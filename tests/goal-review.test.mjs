import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewedGoalWork, goalOk, nativeObservation } from './helpers/reviewed-goal.mjs';
import { makeGoalFixture, TEST_GOAL_CONTRACT } from './helpers/goal-fixture.mjs';
import { goalPrerequisites } from '../scripts/lib/goal-review.mjs';
import { createExecutionRecord, transitionAttempt } from '../scripts/lib/attempt-state.mjs';

const finish = f => f.cli(['finish', '--status', 'completed', '--report', 'final-report.md']);
const dispatch = f => goalOk(f.cli(['goal', 'dispatch', '--transport', 'native']));

test('cancellation exception never hides malformed, un-abandoned or unknown external attempts', t => {
  const f = reviewedGoalWork(t);
  const base = f.state();
  const inline = createExecutionRecord({ attemptId: 'synthetic-inline', mode: 'inline', stage: 'primary', task: 'test', now: 0 });
  let external = createExecutionRecord({ attemptId: 'synthetic-external', mode: 'external', stage: 'primary', task: 'test', now: 0 });
  external = transitionAttempt(external, 'start', { handle: 'unknown-producer', now: 0 });
  const unknown = transitionAttempt(external, 'reconcile', { observation: nativeObservation('unknown', 'unknown-producer'), now: 0 });
  for (const [status, role, execution] of [
    ['abandoned', 'maker', { ...inline, handle: 'invalid-inline-handle' }],
    ['in_progress', 'maker', inline],
    ['abandoned', 'checker', inline],
    ['abandoned', 'maker', unknown],
  ]) {
    const loop = structuredClone(base);
    loop.episodes.push({ id: 'synthetic-cancelled', status, role, execution });
    assert.ok(goalPrerequisites(loop).missing.includes('execution-not-quiescent'));
  }
});

for (const mode of ['inline', 'external']) {
  test(`abandoned ${mode} attempt preserves cancellation versus external liveness semantics`, (t) => {
    let abandonedId, originalExecution;
    const f = reviewedGoalWork(t, { beforeMaker(f, ws, artifact) {
      abandonedId = goalOk(f.cli(['episode', 'new', '--plugin', 'standalone', '--role', 'maker',
        '--kind', 'implementation', '--point', 'implementation', '--workstream', ws.id,
        '--artifacts', JSON.stringify([artifact])])).id;
      const execution = goalOk(f.cli(['execution', 'prepare', '--episode', abandonedId,
        '--mode', mode, '--stage', 'primary', '--task', 'Cancelled earlier work'])).execution;
      if (mode === 'external') goalOk(f.cli(['execution', 'start', '--episode', abandonedId,
        '--attempt', execution.attempt_id, '--handle', 'possibly-live-producer']));
      originalExecution = f.state().episodes.find(e => e.id === abandonedId).execution;
      goalOk(f.cli(['episode', 'abandon', '--id', abandonedId, '--confirm', '--reason', 'Human cancellation']));
    } });
    const abandoned = f.state().episodes.find(e => e.id === abandonedId);
    assert.equal(abandoned.status, 'abandoned');
    assert.deepEqual(abandoned.execution, originalExecution, 'no fabricated return or completion credit');
    const result = f.cli(['goal', 'dispatch', '--transport', 'native']);
    if (mode === 'inline') {
      goalOk(result);
      assert.equal(finish(f).exit, 1, 'cancellation never replaces whole-goal review');
    } else {
      assert.equal(result.exit, 1);
      assert.match(result.stderr, /execution-not-quiescent/);
    }
  });
}
function start(f, review) {
  return f.cli(['goal', 'start', '--id', review.id, '--attempt', review.execution.attempt_id, '--handle', 'synthetic-goal-reviewer']);
}
function returned(f, review, raw = JSON.stringify(document(f, review))) {
  const observation = { ...nativeObservation('succeeded'), output_sha256: createHash('sha256').update(raw).digest('hex') };
  return f.cli(['goal', 'reconcile', '--id', review.id, '--attempt', review.execution.attempt_id, '--observation', JSON.stringify(observation)]);
}
function document(f, review, { verdict = 'APPROVE', failed = [] } = {}) {
  const snapshot = JSON.parse(readFileSync(join(f.root, '.deep-loop', 'runs', f.runId, review.snapshot_rel), 'utf8')).payload;
  const ref = snapshot.artifacts[0].ref;
  return { schema_version: 1, review_id: review.id, attempt_id: review.execution.attempt_id, goal_sha256: review.goal_sha256,
    snapshot_sha256: review.snapshot_sha256, verdict,
    requirements: f.state().goal_contract.requirements.map(({ id }) => ({ id, status: failed.includes(id) ? 'fail' : 'pass',
      evidence: [ref], reason: failed.includes(id) ? 'The declared result is still wrong.' : null })), report_body: '# Synthetic independent goal review\n' };
}
function record(f, value) { return f.cli(['goal', 'record', '--stdin'], { input: JSON.stringify(value) }); }
function approved(f) {
  const review = dispatch(f).review;
  goalOk(start(f, review)); goalOk(returned(f, review)); goalOk(record(f, document(f, review)));
  return review;
}

