[English](./README.md) | **한국어**

# deep-loop

**Claude Code, Codex, Grok CLI용 내구성 있는 오케스트레이션 플러그인** — 엄격한 2-plane 아키텍처, 예산 강제, proposal-only 안전 불변식으로 멀티세션·크로스플러그인 엔지니어링 작업을 조율합니다.

## 개요

deep-loop는 독립 실행 가능한(standalone/독립) Claude Code / Codex / Grok CLI 플러그인으로, 내구성 있는 "루프"를 실행합니다 — 여러 LLM 세션에 걸친 발견(discovery), 트리아지(triage), 제작(make), 리뷰(review), 통합(integrate)의 구조화된 순서입니다. deep-suite(deep-work, deep-review, deep-wiki, deep-memory) 없이도 독립 동작하며, 있으면 오케스트레이션 레이어로 활용됩니다.

**Proposal-only** 범위는 push, PR, merge, publish, delete, marketplace/deep-suite sync를 모두 포함하며, 실행 전 각각 **별도 사람 승인(human approval)**이 필요합니다. 설치 안내는 이 저장소가 이미 릴리스·마켓플레이스 동기화되었다는 뜻이 아닙니다.

## 아키텍처: 2-plane 설계

deep-loop는 엄격한 **2-plane 분리**(spec §1)를 강제합니다:

### Control Plane (커널)
커널(`scripts/lib/`)이 모든 상태·리스·예산·무결성을 관리합니다:
- **상태 기계** (`state.mjs`, `lease.mjs`) — 컨텐츠-해시 앵커 `loop.json`, generation-fenced 리스
- **예산 엔진** (`budget.mjs`) — turn/token/wallclock 하드캡, 측정불가 시 fail-closed
- **서킷 브레이커** (`breaker.mjs`) — 반복 실패 시 자동 트립, 사람 리셋 필요
- **무결성** (`integrity.mjs`) — 체인+헤드 앵커 추가전용 이벤트 로그, 변조 탐지
- **핸드오프/리스폰** (`handoff.mjs`, `respawn.mjs`) — 멱등성 키가 있는 상태 있는 세션 핸드오프

### Execution Plane (스킬 / SKILL.md)
스킬은 raw 상태 파일에 대해 **읽기 전용**입니다. CLI를 통해서만 상태를 읽고(`state get`, `next-action` 등), 커널 CLI 서브커맨드를 통해서만 씁니다(`state patch`, `budget record` 등).

## 명령어 (사용자 스킬 10개)

| Claude Code | Codex CLI / App | 설명 |
|---|---|---|
| `/deep-loop` | `$deep-loop:deep-loop` | **진입점** — run 시작, 플러그인 감지, 레시피/프로토콜 매칭, 워크스트림 분해 |
| `/deep-loop-discover` | `$deep-loop:deep-loop-discover` | 발견 단계 — `discovered_items` 채우기, 워크스트림 매핑 |
| `/deep-loop-triage` | `$deep-loop:deep-loop-triage` | 트리아지 단계 — 우선순위, 프로토콜, 사람 확인 |
| `/deep-loop-continue` | `$deep-loop:deep-loop-continue` | 메인 틱 — maker → 대기 → 아티팩트 → checker |
| `/deep-loop-compact` | `$deep-loop:deep-loop-compact` | 신뢰된 동일 대화 compaction checkpoint의 명시적 `prepare`/`restore` 경로 |
| `/deep-loop-handoff` | `$deep-loop:deep-loop-handoff` | 다음 세션용 clean handoff 방출 |
| `/deep-loop-resume` | `$deep-loop:deep-loop-resume` | handoff 문서에서 중단된 run 재개 |
| `/deep-loop-status` | `$deep-loop:deep-loop-status` | 상태·예산·워크스트림·comprehension debt 읽기 |
| `/deep-loop-ack` | `$deep-loop:deep-loop-ack` | 사람 리뷰 확인 및 comprehension debt 감소 |
| `/deep-loop-finish` | `$deep-loop:deep-loop-finish` | settled 검증, final-report 작성, run 종료 |

> 참고: `/deep-loop-workflow`는 `/deep-loop-continue` 등이 내부적으로 사용하는 비공개(user-invocable:false) 스킬입니다. Grok CLI는 Claude Code와 같은 `/deep-loop…` 슬래시 명령을 사용합니다.

### 적합성 게이트 (suitability gate)

`/deep-loop "<goal>"`은 run을 만들기 전에 goal이 루프감인지 먼저 판단합니다.
적합하면 추가 마찰 없이 그대로 진행하고, 명백히 부적합하면(bounded one-shot
질문, 리뷰만, 한 세션 사이즈 구현) 근거와 함께 대안(deep-work / deep-review /
인라인)을 한 번 제안합니다 — "그래도 deep-loop" 선택은 항상 가능하며 자동
적용은 없습니다. 애매하면 루프로 진행합니다.

## Multi-run identity와 worktree 라우팅

한 프로젝트에는 여러 active/historical run이 함께 존재할 수 있습니다. 먼저 bounded verified 목록을 확인한 뒤 불변 logical id 하나를 명시적으로 선택합니다:

```text
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" run list --project-root "<canonical_project_root>"
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" state get --field status --project-root "<canonical_project_root>" --run-id <run_id>
```

