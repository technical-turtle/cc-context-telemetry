'use strict';
// Bounded test runner for cc-context-telemetry (PURE-SHELL entry + on-demand reader).
// Every test uses a temp CCT_DIR so the real telemetry dir is never touched. Nothing
// here calls `claude` or scans a binary; spawned children are tiny inline node/sh
// stubs, all bounded by short timeouts and cleaned up (no leaked processes).
//
// ARCHITECTURE UNDER TEST:
//   bin/cct-statusline  - PURE SHELL. Per render: reads stdin, extracts+sanitizes the
//                         session_id, ATOMICALLY writes the RAW payload to
//                         telemetry-raw-<sid>.json, then EITHER execs CCT_WRAP OR
//                         prints a minimal shell-extracted bar. NO Node on this path.
//   index.js            - readTelemetry(sid): reads + parses the raw file ON DEMAND,
//                         prunes stale/excess raw files (throttled, off the hot path).
//   bin/telemetry.js    - on-demand CLI READER over readTelemetry (NOT in hot path).
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'bin', 'cct-statusline');   // the pure-shell entry
const READER = path.join(ROOT, 'bin', 'telemetry.js');    // the on-demand CLI reader

// Cross-platform shell resolution. POSIX: /bin/sh. Windows: rely on Git-Bash `sh`
// on PATH (the Windows CI job runs under `shell: bash`, which puts sh/awk/sed/printf
// there). The pure-shell entry itself is POSIX and is exercised through this SH.
const IS_WIN = process.platform === 'win32';
const SH = IS_WIN ? 'sh' : '/bin/sh';

let pass = 0, fail = 0, skip = 0;
function test(name, fn) {
  // A test that calls skipTest() from inside counts as a SKIP only, never also as a pass.
  const skipsBefore = skip;
  try { fn(); if (skip === skipsBefore) { pass++; console.log('ok   - ' + name); } }
  catch (e) { fail++; console.log('FAIL - ' + name + '\n       ' + (e && e.message)); }
}
// A test that genuinely cannot hold on THIS platform (e.g. a Unix-process-model
// assertion on Windows). Counted and printed VISIBLY so a skip never reads as a pass
// and never silently vanishes from the totals.
function skipTest(name, reason) { skip++; console.log('skip - ' + name + ' (' + reason + ')'); }
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cct-test-')); }

// Run the shell ENTRY with a stub payload on stdin (which CLOSES, as Claude Code
// does) and the given env. Bounded by a short timeout.
function runEntry(payload, env) {
  return spawnSync(SH, [ENTRY], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, env),
  });
}
// Run the on-demand CLI reader.
function runReader(args, env, input) {
  return spawnSync(process.execPath, [READER].concat(args || []), {
    input: input,
    encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, env),
  });
}
// Read the RAW per-session payload file the entry wrote.
function rawFile(dir, sid) {
  return fs.readFileSync(path.join(dir, 'telemetry-raw-' + sid + '.json'), 'utf8');
}
const api = require('../index.js');

// ============================================================================
// (1) RAW WRITE: the entry writes telemetry-raw-<sid>.json verbatim, atomically
// ============================================================================

test('entry writes the RAW payload verbatim to telemetry-raw-<sid>.json', function () {
  const dir = tmpDir();
  const payload = '{"session_id":"s-raw","context_window":{"used_percentage":47.2,"context_window_size":200000},"extra":"keep me"}';
  const r = runEntry(payload, { CCT_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(rawFile(dir, 's-raw'), payload, 'raw file is byte-identical to stdin');
});

test('atomic write leaves NO leftover .tmp files in the dir', function () {
  const dir = tmpDir();
  runEntry('{"session_id":"s-tmp","context_window":{"used_percentage":1}}', { CCT_DIR: dir });
  const files = fs.readdirSync(dir);
  assert.ok(files.every(function (f) { return f.slice(-4) !== '.tmp'; }),
    'no .tmp litter: ' + JSON.stringify(files));
  // The raw payload, plus the empty marker tracker a session with no rate_limits gets.
  assert.deepStrictEqual(files.sort(), ['telemetry-raw-s-tmp.json', 'telemetry-rl2-s-tmp']);
});

// ============================================================================
// (2) ON-DEMAND PARSE round-trip across payload shapes (full / null / missing /
//     malformed) via the entry + index.js readTelemetry
// ============================================================================

test('round-trip FULL Pro/Max payload (rate_limits + 200k window)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-pro', context_window: { used_percentage: 47.2, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: 1783359600 },
      seven_day: { used_percentage: 30, resets_at: 1783368000 } },
    model: { id: 'claude-opus-4-1' } }, { CCT_DIR: dir });
  const t = api.readTelemetry('s-pro');
  assert.ok(t);
  assert.strictEqual(t.contextPct, 47.2);
  assert.strictEqual(t.usedPercentage, 47.2);
  assert.strictEqual(t.windowSize, 200000);
  assert.strictEqual(t.fiveHourPct, 12);
  assert.strictEqual(t.sevenDayPct, 30);
  assert.strictEqual(t.fiveHourResetsAt, 1783359600, 'reset epoch surfaced for hooks');
  assert.strictEqual(t.sevenDayResetsAt, 1783368000);
  assert.strictEqual(t.model, 'claude-opus-4-1');
  assert.strictEqual(t.source, 'statusline');
  assert.strictEqual(t.fresh, true, 'a just-written raw file is fresh');
  delete process.env.CCT_DIR;
});

// ============================================================================
// (2b) RESET EPOCHS in the consumer API: readTelemetry/parsePayload surface
// fiveHourResetsAt / sevenDayResetsAt (Unix epoch), verbatim passthrough, omitted
// when absent - exactly like the percentages. For hooks that gate on reset timing.
// ============================================================================

test('parsePayload surfaces fiveHourResetsAt / sevenDayResetsAt verbatim', function () {
  const p = api.parsePayload({ session_id: 's', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: 1783359600 },
      seven_day: { used_percentage: 30, resets_at: 1783368000 } } }, 's');
  assert.strictEqual(p.fiveHourResetsAt, 1783359600);
  assert.strictEqual(p.sevenDayResetsAt, 1783368000);
});

test('reset epochs OMITTED (undefined) when resets_at absent, like the percentages', function () {
  const p = api.parsePayload({ session_id: 's', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 30 } } }, 's');
  assert.strictEqual(p.fiveHourResetsAt, undefined);
  assert.strictEqual(p.sevenDayResetsAt, undefined);
  assert.strictEqual('fiveHourResetsAt' in p, true, 'key present with undefined value, like fiveHourPct');
});

test('reset epochs OMITTED when NO rate_limits at all (API-key / Bedrock / Vertex)', function () {
  const p = api.parsePayload({ session_id: 's', context_window: { used_percentage: 60 } }, 's');
  assert.strictEqual(p.fiveHourResetsAt, undefined);
  assert.strictEqual(p.sevenDayResetsAt, undefined);
});

test('reset epoch surfaced per-window independently (5h has it, 7d does not)', function () {
  const p = api.parsePayload({ session_id: 's', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: 1783359600 },
      seven_day: { used_percentage: 30 } } }, 's');
  assert.strictEqual(p.fiveHourResetsAt, 1783359600);
  assert.strictEqual(p.sevenDayResetsAt, undefined);
});

test('non-numeric resets_at (string / null) -> undefined, never a bogus value', function () {
  const pStr = api.parsePayload({ session_id: 's', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: '1783359600' } } }, 's');
  assert.strictEqual(pStr.fiveHourResetsAt, undefined, 'string resets_at rejected (typeof check)');
  const pNull = api.parsePayload({ session_id: 's', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: null } } }, 's');
  assert.strictEqual(pNull.fiveHourResetsAt, undefined, 'null resets_at rejected');
});

// Plausible-epoch guard: the Node reader must agree with the shell renderer, which
// floors resets_at at a real Unix epoch. A corrupt/hostile raw file must never hand a hook
// a bogus reset time (negative, 0, sub-epoch, absurd far-future) or NaN/Infinity.
test('reset epoch: implausible values rejected, matching the shell renderer', function () {
  const mk = function (r) {
    return api.parsePayload({ session_id: 's', context_window: { used_percentage: 5 },
      rate_limits: { five_hour: { used_percentage: 12, resets_at: r } } }, 's').fiveHourResetsAt;
  };
  assert.strictEqual(mk(-5), undefined, 'negative');
  assert.strictEqual(mk(0), undefined, 'zero');
  assert.strictEqual(mk(12345), undefined, 'below the 1e9 epoch floor');
  assert.strictEqual(mk(999999999), undefined, 'just below 1e9');
  assert.strictEqual(mk(1e15), undefined, 'absurd far-future (the devil-repro 1e15)');
  assert.strictEqual(mk(NaN), undefined, 'NaN fails the range compare');
  assert.strictEqual(mk(Infinity), undefined, 'Infinity fails the range compare');
  assert.strictEqual(mk(1000000000), 1000000000, 'exactly 1e9 accepted (boundary)');
  assert.strictEqual(mk(1783359600), 1783359600, 'a real epoch accepted');
});

// ============================================================================
// (3c) ACCOUNT-WIDE rate limits. rate_limits change ONLY when a session makes an API call,
// so a session that has not called recently keeps reporting its OLD reading (even after a
// limit RESET, when usage has actually dropped). Every session writes its current reading to
// a tracker file (telemetry-rl2-<sid>, single line "TS5|5U|5R|TS7|7U|7R", each TS being the
// local time at which that window's pair last CHANGED, kept while the pair is unchanged), and
// the segment ranks the pool per window independently, 5h and 7d by the same rule:
//   (resets_at DESC, then change-TS DESC)
// over readings that have a usage, a plausible resets_at inside (now, now+cap] and a change-TS
// no later than now+60. Usage percentages are NEVER compared: after a mid-window quota reset
// (96% -> 24% on the same boundary) the newer, LOWER reading is the right one. An exact
// change-TS tie keeps the first file in glob order. ctx + model stay per-session.
// Deterministic via CCT_NOW + tracker files.
// ============================================================================

const AW_NOW = 1700000000;
// Pre-seed another session's rate-limit tracker line: "TS5|5U|5R|TS7|7U|7R".
function writeRl(dir, sid, line) {
  fs.writeFileSync(path.join(dir, 'telemetry-rl2-' + sid), line);
}
function rlFile(dir, sid) { return fs.readFileSync(path.join(dir, 'telemetry-rl2-' + sid), 'utf8'); }
// Note: some hand-made fixtures below leave the TS of an EMPTY window pair blank ("TS|5U|5R|||",
// "|||TS7|7U|7R"). The writer always fills both stamps; the picker never reads the stamp of an
// empty pair, so these lines rank exactly as the writer-shaped equivalents.
// Render `current` (this session's payload) in a dir seeded with `trackers` (other
// sessions' rl files: { sid, line }). nowVal pins CCT_NOW (default AW_NOW; pass a string
// like 'garbage' to exercise an invalid now).
function awBar(current, trackers, nowVal) {
  const dir = tmpDir();
  (trackers || []).forEach(function (s) { writeRl(dir, s.sid, s.line); });
  return runEntry(current, { CCT_DIR: dir, CCT_NOW: nowVal === undefined ? String(AW_NOW) : nowVal }).stdout;
}
// A ctx-only payload (no rate_limits): THIS session writes only an empty marker tracker, which
// carries no reading, so the picker sees only the pre-seeded trackers.
function ctxOnly(pct) { return { session_id: 'C', context_window: { used_percentage: pct } }; }

test('account-wide 7d (the 24-vs-96 boundary): same resets_at, the NEWER change-TS wins whether its usage is lower or higher', function () {
  // Same 7d boundary = same window, so the reading that CHANGED most recently is the latest
  // measurement. Usage is never compared: a newer 24% beats an older 96% (a mid-window reset),
  // and a newer 96% beats an older 24% (normal growth). Fails if the picker ranked by usage.
  const R7 = AW_NOW + 3 * 86400;
  assert.strictEqual(awBar(ctxOnly(33),
    [ { sid: 'OLD', line: '|||1000|96|' + R7 },
      { sid: 'NEW', line: '|||2000|24|' + R7 } ]),
    'ctx 33% | 7d 24% ~3d', 'newer change-TS (24) beats an older, higher reading (96)');
  assert.strictEqual(awBar(ctxOnly(33),
    [ { sid: 'OLD', line: '|||1000|24|' + R7 },
      { sid: 'NEW', line: '|||2000|96|' + R7 } ]),
    'ctx 33% | 7d 96% ~3d', 'newer change-TS (96) beats an older, lower reading (24)');
});

test('account-wide 5h (the 24-vs-96 boundary): same resets_at, the NEWER change-TS wins whether its usage is lower or higher', function () {
  // The 5h window follows the same rule as the 7d one: a mid-window 5h reset makes the newer
  // reading the lower one, and it must win.
  const R = AW_NOW + 3600;
  assert.strictEqual(awBar(ctxOnly(33),
    [ { sid: 'OLD', line: '1000|96|' + R + '|||' },
      { sid: 'NEW', line: '2000|24|' + R + '|||' } ]),
    'ctx 33% | 5h 24% ~1h', 'newer change-TS (24) beats an older, higher reading (96)');
  assert.strictEqual(awBar(ctxOnly(33),
    [ { sid: 'OLD', line: '1000|24|' + R + '|||' },
      { sid: 'NEW', line: '2000|96|' + R + '|||' } ]),
    'ctx 33% | 5h 96% ~1h', 'newer change-TS (96) beats an older, lower reading (24)');
});

test('account-wide 7d MID-WINDOW RESET: an idle 96% changed long ago loses to an active 24% changed recently (same boundary, either filename order)', function () {
  // The 2026-09-05 shape: a quota reset drops usage without moving resets_at. The idle session
  // keeps its pre-reset reading and its old change-TS; the active one has recorded the
  // post-reset value since. Both filename orders, so glob order cannot be what decides.
  const R7 = AW_NOW + 2 * 86400;
  [['A', 'B'], ['B', 'A']].forEach(function (n) {
    const dir = tmpDir();
    writeRl(dir, n[0] + 'IDLE', (AW_NOW - 90000) + '|10|' + (AW_NOW - 80000) + '|' + (AW_NOW - 90000) + '|96|' + R7);
    writeRl(dir, n[1] + 'ACTIVE', (AW_NOW - 120) + '|4|' + (AW_NOW + 9000) + '|' + (AW_NOW - 120) + '|24|' + R7);
    assert.strictEqual(runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
      'ctx 33% | 5h 4% ~2h30m | 7d 24% ~2d', 'post-reset 24% wins (order ' + n.join(',') + ')');
  });
});

test('account-wide 5h MID-WINDOW RESET: an idle 96% changed long ago loses to an active 24% changed recently (same boundary, either filename order)', function () {
  const R5 = AW_NOW + 3600;
  [['A', 'B'], ['B', 'A']].forEach(function (n) {
    const dir = tmpDir();
    writeRl(dir, n[0] + 'IDLE', (AW_NOW - 9000) + '|96|' + R5 + '|||');
    writeRl(dir, n[1] + 'ACTIVE', (AW_NOW - 60) + '|24|' + R5 + '|||');
    assert.strictEqual(runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
      'ctx 33% | 5h 24% ~1h', 'post-reset 24% wins (order ' + n.join(',') + ')');
  });
});

test('account-wide: the NEWEST boundary beats a NEWER change-TS on an older boundary (5h and 7d, either filename order)', function () {
  // A real window reset advances resets_at. A session still frozen on the previous, still-future
  // boundary may have changed more recently than the session that first saw the new boundary;
  // the boundary decides first, so that newer stamp cannot promote the old window.
  [['A', 'B'], ['B', 'A']].forEach(function (n) {
    const dir = tmpDir();
    writeRl(dir, n[0] + 'NEWBOUND', (AW_NOW - 9000) + '|2|' + (AW_NOW + 3600) + '|' + (AW_NOW - 9000) + '|3|' + (AW_NOW + 6 * 86400));
    writeRl(dir, n[1] + 'OLDBOUND', (AW_NOW - 10) + '|90|' + (AW_NOW + 1800) + '|' + (AW_NOW - 10) + '|96|' + (AW_NOW + 2 * 86400));
    assert.strictEqual(runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
      'ctx 33% | 5h 2% ~1h | 7d 3% ~6d', 'newest boundary wins in both windows (order ' + n.join(',') + ')');
  });
});

