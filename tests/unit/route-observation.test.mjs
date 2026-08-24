import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GIT_BRANCH_MAX_BYTES,
  IDENTITY_MAX_BYTES,
  MANIFEST_MAX_FILE_BYTES,
  OBSERVATION_DIR,
  OBSERVATION_MAX_FILE_BYTES,
  OBSERVATION_REASONS,
  ROUTE_OBSERVATION_ARTIFACT_KIND,
  ROUTE_OBSERVATION_CONTRACT_VERSION,
  ROUTE_OBSERVATION_SCHEMA_VERSION,
  VALIDATION_REASONS,
  asciiCanonicalJson,
  assertMaxFileBytes,
  assertObservationSize,
  buildRouteObservation,
  classifyLinkage,
  compareCodePoints,
  normalizeGitBranch,
  normalizeSeat,
  normalizeState,
  projectObservationForCli,
  projectValidationForCli,
  relObservationPath,
  serializeObservation,
  subjectSha256,
  validIdentity,
} from '../../scripts/lib/route-observation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', '..', 'scripts', 'lib', 'route-observation.mjs');
const FIXTURES = join(HERE, '..', 'fixtures', 'route-observation');
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);
const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const EVENT_TS = '2026-08-24T02:10:11.204Z';

function routing(overrides = {}) {
  const decision = {
    route_schema_version: 1,
    router_plugin_version: '1.4.0',
    policy_sha256: HEX_A,
    decision_fingerprint: HEX_B,
    request_sha256: HEX_C,
    ...(overrides.decision || {}),
  };
  return {
    request: { task_class: 'IMPLEMENTATION', ...(overrides.request || {}) },
    decision,
    selected_model: 'claude-fable-5',
    selected_effort_native: 'high',
    effective_policy: {},
    provenance: 'router',
    ...overrides,
    decision,
  };
}

function baseLoop(episodes, overrides = {}) {
  return {
    schema_version: '0.4.0',
    run_id: RUN_ID,
    goal: 'SECRET GOAL MUST NOT LEAK',
    project: {
      root: '/Users/private/project',
      head: 'abcdef1',
      branch: 'feat/route-observation',
      dirty: true,
    },
    autonomy: {
      session_runtime: 'claude',
      runtime_source: 'skill-asserted',
      session_model: 'claude-fable-5',
      session_effort: 'high',
    },
    session_chain: {
      parent_run_id: 'PARENT-RUN-01',
      lease: { owner_run_id: 'SESSION-RUN-01' },
    },
    workstreams: [{
      id: 'ws-01',
      base_commit: '1234567',
      worktree: '.worktrees/private-topic',
    }],
    budget: { tokens_spent: 999, process_context: { argv: ['secret'] } },
    episodes,
    ...overrides,
  };
}

function makerEpisode(overrides = {}) {
  return {
    id: 'ep-01',
    plugin: 'deep-work',
    role: 'maker',
    kind: 'implementation',
    point: 'implementation',
    workstream_id: 'ws-01',
    status: 'done',
    request_rel: 'episodes/ep-01/request.md',
    routing: routing(),
    evidence: { candidates: ['SECRET CANDIDATE'] },
    ...overrides,
  };
}

function checkerEpisode(overrides = {}) {
  return {
    id: '003-deep-review',
    plugin: 'deep-review',
    role: 'checker',
    kind: 'review',
    point: 'implementation',
    workstream_id: 'ws-01',
    status: 'approved',
    target_maker: '002-deep-work',
    request_rel: 'episodes/003-deep-review/request.md',
    routing: routing({ request: { task_class: 'REVIEW' } }),
    review_claim: { project_root: '/Users/private/project' },
    ...overrides,
  };
}

function built(loop, episodeId, terminalStatus, extra = {}) {
  return buildRouteObservation({
    loop,
    episodeId,
    event: { seq: 7, ts: EVENT_TS, data: { id: episodeId, status: terminalStatus, ...(extra.eventData || {}) } },
    terminalStatus,
    kernelVersion: '1.22.0',
    ...extra,
  });
}

