import { inheritGoalScopeState } from './session-scope.mjs';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { contentHash, unwrap, wrap } from './envelope.mjs';
import {
  appendAnchored,
  readLines,
  verifyHead,
  verifyLog,
} from './integrity.mjs';
import {
  checkHardBudget,
  recoveryReservationKind,
} from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import {
  captureReconciledRunSnapshot,
  runDir,
} from './state.mjs';
import {
  isOpenScope,
  openScopeSessions,
  ownerSession,
  supersedeScope,
} from './session-scope.mjs';
import {
  captureStableFileIdentity,
  matchingStableFileIdentity,
  normalizePortableRelativePath,
} from './fs-safe.mjs';
import { projectRootDigest } from './project-root.mjs';
import { runtimeCapability, runtimeFence, sessionRuntime } from './runtime.mjs';
import { buildRecoveryResumeDescriptor } from './runtime-descriptor.mjs';

const RECOVERY_KINDS = new Set(['affinity-supersession', 'boundary-recovery']);
const NONTERMINAL_WORKSTREAM = new Set(['planned', 'in_progress', 'in_review', 'parked']);
const MAX_CAPSULE_BYTES = 256 * 1024;

function exactBoundaryIdentity(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify(['seq', 'checksum'])
    && Number.isSafeInteger(value.seq)
    && value.seq > 0
    && /^[0-9a-f]{64}$/.test(value.checksum || '');
}

function sameBoundaryIdentity(left, right) {
  return exactBoundaryIdentity(left)
    && exactBoundaryIdentity(right)
    && left.seq === right.seq
    && left.checksum === right.checksum;
}

function canonicalNow(now, context = 'recovery') {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error(`INVALID_NOW: ${context}`);
  return date.toISOString();
}

function normalizedTime(value, context) {
  const timestamp = new Date(value).getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`INVALID_NOW: ${context}`);
  }
  return timestamp;
}

function lockedSafetyTime(clock, context) {
  return normalizedTime(
    typeof clock === 'function' ? clock() : Number.NaN,
    context,
  );
}

function operationTime(now, safetyNow, context) {
  return normalizedTime(now === undefined ? safetyNow : now, context);
}

// ── acquire↔resume 응답 계약 (spec §3.1/§3.2) ────────────────────────────────
// 세 acquire 경로가 공유한다. lease.mjs 는 이미 이 모듈을 import 하므로 여기 두면 순환이 없다.

// 비진행 판정을 preCheck 밖으로 나르는 sentinel. 메시지는 **bare 토큰**이어야 한다 — 판별이 정확일치이므로
// 사유를 덧붙이면 catch 가 이를 sentinel 로 알아보지 못한다(§3.2 노트 1). 사유는 payload 에 싣는다.
export const ACQUIRE_HALT = 'ACQUIRE_HALT';

export function acquireHalt(payload) {
  const halt = new Error(ACQUIRE_HALT);
  halt.payload = payload;
  return halt;
}

// 응답 계약 3필드 — **in-place 할당만** 한다(§3.2 노트 2). `{...result}` 재구성은 금지: spread 는
// classifiedAcquireFailure 가 붙인 non-enumerable `kernel_exit_code` 를 복사하지 않으므로 exit 3/1 이
// 조용히 0 으로 회귀한다. proceed 는 단일 파생 규칙이다 — ok && reason === 'acquired'.
export function contractFields(result, { consumed = null, replayed = false } = {}) {
  result.proceed = result.ok === true && result.reason === 'acquired';
  result.consumed = result.proceed ? consumed : null;
  result.replayed = replayed;
  return result;
}

// 영수증 필드 순서 = §3.2 스키마 순서. `consumed` 는 여기서 세 필드를 뺀 나머지이므로(§3.1) 이 순서가
// 곧 응답 `consumed` 의 키 순서다.
export function buildAcquisitionReceipt({
  takeoverKind,
  childRunId,
  supersededOwnerRunId,
  boundaryEvent = null,
  projectRootDigest: rootDigest = null,
  projectBindingGeneration = null,
  handoffRel = null,
  reservationKey = null,
  fromGeneration,
  toGeneration,
  at,
  attemptId = null,
}) {
  return {
    takeover_kind: takeoverKind,
    child_run_id: childRunId,
    superseded_owner_run_id: supersededOwnerRunId,
    boundary_event: boundaryEvent === null ? null : { ...boundaryEvent },
    project_root_digest: rootDigest,
    project_binding_generation: projectBindingGeneration,
    handoff_rel: handoffRel,
    reservation_key: reservationKey,
    from_generation: fromGeneration,
    to_generation: toGeneration,
    at,
    attempt_id: attemptId,
  };
}

// 예약 없는 인수(`released-takeover`)는 영수증은 남기지만 응답 `consumed` 는 null 이다 — B-2(ii) 해소.
export function consumedFromReceipt(receipt) {
  if (!receipt || receipt.takeover_kind === 'released-takeover') return null;
  const {
    reservation_key: _reservationKey, at: _at, attempt_id: _attemptId, ...consumed
  } = receipt;
  return consumed;
}

function assertFence(loop, expect) {
  const lease = loop.session_chain?.lease;
  if (!lease
    || !expect
    || typeof expect.owner !== 'string'
    || expect.owner.length === 0
    || !Number.isSafeInteger(expect.generation)
    || expect.generation < 1) {
    throw new Error('LEASE_FENCED: invalid-fence');
  }
  if (lease.owner_run_id !== expect.owner) throw new Error('LEASE_FENCED: owner-mismatch');
  if (lease.generation !== expect.generation) throw new Error('LEASE_FENCED: generation-mismatch');
}

function assertReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length === 0
    || reason.length > 1_024 || reason.includes('\0')) {
    throw new Error('RECOVERY_REASON_INVALID');
  }
}

function recoverySafetyReason(loop, now) {
  const budget = checkHardBudget(loop, { now });
  if (budget.blocked) return 'BUDGET_BLOCKED';
  if (checkBreaker(loop).tripped) return 'BREAKER_BLOCKED';
  return null;
}

