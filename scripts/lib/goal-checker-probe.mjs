import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildCodexExecEntry } from './codex-runtime.mjs';
import { validateGoalCheckerSession } from './goal-execution-plan.mjs';
import { isMeasuredOneTurnUsage } from './budget.mjs';

// This is transport readiness, never a review of a real maker or completion proof.
export function probeGoalChecker({executable,root,model,effort,env,ownerThreads,timeoutMs,runProcess,onInvocation=()=>{}}) {
 const directory=mkdtempSync(join(tmpdir(),'deep-loop-checker-probe-')),nonce=randomBytes(16).toString('hex');
 try {
  const schema=join(directory,'readiness.json');
  writeFileSync(schema,JSON.stringify({type:'object',additionalProperties:false,required:['ready','nonce'],properties:{ready:{type:'boolean',const:true},nonce:{type:'string',const:nonce}}}),{mode:0o400});
  const entry=buildCodexExecEntry({executable,projectRoot:root,model,effort,sandbox:'read-only',goalDriven:true,
   prompt:`Read-only checker transport readiness probe. Do not use tools or review project artifacts. Return exactly the JSON object with ready true and nonce ${JSON.stringify(nonce)}. This is not a review verdict.`});
  entry.argv.splice(entry.argv.indexOf('-C'),0,'--output-schema',schema);
  Object.assign(entry,{env,cwd:root,usageOutputKind:'codex-jsonl',captureFinalMessage:true,captureProviderThreadId:true});
  const result=runProcess(entry,{timeoutMs,processGroup:'required',captureRawJsonl:true});onInvocation({kind:'checker-preflight',entry,result});
  let reason=validateGoalCheckerSession(result,{ownerThreads,argv:entry.argv});
  if(!reason&&(!result?.ok||!isMeasuredOneTurnUsage(result.usage)))reason='checker-probe-usage-unavailable';
  if(!reason)try {const output=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.finalMessage));if(Object.keys(output).length!==2||output.ready!==true||output.nonce!==nonce)throw new Error();}catch{reason='checker-probe-output-invalid';}
  return {ok:reason===null,reason,result};
 }finally{rmSync(directory,{recursive:true,force:true});}
}
