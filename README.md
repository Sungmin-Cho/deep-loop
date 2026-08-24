**English** | [한국어](./README.ko.md)

# deep-loop

**Durable orchestration plugin for Claude Code, Codex, and Grok CLI** — coordinates multi-session, cross-plugin engineering work with a strict 2-plane architecture, budget enforcement, and proposal-only safety invariants.

## Overview

deep-loop is a standalone Claude Code / Codex / Grok CLI plugin that runs durable "loops" — structured sequences of discovery, triage, make, review, and integrate across multiple LLM sessions. It can operate independently or as the orchestration layer on top of the deep-suite (deep-work, deep-review, deep-wiki, deep-memory).

**Proposal-only** means push, PR, merge, publish, delete, and marketplace/deep-suite sync all require separate **human approval** before execution. Installation does not imply that this repository has been released or synchronized to either marketplace.

## Architecture: 2-Plane Design

deep-loop enforces a strict **2-plane separation** (spec §1):

### Control Plane (Kernel)
The kernel (`scripts/lib/`) manages all state, leases, budgets, and integrity:
- **State machine** (`state.mjs`, `lease.mjs`) — content-hash-anchored `loop.json`, generation-fenced leases
- **Budget engine** (`budget.mjs`) — turn/token/wallclock hard caps, fail-closed on unmeasurable usage
- **Circuit breaker** (`breaker.mjs`) — auto-trips on repeated failures, requires human reset
- **Integrity** (`integrity.mjs`) — append-only event log with chain + head anchors, tamper-detect
- **Handoff/respawn** (`handoff.mjs`, `respawn.mjs`) — stateful session handoff with idempotency keys
- **Execution plane CLI** (`deep-loop.mjs`) — the only mutation path for skills; all mutating commands require `--owner/--generation` lease fence

### Execution Plane (Skills / SKILL.md)
Skills are **read-only** with respect to raw state files. They read state only through the CLI (`state get`, `next-action`, `adapter resolve`, etc.) and write only through kernel CLI subcommands (`state patch`, `budget record`, `comprehension ack`, etc.). Skills never write `loop.json`, `event-log.jsonl`, or `.loop.hash` directly.

```
Skill (LLM) ──read──▶ state get / next-action / adapter resolve
Skill (LLM) ──write──▶ state patch / budget record / comprehension ack / episode new / etc.
                           │
                           ▼ (lock + fence + integrity.appendAnchored)
                        loop.json + event-log.jsonl (kernel-owned)
```

## Commands (10 User Skills)

| Claude Code | Codex CLI / App | Description |
|---|---|---|
| `/deep-loop` | `$deep-loop:deep-loop` | **Entry point** — starts a durable orchestration run, detects sibling plugins, matches a recipe/protocol, decomposes the goal into workstreams |
| `/deep-loop-discover` | `$deep-loop:deep-loop-discover` | Discovery phase — populates `discovered_items`, maps them to workstreams |
| `/deep-loop-triage` | `$deep-loop:deep-loop-triage` | Triage phase — prioritizes workstreams, assigns protocols, confirms with human |
| `/deep-loop-continue` | `$deep-loop:deep-loop-continue` | Main tick — advances the current workstream: dispatch maker → await → read artifacts → dispatch checker |
| `/deep-loop-compact` | `$deep-loop:deep-loop-compact` | Explicit `prepare`/`restore` path for a trusted same-conversation compaction checkpoint |
| `/deep-loop-handoff` | `$deep-loop:deep-loop-handoff` | Emits a clean handoff for the next session |
| `/deep-loop-resume` | `$deep-loop:deep-loop-resume` | Resumes an interrupted run from a handoff document |
| `/deep-loop-status` | `$deep-loop:deep-loop-status` | Read-only status report — state, budget, workstreams, and comprehension debt |
| `/deep-loop-ack` | `$deep-loop:deep-loop-ack` | Marks a human-reviewed episode and reduces comprehension debt |
| `/deep-loop-finish` | `$deep-loop:deep-loop-finish` | Verifies settled episodes, writes the final report, and finishes the run |

> Note: `/deep-loop-workflow` is an internal non-user-invocable skill used by `/deep-loop-continue` and other skills. Grok CLI uses the same `/deep-loop…` slash commands as Claude Code.

### Suitability gate

Before creating a run, `/deep-loop "<goal>"` first judges whether the goal is
loop-shaped. A fitting goal proceeds with zero extra friction; a clearly
misfit goal (a bounded one-shot question, review-only work, a single-session
implementation) gets a one-time alternative suggestion (deep-work /
deep-review / inline) with the reasoning — choosing deep-loop anyway is always
available, and nothing is auto-applied. Ambiguous goals proceed as a loop.

