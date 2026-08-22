#!/usr/bin/env node
/* SwarmEye clean agent — a dependency-free CLI that runs an OpenRouter model
 * as a bare agent: no Claude Code binary, no Anthropic system prompt, native
 * OpenAI wire format straight to openrouter.ai (see clean-agent-plan.md).
 *
 * It stays a full SwarmEye citizen by emitting the same local artifacts the
 * pipeline already reads: hook-state JSON files (status, activity list) and
 * a Claude-format transcript JSONL (cost panel, model chip, summaries) —
 * hooks.js needs no changes. Standalone use for testing:
 *
 *   OPENROUTER_API_KEY=… node agent/clean.js --model qwen/qwen3-coder-next
 *
 * In-app launches add SWARMEYE_SESSION / SWARMEYE_STATE_DIR /
 * SWARMEYE_TRANSCRIPT env plus --system / --yolo / --continue flags.
 *
 * Everything here is deliberately lean: four tools, no skills, no MCP, no
 * subagents, no auto-compaction (/clear is the tool; a context-overflow
 * error from the API is printed plainly). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL_RE = /^[A-Za-z0-9._/:-]{1,128}$/; // providers.js SLUG_RE minus '~'
const MAX_TOOL_ROUNDS = 100; // one user turn's tool loop; a runaway-model backstop
const TOOL_OUT_HEAD = 20000; // chars of a tool result the model sees...
const TOOL_OUT_TAIL = 8000; // ...head and tail, with a truncation marker between
const BASH_TIMEOUT_MS = 120000;
const REQUEST_TIMEOUT_MS = 600000;
const RETRY_DELAYS_MS = [2000, 6000]; // 429/5xx/network, then the turn gives up
// Without max_tokens OpenRouter budgets for the model's full output allowance
// (65k on some), which 402s any key whose balance can't cover it. 16k is
// plenty for an agent turn.
// ponytail: flat cap — reasoning tokens count against it, so a very long
// think could truncate; per-model caps from the catalog if that ever bites.
const MAX_TOKENS = 16384;

// ---------------------------------------------------------------- arguments
const args = { model: '', system: '', yolo: false, cont: false, contFrom: '', skills: [] };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') args.model = argv[++i] || '';
    else if (argv[i] === '--system') args.system = argv[++i] || '';
    else if (argv[i] === '--yolo') args.yolo = true;
    else if (argv[i] === '--continue') args.cont = true;
    // resume across a pane restart: the new session id is fresh, so the
    // previous session's id names the conversation to pick back up
    else if (argv[i] === '--continue-from') args.contFrom = argv[++i] || '';
    // a skill folder (SKILL.md inside) to load into the system prompt —
    // repeatable; SwarmEye passes the ones flagged for OpenRouter agents
    else if (argv[i] === '--skill') args.skills.push(argv[++i] || '');
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage: clean.js --model <openrouter-slug> [--system <extra prompt>] [--yolo] [--continue]');
      process.exit(0);
    }
    // unknown flags are ignored, so a launcher can grow without breaking old scripts
  }
}
const KEY = process.env.OPENROUTER_API_KEY || '';
if (!KEY) { console.error('clean agent: OPENROUTER_API_KEY is not set'); process.exit(1); }
if (!MODEL_RE.test(args.model)) { console.error('clean agent: --model must be an OpenRouter slug like qwen/qwen3-coder-next'); process.exit(1); }

let model = args.model;
const cwd = process.cwd();
const sessionId = process.env.SWARMEYE_SESSION || '';
const stateDir = process.env.SWARMEYE_STATE_DIR || '';
// /clear rotates onto `<base>.<n>.jsonl` — hooks.js treats a new transcript
// path as a fresh conversation and restarts the pane's tally by itself.
// In-app launches carry no explicit transcript env: the path derives from
// the state dir the hook env already names. --continue-from keys it to the
// *previous* session's id instead, which is what makes a pane restart land
// back in (and keep appending to) the conversation it left. Standalone runs
// land in the OS temp dir.
if (args.contFrom && !/^[A-Za-z0-9_-]{1,64}$/.test(args.contFrom)) args.contFrom = '';
if (args.contFrom) args.cont = true;
const ownerId = args.contFrom || sessionId;
const transcriptBase = (process.env.SWARMEYE_TRANSCRIPT
  || (stateDir && ownerId ? path.join(stateDir, '..', 'clean-transcripts', ownerId + '.jsonl') : path.join(os.tmpdir(), `clean-agent-${process.pid}.jsonl`))
).replace(/\.jsonl$/, '');
// resume must land on the newest rotation — /clear moved the conversation to
// <base>.<n>.jsonl and the messages file rides the transcript's name
let transcriptN = 0;
try { while (fs.existsSync(`${transcriptBase}.${transcriptN + 1}.jsonl`)) transcriptN++; } catch { /* fresh */ }
const transcriptPath = () => transcriptBase + (transcriptN ? `.${transcriptN}` : '') + '.jsonl';
const messagesPath = () => transcriptPath() + '.messages.json';
try { fs.mkdirSync(path.dirname(transcriptPath()), { recursive: true }); } catch { /* transcript is best-effort */ }

