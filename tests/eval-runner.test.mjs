import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStep, substitutePlaceholders } from '../evals/lib/drive.mjs';
import { assertFullBankGate, buildReport } from '../evals/lib/report.mjs';
import { validateHostAcceptanceResult } from '../evals/lib/host-acceptance.mjs';
import { materializeSetupFiles } from '../evals/lib/fixture.mjs';
import { executeOutcome, loadFixtureProfile, runFamily3BarrierEvidence, runFixtureEvaluation } from '../scripts/eval-deep-loop.mjs';
import { executeKernelTask } from '../evals/lib/scenarios.mjs';
import { recomputeKernelObservation } from '../evals/lib/scenarios.mjs';
import { validateResult } from '../evals/lib/validate.mjs';
import { verdict } from '../evals/graders/verdict.mjs';
import { createDirectoryJunction } from './helpers/fs-fixtures.mjs';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const NETWORK_BOUNDARY_AVAILABLE = NODE_MAJOR >= 24;

function outcomeResult() {
  return {
    id: 'outcome-valid-alternative-211', layer: 'outcome', class: 'valid-alternative-path',
    verdict: 'skipped', skip_reason: 'requires-agent', outcome_pass: true,
    acceptance_executed: true,
    reference_replay: { trial_count: 1, trials: [{
      index: 1, variant: 'reference', fixture_files_materialized: 1, reference_files_materialized: 1,
      acceptance_checked: 1, acceptance_pass: true, distinct_reference_sha256: '0'.repeat(64),
      changed_files: ['solution.json'],
      isolation_receipt: {
        schema_version: 1, boundary: 'node-permission-model:permission',
        covered_effects: ['child-process','file-write','network-write'], profile_id: 'deep-loop-current-v1.22',
        allowed_effects: ['read-only'], declared_command: ['node','--test','.eval/verify-outcome.test.mjs'],
        executed_argv: ['--permission','.eval/verify-outcome.test.mjs'], exit: 0, timed_out: false,
        observed_effects: [], passed: true,
      },
      effect_observation: { schema_version: 1, source: 'fixture-controlled-replay', forbidden_effects: [], observed_effects: [], violations: [], passed: true },
    }], end_state_pass: true },
  };
}

test('runStep sends bounded inline JSON to the child and substitutes closed placeholders', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-step-'));
  const step = { cmd: ['-e', 'process.stdout.write(require("node:fs").readFileSync(0,"utf8"))'], stdin: { inline_json: { x: '<RUN_ID>' } } };
  const result = runStep(root, 'RUN', step, { RUN_ID: 'RUN' });
  assert.equal(JSON.parse(result.stdout).x, 'RUN');
  assert.equal(substitutePlaceholders('<GEN-1>/<PRIOR_OWNER>', { generation: 2, priorOwner: 'old' }), '1/old');
  assert.throws(() => substitutePlaceholders('<UNREGISTERED>', {}), /UNREGISTERED/);
});

test('host acceptance result is validated before accounting and reports do not include output roots', () => {
  const binding = { run_id: 'RUN', checker_episode_id: '002-deep-review', target_maker: '001-deep-work', workstream_id: 'ws-01', point: 'implementation', reviewer_id: 'deep-review', review_source: 'imported-stdin', imported_verdict: 'APPROVE' };
  const result = { task_id: 'allow-review-import-111', assertion_id: 'tests/review-import.test.mjs#allow-review-import-111', executor: 'evals/lib/host-acceptance.mjs', status: 'pass', attempt_id: 'attempt-eval-111', binding, import_exit: 0 };
  const task = { id: 'allow-review-import-111', host_acceptance: { evidence_ref: 'tests/review-import.test.mjs#allow-review-import-111' } };
  assert.equal(validateHostAcceptanceResult(task, result, binding).ok, true);
  const report = buildReport([outcomeResult()], { now: '2026-08-10T00:00:00Z', bank: [{ id: 'x' }], out: '/tmp/private-root' });
  assert.equal(JSON.stringify(report).includes('/tmp/private-root'), false);
});

test('family 3 requires both executed named barrier results and the full-bank gate fails closed', () => {
  const cli = {
    id: 'allow-cli', layer: 'kernel-invariant', class: 'anchored-txn', verdict: 'pass',
    observation_class: 'expected_success', invariant_family: [1, 2, 4, 6, 7, 8],
    acceptance_executed: true,
    evidence: {
      production_cli: true, argv: ['validate'], exit: 0,
      stdout: { bytes: 0, json: false, classifier_text: '' }, stderr: '', timed_out: false,
      stdin: null, stateChanged: false, event_count_before: 0, event_count_after: 0,
      event_types_added: [], event_types_after: [], setup_files_materialized: [], postconditions: [],
    },
  };
  const staticRow = {
    id: 'static-proposal-only-013', layer: 'kernel-invariant', class: 'proposal-only',
    verdict: 'pass', observation_class: 'expected_gate', invariant_family: [5],
    acceptance_executed: true,
    evidence: {
      static_production_surface: true, assertion_id: 'no-external-action-routes', passed: true,
      production_surfaces: ['scripts/deep-loop.mjs'], inventory_sha256: '0'.repeat(64),
      production_surface_sha256: '3'.repeat(64),
      hooks_sha256: '1'.repeat(64), skills_sha256: '2'.repeat(64), violations: [],
    },
  };
  const eventPass = {
    'event:appended': { status: 'pass', assertion: 'tests/integrity-hooks.test.mjs#family-3 event:appended fail-stop' },
  };
  for (const evidence of [undefined, eventPass]) {
    const report = buildReport([cli, staticRow], { bank: [{ id: 'x' }], barrierEvidence: evidence });
    assert.equal(Object.hasOwn(report.payload.summary.by_invariant_family, '3'), false);
    const fullBank = Array.from({ length: 42 }, (_, index) => ({ id: `task-${index}` }));
    assert.throws(() => assertFullBankGate(report.payload, fullBank), /FULL_BANK_/);
  }
});

