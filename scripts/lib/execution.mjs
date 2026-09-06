import { randomUUID, createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { appendAnchored, MUTATION_TURN_FLOOR } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';
import { isGoalDriven, boundedGoalText } from './goal-contract.mjs';
import { createExecutionRecord, isAttemptObservation, transitionAttempt, attemptIsQuiescent } from './attempt-state.mjs';
import { assertScopeAllows, bindMakerScope } from './session-scope.mjs';
import { validateMakerCompletion, applyMakerCompletion } from './episode.mjs';
import { containedRealFile, containedRealFileWithin, normalizePortableRelativePath, pathWithin } from './fs-safe.mjs';
import { assertRoutingRecord, assertRoutingDigest } from './router-adapter.mjs';
import { resolveAdapter, guardTierProtocol } from './adapters.mjs';
import { checkBudget } from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import { observeTerminalEpisode } from './route-observation.mjs';
import { computeDebt } from './comprehension.mjs';

const terminal = new Set(['done', 'approved', 'rejected', 'abandoned']);
function target(loop, episodeId, fence, { allowUnbound = false, attemptId } = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: execution');
  const lease = leaseCheck(loop, fence); if (!lease.ok) throw new Error(`LEASE_FENCED: ${lease.reason}`);
  if (!isGoalDriven(loop)) throw new Error('GOAL_CONTRACT_REQUIRED: execution requires v0.5');
  const episode = loop.episodes.find(item => item.id === episodeId);
  if (!episode) throw new Error('EPISODE_NOT_FOUND');
  if (terminal.has(episode.status)) throw new Error('EPISODE_ALREADY_TERMINAL');
  const workstream = loop.workstreams.find(item => item.id === episode.workstream_id);
  if (!workstream || ['ready', 'merged', 'abandoned'].includes(workstream.status)) throw new Error('WORKSTREAM_TERMINAL_LOCKED');
  assertScopeAllows(loop, workstream.id, { allowUnbound });
  if (attemptId !== undefined && episode.execution?.attempt_id !== attemptId) throw new Error('EXECUTION_ATTEMPT_MISMATCH');
  return { episode, workstream };
}

function dispatchGate(loop, now, stage, role = 'maker') {
  const budget = checkBudget(loop, { now });
  if (!budget.ok) throw new Error(`EXECUTION_BUDGET_BLOCKED: ${budget.reason}`);
  if (checkBreaker(loop).tripped) throw new Error('EXECUTION_BREAKER_BLOCKED');
  const permitted = role === 'maker' ? guardTierProtocol(loop.autonomy.tier, loop.routing.protocol, stage === 'continuation' ? 'then' : 'dispatch') : { ok: true };
  if (!permitted.ok) throw new Error(`EXECUTION_TIER_BLOCKED: ${permitted.reason}`);
}

function invocation(loop, episode, execution) {
  const primary = resolveAdapter(loop.routing.protocol).dispatch({ task: execution.task, goalDriven: true,
    implementation: episode.point === 'implementation' || ['implementation', 'fix'].includes(episode.kind) });
  if (execution.stage === 'primary') return primary;
  const plan = (episode.execution_history || []).findLast(item => item.stage === 'primary' && item.phase === 'returned')?.artifacts[0];
  return { kind: 'skill', role: 'maker', skill: primary.then, then: null, args: plan, plan_path: plan, task: execution.task };
}

export function prepareExecution(root, runId, { episodeId, mode, stage = 'primary', task, routing, fence, now = Date.now() } = {}) {
  if (!boundedGoalText(task) || !['inline', 'external'].includes(mode) || !['primary', 'continuation'].includes(stage)) throw new Error('EXECUTION_INPUT_INVALID: mode must be inline or external; stage must be primary or continuation; task must be nonempty bounded text');
  if (routing !== undefined) assertRoutingRecord(routing);
  let prepared, existing, output;
  const eventData = { episode_id: episodeId, mode, stage };
  try {
    appendAnchored(root, runId, { type: 'execution-prepared', data: eventData, now }, (loop, _spent, tx) => {
      const episode = loop.episodes.find(item => item.id === episodeId);
      if (episode.execution) (episode.execution_history ??= []).push(episode.execution);
      episode.execution = prepared;
      episode.status = 'in_progress';
      if (routing !== undefined && episode.routing === undefined) episode.routing = structuredClone(routing);
      bindMakerScope(loop, episode, tx.event_identity.seq);
      output = { execution: structuredClone(prepared), invocation: invocation(loop, episode, prepared), created: true };
    }, (loop) => {
      const { episode } = target(loop, episodeId, fence, { allowUnbound: true });
      if (episode.role !== 'maker') throw new Error('EXECUTION_CHECKER_REQUIRES_CLAIM');
      const prior = episode.execution;
      if (!prior && episode.kind !== 'fix' && computeDebt(loop).blocked) throw new Error('EXECUTION_COMPREHENSION_BLOCKED');
      if (prior && ['running', 'prepared'].includes(prior.phase) && prior.stage === stage) {
        if (prior.task !== task || prior.mode !== mode || (routing !== undefined && JSON.stringify(routing) !== JSON.stringify(episode.routing))) throw new Error('EXECUTION_INTENT_FROZEN');
        existing = { execution: structuredClone(prior), invocation: invocation(loop, episode, prior), created: false };
        throw Object.assign(new Error('EXECUTION_ALREADY_PREPARED'), { existingExecution: true });
      }
      if (prior && !attemptIsQuiescent(prior)) throw new Error('EXECUTION_LIVENESS_UNKNOWN');
      if ((episode.execution_history || []).length >= 64) throw new Error('EXECUTION_HISTORY_LIMIT');
      const implementation = episode.point === 'implementation' || ['implementation', 'fix'].includes(episode.kind);
      const adapter = resolveAdapter(loop.routing.protocol).dispatch({ task, goalDriven: true, implementation });
      const requiredStages = prior?.required_stages || adapter.required_stages;
      const primary = [prior, ...(episode.execution_history || [])].filter(Boolean)
        .findLast(item => item.stage === 'primary' && item.phase === 'returned');
      const retryingContinuation = prior?.stage === 'continuation' && prior.phase === 'blocked' && attemptIsQuiescent(prior);
      if (stage === 'continuation' && (!primary || (!retryingContinuation && prior !== primary)
        || !requiredStages.includes('continuation') || primary.artifacts.length === 0)) throw new Error('EXECUTION_CONTINUATION_NOT_READY');
      if (stage === 'primary' && prior?.phase === 'returned') throw new Error('EXECUTION_STAGE_ALREADY_RETURNED');
      if (routing !== undefined) {
        if (mode === 'inline' && (typeof loop.autonomy.session_model !== 'string'
          || routing.selected_model !== loop.autonomy.session_model
          || (loop.autonomy.session_effort != null && routing.selected_effort_native !== loop.autonomy.session_effort))) {
          throw new Error('EXECUTION_INLINE_MODEL_UNVERIFIED: inline routing must match the current owner profile');
        }
        if (episode.routing !== undefined && JSON.stringify(routing) !== JSON.stringify(episode.routing)) throw new Error('EPISODE_ROUTING_FROZEN');
        assertRoutingDigest(loop, routing);
      }
      dispatchGate(loop, now, stage);
      prepared = createExecutionRecord({ attemptId: randomUUID(), mode, stage, task, requiredStages, now });
      eventData.attempt_id = prepared.attempt_id;
    }, { floor: MUTATION_TURN_FLOOR });
  } catch (error) {
    if (error.existingExecution === true) return { ok: true, ...existing };
    throw error;
  }
  return { ok: true, ...output };
}

function boundedRegularBytes(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > limit || before.nlink !== 1) throw new Error('EXECUTION_RECEIPT_UNAVAILABLE');
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    const after = fstatSync(fd), pathAfter = lstatSync(path);
    if (count > limit || count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) throw new Error('EXECUTION_RECEIPT_CHANGED');
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}

