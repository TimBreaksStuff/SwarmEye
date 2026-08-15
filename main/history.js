const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { exec, shQuote, toShellPath } = require('./platform');
const { claudeProjectDirName, SESSION_ID_RE } = require('./sessions');

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
// how many of those the History screen itself shows; everything older is
// flagged archived, so the screen's archive section can hold it instead
const RECENT_MAX = 15;
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
    // which model answered last — every assistant entry carries it, so the
    // file's tail is enough (a whole-file grep would re-read megabytes per
    // transcript). "<synthetic>" is Claude Code's marker on error entries,
    // not a model. The History screen badges non-Claude ids, and resume
    // relaunches OpenRouter conversations on their own model.
    'mo=$(tail -c 65536 "$f" 2>/dev/null | grep -o \'"model":"[^"<]*"\' | tail -1 | cut -d\'"\' -f4); ' +
    'printf \'%s\\t%s\\t%s\\t%s\\t\' "$(basename "$f" .jsonl)" "$m" "$s" "$mo"; ' +
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

/* ---- the harnesses that keep their own transcripts ----
 *
 * A clean-agent, opencode or pi pane writes a Claude-format .jsonl of its own
 * (their adapters under agent/), in the user-data folder rather than
 * ~/.claude/projects — Claude Code never sees those conversations, so nothing
 * above finds them. They belong on this screen all the same, and are merged
 * into the one newest-first list.
 *
 * These live in the app's own data folder, a host path on both platforms, so
 * plain `fs` reads them — unlike ~/.claude/projects, which on Windows sits
 * inside WSL and has to go through the shell.
 *
 * The id carries the harness (`clean:s_ab12cd`), and that prefix is what
 * routes a read, a delete and a resume: only opencode can reopen an opencode
 * conversation, and the clean agent continues from its own messages file.
 */
const HARNESS_DIRS = { clean: 'clean-transcripts', opencode: 'opencode-transcripts', pi: 'pi-transcripts' };
// `<session id>.jsonl`, plus the `.<n>` rotations the clean agent's /clear
// leaves behind — each rotation is its own conversation and its own row
const LOCAL_ID_RE = /^(clean|opencode|pi):([A-Za-z0-9_-]{1,64})(\.\d{1,4})?$/;
// enough of the head to hold the folder stamp and the first few turns, enough
// of the tail to hold the model of the last answer. A transcript with a long
// tool output in it is not read whole just to be listed.
const SCAN_HEAD = 128 * 1024;
const SCAN_TAIL = 64 * 1024;

function readAt(file, pos, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, pos);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function localFile(id) {
  const m = LOCAL_ID_RE.exec(String(id || ''));
  return m ? path.join(app.getPath('userData'), HARNESS_DIRS[m[1]], m[2] + (m[3] || '') + '.jsonl') : null;
}

/* Which folder the agent was working in. The adapters stamp `cwd` on every
 * entry, the field Claude's own transcripts carry — it is the only thing that
 * still ties one of these files to a workspace once the pane is gone (session
 * metadata is dropped on exit), so a transcript written before they did is
 * listed nowhere rather than guessed at. */
function firstCwd(head) {
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
  if (!m) return '';
  try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
}

function lastModel(tail) {
  let last = '';
  for (const m of tail.matchAll(/"model":"([^"<]*)"/g)) last = m[1];
  return last;
}

/* The opening request, from the same candidate-and-noise-filter the claude
 * list uses. User turns first; a conversation recorded before the adapters
 * wrote them falls back to whatever the answers say, which at least names
 * what it was about. */
function localPreview(head) {
  const lines = head.split('\n').filter((l) => l.trim());
  const users = lines.filter((l) => l.includes('"type":"user"')).slice(0, PREVIEW_CANDIDATES);
  return previewOf((users.length ? users : lines.slice(0, PREVIEW_CANDIDATES)).join(UNIT_SEP));
}

