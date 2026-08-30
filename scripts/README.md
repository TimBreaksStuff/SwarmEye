# `scripts/`

Everything that is run *at* the project rather than shipped in it: the setup
scripts a fresh machine needs, the two publish scripts, and the dev tools that
stand in for the test runner this project does not have.

| File | What it is |
|---|---|
| `cdp.js` | shared: boots the app on a throwaway profile and hands back a CDP connection |
| `boot-check.js` | does the renderer come up clean? |
| `check-imports.js` | does every name a renderer module uses resolve? |
| `style-snapshot.js` | did a CSS move change anything? |
| `setup-mac.sh`, `setup-stt.sh`, `setup-tts.sh` | first-run installs |
| `publish-github.sh`, `publish-release.sh` | the two publish paths |
| `stt-stream.py` | the dictation helper `main/speech.js` spawns |

## The dev tools

`verify` in this project means run the app and look. These do the part of
looking that a script can do. `check-imports.js` is static and needs nothing;
the other two need no real config either, because `cdp.js` boots
Electron on a throwaway `--user-data-dir`, so they run happily while SwarmEye
is open and every run starts from the same blank state.

```
node scripts/check-imports.js       # exit 1 on any unresolved name
node scripts/boot-check.js          # exit 1 on any uncaught error
node scripts/style-snapshot.js --cascade before.json
```

**`check-imports.js` catches what a clean boot cannot.** A module that reads a
name it never imported is valid JavaScript until that line runs, and the line
is usually in a branch only real data reaches — so the app boots perfectly and
throws in front of a user. It reports both halves of that: a name another
module exports and this one forgot to import, and a name another module keeps
module-private, which needs an `export` as well as the import.

**`boot-check.js` is the one to run after anything structural** — a module
conversion, a moved file, a changed `<script>` or `<link>`. It fails on an
uncaught exception, a `console.error`, or a resource the page could not load,
and names the file and line. It is not a test suite: a clean boot says the app
loaded, not that it works.

**`style-snapshot.js` is the harness behind the rule that a bulk CSS move is
verified, not reasoned about.** `renderer/styles/README.md` explains both of
its modes and why the cascade one is the one that proves a move.

## Adding one

A dev tool goes here, uses `cdp.js` rather than opening its own WebSocket, and
gets a row in the table above. If it needs the app in a particular state, drive
it through the app's own entry points — an id-based DOM poke is fine, a click
path breaks on every layout change.