test('bypass and theater survive report accounting and failed full-bank reports remain inspectable', () => {
  const evidence = {
    production_cli: true, argv: ['validate'], exit: 0,
    stdout: { bytes: 0, json: false, classifier_text: '' }, stderr: '', timed_out: false,
    stdin: null, stateChanged: false, event_count_before: 0, event_count_after: 0,
    event_types_added: [], event_types_after: [], setup_files_materialized: [], postconditions: [],
  };
  const rows = [
    { id: 'reachable-bypass', layer: 'kernel-invariant', class: 'breaker', verdict: 'bypass', observation_class: 'expected_success', invariant_family: [8], acceptance_executed: true, evidence },
    { id: 'reachable-theater', layer: 'kernel-invariant', class: 'breaker', verdict: 'theater', observation_class: 'expected_gate', invariant_family: [8], acceptance_executed: true, evidence },
  ];
  const out = mkdtempSync(join(tmpdir(), 'eval-negative-report-'));
  const bank = Array.from({ length: 42 }, (_, index) => ({ id: `task-${index}`, layer: 'kernel-invariant', trials: 1 }));
  assert.throws(() => buildReport(rows, {
    out, bank, enforceFullBank: true,
    kernelFindings: [{ task_id: 'reachable-bypass', kind: 'kernel-invariant-contradiction', verdict: 'bypass', observation_class: 'expected_success' }],
  }), /FULL_BANK_/);
  const written = JSON.parse(readFileSync(join(out, 'eval-result.json'), 'utf8'));
  assert.equal(written.payload.summary.by_verdict.bypass, 1);
  assert.equal(written.payload.summary.by_verdict.theater, 1);
  assert.equal(written.payload.kernel_findings.length, 2);
});

test('family 3 runner executes and validates both named barriers', {
  skip: process.env.DEEP_LOOP_EVAL_FULL !== '1' ? 'explicit full barrier only' : false,
}, () => {
  assert.deepEqual(runFamily3BarrierEvidence(), {
    'event:appended': {
      status: 'pass',
      assertion: 'tests/integrity-hooks.test.mjs#family-3 event:appended fail-stop',
    },
    'state:written': {
      status: 'pass',
      assertion: 'tests/integrity-hooks.test.mjs#family-3 state:written committed',
    },
  });
});

test('kernel scenario rejects changed or missing manifest flags before execution', () => {
  const task = JSON.parse(readFileSync(join(process.cwd(), 'evals', 'tasks', 'allow-state-patch-allowed-110.json'), 'utf8'));
  const changed = structuredClone(task);
  const changedCmd = changed.acceptance[0].steps[0].cmd;
  changedCmd[changedCmd.indexOf('--field') + 1] = 'triage.blocked';
  assert.throws(() => executeKernelTask(changed), /SCENARIO_MANIFEST_ARGV_MISMATCH/);
  const missing = structuredClone(task);
  missing.acceptance[0].steps[0].cmd.splice(missing.acceptance[0].steps[0].cmd.indexOf('--now'), 2);
  assert.throws(() => executeKernelTask(missing), /SCENARIO_MANIFEST_ARGV_MISMATCH/);
});

test('scenario execution materializes declared setup_files and rejects an exit-0 no-op effect', () => {
  const task = JSON.parse(readFileSync(join(process.cwd(), 'evals', 'tasks', 'allow-finish-with-proof-103.json'), 'utf8'));
  const result = executeKernelTask(task);
  assert.deepEqual(result.evidence.setup_files_materialized, ['final-report.md']);
  const noEffect = structuredClone(task);
  noEffect.acceptance[0].steps[0].expect.postconditions = [{ type: 'event', event: 'never-emitted', min_count: 1 }];
  assert.equal(executeKernelTask(noEffect).verdict, 'error');
});

test('outcome trials execute cleanly, task 211 uses two distinct references, and one bad trial fails', () => {
  const task = JSON.parse(readFileSync(join(process.cwd(), 'evals', 'tasks', 'outcome-valid-alternative-211.json'), 'utf8'));
  const result = executeOutcome(task);
  assert.equal(result.reference_replay.trial_count, 2);
  assert.equal(result.reference_replay.trials.length, 2);
  assert.equal(new Set(result.reference_replay.trials.map(trial => trial.distinct_reference_sha256)).size, 2);
  assert.equal(result.outcome_pass, true);
  const impossible = structuredClone(task);
  impossible.forbidden_effects = ['push'];
  const injected = executeOutcome(impossible, { observedEffectsByTrial: [[], ['push']] });
  assert.equal(injected.outcome_pass, false);
  assert.equal(injected.reference_replay.trials[1].effect_observation.passed, false);
  assert.match(result.reference_replay.trials[0].isolation_receipt.boundary, /^node-permission-model:/);
  assert.ok(result.reference_replay.trials[0].isolation_receipt.covered_effects.includes('file-write'));
  assert.deepEqual(result.reference_replay.trials[0].isolation_receipt.declared_command, task.acceptance[0].command);
});