test('RouteObservation public constants keep the independent observation and manifest bounds', () => {
  assert.equal(ROUTE_OBSERVATION_ARTIFACT_KIND, 'route-observation');
  assert.equal(ROUTE_OBSERVATION_SCHEMA_VERSION, '1.0');
  assert.equal(ROUTE_OBSERVATION_CONTRACT_VERSION, 1);
  assert.equal(OBSERVATION_DIR, 'observations');
  assert.equal(OBSERVATION_MAX_FILE_BYTES, 16_384);
  assert.equal(MANIFEST_MAX_FILE_BYTES, 65_536);
  assert.equal(IDENTITY_MAX_BYTES, 128);
  assert.equal(GIT_BRANCH_MAX_BYTES, 128);
  assert.equal(relObservationPath(HEX_A), `observations/${HEX_A}.json`);
  assert.deepEqual(OBSERVATION_REASONS, [
    'git-identity-unavailable',
    'observation-too-large',
    'observation-collision',
    'observation-directory-unsafe',
    'observation-publish-unsupported',
    'observation-write-failed',
    'snapshot-invalid',
    'observation-identity-invalid',
    'kernel-version-unavailable',
    'observation-failed',
  ]);
  assert.deepEqual(VALIDATION_REASONS, [
    'router-missing', 'validator-missing', 'python-unavailable', 'timeout', 'max-buffer',
    'signal', 'spawn-error', 'invalid', 'usage',
  ]);
  assert.ok(Object.isFrozen(OBSERVATION_REASONS));
  assert.ok(Object.isFrozen(VALIDATION_REASONS));
});

test('canonical JSON matches Python sort_keys for scalar, astral, integer-like, and nested-array keys', (t) => {
  const cases = [
    { value: { z: 'line\n\u0001\ud83d\ude00', a: '\u00e9' } },
    { value: { '\ufffd': '\ud83d\ude00', '\ud800\udc00': '\ud83d\ude80' } },
    { value: { 10: 1, 2: 2, 1: 3 }, exact: '{"1":3,"10":1,"2":2}' },
    { value: { a: [3, 1, 2, { z: 1, b: 2 }] }, exact: '{"a":[3,1,2,{"b":2,"z":1}]}' },
    { value: { 10: '\ud800\udc00', 2: '\ufffd', '\ufffd': 2, '\ud800\udc00': 1 } },
  ];
  for (const { value, exact } of cases) {
    const actual = asciiCanonicalJson(value);
    if (exact) assert.equal(actual, exact);
    const python = spawnSync('python3', ['-c', [
      'import json,sys',
      'v=json.loads(sys.stdin.read())',
      'sys.stdout.write(json.dumps(v,sort_keys=True,separators=(",",":"),ensure_ascii=True))',
    ].join(';')], { input: JSON.stringify(value), encoding: 'utf8' });
    if (python.error?.code === 'ENOENT') {
      t.diagnostic('python3 unavailable; parity sub-assertion skipped');
      continue;
    }
    assert.equal(python.status, 0, python.stderr);
    assert.equal(actual, python.stdout);
  }
});

test('subject hashing and code-point comparison catch UTF-16 ordering drift', () => {
  assert.equal(subjectSha256({ producer: 'deep-loop', run_id: RUN_ID, artifact_id: 'ep-01' }),
    'a1a6ccd20d42089aa5bdacfba8e80f6176f785383be380961597e856b9d3966c');
  assert.equal(subjectSha256({ producer: 'deep-model-router', run_id: 'grp-01', artifact_id: null }),
    'a4639d1b61339690dd157e980e60f93609265f26fec3267a61bec7483b9243f2');
  assert.equal(subjectSha256({ producer: 'deep-loop', run_id: 'run-01', artifact_id: 'run' }),
    'a65727dc1104e793736529a1a5cf88dc85d49cbecfc6d5d554434a1b18bc32a5');
  assert.ok(compareCodePoints('\ufffd', '\ud800\udc00') < 0);
  assert.deepEqual(['\ud800\udc00', '\ufffd'].sort(compareCodePoints), ['\ufffd', '\ud800\udc00']);
  assert.ok(compareCodePoints('a', 'ab') < 0);
  assert.equal(compareCodePoints('same', 'same'), 0);
});

