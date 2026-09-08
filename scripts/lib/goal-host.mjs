import { probeGoalChecker } from './goal-checker-probe.mjs';
import { createGoalProgressWatchdog, goalProgressKey, goalRecoveryDiagnostic, boundArtifactActivity, changedBoundArtifact } from './goal-progress.mjs';
import { compileGoalExecutionPlan, createGoalPlanController, issueGoalExecutionPlan, assertIssuedGoalExecutionPlan, expireGoalPlanController, assertGoalReviewDescriptor, goalPlanHash } from './goal-execution-plan.mjs';
import { createGoalCallBudget } from './goal-call-budget.mjs';
import { issueCallCharge, settleCallCharge } from './goal-call-accounting.mjs';
import { captureVerifiedRunSnapshot } from './integrity.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureReconciledRunSnapshot, pauseRun, runDir } from './state.mjs';
import { isGoalDriven } from './goal-contract.mjs';
import { sessionRuntime, runtimeCapability } from './runtime.mjs';
import { readLines } from './integrity.mjs';
import { wrap } from './envelope.mjs';
import { headlessSpawn } from './spawn-driver.mjs';
import { leaseCheck } from './lease.mjs';
import { nextAction } from './next-action.mjs';
import { recordCost, isMeasuredOneTurnUsage, settleCodexPreflightCost, settleGoalOwnerCost } from './budget.mjs';
import { withHeadlessHostService } from './headless-host.mjs';
import { buildCodexGoalOwnerEntry, buildMinimalCodexEnv } from './codex-runtime.mjs';
import { runStreamingProcessSync } from './streaming-process.mjs';
import { revalidateTrustedRuntimeExecutable, resolveAuthenticatedCodexHome } from './runtime-executable.mjs';
import { resolveTrustedCheckerSkill, runIndependentCodexChecker } from './codex-checker.mjs';
import { ensureCodexPreflight } from './codex-preflight.mjs';
import { issueGoalOwnerTurn, bindGoalOwnerResult } from './goal-owner-receipt.mjs';
import { drivePendingGoalReview } from './goal-checker.mjs';
import { finishRun } from './finish.mjs';
import { ownerSession } from './session-scope.mjs';
import { recordWorkstreamTerminal } from './workspace.mjs';
import { dispatchReview } from './review.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const fresh = (root, runId) => captureReconciledRunSnapshot(root, runId).data;
const markerPath = (root,runId,fence) => join(runDir(root,runId),'owner-process-intents',`${fence.owner}-${fence.generation}.json`);
const fenceOf = loop => ({owner:loop.session_chain.lease.owner_run_id,generation:loop.session_chain.lease.generation});
const measured = result => result?.termination?.confirmed === true
  && result?.process_group?.quiescence_confirmed === true && isMeasuredOneTurnUsage(result.usage);

export function buildGoalOwnerContext({loop,action,deepLoopRoot=ROOT,hostBudget=null}) {
  if(!isGoalDriven(loop) || !action || typeof action.type !== 'string')throw new Error('GOAL_OWNER_CONTEXT_INVALID');
  if(hostBudget !== null && (!hostBudget || !['remaining_tokens','remaining_time_ms','remaining_owner_turns'].every(key=>Number.isSafeInteger(hostBudget[key]) && hostBudget[key]>=0)))throw new Error('GOAL_OWNER_CONTEXT_BUDGET_INVALID');
  if(hostBudget?.remaining_call_time_ms!==undefined&&(!Number.isSafeInteger(hostBudget.remaining_call_time_ms)||hostBudget.remaining_call_time_ms<1))throw new Error('GOAL_OWNER_CONTEXT_BUDGET_INVALID');
  const owner=ownerSession(loop);
  return structuredClone({context_kind:'goal-owner-v1',state_version:loop.schema_version,
    node_path:process.execPath,kernel_path:join(deepLoopRoot,'scripts/deep-loop.mjs'),
    root:loop.project.root,run_id:loop.run_id,...fenceOf(loop),
    report_path:join(runDir(loop.project.root,loop.run_id),'final-report.md'),
    report_template:wrap({producer:'deep-loop',artifact_kind:'final-report',schema:{name:'final-report',version:'1.0'},
      run_id:loop.run_id,parent_run_id:loop.session_chain.parent_run_id,payload:{markdown:''},now:loop.updated_at}),
    event_log_head:loop.event_log_head,scope_epoch:owner.scope_epoch,current_scope:owner.scope,
    routing:{protocol:loop.routing.protocol},review:loop.review,host_budget:hostBudget,
    session_profile:{model:loop.autonomy.session_model,effort:loop.autonomy.session_effort},
    workstreams:loop.workstreams.map(({id,title,worktree,branch,status,requirement_ids,depends_on,review_points_done})=>
      ({id,title,worktree,branch,status,requirement_ids,depends_on,review_points_done})),
    current_action:action,
    episodes:loop.episodes.filter(episode=>episode.id===action.episode_id || episode.id===action.target_maker)
      .map(({id,role,plugin,kind,point,workstream_id,status,expected_artifacts,execution,routing,proof,target_maker,retry_of})=>
        ({id,role,plugin,kind,point,workstream_id,status,expected_artifacts,execution,routing,proof,target_maker,retry_of})),
    goal:loop.goal,goal_contract:loop.goal_contract,
    goal_review:loop.goal_reviews.at(-1) ? {id:loop.goal_reviews.at(-1).id,status:loop.goal_reviews.at(-1).status,
      result_rel:loop.goal_reviews.at(-1).result_rel,verdict:loop.goal_reviews.at(-1).verdict} : null});
}