## Multi-run identity and worktree routing

A project can contain multiple active or historical runs. Start with the bounded verified list, then choose one immutable logical id explicitly:

```text
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" run list --project-root "<canonical_project_root>"
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" state get --field status --project-root "<canonical_project_root>" --run-id <run_id>
```

The `.deep-loop/current` pointer is only a last-created **hint**. It is never routing authority, ownership proof, or a tie-breaker. Mutation routes and exact reads never silently fall back to it; official automation also requires provisioned identity. The bounded resolver retains a `legacy-current` compatibility path only when the current selection resolves to one sole verified terminal run with no active runs; that run may have one or more distinct terminal claims, including nested Workstreams. Every concurrent run must use a unique worktree path and branch. The create↔record worktree flow still has a narrow TOCTOU between creation and `workstream new`; v1 does not promise project-level reservation, claim retirement, or ownership transfer. Duplicate claims fail closed and orphan cleanup remains proposal-only.

For unattended execution, provision the canonical project root and immutable run id once, then pass both values on every tick:

```text
node "<absolute-deep-loop-root>/scripts/hooks-impl/drive-headless.mjs" --project-root "<canonical_project_root>" --run-id <run_id>
```

## Compatibility and recovery contract

New runs use `workstream-session` with `spawn_style='interactive'` on Claude Code, Codex CLI, and Codex App. The active host conversation owns one bound Workstream until its exact `bound_workstream_first_terminal` event; compaction stays in that conversation, and only that first-terminal boundary may publish a normal child handoff. There is **no unattended mid-Workstream respawn**. The default continuation is interactive, and **manual resume** through `/deep-loop-resume` or `$deep-loop:deep-loop-resume` is a first-class supported path rather than an error-only fallback.

Grok CLI is an **attended Darwin-only** session runtime: new grok runs also use `workstream-session` with `spawn_style='interactive'` on macOS, and Linux, Windows, desktop, and measured headless are rejected. **Grok compact is unsupported.** The Claude-cache-loaded deep-loop plugin hook with matcher `"*"` did not fire on measured Grok 1.0.4 PreCompact/PostCompact, so emit+observe stay closed and SessionStart restore is not opened. **Downgrade:** a 1.18 grok run fail-stops on a 1.17.0 kernel at `validateSessionRuntime` / the schema enum; existing claude/codex runs remain readable. The durable schema stays `0.4.0`.

**1.19 kernel contract.** Every mutating route returns **exit 3** for `PROJECT_ROOT_FENCED` (nine routes that used to fold that fence to exit 1 now match invariant 2). Read-only `next-action` and `state get` stay exit 1; `path resolve` stays 3. Unknown flags are usage **exit 2**. Discover routes with `node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" help` (or `help <handler>`). Grok loops no longer receive compact advice.

PreCompact publishes a bounded checkpoint and SessionStart with source/matcher `compact` performs **host-mediated restore**. Restore liveness belongs to the host: the hook is emit-only, best-effort, and never creates a session. **Provider identity is optional** when the host supplies no stable identity; when present, its digest must match. A missing or untrusted hook is conditional, not an unconditional pause: without an explicit trusted-evidence rejection, restore reads fresh state; if it proves the same owner and generation with an open bound Workstream affinity in that owner session, state-derived continuation may proceed. Otherwise restore uses preserve-pause for the durable lease and the same manual resume path. An explicit trusted `provider-evidence-mismatch` or `checkpoint-unavailable-with-trusted-evidence` result takes that preserve-pause path directly. The isolated headless driver may continue only after the Workstream boundary and still fails closed on unmeasurable usage.

PostCompact accepts a bounded 256 KiB host event, projects only its trusted common fields, and supplies that bounded 4096-byte trusted payload to the fenced public `checkpoint observe` CLI; the adapter never restores or continues. An observation receipt corroborates that compaction occurred and never overrides a provider-evidence mismatch. A `prepared` checkpoint is only inspection evidence and never grants automatic restore authority. For an unattended tick inside an open bound Workstream, `next-action` preserves the normal action with no compact advice and no cap handoff. On a terminal run, `checkpoint observe` and `checkpoint restore` reject before changing durable bytes.

