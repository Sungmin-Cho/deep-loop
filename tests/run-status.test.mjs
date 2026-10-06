import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { runDir, withLock, readState, pauseRun } from '../scripts/lib/state.mjs';
import { tripBreaker } from '../scripts/lib/breaker.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { reviewedGoalWork, goalOk } from './helpers/reviewed-goal.mjs';
import { makeGoalFixture } from './helpers/goal-fixture.mjs';
import { buildRunStatus, publicReason } from '../scripts/lib/run-status.mjs';
import { resolveRunContext } from '../scripts/lib/run-context.mjs';
import { captureVerifiedRunSet } from '../scripts/lib/integrity.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deep-loop.mjs');
const SEED_NOW = '2026-10-06T00:00:00.000Z';
const NOW = '2026-10-06T00:30:00.000Z';
const ENVELOPE_KEYS = ['status_version', 'ok', 'resolution', 'run'];
const RESOLUTION_KEYS = ['kind', 'source', 'reason', 'total', 'candidates'];
const RUN_KEYS = ['run_id', 'status', 'pause_reason', 'budget', 'comprehension', 'pending_human_reviews',
  'breaker', 'workstreams', 'next_action'];

const created = [];
function tempRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-run-status-cli-')));
  created.push(root);
  return root;
}
test.after(() => { for (const root of created) rmSync(root, { recursive: true, force: true }); });

function seed(root = tempRoot()) {
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', now: new Date(SEED_NOW), env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  return { root, runId, fence: { owner: runId, generation: 1, intent: 'business' } };
}

const ENV = { ...process.env, NO_COLOR: '1', DEEP_LOOP_HEADLESS: '' };
function cli(argv, { cwd, env = ENV } = {}) {
  return spawnSync(process.execPath, [CLI, ...argv], { cwd, env, encoding: 'utf8', timeout: 120_000 });
}
function status(root, extra = [], opts = {}) {
  return cli(['run', 'status', '--json', '--project-root', root, ...extra, '--now', NOW], { cwd: root, ...opts });
}
function envelopeOf(result) {
  assert.ok(result.stdout.endsWith('\n'), 'envelope ends with a newline');
  const lines = result.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `exactly one envelope line, got: ${result.stdout}`);
  return JSON.parse(lines[0]);
}

function walk(dir, out = {}) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out[`${full}/`] = null; walk(full, out); }
    else out[full] = readFileSync(full).toString('base64');
  }
  return out;
}
const deepLoopTree = root => walk(join(root, '.deep-loop'));
const noLockLeft = root => Object.keys(deepLoopTree(root)).every(p => !/[\\/]\.lock(?:[\\/]|$)/.test(p));

function addMaker(s, { done = true, name = 'a', worktree = `.worktrees/${name}`, ws: existing } = {}) {
  const ws = existing ?? newWorkstream(s.root, s.runId, { title: name, branch: name, worktree, fence: s.fence, now: SEED_NOW }).id;
  writeFileSync(join(s.root, `art-${name}.txt`), 'x');
  const id = newEpisode(s.root, s.runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation',
    point: 'implementation', workstream: ws, expectedArtifacts: [`art-${name}.txt`], fence: s.fence, now: SEED_NOW }).id;
  if (done) {
    recordEpisode(s.root, s.runId, id, { status: 'in_progress', fence: s.fence, now: SEED_NOW });
    recordEpisode(s.root, s.runId, id, { status: 'done', artifacts: [`art-${name}.txt`], fence: s.fence, now: SEED_NOW });
  }
  return { ws, id };
}

test('T-K1: success envelope has exact keys and types, exit 0, one line', () => {
  const s = seed();
  addMaker(s, { done: false });
  const out = status(s.root);
  assert.equal(out.status, 0, out.stderr);
  const envelope = envelopeOf(out);
  assert.deepEqual(Object.keys(envelope), ENVELOPE_KEYS);
  assert.deepEqual(Object.keys(envelope.resolution), RESOLUTION_KEYS);
  assert.deepEqual(Object.keys(envelope.run), RUN_KEYS);
  assert.equal(envelope.status_version, 1);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.resolution.kind, 'selected');
  assert.equal(envelope.resolution.source, 'single-active');
  assert.equal(envelope.run.run_id, s.runId);
  assert.equal(envelope.run.status, 'running');
  assert.equal(envelope.run.workstreams.total, 1);
  assert.equal(typeof envelope.run.next_action.type, 'string');
  assert.equal(out.stderr, '');
});

