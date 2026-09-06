import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { appendAnchored, MUTATION_TURN_FLOOR } from './integrity.mjs';
import { captureReconciledRunSnapshot, runDir } from './state.mjs';
import { leaseCheck } from './lease.mjs';
import { wrap, contentHash } from './envelope.mjs';
import { containedRealFile } from './fs-safe.mjs';
import { isGoalDriven, exactGoalObject, boundedGoalText, goalRequirementIds, GOAL_ID } from './goal-contract.mjs';
import { createExecutionRecord, transitionAttempt, attemptIsQuiescent, isAttemptObservation } from './attempt-state.mjs';
import { captureGoalSnapshot, snapshotEvidenceRefs } from './goal-snapshot.mjs';
import { ordinaryFinishProofState, workstreamClosureProofState } from './finish.mjs';
import { checkBudget } from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import { runtimeCapability, sessionRuntime } from './runtime.mjs';
import { isHeadlessInvocation } from './respawn.mjs';
import { ownerSession } from './session-scope.mjs';

export const GOAL_RESULT_MAX_BYTES = 1048576;
const SHA256 = /^[0-9a-f]{64}$/;
const RESULT_KEYS = ['schema_version', 'review_id', 'attempt_id', 'goal_sha256', 'snapshot_sha256', 'verdict', 'requirements', 'report_body'];
const completedWs = ws => ws.status === 'ready' || ws.status === 'merged';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function goalFence(loop, fence) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: goal');
  const checked = leaseCheck(loop, fence); if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
  if (!isGoalDriven(loop)) throw new Error('GOAL_CONTRACT_REQUIRED');
}

function readArtifact(root, runId, rel, digest, max = 32 * 1024 * 1024) {
  const real = containedRealFile(runDir(root, runId), rel);
  if (!real) throw new Error('GOAL_PROOF_UNAVAILABLE: missing artifact');
  const fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > max) throw new Error('GOAL_PROOF_UNAVAILABLE: artifact bound');
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, null); if (n === 0) break; offset += n;
    }
    const after = fstatSync(fd), pathAfter = lstatSync(real);
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) throw new Error('GOAL_PROOF_UNAVAILABLE: artifact changed');
    bytes = buffer.subarray(0, offset);
  } finally { closeSync(fd); }
  if (contentHash(bytes) !== digest) throw new Error('GOAL_PROOF_UNAVAILABLE: artifact digest mismatch');
  return JSON.parse(bytes.toString('utf8'));
}

function goalArtifact(runId, kind, payload, now, parentRunId = null) {
  return Buffer.from(JSON.stringify(wrap({ producer: 'deep-loop', artifact_kind: kind, schema: { name: kind, version: '1.0' },
    run_id: runId, parent_run_id: parentRunId, payload, now: new Date(now).toISOString() }), null, 2));
}

export function parseGoalResult(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > GOAL_RESULT_MAX_BYTES) throw new Error('GOAL_RESULT_INVALID: bounded UTF-8 JSON required');
  let value; try { value = JSON.parse(raw); } catch { throw new Error('GOAL_RESULT_INVALID: JSON'); }
  if (!exactGoalObject(value, RESULT_KEYS) || value.schema_version !== 1
    || typeof value.review_id !== 'string' || !GOAL_ID.test(value.review_id)
    || typeof value.attempt_id !== 'string' || !GOAL_ID.test(value.attempt_id)
    || typeof value.goal_sha256 !== 'string' || !SHA256.test(value.goal_sha256)
    || typeof value.snapshot_sha256 !== 'string' || !SHA256.test(value.snapshot_sha256)
    || !['APPROVE', 'CONCERN', 'REQUEST_CHANGES'].includes(value.verdict)
    || !boundedGoalText(value.report_body, 262144) || !Array.isArray(value.requirements)
    || value.requirements.length < 1 || value.requirements.length > 64) throw new Error('GOAL_RESULT_INVALID: shape');
  const ids = new Set();
  for (const assessment of value.requirements) {
    if (!exactGoalObject(assessment, ['id', 'status', 'evidence', 'reason']) || typeof assessment.id !== 'string'
      || !GOAL_ID.test(assessment.id) || ids.has(assessment.id) || !['pass', 'fail', 'blocked'].includes(assessment.status)
      || !Array.isArray(assessment.evidence) || assessment.evidence.length > 64
      || assessment.evidence.some(ref => !boundedGoalText(ref, 4096)) || new Set(assessment.evidence).size !== assessment.evidence.length
      || !(assessment.reason === null || boundedGoalText(assessment.reason))) throw new Error('GOAL_RESULT_INVALID: assessment');
    if (assessment.status === 'pass' && assessment.evidence.length === 0) throw new Error('GOAL_RESULT_INVALID: pass needs evidence');
    if (assessment.status !== 'pass' && !boundedGoalText(assessment.reason)) throw new Error('GOAL_RESULT_INVALID: nonpass needs reason');
    ids.add(assessment.id);
  }
  const allPass = value.requirements.every(item => item.status === 'pass');
  if ((value.verdict !== 'REQUEST_CHANGES') !== allPass) throw new Error('GOAL_RESULT_INVALID: contradictory verdict');
  return value;
}

