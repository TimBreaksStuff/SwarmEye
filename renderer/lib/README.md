# `renderer/lib/`

The five helpers every area uses. Not areas themselves, which is why they sit
outside `features/`; they load first, as classic scripts, and publish globals.

| File | Public interface |
|---|---|
| `dom.js` | `elt(tag, class, text)`, `placePop(el, anchor, opts)`, `dismissPop(el, close, opts)`, `dragWidth(handle, el, opts)` |
| `tooltip.js` | nothing — installs the `data-tip` listeners |
| `confirm.js` | `Confirm.armOrFire`, `.restoreArmed`, `.disarm` |
| `icons.js` | `Icons.markup(name)`, `Icons.set(el, name)` |
| `resizable.js` | `Resizable.place`, `.remember` |

## Rules

- **Never name a local `elt`** — it shadows the global one.
- **Anchor popovers with `placePop`, close them with `dismissPop`.** Ten
  popovers each carried their own clamp-to-the-window maths before the sweep.
  `placePop` measures the box, so unhide it *first*; `dismissPop` returns its
  own teardown, which your `close()` must call.
- **One confirm.** `confirm.js` owns app-wide click-twice-to-confirm because
  screens rebuild their rows on unrelated events and would otherwise wipe an
  armed button mid-confirm. Reuse it; do not write a second one.
- **`icons.js` is the icon set** — 24-box, 1.6 stroke weight. New chrome uses
  it, not an emoji glyph.

## How to test

`npm start` and open any popover: it should sit under its button, stay inside
the window, and close on a click outside or `Esc`.
