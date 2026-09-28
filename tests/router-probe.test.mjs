import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { runDir } from '../scripts/lib/state.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { buildRoutingRecord } from '../scripts/lib/router-adapter.mjs';
import { probeRouterPin, readRouterVersion } from '../scripts/lib/router-probe.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deep-loop.mjs');

const POLICY_A = 'a'.repeat(64);

// Real install layout: <root>/skills/model-router/scripts/route_task.py beside
// <root>/package.json and <root>/.claude-plugin/plugin.json.
function installTree(root, {
  version = '1.16.1', name = 'deep-model-router', pluginVersion = version, pluginName = name,
  pkg, plugin,
} = {}) {
  const routeTask = join(root, 'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(routeTask), { recursive: true });
  writeFileSync(routeTask, '#!/usr/bin/env python3\n');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  if (pkg !== null) writeFileSync(join(root, 'package.json'), pkg ?? JSON.stringify({ name, version }));
  if (plugin !== null) {
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'),
      plugin ?? JSON.stringify({ name: pluginName, version: pluginVersion }));
  }
  return routeTask;
}

function tempHome(prefix = 'dl-probe-home-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function claudeCache(home, version) {
  return join(home, '.claude', 'plugins', 'cache', 'mkt', 'deep-model-router', version);
}

function codexCache(home, version) {
  return join(home, '.codex', 'plugins', 'cache', 'mkt', 'deep-model-router', version);
}

function frozenLoop(policy = POLICY_A) {
  return {
    episodes: [{
      id: 'ep-1',
      role: 'maker',
      status: 'in_progress',
      routing: buildRoutingRecord(
        { route_schema_version: 1, task_class: 'IMPLEMENTATION' },
        {
          route_schema_version: 1, router_plugin_version: '1.16.1', policy_sha256: policy,
          selected_model: 'claude-sonnet-5', selected_effort_native: 'high', effective_policy: {},
        },
      ),
    }],
  };
}

test('probe manifest: matching package and plugin manifests yield the version', () => {
  const home = tempHome();
  const routeTask = installTree(join(home, 'install'), { version: '1.16.1' });
  assert.equal(readRouterVersion(realpathSync(routeTask)), '1.16.1');
});

test('probe manifest: every malformed or disagreeing manifest yields no version', (t) => {
  const home = tempHome();
  const cases = {
    'name mismatch': { name: 'other-router' },
    'plugin name mismatch': { pluginName: 'other-router' },
    'version mismatch': { pluginVersion: '1.16.0' },
    'missing package.json': { pkg: null },
    'missing plugin.json': { plugin: null },
    'broken JSON': { pkg: '{' },
    'JSON array': { pkg: JSON.stringify(['deep-model-router', '1.16.1']) },
    'numeric version': { pkg: JSON.stringify({ name: 'deep-model-router', version: 1.16 }) },
    prerelease: { version: '1.16.0-rc.1' },
    build: { version: '1.16.0+x' },
    oversized: { pkg: JSON.stringify({ name: 'deep-model-router', version: '1.16.1', pad: 'x'.repeat(70_000) }) },
  };
  for (const [label, options] of Object.entries(cases)) {
    const routeTask = installTree(join(home, label.replaceAll(' ', '-')), options);
    assert.equal(readRouterVersion(realpathSync(routeTask)), null, label);
  }
  const linked = join(home, 'linked-manifest');
  const routeTask = installTree(linked, { pkg: null });
  writeFileSync(join(home, 'real-package.json'), JSON.stringify({ name: 'deep-model-router', version: '1.16.1' }));
  if (!createFileSymlinkOrSkip(t, join(home, 'real-package.json'), join(linked, 'package.json'))) return;
  assert.equal(readRouterVersion(realpathSync(routeTask)), null, 'symlinked manifest');
  assert.equal(readRouterVersion(null), null);
  assert.equal(readRouterVersion(''), null);
});

