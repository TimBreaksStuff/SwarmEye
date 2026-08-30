# `renderer/features/skills/`

The Skills screen.

Install a skill from a GitHub repo, enable it, mark it active, update it,
remove it. A full view, mutually exclusive with the Task Board and the grid.

**Enabled is not active.** An *active* skill is injected into every new agent on
every turn, which is paid every turn of every agent — see `main/skills.js`.

## Files

`skills.js`, `skills.css` · `skills.html`

The markup was in `renderer/index.html`. It is here now, as
`<template data-mount="…">` sections that `lib/fragments.js` puts into the
shell before any module runs.

## Public interface

`Skills.refresh()`, `.installed()`, `.getActiveSkills()` — a plain top-level
const `app.js` reads directly. An ES module.

## How to test

**Skills** in the rail. Install a repo, toggle enabled and active, press
update. Then start an agent and confirm an active skill reached its prompt (and
an enabled-but-inactive one did not).