test('account-wide: an ELAPSED boundary is excluded even with the newest change-TS (a re-rendered ancient payload)', function () {
  // A resumed session can re-render a payload from before the last reset; its tracker then
  // carries the NEWEST change-TS on a boundary that has already passed. It must never be picked,
  // and "~now" must never show.
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 2 * 86400;
  let dir = tmpDir();
  writeRl(dir, 'ANCIENT', AW_NOW + '|70|' + (AW_NOW - 50) + '|' + AW_NOW + '|90|' + (AW_NOW - 100));
  assert.strictEqual(runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 33%', 'alone in the pool: both elapsed windows omitted, never "~now"');
  // Through the writer: the tracked session OLD last showed different numbers 10s ago, then
  // renders the ancient payload NOW. Both pairs changed, so its tracker is stamped now (the
  // newest change-TS in the pool).
  dir = tmpDir();
  const ancient = { session_id: 'OLD', context_window: { used_percentage: 33 },
    rate_limits: { five_hour: { used_percentage: 70, resets_at: AW_NOW - 50 },
      seven_day: { used_percentage: 90, resets_at: AW_NOW - 100 } } };
  runEntry({ session_id: 'OLD', context_window: { used_percentage: 33 },
    rate_limits: { five_hour: { used_percentage: 69, resets_at: AW_NOW - 50 },
      seven_day: { used_percentage: 89, resets_at: AW_NOW - 100 } } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 10) });
  assert.strictEqual(runEntry(ancient, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 33% | 5h 70% | 7d 90%', 'alone: own-usage fallback with no countdown, never "~now"');
  assert.strictEqual(rlFile(dir, 'OLD'), AW_NOW + '|70|' + (AW_NOW - 50) + '|' + AW_NOW + '|90|' + (AW_NOW - 100),
    'the ancient reading carries the newest change-TS');
  writeRl(dir, 'LIVE', (AW_NOW - 5000) + '|10|' + R5 + '|' + (AW_NOW - 5000) + '|40|' + R7);
  assert.strictEqual(runEntry(ancient, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 33% | 5h 10% ~1h | 7d 40% ~2d', 'the older-stamped live reading on a future boundary wins');
});

test('account-wide: a change-TS past now+60 is dropped even as the newest; exactly now+60 is accepted and wins (5h and 7d)', function () {
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 3 * 86400;
  const dir = tmpDir();
  writeRl(dir, 'FAIR', (AW_NOW - 100) + '|20|' + R5 + '|' + (AW_NOW - 100) + '|30|' + R7);
  writeRl(dir, 'SKEW', (AW_NOW + 61) + '|80|' + R5 + '|' + (AW_NOW + 61) + '|90|' + R7);
  assert.strictEqual(runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 33% | 5h 20% ~1h | 7d 30% ~3d', 'TS == now+61 dropped (corrupt tracker or clock jump)');
  writeRl(dir, 'SKEW', (AW_NOW + 60) + '|80|' + R5 + '|' + (AW_NOW + 60) + '|90|' + R7);
  assert.strictEqual(runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 33% | 5h 80% ~1h | 7d 90% ~3d', 'TS == now+60 accepted, and as the newest it wins');
});

test('account-wide: an exact change-TS tie on one boundary keeps the FIRST file in glob order (5h and 7d, values swapped)', function () {
  // Two different values changing in the same second is the only case this decides. It must be
  // deterministic: the first file read wins, so swapping the two values swaps the result. Fails
  // if the comparison were ">=" (last file read wins).
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 3 * 86400, T = AW_NOW - 100;
  [[30, 70], [70, 30]].forEach(function (v) {
    const dir = tmpDir();
    writeRl(dir, 'A1', T + '|' + v[0] + '|' + R5 + '|' + T + '|' + (v[0] + 1) + '|' + R7);
    writeRl(dir, 'B1', T + '|' + v[1] + '|' + R5 + '|' + T + '|' + (v[1] + 1) + '|' + R7);
    assert.strictEqual(runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
      'ctx 33% | 5h ' + v[0] + '% ~1h | 7d ' + (v[0] + 1) + '% ~3d', 'first file (A1) wins the tie with ' + v[0]);
  });
});


test('account-wide 7d reset (elapsed-exclusion guard): a pre-reset HIGH whose boundary elapsed is dropped, so the post-reset low on the new future boundary wins', function () {
  // A real 7d reset advances resets_at by 7d; the old window boundary elapses (r <= now) and is
  // excluded, so last week's stale 90% can never override this week's fresh 5%, although it has
  // the newer change-TS. The newer boundary would rank first anyway, so the lone-elapsed tests
  // (all past-reset trackers excluded, the ancient re-render) are what guard the exclusion.
  const out = awBar(ctxOnly(33),
    [ { sid: 'LASTWEEK', line: '|||9000|90|' + (AW_NOW - 100) },        // pre-reset high, boundary just elapsed
      { sid: 'THISWEEK', line: '|||1000|5|' + (AW_NOW + 6 * 86400) } ]); // post-reset low, new future boundary
  assert.strictEqual(out, 'ctx 33% | 7d 5% ~6d', 'post-reset low (5) wins; elapsed pre-reset high (90) excluded');
});

test('account-wide: a FUTURE / huge change TS is rejected (corrupt tracker or clock jump cannot pin the pick)', function () {
  const R = AW_NOW + 3600;
  const out = awBar(ctxOnly(40),
    [ { sid: 'B', line: '2000|5|' + R + '|||' },              // legit past change, low usage
      { sid: 'X', line: '99999999999|95|' + R + '|||' } ]);   // absurd future TS, high usage
  assert.strictEqual(out, 'ctx 40% | 5h 5% ~1h', 'future-TS tracker excluded; the legit past-change reading wins');
});

test('account-wide: a far-future resets_at is rejected even with the newest TS + highest usage', function () {
  const out = awBar(
    { session_id: 'C', context_window: { used_percentage: 33 },
      rate_limits: { five_hour: { used_percentage: 20, resets_at: AW_NOW + 3600 } } },
    [ { sid: 'X', line: '9999999999|99|' + (AW_NOW + 5 * 86400) + '|||' } ]);
  assert.strictEqual(out, 'ctx 33% | 5h 20% ~1h', 'far-future 5h reset (5d) rejected; this session (20%) wins');
});

test('account-wide: trackers whose reset already ELAPSED are excluded as stale (no ~now)', function () {
  // Both trackers report a reset in the PAST -> their window has since reset -> stale, so
  // NEITHER can win (even the newest-TS one). This session has no rate_limits, so 5h is
  // simply omitted. A stale past-reset reading must never surface, and ~now must never show.
  const out = awBar(ctxOnly(33),
    [ { sid: 'A', line: '1000|80|' + (AW_NOW - 3600) + '|||' },
      { sid: 'B', line: '2000|60|' + (AW_NOW - 7200) + '|||' } ]);
  assert.strictEqual(out, 'ctx 33%', 'all past-reset trackers excluded; 5h omitted, never ~now');
});

test('account-wide: a past-reset tracker loses to a FUTURE-reset one even with a newer TS', function () {
  // A: newest change but its reset already elapsed (stale). B: older change but a valid
  // future reset. B must win - a future boundary beats a fresher-but-stale reading.
  const out = awBar(ctxOnly(33),
    [ { sid: 'A', line: '9000|80|' + (AW_NOW - 3600) + '|||' },      // newest TS, PAST reset
      { sid: 'B', line: '2000|12|' + (AW_NOW + 3600) + '|||' } ]);   // older TS, FUTURE reset
  assert.strictEqual(out, 'ctx 33% | 5h 12% ~1h', 'valid future-reset reading (B) wins over stale past-reset (A)');
});

// --- Full state-matrix pins (each row of the tracker/reset/window space) ---

test('matrix: MIXED windows - 5h elapsed (idle case) falls back w/o countdown, 7d still valid shows one', function () {
  // The 5h boundary passes routinely between API calls; that must NOT degrade the 7d field.
  const dir = tmpDir();
  writeRl(dir, 'A', (AW_NOW - 600) + '|40|' + (AW_NOW - 100) + '|' + (AW_NOW - 600) + '|21|' + (AW_NOW + 200000));
  const out = runEntry({ session_id: 'C', context_window: { used_percentage: 50 },
    rate_limits: { five_hour: { used_percentage: 40, resets_at: AW_NOW - 100 },
      seven_day: { used_percentage: 21, resets_at: AW_NOW + 200000 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(out, 'ctx 50% | 5h 40% | 7d 21% ~2d7h', '5h usage w/o countdown; 7d full');
});

test('matrix: corrupt tracker lines (extra pipes / empty / garbage) are skipped, never fatal or leaked', function () {
  const dir = tmpDir();
  writeRl(dir, 'A', '|||' + (AW_NOW - 600) + '|21|' + (AW_NOW + 200000)); // valid 7d-only
  writeRl(dir, 'bad1', 'garbage|not|a|tracker|line|extra|pipes');
  writeRl(dir, 'bad2', '\n');
  const out = runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(out, 'ctx 50% | 7d 21% ~2d7h', 'corrupt lines skipped; valid reading intact');
});

test('matrix: non-numeric TS coerces low - loses to any valid TS, but a valid reading still shows if alone', function () {
  const dir = tmpDir();
  writeRl(dir, 'X', 'notanumber|12|' + (AW_NOW + 3600) + '|||');
  const alone = runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(alone, 'ctx 50% | 5h 12% ~1h', 'garbage TS alone: reading is valid, shown');
  writeRl(dir, 'B', '2000|30|' + (AW_NOW + 3600) + '|||');
  const paired = runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(paired, 'ctx 50% | 5h 30% ~1h', 'garbage TS (coerced 0) loses to a real TS');
});

test('matrix: reset exactly AT now is excluded (boundary elapsed); 1s in the future is accepted', function () {
  const dir = tmpDir();
  writeRl(dir, 'A', '2000|40|' + AW_NOW + '|||');           // r == now -> elapsed
  const at = runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(at, 'ctx 50%', 'r == now excluded');
  writeRl(dir, 'A', '2000|40|' + (AW_NOW + 1) + '|||');     // r == now+1 -> valid
  const future = runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(future, 'ctx 50% | 5h 40% ~<1m', 'r == now+1 accepted');
});

test('matrix: this session ITSELF wins normally - fresh payload writes its tracker and shows countdowns', function () {
  const dir = tmpDir();
  const out = runEntry({ session_id: 'C', context_window: { used_percentage: 50 },
    rate_limits: { five_hour: { used_percentage: 9, resets_at: AW_NOW + 7200 },
      seven_day: { used_percentage: 21, resets_at: AW_NOW + 200000 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(out, 'ctx 50% | 5h 9% ~2h | 7d 21% ~2d7h', 'own fresh reading, full countdowns');
});

test('matrix: CRLF tracker line parses (trailing \\r lands on the last field, numeric coercion holds)', function () {
  const dir = tmpDir();
  writeRl(dir, 'A', '2000|12|' + (AW_NOW + 3600) + '|||\r\n');
  const out = runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(out, 'ctx 50% | 5h 12% ~1h', 'CRLF tracker still yields the correct reading');
});

test('matrix: TS slack boundary - now+60 accepted, now+61 rejected', function () {
  const dir = tmpDir();
  const R = AW_NOW + 3600;
  writeRl(dir, 'A', (AW_NOW + 60) + '|12|' + R + '|||');
  assert.strictEqual(runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 50% | 5h 12% ~1h', 'TS == now+60 accepted');
  writeRl(dir, 'A', (AW_NOW + 61) + '|12|' + R + '|||');
  assert.strictEqual(runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 50%', 'TS == now+61 rejected (future stamp)');
});

test('matrix: 5h reset exactly AT the horizon cap (now+21600) accepted; one past it rejected', function () {
  const dir = tmpDir();
  writeRl(dir, 'A', '2000|12|' + (AW_NOW + 21600) + '|||');
  assert.strictEqual(runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 50% | 5h 12% ~6h', 'r == now+cap accepted');
  writeRl(dir, 'A', '2000|12|' + (AW_NOW + 21601) + '|||');
  assert.strictEqual(runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 50%', 'r just past the 5h horizon rejected');
});

test('matrix: 7d reset exactly AT the horizon cap (now+691200) accepted; one past it rejected', function () {
  const dir = tmpDir();
  writeRl(dir, 'A', '|||' + (AW_NOW - 100) + '|12|' + (AW_NOW + 691200));
  assert.strictEqual(runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 50% | 7d 12% ~8d', 'r == now+cap accepted');
  writeRl(dir, 'A', '|||' + (AW_NOW - 100) + '|12|' + (AW_NOW + 691201));
  assert.strictEqual(runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 50%', 'r just past the 7d horizon rejected');
});

test('matrix: THE INCIDENT - own 5h reading elapsed, another session has a valid one -> the valid one wins', function () {
  const dir = tmpDir();
  writeRl(dir, 'LIVE', (AW_NOW - 120) + '|16|' + (AW_NOW + 8400) + '|||');  // valid future reset
  const out = runEntry({ session_id: 'C', context_window: { used_percentage: 89 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: AW_NOW - 525900 } } },  // ancient elapsed
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(out, 'ctx 89% | 5h 16% ~2h20m', 'valid session wins; own elapsed reading never shows ~now');
});

test('matrix: tracker-sourced float usage rounds like payload floats', function () {
  const dir = tmpDir();
  writeRl(dir, 'A', '2000|12.5|' + (AW_NOW + 3600) + '|||');
  assert.strictEqual(runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 50% | 5h 13% ~1h', '12.5 -> 13');
});

test('picker: a window with an EMPTY used but a valid resets_at is ignored, never rendered as a blank percentage', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 3 * 86400;
  // Line shape "TS||R5|TS|U|R7": the 5h pair has a reset but no usage. Dropping the u == ""
  // guard would render the malformed "5h % ~1h" instead of omitting the window.
  writeRl(dir, 'A', (AW_NOW - 100) + '||' + (AW_NOW + 3600) + '|' + (AW_NOW - 100) + '|10|' + R7);
  assert.strictEqual(runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 33% | 7d 10% ~3d', 'empty 5h usage -> 5h omitted entirely, 7d unaffected');
});

test('account-wide: ctx + model always come from THIS session, never a tracker', function () {
  const out = awBar(
    { session_id: 'C', context_window: { used_percentage: 7 }, model: { id: 'claude-opus-4-8' } },
    [ { sid: 'B', line: '2000|12|' + (AW_NOW + 3600) + '|||' } ]);
  assert.strictEqual(out, 'ctx 7% | 5h 12% ~1h | opus-4.8', 'ctx 7 + model from C; 5h 12 from tracker B');
});

test('account-wide: 5h and 7d are selected INDEPENDENTLY, not coupled', function () {
  const R5old = AW_NOW + 1800, R5new = AW_NOW + 3600, R7 = AW_NOW + 3 * 86400;
  const out = awBar(ctxOnly(33),
    [ { sid: 'P', line: '6000|15|' + R5new + '|||' },               // later 5h boundary (recent), no 7d
      { sid: 'Q', line: '5000|99|' + R5old + '|5000|40|' + R7 } ]); // earlier 5h boundary, plus the only 7d
  assert.strictEqual(out, 'ctx 33% | 5h 15% ~1h | 7d 40% ~3d',
    '5h from P (later boundary, 15) though Q has higher 99; 7d only Q has it (40)');
});

// The tracker file itself: written on first render, TS preserved when unchanged, restamped
// on a real change (an API call moved the reading). Six fields, no trailing flag. A FIRST
// sighting without prompt_cache has an UNKNOWN measurement time and is stamped 0 in both
// windows (never "now"); every later change is stamped now.

test('tracker: written on first render as "TS5|5U|5R|TS7|7U|7R" (no prompt_cache: both TS = 0, unknown)', function () {
  const dir = tmpDir();
  runEntry({ session_id: 'T', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: AW_NOW + 3600 },
      seven_day: { used_percentage: 30, resets_at: AW_NOW + 100000 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'T'),
    '0|12|' + (AW_NOW + 3600) + '|0|30|' + (AW_NOW + 100000),
    'tracker line = TS5(0)|5U|5R|TS7(0)|7U|7R');
});

test('tracker: NOT rewritten when the reading is byte-identical across renders (TS preserved)', function () {
  const dir = tmpDir();
  const payload = { session_id: 'T2', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: AW_NOW + 3600 } } };
  runEntry(payload, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  const first = rlFile(dir, 'T2');
  const st1 = fs.statSync(path.join(dir, 'telemetry-rl2-T2'));
  // Second render, SAME rate_limits, LATER now: the reading did not change, so its change
  // TS must NOT advance (the byte-identical reading keeps the original TS).
  runEntry(payload, { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 500) });
  assert.strictEqual(rlFile(dir, 'T2'), first, 'unchanged reading keeps its original TS');
  // Contents alone cannot tell "not rewritten" from "rewritten identically", and the difference
  // matters: this is the per-render hot path, so an unconditional write would add a temp-file
  // write plus a rename per render per session. The inode pins that no write happened at all
  // (the writer replaces the file via mv, so any rewrite lands a NEW inode).
  const st2 = fs.statSync(path.join(dir, 'telemetry-rl2-T2'));
  if (!IS_WIN) {
    assert.strictEqual(st2.ino, st1.ino, 'no rewrite occurred: same inode, not just same bytes');
  }
  assert.strictEqual(first, '0|12|' + (AW_NOW + 3600) + '|0||',
    'sanity: first sighting without prompt_cache stamps 0 (unknown); 5h-only leaves the 7d pair empty');
  // The same for a KNOWN (non-zero) stamp: a change at now+600 is stamped now+600, and an
  // unchanged render at now+900 keeps it, again without a rewrite.
  const changed = { session_id: 'T2', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 13, resets_at: AW_NOW + 3600 } } };
  runEntry(changed, { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 600) });
  const second = rlFile(dir, 'T2');
  assert.strictEqual(second, (AW_NOW + 600) + '|13|' + (AW_NOW + 3600) + '|0||', 'the change is stamped now');
  const st3 = fs.statSync(path.join(dir, 'telemetry-rl2-T2'));
  runEntry(changed, { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 900) });
  assert.strictEqual(rlFile(dir, 'T2'), second, 'unchanged reading keeps its known TS');
  if (!IS_WIN) {
    assert.strictEqual(fs.statSync(path.join(dir, 'telemetry-rl2-T2')).ino, st3.ino, 'no rewrite: same inode');
  }
});

test('tracker: restamped with a NEW TS when a value changes (an API call happened)', function () {
  const dir = tmpDir();
  runEntry({ session_id: 'T3', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: AW_NOW + 3600 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  runEntry({ session_id: 'T3', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 15, resets_at: AW_NOW + 3600 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 500) });
  assert.strictEqual(rlFile(dir, 'T3'), (AW_NOW + 500) + '|15|' + (AW_NOW + 3600) + '|0||',
    'changed 5h -> new TS5 (now) + new value; TS7 preserved at 0 (7d never changed, empty pair)');
});

test('tracker: a render with NO rate_limits writes only an EMPTY marker, once, and only when no tracker exists', function () {
  const dir = tmpDir();
  runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'C'), AW_NOW + '|||' + AW_NOW + '||', 'marker: no reading, just the session');
  const st = fs.statSync(path.join(dir, 'telemetry-rl2-C'));
  runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 30) });
  if (!IS_WIN) assert.strictEqual(fs.statSync(path.join(dir, 'telemetry-rl2-C')).ino, st.ino, 'not rewritten');
  // A tracked session whose rate_limits vanish keeps its stored reading and stamp.
  const R7 = AW_NOW + 2 * 86400;
  writeRl(dir, 'K', (AW_NOW - 500) + '|||' + (AW_NOW - 500) + '|40|' + R7);
  runEntry({ session_id: 'K', context_window: { used_percentage: 5 } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'K'), (AW_NOW - 500) + '|||' + (AW_NOW - 500) + '|40|' + R7, 'existing tracker untouched');
  // No valid now: nothing is written.
  const dir2 = tmpDir();
  runEntry(ctxOnly(33), { CCT_DIR: dir2, CCT_NOW: 'garbage' });
  assert.strictEqual(fs.existsSync(path.join(dir2, 'telemetry-rl2-C')), false, 'no now -> no marker');
});

test('a session first rendered WITHOUT rate_limits (before its first request) gets its first reading stamped NOW', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  // Older Claude Code: the payload carries no rate_limits until the session first request, so its
  // first reading is a fresh measurement and must beat an idle tracked one (A, 60%, a day old).
  writeRl(dir, 'A', (AW_NOW - 86400) + '|||' + (AW_NOW - 86400) + '|60|' + R7);
  runEntry({ session_id: 'B', context_window: { used_percentage: 5 } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 30) });
  const out = runEntry({ session_id: 'B', context_window: { used_percentage: 5 },
    rate_limits: { seven_day: { used_percentage: 66, resets_at: R7 } } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(out, 'ctx 5% | 7d 66% ~2d', 'the new session fresh 66% wins');
  assert.strictEqual(rlFile(dir, 'B'), (AW_NOW - 30) + '|||' + AW_NOW + '|66|' + R7, '7d stamped as a change at now (the empty 5h keeps the marker time)');
  // The marker itself never competes: a pool of only markers renders this session own usage.
  const dir2 = tmpDir();
  runEntry({ session_id: 'M', context_window: { used_percentage: 5 } }, { CCT_DIR: dir2, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(runEntry(ctxOnly(9), { CCT_DIR: dir2, CCT_NOW: String(AW_NOW) }).stdout, 'ctx 9%');
});

// PER-WINDOW change timestamps: the tracker stamps TS5 and TS7 INDEPENDENTLY, so a window
// that did not change keeps its own TS byte-for-byte while the other restamps. This is what
// closes the "5h churn makes a stale 7d look freshest" hole.

test('tracker: only the 5h reading changes -> TS5 restamped, TS7 PRESERVED byte-for-byte', function () {
  const dir = tmpDir();
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 100000;
  runEntry({ session_id: 'W1', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 11, resets_at: R5 },
      seven_day: { used_percentage: 29, resets_at: R7 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 100) });
  assert.strictEqual(rlFile(dir, 'W1'),
    '0|11|' + R5 + '|0|29|' + R7, 'first render (no prompt_cache): both TS = 0');
  // Both windows change: both stamped now.
  runEntry({ session_id: 'W1', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: R5 },
      seven_day: { used_percentage: 30, resets_at: R7 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'W1'),
    AW_NOW + '|12|' + R5 + '|' + AW_NOW + '|30|' + R7, 'both changed: both TS = now');
  // Only 5h usage moves (12 -> 15); 7d identical; later now.
  runEntry({ session_id: 'W1', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 15, resets_at: R5 },
      seven_day: { used_percentage: 30, resets_at: R7 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 500) });
  assert.strictEqual(rlFile(dir, 'W1'),
    (AW_NOW + 500) + '|15|' + R5 + '|' + AW_NOW + '|30|' + R7,
    'TS5 advanced to now+500; TS7 preserved at its own change time');
});

test('tracker: only the 7d reading changes -> TS7 restamped, TS5 PRESERVED byte-for-byte', function () {
  const dir = tmpDir();
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 100000;
  runEntry({ session_id: 'W2', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 11, resets_at: R5 },
      seven_day: { used_percentage: 29, resets_at: R7 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 100) });
  runEntry({ session_id: 'W2', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: R5 },
      seven_day: { used_percentage: 30, resets_at: R7 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'W2'),
    AW_NOW + '|12|' + R5 + '|' + AW_NOW + '|30|' + R7, 'both changed: both TS = now');
  // Only 7d usage moves (30 -> 41); 5h identical; later now.
  runEntry({ session_id: 'W2', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 12, resets_at: R5 },
      seven_day: { used_percentage: 41, resets_at: R7 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 700) });
  assert.strictEqual(rlFile(dir, 'W2'),
    AW_NOW + '|12|' + R5 + '|' + (AW_NOW + 700) + '|41|' + R7,
    'TS5 preserved at its own change time; TS7 advanced to now+700');
});

test('a MALFORMED 5-field tracker line (only tampering produces one) cannot let its 7d win, and is rewritten whole', function () {
  const dir = tmpDir();
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 3 * 86400;
  writeRl(dir, 'OLD', '1000|5|' + R5 + '|34|' + R7);
  // The picker reads it as 6 fields: a[4]=34 (TS7), a[5]=R7 (7U), a[6]='' (7R) -> no resets_at -> 7d rejected.
  assert.strictEqual(runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout, 'ctx 50% | 5h 5% ~1h',
    'its 7d (34%) cannot win; its 5h still read');
  // Its session renders: the line is rewritten in the 6-field format (the 7d pair is new to it).
  runEntry({ session_id: 'OLD', context_window: { used_percentage: 20 },
    rate_limits: { five_hour: { used_percentage: 5, resets_at: R5 }, seven_day: { used_percentage: 34, resets_at: R7 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'OLD'), '1000|5|' + R5 + '|' + AW_NOW + '|34|' + R7, 'rewritten as 6 fields');
});
// LAST-CALL TIME. Newer Claude Code (2.1.280+) puts prompt_cache.expires_at and .ttl in the payload;
// each main-thread API request refreshes the cache, so expires_at - ttl is when this session last
// called. It is the stamp for a FIRST sighting only (an idle session, a fresh install, a recreated
// tracker), where the change moment is unknown: such a session carries its real, old time instead
// of "now". A tracked session is stamped when its numbers change, because subagent requests refresh
// rate_limits without moving this time, and a cancelled request can move it without new numbers.

function pcPayload(sid, u7, r7, lastCall, extra) {
  const p = { session_id: sid, context_window: { used_percentage: 33 },
    rate_limits: { seven_day: { used_percentage: u7, resets_at: r7 } },
    prompt_cache: { warm: true, ttl: '1h', expires_at: lastCall + 3600 } };
  return Object.assign(p, extra || {});
}

test('last-call time on FIRST sighting: an idle session carries its real old call time and loses to a newer call', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  // Fresh install: no trackers. LIVE called 100s ago (24%, after a reset). IDLE last called a day ago
  // (96%) and renders LAST. Change-TS alone would stamp IDLE "now"; its last-call time keeps it old.
  runEntry(pcPayload('LIVE', 24, R7, AW_NOW - 100), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 10) });
  const out = runEntry(pcPayload('IDLE', 96, R7, AW_NOW - 86400), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(out, 'ctx 33% | 7d 24% ~2d', 'the most recent call (24%) wins');
  assert.strictEqual(rlFile(dir, 'IDLE'), (AW_NOW - 86400) + '|||' + (AW_NOW - 86400) + '|96|' + R7, 'stamped with its call time');
});

test('last-call time is used ONLY on first sighting: a SUBAGENT refresh (value changes, call time does not) is stamped now', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  // Subagent requests refresh a session rate_limits but not its prompt_cache, so the last-call time
  // stays at the main thread last request. A: main call at now - 1000 (60%). B: main call at now - 700
  // (63%). A subagents then push A to 70% with no new main call. The change is the newest measurement.
  runEntry(pcPayload('A', 60, R7, AW_NOW - 1000), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 990) });
  runEntry(pcPayload('B', 63, R7, AW_NOW - 700), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 690) });
  const out = runEntry(pcPayload('A', 70, R7, AW_NOW - 1000), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(out, 'ctx 33% | 7d 70% ~2d', 'the subagent-driven 70% is the newest reading');
  assert.strictEqual(rlFile(dir, 'A'), (AW_NOW - 1000) + '|||' + AW_NOW + '|70|' + R7, 'TS7 = the change moment, not the stale call time');
});

test('last-call time: a newer call that leaves the number UNCHANGED (e.g. a cancelled request) does not restamp', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  // A cancelled or failed request can move the call time without new rate_limits, so an unchanged
  // number must keep its stamp: A (idle 40% since now - 5000) must not outrank B (45% at now - 100).
  runEntry(pcPayload('A', 40, R7, AW_NOW - 5000), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 4990) });
  runEntry(pcPayload('B', 45, R7, AW_NOW - 100), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 90) });
  const out = runEntry(pcPayload('A', 40, R7, AW_NOW - 10), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(out, 'ctx 33% | 7d 45% ~2d', 'B stays the newest reading');
  assert.strictEqual(rlFile(dir, 'A'), (AW_NOW - 5000) + '|||' + (AW_NOW - 5000) + '|40|' + R7, 'A keeps its first stamp');
});


test('last-call time (first sighting): a call at or before now is the stamp; one in the future is rejected (unknown, 0)', function () {
  const R7 = AW_NOW + 2 * 86400;
  [[-1, AW_NOW - 1], [0, AW_NOW], [1, 0], [60, 0], [5000, 0]].forEach(function (c) {
    const dir = tmpDir();
    runEntry(pcPayload('X', 40, R7, AW_NOW + c[0]), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
    assert.strictEqual(rlFile(dir, 'X'), c[1] + '|||' + c[1] + '|40|' + R7, 'last call at now+' + c[0]);
  });
});
test('last-call time: a zero ttl ("0s", "0h") is rejected, the first sighting falls back to 0 (unknown)', function () {
  const R7 = AW_NOW + 2 * 86400;
  ['0s', '0h', '00m'].forEach(function (ttl) {
    const dir = tmpDir();
    runEntry({ session_id: 'X', context_window: { used_percentage: 33 },
      rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } },
      prompt_cache: { ttl: ttl, expires_at: AW_NOW - 500 } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
    assert.strictEqual(rlFile(dir, 'X'), '0|||0|40|' + R7, 'ttl ' + ttl + ': stamp 0, never now');
  });
});
test('last-call time: an expires_at at or past 1e11 is rejected even when a huge ttl brings it back', function () {
  const R7 = AW_NOW + 2 * 86400;
  const dir = tmpDir();
  runEntry({ session_id: 'X', context_window: { used_percentage: 33 },
    rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } },
    prompt_cache: { ttl: (100000000000 - (AW_NOW - 1000)) + 's', expires_at: 100000000000 } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'X'), '0|||0|40|' + R7, 'rejected: stamp 0, never now');
});

test('a 6-field line whose 7d has a usage but no reset is NOT mistaken for the old format (no rewrite per render)', function () {
  const dir = tmpDir();
  const R5 = AW_NOW + 3600;
  const pay = { session_id: 'U', context_window: { used_percentage: 20 },
    rate_limits: { five_hour: { used_percentage: 10, resets_at: R5 }, seven_day: { used_percentage: 50, resets_at: null } } };
  runEntry(pay, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'U'), '0|10|' + R5 + '|0|50|');
  const st = fs.statSync(path.join(dir, 'telemetry-rl2-U'));
  runEntry(pay, { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 30) });
  if (!IS_WIN) assert.strictEqual(fs.statSync(path.join(dir, 'telemetry-rl2-U')).ino, st.ino, 'unchanged render: no rewrite');
  assert.strictEqual(rlFile(dir, 'U'), '0|10|' + R5 + '|0|50|');
});

test('last-call time: an unchanged render with the same call time does not rewrite the tracker', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  runEntry(pcPayload('S', 40, R7, AW_NOW - 100), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  const st1 = fs.statSync(path.join(dir, 'telemetry-rl2-S'));
  runEntry(pcPayload('S', 40, R7, AW_NOW - 100), { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 30) });
  if (!IS_WIN) assert.strictEqual(fs.statSync(path.join(dir, 'telemetry-rl2-S')).ino, st1.ino, 'no rewrite');
  assert.strictEqual(rlFile(dir, 'S'), (AW_NOW - 100) + '|||' + (AW_NOW - 100) + '|40|' + R7);
});

test('last-call time: both windows take it, and a 5m ttl is parsed', function () {
  const dir = tmpDir();
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 2 * 86400;
  runEntry({ session_id: 'B5', context_window: { used_percentage: 33 },
    rate_limits: { five_hour: { used_percentage: 7, resets_at: R5 }, seven_day: { used_percentage: 40, resets_at: R7 } },
    prompt_cache: { ttl: '5m', expires_at: AW_NOW + 100 } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'B5'), (AW_NOW - 200) + '|7|' + R5 + '|' + (AW_NOW - 200) + '|40|' + R7);
});

test('last-call time: ignored when missing, malformed or in the future (first sighting stamped 0)', function () {
  const R7 = AW_NOW + 2 * 86400;
  const bad = [
    {},                                                     // no prompt_cache (older Claude Code)
    { prompt_cache: { ttl: '1h' } },                        // no expires_at
    { prompt_cache: { expires_at: AW_NOW + 3000 } },        // no ttl
    { prompt_cache: { ttl: '1d', expires_at: AW_NOW } },    // unknown unit
    { prompt_cache: { ttl: '1h', expires_at: 12345 } },     // implausible epoch
    { prompt_cache: null },                                 // null block
    { prompt_cache: { ttl: '1h', expires_at: String(AW_NOW + 3000) } }, // expires_at as a string
  ];
  bad.forEach(function (extra, k) {
    const dir = tmpDir();
    const p = { session_id: 'X', context_window: { used_percentage: 33 }, rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } };
    runEntry(Object.assign(p, extra), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
    assert.strictEqual(rlFile(dir, 'X'), '0|||0|40|' + R7, 'case ' + k + ': unknown time, stamp 0 (never now)');
  });
  // A last call 61s in the FUTURE cannot have happened: rejected, unknown time.
  const dir = tmpDir();
  runEntry({ session_id: 'X', context_window: { used_percentage: 33 }, rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } },
    prompt_cache: { ttl: '1h', expires_at: AW_NOW + 3661 } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'X'), '0|||0|40|' + R7, 'future last call: rejected, stamp 0 (never now)');
});

// --- UNKNOWN measurement time. A first sighting without a usable prompt_cache (older Claude Code,
// a session that has made no request yet, a recreated tracker) has no known measurement time and
// is stamped 0, so it ranks below every reading with a known time on the same boundary until its
// numbers change (then it is stamped now). It is never stamped "now" on first sight: that would let
// an old reading (an idle session, a new session carrying a cached value) outrank a real newer one.

