import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { claimIndependentReview, dispatchReview, importReviewOutcome, recordReviewOutcome } from '../scripts/lib/review.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { recordCost } from '../scripts/lib/budget.mjs';
import { finishRun } from '../scripts/lib/finish.mjs';
import { verifyHead, verifyLog } from '../scripts/lib/integrity.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';
import { REVIEW_IMPORT_MAX_BYTES } from '../scripts/lib/bounded-input.mjs';
import { runAllowReviewImport111, validateHostAcceptanceResult } from '../evals/lib/host-acceptance.mjs';
import {
  REVIEW_IMPORT_MAX_ARTIFACTS,
  REVIEW_REPORT_BODY_MAX_BYTES,
  parseReviewImport,
} from '../scripts/lib/review-import.mjs';
import {
  createDirectoryJunction,
  createFileSymlinkOrSkip,
} from './helpers/fs-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'scripts', 'deep-loop.mjs');
const SHA0 = '0'.repeat(64);
const FIXED_NOW = '2026-07-10T12:00:00.000Z';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const eventLog = (root, runId) => {
  const path = join(runDir(root, runId), 'event-log.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
};

test('allow-review-import-111: fixed host executor threads claimed attempt into bounded CLI import', () => {
  const f = fixtureWithoutChecker();
  const result = runAllowReviewImport111({ projectRoot: realpathSync(f.root), runId: f.runId, fence: f.fence, workstreamId: f.ws });
  assert.equal(result.status, 'pass');
  assert.equal(result.attempt_id, 'attempt-eval-111');
  assert.equal(result.binding.review_source, 'imported-stdin');
  const task = { id: 'allow-review-import-111', host_acceptance: { evidence_ref: 'tests/review-import.test.mjs#allow-review-import-111' } };
  const expected = {
    run_id: f.runId, checker_episode_id: '002-deep-review', target_maker: '001-deep-work',
    workstream_id: f.ws, point: 'implementation', reviewer_id: 'deep-review',
    review_source: 'imported-stdin', imported_verdict: 'APPROVE',
  };
  const validation = validateHostAcceptanceResult(task, result, expected);
  assert.equal(validation.ok, true, JSON.stringify({ result, expected, validation }));
});

test('allow-review-import-111 validates against an independently derived topology expectation, never result.binding itself', () => {
  const f = fixtureWithoutChecker();
  const expected = {
    run_id: f.runId,
    checker_episode_id: '002-deep-review',
    target_maker: '001-deep-work',
    workstream_id: f.ws,
    point: 'implementation',
    reviewer_id: 'deep-review',
    review_source: 'imported-stdin',
    imported_verdict: 'APPROVE',
  };
  const task = {
    id: 'allow-review-import-111',
    host_acceptance: { evidence_ref: 'tests/review-import.test.mjs#allow-review-import-111' },
  };
  const result = runAllowReviewImport111({ projectRoot: realpathSync(f.root), runId: f.runId, fence: f.fence, workstreamId: f.ws });
  const validation = validateHostAcceptanceResult(task, result, expected);
  assert.equal(validation.ok, true, JSON.stringify({ result, expected, validation }));
  const selfConsistentButWrong = {
    ...result,
    binding: { ...result.binding, target_maker: '999-spoof' },
  };
  assert.equal(validateHostAcceptanceResult(task, selfConsistentButWrong, expected).ok, false);
});

function validImport(overrides = {}) {
  return {
    schema_version: '1.0',
    reviewer_id: 'deep-review',
    checker_episode_id: '002-deep-review',
    target_maker: '001-deep-work',
    attempt_id: 'attempt-01',
    verdict: 'APPROVE',
    report_body: '# independent review\n\nAPPROVE',
    artifacts: [{ path: '.claude/worktrees/w/artifact.txt', sha256: SHA0 }],
    ...overrides,
  };
}

function fixture({ runtime = 'codex', detected = { 'deep-review': true }, artifactRel = '.claude/worktrees/w/artifact.txt', artifactBytes = Buffer.from('maker artifact'), claim = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-review-import-'));
  const { runId } = initRun(root, { runtime, goal: 'g', detected, now: new Date('2026-07-10T00:00:00Z') });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const worktree = '.claude/worktrees/w';
  mkdirSync(join(root, worktree), { recursive: true });
  const ws = newWorkstream(root, runId, { title: 'w', branch: 'b', worktree, fence }).id;
  mkdirSync(dirname(join(root, artifactRel)), { recursive: true });
  writeFileSync(join(root, artifactRel), artifactBytes);
  const makerId = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: [artifactRel], fence,
  }).id;
  recordEpisode(root, runId, makerId, { status: 'in_progress', fence });
  recordEpisode(root, runId, makerId, { status: 'done', artifacts: [artifactRel], fence });
  const checkerId = dispatchReview(root, runId, {
    point: 'implementation', workstreamId: ws, detected, independentSubagent: detected['deep-review'] !== true, fence,
  }).checkerEpisodeId;
  if (claim) claimIndependentReview(root, runId, {
    episodeId: checkerId, fence, attemptIdFactory: () => 'attempt-01', now: FIXED_NOW,
  });
  const reviewerId = readState(root, runId).data.episodes.find(e => e.id === checkerId).plugin;
  const input = {
    schema_version: '1.0', reviewer_id: reviewerId, checker_episode_id: checkerId,
    target_maker: makerId, attempt_id: 'attempt-01', verdict: 'APPROVE', report_body: '# independent review\n\nAPPROVE',
    artifacts: [{ path: artifactRel.replaceAll('\\', '/'), sha256: sha256(artifactBytes) }],
  };
  return { root, runId, fence, worktree, ws, makerId, checkerId, artifactRel, input };
}

