import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInitialLoop, initRun } from '../scripts/lib/initrun.mjs';
import {
  PUBLIC_NEXT_COMMANDS, PUBLIC_REASONS, PUBLIC_REASON_PREFIXES, RUN_STATUS_VERSION,
  buildRunStatus, emptyResolution, isPublicReason, projectNextAction, projectResolution, publicReason, statusEnvelope,
} from '../scripts/lib/run-status.mjs';
import { TEST_GOAL_CONTRACT } from './helpers/goal-fixture.mjs';

const NOW = Date.parse('2026-06-24T00:30:00.000Z');
const ENVELOPE_KEYS = ['status_version', 'ok', 'resolution', 'run'];
const RESOLUTION_KEYS = ['kind', 'source', 'reason', 'total', 'candidates'];
const RUN_KEYS = ['run_id', 'status', 'pause_reason', 'budget', 'comprehension', 'pending_human_reviews',
  'breaker', 'workstreams', 'next_action'];

function v04(over = {}, runId = 'R') {
  return Object.assign(buildInitialLoop({ runtime: 'claude', goal: 'g', protocol: 'deep-work',
    recipe: { id: 'r', name: 'r', reason: '' }, runId, now: new Date('2026-06-24T00:00:00Z') }), over);
}
function v05(over = {}, runId = 'R05') {
  return Object.assign(buildInitialLoop({ runtime: 'claude', goal: 'Deliver A', protocol: 'standalone',
    recipe: { id: 'r', name: 'r', reason: '' }, runId, now: new Date('2026-06-24T00:00:00Z'),
    goalContract: TEST_GOAL_CONTRACT }), over);
}
const selected = (loop, runId = loop.run_id, extra = {}) => ({ ok: true, kind: 'selected', runId, source: 'single-active',
  status: loop.status, snapshot: { data: loop }, ...extra });
const status = (loop, opts = {}) => buildRunStatus(selected(loop), { now: NOW, ...opts });
const addDone = (loop, n, reviewed = 0) => {
  loop.episodes = Array.from({ length: n }, (_, i) => ({ id: `ep-${i}`, role: 'maker', status: 'done', kind: 'implementation',
    point: 'implementation', workstream_id: 'ws-x', human_reviewed: i < reviewed }));
  loop.current_episode = null;
  return loop;
};

test('envelope key order and exact keys for selected, none, ambiguous, invalid and compute failure', () => {
  const sel = status(v04());
  assert.deepEqual(Object.keys(sel.envelope), ENVELOPE_KEYS);
  assert.deepEqual(Object.keys(sel.envelope.resolution), RESOLUTION_KEYS);
  assert.deepEqual(Object.keys(sel.envelope.run), RUN_KEYS);
  assert.deepEqual(Object.keys(sel.envelope.run.budget), ['spent', 'total', 'tokens_spent', 'tokens_total', 'state', 'reason']);
  assert.deepEqual(Object.keys(sel.envelope.run.comprehension), ['debt_ratio', 'debt_threshold', 'blocked']);
  assert.deepEqual(Object.keys(sel.envelope.run.breaker), ['tripped', 'reason']);
  assert.deepEqual(Object.keys(sel.envelope.run.workstreams), ['total', 'terminal', 'by_status']);
  assert.deepEqual(Object.keys(sel.envelope.run.next_action), ['type', 'reason', 'next_command', 'blocked_by']);
  assert.equal(sel.envelope.status_version, RUN_STATUS_VERSION);
  assert.equal(sel.envelope.ok, true);
  assert.equal(sel.exitCode, 0);

  const none = buildRunStatus({ ok: true, kind: 'none', reason: 'no-runs' }, { now: NOW });
  assert.deepEqual(Object.keys(none.envelope), ENVELOPE_KEYS);
  assert.deepEqual(Object.keys(none.envelope.resolution), RESOLUTION_KEYS);
  assert.equal(none.envelope.run, null);
  assert.equal(none.envelope.ok, true);
  assert.equal(none.exitCode, 0);

  const amb = buildRunStatus({ ok: false, kind: 'ambiguous', reason: 'multi-active-root-cwd', total: 2,
    candidates: [{ run_id: 'A', status: 'running' }, { run_id: 'B', status: 'paused' }] }, { now: NOW });
  assert.deepEqual(Object.keys(amb.envelope.resolution), RESOLUTION_KEYS);
  assert.equal(amb.envelope.ok, false);
  assert.equal(amb.exitCode, 1);
  assert.deepEqual(amb.envelope.resolution.candidates, [{ run_id: 'A', status: 'running' }, { run_id: 'B', status: 'paused' }]);
  assert.equal(amb.envelope.resolution.total, 2);

  const inv = buildRunStatus({ ok: false, kind: 'invalid', reason: 'run-set-integrity' }, { now: NOW });
  assert.equal(inv.envelope.resolution.reason, 'run-set-integrity');
  assert.equal(inv.envelope.run, null);
  assert.equal(inv.exitCode, 1);

  const bad = buildRunStatus(selected(v04({ status: 'weird' })), { now: NOW });
  assert.deepEqual(bad.envelope, statusEnvelope({ ok: false, resolution: emptyResolution('invalid', 'status-compute-failed'), run: null }));
  assert.equal(bad.exitCode, 1);
  assert.deepEqual(Object.keys(bad.envelope.resolution), RESOLUTION_KEYS);
});

