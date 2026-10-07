import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { createDirectoryJunction, createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { finishRun } from '../scripts/lib/finish.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { resolveRunContext } from '../scripts/lib/run-context.mjs';
import { runDir } from '../scripts/lib/state.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { appendAnchored } from '../scripts/lib/integrity.mjs';
import {
  RUN_SELECTION_BOUNDS,
  captureVerifiedRunSet,
  captureVerifiedRunSnapshot,
  readTerminalHistoryLight,
} from '../scripts/lib/integrity.mjs';

let clock = Date.UTC(2026, 5, 1);

function freshRoot() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'deep-loop-history-')));
}

function seedRun(root, { status = 'running' } = {}) {
  clock += 60_000;
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date(clock) });
  if (status === 'stopped') {
    finishRun(root, runId, {
      status: 'stopped',
      proof: { human_reason: 'fixture' },
      confirm: true,
      fence: { owner: runId, generation: 1, intent: 'business' },
    });
  }
  return runId;
}

function readLoop(root, runId) {
  return JSON.parse(readFileSync(join(runDir(root, runId), 'loop.json'), 'utf8'));
}

// Writes a hash-consistent loop.json. Only the light reader trusts this pair; a full
// capture of a forged run still checks the event log against it.
function writeLoop(root, runId, data, { hash = true } = {}) {
  const raw = JSON.stringify(data, null, 2);
  writeFileSync(join(runDir(root, runId), 'loop.json'), raw);
  if (hash) writeFileSync(join(runDir(root, runId), '.loop.hash'), contentHash(raw));
}

// A terminal history entry for the light path only: loop.json + .loop.hash, no log.
function cloneTerminal(root, sourceRunId, newRunId) {
  mkdirSync(runDir(root, newRunId), { recursive: true });
  writeLoop(root, newRunId, { ...readLoop(root, sourceRunId), run_id: newRunId });
}

function cloneId(index) {
  return `01TERMINAL${String(index).padStart(16, '0')}`;
}

function durableBytes(root) {
  const base = join(root, '.deep-loop');
  const out = [];
  const visit = current => {
    for (const name of readdirSync(current).sort()) {
      if (name === '.lock') continue;
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else out.push([path.slice(base.length), readFileSync(path).toString('base64')]);
    }
  };
  visit(base);
  return out;
}

function fullCaptureSpy() {
  const calls = [];
  const fn = (root, runId, options) => {
    calls.push({ runId, options });
    return captureVerifiedRunSnapshot(root, runId, options);
  };
  return { calls, fn };
}

const fast = (extra = {}) => ({ historyFastPath: true, ...extra });

test('RUN_SELECTION_BOUNDS is the single frozen source of the selection limits', () => {
  assert.equal(Object.isFrozen(RUN_SELECTION_BOUNDS), true);
  assert.equal(RUN_SELECTION_BOUNDS.maxRunIds, 256);
  assert.equal(RUN_SELECTION_BOUNDS.maxFullCaptures, 64);
  assert.equal(RUN_SELECTION_BOUNDS.maxLightBytes, 32 * 1024 * 1024);
  assert.equal(RUN_SELECTION_BOUNDS.maxClaims, 4096);
  assert.equal(RUN_SELECTION_BOUNDS.baseDeadlineMs, 500);
  assert.equal(RUN_SELECTION_BOUNDS.perLightReadMs, 2);
  assert.equal(RUN_SELECTION_BOUNDS.perFullCaptureMs, 100);
  assert.deepEqual(RUN_SELECTION_BOUNDS.maxDeadlineMs, {
    'cli-read': 3000, 'run-list': 6900, 'hook-checkpoint': 6900, 'hook-restore': 6900, headless: 6900,
  });
});