function buildGoalOwnerPacket({loop,action,deepLoopRoot=ROOT,profile='current',task=null,hostBudget=null,loadedPolicySha=null}) {
  if(!['current','minimal'].includes(profile))throw new Error('GOAL_OWNER_PROFILE_INVALID');
  const frame=buildGoalOwnerContext({loop,action,deepLoopRoot,hostBudget});
  let policy='Goal owner minimal policy v1: fulfill the original outcomes using your judgment and the supplied action. Mutate state only through kernel CLI. Perform one bounded logical action or maker stage and yield. Independent reviewers and proof-gated closure/finish belong to the host. Never fabricate evidence or human authority.';
  let policySource='minimal-policy-v1';
  if(profile==='current') {
    policySource=join(deepLoopRoot,'skills/deep-loop-workflow/references/goal-owner.md');
    const stat=lstatSync(policySource);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>32768)throw new Error('GOAL_OWNER_POLICY_INVALID');
    const bytes=readFileSync(policySource);
    if(bytes.length>32768)throw new Error('GOAL_OWNER_POLICY_INVALID');
    policy=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }
  const policySha=digest(policy);
  const policyBody=loadedPolicySha===policySha ? 'The previously supplied owner policy still applies. Reload only its named source if native context restoration has lost the details.' : policy;
  const prompt=[`Official ${profile} host-owner policy from ${policySource}; SHA256 ${policySha}.`,policyBody,
    `Host context snapshot (context, not mutation authority): ${JSON.stringify(frame)}`,
    task ? `Task context: ${task}` : '',
    'Use the supplied facts and action. Do not rediscover unchanged fields or load legacy/entry workflows. Refresh after the action boundary or stale/fence evidence.',
    'Complete one bounded maker stage, including its necessary planning/setup/selection/registration; batch predictable typed CLI steps in one tool call with actual-result bindings, then yield. Do not start a second maker or retry round.',
    frame.host_budget?.remaining_call_time_ms ? `This owner invocation has at most ${frame.host_budget.remaining_call_time_ms} milliseconds, separate from the whole-run horizon. Yield with the current exact action before this call deadline; a setup-only or partial inline-stage yield may continue on the same thread. Never wait for the host to kill a productive call.` : '',
    'Artifact arguments are project-root-relative and worktree-prefixed (for example .worktrees/task/solution.mjs), even when the worktree registration path is absolute. Keep scratch helpers inside the selected worktree.',
    'For dispatch_checker yield: the host registers and runs the already-configured independent checker. Never claim or execute it as the owner. Yield for whole-goal review. At finish populate the supplied M3 report template with the factual report, write it to report_path, then yield before finish.',
    'External push, PR, merge, publish, network and delete actions are outside this isolated execution scope. Report genuinely missing authority or requirements without inventing them.',
  ].filter(Boolean).join('\n');
  return {prompt,policySha};
}

export function buildGoalOwnerPrompt(options) { return buildGoalOwnerPacket(options).prompt; }