function fixtureWithoutChecker({
  runtime = 'codex', detected = { 'deep-review': true },
  artifactRel = '.claude/worktrees/w/artifact.txt', artifactBytes = Buffer.from('maker artifact'),
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-review-import-host-'));
  const { runId } = initRun(root, {
    runtime, goal: 'g', detected, now: new Date('2026-07-10T00:00:00Z'),
  });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const worktree = '.claude/worktrees/w';
  mkdirSync(join(root, worktree), { recursive: true });
  const ws = newWorkstream(root, runId, { title: 'w', branch: 'b', worktree, fence }).id;
  mkdirSync(dirname(join(root, artifactRel)), { recursive: true });
  writeFileSync(join(root, artifactRel), artifactBytes);
  const makerId = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: [artifactRel], fence,
  }).id;
  recordEpisode(root, runId, makerId, { status: 'in_progress', fence });
  recordEpisode(root, runId, makerId, { status: 'done', artifacts: [artifactRel], fence });
  return { root, runId, fence, worktree, ws, makerId, artifactRel };
}

test('review import schema artifact is exact and closed', () => {
  const schema = JSON.parse(readFileSync(join(HERE, '..', 'schemas', 'review-import.schema.json'), 'utf8'));
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['schema_version', 'reviewer_id', 'checker_episode_id', 'target_maker', 'attempt_id', 'verdict', 'report_body', 'artifacts']);
  assert.equal(schema.properties.attempt_id.maxLength, 128);
  assert.equal(schema.properties.attempt_id.pattern, '^[A-Za-z0-9][A-Za-z0-9._-]*$');
  assert.equal(schema.properties.schema_version.const, '1.0');
  assert.deepEqual(schema.properties.verdict.enum, ['APPROVE', 'REQUEST_CHANGES', 'CONCERN']);
  assert.equal(schema.properties.report_body.maxLength, REVIEW_REPORT_BODY_MAX_BYTES);
  assert.equal(schema.properties.artifacts.maxItems, REVIEW_IMPORT_MAX_ARTIFACTS);
  assert.equal(schema.properties.artifacts.items.additionalProperties, false);
  assert.equal(schema.properties.artifacts.items.properties.sha256.pattern, '^[0-9a-f]{64}$');
});

test('parseReviewImport pins body/artifact bounds and returns portable normalized paths', () => {
  assert.equal(REVIEW_REPORT_BODY_MAX_BYTES, 262_144);
  assert.equal(REVIEW_IMPORT_MAX_ARTIFACTS, 256);
  const atBodyLimit = validImport({
    report_body: 'a'.repeat(REVIEW_REPORT_BODY_MAX_BYTES),
    artifacts: [{ path: 'dir\\artifact.txt', sha256: SHA0 }],
  });
  assert.equal(parseReviewImport(JSON.stringify(atBodyLimit)).artifacts[0].path, 'dir/artifact.txt');
  assert.throws(() => parseReviewImport(JSON.stringify(validImport({ report_body: 'a'.repeat(REVIEW_REPORT_BODY_MAX_BYTES + 1) }))), /REVIEW_IMPORT_BODY_TOO_LARGE/);
  assert.doesNotThrow(() => parseReviewImport(JSON.stringify(validImport({ report_body: '€'.repeat(87_381) }))));
  assert.throws(() => parseReviewImport(JSON.stringify(validImport({ report_body: '€'.repeat(87_382) }))), /REVIEW_IMPORT_BODY_TOO_LARGE/);
  const maxArtifacts = Array.from({ length: REVIEW_IMPORT_MAX_ARTIFACTS }, (_, i) => ({ path: `a/${i}`, sha256: SHA0 }));
  assert.equal(parseReviewImport(JSON.stringify(validImport({ artifacts: maxArtifacts }))).artifacts.length, 256);
  assert.throws(() => parseReviewImport(JSON.stringify(validImport({ artifacts: [...maxArtifacts, { path: 'overflow', sha256: SHA0 }] }))), /REVIEW_IMPORT_ARTIFACTS_TOO_MANY/);
  const validRaw = JSON.stringify(validImport());
  assert.throws(() => parseReviewImport(validRaw + ' '.repeat(REVIEW_IMPORT_MAX_BYTES - Buffer.byteLength(validRaw) + 1)), /REVIEW_IMPORT_TOO_LARGE/);
});

