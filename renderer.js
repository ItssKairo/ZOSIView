'use strict';

/**
 * Renderer Process Script
 * Camera feed manager — Electron renderer process.
 *
 * HTTP Architecture:
 *   The renderer makes ZERO direct network requests.
 *   All camera probing and image fetching is done via window.electronAPI,
 *   which invokes IPC handlers in the main process. This keeps the CSP clean.
 *
 * Boot Sequence:
 *   1. Load settings via IPC.
 *   2. Check localStorage for a cached host — test it first (fast path).
 *   3. If the cached host is alive, skip the subnet scan entirely.
 *   4. Otherwise scan 10.1.1.180–210 sequentially via IPC check-host calls.
 *   5. Cache the found host to localStorage for the next boot.
 *   6. Fire all 4 cameras simultaneously for the first frame (sync).
 *   7. Repeat on a staggered interval to reduce NVR load.
 *
 * Keyboard shortcuts:
 *   M     — Toggle main menu
 *   F     — Close menu / return to feed (from menu)
 *   S     — Open settings directly
 *   =     — Open diagnostics directly
 *   Esc   — Close active overlay or exit fullscreen
 *   Click — Toggle camera fullscreen
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const CONFIG = Object.freeze({
  CAMERA_COUNT:           4,
  DEFAULT_REFRESH_MS:     5_000,

  SCAN_SUBNET_BASE:       '10.1.1',
  SCAN_SUBNET_START:      180,
  SCAN_SUBNET_END:        210,
  PROBE_BATCH_SIZE:       6,

  MAX_ERRORS_BEFORE_SCAN: 5,
  ERROR_HISTORY_LIMIT:    10,
  STAGGER_MS:             200,

  DEBUG_UPDATE_MS:        1_000,
  STORAGE_KEY_HOST:       'lastActiveHost',
});

const DEFAULT_ADJUSTMENTS = Object.freeze({
  1: { brightness: 105, contrast: 105, saturate: 110, rotation: 0 },
  2: { brightness: 100, contrast: 100, saturate:  90, rotation: 0 },
  3: { brightness: 110, contrast:  95, saturate: 115, rotation: 0 },
  4: { brightness: 100, contrast: 120, saturate: 105, rotation: 0 },
});

const DEFAULT_URL_TEMPLATES = Object.freeze({
  1: 'http://10.1.1.189/cgi-bin/snapshot.cgi?chn=1&u=admin&p=&q=0&d=1',
  2: 'http://10.1.1.189/cgi-bin/snapshot.cgi?chn=0&u=admin&p=&q=0&d=1',
  3: 'http://10.1.1.189/cgi-bin/snapshot.cgi?chn=2&u=admin&p=&q=0&d=1',
  4: 'http://10.1.1.189/cgi-bin/snapshot.cgi?chn=3&u=admin&p=&q=0&d=1',
});

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

function timestamp() {
  return new Date().toLocaleTimeString();
}

function freshRand() {
  return Math.random().toString().slice(2);
}

// ─── EventBus ────────────────────────────────────────────────────────────────

class EventBus {
  constructor() { this._listeners = new Map(); }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
  }

  off(event, fn) { this._listeners.get(event)?.delete(fn); }

  emit(event, ...args) {
    this._listeners.get(event)?.forEach(fn => {
      try { fn(...args); }
      catch (err) { console.error(`[EventBus] "${event}":`, err); }
    });
  }

  destroy() { this._listeners.clear(); }
}

// ─── NetworkManager ───────────────────────────────────────────────────────────

/**
 * Discovers and tracks the active camera NVR host.
 * All HTTP is done via window.electronAPI.checkHost() in the main process.
 *
 * Events: 'network:online', 'network:offline', 'network:scanning'
 */
class NetworkManager {
  constructor(bus) {
    this._bus               = bus;
    this._isScanning        = false;
    this._consecutiveErrors = 0;
    this._candidateHosts    = [];

    try {
      this.activeHost = localStorage.getItem(CONFIG.STORAGE_KEY_HOST) || null;
    } catch {
      this.activeHost = null;
    }
  }

