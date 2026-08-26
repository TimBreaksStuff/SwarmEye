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

// archived tasks always cross IPC without their transcripts: each one can carry
// a 300KB sessionLog and the archive holds 200 of them, so `hasSessionLog` is
// all the renderer gets until task:archived-log is asked for one by id
const projectArchive = (list) => list.map(({ sessionLog, ...t }) => (
  sessionLog ? { ...t, hasSessionLog: true } : t
));

module.exports = function registerIpc(deps) {
  deps.projectArchive = projectArchive;
  for (const register of registrars) register(deps);
};
