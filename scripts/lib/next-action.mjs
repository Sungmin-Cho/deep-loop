import { checkBudget } from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import { computeDebt } from './comprehension.mjs';
import { makerReviewed, unsatisfiedReviewPoints, rejectionResolved } from './review.mjs';
import { finishProofState } from './finish.mjs';
import { classifyCompactHostForLoop, readableSessionRuntime } from './runtime.mjs';

function currentSessionTurns(loop) {
  const s = (loop.session_chain?.sessions || []).find(x => x.run_id === loop.session_chain?.lease?.owner_run_id);
  return s ? (s.turns || 0) : 0;
}

const A = (gate, action, next_command) => ({ gate, action, next_command });
const TERMINAL_WORKSTREAM_STATUSES = new Set(['ready', 'merged', 'abandoned']);

function sameBoundary(left, right) {
  return Number.isSafeInteger(left?.seq)
    && left.seq > 0
    && left.seq === right?.seq
    && typeof left.checksum === 'string'
    && left.checksum === right?.checksum;
}

function ownerSession(loop) {
  const owner = loop.session_chain?.lease?.owner_run_id;
  return (loop.session_chain?.sessions || []).find(session => session.run_id === owner) || null;
}

function baselineForWorkstreamAdvice(loop, session) {
  const cursor = session?.compact_cursor;
  const lease = loop.session_chain?.lease;
  return cursor?.owner_run_id === session?.run_id
    && cursor.owner_run_id === lease?.owner_run_id
    && cursor.generation === lease?.generation
    && Number.isSafeInteger(cursor.baseline_turns)
    && cursor.baseline_turns >= 0
    ? cursor.baseline_turns
    : 0;
}

export function workstreamSessionAdviceCadence(loop, { unattended = false } = {}) {
  if (loop.autonomy?.continuation_policy !== 'workstream-session' || unattended) {
    return { advice: false, reason: null };
  }
  const session = ownerSession(loop);
  const cap = loop.budget?.per_session_turn_cap;
  const relativeTurns = currentSessionTurns(loop) - baselineForWorkstreamAdvice(loop, session);
  return cap && relativeTurns >= cap
    ? { advice: true, reason: 'per_session_turn_cap' }
    : { advice: false, reason: null };
}

export function migratedPolicyCapOutcome(loop, { unattended = false } = {}) {
  if (loop.autonomy?.continuation_policy === 'workstream-session') {
    return { advice: false, handoff: false };
  }
  const cap = loop.budget?.per_session_turn_cap;
  const capReached = cap && currentSessionTurns(loop) >= cap;
  if (!capReached) return { advice: false, handoff: false };
  if (loop.autonomy?.continuation_policy === 'compact-in-place' && !unattended) {
    return { advice: true, handoff: false };
  }
  return { advice: false, handoff: true };
}

function boundaryAlreadyLinked(loop, parent, boundary) {
  if (!parent?.superseded_by) return false;
  const child = (loop.session_chain?.sessions || [])
    .find(session => session.run_id === parent.superseded_by);
  return child?.parent_run_id === parent.run_id
    && sameBoundary(child.parent_boundary_event, boundary);
}

function scopedRoutingView(loop, session) {
  const workstreams = loop.workstreams || [];
  let eligibleIds;
  if (session?.scope?.workstream_id) {
    eligibleIds = new Set([session.scope.workstream_id]);
  } else {
    eligibleIds = new Set(workstreams
      .filter(workstream => !TERMINAL_WORKSTREAM_STATUSES.has(workstream.status))
      .map(workstream => workstream.id));
    // With no eligible Workstream there is nothing to isolate from a terminal
    // sibling. Preserve the canonical finish/proof diagnostics for the whole run.
    if (eligibleIds.size === 0) return loop;
  }
  const episodes = (loop.episodes || [])
    .filter(episode => episode.workstream_id == null || eligibleIds.has(episode.workstream_id));
  const current = episodes.some(episode => episode.id === loop.current_episode)
    ? loop.current_episode
    : null;
  return { ...loop, episodes, current_episode: current };
}

