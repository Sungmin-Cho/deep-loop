import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  captureReconciledRunSet,
  captureReconciledRunSnapshot,
} from './state.mjs';
import {
  captureVerifiedRunSet,
  verifyLines,
  verifyHeadLines,
  appendAnchored,
  MUTATION_TURN_FLOOR,
} from './integrity.mjs';
import { contentHash, wrap, unwrap, ulid, atomicWrite, renameAtomicWithRetry } from './envelope.mjs';
import { leaseCheck } from './lease.mjs';
import { isTerminalGoalOwnerCostEvent } from './budget.mjs';
import { captureStableFileIdentity, matchingStableFileIdentity } from './fs-safe.mjs';

export const INSIGHTS_SCHEMA_VERSION = 1;

// 스펙 §5 — 임계값 고정 상수 (v1 설정화 ❌)
export const CANDIDATE_RULES = {
  FIX_CYCLES_HIGH: 1.0,        // (ws,point)당 평균 fix_cycles ≥
  PAUSE_FREQUENCY: 2,          // run-paused ≥
  CROSS_RUN_MIN: 3,            // cross-run 후보 최소 run 수
};

export function computeRunMetrics(loop, events) {
  const eps = loop.episodes || [];
  const byId = new Map(eps.map(e => [e.id, e]));
  // 버킷 키(point/kind/for/run_id)는 episode new가 임의 문자열을 허용하는 user-supplied 값 —
  // plain {}에 '__proto__' 키를 넣으면 Object.prototype 오염/집계 유실이 나므로 모든 버킷은 null-prototype.
  const count = (arr, key) => arr.reduce((a, e) => ((a[e[key]] = (a[e[key]] || 0) + 1), a), Object.create(null));
  const terminal = { done: 0, approved: 0, rejected: 0, abandoned: 0 };
  for (const e of eps) if (terminal[e.status] !== undefined) terminal[e.status]++;
  // abandoned는 loop.episodes 상태에도 남지만 소스 규약(§4)은 episode-abandon 이벤트 — 이벤트 기준으로 덮어쓴다.
  terminal.abandoned = events.filter(e => e.type === 'episode-abandon').length;

  const per_point = Object.create(null); const fix_cycles = Object.create(null);
  for (const ev of events.filter(e => e.type === 'review-outcome')) {
    const ep = byId.get(ev.data.episodeId) || {};
    const point = ep.point || 'unknown';
    const p = (per_point[point] ||= { checker_count: 0, approve: 0, request_changes: 0, concern: 0 });
    p.checker_count++;
    // 분모 시드: 리뷰된 (ws,point) 쌍은 verdict와 무관하게 0부터 존재해야 한다 — RC-only 분모는
    // 평균을 항상 ≥1로 퇴화시켜 임계 1.0(스펙 §5)이 무의미해진다 (impl-R3 🟡A).
    const k = `${ep.workstream_id || 'unknown'}|${point}`;
    fix_cycles[k] ||= 0;
    if (ev.data.verdict === 'APPROVE') p.approve++;
    else if (ev.data.verdict === 'REQUEST_CHANGES') {
      p.request_changes++;
      fix_cycles[k] += 1;
    } else if (ev.data.verdict === 'CONCERN') p.concern++;
  }

  const costs = events.filter(e => e.type === 'cost');
  const cost = {
    turns: costs.reduce((a, e) => a + (e.data.turns || 0), 0),
    tokens: costs.reduce((a, e) => a + (e.data.tokens || 0), 0),
    auto_floor_turns: costs.filter(e => e.data.auto_floor).reduce((a, e) => a + e.data.turns, 0),
    auto_floor_by_for: costs.filter(e => e.data.auto_floor && e.data.for)
      .reduce((a, e) => ((a[e.data.for] = (a[e.data.for] || 0) + e.data.turns), a), Object.create(null)),
  };

  const acks = events.filter(e => e.type === 'comprehension-ack');
  const firstDispatch = events.find(e => e.type === 'episode-record' && e.data.status === 'in_progress');
  const firstHumanAck = acks.find(e => e.data.actor === 'human');
  const hasMaker = eps.some(e => e.role === 'maker');
  const ack_before_first_dispatch = !hasMaker ? null
    : Boolean(firstHumanAck && (!firstDispatch || firstHumanAck.seq < firstDispatch.seq));

  const pausedEvents = events.filter(e => e.type === 'run-paused');
  const last = events[events.length - 1];
  const budget = loop.budget || null;
  return {
    run_id: loop.run_id, goal: loop.goal, recipe: loop.recipe?.id ?? null,
    protocol: loop.routing?.protocol ?? null, status: loop.status,
    created_at: loop.created_at ?? null,
    last_event_at: last ? last.ts : null,
    last_seq: last ? last.seq : 0,
    wallclock_sec: (last && loop.created_at) ? Math.round((Date.parse(last.ts) - Date.parse(loop.created_at)) / 1000) : 0,
    episodes: { total: eps.length, by_role: count(eps, 'role'), by_kind: count(eps, 'kind'), by_point: count(eps, 'point'), terminal },
    review: { per_point, fix_cycles },
    // §5 budget_overrun 경계 산정용 — loop.budget이 없으면(콜드스타트/구버전 fixture) null.
    budget_ratio: loop.budget && loop.budget.total > 0 ? (loop.budget.spent / loop.budget.total) : null,
    soft_stop_ratio: budget ? budget.soft_stop_ratio : null,
    // Honest semantics: only the END-OF-RUN latch is observable — the kernel emits no breaker trip/reset
    // events (trips latch inline in review-outcome's mutate; resetBreaker writes state without an event),
    // so mid-run trip→reset history is NOT reconstructable. 0/1, not a lifetime count.
    breaker: { trips: loop.circuit_breaker?.tripped ? 1 : 0,
      trip_reason: loop.circuit_breaker?.trip_reason ?? null,
      max_consecutive_rc: loop.circuit_breaker?.consecutive_request_changes ?? 0 },
    cost,
    sessions: { count: (loop.session_chain?.sessions || []).length,
      handoffs: events.filter(e => e.type === 'handoff-emitted').length,
      handoff_reasons: events.filter(e => e.type === 'handoff-emitted').map(e => e.data.reason ?? null),
      respawn: { spawned: events.filter(e => e.type === 'respawn-spawned').length,
        failed: events.filter(e => e.type === 'respawn-failed').length,
        timeout: events.filter(e => e.type === 'respawn-timeout').length } },
    pauses: { count: pausedEvents.length, reasons: pausedEvents.map(e => e.data.reason ?? null),
      recovered: events.filter(e => e.type === 'run-recovered').length },
    comprehension: { ack_human: acks.filter(e => e.data.actor === 'human').length,
      ack_agent: acks.filter(e => e.data.actor === 'agent').length,
      ack_rejected: events.filter(e => e.type === 'comprehension-ack-rejected').length,
      ack_before_first_dispatch },
  };
}

