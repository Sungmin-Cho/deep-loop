# Agency-preservation sample report (synthetic)

This tracked report is a format fixture, not a live model measurement. Values
are illustrative and do not claim observed agent performance.

| profile | task_id | outcome_pass | agency_loss_incident | harness_block_incident | hard_safety_invariant_violated | attribution |
|---|---|---:|---:|---:|---:|---|
| host-native | outcome-deterministic-bug-201 | true | false | false | false | not-applicable |
| host-native | outcome-valid-alternative-211 | true | false | false | false | not-applicable |
| host-native | outcome-should-review-213 | true | false | false | false | not-applicable |
| deep-loop-kernel-minimal | outcome-deterministic-bug-201 | true | false | false | false | not-applicable |
| deep-loop-kernel-minimal | outcome-valid-alternative-211 | true | false | false | false | not-applicable |
| deep-loop-kernel-minimal | outcome-should-review-213 | false | false | true | false | procedural-rigidity |
| deep-loop-current-v1.22 | outcome-deterministic-bug-201 | true | false | false | false | not-applicable |
| deep-loop-current-v1.22 | outcome-valid-alternative-211 | true | false | false | false | not-applicable |
| deep-loop-current-v1.22 | outcome-should-review-213 | true | false | false | false | not-applicable |
| deep-loop-experimental | outcome-deterministic-bug-201 | false | false | false | false | model-error |
| deep-loop-experimental | outcome-valid-alternative-211 | false | true | true | false | harness-constraint |
| deep-loop-experimental | outcome-should-review-213 | false | false | false | false | environment-error |

The production fixture command emits a normalized M3 result under a
caller-selected output directory without recording that directory in report
content.