Visible and desktop launches are never inferred from terminal detection. A human must inspect the selected run's lease and executable diagnosis, then explicitly run `node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" attended-launch approve --style visible --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>`; desktop uses the nonce-bound `spawn-style offer-desktop ...` followed by `spawn-style confirm-desktop ...`. Budget exhaustion and a latched breaker are independent relief routes. Budget extend and breaker reset are independent relief routes: only confirmed `node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" budget extend --turns <positive_turn_delta> --reason "<human_confirmed_reason>" --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>` for exhaustion or `node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" breaker reset --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>` for a latched breaker may resume the run. Neither approval is granted by an autonomous skill.

Review flags are immutable through generic `state patch`. After a human-approved operational checker abandonment, a human may use the lease-fenced `review configure --profile codex-only-static --source-checker <id> --confirm ...` route before the next checker is created. That closed profile expands only to `--contract --codex-only --reviewer-strategy static`. For a critical-document provider-family shortage, the separately approved closed profile `gpt56-agy-static` fixes the two Codex roles to `gpt-5.6-sol/high`, fixes Agy to `gemini-3.6-flash-high`, disables Opus and fallback, and accepts no arbitrary provider/model argv. The kernel requires the durable reviewer to be `deep-review-loop` and the latest source to be a `deep-review` checker bound to a done maker and abandoned with an `operational-review-failure:` reason. It consumes that authority once, rejects the change while any checker is non-terminal, and records the source, event, and new flags in one anchored transaction.

Lost-host recovery is likewise human-only. Preserve-pause comes first, then a confirmed affinity supersession publishes a capsule; a fresh process executes only the exact returned `recovery acquire --capsule ...` command, unchanged. For a moved project, run the read-only `root diagnose --candidate-project-root ...`; after reviewing its descriptor, execute only the exact returned command unchanged (such as the returned root rebind or root recovery acquire --capsule ... command). Never synthesize, shorten, or edit a recovery command. `project.binding_generation` is the **root epoch**. Every state command and every **relative locator** is bound to that epoch, root digest, run id, lease owner, and lease generation. **Stale root-bound commands** are rejected by the epoch fence and are **never edited in place**; diagnose again to obtain a fresh command.

The durable artifact inventory under `.deep-loop/runs/<run-id>/` includes:

- `checkpoints/<checkpoint-key>-compact.json` for same-conversation compaction;
- `checkpoints/<checkpoint-key>-compact-observation.json` for trusted PostCompact evidence and `checkpoints/<checkpoint-key>-compact-prune.json` for crash-safe pair pruning;
- `compact-restore-intents/<operation-id>.prepared.json` for a fixed-shape restore publication intent;
- `transactions/<operation-id>/prepared.json` and `transactions/<operation-id>/committed.json` for the write-ahead log (**WAL**);
- `observations/<subject_sha256>.json` for RouteObservationV1 route-attempt telemetry,
  emitted best-effort (zero-or-one) after a successful terminal episode commit; it is
  never duplicated, never recovered if the process dies between commit and emit, and
  fails open;
- `recoveries/<child-run-id>-affinity-recovery.json`, boundary-recovery capsules, and `recoveries/root/<replacement-session-id>.json` root-relocation capsules;
- `terminal/launch-command.txt` plus bound `terminal/launch-command.meta.json` launch metadata.

The WAL reconciles before ordinary reads or mutations. An incomplete, invalid, or identity-mismatched prepared/committed publication is **fail-stop**: it cannot be skipped to continue from a partially published state.

### acquire↔resume contract

Every return object from the acquisition family — `lease acquire`, `recovery acquire`, and
`root recovery acquire` — always carries three fields:

| Field | Meaning |
|---|---|
| `proceed` | boolean. `proceed === (ok === true && reason === 'acquired')` — one derivation rule, no per-path branching. **Consumers decide whether to continue on `proceed` alone.** The idempotent `already-owned` response is `ok:true` with `proceed:false`. |
| `consumed` | object or `null`. Non-null only when a proceeding acquire actually consumed a reservation; a reservation-less takeover of a released lease is `null`. Echoes the takeover kind, both run ids, the boundary event, the root digest/binding generation, the handoff rel, and the generation transition. |
| `replayed` | boolean. `true` marks a nonce replay — the same response re-issued, not a second consumption. Independent of `proceed`; observational. |

Every successful acquire also writes a durable **acquisition receipt** to
`session_chain.lease.acquisition_receipt` (one per generation, overwritten on each success).
It is a superset of the `consumed` payload, so a replay response is a field copy rather than
a derivation, and it exists even for an owner that has no session entry.

