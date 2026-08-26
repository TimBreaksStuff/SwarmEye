/* Preview: a dock on the right of the grid showing whatever your agents are
 * building — a local dev server, in the same window, so checking their work
 * isn't an alt-tab away. An Electron <webview>, deliberately restricted to
 * localhost (main/main.js enforces that too, at attach and at navigate).
 * Exposes window.Preview. */

const Preview = (() => {
  const el = document.getElementById('preview');
  const webEl = document.getElementById('preview-web');
  const urlEl = document.getElementById('preview-url');
  const msgEl = document.getElementById('preview-msg');
  const btnEl = document.getElementById('preview-btn');
  const resizerEl = document.getElementById('preview-resizer');
  const autoEl = document.getElementById('preview-auto');

  const DEFAULT_URL = 'http://localhost:3000';
  const MIN_WIDTH = 320;
  // a dev server rebuilds after the agent's last write — reloading on the Stop
  // itself would show the page as it was before the change
  const AUTO_DELAY = 1500;
  const AUTO_KEY = 'swarmeye.previewAutoReload';
  const urlKey = (wsId) => 'swarmeye.previewUrl.' + (wsId || 'none');

  let workspaceId = null;
  let loaded = false; // the webview only loads a real page once the dock is opened
  let ready = false; // the guest is attached and can take a loadURL
  let resolving = false; // a probe/start is in flight — don't launch a second
  let autoTimer = null; // the pending auto-reload, restarted by each agent that finishes

  /* Never through the src attribute: its own handler logs every rejected load
   * to the console, and a load superseded by the next address typed rejects as
   * ERR_ABORTED. loadURL hands us the rejection instead — did-fail-load below
   * is what actually reports a failure worth showing. */
  function load(url) {
    if (!ready) {
      webEl.addEventListener('dom-ready', () => load(url), { once: true });
      return;
    }
    webEl.loadURL(url).catch(() => { /* superseded or refused */ });
  }

  /* "3000" → http://localhost:3000 · "localhost:8080/x" → http://localhost:8080/x.
   * Returns null for anything that isn't local: the dock is for a dev server,
   * and main refuses to attach or navigate to anything else anyway. */
  function normalize(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    if (/^\d{2,5}$/.test(s)) s = 'localhost:' + s;
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    let u;
    try { u = new URL(s); } catch { return null; }
    const local = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'];
    return local.includes(u.hostname) ? u.href : null;
  }

  function sameOrigin(a, b) {
    try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
  }

  function setMessage(text) {
    msgEl.textContent = text || '';
    msgEl.hidden = !text;
  }

  function navigate(raw) {
    const url = normalize(raw);
    if (!url) {
      setMessage('local addresses only — try localhost:3000 or 127.0.0.1:8080');
      return;
    }
    setMessage('');
    localStorage.setItem(urlKey(workspaceId), url);
    urlEl.value = url;
    // re-pointing at the page already up would abort its load — reload it
    // instead, which is what was meant anyway
    if (loaded && webEl.getURL() === url) { webEl.reload(); return; }
    loaded = true;
    load(url);
  }

  /* opening the dock shouldn't require having started the dev server by hand:
   * main probes the usual ports, and only starts `npm run dev` if none answer */
  const REASONS = {
    'no-workspace': 'open a workspace first',
    'no-script': 'no dev/start/serve script in package.json — type an address above',
    unreachable: 'this workspace folder is not reachable from the shell',
    'no-url': 'the dev server printed no address — type its port above',
  };

  async function autoStart() {
    if (resolving) return;
    resolving = true;
    setMessage('looking for a dev server…');
    try {
      const stored = storedUrl();
      const r = await window.swarm.resolvePreview(workspaceId, stored);
      // resolve() answers with a bare origin — it probed a port, it knows no
      // path. Same origin as the page we remember means it is that server, so
      // go back to the page rather than to its front door.
      if (r && r.ok) navigate(sameOrigin(r.url, stored) ? stored : r.url);
      else setMessage((r && REASONS[r.reason]) || 'no dev server found');
    } finally {
      resolving = false;
    }
  }

  function storedUrl() {
    return localStorage.getItem(urlKey(workspaceId)) || DEFAULT_URL;
  }

  function toggle(show) {
    el.hidden = !show;
    btnEl.classList.toggle('active', show);
    if (!show) {
      // closing mid-resolve cancels main's ~15s poll (and kills the server it
      // just started); a server already up is left alone for the next open
      if (resolving && workspaceId) window.swarm.stopPreview(workspaceId);
      return;
    }
    urlEl.value = storedUrl();
    if (!loaded) autoStart();
  }

  /* the dock follows the workspace: each one remembers its own address, so
   * switching to the API repo doesn't leave the web app's page up */
  function setWorkspace(id) {
    if (id === workspaceId) return;
    // same cancellation as closing the dock — the old workspace's poll must
    // not keep running (it also holds the `resolving` flag up)
    if (resolving && workspaceId) window.swarm.stopPreview(workspaceId);
    clearTimeout(autoTimer); // a reload queued for the old workspace is not wanted here
    autoTimer = null;
    workspaceId = id;
    const next = storedUrl();
    urlEl.value = next;
    if (!el.hidden) { loaded = false; autoStart(); }
    else loaded = false; // load it when the dock is next opened
  }

  /* app.js calls this on every agent that finishes a turn. Only the workspace
   * on show counts, and only while the dock is open with the toggle ticked —
   * the debounce collapses a swarm finishing together into one reload, and a
   * dock still showing 'no dev server found' probes again, since the agent may
   * be what just started one. */
  function onAgentDone(wsId) {
    if (el.hidden || !autoEl.checked || wsId !== workspaceId) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = null;
      if (el.hidden || !autoEl.checked) return; // closed or unticked while waiting
      if (loaded) webEl.reload();
      else autoStart();
    }, AUTO_DELAY);
  }

  function init({ getWorkspaceId }) {
    workspaceId = getWorkspaceId();
    urlEl.value = storedUrl();
    autoEl.checked = localStorage.getItem(AUTO_KEY) !== '0'; // on unless turned off
    autoEl.addEventListener('change', () => {
      localStorage.setItem(AUTO_KEY, autoEl.checked ? '1' : '0');
      if (!autoEl.checked) { clearTimeout(autoTimer); autoTimer = null; }
    });
    // drag the left edge to resize; the width is one setting for all workspaces
    dragWidth(resizerEl, el, { key: 'swarmeye.previewWidth', min: MIN_WIDTH });

    btnEl.addEventListener('click', () => toggle(el.hidden));
    document.getElementById('preview-close').addEventListener('click', () => toggle(false));
    document.getElementById('preview-reload').addEventListener('click', () => {
      if (loaded) webEl.reload();
      else autoStart();
    });
    document.getElementById('preview-back').addEventListener('click', () => {
      if (webEl.canGoBack && webEl.canGoBack()) webEl.goBack();
    });
    document.getElementById('preview-fwd').addEventListener('click', () => {
      if (webEl.canGoForward && webEl.canGoForward()) webEl.goForward();
    });
    document.getElementById('preview-external').addEventListener('click', () => {
      const url = normalize(urlEl.value);
      if (url) window.swarm.openExternal(url);
    });

    urlEl.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing an address must not cycle agents
      if (e.key === 'Enter') { e.preventDefault(); navigate(urlEl.value); }
    });

    webEl.addEventListener('dom-ready', () => { ready = true; });
    // the page can navigate itself (a link, a router push) — keep the box
    // honest, and remember the page actually on show: a reload that has to go
    // through resolve() (dock reopened, dev server restarted) would otherwise
    // come back to the site root, since that is all a port probe knows
    for (const ev of ['did-navigate', 'did-navigate-in-page']) {
      webEl.addEventListener(ev, (e) => {
        if (!e.url) return;
        urlEl.value = e.url;
        const u = normalize(e.url);
        if (u) localStorage.setItem(urlKey(workspaceId), u);
      });
    }
    webEl.addEventListener('did-fail-load', (e) => {
      // -3 is ERR_ABORTED, which every cancelled/redirected load reports
      if (e.errorCode === -3 || !e.isMainFrame) return;
      setMessage('nothing answering at ' + (e.validatedURL || urlEl.value) + ' — is the dev server running?');
    });
    webEl.addEventListener('did-finish-load', () => setMessage(''));
  }

  return { init, setWorkspace, onAgentDone };
})();

window.Preview = Preview;
