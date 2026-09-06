import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGoalFixture } from './helpers/goal-fixture.mjs';
import { goalOk } from './helpers/reviewed-goal.mjs';
import { driveScenario, seedPhaseGap, createScenarioMaker, produceScenarioMaker, reviewScenarioMaker, PHASE_REVIEW } from './helpers/goal-scenario.mjs';

test('an approved design advances to missing plan and implementation work without user state repair', (t) => {
  const f = seedPhaseGap(); t.after(f.cleanup);
  const action = goalOk(f.cli(['next-action', '--json'])).action;
  assert.equal(action.type, 'plan_next_work');
  assert.equal(action.point, 'plan');
  const trace = driveScenario(f);
  assert.equal(f.state().status, 'completed');
  assert.equal(f.state().comprehension.episodes_human_reviewed, 0);
  assert.equal(trace.producerCalls.length, 2);
});

test('two real workstreams and an invoked fix reach fresh whole-goal completion with zero human acknowledgements', (t) => {
  const f = makeGoalFixture({ contract: { version: 1, requirements: [
    { id: 'REQ-A', statement: 'Deliver A', acceptance: 'A is implemented and checked.' },
    { id: 'REQ-B', statement: 'Deliver B', acceptance: 'B is implemented and checked.' },
  ], non_goals: [] } }); t.after(f.cleanup);
  const a = f.workstream('a', ['REQ-A']); f.workstream('b', ['REQ-B']);
  createScenarioMaker(f, a);
  const trace = driveScenario(f, { firstReview: 'REQUEST_CHANGES' });
  const loop = f.state();
  assert.equal(loop.status, 'completed');
  assert.equal(loop.workstreams.length, 2);
  assert.equal(trace.producerCalls.filter(call => call.kind === 'fix').length, 1);
  assert.equal(loop.comprehension.episodes_human_reviewed, 0);
  assert.equal(trace.actions.some(action => action.type === 'handoff'), false);
});

test('Superpowers continuation receives the real plan and both stages execute before done', (t) => {
  const f = makeGoalFixture({ protocol: 'superpowers' }); t.after(f.cleanup);
  const ws = f.workstream('delivery'); createScenarioMaker(f, ws);
  const trace = driveScenario(f);
  assert.equal(f.state().status, 'completed');
  assert.deepEqual(trace.producerCalls.map(call => call.stage), ['primary', 'continuation']);
  assert.equal(trace.producerCalls[1].invocation.skill, 'superpowers:subagent-driven-development');
  assert.equal(trace.producerCalls[1].invocation.args, `${ws.worktree}/implementation-plan.md`);
});

test('an unstarted prerequisite is selected while a blocked inline attempt stays resumable', (t) => {
  const f = makeGoalFixture(); t.after(f.cleanup);
  const a = f.workstream('a'), makerA = createScenarioMaker(f, a);
  const execution = goalOk(f.cli(['execution', 'prepare', '--episode', makerA.id, '--mode', 'inline', '--stage', 'primary', '--task', 'Complete implementation'])).execution;
  const b = f.workstream('b');
  goalOk(f.cli(['state', 'patch', '--field', 'workstreams.0.depends_on', '--value', JSON.stringify([b.id]), '--owner', f.fence.owner, '--generation', '1']));
  goalOk(f.cli(['episode', 'record', '--id', makerA.id, '--status', 'blocked']));
  const action = goalOk(f.cli(['next-action', '--json'])).action;
  assert.equal(action.type, 'select_workstream'); assert.equal(action.workstream_id, b.id);
  goalOk(f.select(b.id, action.expected_scope));
  const makerB = createScenarioMaker(f, b); produceScenarioMaker(f, makerB); reviewScenarioMaker(f, makerB.id);
  const trace = driveScenario(f);
  assert.equal(f.state().status, 'completed');
  assert.equal(f.state().episodes.find(item => item.id === makerA.id).execution.attempt_id, execution.attempt_id);
  assert.equal(trace.producerCalls.some(call => call.episode === makerA.id), true);
});

test('human supervision gates a new non-fix producer at the write boundary', (t) => {
  const f = makeGoalFixture({ supervision: 'human', review: { ...PHASE_REVIEW, require_human_ack: true } }); t.after(f.cleanup);
  const ws = f.workstream('delivery'), design = createScenarioMaker(f, ws, 'design');
  produceScenarioMaker(f, design); reviewScenarioMaker(f, design.id);
  const plan = createScenarioMaker(f, ws, 'plan');
  const prepare = () => f.cli(['execution', 'prepare', '--episode', plan.id, '--mode', 'inline', '--stage', 'primary', '--task', 'Create the plan']);
  assert.equal(prepare().exit, 1, 'direct CLI dispatch must not bypass the human debt policy');
  assert.equal(f.state().episodes.find(item => item.id === plan.id).execution, undefined);
  goalOk(f.cli(['comprehension', 'ack', '--episode', design.id, '--actor', 'human', '--confirm'], { env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } }));
  goalOk(prepare());
});