function assertNoRecoveryInFlight(loop) {
  if (RECOVERY_KINDS.has(loop.session_chain?.lease?.takeover_kind)) {
    throw new Error('RECOVERY_IN_FLIGHT');
  }
}

function recoveryChildId(domain, values) {
  return `RECOVERY-${contentHash(JSON.stringify([domain, ...values])).slice(0, 24).toUpperCase()}`;
}

function baseRecoverySession({
  childRunId,
  recoveredFrom,
  recoveryKind,
  recoveryRel,
  recoverySha256,
  bindingGeneration,
  rootDigest,
  scope,
  sourceSession,
}) {
  return {
    run_id: childRunId,
    started_at: null,
    ended_at: null,
    turns: 0,
    ...inheritGoalScopeState(sourceSession),
    outcome: null,
    superseded_by: null,
    recovered_from: recoveredFrom,
    recovery_kind: recoveryKind,
    recovery_rel: recoveryRel,
    recovery_sha256: recoverySha256,
    recovery_project_binding_generation: bindingGeneration,
    recovery_project_root_digest: rootDigest,
    scope,
  };
}

function exactRecoveryLease(lease, {
  kind,
  childRunId,
  operationId,
  recoveryRel,
  recoverySha256,
  boundaryEvent,
  bindingGeneration,
  rootDigest,
}) {
  return {
    ...lease,
    state: 'released',
    handoff_phase: 'reserved',
    handoff_child_run_id: childRunId,
    handoff_idempotency_key: operationId,
    handoff_trigger: kind,
    expires_at: null,
    resume_policy: 'human',
    takeover_kind: kind,
    recovery_rel: recoveryRel,
    recovery_sha256: recoverySha256,
    recovery_discriminator: operationId,
    ...(boundaryEvent ? {
      handoff_boundary_event: { ...boundaryEvent },
      handoff_project_binding_generation: bindingGeneration,
      handoff_project_root_digest: rootDigest,
    } : {}),
  };
}

function boundedEpisodeContext(loop, workstreamId) {
  return (loop.episodes || [])
    .filter(episode => episode.workstream_id === workstreamId)
    .slice(0, 64)
    .map(episode => ({
      id: episode.id,
      role: episode.role,
      point: episode.point,
      status: episode.status,
      ...(episode.target_maker ? { target_maker: episode.target_maker } : {}),
    }));
}

function boundedArtifactReferences(loop, workstreamId) {
  const values = [];
  for (const episode of (loop.episodes || [])) {
    if (episode.workstream_id !== workstreamId) continue;
    for (const field of ['expected_artifacts', 'artifacts']) {
      if (!Array.isArray(episode[field])) continue;
      for (const value of episode[field]) {
        if (typeof value === 'string' && value.length > 0 && value.length <= 4_096) {
          values.push(value);
        }
      }
    }
  }
  return [...new Set(values)].slice(0, 128);
}

function capsuleEnvelope({
  artifactKind,
  childRunId,
  parentRunId,
  now,
  payload,
  sourceArtifacts,
}) {
  const bytes = Buffer.from(JSON.stringify(wrap({
    producer: 'deep-loop',
    artifact_kind: artifactKind,
    schema: { name: artifactKind, version: '1.0' },
    run_id: childRunId,
    parent_run_id: parentRunId,
    provenance: {
      source_artifacts: sourceArtifacts,
      tool_versions: {},
    },
    payload,
    now: canonicalNow(now),
  }), null, 2));
  if (bytes.length > MAX_CAPSULE_BYTES) throw new Error('RECOVERY_CAPSULE_TOO_LARGE');
  return bytes;
}

function openAffinityState(loop) {
  if (loop.autonomy?.continuation_policy !== 'workstream-session') return null;
  const session = ownerSession(loop);
  const scope = session.scope;
  if (!isOpenScope(scope) || typeof scope.workstream_id !== 'string'
    || scope.workstream_id.length === 0
    || !Number.isSafeInteger(scope.bound_at_seq)
    || scope.bound_at_seq < 1) return null;
  const matches = (loop.workstreams || []).filter(item => item.id === scope.workstream_id);
  if (matches.length !== 1 || !NONTERMINAL_WORKSTREAM.has(matches[0].status)
    || (matches[0].terminal_events !== undefined
      && (!Array.isArray(matches[0].terminal_events) || matches[0].terminal_events.length !== 0))) {
    return null;
  }
  return { session, scope, workstream: matches[0] };
}

function assertAffinitySupersessionReady(loop, {
  expect,
  reason,
  sampleSafetyNow,
  predecessorHash,
}) {
  assertFence(loop, expect);
  assertNoRecoveryInFlight(loop);
  if (loop.autonomy?.continuation_policy !== 'workstream-session') {
    throw new Error('AFFINITY_SUPERSESSION_POLICY_INVALID');
  }
  if (loop.status !== 'paused' || loop.pause_reason !== 'host-session-lost') {
    throw new Error('AFFINITY_SUPERSESSION_PAUSE_INVALID');
  }
  const lease = loop.session_chain.lease;
  if (!['active'].includes(lease.state)
    || !['idle', 'acquired'].includes(lease.handoff_phase)
    || lease.handoff_child_run_id != null
    || lease.handoff_idempotency_key != null
    || lease.handoff_trigger != null
    || lease.takeover_kind !== null
    || lease.recovery_rel != null
    || lease.recovery_sha256 != null
    || lease.recovery_discriminator != null
    || lease.handoff_boundary_event != null
    || lease.handoff_project_binding_generation != null
    || lease.handoff_project_root_digest != null
    || openScopeSessions(loop).length !== 1) {
    throw new Error('AFFINITY_SUPERSESSION_PHASE_INVALID');
  }
  const affinity = openAffinityState(loop);
  if (!affinity || affinity.session.run_id !== expect.owner) {
    throw new Error('AFFINITY_SUPERSESSION_REQUIRED');
  }
  if (sampleSafetyNow) {
    const safety = recoverySafetyReason(loop, sampleSafetyNow());
    if (safety) throw new Error(safety);
  }
  assertReason(reason);
  if (contentHash(JSON.stringify(loop, null, 2)) !== predecessorHash) {
    throw new Error('RECOVERY_SNAPSHOT_STALE');
  }
  return affinity;
}

