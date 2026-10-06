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
