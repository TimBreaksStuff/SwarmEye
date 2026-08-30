/* The orchestrator: a lead agent that plans, workers that execute.
 *
 * The coordinator (renderer/features/coordinator/coordinator.js) splits a *sentence* — one headless
 * haiku call with no tools and no view of the code. This is the other thing: a
 * real agent in a pane that reads the repo, decides what the work is, and
 * hands each piece to a worker on whatever model workers are worth. The lead
 * stays live and is told how each worker went, so it can queue a second wave
 * or call the job done.
 *
 * Nothing here is a new kind of agent. The lead is an ordinary board task
 * (mode 'now', close-on-complete off) so the scheduler's own launch sequence
 * types its brief; every worker is an ordinary board task on the worker model,
 * so the agent cap, the usage gate and the OpenRouter billing rules all apply
 * unchanged. The only new mechanism is the plan file, which main/orchestrator.js
 * watches and consumes — see its header for why a file and not a socket.
 *
 * A popover built here rather than in index.html, which gains one stylesheet
 * link and nothing else. */

/* The mode/model/effort tables come from pane-const.js, not from Pane's
 * statics. Same arrays either way — Pane.MODELS *is* this one, which is why an
 * OpenRouter catalog pushed into it shows up in every picker — but reading
 * them here off the class meant importing the class, and the class imports
 * openrouter.js, which imports this file. That cycle is what left `Pane` in
 * the temporal dead zone while this module built its selects. */
import { MODELS } from '../pane/pane-const.js';

import { elt } from '../../lib/dom.js';
import { modHeld } from '../../lib/keys.js';
import { Resizable } from '../../lib/resizable.js';
import { OpenRouterUI } from '../openrouter/openrouter.js';
import { pending } from '../update/update.js';

import {
  createTask,
  TASK_SUBMIT_DELAY_MS,
} from '../scheduler/scheduler.js';

const PLAN = '.swarmeye/plan.json'; // what the brief tells the lead to write
const MAX_ROWS = 8;                 // main/orchestrator.js enforces the same cap
// ...and however many waves it writes, one job gets this many workers in total
const MAX_WORKERS = 12;
const REQUEST_MAX = 4000;
const SIZE_KEY = 'swarmeye.orchSize';
const LEADS_KEY = 'swarmeye.leads';

// how long a finished worker's closing summary is waited for before its report
// goes in without one — it is read from the transcript a beat after the Stop
const SUMMARY_WAIT_MS = 12000;
const SUMMARY_POLL_MS = 500;
// a report is never typed into a lead that is mid-turn; this is how often the
// queue re-checks, and how long it settles after sending one
const IDLE_POLL_MS = 500;
const AFTER_SEND_MS = 1200;
// worker text and summary are quoted back to the lead — enough to recognise
// the task and read the outcome, not the whole transcript (every agent pays
// for its own context on every turn)
const QUOTE_TEXT = 120;
const QUOTE_SUMMARY = 400;

let ctx = null;   // { state, toast } — from app.js, like the scheduler's
let roles = [];   // [{key, label}] — the role menu the lead may pick from

/* One entry per live lead. `workers` is the set of task ids it queued that are
 * still running, `queue` the reports waiting for it to finish its turn. The
 * durable half (workspace, worker model, worker ids) is mirrored into
 * localStorage so a renderer reload doesn't orphan a running swarm — a
 * renderer-only convenience that costs no IPC. */
const leads = new Map(); // leadSessionId -> { workspaceId, workerModel, taskId, workers:Set, crew:[], shown, queue:[], flushing }

function save() {
  const out = {};
  for (const [id, lead] of leads) {
    out[id] = {
      workspaceId: lead.workspaceId,
      workerModel: lead.workerModel,
      taskId: lead.taskId,
      workers: [...lead.workers],
      crew: lead.crew,
      shown: lead.shown,
    };
  }
  localStorage.setItem(LEADS_KEY, JSON.stringify(out));
}

/* What a model value is called in prose — the brief and the chip both say it.
 * 'default' is the account's own model, and naming it "default" in a sentence
 * the lead reads would be nonsense. */
function modelLabel(model) {
  if (!model || model === 'default') return 'the account default model';
  return OpenRouterUI.slugOf(model) || model;
}

/* ── the card ─────────────────────────────────────────────────────────── */

