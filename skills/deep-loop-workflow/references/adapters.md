# 어댑터(Adapter) 4-verb 수행 절차

## 실행 루트

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

프로토콜 어댑터(adapter)는 4-verb로 maker dispatch부터 checker 호출까지 전 과정을 정의한다.
**Execution LLM이** 직접 수행하며, 커널은 verb를 실행하지 않는다(§1.1 — 커널은 디스크립터를 반환하고 dispatch는 Execution LLM이 수행).

## Lease identity

호출자가 넘긴 `<run_id>`는 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. fenced checker/maker mutation 직전에 다음 read-only 명령으로 current lease를 새로 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`에서 얻는다. 모든 checker command는 current fence에는 owner/generation을, descriptor identity에는 불변 `<run_id>`를 전달한다.

## 1. dispatch — Maker 스킬 Invoke

### 디스크립터 획득

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" adapter resolve --protocol <protocol> --task "<brief>" --tier <gate.tier_after> --project-root "<canonical_project_root>" --run-id <run_id>
```

`--tier`는 **반드시** `next-action`의 `gate.tier_after` 값을 전달해야 한다. 빠지면 guard가 `no-tier` no-op라 read-only run이 implementer를 dispatch할 수 있다.

반환 형태 (예시):
```
{
  dispatch.kind = "skill",
  dispatch.skill = "deep-work:deep-work-orchestrator",
  dispatch.then = "superpowers:subagent-driven-development",
  await.kind = "poll_file",
  await.path = ".deep-work/<task>/session-receipt.json",
  read.path = ".deep-work/<task>/session-receipt.json",
  checker_via = "review dispatch CLI (kernel derives checker episode)",
  guard.ok = true
}
```

### Guard 확인

- `guard.ok === false`이면 **dispatch 중단** → `await_human`(tier × protocol 모순) 보고.
- `guard.ok === true`이면 진행.

### Invoke (runtime별)

- `dispatch.kind === 'skill'`이면 descriptor의 qualified skill id와 args를 그대로 사용한다.
  - Claude: `Skill({ skill: descriptor.skill, args: descriptor.args })`
  - Codex: `$<descriptor.skill>` 뒤에 `descriptor.args`를 전달한다(qualified dollar invocation).
- **read-only tier**: `guard.planning_only === true`이면 `dispatch.skill`(planning)만 실행하고, `dispatch.then`(implementer)은 null이라 건너뛴다.
- `kind === 'inline'`이면 직접 도구 사용.

## 2. awaitResult — 완료 폴링

디스크립터의 `await.kind`가 `poll_file`이면 해당 경로를 `done_when` 조건 만족까지 폴링(LLM/드라이버 수행).

deep-work 예시: `.deep-work/<task>/session-receipt.json`의 `current_phase=idle`.

## 3. checker — Review Dispatch/Record

### 상호 배타 checker routing preflight

아래 Route A–E는 **상호 배타(mutually exclusive)**다. `review dispatch` 전에 현재 runtime, attended/unattended 상태, configured reviewer kind, 실제 host capability를 확인해 정확히 하나만 선택한다. Codex CLI가 존재한다는 사실만으로 cooperative subagent capability나 자동 Codex App task 생성을 추론하지 않는다.

### Route A — cooperative fresh subagent

현재 host의 cooperative fresh-subagent 기능이 **실제로 사용 가능**하다고 host capability로 assertion한 경우에만 이 route를 선택하고 `review dispatch`에 `--independent-subagent`를 전달한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review dispatch --point <review_point> --workstream <workstream_id> --independent-subagent --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

`--independent-subagent` flag는 cooperative capability가 실제로 있을 때만 전달한다. 없으면 이 flag를 전달하지 않는다. 반환 descriptor가 `checker.kind === 'agent'`이고 `agent_role === 'code-reviewer'`인지 확인한다. 그 뒤 fresh `code-reviewer`를 host tool(호스트 도구)로 실제 spawn한다. 같은 execution task의 inline 리뷰로 대체하지 않는다. fresh reviewer가 리뷰 대상 worktree 아래에 실제 report를 작성해 반환한 경우에만 아래 Verdict 기록으로 간다.

### Route B — Codex unattended measured host

Codex runtime의 unattended run이고 measured host-owned driver가 실행을 소유한 경우다. execution skill은 다음 명령으로 checker를 정확히 한 번 dispatch한 뒤 즉시 host에 yield한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review dispatch --point <review_point> --workstream <workstream_id> --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

host-owned measured driver가 claim 후 isolated read-only 두 번째 `codex exec`를 spawn하고, 최종 bytes를 import한 뒤 accounting까지 수행한다: **claim → spawn → import → accounting**. execution skill은 이 route에서 `review record`를 호출하지 않는다(never). 같은 task의 `$<checker.skill>` 실행이나 caller가 만든 verdict는 proof가 아니다.

### Route C — interactive independent skill session

