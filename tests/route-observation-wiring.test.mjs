import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { abandonEpisode, newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import {
  claimIndependentReview,
  dispatchReview,
  importReviewOutcome,
  recordReviewOutcome,
} from '../scripts/lib/review.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'scripts', 'deep-loop.mjs');
const FIXED_NOW = '2026-08-24T03:04:05.006Z';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function expectedSubject(runId, artifactId) {
  return sha256(Buffer.from(
    `{"artifact_id":${JSON.stringify(artifactId)},"producer":"deep-loop","run_id":${JSON.stringify(runId)}}`,
    'utf8',
  ));
}

function observationsDir(root, runId) {
  return join(runDir(root, runId), 'observations');
}

function observationFiles(root, runId) {
  const dir = observationsDir(root, runId);
  return existsSync(dir)
    ? readdirSync(dir).filter(name => name.endsWith('.json')).sort()
    : [];
}

function events(root, runId) {
  const path = join(runDir(root, runId), 'event-log.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
}

function assertEventLogFree(root, runId) {
  const logged = events(root, runId);
  assert.equal(logged.some(event => String(event.type).includes('observation')), false);
  assert.equal(JSON.stringify(logged).includes('"observation"'), false);
}

function enableObservation(root, runId) {
  const state = readState(root, runId).data;
  state.project.git = true;
  state.project.head = 'abcdef1';
  state.project.branch = 'feat/route-observation-wiring';
  state.project.dirty = false;
  writeState(root, runId, state);
}

function freshRun({ runtime = 'claude', detected = { 'deep-review': true } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-route-wiring-'));
  const { runId } = initRun(root, {
    runtime,
    goal: 'route observation wiring',
    detected,
    now: new Date('2026-08-24T00:00:00.000Z'),
  });
  enableObservation(root, runId);
  return {
    root,
    runId,
    fence: { owner: runId, generation: 1, intent: 'business' },
  };
}

function makerFixture({ runtime = 'claude', enter = true, writeArtifact = true } = {}) {
  const fixture = freshRun({ runtime });
  const worktree = '.worktrees/wiring';
  const artifact = `${worktree}/artifact.txt`;
  mkdirSync(join(fixture.root, worktree), { recursive: true });
  if (writeArtifact) writeFileSync(join(fixture.root, artifact), 'maker artifact');
  const ws = newWorkstream(fixture.root, fixture.runId, {
    title: 'wiring', branch: 'wiring', worktree, fence: fixture.fence,
  }).id;
  const makerId = newEpisode(fixture.root, fixture.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: [artifact], fence: fixture.fence,
  }).id;
  if (enter) recordEpisode(fixture.root, fixture.runId, makerId, {
    status: 'in_progress', fence: fixture.fence, now: FIXED_NOW,
  });
  return { ...fixture, worktree, artifact, ws, makerId };
}

function finishMaker(fixture) {
  return recordEpisode(fixture.root, fixture.runId, fixture.makerId, {
    status: 'done', artifacts: [fixture.artifact], fence: fixture.fence, now: FIXED_NOW,
  });
}

function recordedReviewFixture(verdict) {
  const fixture = makerFixture();
  finishMaker(fixture);
  const checkerId = dispatchReview(fixture.root, fixture.runId, {
    point: 'implementation', workstreamId: fixture.ws,
    detected: { 'deep-review': true }, fence: fixture.fence,
  }).checkerEpisodeId;
  let report;
  if (verdict !== 'REQUEST_CHANGES') {
    report = `${fixture.worktree}/review-${verdict.toLowerCase()}.md`;
    writeFileSync(join(fixture.root, report), `# ${verdict}\n`);
  }
  return { ...fixture, checkerId, report };
}

function importedReviewFixture() {
  const fixture = makerFixture({ runtime: 'codex' });
  finishMaker(fixture);
  const checkerId = dispatchReview(fixture.root, fixture.runId, {
    point: 'implementation', workstreamId: fixture.ws,
    detected: { 'deep-review': true }, fence: fixture.fence,
  }).checkerEpisodeId;
  const attemptId = 'attempt-wiring';
  claimIndependentReview(fixture.root, fixture.runId, {
    episodeId: checkerId,
    fence: fixture.fence,
    now: FIXED_NOW,
    attemptIdFactory: () => attemptId,
  });
  const artifactBytes = readFileSync(join(fixture.root, fixture.artifact));
  const input = {
    schema_version: '1.0',
    reviewer_id: 'deep-review',
    checker_episode_id: checkerId,
    target_maker: fixture.makerId,
    attempt_id: attemptId,
    verdict: 'APPROVE',
    report_body: '# imported review\n\nAPPROVE',
    artifacts: [{ path: fixture.artifact, sha256: sha256(artifactBytes) }],
  };
  return { ...fixture, checkerId, attemptId, input, raw: JSON.stringify(input) };
}

function readObservation(root, runId, observation) {
  assert.equal(observation?.emitted, true, JSON.stringify(observation));
  const expected = `observations/${observation.subject_sha256}.json`;
  assert.equal(observation.path, expected);
  return JSON.parse(readFileSync(join(runDir(root, runId), observation.path), 'utf8'));
}

function removeObservations(root, runId) {
  const dir = observationsDir(root, runId);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
}

function cleanCliEnv() {
  const env = { ...process.env };
  delete env.DEEP_LOOP_ROUTE_OBSERVATION_VALIDATE;
  delete env.DEEP_MODEL_ROUTER_CLI;
  return env;
}

function runCli(fixture, args, { input } = {}) {
  return spawnSync(process.execPath, [
    CLI,
    ...args,
    '--owner', fixture.runId,
    '--generation', '1',
    '--project-root', fixture.root,
    '--run-id', fixture.runId,
  ], {
    encoding: 'utf8',
    input,
    env: cleanCliEnv(),
  });
}

function stdoutJson(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertProjectedObservation(observation) {
  const allowed = new Set(['emitted', 'created', 'path', 'sha256', 'subject_sha256', 'validation', 'reason']);
  assert.equal(observation && typeof observation === 'object' && !Array.isArray(observation), true);
  assert.equal(Object.keys(observation).every(key => allowed.has(key)), true, JSON.stringify(observation));
  const allKeys = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      allKeys.push(key);
      visit(child);
    }
  };
  visit(observation);
  assert.equal(allKeys.includes('code'), false);
  assert.equal(allKeys.includes('abs'), false);
  if (observation.path !== undefined) {
    assert.match(observation.path, /^observations\/[0-9a-f]{64}\.json$/);
    assert.equal(observation.path.startsWith('/'), false);
    assert.doesNotMatch(observation.path, /^[A-Za-z]:/);
  }
}

test('nonterminal episode records never create an observation directory', () => {
  const fixture = makerFixture({ enter: false });
  recordEpisode(fixture.root, fixture.runId, fixture.makerId, {
    status: 'in_progress', fence: fixture.fence, now: FIXED_NOW,
  });
  assert.equal(existsSync(observationsDir(fixture.root, fixture.runId)), false);
  assertEventLogFree(fixture.root, fixture.runId);
});

test('maker done returns one post-commit observation with expected-artifacts proof', () => {
  const fixture = makerFixture();
  assert.equal(existsSync(observationsDir(fixture.root, fixture.runId)), false);
  const result = finishMaker(fixture);
  assert.equal(result.observation.created, true);
  assert.equal(result.observation.subject_sha256, expectedSubject(fixture.runId, fixture.makerId));
  assert.equal(observationFiles(fixture.root, fixture.runId).length, 1);
  const document = readObservation(fixture.root, fixture.runId, result.observation);
  assert.equal(document.payload.subject.artifact_id, fixture.makerId);
  assert.equal(document.payload.attempts[0].state, 'succeeded');
  assert.deepEqual(document.payload.objective_results.gates, [
    { id: 'expected-artifacts', tier: 'required', status: 'PASS' },
  ]);
  assertEventLogFree(fixture.root, fixture.runId);
});

test('maker and checker abandon emit cancelled observations without final', () => {
  {
    const fixture = makerFixture();
    const result = abandonEpisode(fixture.root, fixture.runId, fixture.makerId, {
      reason: 'operator stop', confirm: true, fence: fixture.fence, now: FIXED_NOW,
    });
    const document = readObservation(fixture.root, fixture.runId, result.observation);
    assert.equal(document.payload.attempts[0].state, 'cancelled');
    assert.equal(Object.hasOwn(document.payload, 'final'), false);
    assertEventLogFree(fixture.root, fixture.runId);
  }

  {
    const fixture = freshRun();
    const worktree = '.worktrees/checker-abandon';
    mkdirSync(join(fixture.root, worktree), { recursive: true });
    const ws = newWorkstream(fixture.root, fixture.runId, {
      title: 'checker-abandon', branch: 'checker-abandon', worktree, fence: fixture.fence,
    }).id;
    const checkerId = newEpisode(fixture.root, fixture.runId, {
      plugin: 'deep-review', role: 'checker', kind: 'review', point: 'implementation',
      workstream: ws, fence: fixture.fence,
    }).id;
    const result = abandonEpisode(fixture.root, fixture.runId, checkerId, {
      reason: 'review unavailable', confirm: true, fence: fixture.fence, now: FIXED_NOW,
    });
    const document = readObservation(fixture.root, fixture.runId, result.observation);
    assert.equal(document.payload.attempts[0].seat, 'reviewer');
    assert.equal(document.payload.attempts[0].state, 'cancelled');
    assert.equal(Object.hasOwn(document.payload, 'final'), false);
    assertEventLogFree(fixture.root, fixture.runId);
  }
});

test('recorded review verdicts emit deterministic checker observations', () => {
  for (const [verdict, terminal, state, accepted] of [
    ['APPROVE', 'approved', 'succeeded', true],
    ['CONCERN', 'approved', 'succeeded', true],
    ['REQUEST_CHANGES', 'rejected', 'failed', false],
  ]) {
    const fixture = recordedReviewFixture(verdict);
    const result = recordReviewOutcome(fixture.root, fixture.runId, {
      episodeId: fixture.checkerId,
      verdict,
      proof: { ...(fixture.report ? { report: fixture.report } : {}) },
      fence: fixture.fence,
      now: FIXED_NOW,
    });
    assert.equal(result.terminal, terminal, verdict);
    const document = readObservation(fixture.root, fixture.runId, result.observation);
    const attempt = document.payload.attempts[0];
    assert.equal(attempt.evidence_kind, 'none', verdict);
    assert.equal(attempt.state, state, verdict);
    assert.equal(Object.hasOwn(attempt, 'timing'), false, verdict);
    assert.equal(document.envelope.generated_at, FIXED_NOW, verdict);
    assert.deepEqual(document.envelope.provenance.source_artifacts, [
      { path: `episodes/${fixture.makerId}/request.md` },
      { path: `episodes/${fixture.checkerId}/request.md` },
    ], verdict);
    assert.deepEqual(document.payload.review_results.verdicts, [
      { producer: 'deep-review', value: verdict },
    ], verdict);
    assert.equal(document.payload.final.accepted.verdict, accepted, verdict);
    const outcome = events(fixture.root, fixture.runId).findLast(event => event.type === 'review-outcome');
    assert.equal(document.envelope.generated_at, outcome.ts, verdict);
    assertEventLogFree(fixture.root, fixture.runId);
  }
});

test('claimed review import emits producer evidence bound to the durable review report', () => {
  const fixture = importedReviewFixture();
  const result = importReviewOutcome(fixture.root, fixture.runId, {
    raw: fixture.raw, fence: fixture.fence, now: FIXED_NOW,
  });
  const document = readObservation(fixture.root, fixture.runId, result.observation);
  const attempt = document.payload.attempts[0];
  assert.equal(attempt.evidence_kind, 'producer_record');
  assert.equal(attempt.attempt_id, fixture.attemptId);
  assert.deepEqual(attempt.evidence_ref, {
    path: `reviews/${result.report_sha256}.json`, sha256: result.report_sha256,
  });
  assert.equal(Object.hasOwn(attempt, 'usage'), false);
  assert.equal(Object.hasOwn(attempt, 'timing'), false);
  assert.deepEqual(document.payload.artifact_digests, [
    { path: `reviews/${result.report_sha256}.json`, sha256: result.report_sha256 },
  ]);
  assert.deepEqual(document.envelope.provenance.source_artifacts, [
    { path: `episodes/${fixture.makerId}/request.md` },
    { path: `episodes/${fixture.checkerId}/request.md` },
    { path: `reviews/${result.report_sha256}.json` },
  ]);
  assertEventLogFree(fixture.root, fixture.runId);
});

test('failed terminal mutations leave no observation directory', () => {
  {
    const fixture = makerFixture({ writeArtifact: false });
    assert.throws(() => finishMaker(fixture), /EPISODE_TERMINAL_NO_PROOF/);
    assert.equal(existsSync(observationsDir(fixture.root, fixture.runId)), false);
  }

  {
    const fixture = makerFixture();
    assert.throws(() => recordEpisode(fixture.root, fixture.runId, fixture.makerId, {
      status: 'done', artifacts: [fixture.artifact],
      fence: { owner: 'different-owner', generation: 1, intent: 'business' },
      now: FIXED_NOW,
    }), /LEASE_FENCED/);
    assert.equal(existsSync(observationsDir(fixture.root, fixture.runId)), false);
  }

  {
    const fixture = recordedReviewFixture('APPROVE');
    removeObservations(fixture.root, fixture.runId);
    assert.throws(() => recordReviewOutcome(fixture.root, fixture.runId, {
      episodeId: fixture.checkerId,
      verdict: 'APPROVE',
      proof: {},
      fence: fixture.fence,
      now: FIXED_NOW,
    }), /REVIEW_NO_EVIDENCE/);
    assert.equal(existsSync(observationsDir(fixture.root, fixture.runId)), false);
  }
});

test('nested afterMaterialize committed retry emits exactly once and skips the outer replay', () => {
  const fixture = importedReviewFixture();
  removeObservations(fixture.root, fixture.runId);
  let nestedResult;
  let bytesAfterNested;
  const outerResult = importReviewOutcome(fixture.root, fixture.runId, {
    raw: fixture.raw, fence: fixture.fence, now: FIXED_NOW,
  }, {
    afterMaterialize() {
      nestedResult = importReviewOutcome(fixture.root, fixture.runId, {
        raw: fixture.raw, fence: fixture.fence, now: FIXED_NOW,
      });
      if (nestedResult?.observation?.path) {
        const nestedPath = join(runDir(fixture.root, fixture.runId), nestedResult.observation.path);
        bytesAfterNested = readFileSync(nestedPath);
      }
    },
  });

  assert.equal(observationFiles(fixture.root, fixture.runId).length, 1);
  assert.equal(Object.hasOwn(outerResult ?? {}, 'observation'), false);
  assert.equal(nestedResult.observation.created, true);
  const finalBytes = readFileSync(join(
    runDir(fixture.root, fixture.runId), nestedResult.observation.path,
  ));
  assert.deepEqual(finalBytes, bytesAfterNested);
  assert.equal(events(fixture.root, fixture.runId).filter(event => event.type === 'review-outcome').length, 1);
  assertEventLogFree(fixture.root, fixture.runId);
});

test('all four terminal CLI surfaces project observations without internal paths or error codes', () => {
  const cases = [];

  const done = makerFixture();
  cases.push(['episode record', done, runCli(done, [
    'episode', 'record', '--id', done.makerId, '--status', 'done',
    '--artifacts', JSON.stringify([done.artifact]), '--now', FIXED_NOW,
  ])]);

  const abandoned = makerFixture({ enter: false });
  cases.push(['episode abandon', abandoned, runCli(abandoned, [
    'episode', 'abandon', '--id', abandoned.makerId,
    '--reason', 'operator stop', '--confirm', '--now', FIXED_NOW,
  ])]);

  const recorded = recordedReviewFixture('APPROVE');
  cases.push(['review record', recorded, runCli(recorded, [
    'review', 'record', '--episode', recorded.checkerId,
    '--verdict', 'APPROVE', '--report', recorded.report, '--now', FIXED_NOW,
  ])]);

  const imported = importedReviewFixture();
  cases.push(['review import', imported, runCli(imported, [
    'review', 'import', '--stdin', '--now', FIXED_NOW,
  ], { input: imported.raw })]);

  for (const [label, fixture, command] of cases) {
    const output = stdoutJson(command);
    assert.equal(output.observation.emitted, true, label);
    assertProjectedObservation(output.observation);
    assert.equal(output.observation.subject_sha256,
      expectedSubject(fixture.runId, label.startsWith('episode') ? fixture.makerId : fixture.checkerId), label);
    assertEventLogFree(fixture.root, fixture.runId);
  }
});

test('read-only observation directory is fail-open with unchanged event and budget accounting', {
  skip: process.platform === 'win32' ? 'POSIX permission fixture' : false,
}, () => {
  const writable = makerFixture();
  const readOnly = makerFixture();
  mkdirSync(observationsDir(readOnly.root, readOnly.runId), { recursive: true });
  chmodSync(observationsDir(readOnly.root, readOnly.runId), 0o555);
  const beforeWritable = readState(writable.root, writable.runId).data;
  const beforeReadOnly = readState(readOnly.root, readOnly.runId).data;
  const writableEvents = events(writable.root, writable.runId).length;
  const readOnlyEvents = events(readOnly.root, readOnly.runId).length;

  const okResult = runCli(writable, [
    'episode', 'record', '--id', writable.makerId, '--status', 'done',
    '--artifacts', JSON.stringify([writable.artifact]), '--now', FIXED_NOW,
  ]);
  const failedResult = runCli(readOnly, [
    'episode', 'record', '--id', readOnly.makerId, '--status', 'done',
    '--artifacts', JSON.stringify([readOnly.artifact]), '--now', FIXED_NOW,
  ]);
  chmodSync(observationsDir(readOnly.root, readOnly.runId), 0o755);

  assert.equal(okResult.status, 0, okResult.stderr);
  assert.equal(failedResult.status, 0, failedResult.stderr);
  const failedOutput = JSON.parse(failedResult.stdout);
  assert.deepEqual(failedOutput.observation, {
    emitted: false,
    reason: 'observation-write-failed',
  });
  assertProjectedObservation(failedOutput.observation);
  assert.match(failedResult.stderr, /\[deep-loop:warn\] route-observation/);

  const afterWritable = readState(writable.root, writable.runId).data;
  const afterReadOnly = readState(readOnly.root, readOnly.runId).data;
  assert.equal(afterReadOnly.episodes.find(episode => episode.id === readOnly.makerId).status, 'done');
  assert.equal(events(writable.root, writable.runId).length - writableEvents,
    events(readOnly.root, readOnly.runId).length - readOnlyEvents);
  assert.deepEqual(
    events(writable.root, writable.runId).slice(writableEvents).map(event => event.type),
    events(readOnly.root, readOnly.runId).slice(readOnlyEvents).map(event => event.type),
  );
  assert.equal(afterWritable.budget.spent - beforeWritable.budget.spent,
    afterReadOnly.budget.spent - beforeReadOnly.budget.spent);
  assert.equal(afterWritable.budget.tokens_spent - beforeWritable.budget.tokens_spent,
    afterReadOnly.budget.tokens_spent - beforeReadOnly.budget.tokens_spent);
  assertEventLogFree(readOnly.root, readOnly.runId);
});
