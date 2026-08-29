# Route E — bridged independent process (Grok attended owner)

## 실행 루트

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

Grok native `spawn_subagent` isolation is unverified. This route is the
**separate-process** checker path: `dispatch_agent.py` supervises a read-only
`claude -p` or `codex exec` child. The Grok owner conversation is not the
checker. Inline review, `deep-review:*` Skill, and `spawn_subagent` checker
remain forbidden in this conversation.

`review dispatch` / `review record` / `review import` still take **no**
`--runtime`. The `--runtime grok` flag on `dispatch_agent.py` is receipt
provenance only.

## Preconditions (all AND; else Route D)

| # | Check | Enforced by |
|---|---|---|
| E-0 | Attended: `isHeadlessInvocation` is false and `autonomy.spawn_style !== 'headless'` | probe |
| E-1 | durable `session_runtime` is grok (`review bridge-probe` reports `bridge`) | probe |
| E-2 | `review bridge-probe --json --run-id <run_id>` returns `ready: true` | probe |
| E-3 | durable `review.reviewer` is `subagent-checker` (or omitted default) | LLM-evaluated |
| E-4 | `recipe.id !== 'harness-hill-climb'` | kernel `REVIEW_CONTRACT_UNENFORCEABLE` |
| E-5 | checker router exit 0/4; `selected_model` family maps to a `ready_directions` entry (claude-* → `to_claude`, gpt-* → `to_openai`; xai → Route D) | LLM-evaluated |
| E-6 | child binary `--version` responds (existence only) | LLM-evaluated |
| E-7 | `git check-ignore -q --no-index -- .deep-review/bridge/probe` succeeds in the recorded worktree | LLM-evaluated |

Evaluate E-2 before `review dispatch`. Missing/unverified transports, untrusted
locator paths, write-capable seats, and python3/dispatcher absence all stay
Route D with no pending checker.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review bridge-probe --json --project-root "<canonical_project_root>" --run-id <run_id>
```

`--json` and `--run-id` are required. Fence flags are not. `ready: false` is
exit 0; the JSON `reasons[]` explain why.

## Dispatch then spawn

Route E is **dispatch-first**, same as A/C. Static failures (E-0–E-7) happen
before `review dispatch`. Live process failure leaves a pending checker that
`next-action` surfaces as `await_human:pending-checker-unresolved` (no
re-dispatch). On this path ignore the kernel descriptor `kind: 'agent'` /
`agent_role` — do not spawn a host subagent. The bridged child is the checker.

Checker routing is a **separate** `route_task.py` call. Grok does not degrade
without `--routing` — missing routing is Route D.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review dispatch --point <review_point> --workstream <workstream_id> --routing '<routing_json_compact>' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

Attempt-scoped scratch (project-root relative in argv):

- `<recorded-worktree>/.deep-review/bridge/<ck>-a<N>-request.md` — owner **input**
- `<recorded-worktree>/.deep-review/bridge/<ck>-a<N>-report.md` — finalize output
- `<recorded-worktree>/.deep-review/bridge/receipts/`

The child writes **no** files. `--require-artifact` is not used.

## Spawn

Do not feed the prompt via stdin (`--prompt-file` omitted → child stdin is
DEVNULL). `bridge-exec` re-parses the probe mechanism, substitutes
placeholders, and appends the child argv — do not pass a hand-expanded
claude/codex tail. No `--bare`. No extra flags. Pick the `ready_directions`
entry that matches the checker model family (`to_claude` for claude-*,
`to_openai` for gpt-*; xai is Route D) and use that same direction for
`--direction`, `--transport-id`, mechanism, and findings. The argv template
below shows `to_claude`; swap those fields for `to_openai`.

```
node "DEEP_LOOP_ROOT/scripts/bridge-exec.mjs" --cwd "<absolute-worktree>" --sidecar "<absolute-worktree>/.deep-review/bridge/receipts/<ck>-a1-cwd.json" --dispatcher "<probe.router.dispatch_agent>" --mechanism '<probe.directions.to_claude.mechanism>' --direction to_claude --model <descriptor.selected_model> --effort <descriptor.selected_effort_native> --prompt "Independent review. Read <recorded-worktree>/.deep-review/bridge/<ck>-a<N>-request.md and write only stdout." -- python3 <probe.router.dispatch_agent> run --attempt-id <ck>-a1 --receipt-dir "<absolute-worktree>/.deep-review/bridge/receipts" --deadline-seconds 900 --grace-seconds 15 --seat reviewer-1 --runtime grok --transport-id grok.to_claude --model-id <descriptor.selected_model> --effort-native <descriptor.selected_effort_native> --output-schema review
```

v1 seats are read-only. Probe rejects write tokens (`acceptEdits`,
`workspace-write`, …) and requires a tools allowlist for `to_claude`. Codex
uses `-s read-only` (or `<sandbox>` substituted to `read-only`).

`claude -p` must **not** receive `--bare`.

## Finalize and record

On supervisor SUCCEEDED:

```
node "DEEP_LOOP_ROOT/scripts/bridge-finalize.mjs" --cwd "<absolute-worktree>" --receipt "<absolute-worktree>/.deep-review/bridge/receipts/<ck>-a1.json" --attempt-id <ck>-a1 --dest "<absolute-worktree>/.deep-review/bridge/<ck>-a1-report.md"
```

`bridge-finalize` reads `result.output_sha256` from that receipt and copies
only when `state` is `SUCCEEDED`, `output_schema` is `review`,
`schema_valid` is true, and `termination_confirmed` is true. Owner LLM must
not edit the report. Compare sidecar `cwd_realpath` to the recorded worktree
realpath before record.

The request file must tell the child to emit exactly one line
`verdict: PASS` or `verdict: PASS_WITH_CHANGES` or `verdict: FAIL` with no
trailing text on that line. Supervisor grading uses a word-boundary token;
finalize requires that unique end-anchored line.

Verdict mapping (stdout is authoritative):

- `PASS` → `APPROVE`
- `PASS_WITH_CHANGES` → `REQUEST_CHANGES`
- `FAIL` → `REQUEST_CHANGES`
- 0/duplicate/unknown tokens → do not record

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review record --episode <ck> --verdict <APPROVE|REQUEST_CHANGES> --report "<recorded-worktree>/.deep-review/bridge/<ck>-a1-report.md" --findings "bridge:grok.to_claude attempt:<ck>-a1 receipt:<recorded-worktree>/.deep-review/bridge/receipts/<ck>-a1.json output_sha256:<hex>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

`--report` is **project-root relative**. Live failures never call `review record`.

## Recovery

Autonomous ticks do not recover. After `await_human:pending-checker-unresolved`:

1. `dispatch_agent.py status`
2. `cancel` when RUNNING or TERMINATION_UNCONFIRMED
3. Prove the process group is dead; quarantine the worktree until then
4. CLAIMED-without-receipt: cancel refuses it — confirm death, then human-gated claim cleanup
5. After death: (a) same episode, fresh `-a<N+1>`; (b) human/Claude/Codex session closes review; (c) `episode abandon --confirm` (does **not** satisfy the review point; next tick re-issues `dispatch_checker`)

`TERMINATION_UNCONFIRMED` forbids automatic retry.

## Scope

New runs, and existing runs whose durable reviewer is already
`subagent-checker`. `deep-review-loop` Grok runs stay Route D. Compact and
measured headless are out of scope.
