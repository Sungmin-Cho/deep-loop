import { randomUUID } from 'node:crypto';
import { recordCost, isMeasuredOneTurnUsage } from './budget.mjs';
const charges=new WeakMap();
export function issueCallCharge({root,runId,fence,kind}={}){
 if(!['owner-probe','checker-probe','goal-checker'].includes(kind)||!fence?.owner||!Number.isSafeInteger(fence.generation))throw new Error('GOAL_CHARGE_INPUT_INVALID');
 const c=Object.freeze({invocation_id:randomUUID()});charges.set(c,{root,runId,fence:{owner:fence.owner,generation:fence.generation,intent:'accounting'},kind,state:'issued',result:null});return c;
}
export function settleCallCharge(charge,result,{record=recordCost}={}){
 const c=charges.get(charge);if(!c)throw new Error('GOAL_CHARGE_NOT_ISSUED');
 if(c.state==='settled'){if(c.result!==result)throw new Error('GOAL_CHARGE_RESULT_MISMATCH');return {ok:true,duplicate:true,invocation_id:charge.invocation_id};}
 if(c.state!=='issued')throw new Error('GOAL_CHARGE_UNKNOWN');
 c.result=result;c.state='settling';
 try{
  if(!isMeasuredOneTurnUsage(result?.usage)||result?.termination?.confirmed!==true||result?.process_group?.quiescence_confirmed!==true)throw new Error('GOAL_CHARGE_EVIDENCE_UNAVAILABLE');
  record(c.root,c.runId,{turns:result.usage.num_turns,tokens:result.usage.tokens,fence:c.fence});c.state='settled';
  return {ok:true,duplicate:false,invocation_id:charge.invocation_id};
 }catch(error){c.state='unknown';throw error;}
}