test('linkage classification preserves all six keys and downgrades malformed legacy identity', () => {
  const none = {
    route_schema_version: null,
    router_plugin_version: null,
    policy_sha256: null,
    request_sha256: null,
    decision_fingerprint: null,
    linkage_quality: 'none',
  };
  assert.deepEqual(classifyLinkage(undefined), none);
  assert.deepEqual(classifyLinkage(routing({ provenance: 'local-fallback' })), none);
  assert.deepEqual(classifyLinkage(routing({ decision: { router_plugin_version: 'legacy' } })), none);
  assert.deepEqual(classifyLinkage(routing({ decision: { policy_sha256: 'zz' } })), none);

  assert.deepEqual(classifyLinkage(routing()), {
    route_schema_version: 1,
    router_plugin_version: '1.4.0',
    policy_sha256: HEX_A,
    request_sha256: HEX_C,
    decision_fingerprint: HEX_B,
    linkage_quality: 'full',
  });
  assert.deepEqual(classifyLinkage(routing({ decision: { decision_fingerprint: undefined } })), {
    route_schema_version: 1,
    router_plugin_version: '1.4.0',
    policy_sha256: HEX_A,
    request_sha256: HEX_C,
    decision_fingerprint: null,
    linkage_quality: 'identity_only',
  });
  assert.equal(classifyLinkage(routing({ decision: { decision_fingerprint: 'zz' } })).linkage_quality, 'identity_only');
  assert.equal(classifyLinkage(routing({ decision: { request_sha256: 'zz' } })).request_sha256, null);
});

test('seat, state, identity, and git-ref normalization are closed and byte-bounded', () => {
  assert.equal(normalizeSeat('maker'), 'worker');
  assert.equal(normalizeSeat('checker'), 'reviewer');
  assert.equal(normalizeSeat('unknown'), 'other');
  assert.equal(normalizeState('done'), 'succeeded');
  assert.equal(normalizeState('approved'), 'succeeded');
  assert.equal(normalizeState('rejected'), 'failed');
  assert.equal(normalizeState('abandoned'), 'cancelled');
  assert.equal(normalizeState('pending'), 'unknown');

  assert.equal(validIdentity('a'.repeat(128)), true);
  assert.equal(validIdentity('a'.repeat(129)), false);
  assert.equal(validIdentity('\uac00'.repeat(42)), true);
  assert.equal(validIdentity('\uac00'.repeat(43)), false);
  for (const value of ['', '/x', null, 42]) assert.equal(validIdentity(value), false, String(value));

  const rejected = [
    null, '', 'a'.repeat(129), '\uae30\ub2a5/x', 'feat x', 'feat\tx', 'feat\u0001x',
    'C:\\Users\\x', '\\\\server\\share', 'feat\\x', 'feat/@{1}', 'feat/../x', 'a..b',
    '/feat', 'feat/', '.feat', 'feat.', 'feat/.hidden', 'feat.lock', 'feat//x', 'feat~1',
    'feat^', 'feat:x', 'feat?', 'feat*', 'feat[x]', '-feat', '.worktrees/x', 'feat/.claude/x',
  ];
  for (const value of rejected) {
    assert.equal(normalizeGitBranch(value), 'HEAD', String(value));
    assert.equal(validIdentity(normalizeGitBranch(value)), true);
  }
  for (const value of ['feat/x', 'release-1.2', 'user_name/topic', 'HEAD', 'a'.repeat(128)]) {
    assert.equal(normalizeGitBranch(value), value);
    assert.equal(validIdentity(normalizeGitBranch(value)), true);
  }
});

test('maker mapping is deterministic, full-linked, one-attempt, and excludes stale timing and usage', () => {
  const maker = makerEpisode();
  const priorRejected = checkerEpisode({
    id: '010-deep-review',
    target_maker: '001-deep-work',
    status: 'rejected',
  });
  const loop = baseLoop([priorRejected, maker]);
  const first = built(loop, maker.id, 'done');
  const second = built(structuredClone(loop), maker.id, 'done', { logLines: [{ type: 'cost', tokens: 999 }] });
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  const { document } = first;
  assert.equal(document.envelope.run_id, document.payload.subject.run_id);
  assert.equal(document.envelope.git.dirty, 'unknown');
  assert.equal(document.envelope.session_id, 'SESSION-RUN-01');
  assert.equal(document.envelope.parent_run_id, 'PARENT-RUN-01');
  assert.equal(document.envelope.schema.version, '1.0');
  assert.equal(document.payload.decision.linkage_quality, 'full');
  assert.equal(document.payload.subject.subject_sha256,
    'a1a6ccd20d42089aa5bdacfba8e80f6176f785383be380961597e856b9d3966c');
  assert.deepEqual(document.envelope.provenance.source_artifacts, [{ path: 'episodes/ep-01/request.md' }]);
  assert.deepEqual(document.envelope.provenance.tool_versions, {
    'deep-loop': '1.22.0',
    'deep-model-router': '1.4.0',
  });
  assert.equal(document.payload.attempts.length, 1);
  assert.equal(Object.hasOwn(document.payload.attempts[0], 'timing'), false);
  assert.equal(Object.hasOwn(document.payload.attempts[0], 'usage'), false);
  assert.deepEqual(document.payload.objective_results, {
    gates: [{ id: 'expected-artifacts', tier: 'required', status: 'PASS' }],
  });
  assert.deepEqual(document.payload.final, { implementation_attempts: { rework_total: 1 } });
});