test('T1 terminal runs are classified from a hash-verified state without a lock', () => {
  const root = freshRoot();
  const stopped = [seedRun(root, { status: 'stopped' }), seedRun(root, { status: 'stopped' })];
  const active = seedRun(root);
  const spy = fullCaptureSpy();
  let tokens = 0;
  const before = durableBytes(root);
  const captured = captureVerifiedRunSet(root, fast({
    captureRunSnapshotFn: spy.fn,
    lockOptions: { tokenFactory: () => { tokens += 1; return crypto.randomUUID(); } },
  }));
  assert.deepEqual(Object.keys(captured.errors), []);
  for (const runId of stopped) {
    assert.equal(captured.runs[runId].verification, 'state-hash');
    assert.equal(captured.runs[runId].snapshot.data.status, 'stopped');
  }
  assert.equal(captured.runs[active].verification, 'full');
  assert.deepEqual(spy.calls.map(call => call.runId), [active]);
  assert.equal(tokens, 1, 'only the non-terminal run takes a lock');
  assert.deepEqual(durableBytes(root), before, 'a set capture writes nothing');
});

test('T1 a held lock on every terminal run does not block the set capture', () => {
  const root = freshRoot();
  const stopped = [seedRun(root, { status: 'stopped' }), seedRun(root, { status: 'stopped' })];
  const active = seedRun(root);
  for (const runId of stopped) mkdirSync(join(runDir(root, runId), '.lock'));
  try {
    const captured = captureVerifiedRunSet(root, fast({ lockOptions: { retries: 1, backoffMs: 0 } }));
    assert.deepEqual(Object.keys(captured.errors), []);
    assert.equal(captured.runs[active].verification, 'full');
  } finally {
    for (const runId of stopped) rmSync(join(runDir(root, runId), '.lock'), { recursive: true, force: true });
  }
});

test('T1 the light reader returns the parsed state and refuses non-terminal runs', () => {
  const root = freshRoot();
  const stopped = seedRun(root, { status: 'stopped' });
  const active = seedRun(root);
  const light = readTerminalHistoryLight(root, stopped);
  assert.equal(light.ok, true);
  assert.equal(light.verification, 'state-hash');
  assert.equal(light.snapshot.data.run_id, stopped);
  assert.equal(typeof light.snapshot.hash, 'string');
  assert.equal(readTerminalHistoryLight(root, active).ok, false);
});

test('T2 every unverifiable terminal shape falls back to full capture and fails closed', () => {
  const cases = {
    'hash mismatch': (root, runId) => {
      writeFileSync(join(runDir(root, runId), 'loop.json'), `${readFileSync(join(runDir(root, runId), 'loop.json'), 'utf8')} `);
    },
    'missing hash': (root, runId) => rmSync(join(runDir(root, runId), '.loop.hash')),
    'foreign project root': (root, runId) => {
      const other = freshRoot();
      const data = readLoop(root, runId);
      data.project.root = other;
      writeLoop(root, runId, data);
    },
    'schema-invalid but hash-consistent': (root, runId) => {
      const data = readLoop(root, runId);
      data.workstreams = {};
      writeLoop(root, runId, data);
    },
    'unsupported schema version': (root, runId) => {
      const data = readLoop(root, runId);
      data.schema_version = '9.9.9';
      writeLoop(root, runId, data);
    },
  };
  for (const [label, damage] of Object.entries(cases)) {
    const root = freshRoot();
    const terminal = seedRun(root, { status: 'stopped' });
    const active = seedRun(root);
    damage(root, terminal);
    const spy = fullCaptureSpy();
    const captured = captureVerifiedRunSet(root, fast({ captureRunSnapshotFn: spy.fn }));
    assert.deepEqual(spy.calls.map(call => call.runId).sort(), [active, terminal].sort(), label);
    assert.ok(captured.errors[terminal], `${label}: the damaged run is a set error`);
    assert.equal(captured.runs[active]?.verification, 'full', `${label}: healthy runs stay in a fast-path set`);
  }
});

test('T2 a symlinked loop.json falls back to full capture and fails closed', t => {
  const root = freshRoot();
  const terminal = seedRun(root, { status: 'stopped' });
  const active = seedRun(root);
  const path = join(runDir(root, terminal), 'loop.json');
  const moved = join(root, 'moved-loop.json');
  writeFileSync(moved, readFileSync(path));
  rmSync(path);
  if (!createFileSymlinkOrSkip(t, moved, path)) return;
  assert.equal(readTerminalHistoryLight(root, terminal).ok, false);
  const spy = fullCaptureSpy();
  const captured = captureVerifiedRunSet(root, fast({ captureRunSnapshotFn: spy.fn }));
  assert.deepEqual(spy.calls.map(call => call.runId).sort(), [active, terminal].sort());
  assert.ok(captured.errors[terminal]);
});

