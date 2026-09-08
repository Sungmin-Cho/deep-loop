import { isCanonicalCodexProviderThreadId } from './usage-parser.mjs';
import { normalizeReviewerAlias } from './reviewer-alias.mjs';
import { createHash } from 'node:crypto';
import { isGoalDriven, GOAL_LIMITS } from './goal-contract.mjs';
import { sessionRuntime, runtimeCapability } from './runtime.mjs';
import { validateRuntimeProfile } from './session-profile.mjs';

const controllers=new WeakSet(),issued=new WeakMap();
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])])):value;
export const goalPlanHash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export function normalizeGoalReview(review={}) {
 const reviewer=normalizeReviewerAlias(review.reviewer===undefined?'subagent-checker':review.reviewer);
 return {...review,reviewer,mode:review.mode===undefined?'cross-model':review.mode,flags:review.flags===undefined?[]:review.flags};
}
export function goalReviewRemediation(){return {command:'init-run',applies_to:'new-run-only',review:{points:['implementation'],reviewer:'subagent-checker',mode:'same-model',flags:[],converge:true,max_review_rounds:5,require_human_ack:false},supervision:'delegated',boundary_mode:'continue',required_existing_fields:['goal','goal-contract','runtime','model','effort','project-root'],note:'Preserve the original goal and authority. Do not patch an existing run or silently change review policy.'};}
const rejected=reason=>({ok:false,reason,remediation:goalReviewRemediation(),model_availability:'unprobed'});
export function compileGoalExecutionPlan({loop,options={}}={}) {
 try {
  if(!isGoalDriven(loop)||!runtimeCapability(sessionRuntime(loop),'persistent_goal_owner'))return rejected('goal-owner-runtime-unavailable');
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['callTimeoutMs','noProgressTurns'].includes(k)))return rejected('goal-execution-options-invalid');
  const call=options.callTimeoutMs===undefined?120000:options.callTimeoutMs,progress=options.noProgressTurns===undefined?3:options.noProgressTurns;
  if(!Number.isSafeInteger(call)||call<1000||call>600000||!Number.isSafeInteger(progress)||progress<2||progress>20)return rejected('goal-execution-options-invalid');
  const review=normalizeGoalReview(loop.review);
  if(!Array.isArray(review.flags)||review.flags.some(x=>typeof x!=='string')||!Array.isArray(review.points)||review.points.length===0||review.points.some(x=>!['design','plan','implementation'].includes(x))||new Set(review.points).size!==review.points.length||typeof review.converge!=='boolean'||!Number.isSafeInteger(review.max_review_rounds)||review.max_review_rounds<1||review.max_review_rounds>GOAL_LIMITS.reviewRounds||typeof review.require_human_ack!=='boolean')return rejected('goal-review-config-invalid');
  if(review.reviewer!=='subagent-checker')return rejected('configured-review-workflow-unavailable');
  if(review.mode==='cross-model')return rejected('checker-model-evidence-unavailable');
  if(review.mode!=='same-model'||review.flags.length)return rejected('configured-review-options-unavailable');
  const profile=validateRuntimeProfile(sessionRuntime(loop),{model:loop.autonomy.session_model,effort:loop.autonomy.session_effort},{goalDriven:true});
  if(!profile.model||!profile.effort)return rejected('goal-owner-profile-required');
  return {ok:true,plan:{version:1,root:loop.project.root,run_id:loop.run_id,owner:loop.session_chain.lease.owner_run_id,generation:loop.session_chain.lease.generation,
   review_config_sha256:goalPlanHash(review),executable_approval_sha256:goalPlanHash(loop.autonomy.runtime_executable_approval??null),owner_profile:profile,maker_checker:{reviewer:'subagent-checker',mode:'same-model',flags:[],transport:'codex',...profile,independence:'separate-process'},goal_checker:{transport:'codex',...profile,independence:'separate-process'},
   limits:{call_timeout_ms:call,no_progress_turns:progress,diagnostic_turns:1,activity_extension_turns:2,setup_turns:3,no_transition_iterations:2},evidence_class:'requested-profile-and-isolated-process',served_model_status:'unavailable'},model_availability:'unprobed'};
 }catch(error){return rejected(error.message);}
}
export function createGoalPlanController(){const c=Object.freeze({});controllers.add(c);return c;}
export function expireGoalPlanController(c){controllers.delete(c);}
export function issueGoalExecutionPlan(controller,{loop,options,doctrine}={}){
 if(!controllers.has(controller))throw new Error('GOAL_PLAN_CONTROLLER_INVALID');
 const compiled=compileGoalExecutionPlan({loop,options});if(!compiled.ok)throw new Error(compiled.reason);
 if(!doctrine?.skill?.canonical_path)throw new Error('checker-skill-unavailable');
 const plan=freeze({...compiled.plan,doctrine:structuredClone(doctrine),doctrine_sha256:goalPlanHash(doctrine)});
 issued.set(plan,{controller,compiledHash:goalPlanHash(compiled.plan)});return plan;
}
export function assertGoalPlanIdentity(plan){const p=issued.get(plan);if(!p)throw new Error('GOAL_PLAN_NOT_ISSUED');if(!controllers.has(p.controller))throw new Error('goal-execution-plan-stale');return plan;}
export function assertIssuedGoalExecutionPlan(plan,loop){
 assertGoalPlanIdentity(plan);const checked=compileGoalExecutionPlan({loop,options:{callTimeoutMs:plan.limits.call_timeout_ms,noProgressTurns:plan.limits.no_progress_turns}});
 if(!checked.ok||goalPlanHash(checked.plan)!==issued.get(plan).compiledHash)throw new Error('goal-execution-plan-stale');return plan;
}
export function assertGoalReviewDescriptor(plan,registered,bound,action){
 const d=registered?.descriptor;
 if(!d||d.kind!=='agent'||d.agent_role!=='code-reviewer'||d.role!=='checker'||d.mode!==plan.maker_checker.mode||d.args!==''||d.requires_independent_session!==true||d.review_point!==action.point||d.workstream!==action.workstream_id||bound?.plugin!=='subagent-checker'||bound?.target_maker!==action.episode_id||bound?.status!=='pending')throw new Error('checker-registration-binding-mismatch');
}
export function validateGoalCheckerSession(result,{ownerThreads=[],argv=[]}={}) {
 if(!ownerThreads.length||ownerThreads.some(x=>!isCanonicalCodexProviderThreadId(x)))return 'checker-owner-session-evidence-unavailable';
 if(result?.termination?.confirmed!==true||result?.process_group?.mode!=='required'||result?.process_group?.quiescence_confirmed!==true||(Array.isArray(result?.observedSurvivors)&&result.observedSurvivors.length>0))return 'checker-termination-unconfirmed';
 if(!Number.isSafeInteger(result.process_group.group_id)||result.process_group.group_id<=0||!isCanonicalCodexProviderThreadId(result.providerThreadId)||ownerThreads.includes(result.providerThreadId)||argv.includes('resume')||argv.includes('--last'))return 'checker-session-independence-unavailable';
 return null;
}
