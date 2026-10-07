---
name: deep-loop-status
description: "deep-loop status — shows the current run's status, budget, comprehension debt, circuit breaker, pending human reviews, session chain, and workstreams. Read-only. Triggered by '/deep-loop-status', 'loop status', 'show the loop', 'where are we', '루프 상태', '상태 보기', '진행 상황', cross-platform Skill({ skill: \"deep-loop:deep-loop-status\" })."
user-invocable: true
---

사용자의 언어(language)를 감지하여 같은 언어로 응답한다.

## 실행 루트와 호스트 호출

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

호출은 제품 이름(Claude Code / Codex / Grok Build)을 직접 assertion한다. Claude Code는 `/deep-loop-status`, Codex는 `$deep-loop:deep-loop-status`, Grok Build는 `/deep-loop-status`(모호하면 `/deep-loop:deep-loop-status`)를 사용한다. 슬래시 호출이 Claude를 뜻하지 않는다. 환경 변수로 호스트를 단정하지 않는다.

## 개요

`/deep-loop-status` — 현재 run의 상태(status), 예산, comprehension debt, circuit breaker, 미검토 episode, session chain, workstream 표를 **읽기 전용**으로 표시한다.

프로젝트에 여러 run이 있을 수 있으므로 먼저 `run list`로 bounded verified 목록을 보고 대상 `<run_id>`를 선택한다. `current` 포인터는 마지막 생성 run을 가리키는 hint일 뿐이고 sole authority나 tie-breaker가 아니다. status 조회 대상 `<run_id>`는 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. 아래 사람 전용 mutation을 제안하거나 실행하기 전에는 선택한 run의 lease를 새로 읽는다.
스킬의 autonomous 진단은 durable state를 **읽기만** 한다. 아래 mutation은
명시적 사람 확인 뒤 public kernel CLI로만 실행하며 상태 파일을 직접 쓰지 않는다.

## 조회 순서

### 0. Run 목록과 선택

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" run list --project-root "<canonical_project_root>"
```

목록에서 확인한 `<run_id>`를 모든 아래 read와 사람 전용 mutation에 명시한다. current가 다른 run을 가리켜도 그 포인터로 바꾸거나 fallback하지 않는다.

각 행의 `verification`은 그 행을 어떻게 검증했는지 말한다. `state-hash`는 terminal run을 lock 없이 state hash·스키마·project binding으로만 읽은 것이고, `full`은 lock 아래의 전체 검증이다. terminal run의 event log까지 확인하려면 그 `<run_id>`로 아래 §1을 조회한다.

#### 0.1 run 선택이 안 될 때

compact hook과 status band는 cwd로 run을 고른다. 같은 선택을 직접 확인하려면:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" run resolve --cwd "<session_cwd>" --project-root "<canonical_project_root>"
```

`run list`가 `ok: false` 디스크립터를 내거나 `errors`가 비어 있지 않을 때, 또는 `run resolve`가 `invalid`·`ambiguous`일 때는 사유와 아래 안내를 함께 보여 준다. 이 스킬은 어느 안내도 **실행하지 않는다**. 디렉터리 이동·삭제와 run 정지는 사람이 결정한다.

