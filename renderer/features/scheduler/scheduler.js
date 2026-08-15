/* ---- Task scheduler: the board's tasks, and everything that turns one into
 * a running agent ----
 *
 * Split out of app.js. This owns the queue and the launch sequence — which
 * pending task starts next, spawning its agent, and typing the startup
 * commands (active skills, permission mode, /effort, /focus) in an order that
 * keeps their Stop hooks from being read as the task's own completion.
 *
 * What it deliberately does NOT own: toggleBoard and the board button, which
 * are part of app.js's five-views-in-one-slot swap, not the queue.
 *
 * The Sets and Maps below are exported by reference — app.js's session
 * lifecycle (exit, hook events) adds to and deletes from them, which needs no
 * setter. usageSnapshot is a value, so it gets one.
 */

import { maxAgents, autoUsageLimit, taskSummaries } from '../settings/settings.js';

/* set once by init() — what the scheduler needs from app.js: the shared state,
 * the pane/grid plumbing a launch goes through, and the view swap onJump uses */
let ctx = null;
export function init(context) { ctx = context; }

/* the latest usage poll, from app.js's usage:update subscriber — the auto
 * gate and "next session" both read it */
export function setUsageSnapshot(snap) { usageSnapshot = snap; }

export const pendingTaskStarts = new Map(); // sessionId -> {taskId, injected}
export const skillInjectAttempted = new Set(); // sessionId — every new session gets one attempt, task or manual
// sessionId — a task's prompt has been submitted but its own turn hasn't
// started yet. Every startup injection (an active skill's /command, /effort,
// /focus) is a real turn of its own, so it fires a Stop hook; without this
// gate the first of those Stops completes the task and closes the pane before
// the task text has even been typed.
export const awaitingTaskTurn = new Set();
export const manualStartRun = new Set(); // sessionId — manually-added agents run their startup sequence (skills, then default mode) once
export const manualLaunchOpts = new Map(); // sessionId -> the empty-workspace card's picks for this launch, read once by startManualSession
export const sessionStarted = new Set(); // sessionId — its SessionStart hook has arrived, i.e. claude's CLI is really up
let usageSnapshot = null;
let schedulerRunning = false;
let schedulerQueued = false;
export const TASK_INJECT_SETTLE_MS = 500; // grace after SessionStart for the mode footer to draw
export const TASK_INJECT_FALLBACK_MS = 5000; // covers sessions whose hooks never fire
export const TASK_SUBMIT_DELAY_MS = 150; // gap before Enter so it lands as its own keystroke, not part of a pasted chunk
export const TASK_MODEL_SETTLE_MS = 600; // grace for the "/model"/"/effort"/"/focus" confirmation line to print before the prompt follows
const DEFAULT_MODE_TRIES = 3; // Shift+Tab laps allowed before giving up on the Options default mode
const DEFAULT_MODE_RETRY_MS = 1500; // gap between those laps — also the window autoAcceptDialogs needs to clear a blocking dialog
const CLAUDE_READY_TIMEOUT_MS = 90000; // how long the mode cycler waits for a SessionStart before cycling blind (hookless sessions)
// uninterrupted idle that counts as "the startup turns are over" — longer than
// hooks.js's 3s state sweep, which is what actually delivers those events when
// fs.watch misses a write (the state dir is written from the WSL side)
const INJECT_QUIET_MS = 4000;
const INJECT_QUIET_MAX_MS = 90000; // ... but a wedged startup turn must not hold a task's prompt forever
const INJECT_POLL_MS = 200;

/* Waits for the turns started by the startup injections to finish. Typing an
 * active skill's `/command` (or `/effort`, or `/focus`) is a real turn that
 * ends in a Stop hook — send the agent's actual prompt while one is still
 * running and that Stop lands *after* the prompt is in, where a task reads it
 * as its own completion and 'close on complete' kills the agent mid-work.
 * Waiting the injections out is what keeps the two apart. */
