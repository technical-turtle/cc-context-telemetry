'use strict';
// cc-context-telemetry - consumer API.
//
// Claude Code hooks and plugins cannot see context fullness or rate limits. The
// ONLY place Claude Code exposes the AUTHORITATIVE context_window /
// rate_limits is the statusLine command. The statusLine entry (bin/cct-statusline)
// is PURE SHELL: every render it writes the RAW statusline payload to a per-session
// file (telemetry-raw-<session>.json) with NO Node and NO JSON parsing (a Node spawn
// per render across many sessions piles up load). ALL parsing happens HERE, on
// demand, when a hook calls readTelemetry(sessionId): this module reads the raw
// payload file, parses it, and returns the authoritative reading. So the per-render
// hot path stays Node-free and the parse cost is paid only when a hook actually asks.
//
// CONTRACT: never throws. readTelemetry returns a normalized object or null.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Telemetry directory. Default ~/.claude/cc-context-telemetry/, override via
// env CCT_DIR (tests point this at a temp dir).
function telemetryDir() {
  return process.env.CCT_DIR || path.join(os.homedir(), '.claude', 'cc-context-telemetry');
}

// Sanitize a session id into a safe filename component. A real Claude Code
// session_id is a UUID, so legit ids pass through unchanged; a hostile id like
// "../../tmp/evil" or "a/b" cannot escape telemetryDir() because every character
// outside [A-Za-z0-9_-] (dots and slashes included) becomes "_", killing ".."
// and path separators. Empty result falls back to "default".
function sanitizeId(sessionId) {
  const s = String(sessionId == null ? '' : sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
  return s.length ? s : 'default';
}

// Build a contained per-session path under telemetryDir() for the given filename
// prefix. The sanitized id cannot escape; the resolve check is belt-and-suspenders.
function sessionPath(prefix, sessionId, fallbackName) {
  const dir = telemetryDir();
  const safe = sanitizeId(sessionId);
  const p = path.join(dir, prefix + safe + '.json');
  const guard = path.resolve(dir) + path.sep;
  if (!(path.resolve(p) + path.sep).startsWith(guard)) {
    return path.join(dir, fallbackName);
  }
  return p;
}

// Path of the parsed-telemetry file. Retained for backward compatibility and for
// tests/consumers that stub telemetry via writeTelemetry; the live shell entry no
// longer writes this file (it writes the raw payload, see rawPath).
function telemetryPath(sessionId) {
  return sessionPath('telemetry-', sessionId, 'telemetry-default.json');
}

// Path of the RAW statusline payload the shell entry writes every render. This is
// the live source readTelemetry parses on demand. The shell entry uses the SAME
// sanitization and "default" empty-id fallback as sanitizeId here, so both sides
// resolve the same filename.
function rawPath(sessionId) {
  return sessionPath('telemetry-raw-', sessionId, 'telemetry-raw-default.json');
}

function ensureDir() {
  try { fs.mkdirSync(telemetryDir(), { recursive: true }); } catch (e) {}
}

function nowIso() { return new Date().toISOString(); }

// Raw-file hygiene. The shell entry writes one telemetry-raw-<session>.json AND one
// telemetry-rl2-<session> (the rate-limit change tracker; telemetry-rl-* is the pre-1.4.8 name,
// no longer read, so it is deleted outright) per session, overwriting them
// each render, so a single live session never grows the dir. But a long-lived machine
// accumulates one of each per session id seen over time (each `claude` invocation is a
// new UUID), and nothing on the hot path prunes them. So the READER prunes here, OFF the
// per-render hot path: pruning runs only when a hook actually calls readTelemetry
// (best-effort, never throws, never blocks output).
//
// Bounded prune over ONLY this lib's own state files, applied to the raw pool
// (telemetry-raw-*.json) AND the tracker pool (telemetry-rl2-*) INDEPENDENTLY:
//   1. RAW files: delete any whose mtime is older than CCT_PRUNE_AGE_SEC (default 1 day) - a
//      session untouched for that long is dead.
//   1b. TRACKERS: deleted when EVERY reset boundary in the line has elapsed (it can never be
//      picked again), NOT by age. A tracker is rewritten only when its reading changes, so an
//      open but idle session has an old mtime and still holds its reading's real stamp; a
//      recreated tracker could only be stamped with the last-call time or as unknown. A
//      tracker with no parseable boundary (corrupt, an old format, or the empty marker a session
//      writes before its first rate_limits) falls back to the age rule.
//   2. then, if more than the cap remain in a pool (raw: CCT_PRUNE_MAX_FILES, default 200;
//      trackers: CCT_PRUNE_MAX_RL, default 200), delete the oldest until at most MAX remain -
//      a hard cap so the dir can never grow without bound (every render scans the tracker pool).
//      Deleting a live tracker is safe: its session is re-sighted with its last-call time (or
//      its transcript's last response time on older Claude Code), or with an unknown time that
//      ranks lowest, never with a fresh one.
// The cost is one readdir + lstat per file; bounded by the cap and only paid on a reader
// call. We NEVER touch files we did not create (only the telemetry-raw- / telemetry-rl2- /
// legacy telemetry-rl-
// prefixes, not the legacy telemetry- file the consumer may stub, not the user's files).
const DEFAULT_PRUNE_AGE_SEC = 24 * 60 * 60; // 1 day
const DEFAULT_PRUNE_MAX_FILES = 200;
const DEFAULT_PRUNE_MAX_RL = 200;

// True when a tracker line "TS5|5U|5R|TS7|7U|7R" holds at least one plausible reset epoch and
// every one it holds is at or before nowSec (so the line can never be picked again). null when
// it holds no plausible epoch at all (unparseable: the caller falls back to the age rule).
// Plausible = 1e9 <= v < 1e11 and no more than 8 days ahead (the picker 7d horizon): a reset
// further out is corrupt, can never be picked, and must not keep the file alive until then.
// Reads at most 256 bytes; a tracker line is far shorter.
function trackerExpired(p, nowSec) {
  let buf;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      buf = buf.slice(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (e) { return null; }
  const f = buf.split(/\r?\n/)[0].split('|');
  if (f.length < 6) return null;
  const resets = [f[2], f[5]].filter(function (v) { return /^[0-9]+$/.test(v); })
    .map(Number).filter(function (v) { return v >= 1e9 && v < 1e11 && v <= nowSec + 691200; });
  if (resets.length === 0) return null;
  return resets.every(function (v) { return v <= nowSec; });
}

function posIntEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  return (isFinite(n) && n > 0) ? n : def;
}

// Cross-process throttle so prune runs at most once per CCT_PRUNE_EVERY_SEC even
// though every hook is a fresh Node process (an in-process flag would never help).
// We touch a sentinel file and skip the prune if it was touched recently. Best-effort
// (a failed stat/touch just means we prune this call). force=true bypasses (tests).
const DEFAULT_PRUNE_EVERY_SEC = 60 * 60; // at most once per hour

function pruneThrottled(force) {
  try {
    if (force) { pruneRaw(); return; }
    const everySec = posIntEnv('CCT_PRUNE_EVERY_SEC', DEFAULT_PRUNE_EVERY_SEC);
    const dir = telemetryDir();
    const sentinel = path.join(dir, '.cct-prune-stamp');
    let due = true;
    try {
      const st = fs.statSync(sentinel);
      if ((Date.now() - st.mtimeMs) / 1000 < everySec) due = false;
    } catch (e) { /* no sentinel yet -> due */ }
    if (!due) return;
    // Touch the sentinel BEFORE pruning so concurrent readers do not all prune at once.
    try { fs.writeFileSync(sentinel, ''); } catch (e) {}
    pruneRaw();
  } catch (e) { /* best-effort */ }
}

// Rule 2 helper: hard count cap. Delete the OLDEST surviving files in a pool beyond MAX.
function capPool(live, maxFiles) {
  if (live.length > maxFiles) {
    live.sort(function (a, b) { return a.mtimeMs - b.mtimeMs; }); // oldest first
    const toDelete = live.length - maxFiles;
    for (let i = 0; i < toDelete; i++) {
      try { fs.unlinkSync(live[i].path); } catch (e) {}
    }
  }
}

function pruneRaw() {
  try {
    const dir = telemetryDir();
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    const ageSec = posIntEnv('CCT_PRUNE_AGE_SEC', DEFAULT_PRUNE_AGE_SEC);
    const maxFiles = posIntEnv('CCT_PRUNE_MAX_FILES', DEFAULT_PRUNE_MAX_FILES);
    const maxRl = posIntEnv('CCT_PRUNE_MAX_RL', DEFAULT_PRUNE_MAX_RL);
    const now = Date.now();
    const cutoff = now - ageSec * 1000;
    const liveRaw = []; // { path, mtimeMs } for raw files that survive the age rule
    const liveRl = [];  // same, for the rate-limit tracker files (telemetry-rl2-*)
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      // Reclaim a stale atomic-write temp left by a crash BETWEEN write and mv (the shell
      // removes its own temp on a normal mv-failure, so this only catches a hard crash
      // mid-write). The temps are ".telemetry-raw-<sid>.<pid>.tmp" and
      // ".telemetry-rl2-<sid>.<pid>.tmp" (leading dot; also the pre-1.4.8 ".telemetry-rl-"). Only
      // OUR temps, only when old, so a
      // temp from an in-flight write is never touched.
      if ((name.indexOf('.telemetry-raw-') === 0 || name.indexOf('.telemetry-rl-') === 0
           || name.indexOf('.telemetry-rl2-') === 0)
          && name.slice(-4) === '.tmp') {
        const tp = path.join(dir, name);
        try {
          const tst = fs.lstatSync(tp);
          if (tst.isFile() && tst.mtimeMs < cutoff) fs.unlinkSync(tp);
        } catch (e) {}
        continue;
      }
      // ONLY our own state files for the main rules: raw payloads (telemetry-raw-*.json) and
      // rate-limit trackers (telemetry-rl2-<id>, the id sanitized to [A-Za-z0-9_-] exactly as the
      // writer does, so a stray "telemetry-rl2-x.bak" is not ours). A pre-1.4.8 tracker
      // (telemetry-rl-<id>) is never read again, so it is simply deleted.
      let live, legacy = false;
      if (name.indexOf('telemetry-raw-') === 0 && name.slice(-5) === '.json') live = liveRaw;
      else if (/^telemetry-rl2-[A-Za-z0-9_-]+$/.test(name)) live = liveRl;
      else if (/^telemetry-rl-[A-Za-z0-9_-]+$/.test(name)) legacy = true;
      else continue;
      const p = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(p); } catch (e) { continue; }
      if (!st.isFile()) continue;
      if (legacy) { try { fs.unlinkSync(p); } catch (e) {} continue; }
      // Rule 1b: a tracker goes when all its boundaries have elapsed, never by age alone.
      if (live === liveRl) {
        const exp = trackerExpired(p, Math.floor(now / 1000));
        if (exp === true) { try { fs.unlinkSync(p); } catch (e) {} continue; }
        if (exp === false) { live.push({ path: p, mtimeMs: st.mtimeMs }); continue; }
      }
      // Rule 1: too old -> delete now. Treat far-future mtimes as live (do not delete
      // a file whose clock is ahead; the count cap will still bound the dir).
      if (st.mtimeMs < cutoff) {
        try { fs.unlinkSync(p); } catch (e) {}
        continue;
      }
      live.push({ path: p, mtimeMs: st.mtimeMs });
    }
    // Rule 2: hard count cap, applied to each pool independently.
    capPool(liveRaw, maxFiles);
    capPool(liveRl, maxRl);
  } catch (e) { /* hygiene is best-effort; never affect the reader */ }
}