test('T-K1: usage errors are exit 2 with empty stdout', () => {
  const s = seed();
  const base = ['run', 'status', '--json', '--project-root', s.root, '--now', NOW];
  for (const extra of [['--bogus'], ['--bogus', 'x'], ['stray'], ['--cwd'], ['--run-id'], ['--cwd', ''], ['--run-id='], ['--now'], ['--now='], ['--now', '']]) {
    const out = cli([...base, ...extra], { cwd: s.root });
    assert.equal(out.status, 2, `${extra.join(' ')}: ${out.stderr}`);
    assert.equal(out.stdout, '', extra.join(' '));
  }
  // --json is a switch: a stray value is a usage error, with or without --project-root
  for (const argv of [['run', 'status', '--json', 'stray', '--now', NOW],
    ['run', 'status', '--project-root', s.root, '--json', 'stray', '--now', NOW]]) {
    const stray = cli(argv, { cwd: s.root });
    assert.equal(stray.status, 2, argv.join(' '));
    assert.equal(stray.stdout, '', argv.join(' '));
  }
  const noValue = cli(['run', 'status', '--json', '--now', NOW, '--project-root'], { cwd: s.root });
  assert.equal(noValue.status, 2);
  assert.equal(noValue.stdout, '');
});

test('T-K1: an invalid --now is exit 1 with an invalid-now envelope', () => {
  const s = seed();
  const out = cli(['run', 'status', '--json', '--project-root', s.root, '--now', 'yesterday'], { cwd: s.root });
  assert.equal(out.status, 1);
  const envelope = envelopeOf(out);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.run, null);
  assert.equal(envelope.resolution.kind, 'invalid');
  assert.equal(envelope.resolution.reason, 'invalid-now');
  assert.deepEqual(Object.keys(envelope.resolution), RESOLUTION_KEYS);
});

test('T-K1: an unresolvable project root is an invalid envelope, exit 1', () => {
  const root = tempRoot();
  const missing = join(root, 'does-not-exist');
  const out = status(missing, [], { cwd: root });
  assert.equal(out.status, 1, out.stderr);
  const envelope = envelopeOf(out);
  assert.equal(envelope.resolution.kind, 'invalid');
  assert.equal(envelope.resolution.reason, 'root-unresolvable');
  assert.equal(envelope.ok, false);
});

test('T-K2: status writes nothing, even for a paused, a breaker-tripped and a v0.5 run', t => {
  const plain = seed();
  addMaker(plain);
  const paused = seed();
  pauseRun(paused.root, paused.runId, { reason: 'host-session-lost', expect: paused.fence, now: Date.parse(SEED_NOW) });
  const tripped = seed();
  tripBreaker(tripped.root, tripped.runId, 'consecutive-request-changes');
  const goal = reviewedGoalWork(t);
  const cases = [['running', plain], ['paused', paused], ['tripped', tripped], ['v0.5', { root: goal.root, runId: goal.runId }]];
  for (const [label, s] of cases) {
    const before = deepLoopTree(s.root);
    const lease = readState(s.root, s.runId).data.session_chain.lease.generation;
    for (let i = 0; i < 2; i += 1) {
      const out = status(s.root, ['--run-id', s.runId], { cwd: s.root });
      assert.equal(out.status, 0, `${label}: ${out.stderr}`);
    }
    assert.deepEqual(deepLoopTree(s.root), before, `${label}: bytes untouched`);
    assert.ok(noLockLeft(s.root), label);
    assert.equal(readState(s.root, s.runId).data.session_chain.lease.generation, lease, label);
    for (const name of ['loop.json', '.loop.hash']) {
      assert.ok(existsSync(join(runDir(s.root, s.runId), name)), `${label}: ${name}`);
    }
  }
});