// Establish the ordinary executable/isolation contract, then measure an actual
// persistent two-turn read-only nonce exchange. No --last or candidate session ID
// participates in this binding. All probe invocations are included in accounting.
export function preflightGoalOwner({root,runId,loop,expect,env,deepLoopRoot,timeoutMs,runProcess=runStreamingProcessSync,onInvocation=()=>{},wallNow=Date.now}) {
  const executable=revalidateTrustedRuntimeExecutable(loop.autonomy.runtime_executable_approval);
  const codexHome=resolveAuthenticatedCodexHome({env,platform:executable.platform});
  const checkerDoctrine=resolveTrustedCheckerSkill({codexHome:codexHome.canonical_path});
  const emitProbe=event=>onInvocation({...event,doctrine_sha256:goalPlanHash(checkerDoctrine)});
  const probeDeadline=wallNow()+timeoutMs;
  const runProbe=(entry,options)=>{const available=probeDeadline-wallNow();if(available<=0)return {ok:false,reason:'goal-host-deadline'};const result=runProcess(entry,{...options,timeoutMs:Math.min(options.timeoutMs,available),processGroup:'required',captureRawJsonl:true});emitProbe({kind:'runtime-preflight',entry,result});return result;};
  const settle=receipt=>settleCodexPreflightCost(root,runId,{receipt,fence:{...expect,intent:'accounting'}});
  const proof=ensureCodexPreflight({projectRoot:root,runId,executableIdentity:executable,codexHomeIdentity:codexHome,
    deepLoopRoot,resumeSkillPath:join(deepLoopRoot,'skills/deep-loop-resume/SKILL.md'),sourceEnv:env,
    owner:expect.owner,generation:expect.generation,model:loop.autonomy.session_model,effort:loop.autonomy.session_effort,
    goalDriven:true,timeoutMs,runSync:runProbe,settleAccountingReceipt:settle,settleOrphanAccountingReceipt:settle});
  if (!proof.ok) return proof;
  const childEnv=buildMinimalCodexEnv({sourceEnv:env,codexHome:codexHome.canonical_path,runId,projectRoot:root,...expect});
  const nonce=randomBytes(16).toString('hex'); let thread=null;
  const deniedPath=join(root,`.goal-readonly-probe-${nonce}`);
  const probes=[];
  for(let i=0;i<2;i++) {
    if(probeDeadline-wallNow()<=0)return {ok:false,reason:'goal-host-deadline',probes};
    const entry=buildCodexGoalOwnerEntry({executable:executable.canonical_path,projectRoot:root,
      model:loop.autonomy.session_model,effort:loop.autonomy.session_effort,sandbox:'read-only',providerThreadId:thread,
      prompt:i===0?`Read-only continuity probe. Remember this nonce in this conversation: ${nonce}. Reply exactly READY. Do not use tools.`
        :`Read-only continuity probe. Attempt exactly one shell command to create the file ${JSON.stringify(deniedPath)} with the bytes probe. The read-only sandbox must reject the write; do not retry or request permission. Then return exactly the nonce from the previous turn, with no other text.`});
    Object.assign(entry,{env:childEnv,cwd:root,usageOutputKind:'codex-jsonl',captureFinalMessage:true});
    const available=probeDeadline-wallNow();if(available<=0)return {ok:false,reason:'goal-host-deadline',probes};
    const charge=issueCallCharge({root,runId,fence:expect,kind:'owner-probe'});
    const result=runProcess(entry,{timeoutMs:available,processGroup:'required',captureRawJsonl:true});
    probes.push(result);emitProbe({kind:'owner-preflight',entry,result});
    if(measured(result)) settleCallCharge(charge,result);
    if(!result?.ok || !measured(result) || !UUID.test(result.providerThreadId || '')
      || (thread!==null && thread!==result.providerThreadId)) return {ok:false,reason:'owner-continuity-unavailable',probes};
    thread=result.providerThreadId;
    if(i===1 && (existsSync(deniedPath) || result.finalMessage?.toString().trim()!==nonce)) return {ok:false,reason:'owner-continuity-mismatch',probes};
  }
  const checkerCharge=issueCallCharge({root,runId,fence:expect,kind:'checker-probe'});
  const checker=probeGoalChecker({executable:executable.canonical_path,root,model:loop.autonomy.session_model,effort:loop.autonomy.session_effort,env:buildMinimalCodexEnv({sourceEnv:env,codexHome:codexHome.canonical_path,runId,projectRoot:root,owner:`checker-probe-${nonce}`,generation:expect.generation}),ownerThreads:[thread],timeoutMs:probeDeadline-wallNow(),runProcess,onInvocation:emitProbe});
  if(measured(checker.result))settleCallCharge(checkerCharge,checker.result);
  if(!checker.ok)return {ok:false,reason:checker.reason,probes};
  return {ok:true,executable,codexHome,probes,measured_usage:proof.measured_usage};
}

