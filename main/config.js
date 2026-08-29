const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = () => path.join(app.getPath('userData'), 'config.json');

const DEFAULT_TASK_CATEGORIES = ['maintenance', 'bugfix', 'features'];

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
  // skills moved to skills.json and openrouterCatalog to openrouter-catalog.json
  // (loadSkills/loadCatalog below) — same reason, same one-time migration
  localActiveSkills: [], // ids of filesystem-discovered skills marked auto-invoke (see skills.js)
  localOrSkills: [], // ids of filesystem-discovered skills injected into clean OpenRouter agents
  autoUsageLimit: 85,
  lastUsageSnapshot: null, // legacy usage snapshot; usage.js reads it once and writes usage-snapshot.json from then on
  skipPermissions: false,
  // "Isolate agents in git worktrees" — one switch for every workspace
  worktrees: false,
  // session id -> { path, branch, base, repo, workspaceId }, written by
  // main/worktree.js. Kept out of `sessions` on purpose: a tree outlives the
  // session metadata, which is dropped the moment an agent exits.
  agentWorktrees: {},
  openrouterKey: '', // never crosses IPC — see providers.js
  openrouterAlts: [], // up to 3 slugs `/model` offers alongside the launch model (providers.js)
  claudeTemplate: '', // path to the standard CLAUDE.md copied into each new workspace (main/template.js)
  // macOS "Native Apple style" (Options → Appearance): the renderer half is a
  // localStorage flag, but the window frame is decided at createWindow, so the
  // setting has to survive here too. Ignored off darwin.
  nativeStyle: false,
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
    list.forEach((ws) => {
      if (!Array.isArray(ws.categories)) ws.categories = [...DEFAULT_TASK_CATEGORIES];
    });
  }
  hoistBlobs(cache); // cache is set first: hoisting save()s, and save() must not re-enter here
  return cache;
}

function save(cfg) {
  cache = cfg;
  // a caller holding a load() reference taken before the one-time migration
  // below must not write the moved blobs back in — they are owned by their own
  // files from then on, and a resurrected key would be read as the newer copy
  delete cfg.skills;
  delete cfg.openrouterCatalog;
  writeJson(FILE(), cfg);
}

// no pretty-print anywhere: these run on ordinary mutations and nothing but
// this module reads the files
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

/* The two blobs that dwarfed everything else in config.json and change almost
 * never: the OpenRouter model catalog (~45KB) and the installed-skill registry
 * (~19KB). Left in config.json they were re-stringified and rewritten by every
 * unrelated save — a window drag, a session's metadata, a task edit — so a
 * 200-byte change cost a 68KB synchronous write on the main thread. Same split,
 * and the same one-time migration, as archive.json below. */
function sideBlob(fileName, empty) {
  const FILE_ = () => path.join(app.getPath('userData'), fileName);
  let blobCache;
  let loaded = false;
  return {
    load() {
      if (loaded) return blobCache;
      load(); // whatever is still in config.json is hoisted out on that first read
      try { blobCache = JSON.parse(fs.readFileSync(FILE_(), 'utf8')); } catch { blobCache = empty; }
      loaded = true;
      return blobCache;
    },
    save(value) {
      blobCache = value;
      loaded = true;
      writeJson(FILE_(), value);
    },
  };
}

const catalogBlob = sideBlob('openrouter-catalog.json', null);
const skillsBlob = sideBlob('skills.json', []);

/* The one-time move out of a pre-split config.json, for every blob in the same
 * pass — save() drops all of their keys, so hoisting them one at a time would
 * let the first mover's save wipe the value the next one had not read yet. An
 * existing split file always wins: once written it is the truth, whatever a
 * stale key still says. */
const HOISTED = [
  ['openrouterCatalog', 'openrouter-catalog.json'],
  ['skills', 'skills.json'],
];

function hoistBlobs(cfg) {
  let moved = false;
  for (const [key, fileName] of HOISTED) {
    if (cfg[key] == null) continue;
    moved = true;
    const file = path.join(app.getPath('userData'), fileName);
    if (!fs.existsSync(file)) writeJson(file, cfg[key]);
  }
  if (moved) save(cfg); // save() is what drops the legacy keys
}

const loadCatalog = () => catalogBlob.load();
const saveCatalog = (cat) => catalogBlob.save(cat);
const loadSkills = () => skillsBlob.load() || [];
const saveSkills = (list) => skillsBlob.save(list);

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
  writeJson(ARCHIVE_FILE(), list);
}

/* Mutates the cache in place rather than replacing it: a caller that took a
 * load() reference, awaited something slow (skills.js clones a repo for up to
 * a minute) and then save()s it back must not write a snapshot that predates
 * every patch made in between. */
function patch(partial) {
  save(Object.assign(load(), partial));
}

module.exports = {
  load, save, patch,
  loadArchive, saveArchive,
  loadCatalog, saveCatalog,
  loadSkills, saveSkills,
  DEFAULT_TASK_CATEGORIES,
};
