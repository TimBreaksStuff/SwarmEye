#!/usr/bin/env node
/* scripts/check-imports.js — does every name a renderer module uses actually
 * resolve to a local binding or an import?
 *
 * The renderer has no bundler and no linter, so a module that reads a name it
 * forgot to import is valid JavaScript right up until the line runs. If that
 * line is in a branch only real data reaches — a workspace tile, a task card —
 * the app boots perfectly and breaks in front of a user. That is exactly how
 * `Icons` went missing from wsagents.js: the rail threw on the first workspace
 * tile, so a config with seven workspaces rendered one and stopped, while a
 * blank profile looked flawless.
 *
 * This is a static check, so it does not care which branch a line is in.
 *
 *   node scripts/check-imports.js        # exit 1 if anything is unresolved
 *
 * Two rules keep it honest:
 *   - it only reports a name some *other* module exports, so a typo'd global
 *     is not its business and it has nothing to guess about;
 *   - `strip()` below must understand regex literals. The first version did
 *     not, and `s.replace(/[`*_#>]/g, '')` — a regex holding a backtick — made
 *     it treat the whole rest of the file as one template string. Everything
 *     after that line went unchecked, silently, which is the entire reason
 *     this file exists rather than a scratch script.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'renderer');

/* Blank out comments, strings, template literals and regex literals, keeping
 * every newline so reported line numbers point at the real file.
 *
 * Telling a regex literal from division is the one judgement here: a `/` opens
 * a regex only where a value cannot already have ended, i.e. when the previous
 * significant character is not an identifier character, `)`, `]` or `}`. That
 * is the standard heuristic and it is right for everything in this codebase.
 */
function strip(src) {
  const out = [];
  const keep = (ch) => out.push(ch === '\n' ? '\n' : ' ');
  let i = 0;
  const n = src.length;
  let prev = ''; // last significant character emitted

  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';

    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') keep(src[i++]);
      continue;
    }
    if (c === '/' && d === '*') {
      keep(' '); keep(' '); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) keep(src[i++]);
      keep(' '); keep(' '); i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c; keep(' '); i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { keep(src[i]); i++; }
        if (i < n) { keep(src[i]); i++; }
      }
      if (i < n) { keep(' '); i++; }
      prev = 'x';
      continue;
    }
    if (c === '`') {
      keep(' '); i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { keep(src[i]); keep(src[i + 1] === '\n' ? '\n' : ' '); i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { depth++; keep(' '); keep(' '); i += 2; continue; }
        if (depth > 0 && src[i] === '}') { depth--; keep(' '); i++; continue; }
        if (depth > 0) { out.push(src[i]); i++; continue; } // ${…} holds real code
        if (src[i] === '`') { keep(' '); i++; break; }
        keep(src[i]); i++;
      }
      prev = 'x';
      continue;
    }
    if (c === '/' && !/[\w$)\]}]/.test(prev)) {
      // a regex literal: consume it, character classes included, so a quote or
      // a backtick inside one cannot open a string
      keep(' '); i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { keep(src[i]); keep(src[i + 1] === '\n' ? '\n' : ' '); i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { keep(' '); i++; break; }
        else if (src[i] === '\n') break; // unterminated: not a regex after all
        keep(src[i]); i++;
      }
      while (i < n && /[a-z]/.test(src[i])) { keep(src[i]); i++; } // flags
      prev = 'x';
      continue;
    }
    out.push(c);
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

const GLOBALS = new Set((
  'window document console Math JSON Object Array String Number Boolean Date RegExp Map Set WeakMap WeakSet '
  + 'Promise Symbol Error TypeError RangeError Intl Infinity NaN undefined globalThis '
  + 'setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame queueMicrotask structuredClone '
  + 'fetch URL URLSearchParams Blob File FileReader FormData Headers Request Response AbortController AbortSignal TextEncoder TextDecoder '
  + 'localStorage sessionStorage navigator location history screen performance crypto '
  + 'Element HTMLElement Node NodeList Event CustomEvent KeyboardEvent MouseEvent PointerEvent WheelEvent DragEvent InputEvent FocusEvent '
  + 'MutationObserver ResizeObserver IntersectionObserver getComputedStyle matchMedia DOMParser XMLSerializer CSSRule '
  + 'AudioContext webkitAudioContext SpeechSynthesisUtterance speechSynthesis MediaRecorder Notification Image Audio Option CSS '
  + 'DataTransfer Range Selection parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI '
  + 'Terminal FitAddon WebglAddon SearchAddon WebLinksAddon '  // xterm's UMD globals
  + 'export import from as default new typeof instanceof void delete in of let const var function class return if else for while '
  + 'do switch case break continue try catch finally throw await async yield extends super static get set this arguments true false null'
).split(/\s+/));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(DIR).sort();
const src = {}, tops = {}, locals = {}, imported = {};

for (const f of files) {
  const s = strip(fs.readFileSync(f, 'utf8'));
  src[f] = s;
  const top = new Set(), loc = new Set(), imp = new Set();
  for (const m of s.matchAll(/^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) top.add(m[1]);
  for (const m of s.matchAll(/\bimport\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (t) for (const side of t.split(/\s+as\s+/)) imp.add(side.trim());
    }
  }
  for (const m of s.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from/g)) imp.add(m[1]);
  for (const m of s.matchAll(/\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) imp.add(m[1]);
  // any binding introduced anywhere in the file, at any depth
  for (const m of s.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) loc.add(m[1]);
  for (const m of s.matchAll(/(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) {
    for (const x of m[1].split(',')) {
      const k = x.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
      if (k) loc.add(k);
    }
  }
  for (const re of [/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g, /\(([^()]*)\)\s*=>/g]) {
    for (const m of s.matchAll(re)) {
      for (const x of m[1].split(',')) {
        const k = x.split('=')[0].replace(/[{}[\]]/g, '').split(':').pop().trim().replace(/^\.\.\./, '');
        if (k) loc.add(k);
      }
    }
  }
  for (const m of s.matchAll(/(?:^|[^\w.$])([A-Za-z_$][\w$]*)\s*=>/g)) loc.add(m[1]);
  for (const m of s.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) loc.add(m[1]);
  for (const m of s.matchAll(/^\s*(?:async\s+|get\s+|set\s+|\*\s*)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) loc.add(m[1]);
  tops[f] = top; locals[f] = loc; imported[f] = imp;
}

const exported = new Map();
for (const f of files) {
  for (const m of src[f].matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (!exported.has(m[1])) exported.set(m[1], []);
    exported.get(m[1]).push(path.relative(ROOT, f));
  }
}

let bad = 0;
for (const f of files) {
  const s = src[f];
  const seen = new Set();
  for (const m of s.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/g)) {
    const n = m[1];
    if (GLOBALS.has(n) || locals[f].has(n) || tops[f].has(n) || imported[f].has(n)) continue;
    if (!exported.has(n)) continue;
    const rest = s.slice(m.index + n.length);
    if (/^\s*:/.test(rest) && !/^\s*::/.test(rest)) continue; // an object key, not a reference
    const line = s.slice(0, m.index).split('\n').length;
    const key = n + ':' + line;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`MISSING IMPORT  ${path.relative(ROOT, f)}:${line}  ${n}  <- ${exported.get(n).join(', ')}`);
    bad++;
  }
}

console.log(`\n${bad} unresolved reference(s)`);
process.exit(bad ? 1 : 0);
