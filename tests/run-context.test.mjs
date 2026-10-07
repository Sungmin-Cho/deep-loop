import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix as posixPath, win32 as win32Path } from 'node:path';
import { formatBoundedRoutingDiagnostic, resolveRunContext } from '../scripts/lib/run-context.mjs';
import { appendAnchored, captureVerifiedRunSet, captureVerifiedRunSnapshot } from '../scripts/lib/integrity.mjs';
import { recordedClaimKey } from '../scripts/lib/fs-safe.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { runDir, withLock } from '../scripts/lib/state.mjs';

const ROOT = '/project';
const realpathFn = value => value;
const hash = id => `${id}`.padEnd(64, '0').slice(0, 64);
const snapshot = (runId, status = 'running', workstreams = [], root = ROOT) => ({
  data: {
    run_id: runId,
    status,
    project: { root },
    workstreams: workstreams.map((worktree, index) => ({
      id: `ws-${index + 1}`,
      status: worktree.status || 'in_progress',
      worktree: worktree.path || worktree,
    })),
  },
  hash: hash(runId),
});
const captureSet = (runs, extra = {}) => () => ({
  runIds: Object.keys(runs).sort(),
  runs: Object.fromEntries(Object.entries(runs).map(([runId, value]) => [runId, {
    ok: true, kind: 'clean-no-publication', snapshot: value,
  }])),
  errors: extra,
});
function resolve(runs, options = {}) {
  const platform = options.platform ?? 'linux';
  return resolveRunContext({
    root: ROOT,
    realpathFn,
    captureRunSet: captureSet(runs, options.errors),
    pathApi: options.pathApi ?? (platform === 'win32' ? win32Path : posixPath),
    platform,
    ...(options.current !== undefined ? { currentRunIdFn: () => options.current } : {}),
    ...options,
  });
}

function durableBytes(root, runId) {
  const base = runDir(root, runId);
  const bytes = [];
  const visit = current => {
    for (const name of readdirSync(current).sort()) {
      if (name === '.lock') continue;
      const path = join(current, name);
      const stat = lstatSync(path);
      const rel = path.slice(base.length + 1);
      if (stat.isDirectory()) visit(path);
      else bytes.push([rel, readFileSync(path).toString('base64')]);
    }
  };
  visit(base);
  return bytes;
}

function seedPrepared(root, runId, operationId) {
  assert.throws(() => appendAnchored(
    root,
    runId,
    { type: 'context-prepared', data: { operation_id: operationId }, now: '2026-07-23T00:01:00.000Z' },
    loop => { loop.discovered_items.push(operationId); },
    undefined,
    {
      publication: {
        kind: 'workstream-boundary',
        operationId,
        artifacts: [
          { rel: 'artifacts/boundary.txt', bytes: Buffer.from(`artifact:${operationId}`) },
          { rel: 'artifacts/boundary.meta', bytes: Buffer.from(`meta:${operationId}`) },
        ],
        topology: { operation_id: operationId, phase: 'prepared' },
        faultAt(label) {
          if (label === 'prepared:digest-verified') throw new Error(`context-fixture:${operationId}`);
        },
      },
      floor: 1,
    },
  ), /TRANSACTION_PENDING/);
}

