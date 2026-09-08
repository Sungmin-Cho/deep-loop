import { validateAgentProfileV2, validateAgentTrialV2, scheduleAgentTrials, summarizeAgentTrialsV2 } from '../lib/agent-report-v2.mjs';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { REPO_ROOT, CLI_PATH } from '../lib/paths.mjs';
import { materializeFixture } from '../lib/fixture.mjs';
import { executeOutcomeCases } from '../lib/outcome-cases.mjs';
import { agentDigest, validateAgentProfile, finalizeAgentTrial, summarizeAgentInvocations, sameAgentSourceProvenance } from '../lib/agent-report.mjs';
import { buildCodexGoalOwnerEntry, buildMinimalCodexEnv } from '../../scripts/lib/codex-runtime.mjs';
import { runStreamingProcessSync } from '../../scripts/lib/streaming-process.mjs';
import { initRun } from '../../scripts/lib/initrun.mjs';
import { captureReconciledRunSnapshot } from '../../scripts/lib/state.mjs';
import { driveGoalRun } from '../../scripts/lib/goal-host.mjs';
const POSIX = new Set(['aix','darwin','freebsd','linux','openbsd','sunos']);
const DEFAULT = JSON.parse(readFileSync(new URL('../profiles/agent/goal-agent.json',import.meta.url)));
const nowMs = () => Date.now();
function json(path,value) {writeFileSync(path,`${JSON.stringify(value,null,2)}\n`,{flag:'wx',mode:0o600});}
function serializable(event) {
 // Environment includes authenticated CODEX_HOME only, but never serialize a
 // caller-supplied environment or secrets. The exact argv and stdin are evidence.
 const {entry,result,...other}=event;
 const {rawJsonl,...resultFields}=result || {};
 const rest={...other,result:{...resultFields,...(rawJsonl!==undefined?{raw_jsonl_sha256:agentDigest(rawJsonl),raw_jsonl_bytes:Buffer.byteLength(rawJsonl)}:{})}};
 return {...rest,...(entry?{entry:{bin:entry.bin,argv:entry.argv,stdin:entry.stdin,cwd:entry.cwd,shell:entry.shell}}:{})};
}
function cli(argv,root,input) {
 const r=spawnSync(process.execPath,[CLI_PATH,...argv,'--project-root',root],{cwd:root,input,encoding:'utf8',timeout:30000,env:{...process.env,DEEP_LOOP_HEADLESS:'',DEEP_LOOP_UNATTENDED:''}});
 if(r.status!==0) throw new Error(`AGENT_INIT_CLI_FAILED:${r.stderr || r.error?.message}`);
 return JSON.parse(r.stdout);
}
export function initializeAgentGoal(root,task,{model,effort,executable,approveExecutable=true}={}) {
 const {runId}=initRun(root,{runtime:'codex',goal:task.prompt,protocol:'standalone',model,effort,supervision:'delegated',boundaryMode:'continue',
  goalContract:{version:1,requirements:[{id:'REQ-OUTCOME',statement:task.prompt,acceptance:'The integrated project root passes independent held-out behavior tests for the requested function.'}],non_goals:['External network, publication and unrelated project changes.']},
  review:{points:['implementation'],reviewer:'subagent-checker',mode:'same-model',flags:[],converge:true,max_review_rounds:5,require_human_ack:false}});
 if(approveExecutable) {
  const diagnosed=cli(['runtime-executable','diagnose','--runtime','codex','--path',executable],root);
  cli(['runtime-executable','approve','--runtime','codex','--path',executable,'--canonical-path',diagnosed.identity.canonical_path,
   '--sha256',diagnosed.identity.sha256,'--actor','human','--confirm','--run-id',runId,'--owner',runId,'--generation','1'],root);
 }
 return {runId,expect:{owner:runId,generation:1}};
}
function nativeEnv(sourceEnv,codexHome,projectRoot) {
 // Reuse the exact transport core allowlist, then remove every loop identity
 // field: native runs have no kernel owner, lease or run.
 const env=buildMinimalCodexEnv({sourceEnv,codexHome,projectRoot,runId:'native-eval-env-filter',owner:'native-eval-env-filter',generation:0});
 for(const key of Object.keys(env))if(key.startsWith('DEEP_LOOP_'))delete env[key];
 return env;
}
function gitInit(root) {
 // Both native and harness candidates start from the same materialized fixture
 // with a real HEAD, so legitimate git worktree creation is possible immediately.
 const env={PATH:process.env.PATH,HOME:tmpdir(),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
 for(const args of [['init','--quiet',root],['-C',root,'add','-A'],
  ['-C',root,'-c','user.name=deep-loop evaluation','-c','user.email=eval@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Initialize isolated evaluation fixture']]) {
  const r=spawnSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,encoding:'utf8',timeout:15000,env});
  if(r.status!==0)throw new Error(`AGENT_TEMP_GIT_INIT_FAILED:${r.stderr || r.error?.message}`);
 }
}
export function copyStableAgentCandidate(source,target) {
 const records=[];let total=0,entries=0;
 function copy(dir,dest,prefix='',depth=0) {
  if(depth>64)throw new Error('AGENT_SNAPSHOT_DEPTH_LIMIT');
  mkdirSync(dest,{recursive:true,mode:0o700});
  for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
   if(++entries>20000)throw new Error('AGENT_SNAPSHOT_ENTRY_LIMIT');
   if(e.name==='.git'||e.name==='.deep-loop')continue;
   const rel=prefix?`${prefix}/${e.name}`:e.name;const src=join(dir,e.name),dst=join(dest,e.name);const before=lstatSync(src,{bigint:true});
   if(before.isSymbolicLink()||(!before.isFile()&&!before.isDirectory()))throw new Error('AGENT_SNAPSHOT_SPECIAL_FILE');
   if(before.isDirectory()){copy(src,dst,rel,depth+1);continue;}
   if(before.size>16n*1024n*1024n||total+Number(before.size)>128*1024*1024)throw new Error('AGENT_SNAPSHOT_SIZE_LIMIT');
   const bytes=readFileSync(src);const after=lstatSync(src,{bigint:true});
   if(['dev','ino','mode','size','mtimeNs','ctimeNs'].some(k=>before[k]!==after[k])||bytes.length!==Number(before.size))throw new Error('AGENT_SNAPSHOT_CHANGED');
   total+=bytes.length;const originalMode=Number(before.mode & 0o777n);
   writeFileSync(dst,bytes,{flag:'wx',mode:(originalMode & ~0o222) | 0o400});records.push({path:rel,size:bytes.length,mode:originalMode,sha256:agentDigest(bytes)});
  }
 }
 copy(source,target);return {files:records,sha256:agentDigest(JSON.stringify(records)),bytes:total};
}