test('parseReviewImport manually enforces exact keys, schema, types, enums, and lowercase hashes', () => {
  const invalid = [
    ['json', '{', /REVIEW_IMPORT_JSON_INVALID/],
    ['top-level array', JSON.stringify([]), /REVIEW_IMPORT_OBJECT_INVALID/],
    ['extra top key', JSON.stringify(validImport({ review_source: 'recorded-path' })), /REVIEW_IMPORT_PROPERTY_INVALID/],
    ['schema', JSON.stringify(validImport({ schema_version: '2.0' })), /REVIEW_IMPORT_SCHEMA_INVALID/],
    ['reviewer', JSON.stringify(validImport({ reviewer_id: '' })), /REVIEW_IMPORT_REVIEWER_INVALID/],
    ['checker', JSON.stringify(validImport({ checker_episode_id: 1 })), /REVIEW_IMPORT_CHECKER_INVALID/],
    ['maker', JSON.stringify(validImport({ target_maker: null })), /REVIEW_IMPORT_TARGET_INVALID/],
    ['attempt', JSON.stringify(validImport({ attempt_id: '../bad' })), /REVIEW_IMPORT_ATTEMPT_INVALID/],
    ['verdict', JSON.stringify(validImport({ verdict: 'approved' })), /REVIEW_IMPORT_VERDICT_INVALID/],
    ['body', JSON.stringify(validImport({ report_body: 1 })), /REVIEW_IMPORT_BODY_INVALID/],
    ['artifacts', JSON.stringify(validImport({ artifacts: null })), /REVIEW_IMPORT_ARTIFACTS_INVALID/],
    ['artifact extra key', JSON.stringify(validImport({ artifacts: [{ path: 'a', sha256: SHA0, size: 1 }] })), /REVIEW_IMPORT_ARTIFACT_PROPERTY_INVALID/],
    ['uppercase hash', JSON.stringify(validImport({ artifacts: [{ path: 'a', sha256: 'A'.repeat(64) }] })), /REVIEW_IMPORT_ARTIFACT_HASH_INVALID/],
  ];
  for (const [label, raw, error] of invalid) assert.throws(() => parseReviewImport(raw), error, label);
});

test('parseReviewImport rejects portable absolute, empty, dot, dotdot, NUL, and normalized duplicate paths', () => {
  const paths = ['', '.', '..', '/absolute', 'C:\\absolute', '\\\\server\\share\\x', 'a//b', 'a/./b', 'a/../b', 'a/', 'a\0b'];
  for (const path of paths) {
    assert.throws(() => parseReviewImport(JSON.stringify(validImport({ artifacts: [{ path, sha256: SHA0 }] }))), /REVIEW_IMPORT_ARTIFACT_PATH_INVALID/, path);
  }
  assert.throws(() => parseReviewImport(JSON.stringify(validImport({ artifacts: [
    { path: 'a/b', sha256: SHA0 }, { path: 'a\\b', sha256: SHA0 },
  ] }))), /REVIEW_IMPORT_ARTIFACT_DUPLICATE/);
});

test('importReviewOutcome materializes a content-addressed M3 envelope and commits imported proof once', () => {
  const f = fixture();
  const beforeEvents = eventLog(f.root, f.runId).length;
  const result = importReviewOutcome(f.root, f.runId, { raw: JSON.stringify(f.input), fence: f.fence, now: FIXED_NOW });
  assert.equal(result.terminal, 'approved');
  assert.equal(result.review_source, 'imported-stdin');
  assert.match(result.report, new RegExp(`^\\.deep-loop/runs/${f.runId}/reviews/[0-9a-f]{64}\\.json$`));
  const reportAbs = join(f.root, result.report);
  const reportRaw = readFileSync(reportAbs);
  assert.equal(sha256(reportRaw), result.report_sha256);
  assert.equal(basename(reportAbs), `${result.report_sha256}.json`);
  const envelope = JSON.parse(reportRaw.toString('utf8'));
  assert.equal(envelope.schema_version, '1.0');
  assert.equal(envelope.envelope.producer, 'deep-loop');
  assert.equal(envelope.envelope.artifact_kind, 'review-report');
  assert.deepEqual(envelope.envelope.schema, { name: 'review-report', version: '1.0' });
  assert.equal(envelope.envelope.run_id, f.runId);
  assert.equal(envelope.envelope.generated_at, FIXED_NOW);
  assert.deepEqual(envelope.envelope.provenance.review_binding, {
    reviewer_id: 'deep-review', checker_episode_id: f.checkerId, target_maker: f.makerId,
    attempt_id: 'attempt-01',
    artifacts: f.input.artifacts,
  });
  assert.deepEqual(envelope.payload, { verdict: 'APPROVE', report_body: f.input.report_body });

  const state = readState(f.root, f.runId).data;
  const checker = state.episodes.find(e => e.id === f.checkerId);
  assert.equal(checker.status, 'approved');
  assert.equal(checker.review_source, 'imported-stdin');
  assert.equal(state.episodes.find(e => e.id === f.makerId).agent_reviewed, true);
  assert.equal(state.comprehension.episodes_agent_reviewed, 1);
  assert.deepEqual(state.workstreams.find(w => w.id === f.ws).review_points_done, ['implementation']);
  const outcomes = eventLog(f.root, f.runId).slice(beforeEvents).filter(e => e.type === 'review-outcome');
  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0].data, {
    episodeId: f.checkerId, verdict: 'APPROVE', workstream_id: f.ws, point: 'implementation',
    target_maker: f.makerId, reviewer_id: 'deep-review', review_source: 'imported-stdin',
    attempt_id: 'attempt-01',
    report: result.report, report_sha256: result.report_sha256,
  });
  assert.throws(() => importReviewOutcome(f.root, f.runId, { raw: JSON.stringify(f.input), fence: f.fence, now: FIXED_NOW }), /REVIEW_ALREADY_RECORDED/);
});

