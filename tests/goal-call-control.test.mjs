import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoalCallBudget } from '../scripts/lib/goal-call-budget.mjs';
import { issueCallCharge, settleCallCharge } from '../scripts/lib/goal-call-accounting.mjs';
const usage={num_turns:1,input_tokens:10,output_tokens:5,tokens:15};
const entry={bin:'/codex',argv:['exec','--json','-'],dispatch_kind:'codex-model-call-v1',usageOutputKind:'codex-jsonl'};
const loop=()=>({created_at:'2026-01-01T00:00:00Z',budget:{tokens_spent:0,tokens_total:100,total:100,spent:0,max_wallclock_sec:100}});
test('every model call checks durable and host budget, clips timeout, and records overshoot',()=>{
 const l=loop();let calls=0,timeout;
 const b=createGoalCallBudget({readLoop:()=>l,tokenLimit:10,remaining:()=>5000,callTimeoutMs:1000,now:()=>Date.parse(l.created_at),runProcess:(e,o)=>{calls++;timeout=o.timeoutMs;return {ok:true,usage,termination:{confirmed:true},process_group:{group_id:1,quiescence_confirmed:true}};}});
 b.run(entry,{timeoutMs:9000});assert.equal(timeout,1000);assert.equal(b.summary().token_overshoot,5);
 assert.throws(()=>b.run(entry,{timeoutMs:9000}),/token-limit/);assert.equal(calls,1);
 const empty=createGoalCallBudget({readLoop:()=>({...l,budget:{...l.budget,tokens_spent:100}}),tokenLimit:100,remaining:()=>5000,callTimeoutMs:1000,now:()=>Date.parse(l.created_at),runProcess:()=>{throw Error('spawned');}});
 assert.throws(()=>empty.run(entry,{timeoutMs:1000}),/budget/);
});
test('unknown entry or missing model usage never becomes a free invocation; local version is distinct',()=>{
 const l=loop();let calls=0;const b=createGoalCallBudget({readLoop:()=>l,tokenLimit:100,remaining:()=>5000,callTimeoutMs:1000,now:()=>Date.parse(l.created_at),runProcess:()=>{calls++;return {ok:true,process_group:{group_id:1},termination:{confirmed:true}};}});
 assert.throws(()=>b.run({...entry,usageOutputKind:null},{}),/entry/);assert.equal(calls,0);
 b.run({...entry,argv:['--version'],dispatch_kind:'local-control-v1',usageOutputKind:null},{});assert.equal(b.summary().tokens,0);
 b.run(entry,{});assert.throws(()=>b.run(entry,{}),/usage-unavailable/);assert.equal(calls,2);
});
test('call charge is host-local, one-shot, and a failed settlement cannot be retried',()=>{
 let writes=0;const fence={owner:'R',generation:1};const r={usage,termination:{confirmed:true},process_group:{quiescence_confirmed:true}};
 const charge=issueCallCharge({root:'/p',runId:'R',fence,kind:'goal-checker'});
 const settle=()=>settleCallCharge(charge,r,{record:()=>{writes++;}});
 assert.equal(settle().ok,true);assert.equal(settle().duplicate,true);assert.equal(writes,1);
 assert.throws(()=>settleCallCharge({...charge},r,{record:()=>{}}),/NOT_ISSUED/);
 const bad=issueCallCharge({root:'/p',runId:'R',fence,kind:'owner-probe'});
 assert.throws(()=>settleCallCharge(bad,r,{record:()=>{throw Error('disk');}}),/disk/);
 assert.throws(()=>settleCallCharge(bad,r,{record:()=>{writes++;}}),/UNKNOWN/);assert.equal(writes,1);
});
test('a transport label alone cannot exempt a model call from usage evidence',()=>{
 const l=loop(),b=createGoalCallBudget({readLoop:()=>l,tokenLimit:100,remaining:()=>5000,callTimeoutMs:1000,now:()=>Date.parse(l.created_at),runProcess:()=>({spawn_state:'not-started'})});
 const r=b.run(entry);assert.equal(b.observation(r).spawn_state,'unknown');assert.equal(b.summary().usage_complete,false);assert.throws(()=>b.run(entry),/usage-unavailable/);
});

import { makeGoalFixture } from './helpers/goal-fixture.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
test('sequential probe and goal charges add measured tokens once while mutation floors remain zero tokens',()=>{
 const f=makeGoalFixture();
 try {
  const before=f.state().budget.tokens_spent;
  for(const [i,kind] of ['owner-probe','checker-probe','goal-checker'].entries()) {
   f.workstream(`cost-${i}`);
   const charge=issueCallCharge({root:f.root,runId:f.runId,fence:f.fence,kind}),r={usage,termination:{confirmed:true},process_group:{quiescence_confirmed:true}};
   settleCallCharge(charge,r);settleCallCharge(charge,r);
  }
  assert.equal(f.state().budget.tokens_spent-before,45);
  const events=readFileSync(join(f.root,'.deep-loop','runs',f.runId,'event-log.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.filter(e=>e.type==='cost'&&e.data.auto_floor).every(e=>e.data.tokens===0));
  assert.equal(events.filter(e=>e.type==='cost'&&!e.data.auto_floor).reduce((sum,e)=>sum+e.data.tokens,0),45);
 }finally{f.cleanup();}
});