test('candidates are bounded to five and projected to run_id/status', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ run_id: `R${i}`, status: 'running', extra: 'x' }));
  const projected = projectResolution({ ok: false, kind: 'ambiguous', reason: 'multi-active-root-cwd', total: 8, candidates: many });
  assert.equal(projected.candidates.length, 5);
  assert.deepEqual(Object.keys(projected.candidates[0]), ['run_id', 'status']);
  assert.equal(projected.total, 8);
});

test('resolver reasons that are not kernel-shaped become other; unknown kinds become invalid', () => {
  assert.equal(projectResolution({ ok: false, kind: 'invalid', reason: '/Users/a/b' }).reason, 'other');
  assert.equal(projectResolution(null).reason, 'resolver-invalid');
  assert.equal(projectResolution({ kind: 'weird' }).kind, 'invalid');
});

test('real kernel ULID run id (uppercase) passes through unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-run-status-'));
  try {
    const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
    assert.match(runId, /[A-Z]/);
    const loop = JSON.parse(readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json'), 'utf8'));
    const result = buildRunStatus(selected(loop, runId), { now: NOW });
    assert.equal(result.envelope.run.run_id, runId);
    assert.equal(result.exitCode, 0);
    assert.ok(readdirSync(join(root, '.deep-loop', 'runs')).includes(runId));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run id grammar violation is a compute failure', () => {
  const result = buildRunStatus(selected(v04(), 'bad id/../x'), { now: NOW });
  assert.equal(result.envelope.resolution.reason, 'status-compute-failed');
});

test('every public next command is projected as-is and unknown commands become null', () => {
  assert.equal(PUBLIC_NEXT_COMMANDS.length, 6);
  const seen = new Set();
  for (const loop of [v04(), addDone(v04(), 2), v04({ status: 'completed' })]) {
    const cmd = status(loop).envelope.run.next_action.next_command;
    assert.ok(cmd === null || PUBLIC_NEXT_COMMANDS.includes(cmd));
    seen.add(cmd);
  }
  assert.ok(seen.size >= 2);
});

test('publicReason is a closed-vocabulary projection', () => {
  for (const word of PUBLIC_REASONS) assert.equal(publicReason(word), word);
  for (const prefix of PUBLIC_REASON_PREFIXES) assert.equal(publicReason(prefix), prefix);
  // text equal to a listed word is shown as-is: the guarantee is about vocabulary, not provenance
  assert.equal(publicReason('host-session-lost'), 'host-session-lost');
  assert.equal(publicReason('review-point-unsatisfied:ws-a,ws-b'), 'review-point-unsatisfied');
  assert.equal(publicReason('independent-review:xyz'), 'independent-review');
  assert.equal(publicReason('recovery:boundary-recovery'), 'recovery');
  assert.equal(publicReason('recovered:awaiting-resume'), 'recovered:awaiting-resume');
  assert.equal(publicReason('checker-gate:budget'), 'checker-gate');
  // comma-joined kernel codes pass only when every part is public
  assert.equal(publicReason('unsettled-episodes,unreviewed-maker'), 'unsettled-episodes,unreviewed-maker');
  assert.equal(publicReason('unsettled-episodes,secrets.txt'), 'other');
  assert.equal(publicReason('a,b'), 'other');
  for (const hidden of ['secrets.txt', 'ship-confidential-acquisition', '/Users/a/b', 'C:\\x\\y',
    'fix the login bug', 'unknown-prefix:abc']) assert.equal(publicReason(hidden), 'other', hidden);
  for (const none of [undefined, null, 42, {}, [], '']) assert.equal(publicReason(none), null);
});

const SRC = name => readFileSync(new URL(`../scripts/lib/${name}`, import.meta.url), 'utf8');
const known = lit => publicReason(lit) !== 'other';

