import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateTask, validateResult, validateProfile, STEP_VOCAB } from '../../evals/lib/validate.mjs';
import { validateJsonSchemaOnly } from '../../evals/lib/schema-contract.mjs';

const common = (overrides = {}) => ({
  schema_version: 1, id: 'task-1', class: 'lease-recovery', layer: 'kernel-invariant',
  prompt: 'exercise the kernel', fixture: null, expectation: 'must-block',
  acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate'], expect: { exit: 1, stderr_includes: 'STATE_TAMPERED' } }] }],
  forbidden_effects: [], grader_policy: { grade_end_state: true, require_specific_tool_order: false, allow_unlisted_valid_strategy: true },
  trials: 1, requires: 'none', host_acceptance: null, fixture_actions: [], invariant_family: [3], held_out: false,
  drive: 'cli', cli_gap: null, ...overrides,
});

test('validateTask accepts both task layers and the closed host/tamper contracts', () => {
  assert.equal(validateTask(common()).ok, true);
  assert.equal(validateTask(common({ layer: 'outcome', class: 'valid-alternative-path', expectation: 'outcome-only', fixture: 'evals/fixtures/t', reference_solution: 'evals/fixtures/t/reference', acceptance: [{ type: 'command', command: ['node', '--test'] }], requires: 'agent', invariant_family: [] })).ok, true);
  assert.equal(validateTask(common({ id: 'allow-review-import-111', requires: 'host-acceptance', host_acceptance: { path: 'evals/lib/host-acceptance.mjs', named_assertion: 'allow-review-import-111', evidence_ref: 'tests/review-import.test.mjs#allow-review-import-111' }, acceptance: [{ type: 'host-acceptance' }] })).ok, true);
  assert.equal(validateTask(common({ fixture_actions: [{ type: 'tamper', target: 'loop.json', operation: 'flip-byte', offset: 0 }] })).ok, true);
});

test('validateTask is default-deny for commands, placeholders, gates, actions, and unknown keys', () => {
  for (const task of [
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['rm', '-rf', '/'], expect: { exit: 0 } }] }] }),
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate', '<UNREGISTERED>'], expect: { exit: 1, stderr_includes: 'x' } }] }] }),
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate'], expect: { exit: 2 } }] }] }),
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate'], expect: {} }] }] }),
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate', '<CHECKPOINT>'], expect: { exit: 1, stderr_includes: 'x' } }] }] }),
    common({ fixture_actions: [{ type: 'write', target: 'loop.json', operation: 'flip-byte', offset: 0 }] }),
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate'], expect: { exit: 1, stderr_includes: 'x', invented: true } }] }] }),
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate'], expect: { exit: 1, stderr_includes: 'x' }, invented: true }] }] }),
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate'] }] }] }),
    common({ forbidden_effects: ['push', 'push'] }),
    common({ acceptance: [{ type: 'static-assertion', assertion_id: 'no-external-action-routes', invented: true }] }),
    { ...common(), extra: true },
  ]) assert.equal(validateTask(task).ok, false);
  assert.ok(STEP_VOCAB.includes('validate'));
});

test('task JSON schema carries the same fail-closed layer, host, drive, and gate conditionals', () => {
  const schema = JSON.parse(readFileSync(join(process.cwd(), 'schemas', 'eval-task.schema.json'), 'utf8'));
  assert.ok(Array.isArray(schema.allOf));
  const text = JSON.stringify(schema.allOf);
  for (const token of ['must-block', 'must-escalate', 'host-acceptance', 'kernel-invariant', 'outcome', 'cli_gap']) {
    assert.match(text, new RegExp(token));
  }
  assert.equal(schema.$defs.acceptance.oneOf[0].properties.steps.maxItems, 1);
  assert.deepEqual(schema.$defs.expect.required, ['exit']);
});