// ------------------------------------------------------------------- output
const TTY = process.stdout.isTTY;
const dim = (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s);
const cyan = (s) => (TTY ? `\x1b[36m${s}\x1b[0m` : s);
const red = (s) => (TTY ? `\x1b[31m${s}\x1b[0m` : s);
const out = (s) => process.stdout.write(s);

// ------------------------------------------------- pipeline artifact writers
/* The hook-state file main's HookMonitor watches. Same payload shape Claude
 * Code's hooks pipe through `cat`, same atomic tmp+mv, last event wins. A
 * standalone run (no SWARMEYE_STATE_DIR) skips this silently. */
function writeState(event, extra = {}) {
  if (!stateDir || !sessionId) return;
  const payload = JSON.stringify({
    hook_event_name: event,
    session_id: sessionId,
    transcript_path: transcriptPath(),
    cwd,
    ...extra,
  });
  try {
    const file = path.join(stateDir, sessionId + '.json');
    fs.writeFileSync(file + '.tmp', payload);
    fs.renameSync(file + '.tmp', file);
  } catch { /* status degrades to heuristics; the agent itself is fine */ }
}

/* One Claude-format transcript line per assistant response — exactly the
 * fields hooks.js reads on Stop: type, message.{id,model,usage,content}.
 * OpenRouter's OpenAI-shape usage maps onto Anthropic's: prompt_tokens
 * includes the cached and cache-written slices, Anthropic's input_tokens
 * excludes them. */
function appendTranscript(respId, respModel, text, toolCalls, usage) {
  const d = (usage && usage.prompt_tokens_details) || {};
  const cached = d.cached_tokens || 0;
  const written = d.cache_write_tokens || 0;
  const entry = {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    cwd,
    message: {
      id: respId,
      model: respModel,
      role: 'assistant',
      content: [
        ...(text ? [{ type: 'text', text }] : []),
        ...toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.parsed || {} })),
      ],
      usage: {
        input_tokens: Math.max(0, ((usage && usage.prompt_tokens) || 0) - cached - written),
        output_tokens: (usage && usage.completion_tokens) || 0,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: written,
      },
    },
  };
  try { fs.appendFileSync(transcriptPath(), JSON.stringify(entry) + '\n'); } catch { /* cost panel only */ }
}

/* The other half of the transcript: what you asked. Nothing in the pipeline
 * reads user turns — hooks.js only ever counts assistant ones — but the
 * History screen previews a conversation by its opening request and paints
 * both sides, so a transcript of answers alone would list as a blank row. */