| 사유 | 안내 |
|---|---|
| `run-set-bound-exceeded`, `phase: enumeration`, `bound: count` | run 디렉터리가 256개를 넘는다. 오래된 run 디렉터리를 `.deep-loop/runs/` 밖으로 옮기는 것을 사람에게 제안한다. |
| `run-set-bound-exceeded`, `phase: full-capture-count` | terminal로 검증되지 않는 run이 64개를 넘는다. stale 활성 run을 멈추는 것을 제안한다(아래 `multi-active-root-cwd` 행). |
| `run-set-bound-exceeded`, `phase: claims` | 모든 run의 worktree claim 합이 4096개를 넘는다. 오래된 run 정리를 제안한다(위 두 행). |
| `run-set-bound-exceeded`, `bound: deadline` 또는 `bytes` | 시간·바이트 상한이다. 부하가 줄면 다시 시도한다. 계속되면 위 두 행을 본다. |
| `run-set-integrity` | `errors`에 나온 run을 `validate --run-id <run_id>`로 확인한다. kind `state-missing`은 `loop.json`이 없는 run 디렉터리다. 사람이 옮기거나 지우는 것을 제안한다. |
| `invalid-worktree-claim` | 활성(running·paused) run의 worktree claim이 규격(`.claude/worktrees/` 또는 `.worktrees/` 아래 상대 경로)에 맞지 않는다. `errors`의 run을 `--run-id`로 조회해 확인한다. `worktree`는 `state patch`로 고칠 수 없는 필드라 **지금 CLI로 고치는 경로는 없다**. 사람에게 그 사실을 알린다. |
| `reconciliation-required` | `errors`의 run을 `--run-id`로 확인한다(아래 §1의 `state get`). 이 정확 읽기는 검증만 하며, 미완료 발행이 있으면 거부할 뿐 고치지 않는다. 재조정과 fail-stop 규칙은 README 호환 계약의 WAL 문단이 정한다. 이 스킬에 별도 복구 절은 없다. |
| `none`, `terminal-residue`, `source: worktree` | cwd가 끝난 run이 claim했던 worktree 안이다. 다른 활성 run이 같은 경로를 쓰고 있어도 그 안에서는 compact safety net이 꺼진다. 프로젝트 root에서 작업하거나 새 run에는 새 worktree 경로를 쓰도록 제안한다. |
| `multi-active-root-cwd`, `duplicate-worktree-claim` | `run list`에서 stale 활성 run을 고른다. `run list`도 상한에 걸리면 `.deep-loop/runs/`의 디렉터리 이름을 보고 아래 §1의 `state get --run-id`로 하나씩 확인한다(정확 읽기는 run 집합을 스캔하지 않는다). 멈추는 것은 `/deep-loop-finish`의 stopped 절차다(`--confirm`과 `human_reason`이 필수). 그 명령은 run이 `running`이고 lease가 `active`일 때만 통과한다. 이 스킬의 사람 전용 복구 절은 각자 좁은 전제를 가진다(예: lost-host 복구는 `host-session-lost` pause, active lease, 열린 affinity). 그 전제에 맞지 않는 `paused` run이나 lease가 `released`·`releasing`인 run은 **지금 일반적인 정지 경로가 없다**. 사람에게 그 사실을 알린다. 멈춘 run의 claim은 terminal이 되므로, 그 경로를 다른 활성 run이 쓰고 있으면 그 안의 cwd는 위 `none` 행이 된다. |

terminal claim(끝난 run의 claim, 또는 ready·merged·abandoned workstream의 claim)은 그 경로 안의 cwd에만 영향을 준다. 그 안에서는 `none`(`terminal-residue`)이고, 프로젝트 전체 선택은 막지 않는다. 예외는 예전과 같다. 활성 run이 없고, 끝난 run 하나의 일반 claim이 cwd를 포함하고, `current`가 그 run을 가리키면 읽기 전용 `legacy-current` 선택이다. 예전 형식의 절대 경로 claim은 root 안 컨벤션 디렉터리를 가리키면 상대 경로로 해석되고, 해석할 수 없으면 격리된다. `run resolve`의 `history`가 그 개수를 보여 준다. lock이 계속 잡혀 있는 run은 `errors`에 kind `lock-busy`로 나온다.

### 1. 전체 Loop 상태

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`status`, `goal`, `protocol`, `created_at`, 적용 중인 continuation policy(`autonomy.continuation_policy`), `session_spawn.reason`(visible continuation 비활성 사유)을 출력한다.
`<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`에서 얻는다. read-only 조회에는 fence가 없고, 사람 전용 mutation만 이 current fence와 불변 `<run_id>`를 함께 쓴다.

### 2. 예산 확인

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" budget check --project-root "<canonical_project_root>" --run-id <run_id>
```

`budget check`는 `{ok, reason, tier_after}`만 돌려준다. `spent`(turns), `tokens_spent`, 남은 예산 같은 수치는 이 명령이 아니라 `state get --field budget`의 값이나 읽기 전용 `run status --json`의 `run.budget`에서 읽는다.

### 3. Comprehension Debt

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" comprehension status --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field comprehension --project-root "<canonical_project_root>" --run-id <run_id>
```

