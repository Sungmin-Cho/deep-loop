# Host-driven v0.5 owner

Apply this specialization only when the trusted `goal drive` host supplies a verified v0.5 owner frame. It is the current host-owner policy; the selected maker adapter's contracts still apply. Other entry, runtime and visible-session paths retain their existing skills and authority boundaries.

## Use the supplied frame

Retain the supplied absolute Node/kernel paths, project root, run/owner/generation, event-log head, scope epoch, `routing.protocol`, review configuration, workstreams, current action and immutable goal contract. These are validated context, not guesses requiring another discovery pass. The host embeds this exact shipped policy; no extra file-read call is needed. Do not reload unchanged continue/entry/legacy instructions, protocol files or state fields.

Use the supplied action and remaining host budget first. Token accounting includes cached input and updates when a measured process returns. After completing an action, obtain `next-action --json`; retain its action and verify its identity against the host frame. A changed owner/generation yields to the host; reading identity does not transfer ownership. Refresh after external waits, a stale token/fence response, or changed context. Never retry a failed mutation blindly. If a genuinely required binding is missing, obtain one fresh state snapshot and retain the needed information. The kernel remains authoritative for lease, scope, budget, breaker, prerequisites, review and completion proof.

## Execute useful work

Choose decomposition, implementation strategy, tests and necessary discoveries from the original outcomes. Reuse existing pending work. You may batch independent reads and run several sequential action steps in one tool call; preserve dependencies and check every result. Perform one bounded logical action or one maker stage, then yield. Batch its predictable steps; do not start another maker or review round in the same owner invocation.

Use shell-free argv. This example validates argument types, bounds output, and stops the sequence on command or JSON failure. `NODE`, `CLI`, `root`, `runId`, `owner` and `generation` come from the host frame; check them against fresh `next-action` identity.

```javascript
import { spawnSync } from 'node:child_process';
function kernel(args, write = true) {
  if (!Array.isArray(args) || args.some(x => typeof x !== 'string'))
    throw new Error('Expected string argv');
  const locator = ['--project-root', root, '--run-id', runId];
  const fence = write ? ['--owner', owner, '--generation', String(generation)] : [];
  const r = spawnSync(NODE, [CLI, ...args, ...locator, ...fence], {
    cwd: root, shell: false, encoding: 'utf8', timeout: 30000,
    maxBuffer: 262144,
  });
  if (r.error || r.signal || r.status !== 0)
    throw new Error(String(r.stderr || r.error || `exit ${r.status}`).slice(0, 4096));
  return JSON.parse(r.stdout);
}
```

Hot-path argv, excluding the helper's shared locator/fence:

```javascript
const ws = kernel(['workstream', 'new', '--title', title,
  '--branch', branch, '--worktree', worktree,
  '--requirements', JSON.stringify(requirementIds)]);
const selection = kernel(['next-action', '--json'], false);
if (selection.action.type === 'select_workstream' && selection.action.workstream_id === ws.id)
  kernel(['workstream', 'select', '--id', ws.id,
    '--expected-scope', selection.action.expected_scope, '--reason', 'next-workstream']);
const maker = kernel(['episode', 'new', '--plugin', protocol,
  '--role', 'maker', '--kind', kind, '--point', point,
  '--workstream', ws.id, '--artifacts', JSON.stringify(expectedArtifacts)]);
const next = kernel(['next-action', '--json'], false);
// Verify identity; prepare only when next.action requests this maker/stage.
const prepared = kernel(['execution', 'prepare', '--episode', maker.id,
  '--mode', 'inline', '--stage', stage, '--task', task]);
// Perform prepared.invocation and verify its actual outputs before return.
kernel(['execution', 'return', '--episode', maker.id,
  '--attempt', prepared.execution.attempt_id,
  '--artifacts', JSON.stringify(actualArtifacts)]);
const after = kernel(['next-action', '--json'], false);
```

This is argument syntax, not permission to skip an intervening kernel action. Bind dependent calls to actual returned IDs/attempts; never predict IDs or issue dependent mutations concurrently. On resume, use the existing episode, frozen task and attempt. `created:false` does not authorize another producer. Execute `prepared.invocation`; resolve missing adapter information through `adapter resolve --protocol <routing.protocol> --task <task>`, not a guessed filesystem path. Superpowers implementation requires actual `writing-plans`, return of its plan, then `continuation` preparation and actual `subagent-driven-development` using the returned `plan_path`. Standalone evidence does not validate sibling integrations.

Create the chosen internal `.worktrees/<slug>` directory before registering it. A plain internal directory is supported; Git metadata creation is not a prerequisite. Keep the required declared branch string without claiming a Git worktree was created. Never initialize a nested or foreign Git repository to bypass that denial. Return real regular-file artifacts within the workstream. When delivery targets the project root, integrate and test there separately, recording root-file hashes, commands and outcomes in a workstream validation artifact. A passing workstream test alone does not establish integrated delivery.

For selection, use `workstream select --id TARGET --expected-scope TOKEN --reason REASON`. Park only quiescent work; blocked inline work keeps its attempt. Unknown external liveness must be reconciled. Create fixes with `episode new` plus `--kind fix --retry-of TARGET_MAKER`; retain the required plugin/role/point/workstream/artifact arguments.

## Yield at service boundaries

- `dispatch_checker`: `review dispatch --point POINT --workstream WS` under the configured reviewer, then yield. Do not claim, run or impersonate the independent reviewer.
- Goal review or unresolved external producer: yield the exact action/attempt to the host.
- `close_workstream`: yield; the host commits the kernel-derived closure after its proof checks.
- `handoff`: emit only the supplied current boundary with `handoff emit --headless --reason workstream-terminal --boundary-event SEQ:CHECKSUM`, then yield for canonical host service.
- `finish`: put factual goal/results, changed files, test evidence, review references and remaining limits in `report_template.payload.markdown`. Update `envelope.generated_at` to the write time and write that M3 JSON object to the absolute `report_path`; then yield before finish so the host settles usage. Already-terminal runs need no mutation.

Preserve every requirement and obligation. Never fabricate human credit, checker proof or usage. Existing external-action restrictions remain binding; this policy grants no new permission. Honor existing authorization. If genuinely missing information or authority prevents progress, call `pause --reason REASON` with the current fence and yield; the host returns that reason without another owner call.