test('explicit A ignores current B and does not enumerate unrelated runs', () => {
  const snapshot = {
    data: {
      run_id: 'A',
      status: 'running',
      project: { root: '/project' },
      workstreams: [],
    },
    hash: 'a'.repeat(64),
  };
  const result = resolveRunContext({
    root: '/project',
    explicitRunId: 'A',
    captureRunSnapshot(root, runId) {
      assert.equal(root, '/project');
      assert.equal(runId, 'A');
      return { ok: true, snapshot };
    },
    captureRunSet() {
      throw new Error('explicit selection must not enumerate');
    },
    realpathFn(value) { return value; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.runId, 'A');
  assert.equal(result.source, 'explicit');
});

test('unsafe explicit identities do not fall back to current', () => {
  for (const explicitRunId of ['../B', '.', '..', 'A/B', 'A\\\\B', `A${String.fromCharCode(0)}B`, `A${String.fromCharCode(31)}B`, `A${String.fromCharCode(127)}B`, `A${String.fromCharCode(128)}B`]) {
    const result = resolve({}, { explicitRunId });
    assert.equal(result.reason, 'invalid-run-id', explicitRunId);
  }
});

test('worktree A beats current B', () => {
  const a = snapshot('A', 'running', ['.claude/worktrees/a']);
  const b = snapshot('B', 'running', ['.claude/worktrees/b']);
  const result = resolve({ A: a, B: b }, { cwd: '/project/.claude/worktrees/a/file' });
  assert.equal(result.source, 'worktree');
  assert.equal(result.runId, 'A');
});

test('single active run is selected without a cwd', () => {
  const result = resolve({ A: snapshot('A') });
  assert.deepEqual({ kind: result.kind, source: result.source, runId: result.runId }, {
    kind: 'selected', source: 'single-active', runId: 'A',
  });
});

test('root A+B is ambiguous and current is not a tie-breaker', () => {
  const result = resolve({ A: snapshot('A'), B: snapshot('B') });
  assert.equal(result.kind, 'ambiguous');
  assert.equal(result.reason, 'multi-active-root-cwd');
  assert.deepEqual(result.candidates.map(item => item.run_id), ['A', 'B']);
});

test('terminal claim residue never falls to active A', () => {
  const terminal = snapshot('T', 'completed', [{ path: '.claude/worktrees/shared', status: 'ready' }]);
  const active = snapshot('A', 'running', ['.claude/worktrees/active']);
  const result = resolve({ A: active, T: terminal }, { cwd: '/project/.claude/worktrees/shared/file' });
  // `source: 'worktree'` (issue #77) tells this apart from a project whose last run finished.
  assert.deepEqual(result, { ok: true, kind: 'none', reason: 'terminal-residue', source: 'worktree' });
  const finished = resolve({ T: snapshot('T', 'completed') }, { current: 'T' });
  assert.deepEqual(finished, { ok: true, kind: 'none', reason: 'terminal-residue' });
});

// Issue #77 (D2): terminal history only affects a cwd inside its own claim. A terminal
// claim on the same path as an active one no longer makes the whole project ambiguous.
test('a terminal claim on an active claim path does not block selection outside it', () => {
  const result = resolve({
    A: snapshot('A', 'running', ['.claude/worktrees/shared']),
    T: snapshot('T', 'completed', [{ path: '.claude/worktrees/shared', status: 'ready' }]),
  });
  assert.equal(result.kind, 'selected');
  assert.equal(result.source, 'single-active');
  assert.equal(result.runId, 'A');
});

test('Win32 Foo/foo claims collide component-wise', () => {
  const result = resolve({ A: snapshot('A', 'running', ['.worktrees/Foo']), B: snapshot('B', 'running', ['.worktrees/foo']) }, {
    platform: 'win32',
  });
  assert.equal(result.reason, 'duplicate-worktree-claim');
  const drive = recordedClaimKey({ root: 'C:\\fixture', worktree: '.worktrees/Foo', platform: 'win32', pathApi: win32Path, realpathFn: value => value });
  const driveCase = recordedClaimKey({ root: 'c:/FIXTURE', worktree: '.worktrees/foo', platform: 'win32', pathApi: win32Path, realpathFn: value => value });
  const driveOther = recordedClaimKey({ root: 'D:\\fixture', worktree: '.worktrees/foo', platform: 'win32', pathApi: win32Path, realpathFn: value => value });
  const unc = recordedClaimKey({ root: '\\\\server\\share\\fixture', worktree: '.worktrees/Foo', platform: 'win32', pathApi: win32Path, realpathFn: value => value });
  const uncCase = recordedClaimKey({ root: '\\\\SERVER\\SHARE\\FIXTURE', worktree: '.worktrees/foo', platform: 'win32', pathApi: win32Path, realpathFn: value => value });
  const uncOther = recordedClaimKey({ root: '\\\\other\\share\\fixture', worktree: '.worktrees/foo', platform: 'win32', pathApi: win32Path, realpathFn: value => value });
  assert.equal(drive.ok, true);
  assert.equal(driveCase.ok, true);
  assert.equal(driveOther.ok, true);
  assert.equal(unc.ok, true);
  assert.equal(uncCase.ok, true);
  assert.equal(uncOther.ok, true);
  const intersects = (left, right) => left.keys.some(key => right.keys.includes(key));
  assert.equal(intersects(drive, driveCase), true);
  assert.equal(intersects(drive, driveOther), false);
  assert.equal(intersects(unc, uncCase), true);
  assert.equal(intersects(unc, uncOther), false);
  for (const [left, right] of [['ß', 'ss'], ['ẞ', 'ss'], ['ς', 'σ'], ['ﬃ', 'ffi'], ['İ', 'i̇']]) {
    const unicode = resolve({ A: snapshot('A', 'running', [`.worktrees/${left}`]), B: snapshot('B', 'running', [`.worktrees/${right}`]) }, {
      platform: 'win32',
    });
    assert.equal(unicode.reason, 'duplicate-worktree-claim', `${left}/${right}`);
  }
});

test('POSIX Foo/foo claims remain distinct', () => {
  const result = resolve({ A: snapshot('A', 'running', ['.worktrees/Foo']), B: snapshot('B', 'running', ['.worktrees/foo']) });
  assert.equal(result.reason, 'multi-active-root-cwd');
  const unicode = resolve({ A: snapshot('A', 'running', ['.worktrees/ß']), B: snapshot('B', 'running', ['.worktrees/ss']) });
  assert.equal(unicode.reason, 'multi-active-root-cwd');
});

test('physical aliases collide even when lexical spellings differ', () => {
  const aliasRealpath = value => value.includes('/alias') ? '/project/.worktrees/shared' : value;
  const result = resolve({
    A: snapshot('A', 'running', ['.worktrees/shared']),
    B: snapshot('B', 'running', ['.worktrees/alias']),
  }, { realpathFn: aliasRealpath });
  assert.equal(result.reason, 'duplicate-worktree-claim');
});

test('component containment rejects prefix lookalikes', () => {
  const result = resolve({ A: snapshot('A', 'running', ['.worktrees/foo']) }, {
    cwd: '/project/.worktrees/foobar/file',
  });
  assert.equal(result.source, 'single-active');
});

test('physical escape does not become a worktree match', () => {
  const escape = value => value.endsWith('/.worktrees/escape') ? '/outside/escape' : value;
  const result = resolve({ A: snapshot('A', 'running', ['.worktrees/escape']) }, {
    cwd: '/project/.worktrees/escape/file', realpathFn: escape,
  });
  assert.equal(result.reason, 'invalid-worktree-claim');
  assert.deepEqual(result.errors, { A: { kind: 'invalid-worktree-claim' } });
});

test('complete headless env identity selects A', () => {
  const a = snapshot('A', 'paused');
  const result = resolve({ B: snapshot('B') }, {
    purpose: 'headless',
    envIdentity: {
      DEEP_LOOP_RUN_ID: 'A', DEEP_LOOP_PROJECT_ROOT: ROOT, DEEP_LOOP_OWNER: 'A',
      DEEP_LOOP_GENERATION: '1', DEEP_LOOP_HEADLESS: '1', DEEP_LOOP_UNATTENDED: '1',
    },
    captureRunSnapshot(root, runId) {
      assert.equal(runId, 'A');
      return { ok: true, snapshot: a };
    },
  });
  assert.equal(result.source, 'env');
  assert.equal(result.runId, 'A');
  assert.deepEqual(result.expect, { owner: 'A', generation: 1 });
});

test('partial headless env markers are ignored', () => {
  const result = resolve({ A: snapshot('A'), B: snapshot('B') }, {
    purpose: 'headless',
    envIdentity: { DEEP_LOOP_RUN_ID: 'A', DEEP_LOOP_HEADLESS: '1' },
  });
  assert.equal(result.kind, 'ambiguous');
  for (const runId of ['.', '..', `A${String.fromCharCode(1)}B`]) {
    const invalid = resolve({ A: snapshot('A') }, {
      purpose: 'headless', envIdentity: {
        DEEP_LOOP_RUN_ID: runId, DEEP_LOOP_PROJECT_ROOT: ROOT, DEEP_LOOP_OWNER: 'A',
        DEEP_LOOP_GENERATION: '1', DEEP_LOOP_HEADLESS: '1', DEEP_LOOP_UNATTENDED: '1',
      },
    });
    assert.equal(invalid.reason, 'identity-conflict');
  }
});

test('explicit and complete env identity conflict before capture', () => {
  const result = resolve({}, {
    explicitRunId: 'A', purpose: 'headless',
    envIdentity: {
      DEEP_LOOP_RUN_ID: 'B', DEEP_LOOP_PROJECT_ROOT: ROOT, DEEP_LOOP_OWNER: 'B',
      DEEP_LOOP_GENERATION: '1', DEEP_LOOP_HEADLESS: '1', DEEP_LOOP_UNATTENDED: '1',
    },
  });
  assert.deepEqual(result, { ok: false, kind: 'invalid', reason: 'identity-conflict' });
});

test('complete env identity bound to another root is invalid', () => {
  const result = resolve({}, {
    purpose: 'headless', envIdentity: {
      DEEP_LOOP_RUN_ID: 'A', DEEP_LOOP_PROJECT_ROOT: '/other', DEEP_LOOP_OWNER: 'A',
      DEEP_LOOP_GENERATION: '1', DEEP_LOOP_HEADLESS: '1', DEEP_LOOP_UNATTENDED: '1',
    },
  });
  assert.equal(result.reason, 'identity-conflict');
});

test('complete env markers are ignored outside headless purpose', () => {
  const result = resolve({ A: snapshot('A'), B: snapshot('B') }, {
    purpose: 'cli-read', envIdentity: {
      DEEP_LOOP_RUN_ID: 'A', DEEP_LOOP_PROJECT_ROOT: ROOT, DEEP_LOOP_OWNER: 'A',
      DEEP_LOOP_GENERATION: '1', DEEP_LOOP_HEADLESS: '1', DEEP_LOOP_UNATTENDED: '1',
    },
  });
  assert.equal(result.kind, 'ambiguous');
});

test('empty verified run set returns no-runs', () => {
  assert.deepEqual(resolve({}), { ok: true, kind: 'none', reason: 'no-runs' });
});

test('no active runs without a current pointer returns no-current', () => {
  const result = resolve({ T: snapshot('T', 'completed') });
  assert.equal(result.reason, 'no-current');
});

test('stale current is reported without selection', () => {
  const result = resolve({ T: snapshot('T', 'completed') }, {
    current: 'MISSING',
  });
  assert.ok(['no-current', 'stale-current'].includes(result.reason));
  for (const current of ['.', '..', `A${String.fromCharCode(1)}B`]) {
    const invalid = resolve({ T: snapshot('T', 'completed') }, { current });
    assert.equal(invalid.reason, 'stale-current');
  }
});

test('terminal current with zero recorded claims does not select', () => {
  const result = resolve({ T: snapshot('T', 'completed') }, { current: 'T' });
  assert.equal(result.reason, 'terminal-residue');
});

test('explicit A ignores an erroring unrelated run set', () => {
  const result = resolve({}, {
    explicitRunId: 'A',
    captureRunSnapshot: () => ({ ok: true, snapshot: snapshot('A') }),
    captureRunSet: () => ({ ok: false, kind: 'run-set-integrity', errors: { B: { kind: 'integrity-invalid' } } }),
  });
  assert.equal(result.source, 'explicit');
});

test('run-set integrity errors are invalid and partial runs are discarded', () => {
  const result = resolve({ A: snapshot('A') }, { errors: { B: { kind: 'integrity-invalid' } } });
  assert.equal(result.reason, 'run-set-integrity');
  assert.equal(result.ok, false);

  const root = mkdtempSync(join(tmpdir(), 'deep-loop-context-set-'));
  const runA = initRun(root, { runtime: 'claude', goal: 'clean A', now: new Date('2026-07-23T00:00:00.000Z') }).runId;
  const runB = initRun(root, { runtime: 'claude', goal: 'prepared B', now: new Date('2026-07-23T00:00:00.001Z') }).runId;
  seedPrepared(root, runB, 'context-prepared-B');
  const beforeA = durableBytes(root, runA);
  const beforeB = durableBytes(root, runB);
  const actual = resolveRunContext({ root, captureRunSet: captureVerifiedRunSet, nowFn: () => 100, sleepFn: () => {} });
  assert.equal(actual.reason, 'reconciliation-required');
  assert.equal(actual.ok, false);
  assert.deepEqual(Object.keys(actual.errors), [runB]);
  assert.deepEqual(durableBytes(root, runA), beforeA);
  assert.deepEqual(durableBytes(root, runB), beforeB);
});

test('run-set cap diagnostic is invalid and bounded', () => {
  const actualRoot = mkdtempSync(join(tmpdir(), 'deep-loop-context-'));
  mkdirSync(join(actualRoot, '.deep-loop', 'runs'), { recursive: true });
  for (let index = 0; index < 257; index += 1) mkdirSync(join(actualRoot, '.deep-loop', 'runs', `R${String(index).padStart(3, '0')}`));
  const nowFn = () => 100;
  const sleepFn = async () => {};
  const opendirFn = () => {};
  let optionsSeen;
  const result = resolve({}, {
    root: actualRoot,
    captureRunSet: captureVerifiedRunSet,
    opendirFn: undefined,
    nowFn,
    sleepFn,
  });
  assert.equal(result.reason, 'run-set-bound-exceeded');
  assert.equal(result.phase, 'enumeration');
  assert.equal(result.bound, 'count');
  assert.equal(result.max_run_ids, 256);
  const propagated = resolve({}, {
    nowFn, sleepFn, opendirFn,
    captureRunSet: (_root, options) => {
      optionsSeen = options;
      return {
        ok: false, kind: 'run-set-bound-exceeded', max_run_ids: 256, deadline_ms: 500, observed_count: 257,
        total_is_lower_bound: true, phase: 'enumeration', bound: 'count',
      };
    },
  });
  assert.equal(optionsSeen.historyFastPath, true);
  assert.equal(optionsSeen.maxRunIds, 256);
  assert.equal(optionsSeen.maxFullCaptures, 64);
  assert.equal(optionsSeen.baseDeadlineMs, 500);
  assert.equal(optionsSeen.perFullCaptureMs, 100);
  assert.equal(optionsSeen.maxDeadlineMs, 3000);
  assert.equal(optionsSeen.nowFn, nowFn);
  assert.equal(optionsSeen.sleepFn, sleepFn);
  assert.equal(optionsSeen.opendirFn, opendirFn);
  assert.deepEqual(propagated, {
    ok: false, kind: 'invalid', reason: 'run-set-bound-exceeded', phase: 'enumeration', bound: 'count',
    max_run_ids: 256, deadline_ms: 500, observed_count: 257, total_is_lower_bound: true,
  });

  const lockRoot = mkdtempSync(join(tmpdir(), 'deep-loop-context-lock-'));
  const lockRunId = 'R1';
  mkdirSync(runDir(lockRoot, lockRunId), { recursive: true });
  let lockResult;
  let clock = 100;
  const sleeps = [];
  withLock(lockRoot, lockRunId, () => {
    lockResult = captureVerifiedRunSet(lockRoot, {
      runIds: [lockRunId], deadlineMs: 5, nowFn: () => clock,
      sleepFn(ms) { sleeps.push(ms); clock += ms; },
      lockOptions: {
        retries: 10, backoffMs: 50, nowFn: () => clock,
        sleepFn(ms) { sleeps.push(ms); clock += ms; },
      },
    });
  });
  assert.equal(lockResult.kind, 'run-set-bound-exceeded');
  assert.equal(lockResult.phase, 'lock-retry');
  assert.deepEqual(Object.keys(lockResult.runs), []);
  assert.deepEqual(sleeps, [5]);
});

test('error diagnostics cap at five entries', () => {
  const errors = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`R${index}`, { kind: 'integrity-invalid' }]));
  const result = resolve({}, { errors });
  assert.equal(Object.keys(result.errors).length, 5);
  assert.equal(result.total, 7);
});