**Attempt nonce — `lease acquire --attempt-id <token>`** (optional,
`^[A-Za-z0-9_-]{8,128}$`; a malformed value is exit 1, an omitted one is not a violation).
A caller whose response was lost but which is still alive re-sends the **same** value and
the kernel re-issues `{proceed:true, replayed:true}`, recovering the right to proceed with
no human step. The protocol is **generate → persist durably on the caller's side → acquire**;
persisting after the call leaves a window where the call succeeded but the identifier is
lost, so it is forbidden, and a caller that skips it gets no such guarantee. Retries reuse
the value — a fresh one is a different attempt. Replay writes nothing of its own. A
human-initiated `node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" pause --mode preserve --reason "host-session-lost" --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>` revokes an already-granted attempt: replay requires
the run to be `running`.

`resume-command` grows an **acquired branch**: after consumption it still proves, read-only
and from the receipt, that this exact reservation was consumed once, in which generation
transition, and by whom. Its first line is a **non-executable marker**, so a legacy consumer
cannot mistake `already-owned` for success. An ordinary re-acquisition and a stale receipt
never surface as consumed.

**Path × scenario.** Five acquisition paths across three CLI surfaces: `normal`,
`boundary-handoff` and `boundary-recovery` share `lease acquire`; `affinity recovery` and
`root recovery` have their own verbs. All five report `proceed`/`consumed` and write a
receipt. Only the three `lease acquire` paths accept `--attempt-id` and therefore have
replay; neither recovery verb has a replay branch, so **a lost response there is recoverable
only by human intervention** — `resume-command`'s `Recovery: consumed` is an observation, not
a re-issued right to proceed. Their duplicate answers differ and are not interchangeable:
`recovery acquire` throws `LEASE_FENCED: generation-mismatch` (**exit 3**), while
`root recovery acquire` fails its receipt proof first and throws
`ROOT_OPERATION_PROOF_INVALID` (**exit 1**) — that identity is not a fence, so it does not
take the exit-3 path.

**Known limitation.** A run whose second-generation boundary emit was attempted with a
pre-1.13.0 binary can hold a stranded prepared journal; every later reconciled read or
mutation on it fail-stops. This release provides **no kernel recovery path and no approved
manual procedure** for that state — a safe procedure would need a maintainable maintenance
lock the kernel does not offer. Such a run is discarded or judged case by case. New runs
cannot enter the state.

**Conformance fixture.** `tests/fixtures/acquire-resume-conformance.json` declares six
orderings (`raw-first`, `wrapper-first`, `duplicate`, `stale-invocation`, `lost-ack`,
`principal-death`) as zero-dependency JSON, using only the public CLI and raw file
operations — no repository test helper. An external consumer replays the same seed and
steps under its own transport and compares `{exit, ok, reason, proceed}` plus the `final`
lease subset. Bind `$T0`/`$T1`/`$T2` per the fixture's `now_binding` rule — **offsets
relative to replay start**, because recovery safety samples the real clock inside the lock
and cannot be injected, so absolute timestamps make the replay drift.

## Kernel CLI: `insights` (Hill-Climbing)

deep-loop mines its own run history into deterministic insights via a 3-verb kernel subcommand
(`scripts/lib/insights.mjs`, spec §6):

> Note: `--now` is accepted by most kernel CLI subcommands, not just `insights emit` (e.g. `next-action`, `tick`, `respawn`, `budget check`, `recover`, `session-profile set`, `finish`). Accepted forms are epoch ms or ISO-8601 (date-only is interpreted as UTC midnight; datetimes require a `Z`/`±HH:MM` designator). Across all of them, a malformed, value-less, or out-of-range (`±8.64e15`) value produces a common `INVALID_NOW` message on stderr and exit 1; omitting `--now` falls back to `Date.now()`.

