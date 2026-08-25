const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('swarm', {
  // the renderer's only platform check: picks the shortcut modifier (Cmd vs
  // Ctrl) and the labels that go with it
  isMac: process.platform === 'darwin',
  getConfig: () => ipcRenderer.invoke('config:get'),
  setMaxAgents: (n) => ipcRenderer.invoke('config:set-max-agents', n),
  addWorkspace: () => ipcRenderer.invoke('workspace:add'),
  removeWorkspace: (id) => ipcRenderer.invoke('workspace:remove', id),
  reorderWorkspaces: (ids) => ipcRenderer.invoke('workspace:reorder', ids),
  renameWorkspace: (id, name) => ipcRenderer.invoke('workspace:rename', { id, name }),
  setWorkspaceColor: (id, color) => ipcRenderer.invoke('workspace:set-color', { id, color }),
  setWorkspacePinned: (id, pinned) => ipcRenderer.invoke('workspace:set-pinned', { id, pinned }),
  selectWorkspace: (id) => ipcRenderer.invoke('workspace:select', id),
  addWorkspaceCategory: (id, name) => ipcRenderer.invoke('workspace:add-category', { id, name }),
  removeWorkspaceCategory: (id, name) => ipcRenderer.invoke('workspace:remove-category', { id, name }),
  // the workspace notebook — main resolves the file from the id
  resolvePreview: (workspaceId, preferred) => ipcRenderer.invoke('preview:resolve', { workspaceId, preferred }),
  stopPreview: (workspaceId) => ipcRenderer.invoke('preview:stop', { workspaceId }),
  setAutoUsageLimit: (n) => ipcRenderer.invoke('config:set-auto-usage-limit', n),
  setSkipPermissions: (on) => ipcRenderer.invoke('config:set-skip-permissions', on),
  // the standard CLAUDE.md copied into every workspace folder as it is added;
  // the current path arrives with config:get, these two change it
  pickTemplate: () => ipcRenderer.invoke('template:pick'),
  clearTemplate: () => ipcRenderer.invoke('template:clear'),

  createTask: (payload) => ipcRenderer.invoke('task:create', payload),
  updateTask: (id, patch) => ipcRenderer.invoke('task:update', { id, patch }),
  deleteTask: (id) => ipcRenderer.invoke('task:delete', id),
  purgeTask: (id) => ipcRenderer.invoke('task:purge', id),
  purgeAllTasks: () => ipcRenderer.invoke('task:purge-all'),
  archivedTaskLog: (id) => ipcRenderer.invoke('task:archived-log', id),
  splitTask: (text, workspaceId) => ipcRenderer.invoke('coordinator:split', { text, workspaceId }),
  // a lead agent's plan file: watch it while its pane lives, and take each
  // wave of subtasks back through onOrchestratorPlan below
  watchPlan: (sessionId, workspaceId) => ipcRenderer.invoke('orchestrator:watch', { sessionId, workspaceId }),
  unwatchPlan: (sessionId) => ipcRenderer.invoke('orchestrator:unwatch', { sessionId }),

  listSessions: () => ipcRenderer.invoke('session:list'),
  // scope: a folder inside the workspace this agent may edit, and nothing else
  createSession: (workspaceId, cols, rows, model, role, effort, scope) =>
    ipcRenderer.invoke('session:create', { workspaceId, cols, rows, model, role, effort, scope }),
  listWorkspaceFiles: (id) => ipcRenderer.invoke('workspace:files', id),
  // the areas a workspace's .swarmeye/areas.json carves it into, for scoping
  listAreas: (id) => ipcRenderer.invoke('areas:read', id),
  attachImage: (dataUrl) => ipcRenderer.invoke('attach:image', dataUrl),
  listRoles: () => ipcRenderer.invoke('roles:list'),
  restartSession: (payload) => ipcRenderer.invoke('session:restart', payload),
  reattachSession: (id, cols, rows) => ipcRenderer.invoke('session:reattach', { id, cols, rows }),
  renameSession: (id, name) => ipcRenderer.invoke('session:rename', { id, name }),
  setLastCommand: (id, cmd) => ipcRenderer.invoke('session:set-last-command', { id, cmd }),
  exportSession: (name, text) => ipcRenderer.invoke('session:export', { name, text }),
  writeSession: (id, data) => ipcRenderer.send('session:write', { id, data }),
  resizeSession: (id, cols, rows) => ipcRenderer.send('session:resize', { id, cols, rows }),
  killSession: (id) => ipcRenderer.invoke('session:kill', { id }),

  notify: (payload) => ipcRenderer.send('notify', payload),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  // File objects carry no path in the renderer — resolve it here
  pathForFile: (file) => webUtils.getPathForFile(file),

  refreshUsage: () => ipcRenderer.invoke('usage:refresh'),

  listBranches: (workspaceId) => ipcRenderer.invoke('git:branches', workspaceId),
  gitDiff: (workspaceId) => ipcRenderer.invoke('git:diff', workspaceId),
  checkoutBranch: (workspaceId, branch, create) => ipcRenderer.invoke('git:checkout', { workspaceId, branch, create }),

  // isolated agents: a worktree each (main/worktree.js)
  setWorkspaceIsolate: (id, isolate) => ipcRenderer.invoke('workspace:set-isolate', { id, isolate }),

  listSkills: () => ipcRenderer.invoke('skills:list'),
  installSkill: (repoUrl) => ipcRenderer.invoke('skills:install', repoUrl),
  removeSkill: (id) => ipcRenderer.invoke('skills:remove', id),
  removeSkillRepo: (repoId) => ipcRenderer.invoke('skills:remove-repo', repoId),
  setSkillEnabled: (id, enabled) => ipcRenderer.invoke('skills:set-enabled', { id, enabled }),
  setSkillActive: (id, active) => ipcRenderer.invoke('skills:set-active', { id, active }),
  setSkillOrStartup: (id, on) => ipcRenderer.invoke('skills:set-or-startup', { id, on }),
  updateSkill: (id) => ipcRenderer.invoke('skills:update', id),
  checkSkillUpdates: () => ipcRenderer.invoke('skills:check-updates'),
  skillTerminalCommand: (id) => ipcRenderer.invoke('skills:terminal-command', id),
  onSkillUpdateStatus: (cb) => ipcRenderer.on('skills:update-status', (e, p) => cb(p)),
  copyText: (text) => ipcRenderer.send('clipboard:write', text),
  readText: () => ipcRenderer.invoke('clipboard:read'),

  speechInstalled: () => ipcRenderer.invoke('speech:installed'),
  speechInstall: () => ipcRenderer.invoke('speech:install'),
  onSpeechInstallProgress: (cb) => ipcRenderer.on('speech:install-progress', (e, p) => cb(p)),
  speechStart: (id) => ipcRenderer.invoke('speech:start', id),
  speechAudio: (b64) => ipcRenderer.send('speech:audio', b64),
  speechStop: () => ipcRenderer.send('speech:stop'),
  onSpeechResult: (cb) => ipcRenderer.on('speech:result', (e, p) => cb(p)),
  onSpeechError: (cb) => ipcRenderer.on('speech:error', (e, p) => cb(p)),
  onSpeechEnd: (cb) => ipcRenderer.on('speech:end', (e, p) => cb(p)),
  ttsInstalled: () => ipcRenderer.invoke('tts:installed'),
  ttsInstall: () => ipcRenderer.invoke('tts:install'),
  onTtsInstallProgress: (cb) => ipcRenderer.on('tts:install-progress', (e, p) => cb(p)),
  ttsSpeak: (text) => ipcRenderer.invoke('tts:speak', text),

  onSessionData: (cb) => ipcRenderer.on('session:data', (e, p) => cb(p)),
  onSessionExit: (cb) => ipcRenderer.on('session:exit', (e, p) => cb(p)),
  onSessionState: (cb) => ipcRenderer.on('session:state', (e, p) => cb(p)),
  onUsageUpdate: (cb) => ipcRenderer.on('usage:update', (e, p) => cb(p)),
  onGitUpdate: (cb) => ipcRenderer.on('git:update', (e, p) => cb(p)),
  // one wave of subtasks a lead agent wrote: { sessionId, items } — or
  // { sessionId, items: [], reason } when its plan file didn't parse
  onOrchestratorPlan: (cb) => ipcRenderer.on('orchestrator:plan', (e, p) => cb(p)),
  onHealthUpdate: (cb) => ipcRenderer.on('health:update', (e, p) => cb(p)),
  openrouterStatus: () => ipcRenderer.invoke('openrouter:status'),
  openrouterSetKey: (key) => ipcRenderer.invoke('openrouter:set-key', key),
  openrouterClearKey: () => ipcRenderer.invoke('openrouter:clear-key'),
  openrouterRefresh: () => ipcRenderer.invoke('openrouter:refresh'),
  openrouterSpend: () => ipcRenderer.invoke('openrouter:spend'),
  openrouterSetAlts: (list) => ipcRenderer.invoke('openrouter:set-alts', list),

  getAppVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (e, p) => cb(p)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (e, p) => cb(p)),
  onUpdateReady: (cb) => ipcRenderer.on('update:ready', () => cb()),
  onUpdateError: (cb) => ipcRenderer.on('update:error', (e, p) => cb(p)),
});
