# `renderer/features/usage/`

Quota warnings.

One toast when the Anthropic quota crosses a threshold. The rail's gauges
already colour themselves amber past 75% and red past 90%, but that only helps
while you are looking at them; with a swarm running you can walk into the
ceiling and only find out when agents start failing mid-turn.

Same two thresholds as the gauges, so the warning and the gauge always agree.
It fires only on the way up; dropping back below, or the window resetting,
re-arms it.

## Files

`usage-warnings.js`

## Public interface

`check(snapshot, toast)`. An ES module imported by `app.js`.

## How to test

Hard to force honestly — a degraded or stale snapshot must produce *no*
warning and must not clear an armed level, which is the case worth checking by
hand in `usage-warnings.js`.