// A native host supplies its observed task/list result under the cooperative
// host boundary. A supervisor reference is additionally read and hash-checked;
// a missing report or a caller-supplied success flag is never supervisor proof.
function checkedObservation(root, runId, execution, value) {
  if (!isAttemptObservation(value)) throw new Error('EXECUTION_OBSERVATION_INVALID');
  if (value.source === 'native-task') return structuredClone(value);
  const rel = normalizePortableRelativePath(value.reference);
  if (!rel || (!rel.startsWith(`.deep-loop/runs/${runId}/`) && !rel.startsWith('.deep-review/'))) throw new Error('EXECUTION_RECEIPT_UNCONTAINED');
  const real = containedRealFile(root, rel);
  if (!real) throw new Error('EXECUTION_RECEIPT_UNAVAILABLE');
  const receipt = JSON.parse(boundedRegularBytes(real, 262144).toString('utf8'));
  const result = receipt.result;
  if (receipt.attempt_id !== execution.attempt_id || result?.termination_confirmed !== true) throw new Error('EXECUTION_RECEIPT_MISMATCH');
  const state = result.state === 'SUCCEEDED' && result.exit_status === 0 ? 'succeeded'
    : ['FAILED', 'TIMED_OUT', 'CANCELLED', 'INVALID_OUTPUT'].includes(result.state) ? 'failed' : null;
  if (state !== value.state) throw new Error('EXECUTION_RECEIPT_MISMATCH');
  const stdout = result.stdout_path;
  const stdoutAbs = typeof stdout === 'string' ? resolve(root, stdout) : null;
  if (!stdoutAbs || !pathWithin(dirname(real), stdoutAbs)) throw new Error('EXECUTION_RECEIPT_OUTPUT_UNCONTAINED');
  const stdoutRel = normalizePortableRelativePath(stdoutAbs.slice(resolve(root).length + 1));
  const output = stdoutRel && containedRealFile(root, stdoutRel);
  if (!output || createHash('sha256').update(boundedRegularBytes(output, 1048576)).digest('hex') !== result.output_sha256) throw new Error('EXECUTION_RECEIPT_OUTPUT_MISMATCH');
  return structuredClone(value);
}