`.deep-loop/current` 포인터는 마지막 생성 run을 알려주는 **hint**일 뿐입니다. routing 권위·소유권 증명·tie-breaker가 아닙니다. mutation route와 exact read never silently fallback to current; 공식 automation도 provisioned identity를 요구합니다. 단, bounded resolver는 active run이 없고 현재 선택이 검증된 terminal run 하나일 때에만 `legacy-current` 호환 경로를 유지하며, 그 run에는 서로 다른 terminal claim이 하나 이상(중첩 Workstream 포함) 있을 수 있습니다. 동시에 실행하는 각 run은 고유한 worktree 경로와 branch를 사용해야 합니다. worktree 생성과 `workstream new` 기록 사이에는 좁은 create↔record TOCTOU가 남아 있고, v1은 project-level reservation·claim retirement·ownership transfer를 구현하거나 보장하지 않습니다. 중복 claim은 fail-closed이고 orphan 정리는 proposal-only입니다.

무인 실행은 canonical project root와 불변 run id를 한 번 provision한 뒤 매 tick에 두 값을 함께 전달합니다:

```text
node "<absolute-deep-loop-root>/scripts/hooks-impl/drive-headless.mjs" --project-root "<canonical_project_root>" --run-id <run_id>
```

## 호환성 및 복구 계약

새 run은 Claude Code, Codex CLI, Codex App 모두 `workstream-session`과 `spawn_style='interactive'`로 시작합니다. active host conversation은 정확한 `bound_workstream_first_terminal` 이벤트까지 하나의 bound Workstream을 소유합니다. compaction은 그 대화 안에서 처리하고, normal child handoff는 first-terminal 경계에서만 발행합니다. **No unattended mid-Workstream respawn**이 계약입니다. 따라서 기본 연속성은 interactive이고 `/deep-loop-resume` 또는 `$deep-loop:deep-loop-resume`을 이용한 **manual resume**은 오류 전용 폴백이 아닌 일급 지원 경로입니다.

Grok CLI는 **attended Darwin-only** session runtime입니다. 새 grok run도 macOS에서 `workstream-session`과 `spawn_style='interactive'`를 쓰며, Linux·Windows·desktop·측정 헤드리스는 거부됩니다. **Grok compact is unsupported.** The Claude-cache-loaded deep-loop plugin hook with matcher `"*"` did not fire on measured Grok 1.0.4 PreCompact/PostCompact, so emit+observe stay closed and SessionStart restore is not opened. **다운그레이드:** 1.18 grok run을 1.17.0 커널이 읽으면 `validateSessionRuntime` / 스키마 enum에서 fail-stop합니다. 기존 claude/codex run은 그대로 읽힙니다. durable schema는 `0.4.0`입니다.

**1.19 커널 계약.** 모든 변이 라우트는 `PROJECT_ROOT_FENCED`에 **exit 3**을 냅니다(이전 exit 1로 접히던 9개 라우트가 불변식 2와 같아졌습니다). 읽기 전용 `next-action`/`state get`은 exit 1, `path resolve`는 3을 유지합니다. 모르는 플래그는 usage **exit 2**입니다. 라우트 목록은 `node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" help` (`help <handler>`)입니다. Grok loop는 compact advice를 받지 않습니다.

PreCompact는 bounded checkpoint를 발행하고 source/matcher가 `compact`인 SessionStart가 **host-mediated restore**를 수행합니다. restore liveness의 주체는 host이며 hook은 emit-only, best-effort이고 세션을 생성하지 않습니다. **Provider identity is optional** when the host has no stable identity; 제공되면 digest가 일치해야 합니다. missing or untrusted hook은 무조건 pause한다는 뜻이 아니라 조건부로 처리됩니다. 명시적인 trusted-evidence rejection이 없으면 restore가 fresh state를 읽고, 그 owner session의 same owner와 generation 및 open bound Workstream affinity를 입증할 때만 state-derived continuation을 계속할 수 있습니다. Otherwise restore는 durable lease에 preserve-pause를 적용하고 같은 manual resume 경로를 사용합니다. 명시적인 trusted `provider-evidence-mismatch` 또는 `checkpoint-unavailable-with-trusted-evidence` 결과는 곧바로 이 preserve-pause 경로를 따릅니다. 격리 headless driver도 Workstream 경계 뒤에서만 계속할 수 있고 usage 측정 불가 시 fail-closed합니다.

PostCompact는 bounded 256 KiB host event를 받은 뒤 trusted common field만 projection하여 bounded 4096-byte trusted payload를 fenced public `checkpoint observe` CLI에 전달하며 adapter는 restore나 continue를 수행하지 않습니다. Observation receipt는 compaction 발생을 입증하지만 절대 provider-evidence mismatch를 덮어쓰지 않습니다. `prepared` checkpoint는 inspection evidence일 뿐 절대 automatic 자동 복원 권한을 부여하지 않습니다. Unattended tick이 open bound Workstream 안에 있으면 `next-action`은 normal action을 유지하고 no compact advice 및 no cap handoff를 보장합니다. Terminal run에서는 `checkpoint observe`와 `checkpoint restore`를 durable byte 변경 전에 거부합니다.

visible/desktop launch는 터미널 감지만으로 추론하지 않습니다. 사람이 선택한 run의 lease와 executable diagnosis를 확인한 후 `node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" attended-launch approve --style visible --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>`를 명시적으로 실행해야 합니다. desktop은 nonce-bound `spawn-style offer-desktop ...` 뒤 `spawn-style confirm-desktop ...` 흐름을 사용합니다. 예산 소진과 latch된 breaker는 서로 독립적인 relief route입니다. Budget extend와 breaker reset은 independent relief routes입니다. 확인된 `node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" budget extend --turns <positive_turn_delta> --reason "<human_confirmed_reason>" --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>`는 예산 소진 때, `node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" breaker reset --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>`는 latch된 breaker 때 각각 사용합니다. autonomous skill은 어떤 승인도 대신하지 않습니다.

