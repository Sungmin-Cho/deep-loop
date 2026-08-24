# deep-suite post-merge SHA-bump procedure — deep-loop

> **Status: proposal only; not synchronized or released.** Post-merge execution requires separate approval. This procedure is authorized only after the deep-loop PR has merged and a separate post-merge sync approval has been granted. Push, PR, merge, publish, delete, and marketplace/deep-suite sync remain separate human-approved actions. `<MERGED_MAIN_SHA>` means the exact 40-character commit on deep-loop `main`; this file is not evidence that either marketplace already uses it.

deep-loop is already registered in deep-suite. Do not add a duplicate entry. The post-merge change updates the two existing marketplace pins, refreshes the sidecar inventory, regenerates generated docs, and passes the deep-suite release gates.
Marketplace sync remains proposal-only even when every source and preflight gate is green.

## Authorized sequence

1. In deep-loop, run `npm run preflight` on the source commit intended for its PR. After separately approved push, PR, and merge, read the merged `main` SHA and verify it is 40 lowercase hexadecimal characters.
2. After **separate post-merge sync approval**, create a deep-suite branch. In both `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`, change only the existing `deep-loop.source.sha` to `<MERGED_MAIN_SHA>`. The two pins must be byte-identical.
3. Update the existing `deep-loop` object in `.claude-plugin/suite-extensions.json` to the inventory below. Do not create a second plugin object.
4. Run deep-suite `npm run docs:write` to regenerate the generated docs (README/CLAUDE/guide marker regions); never edit generated marker contents by hand.
5. Run deep-suite `npm run preflight`. Review the marketplace-pin diff, sidecar diff, and generated docs, then use a separately approved deep-suite PR and merge. A later publish, tag, or deletion still needs its own approval.

The pinned-path checker fetches the deep-loop repository at the proposed SHA. A local-only or unpushed SHA cannot satisfy that gate.

## Marketplace pin edits

Apply the same replacement in both marketplace files:

```diff
 {
   "name": "deep-loop",
   "source": {
     "source": "url",
     "url": "https://github.com/Sungmin-Cho/deep-loop.git",
-    "sha": "<OLD_SHA>"
+    "sha": "<MERGED_MAIN_SHA>"
   }
 }
```

Targets:

- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`

## `.claude-plugin/suite-extensions.json` inventory

The existing object remains Node-only and declares both hook event types. `SessionStart` is active only for its `compact` source filter (the plugin hook manifest expresses this as matcher `compact`).

```json
"deep-loop": {
  "runtime": ["node"],
  "capabilities": [
    "orchestration",
    "loop-state",
    "durable-state",
    "checkpoint",
    "handoff",
    "respawn",
    "cross-plugin-routing",
    "budget-breaker-gates",
    "project-root-recovery"
  ],
  "artifacts": {
    "writes": [
      ".deep-loop/runs/<run-id>/loop.json",
      ".deep-loop/runs/<run-id>/event-log.jsonl",
      ".deep-loop/runs/<run-id>/observations/<subject_sha256>.json",
      ".deep-loop/runs/<run-id>/handoffs/<ts>-next-session.md",
      ".deep-loop/runs/<run-id>/checkpoints/<checkpoint-key>-compact.json",
      ".deep-loop/runs/<run-id>/checkpoints/<checkpoint-key>-compact-observation.json",
      ".deep-loop/runs/<run-id>/checkpoints/<checkpoint-key>-compact-prune.json",
      ".deep-loop/runs/<run-id>/compact-restore-intents/<operation-id>.prepared.json",
      ".deep-loop/runs/<run-id>/transactions/<operation-id>/prepared.json",
      ".deep-loop/runs/<run-id>/transactions/<operation-id>/committed.json",
      ".deep-loop/runs/<run-id>/recoveries/<child-run-id>-affinity-recovery.json",
      ".deep-loop/runs/<run-id>/recoveries/<child-run-id>-boundary-recovery.json",
      ".deep-loop/runs/<run-id>/recoveries/root/<replacement-session-id>.json",
      ".deep-loop/runs/<run-id>/recoveries/root-operations/<operation-id>.json",
      ".deep-loop/runs/<run-id>/terminal/launch-command.txt",
      ".deep-loop/runs/<run-id>/terminal/launch-command.meta.json",
      ".deep-loop/runs/<run-id>/reviews/<sha256>.json",
      ".deep-loop/runs/<run-id>/preflight/cache/<cache-key>.json",
      ".deep-loop/runs/<run-id>/preflight/accounting/<cache-key>.json",
      ".deep-loop/runs/<run-id>/preflight/process-receipts/<receipt>.json",
      ".deep-loop/runs/<run-id>/final-report.md",
      ".deep-loop/current"
    ],
    "reads": [
      ".deep-work/<session>/session-receipt.json",
      ".deep-review/reports/*.md",
      ".deep-docs/last-scan.json",
      ".deep-evolve/evolve-receipt.json",
      ".deep-dashboard/harnessability-report.json"
    ]
  },
  "hooks_active": ["PreCompact", "PostCompact", "SessionStart"],
  "x-session-start-sources":["compact"]
}
```

The hook inventory means:

- `PreCompact`: under `workstream-session`, an open affinity emits a checkpoint; a closed boundary (or any other absence of open affinity) returns `no-affinity`. Migrated policies alone retain the legacy pre-compact handoff path.
- `PostCompact`: bounded, fenced `checkpoint observe` ingress only; its receipt corroborates compaction and never overrides evidence mismatch.
- `SessionStart`: restore/context injection only when its source/matcher is `compact`.

Because `hooks_active` is non-empty, do not add `hooks_intentionally_empty_reason`. Registration adds discoverability only; deep-loop continues to run standalone and the SHA bump does not prove publication.