function appendUserTurn(text) {
  const entry = {
    type: 'user',
    timestamp: new Date().toISOString(),
    cwd,
    message: { role: 'user', content: text },
  };
  try { fs.appendFileSync(transcriptPath(), JSON.stringify(entry) + '\n'); } catch { /* history only */ }
}

/* The whole OpenAI-format conversation, rewritten after every response —
 * what --continue reloads. Tiny next to the tokens it saves re-sending. */
function persistMessages() {
  try {
    fs.writeFileSync(messagesPath() + '.tmp', JSON.stringify(messages));
    fs.renameSync(messagesPath() + '.tmp', messagesPath());
  } catch { /* resume only */ }
}

// -------------------------------------------------------------------- tools
/* OpenAI function-calling schemas. bash covers grep/glob/ls; the file tools
 * exist because models are measurably better with dedicated read/edit than
 * with sed/heredocs. Hook tool_name values are the Claude spellings so the
 * pane's activity list renders them like any other agent's. */
const TOOLS = [
  { type: 'function', function: { name: 'bash', description: 'Run a shell command in the working directory. Returns stdout and stderr.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file. Optionally a line range.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', description: '1-based first line' }, limit: { type: 'integer', description: 'max lines' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file with the given content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'str_replace', description: 'Replace an exact string in a file. old_string must occur exactly once.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
];
const HOOK_TOOL_NAMES = { bash: 'Bash', read_file: 'Read', write_file: 'Write', str_replace: 'Edit' };
const NEEDS_PERMISSION = new Set(['bash', 'write_file', 'str_replace']); // reads never prompt, but are confined to cwd

// The API key must not reach anything the model runs: `env`, a build script
// that dumps its environment, anything — tool output is clipped into the pane,
// written to the messages file and re-sent on --continue.
const { OPENROUTER_API_KEY, ...childEnv } = process.env;

/* Every file tool resolves its path through here. Absolute paths and `../`
 * escapes are refused, so one tool call can't reach ~/.ssh, SwarmEye's own
 * config.json (openrouterKey in plaintext) or ~/.claude/.credentials.json.
 * Credential paths that could sit inside a workspace are denied by name too. */
const DENY_RE = /(^|\/)(\.ssh|\.aws|\.gnupg)(\/|$)|(^|\/)\.credentials\.json$/;
function resolveInCwd(p) {
  const file = path.resolve(cwd, String(p || ''));
  const rel = path.relative(cwd, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (DENY_RE.test(file.split(path.sep).join('/'))) return null;
  return file;
}

function clip(s) {
  s = String(s);
  if (s.length <= TOOL_OUT_HEAD + TOOL_OUT_TAIL) return s;
  return s.slice(0, TOOL_OUT_HEAD)
    + `\n…[${s.length - TOOL_OUT_HEAD - TOOL_OUT_TAIL} chars truncated]…\n`
    + s.slice(-TOOL_OUT_TAIL);
}

function runBash(command) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, BASH_TIMEOUT_MS);
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: 'spawn failed: ' + e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = clip(buf);
      if (timedOut) resolve({ ok: false, text: text + `\n[killed after ${BASH_TIMEOUT_MS / 1000}s]` });
      else resolve({ ok: code === 0, text: code === 0 ? (text || '(no output)') : text + `\n[exit ${code}]` });
    });
  });
}