review flags는 generic `state patch`로 바꿀 수 없습니다. 사람 승인으로 운영 실패 checker를 abandon한 뒤 다음 checker를 만들기 전에는, 사람이 lease-fenced `review configure --profile codex-only-static --source-checker <id> --confirm ...` 경로를 사용할 수 있습니다. 이 폐쇄형 프로필은 `--contract --codex-only --reviewer-strategy static`으로만 확장됩니다. critical document의 provider-family 부족에 대해 별도 승인을 받은 폐쇄형 `gpt56-agy-static` 프로필은 Codex 두 역할을 `gpt-5.6-sol/high`, Agy를 `gemini-3.6-flash-high`로 고정하고 Opus와 fallback을 비활성화하며 임의 provider/model argv는 받지 않습니다. 커널은 durable reviewer가 `deep-review-loop`이고 최신 source가 done maker에 바인딩된 `deep-review` checker이며 `operational-review-failure:` reason으로 abandoned 상태인지 확인합니다. 그 권한은 한 번만 소비하며, non-terminal checker가 있으면 변경을 거부합니다. 성공 시 source, 이벤트, 새 flags를 하나의 anchored transaction으로 기록합니다.

host 상실 복구도 human-only입니다. 먼저 preserve-pause하고, 확인된 affinity supersession이 capsule을 발행하면 fresh process는 반환된 정확한 `recovery acquire --capsule ...`를 그대로 실행합니다. 프로젝트 이동 시 read-only `root diagnose --candidate-project-root ...`를 실행하고 descriptor를 검토합니다. 그 뒤 diagnosis가 반환한 public-kernel command를 정확히 그대로 실행합니다(예: 반환된 root rebind 또는 root recovery acquire --capsule ...). recovery command를 합성·축약·수정하지 않습니다. `project.binding_generation`이 **root epoch**입니다. 모든 state command와 **relative locator**는 그 epoch, root digest, run id, lease owner/generation에 묶입니다. **Stale root-bound commands** are rejected by the epoch fence and are **never edited in place**; fresh command가 필요하면 다시 diagnose합니다.

`.deep-loop/runs/<run-id>/`의 durable artifact inventory는 다음을 포함합니다.

- 동일 대화 compaction용 `checkpoints/<checkpoint-key>-compact.json`
- trusted PostCompact evidence용 `checkpoints/<checkpoint-key>-compact-observation.json`과 crash-safe pair prune tombstone `checkpoints/<checkpoint-key>-compact-prune.json`
- fixed-shape restore publication intent `compact-restore-intents/<operation-id>.prepared.json`
- write-ahead log(**WAL**)용 `transactions/<operation-id>/prepared.json`과 `transactions/<operation-id>/committed.json`
- RouteObservationV1 route-attempt telemetry용 `observations/<subject_sha256>.json` —
  성공한 터미널 커밋 뒤 best-effort로 0개 또는 1개가 발행되며, 중복되지 않고
  커밋–emit 사이 프로세스 종료는 복구하지 않으며 fail-open한다
- `recoveries/<child-run-id>-affinity-recovery.json`, boundary-recovery capsule, `recoveries/root/<replacement-session-id>.json` root-relocation capsule
- `terminal/launch-command.txt`와 바인딩된 launch metadata `terminal/launch-command.meta.json`

WAL은 일반 read/mutation 전에 reconcile됩니다. incomplete, invalid, identity-mismatched prepared/committed publication은 **fail-stop**하며 partially published state를 건너뛰어 계속할 수 없습니다.

### acquire↔resume 계약

획득 계열 — `lease acquire`, `recovery acquire`, `root recovery acquire` — 의 **모든** 반환
객체가 세 필드를 항상 싣는다:

| 필드 | 의미 |
|---|---|
| `proceed` | boolean. `proceed === (ok === true && reason === 'acquired')` — 단일 파생 규칙이며 경로별 분기가 없다. **소비자는 `proceed`만 보고 진행을 판단한다.** 멱등 `already-owned`는 `ok:true`이면서 `proceed:false`다. |
| `consumed` | object 또는 `null`. 진행한 acquire가 **실제로 예약을 소비**했을 때만 non-null이며, 예약 없는 released lease 인수는 `null`이다. takeover 종류, 두 run id, boundary event, root digest/binding generation, handoff rel, 세대 전이를 에코한다. |
| `replayed` | boolean. `true`는 nonce replay — 같은 응답의 재발급이지 두 번째 소비가 아니다. `proceed`와 독립이며 관측용이다. |

성공 acquire는 durable **소비 영수증**을 `session_chain.lease.acquisition_receipt`에 남긴다
(세대당 하나, 매 성공 시 덮어씀). 응답 `consumed`의 상위집합이라 replay 응답 구성이 파생이
아니라 필드 복사이고, 세션 엔트리가 없는 owner에게도 존재한다.

**attempt nonce — `lease acquire --attempt-id <token>`** (optional,
`^[A-Za-z0-9_-]{8,128}$`; 비정형은 exit 1, 미지정은 위반이 아니다). 응답을 잃었으나 살아 있는
호출자가 **같은** 값을 재전송하면 커널이 `{proceed:true, replayed:true}`를 재발급해 사람 개입
없이 진행 권한을 회복한다. 규약은 **생성 → 호출자 쪽 durable 영속화 → acquire** 순서이며,
호출 후 기록은 "호출은 성공했는데 기록 전에 죽는" 창을 남기므로 **금지**한다 — 지키지 않은
호출자에게는 이 보증이 적용되지 않는다. 재시도는 같은 값을 재사용한다(새 값은 다른 시도다).
replay 자신은 아무것도 쓰지 않는다. 사람이 개시한 `node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" pause --mode preserve --reason "host-session-lost" --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>`는 이미 부여된 시도의
진행 권한을 **취소**한다 — replay는 run이 `running`일 때만 성립한다.

