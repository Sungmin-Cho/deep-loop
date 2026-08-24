---
name: deep-loop-continue
description: "deep-loop main tick — advances the kernel-returned next action in the current Workstream owner conversation, using native compact in place and handing off only at an exact terminal Workstream boundary. Triggered by '/deep-loop-continue', 'continue the loop', 'advance the loop', 'next tick', '루프 진행', '루프 계속', '다음 tick', '계속 진행', cross-platform Skill({ skill: \"deep-loop:deep-loop-continue\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> **loop.json + handoff 파일이 source of truth** — 이전 대화 컨텍스트를 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.
> **maker/checker 분리 유지** — 같은 세션이 동일 workstream의 maker와 checker를 겸하지 않는다.
> 스킬은 durable state를 **읽기만** 하며, 모든 변경은 public kernel CLI로만 요청한다.

## 실행 루트와 호스트 호출

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

호출은 제품 이름(Claude Code / Codex / Grok Build)을 직접 assertion한다. Claude Code는 `/deep-loop-continue`, Codex는 `$deep-loop:deep-loop-continue`, Grok Build는 `/deep-loop-continue`(모호하면 `/deep-loop:deep-loop-continue`)를 사용한다. 슬래시 호출이 Claude를 뜻하지 않는다. 환경 변수로 호스트를 단정하지 않는다.

## Invocation mode

Accept exactly three mutually exclusive forms: the normal invocation with no
arguments; the literal invocation-local internal mode `prepared-fallback`; or
exactly one canonical restored wrapper JSON string supplied by
`deep-loop-compact restore` in the same model turn. Route the canonical
restored wrapper directly to Stage A of §0.25 before generic argument rejection.
The `prepared-fallback` form is accepted only when the trusted SessionStart
`prepared` branch dispatches it. It grants no restore authority, carries no
capsule, and never changes durable state by itself. Reject every other argument,
multiple form, or conflicting mode.

For `prepared-fallback`, §1 still reads `next-action --json` exactly once. If
the returned action has `advice:"compact"`, ignore only that advice and its
reason for this one tick, then consume the `prepared-fallback` mode exactly
once. Route and perform the original underlying `action.type`; never replace
or infer that action. Do not enter §4 Compact advice for this tick. This avoids
an immediate compact loop while preserving the kernel's routing authority.

## 개요

`/deep-loop-continue` — 커널의 `next-action`을 한 단계 수행한다. 열린
Workstream affinity는 현재 owner conversation에 계속 남는다. 새 owner는
커널이 정확한 terminal Workstream boundary를 `handoff` action으로 반환한
뒤에만 준비한다.

## 0. Run ID / Generation 확보

handoff descriptor 또는 current run이 제공한 `<run_id>`는 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. lease owner가 세션마다 바뀌어도 이 값을 다시 대입하지 않는다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

현재 세션이 `owner_run_id`인지 확인한다. 아니면 Claude는 `/deep-loop-resume`, Codex는 `$deep-loop:deep-loop-resume`으로 lease를 인수해야 한다.

`<owner_run_id> = lease.owner_run_id`, `<generation> = lease.generation`. 여기서 `lease`는 방금 읽은 `session_chain.lease`다. 즉 `<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`에서 매 tick 새로 읽고, `<run_id>`는 절대 재바인딩하지 않는다.

## 0.25. Restored compact capsule gate

이 `SessionStart(compact)` comprehension tick 또는 같은 turn의 명시적
direct-human compact restore dispatch가 restored compact capsule wire를
공급했다면, 어떤 mutating CLI보다 먼저 이
gate를 실행한다. Stage A는 §0의 lease 명령보다도 먼저 순수 입력만 검사한다.
같은-turn compact restore dispatch에서는 canonical restored wire JSON 전체를
exactly one single string argument로 받는다. 이 wrapper argument는 정상적인
인자 없는 invocation의 예외이며, flat inspect descriptor나 inner capsule은
유효한 wire가 아니다.
wire가 2048 UTF-8 bytes를 초과하거나 missing, truncated, malformed, oversized
JSON이면 `/deep-loop-status`를 안내하고 즉시 stop한다. `JSON.parse` 후 다음
exact top-level key set만 허용한다:

`marker`, `version`, `injected_by`, `capsule`.

