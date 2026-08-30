# `renderer/styles/`

The sheets that are not one area's. **Their position in `index.html` is
the whole design** — see the load order there.

| File | Holds |
|---|---|
| `tokens.css` | design tokens and the colour themes |
| `app.css` | the chassis only: shell, health banner, reattach pill |
| `chrome-clean.css` | the shared design language — `.pill`, chips, icon sizing, focus rings, `.sw-busy`, and the one flat treatment the four views share |
| `native-mac.css` | "Native Apple style", every rule scoped to `:root[data-native="on"]` |
| `reduce-transparency.css` | the "Reduce transparency" option, scoped to `:root[data-reduce-transparency="on"]` |

`chrome-clean.css` still names board and skills selectors, and that is not a
leak to clean up: its VIEWS section exists precisely to give the Task Board and
the Skills screen *one* row language, one button shape, one field shape. The
board's own components live in `features/board/board.css`; what is here is the
half that puts them next to the skills equivalents. Splitting those apart would
delete the only place the pairing is visible.

What *was* a leak, and is gone: four self-contained components — the command
palette, the launch card, the role editor and the OpenRouter key row — had
their entire look in this sheet while their JS sat in `features/`. `pane.css`
had the same problem twice over, carrying `.app-tooltip` and `#toast`, neither
of which is the pane's; both moved to `lib/`, next to the module that raises
them.

## Load order

1. `tokens.css`
2. `app.css`
3. `features/<area>/<area>.css` — one sheet per area, plus `lib/tooltip.css`
   and `lib/toast.css` right after `pane.css` and
   `features/palette/palette.css` last
4. `chrome-clean.css`
5. `features/launcher/launcher.css`, `features/addagent/addagent.css`,
   `features/openrouter/openrouter.css`,
   `features/settings/settings.css`, `features/notifications/notifications.css`
6. `features/orchestrator/orchestrator.css`
7. `native-mac.css`
8. `reduce-transparency.css`

The first three sheets in slot 5 are the tail `chrome-clean.css` used to carry
inline, kept in the order it carried them — which is the reason cutting them
out moved nothing.

Slot 8 is last because its job is to beat every blur above it, `native-mac`'s
included. The window material behind that style is not CSS at all — main
switches it (`config:set-reduce-transparency`).

**Slot 3 vs slot 5 is load-bearing.** `chrome-clean.css` exists to override
`app.css`, so an area sheet carrying only `app.css`'s half must load *before* it
or every one of those overrides flips at once. A sheet moves to slot 5 only if
it took `chrome-clean`'s half too — and then it must carry any *shared*
declaration it was relying on (`#kbd-pop` and `#notif-pop` both sat on
chrome-clean's flat-popover list and had to carry those two declarations
themselves).

## Where a rule goes

- A new component: its area's `features/<area>/*.css`.
- Genuinely shared across areas: `chrome-clean.css`.
- The shell itself: `app.css`.
- A new colour: `tokens.css`, never inline.

Anything text-carrying must clear WCAG AA against `--bg` on the Light theme too.

## How to test

Bulk moves are **verified, not reasoned about**, and `scripts/style-snapshot.js`
is the harness that does it. It boots the app on a throwaway `--user-data-dir`
(the real one and its single-instance lock stay untouched) and reads it over
CDP in two different ways.

```
node scripts/style-snapshot.js --cascade before.json
<move the rules>
node scripts/style-snapshot.js --cascade after.json
node scripts/style-snapshot.js --diff before.json after.json    # must be empty
```

**`--cascade` is the one that proves the move.** For every CSS property it dumps
the ordered list of every declaration touching that property across every sheet,
in cascade order. Two declarations can only fight if they name the same
property, so an unchanged sequence per property means an unchanged winner for
*every* element — including the ones no snapshot can reach because they are
built at runtime: palette rows, board cards, skill rows, launcher tiles. It
renders nothing, so it has no noise floor at all: the diff must be exactly
empty. It reads longhands, so respelling a shorthand compares equal.

The default mode (no flag) is the weaker, complementary check: walk the live DOM
in every view and every sheet-switching mode — dark, light, Native Apple style,
Reduce transparency — and record the full computed style of every element. It
catches the one thing the cascade dump cannot, a selector that stopped matching
because markup moved, but only for elements actually on screen. It carries a
small noise floor: "Native Apple style" resolves macOS's own accent colours and
Chromium re-derives them per run, so the diff tolerates a 1% colour drift and
0.02 on any other number. Run it twice on identical code to confirm that floor
is still empty on your machine before trusting a real diff.

Use both, cascade first.