| Subcommand | Role | Fence | Exit |
|---|---|---|---|
| `insights [--run <id>] [--json]` | Computes metrics + candidates. **Default = spec §4 aggregation across all runs**; `--run` narrows `per_run` only (candidates/aggregates stay fleet-wide). **Read-only** | Not required | 0 / 1 (invalid run id) / 2 (usage) |
| `insights emit --owner <run_id> --generation <n>` | Emits an envelope via the 3-step order (tmp atomic write → `appendAnchored` `insights-emitted` event → tmp→final atomic rename) | **Required** (invariant #2) | 0 / 1 (invalid `--now` / lib error) / 3 (fence) / 2 (usage) |
| `insights latest [--json]` | Returns the **verified** latest insights. **Read-only** — skills (`/deep-loop` init, `/deep-loop-finish`) use only this command, never parse `.deep-loop/insights/*.json` directly | Not required | 0 / 2 (usage) |

The payload (`insights_schema_version` stays `1` — these are additive fields) also carries two trust-labels: `suspicious_active` — a subset of `excluded_active` flagging non-terminal, non-paused runs whose lease is `released`, or `releasing` with an expired/missing TTL (a dead-lease signal, not an extra exclusion) — and `post_finish_mutated` — terminal runs whose `finish` event is followed by a non-exempt event (the run stays in the aggregates; only the label is added). `insights emit`'s stdout JSON returns both label arrays at the top level too, so stdout-only consumers see them without parsing the envelope. `insights latest` additionally trusts a run only when exactly one non-auto-floor-cost event follows the `insights-emitted` event the artifact is bound to (by path + sha256), and that event is `finish` — any other event(s) after the anchor, or none at all, cause a fail-soft skip to the next candidate file. Consumers that surface insights candidates to a human (e.g. `/deep-loop-finish`'s candidate block) should display `suspicious_active` / `post_finish_mutated` alongside candidates whenever either array is non-empty.

## Safety Invariants

1. **proposal-only / human approval** — push, PR, merge, publish, delete, and marketplace/deep-suite sync are never executed automatically. v1 always surfaces a proposal and waits for human confirmation.
2. **Lease fencing** — every mutating kernel CLI requires matching `--owner` (run_id) and `--generation`. Stale sessions are rejected before any state change.
3. **Fail-closed on unmeasurable usage** — unattended (headless) sessions that cannot measure turns/tokens are rejected, not silently passed. The `drive-headless.mjs` driver enforces this.
4. **Circuit breaker** — 3 consecutive REQUEST_CHANGES latch the breaker; a human must explicitly run `node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" breaker reset --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>` (lease-fenced, human-only) to resume. (`/deep-loop-ack` is unrelated — it reduces comprehension debt.)
5. **Terminal states via proof only** — episode `done`/`approved`/`rejected`, workstream `merged`/`abandoned` can only be set through verified proof artifacts, not direct state patch. **Exception: episode `abandoned` is a human-gated (`--confirm`) escape for stranded episodes, not proof-derived.**
6. **No writes outside `.deep-loop/`** — all kernel writes go under `<project-root>/.deep-loop/`. External writes (deep-memory store, wiki) are delegated to those plugins' own skills.

## Installation and Discovery

The marketplace entries may be synchronized only after merge and separate approval. That sync has happened for v1.13.0 — the deep-suite registry pins the merged `main` commit. For anything newer than the pinned commit, use the local-repository paths below and do not infer that it has already been published.

| Surface | Local installation and discovery | After a local plugin change |
|---|---|---|
| Claude Code | Use `claude --plugin-dir /absolute/path/to/deep-loop` for unreleased local changes. For the pinned release, use `/plugin marketplace add Sungmin-Cho/deep-suite` and `/plugin install deep-loop@claude-deep-suite`. | Start a new session. |
| Codex CLI | Complete both coupled local-install steps below, then open `/plugins`. | Start a new task/session and verify it in `/plugins`. |
| Codex App | Complete the same coupled install. In the ChatGPT desktop app, select **Work or Codex**, open **Plugins**, and select deep-loop; continuation uses `workstream-session`. | **Restart the App**, then start a new task. |
| Grok CLI | Attended Darwin only. Grok 1.0.4 discovers the Claude-cache-loaded plugin; there is no `.grok-plugin` manifest. Use `claude --plugin-dir /absolute/path/to/deep-loop` or the pinned Claude marketplace install so the cache entry is present, then start a new Grok session. | Start a new Grok session. |

The Codex personal install is one coupled operation, not alternatives: first copy/place this repository at the official current personal plugin directory `~/.codex/plugins/deep-loop`; then add or update its entry in the local personal marketplace `~/.agents/plugins/marketplace.json` with `source.path` set to `"./.codex/plugins/deep-loop"`. Both steps are required. In the ChatGPT desktop app: select **Work or Codex**, then open **Plugins**.

On Windows the coupled locations are `%USERPROFILE%\.codex\plugins\deep-loop` and `%USERPROFILE%\.agents\plugins\marketplace.json`, whose entry must point `source.path` at the former directory. Requirements: Node >= 20 and no external npm dependencies.

Codex App install/discovery and in-task skill execution are supported by the plugin contract. There is **no automated app-native task creation** and **no private app-native task-creation URL or deep link**. For continuation, open a new task at the recorded project root and invoke `$deep-loop:deep-loop-resume`; the durable lease keeps the run paused until that manual step. **App smoke pending external evidence**: lifecycle support is implemented, but an App-specific smoke has not been run in this repository.