test('successful review import leaves its committed journal for the next cost mutation to retire', () => {
  const f = fixture();
  const result = importReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(f.input), fence: f.fence, now: FIXED_NOW,
  });
  const operationDir = join(
    runDir(f.root, f.runId), 'transactions', `review-import-${result.report_sha256}`,
  );
  assert.equal(existsSync(join(operationDir, 'committed.json')), true);
  const reportAbs = join(f.root, result.report);
  const reportBytes = readFileSync(reportAbs);
  assert.equal(sha256(reportBytes), result.report_sha256);

  const before = readState(f.root, f.runId).data;
  const beforeEvents = eventLog(f.root, f.runId);
  const beforeReviewOutcomes = beforeEvents.filter(event => event.type === 'review-outcome').length;
  const beforeCosts = beforeEvents.filter(event => event.type === 'cost').length;
  recordCost(f.root, f.runId, {
    turns: before.budget.spent + 2,
    tokens: before.budget.tokens_spent + 41,
    fence: f.fence,
  });

  assert.equal(existsSync(operationDir), false);
  const after = readState(f.root, f.runId).data;
  const afterEvents = eventLog(f.root, f.runId);
  assert.equal(afterEvents.filter(event => event.type === 'review-outcome').length, beforeReviewOutcomes);
  assert.equal(afterEvents.filter(event => event.type === 'cost').length, beforeCosts + 1);
  const cost = afterEvents.at(-1);
  assert.equal(cost.type, 'cost');
  assert.deepEqual(cost.data, {
    turns: 2,
    tokens: 41,
    reported_turns: before.budget.spent + 2,
    reported_tokens: before.budget.tokens_spent + 41,
    owner: f.runId,
    generation: 1,
  });
  assert.deepEqual(after.event_log_head, { seq: cost.seq, checksum: cost.checksum });
  assert.deepEqual(verifyLog(f.root, f.runId), { ok: true, errors: [] });
  assert.deepEqual(verifyHead(f.root, f.runId, after.event_log_head), { ok: true, errors: [] });
  assert.equal(after.budget.spent, before.budget.spent + 2);
  assert.equal(after.budget.tokens_spent, before.budget.tokens_spent + 41);
  assert.deepEqual(readFileSync(reportAbs), reportBytes);
  assert.equal(sha256(readFileSync(reportAbs)), result.report_sha256);
  const checker = after.episodes.find(episode => episode.id === f.checkerId);
  assert.equal(checker.status, 'approved');
  assert.equal(checker.review_source, 'imported-stdin');
});

test('successful review import journal retires through stopped finish exactly once', () => {
  const f = fixture();
  const result = importReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(f.input), fence: f.fence, now: FIXED_NOW,
  });
  const operationDir = join(
    runDir(f.root, f.runId), 'transactions', `review-import-${result.report_sha256}`,
  );
  assert.equal(existsSync(join(operationDir, 'committed.json')), true);
  const reportAbs = join(f.root, result.report);
  const reportBytes = readFileSync(reportAbs);
  const beforeEvents = eventLog(f.root, f.runId);

  assert.deepEqual(finishRun(f.root, f.runId, {
    status: 'stopped',
    proof: { human_reason: 'test stop after imported review' },
    confirm: true,
    fence: f.fence,
    now: FIXED_NOW,
  }), { ok: true, status: 'stopped' });

  assert.equal(existsSync(operationDir), false);
  const after = readState(f.root, f.runId).data;
  const afterEvents = eventLog(f.root, f.runId);
  assert.equal(after.status, 'stopped');
  assert.equal(afterEvents.filter(event => event.type === 'review-outcome').length, 1);
  assert.equal(afterEvents.filter(event => event.type === 'finish').length, 1);
  assert.equal(afterEvents.length, beforeEvents.length + 2);
  assert.deepEqual(verifyLog(f.root, f.runId), { ok: true, errors: [] });
  assert.deepEqual(verifyHead(f.root, f.runId, after.event_log_head), { ok: true, errors: [] });
  assert.deepEqual(readFileSync(reportAbs), reportBytes);
  assert.equal(sha256(readFileSync(reportAbs)), result.report_sha256);

  const loopBytes = readFileSync(join(runDir(f.root, f.runId), 'loop.json'));
  const logBytes = readFileSync(join(runDir(f.root, f.runId), 'event-log.jsonl'));
  assert.throws(() => finishRun(f.root, f.runId, {
    status: 'stopped',
    proof: { human_reason: 'duplicate stop' },
    confirm: true,
    fence: f.fence,
    now: FIXED_NOW,
  }), /LEASE_FENCED: RUN_TERMINAL/);
  assert.deepEqual(readFileSync(join(runDir(f.root, f.runId), 'loop.json')), loopBytes);
  assert.deepEqual(readFileSync(join(runDir(f.root, f.runId), 'event-log.jsonl')), logBytes);
});