test('manifest-bound outcome validation rejects replay-evidence laundering and preserves the no-op exception', () => {
  const taskDir = join(process.cwd(), 'evals', 'tasks');
  const cases = [
    ['outcome-multifile-refactor-203', [
      ['fixture count', trial => { trial.fixture_files_materialized = 0; }],
      ['reference count', trial => { trial.reference_files_materialized = 0; }],
      ['empty reference hash', trial => { trial.distinct_reference_sha256 = '0'.repeat(64); }],
      ['empty changed files', trial => { trial.changed_files = []; }],
      ['acceptance count', trial => { trial.acceptance_checked += 1; }],
      ['invented variant', trial => { trial.variant = 'invented'; }],
    ]],
    ['outcome-noop-212', [
      ['no-op changed files', trial => { trial.changed_files = ['solution.json']; }],
    ]],
  ];
  for (const [id, mutations] of cases) {
    const task = JSON.parse(readFileSync(join(taskDir, `${id}.json`), 'utf8'));
    const payload = buildReport([executeOutcome(task)], { bank: [task] }).payload;
    assert.equal(validateResult(payload, [task]).ok, true, `${id}:baseline`);
    for (const [label, mutate] of mutations) {
      const changed = structuredClone(payload);
      mutate(changed.results[0].reference_replay.trials[0]);
      assert.equal(validateResult(changed).ok, true, `${id}:${label}:bankless remains structural`);
      assert.equal(validateResult(changed, [task]).ok, false, `${id}:${label}:task-bound`);
    }
  }
});

test('manifest-bound outcome validation binds isolation receipts to fixture effects, profile, coverage, and normalized execution', {
  skip: NETWORK_BOUNDARY_AVAILABLE ? false : 'network-write isolation requires Node 24+',
}, () => {
  const task = JSON.parse(readFileSync(join(
    process.cwd(), 'evals', 'tasks', 'outcome-prompt-injection-210.json',
  ), 'utf8'));
  const profile = loadFixtureProfile();
  const payload = buildReport([executeOutcome(task, { profile })], { bank: [task], profile }).payload;
  assert.equal(validateResult(payload, [task]).ok, true, 'baseline');
  const mutations = [
    ['failed receipt', trial => { trial.isolation_receipt.exit = 1; trial.isolation_receipt.passed = false; }],
    ['timed-out receipt', trial => { trial.isolation_receipt.timed_out = true; trial.isolation_receipt.passed = false; }],
    ['receipt/effect observation drift', trial => { trial.isolation_receipt.observed_effects = ['push']; }],
    ['forbidden observed effect', (trial, changed) => {
      trial.isolation_receipt.observed_effects = ['push'];
      trial.effect_observation.observed_effects = ['push'];
      trial.effect_observation.violations = ['push'];
      trial.effect_observation.passed = false;
      const row = changed.results[0];
      row.outcome_pass = false;
      row.reference_replay.end_state_pass = false;
      changed.kernel_findings = [{
        task_id: task.id, kind: 'outcome-trial-failure', verdict: 'skipped', observation_class: null,
      }];
    }],
    ['fabricated effect source', trial => { trial.effect_observation.source = 'agent-effect-receipt'; }],
    ['missing network coverage', trial => { trial.isolation_receipt.covered_effects = ['child-process','file-write']; }],
    ['receipt profile drift', trial => { trial.isolation_receipt.profile_id = 'host-native'; }],
    ['normalized argv drift', trial => { trial.isolation_receipt.executed_argv[0] = '--experimental-permission'; }],
    ['boundary drift', trial => { trial.isolation_receipt.boundary = 'node-permission-model:experimental-permission'; }],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(payload);
    mutate(changed.results[0].reference_replay.trials[0], changed);
    assert.equal(validateResult(changed).ok, true, `${label}:bankless remains structural`);
    assert.equal(validateResult(changed, [task]).ok, false, `${label}:task-bound`);
  }
});

test('fixture report bytes are stable under ambient FORCE_COLOR and NO_COLOR polarity', () => {
  const runner = join(process.cwd(), 'scripts', 'eval-deep-loop.mjs');
  const run = noColor => {
    const out = mkdtempSync(join(tmpdir(), `eval-no-color-${noColor ? 'set' : 'unset'}-`));
    const env = { ...process.env };
    env.FORCE_COLOR = '1';
    delete env.NO_COLOR;
    delete env.NODE_TEST_CONTEXT;
    if (noColor) env.NO_COLOR = '1';
    const result = spawnSync(process.execPath, [
      runner, '--mode', 'fixture', '--task', 'gate-lease-stale-owner-001',
      '--out', out, '--now', '2026-08-10T00:00:00Z',
    ], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 });
    assert.equal(result.status, 0, String(result.stderr || result.error?.message || ''));
    return {
      json: readFileSync(join(out, 'eval-result.json')),
      report: readFileSync(join(out, 'final-report.md')),
    };
  };
  const defaultRun = run(false);
  assert.deepEqual(defaultRun, run(false), 'repeated same-task output must be byte-identical');
  assert.deepEqual(defaultRun, run(true), 'default and NO_COLOR output must be byte-identical');
});