test('validateResult requires the five verdicts and seven metadata fields', () => {
  const result = {
    schema_version: 1,
    summary: {
      by_verdict: { pass: 0, bypass: 0, theater: 0, error: 0, skipped: 1 },
      by_invariant_family: {}, by_class: { 'valid-alternative-path': 1 }, by_layer: { outcome: 1 },
      in_process_barriers: {
        'event:appended': { status: 'missing', assertion: 'tests/integrity-hooks.test.mjs#family-3 event:appended fail-stop' },
        'state:written': { status: 'missing', assertion: 'tests/integrity-hooks.test.mjs#family-3 state:written committed' },
      },
      accounting: {
        runner_driven_count: 0, runner_error_denominator: 0, host_acceptance_required: 0,
        host_acceptance_verified: 0, kernel_acceptance_executed: 0, outcome_reference_replays: 1,
      },
    },
    results: [{
      id: 'outcome-valid-alternative-211', layer: 'outcome', class: 'valid-alternative-path',
      verdict: 'skipped', skip_reason: 'requires-agent', outcome_pass: true,
      acceptance_executed: true,
      reference_replay: {
        trial_count: 1,
        trials: [{
          index: 1, variant: 'reference', fixture_files_materialized: 1,
          reference_files_materialized: 1, acceptance_checked: 1,
          acceptance_pass: true, distinct_reference_sha256: '0'.repeat(64),
          changed_files: ['solution.json'],
          isolation_receipt: {
            schema_version: 1, boundary: 'node-permission-model:permission',
            covered_effects: ['child-process','file-write','network-write'], profile_id: 'deep-loop-current-v1.22',
            allowed_effects: ['read-only'], declared_command: ['node','--test','.eval/verify-outcome.test.mjs'],
            executed_argv: ['--permission','.eval/verify-outcome.test.mjs'], exit: 0, timed_out: false,
            observed_effects: [], passed: true,
          },
          effect_observation: {
            schema_version: 1, source: 'fixture-controlled-replay', forbidden_effects: [],
            observed_effects: [], violations: [], passed: true,
          },
        }],
        end_state_pass: true,
      },
    }],
    kernel_findings: [],
    profile_comparison_stub: [],
    meta: { model: 'none:fixture', harness: 'none:fixture', profile: 'deep-loop-current-v1.22', kernel_version: '1.22.0', node: 'v26', runtime: 'fixture', task_bank_sha256: '0'.repeat(64) },
  };
  assert.equal(validateResult(result).ok, true);
  assert.equal(validateResult({ ...result, results: [{ verdict: 'nope' }] }).ok, false);
  assert.equal(validateResult({ ...result, meta: { ...result.meta, runtime: undefined } }).ok, false);
  assert.equal(validateResult({ ...result, summary: {} }).ok, false);
  assert.equal(validateResult({ ...result, summary: { ...result.summary, invented: 1 } }).ok, false);
  assert.equal(validateResult({ ...result, summary: { ...result.summary, accounting: { ...result.summary.accounting, invented: 1 } } }).ok, false);
  assert.equal(validateResult({ ...result, results: [{}] }).ok, false);
  assert.equal(validateResult({ ...result, results: [{ ...result.results[0], invented: true }] }).ok, false);
  assert.equal(validateResult({ ...result, extra: true }).ok, false);
});

test('host status, row verification, and summary accounting are equivalent by construction', () => {
  const base = {
    schema_version: 1,
    summary: {
      by_verdict: { pass: 0, bypass: 0, theater: 0, error: 0, skipped: 1 },
      by_invariant_family: {}, by_class: { review: 1 }, by_layer: { 'kernel-invariant': 1 },
      in_process_barriers: {
        'event:appended': { status: 'missing', assertion: 'tests/integrity-hooks.test.mjs#family-3 event:appended fail-stop' },
        'state:written': { status: 'missing', assertion: 'tests/integrity-hooks.test.mjs#family-3 state:written committed' },
      },
      accounting: { runner_driven_count: 0, runner_error_denominator: 0, host_acceptance_required: 1, host_acceptance_verified: 0, kernel_acceptance_executed: 1, outcome_reference_replays: 0 },
    },
    results: [{
      id: 'allow-review-import-111', layer: 'kernel-invariant', class: 'review', verdict: 'skipped',
      observation_class: 'unexpected_failure', skip_reason: 'host-acceptance',
      host_evidence_ref: 'tests/review-import.test.mjs#allow-review-import-111',
      host_evidence_status: 'fail', host_acceptance_verified: 0, acceptance_executed: true,
      invariant_family: [4], host_binding: null,
    }],
    kernel_findings: [], profile_comparison_stub: [],
    meta: { model: 'none:fixture', harness: 'none:fixture', profile: 'deep-loop-current-v1.22', kernel_version: '1.22.0', node: 'v26', runtime: 'fixture', task_bank_sha256: '0'.repeat(64) },
  };
  assert.equal(validateResult(base).ok, true);
  const launderedRow = structuredClone(base);
  launderedRow.results[0].host_acceptance_verified = 1;
  assert.equal(validateResult(launderedRow).ok, false);
  const launderedSummary = structuredClone(base);
  launderedSummary.summary.accounting.host_acceptance_verified = 1;
  assert.equal(validateResult(launderedSummary).ok, false);
});

