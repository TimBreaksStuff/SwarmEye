/* OpenRouter integration: one API key unlocks the whole model catalog for
 * agent launches. An OpenRouter agent is the same `claude` CLI launch with an
 * env-var prefix routing its API traffic through openrouter.ai — nothing in
 * the PTY/hook/transcript pipeline changes (see openrouter-plan.md).
 *
 * Model values are encoded 'or:<slug>' ('or:qwen/qwen3-coder-next') wherever
 * the app passes a model around; bare tier names ('opus') keep meaning
 * Claude. slugOf() is the one decoder.
 *
 * The key lives in config.json; the slimmed catalog has its own file
 * (main/config.js — it is 45KB that changes twice a month, and every config
 * write was paying for it). The key never crosses IPC: config:get ships the
 * catalog only, and status() reports counts, not key material. */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { toShellPath } = require('./platform');

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
// sk-or-v1-<64 hex> today, but only the shell-safety of the charset is
// load-bearing: the key lands inside the single-quoted tmux launch command,
// so quotes, $, backticks, backslashes and whitespace must be impossible.
const KEY_RE = /^[A-Za-z0-9._-]{20,240}$/;
// catalog slugs: 'qwen/qwen3-coder-next', ':free' variants, '~...-latest'
// aliases. Same shell-safety rule as the key.
const SLUG_RE = /^[~A-Za-z0-9._/:-]{1,128}$/;
const PREFIX = 'or:';
// 'oc:<slug>' launches the *clean* agent (agent/clean.js): our own CLI
// talking OpenAI format straight to OpenRouter, no Claude Code harness at
// all — see clean-agent-plan.md. 'or:' keeps meaning "catalog model inside
// Claude Code"; the two coexist per agent.
const CLEAN_PREFIX = 'oc:';
// The tier aliases the user's extra `/model` choices are parked in, in the
// order Claude Code's picker lists them. Opus is not among them: it holds the
// launch model, so the picker's "Default" row and the running agent agree.
const ALT_SLOTS = ['FABLE', 'SONNET', 'HAIKU'];

/* 'or:qwen/qwen3-coder-next' -> 'qwen/qwen3-coder-next'; null for anything
 * that is not a well-formed OpenRouter model value. */
function slugOf(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
  const slug = value.slice(PREFIX.length);
  return SLUG_RE.test(slug) ? slug : null;
}

/* Same decoder for the clean-agent spelling, 'oc:<slug>'. */
function cleanSlugOf(value) {
  if (typeof value !== 'string' || !value.startsWith(CLEAN_PREFIX)) return null;
  const slug = value.slice(CLEAN_PREFIX.length);
  return SLUG_RE.test(slug) ? slug : null;
}

function hasKey() {
  return KEY_RE.test(config.load().openrouterKey || '');
}

function setKey(key) {
  if (!KEY_RE.test(key)) throw new Error('that does not look like an OpenRouter key');
  config.patch({ openrouterKey: key });
  spendCache = { at: 0, data: null }; // a new key's spend is a different account's
}

function clearKey() {
  config.patch({ openrouterKey: '', openrouterAlts: [] });
  config.saveCatalog(null); // its own file since 2.7.0 — see main/config.js
  spendCache = { at: 0, data: null };
}

function status() {
  const cfg = config.load();
  const cat = config.loadCatalog();
  return {
    configured: KEY_RE.test(cfg.openrouterKey || ''),
    models: cat ? cat.models.length : 0,
    fetchedAt: cat ? cat.fetchedAt : null,
    alts: alts(),
  };
}

/* The extra models `/model` offers inside an OpenRouter agent (see envPrefix).
 * Filtered on the way out as well as in: a slug that has left the catalog
 * since it was picked is dropped rather than launched. */