test('T2 a failed light read is still charged its declared bytes', () => {
  const root = freshRoot();
  const terminal = seedRun(root, { status: 'stopped' });
  const loopSize = lstatSync(join(runDir(root, terminal), 'loop.json')).size;
  rmSync(join(runDir(root, terminal), '.loop.hash'));
  const light = readTerminalHistoryLight(root, terminal);
  assert.equal(light.ok, false);
  assert.equal(light.bytes, loopSize);
  const captured = captureVerifiedRunSet(root, fast({ maxLightBytes: loopSize - 1, nowFn: () => 1_000 }));
  assert.equal(captured.phase, 'classification');
  assert.equal(captured.bound, 'bytes');
});

test('T2 an oversized terminal loop.json falls back to the locked capture, which accepts it', () => {
  const root = freshRoot();
  const terminal = seedRun(root, { status: 'stopped' });
  const data = readLoop(root, terminal);
  data.goal = 'g'.repeat(1024 * 1024);
  writeLoop(root, terminal, data);
  const light = readTerminalHistoryLight(root, terminal);
  assert.equal(light.ok, false);
  assert.ok(light.bytes > 1024 * 1024);
  const captured = captureVerifiedRunSet(root, fast({ nowFn: () => 1_000 }));
  assert.deepEqual(Object.keys(captured.errors), []);
  assert.equal(captured.runs[terminal].verification, 'full');
});

test('T2 a pre-0.4 terminal state passes the light path through the same migration', () => {
  const root = freshRoot();
  const terminal = seedRun(root, { status: 'stopped' });
  const data = readLoop(root, terminal);
  data.schema_version = '0.3.0';
  delete data.project.binding_generation;
  delete data.autonomy.attended_launch_approval;
  delete data.session_chain.lease.takeover_kind;
  for (const session of data.session_chain.sessions) delete session.scope;
  data.autonomy.continuation_policy = 'compact-in-place';
  writeLoop(root, terminal, data);
  const light = readTerminalHistoryLight(root, terminal);
  assert.equal(light.ok, true, JSON.stringify(light));
  assert.equal(light.snapshot.data.status, 'stopped');
});

test('T2 a run id that does not match its directory is not light-verified', () => {
  const root = freshRoot();
  const source = seedRun(root, { status: 'stopped' });
  const copy = cloneId(1);
  mkdirSync(runDir(root, copy), { recursive: true });
  writeLoop(root, copy, readLoop(root, source));
  assert.equal(readTerminalHistoryLight(root, copy).ok, false);
});

test('T2 a symlinked run directory is not light-verified', () => {
  const root = freshRoot();
  const source = seedRun(root, { status: 'stopped' });
  const target = join(root, 'elsewhere');
  mkdirSync(target);
  cloneTerminal(root, source, cloneId(2));
  const alias = cloneId(3);
  createDirectoryJunction(runDir(root, cloneId(2)), runDir(root, alias));
  assert.equal(readTerminalHistoryLight(root, alias).ok, false);
});

test('T2 a run directory without loop.json is state-missing without a full capture', () => {
  const root = freshRoot();
  const active = seedRun(root);
  const empty = cloneId(4);
  mkdirSync(runDir(root, empty), { recursive: true });
  const spy = fullCaptureSpy();
  const captured = captureVerifiedRunSet(root, fast({ captureRunSnapshotFn: spy.fn }));
  assert.equal(captured.errors[empty]?.kind, 'state-missing');
  assert.deepEqual(spy.calls.map(call => call.runId), [active]);
  assert.equal(captured.runs[active]?.verification, 'full');
});

test('T2 the default (non fast path) set still discards every run when one errors', () => {
  const root = freshRoot();
  const active = seedRun(root);
  mkdirSync(runDir(root, cloneId(5)), { recursive: true });
  const captured = captureVerifiedRunSet(root, { maxRunIds: 64, deadlineMs: 500 });
  assert.ok(captured.errors[cloneId(5)]);
  assert.equal(captured.runs[active], undefined);
});

