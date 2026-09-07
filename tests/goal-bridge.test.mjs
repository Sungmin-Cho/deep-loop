import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { reviewedGoalWork } from './helpers/reviewed-goal.mjs';
import { GOAL_NOW } from './helpers/goal-fixture.mjs';
import * as bridge from '../scripts/lib/checker-bridge.mjs';
import { createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const mechanism='"claude -p --model <id> --effort <effort> --permission-mode plan --allowedTools Read,Glob,Grep,LS --strict-mcp-config \\"<prompt>\\""';
function install(t) {
 const home=realpathSync(mkdtempSync(join(tmpdir(),'goal-bridge-home-')));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const skill=join(home,'.codex','plugins','cache','market','deep-model-router','1.14.0','skills','model-router');mkdirSync(join(skill,'scripts'),{recursive:true});mkdirSync(join(skill,'config'),{recursive:true});
 writeFileSync(join(skill,'scripts','route_task.py'),'print(1)');writeFileSync(join(skill,'scripts','dispatch_agent.py'),'print(1)');
 writeFileSync(join(skill,'config','model-routing.yaml'),`transports:\n  grok:\n    to_claude:\n      mechanism_reviewer: ${mechanism}\n      isolation: separate_process\n      verified: true\nfallbacks:\n  grok: {}\n`);
 const checker=join(home,'.codex','plugins','cache','market','deep-review','1.0.0');mkdirSync(join(checker,'.codex-plugin'),{recursive:true});mkdirSync(join(checker,'skills','deep-review-loop'),{recursive:true});
 writeFileSync(join(checker,'.codex-plugin','plugin.json'),JSON.stringify({name:'deep-review',version:'1.0.0',skills:'./skills/'}));writeFileSync(join(checker,'skills','deep-review-loop','SKILL.md'),'---\nname: deep-review-loop\n---\nIndependent evidence.');
 return {home,env:{PATH:process.env.PATH,CODEX_HOME:join(home,'.codex')},skill};
}
test('goal bridge exposes bounded receipt verifier before any supervisor success is trusted',()=>{assert.equal(typeof bridge.verifyGoalBridgeReceipt,'function');});
async function preparedBridge(t) {
 const f=reviewedGoalWork(t,{runtime:'grok'}),installed=install(t);
 const {dispatchGoalReview,startGoalReview,measuredGoalReviewContext}=await import('../scripts/lib/goal-review.mjs');
 const {buildGoalBridgeDescriptor}=await import('../scripts/lib/goal-checker.mjs');
 const review=dispatchGoalReview(f.root,f.runId,{transport:'bridge',fence:f.fence,home:installed.home,env:installed.env,now:Date.parse(GOAL_NOW)}).review;
 const descriptor=buildGoalBridgeDescriptor({root:f.root,runId:f.runId,fence:f.fence,id:review.id,attemptId:review.execution.attempt_id,direction:'to_claude',model:'claude-fable-5-1',effort:'high',...installed});
 descriptor.required_directories.forEach(path=>mkdirSync(path,{recursive:true}));
 startGoalReview(f.root,f.runId,{id:review.id,attemptId:review.execution.attempt_id,handle:`goal-bridge:${review.execution.attempt_id}`,fence:f.fence,now:Date.parse(GOAL_NOW)});
 const argv=descriptor.exec.argv,split=argv.indexOf('--'),get=flag=>argv[argv.indexOf(flag)+1];
 const input={cwdFlag:f.root,sidecar:get('--sidecar'),dispatcher:get('--dispatcher'),mechanism:get('--mechanism'),direction:'to_claude',model:'claude-fable-5-1',effort:'high',prompt:get('--prompt'),supervisorArgv:argv.slice(split+1),goalSubject:descriptor.subject,...installed};
 assert.equal(bridge.bindBridgeExec({...input,prompt:'Invented reviewer instructions'}).ok,false);
 const bound=bridge.bindBridgeExec(input);assert.equal(bound.ok,true,bound.reason);
 writeFileSync(bound.sidecar,JSON.stringify(bound.sidecarPayload));
 const receipts=descriptor.required_directories[0],attemptId=review.execution.attempt_id;
 const stdout=join(receipts,`${attemptId}.stdout`),receiptPath=join(receipts,`${attemptId}.json`);
 const context=measuredGoalReviewContext(f.root,f.runId,{id:review.id,attemptId,fence:f.fence});
 const result={schema_version:1,review_id:review.id,attempt_id:attemptId,goal_sha256:review.goal_sha256,snapshot_sha256:review.snapshot_sha256,verdict:'APPROVE',requirements:context.requirements.map(r=>({id:r.id,status:'pass',evidence:[context.evidence_refs[0]],reason:null})),report_body:'Synthetic independently bound bridge review.'};
 const raw=JSON.stringify(result);writeFileSync(stdout,raw);
 const receipt={attempt_id:attemptId,seat:'reviewer-1',runtime:'grok',transport_id:'grok.to_claude',model_id:'claude-fable-5-1',effort_native:'high',permission_mode:'read-only',output_schema:'none',output_envelope:null,argv:bound.spawnArgv.slice(bound.spawnArgv.indexOf('--')+1),timing:{started_at:'2026-09-07T00:00:00Z',finished_at:'2026-09-07T00:00:01Z'},result:{state:'SUCCEEDED',exit_status:0,schema_valid:true,termination_confirmed:true,invalid_reasons:[],stdout_path:stdout,output_sha256:sha(raw)}};
 writeFileSync(receiptPath,JSON.stringify(receipt));
 return {f,installed,review,descriptor,input,bound,stdout,receiptPath,receipt,result,raw,options:{receiptPath,attemptId,cwdFlag:f.root,sidecarPath:bound.sidecar,goalSubject:descriptor.subject,...installed}};
}
test('probed goal bridge binds exact raw subject, materializes without mutation and records only through kernel',async t=>{
 const b=await preparedBridge(t),before=b.f.state();
 const proof=bridge.verifyGoalBridgeReceipt(b.options);assert.equal(proof.raw,b.raw);
 const dest=b.descriptor.finalize.argv[b.descriptor.finalize.argv.indexOf('--dest')+1];
 assert.equal(bridge.materializeFromReceipt({...b.options,destPath:dest}).ok,true);assert.equal(readFileSync(dest,'utf8'),b.raw);assert.deepEqual(b.f.state(),before);
 const {recordGoalBridgeReview}=await import('../scripts/lib/goal-review.mjs');
 recordGoalBridgeReview(b.f.root,b.f.runId,{id:b.review.id,attemptId:b.review.execution.attempt_id,receiptPath:b.receiptPath,sidecarPath:b.bound.sidecar,fence:b.f.fence,...b.installed});
 assert.equal(b.f.state().goal_reviews[0].status,'approved');
});
test('goal bridge refuses supervisor-only success, active claim, forged identity, stale probe and FIFO before ingestion',async t=>{
 const b=await preparedBridge(t);
 for(const mutate of [r=>r.result.exit_status=1,r=>r.result.termination_confirmed=false,r=>r.output_schema='review',r=>r.argv=['invented'],r=>r.model_id='other']) {
  const changed=structuredClone(b.receipt);mutate(changed);writeFileSync(b.receiptPath,JSON.stringify(changed));assert.throws(()=>bridge.verifyGoalBridgeReceipt(b.options),/GOAL_BRIDGE_/);
 }
 writeFileSync(b.receiptPath,JSON.stringify(b.receipt));
 const originalSidecar=readFileSync(b.bound.sidecar),sidecar=JSON.parse(originalSidecar);
 const forged=structuredClone(b.receipt);forged.argv[forged.argv.length-1]='Invented review prompt';sidecar.child_argv_sha256=sha(JSON.stringify(forged.argv));
 writeFileSync(b.receiptPath,JSON.stringify(forged));writeFileSync(b.bound.sidecar,JSON.stringify(sidecar));assert.throws(()=>bridge.verifyGoalBridgeReceipt(b.options),/GOAL_BRIDGE_ARGV_MISMATCH/);
 writeFileSync(b.receiptPath,JSON.stringify(b.receipt));writeFileSync(b.bound.sidecar,originalSidecar);
 const claim=join(b.descriptor.required_directories[0],`${b.review.execution.attempt_id}.claim`);writeFileSync(claim,'claimed');assert.throws(()=>bridge.verifyGoalBridgeReceipt(b.options),/ATTEMPT_ACTIVE/);rmSync(claim);
  if (!createFileSymlinkOrSkip(t, join(b.f.root, 'absent-claim-target'), claim)) return;
  assert.throws(()=>bridge.verifyGoalBridgeReceipt(b.options),/ATTEMPT_ACTIVE/);rmSync(claim);
 for(const raw of ['verdict: PASS\n',JSON.stringify({...b.result,attempt_id:'foreign'}),JSON.stringify({...b.result,snapshot_sha256:'f'.repeat(64)})]) {
  writeFileSync(b.stdout,raw);b.receipt.result.output_sha256=sha(raw);writeFileSync(b.receiptPath,JSON.stringify(b.receipt));assert.throws(()=>bridge.verifyGoalBridgeReceipt(b.options),/GOAL_RESULT_/);
 }
 rmSync(b.stdout);if(process.platform!=='win32'){assert.equal(spawnSync('mkfifo',[b.stdout]).status,0);assert.throws(()=>bridge.verifyGoalBridgeReceipt(b.options),/GOAL_BRIDGE_FILE_INVALID/);rmSync(b.stdout);}
 writeFileSync(b.stdout,b.raw);b.receipt.result.output_sha256=sha(b.raw);writeFileSync(b.receiptPath,JSON.stringify(b.receipt));
 const config=join(b.installed.skill,'config','model-routing.yaml');writeFileSync(config,readFileSync(config,'utf8').replace('verified: true','verified: false'));assert.throws(()=>bridge.verifyGoalBridgeReceipt(b.options),/PROBE_UNAVAILABLE/);
 assert.equal(b.f.state().goal_reviews[0].status,'pending');
});