export function captureAgentSourceProvenance(repoRoot=REPO_ROOT,taskIds=DEFAULT.tasks) {
 const files=[];
 function collect(dir,filter) {
  for(const entry of readdirSync(join(repoRoot,dir),{withFileTypes:true})) {
   const rel=`${dir}/${entry.name}`;
   if(entry.isSymbolicLink())throw new Error('AGENT_SOURCE_SYMLINK');
   if(entry.isDirectory())collect(rel,filter);else if(entry.isFile()&&filter(rel))files.push(rel);
  }
 }
 collect('scripts',path=>path.endsWith('.mjs'));
 collect('skills',path=>path.endsWith('.md'));
 collect('evals/lib',path=>path.endsWith('.mjs'));
 collect('evals/drivers',path=>path.endsWith('.mjs'));
 collect('evals/fixtures/_support',()=>true);
 collect('schemas',path=>path.endsWith('.json'));
 collect('evals/profiles/agent',path=>path.endsWith('.json'));
 for(const id of taskIds){files.push(`evals/tasks/${id}.json`);collect(`evals/fixtures/${id}`,()=>true);}
 files.push('.claude-plugin/plugin.json','.codex-plugin/plugin.json','package.json','evals/profiles/agent/goal-agent.json');
 const manifest=[...new Set(files)].sort().map(path=>{
  const absolute=join(repoRoot,path),before=lstatSync(absolute,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.size>16n*1024n*1024n)throw new Error('AGENT_SOURCE_FILE_INVALID');
  const bytes=readFileSync(absolute),after=lstatSync(absolute,{bigint:true});
  if(['dev','ino','mode','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key]))throw new Error('AGENT_SOURCE_CHANGED_DURING_CAPTURE');
  return {path,bytes:bytes.length,sha256:agentDigest(bytes)};
 });
 const git=args=>{
  const result=spawnSync('git',['--no-optional-locks','-C',repoRoot,...args],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,
   env:{PATH:process.env.PATH,HOME:tmpdir(),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}});
  if(result.status!==0)throw new Error('AGENT_SOURCE_GIT_UNAVAILABLE');return result.stdout;
 };
 const head=git(['rev-parse','HEAD']).trim();if(!/^[0-9a-f]{40}$/.test(head))throw new Error('AGENT_SOURCE_HEAD_INVALID');
 const status=git(['status','--porcelain=v1','--untracked-files=normal']);
 return {version:1,repo_root:realpathSync(repoRoot),plugin_version:JSON.parse(readFileSync(join(repoRoot,'.claude-plugin/plugin.json'),'utf8')).version,
  git_head:head,working_tree_dirty:status.length>0,git_status:status,git_status_sha256:agentDigest(status),
  manifest,manifest_sha256:agentDigest(JSON.stringify(manifest))};
}


function unavailableTrial(row,profile,reason) {
 return {...finalizeAgentTrial({profile:row.profile,taskId:row.task_id,requestedModel:profile.model,requestedEffort:profile.effort,invocations:[],hostResult:{ok:false,reason},elapsedMs:0,tokenLimit:profile.token_limit,timeoutMs:profile.timeout_ms,paths:{candidate:null,evidence:null,run_id:null}}),...row,schema_version:2,started:false,served_model_status:'unavailable',requested_profile_evidence:false,reviewer_profile:profile.reviewer};
}

export async function runAgentEvaluation({profile=DEFAULT,outDir,executable,codexHome,env=process.env,
 runProcess=runStreamingProcessSync,platform=process.platform,preflight,approveExecutable=true,clock=nowMs,resolveCheckerSkill,revalidateExecutable}={}) {
 const v2=profile.schema_version===2;
 if(!(v2?validateAgentProfileV2(profile):validateAgentProfile(profile)))throw new Error('AGENT_PROFILE_INVALID');
 if(!POSIX.has(platform)){
  if(!v2)return {schema_version:1,mode:'real-agent',attempts:[],stopped:true,reason:'process-group-unavailable'};
  const scheduled=scheduleAgentTrials(profile),attempts=scheduled.map(row=>unavailableTrial(row,profile,'process-group-unavailable'));
  return {schema_version:2,mode:'real-agent',scheduled,attempts,summary:summarizeAgentTrialsV2(scheduled,attempts),stopped:true,passed:false,reason:'process-group-unavailable'};
 }
 if(typeof executable!=='string'||!isAbsolute(executable)||typeof codexHome!=='string'||!isAbsolute(codexHome))throw new Error('AGENT_RUNTIME_PATHS_REQUIRED');
 const scheduled=v2?scheduleAgentTrials(profile):profile.tasks.flatMap(task_id=>profile.profiles.map(variant=>({task_id,profile:variant,trial:1,id:`${task_id}-${variant}`})));
 const measuredProcess=(entry,options)=>runProcess(entry,{...options,captureRawJsonl:true});
 const output=resolve(outDir || mkdtempSync(join(tmpdir(),'deep-loop-agent-evidence-')));mkdirSync(output,{recursive:true,mode:0o700});
 const sessionDir=mkdtempSync(join(output,'agent-'));const attempts=[];let stopped=false,stopReason=null;
 json(join(sessionDir,'profile.json'),profile);
 if(v2)json(join(sessionDir,'scheduled.json'),scheduled);
 const provenanceBefore=captureAgentSourceProvenance(REPO_ROOT,profile.tasks);json(join(sessionDir,'source-before.json'),provenanceBefore);
 for(const scheduledTrial of scheduled) {
   const {task_id:taskId,profile:variant}=scheduledTrial;
   if(stopped){if(v2)attempts.push(unavailableTrial(scheduledTrial,profile,stopReason));continue;}
   const task=JSON.parse(readFileSync(join(REPO_ROOT,'evals','tasks',`${taskId}.json`),'utf8'));
   const candidate=realpathSync(mkdtempSync(join(tmpdir(),'deep-loop-agent-candidate-')));
   const rel=relative(candidate,sessionDir);if(!rel.startsWith('..')&&!isAbsolute(rel))throw new Error('AGENT_RECEIPTS_INSIDE_CANDIDATE');
   const evidence=join(sessionDir,scheduledTrial.id);mkdirSync(evidence,{mode:0o700});
   materializeFixture(candidate,task);gitInit(candidate);
   const taskContext=`${task.prompt}\nTrial budget: ${profile.timeout_ms / 1000} seconds and ${profile.token_limit} measured tokens, including cached input.\nDeliver the final working function in the integrated project root ${candidate}. The behavioral oracle will evaluate that root. Any correct implementation strategy is valid. Do not access reference solutions, hidden tests, evaluator code or unrelated directories. External network and publication are outside this task.`;
   json(join(evidence,'task.json'),{id:task.id,prompt:task.prompt,prompt_sha256:agentDigest(task.prompt),task_sha256:agentDigest(JSON.stringify(task))});
   const started=clock();const invocations=[];let hostResult,kernelStatus=null,runId=null,outcome=null,rawAvailable=true;
   const capture=event=>{
    const index=invocations.length;invocations.push(event);json(join(evidence,`invocation-${index}.json`),serializable(event));
    if(typeof event.result?.rawJsonl==='string'||Buffer.isBuffer(event.result?.rawJsonl))writeFileSync(join(evidence,`invocation-${index}.jsonl`),event.result.rawJsonl,{flag:'wx',mode:0o600});
    else rawAvailable=false;
    if(event.result?.rawJsonlTruncated===true)rawAvailable=false;
   };
   try {
    if(variant==='native') {
     const entry=buildCodexGoalOwnerEntry({executable,projectRoot:candidate,prompt:taskContext,model:profile.model,effort:profile.effort});
     Object.assign(entry,{cwd:candidate,env:nativeEnv(env,codexHome,candidate),usageOutputKind:'codex-jsonl',captureFinalMessage:true});
     const result=await measuredProcess(entry,{timeoutMs:profile.timeout_ms,processGroup:'required'});capture({kind:'native',entry,result});hostResult=result;
    } else {
     const initialized=initializeAgentGoal(candidate,task,{model:profile.model,effort:profile.effort,executable,approveExecutable});runId=initialized.runId;
     hostResult=await driveGoalRun({root:candidate,runId,expect:initialized.expect,timeoutMs:Math.max(1,profile.timeout_ms-(clock()-started)),tokenLimit:profile.token_limit,
      env,profile:variant,task:taskContext,runProcess:measuredProcess,onInvocation:capture,...(preflight?{preflight}:{}),...(resolveCheckerSkill?{resolveCheckerSkill}:{}),...(revalidateExecutable?{revalidateExecutable}:{}),...(v2?{callTimeoutMs:profile.call_timeout_ms,noProgressTurns:profile.no_progress_turns}:{})});
     kernelStatus=captureReconciledRunSnapshot(candidate,runId).data.status;
    }
   } catch(error) {hostResult={ok:false,reason:`agent-driver:${error.message}`};}
   const measured=summarizeAgentInvocations(invocations);
   let snapshot=null;
   if(measured.usage_complete&&measured.termination_confirmed) {
    try {snapshot=copyStableAgentCandidate(candidate,join(evidence,'candidate'));json(join(evidence,'snapshot.json'),snapshot);
     outcome=executeOutcomeCases(join(evidence,'candidate'),task.id);}
    catch(error){outcome={pass:false,unavailable:true,reason:error.message};}
   }
   const trial=finalizeAgentTrial({profile:variant,taskId,requestedModel:profile.model,requestedEffort:profile.effort,invocations,hostResult,kernelStatus,outcome,
    elapsedMs:clock()-started,tokenLimit:profile.token_limit,timeoutMs:profile.timeout_ms,paths:{candidate,evidence,run_id:runId},rawTraceAvailable:rawAvailable&&invocations.length>0});
   if(v2){
    const requestedProfileEvidence=invocations.length>0&&invocations.every(({entry})=>entry?.argv?.filter(x=>x==='--model').length===1&&entry.argv[entry.argv.indexOf('--model')+1]===profile.model&&entry.argv.filter(x=>x.startsWith('model_reasoning_effort=')).length===1&&entry.argv.includes(`model_reasoning_effort=${JSON.stringify(profile.effort)}`));
    Object.assign(trial,scheduledTrial,{schema_version:2,started:true,served_model_status:'unavailable',requested_profile_evidence:requestedProfileEvidence,reviewer_profile:profile.reviewer,statistical_claim:'Repeated pilot with fixed scheduled denominator; no served-model identity claim.'});
    if(!requestedProfileEvidence){trial.status='unavailable';trial.reason='requested-profile-evidence-unavailable';}
   }
   json(join(evidence,'result.json'),trial);attempts.push(trial);
   if(!measured.usage_complete||!measured.termination_confirmed){stopped=true;stopReason=trial.reason;}
 }
 let provenanceAfter=null,provenanceError=null;
 try {provenanceAfter=captureAgentSourceProvenance(REPO_ROOT,profile.tasks);}catch(error){provenanceError=error.message;}
 const provenanceStable=provenanceAfter!==null&&sameAgentSourceProvenance(provenanceBefore,provenanceAfter);
 json(join(sessionDir,'source-after.json'),provenanceAfter||{error:provenanceError});
 const provenance={version:1,plugin_version:provenanceBefore.plugin_version,git_head:provenanceBefore.git_head,working_tree_dirty:provenanceBefore.working_tree_dirty,
  ...(v2?{git_status_sha256:provenanceBefore.git_status_sha256}:{}),before_manifest_sha256:provenanceBefore.manifest_sha256,after_manifest_sha256:provenanceAfter?.manifest_sha256??null,source_stable:provenanceStable,
  before_path:join(sessionDir,'source-before.json'),after_path:join(sessionDir,'source-after.json')};
 if(!provenanceStable){stopped=true;stopReason='agent-source-provenance-drift';}
 for(const trial of attempts){trial.provenance=provenance;if(!provenanceStable){trial.status='unavailable';trial.reason=stopReason;}
  if(v2&&!validateAgentTrialV2(trial)){
   const row=scheduled.find(row=>row.id===trial.id);
   const rawPath=join(sessionDir,`${row.id}-invalid-result.json`);json(rawPath,serializable(trial));
   const fallback={...unavailableTrial(row,profile,'result-schema-invalid'),provenance,started:trial.started===true,paths:trial.paths};
   // Retain valid measured usage; invalid proof/timing stays in the raw record.
   if(validateAgentTrialV2({...fallback,measurement:trial.measurement}))fallback.measurement=trial.measurement;
   if(Number.isFinite(trial.elapsed_ms)&&trial.elapsed_ms>=0)fallback.elapsed_ms=trial.elapsed_ms;
   Object.keys(trial).forEach(key=>delete trial[key]);Object.assign(trial,fallback);
   stopped=true;stopReason='result-schema-invalid';
  }
  if(trial.paths.evidence)writeFileSync(join(trial.paths.evidence,'result.json'),`${JSON.stringify(trial,null,2)}\n`,{mode:0o600});}
 const report={schema_version:v2?2:1,mode:'real-agent',...(v2?{scheduled,effective_limits:{trial_timeout_ms:profile.timeout_ms,native_call_timeout_ms:profile.timeout_ms,harness_call_timeout_ms:Math.min(profile.timeout_ms,profile.call_timeout_ms),token_limit_kind:'measured-next-call-admission'},summary:summarizeAgentTrialsV2(scheduled,attempts)}:{}),profile,provenance,attempts,stopped,reason:stopReason,output_dir:sessionDir,
  passed:attempts.length===scheduled.length&&attempts.every(x=>x.status==='passed'),comparison_claim:v2?'Fixed repeated pilot; report all scheduled failures and unavailable trials. No general reliability guarantee.':'No statistical efficacy or uplift conclusion from this single-trial smoke.'};
 json(join(sessionDir,'result.json'),report);return report;
}
