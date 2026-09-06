import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildInitialLoop } from '../scripts/lib/initrun.mjs';
import { validate } from '../scripts/lib/schema.mjs';
import { computeDebt } from '../scripts/lib/comprehension.mjs';
import { classifyPatch } from '../scripts/lib/state.mjs';
import { validate as legacyValidate } from './fixtures/legacy-v04/scripts/lib/schema.mjs';
import { GOAL_NOW, makeGoalFixture, TEST_GOAL_CONTRACT } from './helpers/goal-fixture.mjs';

const legacySchema = JSON.parse(readFileSync(new URL('./fixtures/legacy-v04-schema.json', import.meta.url), 'utf8'));
const review = { points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model', flags: [], converge: true, max_review_rounds: 5, require_human_ack: false };
function build(extra = {}) {
  return buildInitialLoop({ runtime: 'claude', goal: 'Deliver A', protocol: 'standalone',
    recipe: { id: 'test', name: 'test', reason: 'test' }, now: new Date(GOAL_NOW),
    runId: '01K4G43N00SDWDVVDKDAR12345', env: {}, run: () => ({ status: 1, stdout: '' }),
    goalContract: structuredClone(TEST_GOAL_CONTRACT), ...extra });
}

test('goal-contract init opts into validated v0.5 while released v0.4 remains readable', (t) => {
  const f = makeGoalFixture(); t.after(f.cleanup);
  const loop = f.state();
  assert.equal(loop.schema_version, '0.5.0');
  assert.deepEqual(loop.orchestration, { version: 1, supervision: 'delegated', boundary_mode: 'continue' });
  assert.deepEqual(loop.review.points, ['implementation']);
  assert.equal(loop.review.require_human_ack, false);
  assert.match(loop.goal_contract.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(loop.goal_reviews, []);
  assert.deepEqual(loop.goal_obligations, []);
  assert.equal(validate(loop).ok, true, validate(loop).errors.join(';'));
  assert.equal(legacyValidate(loop, legacySchema).ok, false, 'the actual released reader must reject new state');
  const old = build({ goalContract: undefined });
  assert.equal(old.schema_version, '0.4.0');
  assert.equal(old.review.require_human_ack, true);
  assert.deepEqual(old.review.points, ['design', 'plan', 'implementation']);
  assert.equal(validate(old).ok, true);
  assert.equal(legacyValidate(old, legacySchema).ok, true);
});

test('the released validator fixture matches its pinned source bytes', () => {
  const manifest = JSON.parse(readFileSync(new URL('./fixtures/legacy-v04/provenance.json', import.meta.url), 'utf8'));
  assert.equal(manifest.commit, '8763b48b14635ab40251d74de88448e43f722ec5');
  assert.equal(manifest.files.length, 6);
  for (const entry of manifest.files) {
    const bytes = readFileSync(new URL(`./fixtures/legacy-v04/${entry.source}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.source);
  }
});

test('goal contract rejects empty, duplicate, foreign keys, unsafe IDs and caller digests', () => {
  const good = structuredClone(TEST_GOAL_CONTRACT);
  for (const contract of [null, {}, { ...good, version: 2 }, { ...good, requirements: [] },
    { ...good, requirements: [good.requirements[0], good.requirements[0]] },
    { ...good, sha256: 'a'.repeat(64) }, { ...good, extra: true },
    { ...good, requirements: [{ ...good.requirements[0], id: '../escape' }] },
    { ...good, requirements: [{ ...good.requirements[0], id: 7 }] },
    { ...good, requirements: [{ ...good.requirements[0], acceptance: '' }] },
    { ...good, requirements: [{ ...good.requirements[0], tool_order: ['implement'] }] },
    { ...good, requirements: Array.from({ length: 65 }, (_, index) => ({ ...good.requirements[0], id: `R${index}` })) },
    { ...good, non_goals: [null] },
  ]) assert.throws(() => build({ goalContract: contract }), /GOAL_CONTRACT_INVALID/, JSON.stringify(contract));
  assert.notEqual(build().goal_contract.sha256, build({ goal: 'Deliver A and B' }).goal_contract.sha256);
});

test('new supervision is explicit, consistent and unavailable without a goal contract', () => {
  assert.throws(() => build({ goalContract: undefined, supervision: 'delegated' }), /GOAL_CONTRACT_REQUIRED/);
  assert.throws(() => build({ goalContract: undefined, boundaryMode: 'continue' }), /GOAL_CONTRACT_REQUIRED/);
  assert.throws(() => build({ supervision: 'guess' }), /GOAL_POLICY_INVALID/);
  assert.throws(() => build({ boundaryMode: 'guess' }), /GOAL_POLICY_INVALID/);
  assert.throws(() => build({ supervision: 'delegated', review: { ...review, require_human_ack: true } }), /GOAL_POLICY_INVALID/);
  assert.throws(() => build({ supervision: 'human', review }), /GOAL_POLICY_INVALID/);
  assert.equal(build({ supervision: 'human' }).review.require_human_ack, true);
  assert.equal(validate(build({ review: { ...review, points: [7] } })).ok, false);
});

test('malformed goal state or version rewrite cannot gain legacy authority', () => {
  const cases = [
    loop => { delete loop.orchestration; },
    loop => { loop.orchestration.supervision = 'unknown'; },
    loop => { loop.orchestration.extra = true; },
    loop => { loop.goal_contract.requirements[0].statement = 'Silently changed goal'; },
    loop => { loop.goal_contract.sha256 = 'a'.repeat(64); },
    loop => { loop.goal_obligations = {}; },
    loop => { loop.goal_reviews = {}; },
    loop => { loop.session_chain.sessions[0].scope_epoch = -1; },
    loop => { loop.session_chain.sessions[0].scope_history = {}; },
    loop => { delete loop.session_chain.sessions[0].scope_turn_baseline; },
    loop => { loop.review.max_review_rounds = 0; },
    loop => { loop.schema_version = '0.4.0'; },
  ];
  for (const mutate of cases) {
    const loop = build(); mutate(loop);
    assert.equal(validate(loop).ok, false, mutate.toString());
  }
  for (const field of ['goal_contract', 'goal_contract.requirements', 'goal_obligations', 'goal_reviews',
    'orchestration', 'session_chain.sessions.0.scope_epoch', 'workstreams.0.requirement_ids']) {
    assert.equal(classifyPatch(field, []), 'forbid', field);
  }
});

test('delegated progress keeps debt truthful without fabricating human review', () => {
  for (const supervision of ['delegated', 'human']) {
    const loop = build({ supervision });
    loop.episodes = [{ role: 'maker', status: 'done', human_reviewed: false, agent_reviewed: true }];
    const before = structuredClone(loop);
    assert.deepEqual(computeDebt(loop), { debt_ratio: 1, blocked: supervision === 'human' });
    assert.deepEqual(loop, before, 'computing permission never mints review credit');
  }
  const legacy = build({ goalContract: undefined });
  legacy.episodes = [{ role: 'maker', status: 'done', human_reviewed: false, agent_reviewed: true }];
  assert.deepEqual(computeDebt(legacy), { debt_ratio: 1, blocked: true });
});

test('public workstream mapping requires known goal IDs and rejects invalid dependency mutations atomically', (t) => {
  const f = makeGoalFixture(); t.after(f.cleanup);
  const ws = f.workstream('delivery');
  assert.deepEqual(f.state().workstreams[0].requirement_ids, ['REQ-A']);
  const before = f.state();
  for (const ids of [[], ['REQ-OTHER'], ['REQ-A', 'REQ-A'], null]) {
    const result = f.cli(['workstream', 'new', '--title', 'bad', '--branch', 'bad', '--worktree', '.worktrees/bad', '--requirements', JSON.stringify(ids)]);
    assert.equal(result.exit, 1, result.stderr);
    assert.deepEqual(f.state(), before);
  }
  const result = f.cli(['workstream', 'new', '--title', 'bad', '--branch', 'bad', '--worktree', '.worktrees/bad', '--requirements', '["REQ-A"]', '--depends-on', '["missing"]']);
  assert.equal(result.exit, 1, result.stderr);
  assert.deepEqual(f.state(), before);
  // The generic patch route is still the dependency writer; schema validation
  // inside its anchored precheck must catch both cycles and unknown IDs.
  for (const depends of [[ws.id], ['missing']]) {
    const patch = f.cli(['state', 'patch', '--field', 'workstreams.0.depends_on', '--value', JSON.stringify(depends), '--owner', f.fence.owner, '--generation', '1']);
    assert.equal(patch.exit, 1, patch.stderr);
    assert.deepEqual(f.state(), before);
  }
});
