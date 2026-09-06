import { captureReconciledRunSnapshot, writeState, withReconciledMutationLock } from './state.mjs';
import { appendAnchored, MUTATION_TURN_FLOOR } from './integrity.mjs';
import { isHeadlessInvocation } from './respawn.mjs';
import { leaseCheck } from './lease.mjs';
import { sessionRuntime } from './runtime.mjs';
import { assertScopeAllows } from './session-scope.mjs';
import { isGoalDriven } from './goal-contract.mjs';

function assertEpisodeScope(loop, episode, { allowCrossWorkstream = false } = {}) {
  if (loop.autonomy?.continuation_policy === 'workstream-session' && episode?.workstream_id) {
    assertScopeAllows(loop, episode.workstream_id, { allowCrossWorkstream });
  }
}

export function computeDebt(loop) {
  const c = loop.comprehension || {};
  // comprehension debt = change a human has not yet understood that ALREADY EXISTS. A pending/in_progress maker
  // has produced no diff, so it belongs in neither the numerator nor the denominator — counting it makes the
  // blocking cause the blocked episode itself, and the pre-emptive ack that clears it burns the review credit for
  // a diff that does not exist yet. The durable counters (episodes_total / episodes_human_reviewed) stay as the
  // audit record and are deliberately NOT read here: they include pending makers, so they mean something else.
  // Only the HUMAN flag lowers this metric. Delegated goal runs make the metric
  // advisory; a machine APPROVE never becomes human comprehension credit.
  const episodes = Array.isArray(loop.episodes) ? loop.episodes : [];
  const settled = episodes.filter(e => e?.role === 'maker' && e.status === 'done');
  const reviewed = settled.filter(e => e.human_reviewed === true).length;
  const debt_ratio = settled.length === 0 ? 0 : 1 - reviewed / settled.length;
  const delegated = isGoalDriven(loop) && loop.orchestration.supervision === 'delegated';
  return { debt_ratio, blocked: !delegated && settled.length > 0 && debt_ratio >= (c.debt_threshold ?? 0.5) };
}

// Acknowledge that an episode's diff has been reviewed. tamper-evident + 절차 금지 + headless fail-closed (design #1):
//   - actor='human' releases the comprehension gate (episodes_human_reviewed++) but requires confirm===true
//     (형제 abandonEpisode/recover/breaker-reset human-only pattern) — enforced HERE in the lib, so a CLI-bypass
//     direct call cannot mint human credit.
//   - actor='agent' (default) accrues to episodes_agent_reviewed only — it never releases the human gate.
//   - a headless invocation asserting actor='human' is fail-closed: a dedicated comprehension-ack-rejected event
//     is appended (counter never incremented) and a non-ok result returned (single flow — always append then non-ok).
// Every outcome is written through appendAnchored so the ack (and its rejection) lands in the tamper-evident
// event-log with full context {actor, headless, attended} — unlike the old withLock+writeState path, which left
// no audit trail. (MUTATION_TURN_FLOOR is wired in Task 3.)
export function ack(root, runId, episodeId, { actor = 'agent', confirm = false, env = process.env, fence } = {}) {
  // lib-authoritative guards — BEFORE any append/counter change (형제 abandonEpisode:78 동형).
  if (!['human', 'agent'].includes(actor)) throw new Error('INVALID_ACTOR: actor must be human|agent');
  if (actor === 'human' && confirm !== true) throw new Error('CONFIRM_REQUIRED: human ack requires confirm (human-only)');
  const runtime = sessionRuntime(captureReconciledRunSnapshot(root, runId).data);
  const headless = isHeadlessInvocation(env, runtime);
  const isHuman = actor === 'human';
  if (isHuman && headless) {
    // fail-closed: a headless session cannot self-assert a human review. Append the rejection (never a counter
    // bump) then return non-ok — single flow, sudo-audit-able.
    appendAnchored(root, runId,
      { type: 'comprehension-ack-rejected', data: { episodeId, actor, headless, attended: false, reason: 'headless-human-ack-forbidden' } },
      undefined,
      (loop) => {
        if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
        const ep = loop.episodes.find(e => e.id === episodeId);
        if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
        if (ep.role !== 'maker') throw new Error('ACK_NOT_MAKER: only a maker episode can be acked');   // impl-R3 Fix 5
        assertEpisodeScope(loop, ep);
      },
      { floor: MUTATION_TURN_FLOOR });
    return { ok: false, rejected: true, reason: 'headless-human-ack-forbidden' };
  }
  let out = { ok: true, already: false };
  appendAnchored(root, runId,
    { type: 'comprehension-ack', data: { episodeId, actor, headless, attended: !headless } },
    (loop) => {
      const ep = loop.episodes.find(e => e.id === episodeId);
      // P2-a (belt-and-suspenders): an abandoned maker is already out of episodes_total — never count it.
      if (ep.status === 'abandoned') { out = { ok: true, abandoned: true }; return; }
      if (ep.human_reviewed) { out = { ok: true, already: true }; return; }   // human 우선 — 멱등, agent 도 no-op
      if (isHuman) {
        ep.human_reviewed = true;
        loop.comprehension.episodes_human_reviewed = (loop.comprehension.episodes_human_reviewed || 0) + 1;
      } else {
        if (ep.agent_reviewed) { out = { ok: true, already: true }; return; }   // agent 멱등
        ep.agent_reviewed = true;
        loop.comprehension.episodes_agent_reviewed = (loop.comprehension.episodes_agent_reviewed || 0) + 1;
      }
    },
    (loop) => {
      if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
      const ep = loop.episodes.find(e => e.id === episodeId);
      if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);   // Codex r1 sf-5: overcount 차단
      // impl-R3 Fix 5: ack is a MAKER-review signal. episodes_total counts only makers, so acking a checker would
      // inflate episodes_human_reviewed past episodes_total and drive debt_ratio below threshold with no maker reviewed.
      if (ep.role !== 'maker') throw new Error('ACK_NOT_MAKER: only a maker episode can be acked');
      // The debt gate is run-global (computeDebt reads the whole loop), so its remedy must be reachable
      // run-globally too. Only a settled (done) maker's HUMAN ack gets the exemption: an agent ack does not
      // release the gate, so widening it would be pure isolation loss. The headless rejection precheck below
      // stays strict — it only appends a rejection event and must not reference foreign workstreams.
      assertEpisodeScope(loop, ep, { allowCrossWorkstream: isHuman && ep.status === 'done' });
    },
    { floor: MUTATION_TURN_FLOOR });
  return out;
}

export function recordReviewed(root, runId, episodeId, source) {
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    // v1.6 (spec §2.3-7): fence 없는 legacy export — terminal run에 카운터 write 금지.
    if (data.status === 'completed' || data.status === 'stopped') throw new Error('RUN_TERMINAL: recordReviewed');
    const requireHumanAck = data.review?.require_human_ack === true;
    if (source === 'deep-review-approve' && requireHumanAck) return; // ack 필요, 카운트 안 함
    const ep = data.episodes.find(e => e.id === episodeId);
    assertEpisodeScope(data, ep);
    // P2-a (belt-and-suspenders): skip an abandoned episode — it is out of episodes_total and must not be counted.
    if (ep && ep.status !== 'abandoned' && !ep.human_reviewed) {
      ep.human_reviewed = true;
      data.comprehension.episodes_human_reviewed = (data.comprehension.episodes_human_reviewed || 0) + 1;
    }
    writeState(root, runId, data);
  });
}
