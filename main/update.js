/* Update check: read the latest GitHub Release and compare versions. On a
 * newer release, resolve this platform's asset (by the fixed artifactName
 * set in package.json's build config) and expose download()/install() so
 * the renderer can offer a real one-click update. Any network failure
 * (offline, rate-limited) stays silent — this never bothers the user. */

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { app } = require('electron');
const { IS_WIN, installUpdate: platformInstallUpdate } = require('./platform');

const REPO = 'TimBreaksStuff/SwarmEye';
const LATEST_RELEASE_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
const RELEASE_URL = 'https://github.com/' + REPO + '/releases';
const ASSET_NAME = IS_WIN ? 'SwarmEye-portable.exe' : 'SwarmEye-mac.zip';
const CHECK_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15 * 1000;

/* numeric collation compares 0.10 above 0.9, which a plain string compare
 * gets backwards and a hand-rolled split/parse loop needs a dozen lines to
 * get right */
function isNewer(remote, local) {
  return String(remote).localeCompare(String(local), undefined, { numeric: true }) > 0;
}

class UpdateChecker {
  constructor({ current, onAvailable, onProgress, onReady, onError, debugLog }) {
    this.current = current;
    this.onAvailable = onAvailable;
    this.onProgress = onProgress;
    this.onReady = onReady;
    this.onError = onError;
    this.debugLog = debugLog;
    this.firstTimer = null;
    this.timer = null;
    this.latest = null; // { version, assetUrl, releaseUrl }
    this.downloadedPath = null;
  }

  start() {
    this.firstTimer = setTimeout(() => this.tick(), FIRST_CHECK_MS);
    this.timer = setInterval(() => this.tick(), CHECK_MS);
  }

  stop() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }

  async check() {
    await this.tick();
    return this.latest;
  }

  async tick() {
    try {
      const res = await fetch(LATEST_RELEASE_URL, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return;
      const release = await res.json();
      const version = String(release.tag_name || '').replace(/^v/, '');
      if (!version || !isNewer(version, this.current)) return;
      const asset = (release.assets || []).find((a) => a.name === ASSET_NAME);
      if (!asset) return;
      this.latest = {
        version,
        assetUrl: asset.browser_download_url,
        releaseUrl: release.html_url || RELEASE_URL,
      };
      this.debugLog('[update] ' + version + ' available (running ' + this.current + ')');
      this.onAvailable(this.latest);
    } catch { /* offline/rate-limited — never bother the user */ }
  }

  async download() {
    if (!this.latest) return;
    const dest = path.join(app.getPath('temp'), ASSET_NAME);
    try {
      const res = await fetch(this.latest.assetUrl);
      if (!res.ok || !res.body) throw new Error('download failed: ' + res.status);
      const total = Number(res.headers.get('content-length')) || 0;
      let received = 0;
      const out = fs.createWriteStream(dest);
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        received += chunk.length;
        if (total) this.onProgress(Math.round((received / total) * 100));
      });
      await pipeline(body, out);
      this.downloadedPath = dest;
      this.onReady();
    } catch (err) {
      this.debugLog('[update] download failed: ' + err.message);
      this.onError(err.message);
    }
  }

  install() {
    if (!this.downloadedPath) return;
    if (!app.isPackaged) {
      this.onError('cannot self-update in a dev build');
      return;
    }
    const result = platformInstallUpdate(this.downloadedPath);
    if (!result.ok) {
      this.onError(result.error);
      return;
    }
    app.quit();
  }
}

module.exports = { UpdateChecker };