test('checker imported mapping keeps maker-checker-review order and digest subset', () => {
  const maker = makerEpisode({ id: '002-deep-work', status: 'done' });
  const checker = checkerEpisode();
  const loop = baseLoop([maker, checker]);
  const result = built(loop, checker.id, 'approved', {
    verdict: 'APPROVE',
    reviewSource: 'imported-stdin',
    eventData: { attempt_id: 'attempt-01', report_sha256: 'd'.repeat(64), review_source: 'imported-stdin' },
  });
  assert.equal(result.ok, true);
  const doc = result.document;
  const expectedPaths = [
    { path: 'episodes/002-deep-work/request.md' },
    { path: 'episodes/003-deep-review/request.md' },
    { path: `reviews/${'d'.repeat(64)}.json` },
  ];
  assert.deepEqual(doc.envelope.provenance.source_artifacts, expectedPaths);
  assert.deepEqual(doc.payload.artifact_digests, [{
    path: expectedPaths[2].path,
    sha256: 'd'.repeat(64),
  }]);
  assert.deepEqual(doc.payload.review_results, {
    verdicts: [{ producer: 'deep-review', value: 'APPROVE' }],
    rounds: 1,
  });
  assert.deepEqual(doc.payload.final, {
    accepted: {
      decided_by: 'deep-loop-kernel',
      verdict: true,
      signals: [{ kind: 'proof-verdict' }],
    },
  });
  assert.equal(doc.payload.attempts[0].evidence_kind, 'producer_record');
  assert.equal(doc.payload.attempts[0].attempt_id, 'attempt-01');
  assert.deepEqual(doc.payload.attempts[0].evidence_ref, {
    path: expectedPaths[2].path,
    sha256: 'd'.repeat(64),
  });
});

test('abandoned and legacy-unbound mappings omit proof claims and cross-workstream rework', () => {
  const abandoned = makerEpisode({ id: '004-deep-work', status: 'abandoned', routing: undefined });
  const abandonedResult = built(baseLoop([abandoned]), abandoned.id, 'abandoned');
  assert.equal(abandonedResult.ok, true);
  assert.equal(abandonedResult.document.payload.decision.linkage_quality, 'none');
  assert.equal(Object.hasOwn(abandonedResult.document.payload, 'objective_results'), false);
  assert.equal(Object.hasOwn(abandonedResult.document.payload, 'review_results'), false);
  assert.equal(Object.hasOwn(abandonedResult.document.payload, 'final'), false);

  const unbound = checkerEpisode({ id: '005-deep-review', target_maker: undefined, status: 'abandoned' });
  const unboundResult = built(baseLoop([unbound]), unbound.id, 'abandoned');
  assert.equal(unboundResult.ok, true);
  assert.deepEqual(unboundResult.document.envelope.provenance.source_artifacts,
    [{ path: 'episodes/005-deep-review/request.md' }]);

  const legacyMaker = makerEpisode({ id: '1000-deep-work', workstream_id: null });
  const rejectedA = checkerEpisode({ id: '999-a', target_maker: '999-deep-work', workstream_id: 'ws-01', status: 'rejected' });
  const rejectedB = checkerEpisode({ id: '998-b', target_maker: '998-deep-work', workstream_id: 'ws-02', status: 'rejected' });
  const legacy = built(baseLoop([rejectedA, rejectedB, legacyMaker]), legacyMaker.id, 'done');
  assert.equal(legacy.document.payload.final.implementation_attempts.rework_total, 0);
  legacyMaker.workstream_id = 'ws-01';
  const bound = built(baseLoop([rejectedA, rejectedB, legacyMaker]), legacyMaker.id, 'done');
  assert.equal(bound.document.payload.final.implementation_attempts.rework_total, 1);
});

