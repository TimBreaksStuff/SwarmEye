const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = () => path.join(app.getPath('userData'), 'config.json');

const DEFAULT_TASK_CATEGORIES = ['maintenance', 'bugfix', 'features'];

// per-workspace identity colours — assigned round-robin as workspaces are
// added, then surfaced as the rail-tile dot, the flyout swatch picker, and the
// swarm-map slot borders. Chosen to read as a border on both light and dark
// themes. The renderer receives this list over config:get — no hand-synced copy.
const WORKSPACE_COLORS = ['#e5484d', '#e5822d', '#e0b341', '#d6ff4b', '#5bbf3a', '#2bb9a3', '#3d8bf0', '#7c5cff', '#c44de5', '#e5489b', '#8b93a0'];

const DEFAULTS = {
  workspaces: [],
  archivedWorkspaces: [],
  selectedWorkspaceId: null,
  windowBounds: null,
  maxAgents: 10,
  sessions: {},
  usage: {}, // pre-1.45.1 cost/context totals; hooks.js reads these once and writes usage.json from then on
  tasks: [],
  // archivedTasks moved to archive.json (loadArchive below); the key may still
  // exist in an older config.json and is migrated out on first read
  // role presets, seeded from main/roles.js's four built-ins the first time
  // they are asked for and user-editable from then on
  roles: [],
  skills: [],
  localActiveSkills: [], // ids of filesystem-discovered skills marked auto-invoke (see skills.js)
  localOrSkills: [], // ids of filesystem-discovered skills injected into clean OpenRouter agents
  autoUsageLimit: 85,
  lastUsageSnapshot: null, // legacy usage snapshot; usage.js reads it once and writes usage-snapshot.json from then on
  skipPermissions: false,
  openrouterKey: '', // never crosses IPC — see providers.js
  openrouterCatalog: null, // { fetchedAt, models: [{id,label,ctx,in,out,cr,cw}] }
  openrouterAlts: [], // up to 3 slugs `/model` offers alongside the launch model (providers.js)
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE(), 'utf8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (err) {
    // A corrupt config.json (partial write, disk error) must not be silently
    // discarded — the next save() would overwrite it with empty defaults and
    // destroy every workspace/task/session permanently. Preserve it for
    // recovery, unless it simply doesn't exist yet (first run).
    if (err.code !== 'ENOENT') {
      try { fs.copyFileSync(FILE(), FILE() + '.corrupt'); } catch { /* best effort */ }
    }
    cache = { ...DEFAULTS };
  }
  // backfill fields added after a workspace was first saved. Archived entries
  // get them too: re-adding a removed folder pushes the old record straight
  // back into cache.workspaces, without passing through the code that mints one
  for (const list of [cache.workspaces, cache.archivedWorkspaces || []]) {
    list.forEach((ws, i) => {
      if (!Array.isArray(ws.categories)) ws.categories = [...DEFAULT_TASK_CATEGORIES];
      if (!ws.color) ws.color = WORKSPACE_COLORS[i % WORKSPACE_COLORS.length];
    });
  }
  return cache;
}

function save(cfg) {
  cache = cfg;
  const file = FILE();
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // no pretty-print: this runs on every task/session/workspace mutation and
  // the file is read by nothing but this module
  fs.writeFileSync(tmp, JSON.stringify(cfg), 'utf8');
  fs.renameSync(tmp, file);
}

/* Archived tasks live in their own file: each can carry a ~300KB sessionLog
 * and the archive keeps 200 of them, which sized every config.json rewrite
 * (several a minute on a busy board, each a synchronous main-thread
 * stringify+write) by the archive instead of by the change being saved.
 * archive.json is written only when a task is archived or purged. */
const ARCHIVE_FILE = () => path.join(app.getPath('userData'), 'archive.json');

let archiveCache = null;

function loadArchive() {
  if (archiveCache) return archiveCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(ARCHIVE_FILE(), 'utf8'));
    archiveCache = Array.isArray(parsed) ? parsed : [];
  } catch {
    archiveCache = [];
  }
  // one-time migration out of the pre-split config.json key
  const cfg = load();
  if (Array.isArray(cfg.archivedTasks) && cfg.archivedTasks.length) {
    archiveCache = cfg.archivedTasks.concat(archiveCache).slice(0, 200);
    saveArchive(archiveCache);
    delete cfg.archivedTasks;
    save(cfg);
  }
  return archiveCache;
}

function saveArchive(list) {
  archiveCache = list;
  const file = ARCHIVE_FILE();
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(list), 'utf8');
  fs.renameSync(tmp, file);
}

/* Mutates the cache in place rather than replacing it: a caller that took a
 * load() reference, awaited something slow (skills.js clones a repo for up to
 * a minute) and then save()s it back must not write a snapshot that predates
 * every patch made in between. */
function patch(partial) {
  save(Object.assign(load(), partial));
}

module.exports = { load, save, patch, loadArchive, saveArchive, DEFAULT_TASK_CATEGORIES, WORKSPACE_COLORS };