// Finish-path robustness (repro-009): a PROOF-IMPOSSIBLE ORPHAN maker — one whose expected_artifacts is an explicit
// empty array — can NEVER be recorded `done` (recordEpisode rejects empty expected_artifacts with
// EPISODE_TERMINAL_NO_PROOF). Dispatching it forever burns budget / spins autonomous runs; instead surface the
// human-gated `episode abandon --confirm` recovery via await_human. PRECISE: fires ONLY on an explicit empty array
// (how newEpisode stores an artifact-less maker), NOT on synthetic fixtures that omit the field (those still dispatch).
const isOrphanMaker = (ep) => Array.isArray(ep.expected_artifacts) && ep.expected_artifacts.length === 0;

// "Is this rejected checker resolved (superseded)?" is answered by the SINGLE unified predicate
// rejectionResolved (review.mjs) — the SAME predicate finish.mjs settledEp uses, so next-action routing and
// finishProofState can never disagree on a rejected checker. Checkers are ALWAYS bound going forward (dispatchReview
// refuses to create an unbound checker — REVIEW_NO_ELIGIBLE_MAKER), and any LEGACY unbound rejected checker is
// rejectionResolved=true (neutral) → excluded from the scan. So an UNRESOLVED rejected checker reaching routing is
// ALWAYS bound → fix_episode (re-make THIS maker). A resolved rejected checker falls through to the finish gate.

