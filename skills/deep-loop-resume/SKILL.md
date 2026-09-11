---
name: deep-loop-resume
description: "deep-loop resume — validates a kernel-published boundary, affinity-recovery capsule, or project-root relocation descriptor, acquires only through its exact route, and delegates worktree entry to continue. Triggered by '/deep-loop-resume', '$deep-loop:deep-loop-resume', 'resume the loop', 'take over the session', 'continue handed-off work', '루프 이어가기', '세션 인수', '이어서 진행', cross-platform Skill({ skill: \"deep-loop:deep-loop-resume\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> 이전 conversation이나 stale artifact path를 가정하지 않는다.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.
> 스킬은 durable state를 **읽기만** 하며, 모든 변경은 public kernel CLI로만 요청한다.

## 실행 루트와 입력

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고,
아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다.
literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경
변수나 셸 확장으로 루트를 만들지 않는다.

호출은 제품 이름(Claude Code / Codex / Grok Build)을 직접 assertion한다.
Claude Code는 `/deep-loop-resume`, Codex는
`$deep-loop:deep-loop-resume`, Grok Build는 `/deep-loop-resume`(모호하면
`/deep-loop:deep-loop-resume`)를 사용한다. 슬래시 호출이 Claude를 뜻하지
않는다. 환경 변수로 호스트를 단정하지 않는다. descriptor가 준
`--project-root "<canonical_project_root>" --run-id <run_id>`를 그대로
사용한다. `<run_id>`는 논리적(logical) loop run id이며 불변(immutable)이다.

## 단계 1: Kernel descriptor 분류

현재 root/run에 대해 exact, read-only resume descriptor를 다시 요청한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" resume-command --project-root "<canonical_project_root>" --run-id <run_id>
```

출력의 첫 줄과 `Recovery:`, `Lease:` metadata를 바꾸거나 재구성하지 않는다.
커널 오류, malformed topology, root digest/epoch mismatch이면 인수를 중단한다.

**`Status: consumed`면 어떤 branch에도 진입하지 않는다.** 그 예약은 이미 정확히 한 번
소비됐다는 durable 사실이며(영수증 파생), 첫 줄은 실행 가능한 invocation이 아니라
비실행 마커다. `Consumed:` 줄의 `takeover_kind`/`superseded_owner`/`transition`을 그대로
인용해 보고한다. **attempt_id 없이 또는 다른 값으로** 새로 진입을 시도하면 커널은
`proceed:false`(`already-owned`)를 내므로, 그 경우에는 승격하지 말고 `/deep-loop-status`를
안내한 뒤 멈춘다.

**예외 — 이 세션이 durable하게 보유한 attempt_id가 있으면 정지가 아니다.** 그것은 "커널은
소비를 커밋했는데 이 세션이 응답을 잃었다"는 상태(M1)일 수 있고, 커널은 **같은** attempt_id의
재호출에 `{proceed:true, replayed:true}`를 재발급한다 — `Status: consumed`와 그 replay는
동시에 성립한다(같은 durable 상태에 대한 두 사실이다). 따라서 보유한 값으로 아래 Boundary
handoff의 acquire를 **정확히 한 번** 재시도하고, 그 응답의 `proceed`로 판단한다:
`proceed:true`면 승격하고 계속하며(`replayed:true`는 같은 시도의 재확인이다),
`proceed:false`면 그때 멈춘다. 보유한 값이 없다면 새로 만들지 않는다 — 새 값은 다른 시도이므로
replay가 성립하지 않고, 그 경우는 §4-(b)③의 사람 런북 대상이다.

> 커널의 `Status:` 줄은 replay가 **실제로 도달 가능할 때만** `같은 attempt_id 재호출은 replay`를
> 덧붙인다(영수증이 `attempt_id`를 담고 run이 `running`일 때). 그 절이 있으면 위 예외를 그대로
> 적용한다. **절이 없다는 것만으로 replay 불가를 결론내지 말 것** — 판단 기준은 "이 소비가
> `lease acquire`로 이뤄졌고 그때 `--attempt-id`를 주었는가"다. `normal`·`boundary-handoff`·
> **`boundary-recovery`** 세 경로는 모두 `lease acquire`로 소비되므로 nonce와 replay의 대상이며
> (boundary-recovery의 resume invocation도 `lease acquire`다), `recovery acquire`와
> `root recovery acquire`로 한 소비만 nonce를 받지 않아 replay가 원리적으로 없다. 절이 없는데
> 보유한 값이 있다면 그 값으로 한 번 재시도해 응답의 `proceed`로 판단한다.

## 동일 소유자 needs-human 재개

`resume-command`가 pending handoff 없음을 보고한 경우에만 fresh `state get`으로
status, pause_reason, session_chain.lease, session_chain.sessions, workstreams를 확인한다.
현재 세션이 소유한 active lease, `needs-human:*` pause, 열린 workstream affinity이고
handoff child가 없을 때 **사람이 해당 정지 사유의 재시도를 명시 승인한 뒤에만**:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" recover --same-owner --confirm --reason "<human approval and retry reason>" --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>
```

