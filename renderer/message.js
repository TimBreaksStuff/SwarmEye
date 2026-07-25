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

  let handlers = null; // {listAgents, send, toast}

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

  function open(prefillName) {
    // anchor under the ✉ button, like the bell and the global search
    const r = btnEl.getBoundingClientRect();
    popEl.style.top = Math.round(r.bottom + 8) + 'px';
    popEl.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
    popEl.hidden = false;
    inputEl.value = '';
    renderTargets();
    if (prefillName) address(prefillName);
    else syncHint();
    inputEl.focus();
  }

  function close() {
    popEl.hidden = true;
  }

  function init(h) {
    handlers = h;
    inputEl.addEventListener('input', syncHint);
    inputEl.addEventListener('keydown', (e) => {
      e.stopPropagation(); // no agent cycling / shortcuts while composing
      if (e.key === 'Enter') { e.preventDefault(); send(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
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
