/**
 * Mobile Camera Connection Logic (Shared with Desktop)
 * This is a React Native-compatible version of the NetworkManager from renderer.js.
 */

export class MobileNetworkManager {
  constructor() {
    this.activeHost = null;
    this.isScanning = false;
    this.candidateHosts = [];
    this.consecutiveErrors = 0;
  }

  setCandidates(hosts) {
    this.candidateHosts = [...new Set(hosts.filter(h => h && h.trim().length > 0))];
  }

  async findActiveHost(onSuccess, onError) {
    if (this.isScanning) return;
    this.isScanning = true;

    const hostsToCheck = new Set(this.candidateHosts);
    if (this.activeHost) hostsToCheck.add(this.activeHost);

    const checks = Array.from(hostsToCheck).map(host => this.checkHost(host));

    try {
      const validHost = await Promise.any(checks);
      if (validHost) {
        this.activeHost = validHost;
        this.consecutiveErrors = 0;
        if (onSuccess) onSuccess(validHost);
      }
    } catch (e) {
      if (onError) onError(e);
    } finally {
      this.isScanning = false;
    }
  }

  checkHost(host) {
    return new Promise((resolve, reject) => {
      let probeUrl = `http://${host}`;
      // Note: In React Native, fetch works similarly to the browser
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      fetch(probeUrl, { method: 'GET', signal: controller.signal })
        .then(res => {
          clearTimeout(timeoutId);
          if (res.ok || res.status === 401 || res.status === 403) {
            resolve(host);
          } else {
            reject(new Error('Unreachable'));
          }
        })
        .catch(err => {
          clearTimeout(timeoutId);
          reject(err);
        });
    });
  }
}