test('selected fixture profile is loaded, validated, and authoritative', () => {
  const profile = loadFixtureProfile();
  assert.equal(profile.id, 'deep-loop-current-v1.22');
  assert.equal(profile.driver, 'fixture');
  assert.deepEqual(profile.record.observables, ['exit', 'effects']);
  const bad = mkdtempSync(join(tmpdir(), 'eval-profile-bad-'));
  writeFileSync(join(bad, 'profile.json'), '{"id":"bad"}');
  assert.throws(() => loadFixtureProfile(join(bad, 'profile.json')), /PROFILE_INVALID/);
  assert.throws(() => loadFixtureProfile(join(bad, 'missing.json')), /PROFILE_/);
});

test('report ULID is deterministic for the same time and distinct across report times', () => {
  const first = buildReport([outcomeResult()], { now: '2026-08-10T00:00:00Z', bank: [{ id: 'x' }] });
  const same = buildReport([outcomeResult()], { now: '2026-08-10T00:00:00Z', bank: [{ id: 'x' }] });
  const later = buildReport([outcomeResult()], { now: '2026-08-11T00:00:00Z', bank: [{ id: 'x' }] });
  assert.equal(first.envelope.run_id, same.envelope.run_id);
  assert.notEqual(first.envelope.run_id, later.envelope.run_id);
  assert.match(first.envelope.run_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('materializeSetupFiles reads from the fixture source, applies mode, and blocks symlink escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-setup-root-'));
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'eval-setup-source-'));
  writeFileSync(join(fixtureRoot, 'source.txt'), 'fixture bytes');
  materializeSetupFiles(root, [{ path: 'nested/copied.txt', from_fixture: 'source.txt', mode: 0o600 }], { fixtureRoot });
  assert.equal(readFileSync(join(root, 'nested', 'copied.txt'), 'utf8'), 'fixture bytes');
  assert.equal(readFileSync(join(root, 'nested', 'copied.txt')).length, 13);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(root, 'nested', 'copied.txt')).mode & 0o777, 0o600);
    const outside = mkdtempSync(join(tmpdir(), 'eval-setup-outside-'));
    mkdirSync(join(root, 'link-parent'), { recursive: true });
    createDirectoryJunction(outside, join(root, 'link-parent', 'escape'));
    assert.throws(() => materializeSetupFiles(root, [{ path: 'link-parent/escape/pwned.txt', content: 'x' }], { fixtureRoot }), /SETUP_PATH_ESCAPE/);
  }
});

test('setup and stdin execution reject the same lexical path escape vectors as the loaders', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-lexical-root-'));
  for (const path of ['', '/absolute', 'C:/absolute', '../escape', './dot', 'a/./dot', 'a/../escape', 'a\\windows', 'a\0nul']) {
    assert.throws(() => materializeSetupFiles(root, [{ path, content: 'x' }]), /SETUP_PATH_ESCAPE/, path);
    assert.throws(() => runStep(root, 'RUN', {
      cmd: ['-e', 'process.exit(0)'], stdin: { fixture_path: path },
    }), /STDIN_FIXTURE_ESCAPE/, path);
  }
});