`resume-command`에 **acquired 브랜치**가 생겼다. 소비 이후에도 영수증만으로(read-only) "이 예약이
정확히 한 번, 어느 세대 전이에서, 누구에게 소비됐는가"를 검증할 수 있다. 첫 줄은 **비실행
마커**여서 레거시 소비자가 `already-owned`를 성공으로 오인할 표면을 만들지 않는다. 일반
재획득과 stale 영수증은 절대 consumed로 표출되지 않는다.

**경로 × 시나리오.** 획득 경로는 5개, CLI 표면은 3개다 — `normal`·`boundary-handoff`·
`boundary-recovery`가 `lease acquire`를 공유하고, `affinity recovery`와 `root recovery`는 각자
verb를 갖는다. 다섯 경로 모두 `proceed`/`consumed`를 보고하고 영수증을 남긴다. 다만
`--attempt-id`를 받는 것은 `lease acquire` 계열 3경로뿐이라 replay도 그 셋에만 있다. recovery
두 verb에는 replay 분기가 없으므로 **그 경로에서 응답이 유실되면 사람 개입으로만 회복된다** —
`resume-command`의 `Recovery: consumed`는 관측이지 진행 권한의 재발급이 아니다. 다만 두 verb의
duplicate 응답은 서로 다르고 호환되지 않는다: `recovery acquire`는
`LEASE_FENCED: generation-mismatch`(**exit 3**)를 throw하지만, `root recovery acquire`는 영수증
증명이 먼저 실패해 `ROOT_OPERATION_PROOF_INVALID`(**exit 1**)를 throw한다 — 그 신원은 fence가
아니어서 exit-3 경로를 타지 않는다.

**알려진 제약.** 1.13.0 이전 binary로 2세대 boundary emit을 시도한 run은 stranded prepared
journal을 들고 있을 수 있고, 그 run의 이후 모든 reconciled read/mutation이 fail-stop한다. 이
릴리스는 그 상태에 대한 **커널 복구 경로도 승인된 수동 절차도 제공하지 않는다** — 안전한 절차가
커널이 제공하지 않는 프리미티브(유지 가능한 maintenance lock)를 요구하기 때문이다. 해당 run은
폐기하거나 사례별로 사람이 판단한다. 새 run은 이 상태에 들어갈 수 없다.

**conformance fixture.** `tests/fixtures/acquire-resume-conformance.json`이 6개 ordering
(`raw-first`·`wrapper-first`·`duplicate`·`stale-invocation`·`lost-ack`·`principal-death`)을
zero-dep JSON으로 선언한다. public CLI와 원시 파일 op만 쓰고 저장소 테스트 헬퍼를 참조하지
않는다. 외부 소비자는 같은 seed·steps를 자기 transport에서 재생해 `{exit, ok, reason, proceed}`와
`final` lease 부분집합을 대조한다. `$T0`/`$T1`/`$T2`는 fixture의 `now_binding` 규칙대로
**재생 시점 기준 상대 오프셋**으로 바인딩한다 — recovery safety 판정이 lock 안에서 실제 clock을
샘플하며 주입할 수 없어, 절대 시각에 고정하면 재생 시점에 따라 결과가 갈린다.

## 커널 CLI: `insights` (Hill-Climbing)

deep-loop은 자신이 쌓은 run 이력을 3-verb 커널 서브커맨드(`scripts/lib/insights.mjs`, 스펙 §6)로 결정론 마이닝합니다.

> 참고: `--now`는 `insights emit`뿐 아니라 대부분의 커널 CLI 서브커맨드가 공통으로 받습니다(예: `next-action`, `tick`, `respawn`, `budget check`, `recover`, `session-profile set`, `finish`). 허용 형식은 epoch ms 또는 ISO-8601(date-only는 UTC 자정으로 해석, datetime은 `Z`/`±HH:MM` 지정자 필수)입니다. 모든 커맨드에서 malformed·값 누락·범위 초과(`±8.64e15`) `--now`는 공통 stderr `INVALID_NOW` + exit 1을 반환하며, 미지정 시 `Date.now()` 폴백은 그대로 유지됩니다.