test('profile runtime contract is exact and default-deny', () => {
  const profile = {
    id: 'deep-loop-current-v1.22', driver: 'fixture', model: 'none:fixture',
    harness: 'none:fixture', allowed_effects: ['read-only'],
    record: { transcript: false, observables: ['exit', 'effects'] },
  };
  assert.equal(validateProfile(profile).ok, true);
  assert.equal(validateProfile({ ...profile, name: profile.id }).ok, false);
  assert.equal(validateProfile({ ...profile, allowed_effects: ['kernel-cli'] }).ok, false);
  assert.equal(validateProfile({ ...profile, record: 'summary' }).ok, false);
  assert.equal(validateProfile({ ...profile, record: { transcript: false, observables: ['exit'] } }).ok, false);
});

test('outcome commands are a closed safe Node-test contract', () => {
  const outcome = overrides => common({
    layer: 'outcome', class: 'valid-alternative-path', expectation: 'outcome-only',
    fixture: 'evals/fixtures/t', reference_solution: 'evals/fixtures/t/reference',
    acceptance: [{ type: 'command', command: ['node', '--test', '.eval/verify-outcome.test.mjs'] }],
    requires: 'agent', invariant_family: [], ...overrides,
  });
  assert.equal(validateTask(outcome()).ok, true);
  for (const command of [
    ['git', 'push', 'origin', 'main'], ['curl', 'https://example.invalid'],
    ['sh', '-c', 'git push'], ['/usr/bin/node', '--test', '.eval/verify-outcome.test.mjs'],
    ['node', '-e', 'process.exit(0)'],
  ]) {
    assert.equal(validateTask(outcome({ acceptance: [{ type: 'command', command }] })).ok, false, command.join(' '));
  }
});

test('published schemas execute against the same positive and negative contract vectors', async () => {
  const { validatePublishedSchema } = await import('../../evals/lib/schema-contract.mjs');
  const validTask = common();
  const badTask = common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate'], expect: { exit: 2 } }] }] });
  for (const value of [validTask, badTask]) {
    assert.equal(validatePublishedSchema('task', value).ok, validateTask(value).ok);
  }
  const profile = JSON.parse(readFileSync(join(process.cwd(), 'evals', 'profiles', 'deep-loop-current-v1.22.json'), 'utf8'));
  const spoof = { ...profile, id: 'host-native', model: 'spoof', harness: 'spoof' };
  for (const value of [profile, spoof]) {
    assert.equal(validatePublishedSchema('profile', value).ok, validateProfile(value).ok);
  }
});

test('published task schema independently rejects closed commands, placeholders, sizes, and lexical path escapes', () => {
  const outcomeWithStatePath = path => common({
    layer: 'outcome', class: 'valid-alternative-path', expectation: 'outcome-only',
    fixture: 'evals/fixtures/t', reference_solution: 'evals/fixtures/t/reference',
    acceptance: [{ type: 'state', path, pointer: '/ok', equals: true }],
    requires: 'agent', invariant_family: [],
  });
  const vectors = [
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['rm', '-rf', '/'], expect: { exit: 1, stderr_includes: 'x' } }] }] }),
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate', '<UNREGISTERED>'], expect: { exit: 1, stderr_includes: 'x' } }] }] }),
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate'], stdin: { inline_json: { payload: 'x'.repeat(70 * 1024) } }, expect: { exit: 1, stderr_includes: 'x' } }] }] }),
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate'], stdin: { fixture_path: '' }, expect: { exit: 1, stderr_includes: 'x' } }] }] }),
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate'], stdin: { fixture_path: '../escape.json' }, expect: { exit: 1, stderr_includes: 'x' } }] }] }),
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate'], setup_files: [{ path: '/absolute.txt', content: 'x' }], expect: { exit: 1, stderr_includes: 'x' } }] }] }),
    common({ acceptance: [{ type: 'kernel-invariant', steps: [{ cmd: ['validate'], setup_files: [{ path: 'a/../escape.txt', content: 'x' }], expect: { exit: 1, stderr_includes: 'x' } }] }] }),
    outcomeWithStatePath('../escape.json'),
  ];
  for (const value of vectors) {
    assert.equal(validateTask(value).ok, false);
    assert.equal(validateJsonSchemaOnly('task', value).ok, false);
  }
  assert.equal(validateJsonSchemaOnly('task', common()).ok, true);
  assert.equal(validateTask(outcomeWithStatePath('state/result.json')).ok, true);
  assert.equal(validateJsonSchemaOnly('task', outcomeWithStatePath('state/result.json')).ok, true);
});

test('kernel acceptance is exactly one executable axis and cannot hide ignored declarations', () => {
  const task = common({ acceptance: [
    { type: 'kernel-invariant', steps: [{ cmd: ['validate'], expect: { exit: 1, stderr_includes: 'STATE_TAMPERED' } }] },
    { type: 'static-assertion', assertion_id: 'no-external-action-routes' },
  ] });
  assert.equal(validateTask(task).ok, false);
  assert.equal(validateJsonSchemaOnly('task', task).ok, false);
});
