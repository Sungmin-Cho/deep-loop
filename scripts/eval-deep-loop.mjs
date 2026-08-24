#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeKernelTask, seedHostTopology } from '../evals/lib/scenarios.mjs';
import { runAllowReviewImport111, validateHostAcceptanceResult, HOST_TASK_ID } from '../evals/lib/host-acceptance.mjs';
import { materializeFixture, materializeOutcomeSupport, applyReference } from '../evals/lib/fixture.mjs';
import { gradeEndState } from '../evals/graders/end-state.grader.mjs';
import { gradeForbiddenEffects } from '../evals/lib/effects.mjs';
import { gradeStaticAssertion } from '../evals/graders/static-assertion.grader.mjs';
import { verdict } from '../evals/graders/verdict.mjs';
import { BARRIER_ASSERTIONS, buildReport } from '../evals/lib/report.mjs';
import { normalize } from '../evals/lib/normalize.mjs';
import { validateProfile, validateTask } from '../evals/lib/validate.mjs';
import { validatePublishedSchema } from '../evals/lib/schema-contract.mjs';
import { evalChildEnv } from '../evals/lib/child-env.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_NOW = '2026-08-10T00:00:00Z';

function flags(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`UNKNOWN_ARGUMENT:${token}`);
    const name = token.slice(2);
    if (!['mode','task','out','report','now'].includes(name) || Object.hasOwn(output, name)) throw new Error(`UNKNOWN_OR_DUPLICATE_OPTION:${token}`);
    if (name === 'report') output[name] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`OPTION_VALUE_REQUIRED:${token}`);
      output[name] = value;
    }
  }
  return output;
}

function loadTasks(taskId) {
  const files = readdirSync(join(ROOT, 'evals', 'tasks')).filter(file => file.endsWith('.json')).sort();
  const tasks = files.map(file => JSON.parse(readFileSync(join(ROOT, 'evals', 'tasks', file), 'utf8')))
    .filter(task => !taskId || task.id === taskId)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (tasks.length === 0) throw new Error('NO_TASKS');
  for (const task of tasks) {
    const checked = validatePublishedSchema('task', task);
    if (!checked.ok) throw new Error(`${checked.code}:${task.id}`);
  }
  return tasks;
}

export function loadFixtureProfile(file = join(ROOT, 'evals', 'profiles', 'deep-loop-current-v1.22.json')) {
  let profile;
  try { profile = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`PROFILE_LOAD_FAILED:${error.code || error.message}`); }
  const checked = validatePublishedSchema('profile', profile);
  const kernelVersion = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const expectedId = `deep-loop-current-v${kernelVersion.split('.').slice(0, 2).join('.')}`;
  if (!checked.ok || profile.driver !== 'fixture' || profile.id !== expectedId
    || profile.model !== 'none:fixture' || profile.harness !== 'none:fixture') {
    throw new Error(`PROFILE_INVALID:${checked.code || 'IDENTITY_OR_VERSION'}`);
  }
  return profile;
}

function snapshotFiles(root, relative = '') {
  const output = {};
  const directory = join(root, relative);
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (relative === '' && entry.name === '.eval') continue;
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const path = join(root, rel);
    if (entry.isDirectory()) Object.assign(output, snapshotFiles(root, rel));
    else if (entry.isFile()) output[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return output;
}

function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => before[path] !== after[path]).sort();
}

function referenceHash(root, copied) {
  const hash = createHash('sha256');
  for (const path of [...copied].sort()) hash.update(path).update('\0').update(readFileSync(join(root, path)));
  return hash.digest('hex');
}

function executeHost(task, now) {
  const seeded = seedHostTopology(task, { now });
  const raw = runAllowReviewImport111({
    projectRoot: seeded.context.root, runId: seeded.context.runId,
    fence: seeded.context.fence, workstreamId: seeded.workstreamId,
  });
  const checked = validateHostAcceptanceResult(task, raw, seeded.expectedBinding);
  if (!checked.ok) throw new Error(`HOST_ACCEPTANCE_INVALID:${checked.reason}`);
  return {
    id: task.id, layer: task.layer, class: task.class, verdict: 'skipped',
    observation_class: 'expected_success', skip_reason: 'host-acceptance',
    host_evidence_ref: task.host_acceptance.evidence_ref, host_evidence_status: 'pass',
    host_acceptance_verified: 1, acceptance_executed: true, invariant_family: task.invariant_family,
    host_binding: normalize(checked.value, { runId: seeded.context.runId, root: seeded.context.root }),
  };
}

