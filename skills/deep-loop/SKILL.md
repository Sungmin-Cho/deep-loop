---
name: deep-loop
description: "Loop Engineering control plane entry — starts a durable cross-plugin orchestration run over the deep-suite. Detects siblings, matches a recipe/protocol, asks the review strategy, decomposes the goal into workstreams, creates the run, and prints the next command. Triggered by '/deep-loop \"<goal>\"', 'start a loop', 'loop engineering', 'orchestrate this work', '루프 시작', '딥루프 시작', '루프 엔지니어링', cross-platform Skill({ skill: \"deep-loop:deep-loop\", args: \"<goal>\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어를 감지하여 같은 언어(language)로 응답한다.
> **loop.json + handoff 파일이 source of truth** — 이전 대화 컨텍스트를 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인을 받는다.
> **maker/checker 분리 유지** — 같은 세션이 동일 workstream의 maker와 checker를 겸하지 않는다.
> 스킬은 durable state를 **읽기만** 하며, 모든 변경은 public kernel CLI로만 요청한다.

## 실행 루트와 호스트 호출

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

호출은 제품 이름(Claude Code / Codex / Grok Build)을 직접 assertion한다. Claude Code는 `/deep-loop "<goal>"`, Codex는 `$deep-loop:deep-loop "<goal>"`, Grok Build는 `/deep-loop "<goal>"`(모호하면 `/deep-loop:deep-loop "<goal>"`)를 사용한다. 슬래시 호출이 Claude를 뜻하지 않는다. 환경 변수로 호스트를 단정하지 않는다.

## 개요

`/deep-loop "<goal>"` — deep-suite 전체를 아우르는 내구성 있는 크로스-플러그인 오케스트레이션 run을 시작한다. loop engineering 진입점.

## 단계 1: 기존 Run 감지와 명시적 identity 선택

프로젝트에는 여러 run이 동시에 존재할 수 있다. 먼저 bounded verified 목록을 확인하고, 사용자가 선택한 불변 logical id를 이후 명령에 명시한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" run list --project-root "<canonical_project_root>"
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field status --project-root "<canonical_project_root>" --run-id <run_id>
```

`current` 포인터는 마지막으로 만들어진 run을 알려주는 **hint**일 뿐이며 권위, 소유권 증명, 후보 tie-breaker가 아니다. 목록에 없는 run이나 current로의 암묵적 fallback은 선택하지 않는다. 결과가 `running`이면 `/deep-loop-status`로 해당 `<run_id>`의 현황을 보여주고 이어가기 또는 새 run 시작 중 선택을 요청한다. `null` 또는 파일 없음이면 새 run을 시작한다.

동시 run마다 worktree 경로와 branch를 서로 다르게 사용한다. worktree를 먼저 만들고 `workstream new`로 기록하는 create↔record 사이에는 좁은 TOCTOU가 아직 남아 있다. v1은 project-level reservation, claim retirement, ownership transfer를 구현하거나 보장하지 않으며, 중복 claim은 fail-closed되고 고아 정리는 proposal-only로 surface한다.

## 단계 2: Run 시작

### 2-1. Sibling 플러그인 감지

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" detect-plugins --project-root "<canonical_project_root>"
```

감지된 플러그인 목록을 확인한다(deep-work, deep-review, deep-wiki, deep-memory 등).
`detect-plugins`는 각 sibling을 `installed`(어느 런타임 캐시에든 설치 — best-effort union, 마켓플레이스/직접 git 레이아웃 모두 매니페스트 `name`으로 감지) / `initialized`(프로젝트·홈 마커) / `present`(installed‖initialized)로 구분 감지한다. 리뷰/recipe 전략 분기는 `present`를 본다(설치-but-미초기화 sibling 누락 방지). 실제 dispatch는 Execution-plane LLM이 수행하며 그 시점에 호출 가능 여부를 확인한다(2-plane).

### 2-1.5. 적합성 판단 (suitability gate)

단계 1에서 **새 run**이 확정된 직후에만 수행한다(이어가기·resume 경로 제외). 먼저 trim 기준 비어있지 않은 goal 문자열을 확보하고(없으면 goal 확보가 선행), 2-2가 소비할 그 확정 goal에 대해 정확히 1회 판단한다.