  setCandidates(hosts) {
    this._candidateHosts = [...new Set(hosts.map(h => h.trim()).filter(Boolean))];
  }

  async findActiveHost() {
    if (this._isScanning) return;
    this._isScanning = true;
    this._bus.emit('network:scanning');
    console.log('[Network] Starting host discovery…');

    try {
      // Fast path: test cached host alone first
      if (this.activeHost) {
        console.log(`[Network] Testing cached host ${this.activeHost}…`);
        if (await this._probeOne(this.activeHost)) {
          console.log(`[Network] Cached host alive — skipping scan.`);
          this._consecutiveErrors = 0;
          this._bus.emit('network:online', this.activeHost);
          return;
        }
        console.log('[Network] Cached host offline — scanning subnet.');
      }

      const found = await this._probeBatched(this._buildScanList());

      if (found) {
        console.log('[Network] Found host:', found);
        this.activeHost = found;
        try { localStorage.setItem(CONFIG.STORAGE_KEY_HOST, found); } catch { /* quota */ }
        this._consecutiveErrors = 0;
        this._bus.emit('network:online', found);
      } else {
        console.warn('[Network] No host found.');
        this.activeHost = null;
        this._bus.emit('network:offline');
      }
    } finally {
      this._isScanning = false;
    }
  }

  _buildScanList() {
    const set = new Set(this._candidateHosts);
    for (let i = CONFIG.SCAN_SUBNET_START; i <= CONFIG.SCAN_SUBNET_END; i++) {
      set.add(`${CONFIG.SCAN_SUBNET_BASE}.${i}`);
    }
    if (this.activeHost) set.delete(this.activeHost); // already tested
    return [...set];
  }

  async _probeOne(host) {
    try { return (await window.electronAPI.checkHost(host))?.ok === true; }
    catch { return false; }
  }

  async _probeBatched(hosts) {
    for (let i = 0; i < hosts.length; i += CONFIG.PROBE_BATCH_SIZE) {
      const batch  = hosts.slice(i, i + CONFIG.PROBE_BATCH_SIZE);
      const probes = batch.map(host =>
        this._probeOne(host).then(ok => { if (ok) return host; throw new Error(); })
      );
      try { return await Promise.any(probes); }
      catch { /* batch failed */ }
    }
    return null;
  }

  reportError() {
    this._consecutiveErrors++;
    if (this._consecutiveErrors > CONFIG.MAX_ERRORS_BEFORE_SCAN && !this._isScanning) {
      console.log(`[Network] ${this._consecutiveErrors} errors — re-scanning.`);
      this.findActiveHost();
    }
  }

  reportSuccess() {
    if (this._consecutiveErrors > 0) {
      this._consecutiveErrors = 0;
      this._bus.emit('network:online', this.activeHost);
    }
  }

  destroy() {}
}

// ─── CameraFeed ───────────────────────────────────────────────────────────────

/**
 * Manages a single camera tile.
 * Fetches via IPC, displays frames as data: URLs (CSP-compliant).
 */
class CameraFeed {
  constructor(id, bus, network, settings) {
    this.id        = id;
    this._bus      = bus;
    this._network  = network;
    this._settings = settings;
    this._isFetching = false;

    this.stats = { bytes: 0, totalBytes: 0, errors: [], lastFetch: null, fetchCount: 0 };

    this.adjustments = {
      ...(DEFAULT_ADJUSTMENTS[this.id] || { brightness: 100, contrast: 100, saturate: 100, rotation: 0 }),
      ...(settings[`camera${this.id}_adjustments`] || {}),
    };

    this._wrapper    = this._requireEl(`cam${id}`);
    this._img        = this._requireEl(`img${id}`);
    this._statusDot  = this._requireEl(`status${id}`);
    this._loadingEl  = this._wrapper.querySelector('.loading-overlay');
    this._loadingTxt = this._loadingEl?.querySelector('div:last-child') ?? null;

    this._wrapper.addEventListener('click', () =>
      this._bus.emit('ui:toggleFullscreen', this.id)
    );

    this._setLoadingMessage('Waiting for network…');
    this._applyAdjustments();
  }