export async function waitForInjectionsToSettle(pane) {
  const deadline = Date.now() + INJECT_QUIET_MAX_MS;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if (pane.exited) return;
    if (pane.working) quietSince = Date.now();
    else if (Date.now() - quietSince >= INJECT_QUIET_MS) return;
    await new Promise((r) => setTimeout(r, INJECT_POLL_MS));
  }
}

/* Types `/<id>` for every skill marked "active" in the Skills screen, right
 * when a brand-new agent starts — task-created or the plain "+ Coding Agent"
 * button alike — so it's invoked from turn one instead of waiting on the
 * model to notice it's relevant on its own. Idempotent per session: whichever
 * trigger (SessionStart hook or the fallback timer) fires first wins.
 *
 * Several skills go in as one `/a /b /c` message rather than one message
 * each: claude expands a leading skill plus up to five more stacked after it
 * (2.1.199+), so six active skills cost one turn instead of six. Expansion
 * stops at the first token that isn't an inline skill, and everything from
 * there on is read as argument text — so a `context: fork` skill ends the run
 * and is sent on a line of its own instead of silently swallowing whatever
 * followed it.
 *
 * Returns how many messages it typed — each is a turn the caller may have to
 * wait out before sending a prompt of its own. */
const SKILL_STACK_MAX = 6; // claude expands the first skill plus five more
async function tryInjectSkills(sessionId) {
  if (skillInjectAttempted.has(sessionId)) return 0;
  const pane = ctx.state.panes.get(sessionId);
  if (!pane || pane.exited) return 0;
  // a bare harness (clean, opencode, pi) has no SwarmEye skill system — a
  // typed /skill command would just be submitted to the model as a prompt
  if (OpenRouterUI.isBare(pane.session.model)) return 0;
  skillInjectAttempted.add(sessionId);
  const active = typeof Skills !== 'undefined' ? await Skills.getActiveSkills() : [];
  // a workspace-local skill only exists for agents running in that folder
  const forHere = active.filter((s) => !s.workspaceId || s.workspaceId === pane.session.workspaceId);
  const runs = [];
  for (const skill of forHere) {
    const open = runs[runs.length - 1];
    const stackable = open && !open.fork && !skill.fork && open.commands.length < SKILL_STACK_MAX;
    if (stackable) open.commands.push('/' + skill.command);
    else runs.push({ fork: !!skill.fork, commands: ['/' + skill.command] });
  }
  for (const run of runs) {
    window.swarm.writeSession(sessionId, run.commands.join(' '));
    await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
    window.swarm.writeSession(sessionId, '\r');
    await new Promise((r) => setTimeout(r, TASK_MODEL_SETTLE_MS));
  }
  return runs.length;
}

/* Set a starting permission mode and keep at it. One attempt is not enough:
 * setMode steers by reading claude's footer, which may not have drawn yet, and
 * the very first use of auto mode on a machine lands on the bypass-permissions
 * warning that swallows the keys — the gap between laps is when the pane's own
 * autoAcceptDialogs clears it. Both launch paths (manual agents and tasks) go
 * through here; the task path used to try once, which is why a worker in a
 * wave would now and then come up in manual mode while its siblings didn't. */
async function applyStartMode(pane, startMode) {
  for (let attempt = 0; attempt < DEFAULT_MODE_TRIES; attempt++) {
    if (pane.exited) return false;
    // only the final lap may complain — the earlier ones are expected to fail
    // on a CLI that is still drawing its first screen
    if (await pane.setMode(startMode, { quiet: attempt < DEFAULT_MODE_TRIES - 1 })) return true;
    await new Promise((r) => setTimeout(r, DEFAULT_MODE_RETRY_MS));
  }
  return false;
}