function alts() {
  const saved = config.load().openrouterAlts;
  if (!Array.isArray(saved)) return [];
  const known = new Set(catalog().map((m) => m.id));
  return saved.filter((s) => typeof s === 'string' && SLUG_RE.test(s) && known.has(s)).slice(0, ALT_SLOTS.length);
}

function setAlts(list) {
  if (!Array.isArray(list)) throw new Error('expected a list of models');
  const known = new Set(catalog().map((m) => m.id));
  const clean = [];
  for (const s of list) {
    if (typeof s !== 'string' || !SLUG_RE.test(s) || !known.has(s)) throw new Error('unknown model: ' + s);
    if (!clean.includes(s)) clean.push(s);
  }
  if (clean.length > ALT_SLOTS.length) throw new Error(`at most ${ALT_SLOTS.length} models`);
  config.patch({ openrouterAlts: clean });
}

/* Every read of the catalog goes through here — the renderer's pickers get it
 * verbatim over config:get, and alts/envPrefix/priceFor all resolve against
 * it — so the '~vendor/model-latest' rolling aliases are dropped at this one
 * point rather than at fetch time, which also cleans a catalog already saved.
 * OpenRouter serves them, but the CLI rejects the leading '~' as a malformed
 * model id ("It may not exist or you may not have access to it") before a
 * request is ever made; each one duplicates a concrete model in the list
 * anyway. */
function catalog() {
  const cat = config.loadCatalog();
  return cat ? cat.models.filter((m) => !m.id.startsWith('~')) : [];
}

/* GET /api/v1/models (public, no auth) slimmed to what the app reads: the
 * picker wants id + label + prices, the cost panel wants per-token prices,
 * the launch env wants the context window. ':batch' variants are batch-API
 * endpoints an interactive agent can't use, and models that don't emit text
 * can't drive a CLI — both dropped. */
