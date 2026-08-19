/* SwarmEye adapter for opencode (opencode.ai) — the plugin that makes an
 * opencode pane a full SwarmEye citizen.
 *
 * It translates opencode's own events into the two artifacts main/hooks.js
 * already watches: the hook-state file (busy / waiting / done + the activity
 * list) and a Claude-format transcript JSONL (cost, context, model chip and
 * the closing summary). Nothing in hooks.js changes — see opencode-pi-plan.md.
 *
 * Loaded per launch via OPENCODE_CONFIG pointing at a config file whose
 * "plugin" array names this file as a file:// URL, so the user's own opencode
 * config is never touched. The SWARMEYE_* env vars come from hooks.claudeCmd.
 *
 * Deliberately duplicates the two writers from agent/clean.js (and from
 * pi-extension.ts) rather than sharing a module: each adapter is loaded by a
 * foreign runtime with its own resolver, and an import that fails there would
 * take the whole agent down. Keep the three in sync by hand — they are ~40
 * lines each and the shapes are fixed by hooks.js.
 *
 * Everything here is best-effort: an event opencode renames degrades one
 * feature (status falls back to output timing, the cost panel stays empty)
 * and never breaks the agent itself. */
import fs from "node:fs";
import path from "node:path";

const sessionId = process.env.SWARMEYE_SESSION || "";
const stateDir = process.env.SWARMEYE_STATE_DIR || "";
// a restart resumes the previous pane's conversation, so its artifacts keep
// the previous id — the cost tally continues instead of starting over
const ownerId = process.env.SWARMEYE_CONTINUE_FROM || sessionId;
const transcriptPath = stateDir && ownerId
  ? path.join(stateDir, "..", "opencode-transcripts", ownerId + ".jsonl")
  : "";
// opencode names its own conversation; a restart can only resume by that id,
// which nothing outside this process sees. Parked next to the transcript for
// main/sessions.js to read at relaunch.
const sidPath = transcriptPath ? transcriptPath + ".session" : "";

/* The hook-state file main's HookMonitor watches: same payload shape Claude
 * Code's hooks pipe through `cat`, same atomic tmp+mv, last event wins. */
