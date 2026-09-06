import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGoalFixture, GOAL_NOW } from './helpers/goal-fixture.mjs';
import { issueGoalOwnerTurn, bindGoalOwnerResult } from '../scripts/lib/goal-owner-receipt.mjs';
import { settleGoalOwnerCost, recordCost, reconcileBudget } from '../scripts/lib/budget.mjs';
import { finishRun } from '../scripts/lib/finish.mjs';
import { reviewedGoalWork, goalOk } from './helpers/reviewed-goal.mjs';
import { approveScenarioGoal } from './helpers/goal-scenario.mjs';
import { readLines } from '../scripts/lib/integrity.mjs';
const profile = { model: 'gpt-6-astra', effort: 'high', sandbox: 'workspace-write' };
const threadId = '12345678-1234-4234-8234-123456789abc';
const usage = { num_turns: 1, input_tokens: 90, output_tokens: 10, tokens: 100 };
function fixture(t) { const f = makeGoalFixture({ runtime: 'codex', model: profile.model, effort: profile.effort }); t.after(f.cleanup); return f; }
function issue(f, extra = {}) { return issueGoalOwnerTurn(f.root, f.runId, { fence: f.fence, profile, threadId: null, ...extra }); }
function result(binding, extra = {}) { return bindGoalOwnerResult(binding, { profile, threadId, processId: 1234, outputSha256: 'a'.repeat(64), usage, terminationConfirmed: true, exitCode: 0, ...extra }); }
function settle(f, receipt, extra = {}) { return settleGoalOwnerCost(f.root, f.runId, { receipt, fence: { ...f.fence, intent: 'accounting' }, ...extra }); }
function stop(f) { finishRun(f.root, f.runId, { status: 'stopped', confirm: true, proof: { human_reason: 'test stop' }, fence: f.fence, now: Date.parse(GOAL_NOW) }); }

test('owner turn rejects copied bindings, forged receipts, mismatched profile/thread and unmeasured results', t => {
 const f = fixture(t); const binding = issue(f);
 assert.throws(() => result({ ...binding }), /OWNER_TURN_BINDING_INVALID/);
 assert.throws(() => result(binding, { profile: { ...profile, effort: 'low' } }), /OWNER_TURN_RESULT_INVALID/);
 assert.throws(() => result(binding, { usage: { ...usage, num_turns: 2 } }), /OWNER_TURN_RESULT_INVALID/);
 assert.throws(() => result(binding, { terminationConfirmed: false }), /OWNER_TURN_RESULT_INVALID/);
 const receipt = result(binding);
 assert.throws(() => settle(f, JSON.parse(JSON.stringify(receipt))), /OWNER_TURN_RECEIPT_INVALID/);
 assert.equal(settle(f, receipt).recorded, true);
 assert.throws(() => result(binding, { outputSha256: 'b'.repeat(64) }), /OWNER_TURN_RESULT_MISMATCH/);
 const resumed = issue(f, { threadId });
 assert.throws(() => result(resumed, { threadId: '22345678-1234-4234-8234-123456789abc' }), /OWNER_TURN_RESULT_INVALID/);
});

test('initial and resumed active turns settle exactly once and preserve failed process consumption', t => {
 const f = fixture(t);
 const first = result(issue(f), { exitCode: 1 });
 assert.equal(settle(f, first).recorded, true);
 const after = f.state().budget.tokens_spent;
 assert.equal(settle(f, first).recorded, false);
 assert.equal(f.state().budget.tokens_spent, after);
 const second = result(issue(f, { threadId }));
 assert.equal(settle(f, second).recorded, true);
 assert.equal(f.state().budget.tokens_spent, after + 100);
 assert.equal(reconcileBudget(f.root, f.runId).tokens, after + 100);
});

for (const resumed of [false, true]) test(`finished ${resumed ? 'resumed' : 'initial'} owner settles without acquiring a fake child lease`, t => {
 const f = fixture(t);
 if (resumed) settle(f, result(issue(f)));
 const binding = issue(f, { threadId: resumed ? threadId : null });
 stop(f);
 const receipt = result(binding);
 assert.equal(settle(f, receipt).recorded, true);
 const before = readLines(f.root, f.runId).length;
 assert.equal(settle(f, receipt).recorded, false);
 assert.equal(readLines(f.root, f.runId).length, before);
 assert.throws(() => recordCost(f.root, f.runId, { turns: 1, tokens: 1, fence: f.fence }), /RUN_TERMINAL/);
 assert.throws(() => issue(f), /RUN_TERMINAL/);
 assert.equal(f.state().session_chain.lease.handoff_phase, 'idle');
 assert.equal(reconcileBudget(f.root, f.runId).tokens, f.state().budget.tokens_spent);
});