test('T2b a torn pair falls back and the locked capture decides', () => {
  const root = freshRoot();
  const terminal = seedRun(root, { status: 'stopped' });
  const hashPath = join(runDir(root, terminal), '.loop.hash');
  const goodHash = readFileSync(hashPath);
  writeFileSync(hashPath, '0'.repeat(64));
  const spy = [];
  const captured = captureVerifiedRunSet(root, fast({
    captureRunSnapshotFn: (captureRoot, runId, options) => {
      spy.push(runId);
      // The writer finishes its publication before the locked re-read.
      writeFileSync(hashPath, goodHash);
      return captureVerifiedRunSnapshot(captureRoot, runId, options);
    },
  }));
  assert.deepEqual(spy, [terminal]);
  assert.deepEqual(Object.keys(captured.errors), []);
  assert.equal(captured.runs[terminal].verification, 'full');
  assert.equal(captured.runs[terminal].snapshot.data.status, 'stopped');
});

test('T3 one active run and 255 terminal runs fit the bounds', () => {
  const root = freshRoot();
  const source = seedRun(root, { status: 'stopped' });
  for (let index = 0; index < 254; index += 1) cloneTerminal(root, source, cloneId(index));
  const active = seedRun(root);
  const spy = fullCaptureSpy();
  let now = 1_000;
  const captured = captureVerifiedRunSet(root, fast({ captureRunSnapshotFn: spy.fn, nowFn: () => now }));
  assert.deepEqual(Object.keys(captured.errors), []);
  assert.equal(captured.runIds.length, 256);
  assert.deepEqual(spy.calls.map(call => call.runId), [active]);
});

test('T3 more than 256 run directories exceed the enumeration count bound', () => {
  const root = freshRoot();
  mkdirSync(join(root, '.deep-loop', 'runs'), { recursive: true });
  for (let index = 0; index < 257; index += 1) mkdirSync(runDir(root, cloneId(index)));
  writeFileSync(join(root, '.deep-loop', 'runs', 'not-a-dir'), 'x');
  const captured = captureVerifiedRunSet(root, fast({ nowFn: () => 1_000 }));
  assert.equal(captured.ok, false);
  assert.equal(captured.kind, 'run-set-bound-exceeded');
  assert.equal(captured.phase, 'enumeration');
  assert.equal(captured.bound, 'count');
  assert.equal(captured.max_run_ids, 256);
  assert.equal(captured.total_is_lower_bound, true);
});

test('T3 non-directory entries do not count toward the enumeration bound', () => {
  const root = freshRoot();
  const source = seedRun(root, { status: 'stopped' });
  for (let index = 0; index < 255; index += 1) cloneTerminal(root, source, cloneId(index));
  for (let index = 0; index < 20; index += 1) {
    writeFileSync(join(root, '.deep-loop', 'runs', `${cloneId(900 + index)}`), 'x');
  }
  const captured = captureVerifiedRunSet(root, fast({ nowFn: () => 1_000 }));
  assert.deepEqual(Object.keys(captured.errors), []);
  assert.equal(captured.runIds.length, 256);
});

test('T3 more full captures than the bound exceed the full-capture-count bound', () => {
  const root = freshRoot();
  for (let index = 0; index < 3; index += 1) seedRun(root);
  const spy = fullCaptureSpy();
  const captured = captureVerifiedRunSet(root, fast({ maxFullCaptures: 2, captureRunSnapshotFn: spy.fn, nowFn: () => 1_000 }));
  assert.equal(captured.ok, false);
  assert.equal(captured.phase, 'full-capture-count');
  assert.equal(captured.bound, 'count');
  assert.equal(captured.full_capture_count, 3);
  assert.equal(captured.max_full_captures, 2);
  assert.equal(spy.calls.length, 0, 'the count is checked before any locked capture');
});

test('T3 the light byte budget is exact', () => {
  const root = freshRoot();
  const a = seedRun(root, { status: 'stopped' });
  const b = seedRun(root, { status: 'stopped' });
  const size = runId => lstatSync(join(runDir(root, runId), 'loop.json')).size
    + lstatSync(join(runDir(root, runId), '.loop.hash')).size;
  const total = size(a) + size(b);
  const fits = captureVerifiedRunSet(root, fast({ maxLightBytes: total, nowFn: () => 1_000 }));
  assert.deepEqual(Object.keys(fits.errors), []);
  const over = captureVerifiedRunSet(root, fast({ maxLightBytes: total - 1, nowFn: () => 1_000 }));
  assert.equal(over.ok, false);
  assert.equal(over.phase, 'classification');
  assert.equal(over.bound, 'bytes');
});

