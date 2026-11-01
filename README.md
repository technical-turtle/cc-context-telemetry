# cc-context-telemetry

[![npm](https://img.shields.io/npm/v/cc-context-telemetry)](https://www.npmjs.com/package/cc-context-telemetry)
[![CI](https://github.com/technical-turtle/cc-context-telemetry/actions/workflows/ci.yml/badge.svg)](https://github.com/technical-turtle/cc-context-telemetry/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/cc-context-telemetry)](./LICENSE)

Show Claude Code's context % and Pro/Max rate-limit usage (with how long until each limit
resets) and the current model, right next to your existing statusline bar.

    before:   ~/code/myapp  main

    after:    ctx 48% | 5h 14% ~3h20m | 7d 50% ~4d | opus-4.8   ~/code/myapp  main

The trailing part is whatever your own statusline already prints - cct wraps ANY
statusline command, not a specific one (a busier bar, like the adtention plugin's
`main  $9.07  21:04`, gets the same segment prepended).

## Quick start

Install:

```bash
npm i -g cc-context-telemetry
```

(No Node or npm on the machine, e.g. a native Claude Code install? Skip the npm step: `git
clone` the repo and use the absolute path to its `bin/cct-statusline` as the `command`
below. The statusline path is pure POSIX shell, so it needs neither Node nor npm.)

Set it as your `statusLine` in `~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "cc-context-telemetry-statusline" }
}
```

That is it - your statusline is now `ctx % | 5h % | 7d % | model` with reset countdowns. (Settings
changes take effect in a new session. Prefer a stable absolute path? Point `command` at an
installed or checked-out `bin/cct-statusline` instead of the global shim.)

**Already run a statusline you want to keep?** Add `CCT_WRAP`, set to your existing
statusline command; the segment then prepends to it on the same line:

```json
{
  "statusLine": {
    "type": "command",
    "command": "cc-context-telemetry-statusline",
    "env": { "CCT_WRAP": "<your existing statusline command>" }
  }
}
```

(If your Claude Code version does not accept an `env` block, export `CCT_WRAP` in your
shell profile instead.)

Either direction chains, because cct `exec`s through: cct can wrap your bar (above), or if
another statusline tool already owns your `statusLine`, point THAT tool at cct instead of
the reverse - put cct's command in the host's own wrap channel so it keeps managing the
statusLine. See [`examples/host-owned-statusline.md`](examples/host-owned-statusline.md).

## Customizing the bar

`CCT_SEGMENTS` picks which segments show and in what order - a comma (or space) separated
list. Default: `ctx,5h,7d,model`. Order is the display order; presence toggles a segment on
or off; unknown tokens are ignored; unset or empty uses the default. Tokens:

- `ctx` - context window used %
- `5h` / `7d` - Pro/Max rate-limit usage, each with a `~time-left` reset countdown
- `model` - the current model as a short token (e.g. `opus-4.8[1m]`, `fable-5`)

```bash
CCT_SEGMENTS="ctx,5h,7d"          # drop the model
CCT_SEGMENTS="model,ctx,5h,7d"    # model first
CCT_SEGMENTS="5h,7d"              # just the rate limits
```

Set it in your `statusLine` env block in `~/.claude/settings.json`, next to `command` (and
`CCT_WRAP` if you wrap an existing bar):

```json
{
  "statusLine": {
    "type": "command",
    "command": "cc-context-telemetry-statusline",
    "env": { "CCT_SEGMENTS": "ctx,5h,7d" }
  }
}
```

(Or export `CCT_SEGMENTS` in your shell profile instead.)

**Both set an environment variable Claude Code reads at launch, so the change takes effect
only in a NEW session** - existing sessions keep their current bar until you start a fresh
one. If another tool owns your `statusLine` (a host-owned setup, e.g. a plugin that runs cct
through its own wrap channel), setting the variable in that tool's per-render command takes
effect on the next render with no restart; see
[`examples/host-owned-statusline.md`](examples/host-owned-statusline.md).

## Uninstall

Remove the `statusLine` block from `~/.claude/settings.json` (or set `command` back to your
original statusline command, i.e. your `CCT_WRAP` value), then `npm uninstall -g
cc-context-telemetry` (or delete your clone). Optionally clear the telemetry files with
`rm -rf ~/.claude/cc-context-telemetry`.

## How it works

Claude Code hooks and plugins cannot see context fullness or rate limits. The ONLY place
Claude Code exposes the authoritative `context_window` (used percentage, window size) and
Pro/Max `rate_limits` is the `statusLine` command. This tiny, zero-dependency library
bridges that gap: a statusLine wrapper that prepends a compact segment - context %, the
5h/7d rate limits each with a `~time-left` reset countdown, and the current model (default
`ctx,5h,7d,model`, all configurable) - to your own bar, and also writes that telemetry to a
per-session file your hooks can read.

`ctx` is per session. The 5h/7d rate limits are account-wide but Claude Code only refreshes
them on an API call, so any single session's view is often stale. The bar therefore shows, per
window, the most recent reading across your open sessions ON THIS MACHINE. Each session records
its own reading and when it was measured: the moment the reading changed (a reading only
changes when an API response refreshes it, including responses to subagents), or, the first
time a session is seen, the time of its last API call when newer Claude Code exposes it
(`prompt_cache`), so a long-idle session keeps its real, old time (older Claude Code lacks that
field, so the time of the last response in the session transcript is used, except for a
Windows-style transcript path, which is not read; without either, its time is unknown and it
ranks below every reading with a known time until its number changes). The bar takes the newest
reset boundary, and in it the most recently measured reading, whatever its number: after a
quota reset the newest reading is the lower one, and it is shown as soon as any session makes a
request. Usage percentages are never compared. Plans without a 5-hour limit carry only the 7d
window and work the same way; once no session has a current 5h reading and this session's own
payload has no 5h window, the 5h segment is left out. A reading whose own reset boundary
already elapsed is treated as stale and never picked; if no session has a current reading for a
window, the bar falls back to this session's last-known usage with no countdown. So your open
sessions show the newest reading instead of different stale numbers (if several readings have
no known time at all, each session shows its own). It does not converge
across separate machines.

One job, three pieces:

- `bin/cct-statusline` - the POSIX shell entry Claude Code calls as its statusLine,
  every render. It is **pure shell, with NO Node on the per-render path**: it reads the
  payload once, extracts the session id, and atomically writes the RAW payload to
  `telemetry-raw-<session>.json`. Then it prints the `ctx % | 5h % | 7d % | model` segment
  (each rate-limit field carrying a `~time-left` countdown to its reset) and, if `CCT_WRAP` is
  set to your original statusline command, **`exec`s that command** so its bar appends
  right after the segment on the same line and it BECOMES the statusLine process (see
  "Safe to run every render" for why this matters); with no `CCT_WRAP` the segment is the
  whole bar, never blank. There is no per-render Node spawn at all (an earlier design
  spawned `node` every render; across many sessions that piled up).
- `index.js` - the consumer. `readTelemetry(sessionId)` reads the raw payload file,
  parses it ON DEMAND, and returns the latest reading with a freshness check. So all
  JSON parsing happens here, only when a hook actually asks - never on the hot path. It
  also prunes stale per-session raw files (off the hot path, throttled).
- `bin/telemetry.js` - an on-demand CLI reader over `readTelemetry`, for the manual
  live check. It is NOT in the per-render path; it runs only when you invoke it.

Zero third-party dependencies, and cross-platform (CI-tested on Linux, macOS, and Windows):
the pure-POSIX-shell statusline path runs anywhere Claude Code does. On Windows, Claude Code
runs statusLine commands through Git Bash, which ships the shell and tools it needs. Node
>= 18 is required only for the hooks API (`readTelemetry`) and the `bin/telemetry.js` reader.
Never throws, never calls `claude`.

## Consumer API (hooks)

In any hook (PreToolUse, PreCompact, etc.), read the latest reading:

```js
const { readTelemetry } = require('cc-context-telemetry');
const d = require('fs').readFileSync(0, 'utf8'); // hook stdin
const sessionId = JSON.parse(d).session_id;
const t = readTelemetry(sessionId);
if (t && t.fresh && t.contextPct >= 85) { /* near the wall: act */ }
```

`readTelemetry(sessionId, opts)` returns `null` when absent, otherwise:

```js
{
  sessionId,        // string
  contextPct,       // number or null (context window used %)
  usedPercentage,   // number or null (alias of contextPct)
  windowSize,       // number or null (context_window_size)
  fiveHourPct,      // number, OMITTED when Claude Code did not report it
  sevenDayPct,      // number, OMITTED when Claude Code did not report it
  fiveHourResetsAt, // number (Unix epoch seconds), OMITTED when absent
  sevenDayResetsAt, // number (Unix epoch seconds), OMITTED when absent
  model,            // string or null (model id)
  ts,               // ISO timestamp string or null
  source,           // "statusline"
  fresh             // true when contextPct is a finite number AND ts is within the TTL
}
```

`contextPct` / `usedPercentage` are passed through verbatim from Claude Code's
`context_window.used_percentage` (a percentage, 0..100 in practice). The library does
NOT range-clamp them; it only verifies they are numbers, so treat them as advisory and
do not assume a strict `0..100` bound. `fresh` already rejects non-finite values.

`fiveHourResetsAt` / `sevenDayResetsAt` are the Unix epoch (seconds) when each rate-limit
window next resets. They are omitted (like the percentages) when the payload has no
`rate_limits` or no `resets_at`, and also when the value is not a plausible epoch - the
reader rejects non-epoch or absurd values (mirroring the statusline renderer) so a corrupt
file cannot hand you a bogus reset time. Compute time-left yourself, e.g.
`fiveHourResetsAt - Date.now() / 1000`. A reset time can still be in the PAST when the
reading is stale (Claude Code refreshes `rate_limits` only on an API call), so gate on
`fresh` and treat an already-passed reset as stale, not as "resetting now".

`fresh` rejects both stale and far-future timestamps (it checks the absolute age
against the TTL). When `fresh` is false, treat it as "no signal" and stay
observe-only. `opts.ttlSec` (or env `CCT_TTL_SEC`) overrides the default 120s TTL.
An override is honored only when it is a finite number greater than 0; a blank,
zero, negative, or non-numeric value falls back to the default.

The module also exports `DEFAULT_TTL_SEC` (the 120s default, a number),
`parsePayload(d, sessionId)` (the raw-to-normalized field mapping),
`rawPath(sessionId)`, `pruneRaw()`, `telemetryDir()`, `telemetryPath(sessionId)`,
`writeTelemetry(sessionId, obj)`, and `nowIso()`. The session id is sanitized
(everything outside `[A-Za-z0-9_-]` becomes `_`), so a reading is always confined to
the telemetry directory.

## Telemetry file

The pure-shell entry writes the RAW Claude Code statusline payload, verbatim, at
`<dir>/telemetry-raw-<session>.json`. It is overwritten each render (atomically, via a
temp file + rename), so a single session never grows the directory. When the payload
carries `rate_limits` it also writes a second, tiny per-session file,
`<dir>/telemetry-rl2-<session>` (one line, no extension), holding that session's last
5h/7d reading and when each was measured (a session seen before it has any rate limits gets an
empty marker file, so its first reading is dated when it appears). That is what lets the bar
compare your open sessions and show the freshest reading; nothing else reads it. Versions
before 1.4.8 named it `telemetry-rl-<session>`; those files are never read and are deleted by
the prune below.
`readTelemetry(sessionId)` parses the raw file on demand. The raw payload
looks like (fields vary by plan/model/version - the lib reads them straight, never
assuming a shape):

```json
{
  "session_id": "abc123",
  "context_window": { "used_percentage": 47.2, "context_window_size": 200000 },
  "rate_limits": {
    "five_hour": { "used_percentage": 12, "resets_at": 1783359600 },
    "seven_day": { "used_percentage": 30, "resets_at": 1783368000 }
  },
  "model": { "id": "claude-opus-4-1" }
}
```

`rate_limits` is present only for Pro/Max OAuth; it is absent (so `fiveHourPct` /
`sevenDayPct` are omitted, never reported as 0) for API-key / Bedrock / Vertex.
`context_window.used_percentage` is `null` before the first API response and right
after a compaction (so `contextPct` is `null` and `fresh` is `false`).

Each `rate_limits` window also carries `resets_at` (a Unix epoch, seconds). The shell
segment renders it as a compact `~time-left` countdown next to the percent: at most two
units (`~6d23h`, `~2h54m`, `~44m`, `~<1m`). It is a pure duration (reset minus `date +%s`),
so there is no clock or timezone handling. The countdown is omitted whenever `resets_at` is
missing (older Claude Code, or non-OAuth plans), implausible, or already in the past (a
reading whose reset boundary elapsed predates the last reset, so it is treated as stale: the
countdown is dropped and the bar shows this session's last-known usage % without one) -
never fabricated. (`readTelemetry` surfaces these reset epochs too, as
`fiveHourResetsAt` / `sevenDayResetsAt`; see the Consumer API section.)

### Raw-file hygiene

`telemetry-raw-<session>.json` is per session, so live sessions bound the file count,
but a long-lived machine sees a new session id (UUID) per `claude` run. So
`readTelemetry` prunes off the hot path (throttled, at most once per
`CCT_PRUNE_EVERY_SEC`, default hourly): it deletes raw files older than
`CCT_PRUNE_AGE_SEC` (default 1 day) and then caps the total at `CCT_PRUNE_MAX_FILES`
(default 200, deleting the oldest beyond the cap). A `telemetry-rl2-*` tracker is deleted
once every reset boundary in it has passed (one it cannot parse goes by the same age rule):
an idle session's tracker keeps the time its reading was measured, which the bar relies on
(trackers are capped separately at `CCT_PRUNE_MAX_RL`, default 200). Pruning only runs when
something calls `readTelemetry`; without a hook nothing is deleted, and the bar ignores
trackers whose windows have ended. Pre-1.4.8 `telemetry-rl-*` trackers are deleted outright.
It only ever touches this lib's own `telemetry-raw-*.json`, `telemetry-rl2-<id>` and
`telemetry-rl-<id>` files (and its own leftover write temps), never anything else in the
directory. Pruning is best-effort and never throws.

## Environment variables

- `CCT_WRAP` - your original statusline command, as a SINGLE foreground command (a
  program plus args, e.g. `'/path/to/your-statusline' status`). The entry `exec`s it
  with the same stdin so it becomes the statusLine process and forwards its output. It
  must NOT be a pipeline (`a | b`) or backgrounded (trailing `&`): a pipeline mis-routes
  stdin, and `&` leaves a process running past the render (exactly as it would running
  directly). If you need a pipeline, put it in a small script and point `CCT_WRAP` at
  that script. When `CCT_WRAP` is unset, the entry prints its own minimal bar
  (`ctx 47% | 5h 12% ~3h | 7d 30% ~5d | opus-4.8`).
- `CCT_SEGMENTS` - which bar segments to show and in what order (default `ctx,5h,7d,model`);
  see Customizing the bar.
- `CCT_DIR` - telemetry directory (default `~/.claude/cc-context-telemetry/`). The
  shell entry mirrors this default; set it on the statusLine env AND for your hooks so
  both sides agree.
- `CCT_TTL_SEC` - freshness window for `readTelemetry` in seconds (default 120).
- `CCT_PRUNE_AGE_SEC` - delete raw files older than this on the reader side (default
  86400, 1 day).
- `CCT_PRUNE_MAX_FILES` - hard cap on raw files; the oldest beyond it are deleted
  (default 200).
- `CCT_PRUNE_MAX_RL` - hard cap on `telemetry-rl2-*` trackers; the oldest beyond it are
  deleted (default 200).
- `CCT_PRUNE_EVERY_SEC` - throttle: prune at most once per this interval across reader
  invocations (default 3600, hourly).

The raw payload file (`telemetry-raw-<session>.json`) IS the verbatim statusline
payload, so it doubles as the debug dump: inspect it directly to see the real field
paths Claude Code sent. It may contain real session content and is overwritten each
render; the reader auto-prunes it (see Raw-file hygiene).

## Safe to run every render

Claude Code runs your statusLine on every render in every session and kills that process
each time to keep it bounded. cct stays safe by `exec`-ing your `CCT_WRAP` command: the
entry process BECOMES your statusline, so what Claude Code spawns and kills IS your
statusline, torn down each render exactly as if you ran it directly - no extra process, no
pile-up. There is also NO Node on the per-render path (only shell; all JSON parsing happens
later, on demand, in `index.js`), so nothing can outlive a render and orphan. An earlier
design that spawned `node` every render orphaned under Claude Code's render-kills and piled
up; the current exec-through wrapper does not. `test/loadrepro` proves it.

Full rationale (exec vs spawn, the orphan incident, the stdin/EOF contract, and the
forking-statusline corollary): [docs/process-safety.md](docs/process-safety.md).

## Verify it works

Wire it (Quick start), open any session, and send ONE message - the statusline renders
every turn, so you do not need to fill the context. (Settings changes only take effect in
a FRESH session, so start a new one after saving.) Then print the parsed reading:

```bash
node examples/print-telemetry.js <session-id>
```

Check for sane values (a numeric or null `contextPct`, a `windowSize`, a `model`). Your
`<session-id>` is the `session_id` field in any hook payload, and the `<session>` in the
raw file written this session under `~/.claude/cc-context-telemetry/`. If values are null
or missing, open that raw file - it IS the verbatim statusline payload - to see the real
field paths Claude Code sent.

## Examples

See the [`examples/`](examples/) directory for complete, runnable files: a
copy-pasteable PreToolUse warning hook (`pretooluse-warn.js`) and a telemetry
printer for the live check (`print-telemetry.js`). The examples are not published to
npm.

## License

MIT