test('ordinary workstream closure cannot complete a goal without an independent goal result', (t) => {
  const f = reviewedGoalWork(t);
  const result = finish(f);
  assert.equal(result.exit, 1, 'ordinary approvals are not proof of the original goal');
  assert.equal(f.state().status, 'running');
  assert.match(result.stderr, /GOAL_PROOF|goal-review/);
});

test('a missing original requirement blocks goal dispatch and cannot be removed through generic patches', (t) => {
  const contract = structuredClone(TEST_GOAL_CONTRACT);
  contract.requirements.push({ id: 'REQ-B', statement: 'Deliver B', acceptance: 'B must work too.' });
  const f = reviewedGoalWork(t, { contract });
  assert.equal(f.cli(['goal', 'dispatch', '--transport', 'native']).exit, 1);
  assert.equal(finish(f).exit, 1);
  assert.equal(f.cli(['state', 'patch', '--field', 'goal_contract.requirements', '--value', JSON.stringify(contract.requirements.slice(0, 1)), '--owner', f.fence.owner, '--generation', '1']).exit, 1);
  assert.equal(f.state().goal_reviews.length, 0);
});

test('run-level goal review uses its own ledger after closed scopes and records exact raw independent output', (t) => {
  const f = reviewedGoalWork(t);
  const before = f.state();
  const review = dispatch(f).review;
  assert.equal(dispatch(f).review.id, review.id, 'active dispatch is idempotent');
  assert.equal(f.state().episodes.length, before.episodes.length, 'goal review creates no fake maker/checker episode');
  assert.deepEqual(f.state().session_chain.sessions[0].scope, before.session_chain.sessions[0].scope, 'no closed scope is reopened');
  const value = document(f, review);
  assert.equal(record(f, value).exit, 1, 'a record without an observed reviewer return is not proof');
  const raw = JSON.stringify(value, null, 1) + '\n';
  goalOk(start(f, review)); goalOk(returned(f, review, raw));
  goalOk(f.cli(['goal', 'record', '--stdin'], { input: raw }));
  const stored = f.state().goal_reviews[0];
  const envelope = JSON.parse(readFileSync(join(f.root, '.deep-loop', 'runs', f.runId, stored.result_rel), 'utf8'));
  assert.equal(envelope.payload.raw_result, raw);
  assert.equal(stored.status, 'approved');
  assert.equal(f.state().comprehension.episodes_human_reviewed, 0);
  goalOk(finish(f)); assert.equal(f.state().status, 'completed');
});

test('goal output rejects missing, duplicate, foreign, contradictory and ungrounded assessments before mutation', (t) => {
  const f = reviewedGoalWork(t);
  const review = dispatch(f).review; goalOk(start(f, review)); goalOk(returned(f, review));
  const original = document(f, review);
  const before = f.state();
  for (const change of [
    value => { value.requirements = []; },
    value => { value.requirements.push(value.requirements[0]); },
    value => { value.requirements[0].id = 'FOREIGN'; },
    value => { value.requirements[0].status = 'fail'; value.requirements[0].reason = 'bad'; },
    value => { value.requirements[0].evidence = ['invented-file']; },
    value => { value.verdict = 'REQUEST_CHANGES'; },
    value => { value.attempt_id = 'old'; },
    value => { value.extra = true; },
  ]) {
    const value = structuredClone(original); change(value);
    assert.equal(record(f, value).exit, 1, change.toString());
    assert.deepEqual(f.state(), before);
  }
  goalOk(record(f, original));
  const negative = dispatch(f).review; goalOk(start(f, negative));
  const rejected = document(f, negative, { verdict: 'REQUEST_CHANGES', failed: ['REQ-A'] });
  goalOk(returned(f, negative, JSON.stringify(rejected))); goalOk(record(f, rejected));
  const status = goalOk(f.cli(['goal', 'status', '--json']));
  assert.equal(status.failures[0].id, 'REQ-A');
  assert.equal(status.failures[0].reason, 'The declared result is still wrong.');
  assert.equal(finish(f).exit, 1);
});

test('source drift invalidates approval while final reports do not stale their own goal proof', (t) => {
  const f = reviewedGoalWork(t);
  const first = approved(f);
  writeFileSync(f.reportPath, '# A more complete final report\n');
  assert.equal(goalOk(f.cli(['goal', 'status', '--json'])).ok, true);
  writeFileSync(join(f.root, f.productArtifact), 'export const answer = 0;\n');
  const result = finish(f);
  assert.equal(result.exit, 1); assert.match(result.stderr, /GOAL_PROOF_STALE/);
  assert.equal(f.state().goal_reviews[0].snapshot_sha256, first.snapshot_sha256, 'freshness must compare, never refresh old proof');
  const second = approved(f);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.snapshot_sha256, first.snapshot_sha256);
  goalOk(finish(f));
});

