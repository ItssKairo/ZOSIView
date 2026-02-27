const { app, BrowserWindow, ipcMain, session, powerSaveBlocker, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs').promises; // Use promises for async operations

// Prevent display from sleeping
powerSaveBlocker.start('prevent-display-sleep');

let mainWindow;

// --- Auto Updater Configuration ---
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Logging for autoUpdater (optional but recommended)
autoUpdater.on('checking-for-update', () => {
  console.log('Checking for update...');
});
autoUpdater.on('update-available', (info) => {
  console.log('Update available.', info);
});
autoUpdater.on('update-not-available', (info) => {
  console.log('Update not available.', info);
});
autoUpdater.on('error', (err) => {
  console.error('Error in auto-updater: ', err);
});
autoUpdater.on('download-progress', (progressObj) => {
  let log_message = "Download speed: " + progressObj.bytesPerSecond;
  log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
  log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
  console.log(log_message);
});
autoUpdater.on('update-downloaded', (info) => {
  console.log('Update downloaded');
});

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
  
    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    backgroundColor: '#000000',
    show: false, // Don't show until ready to avoid flickering
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true // Enable sandbox for extra security
    }
  });

  // Set Content Security Policy (CSP)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; img-src 'self' blob: data: http: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http: https:"]
      }
    });
  });

  // Custom Menu (Optional: Remove default menu bar for cleaner look)
  // Menu.setApplicationMenu(null); 
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
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
        { role: 'togglefullscreen' }
      ]
    }
  ];
  
  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  mainWindow.maximize();
  mainWindow.show();

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools(); 

  // Check for updates once the window is shown
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
  }
}

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// Helper to get settings path
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// IPC Handler to load settings
ipcMain.handle('get-app-info', async () => {
  return {
    platform: process.platform,
    version: app.getVersion(),
  };
});

ipcMain.handle('load-settings', async () => {
  const settingsPath = getSettingsPath();
  try {
    await fs.access(settingsPath); // Check if file exists
    const data = await fs.readFile(settingsPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Create default settings if not exists
      const defaultSettings = {
        refresh_interval: 5,
        candidate_hosts: [], // Removed hardcoded IPs
        // Add default camera URLs placeholders if needed
        camera1_url: '',
        camera2_url: '',
        camera3_url: '',
        camera4_url: ''
      };
      try {
        await fs.writeFile(settingsPath, JSON.stringify(defaultSettings, null, 2));
        return defaultSettings;
      } catch (writeError) {
        console.error('Error creating default settings:', writeError);
        return { error: 'Could not create default settings' };
      }
    }
    console.error('Error reading settings.json:', error);
    return { error: 'Could not load settings.json' };
  }
});

ipcMain.handle('save-settings', async (event, newSettings) => {
  const settingsPath = getSettingsPath();
  try {
    await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2));
    return { success: true };
  } catch (error) {
    console.error('Error saving settings.json:', error);
    return { error: 'Could not save settings' };
  }
});