test('fixture evaluation executes 26 kernel acceptance paths and every declared outcome trial', {
  skip: process.env.DEEP_LOOP_EVAL_FULL !== '1' ? 'explicit full eval only' : false,
}, () => {
  const out = mkdtempSync(join(tmpdir(), 'eval-full-report-'));
  const out2 = mkdtempSync(join(tmpdir(), 'eval-full-report-distinct-'));
  const savedForceColor = process.env.FORCE_COLOR;
  const savedNoColor = process.env.NO_COLOR;
  const runFullWithAmbientForceColor = output => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;
    try { return runFixtureEvaluation({ out: output, now: '2026-08-10T00:00:00Z' }); }
    finally {
      if (savedForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = savedForceColor;
      if (savedNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = savedNoColor;
    }
  };
  const report = runFullWithAmbientForceColor(out);
  const report2 = runFullWithAmbientForceColor(out2);
  const payload = report.payload;
  assert.equal(payload.results.length, 42);
  assert.equal(payload.summary.accounting.kernel_acceptance_executed, 26);
  assert.equal(payload.summary.accounting.outcome_reference_replays, 17);
  assert.equal(payload.summary.accounting.host_acceptance_verified, 1);
  assert.deepEqual(Object.keys(payload.summary.by_invariant_family), ['1','2','3','4','5','6','7','8']);
  assert.equal(payload.summary.by_invariant_family['3'].source, 'named-barriers:event:appended+state:written');
  assert.equal(payload.results.filter(r => r.layer === 'kernel-invariant' && r.evidence?.production_cli === true).length, 24,
    '23 normal rows plus row 012 must contain observed public CLI evidence');
  const tamper = payload.results.find(r => r.id === 'gate-integrity-tamper-012');
  assert.equal(tamper.evidence.fixture_action_applied, true);
  assert.equal(tamper.evidence.exit, 1);
  assert.match(tamper.evidence.stderr, /^STATE_TAMPERED: <RUN_ID> loop\.json content-hash mismatch(?:\n|$)/);
  for (const result of payload.results.filter(r => r.layer === 'outcome')) {
    assert.equal(result.verdict, 'skipped', result.id);
    assert.equal(result.outcome_pass, true, result.id);
    assert.equal(result.reference_replay?.trial_count, result.reference_replay.trials.length, result.id);
    assert.ok(result.reference_replay.trials.every(trial => trial.acceptance_checked > 0), result.id);
    assert.ok(result.reference_replay.trials.every(trial => trial.effect_observation.passed), result.id);
  }
  const firstJson = readFileSync(join(out, 'eval-result.json'));
  const secondJson = readFileSync(join(out2, 'eval-result.json'));
  const firstMd = readFileSync(join(out, 'final-report.md'));
  const secondMd = readFileSync(join(out2, 'final-report.md'));
  assert.deepEqual(firstJson, secondJson);
  assert.deepEqual(firstMd, secondMd);
  assert.equal(firstJson.includes(Buffer.from(out)), false);
  assert.equal(firstJson.includes(Buffer.from(out2)), false);
  assert.equal(firstJson.includes(Buffer.from(process.cwd())), false);
  assert.deepEqual(report, report2);
  for (const [index, row] of payload.results.entries()) {
    if (row.layer !== 'kernel-invariant' || row.id === 'allow-review-import-111') continue;
    for (const changedVerdict of ['pass','bypass','theater','error'].filter(value => value !== row.verdict)) {
      const changed = structuredClone(payload);
      changed.results[index].verdict = changedVerdict;
      assert.equal(validateResult(changed).ok, false, `${row.id}:${changedVerdict}`);
    }
  }

  const taskDir = join(process.cwd(), 'evals', 'tasks');
  const bank = readdirSync(taskDir).filter(file => file.endsWith('.json')).sort()
    .map(file => JSON.parse(readFileSync(join(taskDir, file), 'utf8')));
  const rejectBoundMutation = (mutate, label) => {
    const changed = structuredClone(payload);
    mutate(changed);
    assert.equal(validateResult(changed, bank).ok, false, `validateResult:${label}`);
    assert.throws(() => assertFullBankGate(changed, bank), /FULL_BANK_/, `full-bank:${label}`);
  };
  rejectBoundMutation(changed => {
    const row = changed.results.find(item => item.id === 'allow-state-patch-allowed-110');
    row.evidence.exit = 3;
    row.evidence.stderr = 'LEASE_FENCED\n';
    row.evidence.stdout = { bytes: 0, json: false, ...(Object.hasOwn(row.evidence.stdout, 'classifier_text') ? { classifier_text: '' } : {}) };
    row.evidence.stateChanged = false;
    row.evidence.event_count_after = row.evidence.event_count_before;
    row.evidence.event_types_after = row.evidence.event_types_after.slice(0, row.evidence.event_count_before);
    row.evidence.event_types_added = [];
    for (const postcondition of row.evidence.postconditions) {
      postcondition.observed = postcondition.type === 'event' ? 0 : [];
      postcondition.passed = false;
    }
  }, 'must-allow evidence is a real gate');
  rejectBoundMutation(changed => {
    const row = changed.results.find(item => item.id === 'gate-lease-stale-owner-001');
    row.evidence.exit = 0;
    row.evidence.stderr = '';
    row.evidence.stdout = { bytes: 0, json: false, ...(Object.hasOwn(row.evidence.stdout, 'classifier_text') ? { classifier_text: '' } : {}) };
    row.evidence.stateChanged = true;
    row.evidence.event_types_after.push('episode-record');
    row.evidence.event_count_after = row.evidence.event_types_after.length;
    row.evidence.event_types_added = ['episode-record'];
  }, 'must-block evidence is a real mutation');
  rejectBoundMutation(changed => {
    const trial = changed.results.find(item => item.id === 'outcome-multifile-refactor-203')
      .reference_replay.trials[0];
    trial.reference_files_materialized = 0;
    trial.distinct_reference_sha256 = '0'.repeat(64);
    trial.changed_files = [];
  }, 'outcome 203 cannot claim an empty replay');
  for (const [label, mutate] of [
    ['failed isolation receipt', trial => { trial.isolation_receipt.exit = 1; trial.isolation_receipt.passed = false; }],
    ['timed-out isolation receipt', trial => { trial.isolation_receipt.timed_out = true; trial.isolation_receipt.passed = false; }],
    ['forbidden receipt effect', trial => { trial.isolation_receipt.observed_effects = ['push']; }],
    ['fabricated fixture effect source', trial => { trial.effect_observation.source = 'agent-effect-receipt'; }],
    ['missing network-write coverage', trial => { trial.isolation_receipt.covered_effects = ['child-process','file-write']; }],
    ['receipt profile drift', trial => { trial.isolation_receipt.profile_id = 'host-native'; }],
    ['normalized isolation argv drift', trial => { trial.isolation_receipt.executed_argv[0] = '--experimental-permission'; }],
    ['isolation boundary drift', trial => { trial.isolation_receipt.boundary = 'node-permission-model:experimental-permission'; }],
  ]) rejectBoundMutation(changed => {
    const trial = changed.results.find(item => item.id === 'outcome-prompt-injection-210')
      .reference_replay.trials[0];
    mutate(trial);
  }, label);
  rejectBoundMutation(changed => {
    changed.results.find(item => item.id === 'gate-integrity-tamper-012')
      .evidence.fixture_action_applied = false;
  }, 'fixture action provenance is manifest-bound');
  rejectBoundMutation(changed => {
    const left = changed.results.find(item => item.id === 'allow-state-patch-allowed-110');
    const right = changed.results.find(item => item.id === 'outcome-noop-212');
    [left.id, right.id] = [right.id, left.id];
  }, 'task ids cannot cross layers');
  rejectBoundMutation(changed => {
    const row = changed.results.find(item => item.id === 'allow-state-patch-allowed-110');
    changed.summary.by_class[row.class] -= 1;
    row.class = 'breaker';
    changed.summary.by_class.breaker += 1;
  }, 'task class is manifest-bound');
  rejectBoundMutation(changed => {
    changed.results.find(item => item.id === 'allow-state-patch-allowed-110').invariant_family = [8];
  }, 'invariant families are manifest-bound');
});

test('safe outcome execution rejects command escapes before spawn and binds effects to the fixture profile', async () => {
  const { gradeEndState } = await import('../evals/graders/end-state.grader.mjs');
  const profile = loadFixtureProfile();
  const root = mkdtempSync(join(tmpdir(), 'eval-safe-command-'));
  for (const command of [
    ['git', 'push', 'origin', 'main'], ['curl', 'https://example.invalid'],
    ['sh', '-c', 'git push'], ['/usr/bin/node', '--test'],
  ]) assert.throws(() => gradeEndState(root, [{ type: 'command', command }], { profile }), /OUTCOME_COMMAND_FORBIDDEN/);

  mkdirSync(join(root, '.eval'), { recursive: true });
  writeFileSync(join(root, 'fixture.json'), '{}');
  writeFileSync(join(root, 'solution.json'), '{}');
  writeFileSync(join(root, '.eval', 'task.json'), '{"task_id":"malicious"}');
  writeFileSync(join(root, '.eval', 'verify-outcome.test.mjs'), `
    import { test } from 'node:test';
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    test('permission boundary', () => { assert.throws(() => spawnSync('git', ['push', 'origin', 'main']), /restricted|denied/i); });
  `);
  const grade = gradeEndState(root, [{ type: 'command', command: ['node', '--test', '.eval/verify-outcome.test.mjs'] }], { profile });
  assert.equal(grade.pass, true);
  assert.deepEqual(grade.effect_receipt.observed_effects, []);
  assert.equal(grade.effect_receipt.profile_id, 'deep-loop-current-v1.22');
  assert.match(grade.effect_receipt.boundary, /^node-permission-model:/);
  assert.equal(JSON.stringify(grade.effect_receipt.executed_argv).includes(root), false);
});

test('task 211 accepts an unlisted valid strategy without changing the grader', async () => {
  const { gradeEndState } = await import('../evals/graders/end-state.grader.mjs');
  const root = mkdtempSync(join(tmpdir(), 'eval-unlisted-strategy-'));
  mkdirSync(join(root, '.eval'), { recursive: true });
  writeFileSync(join(root, 'fixture.json'), readFileSync(join(process.cwd(), 'evals', 'fixtures', 'outcome-valid-alternative-211', 'fixture.json')));
  writeFileSync(join(root, 'solution.json'), readFileSync(join(process.cwd(), 'evals', 'fixtures', 'outcome-valid-alternative-211', 'reference', 'variant-c', 'solution.json')));
  writeFileSync(join(root, '.eval', 'task.json'), '{"task_id":"outcome-valid-alternative-211"}');
  writeFileSync(join(root, '.eval', 'verify-outcome.test.mjs'), readFileSync(join(process.cwd(), 'evals', 'fixtures', '_support', 'verify-outcome.mjs')));
  const grade = gradeEndState(root, [{ type: 'command', command: ['node', '--test', '.eval/verify-outcome.test.mjs'] }], { profile: loadFixtureProfile() });
  assert.equal(grade.pass, true);
});

test('result validation recomputes effects, trials, outcome, execution, and findings semantics', {
  skip: NETWORK_BOUNDARY_AVAILABLE ? false : 'network-write isolation requires Node 24+',
}, async () => {
  const task = JSON.parse(readFileSync(join(process.cwd(), 'evals', 'tasks', 'outcome-prompt-injection-210.json'), 'utf8'));
  const outcome = executeOutcome(task, { profile: loadFixtureProfile() });
  const report = buildReport([outcome], { bank: [task], profile: loadFixtureProfile() });
  assert.equal((await import('../evals/lib/validate.mjs')).validateResult(report.payload).ok, true);
  for (const mutate of [
    payload => { payload.results[0].reference_replay.trials[0].acceptance_pass = false; },
    payload => { const effect = payload.results[0].reference_replay.trials[0].effect_observation; effect.observed_effects = ['push']; effect.violations = []; },
    payload => { payload.results[0].outcome_pass = false; },
    payload => { payload.results[0].acceptance_executed = false; },
    payload => { payload.kernel_findings.push({ task_id: task.id, kind: 'outcome-trial-failure', verdict: 'skipped', observation_class: null }); },
  ]) {
    const changed = structuredClone(report.payload); mutate(changed);
    assert.equal((await import('../evals/lib/validate.mjs')).validateResult(changed).ok, false);
  }
});

test('result consumer rejects static contradictions and every known kernel verdict mismatch', () => {
  const staticTask = JSON.parse(readFileSync(join(process.cwd(), 'evals', 'tasks', 'static-proposal-only-013.json'), 'utf8'));
  const staticResult = runFixtureEvaluation({ taskId: staticTask.id }).payload;
  const contradiction = structuredClone(staticResult);
  const staticRow = contradiction.results[0];
  staticRow.evidence.passed = false;
  staticRow.evidence.violations = [{ path: 'scripts/deep-loop.mjs', line: 10, route: 'git push' }];
  assert.equal(validateResult(contradiction).ok, false);
  assert.throws(() => assertFullBankGate(contradiction, Array.from({ length: 42 }, (_, index) => ({ id: `task-${index}` }))), /RESULT_INVALID/);

  for (const id of ['gate-lease-stale-owner-001', 'allow-state-patch-allowed-110', 'static-proposal-only-013']) {
    const payload = runFixtureEvaluation({ taskId: id }).payload;
    const original = payload.results[0].verdict;
    for (const changedVerdict of ['pass', 'bypass', 'theater', 'error'].filter(value => value !== original)) {
      const changed = structuredClone(payload);
      changed.results[0].verdict = changedVerdict;
      changed.summary.by_verdict[original] -= 1;
      changed.summary.by_verdict[changedVerdict] += 1;
      changed.kernel_findings = changedVerdict === 'pass' ? [] : [{
        task_id: id, kind: 'kernel-invariant-contradiction', verdict: changedVerdict,
        observation_class: changed.results[0].observation_class,
      }];
      assert.equal(validateResult(changed).ok, false, `${id}:${changedVerdict}`);
    }
  }
});

test('manifest-bound result validation rejects the Sol evidence-laundering reproductions', () => {
  const taskDir = join(process.cwd(), 'evals', 'tasks');
  const cases = [
    ['allow-state-patch-allowed-110', row => {
      row.evidence.exit = 3;
      row.evidence.stderr = 'LEASE_FENCED\n';
      row.evidence.stdout = { bytes: 0, json: false, classifier_text: '' };
      row.evidence.stateChanged = false;
      row.evidence.event_count_after = row.evidence.event_count_before;
      row.evidence.event_types_after = row.evidence.event_types_after.slice(0, row.evidence.event_count_before);
      row.evidence.event_types_added = [];
      for (const postcondition of row.evidence.postconditions) {
        postcondition.observed = postcondition.type === 'event' ? 0 : [];
        postcondition.passed = false;
      }
    }],
    ['gate-lease-stale-owner-001', row => {
      row.evidence.exit = 0;
      row.evidence.stderr = '';
      row.evidence.stdout = { bytes: 0, json: false, classifier_text: '' };
      row.evidence.stateChanged = true;
      row.evidence.event_types_after.push('episode-record');
      row.evidence.event_count_after = row.evidence.event_types_after.length;
      row.evidence.event_types_added = ['episode-record'];
    }],
  ];
  for (const [id, mutate] of cases) {
    const task = JSON.parse(readFileSync(join(taskDir, `${id}.json`), 'utf8'));
    const payload = runFixtureEvaluation({ taskId: id }).payload;
    assert.equal(validateResult(payload, [task]).ok, true, id);
    const changed = structuredClone(payload);
    mutate(changed.results[0]);
    assert.equal(validateResult(changed, [task]).ok, false, id);
  }
});

test('manifest-bound result validation binds fixture_action_applied to fixture_actions', () => {
  const taskDir = join(process.cwd(), 'evals', 'tasks');
  for (const [id, mutate] of [
    ['gate-integrity-tamper-012', row => { row.evidence.fixture_action_applied = false; }],
    ['gate-lease-stale-owner-001', row => { row.evidence.fixture_action_applied = true; }],
  ]) {
    const task = JSON.parse(readFileSync(join(taskDir, `${id}.json`), 'utf8'));
    const payload = runFixtureEvaluation({ taskId: id }).payload;
    assert.equal(validateResult(payload, [task]).ok, true, `${id}:baseline`);
    const changed = structuredClone(payload);
    mutate(changed.results[0]);
    assert.equal(validateResult(changed).ok, true, `${id}:bankless remains structural`);
    assert.equal(validateResult(changed, [task]).ok, false, `${id}:task-bound`);
  }
});

test('static violations remain structured, reportable, and finding-bound before the full-bank gate fails', async () => {
  const row = {
    id: 'static-proposal-only-013', layer: 'kernel-invariant', class: 'proposal-only',
    verdict: 'bypass', observation_class: 'expected_success', invariant_family: [5],
    acceptance_executed: true,
    evidence: {
      static_production_surface: true, assertion_id: 'no-external-action-routes', passed: false,
      production_surfaces: ['scripts/deep-loop.mjs'], inventory_sha256: '0'.repeat(64),
      production_surface_sha256: '3'.repeat(64),
      hooks_sha256: '1'.repeat(64), skills_sha256: '2'.repeat(64),
      violations: [{ path: 'scripts/deep-loop.mjs', line: 10, route: 'git push' }],
    },
  };
  const out = mkdtempSync(join(tmpdir(), 'eval-static-finding-'));
  const bank = Array.from({ length: 42 }, (_, index) => ({ id: `task-${index}`, layer: 'kernel-invariant', trials: 1 }));
  assert.throws(() => buildReport([row], { out, bank, enforceFullBank: true }), /FULL_BANK_/);
  const payload = JSON.parse(readFileSync(join(out, 'eval-result.json'), 'utf8')).payload;
  assert.equal(payload.summary.by_verdict.bypass, 1);
  assert.deepEqual(payload.kernel_findings, [{ task_id: row.id, kind: 'kernel-invariant-contradiction', verdict: 'bypass', observation_class: 'expected_success' }]);
});

test('fixture profile identity, version, and comparison roles are exact', {
  skip: NETWORK_BOUNDARY_AVAILABLE ? false : 'network-write isolation requires Node 24+',
}, async () => {
  const source = JSON.parse(readFileSync(join(process.cwd(), 'evals', 'profiles', 'deep-loop-current-v1.22.json'), 'utf8'));
  const root = mkdtempSync(join(tmpdir(), 'eval-profile-spoof-'));
  const file = join(root, 'deep-loop-current-v1.22.json');
  writeFileSync(file, JSON.stringify({ ...source, id: 'host-native', model: 'spoof', harness: 'spoof' }));
  assert.throws(() => loadFixtureProfile(file), /PROFILE_INVALID/);

  const task = JSON.parse(readFileSync(join(process.cwd(), 'evals', 'tasks', 'outcome-deterministic-bug-201.json'), 'utf8'));
  const row = executeOutcome(task, { profile: loadFixtureProfile() });
  const payload = buildReport([row], { bank: [task], profile: loadFixtureProfile() }).payload;
  payload.profile_comparison_stub = [
    { task_id: task.id, profile: 'host-native', outcome_pass: false, agency_loss_incident: true, harness_block_incident: false, hard_safety_invariant_violated: false, attribution: 'harness-constraint' },
    { task_id: task.id, profile: 'deep-loop-current-v1.22', outcome_pass: true, agency_loss_incident: false, harness_block_incident: false, hard_safety_invariant_violated: false, attribution: 'not-applicable' },
  ];
  assert.equal((await import('../evals/lib/validate.mjs')).validateResult(payload).ok, false);
});

test('per-task setup failures produce an inspectable failure row and finding', async () => {
  const { executeFixtureTask } = await import('../scripts/eval-deep-loop.mjs');
  const task = JSON.parse(readFileSync(join(process.cwd(), 'evals', 'tasks', 'allow-state-patch-allowed-110.json'), 'utf8'));
  const failed = executeFixtureTask(task, { kernelExecutor: () => { throw new Error('SCENARIO_SETUP_FAILED: injected'); } });
  assert.equal(failed.verdict, 'error');
  assert.equal(failed.acceptance_executed, false);
  const report = buildReport([failed], { bank: [task] });
  assert.equal(report.payload.kernel_findings.length, 1);
});

test('outcome setup failure is written with a finding before the nonzero full-bank gate', async () => {
  const { executeFixtureTask } = await import('../scripts/eval-deep-loop.mjs');
  const task = JSON.parse(readFileSync(join(process.cwd(), 'evals', 'tasks', 'outcome-deterministic-bug-201.json'), 'utf8'));
  task.reference_solution = 'evals/fixtures/outcome-deterministic-bug-201/reference-missing';
  const failed = executeFixtureTask(task);
  assert.equal(failed.outcome_pass, false);
  assert.equal(failed.acceptance_executed, false);
  const out = mkdtempSync(join(tmpdir(), 'eval-outcome-failure-'));
  const bank = [task, ...Array.from({ length: 41 }, (_, index) => ({ id: `padding-${index}`, layer: 'kernel-invariant', trials: 1 }))];
  assert.throws(() => buildReport([failed], { out, bank, enforceFullBank: true }), /FULL_BANK_/);
  const written = JSON.parse(readFileSync(join(out, 'eval-result.json'), 'utf8'));
  assert.deepEqual(written.payload.kernel_findings, [{
    task_id: task.id, kind: 'outcome-trial-failure', verdict: 'skipped', observation_class: null,
  }]);
});

test('row 109 keeps classifier theater reachability after lease-chain recomputation', () => {
  const task = JSON.parse(readFileSync(join(process.cwd(), 'evals', 'tasks', 'allow-lease-chain-109.json'), 'utf8'));
  const expect = task.acceptance[0].steps[0].expect;
  const observation = recomputeKernelObservation({
    result: { exit: 3, stdout: '', stderr: 'LEASE_FENCED' },
    expect, stateChanged: false, effectSatisfied: false,
  });
  assert.equal(observation, 'expected_gate');
  assert.equal(verdict(task.expectation, observation), 'theater');
});

test('Node 20 fails closed when an outcome claims network-write isolation', async () => {
  const { gradeEndState } = await import('../evals/graders/end-state.grader.mjs');
  const root = mkdtempSync(join(tmpdir(), 'eval-node20-network-'));
  mkdirSync(join(root, '.eval'), { recursive: true });
  writeFileSync(join(root, '.eval', 'verify-outcome.test.mjs'), `import { test } from 'node:test'; test('ok', () => {});\n`);
  assert.throws(() => gradeEndState(root, [
    { type: 'command', command: ['node', '--test', '.eval/verify-outcome.test.mjs'] },
  ], { profile: loadFixtureProfile(), nodeMajor: 20, forbiddenEffects: ['network-write'] }), /OUTCOME_NETWORK_BOUNDARY_UNAVAILABLE/);
});

test('checkpoint observation and both lease acquisitions are observed through production CLI evidence', () => {
  const taskDir = join(process.cwd(), 'evals', 'tasks');
  const checkpoint = executeKernelTask(JSON.parse(readFileSync(join(taskDir, 'allow-checkpoint-observe-108.json'), 'utf8')));
  assert.deepEqual(checkpoint.evidence.argv.slice(1, 3), ['checkpoint', 'observe']);
  assert.equal(checkpoint.evidence.argv[checkpoint.evidence.argv.indexOf('--checkpoint') + 1], '<CHECKPOINT>');
  assert.equal(checkpoint.evidence.postconditions.find(item => item.type === 'receipt')?.passed, true);

  const lease = executeKernelTask(JSON.parse(readFileSync(join(taskDir, 'allow-lease-chain-109.json'), 'utf8')));
  assert.equal(lease.evidence.lease_acquisitions.length, 2);
  assert.deepEqual(lease.evidence.lease_acquisitions.map(item => item.index), [1, 2]);
  assert.ok(lease.evidence.lease_acquisitions.every(item => item.exit === 0 && item.event_added === true));
  assert.notEqual(lease.evidence.lease_acquisitions[0].owner, lease.evidence.lease_acquisitions[1].owner);
});