// review.fix_cycles 키는 computeRunMetrics에서 `${workstream_id}|${point}` 형태로 만든다 (§5 fix_cycles 정의).
// point는 첫 '|' 뒤 나머지 전부 — workstream_id 자체가 '|'를 포함할 일은 없다는 가정 하에 안전하다.
function pointOf(key) {
  const idx = key.indexOf('|');
  return idx === -1 ? key : key.slice(idx + 1);
}

// point별로 (ws,point) raw fix_cycles 항목을 모든 run에 걸쳐 pool한다 — fix_cycles_high(§5)와
// aggregates.avg_fix_cycles_by_point가 공유하는 집계.
function fixCyclesPointStats(perRunMap, runIds) {
  const stats = Object.create(null);
  for (const runId of runIds) {
    const m = perRunMap[runId];
    for (const [key, val] of Object.entries(m.review?.fix_cycles || {})) {
      const point = pointOf(key);
      const e = (stats[point] ||= { sum: 0, n: 0, recipes: [] });
      e.sum += val; e.n += 1;
      if (m.recipe && !e.recipes.includes(m.recipe)) e.recipes.push(m.recipe);
    }
  }
  return stats;
}

// run 하나 안에서 point별 평균 fix_cycles (같은 point에 여러 workstream이 걸쳐있을 수 있음) —
// fix_convergence_slow(§5)의 cross-run 시계열 한 점을 만드는 데 쓰인다.
function perRunPointAverages(fixCycles) {
  const acc = Object.create(null);
  for (const [key, val] of Object.entries(fixCycles || {})) {
    const point = pointOf(key);
    const e = (acc[point] ||= { sum: 0, n: 0 });
    e.sum += val; e.n += 1;
  }
  const out = Object.create(null);
  for (const [point, { sum, n }] of Object.entries(acc)) out[point] = sum / n;
  return out;
}

const recipeHints = (recipes) => (recipes || []).map(r => `recipes/${r}.json`);

// cross-run 집계 — aggregates.avg_fix_cycles_by_point 전용 (deriveCandidates와 동일 pooling 규약 재사용).
export function avgFixCyclesByPoint(perRunMap) {
  const runIds = Object.keys(perRunMap).sort();
  const stats = fixCyclesPointStats(perRunMap, runIds);
  const out = Object.create(null);
  for (const [point, { sum, n }] of Object.entries(stats)) out[point] = sum / n;
  return out;
}

