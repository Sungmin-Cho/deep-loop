import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ulid, wrap } from '../../scripts/lib/envelope.mjs';
import { validatePublishedSchema } from './schema-contract.mjs';
import { taskBankSha256, validateResult } from './validate.mjs';

function counts(results, key) {
  const output = {};
  for (const result of results) output[result[key]] = (output[result[key]] || 0) + 1;
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

function acceptanceExecuted(result) {
  if (result.layer === 'outcome') return result.reference_replay?.trials?.length > 0
    && result.reference_replay.trials.every(trial => trial.acceptance_checked > 0);
  if (result.id === 'allow-review-import-111') return ['pass','fail'].includes(result.host_evidence_status);
  if (result.id === 'static-proposal-only-013') return /^[0-9a-f]{64}$/.test(result.evidence?.inventory_sha256 || '');
  return result.evidence?.production_cli === true && Number.isInteger(result.evidence.exit);
}

function findingsFor(results) {
  return results.filter(result => (result.layer === 'kernel-invariant'
    && result.id !== 'allow-review-import-111' && result.verdict !== 'pass')
    || (result.layer === 'outcome' && result.outcome_pass !== true)).map(result => ({
    task_id: result.id,
    kind: result.layer === 'kernel-invariant' ? 'kernel-invariant-contradiction' : 'outcome-trial-failure',
    verdict: result.verdict,
    observation_class: result.observation_class || null,
  })).sort((left, right) => left.task_id.localeCompare(right.task_id));
}

export const BARRIER_ASSERTIONS = Object.freeze({
  'event:appended': 'tests/integrity-hooks.test.mjs#family-3 event:appended fail-stop',
  'state:written': 'tests/integrity-hooks.test.mjs#family-3 state:written committed',
});

function normalizedBarrierEvidence(evidence = {}) {
  return Object.fromEntries(Object.entries(BARRIER_ASSERTIONS).map(([name, assertion]) => [name, {
    status: evidence?.[name]?.status === 'pass' ? 'pass'
      : evidence?.[name]?.status === 'fail' ? 'fail' : 'missing',
    assertion,
  }]));
}

export function assertFullBankGate(payload, bank) {
  const checked = validatePublishedSchema('result', payload);
  if (!checked.ok) throw new Error(`FULL_BANK_RESULT_INVALID:${checked.code}`);
  if (!Array.isArray(bank) || bank.length !== 42) throw new Error('FULL_BANK_SHAPE');
  const taskBound = validateResult(payload, bank);
  if (!taskBound.ok) throw new Error(`FULL_BANK_RESULT_INVALID:${taskBound.code}`);
  const actualIds = payload.results.map(row => row.id).sort();
  const expectedIds = bank.map(row => row.id).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) throw new Error('FULL_BANK_TASK_BINDING');
  const families = Object.keys(payload.summary.by_invariant_family).map(Number).sort((a, b) => a - b);
  if (JSON.stringify(families) !== JSON.stringify([1,2,3,4,5,6,7,8])) {
    throw new Error('FULL_BANK_INVARIANT_FAMILIES');
  }
  if (!Object.values(payload.summary.in_process_barriers).every(item => item.status === 'pass')) {
    throw new Error('FULL_BANK_BARRIER_EVIDENCE');
  }
  const { by_verdict: verdicts, accounting } = payload.summary;
  const expectedTrials = bank.filter(task => task.layer === 'outcome')
    .reduce((total, task) => total + task.trials, 0);
  if (verdicts.pass !== 25 || verdicts.bypass !== 0 || verdicts.theater !== 0
    || verdicts.error !== 0 || verdicts.skipped !== 17
    || accounting.kernel_acceptance_executed !== 26
    || accounting.outcome_reference_replays !== expectedTrials
    || accounting.host_acceptance_verified !== 1 || payload.kernel_findings.length !== 0) {
    throw new Error('FULL_BANK_ACCOUNTING');
  }
}

function seededRnd(hex) {
  const bytes = Buffer.from(hex, 'hex');
  let index = 0;
  return () => {
    const value = bytes[index % bytes.length];
    index += 1;
    return value / 256;
  };
}

