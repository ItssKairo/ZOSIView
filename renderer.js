/**
 * Renderer Process Script
 * Handles UI logic, camera feed management, and settings.
 */

// --- Constants & Config ---
const CAMERAS_COUNT = 4;
const DEFAULT_REFRESH_INTERVAL = 5;
const MAX_ERRORS_BEFORE_SCAN = 5;

// --- Utility Functions ---
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getTimestamp() {
  return new Date().toLocaleTimeString();
}

// --- Classes ---

class NetworkManager {
  constructor(app) {
    this.app = app;
    this.activeHost = null;
    this.isScanning = false;
    this.candidateHosts = [];
    this.consecutiveErrors = 0;
  }

  setCandidates(hosts) {
    // Filter valid non-empty strings and remove duplicates
    this.candidateHosts = [...new Set(hosts.filter(h => h && h.trim().length > 0))];
  }

  async findActiveHost() {
    if (this.isScanning) return;
    this.isScanning = true;
    this.app.ui.updateGlobalStatus('connecting');
    console.log('Scanning for active camera host...');

    // Combine current active host (if any) with candidates to check all possibilities
    const hostsToCheck = new Set(this.candidateHosts);
    if (this.activeHost) hostsToCheck.add(this.activeHost);

    const checks = Array.from(hostsToCheck).map(host => this.checkHost(host));

    try {
      const validHost = await Promise.any(checks);
      if (validHost) {
        console.log('Found active host:', validHost);
        this.activeHost = validHost;
        this.consecutiveErrors = 0;
        this.app.ui.updateGlobalStatus('online');
        this.app.restartFeeds();
      }
    } catch (e) {
      console.warn('No active host found in candidates.');
      this.app.ui.updateGlobalStatus('offline');
    } finally {
      this.isScanning = false;
    }
  }

