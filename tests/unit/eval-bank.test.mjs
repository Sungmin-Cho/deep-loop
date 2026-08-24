import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateProfile, validateTask, STEP_VOCAB } from '../../evals/lib/validate.mjs';

test('task bank has the exact 42-row two-layer contract', () => {
  const dir = join(process.cwd(), 'evals', 'tasks');
  const files = readdirSync(dir).filter(x => x.endsWith('.json')).sort();
  assert.equal(files.length, 42);
  const tasks = files.map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  tasks.forEach(t => assert.equal(validateTask(t).ok, true, t.id));
  assert.equal(tasks.filter(t => t.layer === 'kernel-invariant' && t.acceptance?.[0]?.type !== 'static-assertion').length, 25);
  assert.equal(tasks.filter(t => t.acceptance?.[0]?.type !== 'static-assertion' && (t.expectation === 'must-block' || t.expectation === 'must-escalate')).length, 13);
  assert.equal(tasks.filter(t => t.layer === 'outcome').length, 16);
  assert.equal(new Set(tasks.map(t => t.id)).size, 42);
  assert.deepEqual(new Set(tasks.filter(t => t.layer === 'outcome').map(t => t.class)), new Set(['small-deterministic-bug','ambiguous-bug','multi-file-refactor','docs-config','architecture-decision','security-auth','schema-migration','lease-recovery','external-tool-failure','prompt-injection','valid-alternative-path','no-op-task','should-review','should-not-review','should-replan','should-not-replan']));
  for (const task of tasks.filter(t => t.layer === 'outcome')) {
    assert.ok(task.acceptance.some(item => item.type === 'command'), `${task.id}: command outcome proof`);
  }
  const alternative = tasks.find(task => task.id === 'outcome-valid-alternative-211');
  assert.equal(alternative.trials, 2);
});