const UK_R5 = AW_NOW + 3600, UK_R7 = AW_NOW + 2 * 86400;
function ukPay(sid, u5, u7, extra) {
  return Object.assign({ session_id: sid, context_window: { used_percentage: 33 },
    rate_limits: { five_hour: { used_percentage: u5, resets_at: UK_R5 },
      seven_day: { used_percentage: u7, resets_at: UK_R7 } } }, extra || {});
}
// The devil repro, in both filename orders: TRACKED is a known session whose numbers last changed
// 600s ago (5h 12, 7d 55); FRESH is first seen NOW with older numbers (5h 4, 7d 30) and no
// prompt_cache. Returns { dir, fresh } for follow-up renders.
function unknownVsTracked(order, freshExtra) {
  const dir = tmpDir();
  const tracked = order[0] + 'TRACKED', fresh = order[1] + 'FRESH';
  runEntry(ukPay(tracked, 10, 50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 1000) });
  runEntry(ukPay(tracked, 12, 55), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 600) });
  assert.strictEqual(rlFile(dir, tracked), (AW_NOW - 600) + '|12|' + UK_R5 + '|' + (AW_NOW - 600) + '|55|' + UK_R7,
    'tracked session: measured at its change, 600s ago');
  const out = runEntry(ukPay(fresh, 4, 30, freshExtra), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(rlFile(dir, fresh), '0|4|' + UK_R5 + '|0|30|' + UK_R7, 'first sighting, no last-call time: stamp 0');
  assert.strictEqual(out, 'ctx 33% | 5h 12% ~1h | 7d 55% ~2d',
    'the known 600s-old reading beats the unknown one (order ' + order.join(',') + ')');
  return { dir: dir, fresh: fresh };
}

test('UNKNOWN time: a first sighting without prompt_cache ranks BELOW a tracked reading with a known time on the same boundary (either filename order)', function () {
  [['A', 'B'], ['B', 'A']].forEach(function (o) { unknownVsTracked(o); });
});

test('UNKNOWN time: total_api_duration_ms 0 and no prompt_cache (no request yet) is also stamped 0 and ranks below (either filename order)', function () {
  [['A', 'B'], ['B', 'A']].forEach(function (o) {
    unknownVsTracked(o, { cost: { total_cost_usd: 0, total_duration_ms: 1500, total_api_duration_ms: 0 } });
  });
});

test('UNKNOWN time: once the unknown reading CHANGES it is stamped now and wins (per window, either filename order)', function () {
  [['A', 'B'], ['B', 'A']].forEach(function (o) {
    const s = unknownVsTracked(o);
    // Only FRESH 7d moves: TS7 = now+10 and its 7d wins; its unchanged 5h keeps 0 and still loses.
    assert.strictEqual(runEntry(ukPay(s.fresh, 4, 31), { CCT_DIR: s.dir, CCT_NOW: String(AW_NOW + 10) }).stdout,
      'ctx 33% | 5h 12% ~59m | 7d 31% ~1d23h', '7d changed: the fresh 31% wins, 5h still the tracked 12%');
    assert.strictEqual(rlFile(s.dir, s.fresh), '0|4|' + UK_R5 + '|' + (AW_NOW + 10) + '|31|' + UK_R7);
    // Then its 5h moves too: TS5 = now+20 and its 5h wins as well.
    assert.strictEqual(runEntry(ukPay(s.fresh, 5, 31), { CCT_DIR: s.dir, CCT_NOW: String(AW_NOW + 20) }).stdout,
      'ctx 33% | 5h 5% ~59m | 7d 31% ~1d23h', '5h changed: the fresh 5% wins too');
    assert.strictEqual(rlFile(s.dir, s.fresh), (AW_NOW + 20) + '|5|' + UK_R5 + '|' + (AW_NOW + 10) + '|31|' + UK_R7);
  });
});

test('UNKNOWN time: a pool where EVERY reading is unknown (fresh install, older Claude Code) still renders a value: each session its own', function () {
  const dir = tmpDir();
  // Rendered C, B, A (reverse of glob order); none has prompt_cache, so all are stamped 0. Each
  // render shows a value: on a tie of unknowns a session shows its OWN reading (never an arbitrary
  // other one); a session with no reading of its own falls back to glob order.
  assert.strictEqual(runEntry(ukPay('C', 6, 60), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 33% | 5h 6% ~1h | 7d 60% ~2d', 'alone: its own unknown reading is shown, not dropped');
  runEntry(ukPay('B', 5, 50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(runEntry(ukPay('A', 4, 40), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 33% | 5h 4% ~1h | 7d 40% ~2d', 'all stamp 0: A shows its own reading');
  ['A', 'B', 'C'].forEach(function (sid, i) {
    assert.strictEqual(rlFile(dir, sid), '0|' + (4 + i) + '|' + UK_R5 + '|0|' + (40 + 10 * i) + '|' + UK_R7, sid + ' stamped 0');
  });
  assert.strictEqual(runEntry(ukPay('C', 6, 60), { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 5) }).stdout,
    'ctx 33% | 5h 6% ~59m | 7d 60% ~1d23h', 'C re-rendering shows its own reading on the tie');
  assert.strictEqual(runEntry({ session_id: 'D', context_window: { used_percentage: 33 } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 5) }).stdout,
    'ctx 33% | 5h 4% ~59m | 7d 40% ~1d23h', 'a session with no reading of its own: the first in glob order (A)');
});

test('a DELETED live tracker is re-sighted with its real call time (prompt_cache), or as unknown (stamp 0) without it, never as now', function () {
  const dir = tmpDir();
  const R7 = UK_R7;
  // S: first seen with a call at now-3000, then its number changes at now-100 (call at now-110).
  runEntry(pcPayload('S', 40, R7, AW_NOW - 3000), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 2990) });
  assert.strictEqual(rlFile(dir, 'S'), (AW_NOW - 3000) + '|||' + (AW_NOW - 3000) + '|40|' + R7);
  runEntry(pcPayload('S', 45, R7, AW_NOW - 110), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 100) });
  assert.strictEqual(rlFile(dir, 'S'), (AW_NOW - 3000) + '|||' + (AW_NOW - 100) + '|45|' + R7);
  // A competitor measured at now-500 on the same boundary.
  writeRl(dir, 'OTHER', '|||' + (AW_NOW - 500) + '|47|' + R7);
  const p = path.join(dir, 'telemetry-rl2-S');
  // Deleted (e.g. by the prune cap), then S re-renders its same payload: the call time is restored.
  fs.unlinkSync(p);
  assert.strictEqual(runEntry(pcPayload('S', 45, R7, AW_NOW - 110), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 33% | 7d 45% ~2d', 'S (call at now-110) still beats OTHER (now-500)');
  assert.strictEqual(rlFile(dir, 'S'), (AW_NOW - 110) + '|||' + (AW_NOW - 110) + '|45|' + R7, 'stamp = the real call time, not now');
  // Deleted again, re-rendered with NO prompt_cache: unknown, stamp 0, so OTHER wins.
  fs.unlinkSync(p);
  assert.strictEqual(runEntry({ session_id: 'S', context_window: { used_percentage: 33 },
    rate_limits: { seven_day: { used_percentage: 45, resets_at: R7 } } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 33% | 7d 47% ~2d', 'the recreated unknown reading ranks below OTHER');
  assert.strictEqual(rlFile(dir, 'S'), '0|||0|45|' + R7, 'stamp 0, never now');
});

test('pool scan (linear): a directory, a dangling symlink and an unreadable file named telemetry-rl2-* are skipped; 300 trackers are all read', function () {
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 2 * 86400;
  // 300 trackers, all on the same boundaries. Only q150 (mid-pool) has the newest stamps, so the
  // expected value proves every file was read, not just the first or last.
  function seed300(dir) {
    for (let i = 0; i < 300; i++) {
      const id = 'q' + String(i).padStart(3, '0');
      const ts = (i === 150) ? (AW_NOW - 100) : (AW_NOW - 5000 + i);
      const u5 = (i === 150) ? 77 : 10, u7 = (i === 150) ? 88 : 20;
      writeRl(dir, id, ts + '|' + u5 + '|' + R5 + '|' + ts + '|' + u7 + '|' + R7);
    }
  }
  const WIN = 'ctx 33% | 5h 77% ~1h | 7d 88% ~2d';
  let dir = tmpDir();
  seed300(dir);
  const r = runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW), CCT_WRAP: 'printf "[argc=%s]" "$#"' });
  assert.strictEqual(r.stdout, WIN + ' [argc=0]', '300 trackers: the mid-pool newest wins; none leaks to CCT_WRAP');
  // Each bad entry alone next to one good tracker (each must not blank the bar), then all together
  // with the 300. A bad entry carries the NEWEST stamps and a newer boundary where it can hold a
  // line, so it would win if it were ever read.
  const good = (AW_NOW - 100) + '|77|' + R5 + '|' + (AW_NOW - 100) + '|88|' + R7;
  const winner = (AW_NOW - 1) + '|99|' + (R5 + 60) + '|' + (AW_NOW - 1) + '|99|' + (R7 + 60);
  function addDir(d) { fs.mkdirSync(path.join(d, 'telemetry-rl2-adir')); }
  function addDangling(d) { fs.symlinkSync(path.join(d, 'no-such-target'), path.join(d, 'telemetry-rl2-dangling')); }
  function addUnreadable(d) {
    const p = path.join(d, 'telemetry-rl2-locked');
    fs.writeFileSync(p, winner); fs.chmodSync(p, 0);
    let readable = true; try { fs.closeSync(fs.openSync(p, 'r')); } catch (e) { readable = false; }
    if (readable) { fs.chmodSync(p, 0o644); fs.unlinkSync(p); return false; }
    return true;
  }
  function restore(d) { try { fs.chmodSync(path.join(d, 'telemetry-rl2-locked'), 0o644); } catch (e) {} }
  const cases = [['directory', addDir], ['dangling symlink', addDangling]];
  if (IS_WIN) skipTest('pool scan: dangling symlink / unreadable file', 'symlink and chmod semantics are POSIX-only');
  const posixCases = IS_WIN ? [cases[0]] : cases.concat([['unreadable file', addUnreadable]]);
  posixCases.forEach(function (c) {
    dir = tmpDir();
    writeRl(dir, 'good', good);
    const active = c[1](dir);
    if (active === false) { skipTest('pool scan: unreadable file', 'running as root: chmod 000 still readable'); return; }
    let out;
    try { out = runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout; } finally { restore(dir); }
    assert.strictEqual(out, WIN, c[0] + ' skipped, the good tracker still read');
  });
  // All together, plus a tracker whose name contains a space (paths split on newline only).
  dir = tmpDir();
  seed300(dir);
  fs.writeFileSync(path.join(dir, 'telemetry-rl2-sp ace'), (AW_NOW - 50) + '|66|' + R5 + '|' + (AW_NOW - 50) + '|67|' + R7);
  posixCases.forEach(function (c) { c[1](dir); });
  let all;
  try { all = runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout; } finally { restore(dir); }
  assert.strictEqual(all, 'ctx 33% | 5h 66% ~1h | 7d 67% ~2d', 'all bad entries skipped among 300; the spaced name is one path');
});

// --- 7d-ONLY payloads. Since 2026-11 some plans have no 5h limit: their payloads carry
// rate_limits.seven_day and NO five_hour key, so those trackers have an empty 5h pair. On accounts
// that still have a 5h window Claude Code also drops five_hour once that window elapses, so a pool
// routinely mixes both shapes. The same rule ranks them all; these pin it end to end. ---

test('account-wide 7d THE 2026-11-01 REPRO: a stale 5h-era line (older change-TS) cannot hold the bar below the live 7d-only readings', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  // Shape copied from the live pool: the last session that still saw five_hour (elapsed 5h
  // boundary, 62%) and three 7d-only sessions after it (63, 66, 70); the newest change-TS (70%) wins. The
  // 1.4.7 release showed 62%.
  writeRl(dir, 'OLD5H', (AW_NOW - 72000) + '|8|' + (AW_NOW - 67500) + '|' + (AW_NOW - 72000) + '|62|' + R7);
  writeRl(dir, 'L1', (AW_NOW - 60000) + '|||' + (AW_NOW - 60000) + '|63|' + R7);
  writeRl(dir, 'L2', (AW_NOW - 40000) + '|||' + (AW_NOW - 40000) + '|66|' + R7);
  writeRl(dir, 'L3', (AW_NOW - 50) + '|||' + (AW_NOW - 50) + '|70|' + R7);
  assert.strictEqual(runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 33% | 7d 70% ~2d', 'the live 70% wins; the 5h segment is omitted (no current 5h reading)');
});

test('account-wide 7d: a lone 7d-only reading of 0% (start of a week) is shown, not treated as missing', function () {
  const dir = tmpDir();
  writeRl(dir, 'ZERO', AW_NOW + '|||' + AW_NOW + '|0|' + (AW_NOW + 2 * 86400));
  assert.strictEqual(runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout, 'ctx 33% | 7d 0% ~2d');
});

test('7d-ONLY account end to end: a seven_day-only payload records an empty 5h pair and renders "7d" with no 5h segment', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  // S7 last called 5s ago (prompt_cache), so its first sighting carries a KNOWN time.
  const pay = pcPayload('S7', 70, R7, AW_NOW - 5, { context_window: { used_percentage: 40 } });
  const res = runEntry(pay, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(res.stdout, 'ctx 40% | 7d 70% ~2d', 'no 5h segment, 7d from the account-wide pick');
  assert.strictEqual(rlFile(dir, 'S7'), (AW_NOW - 5) + '|||' + (AW_NOW - 5) + '|70|' + R7, 'tracker line has an empty 5h pair');
  // A second 7d-only session with a LOWER, older reading must not drag the bar down.
  writeRl(dir, 'OLDER', '|||' + (AW_NOW - 9000) + '|60|' + R7);
  assert.strictEqual(runEntry(pay, { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 10) }).stdout, 'ctx 40% | 7d 70% ~1d23h', 'still 70%');
});

test('7d-ONLY end to end through the writer: a later 7d-only render wins, a reset to a LOWER value wins, an idle re-render does not restamp', function () {
  // The whole loop (writer stamp + picker) on a mixed pool. A rendered both windows (7d 62%) 20h
  // ago; C (66%) and B (70%) rendered 7d-only since -> 70%. Then a mid-window 7d reset: B reads
  // 3% later still -> 3%, although A's 62% and C's 66% sit on the same boundary. Then idle A
  // re-renders its SAME old payload: its tracker must not change (an unconditional restamp would
  // hand the pick back to the stale 62%), so the bar still shows 3%.
  // Every session is first seen with prompt_cache, so each first sighting carries its real
  // call time (made at the render moment); without it they would all be stamped 0 (unknown).
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  const payA = { session_id: 'A', context_window: { used_percentage: 10 },
    rate_limits: { five_hour: { used_percentage: 8, resets_at: AW_NOW - 68400 },
      seven_day: { used_percentage: 62, resets_at: R7 } },
    prompt_cache: { ttl: '1h', expires_at: AW_NOW - 72000 + 3600 } };
  function pay7(sid, u, lastCall) { return pcPayload(sid, u, R7, lastCall); }
  assert.strictEqual(runEntry(payA, { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 72000) }).stdout,
    'ctx 10% | 5h 8% ~1h | 7d 62% ~2d20h', 'A renders both windows');
  const lineA = rlFile(dir, 'A');
  assert.strictEqual(lineA, (AW_NOW - 72000) + '|8|' + (AW_NOW - 68400) + '|' + (AW_NOW - 72000) + '|62|' + R7);
  runEntry(pay7('C', 66, AW_NOW - 2000), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 2000) });
  assert.strictEqual(runEntry(pay7('B', 70, AW_NOW - 1000), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 1000) }).stdout,
    'ctx 33% | 7d 70% ~2d', 'the latest 7d-only reading (70%) wins');
  assert.strictEqual(rlFile(dir, 'B'), (AW_NOW - 1000) + '|||' + (AW_NOW - 1000) + '|70|' + R7, 'B tracker: empty 5h pair');
  // B's next call (at now - 2) brings the reset: a tracked session is stamped at the change.
  assert.strictEqual(runEntry(pay7('B', 3, AW_NOW - 2), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 33% | 7d 3% ~2d', 'after the reset the newer, LOWER 3% wins over 62% and 66%');
  assert.strictEqual(rlFile(dir, 'B'), (AW_NOW - 1000) + '|||' + AW_NOW + '|3|' + R7,
    'only the 7d pair changed: TS7 restamped, the empty 5h pair keeps its TS5');
  const stA = fs.statSync(path.join(dir, 'telemetry-rl2-A'));
  assert.strictEqual(runEntry(payA, { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 100) }).stdout,
    'ctx 10% | 5h 8% | 7d 3% ~1d23h', 'idle A re-render: 3% holds (A own elapsed 5h falls back, no countdown)');
  assert.strictEqual(rlFile(dir, 'A'), lineA, 'A tracker byte-identical: the unchanged reading was not restamped');
  if (!IS_WIN) {
    assert.strictEqual(fs.statSync(path.join(dir, 'telemetry-rl2-A')).ino, stA.ino, 'A tracker not rewritten (same inode)');
  }
});


test('INTERMITTENT five_hour end to end: one session flipping 5h -> 7d-only -> 5h keeps a correct tracker and bar', function () {
  const dir = tmpDir();
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 3 * 86400;
  const both = { session_id: 'S', context_window: { used_percentage: 20 },
    rate_limits: { five_hour: { used_percentage: 5, resets_at: R5 }, seven_day: { used_percentage: 30, resets_at: R7 } } };
  const only7 = { session_id: 'S', context_window: { used_percentage: 20 },
    rate_limits: { seven_day: { used_percentage: 31, resets_at: R7 } } };
  assert.strictEqual(runEntry(both, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout, 'ctx 20% | 5h 5% ~1h | 7d 30% ~3d');
  assert.strictEqual(rlFile(dir, 'S'), '0|5|' + R5 + '|0|30|' + R7, 'first sighting without prompt_cache: both TS = 0');
  assert.strictEqual(runEntry(only7, { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 60) }).stdout, 'ctx 20% | 7d 31% ~2d23h',
    '7d-only render: the own tracker now has no 5h pair, so no 5h segment');
  assert.strictEqual(rlFile(dir, 'S'), (AW_NOW + 60) + '|||' + (AW_NOW + 60) + '|31|' + R7, '7d-only render: 5h pair emptied, both TS restamped');
  assert.strictEqual(runEntry(both, { CCT_DIR: dir, CCT_NOW: String(AW_NOW + 120) }).stdout, 'ctx 20% | 5h 5% ~58m | 7d 30% ~2d23h',
    'back to both windows');
  assert.strictEqual(rlFile(dir, 'S'), (AW_NOW + 120) + '|5|' + R5 + '|' + (AW_NOW + 120) + '|30|' + R7,
    'both pairs changed again: both restamped');
});

test('reformatted payload: CR/LF and blanks around the colon still parse every window', function () {
  const dir = tmpDir();
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 2 * 86400;
  // Not what Claude Code sends (compact JSON), but a host or CCT_WRAP user may pass CRLF or
  // pretty-printed JSON. The key-to-object gaps here use CR, LF, tab or space (awk joins the
  // records, so an LF never reaches the parser; the CR, tab and space are what is exercised).
  const json = '{"session_id":"F",\r\n"model" :\r\n {"id":"claude-opus-4-8"},\r\n"context_window"\t:\n{"used_percentage":12},'
    + '\r\n"rate_limits":\r\n{"five_hour" : \r\n{"used_percentage":3,"resets_at":' + R5 + '},'
    + '\r\n"seven_day":\r\n\t{"used_percentage":33,"resets_at":' + R7 + '}}}\r\n';
  const res = spawnSync(SH, [ENTRY], { input: json, encoding: 'utf8',
    env: Object.assign({}, process.env, { CCT_DIR: dir, CCT_NOW: String(AW_NOW), CCT_WRAP: '' }) });
  assert.strictEqual(res.stdout, 'ctx 12% | 5h 3% ~1h | 7d 33% ~2d | opus-4.8', 'CRLF payload parses fully');
});