test('T4 the full-capture deadline scales with the number of full captures and is capped', () => {
  for (const [count, maxDeadlineMs, expected] of [[1, 3000, 600], [3, 3000, 800], [40, 3000, 3000], [64, 6900, 6900]]) {
    const seen = [];
    const root = freshRoot();
    const source = seedRun(root, { status: 'stopped' });
    const ids = [];
    for (let index = 0; index < count; index += 1) ids.push(cloneId(index));
    for (const id of ids) {
      mkdirSync(runDir(root, id), { recursive: true });
      writeLoop(root, id, { ...readLoop(root, source), run_id: id, status: 'running' });
    }
    captureVerifiedRunSet(root, fast({
      nowFn: () => 10_000,
      maxDeadlineMs,
      captureRunSnapshotFn: (_root, runId, options) => {
        seen.push(options.vectorDeadlineAtMs);
        return { ok: true, kind: 'clean-no-publication', snapshot: { data: readLoop(root, runId), hash: 'h' } };
      },
    }));
    assert.equal(seen.length, count);
    assert.deepEqual([...new Set(seen)], [10_000 + expected], `count ${count}`);
  }
});

test('T4 classification past its own deadline exceeds the classification bound', () => {
  const root = freshRoot();
  const source = seedRun(root, { status: 'stopped' });
  for (let index = 0; index < 4; index += 1) cloneTerminal(root, source, cloneId(index));
  // The clock stands still through enumeration and then jumps past 500 + 2 x 5 ms.
  let now = 1_000;
  let classifying = false;
  const captured = captureVerifiedRunSet(root, fast({
    nowFn: () => (classifying ? (now += 200) : now),
    afterEnumeration: () => { classifying = true; },
  }));
  assert.equal(captured.ok, false);
  assert.equal(captured.kind, 'run-set-bound-exceeded');
  assert.equal(captured.phase, 'classification');
  assert.equal(captured.bound, 'deadline');
  assert.equal(captured.deadline_ms, 500 + 2 * 5);
});

test('T4 classification scales with the directory count and full capture starts after it', () => {
  const root = freshRoot();
  const source = seedRun(root, { status: 'stopped' });
  for (let index = 0; index < 99; index += 1) cloneTerminal(root, source, cloneId(index));
  const active = seedRun(root);
  // 101 directories. The clock moves 6 ms per reading only while classifying, so
  // classification ends past the 500 ms base but inside 500 + 2 x 101 ms.
  let now = 0;
  let classifying = false;
  const seen = [];
  const captured = captureVerifiedRunSet(root, fast({
    nowFn: () => (classifying ? (now += 6) : now),
    afterEnumeration: () => { classifying = true; },
    captureRunSnapshotFn: (captureRoot, runId, options) => {
      classifying = false;
      seen.push({ deadline: options.vectorDeadlineAtMs, at: now });
      return captureVerifiedRunSnapshot(captureRoot, runId, { ...options, nowFn: undefined, vectorDeadlineAtMs: undefined });
    },
  }));
  assert.deepEqual(Object.keys(captured.errors), []);
  assert.equal(captured.runs[active].verification, 'full');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].at > 500, `classification ran past the base budget (${seen[0].at} ms)`);
  assert.equal(seen[0].deadline, seen[0].at + 600, 'the full-capture budget starts when classification ends');
});

test('T4 run-list and omitted purposes get their own deadline caps', async () => {
  const { runSelectionSetOptions } = await import('../scripts/lib/run-context.mjs');
  assert.equal(runSelectionSetOptions().maxDeadlineMs, 3000);
  assert.equal(runSelectionSetOptions('cli-read').maxDeadlineMs, 3000);
  assert.equal(runSelectionSetOptions('run-list').maxDeadlineMs, 6900);
  assert.equal(runSelectionSetOptions('hook-restore').maxDeadlineMs, 6900);
  assert.equal(runSelectionSetOptions('unknown').maxDeadlineMs, 3000);
});