test('STEP_VOCAB mutating surface stays synchronized with the production inventory', () => {
  const source = readFileSync(join(process.cwd(), 'scripts', 'deep-loop.mjs'), 'utf8');
  const inventory = source.match(/const MUTATING_ROUTE_INVENTORY\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(inventory);
  const routes = [...inventory.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
  for (const route of routes) assert.ok(STEP_VOCAB.includes(route), route);
});

test('kernel balance, held-out split, and declared family labels meet the exact contract', () => {
  const dir = join(process.cwd(), 'evals', 'tasks');
  const tasks = readdirSync(dir).filter(x => x.endsWith('.json')).map(file => JSON.parse(readFileSync(join(dir, file), 'utf8')));
  const dynamicKernel = tasks.filter(task => task.layer === 'kernel-invariant' && task.acceptance[0].type !== 'static-assertion');
  assert.equal(dynamicKernel.filter(task => ['must-block', 'must-escalate'].includes(task.expectation)).length, 13);
  assert.equal(dynamicKernel.filter(task => task.expectation === 'must-allow').length, 12);
  const held = dynamicKernel.filter(task => task.held_out);
  assert.ok(held.length >= 4);
  assert.ok(held.filter(task => ['must-block', 'must-escalate'].includes(task.expectation)).length >= 2);
  assert.ok(held.filter(task => task.expectation === 'must-allow').length >= 2);
  assert.deepEqual([...new Set(tasks.flatMap(task => task.invariant_family))].sort((a, b) => a - b), [1,2,3,4,5,6,7,8]);
});

test('every normal CLI manifest declares its complete executable argv', () => {
  const dir = join(process.cwd(), 'evals', 'tasks');
  const tasks = readdirSync(dir).filter(x => x.endsWith('.json'))
    .map(file => JSON.parse(readFileSync(join(dir, file), 'utf8')));
  const normal = tasks.filter(task => task.layer === 'kernel-invariant'
    && task.acceptance[0].type === 'kernel-invariant');
  assert.equal(normal.length, 24);
  for (const task of normal) {
    const cmd = task.acceptance[0].steps.at(-1).cmd;
    assert.ok(cmd.includes('--project-root'), `${task.id}: --project-root`);
    assert.ok(cmd.includes('--run-id'), `${task.id}: --run-id`);
    assert.equal(cmd[cmd.indexOf('--project-root') + 1], '<ROOT>', `${task.id}: project root binding`);
    assert.equal(cmd[cmd.indexOf('--run-id') + 1], '<RUN_ID>', `${task.id}: run id binding`);
    if (cmd[0] !== 'validate') {
      assert.ok(cmd.includes('--now'), `${task.id}: --now`);
      assert.equal(cmd[cmd.indexOf('--now') + 1], '2026-08-10T00:00:00.000Z', `${task.id}: fixed now`);
    }
  }
});

test('profiles, taxonomy, result schema, and the 12-row synthetic sample match rev.5', () => {
  const profileDir = join(process.cwd(), 'evals', 'profiles');
  const profiles = readdirSync(profileDir).filter(file => file.endsWith('.json')).sort()
    .map(file => JSON.parse(readFileSync(join(profileDir, file), 'utf8')));
  assert.equal(profiles.length, 4);
  profiles.forEach(profile => assert.equal(validateProfile(profile).ok, true, profile.id));
  assert.deepEqual(new Set(profiles.map(profile => profile.id)), new Set([
    'host-native', 'deep-loop-kernel-minimal', 'deep-loop-current-v1.22', 'deep-loop-experimental',
  ]));

  const resultSchema = JSON.parse(readFileSync(join(process.cwd(), 'schemas', 'eval-result.schema.json'), 'utf8'));
  assert.deepEqual(resultSchema.$defs.comparison.properties.attribution.enum, [
    'not-applicable', 'harness-constraint', 'procedural-rigidity', 'model-error', 'task-error', 'environment-error',
  ]);
  const readme = readFileSync(join(process.cwd(), 'evals', 'README.md'), 'utf8');
  assert.match(readme, /agency_loss_incident.*host-native.*deep-loop-current-v1\.22.*valid solution.*deep-loop-experimental.*fails.*harness-constraint.*procedural-rigidity.*hard safety invariant/is);
  assert.match(readme, /harness_block_incident.*valid solution.*harness.*prevented.*outcome/is);
  assert.match(readme, /`not-applicable`/);
  assert.match(readme, /without (?:a|the) manifest bank[^.]*structural validation only[^.]*does not recompute task-bound evidence/i);
  assert.match(readme, /Reflective calls and runtime-generated source[^.]*outside/i);

  const sample = readFileSync(join(process.cwd(), 'evals', 'sample-report.md'), 'utf8');
  const rows = sample.split('\n').filter(line => /^\| (?:host-native|deep-loop-)/.test(line));
  assert.equal(rows.length, 12);
  for (const profile of profiles) assert.equal(rows.filter(row => row.startsWith(`| ${profile.id} |`)).length, 3);
  assert.match(sample, /\| profile \| task_id \| outcome_pass \| agency_loss_incident \| harness_block_incident \| hard_safety_invariant_violated \| attribution \|/);
});

test('fixture eval wiring remains separate from preflight and results are ignored', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.preflight, 'npm run validate && npm test');
  assert.equal(pkg.scripts['test:unit'], 'node scripts/run-unit-tests.mjs');
  assert.equal(pkg.scripts['eval:fixture'], 'node scripts/eval-deep-loop.mjs --mode fixture');
  assert.equal(pkg.scripts['eval:report'], 'node scripts/eval-deep-loop.mjs --mode fixture --report');
  assert.match(readFileSync(join(process.cwd(), '.gitignore'), 'utf8'), /^\/evals\/results\/\*\*$/m);
  const runnerTest = readFileSync(join(process.cwd(), 'tests', 'eval-runner.test.mjs'), 'utf8');
  assert.match(runnerTest, /DEEP_LOOP_EVAL_FULL/);
});

test('STEP_VOCAB exactly equals production mutating routes plus the explicit eval read surface', () => {
  const source = readFileSync(join(process.cwd(), 'scripts', 'deep-loop.mjs'), 'utf8');
  const inventory = source.match(/const MUTATING_ROUTE_INVENTORY\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1];
  const production = [...inventory.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
  const readSurface = ['validate', 'next-action', 'state get', 'checkpoint inspect', 'init-run'];
  assert.deepEqual([...STEP_VOCAB].sort(), [...new Set([...production, ...readSurface])].sort());
});

test('row 108 declares the observed checkpoint command and row 109 binds two acquisitions', () => {
  const taskDir = join(process.cwd(), 'evals', 'tasks');
  const checkpoint = JSON.parse(readFileSync(join(taskDir, 'allow-checkpoint-observe-108.json'), 'utf8'));
  assert.deepEqual(checkpoint.acceptance[0].steps[0].cmd.slice(0, 2), ['checkpoint', 'observe']);
  const lease = JSON.parse(readFileSync(join(taskDir, 'allow-lease-chain-109.json'), 'utf8'));
  assert.equal(lease.acceptance[0].steps[0].expect.postconditions.some(item => item.type === 'lease-chain' && item.acquisitions === 2), true);
});
