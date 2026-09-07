import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGoalFixture } from './helpers/goal-fixture.mjs';
import { unwrap } from '../scripts/lib/envelope.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';
import { buildGoalOwnerContext, buildGoalOwnerPrompt } from '../scripts/lib/goal-host.mjs';

test('owner context supplies authoritative protocol, fence and action without rediscovery',()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high'});
 try {
  const loop=f.state(), action=nextAction(loop,{now:Date.parse('2026-09-06T00:00:00Z')}).action;
  const hostBudget={remaining_tokens:1234,remaining_time_ms:5000,remaining_owner_turns:3};
  const frame=buildGoalOwnerContext({loop,action,hostBudget});
  assert.deepEqual(frame.host_budget,hostBudget);
  assert.equal(frame.routing.protocol,'standalone');
  assert.ok(unwrap(frame.report_template,{producer:'deep-loop',artifact_kind:'final-report'}));
  assert.equal(frame.report_template.envelope.run_id,f.runId);
  assert.ok(frame.report_path.endsWith('/final-report.md') || frame.report_path.endsWith('\\final-report.md'));
  assert.equal(frame.session_profile.model,'gpt-6-astra');
  assert.equal(frame.owner,f.runId);assert.equal(frame.generation,1);
  assert.equal(frame.scope_epoch,0);assert.deepEqual(frame.event_log_head,loop.event_log_head);
  assert.deepEqual(frame.current_action,action);assert.deepEqual(frame.goal_contract,loop.goal_contract);
  frame.goal_contract.requirements[0].statement='changed';
  assert.notEqual(loop.goal_contract.requirements[0].statement,'changed');
 }finally{f.cleanup();}
});

test('current owner consumes the actual shipped specialization and bounded action frame',()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high'});
 try {
  const prompt=buildGoalOwnerPrompt({loop:f.state(),action:{type:'plan_next_work'}});
  assert.match(prompt,/goal-owner\.md/);assert.match(prompt,/Host-driven v0.5 owner/);
  assert.match(prompt,/--branch/);assert.match(prompt,/"routing":\{"protocol":"standalone"\}/);
  assert.doesNotMatch(prompt,/deep-loop-continue\/SKILL\.md/);
  assert.match(prompt,/one bounded/i);
 }finally{f.cleanup();}
});

test('pending maker action states the executable primary stage rather than requiring an enum guess',()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high'});
 try {
  const ws=f.workstream('stage');
  const made=f.cli(['episode','new','--plugin','standalone','--role','maker','--kind','implementation','--point','implementation','--workstream',ws.id,'--artifacts',JSON.stringify([`${ws.worktree}/solution.mjs`])]);
  assert.equal(made.exit,0,made.stderr);
  const selection=f.cli(['next-action','--json']).json.action;
  assert.equal(f.select(ws.id,selection.expected_scope).exit,0);
  const action=f.cli(['next-action','--json']).json.action;
  assert.equal(action.type,'dispatch_maker');assert.equal(action.stage,'primary');
  const bad=f.cli(['execution','prepare','--episode',made.json.id,'--mode','inline','--stage','dispatch','--task','Implement']);
  assert.equal(bad.exit,1);assert.match(bad.stderr,/primary.*continuation/);
 }finally{f.cleanup();}
});
