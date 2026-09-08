import { readFileSync } from 'node:fs';
import { validateSchemaValue } from './schema-contract.mjs';
const PROFILE_SCHEMA=JSON.parse(readFileSync(new URL('../../schemas/eval-agent-profile-v2.schema.json',import.meta.url)));
const RESULT_SCHEMA=JSON.parse(readFileSync(new URL('../../schemas/eval-agent-result-v2.schema.json',import.meta.url)));
import { createHash } from 'node:crypto';
import { validateRuntimeProfile } from '../../scripts/lib/session-profile.mjs';
export const AGENT_TASK_REGISTRY=Object.freeze(Object.fromEntries([
 'outcome-deterministic-bug-201','outcome-valid-alternative-211','outcome-dependent-integration-217','outcome-replan-evidence-218','outcome-diagnostic-repair-219',
].map(id=>[id,Object.freeze({lane:'efficacy',applicable_profiles:['native','current','minimal']})])));
const KEYS=['schema_version','mode','profiles','tasks','trials','seed','model','effort','reviewer','timeout_ms','call_timeout_ms','no_progress_turns','token_limit','allowed_effects'];
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const unique=(v,allowed)=>Array.isArray(v)&&v.length>0&&new Set(v).size===v.length&&v.every(x=>allowed.includes(x));
export function validateAgentProfileV2(v) {
 try {
  if(!validateSchemaValue(PROFILE_SCHEMA,v).ok||!exact(v,KEYS)||v.schema_version!==2||v.mode!=='real-agent'||!unique(v.profiles,['native','current','minimal'])||!unique(v.tasks,Object.keys(AGENT_TASK_REGISTRY)))return false;
  const requested=validateRuntimeProfile('codex',{model:v.model,effort:v.effort},{goalDriven:true});
  return !!requested.model&&!!requested.effort&&integer(v.trials,2,20)&&integer(v.seed,0,0xffffffff)&&integer(v.timeout_ms,1000,600000)&&integer(v.call_timeout_ms,1000,600000)&&integer(v.no_progress_turns,2,20)&&integer(v.token_limit,1,500000)
   &&exact(v.reviewer,['reviewer','mode','flags'])&&v.reviewer.reviewer==='subagent-checker'&&v.reviewer.mode==='same-model'&&Array.isArray(v.reviewer.flags)&&v.reviewer.flags.length===0
   &&JSON.stringify(v.allowed_effects)==='["isolated-workspace-write"]';
 }catch{return false;}
}
export function scheduleAgentTrials(profile) {
 if(!validateAgentProfileV2(profile))throw new Error('AGENT_PROFILE_INVALID');
 const rows=[];
 for(const task_id of profile.tasks)for(const variant of profile.profiles)for(let trial=1;trial<=profile.trials;trial++) {
  const task=AGENT_TASK_REGISTRY[task_id];if(!task.applicable_profiles.includes(variant))continue;
  const id=`${task_id}-${variant}-trial-${trial}`;
  rows.push({id,task_id,profile:variant,trial,lane:task.lane});
 }
 return rows.sort((a,b)=>{
  const hash=id=>createHash('sha256').update(`${profile.seed}:${id}`).digest('hex');return hash(a.id).localeCompare(hash(b.id));
 });
}
export function summarizeAgentTrialsV2(scheduled,attempts) {
 const ids=new Set(scheduled.map(x=>x.id));if(ids.size!==scheduled.length)throw new Error('AGENT_DUPLICATE_TRIAL');
 const byId=new Map();for(const row of attempts){if(!ids.has(row.id)||byId.has(row.id))throw new Error('AGENT_TRIAL_ID_INVALID');byId.set(row.id,row);}
 const manifests=new Set(attempts.map(r=>r.provenance?.before_manifest_sha256??null));
 if(manifests.size>1)throw new Error('AGENT_SOURCE_PROVENANCE_MISMATCH');
 const empty=()=>({planned:0,attempted:0,passed:0,failed:0,unavailable:0,budget_exceeded:0,behavior_pass:0,kernel_completed:0,no_progress_pause:0,known_tokens:0,usage_complete:true,elapsed_ms:0,token_samples:[],time_samples:[]});
 const summary={efficacy:empty(),safety:empty(),by_profile:{}};
 for(const row of scheduled){
  const lane=summary[row.lane];if(!lane)throw new Error('AGENT_LANE_INVALID');
  const item=byId.get(row.id),status=item?.status??'unavailable';if(!['passed','failed','unavailable','budget_exceeded'].includes(status))throw new Error('AGENT_TRIAL_STATUS_INVALID');
  const profile=summary.by_profile[row.profile]??=empty();
  for(const bucket of [lane,profile]){
   bucket.planned++;bucket[status]++;if(item?.started!==true)continue;
   bucket.attempted++;bucket.behavior_pass+=item.outcome_pass===true?1:0;bucket.kernel_completed+=item.kernel_completed===true?1:0;
   bucket.no_progress_pause+=['goal-owner-no-progress','goal-host-no-progress'].includes(item.reason)?1:0;
   bucket.usage_complete&&=item.measurement?.usage_complete===true;
   bucket.known_tokens+=item.measurement?.tokens??0;bucket.elapsed_ms+=item.elapsed_ms??0;
   if(item.measurement?.usage_complete)bucket.token_samples.push(item.measurement.tokens);
   if(Number.isFinite(item.elapsed_ms))bucket.time_samples.push(item.elapsed_ms);
  }
 }
 const stats=values=>{values.sort((a,b)=>a-b);const n=values.length;return {n,median:n?(values[Math.floor((n-1)/2)]+values[Math.floor(n/2)])/2:null,p90:n?values[Math.ceil(n*0.9)-1]:null};};
 for(const bucket of [summary.efficacy,summary.safety,...Object.values(summary.by_profile)]){
  bucket.tokens_per_completion=bucket.passed&&bucket.usage_complete?bucket.known_tokens/bucket.passed:null;
  bucket.token_distribution=stats(bucket.token_samples);bucket.time_distribution=stats(bucket.time_samples);
  delete bucket.token_samples;delete bucket.time_samples;
 }
 return summary;
}
export function validateAgentTrialV2(v) {
 if(!validateSchemaValue(RESULT_SCHEMA,v).ok||!v||v.schema_version!==2||!AGENT_TASK_REGISTRY[v.task_id]||v.lane!==AGENT_TASK_REGISTRY[v.task_id].lane||!integer(v.trial,1,20)||v.id!==`${v.task_id}-${v.profile}-trial-${v.trial}`||!['native','current','minimal'].includes(v.profile)||!['passed','failed','unavailable','budget_exceeded'].includes(v.status)||v.served_model_status!=='unavailable')return false;
 if(v.status==='passed')return v.provenance?.source_stable===true&&v.raw_trace_available===true&&v.measurement?.usage_complete===true&&v.measurement?.termination_confirmed===true&&v.requested_profile_evidence===true&&v.outcome_pass===true&&v.outcome?.pass===true&&(v.profile==='native'||v.kernel_completed===true&&v.kernel_status==='completed');
 return true;
}
