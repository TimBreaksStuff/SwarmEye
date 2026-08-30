# `renderer/features/pane/`

An agent pane.

The terminal, its header and everything drawn on it. Seven ES modules, one of
which is only a front door.

| Concern | File |
|---|---|
| status, attention, prompts, subagents, hooks | `pane-status.js` |
| cost & context, model/effort chips | `pane-usage.js` |
| git chip, branch menu, model picker | `pane-git.js` |
| palettes, light-theme contrast, font | `pane-theme.js` |
| Options mirrors, mode/model/effort tables | `pane-const.js` |
| the class: constructor, header DOM, terminal, statics | `pane.js` |
| the front door that guarantees the mixins are on | `index.js` |

**Import `Pane` from `index.js`, never from `pane.js`.** The class in `pane.js`
has no `syncStatus`, no usage panel and no git chip: those are three
`Object.assign(Pane.prototype, …)` mixins in separate files, and `index.js`
exists to import them before it re-exports the class. This used to be a matter
of getting the `<script>` order right in `index.html`, with a comment asking
nicely; a module's imports are evaluated before its body, so now it is enforced.

The three mixin files import `pane.js` directly rather than `index.js`, because
importing the front door from behind it would be a cycle.

## Files

`index.js`, `pane-const.js`, `pane-git.js`, `pane-status.js`, `pane-theme.js`, `pane-usage.js`, `pane.js`, `pane.css`

`pane.css` used to carry `.app-tooltip` too. The hover tooltip is
`lib/tooltip.js`'s, not the pane's, so it moved to `lib/tooltip.css` — which
loads immediately after this sheet, exactly where those rules were.

## Public interface

`Pane` from `index.js` — the class with its three mixins applied, plus the
statics `app.js` needs to run the swarm (`Pane.applyRendererBudget`,
`Pane.setUsageWindow`, `Pane.DEFAULT_FONT_SIZE`).

**The mode table is `pane-const.js`'s; the model and effort tables come from
`main/models.js` over `models:list` and `pane-const.js` fills them in place at
boot** (`boot.js` calls `installModels` before any feature module runs, because
the board and the Options panel build their selects the moment they are
evaluated). The renderer used to keep its own copy of both lists — same values,
labels only here — so a new tier was two edits in two processes.

**The theme and font state is `pane-theme.js`'s.** Both are exported directly, and the board,
the launch card, the coordinator, the orchestrator, OpenRouter and the Options
panel import them from there. They used to read them off `Pane.MODES` and
friends, which meant importing the class — and the class imports
`openrouter.js`, which imports `board.js`, which left `Pane` in the temporal
dead zone while the board built its selects. Same arrays either way:
`Pane.MODELS` *is* `pane-const.js`'s `MODELS`, which is why a catalog pushed
into it appears in every picker.

The five Options flags (`showInitialCommand`, `autoOrganize`, `skipPermissions`,
`showUsagePanel`, `usageWindow`) and the theme/font state have exported setters
in the file that declares them. `pane.js` used to assign to them across the file
boundary, which one shared script scope allowed and modules do not.

## Panes nobody is looking at

A pane in another workspace keeps running, unmounted. `app.js` tells each one
which side of that line it is on (`setOnScreen`), and three things follow:

- **The settle-time scan** (`scanBuffer`) still auto-accepts blocking dialogs
  and refreshes the prompt options — an agent nobody is watching must not sit
  blocked, and the bell offers its buttons from anywhere — but leaves the
  header chips (mode, model, effort) until the pane is on screen again.
- **The GPU renderer** goes back after a minute off screen, and
  `Pane.applyRendererBudget` caps how many panes hold one at all
  (`MAX_WEBGL_PANES`): past it Chromium starts killing contexts under the
  running app, and a pane whose context was taken draws nothing.
- **Its pty output batches slower** — that half is main's (`queuePtyData`),
  driven by the same visible-set `app.js` computes here.

xterm itself already stops *rendering* a terminal that is off screen (its own
IntersectionObserver), so none of the above is about drawing.

## How to test

`npm start` with an agent running. Watch the status dot through a turn, open
the git chip and the model picker, resize the font with `Ctrl+±`.

Moving a method between the mixin files is a cut-and-paste: **a class body
separates methods by nothing, an object literal needs commas.** Check that the
count of `^  }$` terminators still matches the count of method headers.