// 스펙 §5 규칙표를 코드로 옮긴 순수 함수 — I/O 없음. cross-run 시간순은 반드시
// `Object.keys(perRunMap).sort()`(run_id ULID = 생성 시각순)로 고정한다 — 삽입순 의존 금지.
export function deriveCandidates(perRunMap, { integrityFailed = [] } = {}) {
  const runIds = Object.keys(perRunMap).sort();
  const candidates = [];

  // fix_cycles_high:<point> — 해당 point의 (ws,point)당 평균 fix_cycles ≥ 임계치(모든 run pool).
  const pointStats = fixCyclesPointStats(perRunMap, runIds);
  for (const [point, { sum, n, recipes }] of Object.entries(pointStats)) {
    const avg = sum / n;
    if (avg >= CANDIDATE_RULES.FIX_CYCLES_HIGH) {
      candidates.push({
        id: `fix_cycles_high:${point}`, metric: 'fix_cycles_avg', value: avg,
        threshold: CANDIDATE_RULES.FIX_CYCLES_HIGH, min_runs: 1, scope: 'run',
        target_hints: recipeHints(recipes), target_tier: 1,
        note: `point '${point}' 평균 fix_cycles ${avg.toFixed(2)} — T1: recipe 힌트 반영, ` +
          `T2: point 지침·review-strategy.md(human-proposal) + init 환류(max_review_rounds) 검토`,
      });
    }
  }

  // breaker_trip — tripped ≥ 1 (§4 note: 0/1 end-of-run latch, 생애주기 카운트 아님).
  {
    let sum = 0; const recipes = [];
    for (const runId of runIds) {
      const m = perRunMap[runId];
      const t = m.breaker?.trips || 0;
      sum += t;
      if (t >= 1 && m.recipe && !recipes.includes(m.recipe)) recipes.push(m.recipe);
    }
    if (sum >= 1) {
      candidates.push({
        id: 'breaker_trip', metric: 'breaker_trips_count', value: sum,
        threshold: 1, min_runs: 1, scope: 'run', target_hints: recipeHints(recipes), target_tier: 1,
        note: 'circuit breaker trip 발생 — T1: trip 사유 연관 recipe, T2: 제어 스킬 안내(human-proposal)',
      });
    }
  }

  // respawn_failure — respawn-failed + respawn-timeout ≥ 1.
  {
    let sum = 0;
    for (const runId of runIds) {
      const r = perRunMap[runId].sessions?.respawn || {};
      sum += (r.failed || 0) + (r.timeout || 0);
    }
    if (sum >= 1) {
      candidates.push({
        id: 'respawn_failure', metric: 'respawn_failures_count', value: sum,
        threshold: 1, min_runs: 1, scope: 'run', target_hints: [], target_tier: 2,
        note: 'respawn 실패/타임아웃 발생 — respawn/handoff 지침(T2, human-proposal)',
      });
    }
  }

  // bootstrap_ack_friction — ack_before_first_dispatch === true (maker episode ≥ 1인 run에서만 정의된 값이므로
  // null/false는 자연히 걸러진다).
  {
    let count = 0;
    for (const runId of runIds) if (perRunMap[runId].comprehension?.ack_before_first_dispatch === true) count++;
    if (count >= 1) {
      candidates.push({
        id: 'bootstrap_ack_friction', metric: 'ack_before_first_dispatch_count', value: count,
        threshold: 1, min_runs: 1, scope: 'run', target_hints: [], target_tier: 2,
        note: 'ack가 첫 dispatch보다 선행 — init·continue 부트스트랩 안내(T2), init 환류(debt_threshold)',
      });
    }
  }

  // budget_overrun — 소진율(budget_ratio) ≥ soft_stop_ratio. run마다 자기 자신의 soft_stop_ratio가 임계치이므로
  // 가장 크게 초과한 run을 대표값으로 보고한다.
  {
    let best = null;
    for (const runId of runIds) {
      const m = perRunMap[runId];
      const ratio = m.budget_ratio, soft = m.soft_stop_ratio;
      if (ratio == null || soft == null) continue;
      if (ratio >= soft && (!best || ratio > best.ratio)) best = { ratio, soft, recipe: m.recipe };
    }
    if (best) {
      candidates.push({
        id: 'budget_overrun', metric: 'budget_ratio', value: best.ratio,
        threshold: best.soft, min_runs: 1, scope: 'run', target_hints: recipeHints([best.recipe].filter(Boolean)),
        target_tier: 1, note: '예산 소진율이 soft_stop_ratio 이상 — T1: recipe 힌트, T2: init 환류(budget) 검토',
      });
    }
  }

  // §5: min_runs=1의 per-run 규칙 — "run-paused ≥ 2"는 단일 run 내 빈도(max-of-run)다. threshold 1인
  // sibling 규칙들(breaker_trip 등)은 sum≡max라 패턴 근거가 없다. fleet-sum으로 바꾸면 1회씩 pause한
  // 정상 run N개가 위양성으로 발행된다 (2026-07-07 리뷰 판정).
  // pause_frequency — run-paused ≥ 임계치. 대표값 = 가장 빈발한 run.
  {
    let maxCount = 0, recipe = null;
    for (const runId of runIds) {
      const c = perRunMap[runId].pauses?.count || 0;
      if (c > maxCount) { maxCount = c; recipe = perRunMap[runId].recipe; }
    }
    if (maxCount >= CANDIDATE_RULES.PAUSE_FREQUENCY) {
      candidates.push({
        id: 'pause_frequency', metric: 'pause_count_max', value: maxCount,
        threshold: CANDIDATE_RULES.PAUSE_FREQUENCY, min_runs: 1, scope: 'run',
        target_hints: recipeHints([recipe].filter(Boolean)), target_tier: 1,
        note: 'run-paused 빈발 — T1: 사유 연관 recipe, T2: 스킬 지침(human-proposal)',
      });
    }
  }

  // abandoned_episodes — episode-abandon 이벤트 소스 총합 ≥ 1.
  {
    let sum = 0; const recipes = [];
    for (const runId of runIds) {
      const m = perRunMap[runId];
      const a = m.episodes?.terminal?.abandoned || 0;
      sum += a;
      if (a >= 1 && m.recipe && !recipes.includes(m.recipe)) recipes.push(m.recipe);
    }
    if (sum >= 1) {
      candidates.push({
        id: 'abandoned_episodes', metric: 'abandoned_count_total', value: sum,
        threshold: 1, min_runs: 1, scope: 'run', target_hints: recipeHints(recipes), target_tier: 1,
        note: 'episode abandon 발생 — T1: 해당 kind 연관 recipe, T2: 스킬 지침(human-proposal)',
      });
    }
  }

  // fix_convergence_slow:<point> — cross-run 전용. 3+ runs에서 point 평균 fix_cycles가 시간순
  // (runIds 정렬 = runs_analyzed 순서) 비감소일 때만 발행. min_runs 미만인 point는 침묵.
  const seriesByPoint = Object.create(null);
  for (const runId of runIds) {
    const avgs = perRunPointAverages(perRunMap[runId].review?.fix_cycles);
    for (const [point, avg] of Object.entries(avgs)) (seriesByPoint[point] ||= []).push(avg);
  }
  for (const [point, series] of Object.entries(seriesByPoint)) {
    if (series.length < CANDIDATE_RULES.CROSS_RUN_MIN) continue;
    // all-zero 시계열(클린 run들)은 "느린 수렴"이 아니다 — 0-시드 분모(위 🟡A) 도입 후 위양성 방지.
    const nonDecreasing = series.every((v, i) => i === 0 || v >= series[i - 1]) && series[series.length - 1] > 0;
    if (nonDecreasing) {
      candidates.push({
        id: `fix_convergence_slow:${point}`, metric: 'fix_cycles_trend', value: series[series.length - 1],
        threshold: series[0], min_runs: CANDIDATE_RULES.CROSS_RUN_MIN, scope: 'cross-run',
        target_hints: [], target_tier: 2,
        note: `point '${point}' fix_cycles 추세 비감소(${series.join('→')}) — 프로세스 지침(human-proposal, cross-run 전용)`,
      });
    }
  }

  // integrity_failure — §4-2 검증 실패 터미널 run 존재. 편집 대상 아님 — needs-human 조사 신호로만 표기.
  if (integrityFailed.length >= 1) {
    candidates.push({
      id: 'integrity_failure', metric: 'integrity_failed_count', value: integrityFailed.length,
      threshold: 1, min_runs: 1, scope: 'run', target_hints: [], target_tier: 2,
      note: `integrity 검증 실패 run 존재(${integrityFailed.join(', ')}) — 편집 대상 아님, needs-human 조사 신호`,
    });
  }

  return candidates;
}