이 경로는 새 소유자를 만들지 않는다. 성공하면 단계 3으로 이동한다. budget/breaker,
host-session-lost, 진행 중인 handoff 거부를 우회하거나 pause reason을 재표기하지 않는다.
실패하면 오류를 그대로 보고한다. 완료·리뷰 증명과 미해결 의무는 별도로 충족해야 한다.

## Boundary handoff

첫 줄이 현재 runtime의 `/deep-loop-resume` 또는
`$deep-loop:deep-loop-resume` descriptor이고 `Recovery:` 줄이 없을 때만
normal boundary branch다. fresh state에서 exact child와 generation을 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.sessions --project-root "<canonical_project_root>" --run-id <run_id>
```

`handoff_child_run_id`, `handoff_boundary_event`, project root digest/binding
generation, child `parent_boundary_event`, `project_root_digest`, and
`project_binding_generation`이 서로 일치하는지 확인한다. `<child_run_id>`는
exact reserved child, `<current_generation>`은 fresh lease generation,
`<new_generation>`은 아래 CAS 성공 응답이 반환한 generation이어야 한다.

**attempt id 규약 — 호출 **전에** durable하게 남긴다.** 이 세션이 인수를 처음 시도할 때
`<attempt_id>`를 한 번 만들고(형식 `^[A-Za-z0-9_-]{8,128}$`, ULID 권장), 순서는 정확히
**① 생성 → ② 자기 쪽에 durable 영속화 → ③ 아래 acquire 호출**이다. **호출 후에 기록하는 것은
금지한다** — "호출은 성공했는데 기록 전에 죽는" amnesiac 창이 남아 재시도 때 값을 잃고, 그
순서를 지키지 않은 호출자에게는 응답 유실 복구 보증이 적용되지 않는다. **재시도는 같은 값을
재사용한다**; 새로 만들면 커널이 같은 시도로 식별하지 못해 replay가 성립하지 않고
`proceed:false`(`already-owned`)로 떨어진다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" lease acquire --owner <child_run_id> --generation <current_generation> --runtime <claude|codex|grok> --attempt-id <attempt_id> --project-root "<canonical_project_root>" --run-id <run_id>
```

**`proceed:true` 뒤에만** `<owner_run_id> = <child_run_id>`,
`<generation> = <new_generation>`으로 승격한다. `ok:true`인데 `proceed:false`면
(`already-owned`) 승격하지 않고 "이 run은 이미 owner `<id>` generation `<n>`이 인수함 —
이 대화는 진행 권한이 없음"을 보고하고 멈춘다. `replayed:true`는 같은 시도의 재확인이며
진행 판단은 `proceed`만 본다. arbitrary owner나 plain timeout takeover를 시도하지 않는다.

**일시적 락 경합.** 응답이 정확히 `reason:"lock-busy"`, `retryable:true`,
`proceed:false`이면 소유권은 이동하지 않았다. `proceed:false` 응답에서 승격하거나 새 attempt id를 만들지 말고, 이미
영속화한 **같은** `<attempt_id>`로 나중에 제한적으로 재시도한다. 재시도도 `proceed:true`일
때만 승격한다. 제한된 재시도 후에도 `lock-busy`이면 그 구조화 응답을 포함해 사람에게
보고하고 멈춘다. `retryable:true` 없는 다른 `proceed:false` 응답은 재시도하지 않는다.

