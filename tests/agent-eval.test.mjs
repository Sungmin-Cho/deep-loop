import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,statSync,chmodSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runAgentEvaluation,copyStableAgentCandidate} from '../evals/drivers/codex-agent.mjs';
import {validateAgentProfile,sameAgentSourceProvenance} from '../evals/lib/agent-report.mjs';
import {createFileSymlink} from './helpers/fs-fixtures.mjs';
const profile=JSON.parse(readFileSync(new URL('../evals/profiles/agent/goal-agent.json',import.meta.url)));
const result={ok:true,usage:{num_turns:1,input_tokens:90,output_tokens:10,tokens:100},providerThreadId:'12345678-1234-4234-8234-123456789abc',finalMessage:Buffer.from('Done'),rawJsonl:'{"type":"turn.completed"}\n',termination:{confirmed:true},process_group:{mode:'required',quiescence_confirmed:true,group_id:1234}};
const base=t=>{const p=mkdtempSync(join(tmpdir(),'agent-eval-test-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;};
test('agent profiles are separate from legacy read-only profiles and enforce caps',()=>{
 assert.equal(validateAgentProfile(profile),true); assert.equal(validateAgentProfile({...profile,allowed_effects:['read-only']}),false);
 assert.equal(validateAgentProfile({...profile,timeout_ms:600001}),false);assert.equal(validateAgentProfile({...profile,trials:2}),false);
});
test('native real behavioral oracle passes correct code and never trusts a completion label',async t=>{
 const out=base(t); const options={profile:{...profile,profiles:['native'],tasks:[profile.tasks[0]]},outDir:out,executable:process.execPath,codexHome:out};
 const bad=await runAgentEvaluation({...options,runProcess:()=>result}); assert.equal(bad.attempts[0].outcome_pass,false);
 const good=await runAgentEvaluation({...options,runProcess:entry=>{const head=spawnSync('git',['-C',entry.cwd,'rev-parse','HEAD'],{encoding:'utf8'});assert.equal(head.status,0);assert.match(head.stdout.trim(),/^[0-9a-f]{40}$/);writeFileSync(join(entry.cwd,'solution.mjs'),'export function sumNumbers(v){return v.reduce((a,b)=>a+b,0)}\n');return result;}});
 assert.equal(good.attempts[0].outcome_pass,true);assert.equal(good.attempts[0].status,'passed');assert.equal(good.attempts[0].kernel_completed,false);
 assert.equal(good.attempts[0].provenance.source_stable,true);assert.match(good.provenance.git_head,/^[0-9a-f]{40}$/);
 const source=JSON.parse(readFileSync(good.provenance.before_path));assert.ok(source.manifest.some(x=>x.path==='skills/deep-loop-continue/SKILL.md'));assert.ok(source.manifest.some(x=>x.path==='evals/fixtures/_support/verify-outcome.mjs'));
 assert.equal(good.attempts[0].requested_model,'gpt-6-astra');assert.deepEqual(good.attempts[0].observed_models,[]);
});
test('unknown usage or teardown stops all subsequent trials before spawning',async t=>{
 for(const bad of [{...result,usage:null},{...result,termination:{confirmed:false}}]) {
  let calls=0;const out=base(t);const r=await runAgentEvaluation({profile:{...profile,profiles:['native']},outDir:out,executable:process.execPath,codexHome:out,runProcess:()=>{calls++;return bad;}});
  assert.equal(calls,1);assert.equal(r.attempts.length,1);assert.equal(r.stopped,true);assert.equal(r.attempts[0].status,'unavailable');
 }
});
test('unsupported process groups refuse before candidate or model spawn',async t=>{
 let calls=0;const r=await runAgentEvaluation({profile,outDir:base(t),executable:process.execPath,codexHome:tmpdir(),platform:'win32',runProcess:()=>{calls++;return result;}});
 assert.equal(calls,0);assert.equal(r.reason,'process-group-unavailable');
});
test('current and minimal invoke the production goal kernel and fail closed on unmeasured owner output',async t=>{
 for(const variant of ['current','minimal']) {
  const out=base(t);let calls=0;let seenEntry;
  const r=await runAgentEvaluation({profile:{...profile,profiles:[variant],tasks:[profile.tasks[0]]},outDir:out,executable:process.execPath,codexHome:out,approveExecutable:false,
   preflight:()=>({ok:true,executable:{canonical_path:process.execPath},codexHome:{canonical_path:out}}),runProcess:entry=>{calls++;seenEntry=entry;return {...result,usage:null};}});
  t.after(()=>rmSync(r.attempts[0].paths.candidate,{recursive:true,force:true}));
  assert.match(seenEntry.stdin,/"kernel_path"/);
  assert.equal(calls,1);assert.equal(r.attempts[0].kernel_status,'paused');assert.equal(r.attempts[0].status,'unavailable');
  const state=JSON.parse(readFileSync(join(r.attempts[0].paths.candidate,'.deep-loop','runs',r.attempts[0].paths.run_id,'loop.json')));
  assert.equal(state.review.mode,'same-model');
  assert.equal(state.schema_version,'0.5.0');assert.equal(state.goal_contract.requirements[0].id,'REQ-OUTCOME');
 }
});

test('wrong task ID rejects before any model call',async t=>{
 let calls=0;await assert.rejects(()=>runAgentEvaluation({profile:{...profile,tasks:['unknown-task']},outDir:base(t),executable:process.execPath,codexHome:tmpdir(),runProcess:()=>{calls++;return result;}}),/AGENT_PROFILE_INVALID/);
 assert.equal(calls,0);
});
test('stable copy preserves executable bits, records source mode and rejects escaping symlinks',t=>{
 const dir=base(t),source=join(dir,'source'),copy=join(dir,'copy');mkdirSync(source);writeFileSync(join(source,'run.mjs'),'export const x=1');chmodSync(join(source,'run.mjs'),0o755);
 const snapshot=copyStableAgentCandidate(source,copy);assert.equal(snapshot.files[0].mode,0o755);assert.equal(statSync(join(copy,'run.mjs')).mode&0o777,0o555);
 writeFileSync(join(dir,'private'),'not oracle input');createFileSymlink('../private',join(source,'escape'));
 assert.throws(()=>copyStableAgentCandidate(source,join(dir,'unsafe-copy')),/AGENT_SNAPSHOT_SPECIAL_FILE/);
});
test('truncated raw traces cannot become a passing live receipt',async t=>{
 const out=base(t);const r=await runAgentEvaluation({profile:{...profile,profiles:['native'],tasks:[profile.tasks[0]]},outDir:out,executable:process.execPath,codexHome:out,
 runProcess:(entry,options)=>{assert.equal(options.captureRawJsonl,true);writeFileSync(join(entry.cwd,'solution.mjs'),'export function sumNumbers(v){return v.reduce((a,b)=>a+b,0)}');return {...result,rawJsonlTruncated:true};}});
 t.after(()=>rmSync(r.attempts[0].paths.candidate,{recursive:true,force:true}));
 assert.equal(r.attempts[0].outcome_pass,true);assert.equal(r.attempts[0].raw_trace_available,false);assert.equal(r.attempts[0].status,'unavailable');
});

test('source provenance detects source bytes, HEAD and dirty-status drift',()=>{
 const before={manifest_sha256:'a',git_head:'b',git_status_sha256:'c',plugin_version:'1.23.0'};
 assert.equal(sameAgentSourceProvenance(before,{...before}),true);
 for(const field of Object.keys(before))assert.equal(sameAgentSourceProvenance(before,{...before,[field]:'changed'}),false);
});