첫 번째 조회의 `debt_ratio`, `blocked`와 두 번째 조회의 `episodes_total`, `episodes_human_reviewed`, `episodes_agent_reviewed`를 출력한다. `debt_ratio`/`blocked`는 **정착된(done) maker 기준**의 실시간 게이트 판정이고, durable 카운터는 pending을 포함한 감사 원본이다 — 서로 다른 것을 세므로 불일치는 정상이다. 두 번째 조회에 저장된 정적 `debt_ratio`는 실시간 판정으로 사용하지 않는다.

### 4. Circuit Breaker

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" breaker check --project-root "<canonical_project_root>" --run-id <run_id>
```

- `tripped: false`이면 정상.
- `tripped: true`이면 **사람이** 직접 reset해야 한다:
  ```
  node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" breaker reset --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
  ```
  (사람 + lease-owner 전용 경로 — autonomous tick은 `--confirm`을 자동으로 주지 않는다.)

### 5. Workstream 표

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field workstreams --project-root "<canonical_project_root>" --run-id <run_id>
```

각 workstream의 `id`, `title`, `status`, `review_points_done`을 표 형태로 출력한다.

### 6. 미검토 Episode

comprehension status의 `blocked === true`일 때만 미검토 episode 목록을 출력하고 `/deep-loop-ack --actor human`을 안내한다. 목록 대상은 아래 조건을 모두 만족하는 episode로만 고른다:

- `role === 'maker'`
- `status === 'done'`
- `human_reviewed !== true`

사람 검토만 게이트를 해제하며, `episodes_agent_reviewed`는 기계 리뷰 계상으로 debt에 무관하다. `episodes_total`과 `episodes_human_reviewed` 등 durable 카운터는 pending maker도 포함하는 감사 원본이므로 ack 대상 선택이나 이 섹션의 표시 여부에 사용하지 않는다.

### 7. 막힌(stranded) non-terminal episode

`next-action`이 `await_human`을 반환하고 `reason`이 `orphan-maker-no-artifacts`(proof-impossible: `expected_artifacts: []`라 절대 `done`이 될 수 없는 maker)이거나, 기타 터미널에 도달하지 못한 채 막힌 episode일 때는 사람이 해당 episode를 abandon으로 정착(settle)시켜 finish를 풀어준다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" episode abandon --id <id> --reason "<why>" --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

(`--confirm` + lease fence(`--owner`/`--generation`)는 사람 전용 경로 — autonomous tick은 자동으로 주지 않는다. abandon 후 episode는 `abandoned`(settled)가 되어 finish 게이트가 풀린다.)

### 7.5 Review flags 재구성

운영 실패로 checker를 사람 승인하에 abandon한 뒤, 다음 checker를 만들기 전에
reviewer route를 Codex-only static으로 바꿔야 하는 경우에만 current lease를
다시 읽고 아래 전용 mutation을 제안한다. source는 최신 checker이며
durable reviewer가 `deep-review-loop`, source plugin이 `deep-review`, source가 done
maker에 바인딩되어 있고 `operational-review-failure:` reason으로 abandoned
상태여야 한다. 커널은 source를 한 번만 소비하고, non-terminal checker가 하나라도
있으면 변경을 거부한다.
generic `state patch review.flags`나 raw `loop.json` 수정으로 우회하지 않는다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review configure --profile codex-only-static --source-checker <abandoned_checker_id> --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

`codex-only-static`은 exact flags
`["--contract","--codex-only","--reviewer-strategy","static"]`로만 확장된다.
critical document의 provider-family floor를 유지하면서 사람이 Agy 전송과 모델
예외를 명시 승인한 경우에는 `--profile gpt56-agy-static`을 대신 사용한다. 이
profile은 Codex 두 역할을 `gpt-5.6-sol/high`, Agy 역할을
`gemini-3.6-flash-high`로 고정하고 Opus와 fallback은 비활성화한다. 임의 모델이나
provider argv는 받을 수 없다.
`--confirm`은 사람이 source checker와 fresh fence를 확인한 경우에만 전달한다.
성공하면 커널은 source 소비, `review-configured` 이벤트, `review.flags` 변경을
하나의 anchored transaction으로 기록한다.