  checkHost(host) {
    return new Promise((resolve, reject) => {
      // Construct a probe URL. 
      // We try to use the path from Camera 1 if available, otherwise just the root.
      let probeUrl = `http://${host}`;
      const cam1Url = this.app.settings.camera1_url;
      if (cam1Url) {
        try {
          const u = new URL(cam1Url);
          u.hostname = host;
          probeUrl = u.toString();
        } catch (e) {
          // If URL parsing fails, stick to root
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      fetch(probeUrl, { method: 'GET', signal: controller.signal })
        .then(res => {
          clearTimeout(timeoutId);
          // Accept OK, Unauthorized (401), or Forbidden (403) as signs of life
          if (res.ok || res.status === 401 || res.status === 403) {
            resolve(host);
          } else {
            reject(new Error('Unreachable or wrong device'));
          }
        })
        .catch(err => {
          clearTimeout(timeoutId);
          reject(err);
        });
    });
  }

  reportError() {
    this.consecutiveErrors++;
    if (this.consecutiveErrors > MAX_ERRORS_BEFORE_SCAN && !this.isScanning) {
      console.log('Too many errors, triggering network scan...');
      this.findActiveHost();
    }
  }

  reportSuccess() {
    if (this.consecutiveErrors > 0) {
      this.consecutiveErrors = 0;
      this.app.ui.updateGlobalStatus('online');
    }
  }
}

class CameraFeed {
  constructor(id, app) {
    this.id = id;
    this.app = app;
    this.element = document.getElementById(`cam${id}`);
    this.imgElement = document.getElementById(`img${id}`);
    this.statusIndicator = document.getElementById(`status${id}`);
    this.loadingOverlay = this.element.querySelector('.loading-overlay');
    this.loadingText = this.loadingOverlay.querySelector('div:last-child');
    
    this.isFetching = false;
    this.stats = {
      bytes: 0,
      totalBytes: 0,
      errors: [],
      lastFetch: null,
      fetchCount: 0
    };

    // Attach event listener for fullscreen
    this.element.addEventListener('click', () => this.app.ui.toggleFullscreen(this.id));
    
    // Set initial placeholder
    this.setPlaceholder('Initializing...');
  }

  setPlaceholder(text) {
      this.element.setAttribute('data-placeholder', text);
  }

  setLoading(message) {
    if (this.loadingOverlay) {
        this.loadingText.textContent = message || `Loading Cam ${this.id}...`;
        this.loadingOverlay.style.display = 'flex';
    }
  }

  hideLoading() {
    if (this.loadingOverlay) {
        this.loadingOverlay.style.display = 'none';
    }
  }

  setStatus(status) {
    // status: 'online', 'offline', 'connecting'
    if (this.statusIndicator) {
      this.statusIndicator.className = `status-indicator status-${status}`;
    }
  }

  async update() {
    const originalUrl = this.app.settings[`camera${this.id}_url`];
    if (!originalUrl) {
      this.setLoading('Not Configured');
      return;
    }

    if (this.isFetching) return;
    this.isFetching = true;

    // Construct URL with dynamic host if available
    let finalUrl = originalUrl;
    if (this.app.network.activeHost) {
      try {
        const u = new URL(originalUrl);
        u.hostname = this.app.network.activeHost;
        finalUrl = u.toString();
      } catch (e) {
        console.error(`Error constructing URL for Cam ${this.id}:`, e);
      }
    }

    // Add timestamp to prevent caching
    const timestamp = new Date().getTime();
    const separator = finalUrl.includes('?') ? '&' : '?';
    const newSrc = `${finalUrl}${separator}_t=${timestamp}`;

    const controller = new AbortController();
    const timeoutMs = Math.max(5000, (this.app.settings.refresh_interval || DEFAULT_REFRESH_INTERVAL) * 2000);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(newSrc, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      // Create a temp image to validate the blob
      await new Promise((resolve, reject) => {
        const tempImg = new Image();
        tempImg.onload = () => {
          this.updateImageSource(objectUrl, blob.size);
          resolve();
        };
        tempImg.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Image decode failed'));
        };
        tempImg.src = objectUrl;
      });

      this.app.network.reportSuccess();
      this.setStatus('online');
      this.hideLoading();

    } catch (err) {
      this.handleError(err);
    } finally {
      this.isFetching = false;
    }
  }

  updateImageSource(objectUrl, size) {
    // Revoke old URL to prevent memory leaks
    if (this.imgElement.src.startsWith('blob:')) {
      URL.revokeObjectURL(this.imgElement.src);
    }
    this.imgElement.src = objectUrl;
    
    // Update stats
    this.stats.lastFetch = getTimestamp();
    this.stats.bytes = size;
    this.stats.totalBytes += size;
    this.stats.fetchCount++;
  }

  handleError(err) {
    let errorMsg = err.message || 'Fetch failure';
    if (err.name === 'AbortError') errorMsg = 'Timeout';

    // Log error but limit history
    this.stats.errors.push(`${getTimestamp()}: ${errorMsg}`);
    if (this.stats.errors.length > 10) this.stats.errors.shift();

    // Only log significant errors to console
    if (err.name !== 'AbortError') {
      console.warn(`Camera ${this.id} error:`, err);
    }

    this.setStatus('offline');
    this.setPlaceholder('Connection Failed');
    
    // Hide image if it's broken/old
    // this.imgElement.src = ''; // Optional: Clear image on error? 
    // Usually better to keep last good frame, but if it's really old it might be misleading.
    // For now, let's keep the last frame but show status indicator.

    this.app.network.reportError();
  }
}

class UIManager {
  constructor(app) {
    this.app = app;
    this.fullscreenCamId = null;
    this.isDebugVisible = false;
    this.isSettingsVisible = false;

    // Elements
    this.debugOverlay = document.getElementById('debug-overlay');
    this.debugContent = document.getElementById('debug-content');
    this.settingsOverlay = document.getElementById('settings-overlay');
    
    // Inputs
    this.refreshInput = document.getElementById('refresh-interval');
    this.hostsInput = document.getElementById('candidate-hosts');
    this.camInputs = {};
    [1, 2, 3, 4].forEach(id => {
        // We need to add these inputs to the settings modal dynamically or assume they exist
        // For now, let's assume we will add them to HTML
    });

    this.setupEventListeners();
    this.startDebugLoop();
  }

