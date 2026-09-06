import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGoalFixture } from './helpers/goal-fixture.mjs';
import { goalOk, reviewedGoalWork } from './helpers/reviewed-goal.mjs';
import * as scope from '../scripts/lib/session-scope.mjs';
const token = f => scope.scopeToken ? scope.scopeToken(f.state()) : '0'.repeat(64);
function maker(f, ws, mode = 'inline') {
  const id = goalOk(f.cli(['episode', 'new', '--plugin', 'standalone', '--role', 'maker', '--kind', 'implementation', '--point', 'implementation', '--workstream', ws.id])).id;
  const execution = goalOk(f.cli(['execution', 'prepare', '--episode', id, '--mode', mode, '--stage', 'primary', '--task', 'Implement the selected workstream'])).execution;
  return { id, execution };
}
test('public select parks and resumes blocked inline work without replacing its attempt; old ABA token fails', t => {
  const f = makeGoalFixture(); t.after(f.cleanup);
  const a = f.workstream('a'), b = f.workstream('b');
  const m = maker(f, a); goalOk(f.cli(['episode', 'record', '--id', m.id, '--status', 'blocked']));
  const original = f.state().session_chain.sessions[0].scope;
  const old = token(f); goalOk(f.select(b.id, old));
  assert.equal(f.state().session_chain.sessions[0].scope_history[0].scope.workstream_id, a.id);
  goalOk(f.select(a.id, token(f)));
  const current = f.state(); assert.deepEqual(current.session_chain.sessions[0].scope, original);
  assert.equal(current.episodes[0].execution.attempt_id, m.execution.attempt_id);
  assert.equal(current.episodes[0].execution.phase, 'running'); assert.equal(current.current_episode, m.id);
  const rejected = f.select(b.id, old); assert.equal(rejected.exit, 1); assert.match(rejected.stderr, /SCOPE_TOKEN_MISMATCH/);
  assert.deepEqual(f.state(), current);
});
test('public select rejects in-progress inline and prepared/running/unknown external producers', t => {
  for (const mode of ['inline', 'external']) {
    const f = makeGoalFixture(); t.after(f.cleanup); const a = f.workstream(`a-${mode}`), b = f.workstream(`b-${mode}`);
    const m = maker(f, a, mode); const before = f.state();
    assert.equal(f.select(b.id, token(f)).exit, 1); assert.deepEqual(f.state(), before);
    if (mode === 'external') {
      goalOk(f.cli(['episode', 'record', '--id', m.id, '--status', 'blocked']));
      assert.equal(f.select(b.id, token(f)).exit, 1);
      goalOk(f.cli(['execution', 'start', '--episode', m.id, '--attempt', m.execution.attempt_id, '--handle', 'external-task']));
      goalOk(f.cli(['execution', 'reconcile', '--episode', m.id, '--attempt', m.execution.attempt_id, '--observation', JSON.stringify({ source: 'native-task', state: 'unknown', handle: 'external-task', reference: 'observed:unknown' })]));
      assert.equal(f.select(b.id, token(f)).exit, 1);
    }
  }
});
test('public select binds fresh scopes and preserves grammar, fence, and legacy rejection', t => {
  const f = makeGoalFixture(); t.after(f.cleanup); const a = f.workstream('a');
  assert.equal(f.cli(['workstream','select','--id',a.id,'--reason','choose']).exit, 2);
  assert.equal(f.cli(['workstream','select','--id',a.id,'--expected-scope',token(f),'--reason','choose'], { fence: { owner: f.runId, generation: 9 } }).exit, 3);
  goalOk(f.select(a.id, token(f)));
  const s = f.state().session_chain.sessions[0]; assert.equal(s.scope.workstream_id,a.id); assert.equal(s.scope_epoch,1); assert.ok(s.scope_turn_baseline <= s.turns);
  assert.equal(f.select(a.id, token(f)).exit,1);
  const old = makeGoalFixture({ legacy:true }); t.after(old.cleanup); const w = old.workstream('old'); assert.equal(old.select(w.id,'0'.repeat(64)).exit,1);
});
test('closed scope is consumed into history; its old terminal cannot authorize a handoff', t => {
  const f = reviewedGoalWork(t), b = f.workstream('b');
  const closed = f.state().session_chain.sessions[0].scope;
  goalOk(f.select(b.id,token(f)));
  assert.deepEqual(f.state().session_chain.sessions[0].scope_history[0].scope,closed);
  const result=f.cli(['handoff','emit','--reason','workstream-terminal','--boundary-event',`${closed.terminal_event.seq}:${closed.terminal_event.checksum}`]);
  assert.equal(result.exit,1); assert.match(result.stderr,/BOUNDARY|SCOPE/);
});
for (const phase of ['prepared','running','unknown']) test(`pending run-level goal review blocks selection: ${phase}`, t => {
  const f=reviewedGoalWork(t);
  const review=goalOk(f.cli(['goal','dispatch','--transport','native'])).review;
  if (phase !== 'prepared') goalOk(f.cli(['goal','start','--id',review.id,'--attempt',review.execution.attempt_id,'--handle','pending-review']));
  if (phase === 'unknown') goalOk(f.cli(['goal','reconcile','--id',review.id,'--attempt',review.execution.attempt_id,'--observation',JSON.stringify({source:'native-task',state:'unknown',handle:'pending-review',reference:'observation:unknown'})]));
  const b=f.workstream('b');
  const result=f.select(b.id,token(f)); assert.equal(result.exit,1); assert.match(result.stderr,/SCOPE_SELECTION_BUSY/);
});
test('pure selection advice shares public target and producer checks', async t => {
  const api=await import('../scripts/lib/scope-selection.mjs');
  assert.equal(typeof api.scopeSelectionState,'function');
  const f=makeGoalFixture(); t.after(f.cleanup); const a=f.workstream('a'), b=f.workstream('b');
  assert.deepEqual(api.scopeSelectionState(f.state(),a.id),{ok:true,reason:null});
  const m=maker(f,a);
  assert.match(api.scopeSelectionState(f.state(),b.id).reason,/SCOPE_SELECTION_BUSY/);
  goalOk(f.cli(['episode','record','--id',m.id,'--status','blocked']));
  assert.deepEqual(api.scopeSelectionState(f.state(),b.id),{ok:true,reason:null});
  const missing=api.scopeSelectionState(f.state(),'missing'); assert.equal(missing.ok,false); assert.match(missing.reason,/WORKSTREAM_NOT_FOUND/);
  goalOk(f.select(b.id,token(f)));
});
test('scope token is canonical across equivalent scope and terminal property ordering', () => {
  const terminal={seq:9,checksum:'a'.repeat(64)};
  const current={kind:'workstream',workstream_id:'ws-a',bound_at_seq:2,terminal_event:terminal,closed_at:'2026-09-06T00:00:00.000Z',superseded_at:null};
  const loop={schema_version:'0.5.0',session_chain:{lease:{owner_run_id:'owner',generation:1},sessions:[{run_id:'owner',scope_epoch:2,scope:current}]}};
  const reordered=structuredClone(loop);
  reordered.session_chain.sessions[0].scope=Object.fromEntries(Object.entries(current).reverse());
  reordered.session_chain.sessions[0].scope.terminal_event={checksum:terminal.checksum,seq:terminal.seq};
  assert.equal(scope.scopeToken(reordered),scope.scopeToken(loop));
});
test('history rejects noncanonical and normalized-invalid closed timestamps', () => {
  const terminal={seq:9,checksum:'a'.repeat(64)};
  const current={kind:'workstream',workstream_id:'ws-a',bound_at_seq:2,terminal_event:terminal,closed_at:'2026-09-06T00:00:00.000Z',superseded_at:null};
  const session={run_id:'owner',scope_epoch:2,scope:{...current,workstream_id:'ws-b'},scope_history:[{scope:current,owner_run_id:'owner',generation:1,scope_epoch:1,reason:'completed',parked_episode_id:null,parked_cursor_ref:null}]};
  const loop={workstreams:[{id:'ws-a',terminal_events:[terminal]}],episodes:[],session_chain:{lease:{owner_run_id:'owner'},sessions:[session]}};
  let errors=[]; scope.validateScopeHistory(loop,session,errors); assert.deepEqual(errors,[]);
  for (const value of ['2026-09-06','2026-02-30T00:00:00.000Z']) {
    current.closed_at=value; errors=[]; scope.validateScopeHistory(loop,session,errors); assert.ok(errors.length,value);
  }
});
