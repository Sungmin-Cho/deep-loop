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

export function buildGoalOwnerPrompt({loop,action,deepLoopRoot=ROOT,profile='current',task=null,hostBudget=null}) {
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
  return [`Official ${profile} host-owner policy from ${policySource}; SHA256 ${digest(policy)}.`,policy,
    `Host context snapshot (context, not mutation authority): ${JSON.stringify(frame)}`,
    task ? `Task context: ${task}` : '',
    'Use the supplied facts and action. Do not rediscover unchanged fields or load legacy/entry workflows. Refresh after the action boundary or stale/fence evidence.',
    'Complete one bounded logical action or current maker stage; batch predictable typed CLI steps in one tool call with actual-result bindings, then yield. Do not start a second maker or retry round.',
    'For dispatch_checker, dispatch the configured independent checker and yield; never claim or execute it as the owner. Yield for whole-goal review. At finish populate the supplied M3 report template with the factual report, write it to report_path, then yield before finish.',
    'External push, PR, merge, publish, network and delete actions are outside this isolated execution scope. Report genuinely missing authority or requirements without inventing them.',
  ].filter(Boolean).join('\n');
}

// Establish the ordinary executable/isolation contract, then measure an actual
// persistent two-turn read-only nonce exchange. No --last or candidate session ID
// participates in this binding. All probe invocations are included in accounting.
export function preflightGoalOwner({root,runId,loop,expect,env,deepLoopRoot,timeoutMs,runProcess=runStreamingProcessSync,onInvocation=()=>{},wallNow=Date.now}) {
  const executable=revalidateTrustedRuntimeExecutable(loop.autonomy.runtime_executable_approval);
  const codexHome=resolveAuthenticatedCodexHome({env,platform:executable.platform});
  resolveTrustedCheckerSkill({codexHome:codexHome.canonical_path});
  const probeDeadline=wallNow()+timeoutMs;
  const runProbe=(entry,options)=>{const available=probeDeadline-wallNow();if(available<=0)return {ok:false,reason:'goal-host-deadline'};const result=runProcess(entry,{...options,timeoutMs:Math.min(options.timeoutMs,available),processGroup:'required',captureRawJsonl:true});onInvocation({kind:'runtime-preflight',entry,result});return result;};
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
    const result=runProcess(entry,{timeoutMs:available,processGroup:'required',captureRawJsonl:true});
    probes.push(result);onInvocation({kind:'owner-preflight',entry,result});
    if(isMeasuredOneTurnUsage(result?.usage)) recordCost(root,runId,{turns:result.usage.num_turns,tokens:result.usage.tokens,fence:{...expect,intent:'accounting'}});
    if(!result?.ok || !measured(result) || !UUID.test(result.providerThreadId || '')
      || (thread!==null && thread!==result.providerThreadId)) return {ok:false,reason:'owner-continuity-unavailable',probes};
    thread=result.providerThreadId;
    if(i===1 && (existsSync(deniedPath) || result.finalMessage?.toString().trim()!==nonce)) return {ok:false,reason:'owner-continuity-mismatch',probes};
  }
  return {ok:true,executable,codexHome,probes,measured_usage:proof.measured_usage};
}