async function runTool(name, input) {
  try {
    if (name === 'bash') {
      if (typeof input.command !== 'string') return { ok: false, text: 'error: command must be a string' };
      return await runBash(input.command);
    }
    const file = resolveInCwd(input.path);
    if (!file) return { ok: false, text: 'error: path is outside the working directory' };
    if (name === 'read_file') {
      let text = fs.readFileSync(file, 'utf8');
      if (input.offset || input.limit) {
        const lines = text.split('\n');
        const start = Math.max(0, (input.offset || 1) - 1);
        text = lines.slice(start, input.limit ? start + input.limit : undefined).join('\n');
      }
      return { ok: true, text: clip(text) };
    }
    if (name === 'write_file') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(input.content ?? ''));
      return { ok: true, text: 'wrote ' + file };
    }
    if (name === 'str_replace') {
      const old = String(input.old_string ?? '');
      const text = fs.readFileSync(file, 'utf8');
      const first = text.indexOf(old);
      if (!old || first < 0) return { ok: false, text: 'error: old_string not found in ' + file };
      if (text.indexOf(old, first + 1) >= 0) return { ok: false, text: 'error: old_string occurs more than once — add surrounding context to make it unique' };
      // slice, not String.replace — $& etc. in new_string must land literally
      fs.writeFileSync(file, text.slice(0, first) + String(input.new_string ?? '') + text.slice(first + old.length));
      return { ok: true, text: 'edited ' + file };
    }
    return { ok: false, text: 'error: unknown tool ' + name };
  } catch (e) {
    return { ok: false, text: 'error: ' + e.message };
  }
}

/* What a call is about, for the one-line echo under the pane's spinner. */
function toolLabel(name, input) {
  const t = name === 'bash' ? input.command : input.path;
  return `${HOOK_TOOL_NAMES[name] || name}(${String(t || '').slice(0, 120)})`;
}

// -------------------------------------------------------------- permissions
const alwaysAllowed = new Set(); // tool names the user answered 'a' for
// Piped/scripted runs are a supported mode, but there is nobody to answer the
// prompt — so the gate denies rather than waving every call through. --yolo is
// how an unattended run says it means it.
const UNATTENDED = !process.stdin.isTTY;
let inputMode = 'prompt'; // 'prompt' | 'busy' | 'confirm' — one stdin handler, three meanings
let confirmResolve = null;

function askPermission(name, input) {
  if (args.yolo || !NEEDS_PERMISSION.has(name) || alwaysAllowed.has(name)) return Promise.resolve(true);
  if (UNATTENDED) return Promise.resolve(false); // nobody to ask — deny, don't assume yes
  out(dim(`\n  allow ${toolLabel(name, input)}? [y]es [n]o [a]lways `));
  writeState('Notification', { message: 'Waiting for permission: ' + toolLabel(name, input) });
  inputMode = 'confirm';
  return new Promise((resolve) => {
    confirmResolve = (key) => {
      inputMode = 'busy';
      confirmResolve = null;
      if (key === 'a') alwaysAllowed.add(name);
      const yes = key === 'y' || key === 'a';
      out(dim(yes ? 'yes\n' : 'no\n'));
      resolve(yes);
    };
  });
}

// ------------------------------------------------------------ the API turn
/* One streaming request. Prints text as it arrives; returns the assembled
 * response. Retries transient failures, then throws to end the turn. */
