/* The coordinator: one headless `claude -p` call that turns a multi-part
 * request into a list of task-board tasks, each with a role preset.
 *
 * Deliberately not an agent of its own. A pane would need a way to hand its
 * plan back — a watched file, or a scraped transcript — while everything
 * downstream of the plan already exists on the board: the scheduler, the
 * agent cap, the usage gate, prompt injection, the closing summary. The only
 * missing piece was something that *produces* tasks, and that is one command.
 *
 * The request is arbitrary user text on its way to a shell, so it never
 * reaches a command line: it goes to a temp file here and claude reads it as
 * stdin (`--print` takes its prompt from there). Only paths we chose ever get
 * interpolated. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, shQuote, toShellPath } = require('./platform');
const { MODEL_FLAGS } = require('./models');
const roles = require('./roles');

// a bad split must not be able to queue fifty agents
const MAX_SUBTASKS = 8;
const MAX_TEXT = 4000;
// a real split is one turn on haiku (~2s of API time), but the CLI boots a
// whole session around it and the default 20s exec timeout is not enough
const SPLIT_TIMEOUT_MS = 180000;

/* The role menu the splitter picks from, built from roles.list() rather than
 * restated here — the same reason roles:list hands the renderer main's own
 * table: the two can never drift into disagreeing about what a role is. */
function roleMenu() {
  return roles.list()
    .map((r) => `- ${r.key} (${r.label}, ${r.model}): ${r.prompt}`)
    .join('\n');
}

function splitPrompt(request, workspaceName) {
  return [
    'You split a development request into independent subtasks for a swarm of coding agents.',
    '',
    `They all work in the same working copy: ${workspaceName}.`,
    '',
    'The roles you can assign, and the system prompt each one launches with:',
    roleMenu(),
    '',
    'Rules:',
    '- Output ONLY a JSON array. No prose, no explanation.',
    '- Each element is {"text": "...", "role": "..."} where role is one of the role keys above.',
    '- Each text must stand alone. The agent that receives it sees nothing else:'
      + ' not this request, not the other subtasks, not your reasoning. Repeat whatever context it needs.',
    `- Between 1 and ${MAX_SUBTASKS} elements. If the request is really one job, return one element.`,
    '- The subtasks run in PARALLEL in that one working copy. Never let two of them edit the same file.'
      + ' If two parts of the request touch the same file, merge them into a single subtask.',
    '- Prefer fewer, larger subtasks over many small ones. Every element costs a whole agent.',
    '- Do not use any tools. Answer from the request text alone.',
    '',
    'The request follows between the markers.',
    '<<<REQUEST',
    request,
    'REQUEST',
  ].join('\n');
}

/* claude wraps the reply in a result envelope; the model's own text is
 * `.result`, and it fences the JSON as ```json despite being told not to —
 * so take the outermost array rather than trusting the shape around it. */
function parsePlan(out) {
  let envelope;
  try {
    envelope = JSON.parse(out);
  } catch {
    return null;
  }
  if (!envelope || envelope.is_error) return null;
  const text = String(envelope.result || '');
  const from = text.indexOf('[');
  const to = text.lastIndexOf(']');
  if (from === -1 || to <= from) return null;
  let items;
  try {
    items = JSON.parse(text.slice(from, to + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  return { items, cost: Number(envelope.total_cost_usd) || 0 };
}

/* Everything the model produced is re-validated before it can reach
 * task:create — an unknown role is dropped to a plain agent rather than
 * failing the whole split, and the list is capped whatever it says. */
function clean(items) {
  return items
    .map((it) => ({
      text: String((it && it.text) || '').slice(0, MAX_TEXT).trim(),
      role: roles.has(String((it && it.role) || '')) ? it.role : '',
      model: MODEL_FLAGS.includes(it && it.model) ? it.model : 'default',
    }))
    .filter((it) => it.text)
    .slice(0, MAX_SUBTASKS);
}

async function split(text, workspaceName) {
  const request = String(text || '').slice(0, MAX_TEXT).trim();
  if (!request) return { ok: false, reason: 'empty-text' };

  const file = path.join(os.tmpdir(), `swarmeye-split-${process.pid}-${Date.now()}.txt`);
  const shellFile = toShellPath(file);
  if (shellFile === null) return { ok: false, reason: 'tmp-unreachable' };

  let out;
  try {
    fs.writeFileSync(file, splitPrompt(request, workspaceName || 'this workspace'), 'utf8');
    // run from /tmp, not the workspace: a project CLAUDE.md and its active
    // skills would be read into the context of a call that only ever splits
    // a sentence, and they are charged for whether or not they are used.
    //
    // …through a *login* shell, because claude is typically installed to
    // ~/.local/bin and only a login shell puts that on PATH. exec() gives one
    // on macOS ($SHELL -lc) but not on Windows (wsl.exe -e bash -c), where
    // the command would otherwise fail with nothing but a null. Agents don't
    // hit this — tmux starts their shell as a login shell itself.
    //
    // Both `exec`s matter: they collapse outer shell -> bash -> claude onto
    // one pid, so the SIGTERM exec()'s timeout sends lands on claude itself.
    // Without them it kills only the shell, and a stalled split keeps running
    // and billing after we've already told the user no-claude.
    const run = `cd /tmp && exec claude -p --model haiku --output-format json < ${shQuote(shellFile)}`;
    out = await exec(`exec bash -lc ${shQuote(run)}`, SPLIT_TIMEOUT_MS, { maxBuffer: 4 * 1024 * 1024 });
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }

  if (!out) return { ok: false, reason: 'no-claude' };
  const plan = parsePlan(out);
  if (!plan) return { ok: false, reason: 'unreadable-plan' };
  const items = clean(plan.items);
  if (!items.length) return { ok: false, reason: 'empty-plan' };
  return { ok: true, items, cost: plan.cost };
}

module.exports = { split, MAX_SUBTASKS };