export async function driveGoalRun({root,runId,expect=null,timeoutMs,maxTurns,tokenLimit,
  env=process.env,deepLoopRoot=ROOT,profile='current',task=null,now=Date.now,runProcess=runStreamingProcessSync,
  preflight=preflightGoalOwner,goalService=drivePendingGoalReview,onInvocation=()=>{},wallNow=Date.now,...serviceOptions}={}) {
  const invocations=[]; const started=wallNow();
  const sampleNow=typeof now==='function'?now:()=>now;
  const initial=fresh(root,runId); const expected=expect || fenceOf(initial);
  timeoutMs ??= Math.max(1,initial.budget.max_wallclock_sec * 1000 - (new Date(sampleNow()).getTime()-Date.parse(initial.created_at)));
  maxTurns ??= Math.max(1,initial.budget.total-initial.budget.spent);
  tokenLimit ??= Math.max(1,initial.budget.tokens_total-initial.budget.tokens_spent);
  if(!['current','minimal'].includes(profile)||!Number.isSafeInteger(maxTurns)||maxTurns<1||!Number.isSafeInteger(timeoutMs)||timeoutMs<1
    ||!Number.isSafeInteger(tokenLimit)||tokenLimit<1) return {ok:false,reason:'goal-host-options-invalid',invocations};
  if(!isGoalDriven(initial)||!runtimeCapability(sessionRuntime(initial),'persistent_goal_owner')) return {ok:false,reason:'goal-owner-runtime-unavailable',invocations};
  if(!initial.autonomy.session_model||!initial.autonomy.session_effort)return {ok:false,reason:'goal-owner-profile-required',invocations};
  if(profile === 'minimal' && initial.orchestration.boundary_mode !== 'continue')return {ok:false,reason:'minimal-profile-requires-continue-boundary',invocations};
  if(!leaseCheck(initial,{...expected,intent:'lease'}).ok) return {ok:false,reason:'goal-owner-fenced',invocations};
  let evidenceFailure=null;
  const emit=event=>{invocations.push(event);try {onInvocation(event);} catch(error){evidenceFailure=String(error.message || error);}};
  const observedProcess=kind=>(entry,options)=>{const available=remaining();if(available<=0)return {ok:false,reason:'goal-host-deadline'};const result=runProcess(entry,{...options,timeoutMs:Math.min(options.timeoutMs,available),processGroup:'required',captureRawJsonl:true});emit({kind,entry,result});return result;};
  const remaining=()=>timeoutMs-(wallNow()-started);
  const tokensUsed=()=>invocations.reduce((n,x)=>n+(x.result?.usage?.tokens || 0),0);
  return withHeadlessHostService({root,runId,timeoutMs,...serviceOptions},async service=>{
    let thread=null,ownerFence=expected,turns=0; const heldOwners=new Set();
    const fail=reason=>{
      try {const loop=fresh(root,runId);if(loop.status==='running')pauseRun(root,runId,{reason,expect:ownerFence,now:sampleNow()});} catch { /* preserve newer fence/terminal authority */ }
      return {ok:false,reason,invocations,providerThreadId:thread};
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
    try {ready=preflight({root,runId,loop:initial,expect:ownerFence,env,deepLoopRoot,timeoutMs:remaining(),runProcess,onInvocation:emit,wallNow});}
    catch(error){return fail(`goal-owner-preflight:${error.message}`);}
    if(!ready?.ok)return fail(ready?.reason || 'goal-owner-preflight-unavailable');
    if(evidenceFailure)return fail(`goal-evidence-write-failed:${evidenceFailure}`);
    for(;;) {
      if(evidenceFailure)return fail(`goal-evidence-write-failed:${evidenceFailure}`);
      let loop=fresh(root,runId);
      if(['completed','stopped'].includes(loop.status))return {ok:loop.status==='completed',status:loop.status,invocations,providerThreadId:thread};
      if(loop.status==='paused')return {ok:false,status:'paused',reason:loop.pause_reason || 'run-paused',invocations,providerThreadId:thread};
      if(wallNow()-started>=timeoutMs)return fail('goal-host-deadline');
      if(tokensUsed()>tokenLimit)return fail('goal-host-token-limit');
      const emittedHandoff=loop.session_chain.lease.handoff_phase==='emitted';
      if(!leaseCheck(loop,{...ownerFence,intent:emittedHandoff?'lease':'business'}).ok)return fail('goal-owner-fenced');
      const pendingChecker=loop.episodes.some(x=>x.role==='checker'&&['pending','in_progress'].includes(x.status));
      if(pendingChecker||emittedHandoff) {
        if(tokensUsed()>=tokenLimit)return fail('goal-host-token-limit');
        if(remaining()<=0)return fail('goal-host-deadline');
        const result=service({expect:ownerFence,env,deepLoopRoot,timeoutMs:remaining(),clock:sampleNow,
          preflightFn:options=>ensureCodexPreflight({...options,runSync:observedProcess('runtime-preflight')}),
          checkerRunFn:options=>runIndependentCodexChecker({...options,runProcess:observedProcess('checker')}),
          spawnFn:(entry,options)=>headlessSpawn(entry,{...options,runSync:observedProcess('handoff')})});
        if(!result?.ok)return fail(result?.reason || result?.action || 'headless-service-unavailable');
        const after=fresh(root,runId),nextFence=fenceOf(after);
        if(nextFence.owner!==ownerFence.owner||nextFence.generation!==ownerFence.generation) {
          if(!UUID.test(result.providerThreadId || ''))return fail('handoff-provider-binding-unavailable');
          ownerFence=nextFence;thread=result.providerThreadId;heldOwners.add(`${ownerFence.owner}:${ownerFence.generation}`);
        }
        if(result.action==='no-pending-handoff')return fail('headless-service-no-progress');
        continue;
      }
      const descriptor=nextAction(loop,{now:sampleNow(),unattended:true}); const action=descriptor.action;
      if(action.type==='await_human'||descriptor.gate?.allowed===false)return fail(action.reason || 'goal-host-gate-blocked');
      if(action.type==='close_workstream') {
        recordWorkstreamTerminal(root,runId,action.workstream_id,{status:'ready',proof:{},fence:ownerFence,now:sampleNow()});continue;
      }
      if(action.type==='finish') {
        try {finishRun(root,runId,{status:'completed',reportRel:'final-report.md',fence:ownerFence,now:sampleNow()});continue;}
        catch(error){if(!String(error.message).toLowerCase().includes('report'))return fail(error.message);}
      }
      if(tokensUsed()>=tokenLimit)return fail('goal-host-token-limit');
      if(remaining()<=0)return fail('goal-host-deadline');
      if(['dispatch_goal_checker','reconcile_goal_review'].includes(action.type)) {
        const result=await goalService({root,runId,expect:ownerFence,executable:ready.executable.canonical_path,
          codexHome:ready.codexHome.canonical_path,env,model:loop.autonomy.session_model,effort:loop.autonomy.session_effort,
          timeoutMs:remaining(),runProcess:observedProcess('goal-checker'),settleUsage:result=>{ recordCost(root,runId,{turns:result.usage.num_turns,tokens:result.usage.tokens,fence:{...ownerFence,intent:'accounting'}}); return {ok:true}; },now:sampleNow()});
        if(!result?.ok)return fail(result?.reason || 'goal-checker-unavailable');continue;
      }
      if(turns>=maxTurns)return fail('owner-turn-limit');
      const prompt=buildGoalOwnerPrompt({loop,action,deepLoopRoot,profile,task,hostBudget:{remaining_tokens:Math.max(0,tokenLimit-tokensUsed()),remaining_time_ms:Math.max(0,remaining()),remaining_owner_turns:maxTurns-turns}});
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
        result=runProcess(entry,{timeoutMs:available,processGroup:'required',captureRawJsonl:true});turns++;
        if(measured(result)&&UUID.test(result.providerThreadId || '')) {
          const receipt=bindGoalOwnerResult(binding,{profile:processProfile,threadId:result.providerThreadId,
            processId:result.process_group.group_id,outputSha256:digest(result.finalMessage || ''),usage:result.usage,
            terminationConfirmed:true,exitCode:result.ok?0:1});
          accounting=settleGoalOwnerCost(root,runId,{receipt,fence:{...ownerFence,intent:'accounting'}});
        }
      } catch(error){emit({kind:'owner',entry,result,accounting});return fail(`goal-owner-accounting:${error.message}`);}
      emit({kind:'owner',entry,result,accounting});
      if(!result?.ok||!measured(result)||!accounting?.ok)return fail(result?.reason || 'goal-owner-evidence-unavailable');
      if(!UUID.test(result.providerThreadId || '')||(thread!==null&&thread!==result.providerThreadId))return fail('goal-owner-thread-mismatch');
      thread=result.providerThreadId;
    }
  });
}
