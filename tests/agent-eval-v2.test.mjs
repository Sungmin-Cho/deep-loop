import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentProfileV2, scheduleAgentTrials, summarizeAgentTrialsV2 } from '../evals/lib/agent-report-v2.mjs';
const profile={schema_version:2,mode:'real-agent',profiles:['native','current','minimal'],tasks:['outcome-deterministic-bug-201'],trials:3,seed:42,model:'gpt-6-astra',effort:'high',reviewer:{reviewer:'subagent-checker',mode:'same-model',flags:[]},timeout_ms:600000,call_timeout_ms:120000,no_progress_turns:3,token_limit:500000,allowed_effects:['isolated-workspace-write']};
test('v2 exact profile validates repeats and freezes unique deterministic trial identities',()=>{
 assert.equal(validateAgentProfileV2(profile),true);assert.equal(validateAgentProfileV2({...profile,trials:1}),false);assert.equal(validateAgentProfileV2({...profile,typo:1}),false);
 const planned=scheduleAgentTrials(profile);assert.equal(planned.length,9);assert.equal(new Set(planned.map(x=>x.id)).size,9);assert.deepEqual(scheduleAgentTrials(profile),planned);
});
test('missing scheduled trials remain unavailable in the denominator and safety is separate',()=>{
 const scheduled=scheduleAgentTrials(profile),report=summarizeAgentTrialsV2(scheduled,[{...scheduled[0],status:'passed'}]);
 assert.equal(report.efficacy.planned,9);assert.equal(report.efficacy.passed,1);assert.equal(report.efficacy.unavailable,8);assert.equal(report.safety.planned,0);
});

import { runAgentEvaluation } from '../evals/drivers/codex-agent.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('v2 executes repeated isolated trials and emits every scheduled unavailable row after a lost measurement',async t=>{
 const out=mkdtempSync(join(tmpdir(),'agent-v2-'));t.after(()=>rmSync(out,{recursive:true,force:true}));let calls=0;
 const report=await runAgentEvaluation({profile:{...profile,profiles:['native'],trials:2},outDir:out,executable:process.execPath,codexHome:out,platform:'linux',runProcess:entry=>{calls++;return {ok:false,reason:'quota',termination:{confirmed:true},process_group:{mode:'required',quiescence_confirmed:true,group_id:1234}};}});
 for(const attempt of report.attempts)if(attempt.paths.candidate)t.after(()=>rmSync(attempt.paths.candidate,{recursive:true,force:true}));
 assert.equal(calls,1);assert.equal(report.attempts.length,2);assert.equal(report.summary.efficacy.unavailable,2);assert.equal(report.attempts.filter(x=>x.started===false).length,1);
});
test('v2 two measured trials retain separate paths and exact requested-profile evidence',async t=>{
 const out=mkdtempSync(join(tmpdir(),'agent-v2-pass-'));t.after(()=>rmSync(out,{recursive:true,force:true}));
 const report=await runAgentEvaluation({profile:{...profile,profiles:['native'],trials:2},outDir:out,executable:process.execPath,codexHome:out,platform:'linux',runProcess:entry=>{writeFileSync(join(entry.cwd,'solution.mjs'),'export const sumNumbers=v=>v.reduce((a,b)=>a+b,0);');return {ok:true,usage:{num_turns:1,input_tokens:1,output_tokens:1,tokens:2},rawJsonl:'{}\n',termination:{confirmed:true},process_group:{mode:'required',quiescence_confirmed:true,group_id:1234}};}});
 for(const attempt of report.attempts)t.after(()=>rmSync(attempt.paths.candidate,{recursive:true,force:true}));
 assert.equal(report.passed,true,JSON.stringify(report));assert.equal(report.summary.efficacy.passed,2);assert.notEqual(report.attempts[0].paths.evidence,report.attempts[1].paths.evidence);
});

import { cpSync } from 'node:fs';
import { executeOutcomeCases } from '../evals/lib/outcome-cases.mjs';
import { fileURLToPath } from 'node:url';
for(const id of ['outcome-dependent-integration-217','outcome-replan-evidence-218','outcome-diagnostic-repair-219'])test(`held-out behavior distinguishes broken and corrected candidate: ${id}`,t=>{
 const root=mkdtempSync(join(tmpdir(),'v2-oracle-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=fileURLToPath(new URL(`../evals/fixtures/${id}/`,import.meta.url));
 cpSync(source,root,{recursive:true,filter:src=>!src.includes('/reference')});
 assert.equal(executeOutcomeCases(root,id).pass,false);
 cpSync(join(source,'reference'),root,{recursive:true});assert.equal(executeOutcomeCases(root,id).pass,true);
});
