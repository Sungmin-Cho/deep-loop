import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const TARGET=join(ROOT,'tests/goal-host-loss.test.mjs');
const hash=()=>createHash('sha256').update(readFileSync(TARGET)).digest('hex');
// Controlled host loss is a safety experiment, not a model-completion trial.
export function runGoalRecoverySafety({outDir,trials=3}={}) {
 if(!Number.isSafeInteger(trials)||trials<1||trials>20)throw new Error('SAFETY_TRIALS_INVALID');
 const output=resolve(outDir),before=hash(),scheduled=Array.from({length:trials},(_,i)=>({id:`goal-owner-loss-trial-${i+1}`,trial:i+1}));
 mkdirSync(output,{recursive:true,mode:0o700});writeFileSync(join(output,'scheduled.json'),JSON.stringify(scheduled,null,2),{flag:'wx'});
 const attempts=[];
 for(const row of scheduled) {
  const result=spawnSync(process.execPath,['--test','--test-reporter=tap',TARGET],{cwd:ROOT,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  writeFileSync(join(output,`${row.id}.tap`),result.stdout??'',{flag:'wx'});
  const supported=process.platform!=='win32';
  attempts.push({...row,status:supported&&result.status===0&&/^# pass 1$/m.test(result.stdout)&&/^# fail 0$/m.test(result.stdout)?'passed':supported&&Number.isInteger(result.status)?'failed':'unavailable',exit_status:result.status,signal:result.signal,reason:result.error?.code??(!supported?'process-group-unavailable':null)});
 }
 const stable=before===hash();if(!stable)for(const a of attempts){a.status='unavailable';a.reason='control-source-drift';}
 const report={schema_version:1,mode:'control',lane:'safety',task_id:'goal-owner-loss',efficacy_inclusion:false,provider:'injected-transport',source_sha256:before,source_stable:stable,planned:scheduled.length,passed:attempts.filter(a=>a.status==='passed').length,attempts};
 writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2),{flag:'wx'});return report;
}