/* The startup sequence of a manually-added agent (+ Coding Agent / Ctrl+N):
 * active skills first, then the "Default agent permissions" Options setting —
 * strictly in that order, and never twice. The two used to be scheduled as two
 * independent timers, which is why an Options default of "auto" so often
 * didn't take: Shift+Tab landing while a `/skill` command is half-typed is
 * eaten by claude's command autocomplete instead of cycling the mode. Task
 * sessions run the same two steps from tryInjectPrompt, so they are skipped
 * here rather than cycled twice.
 *
 * The mode step waits for the session's SessionStart hook before it starts
 * cycling: on a cold WSL a claude can take the better part of a minute to
 * come up, and Shift+Tab pressed into a terminal it isn't reading yet is
 * simply buffered — the whole 4-press lap arrives at once later and cycles
 * back to where it began. Typed text (the skills above) survives that wait
 * fine, so only the cycling is gated. Sessions whose hooks never fire cycle
 * blind after CLAUDE_READY_TIMEOUT_MS rather than never.
 *
 * setMode is then still retried: it steers by reading claude's footer, which
 * may not have drawn yet, and the very first use of auto mode on a machine
 * lands on the bypass-permissions warning that swallows the keys — the gap
 * between laps is when the pane's own autoAcceptDialogs clears it.
 *
 * An agent launched from the empty-workspace card also carries that card's
 * effort and focus picks (manualLaunchOpts), typed after the mode is settled
 * the same way tryInjectPrompt does it for a task. + Agent and Ctrl+N are
 * deliberately unchanged: they still apply the model and the permission mode
 * only, so a plain agent costs no extra startup turns. */