export function supersedeAffinity(root, runId, {
  reason,
  confirm,
  expect,
  now,
  clock = Date.now,
  publicationFaultAt = () => {},
  durableWriteFn,
} = {}) {
  if (confirm !== true) throw new Error('CONFIRM_REQUIRED: pass --confirm (human-only)');
  assertReason(reason);
  const snapshot = captureReconciledRunSnapshot(root, runId);
  const loop = snapshot.data;
  assertAffinitySupersessionReady(loop, {
    expect,
    reason,
    predecessorHash: snapshot.hash,
  });
  const affinity = openAffinityState(loop);
  const runtime = sessionRuntime(loop);
  const rootDigest = projectRootDigest(loop.project.root);
  const childRunId = recoveryChildId('deep-loop-affinity-recovery-child-v1', [
    runId,
    affinity.workstream.id,
    affinity.scope.bound_at_seq,
    snapshot.hash,
  ]);
  const operationId = contentHash(JSON.stringify([
    'deep-loop-affinity-supersession-v1',
    runId,
    affinity.workstream.id,
    affinity.scope.bound_at_seq,
    childRunId,
    snapshot.hash,
  ]));
  const recoveryRel = `recoveries/${childRunId}-affinity-recovery.json`;
  const descriptor = buildRecoveryResumeDescriptor({
    kind: 'affinity-supersession',
    runtime,
    root: loop.project.root,
    runId,
    childRunId,
    recoveryRel,
    generation: loop.session_chain.lease.generation,
  });
  const capsuleNow = now === undefined ? loop.updated_at : now;
  const capsule = capsuleEnvelope({
    artifactKind: 'affinity-recovery',
    childRunId,
    parentRunId: expect.owner,
    now: capsuleNow,
    sourceArtifacts: boundedArtifactReferences(loop, affinity.workstream.id),
    payload: {
      operation_id: operationId,
      recovery_kind: 'affinity-supersession',
      runtime,
      parent_session_id: expect.owner,
      child_session_id: childRunId,
      lease_generation: loop.session_chain.lease.generation,
      expected_next_generation: loop.session_chain.lease.generation + 1,
      project_root_digest: rootDigest,
      project_binding_generation: loop.project.binding_generation,
      workstream_id: affinity.workstream.id,
      bound_at_seq: affinity.scope.bound_at_seq,
      parent_loop_hash: snapshot.hash,
      pause_reason: 'host-session-lost',
      reason,
      current_episode: loop.current_episode ?? null,
      episodes: boundedEpisodeContext(loop, affinity.workstream.id),
      resume_command: descriptor.acquireInvocation,
    },
  });
  const recoverySha256 = contentHash(capsule);
  const topology = {
    operation_id: operationId,
    recovery_kind: 'affinity-supersession',
    parent_session_id: expect.owner,
    child_session_id: childRunId,
    workstream_id: affinity.workstream.id,
    bound_at_seq: affinity.scope.bound_at_seq,
    project_binding_generation: loop.project.binding_generation,
    project_root_digest: rootDigest,
    recovery_rel: recoveryRel,
    recovery_sha256: recoverySha256,
  };
  let lockedNow;
  const sampleSafetyNow = () => {
    const safetyNow = lockedSafetyTime(clock, 'affinity supersession safety');
    lockedNow = operationTime(now, safetyNow, 'affinity supersession');
    return safetyNow;
  };

  appendAnchored(root, runId, {
    type: 'affinity-superseded',
    data: {
      reason,
      workstream_id: affinity.workstream.id,
      child_run_id: childRunId,
    },
    now,
  }, candidate => {
    const current = ownerSession(candidate);
    supersedeScope(current.scope, {
      reason,
      supersededBy: childRunId,
      now: lockedNow,
    });
    current.superseded_by = childRunId;
    candidate.session_chain.sessions.push(baseRecoverySession({
      childRunId,
      recoveredFrom: current.run_id,
      sourceSession: current,
      recoveryKind: 'affinity-supersession',
      recoveryRel,
      recoverySha256,
      bindingGeneration: candidate.project.binding_generation,
      rootDigest,
      scope: {
        kind: 'workstream',
        workstream_id: affinity.workstream.id,
        bound_at_seq: affinity.scope.bound_at_seq,
        terminal_event: null,
        closed_at: null,
        superseded_at: null,
      },
    }));
    candidate.session_chain.lease = exactRecoveryLease(candidate.session_chain.lease, {
      kind: 'affinity-supersession',
      childRunId,
      operationId,
      recoveryRel,
      recoverySha256,
      bindingGeneration: candidate.project.binding_generation,
      rootDigest,
    });
    candidate.status = 'paused';
    candidate.pause_reason = 'host-session-lost';
  }, candidate => {
    assertAffinitySupersessionReady(candidate, {
      expect,
      reason,
      sampleSafetyNow,
      predecessorHash: snapshot.hash,
    });
  }, {
    publication: {
      kind: 'affinity-supersession',
      operationId,
      artifacts: [{ rel: recoveryRel, bytes: capsule }],
      topology,
      faultAt: publicationFaultAt,
      durableWriteFn,
      nowFn: () => lockedNow,
    },
  });

  return {
    ok: true,
    recovery_kind: 'affinity-supersession',
    child_run_id: childRunId,
    recovery_rel: recoveryRel,
    recovery_sha256: recoverySha256,
    resume_command: descriptor.acquireInvocation,
  };
}

