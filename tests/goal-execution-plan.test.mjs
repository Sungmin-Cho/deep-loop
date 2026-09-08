import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGoalExecutionPlan, createGoalPlanController, issueGoalExecutionPlan, assertIssuedGoalExecutionPlan, expireGoalPlanController, validateGoalCheckerSession } from '../scripts/lib/goal-execution-plan.mjs';
const loop=()=>({schema_version:'0.5.0',orchestration:{version:1,supervision:'delegated',boundary_mode:'continue'},run_id:'RUN',project:{root:'/project'},autonomy:{runtime_source:'skill-asserted',session_runtime:'codex',session_model:'gpt-6-astra',session_effort:'high'},session_chain:{lease:{owner_run_id:'RUN',generation:1}},review:{reviewer:'subagent-checker',mode:'same-model',flags:[],points:['implementation'],converge:true,max_review_rounds:5,require_human_ack:false}});
const doctrine={skill:{canonical_path:'/trusted/SKILL.md',sha256:'a'.repeat(64)}};
test('only explicit single-pass configuration compiles and unsupported defaults carry a new-run remedy',()=>{
 const l=loop();assert.equal(compileGoalExecutionPlan({loop:l}).ok,true);
 for(const review of [{...l.review,reviewer:'deep-review-loop'},{...l.review,mode:'cross-model'},{...l.review,flags:['--contract']},{...l.review,mode:undefined}]){
  const r=compileGoalExecutionPlan({loop:{...l,review}});assert.equal(r.ok,false);assert.equal(r.remediation.command,'init-run');assert.equal(r.remediation.applies_to,'new-run-only');
 }
 assert.equal(compileGoalExecutionPlan({loop:l,options:{callTimeoutMs:0}}).ok,false);
 assert.equal(compileGoalExecutionPlan({loop:l,options:{bogus:true}}).ok,false);
});
test('issued plans bind live controller, fence, review and profile; serialized plans confer no authority',()=>{
 const l=loop(),c=createGoalPlanController();const p=issueGoalExecutionPlan(c,{loop:l,doctrine});
 assert.equal(assertIssuedGoalExecutionPlan(p,l),p);
 assert.throws(()=>assertIssuedGoalExecutionPlan(structuredClone(p),l),/NOT_ISSUED/);
 for(const changed of [{...l,review:{...l.review,flags:['--codex']}},{...l,autonomy:{...l.autonomy,session_effort:'low'}},{...l,session_chain:{lease:{owner_run_id:'RUN',generation:2}}}])assert.throws(()=>assertIssuedGoalExecutionPlan(p,changed),/stale/);
 expireGoalPlanController(c);assert.throws(()=>assertIssuedGoalExecutionPlan(p,l),/stale/);
});
test('checker session must be a distinct CLI thread with confirmed teardown and fresh exec argv',()=>{
 const owner='019c7714-3b77-74d1-9866-e1f484aae2ab',child='019c7714-3b77-74d1-9866-e1f484aae2ac';
 const result={providerThreadId:child,termination:{confirmed:true},process_group:{mode:'required',group_id:123,quiescence_confirmed:true}};
 assert.equal(validateGoalCheckerSession(result,{ownerThreads:[owner],argv:['exec','--ephemeral','-']}),null);
 assert.match(validateGoalCheckerSession({...result,providerThreadId:owner},{ownerThreads:[owner]}),/session/);
 assert.match(validateGoalCheckerSession(result,{ownerThreads:[]}),/owner-session/);
 assert.match(validateGoalCheckerSession(result,{ownerThreads:[owner],argv:['exec','resume',child]}),/session/);
});
