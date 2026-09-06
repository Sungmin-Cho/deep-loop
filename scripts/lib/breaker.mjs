import { writeState, withReconciledMutationLock } from './state.mjs';
import { leaseCheck } from './lease.mjs';
import { recoveryReservationKind } from './budget.mjs';
import { isGoalDriven, GOAL_LIMITS } from './goal-contract.mjs';

const THRESHOLD = 3;
export function reviewFailureLimit(loop) {
  if (!isGoalDriven(loop)) return THRESHOLD;
  const limit = loop.review?.max_review_rounds;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GOAL_LIMITS.reviewRounds) throw new Error('GOAL_POLICY_INVALID: max_review_rounds');
  return limit;
}

export function checkBreaker(loop) {
  const cb = loop.circuit_breaker || {};
  if (cb.tripped) return { tripped: true, reason: cb.trip_reason || 'tripped' };
  if ((cb.consecutive_request_changes || 0) >= reviewFailureLimit(loop)) return { tripped: true, reason: 'consecutive-request-changes' };
  return { tripped: false, reason: null };
}

export function tripBreaker(root, runId, reason) {
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    // v1.6 (spec §2.3-7): fence 파라미터가 없는 legacy export — terminal run을 paused로 강등 금지.
    if (data.status === 'completed' || data.status === 'stopped') throw new Error('RUN_TERMINAL: tripBreaker');
    data.circuit_breaker = { ...data.circuit_breaker, tripped: true, trip_reason: reason };
    data.status = 'paused';
    writeState(root, runId, data);
  });
}

function assertResetBreakerFence(data, fence) {
  const recoveryKind = recoveryReservationKind(data);
  if (recoveryKind !== null) {
    const lease = data.session_chain.lease;
    if (!fence || lease.owner_run_id !== fence.owner || lease.generation !== fence.generation) {
      throw new Error('LEASE_FENCED: recovery-parent-mismatch');
    }
  } else if (fence) {
    const r = leaseCheck(data, fence);
    if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);
  }
  return recoveryKind;
}

export function resetBreaker(root, runId, { fence } = {}) {
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    const recoveryKind = recoveryReservationKind(data);
    // v1.6 (spec §2.3-7): fence가 있으면 gateway authorizer의 leaseCheck가
    // LEASE_FENCED: RUN_TERMINAL로 선착한다(채널 보존).
    // fence-less 직접 호출만 이 자체 가드가 잡는다 — 순서가 계약이다.
    if (data.status === 'completed' || data.status === 'stopped') throw new Error('RUN_TERMINAL: resetBreaker');
    const wasBreaker = data.status === 'paused' && /request-changes|consecutive/.test(data.circuit_breaker?.trip_reason || '');
    data.circuit_breaker = { consecutive_request_changes: 0, tripped: false, trip_reason: null };
    if (wasBreaker && recoveryKind === null) data.status = 'running';
    writeState(root, runId, data);
    return { ok: true, status: data.status };
  }, { authorize: (_guard, { data }) => assertResetBreakerFence(data, fence) });
}

export function recordReviewVerdict(root, runId, verdict, fence) {
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    if (fence) {
      const r = leaseCheck(data, fence);
      if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);
    }
    // v1.6 (spec §2.3-7): legacy export — terminal run에 카운터/paused 강등 write 금지 (fence-less 커버).
    if (data.status === 'completed' || data.status === 'stopped') throw new Error('RUN_TERMINAL: recordReviewVerdict');
    const cb = data.circuit_breaker || { consecutive_request_changes: 0 };
    if (verdict === 'REQUEST_CHANGES') {
      cb.consecutive_request_changes = (cb.consecutive_request_changes || 0) + 1;
      if (cb.consecutive_request_changes >= reviewFailureLimit(data) && !cb.tripped) {
        cb.tripped = true;
        cb.trip_reason = 'consecutive-request-changes';
        data.status = 'paused';
      }
    } else {
      cb.consecutive_request_changes = 0;   // counter resets; tripped stays latched (human-reset only)
    }
    data.circuit_breaker = cb;
    writeState(root, runId, data);
  });
}