test('T-K2: a damaged run beside a healthy one is invalid/run-set-integrity, bytes untouched', () => {
  const a = seed();
  const b = seed(a.root);
  const loopPath = join(runDir(b.root, b.runId), 'loop.json');
  const original = readFileSync(loopPath, 'utf8');
  writeFileSync(loopPath, original.replace('"goal": "g"', '"goal": "h"').replace('"goal":"g"', '"goal":"h"'));
  assert.notEqual(readFileSync(loopPath, 'utf8'), original);
  const before = deepLoopTree(a.root);
  const out = status(a.root);
  assert.equal(out.status, 1, out.stdout + out.stderr);
  const envelope = envelopeOf(out);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.resolution.kind, 'invalid');
  assert.equal(envelope.resolution.reason, 'run-set-integrity');
  assert.deepEqual(deepLoopTree(a.root), before);
});

test('T-K2: more than 64 run directories is invalid/run-set-bound-exceeded, bytes untouched', () => {
  const s = seed();
  const runs = join(s.root, '.deep-loop', 'runs');
  for (let i = 0; i < 65; i += 1) mkdirSync(join(runs, `R${String(i).padStart(3, '0')}`));
  const before = deepLoopTree(s.root);
  const out = status(s.root);
  assert.equal(out.status, 1, out.stdout + out.stderr);
  const envelope = envelopeOf(out);
  assert.equal(envelope.resolution.kind, 'invalid');
  assert.equal(envelope.resolution.reason, 'run-set-bound-exceeded');
  assert.deepEqual(deepLoopTree(s.root), before);
});

test('T-K2: a lock held by a live writer makes status invalid, and its lock survives untouched', () => {
  const s = seed();
  addMaker(s, { done: false });
  let out;
  let during;
  withLock(s.root, s.runId, () => {
    during = deepLoopTree(s.root);
    out = status(s.root);
    assert.deepEqual(deepLoopTree(s.root), during, 'lock and state are untouched by the reader');
    assert.ok(existsSync(join(runDir(s.root, s.runId), '.lock', 'owner.json')));
  });
  assert.equal(out.status, 1, out.stdout + out.stderr);
  const envelope = envelopeOf(out);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.run, null);
  assert.equal(envelope.resolution.kind, 'invalid');
  // Lock contention exhausts the bounded capture deadline, which the resolver reports as a bound; on a
  // slow host the per-run lock can give up first and surface as a run-set integrity failure instead.
  assert.ok(['run-set-bound-exceeded', 'run-set-integrity'].includes(envelope.resolution.reason),
    envelope.resolution.reason);
  assert.ok(noLockLeft(s.root), 'the writer released its lock');
  // and it recovers once the lock is gone
  assert.equal(envelopeOf(status(s.root)).resolution.kind, 'selected');
});

test('T-K3: no .deep-loop, and an empty runs directory, are ok:true / none', () => {
  const root = tempRoot();
  for (const prepare of [() => {}, () => mkdirSync(join(root, '.deep-loop', 'runs'), { recursive: true })]) {
    prepare();
    const out = status(root);
    assert.equal(out.status, 0, out.stderr);
    const envelope = envelopeOf(out);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.run, null);
    assert.equal(envelope.resolution.kind, 'none');
    assert.deepEqual(Object.keys(envelope.resolution), RESOLUTION_KEYS);
  }
});

test('T-K4: two active runs are ambiguous/multi-active-root-cwd, exit 1', () => {
  const a = seed();
  const b = seed(a.root);
  const out = status(a.root);
  assert.equal(out.status, 1, out.stderr);
  const envelope = envelopeOf(out);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.run, null);
  assert.equal(envelope.resolution.kind, 'ambiguous');
  assert.equal(envelope.resolution.reason, 'multi-active-root-cwd');
  assert.equal(envelope.resolution.total, 2);
  assert.deepEqual(envelope.resolution.candidates.map(c => c.run_id), [a.runId, b.runId].sort());
});