- **루프 신호**: 여러 PR/workstream 스코프, 세션을 넘길 장기전, maker/checker 리뷰 규율이 가치 있는 변경, 크로스 플러그인 오케스트레이션, 장기·다중 세션 discovery/triage 분석.
- **부적합 신호**: 내구 산출물·후속 조율·다중 세션이 필요 없는 bounded one-shot 질문/분석(→인라인), 리뷰만(→deep-review), 한 세션 사이즈 구현(→deep-work), 사소한 수정(→인라인).
- **애매하면 루프로 진행한다** — 이 게이트는 명백한 부적합만 잡는다. 명시적 호출 자체가 의도 신호다.

적합 판정이면 별도 출력 없이 §2-2로 계속한다.

부적합 판정이면 **명시적 사람 응답 1회**를 받는다: Claude Code는 AskUserQuestion, 다른 호스트는 동일 옵션의 대화 질문으로 수행한다. 근거를 인용한 추천 대안이 첫 옵션이고, "그래도 deep-loop" 옵션을 항상 포함한다. 어떤 옵션도 preselect하지 않고 자동 적용하지 않는다(§2-2.5와 동일 규율). 무응답이나 도구 실패 시 기본값 없이 중단한다.

대안 후보는 `detect-plugins`의 `present`로 발견만 하고, 질문을 만들기 전에 현재 호스트에서 그 qualified skill을 실제로 호출할 수 있는지 확인한다. 호출 불가한 sibling은 옵션에서 제외하고 인라인으로 대체한다. Grok Build에서는 `deep-review:*` 직접 호출을 추천하지 않는다.

확정 시: 대안 스킬이면 같은 대화에서 goal을 그대로 넘겨 정확히 1회 직접 호출하고(Claude는 `Skill({ skill, args })`, Codex는 qualified dollar invocation — `Read("DEEP_LOOP_ROOT/skills/deep-loop-workflow/references/adapters.md")`의 Invoke 관례), 인라인이면 그 자리에서 일반 작업으로 수행한다. 세 대안 경로(deep-work·deep-review·인라인)는 모두 **terminal branch**다 — 대안의 반환·실패·취소 어느 경우에도 §2-2(recipe-match)나 §2-5(init-run)로 진행하지 않는다. "그래도 deep-loop"만 §2-2로 계속한다.

이 route 확인은 실행 방식의 선택일 뿐이며, proposal-only 행동(push/PR/merge/publish/delete)의 별도·대상 특정 사람 승인을 대체하지 않는다. 이 절의 판단 기준은 §2-2.5와 같은 prose-only 규율이다(자동 테스트는 마커 존재만 고정한다).

### 2-2. Recipe + Protocol 결정

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" recipe-match --goal "<goal>" --project-root "<canonical_project_root>"
```

반환된 `recipe_id`와 `protocol`을 사용자에게 제안한다. 최종 확정은 사람이 한다(`recipe_override_auth=user-only`).

### 2-2.5. Hill-Climb Insights 환류 (읽기 전용, 무마찰)

과거 run들의 결정론 마이닝 결과를 조회한다 — **검증된** 최신 insights만 커널이 반환하며, 스킬은 파일을 직접 읽거나 파싱하지 않는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" insights latest --json --project-root "<canonical_project_root>"
```

- `null`이면 그냥 스킵한다 — 표시할 것이 없으므로 무마찰로 다음 단계로 진행한다.
- 결과가 있으면(candidates/aggregates 포함) 아래 §2-3의 리뷰 전략 질문 **설명**에 기존 문서화 기본값과 **나란히, 별도 옵션으로** 제안을 표시한다:
  - 각 제안에는 반드시 **인용 지표를 병기**한다(예: "max_review_rounds 7 — 근거: 직전 run implementation fix_cycles 평균 2.0").
  - 제안을 **preselect하지 않는다** — 어떤 옵션도 기본 선택 상태로 두지 않는다.
  - 무응답/엔터 경로로 제안이 채택되게 하지 않는다.
  - 어떤 값도 **자동 적용 ❌** — 확정은 항상 사람이다(`recipe_override_auth=user-only`, AskUserQuestion을 거치는 구조로 보장).
  - 반환 envelope.payload의 `suspicious_active` / `post_finish_mutated` 배열이 비어있지 않으면 제안·요약에 해당 run 목록을 ⚠️ 주의로 함께 표기한다 — 후보/제안 유무와 무관하게(라벨만 있는 경우에도 출력).
  - 이 표시 규칙은 prose-only 규율이다(자동 테스트 대상 아님) — 신뢰 원천은 커널의 `insights latest` 검증이지 스킬의 표시 방식이 아니다.

### 2-3. 리뷰 전략 확인