test('probe: a cache route_task.py symlink resolves to its target install and version', (t) => {
  const home = tempHome();
  const target = installTree(join(home, 'other', '1.15.0'), { version: '1.15.0' });
  const cacheRoot = claudeCache(home, '1.16.1');
  installTree(cacheRoot, { version: '1.16.1' });
  const cacheTask = join(cacheRoot, 'skills', 'model-router', 'scripts', 'route_task.py');
  rmSync(cacheTask);
  if (!createFileSymlinkOrSkip(t, target, cacheTask)) return;
  const probe = probeRouterPin({ loopData: frozenLoop(), env: {}, home, cwd: home });
  assert.equal(probe.ok, true);
  assert.equal(probe.route_task, realpathSync(target));
  assert.equal(probe.router_version, '1.15.0');
  assert.equal(probe.policy_pin, null);
  assert.deepEqual(probe.reasons, ['router-pin-unsupported']);
});

test('probe: a cache symlink into a personal skill tree is rejected', (t) => {
  const home = tempHome();
  const personal = join(home, '.claude', 'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(personal), { recursive: true });
  writeFileSync(personal, '# personal\n');
  const cacheRoot = claudeCache(home, '1.16.1');
  installTree(cacheRoot, { version: '1.16.1' });
  const cacheTask = join(cacheRoot, 'skills', 'model-router', 'scripts', 'route_task.py');
  rmSync(cacheTask);
  if (!createFileSymlinkOrSkip(t, personal, cacheTask)) return;
  const probe = probeRouterPin({ loopData: frozenLoop(), env: {}, home, cwd: home });
  assert.equal(probe.route_task, null);
  assert.deepEqual(probe.reasons, ['router-path-rejected']);
});

test('probe: an injected locator result that is missing, a directory or misnamed is rejected', () => {
  const home = tempHome();
  const dir = join(home, 'dir', 'route_task.py');
  mkdirSync(dir, { recursive: true });
  const misnamed = join(home, 'route.py');
  writeFileSync(misnamed, '#!/usr/bin/env python3\n');
  for (const located of [join(home, 'absent', 'route_task.py'), dir, misnamed]) {
    const probe = probeRouterPin({ loopData: frozenLoop(), env: {}, home, cwd: home, locate: () => located });
    assert.equal(probe.route_task, null, located);
    assert.deepEqual(probe.reasons, ['router-path-rejected'], located);
  }
  const none = probeRouterPin({ loopData: frozenLoop(), env: {}, home, cwd: home, locate: () => null });
  assert.deepEqual(none.reasons, ['router-missing']);
});

test('probe: an explicit CLI outside the plugin cache pins when its manifests say 1.16.x', () => {
  const home = tempHome();
  const outside = installTree(join(home, 'checkout', 'deep-model-router-install'), { version: '1.16.1' });
  const probe = probeRouterPin({
    loopData: frozenLoop(), env: { DEEP_MODEL_ROUTER_CLI: outside }, home, cwd: home,
  });
  assert.equal(probe.route_task, realpathSync(outside));
  assert.equal(probe.router_version, '1.16.1');
  assert.equal(probe.policy_pin, POLICY_A);
  assert.deepEqual(probe.reasons, []);
});

test('probe: selection follows the locator order (CLI, ROOT, Claude cache, Codex cache)', () => {
  const home = tempHome();
  const cli = installTree(join(home, 'explicit'), { version: '1.16.0' });
  const lowCache = claudeCache(home, '1.15.0');
  installTree(lowCache, { version: '1.15.0' });
  const highClaude = installTree(claudeCache(home, '1.16.2'), { version: '1.16.2' });
  installTree(codexCache(home, '1.17.0'), { version: '1.17.0' });
  const pick = (env) => probeRouterPin({ loopData: frozenLoop(), env, home, cwd: home });
  assert.equal(pick({ DEEP_MODEL_ROUTER_CLI: cli, DEEP_MODEL_ROUTER_ROOT: lowCache }).route_task, realpathSync(cli),
    'an explicit CLI outranks ROOT and the caches');
  assert.equal(pick({ DEEP_MODEL_ROUTER_ROOT: lowCache }).router_version, '1.15.0',
    'ROOT outranks the highest cache hit');
  const cacheOnly = pick({});
  assert.equal(cacheOnly.route_task, realpathSync(highClaude),
    'the highest Claude cache hit outranks lower hits and the Codex cache');
  const codexHome = tempHome();
  installTree(codexCache(codexHome, '1.15.0'), { version: '1.15.0' });
  const codexHigh = installTree(codexCache(codexHome, '1.16.1'), { version: '1.16.1' });
  const codexOnly = probeRouterPin({ loopData: frozenLoop(), env: {}, home: codexHome, cwd: codexHome });
  assert.equal(codexOnly.route_task, realpathSync(codexHigh), 'Codex cache is the last fallback, highest first');
  assert.equal(codexOnly.policy_pin, POLICY_A);
});

test('probe: an empty environment and caches report router-missing without a pin', () => {
  const home = tempHome();
  const probe = probeRouterPin({ loopData: { episodes: [] }, env: {}, home, cwd: home });
  assert.deepEqual(probe, {
    ok: true,
    route_task: null,
    router_version: null,
    policy_pin_supported: false,
    frozen_policy_sha256: null,
    policy_pin: null,
    reasons: ['router-missing', 'no-frozen-digest'],
  });
});

// ── CLI: router probe --json ───────────────────────────────────────────────

function isolatedEnv(home, overrides = {}) {
  const env = { ...process.env };
  delete env.DEEP_MODEL_ROUTER_CLI;
  delete env.DEEP_MODEL_ROUTER_ROOT;
  return { ...env, HOME: home, USERPROFILE: home, ...overrides };
}

function probeCli(args, { home, env = {} }) {
  return spawnSync(process.execPath, [CLI, 'router', ...args], {
    encoding: 'utf8', cwd: home, env: isolatedEnv(home, env),
  });
}

// Fixed clock and no terminal probing: the seed never reads the real time or env.
const SEED_NOW = Date.parse('2026-08-16T00:00:00Z');

function seedRun() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-probe-run-')));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', now: new Date(SEED_NOW), env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  return { root, runId, fence: { owner: runId, generation: 1, intent: 'business' } };
}

