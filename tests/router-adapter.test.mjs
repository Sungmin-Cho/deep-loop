import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';
import { canonicalRouteTask, isForbiddenRelativeCheckout, locateDeepModelRouter } from '../scripts/lib/locate-deep-model-router.mjs';
import {
  attachRoutingToDescriptor,
  assertRoutingDigest,
  buildRoutingRecord,
  isRoutingRecord,
  mayRecordInProgress,
  POLICY_PIN_REASONS,
  routerPinContext,
  shouldAttachRouting,
  supportsPolicyPin,
  translateRouteOutcome,
} from '../scripts/lib/router-adapter.mjs';

function existingRouterCli() {
  const sibling = '/Users/sungmin/Dev/claude-plugins/deep-model-router/skills/model-router/scripts/route_task.py';
  for (const candidate of [process.env.DEEP_MODEL_ROUTER_CLI, sibling]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function writeSourceCheckoutCli(home) {
  const cli = join(home, 'claude-plugins', 'deep-model-router', 'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, '#!/usr/bin/env python3\n');
  chmodSync(cli, 0o755);
  return cli;
}

const POLICY_A = 'a'.repeat(64);
const POLICY_B = 'b'.repeat(64);

function decision(overrides = {}) {
  return {
    route_schema_version: 1,
    router_plugin_version: '1.0.0',
    policy_sha256: POLICY_A,
    effective_policy: {
      minimum_capability_tier: null,
      minimum_effort: null,
      minimum_reviewers: null,
      minimum_provider_families: null,
      allowed_families: null,
    },
    selected_model: 'claude-sonnet-5',
    selected_effort_native: 'high',
    risk_band: 'MEDIUM',
    terminal: null,
    ...overrides,
  };
}

function outcome(partial) {
  return translateRouteOutcome(partial);
}

test('locator: DEEP_MODEL_ROUTER_CLI hits an injected route_task.py including a source checkout', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-loc-home-'));
  const cli = writeSourceCheckoutCli(home);
  const found = locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: cli },
    home,
  });
  assert.equal(found, realpathSync(cli));
});

test('locator: DEEP_MODEL_ROUTER_ROOT accepts only an installed/cache plugin root', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-loc-home-'));
  const root = join(home, '.claude', 'plugins', 'cache', 'mkt', 'deep-model-router', '1.2.0');
  const cli = join(root, 'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, '#!/usr/bin/env python3\n');
  const found = locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_ROOT: root },
    home,
  });
  assert.equal(found, realpathSync(cli));
});

test('locator: DEEP_MODEL_ROUTER_ROOT rejects source checkout, relative sibling, and personal tree', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dl-loc-root-bad-'));
  const sourceRoot = join(home, 'claude-plugins', 'deep-model-router');
  const sourceCli = join(sourceRoot, 'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(sourceCli), { recursive: true });
  writeFileSync(sourceCli, '#!/usr/bin/env python3\n');
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_ROOT: sourceRoot },
    home,
  }), null);
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_ROOT: '../deep-model-router' },
    home,
    cwd: home,
  }), null);
  const personal = join(home, '.claude', 'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(personal), { recursive: true });
  writeFileSync(personal, '# personal\n');
  const aliasRoot = join(home, 'alias-root');
  mkdirSync(join(aliasRoot, 'skills', 'model-router', 'scripts'), { recursive: true });
  if (!createFileSymlinkOrSkip(t, personal, join(aliasRoot, 'skills', 'model-router', 'scripts', 'route_task.py'))) {
    return;
  }
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_ROOT: aliasRoot },
    home,
  }), null);
});

test('locator: missing env and empty caches return null', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-loc-miss-'));
  assert.equal(locateDeepModelRouter({ env: {}, home }), null);
});

test('locator: personal ~/.claude/skills/model-router symlink is rejected', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-loc-skill-'));
  const personal = join(home, '.claude', 'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(personal), { recursive: true });
  writeFileSync(personal, '# personal\n');
  chmodSync(personal, 0o755);
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: personal },
    home,
  }), null);
});

test('locator: rejects a ../deep-model-router relative checkout path', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-loc-rel-'));
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: '../deep-model-router/skills/model-router/scripts/route_task.py' },
    home,
    cwd: home,
  }), null);
});