const pop = elt('div');
pop.id = 'orch-pop';
pop.hidden = true;

const box = elt('div', 'orch-box');
const head = elt('div', 'orch-head');
const titleEl = elt('div', 'kbd-title', 'Orchestrator');
const closeBtn = elt('button', 'pill', 'Close');
closeBtn.type = 'button';
closeBtn.dataset.tip = 'Close (Esc)';
head.append(titleEl, closeBtn);

const metaEl = elt('div', 'orch-meta');
const inputEl = elt('textarea', 'orch-input');
inputEl.rows = 6;
inputEl.maxLength = REQUEST_MAX;
inputEl.placeholder = 'What should get built? The lead reads the code, then delegates the pieces…';

const rowsEl = elt('div', 'orch-rows');
const leadSel = document.createElement('select');
const workerSel = document.createElement('select');
const harnessSel = document.createElement('select');
harnessSel.hidden = true;

function labelled(text, tip, ...controls) {
  const row = elt('label', 'orch-row');
  const name = elt('span', 'orch-label', text);
  name.dataset.tip = tip;
  row.append(name, ...controls);
  return row;
}

rowsEl.append(
  labelled('lead', 'The agent that plans and delegates — it reads the code, so this is where a strong model pays', leadSel),
  labelled('workers', 'Every task the lead queues runs on this — defaults one tier below the lead until you pick one. Change it later from the lead’s pane.', workerSel, harnessSel)
);

const noteEl = elt('div', 'orch-note');
const launchBtn = elt('button', 'pill pill-primary', 'Launch lead');
launchBtn.type = 'button';
const foot = elt('div', 'orch-foot');
foot.append(noteEl, launchBtn);

box.append(head, metaEl, inputEl, rowsEl, foot);
pop.append(box);
document.body.appendChild(pop);

/* Both selects are built from MODELS, the renderer's one model table —
 * OpenRouterUI.install() has already pushed the catalog into it, so a catalog
 * model needs no second list here. Filled on open rather than at load: at load
 * the catalog isn't in yet. */
function fillModels(sel, chosen) {
  sel.textContent = '';
  for (const [value, text] of MODELS) sel.add(new Option(value === 'default' ? 'Anthropic Subscription: default model' : text, value));
  if (chosen && [...sel.options].some((o) => o.value === chosen)) sel.value = chosen;
}

/* An OpenRouter pick can run in any of three harnesses; which one is a select
 * of its own beside the model, exactly as the board form does it, and the
 * prefix is rewritten on the way out. A Claude tier hides it. */
function fillHarnesses() {
  if (harnessSel.options.length) return;
  for (const [prefix, label, tip] of OpenRouterUI.HARNESSES) {
    const opt = document.createElement('option');
    opt.value = prefix;
    opt.textContent = label;
    opt.title = tip;
    harnessSel.appendChild(opt);
  }
}

function pickedWorkerModel() {
  const v = workerSel.value;
  if (!OpenRouterUI.isOpenRouter(v) || !harnessSel.value) return v;
  return harnessSel.value + OpenRouterUI.slugOf(v);
}

function syncWorkerDeps() {
  const or = OpenRouterUI.isOpenRouter(workerSel.value);
  if (or) fillHarnesses();
  harnessSel.hidden = !or;
  if (or && !harnessSel.value) harnessSel.value = OpenRouterUI.harnessPrefix();
  noteEl.textContent = `The lead writes ${PLAN}; each row becomes one worker on ${modelLabel(pickedWorkerModel())}.`;
}

workerSel.addEventListener('change', syncWorkerDeps);

let openCtx = null; // { workspaceId, workspaceName }

export function open(next) {
  openCtx = next;
  roles = next.roles || [];
  const defaultModel = localStorage.getItem('swarmeye.defaultModel') || 'default';
  fillModels(leadSel, localStorage.getItem('swarmeye.orchLead') || defaultModel);
  fillModels(workerSel, localStorage.getItem('swarmeye.orchWorker') || defaultModel);
  syncWorkerDeps();
  metaEl.textContent = `${next.workspaceName} · one agent plans and delegates, its workers run on the board`;
  launchBtn.disabled = false;
  launchBtn.textContent = 'Launch lead';
  pop.hidden = false;
  Resizable.place(box, SIZE_KEY);
  inputEl.focus();
}

