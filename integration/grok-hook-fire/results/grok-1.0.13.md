# Grok hook-fire measurement — 1.0.13

- Date: 2026-08-30
- Host: macOS Darwin, Grok Build TUI / CLI
- Install channel under test: `claude-cache` (Claude-cache-loaded plugin `hooks/hooks.json`)
- Verdict: **FAIL**
- Native compact command recorded in this session: `/compact`

## Version

- Verbatim banner (`grok --version` first line): `grok 1.0.13 (5e9a58528b76) [stable]`
- Parsed semver (`probeExplicitGrokVersion` group 1): `1.0.13`

## Procedure

Followed `integration/grok-hook-fire/RUNBOOK.md` on a scratch directory (no `.deep-loop/` tree, not this repo).

1. Minted a ULID capture and empty `DEEP_LOOP_HOOK_PROBE_OUT`.
2. Installed `probe-plugin` (production three matchers) and, separately, `probe-plugin-matcher-diag` via `grok plugin install --trust` (native diagnostic; never a PASS input) and confirmed Claude-cache discovery of the production deep-loop plugin.
3. Started a new Grok session (`grok -p` and `grok agent --no-leader --always-approve stdio`) with those env vars in the parent process.
4. Attempted one compact cycle. This session's slash menu / user-guide spelling is `/compact`. ACP `x.ai/compact_conversation` on `grok agent stdio` returns JSON-RPC `-32601 Method not found`.
5. Restart/resume was not reachable: plugin PreCompact/PostCompact never fired, so there was no compact cycle to restart from.

Verifier:

```bash
node integration/grok-hook-fire/verify-hook-fire.mjs \
  --events "$DEEP_LOOP_HOOK_PROBE_OUT/$CAPTURE.jsonl" \
  --capture "$CAPTURE" \
  --source claude-cache \
  --version 1.0.13
```

Last non-empty stdout line: `FAIL` (exit 0). Reason: `events-unreadable` — the production probe wrote no `<capture_id>.jsonl`.

No working JSONL was edited. No hand-written events were fed to the verifier as a measurement.

## Why FAIL

`grok inspect --json` lists Claude-cache and grok-native plugin hook files as opaque `event: "(plugin)"` / `hookType: "file"` entries. They are **not** expanded into `PreCompact` / `PostCompact` / `SessionStart` command bindings.

Claude-cache production plugin (the PASS channel):

```json
{
  "event": "(plugin)",
  "hookType": "file",
  "target": "/Users/sungmin/.claude/plugins/cache/claude-deep-suite/deep-loop/1.22.0/hooks/hooks.json",
  "source": {
    "type": "plugin",
    "plugin_name": "deep-loop",
    "path": "/Users/sungmin/.claude/plugins/cache/claude-deep-suite/deep-loop/1.22.0"
  },
  "matcher": null
}
```

The dedicated probe plugin (installed, enabled, trusted) is the same shape: `event: "(plugin)"`, `matcher: null`. `grok inspect` hook events include `session_start` only from `~/.grok/hooks` (user files). There is no `pre_compact` / `post_compact` / `PreCompact` / `PostCompact` command hook from any plugin.

Consequence: matcher `"*"` on a Claude-cache plugin `hooks.json` still does not fire PreCompact/PostCompact on 1.0.13 (same class of miss as 1.0.4). The production-only probe therefore produced zero lines.

## Diagnostic notes (not PASS inputs)

- **User `~/.grok/hooks` SessionStart does fire** on `grok -p` and `grok agent stdio`. The hook runner itself is alive for user files.
- Grok hook child processes **do not inherit** parent env (`DEEP_LOOP_HOOK_PROBE_*` unset unless the hook JSON `env` field sets it). This is why a probe that only reads process env writes nothing even when a user hook runs.
- `GROK_HOME` is not injected into hook env (`GROK_HOME` presence was false on a firing user SessionStart hook). `CLAUDE_CODE_ENTRYPOINT` was absent.
- User SessionStart stdin (session id redacted) is dual-key camelCase + snake_case. Event value is `session_start`, not `SessionStart`. `source` on a new session is `"new"`, not `"compact"`:

```json
{
  "hookEventName": "session_start",
  "sessionId": "<redacted>",
  "cwd": "<scratch>",
  "source": "new",
  "hook_event_name": "session_start",
  "session_id": "<redacted>"
}
```

  deep-loop's trusted SessionStart ingress requires `hook_event_name: "SessionStart"` and `source: "compact"`. Even a firing user hook would not satisfy §2.1.

- Matcher-diag dual-binding capture is not a PASS input and was not concatenated into a PASS file.

## Branch

FAIL → SLICE-008 / S5. Do not flip `compact_supported`. Do not insert `1.0.13` into `compact_measured_cli_versions`.
