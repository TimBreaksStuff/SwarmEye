# `renderer/lib/`

The helpers every area uses. Not areas themselves, which is why they sit
outside `features/`. All ES modules: each area imports what it needs.

| File | Public interface |
|---|---|
| `dom.js` | `elt(tag, class, text)`, `placePop(el, anchor, opts)`, `dismissPop(el, close, opts)`, `dragWidth(handle, el, opts)` |
| `tooltip.js` | nothing — installs the `data-tip` listeners |
| `tooltip.css` | the look of the element `tooltip.js` puts on the page |
| `confirm.js` | `Confirm.armOrFire`, `.restoreArmed`, `.disarm` |
| `icons.js` | `Icons.markup(name)`, `Icons.set(el, name)` |
| `resizable.js` | `Resizable.place`, `.remember` |
| `toast.js` | `toast(msg)` — the message line at the bottom of the window |
| `toast.css` | its look |
| `keys.js` | `IS_MAC`, `modHeld(e)` — the one modifier rule |
| `fragments.js` | `mountFragments()` — each area's markup, from that area's folder |

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
- **`toast.js` and `keys.js` were in `app.js`, published as `window.toast` and
  `window.modHeld`.** That was never a design: classic scripts could not import
  from a module, so app.js had to hand them out through the global object, and
  the comments there said as much. Every caller is a module now, so they are
  plain imports and live where a helper no area owns belongs.
- **Markup goes in `features/<area>/<area>.html`, not `index.html`.** One or
  more `<template data-mount="name">` per file, one
  `<div data-fragment="name">` placeholder in the shell. `boot.js` mounts them
  all before it imports `app.js`, because feature modules look their elements
  up when they are evaluated. An area whose markup needs to sit in two places
  in the shell uses two templates rather than one, so nothing moves.
- **`tooltip.css` and `toast.css` are the two sheets in here, and they are here
  because no area owns what they style.** The `data-tip` hints come from every corner of the app and the pane
  title's dynamic prompt tip reuses the same element. It loads at slot 3 right
  after `pane.css`, where its rules used to sit, so `chrome-clean.css` still
  flattens `.app-tooltip` afterwards — see `renderer/styles/README.md`.

## How to test

`npm start` and open any popover: it should sit under its button, stay inside
the window, and close on a click outside or `Esc`.
