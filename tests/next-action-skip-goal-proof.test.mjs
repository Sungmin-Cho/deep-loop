import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInitialLoop } from '../scripts/lib/initrun.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';
import { reviewedGoalWork } from './helpers/reviewed-goal.mjs';

const NOW = '2026-09-06T00:00:00.000Z';
const readLoop = f => JSON.parse(readFileSync(join(f.root, '.deep-loop', 'runs', f.runId, 'loop.json'), 'utf8'));

test('skipGoalProof returns not_evaluated at the goal-proof point of a v0.5 run', t => {
  const f = reviewedGoalWork(t);
  const loop = readLoop(f);
  const skipped = nextAction(loop, { now: NOW, skipGoalProof: true });
  assert.deepEqual(skipped.action, { type: 'not_evaluated', reason: 'goal-proof' });
  assert.equal(skipped.next_command, '/deep-loop-status');
});

test('without skipGoalProof the v0.5 result is the proof-evaluated descriptor', t => {
  const f = reviewedGoalWork(t);
  const loop = readLoop(f);
  const normal = nextAction(loop, { now: NOW });
  const explicitFalse = nextAction(loop, { now: NOW, skipGoalProof: false });
  assert.notEqual(normal.action.type, 'not_evaluated');
  assert.deepEqual(explicitFalse, normal);
});

test('an explicit goalProof wins over skipGoalProof', t => {
  const f = reviewedGoalWork(t);
  const loop = readLoop(f);
  const withProof = nextAction(loop, { now: NOW, goalProof: { ok: true }, skipGoalProof: true });
  assert.notEqual(withProof.action.type, 'not_evaluated');
});

test('skipGoalProof does not change v0.4 results', () => {
  const base = () => buildInitialLoop({ runtime: 'claude', goal: 'g', protocol: 'deep-work',
    recipe: { id: 'r', name: 'r', reason: '' }, runId: 'R', now: new Date('2026-06-24T00:00:00Z') });
  const variants = [base(), Object.assign(base(), { status: 'paused', pause_reason: 'budget' }),
    Object.assign(base(), { status: 'completed' })];
  for (const l of variants) {
    assert.deepEqual(nextAction(l, { now: NOW, skipGoalProof: true }), nextAction(l, { now: NOW }));
  }
});

// D8 (r3.2): the skip is deferred to the two points that actually read the proof.
const pendingReview = execution => ({ id: 'GR-1', status: 'pending', transport: 'native-task',
  snapshot_rel: 'goal-snapshots/GR-1.json', execution: { attempt_id: 'A-1', handle: 'h-1', ...execution } });
const same = loop => {
  const skipped = nextAction(loop, { now: NOW, skipGoalProof: true });
  assert.deepEqual(skipped, nextAction(loop, { now: NOW }));
  return skipped;
};

test('a pending goal review with unknown liveness is not hidden by skipGoalProof', t => {
  const loop = structuredClone(readLoop(reviewedGoalWork(t)));
  loop.goal_reviews.push(pendingReview({ phase: 'blocked', observation: { state: 'unknown' } }));
  const r = same(loop);
  assert.equal(r.action.type, 'await_human');
  assert.equal(r.action.reason, 'goal-review-liveness-unknown');
});

test('a mid-flight pending goal review yields reconcile_goal_review under skipGoalProof', t => {
  const loop = structuredClone(readLoop(reviewedGoalWork(t)));
  loop.goal_reviews.push(pendingReview({ phase: 'running', observation: { state: 'present' } }));
  assert.equal(same(loop).action.type, 'reconcile_goal_review');
});

test('an open goal obligation yields plan_next_work/goal-work-missing under skipGoalProof', t => {
  const loop = structuredClone(readLoop(reviewedGoalWork(t)));
  loop.goal_obligations.push({ id: 'OB-1', status: 'open', requirement_ids: ['REQ-A'] });
  const r = same(loop);
  assert.equal(r.action.type, 'plan_next_work');
  assert.equal(r.action.reason, 'goal-work-missing');
});

test('plain fixture (ordinary proof met, no goal review) is not_evaluated under skip', t => {
  const r = nextAction(readLoop(reviewedGoalWork(t)), { now: NOW, skipGoalProof: true });
  assert.deepEqual(r.action, { type: 'not_evaluated', reason: 'goal-proof' });
});

test('v0.5 completed/stopped/paused are unchanged by skipGoalProof', t => {
  const base = readLoop(reviewedGoalWork(t));
  for (const patch of [{ status: 'completed' }, { status: 'stopped' }, { status: 'paused', pause_reason: 'budget' }]) {
    same(Object.assign(structuredClone(base), patch));
  }
});

test('goalProof: null under skip is not_evaluated and the proof is not computed', t => {
  const loop = readLoop(reviewedGoalWork(t));
  const r = nextAction(loop, { now: NOW, goalProof: null, skipGoalProof: true });
  assert.deepEqual(r.action, { type: 'not_evaluated', reason: 'goal-proof' });
});

// A completed goal review whose result artifact cannot be read: the proof outcome shows without the skip,
// and the skip keeps it unevaluated at the final block.
test('an unreadable goal review result shows its proof outcome normally and is not_evaluated under skip', t => {
  const loop = structuredClone(readLoop(reviewedGoalWork(t)));
  loop.goal_reviews.push({ id: 'GR-1', status: 'approved', verdict: 'APPROVE', transport: 'native-task',
    snapshot_rel: 'goal-snapshots/GR-1.json', snapshot_sha256: 'a'.repeat(64),
    result_rel: 'goal-results/GR-1.json', result_sha256: 'b'.repeat(64), result_raw_sha256: 'c'.repeat(64) });
  const normal = nextAction(loop, { now: NOW });
  assert.equal(normal.action.type, 'dispatch_goal_checker');
  assert.equal(normal.action.reason, 'GOAL_PROOF_UNAVAILABLE');
  const skipped = nextAction(loop, { now: NOW, skipGoalProof: true });
  assert.deepEqual(skipped.action, { type: 'not_evaluated', reason: 'goal-proof' });
});