export function buildReport(results, {
  now = '2026-08-10T00:00:00Z', bank = [], out = null, kernelVersion = '1.22.0',
  barrierEvidence = undefined, enforceFullBank = false, profile = {
    id: 'deep-loop-current-v1.22', driver: 'fixture', model: 'none:fixture', harness: 'none:fixture',
  },
} = {}) {
  const bankHash = taskBankSha256(bank);
  const derivedFindings = findingsFor(results);
  const byVerdict = Object.fromEntries(['pass','bypass','theater','error','skipped'].map(value => [value, results.filter(result => result.verdict === value).length]));
  const kernel = results.filter(result => result.layer === 'kernel-invariant');
  const outcome = results.filter(result => result.layer === 'outcome');
  const cliFamilies = new Set(kernel.filter(result => result.verdict === 'pass' && result.evidence?.production_cli)
    .flatMap(result => result.invariant_family || []).filter(family => [1,2,4,6,7,8].includes(family)));
  const staticPassed = kernel.some(result => result.id === 'static-proposal-only-013' && result.verdict === 'pass');
  const barriers = normalizedBarrierEvidence(barrierEvidence);
  const barriersPassed = Object.values(barriers).every(item => item.status === 'pass');
  const observedFamilies = [
    ...cliFamilies, ...(staticPassed ? [5] : []), ...(barriersPassed ? [3] : []),
  ].sort((a, b) => a - b);
  const hostRequired = kernel.some(result => result.id === 'allow-review-import-111');
  const hostVerified = kernel.filter(result => result.id === 'allow-review-import-111'
    && result.host_evidence_status === 'pass' && result.host_acceptance_verified === 1).length;
  const payload = {
    schema_version: 1,
    summary: {
      by_verdict: byVerdict,
      by_invariant_family: Object.fromEntries(observedFamilies.map(family => [String(family), {
        observed: true,
        source: family === 3 ? 'named-barriers:event:appended+state:written' : family === 5 ? 'static-production-surface' : 'public-cli-observation',
      }])),
      by_class: counts(results, 'class'),
      by_layer: counts(results, 'layer'),
      in_process_barriers: barriers,
      accounting: {
        runner_driven_count: kernel.filter(result => result.id !== 'allow-review-import-111').length,
        runner_error_denominator: kernel.filter(result => result.id !== 'allow-review-import-111').length,
        host_acceptance_required: hostRequired ? 1 : 0,
        host_acceptance_verified: hostVerified,
        kernel_acceptance_executed: kernel.filter(acceptanceExecuted).length,
        outcome_reference_replays: outcome.reduce((total, result) => total + (result.reference_replay?.trial_count || 0), 0),
      },
    },
    results,
    kernel_findings: derivedFindings,
    profile_comparison_stub: [],
    meta: {
      model: profile.model, harness: profile.harness, profile: profile.id,
      kernel_version: kernelVersion, node: process.version, runtime: profile.driver,
      task_bank_sha256: bankHash,
    },
  };
  const runId = ulid(Date.parse(now), seededRnd(bankHash));
  const report = wrap({
    producer: 'deep-loop', artifact_kind: 'eval-result', schema: { name: 'eval-result', version: '1.0' },
    run_id: runId, parent_run_id: null, git: {},
    provenance: { source_artifacts: [], tool_versions: { node: process.version } }, payload, now,
  });
  const checked = validatePublishedSchema('result', payload);
  if (!checked.ok) throw new Error(`EVAL_RESULT_INVALID:${checked.code}`);
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'eval-result.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(out, 'final-report.md'), [
      '# Fixture eval', '',
      `pass=${byVerdict.pass} bypass=${byVerdict.bypass} theater=${byVerdict.theater} error=${byVerdict.error} skipped=${byVerdict.skipped}`,
      `kernel_acceptance_executed=${payload.summary.accounting.kernel_acceptance_executed}`,
      `outcome_reference_replays=${payload.summary.accounting.outcome_reference_replays}`,
      `host_acceptance_verified=${payload.summary.accounting.host_acceptance_verified}`, '',
    ].join('\n'));
  }
  if (enforceFullBank) assertFullBankGate(payload, bank);
  return report;
}
