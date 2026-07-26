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

  const DEFAULT_URL = 'http://localhost:3000';
  const MIN_WIDTH = 320;
  const urlKey = (wsId) => 'swarmeye.previewUrl.' + (wsId || 'none');

  let workspaceId = null;
  let loaded = false; // the webview only loads a real page once the dock is opened
  let ready = false; // the guest is attached and can take a loadURL

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

  function storedUrl() {
    return localStorage.getItem(urlKey(workspaceId)) || DEFAULT_URL;
  }

  function toggle(show) {
    el.hidden = !show;
    btnEl.classList.toggle('active', show);
    if (!show) return;
    urlEl.value = storedUrl();
    if (!loaded) navigate(urlEl.value);
  }

  /* the dock follows the workspace: each one remembers its own address, so
   * switching to the API repo doesn't leave the web app's page up */
  function setWorkspace(id) {
    if (id === workspaceId) return;
    workspaceId = id;
    const next = storedUrl();
    urlEl.value = next;
    if (!el.hidden) navigate(next);
    else loaded = false; // load it when the dock is next opened
  }

  /* drag the left edge to resize; the width is one setting for all workspaces */
  function wireResizer() {
    const saved = Number(localStorage.getItem('swarmeye.previewWidth'));
    if (saved >= MIN_WIDTH) el.style.width = saved + 'px';
    resizerEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      resizerEl.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = el.getBoundingClientRect().width;
      const onMove = (ev) => {
        const w = Math.max(MIN_WIDTH, Math.min(window.innerWidth - 360, startW + (startX - ev.clientX)));
        el.style.width = Math.round(w) + 'px';
      };
      const onUp = () => {
        resizerEl.removeEventListener('pointermove', onMove);
        resizerEl.removeEventListener('pointerup', onUp);
        resizerEl.removeEventListener('pointercancel', onUp);
        localStorage.setItem('swarmeye.previewWidth', String(Math.round(el.getBoundingClientRect().width)));
      };
      resizerEl.addEventListener('pointermove', onMove);
      resizerEl.addEventListener('pointerup', onUp);
      resizerEl.addEventListener('pointercancel', onUp);
    });
  }

  function init({ getWorkspaceId }) {
    workspaceId = getWorkspaceId();
    urlEl.value = storedUrl();
    wireResizer();

    btnEl.addEventListener('click', () => toggle(el.hidden));
    document.getElementById('preview-close').addEventListener('click', () => toggle(false));
    document.getElementById('preview-reload').addEventListener('click', () => {
      if (loaded) webEl.reload();
      else navigate(urlEl.value);
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
    // the page can navigate itself (a link, a router push) — keep the box honest
    for (const ev of ['did-navigate', 'did-navigate-in-page']) {
      webEl.addEventListener(ev, (e) => { if (e.url) urlEl.value = e.url; });
    }
    webEl.addEventListener('did-fail-load', (e) => {
      // -3 is ERR_ABORTED, which every cancelled/redirected load reports
      if (e.errorCode === -3 || !e.isMainFrame) return;
      setMessage('nothing answering at ' + (e.validatedURL || urlEl.value) + ' — is the dev server running?');
    });
    webEl.addEventListener('did-finish-load', () => setMessage(''));
  }

  return { init, setWorkspace };
})();

window.Preview = Preview;