// Default freshness window in seconds. Override via env CCT_TTL_SEC or opts.ttlSec.
const DEFAULT_TTL_SEC = 120;

// Resolve the freshness TTL. An override (opts.ttlSec or env CCT_TTL_SEC) is
// honored ONLY when it is a finite number strictly greater than 0; "" (-> 0),
// 0, negatives, and NaN all fall back to the default so freshness is never
// silently disabled by a blank or bad value.
function ttlFrom(opts) {
  if (opts && opts.ttlSec != null && opts.ttlSec !== '') {
    const o = Number(opts.ttlSec);
    if (isFinite(o) && o > 0) return o;
  }
  if (process.env.CCT_TTL_SEC != null && process.env.CCT_TTL_SEC !== '') {
    const env = Number(process.env.CCT_TTL_SEC);
    if (isFinite(env) && env > 0) return env;
  }
  return DEFAULT_TTL_SEC;
}

// Write a raw telemetry object for a session. Best-effort, never throws. The
// wrapper uses this; exported so a consumer can stub telemetry in tests.
function writeTelemetry(sessionId, obj) {
  ensureDir();
  try {
    fs.writeFileSync(telemetryPath(sessionId), JSON.stringify(obj));
    return true;
  } catch (e) { return false; }
}

// Parse a RAW Claude Code statusline payload object into the normalized telemetry
// shape (without freshness, which depends on the source's age). This is the
// authoritative field mapping, on the consumer side (the shell entry does NO
// parsing). No per-model / per-plan / per-window assumptions: every field is read
// straight from the payload; absent fields are omitted/null, never fabricated.
//   - context_window.used_percentage / context_window_size: computed by Claude Code
//     for the active model+plan. used_percentage is null before the first API
//     response and right after a compaction; never coerce a missing field to 0.
//   - rate_limits is Pro/Max OAuth ONLY (omitted for API-key / Bedrock / Vertex).
// Returns null when the payload is not a usable object.
function parsePayload(d, sessionId) {
  if (!d || typeof d !== 'object') return null;
  const cw = (d.context_window && typeof d.context_window === 'object') ? d.context_window : {};
  const contextPct = (typeof cw.used_percentage === 'number') ? cw.used_percentage : null;
  const windowSize = (typeof cw.context_window_size === 'number') ? cw.context_window_size : null;
  const rl = (d.rate_limits && typeof d.rate_limits === 'object') ? d.rate_limits : null;
  const fiveH = (rl && rl.five_hour && typeof rl.five_hour.used_percentage === 'number')
    ? rl.five_hour.used_percentage : undefined;
  const sevenD = (rl && rl.seven_day && typeof rl.seven_day.used_percentage === 'number')
    ? rl.seven_day.used_percentage : undefined;
  // resets_at: the Unix epoch (seconds) when each window next resets, surfaced for hooks.
  // Accepted ONLY when it is a PLAUSIBLE seconds-epoch: >= 1e9 (year 2001) and < 1e11
  // (year ~5138). This mirrors the shell renderer's own epoch floor (bin/cct-statusline),
  // so the two consumers of this one field agree, and it stops a corrupt or hostile raw
  // file from handing a hook a bogus reset time (negative, 0, small ints, absurd
  // far-future) or NaN/Infinity (which fail the range compare). Omitted (undefined) when
  // the window/field is absent or implausible. Not clock-relative: a consumer computes
  // time-left as resets_at - Date.now() / 1000 and treats a past or implausible value as
  // stale (Claude Code refreshes rate_limits only on an API call).
  const fiveHReset = (rl && rl.five_hour && typeof rl.five_hour.resets_at === 'number'
    && rl.five_hour.resets_at >= 1e9 && rl.five_hour.resets_at < 1e11)
    ? rl.five_hour.resets_at : undefined;
  const sevenDReset = (rl && rl.seven_day && typeof rl.seven_day.resets_at === 'number'
    && rl.seven_day.resets_at >= 1e9 && rl.seven_day.resets_at < 1e11)
    ? rl.seven_day.resets_at : undefined;
  const model = (d.model && typeof d.model.id === 'string') ? d.model.id : null;
  const sid = (typeof d.session_id === 'string' && d.session_id)
    ? d.session_id : (sessionId || 'default');
  return {
    sessionId: sid,
    contextPct: contextPct,
    usedPercentage: contextPct,
    windowSize: windowSize,
    fiveHourPct: fiveH,
    sevenDayPct: sevenD,
    fiveHourResetsAt: fiveHReset,
    sevenDayResetsAt: sevenDReset,
    model: model,
    source: 'statusline',
  };
}