function listLocal(ws) {
  // the agent's cwd is what its own shell saw: on Windows that is the WSL
  // spelling of the workspace, not the host one
  const roots = [ws.path, toShellPath(ws.path)].filter(Boolean);
  const rows = [];
  for (const harness of Object.keys(HARNESS_DIRS)) {
    const dir = path.join(app.getPath('userData'), HARNESS_DIRS[harness]);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; } // that harness has never run
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue; // .messages.json / .session sidecars
      const file = path.join(dir, f);
      let st;
      let head;
      let tail;
      try {
        st = fs.statSync(file);
        if (!st.size) continue; // created at launch, never written to
        head = readAt(file, 0, Math.min(st.size, SCAN_HEAD));
        tail = st.size > SCAN_HEAD ? readAt(file, st.size - SCAN_TAIL, SCAN_TAIL) : head;
      } catch { continue; }
      const cwd = firstCwd(head);
      if (!roots.some((p) => cwd === p || cwd.startsWith(p + '/') || cwd.startsWith(p + '\\'))) continue;
      rows.push({
        id: harness + ':' + f.slice(0, -'.jsonl'.length),
        workspaceId: ws.id,
        modifiedAt: st.mtimeMs,
        size: st.size,
        model: lastModel(tail),
        preview: localPreview(head),
        harness,
      });
    }
  }
  return rows;
}

/* ---- reading one transcript back out ---- */

// hard cap on how much of a transcript is pulled back; a long session's
// .jsonl runs to tens of megabytes and the modal only has to be readable. It
// is the *tail* that is kept: a session long enough to hit this cap is one
// whose newest turns are the reason it was opened.
const READ_MAX = 16 * 1024 * 1024;
// per-turn cut, so one pasted build log can't dominate the whole view
const TURN_CHARS = 8000;
// and a tool's arguments/output are summarised harder still
const TOOL_CHARS = 2000;

function cut(s, n) {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;
}

/* One content block as a line of transcript. Thinking blocks are dropped —
 * they're mostly signature blobs and carry no readable text in the file. */
function blockText(b) {
  if (typeof b === 'string') return b;
  if (!b || typeof b !== 'object') return '';
  if (b.type === 'text') return String(b.text || '');
  if (b.type === 'tool_use') {
    const input = b.input == null ? '' : (typeof b.input === 'string' ? b.input : JSON.stringify(b.input));
    return `⚙ ${b.name || 'tool'}  ${cut(input, TOOL_CHARS)}`;
  }
  if (b.type === 'tool_result') {
    const c = b.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.map(blockText).filter(Boolean).join('\n')
      : c == null ? '' : JSON.stringify(c);
    return '⤷ ' + cut(text, TOOL_CHARS);
  }
  return '';
}

/* The whole conversation, as turns the History modal can paint. Same shell
 * read as listSessions — on Windows the file lives inside WSL — except for a
 * harness transcript, which is one of ours in the user-data folder and reads
 * with `fs` on both platforms. Same Claude-format lines either way, so there
 * is one parser below and not two. */
async function readSession(ws, id) {
  let out;
  const local = localFile(id);
  if (local) {
    try {
      const size = fs.statSync(local).size;
      const len = Math.min(size, READ_MAX);
      out = readAt(local, size - len, len);
    } catch { return null; } // deleted since it was listed
  } else {
    const f = '~/.claude/projects/' + shQuote(claudeProjectDirName(ws.path)) + '/' + shQuote(id + '.jsonl');
    out = await exec(`tail -c ${READ_MAX} ${f} 2>/dev/null`, 30000, { maxBuffer: READ_MAX + 1024 * 1024 });
  }
  if (out == null) return null; // shell unreachable, or no such transcript
  const turns = [];
  const lines = out.split('\n');
  let parsed = 0;
  for (const line of lines) {
    // up to 16MB of JSONL in one tight loop stalls the main process (frozen
    // IPC, stuttering pty streams) — yield every few thousand lines
    if (++parsed % 5000 === 0) await new Promise((r) => setImmediate(r));
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // the first line may be cut by READ_MAX
    if (o.isMeta) continue;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const content = o.message && o.message.content;
    const text = (typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(blockText).filter(Boolean).join('\n\n')
      : '').trim();
    if (!text) continue;
    turns.push({
      role: o.type,
      text: cut(text, TURN_CHARS),
      at: Date.parse(o.timestamp) || 0,
      sub: !!o.isSidechain, // a subagent's turn, not the main thread's
    });
  }
  return turns;
}

