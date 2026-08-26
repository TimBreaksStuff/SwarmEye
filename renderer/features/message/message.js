/* Messenger: type one line, send it to one agent, several, or all of them.
 * Sessions are tmux-backed, so a message is just a write into the target
 * session — the same text → beat → Enter channel the task board uses to hand
 * an agent its prompt (a single write with a newline in it reads as a paste
 * to Claude's input box and never submits). Exposes window.Messenger. */

const Messenger = (() => {
  const popEl = document.getElementById('msg-pop');
  const inputEl = document.getElementById('msg-input');
  const hintEl = document.getElementById('msg-hint');
  const targetsEl = document.getElementById('msg-targets');
  const btnEl = document.getElementById('msg-btn');

  let handlers = null; // {listAgents, send, toast, workspaceId}

  /* ---- attaching a file or an image ----
   *
   * Both end up as a path *in the message text*, because that is what Claude
   * Code takes: it opens a file — image included — that a prompt names. Main
   * hands back the path as the agent sees it (a WSL one on Windows), so
   * nothing here builds a path itself. */
  const MENTION_MAX = 8; // rows in the @ picker
  let files = []; // this workspace's tracked files, fetched on open
  let mentions = []; // what the picker is currently offering
  let mentionAt = -1; // index of the @ the picker is completing
  let mentionSel = 0;

  const mentionEl = elt('div', 'msg-mentions');
  mentionEl.hidden = true;

  /* Subsequence match, ranked by how early and how tightly the letters land —
   * "rap" finds renderer/app.js. Not a fuzzy library: this runs on a list of a
   * few thousand strings per keystroke and only has to be good enough to put
   * the file you meant in the first few rows. */
  function rank(file, query) {
    const hay = file.toLowerCase();
    let at = -1;
    let first = -1;
    let gaps = 0;
    for (const ch of query) {
      const next = hay.indexOf(ch, at + 1);
      if (next < 0) return -1;
      if (first < 0) first = next;
      if (at >= 0) gaps += next - at - 1;
      at = next;
    }
    // a hit in the file name beats one in the directories above it
    const inName = hay.lastIndexOf('/') < first ? 0 : 40;
    return first + gaps + inName + file.length / 100;
  }

  /* The @token the caret is inside, or null. A leading @ addresses an agent —
   * the picker must not fight that — so only an @ with text before it counts. */
  function mentionQuery() {
    const caret = inputEl.selectionStart;
    const upto = inputEl.value.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at < 0) return null;
    if (/\s/.test(upto.slice(at + 1))) return null; // the token ended
    const before = upto.slice(0, at);
    if (!before.trim()) return null; // still in the address run at the front
    return { at, query: upto.slice(at + 1).toLowerCase() };
  }

  function renderMentions() {
    mentionEl.textContent = '';
    mentions.forEach((file, i) => {
      const row = elt('button', 'msg-mention' + (i === mentionSel ? ' sel' : ''), file);
      // mousedown, not click: the input must not blur before the pick lands
      row.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(i); });
      mentionEl.appendChild(row);
    });
    mentionEl.hidden = !mentions.length;
  }

  function syncMentions() {
    const m = mentionQuery();
    if (!m || !files.length) { mentions = []; mentionEl.hidden = true; return; }
    mentionAt = m.at;
    mentions = (m.query
      ? files.map((f) => [rank(f, m.query), f]).filter(([r]) => r >= 0).sort((a, b) => a[0] - b[0]).map(([, f]) => f)
      : files
    ).slice(0, MENTION_MAX);
    mentionSel = 0;
    renderMentions();
  }

  function pickMention(i) {
    const file = mentions[i];
    if (!file) return;
    const caret = inputEl.selectionStart;
    inputEl.value = inputEl.value.slice(0, mentionAt) + file + ' ' + inputEl.value.slice(caret);
    mentions = [];
    mentionEl.hidden = true;
    inputEl.focus();
    const to = mentionAt + file.length + 1;
    inputEl.setSelectionRange(to, to);
    syncHint();
  }

  /* A pasted or dropped image: main writes it where the agent can read it and
   * hands back that path, which goes into the message like any other mention. */
  async function attachImage(file) {
    if (!file || !/^image\//.test(file.type)) return false;
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    if (!dataUrl) return false;
    const res = await window.swarm.attachImage(dataUrl);
    if (!res || !res.ok) {
      if (handlers && handlers.toast) handlers.toast('could not attach that image' + (res && res.reason ? ': ' + res.reason : ''));
      return true;
    }
    const caret = inputEl.selectionStart;
    inputEl.value = inputEl.value.slice(0, caret) + res.path + ' ' + inputEl.value.slice(caret);
    syncHint();
    return true;
  }

  function agents() {
    return handlers ? handlers.listAgents() : [];
  }

  /* "@dora @kite run the tests" → {names: ['dora','kite'], text: 'run the tests'}.
   * Only leading @tokens are addresses; an @ later in the line is part of the
   * message (paths, handles, emails all contain them). */
  function parse(raw) {
    const names = [];
    let rest = String(raw || '');
    let m;
    while ((m = /^\s*@([A-Za-z0-9_-]+)\s+/.exec(rest))) {
      names.push(m[1].toLowerCase());
      rest = rest.slice(m[0].length);
    }
    return { names, text: rest.trim() };
  }

  function resolve(names) {
    const list = agents();
    if (names.includes('all')) return { targets: list, unknown: [] };
    const targets = [];
    const unknown = [];
    for (const n of names) {
      const found = list.find((a) => a.name.toLowerCase() === n);
      if (found) targets.push(found);
      else unknown.push(n);
    }
    return { targets, unknown };
  }

  function syncHint() {
    const { names, text } = parse(inputEl.value);
    if (!names.length) {
      hintEl.textContent = 'start with @name (or @all) — click an agent below to address it';
      hintEl.classList.remove('warn');
      return;
    }
    const { targets, unknown } = resolve(names);
    if (unknown.length) {
      hintEl.textContent = 'no agent named ' + unknown.join(', ');
      hintEl.classList.add('warn');
      return;
    }
    hintEl.classList.remove('warn');
    hintEl.textContent = text
      ? `Enter sends to ${targets.map((t) => t.name).join(', ')}`
      : `${targets.length} agent${targets.length === 1 ? '' : 's'} addressed — now type the message`;
  }

  /* one chip per running agent, plus @all — clicking prepends its address, so
   * the common case never needs the name typed correctly from memory */
  function renderTargets() {
    targetsEl.innerHTML = '';
    const list = agents();
    if (!list.length) {
      const none = document.createElement('span');
      none.className = 'msg-none';
      none.textContent = 'no running agents';
      targetsEl.appendChild(none);
      return;
    }
    for (const entry of [{ name: 'all', ws: `${list.length} agents` }, ...list]) {
      const chip = document.createElement('button');
      chip.className = 'msg-chip' + (entry.name === 'all' ? ' msg-chip-all' : '');
      chip.textContent = '@' + entry.name;
      chip.dataset.tip = entry.ws || '';
      chip.addEventListener('click', () => {
        address(entry.name);
        inputEl.focus();
      });
      targetsEl.appendChild(chip);
    }
  }

  /* put @name at the front, without disturbing whatever is already typed and
   * without addressing the same agent twice */
  function address(name) {
    const { names, text } = parse(inputEl.value);
    if (!names.includes(name.toLowerCase())) names.push(name.toLowerCase());
    inputEl.value = names.map((n) => '@' + n).join(' ') + ' ' + text;
    syncHint();
  }

  function send() {
    const { names, text } = parse(inputEl.value);
    if (!names.length || !text) return;
    const { targets, unknown } = resolve(names);
    if (unknown.length || !targets.length) return;
    handlers.send(targets.map((t) => t.id), text);
    close();
  }

  async function loadFiles() {
    files = [];
    const wsId = handlers && handlers.workspaceId && handlers.workspaceId();
    if (!wsId) return;
    const list = await window.swarm.listWorkspaceFiles(wsId);
    // a second open while this one was in flight owns the box
    if (!popEl.hidden) files = list || [];
  }

  function open(prefillName) {
    // anchor under the ✉ button, like the bell and the global search
    placePop(popEl, btnEl, { align: 'right', gap: 8 });
    popEl.hidden = false;
    inputEl.value = '';
    renderTargets();
    if (prefillName) address(prefillName);
    else syncHint();
    mentions = [];
    mentionEl.hidden = true;
    loadFiles();
    inputEl.focus();
  }

  function close() {
    popEl.hidden = true;
    mentions = [];
    mentionEl.hidden = true;
  }

  function init(h) {
    handlers = h;
    inputEl.insertAdjacentElement('afterend', mentionEl);
    inputEl.addEventListener('input', () => { syncHint(); syncMentions(); });
    inputEl.addEventListener('keydown', (e) => {
      e.stopPropagation(); // no agent cycling / shortcuts while composing
      // while the @ picker is up it owns the arrows, Enter and Escape — those
      // are how you choose a file, and Enter must not send the message instead
      if (mentions.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          mentionSel = (mentionSel + (e.key === 'ArrowDown' ? 1 : mentions.length - 1)) % mentions.length;
          renderMentions();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionSel); return; }
        if (e.key === 'Escape') { e.preventDefault(); mentions = []; mentionEl.hidden = true; return; }
      }
      if (e.key === 'Enter') { e.preventDefault(); send(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    inputEl.addEventListener('paste', (e) => {
      const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.kind === 'file');
      if (!item) return; // ordinary text paste
      const file = item.getAsFile();
      if (!file || !/^image\//.test(file.type)) return;
      e.preventDefault();
      attachImage(file);
    });
    // a screenshot dragged onto the box, same path as the paste above
    popEl.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
    popEl.addEventListener('drop', (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      attachImage(file);
    });
    btnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (popEl.hidden) open();
      else close();
    });
    document.addEventListener('click', (e) => {
      if (!popEl.hidden && !popEl.contains(e.target)) close();
    });
  }

  return { init, open, close, isOpen: () => !popEl.hidden };
})();

window.Messenger = Messenger;
