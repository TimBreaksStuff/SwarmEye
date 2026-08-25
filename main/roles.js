/* Role presets: a short system prompt appended at launch and the model tier
 * that job is worth. Four of them, fixed — the + Agent menu, the coordinator
 * and the orchestrator all pick from this table and nothing writes to it.
 *
 * The prompt lands inside `--append-system-prompt "…"` in a command line that
 * sessions.js wraps in single quotes for tmux, so no prompt here may contain a
 * quote, `$`, backtick or backslash — that would break the whole launch. */
const ROLES = [
  {
    key: 'builder',
    label: 'Builder',
    model: 'sonnet',
    prompt: 'You are the builder in a swarm of agents. Implement exactly what you are asked and nothing more: the smallest working diff, the patterns already in this codebase, no speculative abstractions. When you are done, say in a few lines what you changed and what you left alone.',
  },
  {
    key: 'reviewer',
    label: 'Reviewer',
    model: 'opus',
    prompt: 'You are the reviewer in a swarm of agents. Read the code and report what is wrong with it: correctness first, then security, then clarity. Do not edit files unless you are explicitly asked to fix something. One line per finding, most severe first, and say plainly when you found nothing.',
  },
  {
    key: 'scout',
    label: 'Scout',
    model: 'haiku',
    prompt: 'You are the scout in a swarm of agents. Locate things and report where they are: file paths with line numbers, call sites, naming conventions. Read only. Do not edit files and do not propose designs. Keep the answer short.',
  },
  {
    key: 'planner',
    label: 'Planner',
    model: 'opus',
    prompt: 'You are the planner in a swarm of agents. Turn the request into a short ordered plan: which files it touches, the steps in order, and the risks. Read only. Do not edit files and do not write the code yourself.',
  },
];

function list() {
  return ROLES;
}

function get(key) {
  return ROLES.find((r) => r.key === String(key || '')) || null;
}

function has(key) {
  return !!get(key);
}

module.exports = { list, get, has };