export function executeOutcome(task, { observedEffectsByTrial = [], profile = loadFixtureProfile() } = {}) {
  const trials = [];
  for (let index = 0; index < task.trials; index += 1) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'deep-loop-outcome-')));
    const fixtureFiles = materializeFixture(root, task, { repoRoot: ROOT });
    materializeOutcomeSupport(root, task, { repoRoot: ROOT });
    const before = snapshotFiles(root);
    const replay = applyReference(root, task, { repoRoot: ROOT, trialIndex: index });
    const after = snapshotFiles(root);
    const changed = changedFiles(before, after);
    const grade = gradeEndState(root, task.acceptance, { profile, forbiddenEffects: task.forbidden_effects });
    const injectedEffects = observedEffectsByTrial[index];
    const effects = gradeForbiddenEffects(task.forbidden_effects, {
      schema_version: 1,
      source: injectedEffects === undefined ? 'fixture-isolation-receipt' : 'agent-effect-receipt',
      observed_effects: injectedEffects === undefined ? grade.effect_receipt.observed_effects : injectedEffects,
    });
    const noOpSatisfied = task.id !== 'outcome-noop-212' || changed.length === 0;
    trials.push({
      index: index + 1, variant: replay.variant,
      fixture_files_materialized: fixtureFiles.length,
      reference_files_materialized: replay.copied.length,
      acceptance_checked: grade.checked,
      acceptance_pass: grade.pass && effects.pass && noOpSatisfied,
      distinct_reference_sha256: referenceHash(root, replay.copied),
      changed_files: changed,
      isolation_receipt: {
        schema_version: grade.effect_receipt.schema_version,
        boundary: grade.effect_receipt.boundary,
        covered_effects: grade.effect_receipt.covered_effects,
        profile_id: grade.effect_receipt.profile_id,
        allowed_effects: grade.effect_receipt.allowed_effects,
        declared_command: grade.effect_receipt.declared_command,
        executed_argv: grade.effect_receipt.executed_argv,
        exit: grade.effect_receipt.exit,
        timed_out: grade.effect_receipt.timed_out,
        observed_effects: grade.effect_receipt.observed_effects,
        passed: grade.effect_receipt.passed,
      },
      effect_observation: {
        schema_version: effects.schema_version, source: effects.source,
        forbidden_effects: effects.forbidden_effects, observed_effects: effects.observed_effects,
        violations: effects.violations, passed: effects.passed,
      },
    });
  }
  const passed = trials.length === task.trials && trials.every(trial => trial.acceptance_pass);
  return {
    id: task.id, layer: task.layer, class: task.class, verdict: 'skipped',
    skip_reason: 'requires-agent', outcome_pass: passed,
    acceptance_executed: trials.length > 0 && trials.every(trial => trial.acceptance_checked > 0),
    reference_replay: {
      trial_count: task.trials, trials, end_state_pass: passed,
    },
  };
}

function executeStatic(task) {
  const grade = gradeStaticAssertion(task.acceptance[0].assertion_id, ROOT);
  return {
    id: task.id, layer: task.layer, class: task.class,
    verdict: verdict(task.expectation, grade.observation_class),
    observation_class: grade.observation_class, invariant_family: task.invariant_family,
    acceptance_executed: /^[0-9a-f]{64}$/.test(grade.evidence?.inventory_sha256 || ''),
    evidence: {
      static_production_surface: true, assertion_id: task.acceptance[0].assertion_id,
      passed: grade.pass, ...grade.evidence,
    },
  };
}