function bindResult(loop, review, result, snapshot) {
  if (result.review_id !== review.id || result.attempt_id !== review.execution.attempt_id
    || result.goal_sha256 !== loop.goal_contract.sha256 || result.goal_sha256 !== review.goal_sha256
    || result.snapshot_sha256 !== review.snapshot_sha256 || snapshot.sha256 !== review.snapshot_sha256) throw new Error('GOAL_RESULT_BINDING_MISMATCH');
  const expected = [...goalRequirementIds(loop)].sort();
  if (!same(result.requirements.map(item => item.id).sort(), expected)) throw new Error('GOAL_RESULT_REQUIREMENTS_MISMATCH');
  const refs = new Set(snapshotEvidenceRefs(snapshot));
  if (result.requirements.some(item => item.evidence.some(ref => !refs.has(ref)))) throw new Error('GOAL_RESULT_EVIDENCE_UNKNOWN');
}

export function goalPrerequisites(loop) {
  const missing = [...ordinaryFinishProofState(loop).missing];
  const mapped = new Set(loop.workstreams.filter(completedWs).flatMap(ws => ws.requirement_ids || []));
  const unmapped = goalRequirementIds(loop).filter(id => !mapped.has(id));
  if (unmapped.length) missing.push('goal-requirements-unmapped');
  const obligations = loop.goal_obligations.filter(item => item.status !== 'resolved').map(item => item.id);
  if (obligations.length) missing.push('goal-obligations-unresolved');
  if (loop.episodes.some(item => item.execution && !attemptIsQuiescent(item.execution))) missing.push('execution-not-quiescent');
  return { ok: missing.length === 0, missing, unmapped_requirement_ids: unmapped, unresolved_obligation_ids: obligations };
}

function assertPrerequisites(loop) {
  const ready = goalPrerequisites(loop);
  if (!ready.ok) throw new Error(`GOAL_PROOF_UNMET: ${ready.missing.join(',')}`);
}

export function goalReviewBoundaryBlocked(loop) {
  if (!isGoalDriven(loop) || loop.orchestration.boundary_mode !== 'handoff') return false;
  const scope = ownerSession(loop).scope;
  return scope?.kind === 'workstream' && scope.closed_at !== null && scope.superseded_at === null;
}

function pendingReview(loop, id, attemptId) {
  const review = loop.goal_reviews.find(item => item.id === id);
  if (!review || review.status !== 'pending' || review.execution.attempt_id !== attemptId) throw new Error('GOAL_REVIEW_ATTEMPT_MISMATCH');
  return review;
}

function readSnapshot(root, runId, review) {
  const artifact = readArtifact(root, runId, review.snapshot_rel, review.snapshot_file_sha256);
  if (artifact.envelope?.producer !== 'deep-loop' || artifact.envelope?.artifact_kind !== 'goal-snapshot'
    || artifact.envelope?.run_id !== runId || artifact.payload?.sha256 !== review.snapshot_sha256) throw new Error('GOAL_PROOF_UNAVAILABLE: snapshot binding');
  return artifact.payload;
}