export async function startManualSession(sessionId) {
  if (manualStartRun.has(sessionId) || pendingTaskStarts.has(sessionId)) return;
  const pane = ctx.state.panes.get(sessionId);
  if (!pane || pane.exited) return;
  // a clean agent takes no start steering at all: no permission footer to
  // set, no /effort or /focus commands — its y/n gate and --yolo (the
  // skip-permissions option) are the whole permission model
  if (OpenRouterUI.isBare(pane.session.model)) return;
  manualStartRun.add(sessionId);
  await tryInjectSkills(sessionId);
  const launch = manualLaunchOpts.get(sessionId);
  const startMode = launch ? launch.startMode : (localStorage.getItem('swarmeye.defaultStartMode') || 'default');
  // named levels already went in as a --effort launch flag (addAgent) —
  // only ultracode/auto, which the flag can't express, are typed here
  const effort = launch && (launch.effort === 'ultracode' || launch.effort === 'auto')
    && !String(launch.model || '').startsWith('or:') ? launch.effort : null;
  const wantFocus = launch ? launch.focus : null;
  if (startMode === 'default' && !effort && wantFocus === null) return;
  for (let waited = 0; !sessionStarted.has(sessionId) && waited < CLAUDE_READY_TIMEOUT_MS; waited += 500) {
    if (pane.exited) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (startMode !== 'default') await applyStartMode(pane, startMode);
  if (effort) {
    if (pane.exited) return;
    pane.setEffort(effort); // the buffer scan catches it too, but only while the confirmation is still on screen
    await typeCommand(sessionId, '/effort ' + effort);
  }
  // `/focus` is a toggle and claude doesn't always start with it off, so send
  // it only when the footer disagrees — that turns it on when wanted and off
  // when claude carried it over from a previous session
  if (wantFocus !== null && !pane.exited && wantFocus !== pane.detectFocus()) {
    await typeCommand(sessionId, '/focus');
  }
}

/* one slash command into a live session: the text, then Enter as its own
 * keystroke, then a beat for claude's confirmation line to print */
async function typeCommand(sessionId, text) {
  window.swarm.writeSession(sessionId, text);
  await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
  window.swarm.writeSession(sessionId, '\r');
  await new Promise((r) => setTimeout(r, TASK_MODEL_SETTLE_MS));
}

export function renderBoard() {
  Board.render(ctx.state.tasks, ctx.state.archivedTasks, ctx.state.workspaces, autoUsageLimit, boardHandlers);
}

export function renderArchive() {
  Board.renderArchive(ctx.state.archivedTasks, ctx.state.workspaces, boardHandlers);
}

/* usage data is percentage-only (Anthropic's API exposes no raw token
 * counts) — "enough budget" gates on the 5-hour session window only. The
 * weekly window resets on its own multi-day clock regardless of what an
 * agent does today, so gating auto-start on it can wedge every "auto" task
 * for days; a task with no session headroom just stays pending and is
 * retried once the next session's usage comes in. Stale/missing data blocks
 * auto-start rather than guessing. */
function usageOk() {
  const s = usageSnapshot;
  if (!s || !s.ok || s.stale) return false;
  const fh = s.fiveHour && s.fiveHour.usedPct;
  return fh != null && fh < autoUsageLimit;
}

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/* A task whose agent dies before it finishes is handed straight back to the
 * queue by app.js's exit handler. That is right for a one-off crash and
 * catastrophic for a launch that can never work — a model alias the shell
 * mangles, a permission dialog nobody answers: the queue starts it, the agent
 * exits, the queue starts it again, and every lap leaves a dead pane behind.
 * An exited pane counts against no cap, so nothing stopped it; on 2026-08-13 a
 * single task filled the grid with a hundred of them and took the app with it.
 *
 * Three laps is the whole allowance. The card then stays on the board as
 * pending — nothing is lost — and its ▶ button is the retry, which clears the
 * count. Renderer-only state: a fresh app run tries again from scratch. */
const START_TRIES = 3;
const startFailures = new Map(); // taskId -> how often its agent has died
const givenUp = new Set(); // taskId -> the scheduler stops picking it up

/* Counts one dead agent against a task. Returns whether it may be retried. */
export function noteStartFailure(task) {
  const laps = (startFailures.get(task.id) || 0) + 1;
  startFailures.set(task.id, laps);
  if (laps < START_TRIES) return true;
  givenUp.add(task.id);
  ctx.toast(`this task's agent exited ${laps} times without finishing — left on the board, press ▶ to try again`);
  return false;
}

export function clearStartFailures(taskId) {
  startFailures.delete(taskId);
  givenUp.delete(taskId);
}

/* starts as many pending "auto"/"next-session" tasks as the agent cap
 * allows, highest priority first (oldest first within the same priority) —
 * this is the literal "spin up as many agents as required within the
 * limit, working the most important tasks first" behavior. "auto" tasks
 * need usage headroom; "next-session" tasks just wait for the wall clock
 * to pass the resets_at captured when they were created. */
export async function runScheduler() {
  if (schedulerRunning) { schedulerQueued = true; return; }
  schedulerRunning = true;
  try {
    const pending = ctx.state.tasks
      .filter((t) => t.status === 'pending' && (t.mode === 'auto' || t.mode === 'next-session')
        && !givenUp.has(t.id) // its agent died on every attempt — see noteStartFailure
        && ctx.state.workspaces.some((w) => w.id === t.workspaceId))
      .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)
        || a.createdAt - b.createdAt);
    for (const task of pending) {
      if (ctx.liveAgentCount() >= maxAgents) break; // agent cap blocks every mode alike
      // a recurring task's next run is queued the moment the previous one
      // finishes — it waits here until its interval is actually up
      if (task.nextRunAt && Date.now() < task.nextRunAt) continue;
      if (task.mode === 'auto') {
        // an OpenRouter task is billed to OpenRouter, not the Anthropic
        // account — Claude session headroom says nothing about whether it can
        // run, and gating on it left such tasks pending forever whenever the
        // Claude window was full (or its usage poll unavailable, which the
        // gate deliberately reads as "no")
        if (!OpenRouterUI.isOpenRouter(task.model) && !usageOk()) continue;
      } else {
        // no resets_at yet (usage wasn't available at creation) — adopt the
        // first one we see and wait for the tick after it actually passes
        if (task.targetResetsAt == null) {
          const resetsAt = usageSnapshot && usageSnapshot.fiveHour && usageSnapshot.fiveHour.resetsAt;
          if (resetsAt) {
            task.targetResetsAt = resetsAt;
            window.swarm.updateTask(task.id, { targetResetsAt: resetsAt });
          }
          continue;
        }
        // targetResetsAt is normally epoch ms, but tasks created before the
        // resets_at normalization fix may have an ISO string persisted —
        // route through Date() so a stale string doesn't silently compare
        // as NaN (always false) and skip the wait entirely
        if (Date.now() < new Date(task.targetResetsAt).getTime()) continue;
      }
      await startTask(task); // sequential: ctx.liveAgentCount() must be current for the next check
    }
  } finally {
    schedulerRunning = false;
    if (schedulerQueued) { schedulerQueued = false; runScheduler(); }
  }
}