test('spaced payload: blanks after each colon and before each object still parse', function () {
  const dir = tmpDir();
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 2 * 86400;
  const json = '{"session_id": "W", "context_window": {"used_percentage": 40}, "rate_limits": {"five_hour": '
    + '{"used_percentage": 5, "resets_at": ' + R5 + '}, "seven_day":\t{"used_percentage": 70, "resets_at": ' + R7 + '}}}';
  assert.strictEqual(runEntry(json, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout, 'ctx 40% | 5h 5% ~1h | 7d 70% ~2d');
  assert.strictEqual(rlFile(dir, 'W'), '0|5|' + R5 + '|0|70|' + R7);
});

test('a key name used as a string VALUE earlier in the payload does not hide the real key', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  // session_name is user-controlled text; a value of "seven_day" before rate_limits must not be
  // mistaken for the key (which would make the window vanish for this session).
  const res = runEntry({ session_id: 'K', session_name: 'seven_day', context_window: { used_percentage: 33 },
    rate_limits: { seven_day: { used_percentage: 70, resets_at: R7 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(res.stdout, 'ctx 33% | 7d 70% ~2d', 'real seven_day key found past the string value');
  assert.strictEqual(rlFile(dir, 'K'), '0|||0|70|' + R7, 'tracker records the 7d reading');
});

test('CR and tab gaps around the object keys parse, in both the writer and the renderer', function () {
  const dir = tmpDir();
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 2 * 86400;
  // CR and tab around the OBJECT keys (model, context_window, five_hour, seven_day) and a sample
  // of the inner fields; the next test puts both on each side of every inner colon.
  const json = '{"session_id":"F","model"\r:\t{"id":"claude-opus-4-8"},"context_window"\r\t:\t{"used_percentage"\r:\r12},'
    + '"rate_limits":{"five_hour"\t\r:{"used_percentage":3,"resets_at"\r:\r' + R5 + '},'
    + '"seven_day"\r:{"used_percentage"\t:\r33,"resets_at":' + R7 + '}}}';
  assert.strictEqual(runEntry(json, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout,
    'ctx 12% | 5h 3% ~1h | 7d 33% ~2d | opus-4.8', 'renderer reads every field');
  assert.strictEqual(rlFile(dir, 'F'), '0|3|' + R5 + '|0|33|' + R7, 'writer reads every field');
});

test('mixed CR+tab gaps on BOTH sides of every inner colon (used_percentage, resets_at, model id) parse in writer and renderer', function () {
  const dir = tmpDir();
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 2 * 86400, g = '\r\t:\t\r';
  const json = '{"session_id":"G","model":{"id"' + g + '"claude-opus-4-8"},"context_window":{"used_percentage"' + g + '12},'
    + '"rate_limits":{"five_hour":{"used_percentage"' + g + '3,"resets_at"' + g + R5 + '},'
    + '"seven_day":{"used_percentage"' + g + '33,"resets_at"' + g + R7 + '}},'
    + '"prompt_cache":{"ttl"' + g + '"1h","expires_at"' + g + (AW_NOW - 100 + 3600) + '}}';
  assert.strictEqual(runEntry(json, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout, 'ctx 12% | 5h 3% ~1h | 7d 33% ~2d | opus-4.8');
  // prompt_cache (ttl, expires_at) parses through the same gaps: the first sighting takes its call time.
  assert.strictEqual(rlFile(dir, 'G'), (AW_NOW - 100) + '|3|' + R5 + '|' + (AW_NOW - 100) + '|33|' + R7);
});

test('the renderer also skips a key name used as a string value (context_window as a session name)', function () {
  const dir = tmpDir();
  assert.strictEqual(runEntry({ session_id: 'K', session_name: 'context_window', context_window: { used_percentage: 33 } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout, 'ctx 33%', 'ctx comes from the real key');
});

test('a NULL rate-limit window is treated as absent, never read from the next object', function () {
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 2 * 86400;
  // Not observed in real payloads (a 5h-less payload omits the key), but a null value must not let
  // the parser scan ahead into seven_day and render its numbers as "5h".
  let dir = tmpDir();
  let res = runEntry({ session_id: 'N', context_window: { used_percentage: 40 },
    rate_limits: { five_hour: null, seven_day: { used_percentage: 70, resets_at: R7 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(res.stdout, 'ctx 40% | 7d 70% ~2d', 'five_hour null: no 5h segment');
  assert.strictEqual(rlFile(dir, 'N'), '0|||0|70|' + R7, 'five_hour null: empty 5h pair in the tracker');
  dir = tmpDir();
  res = runEntry({ session_id: 'N', context_window: { used_percentage: 40 },
    rate_limits: { seven_day: null, five_hour: { used_percentage: 5, resets_at: R5 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(res.stdout, 'ctx 40% | 5h 5% ~1h', 'seven_day null: no 7d segment');
});

// Fallback semantics: when the picker finds no valid entry for a window (now invalid, or
// the only readings have an implausible / absent resets_at) it falls back to THIS session's
// own usage from the current payload, with NO countdown.

test('account-wide fallback: now invalid -> THIS session usage, no countdown (tracker ignored)', function () {
  const out = awBar(
    { session_id: 'C', context_window: { used_percentage: 33 },
      rate_limits: { five_hour: { used_percentage: 20, resets_at: AW_NOW + 3600 } } },
    [ { sid: 'X', line: '9999|99|' + (AW_NOW + 3600) + '|||' } ],
    'garbage');
  assert.strictEqual(out, 'ctx 33% | 5h 20%', 'now unset -> current session 20%, not tracker 99%, no countdown');
});

test('account-wide fallback: an implausible resets_at -> THIS session %, no countdown', function () {
  const out = awBar(
    { session_id: 'C', context_window: { used_percentage: 33 },
      rate_limits: { five_hour: { used_percentage: 20, resets_at: 12345 } } }, []);
  assert.strictEqual(out, 'ctx 33% | 5h 20%', 'implausible reset rejected by the picker; fall back to 20%, no countdown');
});

test('account-wide fallback: resets_at absent -> THIS session %, no countdown', function () {
  const out = awBar(
    { session_id: 'C', context_window: { used_percentage: 33 },
      rate_limits: { five_hour: { used_percentage: 20 } } }, []);
  assert.strictEqual(out, 'ctx 33% | 5h 20%', 'no reset -> plain 20%, no countdown');
});

test('account-wide: a single session with no other trackers renders normally', function () {
  const out = runEntry({ session_id: 'solo', context_window: { used_percentage: 48 },
    rate_limits: { five_hour: { used_percentage: 14, resets_at: AW_NOW + 4800 },
      seven_day: { used_percentage: 21, resets_at: AW_NOW + 470000 } } },
    { CCT_DIR: tmpDir(), CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(out, 'ctx 48% | 5h 14% ~1h20m | 7d 21% ~5d10h', 'single session picks its own reading');
});

// Regression tests for the pool hygiene (now over the tracker files).

test('account-wide: an unreadable or non-regular tracker file is SKIPPED, segment stays intact', function () {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'telemetry-rl2-adir'));      // a dir matching the glob (non-regular)
  // The chmod-000 "unreadable" case is POSIX-only: on Windows chmod is a no-op, so the file
  // would be readable and its 99% would legitimately enter the pool (and win: it sits on a NEWER
  // 5h boundary than this session's own reading, so it outranks it if it is ever read; that is
  // what makes this assertion able to fail). Exercise the unreadable sub-case only on POSIX; the
  // non-regular (directory) skip above is still exercised on every platform.
  const bad = path.join(dir, 'telemetry-rl2-bad');
  if (!IS_WIN) { fs.writeFileSync(bad, '2000|99|' + (AW_NOW + 7200) + '|||'); fs.chmodSync(bad, 0); }  // unreadable
  const out = runEntry({ session_id: 'C', context_window: { used_percentage: 33 },
    rate_limits: { five_hour: { used_percentage: 20, resets_at: AW_NOW + 3600 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  if (!IS_WIN) fs.chmodSync(bad, 0o644);  // restore so the temp entry is not left unreadable
  assert.strictEqual(out, 'ctx 33% | 5h 20% ~1h', 'bad tracker entries skipped, not fatal; this session (20%) shows');
});

test('account-wide: the tracker pool is NOT leaked to CCT_WRAP as positional args', function () {
  const dir = tmpDir();
  writeRl(dir, 'B', '2000|12|' + (AW_NOW + 3600) + '|||');
  const r = runEntry({ session_id: 'C', context_window: { used_percentage: 33 } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW), CCT_WRAP: 'printf "[argc=%s]" "$#"' });
  assert.strictEqual(r.stdout, 'ctx 33% | 5h 12% ~1h [argc=0]', 'CCT_WRAP sees no argv from the glob');
});

// ============================================================================
// (3d) SEGMENTS + MODEL: CCT_SEGMENTS is an ordered, comma/space list (default
// "ctx,5h,7d,model"); order = display order, presence = toggle, unknown ignored.
// The optional model segment is a short friendly token from model.id, sanitized.
// ============================================================================

const MDL_NOW = 1700000000;
function segBar(payload, segsEnv) {
  const dir = tmpDir();
  const env = { CCT_DIR: dir, CCT_NOW: String(MDL_NOW) };
  if (segsEnv !== undefined) env.CCT_SEGMENTS = segsEnv;
  return runEntry(payload, env).stdout;
}
function fullPayload() {
  return { session_id: 'M', context_window: { used_percentage: 48 },
    rate_limits: { five_hour: { used_percentage: 14, resets_at: MDL_NOW + 4800 },
      seven_day: { used_percentage: 21, resets_at: MDL_NOW + 470000 } },
    model: { id: 'claude-opus-4-8[1m]' } };
}
const FULL = 'ctx 48% | 5h 14% ~1h20m | 7d 21% ~5d10h | opus-4.8[1m]';

test('segments: default (unset) is ctx,5h,7d,model with model as a friendly token', function () {
  assert.strictEqual(segBar(fullPayload(), undefined), FULL);
});
test('segments: empty CCT_SEGMENTS falls back to the default', function () {
  assert.strictEqual(segBar(fullPayload(), ''), FULL);
});
test('segments: model OFF via CCT_SEGMENTS="ctx,5h,7d"', function () {
  assert.strictEqual(segBar(fullPayload(), 'ctx,5h,7d'), 'ctx 48% | 5h 14% ~1h20m | 7d 21% ~5d10h');
});
test('segments: order honored and segments droppable', function () {
  assert.strictEqual(segBar(fullPayload(), 'model,5h,7d'), 'opus-4.8[1m] | 5h 14% ~1h20m | 7d 21% ~5d10h');
  assert.strictEqual(segBar(fullPayload(), '5h'), '5h 14% ~1h20m');
});
test('segments: unknown tokens are ignored (fail-soft)', function () {
  assert.strictEqual(segBar(fullPayload(), 'ctx,bogus,5h'), 'ctx 48% | 5h 14% ~1h20m');
});
test('segments: model absent in the payload -> no model segment even if requested', function () {
  assert.strictEqual(segBar({ session_id: 'M', context_window: { used_percentage: 48 } }, 'ctx,model'), 'ctx 48%');
});

// NEVER-BLANK FALLBACK RESPECTS CCT_SEGMENTS (FIX 2): when nothing assembles and ctx was NOT
// requested, the fallback must NOT inject a "ctx --" the user excluded - it emits "<label> --"
// for the first requested ctx/5h/7d token, or a bare "--" if the list names none of those.

test('never-blank: CCT_SEGMENTS="5h" with nothing valid emits "5h --", NOT the excluded "ctx --"', function () {
  // The devil repro: only an ELAPSED 5h reading in the pool, and the payload has no rate_limits.
  const dir = tmpDir();
  writeRl(dir, 'A', '1000|80|' + (AW_NOW - 3600) + '|||');  // elapsed 5h -> excluded by the picker
  const out = runEntry(ctxOnly(50), { CCT_DIR: dir, CCT_NOW: String(AW_NOW), CCT_SEGMENTS: '5h' }).stdout;
  assert.strictEqual(out, '5h --', 'fallback labels the requested window, never a ctx the user dropped');
});

test('never-blank: CCT_SEGMENTS="7d" with nothing valid emits "7d --"', function () {
  const out = runEntry(ctxOnly(50), { CCT_DIR: tmpDir(), CCT_NOW: String(AW_NOW), CCT_SEGMENTS: '7d' }).stdout;
  assert.strictEqual(out, '7d --', 'requested 7d, nothing to show -> 7d --');
});

test('never-blank: CCT_SEGMENTS="model" with no model emits a bare "--" (no ctx/5h/7d to label)', function () {
  const out = runEntry(ctxOnly(50), { CCT_DIR: tmpDir(), CCT_NOW: String(AW_NOW), CCT_SEGMENTS: 'model' }).stdout;
  assert.strictEqual(out, '--', 'list names none of ctx/5h/7d -> bare --');
});

test('never-blank: CCT_SEGMENTS="model,7d" with nothing -> first labelable token wins -> "7d --"', function () {
  const out = runEntry(ctxOnly(50), { CCT_DIR: tmpDir(), CCT_NOW: String(AW_NOW), CCT_SEGMENTS: 'model,7d' }).stdout;
  assert.strictEqual(out, '7d --', 'model has no label; 7d is the first ctx/5h/7d in order');
});

test('never-blank: DEFAULT config still emits "ctx --" when ctx is requested-but-missing (unchanged)', function () {
  const out = runEntry({ session_id: 'M', context_window: { used_percentage: null } },
    { CCT_DIR: tmpDir(), CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(out, 'ctx --', 'default behavior preserved: ctx requested, missing -> ctx --');
});
test('model: friendly token strips claude- and dots the version', function () {
  function m(id) {
    return segBar({ session_id: 'M', context_window: { used_percentage: 5 }, model: { id: id } }, 'model');
  }
  assert.strictEqual(m('claude-opus-4-8'), 'opus-4.8');
  assert.strictEqual(m('claude-opus-4-8[1m]'), 'opus-4.8[1m]');
  assert.strictEqual(m('claude-fable-5'), 'fable-5');
  assert.strictEqual(m('claude-sonnet-4-5'), 'sonnet-4.5');
});
test('model: SECURITY - a hostile model id is sanitized (no ESC/control/pipe/space reaches output)', function () {
  const out = segBar({ session_id: 'M', context_window: { used_percentage: 5 },
    model: { id: 'claude-[31mEVIL|7d 99%' } }, 'ctx,model');
  assert.strictEqual(out.indexOf(''), -1, 'no ESC byte in output');
  assert.ok(/^ctx 5% \| [A-Za-z0-9._[\]-]+$/.test(out), 'model token is safe chars only: ' + JSON.stringify(out));
});

test('model: SECURITY - LC_ALL=C strips high / non-ASCII bytes (C1 range) deterministically', function () {
  const out = segBar({ session_id: 'M', context_window: { used_percentage: 5 },
    model: { id: 'claude-opusé-4-8' } }, 'ctx,model');  // U+009B (C1 CSI) + accented byte
  assert.ok(/^[\x20-\x7e]*$/.test(out), 'output is printable ASCII only: ' + JSON.stringify(out));
  assert.strictEqual(out, 'ctx 5% | opus-4.8', 'high bytes stripped, id still resolves');
});

test('round-trip 1M window', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-1m', context_window: { used_percentage: 10, context_window_size: 1000000 },
    rate_limits: { five_hour: { used_percentage: 5 } }, model: { id: 'claude-sonnet-4-5' } }, { CCT_DIR: dir });
  const t = api.readTelemetry('s-1m');
  assert.strictEqual(t.windowSize, 1000000);
  assert.strictEqual(t.fiveHourPct, 5);
  assert.strictEqual(t.sevenDayPct, undefined, '7d omitted when absent');
  delete process.env.CCT_DIR;
});

test('round-trip API-key payload WITHOUT rate_limits omits 5h/7d (never 0)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-api', context_window: { used_percentage: 60, context_window_size: 200000 },
    model: { id: 'claude-opus-4-1' } }, { CCT_DIR: dir });
  const t = api.readTelemetry('s-api');
  assert.strictEqual(t.fiveHourPct, undefined);
  assert.strictEqual(t.sevenDayPct, undefined);
  assert.strictEqual(t.contextPct, 60);
  delete process.env.CCT_DIR;
});

test('round-trip used_percentage null -> contextPct null, NOT fresh', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-null', context_window: { used_percentage: null, context_window_size: 200000 } }, { CCT_DIR: dir });
  const t = api.readTelemetry('s-null');
  assert.strictEqual(t.contextPct, null);
  assert.strictEqual(t.fresh, false, 'null context is never fresh');
  delete process.env.CCT_DIR;
});

test('round-trip MALFORMED payload -> raw file written, readTelemetry returns null (no throw)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  // No session_id in malformed text -> entry falls back to "default" (matching the JS
  // sanitizeId empty-id fallback, so a reader resolves the same filename).
  runEntry('not json at all <<<', { CCT_DIR: dir });
  assert.ok(fs.existsSync(path.join(dir, 'telemetry-raw-default.json')), 'raw still written');
  let threw = false, t;
  try { t = api.readTelemetry(''); } catch (e) { threw = true; }
  assert.strictEqual(threw, false, 'never throws on bad JSON');
  assert.strictEqual(t, null, 'unparseable raw -> null');
  delete process.env.CCT_DIR;
});

test('round-trip EMPTY stdin -> raw file empty, readTelemetry null', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry('', { CCT_DIR: dir });
  // shell empty-id fallback "default" matches JS sanitizeId('') -> "default".
  assert.strictEqual(api.readTelemetry(''), null);
  assert.ok(fs.existsSync(path.join(dir, 'telemetry-raw-default.json')), 'written under default');
  delete process.env.CCT_DIR;
});

test('round-trip partial payload (only session_id) -> contextPct null, fields null/omitted', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-partial' }, { CCT_DIR: dir });
  const t = api.readTelemetry('s-partial');
  assert.ok(t);
  assert.strictEqual(t.contextPct, null);
  assert.strictEqual(t.windowSize, null);
  assert.strictEqual(t.model, null);
  assert.strictEqual(t.fiveHourPct, undefined);
  delete process.env.CCT_DIR;
});

// ============================================================================
// (3) STANDALONE shell bar extraction (incl. NO emoji)
// ============================================================================

test('standalone bar: ctx + 5h + 7d, rounded, no emoji', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-bar', context_window: { used_percentage: 33.4 },
    rate_limits: { five_hour: { used_percentage: 9 }, seven_day: { used_percentage: 21 } } }, { CCT_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'ctx 33% | 5h 9% | 7d 21%');
  // No emoji: every byte is ASCII printable.
  assert.ok(/^[\x20-\x7e]*$/.test(r.stdout), 'bar is plain ASCII (no emoji)');
});

test('standalone bar: ctx rounds 47.6 -> 48', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-rnd', context_window: { used_percentage: 47.6 } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx 48%');
});

test('standalone bar: null used_percentage -> "ctx --"', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-bn', context_window: { used_percentage: null } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx --');
});

test('standalone bar: ctx present, NO rate_limits -> only ctx segment', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-bo', context_window: { used_percentage: 60, context_window_size: 200000 } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx 60%');
});

test('standalone bar: object scoping - rate_limits has pct but context_window does NOT (no leak)', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-scope', context_window: { context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 99 } } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx -- | 5h 99%', 'context % must not borrow the rate_limit value');
});

test('standalone bar: malformed/empty stdin -> "ctx --", exit 0', function () {
  const dir = tmpDir();
  assert.strictEqual(runEntry('not json {', { CCT_DIR: dir }).stdout, 'ctx --');
  assert.strictEqual(runEntry('', { CCT_DIR: dir }).stdout, 'ctx --');
});

// ============================================================================
// (3b) RESET COUNTDOWN: "~<time-left>" appended to 5h/7d from resets_at.
// DETERMINISTIC via the CCT_NOW seam (pins "now"); resets_at is now + secondsLeft, so
// every tier boundary is exercised without depending on the wall clock.
// ============================================================================

// Pinned epoch for all countdown tests (via CCT_NOW). Chosen realistic (~2023, well above
// the 1e9 plausible-epoch floor) so "reset just passed" cases (now - gap) stay above the
// floor and are excluded as elapsed/stale (falling back to plain %), matching real epochs.
const NOW = 1700000000;
// Build a payload with a fixed ctx% and optional 5h/7d limits at now+secondsLeft.
function limitsPayload(fiveLeft, sevenLeft) {
  const rl = {};
  if (fiveLeft !== undefined) rl.five_hour = { used_percentage: 44, resets_at: NOW + fiveLeft };
  if (sevenLeft !== undefined) rl.seven_day = { used_percentage: 31, resets_at: NOW + sevenLeft };
  return { session_id: 's-cd', context_window: { used_percentage: 51 }, rate_limits: rl };
}
function bar(fiveLeft, sevenLeft) {
  const dir = tmpDir();
  return runEntry(limitsPayload(fiveLeft, sevenLeft), { CCT_DIR: dir, CCT_NOW: String(NOW) }).stdout;
}
const DAY = 86400, HOUR = 3600, MIN = 60;

test('countdown: days+hours tier, trailing hours shown when non-zero (~6d23h)', function () {
  assert.strictEqual(bar(2 * HOUR + 54 * MIN, 6 * DAY + 23 * HOUR + 59 * MIN),
    'ctx 51% | 5h 44% ~2h54m | 7d 31% ~6d23h');
});
test('countdown: days+hours mid-window (~4d8h)', function () {
  assert.strictEqual(bar(undefined, 4 * DAY + 8 * HOUR).replace('ctx 51% | ', ''), '7d 31% ~4d8h');
});
test('countdown: exact day boundary drops the 0h (~5d, never ~5d0h)', function () {
  assert.strictEqual(bar(undefined, 5 * DAY), 'ctx 51% | 7d 31% ~5d');
});
test('countdown: last day switches to hours+minutes (~10h, minutes dropped at 0)', function () {
  assert.strictEqual(bar(undefined, 10 * HOUR), 'ctx 51% | 7d 31% ~10h');
});
test('countdown: hours+minutes tier, minutes zero-dropped (~2h, not ~2h0m)', function () {
  assert.strictEqual(bar(2 * HOUR, undefined), 'ctx 51% | 5h 44% ~2h');
});
test('countdown: hours+minutes with minutes (~2h54m)', function () {
  assert.strictEqual(bar(2 * HOUR + 54 * MIN, undefined), 'ctx 51% | 5h 44% ~2h54m');
});
test('countdown: bare minutes tier under 1h (~44m)', function () {
  assert.strictEqual(bar(44 * MIN, undefined), 'ctx 51% | 5h 44% ~44m');
});
test('countdown: under a minute -> ~<1m', function () {
  assert.strictEqual(bar(30, undefined), 'ctx 51% | 5h 44% ~<1m');
});
test('countdown: at reset (0s) -> reading excluded (elapsed), falls back to % with no countdown', function () {
  assert.strictEqual(bar(0, undefined), 'ctx 51% | 5h 44%');
});
test('countdown: past reset -> reading excluded (stale), falls back to % with no countdown', function () {
  assert.strictEqual(bar(-5 * HOUR, undefined), 'ctx 51% | 5h 44%');
});
test('countdown: implausible gap (>8d) is omitted, plain % stays', function () {
  assert.strictEqual(bar(9 * DAY, undefined), 'ctx 51% | 5h 44%');
});
// Per-window horizon caps: the 5h field must never render a multi-day countdown from a
// corrupt/foreign resets_at. 5h cap = 6h (21600s), 7d cap = 8d (691200s).
test('countdown: 5h horizon cap - a >6h 5h gap is omitted (no "~6d" on a five-hour field)', function () {
  assert.strictEqual(bar(6 * HOUR + 60, undefined), 'ctx 51% | 5h 44%');   // just over 6h -> omit
  assert.strictEqual(bar(6 * DAY + 22 * HOUR, undefined), 'ctx 51% | 5h 44%'); // the devil's ~6d22h case
});
test('countdown: 5h horizon cap - a 5h gap right at the window (5h) still shows', function () {
  assert.strictEqual(bar(5 * HOUR, undefined), 'ctx 51% | 5h 44% ~5h');
});
test('countdown: 7d horizon cap - exactly 8d shows, just over 8d omits', function () {
  assert.strictEqual(bar(undefined, 691200), 'ctx 51% | 7d 31% ~8d');
  assert.strictEqual(bar(undefined, 691201), 'ctx 51% | 7d 31%');
});
// Exact tier-crossing boundaries (the neighbors were tested; assert the crossings themselves).
test('countdown: exact tier boundaries (60s->~1m, 3600s->~1h, 86400s->~1d, 7d->~7d)', function () {
  assert.strictEqual(bar(60, undefined), 'ctx 51% | 5h 44% ~1m');
  assert.strictEqual(bar(59, undefined), 'ctx 51% | 5h 44% ~<1m');
  assert.strictEqual(bar(3600, undefined), 'ctx 51% | 5h 44% ~1h');
  assert.strictEqual(bar(undefined, 86400), 'ctx 51% | 7d 31% ~1d');
  assert.strictEqual(bar(undefined, 86399), 'ctx 51% | 7d 31% ~23h59m');
  assert.strictEqual(bar(undefined, 7 * DAY), 'ctx 51% | 7d 31% ~7d');
});
// Fail-soft on malformed resets_at (the devil's misparse cases): never fabricate, omit.
function rawBar(resetsAtLiteral) {
  const dir = tmpDir();
  const p = '{"session_id":"s-cd","context_window":{"used_percentage":51},"rate_limits":' +
    '{"five_hour":{"used_percentage":44,"resets_at":' + resetsAtLiteral + '}}}';
  return runEntry(p, { CCT_DIR: dir, CCT_NOW: String(NOW) }).stdout;
}
test('countdown: scientific-notation resets_at (1e12) is omitted, NOT fabricated as ~now', function () {
  assert.strictEqual(rawBar('1e12'), 'ctx 51% | 5h 44%');
});
test('countdown: string-valued resets_at ("...") is omitted (digit match blocked by quote)', function () {
  assert.strictEqual(rawBar('"' + (NOW + 2 * HOUR) + '"'), 'ctx 51% | 5h 44%');
});
test('countdown: negative resets_at is omitted (not misread as a positive)', function () {
  assert.strictEqual(rawBar('-5'), 'ctx 51% | 5h 44%');
});
test('countdown: below-epoch-floor resets_at (small int) is omitted, never ~now', function () {
  assert.strictEqual(rawBar('12345'), 'ctx 51% | 5h 44%');
});
test('countdown: resets_at ABSENT -> plain %, no countdown (never fabricated)', function () {
  const dir = tmpDir();
  const p = { session_id: 's-cd', context_window: { used_percentage: 51 },
    rate_limits: { five_hour: { used_percentage: 44 }, seven_day: { used_percentage: 31 } } };
  assert.strictEqual(runEntry(p, { CCT_DIR: dir, CCT_NOW: String(NOW) }).stdout,
    'ctx 51% | 5h 44% | 7d 31%');
});
test('countdown: resets_at null -> plain % (no match, omitted)', function () {
  const dir = tmpDir();
  const p = { session_id: 's-cd', context_window: { used_percentage: 51 },
    rate_limits: { five_hour: { used_percentage: 44, resets_at: null } } };
  assert.strictEqual(runEntry(p, { CCT_DIR: dir, CCT_NOW: String(NOW) }).stdout, 'ctx 51% | 5h 44%');
});
test('countdown: non-numeric CCT_NOW disables countdowns, plain % stays', function () {
  const dir = tmpDir();
  assert.strictEqual(runEntry(limitsPayload(2 * HOUR, 3 * DAY), { CCT_DIR: dir, CCT_NOW: 'garbage' }).stdout,
    'ctx 51% | 5h 44% | 7d 31%');
});
test('countdown: both 5h and 7d carry independent countdowns', function () {
  assert.strictEqual(bar(44 * MIN, 3 * DAY + 5 * HOUR),
    'ctx 51% | 5h 44% ~44m | 7d 31% ~3d5h');
});
test('countdown: object scoping - 5h resets_at must not leak into 7d', function () {
  const dir = tmpDir();
  // 7d has a pct but NO resets_at; 5h has one. 7d must stay plain, not borrow 5h.
  const p = { session_id: 's-cd', context_window: { used_percentage: 51 },
    rate_limits: { five_hour: { used_percentage: 44, resets_at: NOW + 2 * HOUR },
      seven_day: { used_percentage: 31 } } };
  assert.strictEqual(runEntry(p, { CCT_DIR: dir, CCT_NOW: String(NOW) }).stdout,
    'ctx 51% | 5h 44% ~2h | 7d 31%');
});

// ============================================================================
// (4) WRAP-MODE exec passthrough
// ============================================================================

// NEW WRAP BEHAVIOR: wrap mode PREPENDS the telemetry segment, then EXECs the wrapped
// command, so stdout = "<segment> " + wrapped-command-output (one line). The wrapped
// command still gets the EXACT payload on its stdin (fd3), and its exit code still
// propagates (exec). Each test below asserts the same real invariant it always did,
// now accounting for the segment prefix.
test('wrap mode PREPENDS the segment then EXECs CCT_WRAP, prints ITS bar, still writes raw telemetry', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  // ctx 5%, NO rate_limits -> segment is "ctx 5%"; wrap prints "MY-REAL-BAR" after it.
  const r = runEntry({ session_id: 'e-wrap', context_window: { used_percentage: 5, context_window_size: 200000 } },
    { CCT_DIR: dir, CCT_WRAP: "printf 'MY-REAL-BAR'" });
  assert.strictEqual(r.stdout, 'ctx 5% MY-REAL-BAR', 'segment prefix + verbatim wrapped output');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(api.readTelemetry('e-wrap').contextPct, 5, 'raw telemetry written under wrap');
  // No emoji: every byte is ASCII printable.
  assert.ok(/^[\x20-\x7e]*$/.test(r.stdout), 'wrap output is plain ASCII (no emoji)');
  delete process.env.CCT_DIR;
});

test('wrap mode propagates the wrapped command exit code (segment prepended)', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 'e-exit', context_window: { used_percentage: 1 } },
    { CCT_DIR: dir, CCT_WRAP: "sh -c \"printf BAR; exit 7\"" });
  assert.strictEqual(r.stdout, 'ctx 1% BAR', 'segment prefix + wrapped bar');
  assert.strictEqual(r.status, 7, 'wrapped exit code still propagates through exec');
});

test('wrap mode forwards the EXACT stdin payload to the wrapped command (after the segment prefix)', function () {
  const dir = tmpDir();
  const payload = '{"session_id":"e-stdin","context_window":{"used_percentage":2,"context_window_size":200000},"x":"keep me"}';
  // The wrapped command (cat) echoes its stdin. stdout = "<segment> " + that stdin, so
  // the stdin invariant is asserted by requiring stdout to END WITH the exact payload.
  const r = runEntry(payload, { CCT_DIR: dir, CCT_WRAP: 'cat' });
  assert.strictEqual(r.stdout, 'ctx 2% ' + payload, 'wrapped command got the exact stdin after the segment prefix');
  assert.ok(r.stdout.endsWith(payload), 'stdout ends with the exact, unmodified payload');
});