| 서브커맨드 | 역할 | fence | exit |
|---|---|---|---|
| `insights [--run <id>] [--json]` | 지표+후보 계산·출력. **기본 = §4 집계 규약**, `--run`은 `per_run`만 한정 (후보/집계는 전 run 대상). **읽기 전용** | 불필요 | 0 / 1(invalid run id) / 2(usage) |
| `insights emit --owner <run_id> --generation <n>` | 아래 3단계 순서(tmp atomic write → `appendAnchored` `insights-emitted` 이벤트 → tmp→최종 atomic rename)로 envelope 발행 | **필수** (불변식 #2) | 0 / 1(invalid `--now` / lib error) / 3(fence) / 2(usage) |
| `insights latest [--json]` | **검증된** 최신 insights 반환. **읽기 전용** — 스킬(`/deep-loop` init, `/deep-loop-finish`)은 이 명령만 사용, `.deep-loop/insights/*.json`을 직접 파싱하지 않음 | 불필요 | 0 / 2(usage) |

payload(`insights_schema_version`은 `1` 유지 — 아래는 additive 필드)에는 신뢰 라벨 2종도 담깁니다: `suspicious_active`는 `excluded_active`의 부분집합으로, non-terminal·non-paused run 중 lease가 `released`이거나 `releasing`인데 TTL이 만료·부재인 경우를 표시합니다(죽은 lease 신호이지 추가 제외가 아님). `post_finish_mutated`는 terminal run의 `finish` 이벤트 뒤에 non-exempt 이벤트가 낀 경우를 표시합니다(집계에는 그대로 유지되고 라벨만 추가). `insights emit`의 stdout JSON은 두 라벨 배열을 envelope payload 안뿐 아니라 최상위 반환값에도 그대로 포함해 stdout만 읽는 소비자도 파싱 없이 볼 수 있습니다. `insights latest`는 artifact가 path+sha256으로 바인딩된 `insights-emitted` 이벤트(anchor) 이후, auto-floor cost를 제외한 이벤트가 정확히 하나이고 그것이 `finish`일 때만 신뢰합니다 — 그 외(다른 이벤트가 더 있거나 전혀 없는 경우)는 fail-soft로 다음 후보 파일로 건너뜁니다. 사람에게 insights 후보를 보여주는 소비자(예: `/deep-loop-finish`의 후보 블록)는 `suspicious_active`/`post_finish_mutated` 중 하나라도 비어있지 않으면 후보와 함께 표시해야 합니다.

## 안전 불변식

1. **proposal-only / 사람 승인** — push, PR, merge, publish, delete, marketplace/deep-suite sync는 자동 실행 안 함. v1은 항상 proposal을 제시하고 사람 확인 대기.
2. **리스 펜싱** — 모든 mutating 커널 CLI는 매칭되는 `--owner`(run_id)와 `--generation` 필요. 잘못된 세션은 상태 변경 전 거부.
3. **측정불가 사용량 fail-closed** — 무인(headless) 세션에서 turn/token 측정 불가 시 조용히 진행 않고 거부. `drive-headless.mjs` 드라이버가 강제.
4. **서킷 브레이커** — 반복 실패 시 브레이커 트립; 사람이 명시적으로 리셋해야 재개.
5. **proof 경유 터미널 상태** — 에피소드 `done`/`approved`/`rejected`, 워크스트림 `merged`/`abandoned`는 검증된 proof 아티팩트를 통해서만 설정 가능. **예외: episode `abandoned`는 사람 게이트(`--confirm`) escape 터미널 — proof 불필요, review point 충족으로 치지 않으며 두 종료 경로에서 settled로 취급.**
6. **`.deep-loop/` 외부 쓰기 금지** — 모든 커널 쓰기는 `<project-root>/.deep-loop/` 하위에만.

## 설치와 발견

마켓플레이스 엔트리는 merge와 별도 승인 뒤에만 동기화할 수 있습니다. v1.13.0에 대해서는 그 동기화가 이뤄졌습니다 — deep-suite 레지스트리가 머지된 `main` 커밋을 pin 합니다. pin 된 커밋보다 새로운 변경은 아래 로컬 저장소 경로를 사용하고 이미 배포되었다고 간주하지 마세요.

| Surface | 로컬 설치·발견 | 로컬 플러그인 변경 후 |
|---|---|---|
| Claude Code | 배포되지 않은 로컬 변경에는 `claude --plugin-dir /absolute/path/to/deep-loop`를 사용합니다. pin 된 릴리스에는 `/plugin marketplace add Sungmin-Cho/deep-suite`와 `/plugin install deep-loop@claude-deep-suite`를 사용합니다. | **new session**을 시작합니다. |
| Codex CLI | 아래 결합 설치 단계 둘 다 완료한 뒤 `/plugins`를 엽니다. | **new task/session**을 시작하고 `/plugins`에서 확인합니다. |
| Codex App | 같은 결합 설치를 완료합니다. ChatGPT desktop app에서 **Work or Codex**를 선택하고 **Plugins**를 연 뒤 deep-loop를 선택합니다. 연속성은 `workstream-session`을 사용합니다. | **restart the App** 후 **new task**를 시작합니다. |
| Grok CLI | Attended Darwin only. Grok 1.0.4는 Claude-cache-loaded plugin을 발견하며 `.grok-plugin` 매니페스트는 없습니다. 캐시 엔트리를 위해 `claude --plugin-dir /absolute/path/to/deep-loop` 또는 pin된 Claude marketplace 설치를 사용한 뒤 새 Grok session을 시작합니다. | 새 Grok session을 시작합니다. |

Codex 개인 설치는 대안 선택이 아니라 하나의 결합 작업입니다. 먼저 저장소를 공식 현재 개인 플러그인 디렉터리 `~/.codex/plugins/deep-loop`에 copy/place하고, 이어서 로컬 개인 마켓플레이스 `~/.agents/plugins/marketplace.json`의 해당 엔트리를 추가·수정해 `source.path`를 `"./.codex/plugins/deep-loop"`로 설정합니다. 두 단계가 모두 필요합니다. **ChatGPT desktop app: select Work or Codex, then open Plugins.**

Windows의 결합 경로는 `%USERPROFILE%\.codex\plugins\deep-loop`와 `%USERPROFILE%\.agents\plugins\marketplace.json`이며, 후자의 엔트리 `source.path`가 전자를 가리켜야 합니다. 요구사항은 Node >= 20이며 외부 npm 의존성은 없습니다.

**Codex App install/discovery and in-task skill execution are supported by contract.** 다만 **no automated app-native task creation**, **no private app-native task-creation URL or deep link**이 현재 경계입니다. 연속 실행은 기록된 프로젝트 루트에서 새 task를 열어 `$deep-loop:deep-loop-resume`을 수동 호출하며, 그때까지 durable lease가 run을 pause 상태로 보존합니다. **App smoke pending external evidence**: lifecycle 구현은 존재하지만 이 저장소에서 App 전용 smoke를 실제 실행했다고 주장하지 않습니다.

## 지원 표면

| Surface | 인터랙티브 스킬 | Attended continuation policy | 가시적 연속 실행 | 수동 resume | 헤드리스 연속 실행 | compaction 안전망 |
|---|---|---|---|---|---|---|
| Claude Code, macOS/Linux | 전체 | `workstream-session` — Workstream open 중 같은 대화에서 compact | first-terminal 경계에서 명시적으로 승인된 터미널/tmux/검증된 Claude Desktop handoff | `/deep-loop-resume`를 통한 **공식 지원 경로** | 경계 뒤 측정형 `claude -p` | 신뢰된 direct Node PreCompact checkpoint + SessionStart restore |
| Claude Code, native Windows | 전체 | `workstream-session` — Workstream open 중 같은 대화에서 compact | first-terminal 경계에서 명시적으로 승인된 Windows Terminal/PowerShell handoff | `/deep-loop-resume`를 통한 **공식 지원 경로** | 경계 뒤 신뢰된 native `claude.exe`, 아니면 fail-closed | 신뢰된 direct Node PreCompact checkpoint + SessionStart restore |
| Codex CLI, macOS/Linux | 전체 | `workstream-session` — first-terminal 경계까지 affinity 유지 | 명시적으로 승인된 runtime을 이용한 터미널/tmux 실행 | `$deep-loop:deep-loop-resume`을 통한 **공식 지원 경로** | 경계 뒤 격리 `codex exec --json` | trust review 후 플러그인 lifecycle hook; 버전 의존·우아한 부재 |
| Codex CLI, native Windows | 전체 | `workstream-session` — first-terminal 경계까지 affinity 유지 | 명시적으로 승인된 Windows Terminal/PowerShell 실행 | `$deep-loop:deep-loop-resume`을 통한 **공식 지원 경로** | 경계 뒤 격리·신뢰 `codex.exe`, 아니면 fail-closed | trust review 후 플러그인 lifecycle hook; 버전 의존·우아한 부재 |
| Codex App | install/discovery와 in-task execution | `workstream-session` — first-terminal 경계에서만 수동 task 변경 | 수동 새 task만 | 새 task를 열고 `$deep-loop:deep-loop-resume`을 실행하는 **공식 지원 경로** | 경계 뒤 선택적 격리 `codex exec` 드라이버 | trust review 후 플러그인 lifecycle hook; 버전 의존·우아한 부재, App smoke pending |
| Grok CLI, macOS | 전체 (attended) | `workstream-session` — first-terminal 경계까지 같은 대화; compact 미지원 | 승인된 Darwin 터미널/tmux에서 trusted grok runtime 실행 | `/deep-loop-resume`를 통한 **공식 지원 경로** | 미지원 — no measured headless | 미지원 — plugin hook matcher `"*"` 미기동 |

`workstream-session` continuation policy는 모든 host에 적용됩니다. attended run은 first-terminal 경계까지 interactive 동일 대화 작업이 기본입니다. unattended run은 측정형 headless 실행을 유지하지만 Workstream 중간에는 rotate하지 않습니다. manual resume은 오류 발생 시에만 쓰는 fallback이 아니라 일급 공식 지원 경로입니다.

**Codex POSIX visible authority:** macOS/Linux 자동 visible continuation에는 durable human-approved Codex runtime identity가 필요합니다. `cmux`는 양성 감지가 같은 absolute bundled executable과 exact socket을 성공한 ping으로 묶었을 때만 실행됩니다. `tmux`는 사람이 canonical executable identity를 승인하고 감지가 그 identity를 exact `$TMUX` socket, server PID, session에 묶은 후 지원됩니다. 승인 바이너리가 파생한 `#{session_id}`가 일치해야 하며, OS-bound pane ancestry proof(`#{pane_pid}` ↔ process ancestry)가 같은 session을 독립적으로 파생해야 합니다. macOS에서는 고정 `/usr/bin/osascript`를 통해 양성 감지된 iTerm2 또는 Terminal.app 하나만 실행되며, system binary의 존재만으로 두 런처를 활성화하지 않습니다. runtime 승인이 없으면 `runtime-identity-unavailable`, identity 또는 launcher drift는 spawned CAS 전후에 fail-closed하며 bare `codex`나 Claude process로 대체하지 않습니다.

Native Windows에서는 Node control plane을 win32에서 직접 실행하고 문서의 native command는 **PowerShell** 문법을 사용합니다. Windows Terminal과 PowerShell은 서로 다른 승인 launcher kind입니다. **WSL follows Linux behavior and is not native Windows**이므로 WSL의 실행 파일·경로는 native Windows spawn의 권위가 아닙니다. **Native Windows CI: pending external evidence** — 승인된 push 뒤 저장소의 Windows job이 실제 실행되기 전까지 통과를 주장하지 않습니다.

## 실행 파일 신뢰와 네이티브 Windows 런처

자동 연속 실행은 command lookup을 권위로 사용하지 않습니다. Runtime executable 진단/승인은 모든 지원 OS에서 선택한 runtime에 적용되고, launcher executable 승인은 native Windows WT/PowerShell 또는 POSIX tmux에 추가되는 경계입니다. `<absolute-deep-loop-root>`를 설치 플러그인의 canonical absolute root로 치환하고, 선택한 identity에 해당하는 read-only 진단 한 줄만 실행합니다.

```text
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" runtime-executable diagnose --runtime <claude|codex|grok> --path "<human-supplied-absolute-exe>"
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" launcher-executable diagnose --kind <wt|powershell> --path "<human-supplied-absolute-exe>"
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" launcher-executable diagnose --kind tmux --path "<human-supplied-absolute-exe>"
```

반환된 **canonical absolute path**(`canonical_path`)와 **lowercase SHA-256**(`sha256`)을 사람에게 그대로 보여 주고 exact identity 확인을 받습니다. 그 뒤에만 해당 fenced 승인 한 줄을 실행합니다.

```text
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" runtime-executable approve --runtime <claude|codex|grok> --path "<same-absolute-exe>" --canonical-path "<diagnosed-canonical-path>" --sha256 "<diagnosed-lowercase-sha256>" --actor human --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical-project-root>" --run-id <run_id>
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" launcher-executable approve --kind <wt|powershell> --path "<same-absolute-exe>" --canonical-path "<diagnosed-canonical-path>" --sha256 "<diagnosed-lowercase-sha256>" --actor human --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical-project-root>" --run-id <run_id>
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" launcher-executable approve --kind tmux --path "<same-absolute-exe>" --canonical-path "<diagnosed-canonical-path>" --sha256 "<diagnosed-lowercase-sha256>" --actor human --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical-project-root>" --run-id <run_id>
```

승인할 identity에 해당하는 한 줄만 실행합니다. **Identity drift fails closed and preserves the pause**이며, 다른 실행 파일이나 runtime으로 폴백하지 않습니다.

**Runtime/launcher Authenticode signer policy is pending Windows observation**이며, **distinct from the already-observed Claude Desktop handler pin**입니다. 후자는 검증된 `claude://code/new` 핸들러에만 적용됩니다. **No bare PATH authority**, no shim (`.cmd`, `.ps1`, wrapper) authority, **no bare `wt.exe` authority**입니다. signer policy, 후보 경로, `where.exe`/`Get-Command` 결과는 explicit canonical identity 계약을 대신하지 못합니다.

tmux의 bounded version probe는 `tmux 3.4`, `tmux 3.4a`처럼 release 형태의 출력만 수용합니다. `tmux next-3.4`와 같은 rolling/master label은 fail-closed 승인 경계의 의도에 따라 거부됩니다.

## 독립 동작 (Standalone)

deep-loop는 **독립** 사용을 위해 설계되었습니다 — 다른 deep-suite 플러그인 없이도 동작합니다:

- sibling 플러그인 미감지 시 `standalone` 프로토콜 기본 사용
- 스킬은 graceful 저하: maker/checker dispatch가 `standalone` 어댑터 사용
- 모든 안전 불변식, 예산 강제, 핸드오프 메커니즘 동일 동작

sibling 플러그인(deep-work, deep-review, deep-wiki, deep-memory) 존재 시 자동 감지 후 전문 스킬을 어댑터로 사용합니다.

## 무인 자동화 (Headless)

cron 또는 CI 사용을 위해 `scripts/hooks-impl/drive-headless.mjs` 포함:

```bash
# 헤드리스로 1 틱 실행 (측정불가 시 fail-closed: exit 1)
DEEP_LOOP_UNATTENDED=1 node scripts/hooks-impl/drive-headless.mjs --project-root "<canonical_project_root>" --run-id <run_id>

# cron/GitHub Actions 템플릿은 recipes/automation/ 참조
```

```powershell
# Native Windows PowerShell
$env:DEEP_LOOP_UNATTENDED = '1'
node scripts/hooks-impl/drive-headless.mjs --project-root "<canonical_project_root>" --run-id <run_id>
```

**Claude** 경로는 bounded `claude -p --output-format json` 출력을 파싱합니다. 승인된 **Codex** runtime은 인증된 격리 `CODEX_HOME`, shell-free `codex exec --json`, incremental JSONL 파싱을 사용합니다. 두 경로 모두 정확히 한 turn의 측정 usage를 기록하며 timeout, non-zero exit, malformed output, 측정불가 usage에서 fail-closed합니다. 교차 런타임 fallback은 하지 않습니다. **The isolated Codex child disables plugins and hooks**(Apps·원격 capability도 비활성화)하므로 absolute resume skill workflow를 inline 실행하고 durable state와 측정된 process exit에 의존합니다.

## deep-suite 연동

deep-suite 내에서 사용 시, deep-loop는 오케스트레이션 백본으로 동작:

- **deep-work** — 구현 워크스트림용 maker/checker 어댑터
- **deep-review** — 코드리뷰 워크스트림용 checker 어댑터
- **deep-wiki** — 문서 워크스트림용 writer 어댑터
- **deep-memory** — `/deep-loop-finish`가 run 아티팩트 아카이브를 위임

## 가시적 세션 연속성 (Self-Spawn)

명시적인 attended authorization으로 `autonomy.spawn_style`이 `'visible'`이 되고 지원되는 터미널 멀티플렉서가 감지되면, deep-loop는 다음 boundary 세션을 새로운 가시적 창에 스폰할 수 있습니다:

| 런처 | 감지 신호 | 새 세션 대상 |
|------|-----------|-------------|
| cmux | `CMUX_BUNDLED_CLI_PATH` + `CMUX_SOCKET_PATH` + surface ID | 소켓을 통한 새 cmux workspace |
| iTerm2 | `TERM_PROGRAM=iTerm.app` + osascript 프로브 | 새 iTerm 창 |
| Terminal.app | `TERM_PROGRAM=Apple_Terminal` + osascript 프로브 | 새 Terminal 창 |
| tmux | `$TMUX` + 사람이 승인한 canonical tmux identity + socket ownership/server-PID probe + session binding(승인 바이너리가 파생한 `#{session_id}` 일치) + OS-bound pane ancestry proof(`#{pane_pid}` ↔ process ancestry) | 감지된 tmux session의 새 window |
| Windows Terminal | `WT_SESSION` + 승인된 canonical launcher identity | 정확히 승인된 실행 파일을 통한 새 WT 탭 |
| desktop | (사용자 opt-in) Claude Desktop Code 탭 | 검증된 핸들러로 `claude://code/new` 딥링크 오픈 (반자동: 폴더 확인 + Enter). macOS(경로+bundle-id+codesign TeamIdentifier)와 v1.7.0부터 **Windows**(전통 인스톨러 정확-일치 경로 + publisher-id 해시 고정 MSIX 경로 패턴 + **실제 Windows 11 관측으로 pin된** Authenticode 서명자 thumbprint) 지원. Windows 제안은 라이브 프로브가 설치된 핸들러를 검증할 때만 표시되며, pin된 leaf 인증서 로테이션(NotAfter 2026-10-21경) 이후에는 새 관측 thumbprint를 재-pin하기 전까지 결정론적 fail-closed로 복귀한다 — 추측성 pin은 절대 쓰지 않는다. |

스폰은 **attended 전용**이자 boundary 전용입니다. 부모 세션은 interactive이고 durable `attended_launch_approval`을 가져야 합니다. 부모가 headless(`DEEP_LOOP_UNATTENDED=1`, `spawn_style='headless'`, 또는 headless 진입점 감지)이면 가시적 스폰을 우회하며, Workstream 중간 rotation 권한을 만들지 않습니다.

**OS 무관 폴백**: 런처 미감지(`launcher='none'`) 또는 attended 아닌 경우, `respawn`은 `{ok:false, outcome:'no-launcher'}`를 반환합니다. 스킬은 `pauseRun({mode:'preserve'})`를 호출해 예약된 child를 핸드오프에 유지합니다. 이후 사람이 새 터미널을 열고 Claude Code에서는 `/deep-loop-resume`, Codex에서는 `$deep-loop:deep-loop-resume`을 실행하거나, 예약된 child 세션이 나중에 시작해 아직 releasing 상태인 lease를 인수하면 — 어느 경로든 run이 자동으로 일시정지 해제됩니다. 핸드오프 문서와 `launch-command.txt`는 항상 런타임에 맞는 수동 복사-붙여넣기 명령을 제공합니다.

**게이트 순서**: budget → breaker → max_sessions → wallclock → auto_handoff. 게이트 실패 시 `rollbackAndPause`(lease 롤백, child 무효화). 실행 명령 실패도 롤백. 준비 타임아웃 시 `preservePause`(child 유지, 늦은 인수도 성공).

## PreCompact Hook

deep-loop는 `PreCompact`, `PostCompact`, `SessionStart` hook을 등록합니다. PreCompact는 **emit-only**, **best-effort**로 `workstream-session`을 따르고 unattended continuation은 측정 가능한 `scripts/hooks-impl/drive-headless.mjs`가 담당합니다. `workstream-session`에서 open bound Workstream affinity만 bounded checkpoint를 받고 같은 대화를 유지하며, PreCompact는 `no-affinity`를 반환하고 otherwise 이 policy의 handoff를 emit하지 않습니다. first-terminal boundary handoff는 PreCompact가 아니라 `next-action`이 선택합니다. migrated legacy policy만 PreCompact handoff 경로를 유지합니다. PostCompact는 CLI-observe-only이고 `SessionStart(compact)`는 matching checkpoint context 또는 boundary/복구 안내만 주입합니다. `hooks/hooks.json`의 **exact hook definitions trust is required**하며 세 hook은 **direct shell-free Node** 안전망입니다. 어떤 hook도 세션을 spawn하지 않으며 예외로 compaction이나 session start를 막지 않습니다.

`hooks/hooks.json`의 static Node bootstrap들은 `CLAUDE_PLUGIN_ROOT` 또는 `PLUGIN_ROOT`를 해석하고 file URL로 `scripts/hooks-impl/precompact-handoff.mjs`, `scripts/hooks-impl/postcompact-observe.mjs`, 또는 `scripts/hooks-impl/sessionstart-restore.mjs`를 import해 `main()`을 호출합니다. Bash wrapper나 shell expansion에 의존하지 않습니다.

Codex bundled-hook 발견은 host 버전에 의존하며, 사용자가 plugin hook definition을 검토하고 신뢰한 후에만 적용됩니다. **Missing or untrusted hook**(미지원 host 버전 포함)의 manual compact restore는 fresh evidence를 읽어 same owner와 open bound Workstream affinity를 입증하고, 이 증거가 있을 때만 state-derived continuation을 선택합니다. Otherwise preserve-pause와 공식 manual resume(수동 resume) 경로를 선택합니다. 이 fallback은 fencing을 약화하거나 두 번째 owner를 만들지 않습니다. 격리 Codex child가 plugins와 hooks를 끄는 것도 이 durable fallback을 기대한 설계입니다.

## 에이전시 보존 fixture 평가

preflight와 분리된 오프라인 read-only 격리 fixture 은행을 실행합니다: `npm run eval:fixture -- --out ./evals/results/local --now 2026-08-10T00:00:00Z`.

## 라이센스

MIT — LICENSE 참조.