test('locator: Claude cache prefers the highest semver and ignores a personal skill tree', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-loc-cache-'));
  const low = join(home, '.claude', 'plugins', 'cache', 'suite', 'deep-model-router', '1.0.0',
    'skills', 'model-router', 'scripts', 'route_task.py');
  const high = join(home, '.claude', 'plugins', 'cache', 'suite', 'deep-model-router', '1.2.0',
    'skills', 'model-router', 'scripts', 'route_task.py');
  const personal = join(home, '.claude', 'skills', 'model-router', 'scripts', 'route_task.py');
  for (const p of [low, high, personal]) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '# cache\n');
  }
  const found = locateDeepModelRouter({ env: {}, home });
  assert.equal(found, resolve(high));
});

test('locator: Codex cache is used only when Claude cache has no route_task.py', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-loc-codex-'));
  const codex = join(home, '.codex', 'plugins', 'deep-model-router', '1.1.0',
    'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(codex), { recursive: true });
  writeFileSync(codex, '# codex\n');
  assert.equal(locateDeepModelRouter({ env: {}, home }), resolve(codex));
});

const EXIT_CASES = [
  { exit: 0, status: 'ok', dispatch_authorized: true, provenance: 'router', degrade_forbidden: false },
  { exit: 1, status: 'terminal', dispatch_authorized: false, provenance: 'local-fallback', degrade_forbidden: false },
  { exit: 2, status: 'invalid', dispatch_authorized: false, provenance: 'local-fallback', degrade_forbidden: false },
  { exit: 3, status: 'human_gate', dispatch_authorized: false, provenance: 'router', degrade_forbidden: true },
  { exit: 4, status: 'deferred_confirm', dispatch_authorized: true, provenance: 'router', degrade_forbidden: true },
  { exit: 5, status: 'internal', dispatch_authorized: false, provenance: 'local-fallback', degrade_forbidden: false },
];

for (const row of EXIT_CASES) {
  test(`adapter: exit ${row.exit} → status=${row.status} authorized=${row.dispatch_authorized}`, () => {
    const translated = outcome({
      exit: row.exit,
      stdout: JSON.stringify(decision({ risk_band: 'MEDIUM' })),
      stderr: '',
    });
    assert.equal(translated.status, row.status);
    assert.equal(translated.dispatch_authorized, row.dispatch_authorized);
    assert.equal(translated.routing_provenance, row.provenance);
    assert.equal(translated.degrade_forbidden, row.degrade_forbidden);
    assert.equal(translated.write_retry_forbidden, false);
    assert.equal(translated.risk_band, 'MEDIUM');
    assert.equal(translated.decision.selected_model, 'claude-sonnet-5');
  });
}

test('adapter: missing CLI / python3 / non-JSON / unsupported schema / digest mismatch / signal map to the exit-2 consumer path', () => {
  const cases = [
    outcome({ exit: 0, stdout: '', stderr: '', cliPath: false, python3Available: true }),
    outcome({ exit: 0, stdout: '', stderr: '', cliPath: '/tmp/route_task.py', python3Available: false }),
    outcome({ exit: 0, stdout: 'not-json', stderr: '' }),
    outcome({ exit: 0, stdout: JSON.stringify(decision({ route_schema_version: 2 })), stderr: '' }),
    outcome({
      exit: 0,
      stdout: JSON.stringify(decision({ policy_sha256: POLICY_B })),
      stderr: '',
      frozenDigest: POLICY_A,
    }),
    outcome({ exit: 0, stdout: JSON.stringify(decision()), stderr: '', processState: 'signaled' }),
  ];
  for (const translated of cases) {
    assert.equal(translated.dispatch_authorized, false, translated.degrade_reason);
    assert.ok(['invalid', 'unavailable', 'internal'].includes(translated.status), translated.status);
    assert.equal(translated.routing_provenance, 'local-fallback');
  }
});