test('T2 a lock that stays busy is named lock-busy', () => {
  const root = freshRoot();
  const active = seedRun(root);
  mkdirSync(join(runDir(root, active), '.lock'));
  try {
    const captured = captureVerifiedRunSet(root, fast({ lockOptions: { retries: 1, backoffMs: 0 }, sleepFn: () => {} }));
    assert.equal(captured.errors[active]?.kind, 'lock-busy', JSON.stringify(captured.errors));
  } finally {
    rmSync(join(runDir(root, active), '.lock'), { recursive: true, force: true });
  }
});

// A stopped run whose only claim was recorded as an absolute path by an older writer.
function seedLegacyTerminal(root) {
  clock += 60_000;
  const { runId } = initRun(root, { runtime: 'claude', goal: 'legacy', now: new Date(clock) });
  const worktree = join(root, '.worktrees', 'old');
  mkdirSync(worktree, { recursive: true });
  newWorkstream(root, runId, {
    title: 'old', branch: 'feature/old', worktree,
    fence: { owner: runId, generation: 1 },
  });
  finishRun(root, runId, {
    status: 'stopped', proof: { human_reason: 'fixture' }, confirm: true,
    fence: { owner: runId, generation: 1, intent: 'business' },
  });
  const data = readLoop(root, runId);
  data.workstreams[0].worktree = worktree;
  writeLoop(root, runId, data);
  return { runId, worktree };
}

test('T5b legacy-current returns the re-captured snapshot from both branches', () => {
  const root = freshRoot();
  const { runId, worktree } = seedLegacyTerminal(root);
  writeFileSync(join(root, '.deep-loop', 'current'), `${runId}\n`);
  let recaptures = 0;
  const captureRunSnapshot = (captureRoot, id, options) => {
    recaptures += 1;
    return captureVerifiedRunSnapshot(captureRoot, id, options);
  };
  const atRoot = resolveRunContext({ root, cwd: root, purpose: 'cli-read', captureRunSnapshot });
  assert.equal(atRoot.kind, 'selected', JSON.stringify(atRoot));
  assert.equal(atRoot.source, 'legacy-current');
  assert.ok(atRoot.snapshot.vector, 'a full capture carries the verified vector');
  assert.deepEqual(atRoot.history, { isolated_claims: 0, legacy_absolute_claims: 1 });
  const inside = resolveRunContext({ root, cwd: join(worktree), purpose: 'cli-read', captureRunSnapshot });
  assert.equal(inside.source, 'legacy-current');
  assert.equal(inside.matchedWorktree, worktree);
  assert.ok(inside.snapshot.vector);
  assert.equal(recaptures, 2);
});

test('T7 a failed or diverging re-capture is run-set-integrity, never identity-invalid', () => {
  const root = freshRoot();
  const { runId } = seedLegacyTerminal(root);
  writeFileSync(join(root, '.deep-loop', 'current'), `${runId}\n`);
  const thrown = resolveRunContext({ root, cwd: root, captureRunSnapshot: () => { throw new Error('LOCK_BUSY: held'); } });
  assert.equal(thrown.reason, 'run-set-integrity');
  assert.deepEqual(Object.keys(thrown.errors), [runId]);
  const refused = resolveRunContext({ root, cwd: root, captureRunSnapshot: () => ({ ok: false, kind: 'reconciliation-required' }) });
  assert.equal(refused.reason, 'run-set-integrity');
  assert.equal(refused.errors[runId].kind, 'reconciliation-required');
  const diverged = resolveRunContext({
    root, cwd: root,
    captureRunSnapshot: (captureRoot, id, options) => {
      const real = captureVerifiedRunSnapshot(captureRoot, id, options);
      return { ...real, snapshot: { ...real.snapshot, data: { ...real.snapshot.data, status: 'paused' } } };
    },
  });
  assert.equal(diverged.reason, 'run-set-integrity');
  assert.equal(diverged.errors[runId].kind, 'state-drift');
  const deadlines = [];
  resolveRunContext({
    root, cwd: root, nowFn: () => 7_000,
    captureRunSnapshot: (captureRoot, id, options) => {
      deadlines.push(options.vectorDeadlineAtMs);
      return captureVerifiedRunSnapshot(captureRoot, id, { ...options, nowFn: undefined, vectorDeadlineAtMs: undefined });
    },
  });
  assert.deepEqual(deadlines, [7_000 + 500], 'the re-capture has its own 500 ms deadline');
  const otherClaims = resolveRunContext({
    root, cwd: root,
    captureRunSnapshot: (captureRoot, id, options) => {
      const real = captureVerifiedRunSnapshot(captureRoot, id, options);
      const data = structuredClone(real.snapshot.data);
      data.workstreams[0].worktree = '.worktrees/elsewhere';
      return { ...real, snapshot: { ...real.snapshot, data } };
    },
  });
  assert.equal(otherClaims.errors[runId].kind, 'state-drift');
});