export function close() {
  if (!pop.hidden) Resizable.remember(box, SIZE_KEY);
  pop.hidden = true;
  openCtx = null;
}

export const popEl = pop; // app.js's ESCAPABLE list

closeBtn.addEventListener('click', close);
pop.addEventListener('click', (e) => { if (e.target === pop) close(); });
inputEl.addEventListener('keydown', (e) => {
  // keys typed here must not reach app.js's document-level shortcuts — Escape
  // is left alone so it still closes the card
  if (e.key !== 'Escape') e.stopPropagation();
  if (e.key === 'Enter' && modHeld(e)) doLaunch();
});
launchBtn.addEventListener('click', doLaunch);

/* ── the brief ────────────────────────────────────────────────────────── */

/* One paragraph, deliberately: it is typed into the lead's input box as a
 * single write, and a bare harness (clean, opencode, pi) submits at the first
 * newline — a multi-line brief would arrive as a dozen separate prompts there.
 *
 * Everything in it is paid for on every turn of the lead's life, so it says
 * only what the lead cannot work out: the file, the shape, the caps, and the
 * one rule that keeps parallel workers from colliding. */
function composeBrief(request, workerModel) {
  const roleKeys = roles.map((r) => r.key).join(', ') || 'none configured';
  return [
    'You are the lead agent for this job: you plan and delegate, the workers write the code.',
    `To delegate, write ${PLAN} in this workspace — a JSON array of objects with the keys text and role —`,
    `and SwarmEye consumes that file and starts one worker agent per element on ${modelLabel(workerModel)}.`,
    'Write the file again whenever you want another wave.',
    `Rules: at most ${MAX_ROWS} elements per wave and ${MAX_WORKERS} workers for the whole job, and prefer fewer, larger ones because each element costs a whole agent;`,
    'each text must stand alone, because its worker sees that text and nothing else — not this brief, not the other elements;',
    'the workers run in parallel in this one working copy, so never give two of them the same file;',
    `role is one of ${roleKeys}, or an empty string for a plain agent.`,
    'Each worker is reported back to you here as it finishes, with the last thing it said — check its work, then queue the next wave or say the job is done.',
    'The job:',
    request,
  ].join(' ');
}

async function doLaunch() {
  const request = inputEl.value.trim();
  if (!request || !openCtx) return;
  const workspaceId = openCtx.workspaceId;
  const workerModel = pickedWorkerModel();
  const leadModel = leadSel.value;
  localStorage.setItem('swarmeye.orchLead', leadModel);
  localStorage.setItem('swarmeye.orchWorker', workerSel.value);
  if (OpenRouterUI.isOpenRouter(workerModel)) OpenRouterUI.setHarnessPrefix(harnessSel.value);
  launchBtn.disabled = true;
  launchBtn.textContent = 'launching…';
  // the lead is a task like any other, so it launches through the same path a
  // "start now" card does — and keeps its pane afterwards, which is the whole
  // point of a lead: it stays live to review what the workers did
  const task = await createTask({
    text: composeBrief(request, workerModel),
    workspaceId,
    mode: 'now',
    startMode: localStorage.getItem('swarmeye.defaultStartMode') || 'default',
    model: leadModel === 'default' ? undefined : leadModel,
    closeOnComplete: false,
    priority: 'high',
  });
  if (!task || !task.paneId) {
    launchBtn.disabled = false;
    launchBtn.textContent = 'Launch lead';
    metaEl.textContent = 'the lead agent could not start — the board kept the task';
    return;
  }
  await register(task.paneId, { workspaceId, workerModel, taskId: task.id, workers: [] });
  close();
}

/* ── leads ────────────────────────────────────────────────────────────── */