test('adapter: spawn failure, permission, timeout, empty/truncated stdout, out-of-range exit are unauthorized', () => {
  const cases = [
    outcome({ processState: 'spawn_failed', stdout: '', stderr: 'ENOENT' }),
    outcome({ processState: 'permission_denied', stdout: '', stderr: 'EACCES' }),
    outcome({ processState: 'timeout', stdout: '', stderr: '' }),
    outcome({ exit: 0, stdout: '', stderr: '' }),
    outcome({ exit: 0, stdout: '{"route_schema_version":1,', stderr: '' }),
    outcome({ exit: 7, stdout: JSON.stringify(decision()), stderr: '' }),
    outcome({ exit: -1, stdout: JSON.stringify(decision()), stderr: '' }),
  ];
  for (const translated of cases) {
    assert.equal(translated.dispatch_authorized, false, translated.degrade_reason || translated.status);
    assert.ok(['unavailable', 'internal', 'invalid'].includes(translated.status), translated.status);
  }
});

test('adapter: TERMINATION_UNCONFIRMED sets the write-retry fence', () => {
  const fromState = outcome({
    processState: 'TERMINATION_UNCONFIRMED',
    stdout: JSON.stringify(decision()),
    stderr: '',
  });
  const fromStderr = outcome({
    exit: 0,
    stdout: JSON.stringify(decision()),
    stderr: 'dispatch_agent: TERMINATION_UNCONFIRMED after kill ladder',
  });
  for (const translated of [fromState, fromStderr]) {
    assert.equal(translated.dispatch_authorized, false);
    assert.equal(translated.write_retry_forbidden, true);
    assert.equal(translated.status, 'internal');
    assert.equal(mayRecordInProgress(translated), false);
  }
});

test('adapter: digest freeze accepts the first digest and rejects a later mismatch', () => {
  const first = outcome({ exit: 0, stdout: JSON.stringify(decision({ policy_sha256: POLICY_A })) });
  assert.equal(first.dispatch_authorized, true);
  const frozen = first.decision.policy_sha256;
  const same = outcome({
    exit: 0,
    stdout: JSON.stringify(decision({ policy_sha256: POLICY_A })),
    frozenDigest: frozen,
  });
  assert.equal(same.dispatch_authorized, true);
  const mismatch = outcome({
    exit: 0,
    stdout: JSON.stringify(decision({ policy_sha256: POLICY_B })),
    frozenDigest: frozen,
  });
  assert.equal(mismatch.dispatch_authorized, false);
  assert.equal(mismatch.status, 'invalid');
  assert.equal(mismatch.degrade_reason, 'digest-mismatch');
});

test('adapter: HIGH/CRITICAL failures must not advance in_progress; LOW/MEDIUM may degrade', () => {
  const highFail = outcome({
    exit: 1,
    stdout: JSON.stringify(decision({ risk_band: 'HIGH', terminal: 'HUMAN_REQUIRED', selected_model: null })),
  });
  const criticalFail = outcome({
    exit: 5,
    stdout: JSON.stringify(decision({ risk_band: 'CRITICAL' })),
  });
  const lowFail = outcome({
    exit: 1,
    stdout: JSON.stringify(decision({ risk_band: 'LOW', terminal: 'SUPPLY_EXHAUSTED', selected_model: null })),
  });
  const mediumMissing = outcome({
    exit: null,
    stdout: '',
    stderr: '',
    cliPath: false,
    localBand: 'MEDIUM',
  });
  assert.equal(mayRecordInProgress(highFail), false);
  assert.equal(mayRecordInProgress(criticalFail), false);
  assert.equal(shouldAttachRouting(highFail), false);
  assert.equal(mayRecordInProgress(lowFail), true);
  assert.equal(shouldAttachRouting(lowFail), false);
  assert.equal(mayRecordInProgress(mediumMissing), true);
  assert.equal(shouldAttachRouting(mediumMissing), false);
  const gate = outcome({ exit: 3, stdout: JSON.stringify(decision({ risk_band: 'LOW' })) });
  assert.equal(mayRecordInProgress(gate), false);
  assert.equal(gate.degrade_forbidden, true);
});

test('adapter: exit 3/4 with empty or non-JSON stdout never degrade', () => {
  for (const exit of [3, 4]) {
    for (const stdout of ['', 'not-json', '{"route_schema_version":1,']) {
      const translated = outcome({ exit, stdout, stderr: '', localBand: 'LOW' });
      assert.equal(translated.degrade_forbidden, true, `${exit}:${stdout}`);
      assert.equal(translated.dispatch_authorized, false);
      assert.equal(mayRecordInProgress(translated), false);
      assert.ok(translated.status === 'human_gate' || translated.status === 'deferred_confirm', translated.status);
    }
  }
});