interactive Claude/Codex에서 `checker.kind === 'skill'`이고, 리뷰 대상 worktree(reviewed worktree)를 root로 쓰는 **독립 별도 distinct fresh session 또는 fresh task**가 실제로 준비된 경우다. 준비 가능성을 먼저 확인한 뒤 다음 명령으로 dispatch한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review dispatch --point <review_point> --workstream <workstream_id> --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

반환 descriptor의 `requires_independent_session === true`를 확인한다. 그 별도 task에서 Claude는 `Skill({ skill: checker.skill, args: checker.args })`, Codex는 `$<checker.skill>`에 `checker.args`를 전달한다. Codex automatic new task는 지원하지 않으므로 사람이 manual(수동) task 생성을 완료하고 descriptor를 넘긴 경우에만 진행한다. 같은 task의 `$<checker.skill>` 실행은 독립 proof가 아니며 금지한다.

fresh checker는 reviewed worktree 아래의 contained report만 반환한다. 원래 execution session(original execution session)은 report의 존재와 worktree containment를 확인한 뒤에만 아래 Verdict 기록을 수행한다.

### Route E — bridged independent process (grok attended owner)

Grok attended owner 전용. `review bridge-probe --json`이 `ready: true`이고 Route E 전제(E-0–E-7)가 전부 충족될 때만 선택한다. 상세는 `Read("DEEP_LOOP_ROOT/skills/deep-loop-workflow/references/checker-bridge.md")`.

격리는 **별도 프로세스**다: `dispatch_agent.py`가 read-only `claude -p` / `codex exec` 자식을 감독한다. 자식이 checker이며 report 본문을 쓴다(stdout). 이 대화의 inline 리뷰, `deep-review:*` Skill, `spawn_subagent` checker는 금지다. native Grok subagent isolation은 unverified이므로 Route A가 아니다. 이 경로에서 kernel descriptor의 `kind: 'agent'` / `agent_role`은 무시한다 — 호스트 서브에이전트를 spawn하지 않는다.

`review dispatch`는 probe와 전제 확인 **이후**에 실행한다. live 실패는 `review record` 없이 `needs-human`이며 pending checker를 남긴다. owner는 `bridge-finalize.mjs`로 graded stdout을 worktree 아래 byte-identical 사본으로만 물질화한다.

### Route D — no independent path

독립 경로가 없으면 `needs-human`으로 보고하고 `review dispatch`를 실행하지 않으며, `review record`도 실행하지 않고 proof를 만들지 않는다(fabricated proof 금지). 특히 configured reviewer가 `checker.kind === 'agent'`인데 cooperative capability가 실제로 없고 **Route E 전제도 불충족이면** 이 flag를 전달하지 않고 반드시 그 전에 Route D로 중단하며, `review dispatch`를 호출하지 않아 pending checker를 만들지 않는다. `checker.kind === 'blocked'`가 사전에 확정되면 `needs-human`으로 보고하고 proof를 만들지 않는다.

Grok 호스트에서 Route E 전제가 하나라도 실패하면 Route D다. 이 대화에서 `deep-review:*`, `spawn_subagent` checker를 호출하지 않는다. 사람 또는 Claude/Codex 세션이 현행 review argv를 실행한다(`--runtime` 없음). `review record` / `review import`에도 `--runtime`을 추가하지 않는다.

### Verdict 기록

Route A, Route C, 또는 Route E에서 실제 contained report가 원래 execution session으로 돌아온 경우에만 이 단계를 수행한다. Route B는 host import가 소유하고 Route D는 proof가 없으므로 이 명령을 실행하지 않는다.

APPROVE/CONCERN(통과)은 실재하는 리뷰 리포트 파일을 `--report`로 첨부해야 한다 — **리뷰 대상 workstream의 기록된 worktree(`<recorded-worktree>/…`, 신규 기본 `.worktrees/<slug>`) 하위 경로**여야 하며(무관한 root 파일 재사용 차단), 없거나 밖이면 `REVIEW_NO_EVIDENCE`. 커널이 checker episode에서 workstream/point/target maker/source를 파생하고 리포트 경로+content hash를 event-log에 남기므로 caller는 해당 메타데이터 flag를 전달하지 않는다. REQUEST_CHANGES도 fresh checker가 반환한 실제 verdict여야 한다:
```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review record --episode <checkerEpisodeId> --verdict <APPROVE|REQUEST_CHANGES|CONCERN> --report "<review-report-path>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

커널이 verdict에서 터미널 상태·breaker·comprehension을 자동으로 파생한다.

## 4. readArtifacts — 산출물 Receipt 확인

`read.path`(path_template이 `<task>`로 채워진)와 `read.producer`로 receipt를 확인한다.
불일치 시 throw 금지 → `null` 반환 + 경고 출력.

## Expected Artifacts 도출

`episode new`의 `--artifacts` 인자에 전달할 expected 경로는:
- `adapter resolve`의 `read.path`(receipt 경로)
- 또는 protocol의 계획된 산출물 경로

항상 비어있지 않은 배열이어야 한다 — maker `done` 전이는 expected_artifacts 존재와 실제 파일을 요구한다.
