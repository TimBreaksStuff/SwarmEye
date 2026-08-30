/* main/models.js — the one model and effort table.
 *
 * There were two. This process kept a list of flag values, the renderer kept a
 * list of [value, label] pairs, and adding a tier meant editing both by hand
 * and remembering the labels. main/roles.js has always been the single owner
 * of the role list, handed to the renderer over `roles:list`; this is the same
 * arrangement for models, and `models:list` is its channel.
 *
 * `flag: true` marks a value Claude Code will actually accept behind `--model`
 * or `--effort`. The ones without it exist only in the UI: `default` means
 * "don't pass the flag at all", and `ultracode` and `auto` are typed into a
 * running agent rather than launched with.
 */

const MODELS = [
  { value: 'default', label: 'Anthropic Subscription: default' },
  { value: 'sonnet', label: 'Anthropic Subscription: Sonnet', flag: true },
  { value: 'opus', label: 'Anthropic Subscription: Opus', flag: true },
  { value: 'haiku', label: 'Anthropic Subscription: Haiku', flag: true },
  { value: 'fable', label: 'Anthropic Subscription: Fable', flag: true },
  { value: 'opusplan', label: 'Anthropic Subscription: Opus plan, Sonnet execution', flag: true },
  { value: 'opus[1m]', label: 'Anthropic Subscription: Opus (1M context)', flag: true },
  { value: 'sonnet[1m]', label: 'Anthropic Subscription: Sonnet (1M context)', flag: true },
];

const EFFORTS = [
  { value: 'default', label: 'default' },
  { value: 'low', label: 'low', flag: true },
  { value: 'medium', label: 'medium', flag: true },
  { value: 'high', label: 'high', flag: true },
  { value: 'xhigh', label: 'xhigh', flag: true },
  { value: 'max', label: 'max', flag: true },
  { value: 'ultracode', label: 'ultracode' },
  { value: 'auto', label: 'auto' },
];

const flagsOf = (rows) => rows.filter((r) => r.flag).map((r) => r.value);
const valuesOf = (rows) => rows.map((r) => r.value);

/* What crosses IPC: [value, label] pairs, which is the shape every select in
 * the renderer is built from. */
const pairsOf = (rows) => rows.map((r) => [r.value, r.label]);

module.exports = {
  MODELS,
  EFFORTS,
  /* the values a launch flag may carry */
  MODEL_FLAGS: flagsOf(MODELS),
  EFFORT_FLAGS: flagsOf(EFFORTS),
  /* every value the UI can send, flag or not */
  EFFORT_VALUES: valuesOf(EFFORTS),
  pairsOf,
};