test('wrap mode with a QUOTED path + args execs it directly (the adtention shape), segment prepended', function () {
  const dir = tmpDir();
  const prog = path.join(dir, 'my status.sh'); // space in path -> must stay quoted
  fs.writeFileSync(prog, '#!/bin/sh\nprintf "arg=%s;" "$1"\ncat\n');
  fs.chmodSync(prog, 0o755);
  const payload = '{"session_id":"e-args","context_window":{"used_percentage":4,"context_window_size":200000}}';
  const r = runEntry(payload, { CCT_DIR: dir, CCT_WRAP: "'" + prog + "' TOKEN" });
  assert.strictEqual(r.stdout, 'ctx 4% arg=TOKEN;' + payload,
    'segment prefix, then quoted path honored, arg passed, exact stdin forwarded');
  assert.ok(r.stdout.endsWith(payload), 'exact payload forwarded on stdin (stdout ends with it)');
  process.env.CCT_DIR = dir;
  assert.strictEqual(api.readTelemetry('e-args').contextPct, 4, 'raw telemetry written');
  delete process.env.CCT_DIR;
});

// SEGMENT EXTRACTION (the bug class that cost a session): the awk objspan pass must read
// context % from a REAL-shaped context_window that nests current_usage BEFORE
// used_percentage, must NOT leak a sibling's value, and must never emit emoji.
test('segment: REAL-shaped context_window nests current_usage BEFORE used_percentage -> correct ctx', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-realshape',
    context_window: { current_usage: { input_tokens: 123, cache_read_input_tokens: 45 },
      used_percentage: 66.4, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 30 } } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx 66% | 5h 12% | 7d 30%',
    'ctx read past the nested current_usage; not blank, not the nested value');
  assert.ok(/^[\x20-\x7e]*$/.test(r.stdout), 'plain ASCII (no emoji)');
});

test('segment: NO-LEAK - context_window lacks used_percentage but rate_limits has one -> "ctx --", not the rate_limit value', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-noleak',
    context_window: { current_usage: { input_tokens: 1 }, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 77 } } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx -- | 5h 77%',
    'context % must NOT borrow the rate_limit value across the object boundary');
});

test('segment: 5h/7d come from rate_limits.five_hour / seven_day', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-rl', context_window: { used_percentage: 10, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 55 } } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx 10% | 5h 40% | 7d 55%');
});

test('segment: null used_percentage -> "ctx --"', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-segnull', context_window: { used_percentage: null, context_window_size: 200000 } }, { CCT_DIR: dir });
  assert.strictEqual(r.stdout, 'ctx --');
});

test('segment: full combined "ctx X% | 5h Y% | 7d Z% <wrapped>" in WRAP mode', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 's-segwrap',
    context_window: { current_usage: { x: 1 }, used_percentage: 66.4, context_window_size: 200000 },
    rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 30 } } },
    { CCT_DIR: dir, CCT_WRAP: 'printf WRAPPED' });
  assert.strictEqual(r.stdout, 'ctx 66% | 5h 12% | 7d 30% WRAPPED',
    'combined segment prefix then the wrapped bar on the same line');
  assert.ok(/^[\x20-\x7e]*$/.test(r.stdout), 'plain ASCII (no emoji)');
});

test('wrap mode that backgrounds (trailing &) does NOT hang the entry', function () {
  const dir = tmpDir();
  const r = runEntry({ session_id: 'e-bg', context_window: { used_percentage: 1 } },
    { CCT_DIR: dir, CCT_WRAP: "printf BG; sleep 1 &" });
  assert.strictEqual(r.signal, null, 'entry was not killed by the test timeout (did not hang)');
});

// ============================================================================
// (5) REGRESSION: exec (not spawn) - killing the entry tears down the wrapped
//     command. NOTHING orphans. (The pile-up fix, in a shell harness.)
// ============================================================================

// This asserts a strictly Unix process-model property: exec replaces the process so a
// SIGKILL to the entry tears down the wrapped command, and liveness is probed with
// `kill -9`/`kill -0`/`$!`. None of that (signals, exec-replacement semantics, PID
// probing) maps onto Windows, so it is SKIPPED there (visibly, counted), never faked.
(IS_WIN ? function () {
  skipTest('REGRESSION: killing the entry kills the EXECd wrapped command - no leak', 'Unix process model');
} : function () {
test('REGRESSION: killing the entry kills the EXECd wrapped command - no leak', function () {
  // A wrapped command records its pid then sleeps. Under the OLD spawn model the
  // wrapper spawned this DETACHED, so killing the wrapper (as Claude Code does every
  // render) left it alive -> a per-render pile-up. The exec model makes the wrapped
  // command BE the process, so killing the entry kills it. The liveness check runs in
  // a SHELL harness (shell reaps killed jobs cleanly; a Node poll would see a zombie
  // as "alive", a false leak).
  const dir = tmpDir();
  const pidfile = path.join(dir, 'wrapped.pid');
  const heavy = path.join(dir, 'heavy.sh');
  const payloadFile = path.join(dir, 'payload.json');
  const harness = path.join(dir, 'leakcheck.sh');
  fs.writeFileSync(heavy, '#!/bin/sh\necho "$$" > "' + pidfile + '"\nexec sleep 60\n');
  fs.writeFileSync(payloadFile, '{"session_id":"e-leak","context_window":{"used_percentage":1,"context_window_size":200000}}');
  fs.writeFileSync(harness,
    '#!/bin/sh\n' +
    'CCT_WRAP="' + heavy + '" CCT_DIR="' + dir + '" ' +
      '/bin/sh "' + ENTRY + '" < "' + payloadFile + '" >/dev/null 2>&1 &\n' +
    'sp=$!\n' +
    'sleep 1\n' +                                  // let it write telemetry + exec heavy
    'kill -9 "$sp" 2>/dev/null\n' +                // simulate Claude Code killing the statusline
    'sleep 1\n' +
    'hp=$(cat "' + pidfile + '" 2>/dev/null)\n' +
    'if [ -n "$hp" ] && kill -0 "$hp" 2>/dev/null; then echo LEAK; else echo OK; fi\n' +
    '[ -n "$hp" ] && kill -9 "$hp" 2>/dev/null\n' +  // belt-and-suspenders cleanup
    'exit 0\n');
  const r = spawnSync(SH, [harness], { encoding: 'utf8', timeout: 15000 });
  assert.ok(/\bOK\b/.test(r.stdout || ''), 'wrapped command torn down with the entry (NO leak); said: ' + JSON.stringify(r.stdout));
});
})();

// ============================================================================
// (6) SESSION_ID SANITIZATION: a hostile id cannot escape the dir (entry + api)
// ============================================================================

test('entry: hostile session_id "../../etc/evil" cannot escape CCT_DIR', function () {
  const dir = tmpDir();
  const escaped = path.resolve(dir, '..', '..', 'etc', 'evil.json');
  runEntry('{"session_id":"../../etc/evil","context_window":{"used_percentage":5}}', { CCT_DIR: dir });
  assert.strictEqual(fs.existsSync(escaped), false, 'no file outside the dir');
  const files = fs.readdirSync(dir).sort();
  assert.strictEqual(files.length, 2, 'exactly one raw file and its marker tracker');
  assert.ok(/^telemetry-raw-[A-Za-z0-9_-]+\.json$/.test(files[0]), 'sanitized name: ' + files[0]);
  assert.ok(/^telemetry-rl2-[A-Za-z0-9_-]+$/.test(files[1]), 'sanitized name: ' + files[1]);
  files.forEach(function (f) { assert.strictEqual(f.indexOf('/'), -1, 'no path separator in the name'); });
});

test('entry: slashed session_id "a/b/c" creates no nested dirs', function () {
  const dir = tmpDir();
  runEntry('{"session_id":"a/b/c","context_window":{"used_percentage":1}}', { CCT_DIR: dir });
  assert.strictEqual(fs.existsSync(path.join(dir, 'a')), false, 'no nested dir');
  assert.strictEqual(fs.readdirSync(dir).length, 2, 'the raw file and its marker tracker, both flat');
});

test('entry + api agree on the sanitized id for the SAME hostile input (round-trip)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  // Write via entry with a hostile id, then read it back via the api with the SAME
  // raw id: both must sanitize identically or the read would miss the file.
  runEntry('{"session_id":"a/b/c","context_window":{"used_percentage":7,"context_window_size":200000}}', { CCT_DIR: dir });
  const t = api.readTelemetry('a/b/c');
  assert.ok(t, 'entry and api sanitize the id identically');
  assert.strictEqual(t.contextPct, 7);
  delete process.env.CCT_DIR;
});

test('entry no-session-id write is readable via the JS empty-id fallback (both -> "default")', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  // Entry writes with NO session_id -> "default"; a hook reading with an empty/absent
  // id (JS sanitizeId -> "default") must resolve the SAME file, not miss it.
  runEntry('{"context_window":{"used_percentage":50,"context_window_size":200000}}', { CCT_DIR: dir });
  const t = api.readTelemetry('');
  assert.ok(t, 'shell "default" and JS "default" agree');
  assert.strictEqual(t.contextPct, 50);
  delete process.env.CCT_DIR;
});

test('api: empty session_id -> "default", hostile id contained (writeTelemetry path)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  const escaped = path.resolve(os.tmpdir(), 'evil.json');
  try { fs.unlinkSync(escaped); } catch (e) {}
  api.writeTelemetry('../../tmp/evil', { session_id: 'x', context_pct: 1, ts: api.nowIso() });
  assert.strictEqual(fs.existsSync(escaped), false);
  assert.strictEqual(api.readTelemetry('../../tmp/evil').contextPct, 1);
  delete process.env.CCT_DIR;
});

// ============================================================================
// (7) PRUNING (off the hot path, on the reader side)
// ============================================================================

test('pruneRaw deletes raw files older than the age cutoff, keeps fresh ones', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.ensureDir();
  const old = path.join(dir, 'telemetry-raw-old.json');
  const fresh = path.join(dir, 'telemetry-raw-fresh.json');
  fs.writeFileSync(old, '{}');
  fs.writeFileSync(fresh, '{}');
  // Backdate `old` two days; default age cutoff is 1 day.
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
  api.pruneRaw();
  assert.strictEqual(fs.existsSync(old), false, 'stale raw file pruned');
  assert.strictEqual(fs.existsSync(fresh), true, 'fresh raw file kept');
  delete process.env.CCT_DIR;
});

test('pruneRaw enforces the count cap, deleting the OLDEST first', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  process.env.CCT_PRUNE_MAX_FILES = '3';
  api.ensureDir();
  // 5 fresh raw files with staggered mtimes (i seconds ago); cap is 3 -> 2 oldest go.
  const base = Date.now();
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, 'telemetry-raw-s' + i + '.json');
    fs.writeFileSync(p, '{}');
    const t = (base - i * 1000) / 1000; // s0 newest, s4 oldest
    fs.utimesSync(p, t, t);
  }
  api.pruneRaw();
  const left = fs.readdirSync(dir).filter(function (f) { return f.indexOf('telemetry-raw-') === 0; }).sort();
  assert.strictEqual(left.length, 3, 'capped to 3');
  // s0,s1,s2 are newest -> kept; s3,s4 oldest -> pruned.
  assert.deepStrictEqual(left, ['telemetry-raw-s0.json', 'telemetry-raw-s1.json', 'telemetry-raw-s2.json']);
  delete process.env.CCT_PRUNE_MAX_FILES; delete process.env.CCT_DIR;
});

test('pruneRaw reclaims a STALE atomic-write .tmp leftover, keeps a fresh one', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.ensureDir();
  const staleTmp = path.join(dir, '.telemetry-raw-s.12345.tmp');
  const freshTmp = path.join(dir, '.telemetry-raw-s.67890.tmp');
  fs.writeFileSync(staleTmp, '{}');
  fs.writeFileSync(freshTmp, '{}');
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(staleTmp, twoDaysAgo, twoDaysAgo);
  api.pruneRaw();
  assert.strictEqual(fs.existsSync(staleTmp), false, 'stale crash-leftover .tmp reclaimed');
  assert.strictEqual(fs.existsSync(freshTmp), true, 'in-flight .tmp (fresh) NOT touched');
  delete process.env.CCT_DIR;
});

test('pruneRaw only touches telemetry-raw-* files, never others', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.ensureDir();
  const other = path.join(dir, 'unrelated.json');
  const legacy = path.join(dir, 'telemetry-s.json'); // legacy parsed file, NOT a raw file
  const raw = path.join(dir, 'telemetry-raw-x.json');
  fs.writeFileSync(other, 'keep');
  fs.writeFileSync(legacy, 'keep');
  fs.writeFileSync(raw, '{}');
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(other, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(legacy, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(raw, twoDaysAgo, twoDaysAgo);
  api.pruneRaw();
  assert.strictEqual(fs.existsSync(other), true, 'unrelated file untouched');
  assert.strictEqual(fs.existsSync(legacy), true, 'legacy parsed file untouched');
  assert.strictEqual(fs.existsSync(raw), false, 'stale raw file pruned');
  delete process.env.CCT_DIR;
});

// Trackers are pruned by their reset boundaries, not by age (index.js trackerExpired): an idle
// session's tracker keeps an old mtime, and deleting it would let that session's next render
// re-stamp an OLD reading with a NEW change-TS. pruneRaw reads the real clock (Date.now()), so the
// epochs below are relative to it; every "expired" one is at or before the moment it is computed.
function rlNow() { return Math.floor(Date.now() / 1000); }
function ageFile(p, sec) { const t = Date.now() / 1000 - sec; fs.utimesSync(p, t, t); }
function rlNames(dir) { return fs.readdirSync(dir).filter(function (f) { return f.indexOf('telemetry-rl2-') === 0; }).sort(); }

test('pruneRaw deletes an EXPIRED tracker (every reset at or before now) even with a fresh mtime', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  try {
    const n = rlNow();
    writeRl(dir, 'past', (n - 200) + '|5|' + (n - 100) + '|' + (n - 200) + '|30|' + (n - 50));
    writeRl(dir, 'atnow', (n - 200) + '|5|' + n + '|' + (n - 200) + '|30|' + n);
    writeRl(dir, 'past7only', (n - 200) + '|||' + (n - 200) + '|30|' + (n - 50));
    api.pruneRaw();
    assert.deepStrictEqual(rlNames(dir), [], 'all three expired trackers deleted although just written');
  } finally { delete process.env.CCT_DIR; }
});

test('pruneRaw KEEPS a tracker with any future reset whatever its mtime age (10 days idle)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  try {
    const n = rlNow(), T = n - 900000;
    writeRl(dir, 'both', T + '|5|' + (n + 3600) + '|' + T + '|30|' + (n + 86400));
    writeRl(dir, 'half', T + '|5|' + (n - 100) + '|' + T + '|30|' + (n + 86400));   // 5h elapsed, 7d future
    writeRl(dir, 'only7', T + '|||' + T + '|70|' + (n + 86400));                    // 7d-only (empty 5h pair)
    writeRl(dir, 'only5', T + '|5|' + (n + 3600) + '|' + T + '||');                 // 5h-only (empty 7d pair)
    ['both', 'half', 'only7', 'only5'].forEach(function (s) { ageFile(path.join(dir, 'telemetry-rl2-' + s), 10 * 86400); });
    api.pruneRaw();
    assert.deepStrictEqual(rlNames(dir),
      ['telemetry-rl2-both', 'telemetry-rl2-half', 'telemetry-rl2-only5', 'telemetry-rl2-only7'],
      'a still-current reading is never forgotten (an empty pair is not an expired one, one elapsed window is not all)');
  } finally { delete process.env.CCT_DIR; }
});

test('pruneRaw falls back to the AGE rule only for a tracker with no plausible reset epoch', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  try {
    const n = rlNow();
    // Garbage, an old 5-field line (fewer than 6 fields, even with a future epoch in it), sub-epoch
    // resets and a far-future reset: none parses, so each goes by mtime (default cutoff 1 day).
    // A reset more than 8 days out (beyond the picker 7d horizon) is corrupt too: it can never be
    // picked and must not keep its file alive until that date.
    const lines = { garbage: 'not a tracker', fivefield: '1000|5|' + (n + 3600) + '|34|' + (n + 86400),
      implausible: '1000|5|12345|1000|9|99', farfuture: '1000|||1000|9|' + (n + 30 * 86400) };
    Object.keys(lines).forEach(function (k) {
      writeRl(dir, k + '-old', lines[k]); ageFile(path.join(dir, 'telemetry-rl2-' + k + '-old'), 2 * 86400);
      writeRl(dir, k + '-new', lines[k]);
    });
    api.pruneRaw();
    assert.deepStrictEqual(rlNames(dir),
      ['telemetry-rl2-farfuture-new', 'telemetry-rl2-fivefield-new', 'telemetry-rl2-garbage-new', 'telemetry-rl2-implausible-new'],
      'unparseable trackers: the 2-day-old ones deleted, the fresh ones kept');
  } finally { delete process.env.CCT_DIR; }
});


// Run fn with Date.now pinned to ms, so pruneRaw's clock cannot drift past fixture epochs.
function withNow(ms, fn) { const o = Date.now; Date.now = function () { return ms; }; try { fn(); } finally { Date.now = o; } }
test('pruneRaw boundaries on a PINNED clock: reset == now is expired, reset == now+691200 keeps the file', function () {
  const dir = tmpDir(); const saved = process.env.CCT_DIR; process.env.CCT_DIR = dir;
  try {
    const N = 1800000000;
    writeRl(dir, 'atnow', (N - 200) + '|5|' + N + '|||');                   // only boundary == now: expired
    writeRl(dir, 'athorizon', (N - 200) + '|||' + (N - 200) + '|30|' + (N + 691200)); // exactly the 7d horizon: current
    const old = N - 2 * 86400; fs.utimesSync(path.join(dir, 'telemetry-rl2-athorizon'), old, old); // age rule would delete it
    fs.utimesSync(path.join(dir, 'telemetry-rl2-atnow'), N, N);              // age rule would keep it
    withNow(N * 1000, function () { api.pruneRaw(); });
    assert.deepStrictEqual(rlNames(dir), ['telemetry-rl2-athorizon'], 'at-now expired, at-horizon kept');
  } finally { if (saved === undefined) delete process.env.CCT_DIR; else process.env.CCT_DIR = saved; }
});
test('pruneRaw KEEPS a fresh tracker it cannot read (read error -> age rule, never delete)', function () {
  if (IS_WIN) { skipTest('pruneRaw unreadable tracker', 'chmod no-op'); return; }
  const dir = tmpDir(); const saved = process.env.CCT_DIR; process.env.CCT_DIR = dir;
  const p = path.join(dir, 'telemetry-rl2-locked');
  try {
    const n = Math.floor(Date.now() / 1000);
    writeRl(dir, 'locked', (n - 200) + '|5|' + (n + 3600) + '|||'); fs.chmodSync(p, 0);
    let readable = true; try { fs.closeSync(fs.openSync(p, 'r')); } catch (e) { readable = false; }
    if (readable) { fs.chmodSync(p, 0o644); skipTest('pruneRaw unreadable tracker', 'running as root: chmod 000 still readable'); return; }
    api.pruneRaw();
    assert.strictEqual(fs.existsSync(p), true, 'unreadable fresh tracker kept');
  } finally { try { fs.chmodSync(p, 0o644); } catch (e) {} if (saved === undefined) delete process.env.CCT_DIR; else process.env.CCT_DIR = saved; }
});
test('pruneRaw reads only the FIRST line: a trailing LF or CRLF does not hide the future 7d reset', function () {
  const dir = tmpDir(); const saved = process.env.CCT_DIR; process.env.CCT_DIR = dir;
  try {
    const N = 1800000000;
    writeRl(dir, 'nl', (N - 200) + '|5|' + (N - 100) + '|' + (N - 200) + '|30|' + (N + 86400) + '\n');
    writeRl(dir, 'crlf', (N - 200) + '|5|' + (N - 100) + '|' + (N - 200) + '|30|' + (N + 86400) + '\r\n');
    withNow(N * 1000, function () { api.pruneRaw(); });
    assert.deepStrictEqual(rlNames(dir), ['telemetry-rl2-crlf', 'telemetry-rl2-nl'], 'future 7d boundary keeps both');
  } finally { if (saved === undefined) delete process.env.CCT_DIR; else process.env.CCT_DIR = saved; }
});
test('picker: a sub-epoch resets_at is never picked, even when a broken clock puts it in the future', function () {
  const dir = tmpDir();
  writeRl(dir, 'X', '400|7|1000|400|9|2000');
  assert.strictEqual(runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: '500' }).stdout, 'ctx 33%', 'floor 1e9 rejects both');
});

test('pruneRaw caps trackers at CCT_PRUNE_MAX_RL (oldest first), independently of the raw cap', function () {
  const n = rlNow();
  const live = (n - 100) + '|5|' + (n + 3600) + '|' + (n - 100) + '|30|' + (n + 86400);
  function seed(dir, nRl, nRaw) {
    for (let i = 0; i < nRl; i++) { writeRl(dir, 's' + i, live); ageFile(path.join(dir, 'telemetry-rl2-s' + i), i); }
    for (let i = 0; i < nRaw; i++) {
      const p = path.join(dir, 'telemetry-raw-r' + i + '.json'); fs.writeFileSync(p, '{}'); ageFile(p, i);
    }
  }
  function rawNames(dir) { return fs.readdirSync(dir).filter(function (f) { return f.indexOf('telemetry-raw-') === 0; }).sort(); }
  const saved = { d: process.env.CCT_DIR, f: process.env.CCT_PRUNE_MAX_FILES, r: process.env.CCT_PRUNE_MAX_RL };
  try {
    // Tracker cap 2, raw cap at its default: the 2 newest trackers survive, every raw file survives.
    let dir = tmpDir(); process.env.CCT_DIR = dir;
    delete process.env.CCT_PRUNE_MAX_FILES; process.env.CCT_PRUNE_MAX_RL = '2';
    seed(dir, 4, 3);
    api.pruneRaw();
    assert.deepStrictEqual(rlNames(dir), ['telemetry-rl2-s0', 'telemetry-rl2-s1'], 'trackers capped to the 2 newest');
    assert.strictEqual(rawNames(dir).length, 3, 'raw pool untouched by the tracker cap');
    // Raw cap 2, tracker cap at its default: the raw pool is capped, every tracker survives.
    dir = tmpDir(); process.env.CCT_DIR = dir;
    process.env.CCT_PRUNE_MAX_FILES = '2'; delete process.env.CCT_PRUNE_MAX_RL;
    seed(dir, 4, 3);
    api.pruneRaw();
    assert.strictEqual(rlNames(dir).length, 4, 'trackers untouched by the raw cap');
    assert.deepStrictEqual(rawNames(dir), ['telemetry-raw-r0.json', 'telemetry-raw-r1.json'], 'raw capped to the 2 newest');
    // Defaults: the tracker cap is 200. 201 live trackers -> the single oldest (s200) goes.
    dir = tmpDir(); process.env.CCT_DIR = dir;
    delete process.env.CCT_PRUNE_MAX_FILES;
    seed(dir, 201, 0);
    api.pruneRaw();
    const left = rlNames(dir);
    assert.strictEqual(left.length, 200, 'the default tracker cap is 200');
    assert.strictEqual(left.indexOf('telemetry-rl2-s200'), -1, 'the oldest tracker is the one deleted');
    // Exactly 200 live trackers: all kept (the cap is inclusive).
    dir = tmpDir(); process.env.CCT_DIR = dir;
    seed(dir, 200, 0);
    api.pruneRaw();
    assert.strictEqual(rlNames(dir).length, 200, 'exactly 200 trackers: none deleted');
  } finally {
    ['CCT_DIR', 'CCT_PRUNE_MAX_FILES', 'CCT_PRUNE_MAX_RL'].forEach(function (k, i) {
      const v = [saved.d, saved.f, saved.r][i];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });
  }
});

test('pruneRaw reclaims a STALE telemetry-rl2-* atomic-write .tmp leftover', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  try {
    api.ensureDir();
    const staleTmp = path.join(dir, '.telemetry-rl2-s.12345.tmp');
    fs.writeFileSync(staleTmp, '1000|5|1700003600|||');
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleTmp, twoDaysAgo, twoDaysAgo);
    api.pruneRaw();
    assert.strictEqual(fs.existsSync(staleTmp), false, 'stale rl crash-leftover .tmp reclaimed');
  } finally { delete process.env.CCT_DIR; }
});

test('readTelemetry triggers throttled prune (stale raw files cleaned on a read)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.ensureDir();
  const stale = path.join(dir, 'telemetry-raw-stale.json');
  fs.writeFileSync(stale, '{}');
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
  // A read for some other (absent) session must still run the prune (no sentinel yet).
  api.readTelemetry('whatever');
  assert.strictEqual(fs.existsSync(stale), false, 'stale raw file pruned on read');
  delete process.env.CCT_DIR;
});