/* Resolves an effort pick to what the `--effort` launch flag can carry:
 * 'default' (or nothing) falls back to the Options "Default task effort",
 * and only the five named levels qualify — ultracode/auto have no flag
 * spelling and are still typed as a `/effort` command after start. */
const EFFORT_FLAG_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export function effortFlagValue(pick) {
  const effective = pick && pick !== 'default'
    ? pick
    : (localStorage.getItem('swarmeye.defaultEffort') || 'default');
  return EFFORT_FLAG_LEVELS.includes(effective) ? effective : undefined;
}

/* shared by "start now", manual retry, and the scheduler. notify is only
 * true for user-initiated starts — the scheduler stays silent on failure.
 * Starting a task never jumps the view; it stays wherever the user is
 * (usually the board), so the new active card shows up in place. */
export async function startTask(task, { notify = false } = {}) {
  // synchronous re-entry guard: a second start (double-clicked ▶, or the
  // scheduler picking the task up while a manual start's createSession is
  // still in flight) would spawn two agents for one task. `starting` is
  // renderer-only — not in TASK_PATCH_KEYS, so it never persists.
  if (task.starting || task.status === 'active') return null;
  task.starting = true;
  try {
    // launched as a --model flag (session-only), never a typed `/model`
    // command — that saves as the user's default for new sessions and would
    // bleed this task's choice into every agent started afterward.
    // A role brings its own model tier, so an unset model means "let the role
    // decide" rather than "send the default" — the same rule addAgent uses.
    const modelArg = task.model && task.model !== 'default' ? task.model : undefined;
    // effort rides the same launch-flag path as model (see claudeBase): a
    // typed `/effort` now saves as the user's CLI default and bleeds into
    // every later agent. 'default' falls back to the Options default effort.
    const effortArg = effortFlagValue(task.effort);
    const res = await window.swarm.createSession(task.workspaceId, 100, 30, modelArg, undefined, task.role || undefined, effortArg);
    if (!res.ok) {
      if (notify) {
        ctx.toast(res.reason === 'cap' ? `limit of ${maxAgents} sessions reached — task left pending` : 'could not start task: ' + res.reason);
      }
      return null; // stays pending either way
    }
    const pane = ctx.mountPane(res.session, { managed: true });
    // not for OpenRouter models: main drops --effort there, so the chip would lie
    if (effortArg && !OpenRouterUI.isOpenRouter(task.model)) pane.setEffort(effortArg); // launched via --effort, so no confirmation line for the buffer scan to catch
    task.status = 'active';
    task.paneId = res.session.id;
    task.startedAt = Date.now();
    pane.syncInitialCommandHeader(); // task.paneId is now set, so the lookup in getPaneInitialPrompt resolves
    window.swarm.updateTask(task.id, { status: 'active', paneId: task.paneId, startedAt: task.startedAt });
    renderBoard();
    pendingTaskStarts.set(res.session.id, { taskId: task.id, injected: false });
    setTimeout(() => tryInjectPrompt(res.session.id), TASK_INJECT_FALLBACK_MS);
    return pane;
  } finally {
    delete task.starting;
  }
}

/* delivers the task text through the same safe channel as normal keyboard
 * input (ptys.write) — never the shell command line, which can't safely
 * embed arbitrary text. Fires once: SessionStart or the fallback timer,
 * whichever comes first (`injected` is claimed synchronously).
 * Text and Enter are written as separate, distinctly-timed writes: a single
 * write of `text + '\r'` lands as one chunk that Claude's input box can
 * treat as a paste with an embedded newline (text fills the box but never
 * submits) instead of a real Enter keystroke. */
