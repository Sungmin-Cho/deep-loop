# 리뷰 전략 (Review Strategy)

## 실행 루트

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 이후 argv 템플릿에 `DEEP_LOOP_ROOT`가 나타나면 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

run 시작 시 `/deep-loop`가 리뷰 전략을 확인하는 흐름과 `review` JSON 조립 방법을 정의한다.

## 확인 질문 흐름 (§7)

### deep-review 플러그인 감지 시

기본 추천:
- durable reviewer enum: `deep-review-loop`
- mode: `cross-model`
- flags: `["--contract", "--codex"]`

deep-review 선택의 durable review JSON에는 다음 accepted enum을 저장한다:

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

커널이 나중에 반환하는 descriptor만 host invocation skill id `deep-review:deep-review-loop`를 사용한다. 이 qualified id를 durable JSON에 저장하지 않는다.

사용자 확인 후 `converge`와 `max_review_rounds`를 조정할 수 있다.

### deep-review 미감지 시

3가지 옵션 제안:
1. **codex 2-way**: Codex가 구현하고 Claude가 리뷰 (또는 반대)
2. **서브에이전트 checker**: 동일 모델의 독립 서브에이전트
3. **standalone**: 리뷰 없이 진행 (권장하지 않음 — proof 요건 충족 불가)

사용자가 확정한다.

cooperative subagent 선택의 durable review JSON에는 `"reviewer": "subagent-checker"`를 저장한다. descriptor가 반환된 뒤에만 실제 host tool로 fresh subagent를 만든다.

## 독립 checker 실행 가능성 확인

reviewer 선택은 `references/adapters.md`의 상호 배타 Route A–D 중 하나와 실제로 결합되어야 한다.

- configured reviewer가 agent/subagent이면 cooperative fresh-subagent host tool이 실제로 사용 가능한지 확인한다. 없으면 — 그리고 grok에서 Route E 전제도 불충족이면 — `review dispatch` 전에 `needs-human`으로 중단한다. Codex CLI 설치만으로 capability를 추정하지 않는다.
- Codex unattended measured run은 host-owned Route B를 사용한다. execution skill은 checker를 한 번 dispatch하고 yield하며, measured host가 isolated read-only 두 번째 Codex checker의 claim/spawn/import/accounting을 소유한다.
- interactive independent skill reviewer는 Route C를 사용한다. Claude/Codex 모두 reviewed worktree를 root로 하는 별도 fresh session/task가 필요하다. Codex automatic task 생성은 지원하지 않으므로 사람이 수동으로 새 task를 만든다고 확인한 경우에만 dispatch한다.
- Grok attended owner는 Route E 전제(`review bridge-probe` `ready: true` + E-0–E-7)가 충족되면 bridged independent process를 사용한다. 이 대화에서 `deep-review:*`와 `spawn_subagent` checker는 호출하지 않는다. 전제가 실패하면 Route D다. 사람 또는 Claude/Codex 세션이 현행 argv(`--runtime` 없음)로 review를 실행할 수 있다. Grok 호스트 새 run에는 reviewer `subagent-checker`를 추천한다(`deep-review-loop`는 grok에서 Route D로만 닫힌다).
- 위 경로가 하나도 없으면 Route D다. dispatch/record/fabricated proof 없이 `needs-human`으로 보고한다. `standalone`은 proof 없는 completed 전이를 허용한다는 뜻이 아니다.

## `review` JSON 형태

아래는 cooperative subagent를 선택한 경우의 complete durable JSON이다:

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

### 필드 설명

- **points**: 리뷰할 단계 목록. 빠른 작업이면 `["implementation"]`으로 축소 가능.
- **reviewer**: durable enum. deep-review 선택은 `deep-review-loop`, cooperative subagent 선택은 `subagent-checker`다. qualified invocation id는 저장하지 않는다.
- **mode**: `cross-model`(다른 모델) 또는 `same-model`.
- **flags**: reviewer 스킬에 전달할 추가 플래그.
- **converge**: `true`이면 APPROVE가 나올 때까지 반복(max_review_rounds 한도 내).
- **max_review_rounds**: breaker trip 전 최대 리뷰 라운드 수 (기본 5).
- **require_human_ack**: 정직 신호로 `true` default. 실질 강제는 human/agent 카운터 분리다 — 어떤 설정에서도 기계 리뷰는 comprehension 게이트(사람 검토)를 해제하지 못한다.

## 중요 사항

- 리뷰 없이 completed 전이 불가 — `finishProofState`가 독립 리뷰 proof를 요구한다.
- checker 없이 maker `done`만으로는 workstream을 `ready`로 전이할 수 없다.
- **machine review(checker APPROVE)는 agent 카운터(`episodes_agent_reviewed`)로만 계상되어 comprehension debt를 줄이지 않는다.** comprehension 게이트(사람 검토)는 `/deep-loop-ack --actor human --confirm`만 해제한다.
