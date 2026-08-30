# `renderer/features/openrouter/`

OpenRouter in the renderer.

The provider and model pickers over the catalog main fetched, and the slug
decoding every picker needs. A catalog pick is a **clean** agent (`oc:`,
`agent/clean.js`) — no Claude Code harness around it.

The key itself never crosses IPC; this module only ever sees the catalog.

## Files

`openrouter.js` · `openrouter.css`

The sheet is the key row in **Options → Setup**, the model menu and the harness
chips, cut out of the end of `styles/chrome-clean.css`. Slot 5, after
chrome-clean.css, where those rules were written.

## Public interface

`OpenRouterUI.models`, `.install(models)`, `.openModelMenu(anchor, onPick)`,
`.openProviderMenu(anchor, onPick)`, `.harnessOf`, `.slugOf`, `.isBare`,
`.isOpenRouter`, `.applyNewAgentProvider`. An ES module.

## How to test

Save a key in **Options → Setup**. The catalog should extend every model
select, and **+ Agent → OpenRouter** should offer it. With no key, none of
those rows exist.