test('prune is THROTTLED: a fresh sentinel suppresses a second prune', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.ensureDir();
  // First read writes the sentinel and prunes. Now drop a stale file and read again:
  // within the throttle window the prune is suppressed, so the stale file survives.
  api.readTelemetry('seed'); // creates the sentinel
  const stale = path.join(dir, 'telemetry-raw-stale2.json');
  fs.writeFileSync(stale, '{}');
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
  api.readTelemetry('again'); // throttled: should NOT prune
  assert.strictEqual(fs.existsSync(stale), true, 'throttle suppressed the second prune');
  // Forcing a prune (or expiring the sentinel) then cleans it.
  api.pruneRaw();
  assert.strictEqual(fs.existsSync(stale), false, 'forced prune cleans it');
  delete process.env.CCT_DIR;
});

// ============================================================================
// (8) FRESHNESS (mtime-based for raw, ts-based for legacy) + TTL validation
// ============================================================================

test('readTelemetry on a raw file is fresh; stale-mtime raw is NOT fresh', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-fr', context_window: { used_percentage: 42, context_window_size: 200000 } }, { CCT_DIR: dir });
  assert.strictEqual(api.readTelemetry('s-fr').fresh, true);
  // Backdate the raw file beyond the TTL -> not fresh.
  const p = api.rawPath('s-fr');
  const old = (Date.now() - 10 * 60 * 1000) / 1000;
  fs.utimesSync(p, old, old);
  assert.strictEqual(api.readTelemetry('s-fr').fresh, false, 'stale mtime -> not fresh');
  delete process.env.CCT_DIR;
});

test('opts.ttlSec overrides the default TTL for a raw file', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  runEntry({ session_id: 's-ttl', context_window: { used_percentage: 1, context_window_size: 200000 } }, { CCT_DIR: dir });
  const p = api.rawPath('s-ttl');
  const t50 = (Date.now() - 50 * 1000) / 1000; // 50s old
  fs.utimesSync(p, t50, t50);
  assert.strictEqual(api.readTelemetry('s-ttl', { ttlSec: 30 }).fresh, false);
  assert.strictEqual(api.readTelemetry('s-ttl', { ttlSec: 120 }).fresh, true);
  delete process.env.CCT_DIR;
});

test('legacy writeTelemetry path still works (backward compat) - fresh/stale/future', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.writeTelemetry('L-fresh', { session_id: 'L-fresh', context_pct: 42, used_percentage: 42,
    context_window_size: 200000, model: 'm', ts: new Date().toISOString(), source: 'statusline' });
  assert.strictEqual(api.readTelemetry('L-fresh').fresh, true);
  api.writeTelemetry('L-stale', { session_id: 'L-stale', context_pct: 42,
    ts: new Date(Date.now() - 10 * 60 * 1000).toISOString(), source: 'statusline' });
  assert.strictEqual(api.readTelemetry('L-stale').fresh, false);
  api.writeTelemetry('L-future', { session_id: 'L-future', context_pct: 42,
    ts: new Date(Date.now() + 10 * 60 * 1000).toISOString(), source: 'statusline' });
  assert.strictEqual(api.readTelemetry('L-future').fresh, false);
  delete process.env.CCT_DIR;
});

test('readTelemetry returns null when nothing exists for the session', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  assert.strictEqual(api.readTelemetry('nope'), null);
  delete process.env.CCT_DIR;
});

test('raw file present but UNPARSEABLE -> null (does not fall back to a stale legacy file)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  api.ensureDir();
  // Both a corrupt raw file AND a (valid) legacy file for the same id: raw wins, and a
  // corrupt raw yields null rather than masking it with the legacy reading.
  fs.writeFileSync(api.rawPath('s-corrupt'), 'not json <<<');
  api.writeTelemetry('s-corrupt', { session_id: 's-corrupt', context_pct: 99, ts: api.nowIso() });
  assert.strictEqual(api.readTelemetry('s-corrupt'), null, 'corrupt raw -> null, legacy not used');
  delete process.env.CCT_DIR;
});

test('CCT_TTL_SEC="" / negative fall back to default 120 (legacy path)', function () {
  const dir = tmpDir(); process.env.CCT_DIR = dir;
  const ts = new Date(Date.now() - 50 * 1000).toISOString();
  process.env.CCT_TTL_SEC = '';
  api.writeTelemetry('s-b', { session_id: 's-b', context_pct: 3, ts: ts });
  assert.strictEqual(api.readTelemetry('s-b').fresh, true);
  process.env.CCT_TTL_SEC = '-5';
  api.writeTelemetry('s-n', { session_id: 's-n', context_pct: 3, ts: ts });
  assert.strictEqual(api.readTelemetry('s-n').fresh, true);
  delete process.env.CCT_TTL_SEC; delete process.env.CCT_DIR;
});

// ============================================================================
// (9) ON-DEMAND CLI READER (bin/telemetry.js)
// ============================================================================

test('CLI reader: prints pretty JSON for a session with telemetry (argv id)', function () {
  const dir = tmpDir();
  runEntry({ session_id: 's-cli', context_window: { used_percentage: 22, context_window_size: 200000 } }, { CCT_DIR: dir });
  const r = runReader(['s-cli'], { CCT_DIR: dir });
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.contextPct, 22);
  assert.strictEqual(parsed.source, 'statusline');
});

test('CLI reader: reads session_id from a hook-style stdin payload', function () {
  const dir = tmpDir();
  runEntry({ session_id: 's-cli2', context_window: { used_percentage: 8, context_window_size: 200000 } }, { CCT_DIR: dir });
  const r = runReader([], { CCT_DIR: dir }, '{"session_id":"s-cli2","tool_name":"Bash"}');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(JSON.parse(r.stdout).contextPct, 8);
});

test('CLI reader: "no telemetry for <id>" when absent, exit 0', function () {
  const dir = tmpDir();
  const r = runReader(['ghost'], { CCT_DIR: dir });
  assert.strictEqual(r.status, 0);
  assert.ok(/no telemetry for ghost/.test(r.stdout));
});

test('CLI reader: no id and no stdin payload -> usage on stderr, exit 1', function () {
  const dir = tmpDir();
  const r = runReader([], { CCT_DIR: dir }, '');
  assert.strictEqual(r.status, 1);
  assert.ok(/usage:/.test(r.stderr));
});

test('last-call time is used ONLY on first sighting (5h): a tracked 5h change is stamped now, not the old call time', function () {
  const dir = tmpDir();
  const R5 = AW_NOW + 3600;
  function p(u) { return { session_id: 'A5', context_window: { used_percentage: 33 },
    rate_limits: { five_hour: { used_percentage: u, resets_at: R5 } },
    prompt_cache: { ttl: '1h', expires_at: AW_NOW - 1000 + 3600 } }; }
  runEntry(p(10), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 990) });
  assert.strictEqual(rlFile(dir, 'A5'), (AW_NOW - 1000) + '|10|' + R5 + '|' + (AW_NOW - 1000) + '||', 'first sighting: call time');
  runEntry(p(14), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'A5'), AW_NOW + '|14|' + R5 + '|' + (AW_NOW - 1000) + '||', 'changed 5h: TS5 = now, TS7 kept');
});

test('last-call time: a seconds ttl ("300s") is parsed as seconds', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  runEntry({ session_id: 'S1', context_window: { used_percentage: 33 },
    rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } },
    prompt_cache: { ttl: '300s', expires_at: AW_NOW + 100 } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'S1'), (AW_NOW - 200) + '|||' + (AW_NOW - 200) + '|40|' + R7);
});

test('last-call time: expires_at / ttl inside a NESTED object of prompt_cache are ignored', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  runEntry({ session_id: 'N1', context_window: { used_percentage: 33 },
    rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } },
    prompt_cache: { inner: { expires_at: AW_NOW - 50000, ttl: '1h' }, ttl: '1h', expires_at: AW_NOW - 100 + 3600 } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'N1'), (AW_NOW - 100) + '|||' + (AW_NOW - 100) + '|40|' + R7);
});

test('last-call time: a ttl larger than expires_at (call time below any real epoch) is rejected: unknown, stamp 0', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  runEntry({ session_id: 'G1', context_window: { used_percentage: 33 },
    rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } },
    prompt_cache: { ttl: (AW_NOW + 5) + 's', expires_at: AW_NOW } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'G1'), '0|||0|40|' + R7);
});

test('an UNKNOWN stamp (0) stays unknown on an unchanged reading, even when a call time appears (a cancelled request)', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  // A 0-stamped reading may be a cached copy (a new session carrying its process cache). A request
  // that returns no new numbers (cancelled) moves the call time without measuring anything, so it
  // must not date the reading: Q (2%, a real measurement) must keep winning over the cached 73%.
  writeRl(dir, 'Q', (AW_NOW - 200) + '|||' + (AW_NOW - 200) + '|2|' + R7);
  const base = { session_id: 'S', context_window: { used_percentage: 33 }, rate_limits: { seven_day: { used_percentage: 73, resets_at: R7 } } };
  runEntry(base, { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 100) });
  assert.strictEqual(rlFile(dir, 'S'), '0|||0|73|' + R7, 'first sighting, unknown');
  const out = runEntry(pcPayload('S', 73, R7, AW_NOW - 10), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(rlFile(dir, 'S'), '0|||0|73|' + R7, 'still unknown');
  assert.strictEqual(out, 'ctx 33% | 7d 2% ~2d', 'the measured 2% keeps winning');
});

test('a CCT_DIR containing a NEWLINE still reads the tracker pool (per-file fallback scan)', function () {
  if (IS_WIN) { skipTest('newline CCT_DIR', 'Windows paths cannot contain a newline'); return; }
  const dir = path.join(tmpDir(), 'nl\ndir');
  fs.mkdirSync(dir);
  const R7 = AW_NOW + 2 * 86400;
  writeRl(dir, 'OTHER', (AW_NOW - 100) + '|||' + (AW_NOW - 100) + '|40|' + R7);
  assert.strictEqual(runEntry(ctxOnly(10), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout, 'ctx 10% | 7d 40% ~2d');
});



test('last-call time: a result that is positive but below any real epoch (huge ttl) is rejected: unknown, stamp 0', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  runEntry({ session_id: 'G2', context_window: { used_percentage: 33 },
    rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } },
    prompt_cache: { ttl: (AW_NOW - 500000000) + 's', expires_at: AW_NOW } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'G2'), '0|||0|40|' + R7, 'expires_at - ttl = 5e8 is not a call time');
});


// Hardening tests from the final mutation audit (each kills a mutant the rest of the suite let
// through: FIFO and glob-safe pool scan, CCT_WRAP globbing and IFS restored, same-second value
// changes, one-window adoption of the call time, first-line-only and closed pool reads, unit-less
// ttl, the 1e11 ceiling, and prune parsing). POSIX-only: FIFOs, ulimit and newline paths.
if (IS_WIN) { skipTest('mutation-audit hardening block', 'POSIX-only (FIFO, ulimit, newline paths)'); } else (function () {
  const NOW = 1700000000;
  const R5 = NOW + 3600, R7 = NOW + 2 * 86400;
  function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cct-test-')); }
  function run(payload, env, shPrefix) {
    const args = shPrefix ? ['-c', shPrefix + '; exec /bin/sh "$0"', ENTRY] : [ENTRY];
    return spawnSync('/bin/sh', args, {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8', timeout: 5000, env: Object.assign({}, process.env, env),
    });
  }
  function writeRl(dir, sid, line) { fs.writeFileSync(path.join(dir, 'telemetry-rl2-' + sid), line); }
  function rlFile(dir, sid) { return fs.readFileSync(path.join(dir, 'telemetry-rl2-' + sid), 'utf8'); }
  const ctx = { session_id: 'C', context_window: { used_percentage: 33 } };
  const env = function (dir, extra) { return Object.assign({ CCT_DIR: dir, CCT_NOW: String(NOW) }, extra || {}); };
  function withNow(ms, fn) { const o = Date.now; Date.now = function () { return ms; }; try { fn(); } finally { Date.now = o; } }

  // Kills S1 / N2 (no -f filter): a FIFO named telemetry-rl2-* passes -r but not -f; reading it blocks forever.
  test('S1/N2: a FIFO named telemetry-rl2-* is skipped and the render does not hang (normal and newline dir)', function () {
    [ 'plain', 'nl\ndir' ].forEach(function (sub) {
      const dir = path.join(tmpDir(), sub); fs.mkdirSync(dir);
      writeRl(dir, 'good', (NOW - 100) + '|||' + (NOW - 100) + '|40|' + R7);
      const mk = spawnSync('mkfifo', [path.join(dir, 'telemetry-rl2-fifo')], { timeout: 3000 });
      assert.strictEqual(mk.status, 0, 'mkfifo available');
      const r = run(ctx, env(dir));
      assert.strictEqual(r.error, undefined, 'entry did not time out (' + JSON.stringify(sub) + ')');
      assert.strictEqual(r.stdout, 'ctx 33% | 7d 40% ~2d');
    });
  });

  // Kills S6 (no set -f during the split): glob characters in CCT_DIR must not expand.
  test('S6: a CCT_DIR with glob characters is not expanded into sibling directories', function () {
    const base = tmpDir();
    const dir = path.join(base, 'a?'); const sib = path.join(base, 'ab');
    fs.mkdirSync(dir); fs.mkdirSync(sib);
    writeRl(dir, 'x', (NOW - 100) + '|||' + (NOW - 100) + '|40|' + R7);
    writeRl(sib, 'x', (NOW - 1) + '|||' + (NOW - 1) + '|99|' + (R7 + 60)); // would win if read
    assert.strictEqual(run(ctx, env(dir)).stdout, 'ctx 33% | 7d 40% ~2d');
  });

  // Kills S3 (set +f not restored): CCT_WRAP must see normal pathname expansion, as a direct statusLine does.
  test('S3: CCT_WRAP pathname expansion works as in a direct statusLine', function () {
    const dir = tmpDir(); const g = path.join(dir, 'globs'); fs.mkdirSync(g);
    fs.writeFileSync(path.join(g, 'g1'), ''); fs.writeFileSync(path.join(g, 'g2'), '');
    const r = run(ctx, env(dir, { CCT_WRAP: 'printf "[%s]" ' + g + '/g*' }));
    assert.strictEqual(r.stdout, 'ctx 33% [' + g + '/g1][' + g + '/g2]');
  });

  // Kills S4 (IFS not restored): CCT_WRAP unquoted expansions split on blanks, as in a direct statusLine.
  test('S4: CCT_WRAP field splitting uses the default IFS', function () {
    const dir = tmpDir();
    const r = run(ctx, env(dir, { CCT_WRAP: 'printf "[%s]" $CCTX', CCTX: 'a b' }));
    assert.strictEqual(r.stdout, 'ctx 33% [a][b]');
  });

  // Kills R5 / R4 (rewrite gated only by the stamp): a changed value in the SAME second must be stored.
  test('R5/R4: a value change within the same second as the stored stamp is still written', function () {
    const dir = tmpDir();
    writeRl(dir, 'S', NOW + '|5|' + R5 + '|' + NOW + '|30|' + R7);
    run({ session_id: 'S', context_window: { used_percentage: 1 },
      rate_limits: { five_hour: { used_percentage: 6, resets_at: R5 }, seven_day: { used_percentage: 30, resets_at: R7 } } }, env(dir));
    assert.strictEqual(rlFile(dir, 'S'), NOW + '|6|' + R5 + '|' + NOW + '|30|' + R7, '5h change kept');
    run({ session_id: 'S', context_window: { used_percentage: 1 },
      rate_limits: { five_hour: { used_percentage: 6, resets_at: R5 }, seven_day: { used_percentage: 31, resets_at: R7 } } }, env(dir));
    assert.strictEqual(rlFile(dir, 'S'), NOW + '|6|' + R5 + '|' + NOW + '|31|' + R7, '7d change kept');
  });

  // Kills A5 / A6: LC adoption for a stamp-0 window must be written even when only ONE window adopts.
  test('A5/A6: an unknown (0) stamp on either window stays 0 when unchanged, whatever the call time', function () {
    const dir = tmpDir(); const lc = NOW - 300;
    const pc = { ttl: '5m', expires_at: lc + 300 };
    const rl = { five_hour: { used_percentage: 5, resets_at: R5 }, seven_day: { used_percentage: 30, resets_at: R7 } };
    writeRl(dir, 'P', '0|5|' + R5 + '|' + (NOW - 900) + '|30|' + R7);
    run({ session_id: 'P', context_window: { used_percentage: 1 }, rate_limits: rl, prompt_cache: pc }, env(dir));
    assert.strictEqual(rlFile(dir, 'P'), '0|5|' + R5 + '|' + (NOW - 900) + '|30|' + R7, '5h stays 0');
    writeRl(dir, 'Q', (NOW - 900) + '|5|' + R5 + '|0|30|' + R7);
    run({ session_id: 'Q', context_window: { used_percentage: 1 }, rate_limits: rl, prompt_cache: pc }, env(dir));
    assert.strictEqual(rlFile(dir, 'Q'), (NOW - 900) + '|5|' + R5 + '|0|30|' + R7, '7d stays 0');
  });

  // Kills P24 (getline over all lines): only the FIRST line of a tracker is a reading.
  test('P24: a second line in a tracker is ignored even when it would win', function () {
    const dir = tmpDir();
    writeRl(dir, 'm', (NOW - 100) + '|||' + (NOW - 100) + '|40|' + R7 + '\n' + (NOW - 1) + '|||' + (NOW - 1) + '|99|' + (R7 + 60));
    assert.strictEqual(run(ctx, env(dir)).stdout, 'ctx 33% | 7d 40% ~2d');
  });

  // Kills P26 (no close): every pool file is closed after reading, so a pool larger than the fd limit is fully read.
  test('P26: a pool larger than the open-file limit is fully read (each tracker closed)', function () {
    const dir = tmpDir();
    for (let i = 0; i < 120; i++) {
      const id = 'f' + String(i).padStart(3, '0');
      const ts = (i === 110) ? NOW - 10 : NOW - 5000 + i; const u = (i === 110) ? 88 : 20;
      writeRl(dir, id, ts + '|||' + ts + '|' + u + '|' + R7);
    }
    const r = run(ctx, env(dir), 'ulimit -n 48');
    assert.strictEqual(r.stdout, 'ctx 33% | 7d 88% ~2d');
  });

  // Kills L15 (ttl regex loosened): a numeric or unit-less ttl is not a last-call time.
  test('L15: a ttl without a unit (numeric 300 or string "300") is rejected: first sighting stamped 0', function () {
    ['300', '"300"'].forEach(function (ttl, i) {
      const dir = tmpDir();
      run('{"session_id":"T","context_window":{"used_percentage":1},"rate_limits":{"seven_day":{"used_percentage":40,"resets_at":' + R7 +
        '}},"prompt_cache":{"ttl":' + ttl + ',"expires_at":' + (NOW - 100) + '}}', env(dir));
      assert.strictEqual(rlFile(dir, 'T'), '0|||0|40|' + R7, 'ttl ' + ttl);
    });
  });

  // Kills P18 (picker epoch ceiling removed): resets_at >= 1e11 is never picked, even with a matching clock.
  test('P18: a resets_at at or above 1e11 is never picked, even when now is near it', function () {
    const dir = tmpDir(); const N = 99999999000;
    writeRl(dir, 'h', (N - 100) + '|||' + (N - 100) + '|40|100000000100');
    assert.strictEqual(run(ctx, { CCT_DIR: dir, CCT_NOW: String(N) }).stdout, 'ctx 33%');
  });

  function rlNames(dir) { return fs.readdirSync(dir).filter(function (f) { return f.indexOf('telemetry-rl2-') === 0; }).sort(); }
  function withDir(fn) { const dir = tmpDir(); const s = process.env.CCT_DIR; process.env.CCT_DIR = dir;
    try { fn(dir); } finally { if (s === undefined) delete process.env.CCT_DIR; else process.env.CCT_DIR = s; } }

  // Kills X15 (unanchored digit regex): a reset field with trailing junk is not a plausible epoch.
  test('X15: a reset field with a trailing space is unparseable (age rule), not an expired epoch', function () {
    withDir(function (dir) {
      const N = 1800000000;
      writeRl(dir, 'sp', (N - 200) + '|5|' + (N - 100) + ' |||'); fs.utimesSync(path.join(dir, 'telemetry-rl2-sp'), N, N);
      withNow(N * 1000, function () { api.pruneRaw(); });
      assert.deepStrictEqual(rlNames(dir), ['telemetry-rl2-sp'], 'fresh mtime, unparseable -> kept');
    });
  });

  // X5 (prune ceiling removed) is EQUIVALENT: it needs a clock past ~1e11 (year 5138); ext4 cannot even
  // store such an mtime, so no fixture can be built.

  // Kills X21 (boundary rule applied to raw files): a fresh raw payload is never deleted by its content.
  test('X21: a fresh raw payload whose text looks like an expired tracker line is kept', function () {
    withDir(function (dir) {
      const N = 1800000000;
      const p = path.join(dir, 'telemetry-raw-s.json');
      fs.writeFileSync(p, '{"n":"a|b|' + (N - 100) + '|d|e|' + (N - 100) + '|"}');
      fs.utimesSync(p, N, N);
      withNow(N * 1000, function () { api.pruneRaw(); });
      assert.strictEqual(fs.existsSync(p), true);
    });
  });
})();


if (IS_WIN) { skipTest('closing-audit hardening block', 'POSIX-only'); } else (function () {
  const NOW = 1700000000, R5 = NOW + 3600, R7 = NOW + 2 * 86400;
  function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cct-test-')); }
  function run(p, env) { return spawnSync('/bin/sh', [ENTRY], { input: typeof p === 'string' ? p : JSON.stringify(p), encoding: 'utf8', timeout: 5000, env: Object.assign({}, process.env, env) }); }
  function writeRl(d, s, l) { fs.writeFileSync(path.join(d, 'telemetry-rl2-' + s), l); }
  function rl(d, s) { return fs.readFileSync(path.join(d, 'telemetry-rl2-' + s), 'utf8'); }
  function pc(lc) { return { ttl: '1h', expires_at: lc + 3600 }; }
  function withNow(ms, fn) { const o = Date.now; Date.now = function () { return ms; }; try { fn(); } finally { Date.now = o; } }
  test('K-C2: a last-call time of exactly 1e9 is accepted (floor is inclusive)', function () {
    const d = tmpDir();
    run({ session_id: 'F', context_window: { used_percentage: 1 }, rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } },
      prompt_cache: { ttl: '1h', expires_at: 1000003600 } }, { CCT_DIR: d, CCT_NOW: String(NOW) });
    assert.strictEqual(rl(d, 'F'), '1000000000|||1000000000|40|' + R7);
  });

  // K-C6: lastcall() must print an integer even past 2^31 (2038+) under mawk, whose default number
  // output for an integral value above 2^31-1 is %.6g ("2.2e+09"). Skipped (visibly) without mawk.
  test('K-C6: under mawk a post-2038 last-call time is written as an integer, not 2.2e+09', function () {
    const mawk = ['/usr/bin/mawk', '/bin/mawk', '/usr/local/bin/mawk'].filter(function (p) { return fs.existsSync(p); })[0];
    if (!mawk) { skipTest('K-C6 inner', 'mawk not installed'); return; }
    const shim = tmpDir(); fs.symlinkSync(mawk, path.join(shim, 'awk'));
    const N = 2200000000, d = tmpDir();
    const r = run({ session_id: 'B', context_window: { used_percentage: 1 }, rate_limits: { seven_day: { used_percentage: 40, resets_at: N + 86400 } },
      prompt_cache: pc(N - 1000) }, { CCT_DIR: d, CCT_NOW: String(N), PATH: shim + ':' + process.env.PATH });
    assert.strictEqual(rl(d, 'B'), (N - 1000) + '|||' + (N - 1000) + '|40|' + (N + 86400));
    assert.strictEqual(r.stdout, 'ctx 1% | 7d 40% ~1d');
  });

  // K-N7: the empty marker is written only when NOTHING exists at the tracker path. A non-file there
  // (here a directory: a foreign/hand-made fixture, not something the writer produces) is left alone.
  test('K-N7: a directory at the tracker path is not written into by the marker branch', function () {
    const d = tmpDir(); fs.mkdirSync(path.join(d, 'telemetry-rl2-C'));
    const r = run({ session_id: 'C', context_window: { used_percentage: 33 } }, { CCT_DIR: d, CCT_NOW: String(NOW) });
    assert.strictEqual(r.stdout, 'ctx 33%');
    assert.deepStrictEqual(fs.readdirSync(path.join(d, 'telemetry-rl2-C')), [], 'nothing moved into the directory');
  });

  // K-P2: pool files are read only via getline, never as awk main input (so a vanished tracker is not
  // FATAL and a tracker's bytes never join the payload text J). Proxy fixture (hand-made, corrupt
  // tracker containing JSON keys): its text must not supply ctx/model to a payload lacking them.
  test('K-P2: a corrupt tracker containing JSON keys never leaks into the per-session ctx/model', function () {
    const d = tmpDir();
    writeRl(d, 'junk', '{"context_window":{"used_percentage":99},"model":{"id":"claude-evil-9"}}');
    const r = run({ session_id: 'C' }, { CCT_DIR: d, CCT_NOW: String(NOW) });
    assert.strictEqual(r.stdout, 'ctx --');
  });

  // K-V7: a render with rate_limits but no valid clock writes no tracker (no stamp can be trusted).
  test('K-V7: no valid now -> a rate_limits render writes no tracker', function () {
    const d = tmpDir();
    run({ session_id: 'G', context_window: { used_percentage: 1 }, rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } }, { CCT_DIR: d, CCT_NOW: 'garbage' });
    assert.strictEqual(fs.existsSync(path.join(d, 'telemetry-rl2-G')), false);
  });

  // K-X12: the raw age rule is strict: an mtime exactly AT the cutoff is kept (pinned clock).
  test('K-X12: a raw file whose mtime is exactly the age cutoff is kept (pinned clock)', function () {
    const d = tmpDir(); const s = process.env.CCT_DIR; process.env.CCT_DIR = d;
    try {
      const N = 1800000000, p = path.join(d, 'telemetry-raw-edge.json');
      fs.writeFileSync(p, '{}'); fs.utimesSync(p, N - 86400, N - 86400);
      withNow(N * 1000, function () { api.pruneRaw(); });
      assert.strictEqual(fs.existsSync(p), true);
    } finally { if (s === undefined) delete process.env.CCT_DIR; else process.env.CCT_DIR = s; }
  });
})();