export function startExecution(root, runId, { episodeId, attemptId, handle, fence, now = Date.now() } = {}) {
  let next;
  appendAnchored(root, runId, { type: 'execution-started', data: { episode_id: episodeId, attempt_id: attemptId, handle }, now }, (loop) => {
    const episode = loop.episodes.find(item => item.id === episodeId);
    episode.execution = next; episode.status = 'in_progress';
  }, (loop) => {
    const { episode } = target(loop, episodeId, fence, { attemptId });
    dispatchGate(loop, now, episode.execution.stage, episode.role);
    next = transitionAttempt(episode.execution, 'start', { handle, now });
  }, { floor: MUTATION_TURN_FLOOR });
  return { ok: true, execution: structuredClone(next) };
}

export function returnExecution(root, runId, { episodeId, attemptId, artifacts = [], observation, fence, now = Date.now() } = {}) {
  if (!Array.isArray(artifacts) || artifacts.length > 256 || new Set(artifacts).size !== artifacts.length
    || artifacts.some(path => !normalizePortableRelativePath(path))) throw new Error('EXECUTION_ARTIFACTS_INVALID');
  let next, finalMaker = false, committed;
  const eventData = { episode_id: episodeId, attempt_id: attemptId, artifacts };
  appendAnchored(root, runId, { type: 'execution-returned', data: eventData, now }, (loop, _spent, tx) => {
    const episode = loop.episodes.find(item => item.id === episodeId);
    episode.execution = next;
    if (finalMaker) {
      applyMakerCompletion(loop, episode, artifacts);
      committed = { loop: structuredClone(loop), event: tx.event, episodeId, terminalStatus: 'done' };
    }
  }, (loop) => {
    const { episode, workstream } = target(loop, episodeId, fence, { attemptId });
    const observed = observation === undefined ? undefined : checkedObservation(root, runId, episode.execution, observation);
    if (observed) eventData.observation = observed;
    next = transitionAttempt(episode.execution, 'return', { artifacts, observation: observed, now });
    const base = resolve(root, workstream.worktree);
    for (const artifact of artifacts) if (!containedRealFileWithin(root, artifact, base)) throw new Error(`EXECUTION_ARTIFACT_UNAVAILABLE: ${artifact}`);
    finalMaker = episode.role === 'maker' && next.stage === next.required_stages.at(-1);
    if (finalMaker) validateMakerCompletion(root, loop, episode, artifacts);
    else if (episode.role === 'maker' && artifacts.length === 0) throw new Error('EXECUTION_PLAN_ARTIFACT_REQUIRED');
  }, { floor: MUTATION_TURN_FLOOR });
  const terminalObservation = committed ? observeTerminalEpisode(root, runId, committed) : null;
  return { ok: true, execution: structuredClone(next), terminal: finalMaker ? 'done' : null, ...(terminalObservation ? { observation: terminalObservation } : {}) };
}

export function reconcileExecution(root, runId, { episodeId, attemptId, observation, fence, now = Date.now() } = {}) {
  let next;
  const eventData = { episode_id: episodeId, attempt_id: attemptId };
  appendAnchored(root, runId, { type: 'execution-reconciled', data: eventData, now }, (loop) => {
    const episode = loop.episodes.find(item => item.id === episodeId);
    episode.execution = next; episode.status = next.phase === 'blocked' ? 'blocked' : 'in_progress';
  }, (loop) => {
    const { episode } = target(loop, episodeId, fence, { attemptId });
    next = transitionAttempt(episode.execution, 'reconcile', { observation: checkedObservation(root, runId, episode.execution, observation), now });
    eventData.observation = next.observation;
  }, { floor: MUTATION_TURN_FLOOR });
  return { ok: true, execution: structuredClone(next) };
}

export function executionAction(loop, episode) {
  if (!isGoalDriven(loop) || terminal.has(episode?.status)) return null;
  const execution = episode.execution;
  const common = { episode_id: episode.id, workstream_id: episode.workstream_id, ...(execution ? { attempt_id: execution.attempt_id, stage: execution.stage } : {}) };
  if (!execution) return episode.role === 'checker'
    ? { type: 'reconcile_execution', ...common, reason: 'checker-needs-claim' } : null;
  if (execution.phase === 'blocked') return { type: episode.role === 'maker' && attemptIsQuiescent(execution) ? 'dispatch_maker' : 'await_human', ...common, reason: execution.observation?.state === 'unknown' ? 'execution-liveness-unknown' : 'execution-failed' };
  if (execution.phase === 'returned') {
    if (episode.role === 'checker') return { type: 'reconcile_execution', ...common, reason: 'checker-result-needs-import' };
    if (execution.stage !== execution.required_stages.at(-1)) return { type: 'dispatch_maker', ...common, stage: 'continuation', plan_path: execution.artifacts[0] };
  }
  if (execution.mode === 'inline') return { type: 'resume_maker', ...common, task: execution.task };
  if (execution.phase === 'prepared' && execution.observation?.state === 'absent') return { type: 'dispatch_maker', ...common, ready_to_start: true };
  return { type: 'reconcile_execution', ...common, handle: execution.handle, reason: execution.phase === 'prepared' ? 'start-not-observed' : 'producer-result-required' };
}