function boundaryWorkstream(loop, parent, boundaryEvent) {
  const matches = (loop.workstreams || []).filter(
    workstream => workstream.id === parent.scope?.workstream_id,
  );
  if (matches.length !== 1
    || !['ready', 'merged', 'abandoned'].includes(matches[0].status)
    || !Array.isArray(matches[0].terminal_events)
    || matches[0].terminal_events.filter(
      event => sameBoundaryIdentity(event, boundaryEvent),
    ).length !== 1) return null;
  return matches[0];
}

function closedParent(loop, session, boundaryEvent) {
  return session?.scope?.kind === 'workstream'
    && session.scope.closed_at !== null
    && exactBoundaryIdentity(session.scope.terminal_event)
    && sameBoundaryIdentity(session.scope.terminal_event, boundaryEvent)
    && boundaryWorkstream(loop, session, boundaryEvent)
    ? session
    : null;
}

function boundaryRecoverySource(loop) {
  const lease = loop.session_chain?.lease || {};
  const sessions = loop.session_chain?.sessions || [];
  const owner = sessions.find(session => session.run_id === lease.owner_run_id);
  if (!owner) return null;

  if (lease.handoff_phase === 'reserved') {
    const staleId = lease.handoff_child_run_id;
    const boundaryEvent = lease.handoff_boundary_event;
    if (typeof staleId !== 'string' || sessions.some(session => session.run_id === staleId)
      || lease.state !== 'active'
      || ![null, 'boundary-handoff'].includes(lease.takeover_kind)
      || !exactBoundaryIdentity(boundaryEvent)
      || lease.handoff_project_binding_generation !== loop.project?.binding_generation
      || lease.handoff_project_root_digest !== projectRootDigest(loop.project?.root)
      || !closedParent(loop, owner, boundaryEvent)
      || owner.superseded_by !== null
      || owner.scope.superseded_at !== null) return null;
    return {
      stalePhase: 'reserved',
      staleSessionId: staleId,
      staleSession: null,
      parent: owner,
      boundaryEvent,
    };
  }

  if (['emitted', 'spawned'].includes(lease.handoff_phase)) {
    const stale = sessions.find(session => session.run_id === lease.handoff_child_run_id);
    const boundaryEvent = lease.handoff_boundary_event;
    const parent = stale && sessions.find(session => session.run_id === stale.parent_run_id);
    if (lease.state !== 'releasing'
      || lease.takeover_kind !== 'boundary-handoff'
      || owner !== parent
      || !stale
      || stale.started_at !== null
      || stale.ended_at !== null
      || stale.outcome !== null
      || stale.superseded_by !== null
      || !isOpenScope(stale.scope)
      || stale.scope.workstream_id !== null
      || stale.scope.bound_at_seq !== null
      || !exactBoundaryIdentity(boundaryEvent)
      || !closedParent(loop, parent, boundaryEvent)
      || parent.superseded_by !== stale.run_id
      || !sameBoundaryIdentity(stale.parent_boundary_event, boundaryEvent)
      || stale.project_binding_generation !== loop.project?.binding_generation
      || stale.project_root_digest !== projectRootDigest(loop.project?.root)
      || lease.handoff_project_binding_generation !== loop.project?.binding_generation
      || lease.handoff_project_root_digest !== projectRootDigest(loop.project?.root)) return null;
    return {
      stalePhase: lease.handoff_phase,
      staleSessionId: stale.run_id,
      staleSession: stale,
      parent,
      boundaryEvent,
    };
  }

  if (lease.handoff_phase === 'acquired') {
    const stale = owner;
    const parent = sessions.find(session => session.run_id === stale.parent_run_id);
    const boundaryEvent = stale.parent_boundary_event;
    if (lease.state !== 'active'
      || lease.takeover_kind !== null
      || stale.started_at === null
      || stale.ended_at !== null
      || stale.outcome !== null
      || stale.superseded_by !== null
      || !isOpenScope(stale.scope)
      || stale.scope.workstream_id !== null
      || stale.scope.bound_at_seq !== null
      || !closedParent(loop, parent, boundaryEvent)
      || parent.superseded_by !== stale.run_id
      || stale.project_binding_generation !== loop.project?.binding_generation
      || stale.project_root_digest !== projectRootDigest(loop.project?.root)) return null;
    return {
      stalePhase: 'acquired',
      staleSessionId: stale.run_id,
      staleSession: stale,
      parent,
      boundaryEvent,
    };
  }
  return null;
}

function assertBoundaryRecoveryReady(loop, {
  expect,
  sampleSafetyNow,
  predecessorHash,
}) {
  assertFence(loop, expect);
  assertNoRecoveryInFlight(loop);
  if (loop.autonomy?.continuation_policy !== 'workstream-session') {
    throw new Error('BOUNDARY_RECOVERY_POLICY_INVALID');
  }
  if (loop.status !== 'paused') {
    throw new Error(`NOT_RECOVERABLE: status is ${loop.status}, expected paused`);
  }
  const affinity = openAffinityState(loop);
  if (affinity) throw new Error('AFFINITY_SUPERSESSION_REQUIRED');
  const source = boundaryRecoverySource(loop);
  if (!source || openScopeSessions(loop).some(session => session !== source.staleSession)) {
    throw new Error('BOUNDARY_RECOVERY_PHASE_INVALID');
  }
  if (sampleSafetyNow) {
    const safety = recoverySafetyReason(loop, sampleSafetyNow());
    if (safety) throw new Error(safety);
  }
  if (contentHash(JSON.stringify(loop, null, 2)) !== predecessorHash) {
    throw new Error('RECOVERY_SNAPSHOT_STALE');
  }
  return source;
}

