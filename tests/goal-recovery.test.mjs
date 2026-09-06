import { projectRootDigest as createRootDigest } from '../scripts/lib/project-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeGoalFixture } from './helpers/goal-fixture.mjs';
import { goalOk } from './helpers/reviewed-goal.mjs';
import { scopeToken, ownerSession } from '../scripts/lib/session-scope.mjs';
import { __testRestoreCompactCheckpoint } from '../scripts/lib/checkpoint.mjs';
const CLI = fileURLToPath(new URL('../scripts/deep-loop.mjs', import.meta.url));
function fixture(t, options = {}) {
  const f = makeGoalFixture({ now: new Date().toISOString(), ...options }); t.after(f.cleanup);
  const a = f.workstream('a'), b = f.workstream('b');
  goalOk(f.select(a.id, scopeToken(f.state())));
  const id = goalOk(f.cli(['episode','new','--plugin','standalone','--role','maker','--kind','implementation','--point','implementation','--workstream',a.id])).id;
  goalOk(f.cli(['execution','prepare','--episode',id,'--mode','inline','--stage','primary','--task','Implement A']));
  goalOk(f.cli(['episode','record','--id',id,'--status','blocked']));
  return { ...f,a,b,id };
}
function emit(f) { return goalOk(f.cli(['checkpoint','emit','--runtime','claude'])); }
function restore(f, checkpoint, manual = true) {
  return f.cli(['checkpoint','restore','--checkpoint',checkpoint,'--runtime','claude','--json','--admission', manual ? 'human-attested':'postcompact-observation','--source', manual ? 'direct-human-skill':'sessionstart', ...(manual ? ['--confirm-manual-compact']:[])]);
}
function observe(f, checkpoint) {
  return f.cli(['checkpoint','observe','--checkpoint',checkpoint,'--runtime','claude','--json','--trigger','manual','--trusted-postcompact-stdin'], { input: JSON.stringify({ hook_event_name:'PostCompact',cwd:f.root,trigger:'manual' }) });
}
for (const phase of ['prepared','observed','restored-human','restored-observation']) test(`v0.5 ${phase} compact authority cannot survive A -> B -> A`, t => {
  const f = fixture(t), checkpoint = emit(f).checkpoint_rel;
  const bytes = readFileSync(join(f.root,'.deep-loop','runs',f.runId,checkpoint));
  assert.equal(JSON.parse(bytes).payload.context.scope_epoch,1);
  if (phase.includes('observ')) goalOk(observe(f,checkpoint));
  if (phase.startsWith('restored')) goalOk(restore(f,checkpoint,phase === 'restored-human'));
  goalOk(f.select(f.b.id,scopeToken(f.state()))); goalOk(f.select(f.a.id,scopeToken(f.state())));
  assert.equal(ownerSession(f.state()).compact_cursor,undefined);
  const failed = restore(f,checkpoint,phase !== 'restored-observation'); assert.equal(failed.exit,1); assert.match(failed.stderr,/CHECKPOINT_SCOPE_EPOCH_MISMATCH/);
  assert.equal(observe(f,checkpoint).exit,1);
  assert.deepEqual(readFileSync(join(f.root,'.deep-loop','runs',f.runId,checkpoint)),bytes);
  const fresh = emit(f).checkpoint_rel; assert.notEqual(fresh,checkpoint); goalOk(observe(f,fresh)); goalOk(restore(f,fresh,false));
});
test('retained restore transaction requires canonical replay before selection; old intent capsule loses authority afterwards', t => {
  const f = fixture(t), checkpoint = emit(f).checkpoint_rel;
  assert.throws(() => __testRestoreCompactCheckpoint(f.root,f.runId,{ checkpointRel:checkpoint, fence:f.fence, runtime:'claude', admission:'human-attested',source:'direct-human-skill',confirmManualCompact:true,env:{},faultAt:'restore:intent-written' }),/TEST_FAULT/);
  const blocked = f.select(f.b.id,scopeToken(f.state())); assert.equal(blocked.exit,1); assert.match(blocked.stderr,/COMPACT_RESTORE_INTENT_PENDING/); assert.match(blocked.stderr,/checkpoint restore/);
  goalOk(restore(f,checkpoint)); goalOk(f.select(f.b.id,scopeToken(f.state()))); goalOk(f.select(f.a.id,scopeToken(f.state())));
  assert.match(restore(f,checkpoint).stderr,/CHECKPOINT_SCOPE_EPOCH_MISMATCH/);
});
test('affinity recovery and actual fresh-owner acquisition preserve parked history and reset turn baseline', t => {
  const f = fixture(t); goalOk(f.select(f.b.id,scopeToken(f.state())));
  const before = ownerSession(f.state()); assert.ok(before.scope_turn_baseline > 0);
  goalOk(f.cli(['pause','--reason','host-session-lost']));
  const recovered = goalOk(f.cli(['recover','--supersede-affinity','--reason','lost host','--confirm']));
  let state = f.state(), child = state.session_chain.sessions.find(s => s.run_id === recovered.child_run_id);
  assert.deepEqual(child.scope_history,before.scope_history); assert.equal(child.scope_epoch,before.scope_epoch); assert.equal(child.scope_turn_baseline,0);
  const acquired = f.cli(['recovery','acquire','--capsule',child.recovery_rel,'--runtime','claude'], { fence:{ owner:child.run_id,generation:state.session_chain.lease.generation } }); goalOk(acquired);
  state=f.state(); assert.equal(state.session_chain.lease.owner_run_id,child.run_id);
  goalOk(f.cli(['workstream','select','--id',f.a.id,'--expected-scope',scopeToken(state),'--reason','resume parked work'],{fence:{owner:child.run_id,generation:state.session_chain.lease.generation}}));
  assert.equal(f.state().current_episode,f.id);
});
function rawCli(args, cwd) {
  const r=spawnSync(process.execPath,[CLI,...args],{cwd,encoding:'utf8',timeout:120000});
  let json=null; try { json=JSON.parse(r.stdout); } catch {}
  return {exit:r.status,stderr:r.error ? `${r.stderr || ''}\n${r.error.code}: ${r.error.message}` : r.stderr,stdout:r.stdout,json};
}
test('relocated root recovery capsule and acquired owner carry parked history and epoch', t => {
  const f=fixture(t); goalOk(f.select(f.b.id,scopeToken(f.state())));
  const original=f.state(), before=ownerSession(original), relocated=`${f.root}-moved`;
  renameSync(f.root,relocated); t.after(()=>rmSync(relocated,{recursive:true,force:true}));
  const runArgs=['--candidate-project-root',relocated,'--run-id',f.runId];
  const recovered=goalOk(rawCli(['root','recover',...runArgs,'--owner',f.runId,'--generation','1','--actor','human','--confirm','--expected-stored-root-digest',
    createRootDigest(original.project.root), '--expected-binding-generation','1'],relocated));
  let state=goalOk(rawCli(['state','get','--project-root',relocated,'--run-id',f.runId],relocated));
  const child=state.session_chain.sessions.find(s=>s.run_id===recovered.replacement_session_id);
  assert.deepEqual(child.scope_history,before.scope_history); assert.equal(child.scope_epoch,before.scope_epoch); assert.equal(child.scope_turn_baseline,0);
  const capsule=JSON.parse(readFileSync(join(relocated,'.deep-loop','runs',f.runId,child.recovery_rel)));
  assert.deepEqual(capsule.scope_history,before.scope_history);
  goalOk(rawCli(['root','recovery','acquire',...runArgs,'--owner',child.run_id,'--generation',String(state.session_chain.lease.generation),'--runtime','claude','--capsule',child.recovery_rel,'--binding-generation',String(state.project.binding_generation)],relocated));
  state=goalOk(rawCli(['state','get','--project-root',relocated,'--run-id',f.runId],relocated));
  assert.equal(state.session_chain.lease.owner_run_id,child.run_id);
  goalOk(rawCli(['workstream','select','--id',f.a.id,'--expected-scope',scopeToken(state),'--reason','resume parked source','--owner',child.run_id,'--generation',String(state.session_chain.lease.generation),'--project-root',relocated,'--run-id',f.runId],relocated));
});
test('handoff publishes only current closed boundary and acquired child carries parked history', t => {
  const f=fixture(t,{boundaryMode:'handoff'}); goalOk(f.select(f.b.id,scopeToken(f.state())));
  goalOk(f.cli(['workstream','terminal','--id',f.b.id,'--status','abandoned','--confirm','--proof',JSON.stringify({reason:'Unneeded prerequisite'})]));
  const before=ownerSession(f.state());
  const boundary=`${before.scope.terminal_event.seq}:${before.scope.terminal_event.checksum}`;
  assert.match(f.select(f.a.id,scopeToken(f.state())).stderr,/SCOPE_HANDOFF_REQUIRED/);
  const emitted=goalOk(f.cli(['handoff','emit','--reason','workstream-terminal','--boundary-event',boundary]));
  let state=f.state(), child=state.session_chain.sessions.find(s=>s.run_id===emitted.childRunId);
  assert.deepEqual(child.scope_history,before.scope_history); assert.equal(child.scope_epoch,before.scope_epoch); assert.equal(child.scope_turn_baseline,0);
  assert.equal(child.scope.workstream_id,null);
  goalOk(f.cli(['lease','acquire','--runtime','claude'],{fence:{owner:child.run_id,generation:state.session_chain.lease.generation}}));
  state=f.state(); assert.equal(state.session_chain.lease.owner_run_id,child.run_id);
  goalOk(f.cli(['workstream','select','--id',f.a.id,'--expected-scope',scopeToken(state),'--reason','resume parked work'],{fence:{owner:child.run_id,generation:state.session_chain.lease.generation}}));
  assert.equal(f.state().current_episode,f.id);
});