리뷰 전략을 결정한다(§7). 자세한 흐름은 `Read("DEEP_LOOP_ROOT/skills/deep-loop-workflow/references/review-strategy.md")`를 참조:

- **deep-review 감지 시**: durable reviewer enum `deep-review-loop`, flags `--contract --codex`, mode `cross-model`을 추천한다. 이 선택의 complete durable JSON은 다음과 같다:

```json
{
  "points": ["design", "plan", "implementation"],
  "reviewer": "deep-review-loop",
  "mode": "cross-model",
  "flags": ["--contract", "--codex"],
  "converge": true,
  "max_review_rounds": 5,
  "require_human_ack": true
}
```

  커널이 review dispatch 뒤 반환하는 descriptor만 qualified host invocation skill id `deep-review:deep-review-loop`를 사용한다. 이 qualified id를 durable JSON에 저장하지 않는다.
  Grok Build 호스트 새 run에는 durable reviewer `subagent-checker`를 추천한다 — `deep-review-loop`는 grok에서 Route D로만 닫힌다. Route E bridged checker는 `subagent-checker`만 소비한다.
- **미감지 시**: codex 2-way / 서브에이전트 checker / standalone 중 선택 → 사용자 확정

cooperative subagent를 선택하면 durable reviewer enum은 `subagent-checker`다. 그 경우 complete durable `review` JSON은 다음과 같다:
```json
{
  "points": ["design", "plan", "implementation"],
  "reviewer": "subagent-checker",
  "mode": "cross-model",
  "flags": [],
  "converge": true,
  "max_review_rounds": 5,
  "require_human_ack": true
}
```

### 2-4. Workstream 분해

큰 goal이면 N개 workstream(각각 하나의 PR)을 제안하고 사람 확인을 받는다("[이대로/조정/단일 PR로]"). 작은 작업이면 1 workstream 자동 결정.

### 2-4.5. 세션 model/effort 관측 (자동, 무프롬프트)

먼저 현재 실행 호스트를 **직접** 판정해 `<claude|codex|grok>`에 `claude`, `codex`, 또는 `grok`를 넣는다. 모델이 제품 이름(Claude Code / Codex / Grok Build)을 직접 assertion한다. 환경 변수 마커는 권위가 아니다. Claude Code와 Grok Build는 slash(`/deep-loop…`), Codex는 qualified dollar(`$deep-loop:…`)로 호출한다. 슬래시 호출이 Claude를 뜻하지 않는다. 이 runtime 값은 run 생성 후 변경하지 않는다.

respawn이 자식 세션을 부모와 같은 model/effort로 띄우도록, init 시 현재 세션 값을 호스트 컨텍스트에서 직접 관측한다(이 값이 durable "init seed" — 첫 handoff가 PreCompact/headless여도 fallback이 된다). Claude host가 제공하는 `CLAUDE_EFFORT`와 정확한 모델 ID는 셸에서 읽지 말고 로드된 세션 컨텍스트 값으로 사용한다. Codex도 현재 task의 모델과 effort를 같은 방식으로 사용한다. Grok Build는 effort를 seed하지 않는다 — 관측된 model만 넣고 effort key는 생략한다.

- 관측된 필드만 `model`/`effort` key로 넣어 한 줄 compact JSON을 만든다. 둘 다 관측하지 못하면 `{}`다. 정상 경로에선 아무것도 묻지 않는다(무프롬프트).

### 2-5. Run 생성 (`init-run`)

