/* The whole ipcMain surface, one file per domain.
 *
 * It used to be a single 900-line function in main.js. The channels are
 * genuinely independent — a workspace handler and a skills handler share
 * nothing but the window — so the split costs nothing and means a change to
 * one domain opens one file.
 *
 * `deps` carries what main.js owns and the handlers borrow: the monitors, the
 * pty manager and the two send helpers. `win` is read through a getter,
 * because macOS rebuilds the window after the last one closes and a captured
 * reference would point at the dead one. */

const registrars = [
  require('./config'),
  require('./openrouter'),
  require('./workspaces'),
  require('./tasks'),
  require('./sessions'),
  require('./skills'),
  require('./system'),
];

// archived tasks always cross IPC without their transcripts: a pre-2.7.0
// archive.json still has them inline, and each one can carry 300KB, so
// `hasSessionLog` is all the renderer gets until task:log is asked for one
const projectArchive = (list) => list.map(({ sessionLog, ...t }) => (
  sessionLog ? { ...t, hasSessionLog: true } : t
));

module.exports = function registerIpc(deps) {
  deps.projectArchive = projectArchive;
  for (const register of registrars) register(deps);
};