function recordRoutedMaker({ root, runId, fence }, policy = POLICY_A) {
  const ws = newWorkstream(root, runId, {
    title: 'impl', branch: 'impl', worktree: '.claude/worktrees/impl', fence, now: SEED_NOW,
  }).id;
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: ['art.txt'], fence, now: SEED_NOW,
  });
  recordEpisode(root, runId, id, {
    status: 'in_progress',
    routing: frozenLoop(policy).episodes[0].routing,
    fence,
    now: SEED_NOW,
  });
  return id;
}

function durableBytes(root, runId) {
  const dir = runDir(root, runId);
  return ['loop.json', 'event-log.jsonl', '.loop.hash'].map((name) => readFileSync(join(dir, name)));
}

test('router probe CLI: no pin before the first routed episode, the frozen digest after it', () => {
  const home = tempHome();
  const cli = installTree(join(home, 'router'), { version: '1.16.1' });
  const seeded = seedRun();
  const locator = ['--project-root', seeded.root, '--run-id', seeded.runId];
  const before = probeCli(['probe', '--json', ...locator], { home, env: { DEEP_MODEL_ROUTER_CLI: cli } });
  assert.equal(before.status, 0, before.stderr);
  const first = JSON.parse(before.stdout);
  assert.equal(first.policy_pin, null);
  assert.equal(first.route_task, realpathSync(cli));
  assert.deepEqual(first.reasons, ['no-frozen-digest']);

  recordRoutedMaker(seeded);
  const bytes = durableBytes(seeded.root, seeded.runId);
  const runs = [1, 2].map(() => probeCli(['probe', '--json', ...locator], { home, env: { DEEP_MODEL_ROUTER_CLI: cli } }));
  for (const run of runs) {
    assert.equal(run.status, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.frozen_policy_sha256, POLICY_A);
    assert.equal(payload.policy_pin, POLICY_A);
    assert.equal(payload.router_version, '1.16.1');
  }
  assert.equal(runs[0].stdout, runs[1].stdout, 'two fresh processes read the same pin');
  assert.deepEqual(durableBytes(seeded.root, seeded.runId), bytes, 'router probe never writes durable state');
});