현재 runtime을 실제 `claude`, `codex`, 또는 `grok`로 치환하고 다음 완전한 명령 하나를 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" init-run --runtime <claude|codex|grok> --goal "<goal>" --protocol <protocol> --recipe <recipe_id> --review '<review_json_compact>' --session-profile '<session_profile_json_compact>' --project-root "<canonical_project_root>"
```

`--recipe`는 `recipe-match`가 반환한 recipe **id 문자열**(예: `robust-implementation`)이다 — JSON이 아님.
`<review_json_compact>` placeholder는 선택한 durable review object의 한 줄 compact JSON으로 치환한다. compact JSON 내부의 JSON double quotes(JSON 이중 따옴표)는 그대로 유지하고, 바깥 single quotes가 전체 JSON을 POSIX와 PowerShell 모두에서 하나의 argv 값으로 보존한다.
`<session_profile_json_compact>`도 §2-4.5의 한 줄 compact JSON으로 치환한다. 내부 JSON double quotes(JSON 이중 따옴표)는 그대로 두고 바깥 single quotes로 argv 하나를 만든다. `{}`도 유효하며, 관측된 값은 `autonomy.session_model`/`session_effort`로 seed된다.
init-run 반환의 `<run_id>`를 저장한다. 이 값은 descriptor/current run의 논리적(logical) loop run id이며 전체 run 수명 동안 불변(immutable)이다. 초기 lease는 init-run이 같은 ID와 generation 1로 만들지만 두 역할의 placeholder는 이후에도 구분한다: `<owner_run_id> = <run_id>`, `<generation> = 1`. 이후 모든 mutating CLI는 `--owner <owner_run_id> --generation <generation> --run-id <run_id>`를 사용하며 논리 ID를 owner 변수로 재사용하지 않는다.

### 2-5-1. Continuity 기본값

새 run은 `workstream-session`과 `spawn_style:'interactive'`로 시작한다. entry
skill은 launcher, tty, platform, 또는 handler probe에서 attended launch
approval을 추론하거나 발행하지 않는다. 열린 Workstream은 현재 owner
conversation에 남고, compact는 native `/compact`를 통해 같은 conversation
안에서 수행한다.

visible/desktop attended launch를 원하는 사람은 run 생성 뒤
`/deep-loop-status`의 human-only approval 진단을 명시적으로 요청해야 한다.
autonomous `/deep-loop-continue`와 `/deep-loop-handoff`는 그 승인 유무를
surface heuristic으로 소비하지 않고 kernel `next-action`만 따른다.

### 2-6. Workstream 생성

각 `workstream new` 호출 **직전**, 아래 절차로 worktree를 먼저 생성(eager)한 뒤 실제 path/branch를 기록한다.

**어떤 worktree 전환보다 먼저 두 값을 캡처한다.** `git rev-parse --path-format=absolute --git-common-dir`의 출력을 host path API로 parent directory에 정규화해 ORIG_ROOT로 보관한다(linked worktree의 `--show-toplevel`은 project root가 아니다). 별도로 `git rev-parse HEAD`의 출력을 BASE_REF로 보관한다. 셸 대입이나 command substitution은 사용하지 않는다.

#### Step 0 — 기존 격리 감지 및 재사용 결정

현재 세션이 이미 linked worktree 안인지 확인한다(`git rev-parse --git-dir` ≠ `--git-common-dir`; submodule 가드: `--show-superproject-working-tree`가 경로를 반환하면 일반 repo로 취급).

**이미 격리 상태이면** 적격성을 먼저 검증한다:
- **(a) clean** — 무관한 미커밋 변경 없음
- **(b) base** — 의도한 base commit 기반
- **(c) 소유** — 이 run 전용 브랜치/경로

세 조건 충족 **+ 사용자 확인** 시에만 첫 workstream을 재사용(실제 path/branch 캡처 → Step 2). 캡처한 경로의 컨벤션 prefix를 rewrite하지 않는다(레거시 `.claude/worktrees/` 경로도 그대로 기록; 절대→루트-상대 정규화는 Step 2 규칙대로 유지). 부적격 또는 미확인이면 git 생성(Step 1b) 또는 human selection 중단.

**비격리 상태이면:**
- **`--runtime grok`이면 항상 Step 1b.** grok never Step 1a. never grok `--worktree` / `/fork --worktree` — Grok native worktree는 native-eligible이 아니다. 신규 생성·기록은 `.worktrees/<slug>`.
- **단일·다중 workstream run · 모든 runtime → 전부 git(Step 1b)**, 세션은 ORIG_ROOT 유지. native 생성은 기본값이 아니다.

#### Step 1a — native는 생성 기본값이 아님 (grok 포함 전 runtime)

신규 생성의 기본 절차는 Step 1b(git)다. Claude Code `EnterWorktree`는 `<root>/.claude/worktrees/<slug>`에 worktree를 만든다. 그 경로가 호스트 전용이므로 신규 생성에 쓰지 않는다. grok never Step 1a. never grok `--worktree` / `/fork --worktree`.

> 적용 범위: 생성 기본값이 아님. 진입은 continue §1.5. 레거시 native가 호출되는 경우의 containment만 남긴다.

**Containment(생성 전 보장이 유일 경로 — 레거시 native에만 적용):**
- ① native 호출 **전에** 그 도구가 `<canonical_project_root>/.claude/worktrees/` 밑에 worktree를 생성할 것이 **보장**되는지 확인한다. 보장 불가하면 **Step 1b(git)** 으로 전환. Claude `EnterWorktree`의 알려진 경로는 그 prefix이지만, 그것이 신규 생성의 기본값이라는 뜻은 아니다.
- ② 보장했는데도 native가 root 밖에 생성했다면 **즉시 fail-closed STOP(needs-human)** — 사후 audit 의존 ❌.

레거시 native가 만든 경로를 기록할 때는 캡처한 절대 경로를 canonical root 기준으로 잘라 루트-상대로 변환한 뒤 Step 2에서 `--worktree`로 기록한다. 컨벤션 prefix 자체는 rewrite하지 않는다.

#### Step 1b — git (모든 비격리 신규 생성)

순서가 중요하다. 안전 검증을 먼저 수행한 **뒤에만** 생성 명령을 실행한다.

① **`git check-ignore` 검증(proposal-only, 생성 전 필수):** canonical root에 앵커한다. cwd-relative ignore 검사는 금지한다.
```bash
git -C "<canonical_project_root>" check-ignore -q -- .worktrees/
```
gitignore되어 있으면 통과. **ignore 안 됐으면 `.gitignore`를 자동 편집·커밋하지 않는다** — 사람에게 `.worktrees/` 한 줄 추가를 **제안(proposal-only)**하고 **승인 시에만** 진행, 미승인이면 fail-closed 중단. 이 플러그인 리포는 `.worktrees/`가 gitignore되어 무수정 통과한다. 소비자 리포는 여전히 proposal-only다.

② **검증 통과 후** canonical root-앵커 절대경로 + 명시 base로 생성한다:
```bash
git worktree add -b "worktree-<ws-slug>" "<canonical_project_root>/.worktrees/<ws-slug>" "<base_ref>"
```
다중 run에서 git을 사용하는 이유: cwd를 이동시키지 않아 ORIG_ROOT에 머문 채 N개를 생성할 수 있다(native cwd 이동/중첩 회피).

생성 후 **실제** path + branch를 캡처 → Step 2. **기록 시 루트-상대 변환 필수:** canonical root 접두를 제거해 `.worktrees/<slug>` 형태로 `--worktree`를 지정한다(절대 경로 기록 금지 — artifact prefix가 절대 경로가 되면 `episode.mjs` containment 실패).

#### §0.5 원본 root·base 캡처 + cwd 분리 + artifact 경로 규칙

- **ORIG_ROOT/BASE_REF 캡처(sibling git 경로 구성용):** 어떤 worktree 전환보다 먼저 ORIG_ROOT(main repo root — git-common-dir 출력의 parent를 host path API로 파생)와 BASE_REF(의도한 base commit)를 캡처한다. 이 값이 sibling git 폴백의 절대경로·명시 base 인자가 된다.
- **cwd 분리:** maker/checker 파일 편집은 해당 worktree 안에서(분리) 수행한다. 커널 상태 호출은 descriptor-bound `--project-root "<canonical_project_root>" --run-id <run_id>`를 계속 사용한다.
- **artifact 경로는 ORIG_ROOT-상대로 기록:** episode artifact를 `.worktrees/<slug>/…` 형태(ORIG_ROOT 기준 상대)로 기록해야 `episode.mjs` containment(절대경로·`..` 금지)를 통과한다. worktree가 root 밑에 있어야 이 경로가 성립한다.
- **worktree 기록 경로 규율(FIX A/FIX N):** git worktree **생성**은 `<canonical_project_root>/.worktrees/<slug>` 절대경로로 하되(git은 절대경로 필요), `workstream new`에 **기록**하는 worktree 값은 반드시 루트-상대(root-relative) 형태 `.worktrees/<slug>`여야 한다. Step 0 재사용으로 캡처한 레거시 경로는 prefix를 변환하지 않고 그대로 기록한다. 이유: artifact 경로는 `<recorded-worktree>/<artifact>`로 도출되는데, 기록된 worktree가 절대 경로이면 artifact prefix도 절대 경로가 되어 `episode.mjs` containment(`절대경로·.. 금지`)를 통과하지 못한다. 커널은 `.claude/worktrees/<slug>` 기록도 받는다.

#### Step 1.5 — create↔record 정합 (고아 방지)

**(a) 생성 직전 lease check 사전점검(read-only, explicit root/run):**

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" lease check --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

`ok:false`이면 생성하지 않고 fail-closed. (lease 유효성은 `lease check`로만 읽는다 — `state get`으로 lease 필드를 직접 읽으면 올바른 경로가 아니어서 동작하지 않는다.)

**(b) 멱등 재시도:** 대상 경로/브랜치가 이미 존재하면(이전 실패 잔재) Step 0 적격성 검증을 재적용해 재사용/감지한다.

**(c) record 실패 시 proposal-only 정리:** `workstream new` 실패 시 "worktree `<path>` 고아(orphan) — 정리(`ExitWorktree`/`git worktree remove`) 제안"을 surface(proposal-only, 자동 삭제 ❌).

**(d) reconcile audit(unattended 보강):** respawn/finish 시 `<canonical_project_root>/.worktrees/`(및 레거시 `.claude/worktrees/`) 밑의 실제 디렉터리 중 active workstream에 매핑되지 않는 것을 고아 후보로 surface(proposal-only 정리 제안). 기록에 없는 외래 디렉터리도 후보만이며 자동 삭제하지 않는다. root-밖 native 고아는 Step 1a①②가 처음부터 안 만드므로 audit 대상 아님. **매핑 여부와 무관하게** 각 worktree의 `package.json`이 존재하나 JSON parse 불가면 해당 worktree를 정리 대상 후보로 surface하고 정리를 **제안**한다(proposal-only — 서드파티 preload 환경에서 모든 node hook 기동을 죽이는 E1-클래스 크래시 신호).

**(e) 잔여 TOCTOU:** `lease check`와 `workstream new`의 `requireLease` 사이에 좁은 TOCTOU가 남는다. 고아는 gitignored `.worktrees/`(및 레거시 `.claude/worktrees/`) 밑이므로 repo를 오염시키지 않으며 (d) audit으로 발견된다.

**(f) 커널 2-phase는 명시적 후속:** 고아 원천 차단은 커널 2-phase 예약이 필요(v1 비-스코프 — 스코프 상향 시 TDD 동반).

#### Step 2 — 기록

캡처한 실제 값으로 기록한다. descriptor-bound root/run과 lease fence를 모두 명시한다.

**`--worktree`는 반드시 루트-상대(root-relative) 경로**로 기록한다 — git이 `<canonical_project_root>/.worktrees/<slug>` 절대경로로 생성하더라도 기록 값은 `.worktrees/<slug>` 형태다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" workstream new --title "<workstream title>" --branch "<actual-branch>" --worktree ".worktrees/<ws-slug>" --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>
```