test('owner settlement rejects wrong run/fence and does not discount pre-spawn floors', t => {
 const f = fixture(t); f.workstream('before-spawn');
 const before = f.state().budget.spent;
 const receipt = result(issue(f));
 assert.throws(() => settle(f, receipt, { fence: { ...f.fence, generation: 2, intent: 'accounting' } }), /LEASE_FENCED/);
 assert.throws(() => settleGoalOwnerCost(f.root, 'wrong', { receipt, fence: f.fence }), /OWNER_TURN_RECEIPT_INVALID/);
 settle(f, receipt);
 assert.equal(f.state().budget.spent, before + 1);
});

test('only one unfinished binding is allowed per host/run', t => {
 const f = fixture(t); const binding = issue(f);
 assert.throws(() => issue(f), /OWNER_TURN_UNSETTLED/);
 settle(f, result(binding));
 assert.doesNotThrow(() => issue(f, { threadId }));
});

for (const resumed of [false, true]) test(`completed goal ${resumed ? 'resumed' : 'initial'} owner has exact finish-bound terminal accounting`, t => {
 const f = reviewedGoalWork(t, { runtime: 'codex', model: profile.model, effort: profile.effort });
 approveScenarioGoal(f);
 let earlier;
 if (resumed) { earlier = result(issue(f)); settle(f, earlier); }
 const binding = issue(f, { threadId: resumed ? threadId : null });
 goalOk(f.cli(['finish', '--status', 'completed', '--report', 'final-report.md']));
 const receipt = result(binding); const before = f.state().budget.tokens_spent;
 assert.equal(settle(f, receipt).recorded, true);
 assert.equal(f.state().status, 'completed');
 assert.equal(settle(f, receipt).recorded, false);
 if (earlier) assert.equal(settle(f, earlier).recorded, false);
 assert.equal(f.state().budget.tokens_spent, before + 100);
 const ordinary = f.cli(['budget', 'record', '--turns', '1', '--tokens', '9']);
 assert.notEqual(ordinary.exit, 0);
 assert.match(ordinary.stderr, /RUN_TERMINAL/);
 const cost = readLines(f.root, f.runId).find(e => e.data?.owner_turn_id === binding.turn_id);
 assert.match(cost.data.finish_checksum, /^[a-f0-9]{64}$/);
 assert.equal(cost.data.before_seq, binding.before_seq);
});

test('goal owner terminal accounting preserves pre-finish insights without accepting arbitrary post-finish cost', async t => {
 const {emitInsights,latestInsights,captureLatestInsightsSet,computeInsights}=await import('../scripts/lib/insights.mjs');
 const {captureReconciledRunSet}=await import('../scripts/lib/state.mjs');
 const f=fixture(t);const binding=issue(f);
 const emitted=emitInsights(f.root,f.runId,{fence:f.fence,now:Date.parse(GOAL_NOW)});
 stop(f);settle(f,result(binding));
 assert.equal(latestInsights(captureLatestInsightsSet(f.root,{nowFn:()=>Date.parse(GOAL_NOW)})).path,emitted.path);
 assert.deepEqual(computeInsights(captureReconciledRunSet(f.root),{now:Date.parse(GOAL_NOW)}).post_finish_mutated,[]);
});

test('terminal goal cost recognition rejects wrong finish, owner, charge, receipt, shape and duplicate labels', async t=>{
 const {isTerminalGoalOwnerCostEvent}=await import('../scripts/lib/budget.mjs');
 const f=fixture(t);const binding=issue(f);stop(f);settle(f,result(binding));
 const lines=readLines(f.root,f.runId),loop=f.state(),index=lines.findIndex(e=>e.data?.owner_turn_id===binding.turn_id);
 assert.equal(isTerminalGoalOwnerCostEvent(lines[index],loop,lines),true);
 for(const patch of [{source:'other'},{owner:'other'},{generation:2},{turns:100},{tokens:99},
  {owner_receipt_id:'b'.repeat(64)},{output_sha256:'b'.repeat(64)},{finish_checksum:'b'.repeat(64)},
  {before_seq:999},{before_checksum:'b'.repeat(64)},{expected_thread_id:'22345678-1234-4234-8234-123456789abc'},
  {reported_turns:2},{termination_confirmed:false},{extra:true}]) {
  const copy=structuredClone(lines);Object.assign(copy[index].data,patch);
  assert.equal(isTerminalGoalOwnerCostEvent(copy[index],loop,copy),false,JSON.stringify(patch));
 }
 const copy=structuredClone(lines);copy.push({...copy[index],seq:copy[index].seq+1});
 assert.equal(isTerminalGoalOwnerCostEvent(copy[index],loop,copy),false);
 assert.equal(isTerminalGoalOwnerCostEvent(lines[index],{...loop,project:{...loop.project,root:'/different-root'}},lines),false);
});
