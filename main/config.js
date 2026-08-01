const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = () => path.join(app.getPath('userData'), 'config.json');

const DEFAULT_TASK_CATEGORIES = ['maintenance', 'bugfix', 'features'];

// per-workspace identity colours — assigned round-robin as workspaces are
// added, then surfaced as the rail-tile dot, the flyout swatch picker, and the
// swarm-map slot borders. Chosen to read as a border on both light and dark
// themes. The renderer keeps a matching copy (WS_COLORS in topbar.js).
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
  // backfill identity colour on workspaces saved before this field existed
  cache.workspaces.forEach((ws, i) => { if (!ws.color) ws.color = WORKSPACE_COLORS[i % WORKSPACE_COLORS.length]; });
  (cache.archivedWorkspaces || []).forEach((ws, i) => { if (!ws.color) ws.color = WORKSPACE_COLORS[i % WORKSPACE_COLORS.length]; });
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

module.exports = { load, save, patch, DEFAULT_TASK_CATEGORIES, WORKSPACE_COLORS };
