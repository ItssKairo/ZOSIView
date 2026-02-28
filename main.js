'use strict';

/**
 * Main Process — Electron entry point.
 *
 * All outbound HTTP to the camera NVR is handled here, in the main process.
 * The renderer never makes direct network requests, which means the Content
 * Security Policy can be kept maximally strict (no http: in connect-src).
 *
 * IPC surface exposed to renderer (via preload.js):
 *   load-settings   → { ...settings } | { error }
 *   save-settings   → { success } | { error }
 *   get-app-info    → { platform, version, arch }
 *   check-host      → { ok: boolean }
 *   fetch-camera    → { data: base64String, mimeType } | { error }
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  powerSaveBlocker,
  Menu,
  shell,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs').promises;

// ─── Constants ────────────────────────────────────────────────────────────────

const SETTINGS_FILE = 'settings.json';
const SETTINGS_TMP  = 'settings.tmp.json';

/** Keys the renderer is allowed to set, plus their expected types. */
const SETTINGS_SCHEMA = {
  refresh_interval:    'number',
  candidate_hosts:     'array',
  camera1_url:         'string',
  camera2_url:         'string',
  camera3_url:         'string',
  camera4_url:         'string',
  camera1_adjustments: 'object',
  camera2_adjustments: 'object',
  camera3_adjustments: 'object',
  camera4_adjustments: 'object',
};

const DEFAULT_SETTINGS = Object.freeze({
  refresh_interval: 5,
  candidate_hosts:  [],
  camera1_url:      '',
  camera2_url:      '',
  camera3_url:      '',
  camera4_url:      '',
});

const PROBE_TIMEOUT_MS = 2_000;
const FETCH_TIMEOUT_MS = 8_000;

// ─── Power Save Blocker ───────────────────────────────────────────────────────

const powerSaveId = powerSaveBlocker.start('prevent-display-sleep');

app.on('will-quit', () => {
  if (powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveBlocker.stop(powerSaveId);
  }
});

// ─── Single-Instance Lock ─────────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    configureCSP();
    await createWindow();
  }).catch(err => {
    console.error('[Main] Fatal startup error:', err);
    app.quit();
  });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── Window ───────────────────────────────────────────────────────────────────

/** @type {BrowserWindow|null} */
let _mainWindow = null;

function getMainWindow() { return _mainWindow; }

async function createWindow() {
  _mainWindow = new BrowserWindow({
    width:           1280,
    height:          960,
    backgroundColor: '#000000',
    show:            false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
  });

  Menu.setApplicationMenu(buildMenu());
  _mainWindow.maximize();

  // Show only once the renderer has finished painting its first frame.
  _mainWindow.once('ready-to-show', () => _mainWindow.show());
  _mainWindow.on('closed', () => { _mainWindow = null; });

  // Send external link clicks to the OS browser, never open new Electron windows.
  _mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await _mainWindow.loadFile('index.html');

  if (app.isPackaged) {
    setupAutoUpdater();
    autoUpdater.checkForUpdatesAndNotify();
  }
}

// ─── Content Security Policy ──────────────────────────────────────────────────

/**
 * Because all camera HTTP is proxied through the main process via IPC, the
 * renderer never makes direct network requests. We can therefore lock the CSP
 * to 'self' for connect-src and use data: for images (base64 frames).
 */
function configureCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const alreadySet =
      details.responseHeaders['content-security-policy'] ||
      details.responseHeaders['Content-Security-Policy'];

    if (alreadySet) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "img-src 'self' data:",        // data: for base64 camera frames
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "connect-src 'self'",          // renderer makes NO direct HTTP
          ].join('; '),
        ],
      },
    });
  });
}

// ─── Menu ─────────────────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]);
}

// ─── Auto Updater ─────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update',  ()     => console.log('[Updater] Checking…'));
  autoUpdater.on('update-available',     (info) => console.log('[Updater] Available:', info.version));
  autoUpdater.on('update-not-available', (info) => console.log('[Updater] Up to date:', info.version));
  autoUpdater.on('error',                (err)  => console.error('[Updater] Error:', err.message ?? err));
  autoUpdater.on('download-progress', ({ bytesPerSecond, percent, transferred, total }) => {
    console.log(
      `[Updater] ${percent.toFixed(1)}% — ` +
      `${formatBytes(transferred)} / ${formatBytes(total)} @ ${formatBytes(bytesPerSecond)}/s`
    );
  });
  autoUpdater.on('update-downloaded', (info) =>
    console.log('[Updater] Downloaded, installs on quit:', info.version)
  );
}

// ─── Settings Helpers ─────────────────────────────────────────────────────────

function getSettingsPath()     { return path.join(app.getPath('userData'), SETTINGS_FILE); }
function getTempSettingsPath() { return path.join(app.getPath('userData'), SETTINGS_TMP);  }

