# Grok hook-fire measurement runbook

Attended procedure for issue 64 S3. This is a host-delivery measurement, not a kernel mutation.

Do **not** treat a hand-written JSONL, a Claude Code session, or `probe-plugin-matcher-diag` output as PASS.

The matcher-diag plugin must not share DEEP_LOOP_HOOK_PROBE_CAPTURE with a PASS capture. Mint a new ULID for diagnostics. Never concatenate captures.

## 0. Preconditions

- Scratch directory only: never this repo, never a tree that contains `.deep-loop/`.
- One compact cycle per capture. A second cycle (manual or auto) is FAIL.
- Production PASS plugin is `integration/grok-hook-fire/probe-plugin/` (exactly three bindings).
- Install channel for PASS is Claude-cache (`--source claude-cache`). `grok plugin install` is a separate grok-native capture and is never PASS.

## 1. Record the CLI version

```bash
grok --version | head -n 1
```

Parse the first line with `probeExplicitGrokVersion`:

```
/^grok (\d+\.\d+\.\d+) \(([0-9a-f]+)\) \[[^\]]+\]$/
```

Allowlist token = group 1 (`1.0.5`), not the banner. Parse failure → stop.

```bash
GROK_BANNER="$(grok --version | head -n 1)"
GROK_SEMVER="$(node --input-type=module -e "const m=/^grok (\\d+\\.\\d+\\.\\d+) \\(([0-9a-f]+)\\) \\[[^\\]]+\\]$/.exec(process.argv[1]); if(!m) process.exit(1); process.stdout.write(m[1])" "$GROK_BANNER")"
```

## 2. Mint a capture and empty sink

From this checkout:

```bash
CAPTURE="$(node --input-type=module -e "import { ulid } from './scripts/lib/envelope.mjs'; process.stdout.write(ulid())")"
PROBE_OUT="$(mktemp -d "${TMPDIR:-/tmp}/grok-hook-fire.XXXXXX")"
export DEEP_LOOP_HOOK_PROBE_CAPTURE="$CAPTURE"
export DEEP_LOOP_HOOK_PROBE_OUT="$PROBE_OUT"
export DEEP_LOOP_HOOK_PROBE_SOURCE="claude-cache"
```

`$CAPTURE` must match `^[0-9A-HJKMNP-TV-Z]{26}$`. Do not reuse an id or a populated sink.

## 3. Install the production probe (Claude-cache channel)

Grok discovers the Claude-cache-loaded plugin. There is no `.grok-plugin` manifest.

```bash
PROBE="$(pwd)/integration/grok-hook-fire/probe-plugin"
# load via Claude plugin-dir in the same environment Grok will inherit, then
# start a new Grok session with the env vars from step 2 in the process environment.
# Example: claude --plugin-dir "$PROBE"
```

Confirm the cache/plugin-dir entry exists before starting Grok. Do not install `probe-plugin-matcher-diag` in this capture.

## 4. Scratch session

`cd` into an empty scratch directory. Do not use this repository.

## 5. One compact cycle

Record the exact native compact command this Grok exposes (needed later by S4 E4). Current user-guide spelling is `/compact`; do not assume it — copy the command from this session's slash menu.

1. Run that command once.
2. End and restart the **same** session so `SessionStart(source:"compact")` can fire.
3. Do not compact a second time in this capture.

## 6. Optional diagnostic / grok-native captures

Mint a **new** ULID. Never reuse the PASS `DEEP_LOOP_HOOK_PROBE_CAPTURE`.

- Matcher-diag: install `probe-plugin-matcher-diag/` only, `DEEP_LOOP_HOOK_PROBE_SOURCE=claude-cache`.
- Native channel: `DEEP_LOOP_HOOK_PROBE_SOURCE=grok-native`. That file is not a PASS input.

## 7. Verify and record

```bash
node integration/grok-hook-fire/verify-hook-fire.mjs \
  --events "$DEEP_LOOP_HOOK_PROBE_OUT/$DEEP_LOOP_HOOK_PROBE_CAPTURE.jsonl" \
  --capture "$DEEP_LOOP_HOOK_PROBE_CAPTURE" \
  --source claude-cache \
  --version "$GROK_SEMVER"
```

Exit 0. Last non-empty stdout line is exactly `PASS` or exactly `FAIL`.

Commit `integration/grok-hook-fire/results/grok-<semver>.md` with:

- verdict (`PASS` or `FAIL`)
- verbatim `grok --version` banner
- parsed semver (group 1)
- install channel (`claude-cache`)
- exact native compact command spelling recorded in the session
- redacted verifier summary (redact `session_id` only in the committed excerpt)

Do not edit the working `<capture_id>.jsonl`. Do not check that jsonl in.
