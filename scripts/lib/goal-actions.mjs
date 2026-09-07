import { ownerSession, scopeToken } from './session-scope.mjs';
import { scopeSelectionState } from './scope-selection.mjs';
import { executionAction } from './execution.mjs';
import { goalRequirementIds } from './goal-contract.mjs';
import { ordinaryFinishProofState, workstreamClosureProofState } from './finish.mjs';
import { goalProofState, goalReviewBoundaryBlocked } from './goal-review.mjs';
import { makerReviewed, rejectionResolved } from './review.mjs';
import { runtimeCapability, sessionRuntime } from './runtime.mjs';

const terminal = new Set(['ready', 'merged', 'abandoned']);
const doneEpisode = new Set(['done', 'approved', 'rejected', 'abandoned']);
const pausedInline = episode => episode.role === 'maker' && episode.status === 'blocked'
  && episode.execution?.mode === 'inline' && episode.execution.phase === 'running';

// The LLM chooses task content and how to fulfill it. These descriptors expose
// outstanding work and the same scope/proof constraints enforced by writers.
export function goalNextAction(loop, { gate, debt, blockingMakers, goalProof } = {}) {
  const result = (action, command = '/deep-loop-continue') => ({ gate, action, next_command: command,
    identity: { run_id: loop.run_id, project_root: loop.project.root, owner: loop.session_chain.lease.owner_run_id,
      generation: loop.session_chain.lease.generation, runtime: sessionRuntime(loop) } });
  if (loop.status === 'completed' || loop.status === 'stopped') return result({ type: 'finish', already_terminal: true }, '/deep-loop-finish');
  if (loop.status !== 'running') return result({ type: 'await_human', reason: loop.pause_reason || 'run-paused' }, '/deep-loop-status');
  const session = ownerSession(loop), scope = session.scope;
  const current = loop.workstreams.find(ws => ws.id === scope.workstream_id);
  const open = loop.workstreams.filter(ws => !terminal.has(ws.status));
  const ordinary = ordinaryFinishProofState(loop);
  const proof = goalProof ?? (ordinary.missing.length === 0 ? goalProofState(loop.project.root, loop) : null);

  if (goalReviewBoundaryBlocked(loop)) {
    if (proof?.ok) return result({ type: 'finish' }, '/deep-loop-finish');
    return result({ type: 'handoff', reason: 'workstream-terminal', boundary_event: { ...scope.terminal_event } }, '/deep-loop-handoff');
  }

  const goalReview = loop.goal_reviews.find(review => review.status === 'pending');
  if (goalReview) {
    const execution = goalReview.execution;
    const common = { review_id: goalReview.id, attempt_id: execution.attempt_id, transport: goalReview.transport,
      snapshot_rel: goalReview.snapshot_rel, handle: execution.handle };
    return result(execution.phase === 'blocked' && execution.observation?.state === 'unknown'
      ? { type: 'await_human', ...common, reason: 'goal-review-liveness-unknown' }
      : { type: 'reconcile_goal_review', ...common, phase: execution.phase,
        ready_to_start: execution.phase === 'prepared' && execution.observation?.state === 'absent' });
  }

  const scoped = current ? loop.episodes.filter(episode => episode.workstream_id === current.id) : [];
  const live = scoped.filter(episode => !doneEpisode.has(episode.status) && !pausedInline(episode))
    .map(episode => executionAction(loop, episode)).find(Boolean);
  if (live) return result(live);

  const dependencies = current?.depends_on || [];
  const unmetDependencies = dependencies.filter(id => !['ready', 'merged'].includes(loop.workstreams.find(ws => ws.id === id)?.status));
  const selectable = open.filter(ws => ws.id !== current?.id).filter(ws => scopeSelectionState(loop, ws.id).ok);
  const select = (ws, reason) => result({ type: 'select_workstream', workstream_id: ws.id, expected_scope: scopeToken(loop), reason });
  if (unmetDependencies.length) {
    const prerequisite = selectable.find(ws => unmetDependencies.includes(ws.id)) || selectable[0];
    if (prerequisite) return select(prerequisite, 'prerequisite');
    return result({ type: 'plan_next_work', workstream_id: current.id, reason: 'dependency-needs-replan',
      requirement_ids: [...current.requirement_ids], blocked_dependencies: unmetDependencies });
  }

  const pending = scoped.find(episode => episode.role === 'maker' && episode.status === 'pending');
  if (pending) {
    if (pending.expected_artifacts.length === 0) return result({ type: 'await_human', episode_id: pending.id, reason: 'orphan-maker-no-artifacts' }, '/deep-loop-status');
    if (debt.blocked && pending.kind !== 'fix') return result({ type: 'await_human', episode_id: pending.id,
      reason: 'comprehension-debt', blocking_episode_ids: blockingMakers }, '/deep-loop-status');
    return result({ type: 'dispatch_maker', stage: 'primary', episode_id: pending.id, point: pending.point, workstream_id: pending.workstream_id });
  }
  const rejected = scoped.find(episode => episode.role === 'checker' && episode.status === 'rejected' && !rejectionResolved(loop, episode));
  if (rejected) return result({ type: 'fix_episode', episode_id: rejected.id, target_maker: rejected.target_maker,
    point: rejected.point, workstream_id: rejected.workstream_id });
  const unreviewed = scoped.find(episode => episode.role === 'maker' && episode.status === 'done' && !makerReviewed(loop, episode));
  if (unreviewed) return result({ type: 'dispatch_checker', episode_id: unreviewed.id, point: unreviewed.point, workstream_id: unreviewed.workstream_id });
  const resumable = scoped.find(pausedInline);
  if (resumable) return result({ ...executionAction(loop, resumable), reason: 'resume-blocked-inline-work' });
  const blocked = scoped.find(episode => !doneEpisode.has(episode.status));
  if (blocked) return result({ type: 'await_human', episode_id: blocked.id, reason: blocked.block_reason || 'episode-blocked' }, '/deep-loop-status');

  if (current && !terminal.has(current.status)) {
    const point = loop.review.points.find(item => !current.review_points_done.includes(item));
    if (point && debt.blocked) return result({ type: 'await_human', reason: 'comprehension-debt', blocking_episode_ids: blockingMakers }, '/deep-loop-status');
    if (point) return result({ type: 'plan_next_work', workstream_id: current.id, point,
      requirement_ids: [...current.requirement_ids], reason: 'review-point-work-missing' });
    const closure = workstreamClosureProofState(loop, current.id);
    if (closure.ok) return result({ type: 'close_workstream', workstream_id: current.id });
    return result({ type: 'await_human', workstream_id: current.id, reason: closure.missing.join(',') }, '/deep-loop-status');
  }
  if (selectable.length) {
    return select(selectable[0], 'next-workstream');
  }
  if (open.length) return result({ type: 'await_human', reason: 'workstream-selection-blocked',
    candidates: open.map(ws => ({ workstream_id: ws.id, ...scopeSelectionState(loop, ws.id) })) }, '/deep-loop-status');

  const mapped = new Set(loop.workstreams.filter(ws => ws.status !== 'abandoned').flatMap(ws => ws.requirement_ids));
  const missingRequirements = goalRequirementIds(loop).filter(id => !mapped.has(id));
  const obligations = loop.goal_obligations.filter(item => item.status !== 'resolved');
  if (missingRequirements.length || obligations.length || !ordinary.hasWork) {
    if (debt.blocked) return result({ type: 'await_human', reason: 'comprehension-debt', blocking_episode_ids: blockingMakers }, '/deep-loop-status');
    return result({ type: 'plan_next_work', reason: 'goal-work-missing',
      requirement_ids: missingRequirements.length ? missingRequirements : [...new Set(obligations.flatMap(item => item.requirement_ids))],
      obligations: structuredClone(obligations) });
  }
  if (proof?.ok) return result({ type: 'finish' }, '/deep-loop-finish');
  if (proof?.code === 'GOAL_PROOF_REJECTED') return result({ type: 'plan_next_work', reason: 'goal-review-rejected',
    requirement_ids: proof.failures.map(item => item.id), failures: proof.failures, review_id: proof.review_id });
  if (ordinary.missing.length) return result({ type: 'await_human', reason: ordinary.missing.join(',') }, '/deep-loop-status');
  const transports = runtimeCapability(sessionRuntime(loop), 'goal_checker_transports');
  if (transports.length === 0) return result({ type: 'await_human', reason: 'goal-checker-unavailable' }, '/deep-loop-status');
  return result({ type: 'dispatch_goal_checker', transports: [...transports], reason: proof?.code || 'GOAL_PROOF_REQUIRED' });
}