test('adapter: only explicit LOW/MEDIUM may degrade; null/unknown/lowercase HIGH block', () => {
  assert.equal(mayRecordInProgress(outcome({
    exit: 1, stdout: JSON.stringify(decision({ risk_band: null })),
  })), false);
  assert.equal(mayRecordInProgress(outcome({
    exit: 1, stdout: JSON.stringify(decision({ risk_band: 'UNKNOWN' })),
  })), false);
  assert.equal(mayRecordInProgress(outcome({
    exit: 1, stdout: JSON.stringify(decision({ risk_band: 'high' })),
  })), false);
  assert.equal(mayRecordInProgress(outcome({
    exit: 1, stdout: '', stderr: '', cliPath: false,
  })), false);
  assert.equal(mayRecordInProgress(outcome({
    exit: 1, stdout: JSON.stringify(decision({ risk_band: 'low' })),
  })), true);
});

test('attachRoutingToDescriptor threads selected model/effort onto a spawn descriptor', () => {
  const routing = buildRoutingRecord(
    { route_schema_version: 1, task_class: 'REVIEW' },
    decision(),
  );
  const attached = attachRoutingToDescriptor({ kind: 'skill', skill: 'deep-review:deep-review-loop' }, routing);
  assert.equal(attached.selected_model, 'claude-sonnet-5');
  assert.equal(attached.selected_effort_native, 'high');
  assert.equal(attached.routing_provenance, 'router');
});

test('adapter: buildRoutingRecord optionally preserves valid router fingerprints', () => {
  const record = buildRoutingRecord(
    { route_schema_version: 1, task_class: 'REVIEW' },
    decision({
      decision_fingerprint: 'a'.repeat(64),
      request_sha256: 'b'.repeat(64),
    }),
  );
  assert.equal(record.decision.decision_fingerprint, 'a'.repeat(64));
  assert.equal(record.decision.request_sha256, 'b'.repeat(64));
});

test('adapter: invalid or absent router fingerprints are omitted, never normalized to null', () => {
  const absent = buildRoutingRecord(
    { route_schema_version: 1, task_class: 'REVIEW' },
    decision(),
  );
  assert.equal(Object.hasOwn(absent.decision, 'decision_fingerprint'), false);
  assert.equal(Object.hasOwn(absent.decision, 'request_sha256'), false);

  const invalid = buildRoutingRecord(
    { route_schema_version: 1, task_class: 'REVIEW' },
    decision({ decision_fingerprint: 'zz', request_sha256: 123 }),
  );
  assert.equal(Object.hasOwn(invalid.decision, 'decision_fingerprint'), false);
  assert.equal(Object.hasOwn(invalid.decision, 'request_sha256'), false);
});

test('adapter: legacy routing identity and policy digest remain unchanged by optional fingerprints', () => {
  const legacy = buildRoutingRecord(
    { route_schema_version: 1, task_class: 'REVIEW' },
    decision(),
  );
  assert.equal(isRoutingRecord(legacy), true);
  assert.equal(isRoutingRecord({
    ...legacy,
    decision: { ...legacy.decision, decision_fingerprint: 'z'.repeat(64) },
  }), true);
  assert.doesNotThrow(
    () => assertRoutingDigest({ episodes: [{ routing: legacy }] }, {
      ...legacy,
      decision: { ...legacy.decision, decision_fingerprint: 'z'.repeat(64) },
    }),
  );
});