test('import accepts only the checker plugin as canonical reviewer_id', () => {
  const subagent = fixture({ detected: { 'deep-review': false } });
  assert.equal(subagent.input.reviewer_id, 'subagent-checker');
  assert.equal(importReviewOutcome(subagent.root, subagent.runId, { raw: JSON.stringify(subagent.input), fence: subagent.fence, now: FIXED_NOW }).terminal, 'approved');

  const mismatch = fixture();
  assert.throws(() => importReviewOutcome(mismatch.root, mismatch.runId, {
    raw: JSON.stringify({ ...mismatch.input, reviewer_id: 'subagent-checker' }), fence: mismatch.fence, now: FIXED_NOW,
  }), /REVIEW_IMPORT_REVIEWER_MISMATCH/);

  const unsupported = fixture();
  const state = readState(unsupported.root, unsupported.runId).data;
  state.episodes.find(e => e.id === unsupported.checkerId).plugin = 'caller-chosen-reviewer';
  writeState(unsupported.root, unsupported.runId, state);
  assert.throws(() => importReviewOutcome(unsupported.root, unsupported.runId, {
    raw: JSON.stringify({ ...unsupported.input, reviewer_id: 'caller-chosen-reviewer' }), fence: unsupported.fence, now: FIXED_NOW,
  }), /REVIEW_IMPORT_REVIEWER_INVALID/);
});

test('import rejects checker/target/maker parity and exact artifact set/hash mismatches without proof', () => {
  const cases = [
    ['checker', f => ({ ...f.input, checker_episode_id: 'missing-checker' }), /EPISODE_NOT_FOUND/],
    ['target', f => ({ ...f.input, target_maker: 'missing-maker' }), /REVIEW_IMPORT_TARGET_MISMATCH/],
    ['hash', f => ({ ...f.input, artifacts: [{ ...f.input.artifacts[0], sha256: SHA0 }] }), /REVIEW_IMPORT_ARTIFACT_HASH_MISMATCH/],
    ['missing artifact', f => ({ ...f.input, artifacts: [] }), /REVIEW_IMPORT_ARTIFACT_SET_MISMATCH/],
    ['extra artifact', f => {
      const path = `${f.worktree}/extra.txt`; writeFileSync(join(f.root, path), 'extra');
      return { ...f.input, artifacts: [...f.input.artifacts, { path, sha256: sha256('extra') }] };
    }, /REVIEW_IMPORT_ARTIFACT_SET_MISMATCH/],
  ];
  for (const [label, change, error] of cases) {
    const f = fixture();
    const before = eventLog(f.root, f.runId).length;
    assert.throws(() => importReviewOutcome(f.root, f.runId, { raw: JSON.stringify(change(f)), fence: f.fence, now: FIXED_NOW }), error, label);
    assert.equal(readState(f.root, f.runId).data.episodes.find(e => e.id === f.checkerId).status, 'in_progress', label);
    assert.equal(eventLog(f.root, f.runId).length, before, label);
  }

  const parity = fixture();
  const state = readState(parity.root, parity.runId).data;
  state.episodes.find(e => e.id === parity.makerId).point = 'plan';
  writeState(parity.root, parity.runId, state);
  assert.throws(() => importReviewOutcome(parity.root, parity.runId, { raw: JSON.stringify(parity.input), fence: parity.fence, now: FIXED_NOW }), /REVIEW_MAKER_BINDING_MISMATCH/);
});

test('import requires a done maker and an in-progress claimed, unblocked, target-bound checker', () => {
  for (const [label, mutate, error] of [
    ['maker role', (s, f) => { s.episodes.find(e => e.id === f.makerId).role = 'checker'; }, /REVIEW_TARGET_MAKER_INVALID/],
    ['maker status', (s, f) => { s.episodes.find(e => e.id === f.makerId).status = 'in_progress'; }, /REVIEW_TARGET_MAKER_NOT_DONE/],
    ['checker blocked', (s, f) => { s.episodes.find(e => e.id === f.checkerId).status = 'blocked'; }, /REVIEW_CHECKER_BLOCKED/],
    ['checker unbound', (s, f) => { delete s.episodes.find(e => e.id === f.checkerId).target_maker; }, /REVIEW_UNBOUND_CHECKER/],
  ]) {
    const f = fixture(); const state = readState(f.root, f.runId).data; mutate(state, f); writeState(f.root, f.runId, state);
    assert.throws(() => importReviewOutcome(f.root, f.runId, { raw: JSON.stringify(f.input), fence: f.fence, now: FIXED_NOW }), error, label);
  }
});

