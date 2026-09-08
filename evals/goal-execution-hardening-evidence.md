# Goal execution hardening: validation boundary (1.24.0)

This change improves support checks, process/review evidence, budget admission,
and failure reporting. It does **not** establish reliable or efficient autonomous
goal completion. The goal driver remains experimental.

## Measured local pilot — 2026-09-08

Runtime source: `bc2acf60e111368b8e7c59cdbf07e1eedd57c68f`.
Requested model/effort: `gpt-6-astra` / `high`; served-model identity unavailable.
Profile: `evals/profiles/agent/goal-agent-pilot-v2.json`, seed 20260908,
45 scheduled rows (5 tasks × 3 profiles × 3 trials), 600-second trial horizon,
120-second harness calls, 500,000 measured-token admission limit per trial.
Native uses one call with the full trial horizon; harness profiles share that
horizon across owner, checker and readiness calls. Segmentation differs.

| Profile | Scheduled | Attempted | Passed | Budget exceeded | Unavailable |
|---|---:|---:|---:|---:|---:|
| native | 15 | 2 | 2 | 0 | 13 |
| minimal | 15 | 3 | 0 | 3 | 12 |
| current | 15 | 1 | 0 | 0 | 15 |
| Total | 45 | 6 | 2 | 3 | 40 |

Of the 40 unavailable rows, 39 were not started. The sixth attempt timed out
without complete usage; owned process-group termination was confirmed. The
predefined fail-closed stop rule prevented further trials. The five fully
measured attempts passed the behavioral oracle, but no harness attempt reached
kernel completion. Known tokens totaled 1,803,053; the timed-out call's usage
is unknown and is not counted as zero. Source manifests were stable.

This is an incomplete pilot with substantial unavailable data, not an estimate
of general model quality, an uplift claim, or a 45-execution success rate.
Raw traces and receipts remain in the local worktree's ignored evidence directory.

## Separate diagnostics

Two 120-second default-call smokes timed out with incomplete usage. Two explicit
180-second-call current-profile trials (runtime source `7e67512`) passed the
behavior oracle but consumed 599,540 and 540,355 tokens. Both paused before kernel
completion after overshooting the 500,000-token admission limit in flight.
Changing the call timeout alone did not establish end-to-end completion.

Controlled host-loss checks use an injected provider and an actual owned host
SIGKILL. Their safe-refusal result is safety evidence, not real-model efficacy or
automatic recovery. Process loss does not authorize provider-thread adoption.

## Review and release boundary

One protected R2 reviewer receipt was valid; its accepted findings were addressed.
The second reviewer timed out twice. A subsequent response from the first reviewer
had invalid output formatting and was used only as investigative input.
Dual independent review is incomplete. This document is not merge or release
approval; the release gate must be resolved explicitly.