test('adapter: live DEEP_MODEL_ROUTER_CLI LOW route is dispatchable and freezes identity fields', (t) => {
  const routerCli = existingRouterCli();
  if (!routerCli) {
    t.skip('local deep-model-router checkout is not present');
    return;
  }
  const cli = locateDeepModelRouter({
    env: { ...process.env, DEEP_MODEL_ROUTER_CLI: routerCli },
    home: mkdtempSync(join(tmpdir(), 'dl-live-home-')),
  });
  assert.equal(cli, realpathSync(routerCli));
  const dir = mkdtempSync(join(tmpdir(), 'dl-live-req-'));
  const request = {
    route_schema_version: 1,
    task_class: 'IMPLEMENTATION',
    complexity: 1,
    uncertainty: 1,
    blast_radius: 0,
    reversibility: 0,
    reasoning_centric: false,
    flags: [],
    runtime: 'claude_code',
  };
  const reqPath = join(dir, 'req.json');
  writeFileSync(reqPath, JSON.stringify(request));
  const spawned = spawnSync(process.env.PYTHON || 'python3', [cli, '--request-json', reqPath, '--format', 'json'], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, DEEP_MODEL_ROUTER_CLI: routerCli },
  });
  const translated = translateRouteOutcome({
    exit: spawned.status,
    stdout: spawned.stdout,
    stderr: spawned.stderr,
  });
  assert.equal(translated.dispatch_authorized, true, spawned.stderr);
  assert.equal(translated.status, 'ok');
  assert.equal(translated.decision.route_schema_version, 1);
  assert.match(translated.decision.router_plugin_version, /^\d+\.\d+\.\d+/);
  assert.match(translated.decision.policy_sha256, /^[0-9a-f]{64}$/);
  const frozen = buildRoutingRecord(request, translated.decision);
  assert.deepEqual(Object.keys(frozen).sort(), [
    'decision', 'effective_policy', 'provenance', 'request',
    'selected_effort_native', 'selected_model',
  ].sort());
  assert.equal(frozen.provenance, 'router');
  assert.equal(frozen.selected_model, translated.decision.selected_model);
  assert.equal(frozen.decision.policy_sha256, translated.decision.policy_sha256);
  assert.match(frozen.decision.decision_fingerprint, /^[0-9a-f]{64}$/);
  assert.match(frozen.decision.request_sha256, /^[0-9a-f]{64}$/);
});

function pinnedLoop(...episodes) {
  return { episodes };
}

function routedEpisode(policy, extra = {}) {
  return {
    id: extra.id || `ep-${policy.slice(0, 4)}`,
    role: 'maker',
    status: 'in_progress',
    workstream_id: 'ws-1',
    routing: buildRoutingRecord(
      { route_schema_version: 1, task_class: 'IMPLEMENTATION' },
      decision({ policy_sha256: policy }),
    ),
    ...extra,
  };
}

test('pin: a run without a frozen digest sends no pin', () => {
  const ctx = routerPinContext({ loop: pinnedLoop(), routeTask: '/r/route_task.py', routerVersion: '1.16.1' });
  assert.equal(ctx.policy_pin, null);
  assert.equal(ctx.frozen_policy_sha256, null);
  assert.equal(ctx.policy_pin_supported, true);
  assert.deepEqual(ctx.reasons, ['no-frozen-digest']);
});

test('pin: a supported router receives the frozen digest as policy_pin', () => {
  for (const version of ['1.16.0', '1.16.1', '2.0.0']) {
    const ctx = routerPinContext({
      loop: pinnedLoop(routedEpisode(POLICY_A)), routeTask: '/r/route_task.py', routerVersion: version,
    });
    assert.equal(ctx.policy_pin, POLICY_A, version);
    assert.equal(ctx.frozen_policy_sha256, POLICY_A);
    assert.equal(ctx.router_version, version);
    assert.deepEqual(ctx.reasons, []);
  }
});

test('pin: a router older than 1.16.0 receives no pin', () => {
  const ctx = routerPinContext({
    loop: pinnedLoop(routedEpisode(POLICY_A)), routeTask: '/r/route_task.py', routerVersion: '1.15.0',
  });
  assert.equal(ctx.policy_pin, null);
  assert.equal(ctx.policy_pin_supported, false);
  assert.equal(ctx.frozen_policy_sha256, POLICY_A);
  assert.deepEqual(ctx.reasons, ['router-pin-unsupported']);
});

test('pin: missing, rejected or unidentified routers send no pin, with ordered reasons', () => {
  const frozen = pinnedLoop(routedEpisode(POLICY_A));
  assert.deepEqual(routerPinContext({ loop: frozen, routeTask: '/r/route_task.py', routerVersion: null }).reasons,
    ['router-version-unknown']);
  assert.deepEqual(routerPinContext({ loop: frozen, routeTask: null, routerVersion: '1.16.1' }).reasons,
    ['router-missing']);
  assert.deepEqual(routerPinContext({
    loop: frozen, routeTask: null, routerReason: 'router-path-rejected',
  }).reasons, ['router-path-rejected']);
  assert.deepEqual(routerPinContext({ loop: pinnedLoop(), routeTask: null }).reasons,
    ['router-missing', 'no-frozen-digest']);
  for (const version of ['1.16.0-rc.1', '1.16.0+b', 'v1.16.0', '1.16', 1.16]) {
    const ctx = routerPinContext({ loop: frozen, routeTask: '/r/route_task.py', routerVersion: version });
    assert.equal(ctx.router_version, null, String(version));
    assert.equal(ctx.policy_pin, null, String(version));
    assert.deepEqual(ctx.reasons, ['router-version-unknown'], String(version));
  }
});