async function request(cancel) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, tools: TOOLS, stream: true, max_tokens: MAX_TOKENS, usage: { include: true } }),
        // the timeout covers this one request — tool runs and permission
        // waits between requests must not count against it
        signal: AbortSignal.any([cancel, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch (e) {
      if (cancel.aborted || attempt >= RETRY_DELAYS_MS.length) throw e;
      out(red(`\n[network error, retrying] `));
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      if (attempt >= RETRY_DELAYS_MS.length) throw new Error(`HTTP ${res.status}: ${body}`);
      out(red(`\n[HTTP ${res.status}, retrying] `));
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 500)}`);

    let id = null;
    let respModel = null;
    let text = '';
    let reasoning = false;
    const calls = new Map(); // index -> {id, name, args}
    let usage = null;
    let buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        // provider failures after routing arrive inside the 200 stream —
        // surface them instead of finishing an empty turn as if it succeeded
        if (ev.error) throw new Error(ev.error.message || JSON.stringify(ev.error).slice(0, 300));
        if (ev.id) id = ev.id;
        if (ev.model) respModel = ev.model;
        if (ev.usage) usage = ev.usage;
        const delta = (ev.choices && ev.choices[0] && ev.choices[0].delta) || {};
        // thinking models stream a reasoning channel — shown dim, not stored
        if (typeof delta.reasoning === 'string' && delta.reasoning) {
          if (!reasoning) { out(dim('\n· ')); reasoning = true; }
          out(dim(delta.reasoning.replace(/\n/g, '\n· ')));
        }
        if (typeof delta.content === 'string' && delta.content) {
          if (reasoning) { out('\n'); reasoning = false; }
          text += delta.content;
          out(delta.content);
        }
        for (const tc of delta.tool_calls || []) {
          const cur = calls.get(tc.index) || { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function && tc.function.name) cur.name += tc.function.name;
          if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
          calls.set(tc.index, cur);
        }
      }
    }
    const toolCalls = [...calls.values()].map((c) => {
      let parsed = null;
      try { parsed = JSON.parse(c.args); } catch { /* left null; the tool reports it */ }
      return { ...c, parsed };
    });
    return { id, respModel, text, toolCalls, usage };
  }
}

/* One user turn: request → run tools → repeat until the model stops. */
let turnAbort = null;
async function runTurn() {
  inputMode = 'busy';
  writeState('UserPromptSubmit');
  turnAbort = new AbortController();
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const r = await request(turnAbort.signal);
      appendTranscript(r.id || 'gen_' + Date.now(), r.respModel || model, r.text, r.toolCalls, r.usage);
      if (!r.toolCalls.length) {
        messages.push({ role: 'assistant', content: r.text });
        persistMessages();
        break;
      }
      messages.push({
        role: 'assistant',
        content: r.text || null,
        tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
      });
      for (const c of r.toolCalls) {
        const input = c.parsed || {};
        const hookName = HOOK_TOOL_NAMES[c.name] || c.name;
        let result;
        // Ctrl+C mid-batch: the remaining calls (writes included) must not
        // run — answer them all so the messages array stays well-formed
        if (turnAbort.signal.aborted) {
          messages.push({ role: 'tool', tool_call_id: c.id, content: 'Cancelled by user.' });
          continue;
        }
        out(cyan(`\n● ${toolLabel(c.name, input)}`));
        if (!(await askPermission(c.name, input))) {
          result = { ok: false, text: 'User denied this tool call.' };
          // unsticks the pane from "waiting on permission" while the model
          // streams its reaction to the denial
          writeState('PostToolUse', { tool_name: hookName, tool_input: input, tool_response: { success: false, error: 'denied by user' } });
        } else {
          writeState('PreToolUse', { tool_name: hookName, tool_input: input });
          result = c.parsed ? await runTool(c.name, input) : { ok: false, text: 'error: arguments were not valid JSON' };
          writeState('PostToolUse', { tool_name: hookName, tool_input: input, tool_response: { success: result.ok, ...(result.ok ? {} : { error: result.text.slice(0, 200) }) } });
        }
        const preview = result.text.split('\n').slice(0, 3).join('\n    ').slice(0, 300);
        out(dim(`\n  ⎿ ${result.ok ? '' : red('✗ ')}${preview}\n`));
        messages.push({ role: 'tool', tool_call_id: c.id, content: result.text });
      }
      persistMessages();
      if (round === MAX_TOOL_ROUNDS - 1) out(red(`\n[stopped after ${MAX_TOOL_ROUNDS} tool rounds]`));
    }
  } catch (e) {
    if (turnAbort.signal.aborted) out(red('\n^C turn cancelled'));
    else out(red('\n[error] ' + e.message)); // context overflow lands here, printed plainly
  } finally {
    turnAbort = null;
    writeState('Stop');
    inputMode = 'prompt';
    prompt();
  }
}

// -------------------------------------------------------------------- input
/* Raw-mode line reader with the paste contract the task board relies on
 * (clean-agent-plan.md): a chunk containing a newline is a paste and is
 * inserted literally; only a lone Enter keystroke submits. */
let buffer = '';
let lastCtrlC = 0;
const stdinDecoder = new (require('string_decoder').StringDecoder)('utf8');

function prompt() {
  out('\n' + cyan('› '));
  if (buffer) out(buffer); // survives a /clear repaint
}

function submit() {
  const text = buffer.trim();
  buffer = '';
  if (!text) { prompt(); return; }
  out('\n');
  // only the builtins are commands — task text can legitimately start with a
  // path ("/Users/... has a bug"), which must reach the model, not /help
  if (/^\/(exit|quit|model|yolo|clear|help)(\s|$)/.test(text)) { command(text); return; }
  // a failed turn can leave its user message unanswered; a second consecutive
  // user role 400s strict-alternation providers on every later turn, so merge
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') last.content += '\n' + text;
  else messages.push({ role: 'user', content: text });
  appendUserTurn(text);
  runTurn();
}

function command(text) {
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  if (cmd === '/exit' || cmd === '/quit') process.exit(0);
  if (cmd === '/model') {
    if (!arg) out(dim('model: ' + model));
    else if (!MODEL_RE.test(arg)) out(red('not a valid model slug'));
    else { model = arg; out(dim('model → ' + model + ' (from the next message)')); }
  } else if (cmd === '/yolo') {
    // the runtime face of --yolo, so the pane's mode select can flip the
    // gate on a running agent: on = gate off (every tool call runs)
    if (arg === 'on') args.yolo = true;
    else if (arg === 'off') args.yolo = false;
    else if (arg) { out(red('usage: /yolo on|off')); prompt(); return; }
    else args.yolo = !args.yolo;
    if (!args.yolo) alwaysAllowed.clear(); // gate back on means a clean slate
    out(dim(args.yolo ? 'permission gate off — every tool call runs' : 'permission gate on — bash/write ask first'));
  } else if (cmd === '/clear') {
    messages.length = 1; // keep the system message
    transcriptN++;
    // create the rotation's transcript now: resume finds rotations by these
    // files, and a lazy one would land a restart back on the cleared talk
    try { fs.appendFileSync(transcriptPath(), ''); } catch { /* resume only */ }
    persistMessages();
    writeState('SessionStart', { source: 'clear' }); // new transcript path resets the pane's tally
    out(dim('conversation cleared'));
  } else if (cmd === '/help') {
    out(dim('/model [slug] · /yolo on|off · /clear · /exit — tools: bash, read, write, replace'));
  } else {
    out(red('unknown command — /help'));
  }
  prompt();
}

function onKey(chunk) {
  // stateful decode: the tty splits big pastes at arbitrary byte boundaries,
  // and a per-chunk toString would turn a split umlaut into U+FFFD
  const s = stdinDecoder.write(chunk);
  if (!s) return;
  if (inputMode === 'confirm') {
    if (s === '\x03') return confirmResolve('n'); // Ctrl+C is a no
    const k = s.toLowerCase();
    if (k === 'y' || k === 'n' || k === 'a' || k === '\x1b') return confirmResolve(k === '\x1b' ? 'n' : k);
    return;
  }
  if (inputMode === 'busy') {
    if (s === '\x03' && turnAbort) turnAbort.abort();
    return; // everything else typed mid-turn is dropped, not queued
  }
  // prompt mode
  if (s === '\x03') { // Ctrl+C: clear the line; twice on an empty one exits
    if (buffer) { buffer = ''; prompt(); return; }
    if (Date.now() - lastCtrlC < 1500) process.exit(0);
    lastCtrlC = Date.now();
    out(dim('\n(ctrl+c again to exit)'));
    prompt();
    return;
  }
  if (s === '\x04') process.exit(0); // Ctrl+D
  // only a lone CR submits — keyboard Enter and the task board's injected
  // Enter both arrive as '\r'. A bare '\n' is only ever a pasted newline (a
  // chunk boundary can isolate one from the rest of its paste), so it inserts.
  if (s === '\r') return submit();
  if (s === '\x7f' || s === '\b') {
    if (!buffer) return;
    const last = buffer[buffer.length - 1];
    buffer = buffer.slice(0, -1);
    if (last !== '\n') out('\b \b'); // can't unpaint a newline; the buffer is still right
    return;
  }
  if (s[0] === '\x1b') return; // arrows etc. — no history, no cursor movement
  // single keystroke or paste; pasted newlines are inserted, never submit
  const text = s.replace(/\r\n?/g, '\n');
  buffer += text;
  out(text);
}

// --------------------------------------------------------------------- main
/* Each --skill folder's SKILL.md, appended to the system prompt under its
 * own heading. YAML frontmatter is dropped (name/description metadata for
 * pickers, not instructions) and the name comes from it when present. The
 * whole text rides every turn's context — the flag in SwarmEye's Skills
 * screen is the place that cost is chosen. */
const SKILL_MAX = 24000; // chars per skill; a longer one is cut, not refused
function loadSkill(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { return ''; }
  let name = path.basename(dir);
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    const m = /^name:\s*(.+)$/m.exec(fm[1]);
    if (m) name = m[1].trim();
    raw = raw.slice(fm[0].length);
  }
  raw = raw.trim();
  if (!raw) return '';
  if (raw.length > SKILL_MAX) raw = raw.slice(0, SKILL_MAX) + '\n…[skill truncated]';
  return `\n\n## Skill: ${name}\n${raw}`;
}