## Supported Surfaces

| Surface | Interactive skills | Attended continuation policy | Visible continuation | Manual resume | Headless continuation | Compaction safety net |
|---|---|---|---|---|---|---|
| Claude Code, macOS/Linux | Full | `workstream-session` — compact in place while the Workstream is open | Explicitly approved terminal/tmux/verified Claude Desktop handoff at the first-terminal boundary | **Officially supported** via `/deep-loop-resume` | Measured `claude -p` after the boundary only | Trusted direct Node PreCompact checkpoint + SessionStart restore |
| Claude Code, native Windows | Full | `workstream-session` — compact in place while the Workstream is open | Explicitly approved Windows Terminal/PowerShell handoff at the first-terminal boundary | **Officially supported** via `/deep-loop-resume` | Trusted native `claude.exe` after the boundary; otherwise fail-closed | Trusted direct Node PreCompact checkpoint + SessionStart restore |
| Codex CLI, macOS/Linux | Full | `workstream-session` — keep affinity until the first-terminal boundary | Explicitly approved terminal/tmux launch using the trusted runtime | **Officially supported** via `$deep-loop:deep-loop-resume` | Isolated `codex exec --json` after the boundary only | Plugin lifecycle hooks after trust review; version-dependent and gracefully absent |
| Codex CLI, native Windows | Full | `workstream-session` — keep affinity until the first-terminal boundary | Explicitly approved Windows Terminal/PowerShell launch | **Officially supported** via `$deep-loop:deep-loop-resume` | Isolated trusted `codex.exe` after the boundary; otherwise fail-closed | Plugin lifecycle hooks after trust review; version-dependent and gracefully absent |
| Codex App | Install/discovery and in-task execution | `workstream-session` — manual task change only at the first-terminal boundary | Manual new task only | **Officially supported** by opening a new task, then `$deep-loop:deep-loop-resume` | Optional isolated `codex exec` driver after the boundary | Plugin lifecycle hooks after trust review; version-dependent, graceful absence; App smoke pending |
| Grok CLI, macOS | Full (attended) | `workstream-session` — same conversation until the first-terminal boundary; compact unsupported | Explicitly approved Darwin terminal/tmux launch using the trusted grok runtime | **Officially supported** via `/deep-loop-resume` | Unsupported — no measured headless | Unsupported — plugin hook matcher `"*"` did not fire |

The `workstream-session` continuation policy applies on every host. An attended run defaults to interactive same-conversation work until the first-terminal boundary; unattended runs retain measured headless execution but cannot rotate mid-Workstream. Manual resume is a first-class supported path, not only an error fallback.

**Codex POSIX visible authority:** macOS/Linux automatic visible continuation requires the durable human-approved Codex runtime identity. `cmux` is runnable only when detection bound the same absolute bundled executable to the exact socket with a successful ping. `tmux` is supported after a human approves its canonical executable identity and detection binds that identity to the exact `$TMUX` socket, server PID, and session: the approved binary's `#{session_id}` must match, and an OS-bound pane ancestry proof (`#{pane_pid}` ↔ process ancestry) must independently derive the same session. On macOS, the fixed `/usr/bin/osascript` may launch only the positively detected iTerm2 or Terminal.app entry; finding that system binary alone never activates both launchers. Missing runtime approval returns `runtime-identity-unavailable`, identity or launcher drift fails closed around the spawned CAS, and no path substitutes a bare `codex` or a Claude process.

Native Windows means the Node control plane runs directly on win32 and the documented native commands use **PowerShell**; Windows Terminal and PowerShell remain separate approved launcher kinds. **WSL follows Linux behavior and is not native Windows**; a WSL executable or path is not authority for a native-Windows spawn. **Native Windows CI: pending external evidence** until the repository's Windows job actually runs after an approved push.

## Executable Trust and Native Windows Launchers

Automatic continuation never trusts command lookup alone. Runtime executable diagnosis/approval applies to the selected runtime on every supported OS; launcher executable approval is the additional native-Windows WT/PowerShell or POSIX tmux boundary. Substitute the installed plugin's canonical absolute root for `<absolute-deep-loop-root>` and run exactly one read-only diagnosis for the selected identity:

```text
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" runtime-executable diagnose --runtime <claude|codex|grok> --path "<human-supplied-absolute-exe>"
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" launcher-executable diagnose --kind <wt|powershell> --path "<human-supplied-absolute-exe>"
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" launcher-executable diagnose --kind tmux --path "<human-supplied-absolute-exe>"
```