test('public routing diagnostics stay valid and preserve total under five verbose errors', () => {
  const errors = Object.fromEntries(['E', 'D', 'C', 'B', 'A'].map(runId => [runId, {
    kind: 'reconciliation-required',
    operation_id: 'operation-id-0123456789012345678901234567',
    phase: 'prepared',
  }]));
  const diagnostic = formatBoundedRoutingDiagnostic({
    action: 'ambiguous-run',
    reason: 'run-set-bound-exceeded',
    errors,
    total: 5,
    max_run_ids: 64,
    deadline_ms: 500,
    observed_count: 5,
    total_is_lower_bound: true,
  });
  assert.equal(JSON.parse(diagnostic).total, 5);
  assert.ok(diagnostic.length <= 220);
  assert.ok(Buffer.byteLength(`deep-loop: precompact ${diagnostic}\n`, 'utf8') <= 256);
});

test('ambiguity candidates are capped in fixed UTF-16 code-unit order', () => {
  const ids = ['z-', 'A.', 'a_', 'B-', 'b.', '0-', '9_'];
  const runs = Object.fromEntries(ids.map(id => [id, snapshot(id)]));
  const result = resolve(runs);
  assert.equal(result.total, 7);
  assert.deepEqual(result.candidates.map(item => item.run_id), ['0-', '9_', 'A.', 'B-', 'a_']);
});