/**
 * Strip and validate a settings object from the renderer.
 * Only allowlisted keys with correct types are kept.
 * @param {unknown} raw
 * @returns {object}
 */
function sanitiseSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Settings payload must be a plain object.');
  }

  const out = {};

  for (const [key, expectedType] of Object.entries(SETTINGS_SCHEMA)) {
    const val = raw[key];
    if (val == null) continue;

    if (expectedType === 'array') {
      if (!Array.isArray(val)) continue;
      out[key] = val.filter(v => typeof v === 'string' && v.trim().length > 0);

    } else if (expectedType === 'object') {
      if (typeof val !== 'object' || Array.isArray(val)) continue;
      const adj = {};
      for (const sub of ['brightness', 'contrast', 'saturate', 'rotation']) {
        if (typeof val[sub] === 'number' && Number.isFinite(val[sub])) adj[sub] = val[sub];
      }
      if (Object.keys(adj).length > 0) out[key] = adj;

    } else if (expectedType === 'number') {
      const n = Number(val);
      if (!Number.isFinite(n)) continue;
      out[key] = key === 'refresh_interval' ? Math.max(1, Math.min(n, 300)) : n;

    } else if (expectedType === 'string') {
      if (typeof val !== 'string') continue;
      out[key] = val.trim();
    }
  }

  return out;
}

/**
 * Atomically write JSON to disk: temp file → rename.
 * Protects against corruption if the process is killed mid-write.
 */
async function atomicWrite(targetPath, data) {
  const tmp = getTempSettingsPath();
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, targetPath);
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

/** Load settings, creating defaults on first launch. */
ipcMain.handle('load-settings', async () => {
  const p = getSettingsPath();
  let raw;

  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      try {
        await atomicWrite(p, DEFAULT_SETTINGS);
        return { ...DEFAULT_SETTINGS };
      } catch (we) {
        console.error('[Settings] Failed to write defaults:', we);
        return { error: 'Could not create default settings file.' };
      }
    }
    console.error('[Settings] Read error:', err);
    return { error: `Could not read settings: ${err.message}` };
  }

  try {
    return JSON.parse(raw);
  } catch (pe) {
    console.error('[Settings] JSON parse error:', pe);
    return { error: 'Settings file contains invalid JSON. Delete it to reset.' };
  }
});

/** Validate and persist settings from the renderer. */
ipcMain.handle('save-settings', async (_event, payload) => {
  let sanitised;
  try {
    sanitised = sanitiseSettings(payload);
  } catch (ve) {
    console.warn('[Settings] Validation failed:', ve.message);
    return { error: `Invalid settings: ${ve.message}` };
  }
  try {
    await atomicWrite(getSettingsPath(), sanitised);
    return { success: true };
  } catch (err) {
    console.error('[Settings] Write error:', err);
    return { error: `Could not save settings: ${err.message}` };
  }
});

/** Basic app metadata. */
ipcMain.handle('get-app-info', async () => ({
  platform: process.platform,
  version:  app.getVersion(),
  arch:     process.arch,
}));

/**
 * Probe a single camera host to see if it's reachable and serving images.
 * Returns { ok: true } on HTTP 200, { ok: false } on any failure/timeout.
 *
 * The renderer calls this for every candidate IP during a network scan.
 * Keeping it as a per-host call means the renderer controls batching/ordering
 * logic while this function stays a simple, testable HTTP probe.
 *
 * @param {string} host  e.g. '10.1.1.198'
 */
ipcMain.handle('check-host', async (_event, host) => {
  if (typeof host !== 'string' || host.trim().length === 0) {
    return { ok: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const url = `http://${host.trim()}/cgi-bin/snapshot.cgi?chn=0&u=admin&p=&q=0&d=1&_t=${Date.now()}`;
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.ok };
  } catch {
    clearTimeout(timer);
    return { ok: false };
  }
});

/**
 * Fetch a camera snapshot and return it as base64.
 * The renderer assembles the URL (using the discovered host), passes it here,
 * and displays the result as a data: URL — no direct HTTP from the renderer.
 *
 * @param {string} url  Full snapshot URL with host already resolved
 */
ipcMain.handle('fetch-camera', async (_event, url) => {
  if (typeof url !== 'string' || !url.startsWith('http')) {
    return { error: 'Invalid URL' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return { error: `HTTP ${res.status}` };

    const mimeType = res.headers.get('content-type') || 'image/jpeg';
    const buffer   = await res.arrayBuffer();
    const data     = Buffer.from(buffer).toString('base64');

    return { data, mimeType };
  } catch (err) {
    clearTimeout(timer);
    return { error: err.name === 'AbortError' ? 'Timeout' : err.message };
  }
});

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}