Show the returned **canonical absolute path** (`canonical_path`) and **lowercase SHA-256** (`sha256`) to the user. Only after the user confirms that exact identity may the matching fenced approval run:

```text
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" runtime-executable approve --runtime <claude|codex|grok> --path "<same-absolute-exe>" --canonical-path "<diagnosed-canonical-path>" --sha256 "<diagnosed-lowercase-sha256>" --actor human --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical-project-root>" --run-id <run_id>
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" launcher-executable approve --kind <wt|powershell> --path "<same-absolute-exe>" --canonical-path "<diagnosed-canonical-path>" --sha256 "<diagnosed-lowercase-sha256>" --actor human --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical-project-root>" --run-id <run_id>
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" launcher-executable approve --kind tmux --path "<same-absolute-exe>" --canonical-path "<diagnosed-canonical-path>" --sha256 "<diagnosed-lowercase-sha256>" --actor human --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical-project-root>" --run-id <run_id>
```

Run only the line for the identity being approved. Identity drift fails closed and preserves or restores the pause; it never falls back to another executable or runtime.

The runtime/launcher Authenticode signer policy is **pending Windows observation** and is distinct from the already-observed **Claude Desktop handler pin** used only for the verified `claude://code/new` handler. There is **no bare PATH authority**, no shim (`.cmd`, `.ps1`, or wrapper) authority, and no bare `wt.exe` authority. A signer policy, path candidate, or `where.exe`/`Get-Command` result never substitutes for the explicit canonical identity contract.

For tmux, the bounded version probe accepts release-shaped output such as `tmux 3.4` or `tmux 3.4a`. Rolling/master labels such as `tmux next-3.4` are rejected intentionally; this is a fail-closed approval boundary.

## Standalone Operation

deep-loop is designed for **standalone** use — it does not require any other deep-suite plugin. When operating without siblings:

- Protocol defaults to `standalone` if no sibling plugins are detected (`detect-plugins` returns empty)
- Skills gracefully degrade: maker/checker dispatch uses `standalone` adapters
- All safety invariants, budget enforcement, and handoff mechanics work identically

When sibling plugins (deep-work, deep-review, deep-wiki, deep-memory) are present, deep-loop automatically detects them and uses their specialized skills as adapters.

### Agency-preservation fixture evaluation

Run the offline, read-only-isolated fixture bank separately from preflight: `npm run eval:fixture -- --out ./evals/results/local --now 2026-08-10T00:00:00Z`.

## Unattended (Headless) Automation

For cron or CI use, deep-loop includes `scripts/hooks-impl/drive-headless.mjs`. Set `DEEP_LOOP_UNATTENDED=1` in the host environment, then invoke Node directly:

```bash
# POSIX shell / WSL
DEEP_LOOP_UNATTENDED=1 node scripts/hooks-impl/drive-headless.mjs --project-root "<canonical_project_root>" --run-id <run_id>
```

```powershell
# Native Windows PowerShell
$env:DEEP_LOOP_UNATTENDED = '1'
node scripts/hooks-impl/drive-headless.mjs --project-root "<canonical_project_root>" --run-id <run_id>
```

For **Claude**, the headless driver parses bounded `claude -p --output-format json` output. For an approved **Codex** runtime, it uses an authenticated isolated `CODEX_HOME`, shell-free `codex exec --json`, and incremental JSONL parsing. Each path records exactly one measured turn; timeout, non-zero exit, malformed output, or unmeasurable usage **fails closed**. There is no cross-runtime fallback. The isolated Codex child disables plugins and hooks (as well as Apps and remote capabilities), so it executes the absolute resume skill workflow inline and relies on durable state plus measured process exit.

## deep-suite Integration

When used within the deep-suite, deep-loop acts as the orchestration backbone:

- **deep-work** — maker/checker adapter for implementation workstreams
- **deep-review** — checker adapter for code review workstreams  
- **deep-wiki** — writer adapter for documentation workstreams
- **deep-memory** — called by `/deep-loop-finish` to archive run artifacts

The `adapter resolve` CLI returns normalized 4-verb descriptors (dispatch/await/read/checker_via) for each protocol, letting skills dispatch the right sibling without hardcoding adapter logic.

## Visible Session Continuity (Self-Spawn)

After explicit attended authorization sets `autonomy.spawn_style` to `'visible'` and deep-loop detects a supported terminal multiplexer, it can spawn the next boundary session in a new visible window:

