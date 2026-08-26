# `agent/`

Foreign harnesses. A pane does not have to be Claude Code.

| File | What it is |
|---|---|
| `clean.js` | our own dependency-free CLI, OpenAI wire format straight to openrouter.ai |
| `opencode-plugin.js` | an adapter loaded into the `opencode` CLI |
| `pi-extension.ts` | an adapter loaded into the `pi` CLI |

## The contract

All three earn an ordinary pane by writing the two artifacts `main/hooks.js`
already watches:

1. `hook-state/<sessionId>.json` — the agent's state (busy / waiting / done,
   current tool)
2. a Claude-format transcript JSONL — tokens, cost and the closing summary

Both paths arrive in the environment `main/hooks.js` wraps every launch in:
`SWARMEYE_SESSION` and `SWARMEYE_STATE_DIR`.

So **`hooks.js` needs no change for a new harness.** The price is that the three
duplicate those ~40-line writers on purpose — each is loaded by a foreign
runtime with its own resolver, so they cannot share a module. Keep them in sync
by hand.

## How to test

Launch a pane on that harness (`oc:`, `opencode:` or `pi:` model value) and
watch the status dot and the cost panel: if both move, the two artifacts are
being written correctly. `main/providers.js` decodes the prefix.