의존 관계가 있으면 다음 완전한 명령을 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" workstream new --title "<workstream title>" --branch "<actual-branch>" --worktree ".worktrees/<ws-slug>" --depends-on '["ws-id-1"]' --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>
```

#### 결정표

| 상황 | 동작 |
|------|------|
| 단일 run · 이미 격리 · 적격(clean·base·소유)+사용자 확인 | 현재 worktree 재사용 (컨벤션 prefix를 rewrite하지 않는다) |
| 단일 run · 이미 격리 · 부적격/미확인 | 재사용 ❌ → git(Step 1b) 또는 human 중단 |
| 단일 run · 비격리 · 모든 runtime | git(Step 1b) `.worktrees/<slug>` |
| `--runtime grok` · 모든 ws | 항상 git(Step 1b). grok never Step 1a. never grok `--worktree` |
| 다중 run · 모든 ws | 전부 git(Step 1b): 생성 `<canonical_project_root>/.worktrees/<slug>` — 기록 `.worktrees/<slug>` (루트-상대, native 미사용) |
| gitignore 미설정 | proposal-only 제안 — 승인 시에만 진행, 자동 커밋 ❌ |
| native가 root 밖에 생성 | fail-closed STOP(needs-human) |

### 2-7. 첫 번째 Episode 생성

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" episode new --plugin <maker_plugin> --role maker --kind implementation --point design --workstream <workstream_id> --artifacts '[".worktrees/<ws-slug>/expected-output.md"]' --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>
```

`--artifacts`는 필수다 — maker `done` 전이는 비어있지 않은 `expected_artifacts`와 실제 파일 존재를 요구한다.
Artifact 상세 교정 규칙은 `deep-loop-workflow`의 `## 핵심 불변식`을 따른다.

## 단계 3: 완료 메시지

run_id와 workstream 요약을 출력하고 다음 명령을 안내한다:

이후 각 tick마다 Claude Code는 `/deep-loop-continue`, Codex는 `$deep-loop:deep-loop-continue`, Grok Build는 `/deep-loop-continue`를 호출해 루프를 진행한다.