// 현재 actionable episode 가 없을 때: 미완 maker/거부 checker/in-progress/미리뷰 done maker 를 우선 처리하고,
// 그 외엔 canonical finish 게이트(finishProofState)를 재사용 — finish 추천 ≡ finishRun 집행 (divergence 제거).
function finishOrAdvance(loop, gate, fanoutBlocked, blockingMakers) {
  const eps = loop.episodes || [];
  const wsExists = (id) => !!id && (loop.workstreams || []).some(w => w.id === id);
  const pendingMaker = eps.find(e => e.role === 'maker' && e.status === 'pending');
  if (pendingMaker) {
    // Proof-impossible orphan (expected_artifacts === []) can NEVER reach `done` → route to the human-gated
    // `episode abandon --confirm` recovery instead of dispatching forever. BEFORE the debt check (an orphan can
    // never complete regardless of debt). Keeps next-action ↔ finishProofState consistent (orphan = unsettled).
    if (isOrphanMaker(pendingMaker)) return A(gate, { type: 'await_human', episode_id: pendingMaker.id, reason: 'orphan-maker-no-artifacts' }, '/deep-loop-status');
    // Codex r3 🔴3: debt 면 새 fan-out maker(kind≠fix) 차단. fix maker 는 현재 진행이라 허용.
    if (fanoutBlocked && pendingMaker.kind !== 'fix') return A(gate, { type: 'await_human', episode_id: pendingMaker.id, reason: 'comprehension-debt', blocking_episode_ids: blockingMakers }, '/deep-loop-status');
    return A(gate, { type: 'dispatch_maker', episode_id: pendingMaker.id, point: pendingMaker.point, workstream_id: pendingMaker.workstream_id }, '/deep-loop-continue');
  }
  // Unified: find an unresolved rejected checker via rejectionResolved — the SAME predicate finishProofState.settledEp
  // uses. A resolved one (re-approved newer / later done maker) is skipped and falls through to the finish gate. A
  // rejected checker reaching here is ALWAYS bound (unbound rejected are rejectionResolved=true → neutral, excluded)
  // → fix_episode (re-make THIS maker). Keeps next-action ↔ finishProofState consistent: an unresolved rejection
  // blocks finish AND is surfaced here (never silently finished past).
  const rejected = eps.find(e => e.role === 'checker' && e.status === 'rejected' && !rejectionResolved(loop, e));
  if (rejected) return A(gate, { type: 'fix_episode', episode_id: rejected.id, point: rejected.point, workstream_id: rejected.workstream_id }, '/deep-loop-continue');
  const inProg = eps.find(e => e.status === 'in_progress');
  if (inProg) {
    // P2-b: a proof-impossible orphan maker (expected_artifacts === []) cannot reach `done` even from in_progress
    // (recordEpisode('done') rejects empty expected_artifacts) → don't await_result forever; surface abandon recovery.
    if (inProg.role === 'maker' && isOrphanMaker(inProg)) return A(gate, { type: 'await_human', episode_id: inProg.id, reason: 'orphan-maker-no-artifacts' }, '/deep-loop-status');
    // native-worktree: carry workstream_id so the driver can enter the episode's worktree for await_result.
    return A(gate, { type: 'await_result', episode_id: inProg.id, workstream_id: inProg.workstream_id }, '/deep-loop-continue');
  }
  // pending checker 는 actionable 이나 auto-dispatch (dispatch_checker = review dispatch) 가 중복 checker 를 만든다.
  // 사람에게 surface — driver 가 무한 dispatch loop 에 빠지지 않도록.
  const pendingChecker = eps.find(e => e.role === 'checker' && e.status === 'pending');
  if (pendingChecker) return A(gate, { type: 'await_human', episode_id: pendingChecker.id, reason: 'pending-checker-unresolved' }, '/deep-loop-status');
  // Codex r3 🔴4: 리뷰 안 된 done maker 가 있으면 finish 금지 → checker dispatch (리뷰 게이트 불변식).
  // Uses per-maker binding predicate (makerReviewed) so two checkers for maker1 cannot satisfy maker2.
  const unreviewed = eps.find(e => e.role === 'maker' && e.status === 'done' && !makerReviewed(loop, e));
  if (unreviewed) {
    // workstream 이 없는 done maker 는 checker 를 dispatch 해도 WORKSTREAM_NOT_FOUND 로 막힌다 (dead-end). 사람에게 surface.
    if (!wsExists(unreviewed.workstream_id)) return A(gate, { type: 'await_human', episode_id: unreviewed.id, reason: 'unbound-proof-episode' }, '/deep-loop-status');
    return A(gate, { type: 'dispatch_checker', episode_id: unreviewed.id, point: unreviewed.point, workstream_id: unreviewed.workstream_id }, '/deep-loop-continue');
  }
  // actionable 없음 → canonical finish 게이트 재사용 (추천 ≡ 집행: finishProofState 가 통과해야만 finish).
  const ps = finishProofState(loop);
  if (ps.missing.length === 0) return A(gate, { type: 'finish' }, '/deep-loop-finish');
  if (ps.missing.includes('review-point-unsatisfied')) return A(gate, { type: 'await_human', reason: `review-point-unsatisfied:${unsatisfiedReviewPoints(loop).join(',')}` }, '/deep-loop-status');
  if (ps.missing.includes('unbound-proof-episode')) return A(gate, { type: 'await_human', reason: 'unbound-proof-episode' }, '/deep-loop-status');
  return A(gate, { type: 'await_human', reason: 'active-work-remains' }, '/deep-loop-status');
}

