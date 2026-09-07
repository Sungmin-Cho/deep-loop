# Release — post-merge deep-suite sync

Release-time procedure only. `AGENTS.md` §Release links here so the steps are not resident
in every session; the approval gate itself is invariant 5 in `AGENTS.md`, which applies
whether or not this file has been read.

Only after this repo's PR merges **and a separate post-merge sync approval is granted**:
verify the full merged `main` SHA with `git ls-remote`, then run
`npm run release:bump -- deep-loop <full-40-character-merged-SHA>` in deep-suite.
This canonical tool updates both marketplace manifests, generated documentation
and preflight. Verify both pins equal the exact merged SHA; never edit inside
auto-generated markers. An explicit user authorization for the complete
PR/merge/release/synchronization chain remains valid across those steps.

The patch is pre-written at `DEEP_LOOP_ROOT/integration/deep-suite.patch.md`. It is a proposal, not
evidence that distribution has already been synchronized or released. Registration adds
discoverability only; deep-loop runs standalone with no sibling installed.
