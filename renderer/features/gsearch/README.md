# `renderer/features/gsearch/`

Search across every agent.

A pane's own `Ctrl+F` searches one terminal; this answers *which* agent said
it. Matches are grouped per agent and capped at four rows each — the pane
search is the right tool once you know where to look, so jumping hands it the
query.

Every run translates each live pane's whole scrollback, so the input is
debounced: typing a word costs one pass, not one per letter.

## Files

`gsearch.js`, `gsearch.css`

## Public interface

`init({ state, focusedPane, toggleBoard, selectWorkspace })`, `toggle(show)`,
`popEl`. An ES module imported by `app.js`.

## How to test

`Ctrl+Shift+G` or the magnifier. Type two characters or more; clicking a row
should switch workspace if needed, scroll that pane to the line and leave the
pane search armed with the same query.
