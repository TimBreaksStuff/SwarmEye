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

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';

/* macOS: $SHELL can be stale (GUI-launched apps inherit whatever login shell was
 * cached at last login, which may since have been uninstalled/changed) — a
 * nonexistent path here makes every exec() fail with an opaque ENOENT, so fall
 * back to a shell that's actually on disk rather than trusting the env var
 * blindly. sessions.js hands the same value to node-pty. */
function resolveShell() {
  for (const candidate of [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '/bin/sh';
}
const SHELL = resolveShell();

/* argv that runs `cmd` in a POSIX shell. Windows goes through WSL's bash;
 * macOS uses a login shell so the user's PATH (homebrew, nvm, pyenv) is the
 * same one their terminal has — agents are launched the same way. */
function shellArgv(cmd) {
  return IS_WIN
    ? ['wsl.exe', ['-e', 'bash', '-c', cmd]]
    : [SHELL, ['-lc', cmd]];
}

/* Run a shell command, resolve its stdout, resolve null on any failure.
 * Never rejects — every caller treats "couldn't tell" the same as "no".
 *
 * `maxBuffer` raises execFile's 1MB stdout cap; a command that outruns it
 * fails outright, which is why the transcript reader (hooks.js) has to ask
 * for more — session transcripts run to several megabytes. */
function exec(cmd, timeout = 20000, opts = {}) {
  const [file, args] = shellArgv(cmd);
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: opts.maxBuffer || 1024 * 1024 }, (err, stdout) => {
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

/* Start a shell command that must outlive this process — nothing is read back
 * from it and it is never waited on.
 *
 * On Windows it goes through `cmd /c start` rather than being spawned as our
 * own child: a `detached` child is still inside the electron.exe process
 * tree, and `taskkill /T` (how this app is usually stopped) takes the whole
 * tree with it. The empty string is `start`'s window-title argument, which it
 * would otherwise take from the command. */
function spawnDetachedShell(cmd) {
  const child = IS_WIN
    ? spawn('cmd.exe', ['/c', 'start', '', '/b', 'wsl.exe', '-e', 'bash', '-c', cmd],
      { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn(SHELL, ['-lc', cmd], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
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

/* Swap the running app for a freshly downloaded build and relaunch it.
 * `downloadedPath` is a file already sitting on disk (an .exe on Windows, a
 * .zip on macOS) — how to turn that into "the app that starts next time"
 * is exactly the kind of OS-specific mechanics this module exists to hide.
 *
 * Windows: the portable target runs from a temp-extracted copy, and
 * electron-builder points PORTABLE_EXECUTABLE_FILE at the original file the
 * user downloaded — that file isn't locked while running, so it can just be
 * overwritten in place.
 *
 * macOS: the running .app bundle *is* locked while executing, so a detached
 * helper script waits for this process to exit before swapping it — the
 * caller is expected to quit the app right after this returns ok. */
function installUpdate(downloadedPath) {
  if (IS_WIN) {
    const target = process.env.PORTABLE_EXECUTABLE_FILE;
    if (!target) return { ok: false, error: 'not running as a portable build' };
    try {
      fs.copyFileSync(downloadedPath, target);
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
    spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  }

  const bundleRoot = path.resolve(process.execPath, '../../..');
  if (path.extname(bundleRoot) !== '.app') {
    return { ok: false, error: 'not running from an app bundle' };
  }
  const extractDir = downloadedPath + '-extracted';
  try {
    fs.rmSync(extractDir, { recursive: true, force: true });
    execFileSync('unzip', ['-o', '-q', downloadedPath, '-d', extractDir]);
    const entry = fs.readdirSync(extractDir).find((f) => f.endsWith('.app'));
    if (!entry) return { ok: false, error: 'downloaded zip had no .app inside' };
    const newApp = path.join(extractDir, entry);
    const script = [
      '#!/bin/bash',
      'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done',
      'rm -rf "$2"',
      'mv "$3" "$2"',
      'open "$2"',
    ].join('\n');
    const scriptPath = downloadedPath + '-relaunch.sh';
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    spawn('/bin/bash', [scriptPath, String(process.pid), bundleRoot, newApp], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

module.exports = {
  IS_WIN,
  SHELL,
  exec,
  spawnShell,
  spawnScript,
  spawnDetachedShell,
  shQuote,
  toShellPath,
  installUpdate,
};
