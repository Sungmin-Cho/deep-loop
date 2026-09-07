import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeGoalFixture } from './helpers/goal-fixture.mjs';
import { checkBreaker } from '../scripts/lib/breaker.mjs';
import { validate } from '../scripts/lib/schema.mjs';

function ok(result) { assert.equal(result.exit, 0, result.stderr); return result.json; }
function setup(t, options) {
  const f = makeGoalFixture({ review: { points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model', flags: [], converge: true, max_review_rounds: 5, require_human_ack: false }, ...options }); t.after(f.cleanup);
  const ws = f.workstream('delivery');
  const artifact = `${ws.worktree}/result.mjs`;
  const maker = ok(f.cli(['episode', 'new', '--plugin', 'standalone', '--role', 'maker', '--kind', 'implementation', '--point', 'implementation', '--workstream', ws.id, '--artifacts', JSON.stringify([artifact])])).id;
  const prepare = (mode = 'inline', stage = 'primary', task = 'Deliver working A') => f.cli(['execution', 'prepare', '--episode', maker, '--mode', mode, '--stage', stage, '--task', task]);
  const finish = (attempt, artifacts, observation) => f.cli(['execution', 'return', '--episode', maker, '--attempt', attempt, '--artifacts', JSON.stringify(artifacts), ...(observation ? ['--observation', JSON.stringify(observation)] : [])]);
  return { ...f, ws, artifact, maker, prepare, finish };
}
const observed = (state, handle) => ({ source: 'native-task', state, handle, reference: `native-observation:${state}` });

test('inline execution resumes the same attempt and only its returned artifacts derive done', (t) => {
  const f = setup(t);
  const first = ok(f.prepare());
  const attempt = first.execution.attempt_id;
  const preparedEvent = readFileSync(join(f.root, '.deep-loop', 'runs', f.runId, 'event-log.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line)).find(event => event.type === 'execution-prepared');
  assert.equal(preparedEvent.data.attempt_id, attempt, 'the anchored event identifies the persisted execution intent');
  assert.equal(first.execution.phase, 'running');
  assert.equal(ok(f.cli(['next-action', '--json'])).action.type, 'resume_maker');
  assert.equal(ok(f.prepare()).execution.attempt_id, attempt, 'an interrupted inline turn resumes its intent');
  assert.equal(f.prepare('inline', 'primary', 'Different task').exit, 1);
  assert.equal(f.finish(attempt, [f.artifact]).exit, 1, 'declared output must actually exist');
  // Exercise the actual file output; labels and phase names are no proof.
  const resultPath = `${f.ws.worktree}/result.mjs`;
  writeFileSync(join(f.root, resultPath), 'export const answer = 42;\n');
  assert.equal(f.cli(['episode', 'record', '--id', f.maker, '--status', 'done', '--artifacts', JSON.stringify([resultPath])]).exit, 1);
  ok(f.finish(attempt, [resultPath]));
  const maker = f.state().episodes.find(e => e.id === f.maker);
  assert.equal(maker.status, 'done');
  assert.equal(maker.execution.phase, 'returned');
  assert.equal(f.finish(attempt, [resultPath]).exit, 1, 'terminal attempts cannot settle twice');
});

test('external start gaps reconcile without duplicate producers or report-absence guesses', (t) => {
  const f = setup(t);
  const attempt = ok(f.prepare('external')).execution.attempt_id;
  assert.equal(ok(f.cli(['next-action', '--json'])).action.type, 'reconcile_execution');
  const start = (id, handle) => f.cli(['execution', 'start', '--episode', f.maker, '--attempt', id, '--handle', handle]);
  assert.equal(start('stale-attempt', 'native-one').exit, 1);
  ok(start(attempt, 'native-one'));
  assert.equal(start(attempt, 'native-two').exit, 1);
  assert.equal(f.finish(attempt, [f.artifact]).exit, 1, 'external completion requires an actual observed producer return');
  ok(f.cli(['execution', 'reconcile', '--episode', f.maker, '--attempt', attempt, '--observation', JSON.stringify(observed('unknown', 'native-one'))]));
  assert.equal(ok(f.cli(['next-action', '--json'])).action.type, 'await_human');
  assert.equal(f.prepare('external').exit, 1, 'unknown liveness cannot authorize another producer');
  ok(f.cli(['execution', 'reconcile', '--episode', f.maker, '--attempt', attempt, '--observation', JSON.stringify(observed('absent', 'native-one'))]));
  assert.equal(ok(f.cli(['next-action', '--json'])).action.type, 'dispatch_maker');
  ok(start(attempt, 'native-two'));
  writeFileSync(join(f.root, f.artifact), 'export const answer = 42;\n');
  assert.equal(f.finish(attempt, [f.artifact], observed('succeeded', 'native-one')).exit, 1);
  ok(f.finish(attempt, [f.artifact], observed('succeeded', 'native-two')));
  assert.equal(f.state().episodes[0].status, 'done');
});

test('Superpowers planning return cannot settle implementation before its continuation', (t) => {
  const f = setup(t, { protocol: 'superpowers' });
  const first = ok(f.prepare()).execution;
  assert.deepEqual(first.required_stages, ['primary', 'continuation']);
  const plan = `${f.ws.worktree}/plan.md`;
  writeFileSync(join(f.root, plan), '# A plan, with implementation still missing\n');
  ok(f.finish(first.attempt_id, [plan]));
  assert.equal(f.state().episodes[0].status, 'in_progress');
  const action = ok(f.cli(['next-action', '--json'])).action;
  assert.equal(action.type, 'dispatch_maker');
  assert.equal(action.stage, 'continuation');
  assert.equal(action.plan_path, plan);
  assert.equal(f.cli(['episode', 'record', '--id', f.maker, '--status', 'done', '--artifacts', JSON.stringify([plan])]).exit, 1);
  const second = ok(f.prepare('inline', 'continuation', 'Implement the saved plan')).execution;
  assert.notEqual(second.attempt_id, first.attempt_id);
  assert.equal(f.finish(second.attempt_id, [plan]).exit, 1);
  writeFileSync(join(f.root, f.artifact), 'export const answer = 42;\n');
  ok(f.finish(second.attempt_id, [f.artifact]));
  const maker = f.state().episodes[0];
  assert.equal(maker.status, 'done');
  assert.equal(maker.execution_history[0].attempt_id, first.attempt_id);
});

function completedMaker(f) {
  const execution = ok(f.prepare()).execution;
  writeFileSync(join(f.root, f.artifact), 'export const answer = 42;\n');
  ok(f.finish(execution.attempt_id, [f.artifact]));
}

function finishChecker(f, verdict = 'APPROVE') {
  const checker = ok(f.cli(['review', 'dispatch', '--point', 'implementation', '--workstream', f.ws.id, '--independent-subagent'])).checkerEpisodeId;
  const pending = ok(f.cli(['next-action', '--json'])).action;
  assert.equal(pending.type, 'reconcile_execution');
  assert.equal(pending.episode_id, checker);
  const claim = ok(f.cli(['review', 'claim', '--episode', checker]));
  const document = { schema_version: '1.0', reviewer_id: claim.claim.reviewer_id, checker_episode_id: checker,
    target_maker: f.maker, attempt_id: claim.attemptId, verdict, report_body: `# synthetic independent test reviewer\n${verdict}`,
    artifacts: [{ path: f.artifact, sha256: createHash('sha256').update(readFileSync(join(f.root, f.artifact))).digest('hex') }] };
  const record = () => f.cli(['review', 'import', '--stdin'], { input: JSON.stringify(document) });
  assert.equal(record().exit, 1, 'claimed checker output without observed return is not approval');
  ok(f.cli(['execution', 'start', '--episode', checker, '--attempt', claim.attemptId, '--handle', 'fresh-native-reviewer']));
  ok(f.cli(['execution', 'return', '--episode', checker, '--attempt', claim.attemptId, '--artifacts', '[]', '--observation', JSON.stringify(observed('succeeded', 'fresh-native-reviewer'))]));
  assert.equal(f.state().episodes.find(e => e.id === checker).status, 'in_progress', 'execution return cannot manufacture a checker verdict');
  assert.equal(f.cli(['review', 'record', '--episode', checker, '--verdict', verdict]).exit, 1);
  ok(record());
  return checker;
}

test('claimed checker keeps one attempt and only bound import derives its terminal review', (t) => {
  const f = setup(t); completedMaker(f);
  const checker = finishChecker(f);
  assert.equal(f.state().episodes.filter(e => e.role === 'checker').length, 1);
  assert.equal(f.state().episodes.find(e => e.id === checker).status, 'approved');
});

test('fix creation requires the latest bound rejection and carries no fabricated running producer', (t) => {
  const f = setup(t); completedMaker(f);
  const create = retryOf => f.cli(['episode', 'new', '--plugin', 'standalone', '--role', 'maker', '--kind', 'fix', '--point', 'implementation', '--workstream', f.ws.id, '--artifacts', JSON.stringify([f.artifact]), '--retry-of', retryOf]);
  assert.equal(create(f.maker).exit, 1);
  finishChecker(f, 'REQUEST_CHANGES');
  const fix = ok(create(f.maker)).id;
  const persisted = f.state().episodes.find(e => e.id === fix);
  assert.equal(persisted.status, 'pending');
  assert.equal(persisted.retry_of, f.maker);
  assert.equal(persisted.execution, undefined);
  assert.equal(ok(f.cli(['next-action', '--json'])).action.type, 'dispatch_maker');
});

test('configured goal review limits do not reinterpret the released v0.4 breaker threshold', () => {
  const common = { circuit_breaker: { consecutive_request_changes: 3, tripped: false }, review: { max_review_rounds: 5 } };
  assert.equal(checkBreaker({ ...common, schema_version: '0.4.0' }).tripped, true);
  const goal = { ...common, schema_version: '0.5.0', orchestration: { version: 1, supervision: 'delegated', boundary_mode: 'continue' } };
  assert.equal(checkBreaker(goal).tripped, false);
  assert.equal(checkBreaker({ ...goal, circuit_breaker: { consecutive_request_changes: 5, tripped: false } }).tripped, true);
  assert.equal(checkBreaker({ ...goal, circuit_breaker: { consecutive_request_changes: 0, tripped: true } }).tripped, true);
});

test('a known failed continuation retries a fresh attempt without losing its original plan', (t) => {
  const f = setup(t, { protocol: 'superpowers' });
  const primary = ok(f.prepare()).execution;
  const plan = `${f.ws.worktree}/plan.md`;
  writeFileSync(join(f.root, plan), '# Implementation plan\n');
  ok(f.finish(primary.attempt_id, [plan]));
  const first = ok(f.prepare('external', 'continuation', 'Implement the plan')).execution;
  ok(f.cli(['execution', 'start', '--episode', f.maker, '--attempt', first.attempt_id, '--handle', 'failed-child']));
  ok(f.cli(['execution', 'reconcile', '--episode', f.maker, '--attempt', first.attempt_id, '--observation', JSON.stringify(observed('failed', 'failed-child'))]));
  const retried = ok(f.prepare('external', 'continuation', 'Implement the plan'));
  assert.notEqual(retried.execution.attempt_id, first.attempt_id);
  assert.equal(retried.invocation.plan_path, plan);
});

test('execution rejects stale fences, forged supervisor returns and malformed persisted observations', (t) => {
  const f = setup(t);
  const execution = ok(f.prepare('external')).execution;
  const before = f.state();
  const fenced = f.cli(['execution', 'start', '--episode', f.maker, '--attempt', execution.attempt_id, '--handle', 'child'], { fence: { owner: 'stale-owner', generation: 99 } });
  assert.equal(fenced.exit, 3);
  assert.deepEqual(f.state(), before);
  ok(f.cli(['execution', 'start', '--episode', f.maker, '--attempt', execution.attempt_id, '--handle', 'child']));
  writeFileSync(join(f.root, f.artifact), 'export const answer = 42;\n');
  const receipts = join(f.root, '.deep-review', 'receipts'); mkdirSync(receipts, { recursive: true });
  const output = join(receipts, `${execution.attempt_id}.stdout`); writeFileSync(output, 'real returned output');
  const receipt = { attempt_id: execution.attempt_id, result: { state: 'SUCCEEDED', exit_status: 0, termination_confirmed: false,
    stdout_path: output, output_sha256: createHash('sha256').update('real returned output').digest('hex') } };
  const rel = `.deep-review/receipts/${execution.attempt_id}.json`;
  writeFileSync(join(f.root, rel), JSON.stringify(receipt));
  const observation = { source: 'supervisor-receipt', state: 'succeeded', handle: 'child', reference: rel };
  assert.equal(f.finish(execution.attempt_id, [f.artifact], observation).exit, 1, 'unconfirmed process is not return evidence');
  receipt.result.termination_confirmed = true; receipt.result.output_sha256 = '0'.repeat(64);
  writeFileSync(join(f.root, rel), JSON.stringify(receipt));
  assert.equal(f.finish(execution.attempt_id, [f.artifact], observation).exit, 1, 'stdout digest is independently checked');
  receipt.result.output_sha256 = createHash('sha256').update('real returned output').digest('hex');
  writeFileSync(join(f.root, rel), JSON.stringify(receipt));
  ok(f.finish(execution.attempt_id, [f.artifact], observation));
  assert.equal(f.state().episodes[0].status, 'done');
  for (const mutate of [record => { record.phase = 'invented'; }, record => { record.extra = true; },
    record => { record.observation = { state: 'succeeded' }; }, record => { record.required_stages = ['continuation']; }]) {
    const loop = f.state(); mutate(loop.episodes[0].execution);
    assert.equal(validate(loop).ok, false);
  }
});

test('new fixes accept a fresh routing choice while the previous attempt route remains frozen', (t) => {
  const f = setup(t);
  // Synthetic routing metadata tests persistence; it is not a measured model call.
  const route = model => ({ request: { task_class: 'IMPLEMENTATION' }, decision: { route_schema_version: 1,
    router_plugin_version: 'fixture', policy_sha256: 'a'.repeat(64) }, selected_model: model,
    selected_effort_native: 'high', effective_policy: {}, provenance: 'local-fallback' });
  const prepare = (id, routing, mode = 'external') => f.cli(['execution', 'prepare', '--episode', id, '--mode', mode, '--stage', 'primary', '--task', 'Deliver A', '--routing', JSON.stringify(routing)]);
  assert.equal(prepare(f.maker, route('model-a'), 'inline').exit, 1, 'an inline owner cannot claim an unobserved model assignment');
  const first = ok(prepare(f.maker, route('model-a'))).execution;
  assert.equal(prepare(f.maker, route('model-b')).exit, 1);
  ok(f.cli(['execution', 'start', '--episode', f.maker, '--attempt', first.attempt_id, '--handle', 'synthetic-model-a-child']));
  writeFileSync(join(f.root, f.artifact), 'export const answer = 42;\n'); ok(f.finish(first.attempt_id, [f.artifact], observed('succeeded', 'synthetic-model-a-child')));
  finishChecker(f, 'REQUEST_CHANGES');
  const fix = ok(f.cli(['episode', 'new', '--plugin', 'standalone', '--role', 'maker', '--kind', 'fix', '--point', 'implementation', '--workstream', f.ws.id, '--artifacts', JSON.stringify([f.artifact]), '--retry-of', f.maker])).id;
  ok(prepare(fix, route('model-b')));
  const loop = f.state();
  assert.equal(loop.episodes.find(e => e.id === f.maker).routing.selected_model, 'model-a');
  assert.equal(loop.episodes.find(e => e.id === fix).routing.selected_model, 'model-b');
});

test('the bound review writer trips at the configured goal limit and leaves the latch set', (t) => {
  const f = setup(t, { review: { points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model', flags: [], converge: true, max_review_rounds: 1, require_human_ack: false } });
  completedMaker(f); finishChecker(f, 'REQUEST_CHANGES');
  const loop = f.state();
  assert.equal(loop.circuit_breaker.consecutive_request_changes, 1);
  assert.equal(loop.circuit_breaker.tripped, true);
  assert.equal(loop.status, 'paused');
  assert.equal(ok(f.cli(['next-action', '--json'])).action.type, 'await_human');
});
