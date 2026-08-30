#!/usr/bin/env node
/* scripts/style-snapshot.js — the harness behind CLAUDE.md's rule that a bulk
 * CSS move is verified, not reasoned about.
 *
 * Boots the app on a throwaway userData dir (so the real one and its single-
 * instance lock are untouched) and records two different things over CDP.
 *
 * `--cascade` is the one that proves a move. For every CSS property it dumps
 * the *ordered* list of every declaration touching that property across every
 * sheet, in cascade order. Two declarations can only ever fight each other if
 * they name the same property, so if each property's sequence is unchanged,
 * the winner is unchanged for every element — including the ones no snapshot
 * can reach because they are built at runtime (palette rows, board cards,
 * skill rows). It needs no rendering and has no noise floor at all.
 *
 * The default mode is the weaker, complementary one: walk the live DOM in
 * every view and theme and record the full computed style of every element.
 * It catches what the cascade dump cannot — a selector that no longer matches
 * because markup moved — but only for elements actually on screen, and it
 * carries a small colour noise floor (see sameWithinNoise).
 *
 * Use both. Cascade first, and it must be empty.
 *
 *   node scripts/style-snapshot.js --cascade before.json
 *   <move the rules>
 *   node scripts/style-snapshot.js --cascade after.json
 *   node scripts/style-snapshot.js --diff before.json after.json
 */

const fs = require('fs');
const { sleep, launchApp, evaluate } = require('./cdp');

const PORT = Number(process.env.SNAP_PORT || 9333);

/* The views a sheet in this project can style. Each is a snippet run in the
 * page: it makes one view visible, and the walker then records it. They are
 * deliberately DOM-level rather than click-level — a click path breaks on
 * every layout change, an id does not. */
const VIEWS = {
  shell: '1',
  board: 'document.getElementById("board").hidden = false; 1',
  skills: 'document.getElementById("board").hidden = true; document.getElementById("skills-view").hidden = false; 1',
  palette: 'document.getElementById("skills-view").hidden = true; document.getElementById("palette-pop").hidden = false; 1',
  options: 'document.getElementById("palette-pop").hidden = true; document.getElementById("kbd-pop").hidden = false; 1',
  shortcuts: 'document.getElementById("kbd-pop").hidden = true; document.getElementById("kbd-shortcuts-pop").hidden = false; 1',
  coordinator: 'document.getElementById("kbd-shortcuts-pop").hidden = true; document.getElementById("coord-modal").hidden = false; 1',
  notifications: 'document.getElementById("coord-modal").hidden = true; document.getElementById("notif-panel").hidden = false; 1',
  preview: 'document.getElementById("notif-panel").hidden = true; document.getElementById("preview").hidden = false; 1',
  reset: 'document.getElementById("preview").hidden = true; 1',
};

/* Every knob that switches a sheet on or off, not every colour theme: the
 * themes only swap token values, and a token that moved would show up in any
 * one of them. `light` is in because it is the one theme with its own rules
 * beyond tokens. */
const MODES = [
  { key: 'dark', attrs: { theme: 'dark', native: 'off', rt: 'off' } },
  { key: 'light', attrs: { theme: 'light', native: 'off', rt: 'off' } },
  { key: 'native', attrs: { theme: 'dark', native: 'on', rt: 'off' } },
  { key: 'reduced', attrs: { theme: 'dark', native: 'off', rt: 'on' } },
];

/* Runs in the page. Walks the whole tree depth-first and records every
 * longhand getComputedStyle exposes, keyed by a structural path so an element
 * that has no id is still comparable run to run. */
const WALKER = `(() => {
  const out = {};
  const seen = new Map();
  function key(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const p = n.parentElement;
      const i = p ? Array.prototype.indexOf.call(p.children, n) : 0;
      parts.unshift(n.id ? '#' + n.id : n.localName + '[' + i + ']');
      if (n.id) break;
    }
    return parts.join('>');
  }
  /* The usage meters are the one part of the app whose geometry *is* a live
   * number from main: the bars are sized from the percentage and the rail's
   * gauges encode it as a stroke-dashoffset, so widths, transform origins and
   * dash offsets differ between two runs of the same code no matter how long
   * you wait. Nothing in them is a rule anyone moves — they are styled from
   * rail.css alone — so they are skipped rather than tolerated. */
  const LIVE_DATA = '#usage, [id^="gauge-"]';
  const all = document.querySelectorAll('*');
  for (const el of all) {
    if (el.localName === 'script' || el.localName === 'style' || el.localName === 'link') continue;
    if (el.closest(LIVE_DATA)) continue;
    let k = key(el);
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n > 1) k += '~' + n;
    const cs = getComputedStyle(el);
    const rec = {};
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i];
      rec[prop] = cs.getPropertyValue(prop);
    }
    out[k] = rec;
  }
  return JSON.stringify(out);
})()`;

/* Runs in the page. Every declaration in every sheet, in cascade order,
 * bucketed by the property it sets. Longhands only — reading rule.style by
 * index is what expands `padding: 4px 8px` into its four sides, so a shorthand
 * rewritten as longhands (or the reverse) compares equal, which is what we
 * want: the question is what wins, not how it was spelled. */