test('unresolvable cwd is invalid rather than falling back', () => {
  const result = resolve({ A: snapshot('A') }, { cwd: '/missing', realpathFn(value) { if (value === '/missing') throw new Error('missing'); return value; } });
  assert.deepEqual(result, { ok: false, kind: 'invalid', reason: 'cwd-unresolvable' });
});

test('sole terminal current with matching cwd remains legacy-current', () => {
  const result = resolve({ T: snapshot('T', 'completed', [
    { path: '.worktrees/parent', status: 'ready' },
    { path: '.worktrees/parent/nested', status: 'ready' },
  ]) }, { cwd: '/project/.worktrees/parent/nested/file', current: 'T' });
  assert.equal(result.source, 'legacy-current');
  assert.equal(result.matchedWorktree, '.worktrees/parent/nested');
  const noCwd = resolve({ T: snapshot('T', 'completed', [
    { path: '.worktrees/t', status: 'ready' },
    { path: '.worktrees/other', status: 'ready' },
  ]) }, { current: 'T' });
  assert.equal(noCwd.source, 'legacy-current');
  const outside = resolve({ T: snapshot('T', 'completed', [
    { path: '.worktrees/t', status: 'ready' },
    { path: '.worktrees/other', status: 'ready' },
  ]) }, { cwd: '/project/outside', current: 'T' });
  assert.equal(outside.source, 'legacy-current');
});