export async function driveGoalRun({root,runId,expect=null,timeoutMs,maxTurns,tokenLimit,
  env=process.env,deepLoopRoot=ROOT,profile='current',task=null,now=Date.now,runProcess=runStreamingProcessSync,
  preflight=preflightGoalOwner,goalService=drivePendingGoalReview,onInvocation=()=>{},wallNow=Date.now,resolveCheckerSkill=resolveTrustedCheckerSkill,callTimeoutMs=120000,noProgressTurns=3,...serviceOptions}={}) {
  const invocations=[]; const started=wallNow();
  const sampleNow=typeof now==='function'?now:()=>now;
  if(Object.hasOwn(serviceOptions,'goalExecutionPlan')||Object.hasOwn(serviceOptions,'goalOwnerThreads')||Object.hasOwn(serviceOptions,'goalPlanController')||Object.hasOwn(serviceOptions,'goalCallAdmission'))return {ok:false,reason:'GOAL_PLAN_RESERVED_OPTION',invocations};
  let initial;try{initial=fresh(root,runId);}catch(error){return {ok:false,reason:error.message,invocations,recovery:readGoalRecovery(root,runId,error.message)};}
  const expected=expect || fenceOf(initial);
  timeoutMs ??= Math.max(1,initial.budget.max_wallclock_sec * 1000 - (new Date(sampleNow()).getTime()-Date.parse(initial.created_at)));
  maxTurns ??= Math.max(1,initial.budget.total-initial.budget.spent);
  tokenLimit ??= Math.max(1,initial.budget.tokens_total-initial.budget.tokens_spent);
  if(!['current','minimal'].includes(profile)||!Number.isSafeInteger(maxTurns)||maxTurns<1||!Number.isSafeInteger(timeoutMs)||timeoutMs<1
    ||!Number.isSafeInteger(tokenLimit)||tokenLimit<1) return {ok:false,reason:'goal-host-options-invalid',invocations};
  if(!isGoalDriven(initial)||!runtimeCapability(sessionRuntime(initial),'persistent_goal_owner')) return {ok:false,reason:'goal-owner-runtime-unavailable',invocations};
  if(!initial.autonomy.session_model||!initial.autonomy.session_effort)return {ok:false,reason:'goal-owner-profile-required',invocations};
  if(profile === 'minimal' && initial.orchestration.boundary_mode !== 'continue')return {ok:false,reason:'minimal-profile-requires-continue-boundary',invocations};
  if(!leaseCheck(initial,{...expected,intent:'lease'}).ok) return {ok:false,reason:'goal-owner-fenced',invocations};
  const compiled=compileGoalExecutionPlan({loop:initial,options:{callTimeoutMs,noProgressTurns}});
  if(!compiled.ok)return {...compiled,invocations};
  let evidenceFailure=null,activePlan=null;
  const emit=event=>{
    const entry=event.entry,result=event.result,context=event.binding_context??{};
    const {doctrine,...planFields}=activePlan??compiled.plan;
    const record={...event,...callBudget.observation(result),audit:{version:1,
      plan_sha256:goalPlanHash(planFields),doctrine_sha256:event.doctrine_sha256??activePlan?.doctrine_sha256??null,
      requested_model:initial.autonomy.session_model,native_effort:initial.autonomy.session_effort,
      observed_model:null,served_model_status:'unavailable',evidence_class:compiled.plan.evidence_class,
      session_id:result?.providerThreadId??null,attempt_id:context.attempt_id??null,target_maker:context.target_maker??null,episode_id:context.episode_id??null,
      argv_sha256:entry?digest(JSON.stringify(entry.argv)):null,prompt_sha256:entry?digest(entry.stdin??''):null,
      usage:result?.usage??null,termination:result?.termination??null,process_group:result?.process_group??null}};
    invocations.push(record);try{onInvocation(record);}catch(error){evidenceFailure=String(error.message||error);}
  };
  const remaining=()=>timeoutMs-(wallNow()-started);
  let trustedExecutable=null;
  const callBudget=createGoalCallBudget({readLoop:()=>fresh(root,runId),tokenLimit,remaining,callTimeoutMs,now:sampleNow,runProcess,validateEntry:entry=>{
    if(trustedExecutable){
      if(entry.bin!==trustedExecutable.canonical_path)throw new Error('goal-call-executable-mismatch');
      const observed=(serviceOptions.revalidateExecutable??revalidateTrustedRuntimeExecutable)(fresh(root,runId).autonomy.runtime_executable_approval);
      if(goalPlanHash(observed)!==goalPlanHash(trustedExecutable))throw new Error('goal-call-executable-drift');
    }
  }});
  const observedProcess=(kind,binding_context={})=>(entry,options)=>{const context=typeof binding_context==='function'?binding_context():binding_context;const result=callBudget.run(entry,options);emit({kind,entry,result,binding_context:context});return result;};
  const tokensUsed=()=>callBudget.summary().tokens;
  const controller=createGoalPlanController();
  try {const hostResult=await withHeadlessHostService({root,runId,timeoutMs,...serviceOptions,resolveCheckerSkill},async service=>{
    let plan=null,thread=null,ownerFence=expected,turns=0;
    const watchdog=createGoalProgressWatchdog({limits:compiled.plan.limits,initial});
    let controlSignature=null,controlRepeats=0; const heldOwners=new Set(),ownerThreads=new Set(),loadedPolicies=new Map();
    const fail=reason=>{
      try {const loop=fresh(root,runId);if(loop.status==='running')pauseRun(root,runId,{reason,expect:ownerFence,now:sampleNow()});} catch { /* preserve newer fence/terminal authority */ }
      return {ok:false,reason,invocations,providerThreadId:thread,budget:callBudget.summary(),recovery:readGoalRecovery(root,runId,reason,{remainingOwnerTurns:Math.max(0,maxTurns-turns)})};
    };
    const initialDescriptor=nextAction(initial,{now:sampleNow(),unattended:true});
    const initialAction=initialDescriptor.action;
    if(initialAction.type==='await_human' || initialDescriptor.gate?.allowed===false)return fail(initialAction.reason || 'goal-host-gate-blocked');
    if(initialAction.type==='finish'){
      try{finishRun(root,runId,{status:'completed',reportRel:'final-report.md',fence:expected,now:sampleNow()});return {ok:true,status:'completed',invocations,providerThreadId:null};}
      catch(error){if(!String(error.message).toLowerCase().includes('report'))return fail(error.message);}
    }
    // A marker is evidence of an earlier owner process, never authority to adopt
    // a provider UUID from candidate-readable state. Lost host bindings stop.
    if(existsSync(markerPath(root,runId,expected)) || initial.session_chain.lease.handoff_phase === 'acquired'
      || readLines(root,runId).some(event=>event.type === 'cost' && event.data?.source === 'goal-owner-measured'
        && event.data.owner === expected.owner && event.data.generation === expected.generation))return fail('owner-provider-binding-unavailable');
    if(remaining()<=0)return fail('goal-host-deadline');
    let ready;
    try {ready=preflight({root,runId,loop:initial,expect:ownerFence,env,deepLoopRoot,timeoutMs:remaining(),runProcess:(entry,options)=>callBudget.run(entry,options),onInvocation:emit,wallNow});}
    catch(error){return fail(`goal-owner-preflight:${error.message}`);}
    if(ready?.ok)trustedExecutable=ready.executable;
    if(!ready?.ok)return fail(ready?.reason || 'goal-owner-preflight-unavailable');
    if(evidenceFailure)return fail(`goal-evidence-write-failed:${evidenceFailure}`);
    try { plan=activePlan=issueGoalExecutionPlan(controller,{loop:fresh(root,runId),options:{callTimeoutMs,noProgressTurns},doctrine:resolveCheckerSkill({codexHome:ready.codexHome.canonical_path})}); }catch(error){return fail(error.message);}
    for(;;) {
      if(evidenceFailure)return fail(`goal-evidence-write-failed:${evidenceFailure}`);
      let loop=fresh(root,runId);
      if(['completed','stopped'].includes(loop.status))return {ok:loop.status==='completed',status:loop.status,invocations,providerThreadId:thread};
      if(loop.status==='paused')return {ok:false,status:'paused',reason:loop.pause_reason || 'run-paused',invocations,providerThreadId:thread};
      if(wallNow()-started>=timeoutMs)return fail('goal-host-deadline');
      try {assertIssuedGoalExecutionPlan(plan,loop);} catch(error){return fail(error.message);}
      const signature=goalPlanHash({episodes:loop.episodes,workstreams:loop.workstreams,reviews:loop.goal_reviews,lease:loop.session_chain.lease});
      controlRepeats=signature===controlSignature?controlRepeats+1:0;controlSignature=signature;
      if(controlRepeats>=2)return fail('headless-service-no-progress');
      const emittedHandoff=loop.session_chain.lease.handoff_phase==='emitted';
      if(!leaseCheck(loop,{...ownerFence,intent:emittedHandoff?'lease':'business'}).ok)return fail('goal-owner-fenced');
      const pendingChecker=loop.episodes.some(x=>x.role==='checker'&&['pending','in_progress'].includes(x.status));
      if(pendingChecker||emittedHandoff) {
        if(pendingChecker&&!thread)return fail('checker-owner-session-evidence-unavailable');
        try {assertIssuedGoalExecutionPlan(plan,loop);}catch(error){return fail(error.message);}
        if(tokensUsed()>=tokenLimit)return fail('goal-host-token-limit');
        if(remaining()<=0)return fail('goal-host-deadline');
        const result=service({expect:ownerFence,env,deepLoopRoot,timeoutMs:remaining(),clock:sampleNow,
          ...(pendingChecker?{goalExecutionPlan:plan,goalOwnerThreads:[...ownerThreads],goalCallAdmission:()=>callBudget.admit()}:{}),
          preflightFn:options=>ensureCodexPreflight({...options,runSync:observedProcess('runtime-preflight')}),
          checkerRunFn:options=>runIndependentCodexChecker({...options,runProcess:observedProcess('checker',{attempt_id:options.contract.attempt_id,target_maker:options.contract.target_maker,episode_id:options.contract.checker_episode_id})}),
          spawnFn:(entry,options)=>headlessSpawn(entry,{...options,runSync:observedProcess('handoff')})});
        if(!result?.ok)return fail(result?.reason || result?.action || 'headless-service-unavailable');
        const after=fresh(root,runId),nextFence=fenceOf(after);
        if(nextFence.owner!==ownerFence.owner||nextFence.generation!==ownerFence.generation) {
          if(!UUID.test(result.providerThreadId || ''))return fail('handoff-provider-binding-unavailable');
          ownerFence=nextFence;thread=result.providerThreadId;ownerThreads.add(thread);
          try {plan=activePlan=issueGoalExecutionPlan(controller,{loop:after,options:{callTimeoutMs,noProgressTurns},doctrine:resolveCheckerSkill({codexHome:ready.codexHome.canonical_path})});}catch(error){return fail(error.message);}
          heldOwners.add(`${ownerFence.owner}:${ownerFence.generation}`);
        }
        if(result.action==='no-pending-handoff')return fail('headless-service-no-progress');
        continue;
      }
      const descriptor=nextAction(loop,{now:sampleNow(),unattended:true}); const action=descriptor.action;
      if(action.type==='await_human'||descriptor.gate?.allowed===false)return fail(action.reason || 'goal-host-gate-blocked');
      if(action.type==='close_workstream') {
        try {recordWorkstreamTerminal(root,runId,action.workstream_id,{status:'ready',proof:{},fence:ownerFence,now:sampleNow()});}
        catch(error){return fail(error.message);}
        continue;
      }
      if(action.type==='finish') {
        try {finishRun(root,runId,{status:'completed',reportRel:'final-report.md',fence:ownerFence,now:sampleNow()});continue;}
        catch(error){if(!String(error.message).toLowerCase().includes('report'))return fail(error.message);}
      }
      if(tokensUsed()>=tokenLimit)return fail('goal-host-token-limit');
      if(remaining()<=0)return fail('goal-host-deadline');
      if(action.type==='dispatch_checker') {
        try {
          assertIssuedGoalExecutionPlan(plan,loop);
          if(!thread)return fail('checker-owner-session-evidence-unavailable');
          const checkerSkill=resolveCheckerSkill({codexHome:ready.codexHome.canonical_path});
          if(goalPlanHash(checkerSkill)!==plan.doctrine_sha256)throw new Error('checker-identity-drift');
          const registered=dispatchReview(root,runId,{point:action.point,workstreamId:action.workstream_id,fence:ownerFence});
          const bound=fresh(root,runId).episodes.find(episode=>episode.id===registered.checkerEpisodeId);
          assertGoalReviewDescriptor(plan,registered,bound,action);
        }catch(error){return fail(error.message);}
        continue;
      }
      if(['dispatch_goal_checker','reconcile_goal_review'].includes(action.type)) {
        let result;
        const charge=issueCallCharge({root,runId,fence:ownerFence,kind:'goal-checker'});
        try {assertIssuedGoalExecutionPlan(plan,loop);result=await goalService({root,runId,expect:ownerFence,executable:ready.executable.canonical_path,
          codexHome:ready.codexHome.canonical_path,env,model:plan.goal_checker.model,effort:plan.goal_checker.effort,ownerThreads:[...ownerThreads],goalExecutionPlan:plan,
          timeoutMs:remaining(),runProcess:observedProcess('goal-checker',()=>{const review=fresh(root,runId).goal_reviews.find(r=>r.status==='pending');return {attempt_id:review?.execution.attempt_id??null};}),settleUsage:result=>settleCallCharge(charge,result),now:sampleNow()}); } catch(error){return fail(error.message);}
        if(!result?.ok)return fail(result?.reason==='GOAL_CHECKER_SETTLEMENT_FAILED'?'goal-review-running-unsettled':result?.reason || 'goal-checker-unavailable');continue;
      }
      if(turns>=maxTurns)return fail('owner-turn-limit');
      const progressKey=goalProgressKey(loop,action),progress=watchdog.before(progressKey);if(!progress.allowed)return fail(progressKey.startsWith('setup:')?'goal-host-no-progress':'goal-owner-no-progress');
      const activityBefore=boundArtifactActivity(root,loop);
      const packet=buildGoalOwnerPacket({loop,action,deepLoopRoot,profile,task,loadedPolicySha:loadedPolicies.get(thread),hostBudget:{remaining_tokens:Math.max(0,tokenLimit-tokensUsed()),remaining_time_ms:Math.max(0,remaining()),remaining_owner_turns:maxTurns-turns,remaining_call_time_ms:Math.max(1,Math.min(plan.limits.call_timeout_ms,remaining()))}});
      const prompt=packet.prompt+(progress.diagnostic?'\nDiagnostic allowance: the preceding owner calls produced no new kernel stage or completion evidence. Inspect the current action once, correct a concrete blocker if possible, otherwise pause with the precise missing input or recovery requirement. This is the last unproductive owner turn.':'');
      const entry=buildCodexGoalOwnerEntry({executable:ready.executable.canonical_path,projectRoot:root,prompt,
        model:loop.autonomy.session_model,effort:loop.autonomy.session_effort,providerThreadId:thread});
      Object.assign(entry,{env:buildMinimalCodexEnv({sourceEnv:env,codexHome:ready.codexHome.canonical_path,runId,projectRoot:root,...ownerFence}),
        cwd:root,usageOutputKind:'codex-jsonl',captureFinalMessage:true});
      const processProfile={model:loop.autonomy.session_model,effort:loop.autonomy.session_effort,
        executable:ready.executable.canonical_path,isolation:profile,argv_sha256:digest(JSON.stringify(entry.argv)),prompt_sha256:digest(prompt)};
      let binding,result,accounting;
      try {
        const ownerKey=`${ownerFence.owner}:${ownerFence.generation}`;
        if(!heldOwners.has(ownerKey)){
          const marker=markerPath(root,runId,ownerFence);mkdirSync(dirname(marker),{recursive:true,mode:0o700});
          writeFileSync(marker,JSON.stringify({version:1,run_id:runId,...ownerFence,profile:processProfile}),{flag:'wx',mode:0o600});
          heldOwners.add(ownerKey);
        }
        binding=issueGoalOwnerTurn(root,runId,{fence:ownerFence,profile:processProfile,threadId:thread});
        const available=remaining();if(available<=0)return fail('goal-host-deadline');
        result=callBudget.run(entry,{timeoutMs:available,processGroup:'required',captureRawJsonl:true});turns++;
        if(measured(result)&&UUID.test(result.providerThreadId || '')) {
          const receipt=bindGoalOwnerResult(binding,{profile:processProfile,threadId:result.providerThreadId,
            processId:result.process_group.group_id,outputSha256:digest(result.finalMessage || ''),usage:result.usage,
            terminationConfirmed:true,exitCode:result.ok?0:1});
          accounting=settleGoalOwnerCost(root,runId,{receipt,fence:{...ownerFence,intent:'accounting'}});
        }
      } catch(error){emit({kind:'owner',entry,result,accounting,binding_context:{attempt_id:action.attempt_id??null,episode_id:action.episode_id??null,target_maker:action.episode_id??null}});return fail(`goal-owner-accounting:${error.message}`);}
      emit({kind:'owner',entry,result,accounting,binding_context:{attempt_id:action.attempt_id??null,episode_id:action.episode_id??null,target_maker:action.episode_id??null}});
      if(!result?.ok||!measured(result)||!accounting?.ok)return fail(result?.reason || 'goal-owner-evidence-unavailable');
      if(!UUID.test(result.providerThreadId || '')||(thread!==null&&thread!==result.providerThreadId))return fail('goal-owner-thread-mismatch');
      thread=result.providerThreadId;ownerThreads.add(thread);loadedPolicies.set(thread,packet.policySha);
      const afterOwner=fresh(root,runId);watchdog.after(afterOwner,{key:progressKey,activityChanged:changedBoundArtifact(activityBefore,boundArtifactActivity(root,afterOwner))});
      controlSignature=null;controlRepeats=0;
    }
  });
    if(hostResult?.ok===false&&!hostResult.recovery)return {...hostResult,recovery:readGoalRecovery(root,runId,hostResult.reason)};
    return hostResult;
  }catch(error){
    const reason=String(error.message||error);
    try{const loop=fresh(root,runId);if(loop.status==='running')pauseRun(root,runId,{reason,expect:expected,now:sampleNow()});}catch{}
    return {ok:false,reason,invocations,budget:callBudget.summary(),recovery:readGoalRecovery(root,runId,reason)};
  }finally {expireGoalPlanController(controller);}
}