const CASCADE = `(() => {
  const byProp = {};
  let order = 0;
  function walk(rules, ctx) {
    for (const rule of rules) {
      if (rule.type === CSSRule.STYLE_RULE) {
        const key = (ctx ? ctx + ' || ' : '') + rule.selectorText;
        for (let i = 0; i < rule.style.length; i++) {
          const prop = rule.style[i];
          const val = rule.style.getPropertyValue(prop);
          const imp = rule.style.getPropertyPriority(prop) === 'important' ? '!' : '';
          (byProp[prop] = byProp[prop] || []).push(key + ' {' + val + imp + '}');
        }
        order++;
      } else if (rule.cssRules) {
        const cond = rule.conditionText || rule.media?.mediaText || rule.name || rule.type;
        walk(rule.cssRules, (ctx ? ctx + ' & ' : '') + '@' + cond);
      }
    }
  }
  for (const sheet of document.styleSheets) {
    if (sheet.href && sheet.href.includes('/node_modules/')) continue; // xterm's own sheet
    try { walk(sheet.cssRules, ''); } catch (e) { return JSON.stringify({ __error: String(e) }); }
  }
  return JSON.stringify(byProp);
})()`;

/* Two readings of the same scene, reduced to what both agree on. An element
 * only one reading saw, or a property whose value moved, becomes the sentinel
 * so that every snapshot spells the instability the same way. */
const UNSTABLE = '\u0000unstable';
function stableOnly(a, b) {
  const out = {};
  for (const el of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!a[el] || !b[el]) { out[el] = UNSTABLE; continue; }
    const rec = {};
    for (const prop of new Set([...Object.keys(a[el]), ...Object.keys(b[el])])) {
      rec[prop] = a[el][prop] === b[el][prop] ? a[el][prop] : UNSTABLE;
    }
    out[el] = rec;
  }
  return out;
}


/* Whatever the real mouse pointer happens to be over is in :hover, and this
 * harness reads computed styles — so a cursor resting on a .pill made that
 * button's colour part of the snapshot, and two runs taken with the pointer in
 * different places disagreed about it. It cost one false regression report
 * before it was understood. Parking a synthetic pointer at a fixed, inert
 * corner of the window makes the hover set the same on every run. */
async function neutraliseHover(cdp) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, buttons: 0 });
}

async function capture(outFile, mode) {
  const { cdp, stop } = await launchApp({ port: PORT });
  try {
    await cdp.send('Runtime.enable');
    // let fonts, the first paint and any startup animation settle
    await evaluate(cdp, 'document.fonts.ready.then(() => 1)');
    await sleep(2500);

    /* Computed mode only, and it is not optional. The chips in the top bar
     * carry `transition: color .12s`, so a snapshot taken right after a theme
     * switch records the colour part-way between the two themes — which is why
     * this harness once reported ~1000 differing declarations for a tree that
     * had not changed. Killing every transition and animation makes the switch
     * instant. It is injected as a sheet, so it would show up in a cascade
     * dump: that mode never gets it, and does not need it. */
    if (mode !== 'cascade') {
      await evaluate(cdp, `(() => {
        const st = document.createElement('style');
        st.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
        document.head.appendChild(st);
        return 1;
      })()`);
    }

    if (mode === 'cascade') {
      const dump = JSON.parse(await evaluate(cdp, CASCADE));
      if (dump.__error) throw new Error('could not read the sheets: ' + dump.__error);
      fs.writeFileSync(outFile, JSON.stringify(dump));
      const n = Object.values(dump).reduce((a, v) => a + v.length, 0);
      console.log(`wrote ${outFile}: cascade dump, ${Object.keys(dump).length} properties, ${n} declarations`);
      return;
    }

    const snapshot = {};
    for (const mode of MODES) {
      await evaluate(cdp, `(() => {
        const r = document.documentElement;
        r.setAttribute('data-theme', ${JSON.stringify(mode.attrs.theme)});
        r.setAttribute('data-native', ${JSON.stringify(mode.attrs.native)});
        r.setAttribute('data-reduce-transparency', ${JSON.stringify(mode.attrs.rt)});
        return 1;
      })()`);
      await sleep(150); // the switch itself repaints; transitions are already off
      for (const [view, setup] of Object.entries(VIEWS)) {
        await neutraliseHover(cdp);
        if (view === 'reset') { await evaluate(cdp, setup); continue; }
        await evaluate(cdp, setup);
        await sleep(120);
        /* Twice, half a second apart, keeping only what agreed. The app fills
         * live numbers in as they arrive from main — the usage meters are the
         * loud ones — and a property still settling is not evidence about a
         * CSS move either way. Recording the disagreements as one sentinel
         * drops them from every diff instead of leaving them to masquerade as
         * findings, which is what they did before this existed. */
        const first = JSON.parse(await evaluate(cdp, WALKER));
        await sleep(500);
        const second = JSON.parse(await evaluate(cdp, WALKER));
        snapshot[`${mode.key}/${view}`] = stableOnly(first, second);
      }
    }
    fs.writeFileSync(outFile, JSON.stringify(snapshot));
    const els = Object.values(snapshot).reduce((n, v) => n + Object.keys(v).length, 0);
    console.log(`wrote ${outFile}: ${Object.keys(snapshot).length} view/mode pairs, ${els} elements`);
  } finally {
    await stop();
  }
}