각 값은 `marker:"deep-loop-compact-capsule-v1"`, `version:1`이어야 하고,
`injected_by`는 `"sessionstart"` 또는 `"direct-human-skill"`만 허용한다.
`capsule`은 exact key set
`kind`, `phase`, `run_id`, `checkpoint_key`, `context_sha256`,
`pre_restore_loop_hash`, `owner_run_id`, `generation`, `runtime`,
`workstream_id`, `episode_id`, `provider_evidence`, `admission`,
`restore_event`, `restore_command`만 가지며 `kind`은
`deep-loop-compact-capsule`, `phase`는 반드시 `restored`여야 한다.
`provider_evidence`도 exact boolean keys `recorded`, `supplied`, `matched`만
허용한다. 어느 key/type/enum/length 검사라도 실패하면 stop하며
`session-profile set` must not run; 다른 mutation도 실행하면 안 된다.

provenance와 admission은 서로 묶여 있다. `injected_by:"sessionstart"`이면
`admission.kind:"postcompact-observation"`, `admission.source:"sessionstart"`
여야 한다. `injected_by:"direct-human-skill"`이면 admission은 정확히
`kind:"human-attested"`, `source:"direct-human-skill"`,
`receipt_trigger:null`이어야 하고 `restore_command`도 `null`이어야 한다.
두 provenance를 바꾸어 추측하거나 SessionStart 표식을 만들어내지 않는다.

Stage A 통과 뒤 §0의 fresh lease를 읽고, 이어서 다음 read-only state를 모두
읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.sessions --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field event_log_head --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field workstreams --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field current_episode --project-root "<canonical_project_root>" --run-id <run_id>
```

current lease owner의 `session_chain.sessions` row와 그 `compact_cursor`를 찾아
capsule의 `run_id`, `owner_run_id`, `generation`, `runtime`,
`workstream_id`, `episode_id`, `checkpoint_key`, `context_sha256`,
`pre_restore_loop_hash`, `provider_evidence`, committed `admission`,
`restore_event`와 exact-deep-equal 비교한다. owner session의 run id는
lease owner와 같아야 하고, cursor의 owner/generation/runtime도 fresh lease와
일치해야 한다. cursor `restore_event`는 current `event_log_head`와 같아야
하며, Workstream은 open/non-terminal이고 current episode가 그 Workstream에
속해야 한다.

불일치하면 다른 restore를 추측하지 말고 `/deep-loop-status`를 안내한 뒤
stop한다. model/effort are not part of the immutable capsule identity. 따라서
모든 immutable 검증이 성공한 뒤에만 §0.5 profile refresh를 조건에 따라
정확히 한 번 실행하고, 그 다음 §1의 fresh routing tick으로 진행한다.

## 0.5. 세션 model/effort refresh

§0에서 lease를 확보한 직후, 게이트/디스패치 이전에 현재 세션의
model/effort를 public kernel route로 갱신한다. 스킬이 상태 파일을 직접
쓰지 않는다.

현재 호스트가 알려 준 model과 effort를 직접 관측한다. 관측된 필드만 `model`/`effort` key로 넣어 한 줄 compact JSON을 만들고 다음 완전한 명령 하나를 사용한다. durable `session_runtime`이 grok이면 effort를 넣지 않는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --session-profile '<session_profile_json_compact>' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

`<session_profile_json_compact>` 내부의 JSON double quotes(JSON 이중 따옴표)는 그대로 두고 바깥 single quotes로 argv 하나를 만든다. 둘 다 관측하지 못하면 이 refresh 전체를 건너뛴다(state 그대로 진행 — 무해).
- 값이 그대로면 no-op이다. 관측값이 없으면 이 단계를 건너뛴다.
- handoff가 진행 중이어도 다음 분기를 추측하지 않는다. 항상 §1의 새
  `next-action` 응답만 따른다.

## 1. 게이트 검사 (항상 먼저)

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" next-action --json --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field autonomy.continuation_policy --project-root "<canonical_project_root>" --run-id <run_id>
```

`action.type`이 유일한 routing authority다.

- `await_human`: `action.reason`과 커널 진단을 그대로 보고하고
  `/deep-loop-status`를 안내한 뒤 멈춘다. 이 autonomous tick은 recovery,
  budget relief, breaker reset, 또는 attended approval을 실행하지 않는다.
  `action.reason`이 `comprehension-debt`이면 `action.blocking_episode_ids`가 **실제 ack 대상**(정착된 미리뷰 maker)이다. `action.episode_id`가 있으면 그것은 debt 때문에 막힌 episode이지 ack 대상이 아니다 — 그것을 ack해도 게이트는 풀리지 않는다. 차단된 개별 episode가 없는 discover 분기에서는 `action.episode_id`가 없을 수 있다.