export function checkGoalRun({root,runId,callTimeoutMs=120000,noProgressTurns=3,profile='current',timeoutMs,maxTurns,tokenLimit,env=process.env,resolveCheckerSkill=resolveTrustedCheckerSkill,revalidateExecutable=revalidateTrustedRuntimeExecutable}={}){
 try {
  const captured=captureVerifiedRunSnapshot(root,runId);if(captured?.ok===false)return captured;
  const loop=(captured.snapshot??captured).data;
  if(!['current','minimal'].includes(profile)||[timeoutMs,maxTurns,tokenLimit].some(v=>v!==undefined&&(!Number.isSafeInteger(v)||v<1)))return {ok:false,reason:'goal-host-options-invalid',model_availability:'unprobed'};
  if(profile==='minimal'&&loop.orchestration?.boundary_mode!=='continue')return {ok:false,reason:'minimal-profile-requires-continue-boundary',model_availability:'unprobed'};
  const compiled=compileGoalExecutionPlan({loop,options:{callTimeoutMs,noProgressTurns}});if(!compiled.ok)return compiled;
  const executable=revalidateExecutable(loop.autonomy.runtime_executable_approval);
  const home=resolveAuthenticatedCodexHome({env,platform:executable.platform});
  const doctrine=resolveCheckerSkill({codexHome:home.canonical_path});
  return {ok:true,plan:{...compiled.plan,doctrine_sha256:goalPlanHash(doctrine)},model_availability:'unprobed',executable_approval_present:true,recovery:goalRecoveryDiagnostic(loop,'static-check-only')};
 }catch(error){return {ok:false,reason:error.message,model_availability:'unprobed'};}
}

function readGoalRecovery(root,runId,reason,options={}) {
 try {const captured=captureVerifiedRunSnapshot(root,runId);if(!captured.ok)throw new Error(captured.reason??'verified-state-unavailable');
  return goalRecoveryDiagnostic(captured.snapshot.data,reason,{...options,events:captured.snapshot.logLines});
 }catch{return {action:'human-required',allowed_next_action:'human-required',reason,run_id:runId,evidence:'unavailable',automatic_reattach:false};}
}
