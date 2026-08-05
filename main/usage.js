const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const config = require('./config');
const { IS_WIN, exec } = require('./platform');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// the endpoint's real safe cadence is ~60s (confirmed against a debug log —
// polling at 30s reliably 429s the request right after every success,
// resetting backoff back to 30s and re-tripping it forever); bumped to 90s
// since 60s still trips it often enough that "stale" shows up constantly
const POLL_MS = 90 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
// guards against click-spamming an already-rate-limited endpoint: a second
// manual refresh within this window just replays the last known snapshot
const MIN_MANUAL_INTERVAL_MS = 3000;

/* On macOS Claude Code keeps its OAuth credentials in the Keychain
 * ("Claude Code-credentials"); older installs used ~/.claude/.credentials.json.
 * Try the Keychain first, fall back to the file. */
function readKeychain() {
  return new Promise((resolve, reject) => {
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) return reject(new Error('not in keychain'));
        resolve(String(stdout));
      }
    );
  });
}

/* Windows: the credentials belong to the copy of Claude Code living inside
 * WSL, so they're read from there rather than from the Windows-side home
 * directory — there is no Keychain and no local file to fall back to. */
async function readRaw() {
  if (IS_WIN) {
    const out = await exec('cat ~/.claude/.credentials.json', 15000);
    if (out == null) throw new Error('cannot read WSL credentials');
    return out;
  }
  try {
    return await readKeychain();
  } catch {
    try {
      return fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    } catch {
      throw new Error('cannot read Claude Code credentials — log in with claude first');
    }
  }
}

async function readCredentials() {
  const raw = await readRaw();
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error('credentials unreadable');
  }
  const oauth = creds.claudeAiOauth || {};
  if (!oauth.accessToken) throw new Error('no OAuth token found');
  return oauth;
}

// the usage API reports utilization on a 0-100 scale (confirmed against the
// parallel `limits[].percent` field, which always matches it exactly) — no
// fraction case exists, so treating values <=1 as a 0-1 fraction misreads a
// genuine ~1% (e.g. right after a weekly reset) as 100%
function pct(utilization) {
  if (typeof utilization !== 'number') return null;
  return Math.round(utilization);
}

// the API reports resets_at as an ISO-8601 string; normalize to epoch ms
// here so every downstream comparison (the "next session" scheduler gate,
// task creation's Number.isFinite check) can compare it against Date.now()
// directly instead of re-parsing a string that a bare `<` would silently
// treat as NaN (always false, so a task would never wait for the reset)
function resetsAtMs(v) {
  if (v == null) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function window(w) {
  if (!w) return null;
  return { usedPct: pct(w.utilization), resetsAt: resetsAtMs(w.resets_at) };
}

/* Its own file, not config.json — the runstate.json split in main.js, for the
 * same reason: this snapshot is ~150 bytes and is rewritten every 90 seconds,
 * while config.json carries the archived task logs and is six figures of bytes,
 * so writing it there sized every poll by the archive. */
const SNAPSHOT_FILE = () => path.join(app.getPath('userData'), 'usage-snapshot.json');

function readSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_FILE(), 'utf8')); } catch { /* see below */ }
  // written by a version that still kept it in config.json — taken over once,
  // so upgrading doesn't blank the widgets until the first live fetch lands
  return config.load().lastUsageSnapshot || null;
}

function writeSnapshot(snapshot) {
  try { fs.writeFileSync(SNAPSHOT_FILE(), JSON.stringify(snapshot)); } catch { /* next poll retries */ }
}

class UsageMonitor {
  constructor({ onUpdate }) {
    this.onUpdate = onUpdate;
    this.timer = null;
    this.backoff = POLL_MS;
    // seeded from the previous run so a restart has something to show
    // immediately instead of blank widgets while the first live fetch is
    // pending (or failing, e.g. right after boot the OAuth token / usage
    // endpoint can be briefly unreachable)
    this.lastGood = readSnapshot();
    this.lastAttempt = 0;
    this.inFlight = null;
    this.stopped = false;
    // parsed OAuth creds, kept until their own expiresAt passes or the API
    // rejects them — re-reading every poll cost a wsl.exe spawn (hundreds of
    // ms) per 90s tick on Windows, ~960 spawns a day, for a token that
    // changes a handful of times a day
    this.cachedOauth = null;
  }

