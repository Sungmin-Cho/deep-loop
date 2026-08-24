import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileSymlink } from './helpers/fs-fixtures.mjs';
import { VALIDATION_REASONS, emitRouteObservation } from '../scripts/lib/route-observation.mjs';
import { locateDeepModelRouter } from '../scripts/lib/locate-deep-model-router.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE_MODULE = join(HERE, '..', 'scripts', 'lib', 'route-observation.mjs');
const SIBLING_CLI = '/Users/sungmin/Dev/claude-plugins/deep-model-router/skills/model-router/scripts/route_task.py';
const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const NOW = '2026-08-24T04:30:00.000Z';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function selectedCli() {
  for (const path of [process.env.DEEP_MODEL_ROUTER_CLI, SIBLING_CLI]) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

function requireCli(path, required) {
  if (path) return path;
  if (required) assert.fail('ACTUAL_VALIDATOR_REQUIRED');
  return null;
}

function inspectInstall(routeTask) {
  const cli = realpathSync(routeTask);
  const root = realpathSync(resolve(dirname(cli), '..', '..', '..'));
  const validator = join(dirname(cli), 'validate_observation.py');
  const packagePath = join(root, 'package.json');
  const pluginPath = join(root, '.claude-plugin', 'plugin.json');
  for (const [label, path] of [
    ['package', packagePath], ['plugin', pluginPath], ['route task', routeTask], ['validator', validator],
  ]) {
    const stat = lstatSync(path);
    assert.equal(stat.isFile(), true, `${label} must be regular`);
    assert.equal(stat.isSymbolicLink(), false, `${label} must not be a symlink`);
    const rel = relative(root, realpathSync(path));
    assert.ok(rel && rel !== '..' && !rel.startsWith('../'), `${label} escapes router root`);
  }
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
  assert.equal(pkg.name, 'deep-model-router');
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, pkg.version);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/.exec(pkg.version);
  assert.ok(match, `non-semver router version ${pkg.version}`);
  assert.ok(Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= 4),
    `router ${pkg.version} is below 1.4`);
  return { cli, root, validator, version: pkg.version };
}

function routing(taskClass = 'IMPLEMENTATION') {
  return {
    request: { task_class: taskClass },
    decision: {
      route_schema_version: 1, router_plugin_version: '1.4.0', policy_sha256: A,
      request_sha256: B, decision_fingerprint: C,
    },
    selected_model: 'claude-fable-5', selected_effort_native: 'high',
    effective_policy: {}, provenance: 'router',
  };
}

function maker(id, { status = 'done', routed = true } = {}) {
  return {
    id, plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream_id: 'ws-01', status, request_rel: `episodes/${id}/request.md`,
    ...(routed ? { routing: routing() } : {}),
  };
}

function checker(id, target) {
  return {
    id, plugin: 'deep-review', role: 'checker', kind: 'review', point: 'implementation',
    workstream_id: 'ws-01', status: 'approved', target_maker: target,
    request_rel: `episodes/${id}/request.md`, routing: routing('REVIEW'),
  };
}

function runFixture(episodes) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-validator-gate-')));
  const run = join(root, '.deep-loop', 'runs', RUN_ID);
  mkdirSync(run, { recursive: true });
  const loop = {
    schema_version: '0.4.0', run_id: RUN_ID, goal: 'must never be copied',
    project: { root, head: 'abcdef1', branch: 'feat/validator-gate', dirty: false },
    autonomy: {
      session_runtime: 'claude', runtime_source: 'skill-asserted',
      session_model: 'claude-fable-5', session_effort: 'high',
    },
    session_chain: { lease: { owner_run_id: RUN_ID } },
    workstreams: [{ id: 'ws-01', base_commit: '1234567' }], episodes,
  };
  return { root, run, loop };
}

function singleMakerFixture() {
  const episode = maker('001-deep-work');
  const fixture = runFixture([episode]);
  return {
    ...fixture,
    options: {
      loop: fixture.loop, event: { seq: 1, ts: NOW, data: { id: episode.id, status: 'done' } },
      episodeId: episode.id, terminalStatus: 'done', kernelVersion: '1.22.0',
    },
  };
}

function published(fixture, result) {
  assert.equal(result.emitted, true, JSON.stringify(result));
  const abs = join(fixture.run, result.path);
  assert.equal(existsSync(abs), true, abs);
  return { abs, bytes: readFileSync(abs) };
}