export function recoverBoundary(root, runId, {
  confirm,
  expect,
  now,
  clock = Date.now,
  publicationFaultAt = () => {},
  durableWriteFn,
} = {}) {
  if (confirm !== true) throw new Error('CONFIRM_REQUIRED: pass --confirm (human-only)');
  const snapshot = captureReconciledRunSnapshot(root, runId);
  const loop = snapshot.data;
  const source = assertBoundaryRecoveryReady(loop, {
    expect,
    predecessorHash: snapshot.hash,
  });
  const runtime = sessionRuntime(loop);
  const rootDigest = projectRootDigest(loop.project.root);
  const replacementSessionId = recoveryChildId('deep-loop-boundary-recovery-child-v1', [
    runId,
    source.boundaryEvent.seq,
    source.boundaryEvent.checksum,
    source.stalePhase,
    source.staleSessionId,
    snapshot.hash,
  ]);
  const operationId = contentHash(JSON.stringify([
    'deep-loop-boundary-recovery-v1',
    runId,
    source.boundaryEvent.seq,
    source.boundaryEvent.checksum,
    source.stalePhase,
    source.staleSessionId,
    replacementSessionId,
    snapshot.hash,
  ]));
  const recoveryRel = `recoveries/${replacementSessionId}-boundary-recovery.json`;
  const descriptor = buildRecoveryResumeDescriptor({
    kind: 'boundary-recovery',
    runtime,
    root: loop.project.root,
    runId,
    childRunId: replacementSessionId,
    recoveryRel,
    generation: loop.session_chain.lease.generation,
  });
  const capsuleNow = now === undefined ? loop.updated_at : now;
  const capsule = capsuleEnvelope({
    artifactKind: 'boundary-recovery',
    childRunId: replacementSessionId,
    parentRunId: source.parent.run_id,
    now: capsuleNow,
    sourceArtifacts: [],
    payload: {
      operation_id: operationId,
      recovery_kind: 'boundary-recovery',
      runtime,
      boundary_event: { ...source.boundaryEvent },
      stale_phase: source.stalePhase,
      stale_session_id: source.staleSessionId,
      replacement_session_id: replacementSessionId,
      parent_session_id: source.parent.run_id,
      lease_generation: loop.session_chain.lease.generation,
      expected_next_generation: loop.session_chain.lease.generation + 1,
      project_root_digest: rootDigest,
      project_binding_generation: loop.project.binding_generation,
      parent_loop_hash: snapshot.hash,
      resume_command: descriptor.acquireInvocation,
    },
  });
  const recoverySha256 = contentHash(capsule);
  const topology = {
    operation_id: operationId,
    recovery_kind: 'boundary-recovery',
    boundary_event: { ...source.boundaryEvent },
    stale_phase: source.stalePhase,
    stale_session_id: source.staleSessionId,
    replacement_session_id: replacementSessionId,
    parent_session_id: source.parent.run_id,
    project_binding_generation: loop.project.binding_generation,
    project_root_digest: rootDigest,
    recovery_rel: recoveryRel,
    recovery_sha256: recoverySha256,
  };
  let lockedNow;
  const sampleSafetyNow = () => {
    const safetyNow = lockedSafetyTime(clock, 'boundary recovery safety');
    lockedNow = operationTime(now, safetyNow, 'boundary recovery');
    return safetyNow;
  };

  appendAnchored(root, runId, {
    type: 'boundary-recovered',
    data: {
      operation_id: operationId,
      boundary_event: { ...source.boundaryEvent },
      stale_phase: source.stalePhase,
      stale_session_id: source.staleSessionId,
      replacement_session_id: replacementSessionId,
      parent_session_id: source.parent.run_id,
    },
    now,
  }, candidate => {
    const iso = canonicalNow(lockedNow);
    const sessions = candidate.session_chain.sessions;
    const parent = sessions.find(session => session.run_id === source.parent.run_id);
    let stale = sessions.find(session => session.run_id === source.staleSessionId);
    if (source.stalePhase === 'reserved') {
      parent.superseded_by = source.staleSessionId;
      parent.scope.superseded_at = iso;
      stale = {
        run_id: source.staleSessionId,
        started_at: null,
        ended_at: iso,
        turns: 0,
        ...inheritGoalScopeState(parent),
        outcome: 'abandoned_recover',
        superseded_by: replacementSessionId,
        parent_run_id: parent.run_id,
        parent_boundary_event: { ...source.boundaryEvent },
        project_binding_generation: candidate.project.binding_generation,
        project_root_digest: rootDigest,
        scope: {
          kind: 'workstream',
          workstream_id: null,
          bound_at_seq: null,
          terminal_event: null,
          closed_at: null,
          superseded_at: iso,
          supersede_reason: 'boundary-recovery',
          superseded_by: replacementSessionId,
        },
      };
      sessions.push(stale);
    } else {
      stale.ended_at = iso;
      stale.outcome = 'abandoned_recover';
      stale.superseded_by = replacementSessionId;
      supersedeScope(stale.scope, {
        reason: 'boundary-recovery',
        supersededBy: replacementSessionId,
        now: lockedNow,
      });
    }
    sessions.push(baseRecoverySession({
      childRunId: replacementSessionId,
      recoveredFrom: stale.run_id,
      sourceSession: stale,
      recoveryKind: 'boundary-recovery',
      recoveryRel,
      recoverySha256,
      bindingGeneration: candidate.project.binding_generation,
      rootDigest,
      scope: {
        kind: 'workstream',
        workstream_id: null,
        bound_at_seq: null,
        terminal_event: null,
        closed_at: null,
        superseded_at: null,
      },
    }));
    candidate.session_chain.lease = exactRecoveryLease(candidate.session_chain.lease, {
      kind: 'boundary-recovery',
      childRunId: replacementSessionId,
      operationId,
      recoveryRel,
      recoverySha256,
      boundaryEvent: source.boundaryEvent,
      bindingGeneration: candidate.project.binding_generation,
      rootDigest,
    });
    candidate.status = 'paused';
    candidate.pause_reason = 'recovery:boundary-recovery';
  }, candidate => {
    assertBoundaryRecoveryReady(candidate, {
      expect,
      sampleSafetyNow,
      predecessorHash: snapshot.hash,
    });
  }, {
    publication: {
      kind: 'boundary-recovery',
      operationId,
      artifacts: [{ rel: recoveryRel, bytes: capsule }],
      topology,
      faultAt: publicationFaultAt,
      durableWriteFn,
      nowFn: () => lockedNow,
    },
  });

  return {
    ok: true,
    recovery_kind: 'boundary-recovery',
    operation_id: operationId,
    child_run_id: replacementSessionId,
    stale_phase: source.stalePhase,
    stale_session_id: source.staleSessionId,
    parent_session_id: source.parent.run_id,
    boundary_event: { ...source.boundaryEvent },
    recovery_rel: recoveryRel,
    recovery_sha256: recoverySha256,
    resume_command: descriptor.acquireInvocation,
  };
}