test('identity failures never truncate subjects, while optional identities are omitted', () => {
  const exact = makerEpisode({ id: 'a'.repeat(128), request_rel: `episodes/${'a'.repeat(128)}/request.md` });
  const exactResult = built(baseLoop([exact]), exact.id, 'done');
  assert.equal(exactResult.ok, true);
  assert.equal(exactResult.document.payload.subject.artifact_id, 'a'.repeat(128));

  const tooLong = makerEpisode({ id: 'a'.repeat(129) });
  const invalidEpisode = built(baseLoop([tooLong]), tooLong.id, 'done');
  assert.deepEqual(invalidEpisode, { ok: false, reason: 'observation-identity-invalid' });
  assert.equal(Object.hasOwn(invalidEpisode, 'subject_sha256'), false);

  const invalidRun = built(baseLoop([makerEpisode()], { run_id: 'r'.repeat(129) }), 'ep-01', 'done');
  assert.deepEqual(invalidRun, { ok: false, reason: 'observation-identity-invalid' });

  const invalidTarget = checkerEpisode({ target_maker: 'm'.repeat(129) });
  assert.deepEqual(built(baseLoop([invalidTarget]), invalidTarget.id, 'approved', { verdict: 'APPROVE' }),
    { ok: false, reason: 'observation-identity-invalid' });

  for (const invalid of ['/x', '', 'p'.repeat(129), 42]) {
    const loop = baseLoop([makerEpisode()]);
    loop.session_chain.parent_run_id = invalid;
    loop.session_chain.lease.owner_run_id = invalid;
    const result = built(loop, 'ep-01', 'done');
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result.document.envelope, 'parent_run_id'), false);
    assert.equal(Object.hasOwn(result.document.envelope, 'session_id'), false);
  }
});

test('task producer phase becomes null as a whole at its identity boundary', () => {
  for (const point of ['', 42, 'p'.repeat(129)]) {
    const episode = makerEpisode({ point });
    const result = built(baseLoop([episode]), episode.id, 'done');
    assert.equal(result.ok, true);
    assert.equal(result.document.payload.task.producer_phase, null);
  }
  const result = built(baseLoop([makerEpisode()]), 'ep-01', 'done');
  assert.deepEqual(result.document.payload.task.producer_phase,
    { producer: 'deep-loop', value: 'implementation' });
});

test('serialization is ASCII-only and excludes raw/private keys and values', () => {
  const loop = baseLoop([makerEpisode({
    abandon_reason: 'SECRET ABANDON',
    proof: { report_body: 'SECRET REPORT' },
  })]);
  const result = built(loop, 'ep-01', 'done');
  assert.equal(result.ok, true);
  const bytes = serializeObservation(result.document);
  assert.equal([...bytes].every(byte => byte < 0x80), true);
  const text = bytes.toString('utf8');
  for (const forbidden of [
    'SECRET GOAL', 'SECRET ABANDON', 'SECRET REPORT', '/Users/private/project',
    '.worktrees/private-topic', 'SECRET CANDIDATE', 'argv', 'report_body', 'goal',
    'review_claim', 'candidates',
  ]) assert.equal(text.includes(forbidden), false, forbidden);
});

test('observation and max-file guards reject exact off-by-one and unbounded allocations', () => {
  assert.deepEqual(assertObservationSize(Buffer.alloc(16_384)), { ok: true });
  assert.deepEqual(assertObservationSize(Buffer.alloc(16_385)), {
    ok: false,
    reason: 'observation-too-large',
    bytes: 16_385,
  });
  for (const valid of [1, 16_384]) assert.equal(assertMaxFileBytes(valid), valid);
  for (const invalid of [16_385, 32_769, 65_536, Number.MAX_SAFE_INTEGER, 0, -1, 1.5, '16384', NaN, null]) {
    assert.throws(() => assertMaxFileBytes(invalid), {
      name: 'RangeError',
      message: 'OBSERVATION_MAX_FILE_BYTES_INVALID',
    }, String(invalid));
  }
});

