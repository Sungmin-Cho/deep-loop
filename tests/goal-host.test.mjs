import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewedGoalWork as baseReviewedGoalWork } from './helpers/reviewed-goal.mjs';
import { approveScenarioGoal, createScenarioMaker, produceScenarioMaker, reviewScenarioMaker } from './helpers/goal-scenario.mjs';
import assert from 'node:assert/strict';
import { makeGoalFixture as baseGoalFixture } from './helpers/goal-fixture.mjs';
import { driveGoalRun } from '../scripts/lib/goal-host.mjs';

const supportedReview = {points:['implementation'],reviewer:'subagent-checker',mode:'same-model',flags:[],converge:true,max_review_rounds:5,require_human_ack:false};
const makeGoalFixture = options => baseGoalFixture({review:supportedReview,...options});
const reviewedGoalWork = (t,options) => baseReviewedGoalWork(t,{review:supportedReview,...options});
// These transport seams exercise the real kernel and host accounting, not a
// synthetic completion oracle. Live model effectiveness is a separate gate.
const THREAD = '019c7714-3b77-74d1-9866-e1f484aae2ab';
const usage = {num_turns:1,input_tokens:10,output_tokens:5,tokens:15};
function measured(extra={}) { return {ok:true,exitCode:0,usage,providerThreadId:THREAD,finalMessage:'Continue',
  process_group:{mode:'required',group_id:12345,termination_scope:'owned-posix-process-group',quiescence_confirmed:true},
  termination:{confirmed:true},...extra}; }
function options(f, extra={}) { return {root:f.root,runId:f.runId,expect:{owner:f.runId,generation:1},maxTurns:2,
  revalidateExecutable:()=>({canonical_path:'/usr/bin/codex',platform:process.platform}),resolveCheckerSkill:()=>({skill:{canonical_path:'/trusted/fixture/SKILL.md'}}),timeoutMs:5000,wallNow:()=>0,now:"2026-09-06T00:00:00Z",preflight:()=>({ok:true,executable:{canonical_path:'/usr/bin/codex',platform:process.platform},
    codexHome:{canonical_path:'/tmp/codex-test'},measured_usage:[]}),...extra}; }