  setupEventListeners() {
    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      const isInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (e.key === '=' && !isInput) this.toggleDebug();
      if ((e.key === 's' || e.key === 'S') && !isInput) this.toggleSettings();
      if (e.key === 'Escape') {
        if (this.isSettingsVisible) this.toggleSettings();
        if (this.fullscreenCamId) this.exitFullscreen();
      }
    });

    // Settings buttons
    document.getElementById('save-settings').addEventListener('click', () => this.saveSettings());
    document.getElementById('cancel-settings').addEventListener('click', () => this.toggleSettings());
  }

  toggleFullscreen(id) {
    if (this.fullscreenCamId) {
      this.exitFullscreen();
    } else {
      const wrapper = document.getElementById(`cam${id}`);
      if (wrapper) {
        wrapper.classList.add('fullscreen');
        this.fullscreenCamId = id;
      }
    }
  }

  exitFullscreen() {
    if (!this.fullscreenCamId) return;
    const wrapper = document.getElementById(`cam${this.fullscreenCamId}`);
    if (wrapper) wrapper.classList.remove('fullscreen');
    this.fullscreenCamId = null;
  }

  toggleSettings() {
    this.isSettingsVisible = !this.isSettingsVisible;
    this.settingsOverlay.classList.toggle('hidden', !this.isSettingsVisible);

    if (this.isSettingsVisible) {
      this.populateSettingsForm();
    }
  }

  populateSettingsForm() {
    const s = this.app.settings;
    this.refreshInput.value = s.refresh_interval || DEFAULT_REFRESH_INTERVAL;
    this.hostsInput.value = (s.candidate_hosts || []).join('\n');
    
    // We will dynamically add camera URL inputs if they don't exist in HTML
    // But for this rewrite, let's stick to what's in HTML or add them via JS if needed.
    // The previous HTML didn't have camera URL inputs, which is a bug/missing feature.
    // I should generate them.
    this.renderCameraInputs();
  }
  
  renderCameraInputs() {
      const container = document.querySelector('.settings-content .camera-urls');
      if (!container) return; // Need to add this container in HTML
      
      container.innerHTML = '';
      [1,2,3,4].forEach(id => {
          const div = document.createElement('div');
          div.className = 'settings-group';
          div.innerHTML = `
            <label>Camera ${id} URL:</label>
            <input type="text" id="cam-url-${id}" value="${this.app.settings[`camera${id}_url`] || ''}" placeholder="http://ip/snapshot.jpg">
          `;
          container.appendChild(div);
      });
  }

  async saveSettings() {
    const newRefresh = parseInt(this.refreshInput.value, 10);
    const newHosts = this.hostsInput.value.split('\n').map(h => h.trim()).filter(h => h);
    
    if (isNaN(newRefresh) || newRefresh < 1) {
      alert('Invalid refresh interval');
      return;
    }

    const newSettings = {
      ...this.app.settings,
      refresh_interval: newRefresh,
      candidate_hosts: newHosts
    };

    // Collect Camera URLs
    [1,2,3,4].forEach(id => {
        const input = document.getElementById(`cam-url-${id}`);
        if (input) newSettings[`camera${id}_url`] = input.value.trim();
    });

    try {
      const result = await window.electronAPI.saveSettings(newSettings);
      if (result.error) {
        alert('Failed to save settings: ' + result.error);
      } else {
        this.toggleSettings();
        window.location.reload(); // Reload to apply changes cleanly
      }
    } catch (e) {
      console.error('Save failed', e);
      alert('Save failed: ' + e.message);
    }
  }

  toggleDebug() {
    this.isDebugVisible = !this.isDebugVisible;
    this.debugOverlay.classList.toggle('hidden', !this.isDebugVisible);
  }

  startDebugLoop() {
    setInterval(() => this.updateDebugUI(), 1000);
  }

  updateDebugUI() {
    if (!this.isDebugVisible) return;

    const refreshInterval = this.app.settings.refresh_interval || DEFAULT_REFRESH_INTERVAL;
    let totalBps = 0;
    
    let html = `
      <div class="debug-section">
        <h4>System Info</h4>
        <p><span>Active Host:</span> <span class="debug-value">${this.app.network.activeHost || 'Scanning...'}</span></p>
        <p><span>Refresh:</span> <span class="debug-value">${refreshInterval}s</span></p>
      </div>
    `;

    this.app.cameras.forEach(cam => {
      const bps = cam.stats.bytes / refreshInterval;
      totalBps += bps;
      
      html += `
        <div class="debug-section">
          <h4>Camera ${cam.id}</h4>
          <p><span>Last:</span> <span class="debug-value">${cam.stats.lastFetch || '-'}</span></p>
          <p><span>Size:</span> <span class="debug-value">${formatBytes(cam.stats.bytes)}</span></p>
          <p><span>Speed:</span> <span class="debug-value">${formatBytes(bps)}/s</span></p>
          <p><span>Total:</span> <span class="debug-value">${formatBytes(cam.stats.totalBytes)}</span></p>
          <div class="debug-error">
            ${cam.stats.errors.length > 0 ? 'Errors:<br>' + cam.stats.errors.slice(-2).join('<br>') : 'OK'}
          </div>
        </div>
      `;
    });

    html += `
      <div class="debug-section">
        <h4>Total Bandwidth</h4>
        <p><span>Usage:</span> <span class="debug-value">${formatBytes(totalBps)}/s</span></p>
      </div>
    `;

    this.debugContent.innerHTML = html;
  }

  updateGlobalStatus(status) {
      // Could be used to show a global connection icon
  }
}