test('import rejects artifact files outside the reviewed worktree', () => {
  assert.throws(() => fixture({ artifactRel: 'outside.txt' }), /REVIEW_IMPORT_ARTIFACT_CONTAINMENT/);
});

test('import rejects file-symlink escapes from the reviewed worktree', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dl-review-symlink-'));
  const external = join(mkdtempSync(join(tmpdir(), 'dl-review-external-')), 'secret.txt');
  writeFileSync(external, 'secret');
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g', detected: { 'deep-review': true }, now: new Date('2026-07-10T00:00:00Z') });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const worktree = '.claude/worktrees/w'; mkdirSync(join(root, worktree), { recursive: true });
  const ws = newWorkstream(root, runId, { title: 'w', branch: 'b', worktree, fence }).id;
  const artifactRel = `${worktree}/link.txt`;
  const artifactPath = join(root, artifactRel);
  writeFileSync(artifactPath, 'contained proof');
  const makerId = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws, expectedArtifacts: [artifactRel], fence }).id;
  recordEpisode(root, runId, makerId, { status: 'in_progress', fence });
  recordEpisode(root, runId, makerId, { status: 'done', artifacts: [artifactRel], fence });
  // P1-c rejects an external symlink at maker settlement now. Replace the already-settled contained proof so this
  // review boundary continues to exercise its independent post-settlement TOCTOU/escape revalidation.
  unlinkSync(artifactPath);
  if (!createFileSymlinkOrSkip(t, external, artifactPath)) return;
  const checkerId = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws, detected: { 'deep-review': true }, fence }).checkerEpisodeId;
  assert.throws(() => claimIndependentReview(root, runId, {
    episodeId: checkerId, fence, attemptIdFactory: () => 'attempt-01',
  }), /REVIEW_IMPORT_ARTIFACT_CONTAINMENT/);
});

test('import refuses a symlinked run/reviews directory before atomic materialization', () => {
  const f = fixture();
  const originalRun = runDir(f.root, f.runId);
  const externalParent = mkdtempSync(join(tmpdir(), 'dl-review-run-external-'));
  const movedRun = join(externalParent, 'run');
  renameSync(originalRun, movedRun);
  createDirectoryJunction(movedRun, originalRun);
  assert.throws(() => importReviewOutcome(f.root, f.runId, { raw: JSON.stringify(f.input), fence: f.fence, now: FIXED_NOW }), /REVIEW_IMPORT_DIRECTORY_UNSAFE/);

  const g = fixture();
  const reviews = join(runDir(g.root, g.runId), 'reviews');
  createDirectoryJunction(mkdtempSync(join(tmpdir(), 'dl-review-dir-external-')), reviews);
  assert.throws(() => importReviewOutcome(g.root, g.runId, { raw: JSON.stringify(g.input), fence: g.fence, now: FIXED_NOW }), /REVIEW_IMPORT_DIRECTORY_UNSAFE/);
});

test('import preserves canonical project-root binding through a symlink alias', () => {
  const f = fixture();
  const alias = `${f.root}-alias`;
  createDirectoryJunction(f.root, alias);
  const result = importReviewOutcome(alias, f.runId, { raw: JSON.stringify(f.input), fence: f.fence, now: FIXED_NOW });
  assert.equal(result.terminal, 'approved');
  assert.equal(existsSync(join(f.root, result.report)), true);
});

test('shared commit validates mutable structures before append so mutate remains nonthrowing', () => {
  const f = fixture();
  const loopPath = join(runDir(f.root, f.runId), 'loop.json');
  const state = JSON.parse(readFileSync(loopPath, 'utf8'));
  state.circuit_breaker = null;
  const raw = JSON.stringify(state, null, 2);
  writeFileSync(loopPath, raw);
  writeFileSync(join(runDir(f.root, f.runId), '.loop.hash'), contentHash(raw));
  const before = eventLog(f.root, f.runId).length;
  assert.throws(() => importReviewOutcome(f.root, f.runId, { raw: JSON.stringify(f.input), fence: f.fence, now: FIXED_NOW }), /STATE_INVALID/);
  assert.equal(eventLog(f.root, f.runId).length, before);
});

test('stale lease creates no envelope and never checker proof', () => {
  const f = fixture(); const before = eventLog(f.root, f.runId).length;
  assert.throws(() => importReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(f.input), fence: { ...f.fence, generation: 9 }, now: FIXED_NOW,
  }), /LEASE_FENCED/);
  assert.equal(readState(f.root, f.runId).data.episodes.find(e => e.id === f.checkerId).status, 'in_progress');
  assert.equal(eventLog(f.root, f.runId).length, before);
  const reviews = join(runDir(f.root, f.runId), 'reviews');
  assert.equal(existsSync(reviews) ? readdirSync(reviews).filter(n => n.endsWith('.json')).length : 0, 0);
});