test('terminal cwd with wrong current is terminal residue', () => {
  const result = resolve({
    T: snapshot('T', 'completed', [{ path: '.worktrees/t', status: 'ready' }]),
    X: snapshot('X', 'completed', [{ path: '.worktrees/t/nested', status: 'ready' }]),
  }, { cwd: '/project/.worktrees/t/nested/file', current: 'T' });
  assert.equal(result.reason, 'terminal-residue');
});

test('two active worktree matches are ambiguous', () => {
  const result = resolve({
    A: snapshot('A', 'running', ['.worktrees/parent']),
    B: snapshot('B', 'running', ['.worktrees/parent/nested']),
  }, { cwd: '/project/.worktrees/parent/nested/file' });
  assert.equal(result.reason, 'multi-active-root-cwd');
});

test('missing historical claims stay residue for a cwd inside them', () => {
  const runs = { A: snapshot('A', 'completed', [{ path: '.worktrees/missing', status: 'ready' }]), B: snapshot('B', 'running', ['.worktrees/missing']) };
  assert.equal(resolve(runs).source, 'single-active');
  assert.equal(resolve(runs, { cwd: '/project/.worktrees/missing/file' }).reason, 'terminal-residue');
});

test('a non-NFC claim of an active run is invalid-worktree-claim', () => {
  const malformed = Array.from({ length: 5 }, () => '.worktrees/e\u0301');
  const result = resolve({ A: snapshot('A', 'running', malformed), B: snapshot('B', 'running', ['.worktrees/e\u0301']) });
  assert.equal(result.reason, 'invalid-worktree-claim');
  assert.deepEqual(result.errors, { A: { kind: 'invalid-worktree-claim' }, B: { kind: 'invalid-worktree-claim' } });
  assert.deepEqual(Object.keys(result.errors), ['A', 'B']);
  assert.equal(result.total, 2);
});