- `handoff`: `continuation_policy`가 `workstream-session`이면 §4의
  exact-boundary 경로만 수행한다. migrated `compact-in-place` 또는
  `rotate-per-unit`이면 아래 legacy compatibility 경로만 수행한다.
- 그 밖의 action: 현재 owner conversation에서 계속 수행한다.

## 1.5. Action-keyed Worktree 진입 (maker/checker dispatch 전)

`action.workstream_id`가 존재하는 action에만 이 단계를 실행한다. 이는 `dispatch_maker`, `dispatch_checker`, `fix_episode`, `await_result`(진행 중인 maker/checker 폴링 시 워크트리 경로가 필요)를 포함한다.
`workstream_id`가 없는 action 타입(`finish`, `handoff`, `await_human`, `discover`)은 이 단계를 건너뛴다.

§1에서 실행한 `next-action --json` 결과의 `action.workstream_id`를 읽고, 커널에서 절대 worktree 경로를 얻는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" path resolve --target workstream --workstream <workstream_id> --project-root "<canonical_project_root>" --run-id <run_id>
```

반환된 한 줄의 절대 경로를 그대로 사용한다. 기본 진입은 그 경로를 도구의 working-directory 옵션에 전달하거나 cd 한다. native attach(`EnterWorktree` 등)는 도구가 그 절대 경로에 attach하고 새 sibling을 만들지 않는다고 보장될 때만 쓴다. 기록값이 `.worktrees/` 아래이면 Claude `EnterWorktree`를 생성 수단으로 호출하지 않는다. 이후 커널 명령도 descriptor-bound `--project-root`와 `--run-id`를 계속 명시한다.

Artifact 상세 교정 규칙은 `deep-loop-workflow`의 `## 핵심 불변식`을 따른다.

`max_parallel` 환경에서 여러 active workstream이 있어도, 항상 `action.workstream_id`가 지정하는 workstream의 worktree만 진입한다 — 임의 active workstream이 아님.

## 2. Action 분기 (next-action이 반환한 `action.type`대로, 스스로 판단 추가 금지)

### dispatch_maker

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" adapter resolve --protocol <protocol> --task "<brief>" --tier <gate.tier_after> --project-root "<canonical_project_root>" --run-id <run_id>
```

`guard.ok === false`이면 dispatch 중단 → `await_human` 안내.

**신규 maker 에피소드 경계에서만** 라우터를 호출한다. `adapter resolve` 이후, in_progress 기록 이전. durable `episodes[].routing`이 이미 있으면 재호출하지 않는다.

분류(`task_class`, complexity / uncertainty / blast_radius / reversibility, flags, runtime)를 RouteRequestV1로 만들고 `DEEP_MODEL_ROUTER_CLI` 또는 설치된 플러그인 캐시의 `route_task.py`를 찾는다. 개인 `~/.claude/skills/model-router` 심링크와 `../deep-model-router` checkout은 금지. python3 부재·CLI 부재는 라우터 부재다.

```
python3 <route_task.py> --request-json <request.json> --format json
```

Exit 번역(§11.3):
- `0`: 결정을 소비하고 아래 `--routing` JSON을 붙인다.
- `4`: 결정을 소비하고 사후 확인 의무를 남긴다. degrade 금지.
- `3`: human gate를 전파한다. in_progress로 올리지 않고 `await_human`.
- `1`/`2`/`5`, 비-JSON, 미지원 schema, digest 불일치, spawn/timeout/signal/빈 stdout/범위 밖 exit/`TERMINATION_UNCONFIRMED`, 라우터 부재:
  - 로컬 분류 또는 직전 완전 결정의 band가 HIGH/CRITICAL이면 in_progress로 올리지 않고 `await_human`
  - LOW/MEDIUM이면 `--routing` 없이 진행(현행 session_profile 단일 전파)
- `TERMINATION_UNCONFIRMED` 뒤에는 라우터 write-capable retry 금지

`--routing` 최소 키: `request`, `decision`(`route_schema_version` / `router_plugin_version` / `policy_sha256`), `selected_model`, `selected_effort_native`, `effective_policy`, `provenance`.

라우터 JSON에 `decision_fingerprint` 또는 `request_sha256`가 있으면 그대로
포함하고, 없으면 생략한다. 둘 중 어느 값도 스킬이 합성하지 않는다. 관측 파일
`observations/<subject_sha256>.json`은 터미널 커밋 뒤 커널이 발행하며, 스킬은
읽거나 쓰지 않고 `--artifacts`에도 넣지 않는다.

진행 시 episode in_progress로 기록(authorized 결정이 있을 때만 `--routing`을 붙인다):
```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" episode record --id <episode_id> --status in_progress --routing '<routing_json_compact>' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