test('T1 selection succeeds with 70 terminal runs while every terminal lock is held', () => {
  const root = freshRoot();
  const source = seedRun(root, { status: 'stopped' });
  const terminal = [source];
  for (let index = 0; index < 69; index += 1) {
    cloneTerminal(root, source, cloneId(index));
    terminal.push(cloneId(index));
  }
  const active = seedRun(root);
  for (const runId of terminal) mkdirSync(join(runDir(root, runId), '.lock'));
  try {
    const before = durableBytes(root);
    const result = resolveRunContext({ root, cwd: root, purpose: 'hook-checkpoint', lockOptions: { retries: 1, backoffMs: 0 } });
    assert.equal(result.kind, 'selected', JSON.stringify(result));
    assert.equal(result.source, 'single-active');
    assert.equal(result.runId, active);
    assert.deepEqual(durableBytes(root), before);
  } finally {
    for (const runId of terminal) rmSync(join(runDir(root, runId), '.lock'), { recursive: true, force: true });
  }
});

// ── CLI projections (T9, T10) ──────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addTerminalHistory } from './helpers/run-history.mjs';

const CLI = fileURLToPath(new URL('../scripts/deep-loop.mjs', import.meta.url));
function cli(root, args) {
  const out = spawnSync(process.execPath, [CLI, ...args, '--project-root', root], { cwd: root, encoding: 'utf8' });
  let parsed = null;
  try { parsed = JSON.parse(out.stdout); } catch { /* reported below */ }
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, json: parsed };
}