async function listSessions(ws) {
  const out = await exec(listScript(claudeProjectDirName(ws.path)), 25000, { maxBuffer: 4 * 1024 * 1024 });
  if (out == null) return null; // shell unreachable — the caller says so rather than "none"
  const sessions = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [id, mtime, size, model, ...rest] = line.split('\t');
    if (!id) continue;
    sessions.push({
      id,
      workspaceId: ws.id,
      modifiedAt: (parseInt(mtime, 10) || 0) * 1000,
      size: parseInt(size, 10) || 0,
      model: model || '',
      preview: previewOf(rest.join('\t')),
    });
  }
  // the harnesses' own conversations belong in the same list, so the two are
  // merged and re-sorted rather than sectioned: what you want is the newest
  // thread in this folder, whichever CLI wrote it
  const all = sessions.concat(listLocal(ws))
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, MAX_SESSIONS);
  // position is age, so everything past the newest few is the archive
  all.forEach((s, i) => { s.archived = i >= RECENT_MAX; });
  return all;
}

/* Permanently delete these conversations. The ids are the rows the History
 * screen listed — deleting exactly those, rather than re-deriving a set from
 * `ls -1t` at this point, is what keeps the deletion to what the user was
 * looking at: the folder can have gained a transcript since the list was read.
 * Each id still goes through the same shape check history:read applies, since
 * it lands on a shell command line. This is final: the .jsonl is the file
 * `claude --resume` reads, so the conversation is gone with it. */
async function deleteSessions(ws, ids) {
  // a harness transcript is ours, in the user-data folder: unlinked directly,
  // along with the sidecars that ride its name — the clean agent's messages
  // file, and the conversation id opencode and pi resume by. Leaving those
  // behind would let a later restart reopen a conversation whose transcript
  // this click threw away.
  let deleted = 0;
  for (const id of ids) {
    const file = localFile(id);
    if (!file) continue;
    try { fs.unlinkSync(file); } catch { continue; }
    deleted++;
    for (const ext of ['.messages.json', '.session']) {
      try { fs.unlinkSync(file + ext); } catch { /* not every transcript has one */ }
    }
  }
  const safe = ids.filter((id) => SESSION_ID_RE.test(String(id || '')));
  if (!safe.length) return deleted;
  const d = '~/.claude/projects/' + shQuote(claudeProjectDirName(ws.path));
  const files = safe.map((id) => `${d}/${shQuote(id + '.jsonl')}`).join(' ');
  const out = await exec(`rm -f ${files} && echo ok`, 30000);
  return out != null && out.trim().endsWith('ok') ? deleted + safe.length : deleted;
}

/* Both id shapes this module hands out, for the IPC layer to check before an
 * id reaches a path or a command line. */
function validId(id) {
  return SESSION_ID_RE.test(String(id || '')) || LOCAL_ID_RE.test(String(id || ''));
}

/* The session id inside a harness row's id — what a resume hands the launch
 * as the conversation to carry on. The `.<n>` of a rotation is dropped: the
 * clean agent always continues the newest one of a session, which is the file
 * its own --continue-from lands on. */
function localSessionId(id) {
  const m = LOCAL_ID_RE.exec(String(id || ''));
  return m ? m[2] : null;
}

module.exports = { listSessions, readSession, deleteSessions, validId, localSessionId };