function failureRow(task, error) {
  const code = String(error?.message || error || 'UNKNOWN_FAILURE').slice(0, 4096);
  if (task.id === HOST_TASK_ID) {
    return {
      id: task.id, layer: task.layer, class: task.class, verdict: 'skipped',
      observation_class: 'unexpected_failure', skip_reason: 'host-acceptance',
      host_evidence_ref: task.host_acceptance.evidence_ref, host_evidence_status: 'fail',
      host_acceptance_verified: 0, acceptance_executed: true,
      invariant_family: task.invariant_family, host_binding: null,
    };
  }
  if (task.layer === 'outcome') {
    return {
      id: task.id, layer: task.layer, class: task.class, verdict: 'skipped',
      skip_reason: 'requires-agent', outcome_pass: false, acceptance_executed: false,
      reference_replay: { trial_count: 1, trials: [{
        index: 1, variant: 'setup-failure', fixture_files_materialized: 0,
        reference_files_materialized: 0, acceptance_checked: 0, acceptance_pass: false,
        distinct_reference_sha256: '0'.repeat(64), changed_files: [],
        isolation_receipt: null,
        effect_observation: {
          schema_version: 1, source: 'fixture-isolation-receipt', forbidden_effects: task.forbidden_effects,
          observed_effects: [], violations: [], passed: true,
        },
      }], end_state_pass: false },
    };
  }
  return {
    id: task.id, layer: task.layer, class: task.class, verdict: 'error',
    observation_class: 'unexpected_failure', invariant_family: task.invariant_family,
    acceptance_executed: false, evidence: { scenario_failure: true, code },
  };
}

export function executeFixtureTask(task, {
  now = DEFAULT_NOW, profile = loadFixtureProfile(), kernelExecutor = executeKernelTask,
} = {}) {
  try {
    if (task.id === HOST_TASK_ID) return executeHost(task, now);
    if (task.layer === 'outcome') return executeOutcome(task, { profile });
    if (task.acceptance.length === 1 && task.acceptance[0].type === 'static-assertion') return executeStatic(task);
    const result = kernelExecutor(task, { now });
    return {
      ...result,
      acceptance_executed: result.evidence?.production_cli === true && Number.isInteger(result.evidence.exit),
    };
  } catch (error) {
    return failureRow(task, error);
  }
}

export function runFamily3BarrierEvidence() {
  const file = join(ROOT, 'tests', 'integrity-hooks.test.mjs');
  const env = evalChildEnv();
  delete env.NODE_TEST_CONTEXT;
  return Object.fromEntries(Object.entries(BARRIER_ASSERTIONS).map(([name, assertion]) => {
    const testName = assertion.slice(assertion.indexOf('#') + 1);
    const proc = spawnSync(process.execPath, [
      '--test', '--test-reporter=tap', '--test-name-pattern',
      `^${testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, file,
    ], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 });
    const output = `${String(proc.stdout || '')}\n${String(proc.stderr || '')}`;
    const executed = output.includes(`# Subtest: ${testName}`)
      && new RegExp(`(?:^|\\n)ok \\d+ - ${testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\n|$)`).test(output)
      && /# pass 1(?:\n|$)/.test(output) && /# fail 0(?:\n|$)/.test(output);
    return [name, { status: proc.status === 0 && executed ? 'pass' : 'fail', assertion }];
  }));
}

export function runFixtureEvaluation({ taskId = null, out = null, now = DEFAULT_NOW } = {}) {
  const tasks = loadTasks(taskId);
  const profile = loadFixtureProfile();
  const fullBank = taskId === null;
  const barrierEvidence = fullBank ? runFamily3BarrierEvidence() : undefined;
  const results = tasks.map(task => executeFixtureTask(task, { now, profile }));
  const kernelVersion = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  return buildReport(results, {
    now, bank: tasks, out: out ? resolve(out) : null, barrierEvidence,
    enforceFullBank: fullBank, profile, kernelVersion,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = flags(argv);
  const mode = options.mode || 'fixture';
  if (mode !== 'fixture') {
    process.stderr.write('NOT_IMPLEMENTED: only fixture mode is available\n');
    return 2;
  }
  const selectedOut = options.out || (options.report ? join(ROOT, 'evals', 'results', 'local') : null);
  const report = runFixtureEvaluation({ taskId: options.task || null, out: selectedOut, now: options.now || DEFAULT_NOW });
  const verdicts = report.payload.summary.by_verdict;
  const accounting = report.payload.summary.accounting;
  process.stdout.write(`verdicts: pass=${verdicts.pass} bypass=${verdicts.bypass} theater=${verdicts.theater} error=${verdicts.error} skipped=${verdicts.skipped} kernel_acceptance_executed=${accounting.kernel_acceptance_executed} outcome_reference_replays=${accounting.outcome_reference_replays} host_acceptance_verified=${accounting.host_acceptance_verified}\n`);
  return report.payload.kernel_findings.length === 0 ? 0 : 1;
}

// `process.argv[1]` is a native Windows path, while import.meta.url is always a
// URL. Comparing the POSIX spelling directly makes the Windows child exit 0
// without running the driver or writing its report.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}
