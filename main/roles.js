const config = require('./config');

/* Role presets: a short system prompt appended at launch and the model tier
 * that job is worth.
 *
 * The four below are the seed, not the table. They are copied into config.json
 * the first time this module is asked for a list, and everything after that
 * reads and writes that copy — so a preset can be reworded, re-tiered, added to
 * or deleted, which the hard-coded const this replaced could not.
 *
 * The prompt lands inside `--append-system-prompt "…"` in a command line that
 * sessions.js wraps in single quotes for tmux. A quote, `$`, backtick or
 * backslash in it would break the whole launch, so `clean()` below strips them
 * on the way in rather than trusting the editor — this is the one field in the
 * app whose contents reach a shell command line verbatim. */
const DEFAULT_ROLES = [
  {
    key: 'builder',
    label: 'Builder',
    model: 'sonnet',
    prompt: 'You are the builder in a swarm of agents. Implement exactly what you are asked and nothing more: the smallest working diff, the patterns already in this codebase, no speculative abstractions. When you are done, say in a few lines what you changed and what you left alone.',
  },
  {
    key: 'reviewer',
    label: 'Reviewer',
    model: 'opus',
    prompt: 'You are the reviewer in a swarm of agents. Read the code and report what is wrong with it: correctness first, then security, then clarity. Do not edit files unless you are explicitly asked to fix something. One line per finding, most severe first, and say plainly when you found nothing.',
  },
  {
    key: 'scout',
    label: 'Scout',
    model: 'haiku',
    prompt: 'You are the scout in a swarm of agents. Locate things and report where they are: file paths with line numbers, call sites, naming conventions. Read only. Do not edit files and do not propose designs. Keep the answer short.',
  },
  {
    key: 'planner',
    label: 'Planner',
    model: 'opus',
    prompt: 'You are the planner in a swarm of agents. Turn the request into a short ordered plan: which files it touches, the steps in order, and the risks. Read only. Do not edit files and do not write the code yourself.',
  },
];

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const MODEL_RE = /^[a-zA-Z0-9._-]{1,40}$/;
const LABEL_MAX = 24;
const PROMPT_MAX = 1200;
const ROLES_MAX = 20;

/* Everything a prompt cannot carry into the tmux command line, plus newlines
 * and control characters (the flag is one line). Removed rather than escaped:
 * an escape would have to survive two layers of quoting to come out right, and
 * a role prompt reads the same without an apostrophe. */
function clean(text, max) {
  return String(text == null ? '' : text)
    .replace(/["'`$\\]/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/* A key from a label, for a role the user just added: lowercase, word chars
 * only, and uniquified against what is already there. */
function keyFrom(label, taken) {
  const base = clean(label, LABEL_MAX).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)
    || 'role';
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  return key;
}

function list() {
  const cfg = config.load();
  if (!Array.isArray(cfg.roles) || !cfg.roles.length) {
    config.patch({ roles: DEFAULT_ROLES.map((r) => ({ ...r })) });
    return config.load().roles;
  }
  return cfg.roles;
}

function get(key) {
  return list().find((r) => r.key === String(key || '')) || null;
}

function has(key) {
  return !!get(key);
}

/* Take the editor's list wholesale — it is the whole table, so a role missing
 * from it is a role deleted. Every field is re-derived here rather than
 * trusted: this is renderer input on its way to a command line. */
function save(incoming) {
  const taken = new Set();
  const out = [];
  for (const raw of Array.isArray(incoming) ? incoming.slice(0, ROLES_MAX) : []) {
    if (!raw || typeof raw !== 'object') continue;
    const label = clean(raw.label, LABEL_MAX);
    const prompt = clean(raw.prompt, PROMPT_MAX);
    // a role with no label or no prompt does nothing at launch — dropping it
    // beats shipping a preset that appends an empty system prompt
    if (!label || !prompt) continue;
    const asked = String(raw.key || '');
    const key = KEY_RE.test(asked) && !taken.has(asked) ? asked : keyFrom(label, taken);
    taken.add(key);
    const model = MODEL_RE.test(String(raw.model || '')) ? String(raw.model) : '';
    out.push({ key, label, model, prompt });
  }
  // never leave the app with no roles at all: an empty table would take the
  // role menu, the coordinator's picker and every saved task's role with it
  const roles = out.length ? out : DEFAULT_ROLES.map((r) => ({ ...r }));
  config.patch({ roles });
  return roles;
}

module.exports = { list, get, has, save, DEFAULT_ROLES };