export function dispatchGoalReview(root, runId, { transport, fence, now = Date.now() } = {}) {
  const before = captureReconciledRunSnapshot(root, runId).data; goalFence(before, fence);
  if (goalReviewBoundaryBlocked(before)) throw new Error('GOAL_BOUNDARY_HANDOFF_REQUIRED');
  if (!runtimeCapability(sessionRuntime(before), 'goal_checker_transports').includes(transport)) throw new Error('GOAL_TRANSPORT_UNAVAILABLE');
  const active = before.goal_reviews.find(item => item.status === 'pending');
  if (active) {
    if (active.transport !== transport) throw new Error('GOAL_REVIEW_TRANSPORT_FROZEN');
    return { ok: true, created: false, review: structuredClone(active) };
  }
  assertPrerequisites(before);
  if (!runtimeCapability(sessionRuntime(before), 'goal_checker_transports').includes(transport)) throw new Error('GOAL_TRANSPORT_UNAVAILABLE');
  const snapshot = captureGoalSnapshot(root, before);
  const id = `goal-${randomUUID()}`, attemptId = randomUUID();
  const snapshotRel = `goal-reviews/${id}/snapshot.json`;
  const bytes = goalArtifact(runId, 'goal-snapshot', snapshot, now, before.session_chain.parent_run_id);
  if (bytes.length > 32 * 1024 * 1024) throw new Error('GOAL_SNAPSHOT_UNAVAILABLE: manifest byte limit');
  const snapshotFileHash = contentHash(bytes);
  const record = { id, transport, goal_sha256: before.goal_contract.sha256, snapshot_sha256: snapshot.sha256,
    snapshot_rel: snapshotRel, snapshot_file_sha256: snapshotFileHash, status: 'pending',
    execution: createExecutionRecord({ attemptId, mode: 'external', stage: 'primary', task: `Independently assess every outcome in goal contract ${before.goal_contract.sha256}`, now }),
    created_at: new Date(now).toISOString(), result_rel: null, result_sha256: null, result_raw_sha256: null, verdict: null, failed_requirement_ids: [] };
  let existing;
  try {
    appendAnchored(root, runId, { type: 'goal-review-dispatched', data: { review_id: id, attempt_id: attemptId, snapshot_sha256: snapshot.sha256 }, now }, loop => {
      loop.goal_reviews.push(record);
    }, loop => {
      goalFence(loop, fence);
      if (goalReviewBoundaryBlocked(loop)) throw new Error('GOAL_BOUNDARY_HANDOFF_REQUIRED');
      const current = loop.goal_reviews.find(item => item.status === 'pending');
      if (current) {
        if (current.transport !== transport) throw new Error('GOAL_REVIEW_TRANSPORT_FROZEN');
        existing = structuredClone(current); throw Object.assign(new Error('GOAL_ALREADY_DISPATCHED'), { activeGoalReview: true });
      }
      if (loop.goal_reviews.length >= 64) throw new Error('GOAL_REVIEW_LIMIT');
      assertPrerequisites(loop);
      if (!checkBudget(loop, { now }).ok || checkBreaker(loop).tripped) throw new Error('GOAL_DISPATCH_GATE_BLOCKED');
      if (!runtimeCapability(sessionRuntime(loop), 'goal_checker_transports').includes(transport)) throw new Error('GOAL_TRANSPORT_UNAVAILABLE');
      if (captureGoalSnapshot(root, loop).sha256 !== snapshot.sha256) throw new Error('GOAL_PROOF_STALE');
    }, { floor: MUTATION_TURN_FLOOR, publication: { kind: 'goal-review-dispatch', operationId: id,
      artifacts: [{ rel: snapshotRel, bytes }], topology: { review_id: id, attempt_id: attemptId,
        snapshot_sha256: snapshot.sha256, artifact_rel: snapshotRel, artifact_sha256: snapshotFileHash } } });
  } catch (error) {
    if (error.activeGoalReview) return { ok: true, created: false, review: existing };
    throw error;
  }
  return { ok: true, created: true, review: structuredClone(record) };
}

