# `renderer/features/pane/`

An agent pane.

The terminal, its header and everything drawn on it. **Six classic scripts
sharing one script scope, not modules** — `Pane` is constructed by `app.js` and
read for statics by four more classic scripts, and a classic script cannot
import from a module, so converting means converting all of them at once.

| Concern | File |
|---|---|
| status, attention, prompts, subagents, hooks | `pane-status.js` |
| cost & context, model/effort chips | `pane-usage.js` |
| git chip, branch menu, model picker | `pane-git.js` |
| palettes, light-theme contrast, font | `pane-theme.js` |
| Options mirrors, mode/model/effort tables | `pane-const.js` |
| the class: constructor, header DOM, terminal, statics | `pane.js` |

**Load order in `index.html` carries all of it**: the vocabulary files must come
before the class that closes over their consts, and the three mixins must follow
it because they reach `Pane.prototype`.

## Files

`pane-const.js`, `pane-git.js`, `pane-status.js`, `pane-theme.js`, `pane-usage.js`, `pane.js`, `pane.css`

## Public interface

`window.Pane` — the class, its statics (`Pane.MODELS`, `Pane.DEFAULT_FONT_SIZE`,
`Pane.setUsageWindow`, `Pane.setDefaultFontSize`, `Pane.setSkipPermissions`, …)
and the three `Object.assign(Pane.prototype, {…})` mixins.

## How to test

`npm start` with an agent running. Watch the status dot through a turn, open
the git chip and the model picker, resize the font with `Ctrl+±`.

Moving a method between the mixin files is a cut-and-paste: **a class body
separates methods by nothing, an object literal needs commas.** Check that the
count of `^  }$` terminators still matches the count of method headers.
