#!/usr/bin/env node
/* scripts/boot-check.js — does the renderer still come up clean?
 *
 * There is no test runner here and `verify` means run the app and look. This
 * is the part of looking a script can do: boot the app, wait for it to settle,
 * and fail on anything the page itself complained about — an uncaught
 * exception, a console error, a module or stylesheet that would not load.
 *
 * It is deliberately blunt about what "clean" means, because the failures it
 * exists to catch are blunt: a missing import after a module conversion, a
 * script tag pointing at a file that moved, a fragment that never arrived.
 *
 * It boots against scripts/fixtures/populated-config.json, not a blank
 * profile. That matters more than it sounds: an empty rail looks exactly like
 * a rail that threw drawing its first workspace, and 3.0.0 shipped with
 * precisely that — one tile rendered out of seven, because wsagents.js used
 * Icons without importing it. Every check passed, because none of them had a
 * workspace to draw.
 *
 *   node scripts/boot-check.js            # boot, report, exit 1 on anything
 *   node scripts/boot-check.js --blank    # ...on an empty profile instead
 *   node scripts/boot-check.js --probe 'expression'   # ...and print this too
 */

const path = require('path');
const { launchApp, evaluate, sleep } = require('./cdp');

const FIXTURE = path.join(__dirname, 'fixtures', 'populated-config.json');
const FIXTURE_WORKSPACES = require(FIXTURE).workspaces.length;

/* Warnings the app makes on purpose on a blank profile, which would otherwise
 * fail every run. Keep this list short and specific — a pattern here is a
 * failure nobody will ever see again. */
const EXPECTED = [
  /Autofill\.(enable|setAddresses)/i,          // Chromium's own devtools noise
  /Request Autofill\.enable failed/i,
];

const isExpected = (text) => EXPECTED.some((re) => re.test(text));

async function main() {
  const probeIndex = process.argv.indexOf('--probe');
  const probe = probeIndex > -1 ? process.argv[probeIndex + 1] : null;

  const blank = process.argv.includes('--blank');
  const problems = [];
  const { cdp, stop } = await launchApp({
    seedConfig: blank ? undefined : FIXTURE,
    onStderr: (s) => {
      for (const line of s.split('\n')) {
        const t = line.trim();
        if (!t || isExpected(t)) continue;
        if (/error|uncaught|failed|cannot find|not defined/i.test(t)) problems.push('main: ' + t);
      }
    },
  });

  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      const text = d.text + ' ' + ((d.exception && d.exception.description) || '');
      if (!isExpected(text)) problems.push('uncaught: ' + text.trim());
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'assert') return;
      const text = (p.args || []).map((a) => a.description || a.value || '').join(' ');
      if (!isExpected(text)) problems.push('console.error: ' + text.trim());
    });
    cdp.on('Log.entryAdded', (p) => {
      const e = p.entry || {};
      if (e.level !== 'error') return;
      const text = e.text + (e.url ? ' (' + e.url + ')' : '');
      if (!isExpected(text)) problems.push('page: ' + text.trim());
    });

    await evaluate(cdp, 'document.fonts.ready.then(() => 1)');
    await sleep(4000); // the rail, the usage poll and the first paint all land in here

    /* A renderer that failed to boot still *renders*: the shell is static
     * markup and paints with or without a working app. So the real question is
     * not "did anything print an error", it is "did app.js finish".
     *
     * __swarmTestState is app.js's last statement, and main.js's SWARMEYE_TEST
     * dump already depends on it, so it is not a hook invented for this script.
     * If it is missing, app.js threw or never ran — which is exactly what a
     * rejected top-level await in boot.js looks like, and that arrives as an
     * unhandled rejection rather than Runtime.exceptionThrown: it lit no
     * listener here at all until this check existed. */
    const alive = JSON.parse(await evaluate(cdp, `JSON.stringify({
      title: document.title,
      booted: typeof window.__swarmTestState === 'function',
      unmounted: [...document.querySelectorAll('[data-fragment]')].map((el) => el.dataset.fragment),
      workspaceTiles: document.querySelectorAll('#workspaces .ws-tile').length,
      boardCards: document.querySelectorAll('#board .board-card').length,
      bodyChildren: document.body.children.length,
    })`));
    console.log('page: ' + JSON.stringify(alive));
    if (!alive.booted) problems.push('app.js never finished: window.__swarmTestState is not defined');
    if (alive.unmounted.length) problems.push('fragments never mounted: ' + alive.unmounted.join(', '));
    /* The count, not merely "some". A loop that throws part-way renders the
     * tiles before the throw and none after, which reads as a working rail
     * until you count. */
    if (!blank && alive.workspaceTiles !== FIXTURE_WORKSPACES) {
      problems.push(`the rail drew ${alive.workspaceTiles} of ${FIXTURE_WORKSPACES} workspaces`
        + ' — something threw part-way through rendering it');
    }

    if (probe) console.log('probe: ' + JSON.stringify(await evaluate(cdp, probe)));
  } finally {
    await stop();
  }

  if (problems.length) {
    console.log('\n' + problems.length + ' problem(s):');
    for (const p of [...new Set(problems)]) console.log('  - ' + p);
    process.exit(1);
  }
  console.log('\nBOOT CLEAN — no uncaught exceptions, no console errors, no failed loads');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
