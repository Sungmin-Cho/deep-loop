# Goal-driven execution (state v0.5)

The model owns decomposition, implementation choices, evidence interpretation and
replanning within the user's goal. The kernel owns state, identity, execution
records and proof validation. Keep the original outcome requirements intact.
User authorization already given for concrete work persists across ticks and
compaction. Request only genuinely missing information or new authority.

## Entry

Use this path for new goal-driven runs. Keep existing v0.4 runs on their documented
compatibility path; do not convert an active state file.

1. Preserve the user's complete goal, constraints and authorized delivery steps.
   Compile observable outcomes into `GoalContractInput`:
   `{version:1,requirements:[{id,statement,acceptance}],non_goals:[]}`.
   Use 1–64 unique IDs. Requirements describe results, rather than a mandatory
   tool sequence. Resolve material ambiguity before creating the run.
2. Choose a supported maker protocol using task scope, actual sibling availability
   and explicit user preferences. Preserve recipe-specific contracts. Use an
   implementation review by default; include design/plan reviews when required by
   the task, recipe or user. A normal delegated choice needs no additional survey.
3. Read `goal capabilities --runtime <host>` and verify the corresponding host
   mechanism. `native` means a fresh independent reviewer context; a Grok native
   subagent does not provide this independence. An implemented transport is not a
   successful availability probe. If no supported mechanism is available, report
   that capability gap before init instead of starting an unfinishable run.
4. Invoke `init-run` with the preserved goal, `--goal-contract <JSON>`, explicit
   runtime, selected protocol and `--supervision delegated --boundary-mode continue`.
   Honor an explicit human/handoff choice. A supplied review JSON must agree with
   supervision (`require_human_ack:false` for delegated, `true` for human).
   Pass text/JSON as individual argv values using a shell-free call or safe quoting.
5. Create actual worktrees inside the project and record each through
   `workstream new ... --requirements '["REQ-A"]'`. Plan only useful work;
   requirements may be served together or across several workstreams. Start
   continuation immediately when the user authorized execution.

## Continue

Apply the common root/runtime and compact-capsule admission rules first. Read the
immutable goal contract once per restored context, then consume a fresh
`next-action --json`. Its v0.5 `identity` provides the current root/run/owner and
generation for subsequent calls; writers recheck that fence inside the lock.
Use sequential reads on the same run. Re-read identity after a long external wait.
Every mutation below also takes `--project-root`, `--run-id`, `--owner` and
`--generation`. The `help` output is the flag vocabulary.

| Action | Work to perform |
|---|---|
| `plan_next_work` | Inspect the unmet point, requirement IDs, obligations or review failures. Choose the next task and acceptance artifacts. Reuse pending work; create a mapped workstream or maker only when needed. |
| `select_workstream` | Call `workstream select --id ... --expected-scope ... --reason ...` with the returned token. A blocked inline attempt remains resumable. Resolve any pending compact transaction through its original restore route first. |
| `dispatch_maker` / `resume_maker` | Use the shared execution path below. Enter the action's actual worktree. |
| `fix_episode` | Inspect the rejected checker's `target_maker`; create a **pending** fix with `episode new --kind fix --retry-of ...`. Reclassify a new retry using observed failure evidence, then execute it through the same path as any maker. |
| `dispatch_checker` | Dispatch the required review, then use the claimed-checker sequence below. |
| `reconcile_execution` | Locate the existing attempt/task/receipt. Attach to a live producer, consume a returned result, or establish observed absence before starting it. A pending checker needs its existing episode claimed, not another dispatch. |
| `close_workstream` | Call `workstream terminal --id ... --status ready --proof '{}'`. The kernel checks the actual maker/review proof. |
| `dispatch_goal_checker` | Perform the separate whole-goal review below. |
| `reconcile_goal_review` | Reconcile that exact goal attempt; retain its snapshot, handle and output bytes. |
| `handoff` | Follow the canonical exact-boundary handoff route. |
| `finish` | Check final goal status and finish. `already_terminal:true` means report the existing outcome without another mutation. |
| `await_human` | Report the actual blocking condition. Existing approval is not missing approval; unavailable producer identity or a hard gate is not success. |

After each completed action, continue with a fresh tick until the goal completes,
the user stops, a hard gate applies, or required input is genuinely unavailable.
`plan_next_work` deliberately invites model judgment; the legacy prohibition on
adding judgment does not apply to this v0.5 branch.

## Shared maker path

Prepare once with `execution prepare --episode ... --mode inline|external
--stage primary|continuation --task ...`. The kernel returns an attempt and an
invocation descriptor. `created:false` is an existing intent, not permission to
start another external producer.

- **Inline:** do the actual work in the current owner conversation. Interrupted
  work resumes the same attempt. If a prerequisite requires switching, first
  record the maker blocked after its tools are quiescent, then select the
  prerequisite; retain the original attempt for return.
- **External:** invoke once after a newly prepared intent, then register the
  observed handle with `execution start`. On interruption, use the native host's
  task/result observation or a verified supervisor receipt. Missing report files
  alone cannot establish absence. Unknown liveness needs resolution before retry.
