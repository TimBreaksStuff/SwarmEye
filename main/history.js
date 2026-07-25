const { exec, shQuote } = require('./platform');
const { claudeProjectDirName } = require('./sessions');

/* Past Claude conversations for a workspace.
 *
 * Claude Code stores every session as ~/.claude/projects/<munged-cwd>/<id>.jsonl
 * — the same munge sessions.js already computes for its "is there anything to
 * --continue?" check, which is why that helper is exported rather than copied.
 * The id in the filename is what `claude --resume <id>` takes, so listing the
 * directory is the whole mechanism: a closed pane stops being a lost thread.
 *
 * Read through the shell, not fs: on Windows those files live inside WSL,
 * where the copy of Claude Code that wrote them runs (same constraint as the
 * credential and transcript reads in usage.js / hooks.js).
 */

// newest first, and only this many — a long-lived project accumulates
// hundreds of transcripts and nobody scrolls past the recent ones
const MAX_SESSIONS = 60;
// how much of a user line is pulled out for the preview; a transcript line
// can be megabytes, so this is a hard cut before it crosses back into the
// main process
const PREVIEW_CHARS = 1200;
// how many user turns to offer the preview picker. The opening turns of a
// SwarmEye-launched session are typically machinery rather than intent — an
// active skill's `/command` envelope, then the skill's own body text that
// Claude Code injects as a user turn in reply — so several spares are fetched
// to reach whatever the human actually asked for.
const PREVIEW_CANDIDATES = 8;
/* Turns that are machinery rather than intent:
 *  - a slash command and its <command-message>/<local-command-stdout> envelope
 *  - "Launching skill: x" and the skill's body, injected as user turns
 *  - a bare `/skill-name` invocation, with or without a word stuck to it
 *    (Claude Code records `add` + `/ponytail` as the single token
 *    "add/dietrichgebert-ponytail-ponytail")
 *  - meta turns (compaction notices and the like)
 * Anything matching is kept only as a fallback, for a conversation that never
 * contained anything else. */
const NOISE_LINE = /<command-name>|<command-message>|<local-command-|"isMeta":\s*true/;
const NOISE_TEXT = /^Base directory for this skill:|^Launching skill:|^\S*\/[a-z0-9][\w-]*$/i;
// candidate lines arrive newline-free, joined by this
const UNIT_SEP = '\x1f';

/* Both stat spellings, because both platforms run their own shell: GNU
 * (`-c %Y`) inside WSL, BSD (`-f %m`) on macOS. Keeping one command string
 * for both is the rule main/platform.js exists to enforce. */
function listScript(dirName) {
  const d = '~/.claude/projects/' + shQuote(dirName);
  return `ls -1t ${d}/*.jsonl 2>/dev/null | head -n ${MAX_SESSIONS} | while read -r f; do ` +
    'm=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null); ' +
    's=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null); ' +
    'printf \'%s\\t%s\\t%s\\t\' "$(basename "$f" .jsonl)" "$m" "$s"; ' +
    `grep -m${PREVIEW_CANDIDATES} '"role":"user"' "$f" 2>/dev/null | cut -c1-${PREVIEW_CHARS} | tr '\\n\\t' '\\037 '; ` +
    'printf \'\\n\'; done';
}

/* Pull something human-readable out of one user line. The line is a JSON
 * object cut off mid-way by the cut above, so this can't JSON.parse it — it
 * matches the first content/text string instead, and tolerates the closing
 * quote having been truncated away. */
function textOf(raw) {
  const m = /"(?:content|text)":"((?:[^"\\]|\\.)*)"/.exec(raw)
    || /"(?:content|text)":"((?:[^"\\]|\\.)*)/.exec(raw);
  if (!m) return '';
  let text = m[1];
  try {
    text = JSON.parse('"' + text.replace(/\\$/, '') + '"');
  } catch {
    text = text.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/* The first user turn that actually says something. SwarmEye types an active
 * skill's `/command` (and `/effort`, `/focus`) into every new agent before its
 * real prompt, and Claude Code answers each by injecting the skill's own text
 * as another user turn — so the first two or three turns of a session are
 * usually machinery. Those are skipped, and only fallen back to when the whole
 * conversation was nothing else. */
function previewOf(raw) {
  if (!raw) return '';
  const lines = raw.split(UNIT_SEP).filter((l) => l.trim());
  let fallback = '';
  for (const line of lines) {
    const text = textOf(line);
    if (!text) continue;
    if (NOISE_LINE.test(line) || NOISE_TEXT.test(text)) {
      fallback = fallback || text;
      continue;
    }
    return text.slice(0, 300);
  }
  return fallback.slice(0, 300);
}

async function listSessions(ws) {
  const out = await exec(listScript(claudeProjectDirName(ws.path)), 25000, { maxBuffer: 4 * 1024 * 1024 });
  if (out == null) return null; // shell unreachable — the caller says so rather than "none"
  const sessions = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [id, mtime, size, ...rest] = line.split('\t');
    if (!id) continue;
    sessions.push({
      id,
      workspaceId: ws.id,
      modifiedAt: (parseInt(mtime, 10) || 0) * 1000,
      size: parseInt(size, 10) || 0,
      preview: previewOf(rest.join('\t')),
    });
  }
  return sessions;
}

module.exports = { listSessions };