HIGH/CRITICAL 라우터 실패나 human_gate에서는 이 in_progress 기록 명령을 실행하지 않는다. LOW/MEDIUM degrade면 `--routing`을 생략한 같은 명령을 쓴다.

`dispatch.kind`를 production routing authority로 소비한다. authorized
`--routing`이 있으면 `selected_model` / `selected_effort_native`를 이번
maker spawn에 적용한다. host가 새 세션을 띄우면 그 model/effort를 넘긴다.
inline owner 세션은 모델을 바꾸지 않고, freeze는 다음 handoff/respawn이
소비한다.

- `dispatch.kind === 'inline'`이면 `dispatch.explicit_fallback === true`,
  `dispatch.role === 'maker'`, `dispatch.skill === null`을 모두 요구한다. 현재
  owner LLM이 §1.5의 worktree 안에서 `dispatch.args` brief를 직접 도구로
  수행한다. sibling skill, Orca, MCP, host executable을 찾지 않으며 null
  `dispatch.skill`을 호출하지 않는다. 이 분기는 maker 실행만 허용하고 checker
  독립성 규칙을 변경하지 않는다.
- `dispatch.kind === 'skill'`이면 `dispatch.skill`이 non-empty string인지
  확인한 뒤 Claude는 `Skill({ skill: dispatch.skill, args: dispatch.args })`,
  Codex는 qualified `$<dispatch.skill>`에 `dispatch.args`를 전달한다.
- 그 밖의 kind 또는 위 shape 불일치는 `needs-human:adapter-descriptor-invalid`로
  중단하고 maker 완료 proof를 기록하지 않는다.

완료 후:
```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" episode record --id <episode_id> --status done --artifacts '[".worktrees/<ws-slug>/path/to/artifact"]' --proof '{}' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

### dispatch_checker

먼저 `references/adapters.md`의 **상호 배타 checker routing** Route A–D 중 실제 가능한 경로를 선택하되 아직 dispatch하지 않는다. durable `session_runtime`이 grok이면 Route D만 사용한다 — 이 대화에서 `review dispatch`, `deep-review:*`, `spawn_subagent` checker를 호출하지 않는다. Route D이면 `needs-human`으로 중단하며 계약 파일도 쓰지 않는다. Route A/B/C일 때만 아래 계약 준비를 수행한 뒤 선택한 경로로 dispatch한다.

Route A/B/C 선택 후, 실제 spawn 전에 maker와 **별도** route를 한 번 수행한다. 성공한 결정은 아래 review dispatch의 `--routing` JSON으로 checker 생성 시 심는다. 생성 후 episode record로 routing을 추가하지 않는다. HIGH/CRITICAL 실패·human_gate면 review dispatch와 spawn을 하지 않고 `await_human`. 라우터 부재·LOW/MEDIUM degrade면 `--routing` 없이 dispatch하고 session_profile을 쓴다.

먼저 recipe를 **상태에서** 읽는다(이전 대화 컨텍스트를 가정하지 말 것 — 이 값이 아래 분기의 유일한 근거다):

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field recipe.id --project-root "<canonical_project_root>" --run-id <run_id>
```

**결과가 `"harness-hill-climb"`이면 dispatch 전에 checker 계약을 materialize한다** (P2 — 커널이 fail-closed로 강제; 전체 규약은 `Read("DEEP_LOOP_ROOT/skills/deep-loop-workflow/references/hill-climbing.md")` §3.4):

§1.5에서 확정한 absolute worktree에 대해 host의 native path/file API로 `DEEP_LOOP_ROOT/skills/deep-loop-workflow/references/contracts/HILLCLIMB-001.yaml`을 `<absolute_worktree>/.deep-review/contracts/HILLCLIMB-001.yaml`로 복사한다. mkdir/copy **전** canonical worktree containment를 확인하고, `.deep-review`, `contracts`, 대상 파일 중 존재하는 경로 성분이 symlink/reparse-point이면 중단한다. POSIX `cp`/`mkdir` 셸 문법을 가정하지 말고 현재 host에서 안전한 파일 API를 사용한다.

