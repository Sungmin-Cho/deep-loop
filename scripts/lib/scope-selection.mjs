import { appendAnchored, MUTATION_TURN_FLOOR } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';
import { isGoalDriven, boundedGoalText } from './goal-contract.mjs';
import { isExecutionRecord, attemptIsQuiescent } from './attempt-state.mjs';
import { ownerSession, scopeToken, reservedOpenScope, SCOPE_HISTORY_LIMIT } from './session-scope.mjs';
import { integrationOrder } from './workspace.mjs';
const terminal = new Set(['ready', 'merged', 'abandoned']);
const settled = new Set(['done', 'approved', 'rejected', 'abandoned']);
function assertQuiescent(loop) {
  for (const episode of loop.episodes) {
    if (episode.status === 'in_progress' || (episode.role === 'checker' && !settled.has(episode.status))) {
      throw new Error(`SCOPE_SELECTION_BUSY: unsettled episode ${episode.id}`);
    }
    const execution = episode.execution;
    const parkedInline = episode.role === 'maker' && episode.status === 'blocked'
      && isExecutionRecord(execution) && execution.mode === 'inline' && execution.phase === 'running';
    if (execution && !parkedInline && !attemptIsQuiescent(execution)) throw new Error(`SCOPE_SELECTION_BUSY: producer ${episode.id}`);
  }
  for (const review of loop.goal_reviews) {
    if (review.status === 'pending' || !attemptIsQuiescent(review.execution)) throw new Error(`SCOPE_SELECTION_BUSY: goal reviewer ${review.id}`);
  }
}
function selectionCandidate(loop, id) {
  if (!isGoalDriven(loop)) throw new Error('GOAL_CONTRACT_REQUIRED: scope selection requires v0.5');
  const session = ownerSession(loop), current = session.scope;
  if (current.kind !== 'workstream' || current.superseded_at !== null) throw new Error('SESSION_SCOPE_MISMATCH');
  if (current.terminal_event !== null && loop.orchestration.boundary_mode !== 'continue') throw new Error('SCOPE_HANDOFF_REQUIRED: publish the current boundary');
  if (current.workstream_id === id) throw new Error('SCOPE_ALREADY_CURRENT');
  if (reservedOpenScope(loop)) throw new Error('SCOPE_RESERVED: another session holds an open reservation');
  if (!Number.isSafeInteger(session.scope_epoch + 1)) throw new Error('SCOPE_EPOCH_LIMIT');
  const target = loop.workstreams.find(ws => ws.id === id);
  if (!target) throw new Error('WORKSTREAM_NOT_FOUND');
  if (terminal.has(target.status)) throw new Error('WORKSTREAM_TERMINAL_LOCKED');
  const graph = integrationOrder(loop);
  if (graph.cycle || graph.missing.length) throw new Error('SCOPE_DEPENDENCY_INVALID');
  if (target.depends_on.some(dep => !['ready','merged'].includes(loop.workstreams.find(ws => ws.id === dep)?.status))) throw new Error('SCOPE_DEPENDENCY_UNMET');
  assertQuiescent(loop);
  const restored = session.scope_history.find(row => row.scope.workstream_id === id);
  if (restored && restored.scope.terminal_event !== null) throw new Error('WORKSTREAM_TERMINAL_LOCKED');
  if (session.scope_history.length - (restored ? 1 : 0) + (current.workstream_id === null ? 0 : 1) > SCOPE_HISTORY_LIMIT) throw new Error('SCOPE_HISTORY_LIMIT');
  return restored;
}

export function scopeSelectionState(loop, id) {
  try { selectionCandidate(loop, id); return { ok: true, reason: null }; }
  catch (error) { return { ok: false, reason: error.message }; }
}

export function selectWorkstream(root, runId, { id, expectedScope, reason, fence, now = Date.now() } = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isSafeInteger(fence.generation)) throw new Error('FENCE_REQUIRED: workstream select');
  if (typeof id !== 'string' || !id || !/^[a-f0-9]{64}$/.test(expectedScope || '') || !boundedGoalText(reason,1024)) throw new Error('SCOPE_SELECTION_INPUT_INVALID');
  let restored, output;
  try {
    appendAnchored(root, runId, { type: 'workstream-selected', data: { id, expected_scope: expectedScope, reason }, now }, (loop, _spent, tx) => {
      const session = ownerSession(loop), previous = session.scope;
      const history = session.scope_history.filter(row => row !== restored);
      if (previous.workstream_id !== null) {
        history.push({ scope: structuredClone(previous), owner_run_id: session.run_id,
          generation: loop.session_chain.lease.generation, scope_epoch: session.scope_epoch, reason,
          parked_episode_id: loop.episodes.some(e => e.id === loop.current_episode && e.workstream_id === previous.workstream_id) ? loop.current_episode : null,
          parked_cursor_ref: session.compact_cursor ? `checkpoints/${session.compact_cursor.checkpoint_key}-compact.json` : null });
        const old = loop.workstreams.find(ws => ws.id === previous.workstream_id);
        if (!terminal.has(old.status)) old.status = 'parked';
      }
      session.scope_history = history;
      session.scope = restored ? structuredClone(restored.scope) : { kind: 'workstream', workstream_id: id,
        bound_at_seq: tx.event_identity.seq, terminal_event: null, closed_at: null, superseded_at: null };
      session.scope_epoch += 1;
      session.scope_turn_baseline = session.turns;
      delete session.compact_cursor;
      loop.current_episode = restored?.parked_episode_id ?? loop.episodes.findLast(e => e.workstream_id === id && !settled.has(e.status))?.id ?? null;
      loop.active_workstreams = [id];
      loop.workstreams.find(ws => ws.id === id).status = 'in_progress';
      output = { ok: true, workstream_id: id, scope_epoch: session.scope_epoch, expected_scope: scopeToken(loop), resumed: Boolean(restored) };
    }, loop => {
      const checked = leaseCheck(loop, fence); if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
      if (!isGoalDriven(loop)) throw new Error('GOAL_CONTRACT_REQUIRED: scope selection requires v0.5');
      if (scopeToken(loop) !== expectedScope) throw new Error('SCOPE_TOKEN_MISMATCH');
      restored = selectionCandidate(loop, id);
    }, { floor: MUTATION_TURN_FLOOR });
  } catch (error) {
    if (error.message === 'COMPACT_RESTORE_INTENT_PENDING') throw new Error('COMPACT_RESTORE_INTENT_PENDING: replay the pending checkpoint restore command with its original checkpoint and admission, then retry workstream select');
    throw error;
  }
  return output;
}