test('invalid purpose is rejected before any capture', () => {
  const result = resolve({}, { purpose: 'unknown' });
  assert.deepEqual(result, { ok: false, kind: 'invalid', reason: 'invalid-purpose' });
});

test('paused is an active fallback candidate', () => {
  const result = resolve({ A: snapshot('A', 'paused') });
  assert.equal(result.source, 'single-active');
});

// A terminal claim is never retired or handed over: inside its path a cwd is residue
// even when an active run claims the same path (README: no claim retirement).
test('a terminal claim is never retired, and only affects a cwd inside it', () => {
  const runs = { T: snapshot('T', 'completed', [{ path: '.worktrees/x', status: 'abandoned' }]), A: snapshot('A', 'paused', ['.worktrees/x']) };
  assert.equal(resolve(runs).source, 'single-active');
  assert.equal(resolve(runs, { cwd: '/project/.worktrees/x/file' }).reason, 'terminal-residue');
  const sameRun = resolve({ T: snapshot('T', 'completed', [
    { path: '.worktrees/same', status: 'ready' },
    { path: '.worktrees/same', status: 'ready' },
  ]) });
  assert.notEqual(sameRun.reason, 'duplicate-worktree-claim');
  const activeSameRun = resolve({ A: snapshot('A', 'running', ['.worktrees/same', '.worktrees/same']) });
  assert.equal(activeSameRun.reason, 'duplicate-worktree-claim');
});

test('root binding mismatch in an injected exact snapshot is invalid', () => {
  const result = resolve({}, { explicitRunId: 'A', captureRunSnapshot: () => ({ ok: true, snapshot: snapshot('A', 'running', [], '/other') }) });
  assert.equal(result.reason, 'identity-invalid');
});

test('exact capture failure preserves bounded classification without fallback', () => {
  const reconciliation = resolve({}, { explicitRunId: 'A', captureRunSnapshot: () => ({ ok: false, kind: 'reconciliation-required', operation_id: 'op-1', phase: 'prepared' }) });
  assert.equal(reconciliation.reason, 'reconciliation-required');
  assert.deepEqual(reconciliation.errors.A, { kind: 'reconciliation-required', operation_id: 'op-1', phase: 'prepared' });
  const integrity = resolve({}, { explicitRunId: 'A', captureRunSnapshot: () => ({ ok: false, kind: 'integrity-invalid', operation_id: 'op-2', phase: 'verified-vector' }) });
  assert.equal(integrity.reason, 'identity-invalid');
  assert.deepEqual(integrity.errors.A, { kind: 'integrity-invalid', operation_id: 'op-2', phase: 'verified-vector' });
  const thrownError = Object.assign(new Error('reconciliation-required'), {
    kind: 'reconciliation-required', operation_id: 'op-3', phase: 'committed',
  });
  const thrown = resolve({}, { explicitRunId: 'A', captureRunSnapshot: () => { throw thrownError; } });
  assert.equal(thrown.reason, 'reconciliation-required');
  assert.deepEqual(thrown.errors.A, { kind: 'reconciliation-required', operation_id: 'op-3', phase: 'committed' });

  const root = mkdtempSync(join(tmpdir(), 'deep-loop-context-explicit-'));
  const runId = initRun(root, { runtime: 'claude', goal: 'explicit prepared', now: new Date('2026-07-23T00:00:00.000Z') }).runId;
  seedPrepared(root, runId, 'context-explicit-prepared');
  for (let index = 0; index < 65; index += 1) mkdirSync(join(root, '.deep-loop', 'runs', `corrupt-${index}`));
  const before = durableBytes(root, runId);
  const production = resolveRunContext({
    root,
    explicitRunId: runId,
    captureRunSnapshot: captureVerifiedRunSnapshot,
    captureRunSet() { throw new Error('explicit capture must not enumerate'); },
    nowFn: () => 100,
    sleepFn: () => {},
  });
  assert.equal(production.reason, 'reconciliation-required');
  assert.deepEqual(production.errors[runId], {
    kind: 'reconciliation-required', operation_id: 'context-explicit-prepared', phase: 'prepared',
  });
  assert.deepEqual(durableBytes(root, runId), before);
});

