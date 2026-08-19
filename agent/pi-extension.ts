/* SwarmEye adapter for pi (pi.dev) — the extension that makes a pi pane a
 * full SwarmEye citizen.
 *
 * Same job as agent/opencode-plugin.js: translate the harness's own events
 * into the hook-state file and Claude-format transcript main/hooks.js already
 * watches, so status, cost, context and the closing summary work unchanged.
 * See opencode-pi-plan.md.
 *
 * Loaded per launch with `pi -e <this file>`; the SWARMEYE_* env vars come
 * from hooks.claudeCmd. `.ts` because that is pi's documented extension
 * format (it compiles them itself, no build step here) — the contents are
 * deliberately plain JavaScript, so the file has no dependency on pi's type
 * package and cannot fail to compile in a packaged build.
 *
 * pi asks for no permissions by design, so there is no Notification path: a
 * pi agent is always in auto mode, which the pane labels.
 *
 * The two writers are duplicated from clean.js/opencode-plugin.js on purpose
 * — see the note there. Everything is best-effort: a renamed event degrades
 * one feature, never the agent. */
import fs from "node:fs";
import path from "node:path";

const sessionId = process.env.SWARMEYE_SESSION || "";
const stateDir = process.env.SWARMEYE_STATE_DIR || "";
// a restart resumes the previous pane's conversation, so its artifacts keep
// the previous id and the cost tally continues
const ownerId = process.env.SWARMEYE_CONTINUE_FROM || sessionId;
const transcriptPath = stateDir && ownerId
  ? path.join(stateDir, "..", "pi-transcripts", ownerId + ".jsonl")
  : "";

/* The hook-state file main's HookMonitor watches: same payload shape Claude
 * Code's hooks pipe through `cat`, same atomic tmp+mv, last event wins. */
function writeState(event, extra?) {
  if (!stateDir || !sessionId) return;
  const payload = JSON.stringify({
    hook_event_name: event,
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: process.cwd(),
    ...extra,
  });
  try {
    const file = path.join(stateDir, sessionId + ".json");
    fs.writeFileSync(file + ".tmp", payload);
    fs.renameSync(file + ".tmp", file);
  } catch { /* status degrades to heuristics; the agent is fine */ }
}

/* One Claude-format line per assistant message. pi's own message already
 * carries model, usage and a content array of {type:'text'} blocks, so this
 * is close to a field rename — only the usage keys and the id differ.
 * Reasoning tokens bill as output, which is how the providers charge them. */
function appendTranscript(message, id) {
  if (!transcriptPath) return;
  const u = (message && message.usage) || {};
  const entry = {
    type: "assistant",
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    message: {
      id,
      model: message.model,
      role: "assistant",
      content: Array.isArray(message.content)
        ? message.content.filter((c) => c && c.type === "text")
        : [],
      usage: {
        input_tokens: u.input || 0,
        output_tokens: (u.output || 0) + (u.reasoning || 0),
        cache_read_input_tokens: u.cacheRead || 0,
        cache_creation_input_tokens: u.cacheWrite || 0,
      },
    },
  };
  try { fs.appendFileSync(transcriptPath, JSON.stringify(entry) + "\n"); } catch { /* cost panel only */ }
}

/* The other half of the transcript: what you asked. Nothing in the pipeline
 * reads user turns — hooks.js only ever counts assistant ones — but the
 * History screen previews a conversation by its opening request and paints
 * both sides, so a transcript of answers alone would list as a blank row.
 * pi spells a user message the same way it spells an assistant one, a content
 * array of blocks, so the text blocks are all this has to keep. */
function appendUserTurn(message) {
  if (!transcriptPath) return;
  const text = Array.isArray(message && message.content)
    ? message.content.filter((c) => c && c.type === "text").map((c) => c.text || "").join("").trim()
    : typeof (message && message.content) === "string" ? message.content : "";
  if (!text) return;
  const entry = {
    type: "user",
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    message: { role: "user", content: text },
  };
  try { fs.appendFileSync(transcriptPath, JSON.stringify(entry) + "\n"); } catch { /* history only */ }
}

/* A handler that throws must not take the agent with it — opencode was
 * verified to abort its whole run on a plugin exception, and nothing promises
 * pi is gentler. Every handler is wrapped, so a drifting payload shape costs
 * one feature rather than the pane. */
const safe = (fn) => async (...args) => {
  try { return await fn(...args); } catch { /* degrade, never take the agent down */ }
};

export default function (pi: any) {
  // assistant messages wait here until the run settles: the transcript has to
  // be complete before the Stop that makes hooks.js read it. pi's messages
  // carry no id of their own and hooks.js dedupes on one, so they are numbered
  // here — but the number has to be unique across *runs*, not just within one.
  // A resumed pane appends to the conversation's existing transcript, and with
  // a counter that restarts at 1 the first turn after a restart collided with
  // the first turn before it and was silently dropped from the cost tally.
  // Hence the per-process stamp.
  let pending: any[] = [];
  let n = 0;
  const run = Date.now().toString(36);

  const flush = () => {
    for (const m of pending) appendTranscript(m, `pi_${run}_${++n}`);
    pending = [];
  };

  try { if (transcriptPath) fs.mkdirSync(path.dirname(transcriptPath), { recursive: true }); } catch { /* best effort */ }

  pi.on("session_start", safe(async (event: any, ctx: any) => {
    // pi names its own conversation, and only that name can resume it. The id
    // is the uuid half of the session file's name; parked beside the
    // transcript for main/sessions.js to pass back as --session on a restart.
    const file = ctx && ctx.sessionManager && ctx.sessionManager.getSessionFile
      ? ctx.sessionManager.getSessionFile() : null;
    const uuid = file && String(file).match(/([0-9a-fA-F-]{36})\.jsonl$/);
    if (uuid && transcriptPath) {
      try { fs.writeFileSync(transcriptPath + ".session", uuid[1]); } catch { /* resume only */ }
    }
    writeState("SessionStart", { source: event && event.reason === "resume" ? "resume" : "startup" });
  }));

  pi.on("message_end", safe(async (event: any) => {
    const m = event && event.message;
    if (!m) return;
    // the pane says "vibing..." from here to the first tool call
    if (m.role === "user") writeState("UserPromptSubmit");
    else if (m.role === "assistant") pending.push(m);
  }));

  pi.on("tool_execution_start", safe(async (event: any) => {
    writeState("PreToolUse", { tool_name: event.toolName, tool_input: event.args || {} });
  }));

  pi.on("tool_execution_end", safe(async (event: any) => {
    writeState("PostToolUse", {
      tool_name: event.toolName,
      tool_input: event.args || {},
      tool_response: { success: !event.isError, is_error: !!event.isError },
    });
  }));

  // agent_end still leaves pi free to auto-retry or continue; agent_settled is
  // the documented "will not run again on its own" signal, so it is the Stop
  pi.on("agent_settled", safe(async () => {
    flush();
    writeState("Stop");
  }));
}
