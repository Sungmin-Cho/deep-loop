---
name: deep-loop-finish
description: "deep-loop finish — end-of-work: writes the final report, then transitions the run to completed (proof-gated) or stopped, and delegates to deep-memory / deep-wiki when installed. Triggered by '/deep-loop-finish', 'finish the loop', 'wrap up', 'end the run', '루프 종료', '작업 마무리', '런 종료', cross-platform Skill({ skill: \"deep-loop:deep-loop-finish\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> **loop.json + handoff 파일이 source of truth** — 이전 대화 컨텍스트를 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.
> **artifacts 삭제 ❌** — 생성된 artifact 파일을 절대 삭제하거나 덮어쓰지 않는다.
> 동일 작업에 이미 받은 대상 특정 외부 행동 승인은 유지한다. 새 권한을 추정하지 않는다.

## 실행 루트와 호스트 호출

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

호출은 제품 이름(Claude Code / Codex / Grok Build)을 직접 assertion한다. Claude Code는 `/deep-loop-finish`, Codex는 `$deep-loop:deep-loop-finish`, Grok Build는 `/deep-loop-finish`(모호하면 `/deep-loop:deep-loop-finish`)를 사용한다. 슬래시 호출이 Claude를 뜻하지 않는다. 환경 변수로 호스트를 단정하지 않는다.

## 개요

`/deep-loop-finish` — 작업 종료: final report 작성 → proof-gated `completed` 전이 (또는 `stopped`) → deep-memory / deep-wiki 위임.

## 단계 0: Lease identity 확인

descriptor/current run의 `<run_id>`는 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. 종료 관련 mutation 전에 current lease를 새로 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`에서 얻는다. insights emit과 finish는 이 current fence와 불변 `<run_id>`를 함께 전달한다.

## 단계 0.5: v0.5 원래 목표 확인

상태 버전이 `0.5.0`이면 `goal status --json`으로 실제 전체 목표 proof를 읽고
`Read("DEEP_LOOP_ROOT/skills/deep-loop-workflow/references/goal-execution.md")`의 **Finish**를 따른다.
누락된 작업은 계속 수행하고, 오래된 proof는 새 목표 리뷰로 확인한다. 단순히 maker가 끝났다는
이유로 완료하지 않는다. 정상적으로 복구 가능한 누락을 무조건 사용자 상태 수정으로 넘기지 않는다.
측정 headless goal driver에서는 마지막 turn 계상을 위해 finish 직전 host에 yield한다.

## 단계 1: Final Report 작성

> [!IMPORTANT]
> cwd가 worktree 안일 때 상대 경로는 잘못된 위치에 파일을 만든다. **반드시 커널이 반환한 absolute run-dir를 사용한다.**

먼저 read-only resolver로 run directory를 얻는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" path resolve --target run-dir --project-root "<canonical_project_root>" --run-id <run_id>
```

반환된 한 줄의 절대 경로를 `<resolved-run-dir>`로 사용해 final report를 작성한다:

```
Write({ file_path: "<resolved-run-dir>/final-report.md", content: report })
```

report 내용:
- **목표 & 결과**: 달성된 goal 요약
- **생성/변경 파일**: repo/파일 목록
- **사용 명령 & 원칙**: 핵심 CLI 호출 기록
- **Maker-Checker 흐름**: episode별 maker/checker 결과
- **Worktree 사용 현황**: 브랜치 & 병합 상태
  - `merged`/`abandoned` worktree 정리 제안: native `ExitWorktree` 우선, 없으면 `git worktree remove` — proposal-only(자동 삭제 ❌, 사람 승인)
  - reconcile audit: `<canonical_project_root>/.worktrees/`(및 `.claude/worktrees/`) 밑에서 기록에 없는(어떤 workstream에도 매핑 안 된) 디렉터리를 고아 후보로 surface(proposal-only); root-밖 native worktree는 audit 대상 아님(Step 1a가 애초에 생성 안 함)
- **Heartbeat & 검증 결과**: budget 소비, comprehension debt
- **통합 여부**: PR/브랜치 병합 상태(proposal-only — 실제 push는 사람이)
- **남은 TODO**: 미완료 항목 목록
- **사용 예시**: 다음 run을 위한 명령 예시
- **다음 명령**: 이어서 할 작업 제안
- **사람 검증 체크리스트**: 사람이 확인해야 할 항목

## 단계 1.5: Hill-Climb Insights Emit (비치명)

final report 작성 직후, 이 run의 트레이스를 결정론 마이닝해 하네스 개선 신호를 durable하게 남긴다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" insights emit --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