function legacyRecover(root, runId, {
  expect,
  now,
}) {
  const mutate = (loop) => {
    const lease = loop.session_chain.lease;
    const childId = lease.handoff_child_run_id;
    if (childId) {
      const child = loop.session_chain.sessions.find(s => s.run_id === childId);
      if (child && !child.outcome) child.outcome = 'abandoned_recover';
      const parent = loop.session_chain.sessions.find(s => s.superseded_by === childId);
      if (parent) parent.superseded_by = null;
    }
    lease.handoff_child_run_id = null;
    lease.handoff_idempotency_key = null;
    lease.handoff_trigger = null;
    lease.handoff_phase = 'idle';
    lease.state = 'released';
    lease.expires_at = null;
    lease.resume_policy = null;
    loop.pause_reason = 'recovered:awaiting-resume';
  };
  appendAnchored(root, runId, {
    type: 'run-recovered',
    data: {},
    now,
  }, mutate, loop => {
    assertFence(loop, expect);
    assertNoRecoveryInFlight(loop);
    if (loop.status !== 'paused') {
      throw new Error(`NOT_RECOVERABLE: status is ${loop.status}, expected paused`);
    }
    if (loop.autonomy?.continuation_policy === 'workstream-session') {
      if (openAffinityState(loop)) throw new Error('AFFINITY_SUPERSESSION_REQUIRED');
      if (boundaryRecoverySource(loop)) throw new Error('BOUNDARY_RECOVERY_REQUIRED');
    }
  });
  return {
    ok: true,
    status: 'paused',
    pause_reason: 'recovered:awaiting-resume',
  };
}

export function recoverRun(root, runId, {
  expect,
  confirm,
  now,
  clock = Date.now,
} = {}) {
  if (confirm !== true) throw new Error('CONFIRM_REQUIRED: pass --confirm (human-only)');
  const { data: snapshot } = captureReconciledRunSnapshot(root, runId);
  if (snapshot.status !== 'paused') {
    throw new Error(`NOT_RECOVERABLE: status is ${snapshot.status}, expected paused`);
  }
  assertNoRecoveryInFlight(snapshot);
  if (snapshot.autonomy?.continuation_policy !== 'workstream-session') {
    return legacyRecover(root, runId, { expect, now });
  }
  if (openAffinityState(snapshot)) {
    throw new Error('AFFINITY_SUPERSESSION_REQUIRED');
  }
  return recoverBoundary(root, runId, { confirm, expect, now, clock });
}

// Human approval resumes the existing owner; it grants no completion or review credit.
export function resumeSameOwner(root, runId, {
  expect, confirm, reason, now, clock = Date.now,
} = {}) {
  if (confirm !== true) throw new Error('CONFIRM_REQUIRED: pass --confirm (human-only)');
  assertReason(reason);
  const event = { type: 'same-owner-resumed', data: { reason }, now };
  appendAnchored(root, runId, event, loop => {
    loop.status = 'running';
    loop.pause_reason = null;
    loop.session_chain.lease.resume_policy = null;
  }, loop => {
    assertFence(loop, expect);
    assertNoRecoveryInFlight(loop);
    const lease = loop.session_chain.lease;
    if (loop.status !== 'paused' || !loop.pause_reason?.startsWith('needs-human:')) {
      throw new Error('SAME_OWNER_PAUSE_INVALID');
    }
    if (lease.state !== 'active' || !['idle', 'acquired'].includes(lease.handoff_phase)
      || lease.resume_policy !== 'human'
      || ['handoff_child_run_id', 'handoff_idempotency_key', 'handoff_trigger',
        'takeover_kind', 'recovery_rel', 'recovery_sha256', 'recovery_discriminator',
        'handoff_boundary_event', 'handoff_project_binding_generation',
        'handoff_project_root_digest'].some(key => lease[key] != null)) {
      throw new Error('SAME_OWNER_LEASE_INVALID');
    }
    const affinity = openAffinityState(loop);
    if (!affinity || affinity.session.run_id !== expect.owner || openScopeSessions(loop).length !== 1) {
      throw new Error('SAME_OWNER_AFFINITY_REQUIRED');
    }
    const blocked = recoverySafetyReason(loop, lockedSafetyTime(clock, 'same-owner resume'));
    if (blocked) throw new Error(blocked);
    event.data.previous_pause_reason = loop.pause_reason;
    event.data.owner = expect.owner;
    event.data.generation = expect.generation;
  });
  return { ok: true, status: 'running', owner: expect.owner, generation: expect.generation };
}

