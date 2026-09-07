import test from 'node:test';
import assert from 'node:assert/strict';
import { runStreamingProcess, runStreamingProcessSync } from '../scripts/lib/streaming-process.mjs';
const raw='{"type":"thread.started","thread_id":"thread-raw"}\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}})+'\n';
function entry(bytes=raw,exit=0) { return {bin:process.execPath,argv:['-e',`process.stdout.write(${JSON.stringify(bytes)},()=>process.exit(${exit}));`],stdin:'',shell:false,usageOutputKind:'codex-jsonl'}; }
test('optional raw JSONL capture preserves real stdout bytes on async and worker-backed success',async()=>{
  for(const runner of [runStreamingProcess,runStreamingProcessSync]) {
    const result=await runner(entry(),{timeoutMs:2000,captureRawJsonl:true});assert.equal(result.ok,true,result.reason);assert.deepEqual(result.rawJsonl,Buffer.from(raw));assert.equal(result.rawJsonlTruncated,false);
  }
});
test('entry opt-in captures failed JSONL and defaults preserve legacy result shape',async()=>{
  for(const runner of [runStreamingProcess,runStreamingProcessSync]) {
    const failed=await runner({...entry('invalid output\n',7),captureRawJsonl:true},{timeoutMs:2000});
    assert.equal(failed.ok,false);assert.equal(failed.rawJsonl.toString(),'invalid output\n');assert.equal(failed.rawJsonlTruncated,false);
  }
  const normal=runStreamingProcessSync(entry(),{timeoutMs:2000});assert.equal(normal.ok,true);assert.equal(Object.hasOwn(normal,'rawJsonl'),false);assert.equal(Object.hasOwn(normal,'rawJsonlTruncated'),false);
});
test('raw capture is capped at one MiB and explicitly marks truncation without changing stdout parsing',()=>{
  const line=JSON.stringify({type:'diagnostic',padding:'x'.repeat(2000)})+'\n';
  const bytes=line.repeat(550)+raw;
  const result=runStreamingProcessSync({bin:process.execPath,argv:['-e',`for(let i=0;i<550;i++)process.stdout.write(${JSON.stringify(line)});process.stdout.write(${JSON.stringify(raw)});`],stdin:'',shell:false,usageOutputKind:'codex-jsonl',captureRawJsonl:true},{timeoutMs:5000});
  assert.equal(result.ok,true,result.reason);assert.equal(result.rawJsonl.length,1024*1024);assert.deepEqual(result.rawJsonl,Buffer.from(bytes).subarray(0,1024*1024));assert.equal(result.rawJsonlTruncated,true);
});

test('worker raw trace is opt-in, canonical, bounded and explicitly paired with truncation',()=>{
  const wire={ok:false,reason:'exit-7',rawJsonlBase64:Buffer.from('actual stdout').toString('base64'),rawJsonlTruncated:false};
  const spawnSyncImpl=()=>({status:0,stdout:JSON.stringify(wire)});
  assert.equal(runStreamingProcessSync(entry(),{spawnSyncImpl}).reason,'worker-protocol-invalid');
  const omitted=runStreamingProcessSync(entry(),{captureRawJsonl:true,spawnSyncImpl:()=>({status:0,stdout:JSON.stringify({ok:true,usage:{num_turns:1,tokens:5}})})});assert.equal(omitted.reason,'worker-protocol-invalid');
  const valid=runStreamingProcessSync(entry(),{spawnSyncImpl,captureRawJsonl:true});assert.equal(valid.rawJsonl.toString(),'actual stdout');
  for(const change of [v=>delete v.rawJsonlTruncated,v=>v.rawJsonlTruncated=true,v=>v.rawJsonlBase64='!!!!',v=>v.rawJsonlBase64=Buffer.alloc(1024*1024+1).toString('base64')]) {
    const value={...wire};change(value);const invalid=runStreamingProcessSync(entry(),{captureRawJsonl:true,spawnSyncImpl:()=>({status:0,stdout:JSON.stringify(value)})});assert.equal(invalid.reason,'worker-protocol-invalid');
  }
});