export function startGoalReview(root, runId, { id, attemptId, handle, fence, now = Date.now() } = {}) {
  let next;
  appendAnchored(root, runId, { type: 'goal-review-started', data: { review_id: id, attempt_id: attemptId, handle }, now }, loop => {
    loop.goal_reviews.find(item => item.id === id).execution = next;
  }, loop => {
    goalFence(loop, fence); assertPrerequisites(loop);
    const review = pendingReview(loop, id, attemptId);
    if (!checkBudget(loop, { now }).ok || checkBreaker(loop).tripped) throw new Error('GOAL_DISPATCH_GATE_BLOCKED');
    if (captureGoalSnapshot(root, loop).sha256 !== review.snapshot_sha256) throw new Error('GOAL_PROOF_STALE');
    next = transitionAttempt(review.execution, 'start', { handle, now });
  }, { floor: MUTATION_TURN_FLOOR });
  return { ok: true, execution: structuredClone(next) };
}

export function reconcileGoalReview(root, runId, { id, attemptId, observation, fence, now = Date.now() } = {}) {
  let next;
  appendAnchored(root, runId, { type: 'goal-review-reconciled', data: { review_id: id, attempt_id: attemptId, observation }, now }, loop => {
    const review = loop.goal_reviews.find(item => item.id === id);
    review.execution = next;
    if (next.phase === 'blocked' && next.observation?.state === 'failed') review.status = 'unavailable';
  }, loop => {
    goalFence(loop, fence);
    const review = pendingReview(loop, id, attemptId);
    if (!isAttemptObservation(observation) || observation.source !== 'native-task' || review.transport !== 'native') throw new Error('GOAL_OBSERVATION_UNSUPPORTED');
    if (observation.state === 'succeeded' && !SHA256.test(observation.output_sha256 || '')) throw new Error('GOAL_RETURN_DIGEST_REQUIRED');
    const prior = review.execution.observation;
    if (prior?.state === 'succeeded' && (observation.output_sha256 !== prior.output_sha256
      || observation.handle !== prior.handle || !['succeeded', 'failed'].includes(observation.state)
      || (observation.state === 'succeeded' && !same(observation, prior)))) throw new Error('GOAL_RETURN_FROZEN');
    next = transitionAttempt(review.execution, 'reconcile', { observation, now });
  }, { floor: MUTATION_TURN_FLOOR });
  return { ok: true, execution: structuredClone(next) };
}

export function recordGoalReview(root, runId, { raw, fence, now = Date.now() } = {}) {
  const result = parseGoalResult(raw);
  const before = captureReconciledRunSnapshot(root, runId).data;
  const resultRel = `goal-reviews/${result.review_id}/result.json`;
  const bytes = goalArtifact(runId, 'goal-review', { raw_result: raw }, now, before.session_chain.parent_run_id);
  const digest = contentHash(bytes), rawDigest = contentHash(raw);
  let execution;
  appendAnchored(root, runId, { type: 'goal-review-recorded', data: { review_id: result.review_id, attempt_id: result.attempt_id,
    verdict: result.verdict, snapshot_sha256: result.snapshot_sha256, result_sha256: digest }, now }, loop => {
    const review = loop.goal_reviews.find(item => item.id === result.review_id);
    review.execution = execution; review.status = result.verdict === 'REQUEST_CHANGES' ? 'rejected' : 'approved';
    review.verdict = result.verdict; review.result_rel = resultRel; review.result_sha256 = digest; review.result_raw_sha256 = rawDigest;
    review.failed_requirement_ids = result.requirements.filter(item => item.status !== 'pass').map(item => item.id).sort();
  }, loop => {
    goalFence(loop, fence); assertPrerequisites(loop);
    const review = pendingReview(loop, result.review_id, result.attempt_id);
    const snapshot = readSnapshot(root, runId, review);
    bindResult(loop, review, result, snapshot);
    if (captureGoalSnapshot(root, loop).sha256 !== snapshot.sha256) throw new Error('GOAL_PROOF_STALE');
    if (review.execution.phase !== 'running' || review.execution.observation?.state !== 'succeeded') throw new Error('GOAL_RETURN_UNOBSERVED');
    if (review.execution.observation.output_sha256 !== rawDigest) throw new Error('GOAL_RETURN_RAW_MISMATCH');
    execution = transitionAttempt(review.execution, 'return', { observation: review.execution.observation, artifacts: [resultRel], now });
  }, { floor: MUTATION_TURN_FLOOR, publication: { kind: 'goal-review-result', operationId: `${result.review_id}-${rawDigest}`,
    artifacts: [{ rel: resultRel, bytes }], topology: { review_id: result.review_id, attempt_id: result.attempt_id,
      snapshot_sha256: result.snapshot_sha256, artifact_rel: resultRel, artifact_sha256: digest } } });
  return { ok: true, verdict: result.verdict };
}

