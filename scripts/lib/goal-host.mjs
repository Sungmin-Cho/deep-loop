import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureReconciledRunSnapshot, pauseRun, runDir } from './state.mjs';
import { isGoalDriven } from './goal-contract.mjs';
import { sessionRuntime, runtimeCapability } from './runtime.mjs';
import { readLines } from './integrity.mjs';
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const fresh = (root, runId) => captureReconciledRunSnapshot(root, runId).data;
const markerPath = (root,runId,fence) => join(runDir(root,runId),'owner-process-intents',`${fence.owner}-${fence.generation}.json`);
const fenceOf = loop => ({owner:loop.session_chain.lease.owner_run_id,generation:loop.session_chain.lease.generation});
const measured = result => result?.termination?.confirmed === true
  && result?.process_group?.quiescence_confirmed === true && isMeasuredOneTurnUsage(result.usage);

export function buildGoalOwnerPrompt({loop, action, deepLoopRoot=ROOT, profile='current', task=null}) {
  if (!['current','minimal'].includes(profile)) throw new Error('GOAL_OWNER_PROFILE_INVALID');
  const guidance = profile === 'current'
    ? `Read and follow ${join(deepLoopRoot,'skills/deep-loop-continue/SKILL.md')} and its goal-execution.md reference. These are the pinned shipped execution guidance.`
    : 'Goal owner minimal policy v1: use next-action to see remaining work; exercise your judgment to fulfill the exact goal. All loop-state changes use the kernel CLI. Keep actual artifacts and independent review proof. Continue until the real goal is satisfied.';
  return [guidance, `Kernel executable: ${process.execPath} ${join(deepLoopRoot,'scripts/deep-loop.mjs')}`,
    `Run identity: ${JSON.stringify({root:loop.project.root,run_id:loop.run_id,...fenceOf(loop)})}`,
    `Goal: ${loop.goal}`, `Goal contract: ${JSON.stringify(loop.goal_contract)}`, task ? `Task context: ${task}` : '',
    `Current action: ${JSON.stringify(action)}`,
    'You are the persistent owner. Perform useful maker/control work in this conversation, using your own judgment about implementation. Do not fabricate reviewer results or human acknowledgements.',
    'At dispatch_checker: create the pending checker with review dispatch (the configured deep-review-loop), then yield to the host. Do not claim or run the independent checker yourself.',
    'At dispatch_goal_checker or reconcile_goal_review: yield to the host for independent goal assessment.',
    'At finish: write the real final-report.md under this run directory, then yield before invoking finish; the host settles usage and performs proof-gated completion.',
    'At handoff: use the exact canonical handoff guidance to emit the boundary, then yield; do not spawn a successor yourself.',
    'External push, PR, merge, publish, network and delete actions are outside this isolated execution scope. A genuine ambiguity should be explained without inventing requirements.',
    'Finish this owner turn only after useful progress or reaching a host-service boundary. The host resumes this exact conversation after service.',
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
      const prompt=buildGoalOwnerPrompt({loop,action,deepLoopRoot,profile,task});
      const entry=buildCodexGoalOwnerEntry({executable:ready.executable.canonical_path,projectRoot:root,prompt,
        model:loop.autonomy.session_model,effort:loop.autonomy.session_effort,providerThreadId:thread});
      Object.assign(entry,{env:buildMinimalCodexEnv({sourceEnv:env,codexHome:ready.codexHome.canonical_path,runId,projectRoot:root,...ownerFence}),
        cwd:root,usageOutputKind:'codex-jsonl',captureFinalMessage:true});
      const processProfile={model:loop.autonomy.session_model,effort:loop.autonomy.session_effort,
        executable:ready.executable.canonical_path,isolation:profile,argv_sha256:digest(JSON.stringify(entry.argv))};
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
