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
  tasks: [],
  archivedTasks: [],
  skills: [],
  localActiveSkills: [], // ids of filesystem-discovered skills marked auto-invoke (see skills.js)
  autoUsageLimit: 85,
  lastUsageSnapshot: null,
  skipPermissions: false,
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
  // backfill categories on workspaces saved before this field existed
  for (const ws of cache.workspaces) if (!Array.isArray(ws.categories)) ws.categories = [...DEFAULT_TASK_CATEGORIES];
  for (const ws of cache.archivedWorkspaces || []) if (!Array.isArray(ws.categories)) ws.categories = [...DEFAULT_TASK_CATEGORIES];
  return cache;
}

function save(cfg) {
  cache = cfg;
  const file = FILE();
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function patch(partial) {
  save({ ...load(), ...partial });
}

module.exports = { load, save, patch, DEFAULT_TASK_CATEGORIES };
