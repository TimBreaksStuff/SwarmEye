# `renderer/features/update/`

Checking for and installing a new SwarmEye.

Two elements, one state: the top bar's pill is an at-a-glance indicator and
does nothing but open the Options row, which is where the download and the
restart actually happen — a browser tab would lose the progress reporting.

The background check is silent by design, so asking by hand reports what
actually came back rather than leaving the row reading "up to date" after a
failure.

## Files

`update.js`, `update.css`

## Public interface

`init({ toast, openOptions })`. An ES module imported by `app.js`; everything
else arrives on main's `update:*` channels.

## How to test

**Options → Update → Check**. With no newer release it should read
`v<version> — up to date`; offline it should say the check failed, not that you
are current.
