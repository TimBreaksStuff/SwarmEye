const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('swarm', {
  // the renderer's only platform check: picks the shortcut modifier (Cmd vs
  // Ctrl) and the labels that go with it
  isMac: process.platform === 'darwin',
  getConfig: () => ipcRenderer.invoke('config:get'),
  setMaxAgents: (n) => ipcRenderer.invoke('config:set-max-agents', n),
  addWorkspace: () => ipcRenderer.invoke('workspace:add'),
  removeWorkspace: (id) => ipcRenderer.invoke('workspace:remove', id),
  restoreWorkspace: (id) => ipcRenderer.invoke('workspace:restore', id),
  purgeWorkspace: (id) => ipcRenderer.invoke('workspace:purge', id),
  reorderWorkspaces: (ids) => ipcRenderer.invoke('workspace:reorder', ids),
  renameWorkspace: (id, name) => ipcRenderer.invoke('workspace:rename', { id, name }),
  selectWorkspace: (id) => ipcRenderer.invoke('workspace:select', id),
  addWorkspaceCategory: (id, name) => ipcRenderer.invoke('workspace:add-category', { id, name }),
  removeWorkspaceCategory: (id, name) => ipcRenderer.invoke('workspace:remove-category', { id, name }),
  setAutoUsageLimit: (n) => ipcRenderer.invoke('config:set-auto-usage-limit', n),
  setSkipPermissions: (on) => ipcRenderer.invoke('config:set-skip-permissions', on),

  createTask: (payload) => ipcRenderer.invoke('task:create', payload),
  updateTask: (id, patch) => ipcRenderer.invoke('task:update', { id, patch }),
  deleteTask: (id) => ipcRenderer.invoke('task:delete', id),
  purgeTask: (id) => ipcRenderer.invoke('task:purge', id),
  purgeAllTasks: () => ipcRenderer.invoke('task:purge-all'),

  listSessions: () => ipcRenderer.invoke('session:list'),
  createSession: (workspaceId, cols, rows, model) =>
    ipcRenderer.invoke('session:create', { workspaceId, cols, rows, model }),
  restartSession: (payload) => ipcRenderer.invoke('session:restart', payload),
  reattachSession: (id, cols, rows) => ipcRenderer.invoke('session:reattach', { id, cols, rows }),
  renameSession: (id, name) => ipcRenderer.invoke('session:rename', { id, name }),
  exportSession: (name, text) => ipcRenderer.invoke('session:export', { name, text }),
  writeSession: (id, data) => ipcRenderer.send('session:write', { id, data }),
  resizeSession: (id, cols, rows) => ipcRenderer.send('session:resize', { id, cols, rows }),
  killSession: (id) => ipcRenderer.invoke('session:kill', { id }),

  notify: () => ipcRenderer.send('notify'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  // File objects carry no path in the renderer — resolve it here
  pathForFile: (file) => webUtils.getPathForFile(file),

  refreshUsage: () => ipcRenderer.invoke('usage:refresh'),

  listBranches: (workspaceId) => ipcRenderer.invoke('git:branches', workspaceId),
  checkoutBranch: (workspaceId, branch, create) => ipcRenderer.invoke('git:checkout', { workspaceId, branch, create }),

  listSkills: () => ipcRenderer.invoke('skills:list'),
  installSkill: (repoUrl) => ipcRenderer.invoke('skills:install', repoUrl),
  removeSkill: (id) => ipcRenderer.invoke('skills:remove', id),
  removeSkillRepo: (repoId) => ipcRenderer.invoke('skills:remove-repo', repoId),
  setSkillEnabled: (id, enabled) => ipcRenderer.invoke('skills:set-enabled', { id, enabled }),
  setSkillActive: (id, active) => ipcRenderer.invoke('skills:set-active', { id, active }),
  updateSkill: (id) => ipcRenderer.invoke('skills:update', id),
  checkSkillUpdates: () => ipcRenderer.invoke('skills:check-updates'),
  skillTerminalCommand: (id) => ipcRenderer.invoke('skills:terminal-command', id),
  onSkillUpdateStatus: (cb) => ipcRenderer.on('skills:update-status', (e, p) => cb(p)),
  copyText: (text) => ipcRenderer.send('clipboard:write', text),

  speechInstalled: () => ipcRenderer.invoke('speech:installed'),
  speechInstall: () => ipcRenderer.invoke('speech:install'),
  onSpeechInstallProgress: (cb) => ipcRenderer.on('speech:install-progress', (e, p) => cb(p)),
  speechStart: (id) => ipcRenderer.invoke('speech:start', id),
  speechAudio: (b64) => ipcRenderer.send('speech:audio', b64),
  speechStop: () => ipcRenderer.send('speech:stop'),
  onSpeechResult: (cb) => ipcRenderer.on('speech:result', (e, p) => cb(p)),
  onSpeechError: (cb) => ipcRenderer.on('speech:error', (e, p) => cb(p)),
  onSpeechEnd: (cb) => ipcRenderer.on('speech:end', (e, p) => cb(p)),

  onSessionData: (cb) => ipcRenderer.on('session:data', (e, p) => cb(p)),
  onSessionExit: (cb) => ipcRenderer.on('session:exit', (e, p) => cb(p)),
  onSessionState: (cb) => ipcRenderer.on('session:state', (e, p) => cb(p)),
  onUsageUpdate: (cb) => ipcRenderer.on('usage:update', (e, p) => cb(p)),
  onGitUpdate: (cb) => ipcRenderer.on('git:update', (e, p) => cb(p)),
  onHealthUpdate: (cb) => ipcRenderer.on('health:update', (e, p) => cb(p)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (e, p) => cb(p)),
});