// Read the latest telemetry reading for a session. Reads the RAW statusline payload
// the shell entry wrote, parses it ON DEMAND, and returns a normalized object or
// null when absent / unreadable. NEVER throws.
//
//   {
//     sessionId, contextPct, usedPercentage, windowSize,
//     fiveHourPct?, sevenDayPct?, fiveHourResetsAt?, sevenDayResetsAt?,
//     model, ts, source, fresh
//   }
//
// Freshness comes from the raw file's modification time (the pure-shell entry writes
// no timestamp into the payload). `fresh` is true only when contextPct is a finite
// number AND the file's mtime is within the TTL, rejecting BOTH stale and far-future
// times (Math.abs of the age). `ts` is the raw file's mtime as ISO, for visibility.
//
// Backward compatibility: if no raw file exists but a legacy parsed telemetry file
// (telemetry-<session>.json with context_pct/ts) does, fall back to reading that, so
// a consumer that stubs telemetry via writeTelemetry still works.
function readTelemetry(sessionId, opts) {
  const ttl = ttlFrom(opts);

  // Off-hot-path raw-file hygiene: prune stale/excess raw files at most once per
  // interval (cross-process throttled). Best-effort, never throws, runs before the
  // read so a unique-id flood is bounded even if every read targets a new id.
  pruneThrottled(false);

  // Preferred path: the raw statusline payload written by the shell entry.
  let rawStat;
  try { rawStat = fs.statSync(rawPath(sessionId)); } catch (e) { rawStat = null; }
  if (rawStat) {
    let raw;
    try { raw = fs.readFileSync(rawPath(sessionId), 'utf8'); } catch (e) { raw = null; }
    if (raw != null) {
      let d;
      try { d = JSON.parse(raw); } catch (e) { d = null; }
      const parsed = parsePayload(d, sessionId);
      if (parsed) {
        const ageSec = (Date.now() - rawStat.mtimeMs) / 1000;
        const fresh = (typeof parsed.contextPct === 'number' && isFinite(parsed.contextPct))
          ? (Math.abs(ageSec) <= ttl) : false;
        let ts = null;
        try { ts = new Date(rawStat.mtimeMs).toISOString(); } catch (e) { ts = null; }
        parsed.ts = ts;
        parsed.fresh = fresh;
        return parsed;
      }
      // Raw file present but unparseable: return null (do not silently fall through
      // to a stale legacy file, which would mask a live-but-corrupt reading).
      return null;
    }
    return null;
  }

  // Legacy fallback: a parsed telemetry file written via writeTelemetry (carries its
  // own ts). Kept so existing consumers/stubs that use writeTelemetry keep working.
  let lraw;
  try { lraw = fs.readFileSync(telemetryPath(sessionId), 'utf8'); } catch (e) { return null; }
  let d;
  try { d = JSON.parse(lraw); } catch (e) { return null; }
  if (!d || typeof d !== 'object') return null;
  const contextPct = (typeof d.context_pct === 'number') ? d.context_pct : null;
  let fresh = false;
  if (typeof contextPct === 'number' && isFinite(contextPct) && typeof d.ts === 'string') {
    const t = Date.parse(d.ts);
    if (isFinite(t)) fresh = Math.abs((Date.now() - t) / 1000) <= ttl;
  }
  return {
    sessionId: (typeof d.session_id === 'string') ? d.session_id : (sessionId || 'default'),
    contextPct: contextPct,
    usedPercentage: (typeof d.used_percentage === 'number') ? d.used_percentage : contextPct,
    windowSize: (typeof d.context_window_size === 'number') ? d.context_window_size : null,
    fiveHourPct: (typeof d.five_hour_pct === 'number') ? d.five_hour_pct : undefined,
    sevenDayPct: (typeof d.seven_day_pct === 'number') ? d.seven_day_pct : undefined,
    model: (typeof d.model === 'string') ? d.model : null,
    ts: (typeof d.ts === 'string') ? d.ts : null,
    source: (typeof d.source === 'string') ? d.source : null,
    fresh: fresh,
  };
}

module.exports = {
  readTelemetry,
  parsePayload,
  writeTelemetry,
  telemetryDir,
  telemetryPath,
  rawPath,
  ensureDir,
  pruneRaw,
  pruneThrottled,
  nowIso,
  DEFAULT_TTL_SEC,
};