test('a CORRUPT tracker (stamps, extra fields) never breaks the render or the wrapped bar', function () {
  const dir = tmpDir();
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 2 * 86400;
  ['-5x', '-1e5', '-99999999999999999999', 'zz'].forEach(function (bad, k) {
    const sid = 'X' + k;
    writeRl(dir, sid, bad + '|10|' + R5 + '|' + bad + '|20|' + R7 + '|100');
    const p = { session_id: sid, context_window: { used_percentage: 7 },
      rate_limits: { five_hour: { used_percentage: 10, resets_at: R5 }, seven_day: { used_percentage: 20, resets_at: R7 } },
      cost: { total_api_duration_ms: 500 } };
    const r = runEntry(p, { CCT_DIR: dir, CCT_NOW: String(AW_NOW), CCT_WRAP: 'echo WRAPPED' });
    assert.strictEqual(r.status, 0, 'exit 0 with stamp ' + bad);
    assert.ok(/WRAPPED/.test(r.stdout) && /^ctx 7%/.test(r.stdout), 'segment and wrapped bar: ' + JSON.stringify(r.stdout));
  });
  writeRl(dir, 'Y', AW_NOW + '|10|' + R5 + '|' + AW_NOW + '|20|' + R7 + '|99999999999999999999999');
  const r = runEntry({ session_id: 'Y', context_window: { used_percentage: 7 },
    rate_limits: { five_hour: { used_percentage: 11, resets_at: R5 }, seven_day: { used_percentage: 20, resets_at: R7 } },
    cost: { total_api_duration_ms: 500 } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW), CCT_WRAP: 'echo WRAPPED' });
  assert.strictEqual(r.status, 0, 'an oversized extra field: still renders');
  assert.ok(/WRAPPED/.test(r.stdout));
});



test('a resumed session (no rate_limits until its first request) has its first fresh reading stamped NOW', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  function pay(u, api) { const p = { session_id: 'S', context_window: { used_percentage: 33 }, cost: { total_api_duration_ms: api } };
    if (u != null) p.rate_limits = { seven_day: { used_percentage: u, resets_at: R7 } }; return p; }
  runEntry(pay(null, 0), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 3000) });
  runEntry(pay(30, 50000), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 2000) });
  writeRl(dir, 'A', (AW_NOW - 1000) + '|||' + (AW_NOW - 1000) + '|32|' + R7);
  runEntry(pay(null, 0), { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 100) });     // resumed: no rate_limits yet
  // First request after resume: mid-stream render, its own counter restarted and still small.
  const out = runEntry(pay(35, 1200), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(rlFile(dir, 'S'), (AW_NOW - 3000) + '|||' + AW_NOW + '|35|' + R7, 'measured now');
  assert.strictEqual(out, 'ctx 33% | 7d 35% ~2d', 'the fresh 35% beats the older 32%');
});

test('a session first request (numbers mid-stream, cost counter still 0) is stamped NOW after its marker', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  writeRl(dir, 'B', (AW_NOW - 500) + '|||' + (AW_NOW - 500) + '|40|' + R7);
  runEntry({ session_id: 'N', context_window: { used_percentage: 3 }, cost: { total_api_duration_ms: 0 } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW - 60) });
  const out = runEntry({ session_id: 'N', context_window: { used_percentage: 3 }, cost: { total_api_duration_ms: 0 },
    rate_limits: { seven_day: { used_percentage: 41, resets_at: R7 } } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(out, 'ctx 3% | 7d 41% ~2d', 'the fresh 41% wins');
});


test('no valid now: BOTH windows fall back to this session own usage (never a pool value), no countdown', function () {
  const dir = tmpDir();
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 2 * 86400;
  writeRl(dir, 'POOL', (AW_NOW - 10) + '|90|' + R5 + '|' + (AW_NOW - 10) + '|90|' + R7);
  const out = runEntry({ session_id: 'OWN', context_window: { used_percentage: 5 },
    rate_limits: { five_hour: { used_percentage: 10, resets_at: R5 }, seven_day: { used_percentage: 20, resets_at: R7 } } },
    { CCT_DIR: dir, CCT_NOW: 'garbage' }).stdout;
  assert.strictEqual(out, 'ctx 5% | 5h 10% | 7d 20%', 'own values, no pool, no countdown');
});


test('an exact stamp tie (several first sightings of unknown time) prefers THIS session own reading, in either filename order', function () {
  const R7 = AW_NOW + 2 * 86400;
  [['A', 'Z'], ['Z', 'A']].forEach(function (o) {
    const dir = tmpDir();
    writeRl(dir, o[0] === 'A' ? 'AOTHER' : 'ZOTHER', '0|||0|30|' + R7);
    const out = runEntry({ session_id: 'M', context_window: { used_percentage: 5 },
      rate_limits: { seven_day: { used_percentage: 35, resets_at: R7 } } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
    assert.strictEqual(rlFile(dir, 'M'), '0|||0|35|' + R7, 'own first sighting, unknown time');
    assert.strictEqual(out, 'ctx 5% | 7d 35% ~2d', 'own reading wins the 0-0 tie (other file sorts ' + (o[0] === 'A' ? 'first' : 'last') + ')');
  });
});


test('a pre-1.4.8 tracker (telemetry-rl-*) is never read: its stamps are not measurement times', function () {
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  fs.writeFileSync(path.join(dir, 'telemetry-rl-OLD'), (AW_NOW - 5) + '|||' + (AW_NOW - 5) + '|60|' + R7);
  writeRl(dir, 'NEW', (AW_NOW - 500) + '|||' + (AW_NOW - 500) + '|74|' + R7);
  assert.strictEqual(runEntry(ctxOnly(33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout, 'ctx 33% | 7d 74% ~2d',
    'the old file, though stamped newer, is ignored');
});

test('pruneRaw deletes every pre-1.4.8 tracker (telemetry-rl-*, never read again) and leaves look-alike names alone', function () {
  const dir = tmpDir(); const saved = process.env.CCT_DIR; process.env.CCT_DIR = dir;
  try {
    const n = Math.floor(Date.now() / 1000);
    fs.writeFileSync(path.join(dir, 'telemetry-rl-EXPIRED'), (n - 900) + '|||' + (n - 900) + '|40|' + (n - 50));
    fs.writeFileSync(path.join(dir, 'telemetry-rl-LIVE'), (n - 900) + '|||' + (n - 900) + '|40|' + (n + 86400));
    fs.writeFileSync(path.join(dir, 'telemetry-rl2-x.bak'), 'not ours');
    fs.writeFileSync(path.join(dir, 'telemetry-rl-y.bak'), 'not ours either');
    writeRl(dir, 'KEEP', (n - 900) + '|||' + (n - 900) + '|40|' + (n + 86400));
    api.pruneRaw();
    assert.deepStrictEqual(fs.readdirSync(dir).filter(function (f) { return f.indexOf('telemetry-rl') === 0; }).sort(),
      ['telemetry-rl-y.bak', 'telemetry-rl2-KEEP', 'telemetry-rl2-x.bak'], 'legacy trackers gone, look-alikes and current kept');
  } finally { if (saved === undefined) delete process.env.CCT_DIR; else process.env.CCT_DIR = saved; }
});


// Release-candidate rigor additions: prune horizon boundaries on a pinned clock, the tracker
// glob never matching raw payloads (normal and newline CCT_DIR), an unreadable own tracker
// treated as a first sighting, and no rewrite for an unchanged reading without a 7d reset.
(function () {
  function run(p, env) { return spawnSync('/bin/sh', [ENTRY], { input: JSON.stringify(p), encoding: 'utf8', timeout: 10000, env: Object.assign({}, process.env, env) }); }
  function writeRl(dir, sid, line) { fs.writeFileSync(path.join(dir, 'telemetry-rl2-' + sid), line); }
  function rl(dir, sid) { return fs.readFileSync(path.join(dir, 'telemetry-rl2-' + sid), 'utf8'); }
  function withNow(ms, fn) { const o = Date.now; Date.now = function () { return ms; }; try { fn(); } finally { Date.now = o; } }
  function names(dir) { return fs.readdirSync(dir).filter(function (f) { return f.indexOf('telemetry-rl2-') === 0; }).sort(); }
  const N = 1800000000, NOW = 1700000000;

  // K1 kills PR24 (horizon widened): a reset 1s past the 8-day horizon is corrupt -> age rule.
  // K2 kills PR27 (expiry tolerance): a reset 30s in the future is current, kept despite old mtime.
  test('K1/K2 prune horizon+1 is unparseable (age rule); reset at now+30 is current', function () {
    const dir = tmpDir(); process.env.CCT_DIR = dir;
    try {
      writeRl(dir, 'beyond', (N - 200) + '|||' + (N - 200) + '|30|' + (N + 691201));
      writeRl(dir, 'soon', (N - 200) + '|5|' + (N + 30) + '|||');
      ['beyond', 'soon'].forEach(function (s) { const t = N - 2 * 86400; fs.utimesSync(path.join(dir, 'telemetry-rl2-' + s), t, t); });
      withNow(N * 1000, function () { api.pruneRaw(); });
      assert.deepStrictEqual(names(dir), ['telemetry-rl2-soon']);
    } finally { delete process.env.CCT_DIR; }
  });

  // K3 kills SC11/SC12 (glob widened to telemetry-r*): a raw payload whose single line holds
  // "|99|<R5>|" must never be read as a tracker.
  test('K3 the picker pool is telemetry-rl2-* only (a raw payload with pipes is not a tracker)', function () {
    if (IS_WIN) { skipTest('K3', 'spawns /bin/sh directly'); return; }
    const dir = tmpDir(); const R5 = NOW + 3600;
    fs.writeFileSync(path.join(dir, 'telemetry-raw-Z.json'), '{"session_id":"Z","n":"|99|' + R5 + '|0|0|0"}');
    const out = run({ session_id: 'C', context_window: { used_percentage: 5 } }, { CCT_DIR: dir, CCT_NOW: String(NOW) }).stdout;
    assert.strictEqual(out, 'ctx 5%');
  });

  test('K3b same, in a CCT_DIR containing a newline (per-file branch)', function () {
    if (IS_WIN) { skipTest('K3b', 'a newline in a path is POSIX only'); return; }
    const dir = path.join(tmpDir(), 'a\nb'); fs.mkdirSync(dir); const R5 = NOW + 3600;
    fs.writeFileSync(path.join(dir, 'telemetry-raw-Z.json'), '{"session_id":"Z","n":"|99|' + R5 + '|0|0|0"}');
    const out = run({ session_id: 'C', context_window: { used_percentage: 5 } }, { CCT_DIR: dir, CCT_NOW: String(NOW) }).stdout;
    assert.strictEqual(out, 'ctx 5%');
  });

  // K4 kills WR02 (-r dropped on the writer read): an unreadable existing tracker is a first
  // sighting (stamp 0 without LC), never a change stamped now.
  test('K4 unreadable own tracker: rewritten as a first sighting (stamp 0), not now', function () {
    if (IS_WIN) { skipTest('K4', 'POSIX chmod'); return; }
    const dir = tmpDir(); const p = path.join(dir, 'telemetry-rl2-U');
    writeRl(dir, 'U', (NOW - 500) + '|10|' + (NOW + 3600) + '|' + (NOW - 500) + '|20|' + (NOW + 86400)); fs.chmodSync(p, 0);
    let readable = true; try { fs.closeSync(fs.openSync(p, 'r')); } catch (e) { readable = false; }
    if (readable) { fs.chmodSync(p, 0o644); skipTest('K4', 'running as root: chmod 000 still readable'); return; }
    run({ session_id: 'U', rate_limits: { five_hour: { used_percentage: 11, resets_at: NOW + 3600 } } }, { CCT_DIR: dir, CCT_NOW: String(NOW) });
    fs.chmodSync(p, 0o644);
    assert.strictEqual(rl(dir, 'U'), '0|11|' + (NOW + 3600) + '|0||');
  });

  // K5 kills WR31 (non-digit p5 classed as old format): a 7d reading with a decimal usage and no
  // resets_at is a producible 6-field line ending in "|"; an unchanged render must not rewrite it.
  test('K5 unchanged render with a decimal 7d usage and no 7d reset: no rewrite', function () {
    if (IS_WIN) { skipTest('K5', 'inode check'); return; }
    const dir = tmpDir(); const p = { session_id: 'D', rate_limits: { five_hour: { used_percentage: 1, resets_at: NOW + 3600 }, seven_day: { used_percentage: 42.5 } } };
    run(p, { CCT_DIR: dir, CCT_NOW: String(NOW) });
    const before = rl(dir, 'D'); const ino = fs.statSync(path.join(dir, 'telemetry-rl2-D')).ino;
    assert.strictEqual(before, '0|1|' + (NOW + 3600) + '|0|42.5|');
    run(p, { CCT_DIR: dir, CCT_NOW: String(NOW + 100) });
    assert.strictEqual(fs.statSync(path.join(dir, 'telemetry-rl2-D')).ino, ino, 'not rewritten');
  });
})();


// TRANSCRIPT time for a first sighting without prompt_cache (older Claude Code): the last top-level
// assistant entry in the transcript tail. Lines are shaped like real Claude Code transcript lines
// (top-level "type" and "timestamp" after the nested message object).
function txLine(type, iso) {
  return JSON.stringify({ parentUuid: 'p', isSidechain: false,
    message: { role: type === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: 'x' }] },
    type: type, uuid: 'u', timestamp: iso, sessionId: 's', version: '2.1.220' });
}
function isoOf(sec) { return new Date(sec * 1000).toISOString(); }
test('first sighting without prompt_cache takes the transcript last ASSISTANT time (later user/system entries ignored)', function () {
  if (IS_WIN) { skipTest('transcript time', 'Windows paths contain backslashes, which the fallback does not read'); return; }
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  const tp = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(tp, [txLine('user', isoOf(AW_NOW - 9000)), txLine('assistant', isoOf(AW_NOW - 8000)),
    txLine('user', isoOf(AW_NOW - 700)), txLine('assistant', isoOf(AW_NOW - 600)), txLine('system', isoOf(AW_NOW - 10))].join('\n') + '\n');
  runEntry({ session_id: 'T', transcript_path: tp, context_window: { used_percentage: 3 },
    rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'T'), (AW_NOW - 600) + '|||' + (AW_NOW - 600) + '|40|' + R7, 'stamped with the last response time');
});
test('transcript time: none, no assistant entry, garbage, or in the future -> unknown (0); prompt_cache wins when present; tracked sessions unaffected', function () {
  if (IS_WIN) { skipTest('transcript', 'Windows paths contain backslashes, which the fallback does not read'); return; }
  const R7 = AW_NOW + 2 * 86400;
  function first(tpBody, extra) {
    const dir = tmpDir(); const tp = path.join(dir, 't.jsonl');
    if (tpBody != null) fs.writeFileSync(tp, tpBody);
    runEntry(Object.assign({ session_id: 'T', transcript_path: tp, context_window: { used_percentage: 3 },
      rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } }, extra || {}), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
    return rlFile(dir, 'T');
  }
  assert.strictEqual(first(null), '0|||0|40|' + R7, 'no transcript file');
  assert.strictEqual(first(txLine('user', isoOf(AW_NOW - 50)) + '\n'), '0|||0|40|' + R7, 'no assistant entry');
  assert.strictEqual(first(txLine('assistant', isoOf(AW_NOW + 500)) + '\n'), '0|||0|40|' + R7, 'assistant time in the future');
  assert.strictEqual(first('garbage line\n'), '0|||0|40|' + R7, 'garbage');
  assert.strictEqual(first(txLine('assistant', isoOf(AW_NOW - 600)) + '\n', { prompt_cache: { ttl: '1h', expires_at: AW_NOW - 100 + 3600 } }),
    (AW_NOW - 100) + '|||' + (AW_NOW - 100) + '|40|' + R7, 'prompt_cache time preferred');
  const dir = tmpDir(); const tp = path.join(dir, 't.jsonl');
  fs.writeFileSync(tp, txLine('assistant', isoOf(AW_NOW - 600)) + '\n');
  writeRl(dir, 'T', (AW_NOW - 900) + '|||' + (AW_NOW - 900) + '|39|' + R7);
  runEntry({ session_id: 'T', transcript_path: tp, context_window: { used_percentage: 3 },
    rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'T'), (AW_NOW - 900) + '|||' + AW_NOW + '|40|' + R7, 'tracked change: now');
});
test('the transcript read is bounded: only its last 256 KB are scanned', function () {
  if (IS_WIN) { skipTest('transcript', 'Windows paths contain backslashes, which the fallback does not read'); return; }
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  const tp = path.join(dir, 'big.jsonl');
  const filler = txLine('user', isoOf(AW_NOW - 100)) + '\n';
  let body = txLine('assistant', isoOf(AW_NOW - 7000)) + '\n';
  while (body.length < 300000) body += filler;
  fs.writeFileSync(tp, body);
  runEntry({ session_id: 'B', transcript_path: tp, context_window: { used_percentage: 3 },
    rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'B'), '0|||0|40|' + R7, 'an assistant entry before the last 256 KB is not seen: unknown');
});
test('a corrupt or FUTURE stored stamp on an unchanged reading heals (treated as a first sighting)', function () {
  const R7 = AW_NOW + 2 * 86400;
  ['abc', '99999999999', String(AW_NOW + 500)].forEach(function (bad) {
    const dir = tmpDir();
    writeRl(dir, 'H', bad + '|||' + bad + '|40|' + R7);
    runEntry({ session_id: 'H', context_window: { used_percentage: 3 }, rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } },
      { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
    assert.strictEqual(rlFile(dir, 'H'), '0|||0|40|' + R7, 'stamp ' + bad + ' healed to unknown');
  });
});
test('own-reading tie-break works with a backslash in CCT_DIR', function () {
  if (IS_WIN) { skipTest('backslash CCT_DIR', 'POSIX path'); return; }
  const R7 = AW_NOW + 2 * 86400;
  const dir = path.join(tmpDir(), 'bs\\tdir'); fs.mkdirSync(dir);
  writeRl(dir, 'AAA', '0|||0|99|' + R7);
  const out = runEntry({ session_id: 'S', context_window: { used_percentage: 3 }, rate_limits: { seven_day: { used_percentage: 35, resets_at: R7 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
  assert.strictEqual(out, 'ctx 3% | 7d 35% ~2d', 'own reading on the 0-0 tie');
});


// R9 rigor additions: legacy trackers never read on the newline fallback scan, legacy temp
// reclaim, empty own tracker, raw age boundary, symlinks never deleted, dotfile temps.
(function () {
  function ctxOnlyS(sid, pct) { return { session_id: sid, context_window: { used_percentage: pct } }; }
  function withEnv(vars, fn) {
    const saved = {};
    Object.keys(vars).forEach(function (k) { saved[k] = process.env[k]; process.env[k] = vars[k]; });
    try { fn(); } finally {
      Object.keys(saved).forEach(function (k) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    }
  }

  // G4: newline-dir fallback scan must use the rl2 glob only (legacy files are never read).
  test('K-G4 newline CCT_DIR: a pre-1.4.8 telemetry-rl-* tracker is never read on the fallback scan', function () {
    if (IS_WIN) { skipTest('K-G4', 'newline path POSIX-only'); return; }
    const dir = path.join(tmpDir(), 'nl\ndir'); fs.mkdirSync(dir);
    const R7 = AW_NOW + 2 * 86400;
    fs.writeFileSync(path.join(dir, 'telemetry-rl-OLD'), (AW_NOW - 5) + '|||' + (AW_NOW - 5) + '|60|' + R7);
    writeRl(dir, 'NEW', (AW_NOW - 500) + '|||' + (AW_NOW - 500) + '|74|' + R7);
    assert.strictEqual(runEntry(ctxOnlyS('C', 33), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout, 'ctx 33% | 7d 74% ~2d');
  });

  // I3: legacy .telemetry-rl-*.tmp crash leftovers are still reclaimed.
  test('K-I3 pruneRaw reclaims a stale pre-1.4.8 .telemetry-rl-*.tmp leftover', function () {
    const dir = tmpDir();
    withEnv({ CCT_DIR: dir }, function () {
      const t = path.join(dir, '.telemetry-rl-s.12345.tmp');
      fs.writeFileSync(t, '1000|5|1700003600|||');
      const old = (Date.now() - 2 * 86400 * 1000) / 1000; fs.utimesSync(t, old, old);
      api.pruneRaw();
      assert.strictEqual(fs.existsSync(t), false);
    });
  });

  // P1: getline must require > 0. An EMPTY own tracker (EOF, getline 0) must not re-feed the previous
  // file's line flagged as "mine" (which would flip a glob-order tie).
  test('K-P1 an empty own tracker does not re-consider the previous pool line as own (tie stays in glob order)', function () {
    const dir = tmpDir();
    const R7 = AW_NOW + 2 * 86400, T = AW_NOW - 100;
    writeRl(dir, 'A', T + '|||' + T + '|40|' + R7);
    writeRl(dir, 'B', T + '|||' + T + '|50|' + R7);
    fs.writeFileSync(path.join(dir, 'telemetry-rl2-C'), '');   // own tracker, 0 bytes, sorts after B
    const out = runEntry(ctxOnlyS('C', 10), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) }).stdout;
    assert.strictEqual(out, 'ctx 10% | 7d 40% ~2d');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'telemetry-rl2-C'), 'utf8'), '', 'precondition: own file stayed empty');
  });

  // R1: the raw age cutoff is exact to well under the 2-minute margins used here (clock-safe).
  test('K-R1 raw age rule boundary: just past CCT_PRUNE_AGE_SEC deleted, just under kept', function () {
    const dir = tmpDir();
    withEnv({ CCT_DIR: dir, CCT_PRUNE_AGE_SEC: '3600' }, function () {
      const a = path.join(dir, 'telemetry-raw-past.json'), b = path.join(dir, 'telemetry-raw-under.json');
      fs.writeFileSync(a, '{}'); fs.writeFileSync(b, '{}');
      const ta = Date.now() / 1000 - 3600 - 120, tb = Date.now() / 1000 - 3600 + 120;
      fs.utimesSync(a, ta, ta); fs.utimesSync(b, tb, tb);
      api.pruneRaw();
      assert.strictEqual(fs.existsSync(a), false, '120s past the cutoff: deleted');
      assert.strictEqual(fs.existsSync(b), true, '120s before the cutoff: kept');
    });
  });

  // R4: symlinks matching our prefixes are not ours: never unlinked (raw by age, tracker by expiry).
  test('K-R4 pruneRaw never deletes a SYMLINK named like a raw file or tracker', function () {
    if (IS_WIN) { skipTest('K-R4', 'symlinks POSIX-only'); return; }
    const dir = tmpDir(), ext = tmpDir();
    withEnv({ CCT_DIR: dir }, function () {
      const n = Math.floor(Date.now() / 1000);
      const tRaw = path.join(ext, 'user.json'), tRl = path.join(ext, 'user-rl');
      fs.writeFileSync(tRaw, '{}');
      fs.writeFileSync(tRl, (n - 900) + '|5|' + (n - 100) + '|' + (n - 900) + '|30|' + (n - 50)); // expired line
      const lRaw = path.join(dir, 'telemetry-raw-link.json'), lRl = path.join(dir, 'telemetry-rl2-link');
      fs.symlinkSync(tRaw, lRaw); fs.symlinkSync(tRl, lRl);
      const old = n - 2 * 86400; fs.lutimesSync(lRaw, old, old); fs.utimesSync(tRaw, old, old);
      api.pruneRaw();
      assert.ok(fs.lstatSync(lRaw).isSymbolicLink(), 'raw-named symlink kept');
      assert.ok(fs.lstatSync(lRl).isSymbolicLink(), 'tracker-named symlink kept');
      assert.ok(fs.existsSync(tRaw) && fs.existsSync(tRl), 'targets untouched');
    });
  });

  // T1/T2: a temp left behind (mv AND rm failing, as in a crash between write and mv) must be a
  // dot-file: out of the picker glob and in the prune reclaim pattern.
  test('K-T a leftover tracker temp (mv and rm fail) is a dotfile, for the marker and the reading paths', function () {
    if (IS_WIN) { skipTest('K-T', 'PATH shim of mv/rm POSIX-only'); return; }
    const shim = tmpDir(), tdir = tmpDir();
    ['mv', 'rm'].forEach(function (c) { const p = path.join(shim, c); fs.writeFileSync(p, '#!/bin/sh\nexit 1\n'); fs.chmodSync(p, 0o755); });
    const env = function (dir) { return { CCT_DIR: dir, CCT_NOW: String(AW_NOW), TMPDIR: tdir, PATH: shim + path.delimiter + process.env.PATH }; };
    const d1 = tmpDir();   // marker path (no rate_limits, no tracker yet)
    runEntry(ctxOnlyS('M', 10), env(d1));
    const d2 = tmpDir();   // reading path
    runEntry({ session_id: 'R', context_window: { used_percentage: 10 },
      rate_limits: { seven_day: { used_percentage: 40, resets_at: AW_NOW + 86400 } } }, env(d2));
    [[d1, 'M'], [d2, 'R']].forEach(function (x) {
      const names = fs.readdirSync(x[0]);
      const rl = names.filter(function (f) { return f.indexOf('telemetry-rl2-' + x[1]) >= 0; });
      assert.strictEqual(rl.length, 1, 'precondition: exactly one tracker temp left in ' + x[1] + ': ' + JSON.stringify(names));
      assert.ok(/^\.telemetry-rl2-[A-Za-z0-9_-]+\.[0-9]+\.tmp$/.test(rl[0]), 'leftover temp is a dotfile: ' + rl[0]);
    });
  });

})();


test('heal: an over-range stamp (beyond the shell integer range) heals; a stamp within now+60 is kept (same bound as the picker)', function () {
  const R5 = AW_NOW + 3600, R7 = AW_NOW + 2 * 86400;
  let dir = tmpDir();
  writeRl(dir, 'O', '99999999999999999999999|10|' + R5 + '|x|30|' + R7);
  runEntry({ session_id: 'O', context_window: { used_percentage: 3 }, rate_limits: { five_hour: { used_percentage: 10, resets_at: R5 },
    seven_day: { used_percentage: 30, resets_at: R7 } } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'O'), '0|10|' + R5 + '|0|30|' + R7, 'both healed');
  dir = tmpDir();
  writeRl(dir, 'K', (AW_NOW + 30) + '|10|' + R5 + '|' + (AW_NOW + 60) + '|30|' + R7);
  runEntry({ session_id: 'K', context_window: { used_percentage: 3 }, rate_limits: { five_hour: { used_percentage: 10, resets_at: R5 },
    seven_day: { used_percentage: 30, resets_at: R7 } } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'K'), (AW_NOW + 30) + '|10|' + R5 + '|' + (AW_NOW + 60) + '|30|' + R7, 'within now+60: kept');
});

test('heal uses the transcript time when there is no prompt_cache', function () {
  if (IS_WIN) { skipTest('transcript heal', 'Windows paths contain backslashes, which the fallback does not read'); return; }
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  const tp = path.join(dir, 't.jsonl');
  fs.writeFileSync(tp, txLine('assistant', isoOf(AW_NOW - 800)) + '\n');
  writeRl(dir, 'H', 'abc|||abc|40|' + R7);
  runEntry({ session_id: 'H', transcript_path: tp, context_window: { used_percentage: 3 },
    rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } }, { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(rlFile(dir, 'H'), (AW_NOW - 800) + '|||' + (AW_NOW - 800) + '|40|' + R7, 'healed to the transcript time');
});

test('a DIRECTORY at the tracker path: no write through it, no temp left behind, the bar still renders', function () {
  if (IS_WIN) { skipTest('dir at tracker path', 'POSIX rename semantics'); return; }
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  fs.mkdirSync(path.join(dir, 'telemetry-rl2-D'));
  const r = runEntry({ session_id: 'D', context_window: { used_percentage: 3 }, rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } },
    { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
  assert.strictEqual(r.stdout, 'ctx 3% | 7d 40%', 'own usage fallback, no countdown (no tracker)');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'telemetry-rl2-D')), [], 'nothing moved into the directory');
  assert.deepStrictEqual(fs.readdirSync(dir).filter(function (f) { return /\.tmp$/.test(f); }), [], 'no temp left');
});

test('a READ-ONLY CCT_DIR: the bar renders and nothing is printed to stderr', function () {
  if (IS_WIN) { skipTest('read-only dir', 'POSIX permissions'); return; }
  const dir = tmpDir();
  const R7 = AW_NOW + 2 * 86400;
  fs.chmodSync(dir, 0o555);
  try {
    let writable = true; try { fs.writeFileSync(path.join(dir, 'probe'), 'x'); fs.unlinkSync(path.join(dir, 'probe')); } catch (e) { writable = false; }
    if (writable) { skipTest('read-only dir', 'running as root: chmod has no effect'); return; }
    const r = runEntry({ session_id: 'R', context_window: { used_percentage: 3 }, rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } },
      { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
    assert.strictEqual(r.stdout, 'ctx 3% | 7d 40%');
    assert.strictEqual(r.stderr, '', 'no shell error on stderr');
    const r2 = runEntry(ctxOnly(5), { CCT_DIR: dir, CCT_NOW: String(AW_NOW) });
    assert.strictEqual(r2.stderr, '', 'marker path: no shell error on stderr');
  } finally { fs.chmodSync(dir, 0o755); }
});


// R10 rigor additions: transcript edge cases (FIFO, 256 KB boundary, partial lines, nested types,
// offsets, malformed dates, the date math across months and leap years, the 1e9 floor, now as a
// boundary, escaped paths), per-window heals, empty and backslash stamps, a FIFO at the own tracker,
// the newline-dir filter, getline -1, and look-alike names in prune. POSIX only (FIFOs, /bin/sh).
if (IS_WIN) { skipTest('R10 rigor block', 'POSIX only (FIFOs, /bin/sh)'); } else (function (outerTest) {
  function test(id, name, fn) { outerTest(id + ' ' + name, fn); }
  const NOW = 1700000000, R5 = NOW + 3600, R7 = NOW + 2 * 86400;
  const REPO = ROOT;
  function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cct-test-')); }
  function run(p, env) {
    return spawnSync('/bin/sh', [ENTRY], { input: JSON.stringify(p), encoding: 'utf8', timeout: 5000,
      env: Object.assign({}, process.env, { HOME: tmpDir() }, env) });
  }
  function writeRl(dir, sid, line) { fs.writeFileSync(path.join(dir, 'telemetry-rl2-' + sid), line); }
  function rl(dir, sid) { return fs.readFileSync(path.join(dir, 'telemetry-rl2-' + sid), 'utf8'); }
  function txLine(type, iso, msgExtra) {
    return JSON.stringify({ parentUuid: 'p', isSidechain: false,
      message: Object.assign({ role: type === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: 'x' }] }, msgExtra || {}),
      type: type, uuid: 'u', timestamp: iso, sessionId: 's', version: '2.1.220' });
  }
  function isoOf(sec) { return new Date(sec * 1000).toISOString(); }
  function e7(sid, tp, extra) {
    return Object.assign({ session_id: sid, transcript_path: tp, context_window: { used_percentage: 3 },
      rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } }, extra || {});
  }
  // First-sighting stamp from a transcript body (string) or a pre-made path.
  function txStamp(body, nowv) {
    const dir = tmpDir(); const tp = path.join(dir, 't.jsonl'); fs.writeFileSync(tp, body);
    const r = run(e7('T', tp), { CCT_DIR: dir, CCT_NOW: String(nowv || NOW) });
    assert.strictEqual(r.error, undefined, 'no timeout');
    return rl(dir, 'T').split('|')[0];
  }
  function mkfifo(p) { const m = spawnSync('mkfifo', [p], { timeout: 3000 }); assert.strictEqual(m.status, 0, 'mkfifo available'); }

  // --- transcript fallback -------------------------------------------------------------------------
  test('T03', 'a FIFO transcript_path is not opened (no hang), stamp unknown', function () {
    if (IS_WIN) return skipTest('T03', 'mkfifo POSIX-only');
    const dir = tmpDir(); const tp = path.join(dir, 'fifo.jsonl'); mkfifo(tp);
    const r = run(e7('F', tp), { CCT_DIR: dir, CCT_NOW: String(NOW) });
    assert.strictEqual(r.error, undefined, 'entry did not hang on a FIFO transcript');
    assert.strictEqual(rl(dir, 'F'), '0|||0|40|' + R7);
  });
  test('T06', 'an assistant entry inside the last 256 KB (but beyond 200 KB from the end) IS seen', function () {
    const filler = txLine('user', isoOf(NOW - 100)) + '\n';
    let tail = ''; while (tail.length < 250000) tail += filler;   // < 262144 incl. the assistant line
    const body = filler.repeat(50) + txLine('assistant', isoOf(NOW - 7000)) + '\n' + tail;
    assert.ok(Buffer.byteLength(tail) + 400 < 262144 && Buffer.byteLength(tail) > 200000, 'fixture geometry');
    assert.strictEqual(txStamp(body), String(NOW - 7000));
  });
  test('T09', 'a truncated trailing "timestamp":" (partial in-progress line) keeps the line complete timestamp', function () {
    // Labelled fixture: a partially written last line (no closing quote, no newline).
    const body = txLine('assistant', isoOf(NOW - 900)) + '\n' +
      '{"type":"assistant","timestamp":"' + isoOf(NOW - 600) + '","x":{"timestamp":"2026';
    assert.strictEqual(txStamp(body), String(NOW - 600));
  });
  test('T10', 'a user entry whose NESTED content carries "type":"assistant" is not taken as a response', function () {
    const body = txLine('assistant', isoOf(NOW - 900)) + '\n' +
      txLine('user', isoOf(NOW - 300), { content: [{ type: 'assistant', text: 'quoted' }] }) + '\n';
    assert.strictEqual(txStamp(body), String(NOW - 900));
  });
  test('T12', 'a timestamp with a UTC offset (no Z) is rejected, never parsed as UTC', function () {
    assert.strictEqual(txStamp(txLine('assistant', '2023-11-14T20:00:00.000+02:00') + '\n'), '0');
  });
  test('T13', 'a malformed timestamp (date only, then Z) is rejected', function () {
    assert.strictEqual(txStamp(txLine('assistant', '2023-11-01Z') + '\n'), '0');
  });
  test('T14/T15/T25/T27', 'epoch() matches Date.parse across months, Feb/leap days and year ends', function () {
    ['2004-02-29T12:34:56.000Z', '2023-02-28T23:59:59.000Z', '2023-03-01T00:00:00.000Z', '2023-01-01T00:00:00.000Z',
     '2022-12-31T23:59:59.000Z', '2020-02-29T00:00:01.000Z', '2001-09-09T01:46:40.000Z', '2023-11-14T22:13:20.000Z']
      .forEach(function (iso) {
        assert.strictEqual(txStamp(txLine('assistant', iso) + '\n'), String(Date.parse(iso) / 1000), iso);
      });
  });
  test('T19', 'a transcript time before 1e9 (2001-09-09) is rejected', function () {
    assert.strictEqual(txStamp(txLine('assistant', '1990-01-01T00:00:00.000Z') + '\n'), '0');
  });
  test('T20', 'a transcript time exactly AT now is accepted (boundary)', function () {
    assert.strictEqual(txStamp(txLine('assistant', isoOf(NOW)) + '\n'), String(NOW));
  });
  test('T02', 'a transcript_path with a JSON escape is not opened under its escaped spelling', function () {
    if (IS_WIN) return skipTest('T02', 'backslash file names POSIX-only');
    const dir = tmpDir();
    const real = path.join(dir, 'a\\b.jsonl');          // one backslash on disk
    const decoy = path.join(dir, 'a\\\\b.jsonl');       // the escaped spelling, two backslashes
    fs.writeFileSync(real, txLine('assistant', isoOf(NOW - 600)) + '\n');
    fs.writeFileSync(decoy, txLine('assistant', isoOf(NOW - 50)) + '\n');
    run(e7('T', real), { CCT_DIR: dir, CCT_NOW: String(NOW) });
    assert.strictEqual(rl(dir, 'T').split('|')[0], '0', 'escaped path refused (never the decoy time)');
  });

  // --- heal ----------------------------------------------------------------------------------------
  test('H07-H12', 'a corrupt or future stamp in ONE window heals to the last-call time and the line is rewritten', function () {
    const LC = NOW - 100; const pc = { prompt_cache: { ttl: '1h', expires_at: LC + 3600 } };
    const pay = { session_id: 'H', context_window: { used_percentage: 3 }, rate_limits: {
      five_hour: { used_percentage: 5, resets_at: R5 }, seven_day: { used_percentage: 40, resets_at: R7 } } };
    const good = String(NOW - 900);
    [['abc', good, LC, good], [String(NOW + 500), good, LC, good], [good, 'abc', good, LC], [good, String(NOW + 500), good, LC],
     ['abc', good, 0, good, true], [good, String(NOW + 500), good, 0, true]].forEach(function (c) {
      const dir = tmpDir();
      writeRl(dir, 'H', c[0] + '|5|' + R5 + '|' + c[1] + '|40|' + R7);
      run(Object.assign({}, pay, c[4] ? {} : pc), { CCT_DIR: dir, CCT_NOW: String(NOW) });
      assert.strictEqual(rl(dir, 'H'), c[2] + '|5|' + R5 + '|' + c[3] + '|40|' + R7, JSON.stringify(c));
    });
  });
  test('H03/H04', 'an EMPTY stored stamp heals to the first-sighting stamp (0), never left blank or borrowed from the other window', function () {
    let dir = tmpDir();
    writeRl(dir, 'E', '||||40|' + R7);
    run({ session_id: 'E', rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } }, { CCT_DIR: dir, CCT_NOW: String(NOW) });
    assert.strictEqual(rl(dir, 'E'), '0|||0|40|' + R7, 'empty TS5');
    dir = tmpDir();
    writeRl(dir, 'E', (NOW - 900) + '|5|' + R5 + '||40|' + R7);
    run({ session_id: 'E', rate_limits: { five_hour: { used_percentage: 6, resets_at: R5 }, seven_day: { used_percentage: 40, resets_at: R7 } } },
      { CCT_DIR: dir, CCT_NOW: String(NOW) });
    assert.strictEqual(rl(dir, 'E'), NOW + '|6|' + R5 + '|0|40|' + R7, 'empty TS7 heals to 0, not the 5h change stamp');
  });
  test('W14', 'a backslash in a stored stamp is literal (read -r): the stamp is corrupt and heals', function () {
    const dir = tmpDir();
    writeRl(dir, 'B', '\\0|||0|40|' + R7);
    run({ session_id: 'B', rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } }, { CCT_DIR: dir, CCT_NOW: String(NOW) });
    assert.strictEqual(rl(dir, 'B'), '0|||0|40|' + R7);
  });
  test('W04', 'a FIFO at the own tracker path is never read (no hang)', function () {
    if (IS_WIN) return skipTest('W04', 'mkfifo POSIX-only');
    const dir = tmpDir(); mkfifo(path.join(dir, 'telemetry-rl2-Q'));
    const r = run({ session_id: 'Q', rate_limits: { seven_day: { used_percentage: 40, resets_at: R7 } } }, { CCT_DIR: dir, CCT_NOW: String(NOW) });
    assert.strictEqual(r.error, undefined, 'entry did not hang');
  });

  // --- scan / getline ------------------------------------------------------------------------------
  test('S09', 'newline CCT_DIR: EVERY pool entry is filtered (a FIFO sorting last is skipped, no hang)', function () {
    if (IS_WIN) return skipTest('S09', 'newline path / mkfifo POSIX-only');
    const dir = path.join(tmpDir(), 'n\nl'); fs.mkdirSync(dir);
    writeRl(dir, 'a', (NOW - 100) + '|||' + (NOW - 100) + '|40|' + R7);
    writeRl(dir, 'b', (NOW - 200) + '|||' + (NOW - 200) + '|30|' + R7);
    mkfifo(path.join(dir, 'telemetry-rl2-zz'));
    const r = run({ session_id: 'C', context_window: { used_percentage: 33 } }, { CCT_DIR: dir, CCT_NOW: String(NOW) });
    assert.strictEqual(r.error, undefined, 'no hang');
    assert.strictEqual(r.stdout, 'ctx 33% | 7d 40% ~2d');
  });
  test('P02', 'a tracker deleted between the scan and the read (getline -1) is skipped, never re-read as the previous line', function () {
    if (IS_WIN) return skipTest('P02', 'PATH shim POSIX-only');
    const dir = tmpDir(), shim = tmpDir();
    const T = NOW - 100;
    writeRl(dir, 'A', T + '|||' + T + '|40|' + R7);
    writeRl(dir, 'B', T + '|||' + T + '|50|' + R7);
    writeRl(dir, 'C', T + '|||' + T + '|40|' + R7);     // own tracker, deleted just before the picker awk
    const real = spawnSync('/bin/sh', ['-c', 'command -v awk'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(shim, 'awk'), '#!/bin/sh\ncase "$*" in *segs=*) rm -f "$CCT_DIR/telemetry-rl2-C" ;; esac\nexec ' + real + ' "$@"\n');
    fs.chmodSync(path.join(shim, 'awk'), 0o755);
    const r = run({ session_id: 'C', context_window: { used_percentage: 10 } },
      { CCT_DIR: dir, CCT_NOW: String(NOW), PATH: shim + path.delimiter + process.env.PATH });
    assert.strictEqual(fs.existsSync(path.join(dir, 'telemetry-rl2-C')), false, 'precondition: own tracker removed mid-render');
    assert.strictEqual(r.stdout, 'ctx 10% | 7d 40% ~2d', 'tie stays in glob order (A)');
  });

  // --- index.js prune routing ----------------------------------------------------------------------
  function withDir(fn) { const d = tmpDir(); const s = process.env.CCT_DIR; process.env.CCT_DIR = d;
    try { fn(d); } finally { if (s === undefined) delete process.env.CCT_DIR; else process.env.CCT_DIR = s; } }
  test('I01/I05/I06', 'look-alike tracker names (dotted suffix, empty id) are never pruned, even expired or old', function () {
    withDir(function (dir) {
      const n = Math.floor(Date.now() / 1000), old = n - 10 * 86400;
      const expired = (n - 900) + '|5|' + (n - 100) + '|' + (n - 900) + '|30|' + (n - 50);
      ['telemetry-rl2-x.bak', 'telemetry-rl2-', 'telemetry-rl-', 'telemetry-rl2-y.old'].forEach(function (f) {
        const p = path.join(dir, f); fs.writeFileSync(p, f === 'telemetry-rl2-y.old' ? 'junk' : expired); fs.utimesSync(p, old, old);
      });
      api.pruneRaw();
      assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['telemetry-rl-', 'telemetry-rl2-', 'telemetry-rl2-x.bak', 'telemetry-rl2-y.old']);
    });
  });
})(test);