test('pin: the frozen digest is run-wide, including abandoned and other-workstream episodes', () => {
  const abandoned = routedEpisode(POLICY_A, { id: 'ep-1', status: 'abandoned' });
  const otherWs = routedEpisode(POLICY_A, { id: 'ep-1', workstream_id: 'ws-other' });
  for (const first of [abandoned, otherWs]) {
    const ctx = routerPinContext({
      loop: pinnedLoop(first, routedEpisode(POLICY_B, { id: 'ep-2' })),
      routeTask: '/r/route_task.py', routerVersion: '1.16.1',
    });
    assert.equal(ctx.frozen_policy_sha256, POLICY_A);
    assert.equal(ctx.policy_pin, POLICY_A);
  }
});

test('pin: supportsPolicyPin compares strict semver against 1.16.0', () => {
  assert.equal(supportsPolicyPin('1.16.0'), true);
  assert.equal(supportsPolicyPin('1.17.0'), true);
  assert.equal(supportsPolicyPin('2.0.0'), true);
  assert.equal(supportsPolicyPin('1.15.9'), false);
  assert.equal(supportsPolicyPin('0.99.99'), false);
  assert.equal(supportsPolicyPin('1.16.0-rc.1'), false);
  assert.equal(supportsPolicyPin(null), false);
});

test('pin: POLICY_PIN_REASONS is the frozen router pin_* vocabulary', () => {
  assert.ok(Object.isFrozen(POLICY_PIN_REASONS));
  assert.deepEqual([...POLICY_PIN_REASONS].sort(), [
    'pin_base_changed', 'pin_generation_missing', 'pin_revoked', 'pin_suppressed_by_off',
  ]);
});

function pinTerminal(stateReason, overrides = {}) {
  return JSON.stringify({
    route_schema_version: 1,
    router_plugin_version: '1.16.1',
    policy_sha256: null,
    request_sha256: null,
    decision_fingerprint: null,
    terminal: 'MODEL_STATE_UNAVAILABLE',
    risk_band: null,
    selected_model: null,
    selected_effort_native: null,
    effective_policy: null,
    model_overlay: { status: 'unavailable', state_reason: stateReason },
    ...overrides,
  });
}

test('pin outcome: each pin_* terminal is named and keeps the band rule', () => {
  for (const reason of POLICY_PIN_REASONS) {
    for (const [band, mayRecord] of [['LOW', true], ['MEDIUM', true], ['HIGH', false], ['CRITICAL', false], [null, false]]) {
      const translated = outcome({ exit: 1, stdout: pinTerminal(reason), stderr: '', frozenDigest: POLICY_A, localBand: band });
      assert.equal(translated.status, 'terminal', reason);
      assert.equal(translated.degrade_reason, 'policy-pin-unavailable', reason);
      assert.equal(translated.policy_pin_reason, reason);
      assert.equal(translated.dispatch_authorized, false);
      assert.equal(translated.routing_provenance, 'local-fallback');
      assert.equal(mayRecordInProgress(translated), mayRecord, `${reason}/${band}`);
    }
  }
});

test('pin outcome: pinned and noop routes with the frozen digest dispatch; a different digest is still refused', () => {
  for (const status of ['pinned', 'noop']) {
    const translated = outcome({
      exit: 0,
      stdout: JSON.stringify(decision({ model_overlay: { status, state_reason: null } })),
      stderr: '',
      frozenDigest: POLICY_A,
    });
    assert.equal(translated.status, 'ok', status);
    assert.equal(translated.dispatch_authorized, true);
    assert.equal(translated.policy_pin_reason, null);
  }
  const drifted = outcome({
    exit: 0,
    stdout: JSON.stringify(decision({ policy_sha256: POLICY_B, model_overlay: { status: 'pinned', state_reason: null } })),
    stderr: '',
    frozenDigest: POLICY_A,
  });
  assert.equal(drifted.degrade_reason, 'digest-mismatch');
  assert.equal(drifted.dispatch_authorized, false);
});