  _requireEl(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`CameraFeed ${this.id}: #${id} not found.`);
    return el;
  }

  _applyAdjustments() {
    const { brightness, contrast, saturate, rotation } = this.adjustments;
    this._img.style.filter    = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%)`;
    this._img.style.transform = `rotate(${rotation}deg)`;
  }

  updateAdjustments(partial) {
    Object.assign(this.adjustments, partial);
    this._applyAdjustments();
  }

  _setLoadingMessage(msg) {
    if (this._loadingTxt) this._loadingTxt.textContent = msg;
    if (this._loadingEl)  this._loadingEl.style.display = 'flex';
  }

  _hideLoading() {
    if (this._loadingEl) this._loadingEl.style.display = 'none';
  }

  _setStatus(status) {
    this._statusDot.className = `status-indicator status-${status}`;
    this._bus.emit('camera:status', { id: this.id, status });
  }

  async update() {
    if (this._isFetching) return;
    if (!this._network.activeHost) { this._setLoadingMessage('Scanning for NVR…'); return; }

    const rawUrl = this._settings[`camera${this.id}_url`] || DEFAULT_URL_TEMPLATES[this.id];
    if (!rawUrl) { this._setLoadingMessage('Not configured'); return; }

    this._isFetching = true;
    try {
      const url    = this._buildFetchUrl(rawUrl);
      const result = await window.electronAPI.fetchCamera(url);
      if (result.error) throw new Error(result.error);

      const dataUrl = `data:${result.mimeType};base64,${result.data}`;
      await this._validateAndDisplay(dataUrl, result.data.length);

      this._network.reportSuccess();
      this._setStatus('online');
      this._hideLoading();
    } catch (err) {
      this._handleError(err);
    } finally {
      this._isFetching = false;
    }
  }

  _buildFetchUrl(template) {
    let url = template;
    try {
      const u = new URL(template);
      u.hostname = this._network.activeHost;
      url = u.toString();
    } catch (e) { console.error(`[Cam ${this.id}] Bad URL:`, e); }
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}rand=${freshRand()}&_t=${Date.now()}`;
  }

  _validateAndDisplay(dataUrl, byteCount) {
    return new Promise((resolve, reject) => {
      const tmp = new Image();
      tmp.onload  = () => {
        this._img.src         = dataUrl;
        this.stats.lastFetch   = timestamp();
        this.stats.bytes       = Math.floor(byteCount * 0.75);
        this.stats.totalBytes += this.stats.bytes;
        this.stats.fetchCount++;
        resolve();
      };
      tmp.onerror = () => reject(new Error('Image decode failed'));
      tmp.src = dataUrl;
    });
  }

  _handleError(err) {
    const label = err.message || 'Unknown error';
    this.stats.errors.push(`${timestamp()}: ${label}`);
    if (this.stats.errors.length > CONFIG.ERROR_HISTORY_LIMIT) this.stats.errors.shift();
    console.warn(`[Cam ${this.id}]`, label);
    this._setStatus('offline');
    this._network.reportError();
  }

  destroy() {}
}

// ─── UIManager ────────────────────────────────────────────────────────────────

/**
 * Owns all DOM interaction: menu, debug, settings, fullscreen, status bar clock.
 * Communicates with other subsystems only through EventBus.
 */
class UIManager {
  constructor(bus, settings, cameras, network) {
    this._bus      = bus;
    this._settings = settings;
    this._cameras  = cameras;
    this._network  = network;

    this._fullscreenId      = null;
    this._isMenuVisible     = false;
    this._isDebugVisible    = false;
    this._isSettingsVisible = false;
    this._debugTimer        = null;
    this._clockTimer        = null;

    this._menuOverlay     = this._requireEl('menu-overlay');
    this._debugOverlay    = this._requireEl('debug-overlay');
    this._debugContent    = this._requireEl('debug-content');
    this._settingsOverlay = this._requireEl('settings-overlay');
    this._refreshInput    = this._requireEl('refresh-interval');
    this._hostsInput      = this._requireEl('candidate-hosts');
    this._globalBadge     = document.getElementById('global-status');
    this._clockEl         = document.getElementById('status-clock');

    this._bindKeyboard();
    this._bindMenu();
    this._bindSettings();
    this._bindDebug();
    this._bindBusEvents();
    this._startClock();
  }