export function goalProofState(root, loop) {
  if (!isGoalDriven(loop)) return { ok: true, required: false, missing: [], failures: [] };
  const prerequisites = goalPrerequisites(loop);
  const review = loop.goal_reviews.at(-1);
  const base = { ...prerequisites, required: true, failures: [], review_id: review?.id ?? null };
  if (!prerequisites.ok) return { ...base, code: 'GOAL_PROOF_UNMET' };
  if (!review || !['approved', 'rejected'].includes(review.status)) return { ...base, ok: false, missing: ['goal-review-required'], code: 'GOAL_PROOF_REQUIRED' };
  try {
    const snapshot = readSnapshot(root, loop.run_id, review);
    const artifact = readArtifact(root, loop.run_id, review.result_rel, review.result_sha256, 4 * GOAL_RESULT_MAX_BYTES);
    if (artifact.envelope?.producer !== 'deep-loop' || artifact.envelope?.artifact_kind !== 'goal-review'
      || artifact.envelope?.run_id !== loop.run_id || contentHash(artifact.payload?.raw_result || '') !== review.result_raw_sha256) throw new Error('GOAL_PROOF_UNAVAILABLE');
    const result = parseGoalResult(artifact.payload.raw_result); bindResult(loop, review, result, snapshot);
    if (result.verdict !== review.verdict) throw new Error('GOAL_PROOF_UNAVAILABLE');
    const failures = result.requirements.filter(item => item.status !== 'pass');
    if (captureGoalSnapshot(root, loop).sha256 !== review.snapshot_sha256) return { ...base, ok: false, failures, missing: ['goal-proof-stale'], code: 'GOAL_PROOF_STALE' };
    return failures.length ? { ...base, ok: false, failures, missing: ['goal-review-rejected'], code: 'GOAL_PROOF_REJECTED' }
      : { ...base, ok: true, failures: [], missing: [], code: null };
  } catch (error) { return { ...base, ok: false, missing: ['goal-proof-unavailable'], code: 'GOAL_PROOF_UNAVAILABLE', reason: error.message }; }
}

function obligationInput(loop, value) {
  if (!exactGoalObject(value, ['id', 'requirement_ids', 'workstream_ids', 'status', 'reason'])
    || typeof value.id !== 'string' || !GOAL_ID.test(value.id) || !boundedGoalText(value.reason)
    || !['open', 'mapped'].includes(value.status) || !Array.isArray(value.requirement_ids) || value.requirement_ids.length < 1
    || value.requirement_ids.length > 64 || new Set(value.requirement_ids).size !== value.requirement_ids.length
    || value.requirement_ids.some(id => !goalRequirementIds(loop).includes(id)) || !Array.isArray(value.workstream_ids)
    || value.workstream_ids.length > 256 || new Set(value.workstream_ids).size !== value.workstream_ids.length
    || value.workstream_ids.some(id => !loop.workstreams.some(ws => ws.id === id))
    || (value.status === 'mapped') !== (value.workstream_ids.length > 0)) throw new Error('GOAL_OBLIGATION_INVALID');
  return structuredClone(value);
}