async function fetchCatalog() {
  const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('OpenRouter answered HTTP ' + res.status);
  const data = (await res.json()).data;
  if (!Array.isArray(data)) throw new Error('unexpected catalog shape');
  const models = data
    .filter((m) => m && typeof m.id === 'string' && SLUG_RE.test(m.id)
      && !m.id.endsWith(':batch')
      && /->text/.test((m.architecture && m.architecture.modality) || '->text'))
    .map((m) => ({
      id: m.id,
      label: typeof m.name === 'string' ? m.name : m.id,
      ctx: Number(m.context_length) || 0,
      // per-token USD, as OpenRouter reports them
      in: Number(m.pricing && m.pricing.prompt) || 0,
      out: Number(m.pricing && m.pricing.completion) || 0,
      cr: Number(m.pricing && m.pricing.input_cache_read) || 0,
      cw: Number(m.pricing && m.pricing.input_cache_write) || 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!models.length) throw new Error('catalog came back empty');
  config.saveCatalog({ fetchedAt: Date.now(), models });
  return models.length;
}

/* The launch env for an OpenRouter agent, as a `env K=V ... ` prefix for the
 * claude command. Every tier alias maps to a slug — Claude Code resolves its
 * internal opus/sonnet/haiku picks through these — and the context-window
 * override stops the CLI from assuming 200k for a model it doesn't recognize.
 * Null when the key is missing or anything fails the shell-safety regexes:
 * the caller treats that as "cannot launch", it never guesses.
 *
 * The four tier aliases are also the only thing `/model` inside the agent can
 * offer: against a foreign base URL the picker drops every first-party row and
 * lists exactly these plus Default, which is why pointing them all at one slug
 * made `/model` a list of the same name four times. The user's alternates
 * (Options) fill the other three; a slot nobody claimed keeps the launch model
 * so the alias still resolves to something OpenRouter serves. Picking a row
 * switches the agent by *alias*, so a "set as default" pick can't leave an
 * OpenRouter slug behind as the default for later Claude agents.
 *
 * Subagents stay on the launch model (CLAUDE_CODE_SUBAGENT_MODEL); the CLI's
 * own haiku-tier chores follow whatever sits in that slot, which is the one
 * behaviour an alternate changes beyond the picker. */
function envPrefix(slug) {
  const key = config.load().openrouterKey || '';
  if (!KEY_RE.test(key) || !SLUG_RE.test(slug)) return null;
  const extra = alts().filter((s) => s !== slug);
  const vars = [
    'ANTHROPIC_BASE_URL=https://openrouter.ai/api',
    // ANTHROPIC_AUTH_TOKEN carries the key and is deliberately NOT here — see
    // keyEnv(): it reaches the session over the tmux socket instead, so it
    // stays out of the launch command every process on the box can read
    'ANTHROPIC_API_KEY=', // explicitly empty: an inherited real key would win
    'ANTHROPIC_MODEL=' + slug,
    'ANTHROPIC_DEFAULT_OPUS_MODEL=' + slug,
    ...ALT_SLOTS.map((tier, i) => `ANTHROPIC_DEFAULT_${tier}_MODEL=` + (extra[i] || slug)),
    'CLAUDE_CODE_SUBAGENT_MODEL=' + slug,
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
  ];
  const model = catalog().find((m) => m.id === slug);
  if (model && model.ctx > 0) vars.push('CLAUDE_CODE_MAX_CONTEXT_TOKENS=' + Math.floor(model.ctx));
  return 'env ' + vars.join(' ') + ' ';
}

/* The launch command for a clean agent: `node agent/clean.js` with the key
 * as an env prefix, in place of any `claude` invocation. It composes under
 * hooks.claudeCmd exactly like a claude launch — the SWARMEYE_* env vars are
 * what the script reports its state through, and the trailing
 * `--settings <path>` claude flag it appends is ignored by the script's arg
 * parser, so hooks.js needs no clean-agent branch. Null when the key is
 * missing or any token would break the single-quoted tmux command the whole
 * string lands inside — the caller treats that as "cannot launch".
 *
 * `system` carries the role prompt (its charset is enforced quote-free by
 * roles.js/sessions.js, and re-checked here). The
 * script path is the one machine-derived token: packaged builds must run it
 * out of app.asar.unpacked — shell node cannot read inside the asar — hence
 * the substitution, a no-op in dev where the path has no app.asar segment. */
const SAFE_ARG_RE = /^[^"'$`\\]+$/;

/* `node` is not reliably on PATH for the shell a launch command runs in. A
 * launch is a login shell, but not an interactive one, so it never reads
 * .bashrc — which is the only place nvm puts its node. The pane then died on
 * "node: command not found" the instant it opened, and tmux took the session
 * (and the message) down with it, so it just read [exited]. Hand the command
 * nvm's newest install as a PATH *suffix*: anything the shell already found
 * still wins, and the whole thing stays one `env`-prefixed command, which is
 * what the no-tmux `exec <cmd>` path needs. */
const NODE_PATH = 'PATH="$PATH:$(ls -d $HOME/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"';

/* Which CLI each bare harness actually runs. A missing one was invisible: the
 * launch died on "not found" before the pane drew a character, and tmux took
 * the session — and the message — down with it, so the pane just read
 * [exited]. The builders below ask this and return null instead, which
 * sessions.js already turns into a one-line explanation in the pane. */
const HARNESS_BIN = { clean: 'node', opencode: 'opencode', pi: 'pi' };

/* One shell line naming the harness binaries a launch would find (PtyManager
 * .init folds it into the tmux probe's round trip). It re-enters a *login*
 * shell first, because that is what a launch gets and exec() on Windows is a
 * plain `bash -c`: ~/.local/bin, where these CLIs install themselves, is on
 * one PATH and not the other, and probing the wrong shell reported both as
 * missing. node is looked up the way NODE_PATH resolves it, nvm install
 * included; the answers carry no digits, so the caller's tmux-version regex
 * can share the output. */
const TOOL_PROBE = '${SHELL:-/bin/bash} -lc \''
  + 'for b in opencode pi; do command -v $b >/dev/null 2>&1 && echo have:$b; done; '
  + '{ command -v node >/dev/null 2>&1 || ls -d $HOME/.nvm/versions/node/*/bin/node >/dev/null 2>&1; }'
  + ' && echo have:node; true\'';

/* What that probe found, from its raw output. Until it has run — and whenever
 * the shell doesn't answer at all — every binary counts as present: a probe
 * that failed must never block a launch that would have worked. */
let found = null;
function setTools(out) {
  found = typeof out === 'string' && out
    ? new Set(Object.values(HARNESS_BIN).filter((b) => out.includes('have:' + b)))
    : null;
}

/* The binary this harness needs and the agent's shell cannot find, else null. */
function missingBin(harness) {
  const bin = HARNESS_BIN[harness];
  return bin && found && !found.has(bin) ? bin : null;
}

/* The skill folders a bare-harness launch carries (skills.js orSkillDirs),
 * narrowed to the ones every builder below can express — paths only, never
 * content, so the no-quotes rule stays satisfiable and a path it can't satisfy
 * is dropped rather than risked. Shared by all three so one toggle cannot mean
 * "loaded" in one harness and "missing" in another. */
function safeSkillDirs(skills) {
  return (skills || []).filter((d) => typeof d === 'string' && SAFE_ARG_RE.test(d));
}

function cleanCmd(slug, { system, yolo, skills } = {}) {
  const key = config.load().openrouterKey || '';
  if (!KEY_RE.test(key) || !SLUG_RE.test(slug)) return null;
  if (missingBin('clean')) return null;
  const script = toShellPath(path.join(__dirname, '..', 'agent', 'clean.js').replace('app.asar', 'app.asar.unpacked'));
  if (!script || !SAFE_ARG_RE.test(script)) return null;
  if (system && !SAFE_ARG_RE.test(system)) return null;
  // no OPENROUTER_API_KEY here: keyEnv() hands it to the session over the
  // tmux socket, so the key never sits in a command line anyone can read
  let cmd = `env ${NODE_PATH} node "${script}" --model ${slug}`;
  if (system) cmd += ` --system "${system}"`;
  if (yolo) cmd += ' --yolo';
  // skill folders the script loads into its system prompt
  for (const dir of safeSkillDirs(skills)) cmd += ` --skill "${dir}"`;
  return cmd;
}

/* A pane restart gets a fresh session id, so resuming means naming the
 * previous session's conversation. Session ids are main's own ('s_' +
 * base36) but re-checked here — this lands on the same command line. */
function cleanContinueArg(oldSessionId) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(oldSessionId || '') ? ' --continue-from ' + oldSessionId : '';
}

/* ------------------------------------------- third-party harnesses (v1: manual panes)
 * 'opencode:<slug>' and 'pi:<slug>' run somebody else's coding CLI in place
 * of claude, each carrying a SwarmEye adapter (agent/opencode-plugin.js,
 * agent/pi-extension.ts) that emits the same hook-state files and
 * Claude-format transcript the pipeline already reads — so status, cost and
 * summaries work without touching hooks.js. See agent/README.md.
 *
 * The slug is the plain OpenRouter catalog id in both spellings; only the
 * flag that carries it differs (opencode wants the provider glued on as
 * `openrouter/<slug>`, pi takes --provider separately). Same shell-safety
 * rules as everything else here: the whole command lands inside a
 * single-quoted tmux launch line, so a token that fails a regex means "cannot
 * launch" and the caller shows that, never a guess. */
const OPENCODE_PREFIX = 'opencode:';
const PI_PREFIX = 'pi:';

function opencodeSlugOf(value) {
  if (typeof value !== 'string' || !value.startsWith(OPENCODE_PREFIX)) return null;
  const slug = value.slice(OPENCODE_PREFIX.length);
  return SLUG_RE.test(slug) ? slug : null;
}

function piSlugOf(value) {
  if (typeof value !== 'string' || !value.startsWith(PI_PREFIX)) return null;
  const slug = value.slice(PI_PREFIX.length);
  return SLUG_RE.test(slug) ? slug : null;
}

/* Both foreign CLIs reject claude's flags — a trailing `--settings <path>`
 * makes opencode print its usage and exit 1, and pi answer "Unknown option"
 * — so hooks.claudeCmd has to leave that suffix off for them. This is the
 * predicate its callers ask. */
function isForeign(value) {
  return !!(opencodeSlugOf(value) || piSlugOf(value));
}

/* An adapter's path as the agent's shell sees it. Packaged builds must run it
 * out of app.asar.unpacked (`agent/**` is already in build.asarUnpack) — the
 * substitution is a no-op in dev. Null when the path can't be expressed or
 * carries a character the tmux quoting can't survive. */
function adapterPath(file) {
  const p = toShellPath(path.join(__dirname, '..', 'agent', file).replace('app.asar', 'app.asar.unpacked'));
  return p && SAFE_ARG_RE.test(p) ? p : null;
}

/* opencode reads its plugin list and permission defaults from a config file,
 * which is how the adapter is loaded without touching the config the user
 * runs opencode with themselves: OPENCODE_CONFIG names this one, and it sits
 * above their project config in opencode's precedence while still merging
 * with it. Rewritten at every launch, so the Options toggle takes effect on
 * the next agent rather than at whatever it was when the app booted.
 *
 * `yolo` (SwarmEye's skipPermissions) becomes --auto on the command line
 * instead of a config key, because --auto also overrides whatever the user's
 * own config says. Without it we have to ask explicitly: opencode's built-in
 * default for edit and bash is "allow".
 *
 * Skills ride `instructions`, a list of *files* whose text opencode carries in
 * every turn — the same "full text at launch" the clean agent's --skill means,
 * which is what the toggle promises. (opencode 1.18 also has `skills.paths`,
 * but that only offers a skill for the model to pull in later; verified
 * against 1.18.17, a SKILL.md named in `instructions` is answered from and is
 * absent without it.) */
function writeOpencodeConfig(pluginPath, yolo, skills) {
  const file = path.join(app.getPath('userData'), 'opencode-config.json');
  const body = { plugin: ['file://' + pluginPath] };
  const instructions = safeSkillDirs(skills).map((d) => d + '/SKILL.md');
  if (instructions.length) body.instructions = instructions;
  if (!yolo) body.permission = { edit: 'ask', bash: 'ask' };
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify(body, null, 2));
    fs.renameSync(file + '.tmp', file);
  } catch { return null; }
  const shell = toShellPath(file);
  return shell && SAFE_ARG_RE.test(shell) ? shell : null;
}