- **Return:** submit actual artifacts through `execution return`. External return
  also includes its observed producer result. Only a final required stage can
  derive maker `done`; an `in_progress` label or a planning file cannot do so.
- **Superpowers:** execute `writing-plans`, return its actual plan artifact, then
  prepare `continuation` and invoke `subagent-driven-development` with the returned
  `plan_path`. Return its implementation artifacts only after that invocation
  actually finishes. Planning-only work cannot claim implementation completion.

For example, these are argv arrays, with values supplied from the fresh frame:

```javascript
const base = [cli, '--project-root', root, '--run-id', runId,
  '--owner', owner, '--generation', String(generation)];
// Place the command/verb directly after cli; append the shared locator/fence.
const prepare = [cli, 'execution', 'prepare', '--episode', episodeId,
  '--mode', 'inline', '--stage', 'primary', '--task', task, ...base.slice(1)];
const returned = [cli, 'execution', 'return', '--episode', episodeId,
  '--attempt', attemptId, '--artifacts', JSON.stringify(actualArtifacts), ...base.slice(1)];
```

Freeze routing on a resumed attempt. A new retry can use a fresh route. An inline
owner records a model/effort only when it matches the observed current profile;
choosing another model requires an actual external dispatch.

## Claimed ordinary checker

Use `review dispatch`, then `review claim --episode <checker_id>`. Give a fresh
independent reviewer the claim's actual subject and artifact contract. Register
its actual handle, observe its return with `execution return`, then submit the
raw reviewer body through `review import --stdin` using the claim-derived
reviewer/checker/maker/attempt/artifact fields. `review record` cannot finish a
claimed checker. A process return alone is never a reviewer verdict.

## Whole-goal checker

`goal dispatch --transport ...` creates a run-level review without reopening a
workstream. Give the independent reviewer the original goal/contract, the bounded
snapshot manifest and the exact GoalResult schema. Assess the integrated project
as well as workstream evidence. Return one assessment for every requirement,
using real snapshot evidence refs and reasons for failed/blocked requirements.

Keep the reviewer's raw JSON bytes. Register the observed handle with `goal start`.
For a native reviewer, `goal reconcile --observation <JSON>` records
`{source:"native-task",state:"succeeded",handle,reference,output_sha256}` where
the digest comes from those exact returned bytes. Then pass the same bytes to
`goal record --stdin`. The parent supplies transport metadata, not replacement
assessments. A returned digest is sealed. Invalid returned output may be marked
failed with that same digest so a genuinely new attempt can be reviewed.

Measured Codex/bridge transports use their goal-capable host adapter and trusted
process receipt. They do not run the legacy text PASS/FAIL parser on GoalResult.
Preserve the actual raw result and usage; unavailable output remains unavailable.

Required discoveries use `goal obligation`; advisory triage cannot clear them.
`goal obligation-resolve --workstreams ...` derives resolution from completed
mapped work. A human override requires actual user authorization and the explicit
human/confirm/reason route; it never waives an original requirement.

## Finish

Use `goal status --json`. A stale proof calls for a fresh review; a fresh rejected
result calls for real follow-up work for its failed IDs. Continue mode can do
either in the current owner. In handoff mode the exact closed boundary comes
first, and the successor's unbound session performs the final goal review.

Write the final report at the resolved run directory, then call the proof-gated
`finish --status completed`. The kernel rechecks source and evidence freshness.
Report external delivery truthfully and perform already-authorized actions within
their actual scope. New external authority still comes from the user.

Under the measured headless goal driver, yield for checker service and before
final finish so the trusted host can settle the current turn. The driver resumes
the same persistent owner thread for remaining work; it does not start an
unrelated owner mid-workstream.

## Measured host and bridge execution

`goal drive` is the bounded Codex owner controller. Its verified v0.5 host frame
embeds [DEEP_LOOP_ROOT/skills/deep-loop-workflow/references/goal-owner.md](goal-owner.md)
as the current owner policy; it does not repeat generic entry or legacy discovery. It preserves the exact provider
conversation while the owner identity remains unchanged; it yields for independent
review and measured cost settlement. A lost provider binding is unavailable: do not
substitute `--last` or start an unrelated conversation. The minimal experimental
profile supports `boundary-mode continue`; current supports canonical handoff.

For an attended Grok goal, use `bridge` only after the installed read-only bridge
probe is ready. Invoke `goal dispatch --transport bridge`, then
`goal bridge-descriptor --id <review_id> --attempt <attempt_id> --direction <direction> --model <model> --effort <effort>`
with the current root/run/owner/generation. The descriptor supplies exact argv and
required directories. Create those directories, run `start`, `exec`, `finalize`,
then `record` in order. Finalization is read-only with respect to loop state;
`goal bridge-record` validates the receipt and raw goal result through the kernel.
Do not translate an ordinary PASS marker into whole-goal approval or treat cached
bridge attestation as proof that a live reviewer succeeded.
