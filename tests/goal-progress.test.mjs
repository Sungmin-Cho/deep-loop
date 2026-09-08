import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoalProgressWatchdog, goalRecoveryDiagnostic } from '../scripts/lib/goal-progress.mjs';
const loop=()=>({episodes:[],workstreams:[],goal:{requirements:[]}});
test('bookkeeping churn does not reset bounded diagnostic allowance',()=>{
 const w=createGoalProgressWatchdog({noProgressTurns:3});
 for(let n=0;n<3;n++) {assert.equal(w.before().allowed,true);w.after({...loop(),episodes:[{id:`new${n}`,role:'maker',status:'pending'}]});}
 assert.equal(w.before().diagnostic,true);w.after(loop());assert.equal(w.before().allowed,false);
});
test('bound activity earns only one two-turn extension and proof earns new interval',()=>{
 const w=createGoalProgressWatchdog({noProgressTurns:3});
 for(let n=0;n<5;n++){assert.equal(w.before().allowed,true);w.after(loop(),{activityChanged:true});}
 assert.equal(w.before().diagnostic,true);w.after(loop(),{activityChanged:true});assert.equal(w.before().allowed,false);
 w.after({...loop(),episodes:[{id:'a',role:'maker',status:'done'}]});assert.equal(w.before().allowed,true);
});
test('recovery reports unknown execution as human-required without adopting a handle',()=>{
 const d=goalRecoveryDiagnostic({episodes:[{id:'a',execution:{phase:'running',handle:'remote:1'}}]},'lost-owner');
 assert.equal(d.action,'human-required');assert.equal(d.unresolved_attempts[0].handle,'remote:1');assert.equal(d.automatic_reattach,false);
});
test('separate setup keys retain their own allowance across round trips',()=>{
 const w=createGoalProgressWatchdog({limits:{no_progress_turns:2,setup_turns:3,activity_extension_turns:2}});
 for(let n=0;n<3;n++){w.after(loop(),{key:'setup:a'});w.after(loop(),{key:'setup:b'});}
 assert.equal(w.before('setup:a').diagnostic,true);assert.equal(w.before('setup:b').diagnostic,true);assert.equal(w.before('setup:c').unproductive_turns,0);
 w.after(loop(),{key:'setup:a'});assert.equal(w.before('setup:a').allowed,false);assert.equal(w.before('setup:b').allowed,true);
});
test('goal-review recovery carries exact execution attempt and verified anchor presence',()=>{
 const r=goalRecoveryDiagnostic({run_id:'R',session_chain:{lease:{owner_run_id:'O',generation:2}},goal_reviews:[{id:'g',execution:{phase:'running',attempt_id:'a',handle:'h'}}]},'goal-review-running-unsettled',{events:[{type:'cost'}],remainingOwnerTurns:4});
 assert.equal(r.unresolved_attempts[0].attempt_id,'a');assert.equal(r.unresolved_attempts[0].handle,'h');assert.equal(r.unresolved_attempts[0].termination,'unknown');assert.equal(r.allowed_next_action,'reconcile-exact-attempt');assert.equal(r.anchored_cost_present,true);assert.equal(r.anchored_finish_present,false);assert.equal(r.generation,2);
});
