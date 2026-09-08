// Diagnostic evidence never authorizes process adoption or a kernel mutation.
export function goalRecoveryDiagnostic(loop,reason,{events=null,remainingOwnerTurns=null}={}) {
 const unresolved_attempts=[];
 const add=(subject,identity)=>{
  const execution=subject.execution;if(!execution||!['running','prepared','blocked'].includes(execution.phase))return;
  unresolved_attempts.push({...identity,attempt_id:execution.attempt_id??subject.attempt_id??null,handle:execution.handle??null,phase:execution.phase,
   termination:['succeeded','failed','absent'].includes(execution.observation?.state)?'observed-quiescent':'unknown'});
 };
 for(const e of loop.episodes??[])add(e,{episode_id:e.id});
 for(const r of loop.goal_reviews??[])add(r,{goal_review_id:r.id});
 const allowed_next_action=['goal-review-running-unsettled','settlement-unknown'].includes(reason)?'human-required':unresolved_attempts.length?'reconcile-exact-attempt':reason==='already-driving'?'inspect-existing-owner':'human-required';
 return {action:'human-required',allowed_next_action,reason,run_id:loop.run_id??null,owner:loop.session_chain?.lease?.owner_run_id??null,generation:loop.session_chain?.lease?.generation??null,
  automatic_reattach:false,remaining_owner_turns:remainingOwnerTurns,unresolved_attempts,
  anchored_cost_present:events===null?null:events.some(e=>e.type==='cost'),anchored_finish_present:events===null?null:events.some(e=>e.type==='finish'),
  evidence:events===null?'state-only':'verified-state-and-log',next_step:'Inspect the verified status and reconcile only the exact listed attempt through the fenced kernel. Serialized provider bindings are not resume authority.'};
}