async function register(sessionId, { workspaceId, workerModel, taskId, workers, crew, shown }) {
  // One plan file per workspace, so one lead at a time may own it — two of them
  // watching the same `.swarmeye/plan.json` is a race, and the wave lands in
  // whichever crew won it (seen for real: a leftover lead swallowed the wave a
  // new one had just written, which then waited forever for reports it never
  // got). The newest lead takes the file; the older one keeps its pane, its
  // crew and its dropdown, and simply stops delegating.
  for (const [otherId, other] of leads) {
    if (otherId === sessionId || other.workspaceId !== workspaceId) continue;
    window.swarm.unwatchPlan(otherId);
    ctx.toast(`${paneName(otherId)} has handed this workspace's plan file to the new lead`);
  }
  leads.set(sessionId, {
    workspaceId,
    workerModel,
    taskId,
    workers: new Set(workers || []),
    // every worker task this lead ever queued, in the order it queued them, as
    // {taskId, sessionId} — `workers` drains as they finish, this doesn't,
    // because a finished worker keeps its entry in the dropdown so its output
    // stays reviewable
    crew: (crew || []).map((c) => (typeof c === 'string' ? { taskId: c } : c)),
    shown: shown || sessionId, // which member owns the lead's one grid slot
    pending: 0, // finished workers whose report is still waiting for a summary
    queue: [],
    flushing: false,
  });
  save();
  const res = await window.swarm.watchPlan(sessionId, workspaceId);
  if (!res || !res.ok) {
    ctx.toast('could not watch the lead’s plan file — its workers won’t start');
    leads.delete(sessionId);
    save();
    return;
  }
  attachChip(sessionId);
  ctx.syncGrid(); // this lead's crew shares one cell from here on
}

/* A dead lead writes no more waves — but its pane sticks around until someone
 * clicks ✕, and so must its crew dropdown, or ten workers would pop into the
 * grid as their own cells the moment the lead's agent quits. The entry itself
 * is dropped by hiddenIds() once the pane is really gone. */
function forget(sessionId) {
  if (!leads.has(sessionId)) return;
  window.swarm.unwatchPlan(sessionId);
  if (ctx.state.panes.has(sessionId)) return;
  leads.delete(sessionId);
  save();
}

/* A renderer reload leaves the agents running (they live in tmux) — so the
 * leads are picked back up from localStorage once the panes are mounted, and
 * any whose pane didn't come back is dropped. Called from app.js's boot, after
 * the reattach loop. */
export function restore() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(LEADS_KEY) || '{}');
  } catch {
    stored = {};
  }
  for (const [sessionId, lead] of Object.entries(stored)) {
    if (!ctx.state.panes.has(sessionId)) continue;
    register(sessionId, lead);
  }
  save(); // whatever didn't come back is now gone
}

/* ── the wave ─────────────────────────────────────────────────────────── */

/* One plan file, consumed by main. Every row becomes an ordinary 'auto' task
 * on the worker model, so the scheduler decides when each actually starts. */
async function onPlan({ sessionId, items, reason }) {
  const lead = leads.get(sessionId);
  if (!lead) return; // a wave from a lead we no longer track
  if (reason) {
    report(sessionId, `your plan file could not be read (${reason}) — write ${PLAN} again`);
    return;
  }
  // A lead can decide its workers achieved nothing and delegate the same job
  // again — on 2026-08-13 one did it three times over, because the reports it
  // was reading were the workers' skill preamble rather than their result. The
  // report is fixed (main/hooks.js settleSummary); this is the backstop, and it
  // is a refusal the lead is told about rather than a silent drop.
  const left = Math.max(0, MAX_WORKERS - lead.crew.length);
  if (!left) {
    ctx.toast(`${paneName(sessionId)} has started ${lead.crew.length} workers — further waves refused`);
    report(sessionId, `that wave was refused: this job has already had ${lead.crew.length} workers, which is the limit`
      + ' — finish it with what they produced, or tell me what is still missing rather than starting more');
    return;
  }
  const startMode = localStorage.getItem('swarmeye.defaultStartMode') || 'default';
  let queued = 0;
  for (const row of items.slice(0, left)) {
    const task = await createTask({
      text: row.text,
      workspaceId: lead.workspaceId,
      mode: 'auto',
      startMode,
      model: lead.workerModel === 'default' ? undefined : lead.workerModel,
      role: row.role || '',
      priority: 'medium',
    });
    if (!task) continue;
    lead.workers.add(task.id);
    lead.crew.push({ taskId: task.id, sessionId: task.paneId || null });
    queued++;
  }
  save();
  ctx.syncGrid(); // the new workers are in the switcher before any of them starts
  const name = paneName(sessionId);
  ctx.toast(queued
    ? `${name} queued ${queued} worker task${queued > 1 ? 's' : ''}`
    : `${name} wrote a plan with nothing startable in it`);
  if (!queued) report(sessionId, 'none of the rows in that plan could be started — every element needs a text field');
  else if (items.length > left) {
    report(sessionId, `only the first ${left} of those ${items.length} rows were started`
      + ` — this job's limit is ${MAX_WORKERS} workers in total`);
  }
}