export async function tryInjectPrompt(sessionId) {
  const entry = pendingTaskStarts.get(sessionId);
  if (!entry || entry.injected) return;
  const pane = ctx.state.panes.get(sessionId);
  const task = ctx.state.tasks.find((t) => t.id === entry.taskId);
  if (!pane || !task || pane.exited) { pendingTaskStarts.delete(sessionId); return; }
  entry.injected = true;
  // the 5s fallback can fire before claude's CLI is even up (cold WSL) —
  // typing skills and the prompt into a terminal it isn't reading yet lands
  // everything as one buffered chunk once it wakes. Wait for SessionStart the
  // same way startManualSession does; hookless sessions fall through after
  // the same timeout instead of never.
  for (let waited = 0; !sessionStarted.has(sessionId) && waited < CLAUDE_READY_TIMEOUT_MS; waited += 500) {
    if (pane.exited) { pendingTaskStarts.delete(sessionId); return; }
    await new Promise((r) => setTimeout(r, 500));
  }
  let typedCommands = await tryInjectSkills(sessionId); // active skills before anything task-specific
  // a bare harness (clean, opencode, pi) has no permission footer to steer
  // and no /focus — the clean agent's gate answers to the keyboard or --yolo,
  // and the other two own their permissions entirely
  const cleanAgent = OpenRouterUI.isBare(task.model);
  // set the starting permission mode before the prompt lands, so the first
  // tool call in e.g. bypass mode isn't blocked on a manual approval
  if (task.startMode !== 'default' && !cleanAgent) await applyStartMode(pane, task.startMode);
  // a clean agent's "auto" is its /yolo gate — without this a scheduled task
  // sits blocked on the first y/n prompt with nobody at the keyboard
  else if (cleanAgent && task.startMode === 'bypass') await pane.pickMode('bypass');
  // model is applied as a --model launch flag in startTask, not here — see
  // the comment there for why a typed `/model` command isn't used
  // the five named levels went in as a --effort launch flag (startTask) —
  // only ultracode/auto, which the flag can't express, are typed here
  // ...but not into an OpenRouter agent: the two typed levels drive
  // Anthropic thinking modes its upstream would reject with a 400
  if ((task.effort === 'ultracode' || task.effort === 'auto') && !OpenRouterUI.isOpenRouter(task.model)) {
    pane.setEffort(task.effort); // the buffer scan catches it too, but only while the confirmation is still on screen
    window.swarm.writeSession(sessionId, '/effort ' + task.effort);
    await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
    window.swarm.writeSession(sessionId, '\r');
    await new Promise((r) => setTimeout(r, TASK_MODEL_SETTLE_MS));
    typedCommands++;
  }
  // `/focus` is a toggle, and claude doesn't always start with it off — so
  // send it only when the footer disagrees with what the task asked for:
  // that both turns it on when wanted and off when claude carried it over
  // from a previous session
  if (!cleanAgent && !!task.focus !== pane.detectFocus()) {
    window.swarm.writeSession(sessionId, '/focus');
    await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
    window.swarm.writeSession(sessionId, '\r');
    await new Promise((r) => setTimeout(r, TASK_MODEL_SETTLE_MS));
    typedCommands++;
  }
  // let those turns finish before the prompt goes in, so their Stop hooks
  // can't be mistaken for this task's own completion (nothing typed = nothing
  // to wait for, and the task starts as immediately as it always did)
  if (typedCommands) await waitForInjectionsToSettle(pane);
  if (pane.exited) { pendingTaskStarts.delete(sessionId); return; }
  // armed before the text goes in and cleared by the first hook event of the
  // task's own turn — until then every Stop belongs to a startup injection
  awaitingTaskTurn.add(sessionId);
  window.swarm.writeSession(sessionId, task.text);
  await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
  window.swarm.writeSession(sessionId, '\r');
  pendingTaskStarts.delete(sessionId);
}

/* The closing message of the turn that just ended, filed on the task that turn
 * completed. It arrives a beat after the Stop that completed the task — the
 * transcript read behind it is async — so the card is matched by pane, and only
 * while its completion is still fresh: a pane reused by a later task must not
 * have that task's summary land on this one. */
const SUMMARY_GRACE_MS = 120000;

