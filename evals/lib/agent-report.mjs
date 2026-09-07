import { createHash } from 'node:crypto';
import { isMeasuredOneTurnUsage } from '../../scripts/lib/budget.mjs';
export const AGENT_PROFILE_VERSION = 1;
export const AGENT_PROFILES = Object.freeze(['native', 'current', 'minimal']);
export const AGENT_SMOKE_TASKS = Object.freeze(['outcome-deterministic-bug-201', 'outcome-valid-alternative-211']);
export function validateAgentProfile(value) {
 const keys = ['schema_version','mode','profiles','tasks','trials','model','effort','timeout_ms','token_limit','allowed_effects'];
 return !!value && Object.keys(value).every(k=>keys.includes(k)) && keys.every(k=>Object.hasOwn(value,k))
  && value.schema_version===1 && value.mode==='real-agent' && value.trials===1
  && Array.isArray(value.profiles) && value.profiles.length>0 && new Set(value.profiles).size===value.profiles.length && value.profiles.every(x=>AGENT_PROFILES.includes(x))
  && Array.isArray(value.tasks) && value.tasks.length>0 && new Set(value.tasks).size===value.tasks.length && value.tasks.every(x=>AGENT_SMOKE_TASKS.includes(x))
  && typeof value.model==='string' && !!value.model.trim() && typeof value.effort==='string' && !!value.effort.trim()
  && Number.isSafeInteger(value.timeout_ms) && value.timeout_ms>0 && value.timeout_ms<=600000
  && Number.isSafeInteger(value.token_limit) && value.token_limit>0 && value.token_limit<=500000
  && JSON.stringify(value.allowed_effects)===JSON.stringify(['isolated-workspace-write']);
}
export function summarizeAgentInvocations(invocations) {
 let tokens=0, turns=0; const missing=[]; const teardown=[]; const observed=[];
 for (let index=0;index<invocations.length;index++) {
  const r=invocations[index].result;
  if(!isMeasuredOneTurnUsage(r?.usage)) missing.push(index); else {tokens+=r.usage.tokens;turns+=r.usage.num_turns;}
  if(r?.termination?.confirmed!==true || r?.process_group?.mode!=='required' || r?.process_group?.quiescence_confirmed!==true || (Array.isArray(r?.observedSurvivors)&&r.observedSurvivors.length>0)) teardown.push(index);
  if(typeof r?.observedModel==='string') observed.push(r.observedModel);
 }
 return {tokens,turns,usage_complete:invocations.length>0 && missing.length===0,termination_confirmed:invocations.length>0 && teardown.length===0,
  missing_usage_invocations:missing,unconfirmed_termination_invocations:teardown,observed_models:[...new Set(observed)]};
}
export const agentDigest = value => createHash('sha256').update(value).digest('hex');
export function finalizeAgentTrial({profile,taskId,requestedModel,requestedEffort,invocations,hostResult,kernelStatus=null,outcome=null,elapsedMs,tokenLimit,timeoutMs,paths,rawTraceAvailable=false}) {
 const measurement=summarizeAgentInvocations(invocations);
 const overBudget=measurement.tokens>tokenLimit || elapsedMs>timeoutMs;
 const kernelCompleted=kernelStatus==='completed'; const outcomePass=outcome?.pass===true;
 const passed=rawTraceAvailable && measurement.usage_complete && measurement.termination_confirmed && !overBudget && hostResult?.ok===true
  && outcomePass && (profile==='native'||kernelCompleted);
 const unavailable=!measurement.usage_complete || !measurement.termination_confirmed || !rawTraceAvailable;
 return {schema_version:1,mode:'real-agent',profile,task_id:taskId,trial:1,
  requested_model:requestedModel,requested_effort:requestedEffort,observed_models:measurement.observed_models,
  status:passed?'passed':unavailable?'unavailable':overBudget?'budget_exceeded':'failed',
  reason:passed?null:unavailable?hostResult?.reason||'required-process-evidence-unavailable':overBudget?'trial-budget-exceeded':hostResult?.reason||(!outcomePass?'behavior-oracle-failed':'kernel-not-completed'),
  kernel_status:kernelStatus,kernel_completed:kernelCompleted,outcome_pass:outcomePass,outcome,
  measurement,elapsed_ms:elapsedMs,raw_trace_available:rawTraceAvailable,paths,
  termination_scope:'owned-posix-process-group',containment_limit:'Escaped descendants are not universally contained; observed survivors invalidate teardown.',
  provider_state_effect:'Persistent Codex rollouts may be written under the authenticated CODEX_HOME.',
  statistical_claim:'single-trial-smoke-only'};
}

export function validateAgentTrial(value) {
 if(!value || value.schema_version!==1 || value.mode!=='real-agent' || !AGENT_PROFILES.includes(value.profile)
  || !AGENT_SMOKE_TASKS.includes(value.task_id) || value.trial!==1
  || !['passed','failed','unavailable','budget_exceeded'].includes(value.status)
  || typeof value.outcome_pass!=='boolean' || typeof value.kernel_completed!=='boolean'
  || !Number.isFinite(value.elapsed_ms) || value.elapsed_ms<0 || !value.measurement
  || !Number.isSafeInteger(value.measurement.tokens) || value.measurement.tokens<0) return false;
 if(value.kernel_completed!==(value.kernel_status==='completed'))return false;
 if(value.outcome_pass!==(value.outcome?.pass===true))return false;
 return value.status!=='passed' || (value.provenance?.source_stable!==false && value.outcome_pass && value.raw_trace_available===true
  && value.measurement.usage_complete===true && value.measurement.termination_confirmed===true
  && (value.profile==='native'||value.kernel_completed));
}

export function sameAgentSourceProvenance(before,after) {
 return before?.manifest_sha256===after?.manifest_sha256 && before?.git_head===after?.git_head
  && before?.git_status_sha256===after?.git_status_sha256 && before?.plugin_version===after?.plugin_version;
}