/* The launch command for an opencode agent. Null when the key is missing or
 * any token would break the single-quoted tmux command — "cannot launch". */
/* A restart resumes two different things at once, and they are not the same
 * id. `continueFrom` is the *pane's* previous session id: it tells the adapter
 * to keep writing the old conversation's transcript, so the cost tally carries
 * on rather than starting from zero. `resumeId` is the *harness's* own id,
 * which its adapter recorded and only it can reopen. Both are re-validated
 * here because both land on a shell command line. */
const RESUME_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function continueEnv(continueFrom) {
  return RESUME_ID_RE.test(continueFrom || '') ? `SWARMEYE_CONTINUE_FROM=${continueFrom} ` : '';
}

function opencodeCmd(slug, { yolo, continueFrom, resumeId, skills } = {}) {
  const key = config.load().openrouterKey || '';
  if (!KEY_RE.test(key) || !SLUG_RE.test(slug)) return null;
  if (missingBin('opencode')) return null;
  const plugin = adapterPath('opencode-plugin.js');
  if (!plugin) return null;
  const cfg = writeOpencodeConfig(plugin, yolo, skills);
  if (!cfg) return null;
  // skills go in through that config's `instructions`; there is still no
  // system-prompt *flag* here, so role prompts do not reach an opencode agent
  // OPENROUTER_API_KEY comes in over the tmux socket instead (keyEnv)
  return `env OPENCODE_CONFIG="${cfg}" ${continueEnv(continueFrom)}`
    + `opencode --model openrouter/${slug}${yolo ? ' --auto' : ''}`
    + (RESUME_ID_RE.test(resumeId || '') ? ` --session ${resumeId}` : '');
}