/* The noise floor this project actually has: "Native Apple style" resolves
 * macOS's own accent and appearance colours, and Chromium re-derives every
 * oklab/rgb value from them per run — so the same rule comes back with a
 * channel moved by one. Two values whose non-numeric shape is identical and
 * whose numbers sit within the margin below are the same value, not a moved
 * rule; a different shape, a different keyword, or a number past the margin
 * still counts.
 *
 * The margin is split on purpose. Colour channels get 1%, which covers the
 * observed ±1-in-255 drift and nothing a human could see. Everything else —
 * a length, a duration, a z-index — gets 0.02 absolute, enough for Chromium's
 * sub-pixel rounding and far too little to hide a rule that actually moved. */
const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
const COLOURY = /\b(rgba?|hsla?|oklab|oklch|lab|lch|color)\(/i;
function sameWithinNoise(x, y) {
  if (typeof x !== 'string' || typeof y !== 'string') return false;
  if (x.replace(NUM, '#') !== y.replace(NUM, '#')) return false; // different shape
  const rel = COLOURY.test(x) ? 0.01 : 0;
  const a = x.match(NUM) || [];
  const b = y.match(NUM) || [];
  for (let i = 0; i < a.length; i++) {
    const na = Number(a[i]);
    const nb = Number(b[i]);
    if (Math.abs(na - nb) > Math.max(0.02, Math.abs(na) * rel)) return false;
  }
  return true;
}

/* A cascade dump is {prop: [decl, ...]}; a computed snapshot is
 * {scene: {element: {prop: value}}}. One glance at the first value tells them
 * apart, and mixing the two would compare nonsense. */
const isCascade = (o) => Array.isArray(Object.values(o)[0]);

/* Per property, the sequence of declarations must be identical — same
 * declarations, same order. Reported as the first divergence per property,
 * because after one insertion every later index differs and listing them all
 * says nothing extra. */
function diffCascade(a, b, aFile, bFile) {
  const rows = [];
  for (const prop of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const xs = a[prop] || [];
    const ys = b[prop] || [];
    if (xs.length !== ys.length) rows.push(`${prop}: ${xs.length} declarations in ${aFile}, ${ys.length} in ${bFile}`);
    const n = Math.min(xs.length, ys.length);
    for (let i = 0; i < n; i++) {
      if (xs[i] === ys[i]) continue;
      rows.push(`${prop}[${i}] reordered:\n    was  ${xs[i]}\n    now  ${ys[i]}`);
      break;
    }
  }
  if (!rows.length) { console.log('EMPTY DIFF — every property\'s cascade order is unchanged'); return 0; }
  console.log(rows.slice(0, 200).join('\n'));
  console.log(`\n${rows.length} properties whose cascade changed`);
  return 1;
}

function diff(aFile, bFile) {
  const a = JSON.parse(fs.readFileSync(aFile, 'utf8'));
  const b = JSON.parse(fs.readFileSync(bFile, 'utf8'));
  if (isCascade(a) !== isCascade(b)) { console.error('one file is a cascade dump and the other a computed snapshot'); return 1; }
  if (isCascade(a)) return diffCascade(a, b, aFile, bFile);
  const rows = [];
  const scenes = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const scene of scenes) {
    const ea = a[scene] || {};
    const eb = b[scene] || {};
    for (const el of new Set([...Object.keys(ea), ...Object.keys(eb)])) {
      const pa = ea[el];
      const pb = eb[el];
      if (!pa) { rows.push(`${scene} ${el}: only in ${bFile}`); continue; }
      if (!pb) { rows.push(`${scene} ${el}: only in ${aFile}`); continue; }
      if (pa === UNSTABLE || pb === UNSTABLE) continue; // never settled in one of the runs
      for (const prop of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
        if (pa[prop] === pb[prop]) continue;
        if (pa[prop] === UNSTABLE || pb[prop] === UNSTABLE) continue;
        if (sameWithinNoise(pa[prop], pb[prop])) continue;
        rows.push(`${scene} ${el} ${prop}: ${pa[prop]} -> ${pb[prop]}`);
      }
    }
  }
  if (!rows.length) { console.log('EMPTY DIFF — the two snapshots are identical'); return 0; }
  console.log(rows.slice(0, 400).join('\n'));
  console.log(`\n${rows.length} differing declarations`);
  return 1;
}

const args = process.argv.slice(2);
if (args[0] === '--diff') {
  process.exit(diff(args[1], args[2]));
} else if (args[0] === '--cascade') {
  capture(args[1] || 'cascade.json', 'cascade').catch((e) => { console.error(e.message); process.exit(1); });
} else {
  capture(args[0] || 'snapshot.json', 'computed').catch((e) => { console.error(e.message); process.exit(1); });
}
