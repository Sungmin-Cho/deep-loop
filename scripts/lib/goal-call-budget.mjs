import { isMeasuredOneTurnUsage } from './budget.mjs';

// The tag originates in the trusted entry builder. A label or missing parser
// never turns a Codex exec into a free local-control operation.
export function classifyGoalCall(entry){
 if(entry?.dispatch_kind==='codex-model-call-v1'&&entry.argv?.[0]==='exec'&&entry.argv.includes('--json')&&entry.usageOutputKind==='codex-jsonl')return 'model-call';
 if(entry?.dispatch_kind==='local-control-v1'&&entry.argv?.length===1&&entry.argv[0]==='--version')return 'local-control';
 throw new Error('goal-call-entry-invalid');
}
export function createGoalCallBudget({readLoop,tokenLimit,remaining,callTimeoutMs,now=Date.now,runProcess,validateEntry=()=>{}}={}){
 let tokens=0,unavailable=false;const observations=new WeakMap();
 const summary=()=>({tokens,token_limit:tokenLimit,token_overshoot:Math.max(0,tokens-tokenLimit),usage_complete:!unavailable,token_limit_kind:'measured-next-call-admission'});
 return {summary,observation:result=>observations.get(result)??null,run(entry,options={}){
  const invocation_class=classifyGoalCall(entry);
  validateEntry(entry);
  if(unavailable)throw new Error('goal-call-usage-unavailable');
  const loop=readLoop(),budget=loop.budget;
  if(budget.tokens_spent>=budget.tokens_total||budget.spent>=budget.total)throw new Error('goal-host-budget');
  if(tokens>=tokenLimit)throw new Error('goal-host-token-limit');
  const runRemaining=Date.parse(loop.created_at)+budget.max_wallclock_sec*1000-new Date(now()).getTime();
  const timeoutMs=Math.min(options.timeoutMs??callTimeoutMs,callTimeoutMs,remaining(),runRemaining);
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('goal-host-deadline');
  const result=runProcess(entry,{...options,timeoutMs,processGroup:'required',captureRawJsonl:true});
  const started=Number.isInteger(result?.process_group?.group_id)||Number.isInteger(result?.pid);
  const spawn_state=started?'started':'unknown';
  if(invocation_class==='model-call'&&spawn_state!=='not-started'){
   if(isMeasuredOneTurnUsage(result?.usage)){tokens+=result.usage.tokens;if(!Number.isSafeInteger(tokens))unavailable=true;}
   else unavailable=true;
  }
  if(result&&typeof result==='object')observations.set(result,{invocation_class,spawn_state,effective_timeout_ms:timeoutMs});
  return result;
 }};
}