function writeState(event, extra) {
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

/* One Claude-format line per assistant message — exactly the fields hooks.js
 * reads on Stop. opencode's token block maps straight onto Anthropic's, with
 * reasoning tokens billed as output (which is how the providers bill them). */
function appendTranscript(info, text) {
  if (!transcriptPath) return;
  const t = info.tokens || {};
  const cache = t.cache || {};
  const entry = {
    type: "assistant",
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    message: {
      id: info.id,
      model: info.modelID,
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      usage: {
        input_tokens: t.input || 0,
        output_tokens: (t.output || 0) + (t.reasoning || 0),
        cache_read_input_tokens: cache.read || 0,
        cache_creation_input_tokens: cache.write || 0,
      },
    },
  };
  try { fs.appendFileSync(transcriptPath, JSON.stringify(entry) + "\n"); } catch { /* cost panel only */ }
}

/* The other half of the transcript: what you asked. Nothing in the pipeline
 * reads user turns — hooks.js only ever counts assistant ones — but the
 * History screen previews a conversation by its opening request and paints
 * both sides, so a transcript of answers alone would list as a blank row. */
function appendUserTurn(text) {
  if (!transcriptPath || !text) return;
  const entry = {
    type: "user",
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    message: { role: "user", content: text },
  };
  try { fs.appendFileSync(transcriptPath, JSON.stringify(entry) + "\n"); } catch { /* history only */ }
}

/* hooks.js reads a tool call's target from Claude's own field names; opencode
 * spells the file tools' argument `filePath`, which would leave the activity
 * row blank. One alias, added alongside the real args rather than replacing
 * them. */
function toolInput(args) {
  const a = args && typeof args === "object" ? args : {};
  return a.filePath && !a.file_path ? { ...a, file_path: a.filePath } : a;
}

/* A handler that throws aborts the whole opencode run — verified, an
 * exception in a plugin hook ends the agent with a stack trace. So every
 * handler is wrapped: a payload that drifts into a shape this file does not
 * expect must cost one feature, never the pane. */
const safe = (fn) => async (...args) => {
  try { return await fn(...args); } catch { /* degrade, never take the agent down */ }
};

export const SwarmEye = async () => {
  // completed assistant messages waiting to be written, in arrival order, and
  // the text parts streamed for each. Both are flushed at session.idle: the
  // transcript must be complete *before* the Stop that makes hooks.js read it.
  const pending = new Map(); // messageID -> info
  const texts = new Map(); // messageID -> Map(partID -> text)
  const written = new Set();
  const seenPrompts = new Set();
  // callID -> tool name, so a permission denial can close the row it opened,
  // and requestID -> callID, which is all the reply itself carries
  const openCalls = new Map();
  const asked = new Map();

  // the prompts of this turn, in arrival order — written ahead of the answers
  // below so the transcript reads as a conversation. Their text arrives as
  // parts like an assistant message's, which is why they wait for the flush
  // too rather than being written where they are first seen.
  const prompts = [];

  const flush = () => {
    for (const id of prompts) {
      const parts = texts.get(id);
      appendUserTurn(parts ? [...parts.values()].join("").trim() : "");
      texts.delete(id);
    }
    prompts.length = 0;
    for (const [id, info] of pending) {
      if (written.has(id)) continue;
      written.add(id);
      const parts = texts.get(id);
      appendTranscript(info, parts ? [...parts.values()].join("").trim() : "");
      texts.delete(id);
    }
    pending.clear();
  };

  try { if (transcriptPath) fs.mkdirSync(path.dirname(transcriptPath), { recursive: true }); } catch { /* best effort */ }
  // opencode creates its session lazily, on the first message — so
  // session.created is far too late to tell the pane the agent is up (a manual
  // pane would sit on output-timing heuristics until its first turn). The
  // plugin factory runs at startup, which is the moment that matters.
  writeState("SessionStart", { source: "startup" });

  return {
    event: safe(async ({ event }) => {
      const p = event.properties || {};
      switch (event.type) {
        case "session.created":
          // opencode's id, for a later restart's --session
          try { if (sidPath && p.info && p.info.id) fs.writeFileSync(sidPath, p.info.id); } catch { /* resume only */ }
          break;
        case "message.updated": {
          const info = p.info;
          if (!info) break;
          if (info.role === "user") {
            // the pane says "vibing..." from here to the first tool call
            if (!seenPrompts.has(info.id)) {
              seenPrompts.add(info.id);
              prompts.push(info.id);
              writeState("UserPromptSubmit");
            }
            break;
          }
          // the title-generating side model would otherwise take over the chip
          if (info.role !== "assistant" || info.agent === "title") break;
          if (info.time && info.time.completed && !written.has(info.id)) pending.set(info.id, info);
          break;
        }
        case "message.part.updated": {
          const part = p.part;
          if (!part || part.type !== "text" || !part.messageID) break;
          if (!texts.has(part.messageID)) texts.set(part.messageID, new Map());
          texts.get(part.messageID).set(part.id, part.text || "");
          break;
        }
        case "permission.asked":
          // the reply names only the request, so the call it belongs to has to
          // be remembered here
          if (p.id && p.tool && p.tool.callID) asked.set(p.id, p.tool.callID);
          writeState("Notification", {
            message: "permission requested: " + (p.permission || "tool"),
          });
          break;
        case "permission.replied": {
          // a denied call never reaches tool.execute.after, so its activity row
          // would stay open for the life of the pane
          const callID = asked.get(p.requestID);
          asked.delete(p.requestID);
          if ((p.reply === "reject" || p.reply === "deny") && callID && openCalls.has(callID)) {
            writeState("PostToolUse", {
              tool_name: openCalls.get(callID),
              tool_response: { success: false, error: "permission denied" },
            });
            openCalls.delete(callID);
          }
          break;
        }
        case "session.idle":
          flush();
          writeState("Stop");
          break;
        default:
          break;
      }
    }),

    "tool.execute.before": safe(async (input, output) => {
      openCalls.set(input.callID, input.tool);
      writeState("PreToolUse", {
        tool_name: input.tool,
        tool_input: toolInput(output && output.args),
      });
    }),

    "tool.execute.after": safe(async (input, output) => {
      openCalls.delete(input.callID);
      const meta = (output && output.metadata) || {};
      writeState("PostToolUse", {
        tool_name: input.tool,
        tool_input: toolInput(input.args),
        tool_response: {
          success: !(typeof meta.exit === "number" && meta.exit !== 0),
          exit: typeof meta.exit === "number" ? meta.exit : undefined,
        },
      });
    }),
  };
};