const TERMINAL_RUN = new Set(['completed', 'stopped']);

// (b) finish-edge 인접성의 예외는 auto-floor cost와, 종료한 Codex child의 측정 결과를 프로세스 exit 후
// 정산하는 좁은 terminal-maker receipt뿐이다. 후자는 finish 직전 생성된 insights가 의도적으로 그 마지막
// 프로세스 사용량을 포함하지 않는 pre-finish snapshot이라는 계약이다. source+64-hex accounting key+정확한
// one-turn shape를 모두 요구해 일반 post-finish cost가 이 예외로 위장하지 못하게 한다.
// 명시 budget record cost(둘 다 아닌 cost)는 non-exempt (spec §3, r1 리뷰 P2):
// emit→finish 사이에 끼면 payload가 최종 turns/tokens를 놓쳐 budget_overrun 후보가 억제되므로 재-emit을 요구한다.
const terminalMakerReceipt = e => e.type === 'cost'
  && e.data?.terminal_process === 'codex-maker'
  && e.data?.source === 'terminal-maker-measured'
  && /^[a-f0-9]{64}$/.test(e.data?.accounting_key || '')
  && e.data?.reported_turns === 1
  && Number.isFinite(e.data?.reported_tokens) && e.data.reported_tokens >= 0
  && Number.isFinite(e.data?.turns) && e.data.turns >= 0
  && Number.isFinite(e.data?.tokens) && e.data.tokens >= 0;
const nonExemptEvent = (e, loop, lines) => !(e.type === 'cost'
  && (e.data?.auto_floor === true || terminalMakerReceipt(e) || isTerminalGoalOwnerCostEvent(e, loop, lines)));

export { captureReconciledRunSet };

function projectVerifiedRunSet(captured) {
  if (!captured || typeof captured !== 'object') {
    return { ok: false, kind: 'insights-run-set-integrity', phase: 'run-set', partial_discarded: true };
  }
  if (captured.ok === false) {
    if (captured.kind === 'run-set-bound-exceeded' || captured.reason === 'run-set-bound-exceeded') {
      return {
        ok: false,
        kind: 'run-set-bound-exceeded',
        phase: captured.phase || 'run-set',
        max_run_ids: captured.max_run_ids ?? 64,
        deadline_ms: captured.deadline_ms ?? 500,
        observed_count: captured.observed_count ?? 0,
        total_is_lower_bound: captured.total_is_lower_bound ?? false,
        partial_discarded: true,
      };
    }
    return { ok: false, kind: 'insights-run-set-integrity', phase: 'run-set', partial_discarded: true };
  }
  const runs = Object.fromEntries(captured.runIds.map(runId => [
    runId,
    captured.runs[runId]?.snapshot || captured.runs[runId],
  ]));
  if (Object.keys(captured.errors || {}).length > 0) {
    return { ok: false, kind: 'insights-run-set-integrity', phase: 'run-set', partial_discarded: true };
  }
  return Object.freeze({ ...captured, runs: Object.freeze(runs) });
}

export function captureVerifiedInsightsRunSet(root, options = {}) {
  return projectVerifiedRunSet(captureVerifiedRunSet(root, {
    runIds: options.runIds,
    maxRunIds: options.maxRunIds ?? 64,
    deadlineMs: options.deadlineMs ?? 500,
    deadlineAtMs: options.deadlineAtMs,
    nowFn: options.nowFn,
    sleepFn: options.sleepFn,
    lockOptions: options.lockOptions,
    opendirFn: options.opendirFn,
  }));
}

