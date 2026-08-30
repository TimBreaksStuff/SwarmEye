/* Checking for, downloading and installing a new SwarmEye.
 *
 * Two elements, one state: the top bar's pill is an at-a-glance indicator and
 * does nothing but open the Options row, which is where the download and the
 * restart actually happen. A browser tab would lose the progress reporting.
 *
 * Owns no app state — `init` takes the toast and a way to open Options, and
 * everything else arrives on main's update channels. */

let toast = () => {};
let openOptions = () => {};

const pillEl = document.getElementById('update-pill');
const statusEl = document.getElementById('update-status');
const actionBtn = document.getElementById('update-action-btn');
const checkBtn = document.getElementById('update-check-btn');

export let pending = null; // { version, releaseUrl } — set once a newer release is seen
let appVersion = '';

export function init(context) {
  toast = context.toast;
  openOptions = context.openOptions;

  window.swarm.getAppVersion().then((version) => {
    appVersion = version;
    if (!pending) statusEl.textContent = `v${version} — up to date`;
  });

  /* The background check is silent by design, so a failing one (no release
   * published, offline, rate-limited) used to leave the row reading "up to
   * date". Asking by hand reports what actually came back. */
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    statusEl.textContent = 'checking GitHub…';
    const res = await window.swarm.checkUpdate();
    checkBtn.disabled = false;
    if (res.state === 'available') return; // onUpdateAvailable already repainted the row
    statusEl.textContent = res.state === 'current'
      ? `v${appVersion} — up to date`
      : `v${appVersion} — check failed: ${res.error}`;
  });

  actionBtn.addEventListener('click', () => {
    if (actionBtn.dataset.action === 'install') {
      actionBtn.disabled = true;
      window.swarm.installUpdate();
      return;
    }
    actionBtn.disabled = true;
    statusEl.textContent = `v${pending.version} — downloading…`;
    window.swarm.downloadUpdate();
  });

  window.swarm.onUpdateAvailable(({ version, releaseUrl }) => {
    pending = { version, releaseUrl };
    statusEl.textContent = `v${version} available`;
    actionBtn.textContent = 'Download';
    actionBtn.dataset.action = 'download';
    actionBtn.disabled = false;
    actionBtn.hidden = false;

    pillEl.textContent = `v${version} available`;
    pillEl.dataset.tip = 'A newer SwarmEye is ready — click to update';
    pillEl.hidden = false;
    pillEl.onclick = () => openOptions();
  });

  window.swarm.onUpdateProgress(({ percent }) => {
    if (!pending) return;
    statusEl.textContent = `v${pending.version} — downloading… ${percent}%`;
  });

  window.swarm.onUpdateReady(() => {
    if (!pending) return;
    statusEl.textContent = `v${pending.version} ready to install`;
    actionBtn.textContent = 'Restart & Update';
    actionBtn.dataset.action = 'install';
    actionBtn.disabled = false;
  });

  window.swarm.onUpdateError(({ error }) => {
    toast('update failed: ' + error);
    if (!pending) return;
    statusEl.textContent = `v${pending.version} available`;
    actionBtn.textContent = 'Download';
    actionBtn.dataset.action = 'download';
    actionBtn.disabled = false;
  });
}
