# `renderer/styles/`

The three sheets that are not one area's. **Their position in `index.html` is
the whole design** — see the load order there.

| File | Holds |
|---|---|
| `tokens.css` | design tokens and the colour themes |
| `app.css` | the chassis only: shell, health banner, reattach pill |
| `chrome-clean.css` | the shared design language — `.pill`, chips, icon sizing, focus rings |
| `native-mac.css` | "Native Apple style", every rule scoped to `:root[data-native="on"]` |

## Load order

1. `tokens.css`
2. `app.css`
3. `features/<area>/<area>.css` — one sheet per area
4. `chrome-clean.css`
5. `features/settings/settings.css`, `features/notifications/notifications.css`
6. `features/orchestrator/orchestrator.css`
7. `native-mac.css`

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

Bulk moves are **verified, not reasoned about**: drive the app over CDP, record
every element's computed style across all views and both themes, move the rules,
record again, require an empty diff. Run the snapshot twice on identical code
first — usage bars and toggle states drift between runs, and that noise floor
tells you which differences are real.