## 다음 명령 제안

상태에 따라 적절한 다음 명령을 제안한다:
- 정상 진행 중: `/deep-loop-continue`
- handoff 대기: `/deep-loop-resume`
- 완료 가능: `/deep-loop-finish`
- breaker tripped: 아래 exact command를 사람이 직접 실행한다:
  ```
  node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" breaker reset --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>
  ```

## Human-only safety relief

`next-action`이 `await_human`을 반환하면 autonomous skill은 relief command를
실행하지 않는다. 사람이 현재 pause reason, fresh owner/generation, 요청한
positive delta를 확인한 경우에만 예산을 확장한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" budget extend --turns <positive_turn_delta> --reason "<human_confirmed_reason>" --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

breaker reset은 위 §4의 exact command를 사람이 직접 확인한 경우에만
실행한다. recovery reservation에서는 두 route 모두 exact child/capsule을
보존하며, autonomous tick은 실행하지 않는다.

## Human-only attended launch approval

interactive가 기본이다. 사람이 visible launch를 명시적으로 요청하고 fresh
lease와 executable/launcher diagnosis를 확인한 경우에만 다음 command를
제시하고 확인 후 실행한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" attended-launch approve --style visible --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

desktop은 이 command의 style을 바꾸지 않고 전용 `spawn-style
offer-desktop`/`confirm-desktop` human flow를 사용한다. revoke도 사람이
명시적으로 확인한 경우에만 실행한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" attended-launch revoke --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

continue/handoff skill은 승인 state에서 자동 respawn을 추론하지 않는다.

## Human-only lost-host affinity recovery

열린 Workstream의 original host conversation이 실제로 복구 불가능하다는
사람 확인 없이는 affinity를 supersede하지 않는다. 먼저 fresh lease,
owner scope, Workstream, episode, budget, breaker를 진단하고 original owner
fence로 exact preserve-pause reason을 기록한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" pause --owner <owner_run_id> --generation <n> --mode preserve --reason "host-session-lost" --project-root "<canonical_project_root>" --run-id <run_id>
```

사람이 진단과 reason을 확인한 경우에만 다음 command를 실행한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" recover --supersede-affinity --reason "<human_confirmed_reason>" --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

커널 반환의 child id, `recovery_rel`, `recovery_sha256`, project root digest,
binding generation, current generation, runtime, `resume_command`를 그대로
표시한다. 이어서 read-only descriptor를 다시 열고 첫 줄이 같은 exact
`recovery acquire --capsule ...`인지 확인한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" resume-command --project-root "<canonical_project_root>" --run-id <run_id>
```

사람은 반환된 exact command만 새 process에서 실행한다. plain acquisition,
capsule/path 편집, stale artifact 재사용은 금지한다.

## Human-only project-root relocation recovery

candidate root를 사람이 명시한 경우에만 read-only diagnosis를 실행한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" root diagnose --candidate-project-root "<candidate_project_root>" --run-id <run_id>
```

`action`, blocker/topology, `current_root_digest`,
`current_binding_generation`, owner/generation fence를 모두 표시한다.
`wait`이면 멈추고 `already-rebound`이면 새 command를 만들지 않는다.
`rebind` 또는 `relocation-recovery`이면 사람이 exact diagnosis,
preserve-pause reason, root digest/epoch, fence를 확인한 뒤에만 kernel이
반환한 exact command를 실행한다. command의 `--confirm`, `--actor human`,
expected stored-root digest, expected binding generation을 바꾸지 않는다.

relocation recovery 뒤에는 `resume-command`를 다시 실행하고, returned
`root recovery acquire --capsule ...` command의 candidate root, capsule
SHA-256, binding generation, child, runtime, lease generation이 fresh state와
일치할 때만 그대로 실행한다. stale root-bound command나 locator를 손으로
고치지 않는다.