/* The launch command for a pi agent. pi gates nothing behind a confirmation
 * by design — there is no flag that adds one — so a pi pane is always in auto
 * mode whatever skipPermissions says, and the UI labels it. Unlike opencode
 * it does take a system prompt, so the role preset rides along (same
 * quote-free charset the clean agent enforces). */
function piCmd(slug, { system, continueFrom, resumeId, skills } = {}) {
  const key = config.load().openrouterKey || '';
  if (!KEY_RE.test(key) || !SLUG_RE.test(slug)) return null;
  if (missingBin('pi')) return null;
  const ext = adapterPath('pi-extension.ts');
  if (!ext) return null;
  if (system && !SAFE_ARG_RE.test(system)) return null;
  // same as the other two: the key arrives over the tmux socket (keyEnv), so
  // the only env left here is the optional continue marker
  const cont = continueEnv(continueFrom);
  let cmd = (cont ? `env ${cont}` : '')
    + `pi --provider openrouter --model ${slug} -e "${ext}"`;
  if (system) cmd += ` --append-system-prompt "${system}"`;
  // --append-system-prompt takes text *or a file's contents* and repeats, so a
  // skill goes in as its SKILL.md — same always-on contract as the other two.
  // pi's own --skill flag exists but only lists the skill by name for the model
  // to pull in later, which is not what the toggle promises.
  for (const dir of safeSkillDirs(skills)) cmd += ` --append-system-prompt "${dir}/SKILL.md"`;
  // pi takes a session file or a partial uuid; the adapter stored the uuid
  if (RESUME_ID_RE.test(resumeId || '')) cmd += ` --session ${resumeId}`;
  return cmd;
}