function paneName(sessionId) {
  const pane = ctx.state.panes.get(sessionId);
  return pane ? pane.session.agentName : 'the lead';
}

/* A worker finished. Called from app.js at the one place a task completes;
 * anything that isn't a tracked worker falls straight through. */
export function onWorkerDone(task) {
  for (const [sessionId, lead] of leads) {
    if (!lead.workers.has(task.id)) continue;
    lead.workers.delete(task.id);
    // a worker whose summary is still being waited for has left `workers` but
    // has not been reported yet — without counting those, two workers ending
    // together are each told they were the last one
    lead.pending++;
    save();
    waitForSummary(task).then((summary) => {
      lead.pending--;
      const quoted = task.text.slice(0, QUOTE_TEXT) + (task.text.length > QUOTE_TEXT ? '…' : '');
      const outcome = summary || lastSaid(task.sessionLog) || 'finished, and said nothing at the end';
      report(sessionId, `worker finished — "${quoted}" — ${outcome.slice(0, QUOTE_SUMMARY)}`
        + (lead.workers.size || lead.pending ? '' : ' (that was the last one still running)'));
    });
    return;
  }
}

/* A worker the scheduler gave up on (its agent died on every attempt — see
 * noteStartFailure). Its card stays on the board, but the lead is waiting for a
 * report that will never come, so it is told instead of left hanging. */
export function onWorkerGaveUp(task) {
  for (const [sessionId, lead] of leads) {
    if (!lead.workers.has(task.id)) continue;
    lead.workers.delete(task.id);
    save();
    const quoted = task.text.slice(0, QUOTE_TEXT) + (task.text.length > QUOTE_TEXT ? '…' : '');
    report(sessionId, `worker never started — "${quoted}" — its agent exited immediately every time,`
      + ' so nothing was done for it; the task is still on the board'
      + (lead.workers.size || lead.pending ? '' : ' (nothing of yours is running now)'));
    return;
  }
}

/* The closing summary is read out of the transcript, and a worker that closes
 * on completion is usually killed before that read lands — so the last thing
 * it printed stands in. Claude Code marks its own text with ●/⏺ and wraps the
 * rest of the block in two-space continuations, which is the same shape the
 * transcript colouring keys on. A bare harness prints no marker
 * and simply has no fallback. */
function lastSaid(sessionLog) {
  const lines = String(sessionLog || '').split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^[●⏺]\s/.test(lines[i])) { at = i; break; }
  if (at === -1) return '';
  const block = [lines[at].replace(/^[●⏺]\s+/, '')];
  for (let i = at + 1; i < lines.length && /^ {2}\S/.test(lines[i]); i++) block.push(lines[i].trim());
  return block.join(' ').trim();
}

/* The closing summary is read from the transcript a beat after the Stop that
 * completed the task, and filed on the task by the scheduler — so the report
 * waits a little for it rather than always saying "no summary". */
function waitForSummary(task) {
  return new Promise((resolve) => {
    let waited = 0;
    const tick = () => {
      if (task.summary || waited >= SUMMARY_WAIT_MS) { resolve(task.summary || ''); return; }
      waited += SUMMARY_POLL_MS;
      setTimeout(tick, SUMMARY_POLL_MS);
    };
    tick();
  });
}

/* Reports are typed into the lead the same way the board delivers a task
 * prompt — through ptys.write, never a command line. Two rules matter: never
 * while the lead is mid-turn (the text would land in a box it is about to
 * clear), and never one message per worker when three finished together. */
function report(sessionId, line) {
  const lead = leads.get(sessionId);
  if (!lead) return;
  lead.queue.push(line);
  flush(sessionId);
}