test('T-K4: six active runs report total 6 and exactly five sorted candidates', () => {
  const first = seed();
  const ids = [first.runId];
  for (let i = 0; i < 5; i += 1) ids.push(seed(first.root).runId);
  // In-process with the real capture but a relaxed aggregate deadline: the CLI's fixed 500 ms run-set
  // deadline is load-sensitive (a slow CI runner reports run-set-bound-exceeded instead), and what this
  // test pins is the candidate projection, not the deadline.
  const result = resolveRunContext({
    root: first.root, purpose: 'cli-read',
    captureRunSet: (root, options) => captureVerifiedRunSet(root, { ...options, deadlineMs: 60_000 }),
  });
  const { envelope, exitCode } = buildRunStatus(result, { now: Date.parse(SEED_NOW) });
  assert.equal(exitCode, 1);
  assert.equal(envelope.resolution.kind, 'ambiguous');
  assert.equal(envelope.resolution.total, 6);
  assert.equal(envelope.resolution.candidates.length, 5);
  assert.deepEqual(envelope.resolution.candidates.map(c => c.run_id), [...ids].sort().slice(0, 5));
});

test('T-K4: a worktree claimed by two runs is ambiguous/duplicate-worktree-claim', () => {
  const a = seed();
  const b = seed(a.root);
  mkdirSync(join(a.root, '.worktrees', 'shared'), { recursive: true });
  newWorkstream(a.root, a.runId, { title: 'shared', branch: 'shared', worktree: '.worktrees/shared', fence: a.fence, now: SEED_NOW });
  // newWorkstream does not refuse a second run claiming the same worktree, so the CLI reaches the state.
  newWorkstream(b.root, b.runId, { title: 'shared', branch: 'shared', worktree: '.worktrees/shared', fence: b.fence, now: SEED_NOW });
  const out = status(a.root);
  assert.equal(out.status, 1, out.stderr);
  const envelope = envelopeOf(out);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.resolution.kind, 'ambiguous');
  assert.equal(envelope.resolution.reason, 'duplicate-worktree-claim');
  assert.equal(envelope.resolution.total, 2);
  assert.deepEqual(envelope.resolution.candidates.map(c => c.run_id), [a.runId, b.runId].sort());
});

test('T-K5: --cwd inside run A worktree selects A (source worktree) even with run B active', () => {
  const a = seed();
  const b = seed(a.root);
  mkdirSync(join(a.root, '.worktrees', 'a'), { recursive: true });
  newWorkstream(a.root, a.runId, { title: 'a', branch: 'a', worktree: '.worktrees/a', fence: a.fence, now: SEED_NOW });
  const out = status(a.root, ['--cwd', join(a.root, '.worktrees', 'a')]);
  assert.equal(out.status, 0, out.stderr);
  const envelope = envelopeOf(out);
  assert.equal(envelope.resolution.kind, 'selected');
  assert.equal(envelope.resolution.source, 'worktree');
  assert.equal(envelope.run.run_id, a.runId);
  assert.notEqual(envelope.run.run_id, b.runId);
});

test('T-K6: --run-id selects explicitly; an invalid id is an invalid envelope', () => {
  const a = seed();
  seed(a.root);
  const out = status(a.root, ['--run-id', a.runId]);
  assert.equal(out.status, 0, out.stderr);
  const envelope = envelopeOf(out);
  assert.equal(envelope.resolution.source, 'explicit');
  assert.equal(envelope.run.run_id, a.runId);
  const bad = status(a.root, ['--run-id', '../x']);
  assert.equal(bad.status, 1);
  const badEnvelope = envelopeOf(bad);
  assert.equal(badEnvelope.resolution.kind, 'invalid');
  assert.equal(badEnvelope.ok, false);
});

function differential(s, label) {
  const base = ['--project-root', s.root, '--run-id', s.runId, '--now', NOW];
  const run = envelopeOf(status(s.root, ['--run-id', s.runId])).run;
  const budget = JSON.parse(cli(['budget', 'check', ...base], { cwd: s.root }).stdout);
  const debt = JSON.parse(cli(['comprehension', 'status', ...base], { cwd: s.root }).stdout);
  const breaker = JSON.parse(cli(['breaker', 'check', ...base], { cwd: s.root }).stdout);
  const next = JSON.parse(cli(['next-action', ...base], { cwd: s.root }).stdout);
  const state = !budget.ok ? 'hard-stop' : (budget.reason === 'soft-stop-demote' ? 'soft-stop' : 'ok');
  assert.equal(run.budget.state, state, label);
  assert.equal(run.budget.reason, budget.reason, label);
  assert.equal(run.comprehension.debt_ratio, debt.debt_ratio, label);
  assert.equal(run.comprehension.blocked, debt.blocked, label);
  assert.equal(run.breaker.tripped, breaker.tripped, label);
  assert.equal(run.breaker.reason, breaker.reason, label);
  assert.equal(run.next_action.type, next.action.type, label);
  assert.equal(run.next_action.next_command, next.next_command, label);
  assert.equal(run.next_action.reason, publicReason(next.action.reason), label);
  assert.deepEqual(run.next_action.blocked_by, (next.gate?.blocked_by ?? []).map(publicReason), label);
  return { run, next };
}