/* The project's own CLAUDE.md, if the working directory has one. Claude Code
 * reads this file by itself; a clean agent has no such convention, so it is
 * loaded here — otherwise a workspace's house rules would apply to some of its
 * agents and not others. Full text, capped like a skill: it rides every turn,
 * which is the price of the model actually following it. */
function loadProjectDoc() {
  let raw;
  try { raw = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8').trim(); } catch { return ''; }
  if (!raw) return '';
  if (raw.length > SKILL_MAX) raw = raw.slice(0, SKILL_MAX) + '\n…[truncated]';
  return `\n\n## Project instructions (CLAUDE.md)\nThese are this repository's own rules. Follow them.\n\n${raw}`;
}

const messages = [{
  role: 'system',
  content: [
    `You are a coding agent working in ${cwd} on ${os.platform() === 'darwin' ? 'macOS' : 'Linux'}.`,
    'Use the tools to inspect and change files and to run commands — read before you write, prefer tools over guessing.',
    'Keep answers concise. When the work is done, summarize what changed in a sentence or two.',
    args.system,
  ].filter(Boolean).join(' ') + loadProjectDoc() + args.skills.map(loadSkill).join(''),
}];

if (args.cont) {
  try {
    const saved = JSON.parse(fs.readFileSync(messagesPath(), 'utf8'));
    if (Array.isArray(saved) && saved.length > 1) {
      messages.splice(0, messages.length, ...saved);
      messages[0] = { role: 'system', content: messages[0].content }; // shape check, cheap
      out(dim(`(continuing — ${saved.length - 1} messages)\n`));
    }
  } catch { /* nothing to continue — start fresh */ }
}

// the effective gate, not the flag: without a tty there is no asking
const gateLabel = args.yolo ? 'permissions off' : UNATTENDED ? 'no tty — bash/write denied' : 'asks before bash/write';
out(dim(`◇ clean agent — ${model}\n  ${cwd} · ${gateLabel} · /help\n`));
writeState('SessionStart', { source: 'startup' });

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on('data', onKey);
  process.stdin.resume();
  prompt();
} else {
  // piped input (tests, scripting): each line is a prompt, run sequentially
  let queue = Promise.resolve();
  const rl = require('readline').createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    queue = queue.then(() => {
      if (!line.trim()) return;
      messages.push({ role: 'user', content: line });
      appendUserTurn(line);
      return runTurn();
    });
  });
  rl.on('close', () => queue.then(() => process.exit(0)));
}