test('CLI projections retain only closed reasons, safe relative paths, and bounded validation tokens', () => {
  assert.equal(projectObservationForCli(undefined), undefined);
  assert.equal(projectObservationForCli('bad'), undefined);
  assert.deepEqual(projectObservationForCli({
    emitted: false,
    reason: 'observation-write-failed',
    code: 'EACCES',
    abs: '/Users/private/out.json',
  }), { emitted: false, reason: 'observation-write-failed' });
  assert.deepEqual(projectObservationForCli({ emitted: false, reason: 'not-closed', code: 'SECRET' }),
    { emitted: false });
  assert.deepEqual(projectObservationForCli({
    emitted: true,
    created: true,
    path: `observations/${HEX_A}.json`,
    sha256: HEX_B,
    subject_sha256: HEX_A,
    abs: '/Users/private/out.json',
  }), {
    emitted: true,
    created: true,
    path: `observations/${HEX_A}.json`,
    sha256: HEX_B,
    subject_sha256: HEX_A,
  });
  assert.deepEqual(projectObservationForCli({
    emitted: true,
    created: true,
    path: '/Users/private/out.json',
    sha256: HEX_B,
    subject_sha256: HEX_A,
  }), { emitted: true, created: true, sha256: HEX_B, subject_sha256: HEX_A });

  assert.equal(projectValidationForCli({ state: 'weird' }), undefined);
  assert.deepEqual(projectValidationForCli({ state: 'unavailable', reason: 'spawn python3 ENOENT /Users/x' }),
    { state: 'unavailable' });
  assert.deepEqual(projectValidationForCli({ state: 'unavailable', reason: 'timeout', detail: 'I-STRING', exit_status: 1 }),
    { state: 'unavailable', reason: 'timeout', detail: 'I-STRING', exit_status: 1 });
  assert.deepEqual(projectValidationForCli({ state: 'invalid', detail: 'Traceback /Users/x' }),
    { state: 'invalid' });
  assert.deepEqual(projectValidationForCli({ state: 'usage', detail: 'unknown' }),
    { state: 'usage', detail: 'unknown' });
});

test('source keeps canonical ordering, identity, and no-log behavior in one module', () => {
  const source = readFileSync(MODULE, 'utf8');
  assert.doesNotMatch(source, /localeCompare\(|\.sort\(\)|Object\.fromEntries\(/);
  assert.doesNotMatch(source, /deriveAttemptUsage|deriveAttemptTiming|readLines|logLines/);
  assert.doesNotMatch(source, /\.slice\(0,\s*128\)|\.substring\(|truncate/i);
  const manifestLine = source.split('\n').find(line => line.includes('MANIFEST_MAX_FILE_BYTES'));
  const observationLine = source.split('\n').find(line => line.includes('OBSERVATION_MAX_FILE_BYTES'));
  assert.ok(manifestLine);
  assert.ok(observationLine);
  assert.equal(manifestLine.includes('OBSERVATION_MAX_FILE_BYTES'), false);
  assert.equal(observationLine.includes('MANIFEST_MAX_FILE_BYTES'), false);
});

test('three RouteObservationV1 golden records remain byte-identical and below 8 KiB', () => {
  const maker = makerEpisode();
  const makerLoop = baseLoop([maker]);
  const checkerMaker = makerEpisode({ id: '002-deep-work', status: 'done' });
  const checker = checkerEpisode();
  const checkerLoop = baseLoop([checkerMaker, checker]);
  const abandoned = makerEpisode({ id: '004-deep-work', status: 'abandoned', routing: undefined });
  const abandonedLoop = baseLoop([abandoned]);
  const cases = [
    ['maker-done-full.json', () => built(structuredClone(makerLoop), maker.id, 'done')],
    ['checker-approved-imported.json', () => built(structuredClone(checkerLoop), checker.id, 'approved', {
      verdict: 'APPROVE',
      reviewSource: 'imported-stdin',
      eventData: { attempt_id: 'attempt-01', report_sha256: 'd'.repeat(64), review_source: 'imported-stdin' },
    })],
    ['maker-abandoned-none.json', () => built(structuredClone(abandonedLoop), abandoned.id, 'abandoned')],
  ];
  for (const [name, build] of cases) {
    const first = build();
    const second = build();
    assert.equal(first.ok, true, name);
    assert.deepEqual(second, first, name);
    const actual = serializeObservation(first.document);
    const expected = Buffer.from(readFileSync(join(FIXTURES, name), 'utf8').trimEnd(), 'utf8');
    assert.equal(actual.equals(expected), true, name);
    assert.ok(actual.length < 8 * 1024, `${name}: ${actual.length}`);
    assert.equal(first.document.payload.attempts.length, 1, name);
    assert.equal(Object.hasOwn(first.document.payload.attempts[0], 'usage'), false, name);
    assert.equal(Object.hasOwn(first.document.payload.attempts[0], 'timing'), false, name);
    assert.equal(first.document.envelope.git.dirty, 'unknown', name);
  }
});
