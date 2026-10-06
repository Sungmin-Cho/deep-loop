@AGENTS.md

# deep-loop — Claude Code notes

`AGENTS.md` above is the whole guide, shared by both hosts. Only what is specific
to Claude Code lives here.

## Hook events

`DEEP_LOOP_ROOT/hooks/hooks.json` binds Claude Code's **PreCompact**, **PostCompact**, and
**SessionStart** events to `DEEP_LOOP_ROOT/scripts/hooks-impl/precompact-handoff.mjs`,
`DEEP_LOOP_ROOT/scripts/hooks-impl/postcompact-observe.mjs`, and
`DEEP_LOOP_ROOT/scripts/hooks-impl/sessionstart-restore.mjs`. Codex support remains host-version-dependent.
Claude's manifest (`DEEP_LOOP_ROOT/.claude-plugin/plugin.json`) points at `DEEP_LOOP_ROOT/hooks/hooks.claude.json`,
which repeats `DEEP_LOOP_ROOT/hooks/hooks.json`'s `hooks` verbatim (Grok reads only the manifest file; Claude runs identical
commands once — measured) and adds a `modules` entry for `DEEP_LOOP_ROOT/hooks/status-band/register.mjs`. Codex reads only
`DEEP_LOOP_ROOT/hooks/hooks.json`. The module draws a read-only status band from `run status --json`; it needs
Claude Code 2.1.287+ and is absent, with no behavior change, elsewhere. Keep the two files' `hooks` equal.
Their bounded, non-spawning contract is invariant 7 — it applies wherever the code runs, and
it is stated once, in `AGENTS.md`.

## Dispatch

Where the Execution plane dispatches a descriptor as a subagent, that is the
`Skill()` tool here. The measured headless path on this host is bounded
`claude -p` JSON; the approved Codex path is shell-free `codex exec --json`.
Both are described in `AGENTS.md` §Architecture, because a change to either
affects the same kernel contract.

## Commit trailer

```text
Co-Authored-By: Claude Opus <noreply@anthropic.com>
```

Model name only, **no version or variant**, so the line does not drift as sessions
change model.