function recoveryArtifactBytesLocked(root, runId, rel, guard) {
  const normalized = normalizePortableRelativePath(rel);
  if (normalized !== rel || !normalized?.startsWith('recoveries/')) {
    throw new Error('RECOVERY_CAPSULE_INVALID');
  }
  const dir = resolve((realpathSync.native || realpathSync)(runDir(root, runId)));
  const path = resolve(dir, ...normalized.split('/'));
  const contained = relative(dir, path);
  if (!contained || contained.startsWith('..') || isAbsolute(contained)) {
    throw new Error('RECOVERY_CAPSULE_INVALID');
  }
  guard.assertOwned();
  if (!existsSync(path)) throw new Error('RECOVERY_CAPSULE_INVALID');
  const before = captureStableFileIdentity(path);
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > BigInt(MAX_CAPSULE_BYTES)) {
    throw new Error('RECOVERY_CAPSULE_INVALID');
  }
  if (resolve((realpathSync.native || realpathSync)(path)) !== path) {
    throw new Error('RECOVERY_CAPSULE_INVALID');
  }
  const bytes = readFileSync(path);
  const after = captureStableFileIdentity(path);
  guard.assertOwned();
  if (!matchingStableFileIdentity(before, after) || bytes.length > MAX_CAPSULE_BYTES) {
    throw new Error('RECOVERY_CAPSULE_INVALID');
  }
  return bytes;
}