class App {
  constructor() {
    this.settings = {};
    this.cameras = [];
    this.network = new NetworkManager(this);
    this.ui = null; // Initialized after DOM ready
    this.feedInterval = null;
  }

  async init() {
    try {
      this.settings = await window.electronAPI.loadSettings();
      if (this.settings.error) {
        console.error('Settings error:', this.settings.error);
      }

      this.ui = new UIManager(this);
      
      // Initialize Cameras
      for (let i = 1; i <= CAMERAS_COUNT; i++) {
        this.cameras.push(new CameraFeed(i, this));
      }

      // Initialize Network
      this.network.setCandidates(this.settings.candidate_hosts || []);
      
      // Try to deduce initial host from Camera 1 URL
      if (this.settings.camera1_url) {
        try {
            const url = new URL(this.settings.camera1_url);
            this.network.activeHost = url.hostname;
        } catch(e) {}
      }

      // Initial Network Scan
      await this.network.findActiveHost();

      // Start Feeds
      this.restartFeeds();

    } catch (err) {
      console.error('Initialization failed:', err);
    }
  }

  restartFeeds() {
    if (this.feedInterval) clearInterval(this.feedInterval);

    const refreshMs = (this.settings.refresh_interval || DEFAULT_REFRESH_INTERVAL) * 1000;

    // Trigger immediate update
    this.updateAllCameras();

    // Start interval
    this.feedInterval = setInterval(() => {
      this.updateAllCameras();
    }, refreshMs);
  }

  updateAllCameras() {
    this.cameras.forEach((cam, index) => {
      // Stagger requests to reduce network spikes
      setTimeout(() => {
        cam.update();
      }, index * 250);
    });
  }
}

// --- Main Entry Point ---
const app = new App();

window.addEventListener('DOMContentLoaded', () => {
  app.init();
});