**오용 복구.** 자신이 위임된 실행 세션이 아닌데 `proceed:true`를 받았다면(위임 전 사전
acquire 금지 위반) 즉시 preserve-pause하고 사람에게 보고한다. `<owner_run_id>`/`<generation>`은
다른 mutating CLI와 같이 **fresh `session_chain.lease`에서 다시 읽는다** — 방금 인수했으므로
그 값이 곧 새 owner와 새 generation이다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" pause --reason "acquire-misuse" --mode preserve --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>
```

## Affinity recovery capsule

`Recovery: kind=affinity-supersession`이면 ordinary acquisition을 하지 않는다.
`resume-command`의 첫 줄은 `recovery acquire --capsule ...`이며, exact returned
command를 그대로 실행해야 한다.

실행 전 fresh session/lease metadata의 `recovery_rel`, `recovery_sha256`,
`recovery_project_root_digest`, `recovery_project_binding_generation`,
child id, current generation, runtime이 descriptor의 capsule/root
digest/binding generation과 모두 일치해야 한다. capsule을 편집하거나 path를
다시 만들지 않는다. 불일치하면 사람에게 보고하고 멈춘다.

## Project-root relocation recovery

current root access가 `PROJECT_ROOT_FENCED`/`PROJECT_ROOT_UNRESOLVABLE`이거나
사람이 candidate root를 명시한 경우에만 read-only diagnosis를 실행한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" root diagnose --candidate-project-root "<candidate_project_root>" --run-id <run_id>
```

`action`, `current_root_digest`, `current_binding_generation`, `fence`,
`topology`를 모두 표시한다. `action:'wait'`이면 기다리고,
`action:'already-rebound'`이면 command를 만들지 않는다.
`action:'rebind'|'relocation-recovery'`이면 사람이 exact diagnosis와
preserve-pause reason을 확인하고 명시적으로 승인한 뒤에만 diagnosis의
exact returned command를 그대로 실행한다. stale root, epoch, digest, owner,
generation, 또는 artifact path를 손으로 수정하지 않는다.

relocation recovery publication 뒤 `resume-command`를 다시 실행한다.
`Recovery: kind=project-root`인 첫 줄은
`root recovery acquire --capsule ...`이며, 그 exact returned command만
실행한다. descriptor의 capsule rel, SHA-256, candidate root digest,
`current_binding_generation`, child, runtime, lease generation이 fresh
state와 일치하지 않으면 중단한다. generic acquisition은 금지한다.

## 단계 2.5: 세션 model/effort refresh (성공한 acquire 직후)

성공한 branch가 새 owner를 만들었을 때 실제 host model/effort를 public
kernel route로 갱신한다. durable `session_runtime`이 grok이면 effort를
넣지 않는다. 둘 다 관측한 경우(grok 제외):

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --effort "<session_effort>" --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>
```

effort를 관측하지 못한 경우:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>
```

관측값이 없거나 setter가 fence되면 추측하지 않는다.

## 단계 3: Active Worktree 무결성 확인

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field workstreams --project-root "<canonical_project_root>" --run-id <run_id>
```

active workstream의 recorded relative worktree가 canonical project root 안에
존재하고 symlink/reparse escape가 아닌지 확인한다. 소실 시 재생성하지 않고
`needs-human`으로 보고한다.

## 단계 3.5: Worktree 진입 위임

resume은 특정 worktree에 미리 진입하지 않는다. per-action worktree 진입은
`/deep-loop-continue`가 fresh `action.workstream_id` 기준으로 수행하도록
위임한다.

## 단계 4: 진행

Claude Code에서는 `/deep-loop-continue`, Codex에서는
`$deep-loop:deep-loop-continue`, Grok Build에서는 `/deep-loop-continue`를
invoke한다.