test('T-K7: run status matches budget/comprehension/breaker/next-action for v0.4 runs', () => {
  const fresh = differential(seed(), 'fresh');
  assert.equal(fresh.run.comprehension.blocked, false);

  const blocked = seed();
  const first = addMaker(blocked, { name: 'a' });
  addMaker(blocked, { name: 'b', ws: first.ws });
  const debt = differential(blocked, 'debt');
  assert.equal(debt.run.comprehension.blocked, true);
  assert.equal(debt.run.pending_human_reviews, 2);

  const tripped = seed();
  tripBreaker(tripped.root, tripped.runId, 'consecutive-request-changes');
  const breaker = differential(tripped, 'breaker');
  assert.equal(breaker.run.breaker.tripped, true);
  assert.equal(breaker.run.status, 'paused');

  const paused = seed();
  pauseRun(paused.root, paused.runId, { reason: 'fix the login bug at /Users/x', expect: paused.fence, now: Date.parse(SEED_NOW) });
  const freeText = differential(paused, 'paused');
  assert.equal(freeText.run.pause_reason, 'other');
});

test('T-K8: a v0.5 run at the proof point is not_evaluated by status but evaluated by next-action', t => {
  const f = reviewedGoalWork(t);
  const base = ['--project-root', f.root, '--run-id', f.runId, '--now', '2026-09-06T00:00:00.000Z'];
  const out = cli(['run', 'status', '--json', ...base], { cwd: f.root });
  assert.equal(out.status, 0, out.stderr);
  const run = envelopeOf(out).run;
  assert.equal(run.next_action.type, 'not_evaluated');
  assert.equal(run.next_action.reason, 'goal-proof');
  assert.equal(run.next_action.next_command, '/deep-loop-status');
  const next = JSON.parse(cli(['next-action', ...base], { cwd: f.root }).stdout);
  assert.notEqual(next.action.type, 'not_evaluated');
});

test('T-K7: a v0.5 run whose ordinary proof is not met matches next-action (type, reason, blocked_by)', t => {
  const f = makeGoalFixture({ review: { points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model',
    flags: [], converge: true, max_review_rounds: 5, require_human_ack: false } });
  t.after(f.cleanup);
  const delivery = f.workstream('delivery', ['REQ-A']);
  const artifact = f.artifact(delivery, 'answer.mjs', 'export const answer = 42;\n');
  const maker = goalOk(f.cli(['episode', 'new', '--plugin', 'standalone', '--role', 'maker', '--kind', 'implementation',
    '--point', 'implementation', '--workstream', delivery.id, '--artifacts', JSON.stringify([artifact])])).id;
  const execution = goalOk(f.cli(['execution', 'prepare', '--episode', maker, '--mode', 'inline', '--stage', 'primary', '--task', 'Deliver A'])).execution;
  goalOk(f.cli(['execution', 'return', '--episode', maker, '--attempt', execution.attempt_id, '--artifacts', JSON.stringify([artifact])]));
  const when = '2026-09-06T00:00:00.000Z';
  const base = ['--project-root', f.root, '--run-id', f.runId, '--now', when];
  const run = envelopeOf(cli(['run', 'status', '--json', ...base], { cwd: f.root })).run;
  const next = JSON.parse(cli(['next-action', ...base], { cwd: f.root }).stdout);
  assert.notEqual(run.next_action.type, 'not_evaluated', 'ordinary proof is not met, so nothing is deferred');
  assert.equal(run.next_action.type, next.action.type);
  assert.equal(run.next_action.next_command, next.next_command);
  assert.equal(run.next_action.reason, publicReason(next.action.reason));
  assert.deepEqual(run.next_action.blocked_by, (next.gate?.blocked_by ?? []).map(publicReason));
});