test('goal obligations cannot be waived by an agent reason or by clearing advisory triage', (t) => {
  const f = reviewedGoalWork(t);
  const obligation = { id: 'OB-A', requirement_ids: ['REQ-A'], workstream_ids: [], status: 'open', reason: 'Verify the integrated result.' };
  goalOk(f.cli(['goal', 'obligation', '--value', JSON.stringify(obligation)]));
  assert.equal(f.cli(['goal', 'dispatch', '--transport', 'native']).exit, 1);
  const clear = f.cli(['state', 'patch', '--field', 'triage.actionable', '--value', '[]', '--owner', f.fence.owner, '--generation', '1']); goalOk(clear);
  assert.equal(f.cli(['goal', 'obligation', '--value', JSON.stringify({ ...obligation, status: 'resolved', reason: 'Agent says it is unnecessary.' })]).exit, 1);
  assert.equal(f.cli(['goal', 'obligation-resolve', '--id', 'OB-A', '--reason', 'Agent says it is unnecessary.']).exit, 1);
  goalOk(f.cli(['goal', 'obligation-resolve', '--id', 'OB-A', '--workstreams', JSON.stringify([f.delivery.id])]));
  assert.equal(f.state().goal_obligations[0].resolution.kind, 'completed-work');
  approved(f); goalOk(finish(f));
});

test('unknown goal reviewer liveness cannot authorize replacement dispatch or approval', (t) => {
  const f = reviewedGoalWork(t);
  const review = dispatch(f).review; goalOk(start(f, review));
  goalOk(f.cli(['goal', 'reconcile', '--id', review.id, '--attempt', review.execution.attempt_id, '--observation', JSON.stringify(nativeObservation('unknown'))]));
  const again = dispatch(f).review;
  assert.equal(again.id, review.id);
  assert.equal(f.state().goal_reviews.length, 1);
  assert.equal(record(f, document(f, review)).exit, 1);
  assert.equal(start(f, review).exit, 1);
});

test('a goal return must bind the exact reviewer bytes before recording them', (t) => {
  const f = reviewedGoalWork(t);
  const review = dispatch(f).review; goalOk(start(f, review));
  assert.equal(f.cli(['goal', 'reconcile', '--id', review.id, '--attempt', review.execution.attempt_id,
    '--observation', JSON.stringify(nativeObservation('succeeded'))]).exit, 1, 'a success label without the actual output digest is insufficient');
  const raw = JSON.stringify(document(f, review), null, 1) + '\n';
  const observation = { ...nativeObservation('succeeded'), output_sha256: createHash('sha256').update(raw).digest('hex') };
  goalOk(f.cli(['goal', 'reconcile', '--id', review.id, '--attempt', review.execution.attempt_id, '--observation', JSON.stringify(observation)]));
  assert.equal(record(f, JSON.parse(raw)).exit, 1, 'reformatting a received result cannot silently replace the observed bytes');
  assert.equal(f.cli(['goal', 'reconcile', '--id', review.id, '--attempt', review.execution.attempt_id,
    '--observation', JSON.stringify({ ...observation, output_sha256: '0'.repeat(64) })]).exit, 1, 'a returned result is sealed');
  goalOk(f.cli(['goal', 'record', '--stdin'], { input: raw }));
  assert.equal(f.state().goal_reviews[0].result_raw_sha256, observation.output_sha256);
});

test('human obligation resolution records its authorization and headless claims cannot exercise it', (t) => {
  const f = makeGoalFixture(); t.after(f.cleanup);
  goalOk(f.cli(['goal', 'obligation', '--value', JSON.stringify({ id: 'OB-H', requirement_ids: ['REQ-A'], workstream_ids: [], status: 'open', reason: 'Optional rollout follow-up was requested.' })]));
  const args = ['goal', 'obligation-resolve', '--id', 'OB-H', '--actor', 'human', '--confirm', '--reason', 'The user explicitly withdrew this follow-up.'];
  assert.equal(f.cli(args, { env: { DEEP_LOOP_HEADLESS: '1' } }).exit, 1);
  assert.equal(f.state().goal_obligations[0].status, 'open');
  goalOk(f.cli(args, { env: { DEEP_LOOP_HEADLESS: '', CLAUDE_CODE_ENTRYPOINT: 'cli' } }));
  const state = f.state(), resolution = state.goal_obligations[0].resolution;
  const event = readFileSync(join(f.root, '.deep-loop', 'runs', f.runId, 'event-log.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)).find(item => item.seq === resolution.authorization_event.seq);
  assert.equal(event.data.actor, 'human');
  assert.equal(event.data.confirm, true);
  assert.equal(event.data.reason, 'The user explicitly withdrew this follow-up.');
  assert.equal(state.comprehension.episodes_human_reviewed, 0, 'an obligation waiver is not human maker review');
});

test('explicit handoff mode sends a closed owner to its canonical boundary before goal dispatch', (t) => {
  const f = reviewedGoalWork(t, { boundaryMode: 'handoff' });
  const result = f.cli(['goal', 'dispatch', '--transport', 'native']);
  assert.equal(result.exit, 1);
  assert.match(result.stderr, /GOAL_BOUNDARY_HANDOFF_REQUIRED/);
  assert.equal(f.state().goal_reviews.length, 0);
});