  _requireEl(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`UIManager: #${id} not found.`);
    return el;
  }

  // ── Clock ─────────────────────────────────────────────────────────────────

  _startClock() {
    const tick = () => {
      if (this._clockEl) {
        this._clockEl.textContent = new Date().toLocaleTimeString([], {
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
      }
    };
    tick();
    this._clockTimer = setInterval(tick, 1_000);
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  _bindKeyboard() {
    this._onKeyDown = (e) => {
      const inInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (inInput && e.key !== 'Escape') return;

      switch (e.key) {
        case 'm': case 'M':
          this.toggleMenu(); break;

        case 'f': case 'F':
          if (this._isMenuVisible) this.toggleMenu(); break;

        case 's': case 'S':
          if (!this._isSettingsVisible) {
            if (this._isMenuVisible) this.toggleMenu();
            this.toggleSettings();
          }
          break;

        case '=':
          if (!this._isDebugVisible) {
            if (this._isMenuVisible) this.toggleMenu();
            this.toggleDebug();
          }
          break;

        case 'Escape':
          if (this._isMenuVisible)     { this.toggleMenu();     break; }
          if (this._isSettingsVisible) { this.toggleSettings(); break; }
          if (this._isDebugVisible)    { this.toggleDebug();    break; }
          if (this._fullscreenId)      { this._exitFullscreen();break; }
          break;
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  // ── Menu ──────────────────────────────────────────────────────────────────

  _bindMenu() {
    const menuItems = {
      'menu-feed':     () => { this.toggleMenu(); },
      'menu-settings': () => { this.toggleMenu(); this.toggleSettings(); },
      'menu-debug':    () => { this.toggleMenu(); this.toggleDebug(); },
    };

    for (const [id, handler] of Object.entries(menuItems)) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('click', handler);
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
      });
    }
  }

  toggleMenu() {
    this._isMenuVisible = !this._isMenuVisible;
    this._menuOverlay.classList.toggle('hidden', !this._isMenuVisible);
    if (this._isMenuVisible) document.getElementById('menu-feed')?.focus();
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  _bindSettings() {
    this._requireEl('save-settings').addEventListener('click', () => this.saveSettings());
    // Header X and footer Cancel both close settings
    const cancel = () => { if (this._isSettingsVisible) this.toggleSettings(); };
    this._requireEl('cancel-settings').addEventListener('click', cancel);
    document.getElementById('cancel-settings-2')?.addEventListener('click', cancel);
  }

  toggleSettings() {
    this._isSettingsVisible = !this._isSettingsVisible;
    this._settingsOverlay.classList.toggle('hidden', !this._isSettingsVisible);
    if (this._isSettingsVisible) this._populateSettingsForm();
  }

  _populateSettingsForm() {
    this._refreshInput.value = this._settings.refresh_interval
      ?? (CONFIG.DEFAULT_REFRESH_MS / 1_000);
    this._hostsInput.value   = (this._settings.candidate_hosts || []).join('\n');
  }

  async saveSettings() {
    const newRefreshSec = parseInt(this._refreshInput.value, 10);
    if (!Number.isFinite(newRefreshSec) || newRefreshSec < 1) {
      alert('Refresh interval must be a whole number of seconds (minimum 1).');
      return;
    }

    const newHosts = this._hostsInput.value
      .split('\n').map(h => h.trim()).filter(Boolean);

    // Spread existing settings so camera URLs and adjustments are preserved.
    const newSettings = {
      ...this._settings,
      refresh_interval: newRefreshSec,
      candidate_hosts:  newHosts,
    };

    if (!window.electronAPI?.saveSettings) {
      alert('Settings API unavailable — check the Electron preload script.');
      return;
    }

    try {
      const result = await window.electronAPI.saveSettings(newSettings);
      if (result?.error) {
        alert(`Failed to save: ${result.error}`);
      } else {
        this.toggleSettings();
        window.location.reload();
      }
    } catch (err) {
      console.error('[Settings] Save failed:', err);
      alert(`Save failed: ${err.message}`);
    }
  }

  // ── Debug ─────────────────────────────────────────────────────────────────

  _bindDebug() {
    document.getElementById('close-debug')
      ?.addEventListener('click', () => { if (this._isDebugVisible) this.toggleDebug(); });
  }

  toggleDebug() {
    this._isDebugVisible = !this._isDebugVisible;
    this._debugOverlay.classList.toggle('hidden', !this._isDebugVisible);

    if (this._isDebugVisible) {
      this._updateDebugUI();
      this._debugTimer = setInterval(() => this._updateDebugUI(), CONFIG.DEBUG_UPDATE_MS);
    } else {
      clearInterval(this._debugTimer);
      this._debugTimer = null;
    }
  }

  _updateDebugUI() {
    const refreshSec = this._settings.refresh_interval ?? (CONFIG.DEFAULT_REFRESH_MS / 1_000);
    const fragment   = document.createDocumentFragment();

    const sys = this._debugSection('System');
    sys.append(
      this._debugRow('Active Host', this._network.activeHost || '—'),
      this._debugRow('Refresh',     `${refreshSec}s`),
      this._debugRow('Scanning',    this._network._isScanning ? 'Yes' : 'No'),
    );
    fragment.append(sys);

    let totalBps = 0;
    this._cameras.forEach(cam => {
      const bps = cam.stats.bytes / refreshSec;
      totalBps += bps;
      const sec = this._debugSection(`Camera ${cam.id}`);
      sec.append(
        this._debugRow('Last fetch', cam.stats.lastFetch || '—'),
        this._debugRow('Frame size', formatBytes(cam.stats.bytes)),
        this._debugRow('Speed',      `${formatBytes(bps)}/s`),
        this._debugRow('Total',      formatBytes(cam.stats.totalBytes)),
        this._debugRow('Fetches',    String(cam.stats.fetchCount)),
        this._debugRow('Errors',     cam.stats.errors.length
          ? cam.stats.errors.slice(-2).join(' | ') : 'None'),
      );
      fragment.append(sec);
    });

    const bw = this._debugSection('Total Bandwidth');
    bw.append(this._debugRow('Usage', `${formatBytes(totalBps)}/s`));
    fragment.append(bw);

    this._debugContent.replaceChildren(fragment);
  }

  _debugSection(title) {
    const div = document.createElement('div');
    div.className = 'debug-section';
    const h4 = document.createElement('h4');
    h4.textContent = title;
    div.append(h4);
    return div;
  }

  _debugRow(label, value) {
    const p   = document.createElement('p');
    const lbl = document.createElement('span');
    const val = document.createElement('span');
    val.className   = 'debug-value';
    lbl.textContent = `${label}:`;
    val.textContent = value;
    p.append(lbl, val);
    return p;
  }

  // ── Global Status ─────────────────────────────────────────────────────────

  _setGlobalStatus(status, host) {
    if (!this._globalBadge) return;
    const labels = {
      online:   `● ${host}`,
      offline:  '● Offline',
      scanning: '◌ Scanning…',
    };
    this._globalBadge.textContent    = labels[status] ?? status;
    this._globalBadge.dataset.status = status;
  }

  // ── Fullscreen ────────────────────────────────────────────────────────────

  _handleFullscreen(id) {
    if (this._fullscreenId) {
      this._exitFullscreen();
    } else {
      const el = document.getElementById(`cam${id}`);
      if (el) { el.classList.add('fullscreen'); this._fullscreenId = id; }
    }
  }

  _exitFullscreen() {
    if (!this._fullscreenId) return;
    document.getElementById(`cam${this._fullscreenId}`)?.classList.remove('fullscreen');
    this._fullscreenId = null;
  }

  // ── Bus ───────────────────────────────────────────────────────────────────

  _bindBusEvents() {
    this._bus.on('ui:toggleFullscreen', id => this._handleFullscreen(id));
    this._bus.on('network:online',   host => this._setGlobalStatus('online',   host));
    this._bus.on('network:offline',  ()   => this._setGlobalStatus('offline',  null));
    this._bus.on('network:scanning', ()   => this._setGlobalStatus('scanning', null));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  destroy() {
    clearInterval(this._debugTimer);
    clearInterval(this._clockTimer);
    window.removeEventListener('keydown', this._onKeyDown);
  }
}

// ─── App ──────────────────────────────────────────────────────────────────────

class App {
  constructor() {
    this._bus          = new EventBus();
    this._settings     = {};
    this._network      = null;
    this._cameras      = [];
    this._ui           = null;
    this._feedInterval = null;
    this._firstLoad    = true;
  }

  async init() {
    if (!window.electronAPI?.loadSettings || !window.electronAPI?.saveSettings) {
      console.error('[App] window.electronAPI not available. Check preload.js.');
      return;
    }

    // 1. Settings
    try {
      const result = await window.electronAPI.loadSettings();
      this._settings = result?.error ? {} : (result || {});
      if (result?.error) console.warn('[App] Settings warning:', result.error);
    } catch (err) {
      console.error('[App] Could not load settings:', err);
      this._settings = {};
    }

    // 2. Network
    this._network = new NetworkManager(this._bus);
    this._network.setCandidates(this._settings.candidate_hosts || []);

    // Pre-seed active host from settings so cameras attempt fetches immediately.
    const cam1Url = this._settings['camera1_url'] || DEFAULT_URL_TEMPLATES[1];
    try {
      const h = new URL(cam1Url).hostname;
      if (h) this._network.activeHost = h;
    } catch { /* bad URL */ }

    // 3. Cameras + UI
    for (let id = 1; id <= CONFIG.CAMERA_COUNT; id++) {
      try {
        this._cameras.push(new CameraFeed(id, this._bus, this._network, this._settings));
      } catch (err) {
        console.error(`[App] CameraFeed ${id} failed:`, err);
      }
    }

    this._ui = new UIManager(this._bus, this._settings, this._cameras, this._network);

    // 4. React to network
    this._bus.on('network:online', () => {
      if (this._firstLoad) {
        this._firstLoad = false;
        this._syncLoadAllCameras(); // all 4 at once — first frame is always sync
        this._startInterval();
      } else {
        this._startInterval();      // host recovered after errors
      }
    });

    // 5. Start discovery (non-blocking)
    this._network.findActiveHost();
  }

  _syncLoadAllCameras() {
    console.log('[App] Sync-loading all cameras simultaneously…');
    this._cameras.forEach(cam => cam.update());
  }

  _startInterval() {
    if (this._feedInterval !== null) {
      clearInterval(this._feedInterval);
      this._feedInterval = null;
    }
    const refreshMs = this._settings.refresh_interval
      ? this._settings.refresh_interval * 1_000
      : CONFIG.DEFAULT_REFRESH_MS;

    this._feedInterval = setInterval(() => {
      this._cameras.forEach((cam, idx) => {
        setTimeout(() => cam.update(), idx * CONFIG.STAGGER_MS);
      });
    }, refreshMs);

    console.log(`[App] Feed interval: ${refreshMs / 1_000}s`);
  }

  destroy() {
    if (this._feedInterval !== null) clearInterval(this._feedInterval);
    this._cameras.forEach(c => c.destroy());
    this._ui?.destroy();
    this._network?.destroy();
    this._bus.destroy();
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const app = new App();

window.addEventListener('DOMContentLoaded', () => {
  app.init().catch(err => console.error('[App] Fatal init error:', err));
});

window._app = app;