test('goal host starts persistent owner then resumes exact provider thread and settles each call',async()=>{
  const f=makeGoalFixture({runtime:"codex",model:"gpt-6-astra",effort:"high"}); const entries=[];
  try {
    const result=await driveGoalRun(options(f,{runProcess:entry=>{entries.push(entry);return measured();}}));
    assert.equal(entries.length,2);
    assert.ok(!entries[0].argv.includes('--ephemeral'));
    assert.match(entries[0].stdin,/# Host-driven v0.5 owner/);
    assert.doesNotMatch(entries[1].stdin,/# Host-driven v0.5 owner/);
    assert.match(entries[1].stdin,/goal-owner\.md/);
    assert.ok(entries[1].argv.includes('resume'));
    assert.ok(entries[1].argv.includes(THREAD));
    assert.ok(!entries[1].argv.includes('--last'));
    assert.equal(result.reason,'owner-turn-limit');
    assert.equal(result.invocations.length,2);
    assert.equal(result.invocations.every(x=>x.accounting?.ok===true),true);
    for(const event of result.invocations){assert.match(event.audit.plan_sha256,/^[0-9a-f]{64}$/);assert.match(event.audit.doctrine_sha256,/^[0-9a-f]{64}$/);assert.match(event.audit.argv_sha256,/^[0-9a-f]{64}$/);assert.equal(event.audit.requested_model,'gpt-6-astra');assert.equal(event.audit.native_effort,'high');assert.equal(event.audit.served_model_status,'unavailable');assert.equal(event.invocation_class,'model-call');}
  } finally {f.cleanup();}
});

test('missing provider binding or unconfirmed process termination never starts another owner',async()=>{
  for(const invalid of [{providerThreadId:null},{termination:{confirmed:false}}]) {
    const f=makeGoalFixture({runtime:"codex",model:"gpt-6-astra",effort:"high"});let calls=0;
    try {
      const result=await driveGoalRun(options(f,{runProcess:()=>{calls++;return measured(invalid);}}));
      assert.equal(result.ok,false);assert.equal(calls,1);
      assert.notEqual(f.state().status,'completed');
    } finally {f.cleanup();}
  }
});

test('goal host rejects legacy run and stale owner before any model process',async()=>{
  const f=makeGoalFixture({runtime:"codex",model:"gpt-6-astra",effort:"high"});let calls=0;
  try {
    const result=await driveGoalRun(options(f,{expect:{owner:'wrong',generation:1},runProcess:()=>{calls++;return measured();}}));
    assert.equal(result.ok,false);assert.equal(calls,0);
  } finally {f.cleanup();}
});

test('evidence storage failure still settles the returned owner usage before stopping',async()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high'});let calls=0;
 try {
  const result=await driveGoalRun(options(f,{runProcess:()=>{calls++;return measured();},onInvocation:()=>{throw new Error('disk-full');}}));
  assert.equal(calls,1);assert.match(result.reason,/goal-evidence-write-failed/);
  assert.equal(result.invocations[0].accounting.ok,true);
 }finally{f.cleanup();}
});

test('a lost host binding never accepts a marker UUID as permission to start a new conversation',async()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high'});let calls=0;
 try {
  const dir=join(f.root,'.deep-loop','runs',f.runId,'owner-process-intents');mkdirSync(dir);
  writeFileSync(join(dir,`${f.runId}-1.json`),JSON.stringify({thread_id:THREAD}));
  const result=await driveGoalRun(options(f,{preflight:()=>{calls++;throw new Error('must not probe');}}));
  assert.equal(result.reason,'owner-provider-binding-unavailable');assert.equal(calls,0);
 }finally{f.cleanup();}
});

test('a measured turn at the exact token cap may finish without another model call',async(t)=>{
 const f=reviewedGoalWork(t,{runtime:'codex',model:'gpt-6-astra',effort:'high'});let calls=0;
 const result=await driveGoalRun({...options(f),timeoutMs:30000,tokenLimit:15,
  preflight:params=>{approveScenarioGoal(f);params.onInvocation({kind:'synthetic-preflight',result:measured()});return options(f).preflight();},
  runProcess:()=>{calls++;return measured();}});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.state().status,'completed');assert.equal(calls,0);
});

test('a measured turn over the token cap may finish without another model call',async(t)=>{
 const f=reviewedGoalWork(t,{runtime:'codex',model:'gpt-6-astra',effort:'high'});let calls=0;
 const result=await driveGoalRun({...options(f),timeoutMs:30000,tokenLimit:10,
  preflight:params=>{approveScenarioGoal(f);params.onInvocation({kind:'synthetic-preflight',result:measured()});return options(f).preflight();},
  runProcess:()=>{calls++;return measured();}});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.state().status,'completed');assert.equal(calls,0);
});

test('minimal profile rejects handoff mode explicitly before any runtime call',async()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high',boundaryMode:'handoff'});let calls=0;
 try {
  const result=await driveGoalRun(options(f,{profile:'minimal',preflight:()=>{calls++;throw new Error('must not probe');}}));
  assert.equal(result.reason,'minimal-profile-requires-continue-boundary');assert.equal(calls,0);
 }finally{f.cleanup();}
});

test('an expired controller deadline starts no preflight or owner process',async()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high'});let calls=0,ticks=0;
 try {
  const result=await driveGoalRun(options(f,{wallNow:()=>ticks++===0?0:6000,preflight:()=>{calls++;throw new Error('must not probe');},runProcess:()=>{calls++;return measured();}}));
  assert.equal(result.reason,'goal-host-deadline');assert.equal(calls,0);
 }finally{f.cleanup();}
});