const STUB = String.raw`import json, os, signal, sys, time
mark = os.environ.get("DEEP_LOOP_ROUTE_OBSERVATION_STUB_MARK")
if mark:
    with open(mark, "a", encoding="utf-8") as f:
        f.write(json.dumps({"mark": mark, "argv": sys.argv[1:]}) + "\n")
mode = os.environ.get("DEEP_LOOP_ROUTE_OBSERVATION_STUB_MODE", "valid")
if mode == "signal": os.kill(os.getpid(), signal.SIGKILL)
if mode == "invalid":
    print("I-REFS: /Users/x/secret/report.json", file=sys.stderr)
    sys.exit(1)
if mode == "usage": sys.exit(2)
if mode == "timeout": time.sleep(30)
if mode == "max-buffer":
    sys.stdout.write("x" * (1024 * 1024))
    sys.stdout.flush()
sys.exit(0)
`;

function routerStub(version = '1.4.0') {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dl-validator-stub-')));
  const root = join(fixtureRoot, 'deep-model-router', version);
  const scripts = join(root, 'skills', 'model-router', 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  const paths = {
    routeTask: join(scripts, 'route_task.py'),
    validator: join(scripts, 'validate_observation.py'),
    package: join(root, 'package.json'),
    plugin: join(root, '.claude-plugin', 'plugin.json'),
  };
  writeFileSync(paths.routeTask, '');
  writeFileSync(paths.validator, STUB);
  writeFileSync(paths.package, `${JSON.stringify({ name: 'deep-model-router', version })}\n`);
  writeFileSync(paths.plugin, `${JSON.stringify({ name: 'deep-model-router', version })}\n`);
  return {
    fixtureRoot, root, paths, marker: join(fixtureRoot, 'spawns.ndjson'),
    baseline: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path)])),
  };
}