/* The key as a variable to hand the *session*, never a word in the command
 * that starts it. Anything in that command string is world-readable to every
 * process running as this user — `ps -eo args` shows it, and tmux itself
 * republishes it as `#{pane_start_command}`, which is how an agent following
 * this repo's own `ps` advice would print the key into its scrollback and
 * transcript. sessions.js passes this to `tmux new-session -e NAME=value`,
 * which sets it over the socket and keeps it out of both.
 *
 * Which variable depends on the harness the model value names: an 'or:' agent
 * is Claude Code pointed at openrouter.ai and reads ANTHROPIC_AUTH_TOKEN, the
 * three bare-harness spellings read OPENROUTER_API_KEY. Null for a plain
 * Claude model (it must not be handed an OpenRouter key at all) and when no
 * usable key is saved — the command builders above already turn that into a
 * visible "cannot launch" message.
 *
 * KEY_RE has already guaranteed the value is a single shell-safe token — no
 * quotes, $, backticks, backslashes or whitespace — so it survives the shell
 * that expands it there without needing any quoting of its own. */
function keyEnv(model) {
  const key = config.load().openrouterKey || '';
  if (!KEY_RE.test(key)) return null;
  if (slugOf(model)) return { name: 'ANTHROPIC_AUTH_TOKEN', value: key };
  if (cleanSlugOf(model) || opencodeSlugOf(model) || piSlugOf(model)) {
    return { name: 'OPENROUTER_API_KEY', value: key };
  }
  return null;
}

/* The harness's own session id, as its adapter recorded it next to the
 * transcript of the pane being restarted. Null when there is nothing to
 * resume — a pane that never got that far, or a harness whose id file was
 * never written — and the caller then launches fresh rather than failing. */