function exactAffinityCapsule(loop, child, bytes) {
  if (contentHash(bytes) !== child.recovery_sha256) return null;
  let env;
  try {
    env = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  const opened = unwrap(env, {
    producer: 'deep-loop',
    artifact_kind: 'affinity-recovery',
  });
  const payload = opened?.payload;
  const predecessor = (loop.session_chain.sessions || [])
    .find(session => session.run_id === child.recovered_from);
  if (!opened
    || opened.envelope.run_id !== child.run_id
    || opened.envelope.parent_run_id !== child.recovered_from
    || payload?.recovery_kind !== 'affinity-supersession'
    || payload.operation_id !== loop.session_chain.lease.handoff_idempotency_key
    || payload.runtime !== sessionRuntime(loop)
    || payload.parent_session_id !== child.recovered_from
    || payload.child_session_id !== child.run_id
    || payload.lease_generation !== loop.session_chain.lease.generation
    || payload.expected_next_generation !== loop.session_chain.lease.generation + 1
    || payload.project_root_digest !== projectRootDigest(loop.project.root)
    || payload.project_binding_generation !== loop.project.binding_generation
    || payload.workstream_id !== child.scope.workstream_id
    || payload.bound_at_seq !== child.scope.bound_at_seq
    || child.recovery_project_root_digest !== payload.project_root_digest
    || child.recovery_project_binding_generation !== payload.project_binding_generation
    || predecessor?.scope?.superseded_by !== child.run_id) return null;
  return payload;
}

function validateAffinityEvent(root, runId, loop, child, payload) {
  const verified = verifyLog(root, runId);
  if (!verified.ok) throw new Error(`LOG_TAMPERED: ${verified.errors.join('; ')}`);
  const head = verifyHead(root, runId, loop.event_log_head);
  if (!head.ok) throw new Error(`LOG_TAMPERED: ${head.errors.join('; ')}`);
  const events = readLines(root, runId).filter(event => event.type === 'affinity-superseded'
    && event.data?.child_run_id === child.run_id);
  if (events.length !== 1
    || events[0].data?.reason !== payload.reason
    || events[0].data?.workstream_id !== payload.workstream_id) {
    throw new Error('RECOVERY_CAPSULE_INVALID');
  }
}

function clearRecoveryLease(lease, owner, generation, iso) {
  const cleared = {
    ...lease,
    owner_run_id: owner,
    generation,
    acquired_at: iso,
    expires_at: null,
    state: 'active',
    handoff_phase: 'acquired',
    handoff_idempotency_key: null,
    handoff_child_run_id: null,
    handoff_trigger: null,
    takeover_kind: null,
    resume_policy: null,
  };
  for (const key of [
    'recovery_rel',
    'recovery_sha256',
    'recovery_discriminator',
    'handoff_boundary_event',
    'handoff_project_binding_generation',
    'handoff_project_root_digest',
  ]) delete cleared[key];
  return cleared;
}

// spec §3.2: acquireLease 와 동일 구조 — `appendAnchored` 단일 anchored 트랜잭션(중첩 아님, 불변식 #7),
// §2.1 검증은 preCheck, 상태 변경은 mutate, 비진행은 sentinel. 이 함수의 거부는 **이미 전부 throw** 이므로
// sentinel 로 바꿀 비진행 return 은 preserved-safety 한 곳뿐이고, 진짜 위험은 아래 catch 가 그 8개 거부
// 경로(에러 신원 10종)를 삼키는 것이다 — 판별식이 그것을 막는다.
export function acquireRecovery(root, runId, {
  capsuleRel,
  owner,
  expectGeneration,
  runtime,
  now,
  clock = Date.now,
  platform = process.platform,
  __testPreCheckSeam,
} = {}) {
  if (typeof capsuleRel !== 'string' || capsuleRel.length === 0
    || typeof owner !== 'string' || owner.length === 0
    || !Number.isSafeInteger(expectGeneration) || expectGeneration < 1
    || typeof runtime !== 'string' || runtime.length === 0) {
    throw new Error('RECOVERY_ACQUIRE_INPUT_INVALID');
  }
  let plan = null;
  let outcome = null;
  const appendOptions = {};
  if (__testPreCheckSeam) appendOptions.preCheckSeam = __testPreCheckSeam;

  const preCheck = (loop, ctx) => {
    const runtimeResult = runtimeFence(loop, runtime);
    if (!runtimeResult.ok) throw new Error('RUNTIME_FENCED: recovery runtime mismatch');
    const lease = loop.session_chain?.lease || {};
    if (!runtimeCapability(runtime, 'supported_platforms').includes(platform)) {
      throw acquireHalt(contractFields({
        ok: false,
        reason: 'UNSUPPORTED_RUNTIME_PLATFORM',
        generation: lease.generation,
      }));
    }
    if (lease.generation !== expectGeneration) {
      throw new Error('LEASE_FENCED: generation-mismatch');
    }
    if (lease.takeover_kind !== 'affinity-supersession') {
      throw new Error('RECOVERY_ACQUIRE_STATUS_INVALID');
    }
    if (lease.handoff_child_run_id !== owner) {
      throw new Error('LEASE_FENCED: recovery-child-mismatch');
    }
    if (recoveryReservationKind(loop) !== 'affinity-supersession') {
      throw new Error('LEASE_FENCED: recovery-topology-invalid');
    }
    const child = loop.session_chain.sessions.find(session => session.run_id === owner);
    if (!child || child.recovery_rel !== capsuleRel
      || lease.recovery_rel !== capsuleRel
      || lease.recovery_sha256 !== child.recovery_sha256
      || child.recovery_project_root_digest !== projectRootDigest(loop.project.root)
      || child.recovery_project_binding_generation !== loop.project.binding_generation) {
      throw new Error('LEASE_FENCED: recovery-reservation-mismatch');
    }
    // ctx.guard — preCheck 은 이미 lock 을 보유한다(§3.2 노트 6). lock 밖 읽기는 `…Locked` 계약 파기다.
    const bytes = recoveryArtifactBytesLocked(root, runId, capsuleRel, ctx?.guard);
    const payload = exactAffinityCapsule(loop, child, bytes);
    if (!payload) throw new Error('RECOVERY_CAPSULE_INVALID');
    validateAffinityEvent(root, runId, loop, child, payload);
    const safetyNow = lockedSafetyTime(clock, 'recovery acquire safety');
    const lockedNow = operationTime(now, safetyNow, 'recovery acquire');
    const safety = recoverySafetyReason(loop, safetyNow);
    if (safety) {
      throw acquireHalt(contractFields({
        ok: false,
        generation: lease.generation,
        reason: safety,
        preserved: true,
      }));
    }
    plan = { iso: canonicalNow(lockedNow, 'recovery acquire') };
  };

  const mutate = (loop) => {
    const lease = loop.session_chain.lease;
    const child = loop.session_chain.sessions.find(session => session.run_id === owner);
    const receipt = buildAcquisitionReceipt({
      takeoverKind: 'affinity-supersession',
      childRunId: owner,
      supersededOwnerRunId: lease.owner_run_id,
      boundaryEvent: null,
      projectRootDigest: child?.recovery_project_root_digest ?? null,
      projectBindingGeneration: child?.recovery_project_binding_generation ?? null,
      handoffRel: null,
      reservationKey: lease.recovery_discriminator ?? lease.handoff_idempotency_key ?? null,
      fromGeneration: expectGeneration,
      toGeneration: expectGeneration + 1,
      at: plan.iso,
      // §3.6.4: 이 경로는 `--attempt-id` 를 받지도 기록하지도 않는다.
      attemptId: null,
    });
    loop.session_chain.lease = clearRecoveryLease(lease, owner, expectGeneration + 1, plan.iso);
    loop.session_chain.lease.acquisition_receipt = receipt;
    loop.status = 'running';
    loop.pause_reason = null;
    child.started_at = plan.iso;
    const parent = loop.session_chain.sessions.find(session => session.run_id === child.recovered_from);
    if (parent) parent.outcome = 'took_over';
    outcome = contractFields(
      { ok: true, generation: expectGeneration + 1, reason: 'acquired' },
      { consumed: consumedFromReceipt(receipt) },
    );
  };

  try {
    appendAnchored(root, runId, {
      type: 'lease-acquired',
      data: {
        owner,
        from_generation: expectGeneration,
        to_generation: expectGeneration + 1,
        attempt_id: null,
      },
      now,
    }, mutate, preCheck, appendOptions);
  } catch (e) {
    // 판별 필수 — 없으면 위 8개 거부 경로(RUNTIME_FENCED·LEASE_FENCED×4 는 exit 3)와 appendAnchored 자신의
    // fail-stop(STATE_TAMPERED / LOG_TAMPERED / RUN_TERMINAL)이 반환 객체로 강등된다.
    if (e?.message !== ACQUIRE_HALT) throw e;
    return e.payload;
  }
  return outcome;
}

export function validateBoundaryRecoveryArtifactLocked(root, runId, loop, child, guard) {
  const bytes = recoveryArtifactBytesLocked(root, runId, child.recovery_rel, guard);
  if (contentHash(bytes) !== child.recovery_sha256) {
    throw new Error('RECOVERY_CAPSULE_INVALID');
  }
  let opened;
  try {
    opened = unwrap(JSON.parse(bytes.toString('utf8')), {
      producer: 'deep-loop',
      artifact_kind: 'boundary-recovery',
    });
  } catch {
    opened = null;
  }
  const payload = opened?.payload;
  const lease = loop.session_chain.lease;
  if (!opened
    || opened.envelope.run_id !== child.run_id
    || payload?.operation_id !== lease.handoff_idempotency_key
    || payload.recovery_kind !== 'boundary-recovery'
    || payload.runtime !== sessionRuntime(loop)
    || payload.replacement_session_id !== child.run_id
    || payload.stale_session_id !== child.recovered_from
    || payload.lease_generation !== lease.generation
    || payload.expected_next_generation !== lease.generation + 1
    || payload.project_root_digest !== projectRootDigest(loop.project.root)
    || payload.project_binding_generation !== loop.project.binding_generation
    || child.recovery_project_root_digest !== payload.project_root_digest
    || child.recovery_project_binding_generation !== payload.project_binding_generation
    || !sameBoundaryIdentity(payload.boundary_event, lease.handoff_boundary_event)) {
    throw new Error('RECOVERY_CAPSULE_INVALID');
  }
  const events = readLines(root, runId).filter(event => event.type === 'boundary-recovered'
    && event.data?.operation_id === payload.operation_id);
  if (events.length !== 1
    || JSON.stringify(events[0].data) !== JSON.stringify({
      operation_id: payload.operation_id,
      boundary_event: payload.boundary_event,
      stale_phase: payload.stale_phase,
      stale_session_id: payload.stale_session_id,
      replacement_session_id: payload.replacement_session_id,
      parent_session_id: payload.parent_session_id,
    })) {
    throw new Error('RECOVERY_CAPSULE_INVALID');
  }
  return payload;
}

export { clearRecoveryLease, recoverySafetyReason };