export function applyTaskSummary(sessionId, summary) {
  if (!taskSummaries) return;
  const task = ctx.state.tasks.find((t) => t.paneId === sessionId && t.status === 'completed'
    && t.completedAt && Date.now() - t.completedAt < SUMMARY_GRACE_MS);
  if (!task) return;
  task.summary = summary;
  window.swarm.updateTask(task.id, { summary });
  renderBoard();
}

export async function createTask({ text, workspaceId, mode, startMode, model, effort, focus, closeOnComplete, priority, category, chain, repeat, nextRunAt, role }) {
  if (!workspaceId) { ctx.toast('pick a workspace for this task'); return; }
  const targetResetsAt = mode === 'next-session'
    ? (usageSnapshot && usageSnapshot.fiveHour && usageSnapshot.fiveHour.resetsAt) || null
    : null;
  const res = await window.swarm.createTask({ text, workspaceId, mode, startMode, model, effort, focus, closeOnComplete, priority, category, chain, repeat, nextRunAt, targetResetsAt, role });
  if (!res.ok) {
    ctx.toast(res.reason === 'empty-text' ? 'task text can’t be empty' : 'could not create task');
    return;
  }
  ctx.state.tasks.push(res.task);
  renderBoard();
  if (mode === 'auto' || mode === 'next-session') runScheduler();
  else if (mode === 'now') await startTask(res.task, { notify: true });
  // mode === 'manual': task sits in the Manual column untouched
  // the created task goes back to the caller — the orchestrator needs the id
  // it must watch (and, for a 'now' task, the pane startTask just filled in)
  return res.task;
}

/* pipelines: a task can carry follow-up prompts, and each one is queued as a
 * fresh task (same workspace/model/mode settings) when the previous finishes —
 * build → review → fix, unattended. Only a real completion chains: stopping an
 * agent by hand ends the pipeline with it. */
export function startChain(task) {
  const [next, ...rest] = task.chain || [];
  if (!next) return;
  createTask({
    text: next,
    workspaceId: task.workspaceId,
    // an 'auto' pipeline stays auto — a 'now' follow-up that hits the agent cap
    // would sit pending with nothing to pick it up again
    mode: task.mode === 'auto' ? 'auto' : 'now',
    startMode: task.startMode,
    model: task.model,
    effort: task.effort,
    focus: task.focus,
    closeOnComplete: task.closeOnComplete,
    priority: task.priority,
    category: task.category,
    role: task.role,
    chain: rest,
  });
}

/* recurring tasks: a completed task with a repeat interval queues its own next
 * run as a fresh pending task, due one interval later. Always 'auto' — the
 * scheduler is the only thing that can pick a task up on a timer, and the
 * usage gate it applies keeps a daily job from firing with no budget left.
 * Deleting the queued card is how you stop the series. */
export function startRepeat(task) {
  const every = Board.REPEAT_MS[task.repeat];
  if (!every) return;
  createTask({
    text: task.text,
    workspaceId: task.workspaceId,
    mode: 'auto',
    startMode: task.startMode,
    model: task.model,
    effort: task.effort,
    focus: task.focus,
    closeOnComplete: task.closeOnComplete,
    priority: task.priority,
    category: task.category,
    role: task.role,
    chain: task.chain,
    repeat: task.repeat,
    nextRunAt: Date.now() + every,
  });
}