test('locked error order keeps runtime/lease fencing ahead of source and terminal validation', () => {
  const sourceMismatch = fixture();
  assert.throws(() => importReviewOutcome(sourceMismatch.root, sourceMismatch.runId, {
    raw: JSON.stringify({ ...sourceMismatch.input, reviewer_id: 'subagent-checker' }),
    fence: { ...sourceMismatch.fence, generation: 9 }, now: FIXED_NOW,
  }), /LEASE_FENCED: generation-mismatch/);

  const duplicate = fixture();
  importReviewOutcome(duplicate.root, duplicate.runId, { raw: JSON.stringify(duplicate.input), fence: duplicate.fence, now: FIXED_NOW });
  assert.throws(() => importReviewOutcome(duplicate.root, duplicate.runId, {
    raw: JSON.stringify(duplicate.input), fence: { ...duplicate.fence, generation: 9 }, now: FIXED_NOW,
  }), /LEASE_FENCED: generation-mismatch/);
});

test('record and import have exact terminal/breaker/point/comprehension parity and closed review sources', () => {
  for (const verdict of ['APPROVE', 'CONCERN', 'REQUEST_CHANGES']) {
    const recorded = fixture({ claim: false });
    const imported = fixture();
    const report = `${recorded.worktree}/review.md`;
    writeFileSync(join(recorded.root, report), '# recorded review');
    recordReviewOutcome(recorded.root, recorded.runId, {
      episodeId: recorded.checkerId, verdict,
      proof: verdict === 'REQUEST_CHANGES' ? {} : { report }, fence: recorded.fence,
    });
    importReviewOutcome(imported.root, imported.runId, {
      raw: JSON.stringify({ ...imported.input, verdict }), fence: imported.fence, now: FIXED_NOW,
    });
    const left = readState(recorded.root, recorded.runId).data;
    const right = readState(imported.root, imported.runId).data;
    const projection = (state, f) => ({
      checker_status: state.episodes.find(e => e.id === f.checkerId).status,
      breaker: state.circuit_breaker,
      review_points_done: state.workstreams.find(w => w.id === f.ws).review_points_done,
      maker_agent_reviewed: state.episodes.find(e => e.id === f.makerId).agent_reviewed || false,
      comprehension: state.comprehension,
    });
    assert.deepEqual(projection(left, recorded), projection(right, imported), verdict);
    assert.equal(left.episodes.find(e => e.id === recorded.checkerId).review_source, 'recorded-path');
    assert.equal(right.episodes.find(e => e.id === imported.checkerId).review_source, 'imported-stdin');
    assert.equal(eventLog(recorded.root, recorded.runId).findLast(e => e.type === 'review-outcome').data.review_source, 'recorded-path');
    assert.equal(eventLog(imported.root, imported.runId).findLast(e => e.type === 'review-outcome').data.review_source, 'imported-stdin');
  }
});

function spawnImport(root, runId, raw, extra = []) {
  const args = [CLI, 'review', 'import', '--stdin', '--owner', runId, '--generation', '1', '--project-root', root, '--run-id', runId, ...extra];
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(raw);
  return { child, done: new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr }))) };
}

test('review import keeps its generatedAt timestamp priority over the recorded-path now threading', async () => {
  const f = fixture();
  const importNow = '2026-08-10T00:00:00Z';
  assert.notEqual(importNow, FIXED_NOW, 'the import timestamp must differ from the earlier claim timestamp');

  const result = await spawnImport(
    f.root, f.runId, JSON.stringify(f.input), ['--now', importNow],
  ).done;

  assert.equal(result.code, 0, result.stderr);
  const outcome = eventLog(f.root, f.runId).findLast(event => event.type === 'review-outcome');
  assert.equal(outcome.ts, '2026-08-10T00:00:00.000Z');
  assert.equal(outcome.data.review_source, 'imported-stdin');
});

test('locked commit rebuilds the exact envelope and rejects post-preparation byte tampering', () => {
  const f = fixture();
  const beforeEvents = eventLog(f.root, f.runId).length;
  assert.throws(() => importReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(f.input), fence: f.fence, now: FIXED_NOW,
  }, {
    afterMaterialize({ reportAbs, bytes }) {
      assert.equal(existsSync(reportAbs), false, 'prepared proof is not published before the locked commit');
      bytes[0] ^= 1;
    },
  }), /REVIEW_REPORT_HASH_MISMATCH/);
  assert.equal(readState(f.root, f.runId).data.episodes.find(e => e.id === f.checkerId).status, 'in_progress');
  assert.equal(eventLog(f.root, f.runId).length, beforeEvents);
});

test('post-preparation scope drift rejects imported proof without orphaning a review report', () => {
  const f = fixture();
  const wsOther = newWorkstream(f.root, f.runId, {
    title: 'other', branch: 'other', worktree: '.claude/worktrees/other', fence: f.fence,
  }).id;
  const reviews = join(runDir(f.root, f.runId), 'reviews');
  const before = existsSync(reviews) ? readdirSync(reviews).sort() : [];
  assert.throws(() => importReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(f.input), fence: f.fence, now: FIXED_NOW,
  }, {
    afterMaterialize() {
      const state = readState(f.root, f.runId).data;
      state.session_chain.sessions.find(session => session.run_id === f.runId).scope.workstream_id = wsOther;
      writeState(f.root, f.runId, state);
    },
  }), /SESSION_SCOPE_MISMATCH/);
  assert.deepEqual(existsSync(reviews) ? readdirSync(reviews).sort() : [], before);
  assert.equal(readState(f.root, f.runId).data.episodes.find(ep => ep.id === f.checkerId).status, 'in_progress');
});