test('relative cwd is canonicalized by the injected realpath function', () => {
  const result = resolve({ A: snapshot('A', 'running', ['.worktrees/a']) }, { cwd: 'relative', realpathFn: value => value === 'relative' ? '/project/.worktrees/a' : value });
  assert.equal(result.source, 'worktree');
});

// ── issue #77: terminal history claims (design §3.3–3.5) ──────────────────────────
const terminalRun = (runId, worktree, extra = {}) => snapshot(runId, extra.status ?? 'completed',
  [{ path: worktree, status: extra.wsStatus ?? 'ready' }], extra.root ?? ROOT);

test('T5 a legacy absolute claim inside the root is normalized for terminal history', () => {
  const runs = { T: terminalRun('T', '/project/.worktrees/old'), A: snapshot('A', 'running') };
  const outside = resolve(runs);
  assert.equal(outside.source, 'single-active');
  assert.deepEqual(outside.history, { isolated_claims: 0, legacy_absolute_claims: 1 });
  const inside = resolve(runs, { cwd: '/project/.worktrees/old/sub' });
  assert.equal(inside.reason, 'terminal-residue');
  assert.deepEqual(inside.history, { isolated_claims: 0, legacy_absolute_claims: 1 });
});

test('T5 a legacy absolute claim recorded through a stored root alias is normalized', () => {
  const alias = value => (value.startsWith('/alias/project') ? value.replace('/alias/project', '/project') : value);
  const runs = { T: terminalRun('T', '/alias/project/.worktrees/old', { root: '/alias/project' }), A: snapshot('A', 'running') };
  const result = resolve(runs, { realpathFn: alias, cwd: '/project/.worktrees/old/sub' });
  assert.equal(result.reason, 'terminal-residue');
  assert.deepEqual(result.history, { isolated_claims: 0, legacy_absolute_claims: 1 });
});

test('T5 unresolvable terminal claims are isolated and keep only an in-root residue region', () => {
  for (const [claim, insideCwd, outsideCwd] of [
    ['/elsewhere/.worktrees/x', null, '/project/.worktrees/x/file'],
    ['../x', null, '/x/file'],
    ['.worktrees/e\u0301', '/project/.worktrees/e\u0301/file', '/project/.worktrees/e/file'],
    ['.worktrees\\e\u0301', '/project/.worktrees/e\u0301/file', null],
    // Outside the convention directories an isolated claim leaves no region at all.
    ['/project/src', null, '/project/src/file'],
    ['src', null, '/project/src/file'],
    ['.worktrees', null, '/project/.worktrees/any/file'],
    // A dot segment cannot be normalized without the old tree, and leaves no region.
    ['/project/.worktrees/a/../old', null, '/project/.worktrees/old/file'],
  ]) {
    const runs = { T: terminalRun('T', claim), A: snapshot('A', 'running') };
    const root = resolve(runs);
    assert.equal(root.source, 'single-active', claim);
    assert.deepEqual(root.history, { isolated_claims: 1, legacy_absolute_claims: 0 }, claim);
    if (insideCwd) assert.equal(resolve(runs, { cwd: insideCwd }).reason, 'terminal-residue', claim);
    if (outsideCwd) assert.equal(resolve(runs, { cwd: outsideCwd }).source, 'single-active', claim);
  }
});

test('T5 an isolated region never makes its run legacy-current', () => {
  const runs = { T: snapshot('T', 'completed', [
    { path: '.worktrees/valid', status: 'ready' },
    { path: '.worktrees/e\u0301', status: 'ready' },
  ]) };
  const inRegion = resolve(runs, { current: 'T', cwd: '/project/.worktrees/e\u0301/file' });
  assert.equal(inRegion.kind, 'none');
  assert.equal(inRegion.reason, 'terminal-residue');
  const inValid = resolve(runs, { current: 'T', cwd: '/project/.worktrees/valid/file' });
  assert.equal(inValid.source, 'legacy-current');
});

test('T5 the claim inventory is bounded like the run set', () => {
  const many = Array.from({ length: 4097 }, (_, index) => `.worktrees/w${index}`);
  const result = resolve({ A: snapshot('A', 'running', many) });
  assert.equal(result.reason, 'run-set-bound-exceeded');
  assert.equal(result.phase, 'claims');
  assert.equal(result.bound, 'count');
  assert.equal(result.max_claims, 4096);
});

test('T6 a ready workstream of an active run is a terminal claim: residue, not a duplicate', () => {
  const runs = {
    A: snapshot('A', 'running', [{ path: '.worktrees/x', status: 'ready' }]),
    B: snapshot('B', 'running', [{ path: '.worktrees/x', status: 'in_progress' }]),
  };
  assert.equal(resolve(runs).reason, 'multi-active-root-cwd');
  assert.equal(resolve(runs, { cwd: '/project/.worktrees/x/file' }).reason, 'terminal-residue');
});