function foreignResumeId(stateDir, harness, oldSessionId) {
  if (!RESUME_ID_RE.test(oldSessionId || '')) return null;
  const dir = harness === 'opencode' ? 'opencode-transcripts' : harness === 'pi' ? 'pi-transcripts' : null;
  if (!dir) return null;
  try {
    const id = fs.readFileSync(path.join(stateDir, '..', dir, oldSessionId + '.jsonl.session'), 'utf8').trim();
    return RESUME_ID_RE.test(id) ? id : null;
  } catch { return null; }
}

/* Which of the two foreign harnesses a model value names ('opencode' | 'pi' |
 * null) — the renderer has the same decoder, this is main's. */
function foreignHarness(value) {
  return opencodeSlugOf(value) ? 'opencode' : piSlugOf(value) ? 'pi' : null;
}

/* Spend on the key, from GET /api/v1/key (usage_daily/weekly/monthly in USD,
 * plus what's left of a per-key credit limit), and the account-wide credit
 * balance from GET /api/v1/credits. The docs call /credits management-key
 * only; a plain sk-or-v1 inference key in fact answers 200, so it is asked
 * for — but treated as optional, since that is undocumented behaviour that
 * could be withdrawn. Cached for a minute so the renderer's pollers and any
 * manual refreshes share one request; null when no key is saved. */
let spendCache = { at: 0, data: null };
async function fetchSpend() {
  const key = config.load().openrouterKey || '';
  if (!KEY_RE.test(key)) return null;
  if (spendCache.data && Date.now() - spendCache.at < 60000) return spendCache.data;
  const opts = { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) };
  const [res, credRes] = await Promise.all([
    fetch('https://openrouter.ai/api/v1/key', opts),
    // never rejects: the balance is a bonus row, not worth failing spend over
    fetch('https://openrouter.ai/api/v1/credits', opts).catch(() => null),
  ]);
  if (!res.ok) throw new Error('OpenRouter answered HTTP ' + res.status);
  const d = (await res.json()).data || {};
  let credits = null;
  if (credRes && credRes.ok) {
    const c = (await credRes.json().catch(() => ({}))).data || {};
    if (typeof c.total_credits === 'number' && typeof c.total_usage === 'number') {
      credits = { total: c.total_credits, used: c.total_usage };
    }
  }
  spendCache = {
    at: Date.now(),
    data: {
      daily: typeof d.usage_daily === 'number' ? d.usage_daily : null,
      weekly: typeof d.usage_weekly === 'number' ? d.usage_weekly : null,
      monthly: typeof d.usage_monthly === 'number' ? d.usage_monthly : null,
      remaining: typeof d.limit_remaining === 'number' ? d.limit_remaining : null,
      limit: typeof d.limit === 'number' ? d.limit : null,
      credits,
    },
  };
  return spendCache.data;
}

/* Per-million-token list prices for a transcript-reported model id, in the
 * shape hooks.js prices Claude models ({input, output} USD/M plus the cache
 * rates OpenRouter publishes). Null when the id isn't in the catalog — the
 * caller shows tokens without a dollar figure rather than a wrong price. */
function priceFor(modelId) {
  const m = catalog().find((entry) => entry.id === modelId);
  if (!m) return null;
  return { input: m.in * 1e6, output: m.out * 1e6, cacheRead: m.cr * 1e6, cacheWrite: m.cw * 1e6 };
}

module.exports = { TOOL_PROBE, setTools, missingBin, slugOf, cleanSlugOf, cleanCmd, cleanContinueArg, opencodeSlugOf, piSlugOf, isForeign, opencodeCmd, piCmd, foreignResumeId, foreignHarness, keyEnv, hasKey, setKey, clearKey, status, catalog, fetchCatalog, alts, setAlts, envPrefix, priceFor, fetchSpend };