test('public review import rejects cross-scope target before report artifact creation', async () => {
  const f = fixture();
  const wsOther = newWorkstream(f.root, f.runId, {
    title: 'other', branch: 'other', worktree: '.claude/worktrees/other', fence: f.fence,
  }).id;
  const state = readState(f.root, f.runId).data;
  state.session_chain.sessions.find(session => session.run_id === f.runId).scope.workstream_id = wsOther;
  writeState(f.root, f.runId, state);
  const reviews = join(runDir(f.root, f.runId), 'reviews');
  const before = existsSync(reviews) ? readdirSync(reviews).sort() : [];
  const result = await spawnImport(f.root, f.runId, JSON.stringify(f.input)).done;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /SESSION_SCOPE_MISMATCH/);
  assert.deepEqual(existsSync(reviews) ? readdirSync(reviews).sort() : [], before);
});

test('locked commit runtime snapshot is fenced if stored runtime changes after envelope creation', () => {
  const f = fixture();
  const beforeEvents = eventLog(f.root, f.runId).length;
  assert.throws(() => importReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(f.input), fence: f.fence, now: FIXED_NOW,
  }, {
    afterMaterialize() {
      const state = readState(f.root, f.runId).data;
      state.autonomy.session_runtime = 'claude';
      writeState(f.root, f.runId, state);
    },
  }), /RUNTIME_FENCED/);
  assert.equal(readState(f.root, f.runId).data.episodes.find(e => e.id === f.checkerId).status, 'in_progress');
  assert.equal(eventLog(f.root, f.runId).length, beforeEvents);
});

test('appendAnchored root-bound read fences a copied-root identity change before review proof', () => {
  const f = fixture();
  const beforeEvents = eventLog(f.root, f.runId).length;
  const loopPath = join(runDir(f.root, f.runId), 'loop.json');
  assert.throws(() => importReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(f.input), fence: f.fence, now: FIXED_NOW,
  }, {
    afterMaterialize() {
      const state = JSON.parse(readFileSync(loopPath, 'utf8'));
      state.project.root = mkdtempSync(join(tmpdir(), 'dl-review-other-root-'));
      const raw = JSON.stringify(state, null, 2);
      writeFileSync(loopPath, raw);
      writeFileSync(join(runDir(f.root, f.runId), '.loop.hash'), contentHash(raw));
    },
  }), /PROJECT_ROOT_FENCED/);
  const persisted = JSON.parse(readFileSync(loopPath, 'utf8'));
  assert.equal(persisted.episodes.find(e => e.id === f.checkerId).status, 'in_progress');
  assert.equal(eventLog(f.root, f.runId).length, beforeEvents);
});

test('CLI import requires --stdin, rejects caller metadata/runtime, and classifies invalid/fence errors', async () => {
  for (const extra of [
    ['--source', 'spoof'], ['--workstream', 'spoof'], ['--point', 'spoof'], ['--runtime', 'codex'], ['--attempt-id', 'spoof'],
  ]) {
    const f = fixture();
    const result = await spawnImport(f.root, f.runId, JSON.stringify(f.input), extra).done;
    assert.equal(result.code, 1, extra[0]);
    assert.match(result.stderr, /REVIEW_METADATA_FORBIDDEN/, extra[0]);
  }
  const missing = fixture();
  const child = spawn(process.execPath, [CLI, 'review', 'import', '--owner', missing.runId, '--generation', '1', '--project-root', missing.root, '--run-id', missing.runId], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(JSON.stringify(missing.input));
  let missingErr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', c => { missingErr += c; });
  const missingCode = await new Promise(resolve => child.on('close', resolve));
  assert.equal(missingCode, 2); assert.match(missingErr, /STDIN_REQUIRED/);

  const invalid = fixture();
  const invalidResult = await spawnImport(invalid.root, invalid.runId, '{').done;
  assert.equal(invalidResult.code, 1); assert.match(invalidResult.stderr, /REVIEW_IMPORT_JSON_INVALID/);

  const stale = fixture();
  const staleProc = spawn(process.execPath, [CLI, 'review', 'import', '--stdin', '--owner', stale.runId, '--generation', '9', '--project-root', stale.root, '--run-id', stale.runId], { stdio: ['pipe', 'pipe', 'pipe'] });
  staleProc.stdin.end(JSON.stringify(stale.input));
  let staleErr = ''; staleProc.stderr.setEncoding('utf8'); staleProc.stderr.on('data', c => { staleErr += c; });
  const staleCode = await new Promise(resolve => staleProc.on('close', resolve));
  assert.equal(staleCode, 3); assert.match(staleErr, /LEASE_FENCED/);
});