test('pin outcome: unknown reasons, other terminals and other exits keep their existing branch', () => {
  const unknown = outcome({ exit: 1, stdout: pinTerminal('pin_future'), stderr: '', localBand: 'LOW' });
  assert.equal(unknown.degrade_reason, 'terminal');
  assert.equal(unknown.policy_pin_reason, null);
  const otherTerminal = outcome({
    exit: 1, stdout: pinTerminal('pin_base_changed', { terminal: 'HUMAN_REQUIRED' }), stderr: '', localBand: 'LOW',
  });
  assert.equal(otherTerminal.degrade_reason, 'terminal');
  assert.equal(otherTerminal.policy_pin_reason, null);
  const invalid = outcome({ exit: 2, stdout: pinTerminal('pin_base_changed'), stderr: '', localBand: 'LOW' });
  assert.equal(invalid.degrade_reason, 'invalid-input');
  assert.equal(invalid.policy_pin_reason, null);
  const unreadable = outcome({ exit: 1, stdout: pinTerminal('unreadable'), stderr: '', localBand: 'LOW' });
  assert.equal(unreadable.degrade_reason, 'terminal');
  assert.equal(unreadable.policy_pin_reason, null);
});

test('pin outcome: exit 4 pinned routes keep deferred confirmation; an old router rejecting the key is empty-stdout', () => {
  for (const status of ['pinned', 'noop']) {
    const deferred = outcome({
      exit: 4,
      stdout: JSON.stringify(decision({ model_overlay: { status, state_reason: null } })),
      stderr: '',
      frozenDigest: POLICY_A,
    });
    assert.equal(deferred.status, 'deferred_confirm');
    assert.equal(deferred.dispatch_authorized, true);
    assert.equal(deferred.degrade_forbidden, true);
    assert.equal(deferred.policy_pin_reason, null);
  }
  const oldRouter = outcome({
    exit: 2, stdout: '', stderr: 'error: --request-json has unknown field(s): policy_pin', localBand: 'LOW',
  });
  assert.equal(oldRouter.status, 'internal');
  assert.equal(oldRouter.degrade_reason, 'empty-stdout');
  assert.equal(oldRouter.policy_pin_reason, null);
});

test('pin outcome: every outcome carries policy_pin_reason', () => {
  for (const translated of [
    outcome({ exit: 0, stdout: JSON.stringify(decision()), stderr: '' }),
    outcome({ exit: 3, stdout: JSON.stringify(decision()), stderr: '' }),
    outcome({ processState: 'timeout', stdout: '', stderr: '' }),
  ]) {
    assert.ok(Object.hasOwn(translated, 'policy_pin_reason'));
    assert.equal(translated.policy_pin_reason, null);
  }
});

test('locator: an existing ../deep-model-router checkout is rejected before resolution removes the ..', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dl-loc-sibling-')));
  const cwd = join(base, 'project');
  mkdirSync(cwd, { recursive: true });
  const sibling = join(base, 'deep-model-router', 'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(sibling), { recursive: true });
  writeFileSync(sibling, '#!/usr/bin/env python3\n');
  for (const spelled of [
    '../deep-model-router/skills/model-router/scripts/route_task.py',
    '..\\deep-model-router\\skills\\model-router\\scripts\\route_task.py',
  ]) {
    assert.equal(locateDeepModelRouter({ env: { DEEP_MODEL_ROUTER_CLI: spelled }, home: base, cwd }), null, spelled);
  }
  assert.equal(locateDeepModelRouter({ env: { DEEP_MODEL_ROUTER_CLI: sibling }, home: base, cwd }), realpathSync(sibling),
    'an explicit absolute override stays allowed');
});