test('T5 a claim naming the root itself is isolated without a residue region', () => {
  const runs = { T: terminalRun('T', '/project'), A: snapshot('A', 'running') };
  assert.equal(resolve(runs, { cwd: '/project/anything' }).source, 'single-active');
});

test('T5 any invalid claim of a non-terminal run fails closed whatever its workstream status', () => {
  for (const wsStatus of ['ready', 'merged', 'abandoned', 'in_progress']) {
    const result = resolve({
      A: snapshot('A', 'running', [{ path: '/project/.worktrees/old', status: wsStatus }]),
      T: terminalRun('T', '.worktrees/t'),
    });
    assert.equal(result.reason, 'invalid-worktree-claim', wsStatus);
    assert.deepEqual(result.errors, { A: { kind: 'invalid-worktree-claim' } }, wsStatus);
  }
  const paused = resolve({ P: snapshot('P', 'paused', [{ path: '/project/.worktrees/old', status: 'ready' }]) });
  assert.equal(paused.reason, 'invalid-worktree-claim');
});

test('T6 terminal claims never make the project ambiguous', () => {
  const twoTerminal = {
    T1: terminalRun('T1', '.worktrees/shared'),
    T2: terminalRun('T2', '.worktrees/shared', { status: 'stopped' }),
    A: snapshot('A', 'running', ['.worktrees/mine']),
  };
  assert.equal(resolve(twoTerminal).source, 'single-active');
  assert.equal(resolve(twoTerminal, { cwd: '/project/.worktrees/shared/x' }).reason, 'terminal-residue');
  assert.equal(resolve(twoTerminal, { cwd: '/project/.worktrees/mine/x' }).source, 'worktree');
  const physical = value => (value.endsWith('/.worktrees/alias') ? '/project/.worktrees/shared' : value);
  const viaAlias = resolve({ T: terminalRun('T', '.worktrees/alias'), A: snapshot('A', 'running', ['.worktrees/shared']) }, { realpathFn: physical });
  assert.equal(viaAlias.source, 'single-active');
});

test('T6 Windows folded terminal claims cannot select an unrelated active run', () => {
  const runs = {
    T: terminalRun('T', '.worktrees/ß'),
    A: snapshot('A', 'running', ['.worktrees/ss']),
  };
  const inTerminal = resolve(runs, { platform: 'win32', cwd: '/project/.worktrees/ß/file' });
  assert.equal(inTerminal.reason, 'terminal-residue');
  // The folded key no longer conflicts: containment uses the claimed path itself, so a cwd
  // in the physically distinct active directory still selects the active run.
  const inActive = resolve(runs, { platform: 'win32', cwd: '/project/.worktrees/ss/file' });
  assert.equal(inActive.source, 'worktree');
  assert.equal(inActive.runId, 'A');
});

test('T8 win32 legacy absolute claims normalize across separators and drive case but not drives', () => {
  const runs = (claim) => ({ T: terminalRun('T', claim, { root: 'C:\\project' }), A: snapshot('A', 'running', [], 'C:\\project') });
  const opts = { platform: 'win32', root: 'C:\\project' };
  const same = resolve(runs('c:\\PROJECT\\.worktrees\\Old'), opts);
  assert.deepEqual(same.history, { isolated_claims: 0, legacy_absolute_claims: 1 });
  const otherDrive = resolve(runs('D:\\project\\.worktrees\\old'), opts);
  assert.deepEqual(otherDrive.history, { isolated_claims: 1, legacy_absolute_claims: 0 });
  assert.equal(otherDrive.source, 'single-active');
});

test('T5 a POSIX legacy absolute claim with a literal backslash is not moved by normalization', () => {
  const runs = {
    T: terminalRun('T', '/project/.worktrees\\old'),
    A: snapshot('A', 'running', ['.worktrees/old']),
  };
  const result = resolve(runs, { cwd: '/project/.worktrees/old/file' });
  assert.equal(result.source, 'worktree');
  assert.equal(result.runId, 'A');
  assert.deepEqual(result.history, { isolated_claims: 1, legacy_absolute_claims: 0 });
  const alone = resolve({ T: terminalRun('T', '/project/.worktrees\\old') }, { current: 'T' });
  assert.notEqual(alone.source, 'legacy-current');
});

test('T8 a win32 UNC legacy claim against a drive root is isolated without a region', () => {
  const runs = {
    T: terminalRun('T', '\\\\server\\share\\project\\.worktrees\\x', { root: 'C:\\project' }),
    A: snapshot('A', 'running', [], 'C:\\project'),
  };
  const result = resolve(runs, { platform: 'win32', root: 'C:\\project' });
  assert.deepEqual(result.history, { isolated_claims: 1, legacy_absolute_claims: 0 });
  assert.equal(result.source, 'single-active');
});
