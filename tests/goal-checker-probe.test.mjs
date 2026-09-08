import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { probeGoalChecker } from '../scripts/lib/goal-checker-probe.mjs';
const owner='019c7714-3b77-74d1-9866-e1f484aae2ab',checker='019c7714-3b77-74d1-9866-e1f484aae2ac';
for(const invalid of [null,'same-session','bad-output'])test(`checker capability probe checks real parser/profile shape: ${invalid??'ready'}`,()=>{
 const p=probeGoalChecker({executable:'/codex',root:'/project',model:'gpt-6-astra',effort:'high',env:{},ownerThreads:[owner],timeoutMs:1000,runProcess:entry=>{
  assert.equal(entry.captureProviderThreadId,true);assert.equal(entry.usageOutputKind,'codex-jsonl');assert.equal(entry.argv.includes('resume'),false);
  const schema=JSON.parse(readFileSync(entry.argv[entry.argv.indexOf('--output-schema')+1]));
  return {ok:true,usage:{num_turns:1,input_tokens:1,output_tokens:1,tokens:2},providerThreadId:invalid==='same-session'?owner:checker,termination:{confirmed:true},process_group:{mode:'required',group_id:1234,quiescence_confirmed:true},finalMessage:Buffer.from(JSON.stringify({ready:true,nonce:invalid==='bad-output'?'wrong':schema.properties.nonce.const}))};
 }});assert.equal(p.ok,invalid===null);
});