  start() {
    if (this.lastGood) {
      try { this.onUpdate({ ...this.lastGood, stale: true, reason: 'remembered from before restart' }); } catch { /* see tick() */ }
    }
    this.tick();
  }

  stop() {
    // schedule() runs from inside the in-flight fetch, so a stop() landing
    // while one is pending would otherwise re-arm the timer behind it and the
    // poller would keep running (and writing) after shutdown
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
  }

  /* A click that lands within MIN_MANUAL_INTERVAL_MS of the last attempt
   * (automatic or manual) just replays what we already know — repeated
   * clicking while the endpoint is already rate-limited would otherwise
   * hammer it further and compound the backoff for no benefit. */
  async refreshNow() {
    if (Date.now() - this.lastAttempt < MIN_MANUAL_INTERVAL_MS) {
      return this.degraded('checking too frequently');
    }
    return this.tick(true);
  }

  async tick(manual = false) {
    // a manual refresh landing while a poll's fetch is still in flight must
    // not fire a second concurrent request (a doubled 429 would double the
    // backoff) — both callers share the one pending result instead
    if (this.inFlight) return this.inFlight;
    this.lastAttempt = Date.now();
    this.inFlight = (async () => {
      const snapshot = await this.fetchSnapshot(manual);
      // a failure pushing to the renderer (destroyed window, IPC hiccup) must
      // never prevent the next poll from being scheduled — otherwise the loop
      // silently dies and nothing but an app restart brings it back
      try { this.onUpdate(snapshot); } catch { /* see comment above */ }
      if (!this.stopped) this.schedule(this.backoff);
      return snapshot;
    })();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /* Only the scheduled poll backs off: a manual refresh that gets rate-limited
   * or fails must not push the automatic loop out (a few impatient clicks would
   * otherwise walk it up to the 30-minute maximum). */
  backOff(manual) {
    if (!manual) this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  async fetchSnapshot(manual = false) {
    // re-read only when the cached token is missing or about to expire —
    // a still-valid token needs no disk/Keychain/WSL round trip
    let oauth = this.cachedOauth;
    if (!oauth || (oauth.expiresAt && Date.now() > oauth.expiresAt - 60000)) {
      try {
        oauth = await readCredentials();
        this.cachedOauth = oauth;
      } catch (err) {
        // a credential read that keeps failing retried forever at POLL_MS, and on
        // Windows each retry is a fresh wsl.exe spawn that blocks for 15s when
        // WSL is down — the same backoff the 429 path uses applies here
        this.backOff(manual);
        return this.degraded(err.message);
      }
    }

    if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
      this.cachedOauth = null; // the next poll re-reads — claude may have refreshed it on disk
      return this.degraded('token expired');
    }

    try {
      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 429) {
        this.backOff(manual);
        return this.degraded('rate limited');
      }
      if (res.status === 401) {
        this.cachedOauth = null; // stale cache — re-read from disk next poll
        return this.degraded('token rejected');
      }
      if (!res.ok) {
        return this.degraded(`usage API error ${res.status}`);
      }

      const body = await res.json();
      this.backoff = POLL_MS;
      this.lastGood = {
        ok: true,
        fiveHour: window(body.five_hour),
        weekly: window(body.seven_day),
        fetchedAt: new Date().toISOString(),
      };
      writeSnapshot(this.lastGood);
      return this.lastGood;
    } catch (err) {
      this.backOff(manual);
      return this.degraded('usage API unreachable');
    }
  }

  degraded(reason) {
    if (this.lastGood) {
      return { ...this.lastGood, stale: true, reason };
    }
    return { ok: false, reason };
  }
}

module.exports = { UsageMonitor };