export const boardHandlers = {
  onCreate: createTask,
  onStart(id) {
    const task = ctx.state.tasks.find((t) => t.id === id);
    if (!task) return;
    clearStartFailures(id); // ▶ by hand is the retry a given-up task waits for
    startTask(task, { notify: true });
  },
  onMoveStatus(id, status) {
    const task = ctx.state.tasks.find((t) => t.id === id);
    if (!task) return;
    task.status = status;
    window.swarm.updateTask(id, { status });
    renderBoard();
  },
  // dragging an Active card back to Manual/Scheduled: stop its agent (same
  // kill+cleanup as the pane ✕) and hand the task back unstarted, rather
  // than parking it in Completed the way closing the pane window does.
  onStopAndMove(id, status) {
    const task = ctx.state.tasks.find((t) => t.id === id);
    if (!task) return;
    const pane = ctx.state.panes.get(task.paneId);
    if (pane) {
      if (!pane.exited) ctx.killSessionChecked(pane.session.id);
      if (ctx.state.lastFocused === pane) ctx.state.lastFocused = null;
      ctx.state.panes.delete(pane.session.id);
      ctx.grid.remove(pane);
      ctx.syncChrome();
    }
    task.status = status;
    task.paneId = null;
    window.swarm.updateTask(id, { status, paneId: null });
    renderBoard();
  },
  onSetPriority(id, priority) {
    const task = ctx.state.tasks.find((t) => t.id === id);
    if (!task) return;
    task.priority = priority;
    window.swarm.updateTask(id, { priority });
    renderBoard();
    runScheduler(); // priority decides which pending tasks the scheduler picks up first
  },
  onSetCategory(id, category) {
    const task = ctx.state.tasks.find((t) => t.id === id);
    if (!task) return;
    task.category = category;
    window.swarm.updateTask(id, { category });
    renderBoard();
  },
  async onAddCategory(workspaceId, name) {
    const res = await window.swarm.addWorkspaceCategory(workspaceId, name);
    ctx.state.workspaces = res.workspaces || ctx.state.workspaces;
    renderBoard();
  },
  async onRemoveCategory(workspaceId, name) {
    const res = await window.swarm.removeWorkspaceCategory(workspaceId, name);
    ctx.state.workspaces = res.workspaces || ctx.state.workspaces;
    renderBoard();
  },
  async onDelete(id) {
    const task = ctx.state.tasks.find((t) => t.id === id);
    if (task && task.paneId) pendingTaskStarts.delete(task.paneId);
    const res = await window.swarm.deleteTask(id);
    ctx.state.tasks = ctx.state.tasks.filter((t) => t.id !== id);
    ctx.state.archivedTasks = res.archivedTasks || ctx.state.archivedTasks;
    renderBoard();
  },
  async onPurge(id) {
    const res = await window.swarm.purgeTask(id);
    ctx.state.archivedTasks = res.archivedTasks || [];
    renderArchive();
  },
  async onPurgeAll() {
    const res = await window.swarm.purgeAllTasks();
    ctx.state.archivedTasks = res.archivedTasks || [];
    renderArchive();
  },
  async onJump(paneId) {
    const pane = ctx.state.panes.get(paneId);
    if (!pane) { ctx.toast('this agent is gone'); return; }
    ctx.toggleBoard(false);
    if (pane.session.workspaceId !== ctx.state.selectedWorkspaceId) await ctx.selectWorkspace(pane.session.workspaceId);
    pane.focus();
  },
  getPaneAgentName(paneId) {
    const pane = ctx.state.panes.get(paneId);
    return pane ? pane.session.agentName : null;
  },
  getGit(workspaceId) {
    return ctx.state.git[workspaceId];
  },
  onRunAgain(task) {
    createTask({
      text: task.text,
      workspaceId: task.workspaceId,
      mode: 'now',
      startMode: task.startMode,
      model: task.model,
      effort: task.effort,
      focus: task.focus,
      closeOnComplete: task.closeOnComplete,
      priority: task.priority,
      category: task.category,
      chain: task.chain, // re-running a pipeline's first task re-runs the pipeline
    });
  },
  async onExportSession(task) {
    const ws = ctx.state.workspaces.find((w) => w.id === task.workspaceId);
    const name = boardHandlers.getPaneAgentName(task.paneId) || (ws ? ws.name : 'task');
    // an archived task's log is fetched on demand, not shipped in the boot payload
    if (!task.sessionLog && task.hasSessionLog) {
      task.sessionLog = (await window.swarm.archivedTaskLog(task.id)).sessionLog || '';
    }
    const res = await window.swarm.exportSession(name, task.sessionLog || '');
    if (res.ok) ctx.toast('transcript saved to ' + res.path);
    else if (!res.canceled) ctx.toast('could not save: ' + res.reason);
  },
};