// R11 rigor additions: one-window heals via the transcript, the over-range TS7 guard, the exact
// heal bounds (now+60 kept, now+61 healed) per window, no transcript read for a tracked session,
// a noisy failing mv stays silent, and the 2100 century rule in the date math. POSIX only (shims).
if (IS_WIN) { skipTest('R11 rigor block', 'POSIX only (/bin/sh, PATH shims)'); } else (function () {
  const NOW = 1700000000, R5 = NOW + 3600, R7 = NOW + 2 * 86400;
  function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cct-kill-')); }
  function run(p, env) { return spawnSync('/bin/sh', [ENTRY], { input: JSON.stringify(p), encoding: 'utf8', timeout: 5000,
    env: Object.assign({}, process.env, { HOME: tmp() }, env) }); }
  function rl(d, s) { return fs.readFileSync(path.join(d, 'telemetry-rl2-' + s), 'utf8'); }
  function tx(iso) { return JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, type: 'assistant', timestamp: iso }) + '\n'; }
  function isoOf(s) { return new Date(s * 1000).toISOString(); }
  const both = { five_hour: { used_percentage: 5, resets_at: R5 }, seven_day: { used_percentage: 40, resets_at: R7 } };
  function heal(line, extraEnv, nowv) {
    const d = tmp(), tp = path.join(d, 't.jsonl'); fs.writeFileSync(tp, tx(isoOf((nowv || NOW) - 800)));
    fs.writeFileSync(path.join(d, 'telemetry-rl2-H'), line);
    run({ session_id: 'H', transcript_path: tp, rate_limits: both }, Object.assign({ CCT_DIR: d, CCT_NOW: String(nowv || NOW) }, extraEnv || {}));
    return rl(d, 'H');
  }
  const G = String(NOW - 900), T = String(NOW - 800);
  test('C1: only TS5 corrupt, no prompt_cache -> TS5 healed to the transcript time', function () {
    assert.strictEqual(heal('abc|5|' + R5 + '|' + G + '|40|' + R7), T + '|5|' + R5 + '|' + G + '|40|' + R7);
  });
  test('C2: only TS7 corrupt, no prompt_cache -> TS7 healed to the transcript time', function () {
    assert.strictEqual(heal(G + '|5|' + R5 + '|abc|40|' + R7), G + '|5|' + R5 + '|' + T + '|40|' + R7);
  });
  test('H2: an over-range (23-digit) TS7 alone heals', function () {
    assert.strictEqual(heal(G + '|5|' + R5 + '|99999999999999999999999|40|' + R7), G + '|5|' + R5 + '|' + T + '|40|' + R7);
  });
  test('H7/H11: TS5 exactly now+60 is kept; H9: TS5 now+61 heals', function () {
    const k = String(NOW + 60), h = String(NOW + 61);
    assert.strictEqual(heal(k + '|5|' + R5 + '|' + G + '|40|' + R7), k + '|5|' + R5 + '|' + G + '|40|' + R7, 'now+60 kept');
    assert.strictEqual(heal(h + '|5|' + R5 + '|' + G + '|40|' + R7), T + '|5|' + R5 + '|' + G + '|40|' + R7, 'now+61 healed');
  });
  test('H10: TS7 now+61 heals', function () {
    const h = String(NOW + 61);
    assert.strictEqual(heal(G + '|5|' + R5 + '|' + h + '|40|' + R7), G + '|5|' + R5 + '|' + T + '|40|' + R7);
  });
  test('C4: a TRACKED session with valid stamps never reads its transcript (no per-render tail)', function () {
    const d = tmp(), shim = tmp(), log = path.join(d, 'tail.log');
    const real = spawnSync('/bin/sh', ['-c', 'command -v tail'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(shim, 'tail'), '#!/bin/sh\necho called >> "' + log + '"\nexec ' + real + ' "$@"\n'); fs.chmodSync(path.join(shim, 'tail'), 0o755);
    const tp = path.join(d, 't.jsonl'); fs.writeFileSync(tp, tx(isoOf(NOW - 800)));
    fs.writeFileSync(path.join(d, 'telemetry-rl2-H'), G + '|5|' + R5 + '|' + G + '|40|' + R7);
    run({ session_id: 'H', transcript_path: tp, rate_limits: both }, { CCT_DIR: d, CCT_NOW: String(NOW), PATH: shim + ':' + process.env.PATH });
    assert.strictEqual(rl(d, 'H'), G + '|5|' + R5 + '|' + G + '|40|' + R7, 'precondition: unchanged');
    assert.strictEqual(fs.existsSync(log), false, 'tail was invoked on a tracked render');
    // positive control: first sighting DOES call tail through the shim
    const d2 = tmp();
    run({ session_id: 'N', transcript_path: tp, rate_limits: both }, { CCT_DIR: d2, CCT_NOW: String(NOW), PATH: shim + ':' + process.env.PATH });
    assert.ok(fs.existsSync(log), 'control: shim observed on a first sighting');
  });
  test('W3: a failing tracker mv that complains on stderr stays silent', function () {
    const d = tmp(), shim = tmp();
    fs.writeFileSync(path.join(shim, 'mv'), '#!/bin/sh\necho "mv: boom" >&2\nexit 1\n'); fs.chmodSync(path.join(shim, 'mv'), 0o755);
    const r = run({ session_id: 'M', context_window: { used_percentage: 3 }, rate_limits: both }, { CCT_DIR: d, CCT_NOW: String(NOW), PATH: shim + ':' + process.env.PATH });
    assert.strictEqual(r.stderr, '', 'stderr: ' + JSON.stringify(r.stderr));
    const r2 = run({ session_id: 'Z', context_window: { used_percentage: 3 } }, { CCT_DIR: tmp(), CCT_NOW: String(NOW), PATH: shim + ':' + process.env.PATH });
    assert.strictEqual(r2.stderr, '', 'marker path stderr: ' + JSON.stringify(r2.stderr));
  });
  test('E5: epoch() handles the 2100 non-leap century (2100-03-01)', function () {
    const iso = '2100-03-01T00:00:00.000Z', now = Date.parse(iso) / 1000 + 100;
    const d = tmp(), tp = path.join(d, 't.jsonl'); fs.writeFileSync(tp, tx(iso));
    run({ session_id: 'Y', transcript_path: tp, rate_limits: { seven_day: { used_percentage: 4, resets_at: now + 86400 } } }, { CCT_DIR: d, CCT_NOW: String(now) });
    assert.strictEqual(rl(d, 'Y').split('|')[0], String(Date.parse(iso) / 1000));
  });
})();

console.log('\n' + pass + '/' + (pass + fail) + ' passed' +
  (skip ? ' (' + skip + ' skipped: ' + (IS_WIN ? 'Windows' : process.platform) + ')' : ''));
process.exit(fail === 0 ? 0 : 1);