async function flush(sessionId) {
  const lead = leads.get(sessionId);
  if (!lead || lead.flushing) return;
  lead.flushing = true;
  try {
    while (lead.queue.length) {
      const pane = ctx.state.panes.get(sessionId);
      if (!pane || pane.exited) { lead.queue = []; return; }
      if (pane.working) { await sleep(IDLE_POLL_MS); continue; }
      const text = '[SwarmEye] ' + lead.queue.splice(0).join(' [SwarmEye] ');
      window.swarm.writeSession(sessionId, text);
      await sleep(TASK_SUBMIT_DELAY_MS);
      window.swarm.writeSession(sessionId, '\r');
      await sleep(AFTER_SEND_MS);
    }
  } finally {
    lead.flushing = false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── the crew: one grid slot for a lead and its workers ───────────────── */

/* A lead and everything it queued share a single cell. The other members are
 * running the whole time — they are simply not mounted, exactly as the panes of
 * an unselected workspace aren't — and a select in the header of whichever one
 * is showing swaps between them. Nothing else changes: the agent cap and the
 * board still see every worker.
 *
 * A queued task only has a pane once the scheduler actually starts it, so the
 * pane is looked up from the board — but only once: app.js clears paneId again
 * on an agent that exits mid-task, and a worker that has been and gone must
 * keep its place in the list. From then on the pane itself is the membership,
 * and the entry lasts until someone clicks ✕ on it. */
function crewOf(lead) {
  const ids = [];
  for (const member of lead.crew) {
    if (!member.sessionId) {
      const task = ctx.state.tasks.find((t) => t.id === member.taskId);
      if (task && task.paneId) { member.sessionId = task.paneId; save(); }
    }
    if (member.sessionId && ctx.state.panes.has(member.sessionId)) ids.push(member.sessionId);
  }
  return ids;
}

function membersOf(leadId, lead) {
  const members = [leadId, ...crewOf(lead)];
  if (!members.includes(lead.shown)) lead.shown = leadId; // whatever was showing has been closed
  return members;
}

/* What the switcher lists: the lead, then every worker it has ever queued —
 * including the ones with no pane. A worker has none until the scheduler
 * actually starts it (and may lose it again), and a dropdown that only listed
 * the mounted ones was empty at exactly the moment the lead had just delegated,
 * which read as "the feature isn't there". Those rows are disabled and say what
 * the task is doing instead. A row whose task has been deleted — or finished,
 * since a worker whose pane has gone has nothing left to look at — is dropped. */
function crewRows(leadId, lead) {
  const rows = [{ id: leadId, label: memberLabel(leadId, true), live: true }];
  for (const member of lead.crew) {
    if (member.sessionId && ctx.state.panes.has(member.sessionId)) {
      rows.push({ id: member.sessionId, label: memberLabel(member.sessionId, false), live: true });
      continue;
    }
    const task = ctx.state.tasks.find((t) => t.id === member.taskId);
    if (!task || task.status === 'completed') continue; // finished and its pane closed: nothing left to look at
    const state = task.status === 'pending' ? 'queued'
      : task.status === 'active' ? 'starting' : task.status;
    rows.push({ id: member.taskId, label: `${short(task.text)} · ${state}`, live: false });
  }
  return rows;
}

const short = (text) => {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > 28 ? one.slice(0, 27) + '…' : one;
};

/* Is this pane one of a lead's workers? A worker's turns are the lead's
 * business, not the user's: it is started by an agent rather than by a person,
 * its result is typed into its lead as a report, and a swarm of eight of them
 * ringing the bell, speaking, and filling the notification list buries whatever
 * the user was actually watching. So every notification path asks this first —
 * the lead itself still notifies for the whole crew. */
export function isCrewWorker(sessionId) {
  if (!leads.size) return false; // the common case: no lead anywhere
  for (const [leadId, lead] of leads) {
    if (sessionId === leadId) return false; // a lead notifies like any agent
    // crewOf, not lead.crew: a worker's pane id is filled in from its task the
    // first time anything asks, and its first notification can be that moment
    if (crewOf(lead).includes(sessionId)) return true;
  }
  return false;
}

/* Every crew member that isn't the one showing — app.js keeps these out of the
 * grid and nothing else. Also where a lead whose pane has been closed for good
 * is dropped, since this runs on every regrid. */
export function hiddenIds() {
  const out = new Set();
  if (!leads.size) return out; // the common case: no lead anywhere, nothing to walk
  for (const [leadId, lead] of leads) {
    if (!ctx.state.panes.has(leadId)) { leads.delete(leadId); save(); continue; }
    for (const id of membersOf(leadId, lead)) if (id !== lead.shown) out.add(id);
  }
  return out;
}

function memberLabel(sessionId, isLead) {
  const pane = ctx.state.panes.get(sessionId);
  if (!pane) return sessionId;
  // the lead is the row on screen most of the time, and the chip is as wide as
  // its label — its own status dot already says idle/working/needs you, so the
  // name alone is enough. Workers keep their state: theirs is the one thing the
  // switcher can say about a pane that isn't mounted.
  return isLead ? pane.session.agentName : `${pane.session.agentName} · working`;
}

/* One select per lead, moved into the header of whichever member is showing —
 * a DOM move, so there is never a second copy to keep in step. Called from
 * syncGrid, which is also the beat statuses land on, so the options are rebuilt
 * only when their text or the selection actually changed. */
export function paintCrew() {
  for (const [leadId, lead] of leads) {
    membersOf(leadId, lead); // keeps `shown` on a member that still has a pane
    const rows = crewRows(leadId, lead);
    if (rows.length < 2) { // a lead that has delegated nothing needs no switcher
      if (lead.tabs) { lead.tabs.remove(); lead.tabs = null; lead.sig = null; }
      continue;
    }
    const pane = ctx.state.panes.get(lead.shown);
    if (!pane) continue;
    if (!lead.tabs) {
      const sel = elt('select', 'pane-crew');
      sel.dataset.tip = 'This lead and its workers share this slot — pick which one to look at';
      sel.addEventListener('change', () => {
        const live = leads.get(leadId);
        // a disabled row can't be picked with the mouse, but the keyboard walks
        // onto one — it must not be adopted as the member on screen
        if (!live || !ctx.state.panes.has(sel.value)) { sel.value = live ? live.shown : sel.value; return; }
        live.shown = sel.value;
        save();
        ctx.syncGrid();
      });
      // the header sits under app.js's document-level shortcuts
      sel.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
      lead.tabs = sel;
    }
    const sig = rows.map((r) => r.label + (r.live ? '' : '!')).join('|') + '>' + lead.shown;
    if (sig !== lead.sig) {
      lead.sig = sig;
      lead.tabs.textContent = '';
      for (const row of rows) {
        const opt = document.createElement('option');
        opt.value = row.id;
        opt.textContent = row.label;
        opt.disabled = !row.live; // nothing to show for a worker with no pane
        lead.tabs.appendChild(opt);
      }
      lead.tabs.value = lead.shown;
    }
    // at the head of the header, right after the status dot: the switcher is
    // how a lead's workers are reached at all, so it sits where the eye lands
    // rather than at the end of the chip row
    const header = pane.el.querySelector('.pane-header');
    if (header && lead.tabs.parentNode !== header) {
      header.insertBefore(lead.tabs, header.querySelector('.pane-task') || header.querySelector('.pane-title'));
    }
  }
}

/* ── the lead pane's workers chip ─────────────────────────────────────── */

/* Appended to the pane header from outside rather than built into Pane: only
 * a lead has one, and pane.js is the most contended file in the renderer. */
function attachChip(sessionId) {
  const lead = leads.get(sessionId);
  const pane = ctx.state.panes.get(sessionId);
  if (!lead || !pane) return;
  const header = pane.el.querySelector('.pane-header');
  if (!header) return;
  let chip = header.querySelector('.pane-workers');
  if (!chip) {
    chip = elt('span', 'pane-workers');
    chip.addEventListener('click', () => {
      // the Claude tiers ride in as `extra` so one menu covers both providers,
      // exactly as the pane's own model chip does it
      const tiers = MODELS.filter(([v]) => v !== 'default' && !OpenRouterUI.isOpenRouter(v));
      OpenRouterUI.openModelMenu(chip, (model) => {
        const live = leads.get(sessionId);
        if (!live) return;
        live.workerModel = model;
        save();
        attachChip(sessionId);
        ctx.toast('workers queued from now on run on ' + modelLabel(model));
      }, { extra: tiers });
    });
    header.appendChild(chip);
  }
  chip.textContent = 'workers: ' + modelLabel(lead.workerModel);
  chip.dataset.tip = 'Model this lead’s next workers run on — click to change it';
}

/* ── wiring ───────────────────────────────────────────────────────────── */

export function init(next) {
  ctx = next;
  window.swarm.onOrchestratorPlan(onPlan);
  // a lead's pane going away ends its watch — no app.js line needed, the exit
  // event is already broadcast to every subscriber
  window.swarm.onSessionExit(({ id, detached }) => { if (!detached) forget(id); });
}