export function nextAction(loop, { now = Date.now(), unattended = false } = {}) {
  const b = checkBudget(loop, { now });
  const br = checkBreaker(loop);
  const debt = computeDebt(loop);
  // The remedy must be discoverable from the descriptor, and it must be computed from the SAME input the gate
  // uses — the GLOBAL loop. finishOrAdvance's first parameter is named `loop` but receives `routingLoop` (the
  // scoped view, :185), so computing this inside that function silently yields [] whenever the blocking maker
  // lives in another workstream — precisely the case this field exists for.
  const blockingMakers = (Array.isArray(loop.episodes) ? loop.episodes : [])
    .filter(e => e?.role === 'maker' && e.status === 'done' && e.human_reviewed !== true)
    .map(e => e.id);
  const workstreamSession = loop.autonomy?.continuation_policy === 'workstream-session';
  const currentSession = ownerSession(loop);

  // budget hard-stop / breaker 는 모든 행동을 막는 전역 게이트.
  if (!b.ok) return A(
    { allowed: false, blocked_by: ['budget'], reason: b.reason, tier_after: b.tier_after },
    { type: 'await_human', reason: 'budget' },
    '/deep-loop-status',
  );
  if (br.tripped) return A({ allowed: false, blocked_by: ['breaker'], reason: br.reason, tier_after: b.tier_after }, { type: 'await_human', reason: 'breaker' }, '/deep-loop-status');

  // comprehension-debt는 **정착된(done) 미리뷰 maker 산출물이 존재할 때에만** 새 fan-out을 막는다 —
  // `discover`(:190)와 새 non-fix pending maker의 dispatch(:83/:201)가 그 대상이다. 현재 episode 진행/fix/
  // 리뷰/handoff/finish는 허용한다. pending maker는 debt 산식에 들어가지 않는다(computeDebt, 변경 A′).
  const consumed = loop.session_chain?.consumed_milestones || [];
  const unconsumedMilestones = (loop.workstreams || [])
    .flatMap(w => w.terminal_events || [])
    // Task 6 transition: structured workstream-session boundaries are routed from scope.terminal_event
    // in Task 7. Keep the existing milestone channel legacy-string-only until that boundary grammar lands.
    .filter(event => typeof event === 'string')
    .filter(event => !consumed.includes(event));
  const gate = {
    // unconsumed_milestones is a passable-gate signal only; global blocks already route to handoff/await_human.
    allowed: true,
    blocked_by: debt.blocked ? ['comprehension-debt'] : [],
    reason: b.reason,
    tier_after: b.tier_after,
    unconsumed_milestones: unconsumedMilestones,
  };

  // A Workstream session closes on one anchored event identity. Completion wins
  // because there is no successor work to own; otherwise publish exactly that
  // boundary once. Consumption is the durable parent→child topology, never a
  // second cursor channel.
  const boundary = currentSession?.scope?.terminal_event;
  const closedBoundary = workstreamSession
    && currentSession?.scope?.kind === 'workstream'
    && currentSession.scope.closed_at != null
    && currentSession.scope.superseded_at == null
    && sameBoundary(boundary, boundary);
  if (closedBoundary && !boundaryAlreadyLinked(loop, currentSession, boundary)) {
    if (finishProofState(loop).missing.length === 0) {
      return A(gate, { type: 'finish' }, '/deep-loop-finish');
    }
    return A(
      gate,
      { type: 'handoff', reason: 'workstream-terminal', boundary_event: { ...boundary } },
      '/deep-loop-handoff',
    );
  }

  // Workstream sessions compact only as attended advice relative to their
  // generation-bound cursor. Unattended ticks preserve the real action. The
  // migrated policies keep their historical cap outcomes in a separate helper.
  const workstreamCadence = workstreamSessionAdviceCadence(loop, { unattended });
  const migratedCap = migratedPolicyCapOutcome(loop, { unattended });
  if (migratedCap.handoff) {
    return A(gate, { type: 'handoff', reason: 'per_session_turn_cap' }, '/deep-loop-handoff');
  }
  const sessionRuntimeId = readableSessionRuntime(loop);
  const compactAdviceState = sessionRuntimeId == null
    ? 'unsupported'
    : classifyCompactHostForLoop(loop);
  const withAdvice = (r) => (compactAdviceState === 'enabled' || compactAdviceState === 'needs-approval')
    && (workstreamCadence.advice || migratedCap.advice)
    ? { ...r, action: { ...r.action, advice: 'compact', advice_reason: 'per_session_turn_cap' } }
    : r;

  const routingLoop = workstreamSession ? scopedRoutingView(loop, currentSession) : loop;
  const route = () => {
    const ep = (routingLoop.episodes || []).find(e => e.id === routingLoop.current_episode);
    if (!ep) {
      if (!routingLoop.episodes || routingLoop.episodes.length === 0) {
        if (debt.blocked) return A(gate, { type: 'await_human', reason: 'comprehension-debt', blocking_episode_ids: blockingMakers }, '/deep-loop-status');  // discover=fan-out → debt 면 사람 검토 먼저
        return A(gate, { type: 'discover' }, '/deep-loop-discover');
      }
      return finishOrAdvance(routingLoop, gate, debt.blocked, blockingMakers);
    }
    if (ep.role === 'maker') {
      if (ep.status === 'pending') {
        // Proof-impossible orphan (expected_artifacts === []) can NEVER reach `done` → human-gated abandon recovery.
        // BEFORE the debt check (an orphan can never complete regardless of debt). See finishOrAdvance for rationale.
        if (isOrphanMaker(ep)) return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'orphan-maker-no-artifacts' }, '/deep-loop-status');
        // Codex r3 🔴3: debt 면 새 fan-out maker(kind≠fix) 차단. fix maker 는 현재 진행이라 허용.
        if (debt.blocked && ep.kind !== 'fix') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'comprehension-debt', blocking_episode_ids: blockingMakers }, '/deep-loop-status');
        return A(gate, { type: 'dispatch_maker', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');
      }
      if (ep.status === 'in_progress') {
        // P2-b: same orphan routing as finishOrAdvance — an in_progress orphan maker can never reach `done`, so surface
        // the human-gated abandon recovery instead of awaiting a result that can never validate.
        if (isOrphanMaker(ep)) return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'orphan-maker-no-artifacts' }, '/deep-loop-status');
        // native-worktree: carry workstream_id so the driver can enter the episode's worktree for await_result.
        return A(gate, { type: 'await_result', episode_id: ep.id, workstream_id: ep.workstream_id }, '/deep-loop-continue');
      }
      if (ep.status === 'blocked') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'episode-blocked' }, '/deep-loop-status');
      if (ep.status === 'done') {
        // dispatch_checker 는 workstream 이 있어야 가능 (review dispatch → WORKSTREAM_NOT_FOUND 방지). 없으면 사람에게 surface.
        if (!(routingLoop.workstreams || []).some(w => w.id === ep.workstream_id)) return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'unbound-proof-episode' }, '/deep-loop-status');
        return A(gate, { type: 'dispatch_checker', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');
      }
    }
    if (ep.role === 'checker') {
      // pending checker auto-dispatch 는 중복 checker 를 만든다 (dispatch_checker = review dispatch). 사람에게 surface.
      if (ep.status === 'pending') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'pending-checker-unresolved' }, '/deep-loop-status');
      // native-worktree: carry workstream_id for worktree entry on await_result.
      if (ep.status === 'in_progress') return A(gate, { type: 'await_result', episode_id: ep.id, workstream_id: ep.workstream_id }, '/deep-loop-continue');   // 재dispatch 금지 (Codex r2 🔴7)
      if (ep.status === 'blocked') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'episode-blocked' }, '/deep-loop-status');
      // Same unified predicate as the finishOrAdvance scan (recommend ≡ enforce). An UNRESOLVED rejected checker is
      // ALWAYS bound (unbound rejected are rejectionResolved=true → neutral) → fix_episode (re-make THIS maker). A
      // RESOLVED rejected checker (re-approved newer / later done maker / neutral unbound) falls through to the finish
      // gate — current_episode points at the last-created episode, so a redundant re-review on an already-approved point
      // can leave a (resolved) rejected checker as current_episode; this path must not diverge from finishProofState.
      if (ep.status === 'rejected' && !rejectionResolved(routingLoop, ep)) return A(gate, { type: 'fix_episode', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');
      if (ep.status === 'approved') return finishOrAdvance(routingLoop, gate, debt.blocked, blockingMakers);
    }
    return finishOrAdvance(routingLoop, gate, debt.blocked, blockingMakers);
  };
  return withAdvice(route());
}