tracked 소스를 **그대로 복사**한다(byte-identical — 커널이 대조; 수정본은 `REVIEW_CONTRACT_MISSING`으로 거부). 커널도 realpath containment + contracts 디렉터리 유일성(HILLCLIMB-001.yaml 외 다른 계약 yaml 금지 — bare `--contract`는 모든 active 계약을 로드하므로)을 fail-closed로 재검증한다. 계약-비소비 reviewer나 `--contract` 플래그 부재/명시 selector(`--contract SLICE-NNN` 등 — deep-review 파서는 SLICE-NNN만 selector로 소비하므로 HILLCLIMB-001을 지정할 수 없다)는 `REVIEW_CONTRACT_UNENFORCEABLE` — run의 review 설정을 사람과 함께 재구성해야 한다.

Route A/B/C 모두 hill-climb dispatch 응답의 `descriptor.evidence`(커널-검증 insights 경로·emit ULID·sha256·후보)를 fresh checker의 리뷰 요청 본문에 그대로 포함하여 maker 인용과 대조하게 한다. checker episode의 `request.md`에도 같은 evidence 사본이 durable 기록되며, Codex measured host는 anchored claim의 evidence/contract를 immutable prompt contract로 전달한다.

- **Route A — cooperative fresh subagent:** host에 fresh `code-reviewer`를 만드는 cooperative tool이 실제로 있을 때만 다음 명령을 실행한다. configured reviewer가 agent인데 이 capability가 없으면 Route D로 가며 dispatch하지 않는다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review dispatch --point <review_point> --workstream <workstream_id> --independent-subagent --routing '<routing_json_compact>' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

  반환된 agent descriptor로 host tool을 통해 fresh reviewer를 spawn한다.
  `descriptor.selected_model` / `descriptor.selected_effort_native`가 있으면
  그 값을 그대로 spawn에 넘긴다. inline 자기 리뷰는 proof가 아니다.

- **Route B — Codex unattended measured host:** 다음 명령을 정확히 한 번 실행하고 즉시 measured host에 yield한다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review dispatch --point <review_point> --workstream <workstream_id> --routing '<routing_json_compact>' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

  host가 claim, isolated read-only 두 번째 `codex exec`, import, accounting을 소유한다.
  dispatch 응답의 `descriptor.selected_model` / `selected_effort_native`를
  measured host spawn에 그대로 전달한다. 이 execution skill은 Route B에서
  아래 `review record`를 실행하지 않는다.

- **Route C — interactive independent skill session:** reviewed worktree를 root로 하는 distinct fresh session/task가 실제 준비됐을 때만 flag 없는 위 dispatch를 실행한다. Claude fresh session은 `Skill({ skill: checker.skill, args: checker.args })`, Codex fresh task는 `$<checker.skill>`에 args를 전달한다. Codex 자동 task 생성은 지원하지 않으므로 사람이 수동 task 생성을 완료해야 한다. 같은 task의 `$<checker.skill>` 실행은 proof가 아니다.
- **Route D — no independent path:** `needs-human`으로 보고하고 dispatch/record/proof 생성을 모두 중단한다. pending checker를 만들지 않는다.

Route A 또는 Route C의 fresh checker가 리뷰 대상 worktree 아래 실제 contained report를 반환한 경우에만 원래 execution session이 다음 단계로 간다. 커널은 checker episode에서 workstream/point/target maker/source를 파생하므로 해당 caller flag를 전달하지 않는다. **APPROVE/CONCERN(통과)은 checker가 실제로 작성한 리뷰 리포트 파일을 `--report`로 첨부해야 한다 — 리뷰 대상 workstream의 기록된 worktree(`<recorded-worktree>/…`, 신규 기본 `.worktrees/<slug>`) 하위 경로**여야 하며(무관한 root 파일 재사용 차단), 없거나 밖이면 `REVIEW_NO_EVIDENCE`(exit 1). REQUEST_CHANGES도 fresh checker가 실제 반환한 verdict여야 한다:
```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review record --episode <checker_episode_id> --verdict <APPROVE|REQUEST_CHANGES|CONCERN> --report "<review-report-path>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

### fix_episode

라우터를 다시 호출하지 않는다. `action.episode_id`는 거절된 checker다.
그 `target_maker` episode의 기존 `routing`을 읽어 새 fix maker의
`in_progress` 기록에 그대로 붙인다. maker `routing`이 없으면 `--routing`
없이 기록하고 session_profile로 degrade한다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" episode new --plugin <maker_plugin> --role maker --kind fix --point <point> --workstream <workstream_id> --artifacts '[".worktrees/<ws-slug>/path/to/fix-output"]' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

생성 직후, 거절된 maker의 freeze가 있으면:
```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" episode record --id <new_fix_episode_id> --status in_progress --routing '<prior_maker_routing_json_compact>' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

