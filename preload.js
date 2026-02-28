'use strict';

/**
 * Preload Script — Context Bridge
 *
 * This is the only file that has access to both Node.js APIs and the DOM.
 * It defines the exact surface area the renderer can use to communicate with
 * the main process. Nothing else crosses the boundary.
 *
 * Exposed as window.electronAPI in the renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  /**
   * Load application settings from disk.
   * @returns {Promise<object>} Settings object, or { error: string } on failure.
   */
  loadSettings: () => ipcRenderer.invoke('load-settings'),

  /**
   * Persist application settings to disk.
   * Settings are validated in the main process before writing.
   * @param {object} settings
   * @returns {Promise<{ success: true } | { error: string }>}
   */
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  /**
   * Get basic application metadata (platform, version, arch).
   * @returns {Promise<{ platform: string, version: string, arch: string }>}
   */
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  /**
   * Probe a single host IP to determine if it's serving camera snapshots.
   * All HTTP happens in the main process — the renderer never makes direct
   * network requests, keeping the CSP clean.
   *
   * @param {string} host  e.g. '10.1.1.198'
   * @returns {Promise<{ ok: boolean }>}
   */
  checkHost: (host) => ipcRenderer.invoke('check-host', host),

  /**
   * Fetch a camera snapshot via the main process and return it as base64.
   * The renderer displays the result as a data: URL on an <img> element.
   *
   * @param {string} url  Full snapshot URL (host already resolved by NetworkManager)
   * @returns {Promise<{ data: string, mimeType: string } | { error: string }>}
   */
  fetchCamera: (url) => ipcRenderer.invoke('fetch-camera', url),
});