- **실패는 비치명이다** — `insights emit`이 실패해도(디스크 오류 등) finish는 계속 진행한다. 실패 시 그 사실을 로그에 명시하고 final report에도 기록한다(재시도 불필요 — 다음 run의 emit이 다시 시도된다).
- 성공하면 stdout의 JSON 응답에 `candidates` 배열이 포함된다. **이 배열로부터 후보 요약을 만든다 — 파일을 열어 파싱하지 않는다**(2-plane: `insights emit`의 CLI 출력만 사용).
- stdout JSON의 `suspicious_active` / `post_finish_mutated` 배열이 비어있지 않으면 해당 run 목록을 ⚠️ 주의로 표기한다 — **후보 유무와 무관하게**(후보 0건으로 후보 요약 블록을 생략하는 경우에도 이 표기는 출력한다; plan-r3 — labels-only 케이스에서 라벨이 침묵하지 않도록). 신뢰 라벨은 집계에 이미 반영/유지되어 있으므로 사람 판단 참고용.
- `candidates`가 비어있지 않으면 최종 메시지에 아래 제안 블록을 출력한다(후보 id·metric·value 요약은 **메시지 본문에만** 표기):

  ```
  하네스 개선 후보 N건 발견: <candidate.id 목록>
  Claude 다음 호출: /deep-loop "하네스 개선"
  Codex 다음 호출: $deep-loop:deep-loop "하네스 개선"
  ```

  **제안 명령의 goal은 고정 문구 그대로 쓴다 — candidate id를 goal에 넣지 않는다.** id(`fix_cycles_high:implementation` 등)는 "fix"/"implement" 같은 다른 recipe 트리거를 부분문자열로 포함해 recipe-match(첫 매치 substring 라우팅)가 비결정적으로 샐 수 있기 때문이다. 새 hill-climb run의 design maker는 후보를 goal이 아니라 `insights --json`/`insights latest --json`에서 읽는다(§2 흐름).
  **자동으로 이 명령을 실행하지 않는다** — 사람이 직접 입력해야 다음 hill-climb run이 시작된다.
- `candidates`가 비어있으면(또는 emit 실패로 응답이 없으면) 제안 블록을 생략하고 "개선 후보 없음"만 명시한다.

## 단계 2: Proof 확인

`completed` 전이 전에 proof를 확인한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field episodes --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field workstreams --project-root "<canonical_project_root>" --run-id <run_id>
```

proof 요건:
- 모든 episode settled (`done`/`approved`/`abandoned`)
- `active_workstreams` 비어있음
- 모든 workstream 터미널 상태 (`ready`/`merged`/`abandoned`)
- final-report.md 존재
- 모든 done maker episode에 독립 reviewer 승인

## 단계 3: Run 종료

### completed (proof 충족 시)

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" finish --status completed --report final-report.md --proof '{}' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

v0.4의 `FINISH_PROOF_UNMET` 에러는 기존 진단 절차로 처리한다. v0.5는 fresh `next-action`과
`goal status --json`에 따라 실제 누락 작업·리뷰를 이어간다. 명시적 hard gate나 실제 새 권한은 유지한다.

### stopped (사람 명시 중단)

`stopped`는 completed proof(리뷰·workstream 터미널·리포트)를 **우회하는 일방 종료 경로**이므로 형제 human-only 조작(abandon/recover/breaker reset)과 동형으로 **`--confirm`이 필수**다(누락 시 `CONFIRM_REQUIRED`, exit 2). **autonomous/headless tick은 이 커맨드를 스스로 발행하지 않는다** — 사람이 명시적으로 중단을 승인할 때만 쓴다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" finish --status stopped --confirm --proof '{"human_reason":"사람이 명시적으로 중단 요청"}' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

## 단계 4: Deep-memory 위임 (감지 시)

deep-memory 플러그인이 설치된 경우 runtime에 맞게 위임한다. Claude는 다음 host invocation을 사용한다:

```javascript
Skill({ skill: "deep-memory:deep-memory-harvest" })
```

Codex는 qualified `$deep-memory:deep-memory-harvest` invocation을 사용한다.

핵심 결정 사항을 `deep-memory-save`로 저장한다.
**deep-loop이 `~/.deep-memory`를 직접 쓰지 않는다** — deep-memory 자체 스킬에 위임한다.

## 단계 5: Deep-wiki 위임 (감지 시)

deep-wiki 플러그인이 설치된 경우 runtime에 맞게 위임한다. Claude는 다음 host invocation을 사용한다:

```javascript
Skill({ skill: "deep-wiki:wiki-ingest", args: "<resolved-run-dir>/final-report.md" })
```

Codex는 qualified `$deep-wiki:wiki-ingest`에 `"<resolved-run-dir>/final-report.md"` 인자를 전달한다.

미감지 시 스킵하고 명시적으로 로그에 기록한다.
