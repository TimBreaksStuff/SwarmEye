/* Costs screen: what the swarm has spent, rolled up across sessions.
 *
 * The per-pane cost panel only knows about its own agent and dies with it, so
 * nothing accumulated — this view reads the persistent day/workspace/model tree
 * main/spend.js keeps (fed one delta per agent turn by main/hooks.js) and does
 * all the range and share arithmetic here in the renderer.
 *
 * Same full-view-swap slot as the Task Board and Skills, and self-contained the
 * way Skills is: it fetches its own data over IPC. Workspace names and identity
 * colours come from app.js, which owns that state. Exposes the global `Costs`.
 *
 * Every figure is a list-price estimate (see MODEL_PRICES in main/hooks.js),
 * not a billed amount. */

const Costs = (() => {
  const statsEl = document.getElementById('costs-stats');
  const summaryEl = document.getElementById('costs-summary');
  const sectionsEl = document.getElementById('costs-sections');
  const rangeEl = document.getElementById('costs-range');
  const clearBtn = document.getElementById('costs-clear-btn');

  const RANGES = [['1', 'Today'], ['7', '7 days'], ['30', '30 days'], ['all', 'All time']];
  const FIELDS = ['cost', 'input', 'output', 'cacheRead', 'cacheWrite'];

  let data = { days: {} };
  let workspaces = []; // live workspaces, for names and identity colours
  let archived = []; // removed ones still own the spend they made
  let range = localStorage.getItem('swarmeye.costsRange') || '7';
  if (!RANGES.some(([v]) => v === range)) range = '7';

  function emptyBucket() {
    return { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }

  function addInto(target, src) {
    for (const f of FIELDS) target[f] += Number(src[f]) || 0;
  }

  function tokensOf(b) {
    return b.input + b.output + b.cacheRead + b.cacheWrite;
  }

  // must match dayKey() in main/hooks.js — en-CA is ISO YYYY-MM-DD, in local
  // time, so a day here is the user's day rather than UTC's
  function dayKeyOf(d) {
    return d.toLocaleDateString('en-CA');
  }

  /* The day keys a range covers, newest first. 'all' is whatever the store
   * actually holds, which is also the only range that can reach back past a
   * gap in the data. */
  function daysFor(r) {
    if (r === 'all') return Object.keys(data.days).sort().reverse();
    const out = [];
    const d = new Date();
    for (let i = 0; i < Number(r); i++) {
      out.push(dayKeyOf(d));
      d.setDate(d.getDate() - 1);
    }
    return out;
  }

  function bucketFor(map, key) {
    let b = map.get(key);
    if (!b) { b = emptyBucket(); map.set(key, b); }
    return b;
  }

  function aggregate(dayKeys) {
    const total = emptyBucket();
    const byWs = new Map();
    const byModel = new Map();
    const byDay = new Map();
    for (const day of dayKeys) {
      const entry = data.days[day];
      if (!entry) continue;
      const dayBucket = bucketFor(byDay, day);
      for (const [wsId, models] of Object.entries(entry)) {
        for (const [model, b] of Object.entries(models)) {
          addInto(total, b);
          addInto(dayBucket, b);
          addInto(bucketFor(byWs, wsId), b);
          addInto(bucketFor(byModel, model), b);
        }
      }
    }
    return { total, byWs, byModel, byDay };
  }

  function totalCost(dayKeys) {
    return aggregate(dayKeys).total.cost;
  }

  function wsLabel(id) {
    const ws = workspaces.find((w) => w.id === id) || archived.find((w) => w.id === id);
    if (ws) {
      const gone = !workspaces.some((w) => w.id === id); // archived, but its spend is still real
      return { name: ws.name, color: ws.color, dim: gone, gone };
    }
    // spend whose session was already gone when its turn was filed, or a
    // workspace purged from the archive entirely. "unattributed" already says
    // there's no workspace to name, so it doesn't take the "(gone)" suffix.
    if (id === 'unknown') return { name: 'unattributed', color: null, dim: true };
    return { name: id, color: null, dim: true, gone: true };
  }

  function dayLabel(key) {
    const today = dayKeyOf(new Date());
    const y = new Date();
    y.setDate(y.getDate() - 1);
    if (key === today) return 'today';
    if (key === dayKeyOf(y)) return 'yesterday';
    const d = new Date(key + 'T12:00:00'); // midday: no DST edge can shift the date
    return Number.isFinite(d.getTime())
      ? d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
      : key;
  }

  function statCard(label, cost, tip) {
    const card = document.createElement('div');
    card.className = 'skills-stat-card';
    if (tip) card.dataset.tip = tip;
    const n = document.createElement('span');
    n.className = 'skills-stat-n';
    n.textContent = fmtCost(cost);
    const l = document.createElement('span');
    l.className = 'skills-stat-label';
    l.textContent = label;
    card.append(n, l);
    return card;
  }

  /* One breakdown row: label, a share bar, the cost, and the token count. The
   * bar is drawn against the biggest row in its own section, so the shape of
   * the distribution is readable even when the absolute numbers are tiny. */
  function row({ name, color, dim, cost, tokens, share, tip }) {
    const el = document.createElement('div');
    el.className = 'costs-row' + (dim ? ' costs-row-dim' : '');
    if (tip) el.dataset.tip = tip;

    const label = document.createElement('span');
    label.className = 'costs-row-label';
    if (color) {
      const dot = document.createElement('span');
      dot.className = 'costs-row-dot';
      dot.style.background = color;
      label.appendChild(dot);
    }
    const text = document.createElement('span');
    text.className = 'costs-row-name';
    text.textContent = name;
    label.appendChild(text);

    const track = document.createElement('span');
    track.className = 'costs-row-track';
    const fill = document.createElement('i');
    fill.style.width = Math.max(share * 100, cost > 0 ? 1.5 : 0) + '%';
    track.appendChild(fill);

    const costEl = document.createElement('span');
    costEl.className = 'costs-row-cost';
    costEl.textContent = fmtCost(cost);

    const tokEl = document.createElement('span');
    tokEl.className = 'costs-row-tokens';
    tokEl.textContent = fmtTokens(tokens);

    el.append(label, track, costEl, tokEl);
    return el;
  }

  function section(title, rows) {
    const box = document.createElement('div');
    box.className = 'costs-section';
    const head = document.createElement('div');
    head.className = 'costs-section-title';
    head.textContent = title;
    box.appendChild(head);
    for (const r of rows) box.appendChild(r);
    return box;
  }

  function render() {
    for (const btn of rangeEl.querySelectorAll('button')) {
      btn.classList.toggle('active', btn.dataset.range === range);
    }

    // the cards are fixed periods regardless of the selected range — the
    // "per-day totals" the range pills then drill into
    statsEl.innerHTML = '';
    statsEl.append(
      statCard('today', totalCost(daysFor('1')), 'Estimated spend today, at list prices'),
      statCard('last 7 days', totalCost(daysFor('7'))),
      statCard('last 30 days', totalCost(daysFor('30'))),
      statCard('all time', totalCost(daysFor('all')), 'Everything SwarmEye has recorded — kept for 90 days')
    );

    const { total, byWs, byModel, byDay } = aggregate(daysFor(range));
    const rangeLabel = (RANGES.find(([v]) => v === range) || [])[1] || range;
    const tokens = tokensOf(total);
    const cachedShare = total.cacheRead + total.cacheWrite + total.input
      ? Math.round((total.cacheRead / (total.cacheRead + total.cacheWrite + total.input)) * 100)
      : 0;
    summaryEl.textContent = tokens
      ? `${rangeLabel} · ${fmtCost(total.cost)} · ${fmtTokens(tokens)} tokens · ${cachedShare}% cached`
      : `${rangeLabel} · nothing recorded`;
    summaryEl.dataset.tip = 'List-price estimate, not a bill — in ' + fmtTokens(total.input)
      + ' · out ' + fmtTokens(total.output)
      + ' · cache read ' + fmtTokens(total.cacheRead)
      + ' · cache write ' + fmtTokens(total.cacheWrite);

    sectionsEl.innerHTML = '';
    if (!tokens) {
      const empty = document.createElement('div');
      empty.className = 'skills-empty';
      empty.textContent = 'nothing recorded in this range — spend lands here as your agents take turns';
      sectionsEl.appendChild(empty);
      return;
    }

    const sorted = (map) => [...map.entries()].sort((a, b) => b[1].cost - a[1].cost);
    const peak = (entries) => Math.max(...entries.map(([, b]) => b.cost), 0) || 1;

    const wsEntries = sorted(byWs);
    const wsPeak = peak(wsEntries);
    sectionsEl.appendChild(section('By workspace', wsEntries.map(([id, b]) => {
      const info = wsLabel(id);
      return row({
        name: info.name + (info.gone ? ' (archived)' : ''),
        color: info.color,
        dim: info.dim,
        cost: b.cost,
        tokens: tokensOf(b),
        share: b.cost / wsPeak,
        tip: `${Math.round((b.cost / (total.cost || 1)) * 100)}% of this range's spend`,
      });
    })));

    const modelEntries = sorted(byModel);
    const modelPeak = peak(modelEntries);
    sectionsEl.appendChild(section('By model', modelEntries.map(([id, b]) => row({
      name: prettyModelName(id) || id,
      cost: b.cost,
      tokens: tokensOf(b),
      share: b.cost / modelPeak,
      tip: `${Math.round((b.cost / (total.cost || 1)) * 100)}% of this range's spend — `
        + 'cheaper tiers here is the biggest cost lever there is',
    }))));

    // chronological, newest first — days with no spend are simply absent
    const dayEntries = [...byDay.entries()].filter(([, b]) => b.cost > 0).sort((a, b) => (a[0] < b[0] ? 1 : -1));
    const dayPeak = peak(dayEntries);
    sectionsEl.appendChild(section('By day', dayEntries.map(([key, b]) => row({
      name: dayLabel(key),
      cost: b.cost,
      tokens: tokensOf(b),
      share: b.cost / dayPeak,
      tip: key,
    }))));
  }

  for (const [value, label] of RANGES) {
    const btn = document.createElement('button');
    btn.className = 'pill';
    btn.dataset.range = value;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      range = value;
      localStorage.setItem('swarmeye.costsRange', range);
      render();
    });
    rangeEl.appendChild(btn);
  }

  clearBtn.addEventListener('click', () => Confirm.armOrFire(clearBtn, 'costs:clear', async () => {
    data = await window.swarm.clearSpend();
    render();
    toast('cost history cleared');
  }));

  /* Called by app.js when the view opens (and when the workspace list changes
   * while it's open) — it owns the workspace state this needs for names. */
  async function refresh(live, gone) {
    workspaces = live || [];
    archived = gone || [];
    data = (await window.swarm.getSpend()) || { days: {} };
    render();
  }

  /* A push from main after it folded a turn's spend in — same tree, no fetch. */
  function apply(next) {
    data = next || { days: {} };
    render();
  }

  return { refresh, apply };
})();

window.Costs = Costs;