export function upsertGoalObligation(root, runId, { value, fence, now = Date.now() } = {}) {
  let normalized;
  const eventData = { id: value?.id };
  appendAnchored(root, runId, { type: 'goal-obligation-mapped', data: eventData, now }, loop => {
    const index = loop.goal_obligations.findIndex(item => item.id === normalized.id);
    const next = { ...normalized, resolution: null };
    if (index < 0) loop.goal_obligations.push(next); else loop.goal_obligations[index] = next;
  }, loop => {
    goalFence(loop, fence); normalized = obligationInput(loop, value);
    eventData.value = normalized;
    if (loop.goal_reviews.some(review => review.status === 'pending')) throw new Error('GOAL_REVIEW_ACTIVE');
    const old = loop.goal_obligations.find(item => item.id === normalized.id);
    if (!old && loop.goal_obligations.length >= 256) throw new Error('GOAL_OBLIGATION_LIMIT');
    if (old && (old.status === 'resolved' || old.reason !== normalized.reason
      || !same([...old.requirement_ids].sort(), [...normalized.requirement_ids].sort()))) throw new Error('GOAL_OBLIGATION_IDENTITY_FROZEN');
  }, { floor: MUTATION_TURN_FLOOR });
  return { ok: true };
}

export function resolveGoalObligation(root, runId, { id, workstreamIds, actor = 'agent', confirm = false, reason, env = process.env, fence, now = Date.now() } = {}) {
  let resolution, mapped;
  const eventData = { id, actor };
  appendAnchored(root, runId, { type: 'goal-obligation-resolved', data: eventData, now }, (loop, _spent, tx) => {
    const obligation = loop.goal_obligations.find(item => item.id === id);
    obligation.status = 'resolved'; obligation.workstream_ids = mapped;
    obligation.resolution = { ...resolution, authorization_event: tx.event_identity };
  }, loop => {
    goalFence(loop, fence);
    if (loop.goal_reviews.some(review => review.status === 'pending')) throw new Error('GOAL_REVIEW_ACTIVE');
    const obligation = loop.goal_obligations.find(item => item.id === id);
    if (!obligation || obligation.status === 'resolved') throw new Error('GOAL_OBLIGATION_UNRESOLVABLE');
    if (actor === 'human') {
      if (confirm !== true || !boundedGoalText(reason) || workstreamIds !== undefined
        || isHeadlessInvocation(env, sessionRuntime(loop))) throw new Error('GOAL_OBLIGATION_HUMAN_AUTH_REQUIRED');
      resolution = { kind: 'human-authorized', reason }; mapped = [...obligation.workstream_ids];
    } else {
      if (actor !== 'agent' || confirm !== false || reason !== undefined || !Array.isArray(workstreamIds)
        || workstreamIds.length < 1 || workstreamIds.length > 256 || new Set(workstreamIds).size !== workstreamIds.length) throw new Error('GOAL_OBLIGATION_WORK_PROOF_REQUIRED');
      const workstreams = workstreamIds.map(wsId => loop.workstreams.find(ws => ws.id === wsId));
      if (workstreams.some(ws => !ws || !completedWs(ws) || !workstreamClosureProofState(loop, ws.id).ok
        || !loop.episodes.some(ep => ep.role === 'maker' && ep.status === 'done' && ep.workstream_id === ws.id))
        || obligation.requirement_ids.some(req => !workstreams.some(ws => ws.requirement_ids.includes(req)))) throw new Error('GOAL_OBLIGATION_WORK_PROOF_REQUIRED');
      mapped = [...workstreamIds]; resolution = { kind: 'completed-work', reason: 'Completed independently reviewed mapped work.' };
    }
    Object.assign(eventData, { confirm: actor === 'human' && confirm === true, reason: resolution.reason, workstream_ids: mapped });
  }, { floor: MUTATION_TURN_FLOOR });
  return { ok: true };
}