// (a) suspicious_active 판정 — raw(비검증) 읽기 기반의 **라벨**이지 신뢰 판단이 아니다(집계 제외 원칙은
// terminal-only 불변; spec §2 판정 표를 위에서 아래로 첫 매치). paused 는 preserve-pause 사람-대기 정상
// 상태라 최우선 제외. releasing 인데 expires_at 부재/파싱불가는 규약 밖(정상 커널은 releasing 전이 시 반드시
// TTL 설정 — lease.mjs r1 🔴4) → timeout 인수도 불가한 stranded 이므로 suspicious (spec r4 리뷰 수용).
export function isSuspiciousActive(status, lease, nowMs) {
  if (status === 'paused') return false;
  if (!lease || typeof lease !== 'object') return false;
  if (lease.state === 'released') return true;
  if (lease.state === 'releasing') {
    if (!lease.expires_at) return true;
    // V8 Date.parse는 '2026-02-31T00:00:00Z' 같은 달력-무효 값을 3월로 정규화한다(impl-r5 리뷰) —
    // 커널은 expires_at을 항상 toISOString(밀리초 포함 Z)으로 쓰므로, round-trip 불일치(파싱불가·롤오버·
    // 비정규 표기)는 전부 규약 밖 = suspicious (TTL-부재 처리와 동일한 보수 라벨 원칙).
    const exp = Date.parse(lease.expires_at);
    if (Number.isNaN(exp) || new Date(exp).toISOString() !== lease.expires_at) return true;
    return nowMs > exp;
  }
  return false;
}

export function computeInsights(runSet, { selfRunId = null, now = Date.now() } = {}) {
  if (!runSet || typeof runSet !== 'object' || !Array.isArray(runSet.runIds)
    || !runSet.runs || !runSet.errors) throw new Error('INSIGHTS_SNAPSHOT_REQUIRED');
  const out = {
    insights_schema_version: INSIGHTS_SCHEMA_VERSION,
    generated_at: new Date(now).toISOString(),
    runs_analyzed: [], excluded_active: [], suspicious_active: [], unreadable: [], integrity_failed_runs: [],
    post_finish_mutated: [],
    per_run: Object.create(null), aggregates: {}, candidates: [],
  };
  for (const id of runSet.runIds) {
    const isSelf = id === selfRunId;
    const snapshot = runSet.runs[id];
    if (!snapshot) {
      if (runSet.errors[id]?.kind === 'unreadable') out.unreadable.push(id);
      else out.integrity_failed_runs.push(id);
      continue;
    }
    const probe = { status: snapshot.data.status, lease: snapshot.data.session_chain?.lease ?? null };
    if (!isSelf && !TERMINAL_RUN.has(snapshot.data.status)) {
      out.excluded_active.push(id);
      if (isSuspiciousActive(probe.status, probe.lease, now)) out.suspicious_active.push(id);
      continue;
    }
    const loopHash = snapshot.hash;
    const loop = snapshot.data;
    const events = snapshot.logLines;
    // 검증은 통과했으나 metrics 산출이 불능인 run(과거/타 버전 커널의 이벤트 shape drift)은 fail-soft로
    // unreadable에 분류 — run 하나가 insights 전체(피드백 루프)를 크래시하면 안 된다 (impl-R3 🟡D).
    let m;
    try { m = computeRunMetrics(loop, events); }
    catch { out.unreadable.push(id); continue; }
    if (isSelf) m.self_snapshot = true;
    // (b′) post-finish mutation 라벨 (spec §3, r5 리뷰 — 라벨 방식): finish 이후 non-exempt 이벤트가 낀
    // terminal 로그는 집계에 유지하되 노출만 한다 (suspicious_active와 동일한 라벨 정신 — 제외는 run 전체
    // 이력의 학습 손실이라 채택 안 함). finish 이벤트 없는 terminal 로그(레거시)는 판정 불가 → 라벨 없음.
    const fin = events.find(e => e.type === 'finish');
    if (fin && events.some(e => e.seq > fin.seq && nonExemptEvent(e, loop, events))) out.post_finish_mutated.push(id);
    out.per_run[id] = m;
    out.runs_analyzed.push({ run_id: id, last_seq: m.last_seq, loop_sha256: loopHash });
  }
  out.candidates = deriveCandidates(out.per_run, { integrityFailed: out.integrity_failed_runs });
  out.aggregates = { avg_fix_cycles_by_point: avgFixCyclesByPoint(out.per_run), total_runs: out.runs_analyzed.length };
  return out;
}

const insightsDir = (root) => join(root, '.deep-loop', 'insights');
export const relInsightsPath = (name) => `.deep-loop/insights/${name}`;

