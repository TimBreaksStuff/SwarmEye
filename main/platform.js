/* The one place that knows which OS we're on.
 *
 * Agents and every helper command (git, find, ln, whisper) run in a POSIX
 * shell: on Windows that shell lives inside WSL and is reached through
 * wsl.exe, on macOS it's the user's login shell. Both ports used to carry
 * their own copy of these four helpers — this module is what let the two
 * trees become one.
 *
 * The command *strings* handed to exec() are identical on both platforms;
 * only the argv that carries them differs. Keep it that way — a caller that
 * needs to know the platform to build its command belongs behind a branch
 * here, not at the call site. */

const { execFile, spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const SHELL = process.env.SHELL || '/bin/zsh';

/* argv that runs `cmd` in a POSIX shell. Windows goes through WSL's bash;
 * macOS uses a login shell so the user's PATH (homebrew, nvm, pyenv) is the
 * same one their terminal has — agents are launched the same way. */
function shellArgv(cmd) {
  return IS_WIN
    ? ['wsl.exe', ['-e', 'bash', '-c', cmd]]
    : [SHELL, ['-lc', cmd]];
}

/* Run a shell command, resolve its stdout, resolve null on any failure.
 * Never rejects — every caller treats "couldn't tell" the same as "no". */
function exec(cmd, timeout = 20000) {
  const [file, args] = shellArgv(cmd);
  return new Promise((resolve) => {
    execFile(file, args, { timeout }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

/* Spawn a shell command as a long-lived process (dictation, setup script) —
 * exec() buffers, this streams. */
function spawnShell(cmd) {
  const [file, args] = shellArgv(cmd);
  return spawn(file, args, IS_WIN ? { windowsHide: true } : {});
}

/* Spawn `bash <script>` — the setup script is a file, not a command string. */
function spawnScript(scriptPath) {
  const p = toShellPath(scriptPath);
  if (p === null) return null;
  return IS_WIN
    ? spawn('wsl.exe', ['-e', 'bash', p], { windowsHide: true })
    : spawn('/bin/bash', [p]);
}

function shQuote(p) {
  return "'" + String(p).replace(/'/g, "'\\''") + "'";
}

/* A host path as the shell sees it. On Windows that means translating
 * C:\Users\foo -> /mnt/c/Users/foo (what wsl.exe sees); on macOS the shell
 * and the app share one filesystem, so it's the identity.
 *
 * Returns null when a Windows path can't be translated — callers treat that
 * as "can't reach it from the shell" rather than guessing. */
function toShellPath(p) {
  if (!IS_WIN) return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return null;
  return '/mnt/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/');
}

module.exports = { IS_WIN, SHELL, exec, spawnShell, spawnScript, shQuote, toShellPath, shellArgv };