test('T9 run list shows 72 runs with their verification level, and keeps healthy rows beside an error', () => {
  const root = freshRoot();
  const active = seedRun(root);
  const { ids } = addTerminalHistory(root);
  let out = cli(root, ['run', 'list']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(out.json.ok, true);
  assert.equal(out.json.runs.length, 72);
  assert.deepEqual(out.json.errors, {});
  const byId = Object.fromEntries(out.json.runs.map(row => [row.run_id, row]));
  assert.equal(byId[active].verification, 'full');
  for (const id of ids) assert.equal(byId[id].verification, 'state-hash', id);
  mkdirSync(runDir(root, cloneId(990)), { recursive: true });
  out = cli(root, ['run', 'list']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(out.json.errors[cloneId(990)].kind, 'state-missing');
  const rows = Object.fromEntries(out.json.runs.map(row => [row.run_id, row]));
  assert.equal(rows[active].status, 'running');
  assert.equal(rows[cloneId(990)].status, null);
});

test('T10 run resolve projects history, the new reason and every bound field', () => {
  const root = freshRoot();
  seedRun(root);
  addTerminalHistory(root);
  let out = cli(root, ['run', 'resolve', '--cwd', root]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(out.json.kind, 'selected');
  assert.deepEqual(out.json.history, { isolated_claims: 0, legacy_absolute_claims: 1 });
  mkdirSync(runDir(root, cloneId(991)), { recursive: true });
  out = cli(root, ['run', 'resolve', '--cwd', root]);
  assert.equal(out.status, 1);
  assert.equal(out.json.reason, 'run-set-integrity', out.stdout);
  assert.deepEqual(out.json.errors, { [cloneId(991)]: { kind: 'state-missing' } });
  rmSync(runDir(root, cloneId(991)), { recursive: true });
  for (let index = 0; index < 256; index += 1) mkdirSync(runDir(root, cloneId(2000 + index)), { recursive: true });
  out = cli(root, ['run', 'resolve', '--cwd', root]);
  assert.equal(out.status, 1);
  assert.equal(out.json.reason, 'run-set-bound-exceeded', out.stdout);
  assert.equal(out.json.phase, 'enumeration');
  assert.equal(out.json.bound, 'count');
  assert.equal(out.json.max_run_ids, 256);
});

test('T10 a history with no isolated or normalized claim projects no history key', () => {
  const root = freshRoot();
  seedRun(root);
  seedRun(root, { status: 'stopped' });
  const out = cli(root, ['run', 'resolve', '--cwd', root]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(Object.hasOwn(out.json, 'history'), false);
});

// ── measurement (T17) ─────────────────────────────────────────────────────────────
test('T17 measurement: light history, 64 locked full captures and a whole run status process', t => {
  const frozen = () => 1_000; // deadlines off: this test measures, it does not gate
  const root = freshRoot();
  const source = seedRun(root, { status: 'stopped' });
  for (let index = 0; index < 191; index += 1) cloneTerminal(root, source, cloneId(index));
  const actives = [];
  for (let index = 0; index < 64; index += 1) actives.push(seedRun(root));
  let started = performance.now();
  for (let index = 0; index < 192; index += 1) readTerminalHistoryLight(root, index === 0 ? source : cloneId(index - 1));
  const lightMs = performance.now() - started;
  started = performance.now();
  const captured = captureVerifiedRunSet(root, fast({ nowFn: frozen }));
  const setMs = performance.now() - started;
  assert.deepEqual(Object.keys(captured.errors), []);
  assert.equal(Object.keys(captured.runs).length, 256);
  started = performance.now();
  const status = spawnSync(process.execPath, [CLI, 'run', 'status', '--json', '--cwd', root, '--project-root', root],
    { cwd: root, encoding: 'utf8' });
  const processMs = performance.now() - started;
  // 64 active runs make the cwd ambiguous; the envelope still arrives (or a bound names its phase).
  assert.ok([0, 1].includes(status.status), status.stdout + status.stderr);
  const envelope = JSON.parse(status.stdout);
  t.diagnostic(JSON.stringify({
    platform: process.platform, node: process.version,
    light_192_ms: Math.round(lightMs), set_192_light_64_full_ms: Math.round(setMs),
    per_full_capture_ms: Math.round((setMs - lightMs) / 64), run_status_process_ms: Math.round(processMs),
    run_status_resolution: `${envelope.resolution.kind}/${envelope.resolution.reason}`,
  }));
  assert.ok(processMs < 60_000, `run status took ${Math.round(processMs)} ms`);
});

test('T9 a terminal run with a leftover prepared transaction is history; exact reads still reject it', () => {
  const root = freshRoot();
  const terminal = seedRun(root);
  assert.throws(() => appendAnchored(
    root, terminal,
    { type: 'context-prepared', data: { operation_id: 'op-orphan' }, now: '2026-07-23T00:01:00.000Z' },
    loop => { loop.discovered_items.push('op-orphan'); },
    undefined,
    {
      publication: {
        kind: 'workstream-boundary',
        operationId: 'op-orphan',
        artifacts: [{ rel: 'artifacts/boundary.txt', bytes: Buffer.from('artifact') }],
        topology: { operation_id: 'op-orphan', phase: 'prepared' },
        faultAt(label) { if (label === 'prepared:digest-verified') throw new Error('orphan-fixture'); },
      },
      floor: 1,
    },
  ), /TRANSACTION_PENDING/);
  // The finished state an interrupted terminal publication could leave behind.
  const data = readLoop(root, terminal);
  data.status = 'stopped';
  writeLoop(root, terminal, data);
  const active = seedRun(root);
  const list = cli(root, ['run', 'list']);
  assert.equal(list.status, 0, list.stdout + list.stderr);
  assert.deepEqual(list.json.errors, {});
  assert.equal(list.json.runs.find(row => row.run_id === terminal).verification, 'state-hash');
  const resolved = cli(root, ['run', 'resolve', '--cwd', root]);
  assert.equal(resolved.json.run_id, active, resolved.stdout);
  // The exact (locked, full) read still refuses the run: the journal is verified there.
  const exact = captureVerifiedRunSnapshot(root, terminal);
  assert.equal(exact.ok, false);
  assert.ok(['reconciliation-required', 'integrity-invalid'].includes(exact.kind), exact.kind);
});