function spawns(stub) {
  return existsSync(stub.marker)
    ? readFileSync(stub.marker, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
}

function mutateJson(path, fn) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  fn(value);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function symlinkFile(stub, key) {
  const target = join(stub.fixtureRoot, `${key}-target`);
  writeFileSync(target, stub.baseline[key]);
  unlinkSync(stub.paths[key]);
  createFileSymlink(target, stub.paths[key]);
}

function assertOtherDimensions(stub, changed) {
  for (const [key, path] of Object.entries(stub.paths)) {
    if (changed.has(key)) continue;
    const stat = lstatSync(path);
    assert.equal(stat.isFile(), true, `${key} not regular`);
    assert.equal(stat.isSymbolicLink(), false, `${key} became symlink`);
    assert.deepEqual(readFileSync(path), stub.baseline[key], `${key} changed`);
  }
}

function emitStub(stub, { enabled = true, mode = 'valid', python } = {}) {
  const fixture = singleMakerFixture();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dl-validator-home-')));
  const env = { ...process.env };
  delete env.DEEP_LOOP_ROUTE_OBSERVATION_VALIDATE;
  Object.assign(env, {
    DEEP_MODEL_ROUTER_CLI: stub.paths.routeTask,
    DEEP_LOOP_ROUTE_OBSERVATION_STUB_MARK: stub.marker,
    DEEP_LOOP_ROUTE_OBSERVATION_STUB_MODE: mode,
  });
  if (enabled) env.DEEP_LOOP_ROUTE_OBSERVATION_VALIDATE = '1';
  const result = emitRouteObservation(fixture.root, RUN_ID, {
    ...fixture.options, env, home, ...(python === undefined ? {} : { python }),
  });
  return { fixture, result };
}

test('P7 actual validator gate covers opt-in discovery, install identity, negatives, and four emitted classes', (t) => {
  const required = process.env.DEEP_LOOP_REQUIRE_ACTUAL_VALIDATOR === '1';
  assert.throws(() => requireCli(null, true), /ACTUAL_VALIDATOR_REQUIRED/);
  const routeTask = requireCli(selectedCli(), required);
  if (!routeTask) {
    t.skip('actual deep-model-router validator unavailable');
    return;
  }
  const actual = inspectInstall(routeTask);
  const emptyHome = realpathSync(mkdtempSync(join(tmpdir(), 'dl-validator-actual-home-')));
  assert.equal(locateDeepModelRouter({ env: { DEEP_MODEL_ROUTER_CLI: routeTask }, home: emptyHome }), actual.cli);
  assert.equal(readFileSync(ROUTE_MODULE, 'utf8').includes('DEEP_LOOP_REQUIRE_ACTUAL_VALIDATOR'), false);
  assert.deepEqual(VALIDATION_REASONS, [
    'router-missing', 'validator-missing', 'python-unavailable', 'timeout', 'max-buffer',
    'signal', 'spawn-error', 'invalid', 'usage',
  ]);

  const offStub = routerStub();
  const off = emitStub(offStub, { enabled: false });
  published(off.fixture, off.result);
  assert.deepEqual(off.result.validation, { state: 'disabled' });
  assert.equal(spawns(offStub).length, 0);

  const missing = singleMakerFixture();
  const missingHome = realpathSync(mkdtempSync(join(tmpdir(), 'dl-validator-missing-')));
  const missingResult = emitRouteObservation(missing.root, RUN_ID, {
    ...missing.options,
    env: {
      ...process.env, DEEP_MODEL_ROUTER_CLI: join(missingHome, 'missing', 'route_task.py'),
      DEEP_LOOP_ROUTE_OBSERVATION_VALIDATE: '1',
    },
    home: missingHome,
  });
  published(missing, missingResult);
  assert.deepEqual(missingResult.validation, { state: 'unavailable', reason: 'router-missing' });

  for (const version of ['1.4.0', '2.0.0']) {
    const stub = routerStub(version);
    const positive = emitStub(stub);
    const file = published(positive.fixture, positive.result);
    assert.equal(positive.result.validation?.state, 'valid', `${version}: ${JSON.stringify(positive.result)}`);
    const calls = spawns(stub);
    assert.equal(calls.length, 1, version);
    assert.equal(calls[0].mark, stub.marker);
    assert.deepEqual(calls[0].argv, ['--file', file.abs, '--root', positive.fixture.run, '--check-refs']);
  }

  const manifestCases = [
    ['package missing', ['package'], s => unlinkSync(s.paths.package)],
    ['plugin missing', ['plugin'], s => unlinkSync(s.paths.plugin)],
    ['version 1.3.9', ['package', 'plugin'], s => {
      mutateJson(s.paths.package, v => { v.version = '1.3.9'; });
      mutateJson(s.paths.plugin, v => { v.version = '1.3.9'; });
    }],
    ['package name', ['package'], s => mutateJson(s.paths.package, v => { v.name = 'wrong'; })],
    ['plugin name', ['plugin'], s => mutateJson(s.paths.plugin, v => { v.name = 'wrong'; })],
    ['version mismatch', ['plugin'], s => mutateJson(s.paths.plugin, v => { v.version = '1.4.1'; })],
    ['package symlink', ['package'], s => symlinkFile(s, 'package')],
    ['plugin symlink', ['plugin'], s => symlinkFile(s, 'plugin')],
    ['validator symlink', ['validator'], s => symlinkFile(s, 'validator')],
    ['validator directory', ['validator'], s => { unlinkSync(s.paths.validator); mkdirSync(s.paths.validator); }],
  ];
  for (const [label, changed, mutate] of manifestCases) {
    const stub = routerStub();
    mutate(stub);
    assertOtherDimensions(stub, new Set(changed));
    const negative = emitStub(stub);
    const file = published(negative.fixture, negative.result);
    assert.equal(negative.result.validation?.state, 'unavailable', `${label}: ${JSON.stringify(negative.result)}`);
    assert.ok(['router-missing', 'validator-missing'].includes(negative.result.validation?.reason), label);
    assert.equal(spawns(stub).length, 0, label);
    assert.equal(existsSync(file.abs), true, label);
  }

  const spawnCases = [
    ['python unavailable', 'valid', s => join(s.fixtureRoot, 'missing-python3'), 'unavailable', 'python-unavailable', 0],
    ['python directory', 'valid', s => { const p = join(s.fixtureRoot, 'python-dir'); mkdirSync(p); return p; }, 'unavailable', 'spawn-error', 0],
    ['signal', 'signal', null, 'unavailable', 'signal', 1],
    ['invalid', 'invalid', null, 'invalid', 'invalid', 1],
    ['usage', 'usage', null, 'usage', 'usage', 1],
    ['timeout', 'timeout', null, 'unavailable', 'timeout', 1],
    ['max buffer', 'max-buffer', null, 'unavailable', 'max-buffer', 1],
  ];
  for (const [label, mode, pythonFor, state, reason, count] of spawnCases) {
    const stub = routerStub();
    const negative = emitStub(stub, { mode, ...(pythonFor ? { python: pythonFor(stub) } : {}) });
    const file = published(negative.fixture, negative.result);
    assert.equal(negative.result.validation?.state, state, `${label}: ${JSON.stringify(negative.result)}`);
    assert.equal(negative.result.validation?.reason, reason, label);
    if (label === 'invalid') assert.equal(negative.result.validation.detail, 'I-REFS');
    if (label === 'signal') assert.equal(Object.hasOwn(negative.result.validation, 'exit_status'), false);
    assert.equal(spawns(stub).length, count, label);
    assert.deepEqual(readFileSync(file.abs), file.bytes, label);
  }

  const full = maker('001-deep-work');
  const review = checker('002-deep-review', full.id);
  const abandoned = maker('003-deep-work', { status: 'abandoned' });
  const none = maker('004-deep-work', { routed: false });
  const fixture = runFixture([full, review, abandoned, none]);
  const reviewBytes = Buffer.from('{"review":"APPROVE"}\n');
  const reportHash = sha256(reviewBytes);
  mkdirSync(join(fixture.run, 'reviews'), { recursive: true });
  writeFileSync(join(fixture.run, 'reviews', `${reportHash}.json`), reviewBytes);
  const env = {
    ...process.env, DEEP_MODEL_ROUTER_CLI: actual.cli,
    DEEP_LOOP_ROUTE_OBSERVATION_VALIDATE: '1',
  };
  const rows = [
    [full, 'done', 'full', 'worker', 'succeeded', {}],
    [review, 'approved', 'full', 'reviewer', 'succeeded', {
      verdict: 'APPROVE', reviewSource: 'imported-stdin',
      eventData: { attempt_id: 'attempt-actual-01', report_sha256: reportHash, review_source: 'imported-stdin' },
    }],
    [abandoned, 'abandoned', 'full', 'worker', 'cancelled', {}],
    [none, 'done', 'none', 'worker', 'succeeded', {}],
  ];
  const files = [];
  for (const [index, [episode, terminal, linkage, seat, state, extra]] of rows.entries()) {
    const result = emitRouteObservation(fixture.root, RUN_ID, {
      loop: fixture.loop,
      event: { seq: index + 1, ts: NOW, data: { id: episode.id, status: terminal, ...(extra.eventData || {}) } },
      episodeId: episode.id, terminalStatus: terminal, verdict: extra.verdict,
      reviewSource: extra.reviewSource, env, home: emptyHome, kernelVersion: '1.22.0',
    });
    const file = published(fixture, result);
    assert.equal(result.validation?.state, 'valid', `${episode.id}: ${JSON.stringify(result)}`);
    const document = JSON.parse(file.bytes.toString('utf8'));
    assert.equal(document.payload.decision.linkage_quality, linkage);
    assert.equal(document.payload.attempts[0].seat, seat);
    assert.equal(document.payload.attempts[0].state, state);
    files.push({ ...file, document });
  }
  assert.equal(files.length, 4);
  assert.equal(readdirSync(join(fixture.run, 'observations')).filter(name => name.endsWith('.json')).length, 4);
  for (const file of files) {
    const check = spawnSync('python3', [
      actual.validator, '--file', file.abs, '--root', fixture.run, '--check-refs',
    ], { encoding: 'utf8' });
    assert.equal(check.error, undefined, check.error?.message);
    assert.equal(check.status, 0, check.stderr);
    assert.deepEqual(readFileSync(file.abs), file.bytes);
  }

  const forbidden = structuredClone(files[0].document);
  forbidden.goal = 'forbidden copy';
  const forbiddenPath = join(fixture.root, 'forbidden-goal-copy.json');
  writeFileSync(forbiddenPath, `${JSON.stringify(forbidden, null, 2)}\n`);
  const rejected = spawnSync('python3', [
    actual.validator, '--file', forbiddenPath, '--root', fixture.run, '--check-refs',
  ], { encoding: 'utf8' });
  assert.equal(rejected.error, undefined, rejected.error?.message);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /^I-NO-RAW-KEYS:/);
});