test('an exhausted kernel budget blocks even model preflight',async()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high'});let calls=0;
 try {
  const charged=f.cli(['budget','record','--turns','201','--tokens','1']);assert.equal(charged.exit,0,charged.stderr);
  const result=await driveGoalRun(options(f,{preflight:()=>{calls++;throw new Error('must not probe');}}));
  assert.equal(result.reason,'budget');assert.equal(calls,0);
 }finally{f.cleanup();}
});

test('production controller defaults inherit the configured run horizon',async()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high'});let offered;
 try {
  const opts=options(f);delete opts.timeoutMs;delete opts.maxTurns;
  const result=await driveGoalRun({...opts,preflight:params=>{offered=params.timeoutMs;return options(f).preflight();},runProcess:()=>measured({ok:false,reason:'test-stop'})});
  assert.ok(offered>23*60*60*1000);assert.equal(result.reason,'test-stop');
 }finally{f.cleanup();}
});

test('host closes a proof-complete workstream without an extra owner call',async()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high'});let calls=0,goalCalls=0;
 try {
  const ws=f.workstream('closure');const maker=createScenarioMaker(f,ws);
  produceScenarioMaker(f,maker);reviewScenarioMaker(f,maker.id);
  const result=await driveGoalRun({...options(f),goalService:()=>{goalCalls++;assert.equal(f.state().workstreams[0].status,'ready');return {ok:false,reason:'test-goal-boundary'};},runProcess:()=>{calls++;return measured();}});
  assert.equal(result.reason,'test-goal-boundary');assert.equal(calls,0);assert.equal(goalCalls,1);
 }finally{f.cleanup();}
});

test('the owner may pause for genuinely missing input without being forced into another turn',async()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high'});let calls=0;
 try {
  const result=await driveGoalRun(options(f,{runProcess:()=>{calls++;const paused=f.cli(['pause','--reason','need-input: clarify required behavior']);assert.equal(paused.exit,0,paused.stderr);return measured();}}));
  assert.equal(calls,1);assert.equal(result.status,'paused');assert.equal(result.reason,'need-input: clarify required behavior');
  assert.equal(result.invocations[0].accounting.ok,true);
 }finally{f.cleanup();}
});

test('host rejects an unsupported sibling review workflow before registering or executing a checker',async()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high',review:{points:['implementation'],reviewer:'deep-review-loop',mode:'same-model',flags:[],converge:true,max_review_rounds:5,require_human_ack:false}});let calls=0;
 try {
  const ws=f.workstream('registration'),maker=createScenarioMaker(f,ws);produceScenarioMaker(f,maker);
  const result=await driveGoalRun(options(f,{resolveCheckerSkill:()=>({skill:{canonical_path:'/trusted/fixture/SKILL.md'}}),runProcess:()=>{calls++;return measured();}}));
  assert.equal(calls,0);assert.equal(result.ok,false);
  const checkers=f.state().episodes.filter(x=>x.role==='checker');
  assert.equal(result.reason,'configured-review-workflow-unavailable');
  assert.equal(checkers.length,0);
 }finally{f.cleanup();}
});

test('a goal-service precondition exception becomes a structured pause',async(t)=>{
 const f=reviewedGoalWork(t,{runtime:'codex',model:'gpt-6-astra',effort:'high'});
 const result=await driveGoalRun(options(f,{goalService:()=>{throw new Error('goal-transport-unavailable');}}));
 assert.equal(result.ok,false);assert.equal(result.reason,'goal-transport-unavailable');assert.equal(f.state().status,'paused');
});

test('cost-only owner churn receives one diagnostic turn then pauses without exhausting the run budget',async()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high'});let calls=0;const prompts=[];
 try {
  const result=await driveGoalRun(options(f,{maxTurns:20,runProcess:entry=>{calls++;prompts.push(entry.stdin);return measured();}}));
  assert.equal(calls,4,JSON.stringify(result));assert.equal(result.reason,'goal-host-no-progress');assert.match(prompts.at(-1),/Diagnostic allowance/);assert.equal(f.state().status,'paused');
 }finally{f.cleanup();}
});