test('locator: personal skill markers match regardless of letter case', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dl-loc-case-')));
  const upper = join(home, '.CLAUDE', 'SKILLS', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(upper), { recursive: true });
  writeFileSync(upper, '# personal\n');
  assert.equal(locateDeepModelRouter({ env: { DEEP_MODEL_ROUTER_CLI: upper }, home }), null);
  const cache = join(home, '.claude', 'plugins', 'cache', 'm', 'deep-model-router', '1.16.1', 'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(cache), { recursive: true });
  if (!createFileSymlinkOrSkip(t, upper, cache)) return;
  const located = locateDeepModelRouter({ env: {}, home });
  assert.ok(located === null || canonicalRouteTask(located) === null, 'a cache hit that resolves into a personal tree is never executable');
});

test('locator: every relative spelling of the sibling checkout is rejected, by path segment', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dl-loc-seg-')));
  const cwd = join(base, 'project');
  mkdirSync(cwd, { recursive: true });
  const sibling = join(base, 'deep-model-router', 'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(sibling), { recursive: true });
  writeFileSync(sibling, '#!/usr/bin/env python3\n');
  const tail = 'skills/model-router/scripts/route_task.py';
  for (const spelled of [
    `.././deep-model-router/${tail}`,
    `..//deep-model-router/${tail}`,
    `./../deep-model-router/${tail}`,
    `x/../../deep-model-router/${tail}`,
    `..\\.\\deep-model-router\\${tail.replaceAll('/', '\\')}`,
    `../DEEP-MODEL-ROUTER/${tail}`,
  ]) {
    assert.equal(locateDeepModelRouter({ env: { DEEP_MODEL_ROUTER_CLI: spelled }, home: base, cwd }), null, spelled);
    assert.equal(canonicalRouteTask(spelled, { cwd }), null, spelled);
  }
  assert.equal(locateDeepModelRouter({ env: { DEEP_MODEL_ROUTER_ROOT: '.././deep-model-router' }, home: base, cwd }), null);
});

test('locator: a differently named sibling and absolute overrides containing .. stay allowed', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dl-loc-abs-')));
  const cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  const other = join(home, 'deep-model-router2', 'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, '#!/usr/bin/env python3\n');
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: '../deep-model-router2/skills/model-router/scripts/route_task.py' }, home, cwd,
  }), realpathSync(other));
  const cacheBase = join(home, '.claude', 'plugins', 'cache', 'vendor');
  const low = join(cacheBase, 'deep-model-router', '1.15.0', 'skills', 'model-router', 'scripts', 'route_task.py');
  const high = join(cacheBase, 'deep-model-router', '1.16.1', 'skills', 'model-router', 'scripts', 'route_task.py');
  for (const file of [low, high]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '#!/usr/bin/env python3\n');
  }
  mkdirSync(join(cacheBase, 'staging'), { recursive: true });
  const viaDots = join(cacheBase, 'staging') + '/../deep-model-router/1.15.0';
  assert.equal(locateDeepModelRouter({ env: { DEEP_MODEL_ROUTER_ROOT: viaDots }, home, cwd }), realpathSync(low),
    'an explicit absolute ROOT with .. selects that install, not the higher fallback');
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: `${viaDots}/skills/model-router/scripts/route_task.py` }, home, cwd,
  }), realpathSync(low));
});

test('locator: an uppercase Codex personal skill path is rejected too', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dl-loc-codex-case-')));
  const upper = join(home, '.CODEX', 'SKILLS', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(upper), { recursive: true });
  writeFileSync(upper, '# personal\n');
  assert.equal(locateDeepModelRouter({ env: { DEEP_MODEL_ROUTER_CLI: upper }, home }), null);
});

test('locator: Windows drive-relative sibling spellings are relative; drive-absolute and UNC paths are not', () => {
  // Judge the spelling rule directly: on a POSIX host a `C:` path never exists,
  // so a locator-level null would pass without exercising the rule.
  const tail = 'skills\\model-router\\scripts\\route_task.py';
  for (const spelled of [`C:..\\deep-model-router\\${tail}`, `c:.././deep-model-router/x`, `C:deep\\..\\..\\deep-model-router`]) {
    assert.equal(isForbiddenRelativeCheckout(spelled), true, spelled);
  }
  for (const absolute of [`C:\\x\\..\\deep-model-router\\${tail}`, `C:/deep-model-router`, `\\\\server\\share\\..\\deep-model-router`,
    '/abs/../deep-model-router', '../deep-model-router2/x']) {
    assert.equal(isForbiddenRelativeCheckout(absolute), false, absolute);
  }
});