test('vocabulary completeness scan over action reasons and kernel pause reasons', () => {
  const missing = [];
  for (const name of ['next-action.mjs', 'goal-actions.mjs', 'execution.mjs']) {
    const src = SRC(name);
    const literals = [
      ...[...src.matchAll(/select\([^,]+,\s*'([^']+)'\)/g)].map(m => m[1]),
      ...[...src.matchAll(/reason:\s*'([^']+)'/g)].map(m => m[1]),
      ...[...src.matchAll(/reason:\s*`([a-z0-9-]+):\$\{/g)].map(m => `${m[1]}:x`),
    ];
    assert.ok(literals.length > 0, name);
    for (const lit of literals) if (!known(lit)) missing.push(`${name}:${lit}`);
  }
  const pauseCall = /(?:pauseRun|pauseWithOriginalFence|pauseWithFreshFence)\([^;]{0,400}?\breason:\s*(?:'([^']+)'|`([a-z0-9-]+):\$\{)/g;
  for (const name of readdirSync(new URL('../scripts/lib/', import.meta.url)).filter(f => f.endsWith('.mjs'))) {
    const src = SRC(name);
    const literals = [
      ...[...src.matchAll(pauseCall)].map(m => m[1] ?? `${m[2]}:x`),
      ...[...src.matchAll(/pauseReason\s*[:=]\s*'([^']+)'/g)].map(m => m[1]),
      ...[...src.matchAll(/pauseReason\s*[:=]\s*`([a-z0-9-]+):\$\{/g)].map(m => `${m[1]}:x`),
    ];
    for (const lit of literals) if (!known(lit)) missing.push(`${name}:${lit}`);
  }
  for (const name of readdirSync(new URL('../scripts/lib/', import.meta.url)).filter(f => f.endsWith('.mjs'))) {
    const src = SRC(name);
    const literals = [
      ...[...src.matchAll(/pause_reason\s*=\s*'([^']+)'/g)].map(m => m[1]),
      ...[...src.matchAll(/pause_reason:\s*'([^']+)'/g)].map(m => m[1]),
      ...[...src.matchAll(/pause_reason\s*=\s*`([a-z0-9-]+):\$\{/g)].map(m => `${m[1]}:x`),
    ];
    for (const lit of literals) if (!known(lit)) missing.push(`${name}:${lit}`);
  }
  assert.deepEqual(missing, []);
});

test('wiring: free-text pause reason, breaker reason and v0.5 paused next_action reason are projected', () => {
  const text = 'fix the login bug at /Users/x/app';
  const paused = status(v04({ status: 'paused', pause_reason: text })).envelope.run;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pause_reason, 'other');
  assert.equal(status(v04({ status: 'running', pause_reason: text })).envelope.run.pause_reason, null);

  const tripped = status(v04({ circuit_breaker: { consecutive_request_changes: 0, tripped: true, trip_reason: text } })).envelope.run;
  assert.deepEqual(tripped.breaker, { tripped: true, reason: 'other' });

  const goalPaused = status(v05({ status: 'paused', pause_reason: text })).envelope.run;
  assert.equal(goalPaused.next_action.type, 'await_human');
  assert.equal(goalPaused.next_action.reason, 'other');
  assert.equal(goalPaused.pause_reason, 'other');
});

function executionLoop(execution, role = 'maker') {
  const loop = v05();
  loop.session_chain.sessions[0].scope.workstream_id = 'ws-1';
  loop.workstreams = [{ id: 'ws-1', status: 'in_progress', depends_on: [], requirement_ids: ['REQ-A'], review_points_done: [], terminal_events: [] }];
  loop.episodes = [{ id: 'ep-1', role, status: 'in_progress', kind: 'implementation', point: 'implementation',
    workstream_id: 'ws-1', human_reviewed: false, expected_artifacts: ['a.txt'],
    execution: { mode: 'native', stage: 'primary', required_stages: ['primary'], attempt_id: 'att-1', artifacts: [], handle: 'h', task: 't', ...execution } }];
  loop.current_episode = 'ep-1';
  return loop;
}

test('execution reasons reach next_action unchanged (all four ternary reasons)', () => {
  const cases = [
    [{ phase: 'blocked', observation: { state: 'unknown' } }, 'execution-liveness-unknown'],
    [{ phase: 'blocked', observation: { state: 'failed' } }, 'execution-failed'],
    [{ phase: 'prepared', observation: { state: 'present' } }, 'start-not-observed'],
    [{ phase: 'running', observation: { state: 'present' } }, 'producer-result-required'],
  ];
  for (const [execution, reason] of cases) {
    const out = status(executionLoop(execution));
    assert.equal(out.exitCode, 0, reason);
    assert.equal(out.envelope.run.next_action.reason, reason);
  }
});

test('field semantics: soft stop, hard stop, breaker, debt, pending reviews, delegated debt, workstream order', () => {
  const soft = status(v04({ budget: { ...v04().budget, spent: 160 } })).envelope.run.budget;
  assert.deepEqual([soft.state, soft.reason, soft.spent, soft.total], ['soft-stop', 'soft-stop-demote', 160, 200]);
  const hard = status(v04({ budget: { ...v04().budget, spent: 200 } })).envelope.run.budget;
  assert.deepEqual([hard.state, hard.reason], ['hard-stop', 'turns-hard-stop']);
  assert.equal(status(v04({ budget: { ...v04().budget, spent: 200 } })).envelope.run.next_action.reason, 'budget');

  const tripped = status(v04({ circuit_breaker: { consecutive_request_changes: 3, tripped: true, trip_reason: 'consecutive-request-changes' } })).envelope.run;
  assert.deepEqual(tripped.breaker, { tripped: true, reason: 'consecutive-request-changes' });
  assert.equal(tripped.next_action.reason, 'breaker');

  const debt = status(addDone(v04(), 2, 0)).envelope.run;
  assert.equal(debt.comprehension.blocked, true);
  assert.equal(debt.comprehension.debt_ratio, 1);
  assert.equal(debt.comprehension.debt_threshold, 0.5);
  assert.equal(debt.pending_human_reviews, 2);
  assert.deepEqual(debt.next_action.blocked_by, ['comprehension-debt']);
  assert.equal(status(addDone(v04(), 2, 1)).envelope.run.pending_human_reviews, 1);

  const delegated = addDone(v05(), 2, 0);
  delegated.orchestration.supervision = 'delegated';
  const del = status(delegated).envelope.run;
  assert.equal(del.comprehension.blocked, false);
  assert.equal(del.pending_human_reviews, 2);

  const ws = status(v04({ workstreams: [{ status: 'planned' }, { status: 'merged' }, { status: 'in_progress' },
    { status: 'ready' }, { status: 'planned' }, {}] })).envelope.run.workstreams;
  assert.equal(ws.total, 6);
  assert.equal(ws.terminal, 2);
  assert.deepEqual(Object.keys(ws.by_status), ['in_progress', 'merged', 'planned', 'ready', 'unknown']);
  assert.deepEqual(ws.by_status, { in_progress: 1, merged: 1, planned: 2, ready: 1, unknown: 1 });
});

test('unattended may be a boolean or a function of the loop', () => {
  const loop = v04();
  assert.deepEqual(status(loop, { unattended: true }).envelope, status(loop, { unattended: () => true }).envelope);
});

test('isPublicReason and the exported vocabulary are read-only views', () => {
  assert.equal(isPublicReason('budget'), true);
  assert.equal(isPublicReason('review-point-unsatisfied'), true);
  assert.equal(isPublicReason('fix the login bug'), false);
  assert.equal(isPublicReason(7), false);
  assert.ok(Object.isFrozen(PUBLIC_REASONS) && Array.isArray(PUBLIC_REASONS));
  assert.throws(() => PUBLIC_REASONS.push('x'), TypeError);
});

test('next-action projection drops non-public commands, malformed types and non-string blocked_by', () => {
  const project = (action, command, blocked) => projectNextAction({ action, next_command: command,
    gate: { blocked_by: blocked } });
  assert.equal(project({ type: 'finish' }, '/deep-loop-evil', []).next_command, null);
  assert.equal(project({ type: 'finish' }, 'rm -rf /', []).next_command, null);
  assert.equal(project({ type: 'finish' }, '/deep-loop-handoff', []).next_command, '/deep-loop-handoff');
  assert.equal(project({ type: 'Bad Type!' }, '/deep-loop-status', []).type, null);
  assert.equal(project({ type: 'x'.repeat(41) }, '/deep-loop-status', []).type, null);
  assert.equal(project({ type: 7 }, '/deep-loop-status', []).type, null);
  assert.deepEqual(project({ type: 'await_human' }, '/deep-loop-status', ['budget', 5, null, { a: 1 }, 'secret path']).blocked_by,
    ['budget', 'other']);
  assert.deepEqual(projectNextAction(undefined), { type: null, reason: null, next_command: null, blocked_by: [] });
});
