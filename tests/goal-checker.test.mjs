import { snapshotEvidenceRefs } from '../scripts/lib/goal-snapshot.mjs';
import { reviewedGoalWork } from './helpers/reviewed-goal.mjs';
import { GOAL_NOW } from './helpers/goal-fixture.mjs';
import { reconcileGoalReview, ingestMeasuredGoalReview } from '../scripts/lib/goal-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
const api=()=>import('../scripts/lib/goal-checker.mjs');
function context() { return { run_id:'run-a',owner:'owner-a',generation:1,review_id:'goal-a',attempt_id:'attempt-a',goal_sha256:'a'.repeat(64),snapshot_sha256:'b'.repeat(64),goal:'Deliver A',requirements:[{id:'REQ-A',statement:'A',acceptance:'A works'}],snapshot_path:'/tmp/snapshot.json',snapshot_file_sha256:'c'.repeat(64),evidence_refs:['source:A'] }; }
function output(c=context()) { return {schema_version:1,review_id:c.review_id,attempt_id:c.attempt_id,goal_sha256:c.goal_sha256,snapshot_sha256:c.snapshot_sha256,verdict:'APPROVE',requirements:[{id:'REQ-A',status:'pass',evidence:['source:A'],reason:null}],report_body:'Independent evidence passed.'}; }
function fixture(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'goal-checker-tree-'))), home=realpathSync(mkdtempSync(join(tmpdir(),'goal-checker-home-')));
  t.after(()=>{rmSync(root,{recursive:true,force:true});rmSync(home,{recursive:true,force:true});});
  const plugin=join(home,'plugins','cache','market','deep-review','1.0.0');
  mkdirSync(join(plugin,'.codex-plugin'),{recursive:true}); mkdirSync(join(plugin,'skills','deep-review-loop'),{recursive:true});
  writeFileSync(join(plugin,'.codex-plugin','plugin.json'),JSON.stringify({name:'deep-review',version:'1.0.0',skills:'./skills/'}));
  writeFileSync(join(plugin,'skills','deep-review-loop','SKILL.md'),'---\nname: deep-review-loop\n---\nUse independent evidence.');
  return {root,home};
}
function terminal(finalMessage=Buffer.from(JSON.stringify(output()))) { return {ok:true,usage:{num_turns:1,tokens:12,input_tokens:5,output_tokens:7},finalMessage,process_group:{mode:'required',platform:process.platform,group_id:123,quiescence_confirmed:true,termination_scope:'owned-posix-process-group'},termination:{confirmed:true,term_requested:false,kill_requested:false,trigger:'natural-exit'},stderr:'diagnostic'}; }
test('goal runner uses ephemeral read-only Codex, trusted checker doctrine, exact output contract and required process group', async t=>{
  const {runGoalChecker}=await api(),f=fixture(t); let called=0;
  const result=runGoalChecker({executable:process.execPath,projectRoot:f.root,codexHome:f.home,contract:context(),env:process.env,model:null,effort:null,timeoutMs:1000,processGroup:'required',runProcess:(entry,options)=>{
    called++; assert.equal(options.processGroup,'required'); assert.ok(entry.argv.includes('--ephemeral')); assert.equal(entry.argv[entry.argv.indexOf('--sandbox')+1],'read-only');
    assert.notEqual(entry.env.DEEP_LOOP_OWNER,'owner-a'); assert.match(entry.stdin,/deep-review-loop/);
    const schema=JSON.parse(readFileSync(entry.argv[entry.argv.indexOf('--output-schema')+1])); assert.equal(schema.properties.attempt_id.const,'attempt-a');
    return terminal();
  }}); assert.equal(called,1);assert.equal(result.ok,true);assert.equal(result.stderr,'diagnostic');assert.ok(result.checker_identity.skill.sha256);
});
for (const defect of ['missing usage','missing group','live group','malformed JSON','wrong attempt','wrong snapshot','supervisor success only','cancelled','skill drift']) test(`goal runner refuses ${defect}`,async t=>{
  const {runGoalChecker}=await api(),f=fixture(t),r=terminal();
  if(defect==='missing usage')delete r.usage;
  if(defect==='missing group')delete r.process_group;
  if(defect==='live group')r.process_group.quiescence_confirmed=false;
  if(defect==='malformed JSON')r.finalMessage=Buffer.from('VERDICT: APPROVE');
  if(defect==='wrong attempt')r.finalMessage=Buffer.from(JSON.stringify({...output(),attempt_id:'other'}));
  if(defect==='wrong snapshot')r.finalMessage=Buffer.from(JSON.stringify({...output(),snapshot_sha256:'d'.repeat(64)}));
  if(defect==='supervisor success only')delete r.finalMessage;
  if(defect==='cancelled'){r.ok=false;r.reason='cancelled';}
  const runProcess=()=>{if(defect==='skill drift')writeFileSync(join(f.home,'plugins','cache','market','deep-review','1.0.0','skills','deep-review-loop','SKILL.md'),'---\nname: deep-review-loop\n---\nChanged doctrine.');return r;};
  const result=runGoalChecker({executable:process.execPath,projectRoot:f.root,codexHome:f.home,contract:context(),env:process.env,timeoutMs:1000,processGroup:'required',runProcess});
  assert.equal(result.ok,false);assert.ok(result.reason);
});
function liveOptions(f,home,overrides={}) {
  return {root:f.root,runId:f.runId,expect:f.fence,executable:process.execPath,codexHome:home,env:process.env,timeoutMs:1000,
    revalidateExecutable:()=>({canonical_path:process.execPath}),now:Date.parse(GOAL_NOW),...overrides};
}
test('goal review dispatch is gated by the fixture clock, not wall time',async t=>{
  const {dispatchGoalReview}=await import('../scripts/lib/goal-review.mjs');
  const f=reviewedGoalWork(t);
  assert.throws(()=>dispatchGoalReview(f.root,f.runId,{transport:'native',fence:f.fence,now:Date.parse(GOAL_NOW)+86400*1000}),/GOAL_DISPATCH_GATE_BLOCKED/);
  const dispatched=dispatchGoalReview(f.root,f.runId,{transport:'native',fence:f.fence,now:Date.parse(GOAL_NOW)});
  assert.equal(dispatched.ok,true);
});
function actualOutput(entry) {
  const prompt=entry.stdin.split('Immutable goal review context: ')[1],c=JSON.parse(prompt);
  c.evidence_refs=snapshotEvidenceRefs(JSON.parse(readFileSync(c.snapshot_path)).payload);
  return {schema_version:1,review_id:c.review_id,attempt_id:c.attempt_id,goal_sha256:c.goal_sha256,snapshot_sha256:c.snapshot_sha256,verdict:'APPROVE',requirements:c.requirements.map(r=>({id:r.id,status:'pass',evidence:[c.evidence_refs[0]],reason:null})),report_body:'Synthetic independently observed goal review.'};
}
test('actual goal ledger accepts measured Codex only after terminal usage settlement and exact host-bound raw result',async t=>{
  const {drivePendingGoalReview}=await api(),f=reviewedGoalWork(t,{runtime:'codex'}),{home}=fixture(t);let settled=0;
  const result=await drivePendingGoalReview(liveOptions(f,home,{runProcess:entry=>terminal(Buffer.from(JSON.stringify(actualOutput(entry)))),settleUsage:async r=>{
    settled++;assert.equal(f.state().goal_reviews[0].status,'pending');assert.equal(r.usage.tokens,12);return {ok:true};
  }}));assert.equal(result.ok,true,result.reason);assert.equal(settled,1);assert.equal(f.state().goal_reviews[0].status,'approved');
  assert.throws(()=>ingestMeasuredGoalReview(f.root,f.runId,{receipt:JSON.parse(JSON.stringify(result.receipt)),fence:f.fence}),/GOAL_HOST_RECEIPT_INVALID/);
});
test('missing settlement and forged public supervisor observations cannot approve measured goal review',async t=>{
  const {drivePendingGoalReview}=await api(),f=reviewedGoalWork(t,{runtime:'codex'}),{home}=fixture(t);
  const result=await drivePendingGoalReview(liveOptions(f,home,{runProcess:entry=>terminal(Buffer.from(JSON.stringify(actualOutput(entry)))),settleUsage:async()=>({ok:false})}));
  assert.equal(result.ok,false);assert.equal(f.state().goal_reviews[0].status,'pending');
  const review=f.state().goal_reviews[0];
  assert.throws(()=>reconcileGoalReview(f.root,f.runId,{id:review.id,attemptId:review.execution.attempt_id,fence:f.fence,observation:{source:'supervisor-receipt',state:'succeeded',handle:review.execution.handle,reference:'forged',output_sha256:'f'.repeat(64)}}),/GOAL_OBSERVATION_UNSUPPORTED/);
  assert.throws(()=>ingestMeasuredGoalReview(f.root,f.runId,{receipt:result.receipt,fence:f.fence}),/GOAL_HOST_RECEIPT_INVALID/);
  let calls=0;const retried=await drivePendingGoalReview(liveOptions(f,home,{runProcess:()=>{calls++;return terminal();},settleUsage:async()=>({ok:true})}));
  assert.equal(calls,0);assert.equal(retried.reason,'GOAL_CHECKER_RECONCILIATION_REQUIRED');
});
test('native goal descriptor exposes same strict result contract and no process is spawned',async t=>{
  const {drivePendingGoalReview}=await api(),f=reviewedGoalWork(t);let calls=0;
  const result=await drivePendingGoalReview({root:f.root,runId:f.runId,expect:f.fence,transport:'native',now:Date.parse(GOAL_NOW),runProcess:()=>{calls++;}});
  assert.equal(result.action,'native-goal-review');assert.equal(calls,0);assert.equal(result.output_schema.properties.attempt_id.const,result.review.execution.attempt_id);
  assert.doesNotMatch(result.prompt,/undefined/);
});
test('source drift after measured return retires only the bound goal attempt without approval',async t=>{
  const {drivePendingGoalReview}=await api(),f=reviewedGoalWork(t,{runtime:'codex'}),{home}=fixture(t);
  const result=await drivePendingGoalReview(liveOptions(f,home,{runProcess:entry=>{
    const raw=Buffer.from(JSON.stringify(actualOutput(entry)));writeFileSync(join(f.root,f.productArtifact),'Changed during review');return terminal(raw);
  },settleUsage:async()=>({ok:true})}));
  assert.equal(result.ok,false);assert.match(result.ingestion.reason,/GOAL_PROOF_STALE/);assert.equal(f.state().goal_reviews[0].status,'unavailable');
});