### discover

`/deep-loop-discover` 안내 (또는 invoke).

### await_result

`adapter resolve`의 `await.path` 폴링.

### finish

`/deep-loop-finish` 안내.

## 3. 비용 기록

Interactive tick은 best-effort로 self-report:
```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" budget record --turns <n> --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

**`DEEP_LOOP_UNATTENDED` set 시 자기보고를 생략** — drive-headless 드라이버가 측정 usage를 권위있게 기록하므로 이중계상 방지.

self-report는 best-effort 보정일 뿐이다. 커널이 각 business mutation마다
최소 floor를 계상하고 wallclock hard bound를 적용한다.

## 4. Kernel action 이후 continuity

### Compact advice

`action.advice === 'compact'`이면 handoff하지 않는다. durable
`session_runtime`이 grok이면 `/deep-loop-compact`를 호출하지 않고
`needs-human`으로 멈춘다. 그 외에는 현재 owner conversation에서
`/deep-loop-compact prepare` 또는 `$deep-loop:deep-loop-compact prepare`를
호출하고, 그 스킬이 출력한 host native `/compact` 명령을 사람에게 제시한다.
compact prepare/restore는 같은 conversation, 같은 lease, 같은 Workstream
affinity를 유지한다.

Exception: the already-consumed invocation-local `prepared-fallback` mode skips
this subsection exactly once as specified above. It still performs the
kernel-returned underlying action and cannot suppress compact advice on any
later tick.

### Exact Workstream boundary handoff

`continuation_policy === 'workstream-session'`,
`action.type === 'handoff'`, `action.reason === 'workstream-terminal'`이며
`action.boundary_event`가 있을 때만 handoff한다. public
`next-action --json`은 boundary를 이미
`<boundary_seq>:<boundary_checksum>` 문자열로 렌더한다. 그
`action.boundary_event` 문자열을 검증된 한 값으로 그대로 전달하고,
재구성하거나 이전 action의 값을 재사용하지 않는다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" handoff emit --boundary-event <boundary_seq>:<boundary_checksum> --reason "workstream-terminal" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

### Migrated policy compatibility

`continuation_policy`가 migrated `compact-in-place` 또는 `rotate-per-unit`이고,
fresh kernel action이 정확히 `action.type === 'handoff'`,
`action.reason === 'per_session_turn_cap'`이며 `action.boundary_event`가 없을
때만 legacy public route를 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" handoff emit --reason "per_session_turn_cap" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

이 branch는 기존 run의 호환성만 보존한다. 새 run의 policy를 바꾸거나
turn count, launcher, tty, spawn style로 handoff를 추론하지 않는다.

unattended invocation이면 measured `drive-headless` host가 이후 gate와 spawn을
소유한다. 이 스킬은 respawn을 직접 호출하지 않고 즉시 yield한다.

attended invocation이면 커널의 현재 root/epoch/topology 검증을 거친 exact
resume command를 얻어 **그 출력을 바꾸지 않고 먼저 출력**한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" resume-command --project-root "<canonical_project_root>" --run-id <run_id>
```

그 다음 현재 parent fence로 preserve-pause하고 종료한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" pause --owner <owner_run_id> --generation <n> --mode preserve --reason "needs-human:workstream-terminal" --project-root "<canonical_project_root>" --run-id <run_id>
```

사람은 출력된 Claude `/deep-loop-resume` 또는 Codex
`$deep-loop:deep-loop-resume` 명령을 새 conversation에서 그대로 실행한다.
지원되지 않는 Codex 자동 transport는 `codex-transport-not-activated`,
승인 runtime 부재는 `runtime-identity-unavailable`로 남으며, native Windows,
macOS/Linux `cmux`, macOS iTerm2/Terminal.app 어느 경우도 이 스킬이
surface heuristic으로 attended respawn하지 않는다. Codex App 새 task는 수동이다.