test('router probe CLI: selects the highest Claude cache install when no override is set', () => {
  const home = tempHome();
  installTree(claudeCache(home, '1.15.0'), { version: '1.15.0' });
  const high = installTree(claudeCache(home, '1.16.1'), { version: '1.16.1' });
  const seeded = seedRun();
  recordRoutedMaker(seeded);
  const result = probeCli(['probe', '--json', '--project-root', seeded.root, '--run-id', seeded.runId], { home });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.route_task, realpathSync(high));
  assert.equal(payload.policy_pin, POLICY_A);
});

test('router probe CLI: usage errors are exit 2 and a damaged run is exit 1', () => {
  const home = tempHome();
  const seeded = seedRun();
  const locator = ['--project-root', seeded.root, '--run-id', seeded.runId];
  assert.equal(probeCli(['probe', ...locator], { home }).status, 2, 'missing --json');
  assert.equal(probeCli(['probe', '--json', '--project-root', seeded.root], { home }).status, 2, 'missing --run-id');
  assert.equal(probeCli([], { home }).status, 2, 'bare router');
  assert.equal(probeCli(['bogus', '--json', ...locator], { home }).status, 2, 'unknown verb');
  const loopPath = join(runDir(seeded.root, seeded.runId), 'loop.json');
  const loop = readFileSync(loopPath, 'utf8');
  writeFileSync(loopPath, loop.replace('"goal": "g"', '"goal": "h"').replace('"goal":"g"', '"goal":"h"'));
  assert.notEqual(readFileSync(loopPath, 'utf8'), loop, 'fixture must actually damage loop.json');
  const damaged = probeCli(['probe', '--json', ...locator], { home });
  assert.equal(damaged.status, 1, damaged.stdout + damaged.stderr);
});

test('probe: an injected relative locator result resolves against the supplied cwd', () => {
  const home = tempHome();
  const cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  const routeTask = installTree(join(home, 'project', 'router'), { version: '1.16.1' });
  const probe = probeRouterPin({
    loopData: frozenLoop(), env: {}, home, cwd,
    locate: () => join('router', 'skills', 'model-router', 'scripts', 'route_task.py'),
  });
  assert.equal(probe.route_task, realpathSync(routeTask));
  assert.equal(probe.policy_pin, POLICY_A);
});

test('router probe CLI: a valueless --project-root is a usage error', () => {
  const home = tempHome();
  const seeded = seedRun();
  const result = probeCli(['probe', '--json', '--project-root', '--run-id', seeded.runId], { home });
  assert.equal(result.status, 2, result.stdout + result.stderr);
});

test('probe: an injected relative ../deep-model-router result is rejected before resolution', () => {
  const base = tempHome();
  const cwd = join(base, 'project');
  mkdirSync(cwd, { recursive: true });
  installTree(join(base, 'deep-model-router'), { version: '1.16.1' });
  const probe = probeRouterPin({
    loopData: frozenLoop(), env: {}, home: base, cwd,
    locate: () => '../deep-model-router/skills/model-router/scripts/route_task.py',
  });
  assert.equal(probe.route_task, null);
  assert.deepEqual(probe.reasons, ['router-path-rejected']);
});