| Launcher | Detection signal | New session target |
|----------|-----------------|-------------------|
| cmux | `CMUX_BUNDLED_CLI_PATH` + `CMUX_SOCKET_PATH` + surface ID | new cmux workspace via socket |
| iTerm2 | `TERM_PROGRAM=iTerm.app` + osascript probe | new iTerm window |
| Terminal.app | `TERM_PROGRAM=Apple_Terminal` + osascript probe | new Terminal window |
| tmux | `$TMUX` + human-approved canonical tmux identity + socket ownership/server-PID probe + session binding (approved binary derives matching `#{session_id}`) + OS-bound pane ancestry proof (`#{pane_pid}` ↔ process ancestry) | new window in the detected tmux session |
| Windows Terminal | `WT_SESSION` + approved canonical launcher identity | new WT tab through the exact approved executable |
| desktop | (user opt-in) Claude Desktop Code tab | opens a verified Claude Desktop handler via `claude://code/new` deeplink — **semi-automatic**: user confirms folder + presses Enter. macOS (path + bundle-id + codesign TeamIdentifier) and, since v1.7.0, **Windows** (traditional-installer exact paths + MSIX path pattern with a pinned publisher-id hash, plus an Authenticode signer thumbprint **pinned from a real Windows 11 observation**). On Windows the offer appears only when the live probe verifies the installed handler; after the pinned leaf cert rotates (NotAfter ~2026-10-21) dispatch returns to deterministic fail-closed until a newly observed thumbprint is re-pinned — guessed pins are never used. |

The spawn is **attended-only** and boundary-only: the parent session must be interactive and carry durable `attended_launch_approval`. If the parent is headless (`DEEP_LOOP_UNATTENDED=1`, `spawn_style='headless'`, or a headless-entrypoint is detected), visible spawn is bypassed; it never grants a mid-Workstream rotation.

**OS-agnostic fallback**: If no launcher is detected (`launcher='none'`), or the session is not attended, `respawn` returns `{ok:false, outcome:'no-launcher'}`. The skill then calls `pauseRun({mode:'preserve'})`, keeping the reserved child in the handoff. A human opens a new terminal and runs `/deep-loop-resume` in Claude Code or `$deep-loop:deep-loop-resume` in Codex, or the reserved child session starts later and acquires the still-releasing lease — either path unpauses the run automatically. The handoff document and `launch-command.txt` always provide a runtime-correct copy-paste command for manual use.

**Gate order**: budget → breaker → max_sessions → wallclock → auto_handoff. A gate failure triggers `rollbackAndPause` (lease rolled back, child invalidated). A launch command failure also rolls back. A readiness timeout uses `preservePause` (child kept, late acquire still succeeds).

## PreCompact Hook

deep-loop registers `PreCompact`, `PostCompact`, and `SessionStart` hooks. PreCompact's emit-only, best-effort action follows `workstream-session`; unattended continuation remains assigned to the measured `scripts/hooks-impl/drive-headless.mjs` driver. Under `workstream-session`, an open bound Workstream affinity receives a bounded checkpoint and keeps the same conversation; PreCompact returns `no-affinity` otherwise and never emits a handoff for that policy. A first-terminal boundary handoff is selected by `next-action`, not by PreCompact. Migrated legacy policies alone retain the PreCompact handoff path. PostCompact is CLI-observe-only. A `SessionStart(compact)` hook can inject a matching checkpoint context or boundary/recovery guidance. The **exact hook definitions** in `hooks/hooks.json` must be trusted by the host. They are direct shell-free Node safety nets. No hook owns or spawns a session, and exceptions never block compaction or session start.

`hooks/hooks.json` uses static, shell-free Node bootstraps that resolve `CLAUDE_PLUGIN_ROOT` (or `PLUGIN_ROOT`), import `scripts/hooks-impl/precompact-handoff.mjs`, `scripts/hooks-impl/postcompact-observe.mjs`, or `scripts/hooks-impl/sessionstart-restore.mjs` through a file URL, and invoke `main()`. The bootstraps do not depend on a Bash wrapper or shell expansion.

Codex bundled-hook discovery is host-version-dependent and occurs only after the user reviews and trusts the plugin hook definition. For a **missing or untrusted hook** (including an unsupported host version), manual compact restore reads fresh evidence for the same owner and open bound Workstream affinity; only that proof permits state-derived continuation. Otherwise it chooses preserve-pause and the officially supported manual resume path. This fallback never weakens fencing or grants a second owner. The deliberately isolated Codex child disables plugins and hooks, so this fallback is also its expected continuity model.

## License

MIT — see LICENSE.