export function emitInsights(root, runId, {
  fence, now = Date.now(), rnd = Math.random, platform, monotonicNowFn, renameFn, sleepFn,
} = {}) {
  // lib 진입점 fence 필수 — shape까지 episode.mjs:26-27/finish.mjs 동형(owner 문자열 + generation 정수, r2 리뷰 정정)
  if (!fence || typeof fence.owner !== 'string' || !fence.owner.length || !Number.isInteger(fence.generation)) {
    throw new Error('FENCE_REQUIRED: emitInsights requires {owner: string, generation: integer}');
  }
  // fast-fail leaseCheck를 tmp write **이전에** 수행 (r2 리뷰 정정 — wrong-generation 호출이 .tmp- 잔재를 남기지 않게).
  // 권위 검사는 여전히 아래 appendAnchored preCheck(락 안)에 있다 — 이건 잔재 방지용 사전 검사.
  { const { data: pre } = captureReconciledRunSnapshot(root, runId); const lc = leaseCheck(pre, fence); if (!lc.ok) throw new Error('LEASE_FENCED: ' + lc.reason); }
  const runSet = captureReconciledRunSet(root);
  const payload = computeInsights(runSet, { selfRunId: runId, now });
  const loop = runSet.runs[runId]?.data;
  if (!loop) throw new Error(`INSIGHTS_SNAPSHOT_MISSING: ${runId}`);
  const envelope = wrap({ producer: 'deep-loop', artifact_kind: 'loop-insights',
    schema: { name: 'loop-insights', version: String(INSIGHTS_SCHEMA_VERSION) },
    run_id: runId, parent_run_id: loop.session_chain?.parent_run_id ?? null,
    payload, now: new Date(now).toISOString() });
  const json = JSON.stringify(envelope, null, 2);
  const sha256 = contentHash(json);
  const fileUlid = ulid(now, rnd);
  const finalName = `${fileUlid}-insights.json`;
  const rel = relInsightsPath(finalName);
  mkdirSync(insightsDir(root), { recursive: true });
  const tmp = join(insightsDir(root), `.tmp-${fileUlid}`);
  atomicWrite(tmp, json);                                            // ① tmp (latest 스캔 제외 접두)
  try {
    appendAnchored(root, runId,                                      // ② anchored 이벤트 = 신뢰 원천
      { type: 'insights-emitted', data: { path: rel, sha256, candidates_count: payload.candidates.length } },
      undefined,
      (l) => { if (fence) { const r = leaseCheck(l, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); } },
      { floor: MUTATION_TURN_FLOOR });
  } catch (error) {
    // The hidden file is only staging until the anchored event succeeds. A rejected
    // append (including a retained compact-restore intent) must not accumulate debris.
    try { unlinkSync(tmp); } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
  renameAtomicWithRetry(tmp, join(insightsDir(root), finalName),
    { platform, monotonicNowFn, renameFn, sleepFn });                // ③ 공개
  // candidates를 반환에 포함 — finish 스킬이 파일을 직접 파싱하지 않고 CLI 출력만으로 제안 블록을 구성(§9, 2-plane).
  // v1.5: 신뢰 라벨 2배열도 함께 노출 — payload에만 있으면 stdout-만 읽는 소비자에게 영원히 안 보인다 (plan-r2).
  return { ok: true, path: rel, sha256, candidates_count: payload.candidates.length, candidates: payload.candidates,
    suspicious_active: payload.suspicious_active, post_finish_mutated: payload.post_finish_mutated };
}

export function captureLatestInsightsSet(root, {
  afterEnumeration,
  maxArtifacts = 64,
  deadlineMs = 500,
  deadlineAtMs,
  nowFn = () => Date.now(),
  sleepFn,
  opendirFn = opendirSync,
  readFileFn = readFileSync,
  lstatFn = lstatSync,
  identityFn = path => captureStableFileIdentity(path, { lstatFn }),
} = {}) {
  const now = () => {
    const value = nowFn();
    return value instanceof Date ? value.getTime() : Number(value);
  };
  const absoluteDeadline = deadlineAtMs ?? now() + deadlineMs;
  const bound = (phase, observedArtifacts) => ({
    ok: false,
    kind: 'insights-artifact-set-bound-exceeded',
    phase,
    max_artifacts: maxArtifacts,
    deadline_ms: deadlineMs,
    observed_artifacts: observedArtifacts,
    partial_discarded: true,
  });
  const checkDeadline = (phase, observedArtifacts = 0) => {
    if (!Number.isFinite(absoluteDeadline) || now() >= absoluteDeadline) return bound(phase, observedArtifacts);
    return null;
  };
  const dir = insightsDir(root);
  let artifactNames;
  let directory;
  let directoryIdentity = null;
  let directoryPresent = false;
  const directoryStable = () => {
    let stat;
    try { stat = lstatFn(dir, { bigint: true }); } catch { return false; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    let identity;
    try { identity = identityFn(dir); } catch { return false; }
    return directoryIdentity !== null
      ? matchingStableFileIdentity(directoryIdentity, identity)
      : false;
  };
  try {
    const early = checkDeadline('enumeration');
    if (early) return early;
    const names = [];
    if (existsSync(dir)) {
      directoryPresent = true;
      let stat;
      try { stat = lstatFn(dir, { bigint: true }); } catch { return { ok: false, kind: 'insights-artifact-set-integrity', phase: 'enumeration', partial_discarded: true }; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, kind: 'insights-artifact-set-integrity', phase: 'enumeration', partial_discarded: true };
      directoryIdentity = identityFn(dir);
      directory = opendirFn(dir);
      while (true) {
        const beforeRead = checkDeadline('enumeration', names.length);
        if (beforeRead) return beforeRead;
        const entry = directory.readSync();
        if (entry === null) break;
        if (!entry.isFile() || !entry.name.endsWith('-insights.json') || entry.name.startsWith('.tmp-')) continue;
        names.push(entry.name);
        if (names.length > maxArtifacts) return bound('enumeration', names.length);
      }
    }
    names.sort().reverse();
    artifactNames = Object.freeze(names);
  } catch {
    return { ok: false, kind: 'insights-artifact-set-integrity', phase: 'enumeration', partial_discarded: true };
  } finally {
    try { directory?.closeSync(); } catch { /* enumeration failure is already structured */ }
  }
  afterEnumeration?.(artifactNames);
  const afterEnumerationDeadline = checkDeadline('post-enumeration', artifactNames.length);
  if (afterEnumerationDeadline) return afterEnumerationDeadline;
  if ((directoryPresent && !directoryStable()) || (!directoryPresent && existsSync(dir))) {
    return { ok: false, kind: 'insights-artifact-set-integrity', phase: 'artifact-directory', partial_discarded: true };
  }
  const artifacts = Object.create(null);
  const producerIds = [];
  for (const name of artifactNames) {
    const early = checkDeadline('artifact-read', artifactNames.length);
    if (early) return early;
    if ((directoryPresent && !directoryStable()) || (!directoryPresent && existsSync(dir))) {
      return { ok: false, kind: 'insights-artifact-set-integrity', phase: 'artifact-directory', partial_discarded: true };
    }
    try {
      const path = join(dir, name);
      const beforeStat = lstatFn(path, { bigint: true });
      if (beforeStat.isSymbolicLink() || !beforeStat.isFile()) throw new Error('INSIGHTS_ARTIFACT_NOT_REGULAR');
      const before = identityFn(path);
      const bytes = Buffer.from(readFileFn(path));
      const afterStat = lstatFn(path, { bigint: true });
      const after = identityFn(path);
      if (afterStat.isSymbolicLink() || !afterStat.isFile()
        || !matchingStableFileIdentity(before, after)) {
        throw new Error('INSIGHTS_ARTIFACT_IDENTITY_DRIFT');
      }
      // The file identity check alone does not bind the pathname to the
      // enumerated parent. A concurrent parent rename/symlink swap must be
      // rejected before retaining the bytes we just read.
      if ((directoryPresent && !directoryStable()) || (!directoryPresent && existsSync(dir))) {
        return { ok: false, kind: 'insights-artifact-set-integrity', phase: 'artifact-directory', partial_discarded: true };
      }
      artifacts[name] = Object.freeze({ state: 'present', bytes, sha256: contentHash(bytes) });
      const parsed = JSON.parse(bytes.toString('utf8'));
      const producer = parsed?.envelope?.run_id;
      if (typeof producer === 'string') producerIds.push(producer);
    } catch {
      if ((directoryPresent && !directoryStable()) || (!directoryPresent && existsSync(dir))) {
        return { ok: false, kind: 'insights-artifact-set-integrity', phase: 'artifact-directory', partial_discarded: true };
      }
      return { ok: false, kind: 'insights-artifact-set-integrity', phase: 'artifact-read', partial_discarded: true };
    }
    const afterReadDeadline = checkDeadline('artifact-read-after', artifactNames.length);
    if (afterReadDeadline) return afterReadDeadline;
  }
  if ((directoryPresent && !directoryStable()) || (!directoryPresent && existsSync(dir))) {
    return { ok: false, kind: 'insights-artifact-set-integrity', phase: 'artifact-directory', partial_discarded: true };
  }
  const runSet = captureVerifiedInsightsRunSet(root, {
    runIds: producerIds,
    deadlineAtMs: absoluteDeadline,
    deadlineMs,
    nowFn,
    sleepFn,
    lockOptions: { nowFn, sleepFn },
  });
  if (runSet.ok === false) {
    if (runSet.kind === 'run-set-bound-exceeded') {
      return {
        ok: false,
        kind: 'insights-artifact-set-bound-exceeded',
        phase: 'producer-snapshot',
        max_artifacts: maxArtifacts,
        deadline_ms: deadlineMs,
        observed_artifacts: artifactNames.length,
        partial_discarded: true,
      };
    }
    return { ok: false, kind: 'insights-artifact-set-integrity', phase: 'producer-snapshot', partial_discarded: true };
  }
  const afterProducerDeadline = checkDeadline('post-producer-snapshot', artifactNames.length);
  if (afterProducerDeadline) return afterProducerDeadline;
  return Object.freeze({ root, artifactNames, artifacts, runSet, deadlineAtMs: absoluteDeadline, nowFn, deadlineMs, maxArtifacts });
}

export function latestInsights(snapshotSet) {
  if (snapshotSet?.ok === false) return snapshotSet;
  if (!snapshotSet || typeof snapshotSet !== 'object' || !Array.isArray(snapshotSet.artifactNames)
    || !snapshotSet.artifacts || !snapshotSet.runSet) throw new Error('INSIGHTS_SNAPSHOT_REQUIRED');
  const now = typeof snapshotSet.nowFn === 'function' ? snapshotSet.nowFn : () => Date.now();
  const deadline = snapshotSet.deadlineAtMs;
  const bound = phase => ({ ok: false, kind: 'insights-artifact-set-bound-exceeded', phase,
    max_artifacts: snapshotSet.maxArtifacts ?? 64, deadline_ms: snapshotSet.deadlineMs ?? 500,
    observed_artifacts: snapshotSet.artifactNames.length, partial_discarded: true });
  const deadlineExpired = () => deadline !== undefined && Number(now()) >= Number(deadline);
  const integrityFailure = phase => ({
    ok: false,
    kind: 'insights-artifact-set-integrity',
    phase,
    partial_discarded: true,
  });
  if (deadlineExpired()) return bound('selection');
  for (const f of snapshotSet.artifactNames) {
    if (deadlineExpired()) return bound('selection');
    try {
      const artifact = snapshotSet.artifacts[f];
      if (artifact?.state !== 'present') continue;
      const raw = artifact.bytes.toString('utf8');
      if (deadlineExpired()) return bound('artifact-verify');
      const obj = unwrap(JSON.parse(raw), { producer: 'deep-loop', artifact_kind: 'loop-insights' });
      if (!obj) continue;
      if ((obj.payload?.insights_schema_version ?? Infinity) > INSIGHTS_SCHEMA_VERSION) { process.stderr.write(`[deep-loop:warn] insights ${f}: newer schema — skipped\n`); continue; }
      const rel = relInsightsPath(f);
      // 리뷰 판정(2026-07-07): anchored 신뢰는 체인 검증을 전제한다 — readLines는 parse만 하므로
      // verifyLines(체크섬 체인) + verifyHeadLines(head anchor, suffix truncation)를 통과한 로그의 이벤트만
      // 증거로 인정한다 (computeInsights §4-2 동형 — 단일 읽기, impl-R2 🟡2). 실패는 throw → per-file
      // catch → fail-soft skip.
      const rid = obj.envelope.run_id;
      const producerSnapshot = snapshotSet.runSet.runs[rid];
      if (!producerSnapshot) return integrityFailure('producer-anchor');
      const producerData = producerSnapshot.data;
      if (deadlineExpired()) return bound('producer-verify');
      // Phase6 ITEM-4: finish는 proof 검증 **이전**에 insights emit을 실행하므로, proof 미충족으로
      // finish가 실패하면 status=running인 run의 insights가 검증 통과 상태로 latest에 남아 다음
      // init/hill-climb이 소비할 수 있다 — computeInsights가 타 run에 적용하는 terminal-only 원칙
      // (TERMINAL_RUN, :306)을 여기 artifact 선택에도 대칭 적용한다. emit→finish 성공 사이 창에서만
      // 일시 skip되고, finish가 status를 terminal로 바꾸는 순간 동일 artifact가 유효화된다.
      if (!TERMINAL_RUN.has(producerData.status)) {
        process.stderr.write(`[deep-loop:warn] insights ${f}: producer run ${rid} not terminal (status=${producerData.status}) — skipped\n`);
        continue;
      }
      const anchor = producerData.event_log_head;
      const lines = producerSnapshot.logLines;
      const vl = verifyLines(lines);
      if (!vl.ok) throw new Error(`LOG_TAMPERED: ${vl.errors.join('; ')}`);
      if (deadlineExpired()) return bound('log-verify');
      const vh = verifyHeadLines(lines, anchor);
      if (!vh.ok) throw new Error(`LOG_TAMPERED: ${vh.errors.join('; ')}`);
      // (b) 앵커는 path-binding을 통과시킨 바로 그 이벤트 — artifact의 path와 정확 일치. 동일 path 매칭이
      // 2개 이상이면 fail-closed(정상 경로에서 파일명 ULID가 유일하므로 중복은 규약 밖; spec §3 r3 리뷰).
      const matches = lines.filter(e => e.type === 'insights-emitted' && e.data.path === rel);
      if (matches.length === 0) return integrityFailure('anchor');
      if (matches.length > 1) return integrityFailure('anchor');
      const ev = matches[0];
      if (deadlineExpired()) return bound('anchor-verify');
      if (ev.data.sha256 !== contentHash(raw)) return integrityFailure('artifact-hash');
      // (b) finish-edge: 앵커 이후 non-exempt 이벤트가 정확히 finish 하나(=마지막 non-exempt)여야 신뢰
      // (spec §3, r2 리뷰 🔴 2/2 일치) — mid-run emit(뒤에 business/명시 cost 이벤트)과 post-finish
      // mutation(finish 뒤 non-exempt) 로그의 pre-finish payload를 모두 skip한다. 회복 경로는 재-emit.
      const after = lines.filter(e => e.seq > ev.seq && nonExemptEvent(e, producerData, lines));
      if (after.length !== 1 || after[0].type !== 'finish') return integrityFailure('finish-edge');
      if (deadlineExpired()) return bound('finish-edge');
      // sha256: anchored insights-emitted 이벤트에 기록된 값(위에서 contentHash(raw) 일치 검증 완료) —
      // 소비자(dispatchReview evidence 등)가 artifact 동일성을 재검증 없이 인용할 수 있게 노출한다 (codex r2).
      if (deadlineExpired()) return bound('selection');
      return { path: rel, envelope: obj, sha256: ev.data.sha256 };
    } catch (e) {
      if (String(e?.message || e).startsWith('LOG_TAMPERED')) {
        return integrityFailure('producer-verification');
      }
      process.stderr.write(`[deep-loop:warn] insights ${f}: ${String(e?.message || e)} — skipped\n`);   // fail-soft
    }
  }
  if (deadlineExpired()) return bound('selection');
  return null;
}

// spec §8.3 — hillclimb-ledger.json 스키마 검증 (배열·append-only 항목 형태만; append-only 강제는
// checker 계약 (f)의 diff 검사 + git history 폴백이 담당 — 여기서는 스키마·배열 형태만 단언).
export function validateLedger(arr) {
  const errors = [];
  if (!Array.isArray(arr)) return { ok: false, errors: ['ledger must be an array'] };
  arr.forEach((item, i) => {
    if (typeof item?.date !== 'string') errors.push(`item ${i}: date must be a string`);
    if (typeof item?.insights_ref !== 'string') errors.push(`item ${i}: insights_ref must be a string`);
    if (!Array.isArray(item?.candidates_addressed) || !item.candidates_addressed.every(v => typeof v === 'string')) {
      errors.push(`item ${i}: candidates_addressed must be a string[]`);
    }
    if (typeof item?.falsification !== 'string') errors.push(`item ${i}: falsification must be a string`);
    if (item?.changes !== undefined && (!Array.isArray(item.changes) || !item.changes.every(v => typeof v === 'string'))) {
      errors.push(`item ${i}: changes must be a string[]`);
    }
    if (item?.human_proposals !== undefined && (!Array.isArray(item.human_proposals) || !item.human_proposals.every(v => typeof v === 'string'))) {
      errors.push(`item ${i}: human_proposals must be a string[]`);
    }
    if (item?.insights_sha256 !== undefined && typeof item.insights_sha256 !== 'string') {
      errors.push(`item ${i}: insights_sha256 must be a string`);
    }
  });
  return { ok: errors.length === 0, errors };
}
