import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFRESH_DEBOUNCE_MS, FALLBACK_INTERVAL_MS, SLOW_EVERY_TICKS, RUN_TIMEOUT_MS,
  statusArgv, parseStatus, outcomeKind, pollPolicy, shouldPoll, nextBandState,
  needsCompletionProbe, applyCompletionProbe, transitions, bandModel, isDeepLoopCommand,
  fillPlan, fillOutcomeToast, copyOutcomeToast, busyToast,
} from '../hooks/status-band/band.mjs';

const resolution = (over = {}) => ({ kind: 'selected', source: 'single-active', reason: null, total: null, candidates: [], ...over });
const runObj = (over = {}) => ({
  run_id: '01M27FTBNWNK8XAC63E28X63M3',
  status: 'running',
  pause_reason: null,
  budget: { spent: 41, total: 200, tokens_spent: 1, tokens_total: 2, state: 'ok', reason: 'ok' },
  comprehension: { debt_ratio: 0.5, debt_threshold: 0.5, blocked: false },
  pending_human_reviews: 0,
  breaker: { tripped: false, reason: null },
  workstreams: { total: 5, terminal: 2, by_status: { merged: 2, planned: 3 } },
  next_action: { type: 'dispatch_maker', reason: null, next_command: '/deep-loop-continue', blocked_by: [] },
  ...over,
});
const selectedEnv = (over = {}) => ({ status_version: 1, ok: true, resolution: resolution(), run: runObj(over) });
const noneEnv = () => ({ status_version: 1, ok: true, resolution: resolution({ kind: 'none', source: null, reason: 'no-runs' }), run: null });
const ambiguousEnv = (reason = 'multi-active-root-cwd', total = 2) => ({
  status_version: 1, ok: false, resolution: resolution({ kind: 'ambiguous', source: null, reason, total, candidates: [{ run_id: 'A', status: 'running' }] }), run: null,
});
const invalidEnv = (reason = 'run-set-integrity') => ({ status_version: 1, ok: false, resolution: resolution({ kind: 'invalid', source: null, reason }), run: null });
const out = (env, exitCode = env.ok ? 0 : 1) => ({ exitCode, stdout: JSON.stringify(env) + '\n' });
const P = (env) => parseStatus(out(env));
const sel = (over) => P(selectedEnv(over));
const FAIL = { kind: 'failure' };
const withRun = (id, over = {}) => sel({ run_id: id, ...over });

test('constants', () => {
  assert.equal(REFRESH_DEBOUNCE_MS, 1500);
  assert.equal(FALLBACK_INTERVAL_MS, 60000);
  assert.equal(SLOW_EVERY_TICKS, 5);
  assert.equal(RUN_TIMEOUT_MS, 5000);
});

test('statusArgv: POSIX, trailing slash, Windows, spaces, run id', () => {
  assert.deepEqual(statusArgv('/p/deep-loop', '/w'), ['node', '/p/deep-loop/scripts/deep-loop.mjs', 'run', 'status', '--json', '--cwd', '/w']);
  assert.equal(statusArgv('/p/deep-loop/', '/w')[1], '/p/deep-loop/scripts/deep-loop.mjs');
  assert.equal(statusArgv('C:\\x\\deep-loop\\', 'C:\\w')[1], 'C:\\x\\deep-loop/scripts/deep-loop.mjs');
  assert.equal(statusArgv('C:\\x\\deep-loop', 'C:\\w')[1], 'C:\\x\\deep-loop/scripts/deep-loop.mjs');
  const spaced = statusArgv('/My Plugins/deep loop', '/my proj/sub dir');
  assert.equal(spaced[1], '/My Plugins/deep loop/scripts/deep-loop.mjs');
  assert.equal(spaced[6], '/my proj/sub dir');
  assert.equal(spaced.length, 7);
  assert.deepEqual(statusArgv('/p', '/w', 'RUN1').slice(-2), ['--run-id', 'RUN1']);
  assert.equal(statusArgv('/p', '/w', null).includes('--run-id'), false);
});

test('parseStatus: process failures', () => {
  const bad = [
    { error: new Error('timeout') },
    { exitCode: 2, stdout: '' },
    { exitCode: 0, stdout: 'not json' },
    { exitCode: 0, stdout: '' },
    { exitCode: 0, stdout: '[]' },
    { exitCode: 0, stdout: 'null' },
    out({ ...selectedEnv(), status_version: 2 }),
    out({ ...selectedEnv(), resolution: { kind: 'selected', source: null, reason: null, total: null } }),
    out({ ...selectedEnv(), resolution: { ...resolution(), candidates: 'x' } }),
    out({ ...selectedEnv(), resolution: { ...resolution(), total: '2' } }),
    out(selectedEnv({ budget: 'x' })),
    out(selectedEnv({ budget: { spent: 'a', total: 1, tokens_spent: null, tokens_total: null, state: 'ok', reason: null } })),
    out(selectedEnv({ comprehension: { debt_ratio: 0, debt_threshold: 0.5, blocked: 'no' } })),
    out(selectedEnv({ pending_human_reviews: '1' })),
    out(selectedEnv({ workstreams: { total: 1, terminal: 0 } })),
    out(selectedEnv({ next_action: { type: 5, reason: null, next_command: null, blocked_by: [] } })),
    out(selectedEnv({ run_id: 7 })),
    { exitCode: 0, stdout: JSON.stringify({ ...selectedEnv(), ok: false }) },
    { exitCode: 1, stdout: JSON.stringify(selectedEnv()) },
    { exitCode: 0, stdout: JSON.stringify(ambiguousEnv()) },
    out({ ...noneEnv(), run: runObj() }),
    out({ ...selectedEnv(), run: null }),
    out({ ...selectedEnv(), resolution: resolution({ kind: 'weird' }) }),
    { exitCode: undefined, stdout: JSON.stringify(noneEnv()) },
  ];
  for (const o of bad) assert.deepEqual(parseStatus(o), FAIL, JSON.stringify(o).slice(0, 100));
  assert.deepEqual(parseStatus(undefined), FAIL);
  assert.deepEqual(parseStatus({ exitCode: 0, stdout: 'x', error: new Error('e') }), FAIL);
});

test('parseStatus: valid envelopes (nulls allowed, reason "other")', () => {
  for (const status of ['running', 'paused', 'completed', 'stopped']) {
    const p = sel({ status });
    assert.equal(p.kind, 'envelope');
    assert.equal(p.envelope.run.status, status);
  }
  const nulls = P(selectedEnv({
    pause_reason: 'other',
    budget: { spent: null, total: null, tokens_spent: null, tokens_total: null, state: 'ok', reason: null },
    comprehension: { debt_ratio: null, debt_threshold: null, blocked: false },
    next_action: { type: null, reason: 'other', next_command: null, blocked_by: ['other'] },
  }));
  assert.equal(nulls.kind, 'envelope');
  assert.equal(P(noneEnv()).kind, 'envelope');
  assert.equal(P(ambiguousEnv()).kind, 'envelope');
  assert.equal(P(ambiguousEnv('duplicate-worktree-claim')).kind, 'envelope');
  assert.equal(P(invalidEnv()).kind, 'envelope');
  const env = { ...noneEnv(), resolution: { ...noneEnv().resolution, source: null, total: null } };
  assert.equal(P(env).kind, 'envelope');
});

test('outcomeKind', () => {
  assert.equal(outcomeKind(sel({ status: 'running' })), 'running');
  assert.equal(outcomeKind(sel({ status: 'paused' })), 'paused');
  assert.equal(outcomeKind(sel({ status: 'completed' })), 'terminal');
  assert.equal(outcomeKind(sel({ status: 'stopped' })), 'terminal');
  assert.equal(outcomeKind(P(noneEnv())), 'none');
  assert.equal(outcomeKind(P(ambiguousEnv())), 'ambiguous');
  assert.equal(outcomeKind(P(invalidEnv())), 'invalid');
  assert.equal(outcomeKind(FAIL), 'failure');
});

test('pollPolicy: full table x previous cadence', () => {
  const table = {
    running: { fast: 'fast', slow: 'fast', off: 'fast' },
    paused: { fast: 'slow', slow: 'slow', off: 'slow' },
    ambiguous: { fast: 'slow', slow: 'slow', off: 'slow' },
    invalid: { fast: 'fast', slow: 'slow', off: 'slow' },
    failure: { fast: 'fast', slow: 'slow', off: 'slow' },
    none: { fast: 'off', slow: 'off', off: 'off' },
    terminal: { fast: 'off', slow: 'off', off: 'off' },
  };
  for (const [kind, row] of Object.entries(table)) {
    for (const [prev, expected] of Object.entries(row)) assert.equal(pollPolicy(prev, kind), expected, `${kind}/${prev}`);
  }
});

test('pollPolicy scenarios', () => {
  let c = 'slow';
  for (const [kind, want] of [['running', 'fast'], ['invalid', 'fast'], ['running', 'fast']]) { c = pollPolicy(c, kind); assert.equal(c, want); }
  c = 'slow';
  for (const [kind, want] of [['failure', 'slow'], ['failure', 'slow'], ['running', 'fast']]) { c = pollPolicy(c, kind); assert.equal(c, want); }
  c = 'fast';
  for (const [kind, want] of [['none', 'off'], ['failure', 'slow']]) { c = pollPolicy(c, kind); assert.equal(c, want); }
});

test('shouldPoll tick 0..10', () => {
  for (let t = 0; t <= 10; t += 1) {
    assert.equal(shouldPoll('fast', t), true);
    assert.equal(shouldPoll('off', t), false);
    assert.equal(shouldPoll('slow', t), t % 5 === 0, `slow ${t}`);
  }
});

test('nextBandState: display/selected/cadence/tick', () => {
  const run = sel({ status: 'running' });
  let s = nextBandState(null, run);
  assert.deepEqual(s, { display: run, selected: run, cadence: 'fast', tick: 0 });
  const amb = P(ambiguousEnv());
  s = nextBandState({ ...s, tick: 3 }, amb);
  assert.equal(s.display, amb);
  assert.equal(s.selected, run);
  assert.equal(s.cadence, 'slow');
  assert.equal(s.tick, 3);
  s = nextBandState(s, P(noneEnv()));
  assert.equal(s.display, null);
  assert.equal(s.selected, run);
  assert.equal(s.cadence, 'off');
  s = nextBandState(s, FAIL);
  assert.equal(s.display, null);
  assert.equal(s.selected, run);
  assert.equal(s.cadence, 'slow');
  s = nextBandState({ display: run, selected: run, cadence: 'fast', tick: 1 }, FAIL);
  assert.equal(s.display, null);
  assert.equal(s.selected, run);
  assert.equal(s.cadence, 'fast');
  s = nextBandState({ display: run, selected: run, cadence: 'fast', tick: 1 }, P(invalidEnv()));
  assert.equal(s.display, null);
  assert.equal(s.cadence, 'fast');
  assert.deepEqual(nextBandState(null, FAIL), { display: null, selected: null, cadence: 'slow', tick: 0 });
});

test('needsCompletionProbe', () => {
  const X = withRun('X', { status: 'running' });
  assert.equal(needsCompletionProbe(null, P(noneEnv())), null);
  assert.equal(needsCompletionProbe(X, P(noneEnv())), 'X');
  assert.equal(needsCompletionProbe(X, withRun('Y')), 'X');
  assert.equal(needsCompletionProbe(X, P(ambiguousEnv())), 'X');
  assert.equal(needsCompletionProbe(X, withRun('X', { status: 'paused' })), null);
  assert.equal(needsCompletionProbe(X, FAIL), null);
  assert.equal(needsCompletionProbe(X, P(invalidEnv())), null);
  assert.equal(needsCompletionProbe(withRun('X', { status: 'completed' }), P(noneEnv())), null);
  assert.equal(needsCompletionProbe(withRun('X', { status: 'stopped' }), withRun('Y')), null);
  assert.equal(needsCompletionProbe(withRun('X', { status: 'paused' }), P(noneEnv())), 'X');
});

// One refresh as the module performs it.
function refresh(prev, primary, probe) {
  let next = nextBandState(prev, primary);
  const probeRunId = needsCompletionProbe(prev?.selected ?? null, primary);
  if (probeRunId) {
    assert.ok(probe, 'probe expected');
    next = applyCompletionProbe(next, { prevSelected: prev?.selected ?? null, probeRunId }, probe);
  } else assert.equal(probe, undefined, 'probe not expected');
  return { next, toasts: transitions(prev?.selected ?? null, next.selected), probeRunId };
}

test('completion probe latch: ambiguous + X completed, then ambiguous/none repeat with no re-read or toast', () => {
  const X = withRun('X', { status: 'running' });
  let st = nextBandState(null, X);
  let r = refresh(st, P(ambiguousEnv()), withRun('X', { status: 'completed' }));
  assert.equal(r.toasts.length, 1);
  assert.match(r.toasts[0], /run .*completed|completed/);
  assert.equal(r.next.selected.envelope.run.status, 'completed');
  assert.equal(r.next.display.envelope.resolution.kind, 'ambiguous');
  st = r.next;
  for (const primary of [P(ambiguousEnv()), P(noneEnv()), P(ambiguousEnv())]) {
    r = refresh(st, primary);
    assert.equal(r.probeRunId, null);
    assert.deepEqual(r.toasts, []);
    st = r.next;
  }
});

test('completion probe: primary Y + probe failure keeps X, raises cadence, later toast, then moves to Y silently', () => {
  const X = withRun('X', { status: 'running' });
  const Y = withRun('Y', { status: 'running' });
  let st = nextBandState(null, X);
  let r = refresh(st, Y, FAIL);
  assert.equal(r.next.selected, X);
  assert.equal(r.next.display, Y);
  assert.deepEqual(r.toasts, []);
  assert.notEqual(r.next.cadence, 'off');
  st = r.next;
  r = refresh(st, Y, withRun('X', { status: 'completed' }));
  assert.equal(r.toasts.length, 1);
  assert.equal(r.next.selected.envelope.run.run_id, 'X');
  st = r.next;
  r = refresh(st, Y);
  assert.equal(r.next.selected.envelope.run.run_id, 'Y');
  assert.deepEqual(r.toasts, []);
});

test('completion probe: non-terminal probe tracks X, completed later toasts once', () => {
  const X = withRun('X', { status: 'running' });
  const Y = withRun('Y', { status: 'running' });
  let st = nextBandState(null, X);
  let r = refresh(st, Y, withRun('X', { status: 'running' }));
  assert.equal(r.next.selected.envelope.run.run_id, 'X');
  assert.deepEqual(r.toasts, []);
  st = r.next;
  r = refresh(st, Y, withRun('X', { status: 'completed' }));
  assert.equal(r.toasts.length, 1);
});

test('applyCompletionProbe: invalid envelope, other run and wrong kinds are failures', () => {
  const X = withRun('X', { status: 'running' });
  const base = nextBandState(X, P(noneEnv()));
  assert.equal(base.cadence, 'off');
  for (const probe of [P(invalidEnv()), withRun('Z'), FAIL, P(noneEnv()), P(ambiguousEnv())]) {
    const r = applyCompletionProbe(base, { prevSelected: X, probeRunId: 'X' }, probe);
    assert.equal(r.selected, X);
    assert.equal(r.cadence, 'slow');
    assert.equal(r.display, base.display);
  }
  const ok = applyCompletionProbe(base, { prevSelected: X, probeRunId: 'X' }, withRun('X', { status: 'stopped' }));
  assert.equal(ok.selected.envelope.run.status, 'stopped');
  assert.equal(ok.cadence, 'off');
  assert.equal(ok.display, null);
});

test('applyCompletionProbe: primary none + probe failure raises cadence to slow', () => {
  const X = withRun('X', { status: 'running' });
  const base = nextBandState({ display: X, selected: X, cadence: 'fast', tick: 0 }, P(noneEnv()));
  assert.equal(base.cadence, 'off');
  assert.equal(applyCompletionProbe(base, { prevSelected: X, probeRunId: 'X' }, FAIL).cadence, 'slow');
});

test('transitions', () => {
  const base = withRun('ABCD1234', { status: 'running' });
  assert.deepEqual(transitions(null, base), []);
  assert.deepEqual(transitions(base, null), []);
  assert.deepEqual(transitions(base, base), []);
  const breaker = withRun('ABCD1234', { breaker: { tripped: true, reason: 'consecutive-request-changes' } });
  assert.deepEqual(transitions(base, breaker), ['deep-loop: breaker tripped (consecutive-request-changes)']);
  assert.deepEqual(transitions(breaker, breaker), []);
  const debt = withRun('ABCD1234', { comprehension: { debt_ratio: 1, debt_threshold: 0.5, blocked: true } });
  assert.deepEqual(transitions(base, debt), ['deep-loop: comprehension debt is blocking new work — /deep-loop-ack']);
  const soft = withRun('ABCD1234', { budget: { ...runObj().budget, state: 'soft-stop' } });
  const hard = withRun('ABCD1234', { budget: { ...runObj().budget, state: 'hard-stop' } });
  assert.deepEqual(transitions(base, soft), ['deep-loop: budget soft-stop']);
  assert.deepEqual(transitions(base, hard), ['deep-loop: budget hard-stop']);
  assert.deepEqual(transitions(soft, soft), []);
  assert.deepEqual(transitions(base, withRun('ABCD1234', { status: 'completed' })), ['deep-loop: run 1234 completed']);
  assert.deepEqual(transitions(base, withRun('ABCD1234', { status: 'stopped' })), ['deep-loop: run 1234 stopped']);
  assert.deepEqual(transitions(withRun('ABCD1234', { status: 'completed' }), withRun('ABCD1234', { status: 'completed' })), []);
  assert.deepEqual(transitions(base, withRun('OTHER9999', { status: 'completed', breaker: { tripped: true, reason: 'x' } })), []);
  const all = withRun('ABCD1234', { status: 'completed', breaker: { tripped: true, reason: 'tripped' },
    comprehension: { debt_ratio: 1, debt_threshold: 0.5, blocked: true } });
  assert.equal(transitions(base, all).length, 3);
  assert.deepEqual(transitions(P(noneEnv()), base), []);
  assert.deepEqual(transitions(base, P(ambiguousEnv())), []);
});

const model = (display, extra = {}) => bandModel(display, { hidden: false, hasSurvey: false, active: true, ...extra });

test('bandModel: null cases (order 1, 3, 4)', () => {
  const running = sel();
  assert.equal(model(running, { active: false }), null);
  assert.equal(model(running, { hasSurvey: true }), null);
  assert.equal(model(running, { hidden: true }), null);
  assert.equal(model(null), null);
  assert.equal(model(P(noneEnv())), null);
  assert.equal(model(P(invalidEnv())), null);
  assert.equal(model(FAIL), null);
  assert.equal(model(sel({ status: 'completed' })), null);
  assert.equal(model(sel({ status: 'stopped' })), null);
  assert.equal(model(P(ambiguousEnv('other-reason'))), null);
});

test('bandModel: ambiguous lines', () => {
  const a = model(P(ambiguousEnv('multi-active-root-cwd', 3)));
  assert.equal(a.line, 'deep-loop · 3 active runs · /deep-loop-status');
  assert.deepEqual(a.buttons, [{ key: 'status', label: 'Status', command: '/deep-loop-status' },
    { key: 'hide', label: 'Hide' }]);
  const d = model(P(ambiguousEnv('duplicate-worktree-claim', 2)));
  assert.equal(d.line, 'deep-loop · worktree claimed by 2 runs · /deep-loop-status');
  assert.deepEqual(d.buttons.map((b) => b.key), ['status', 'hide']);
});

test('bandModel: run line', () => {
  const m = model(sel({ comprehension: { debt_ratio: 0.5, debt_threshold: 0.5, blocked: false } }));
  assert.equal(m.line, 'loop 63M3 · running · budget 41/200 turns · debt 0.50/0.5 · review 0 pending · ws 2/5 · next: dispatch_maker');
  assert.deepEqual(m.buttons.map((b) => b.key), ['status', 'hide']);
  assert.deepEqual(m.buttons[0], { key: 'status', label: 'Status', command: '/deep-loop-status' });
  assert.deepEqual(m.buttons[1], { key: 'hide', label: 'Hide' });
});

test('bandModel: paused reason shown unless other/null, breaker, soft/hard stop, debt rounding, Ack', () => {
  assert.match(model(sel({ status: 'paused', pause_reason: 'budget' })).line, /^loop 63M3 · paused \(budget\) · budget/);
  assert.match(model(sel({ status: 'paused', pause_reason: 'other' })).line, /^loop 63M3 · paused · budget/);
  assert.match(model(sel({ status: 'paused', pause_reason: null })).line, /^loop 63M3 · paused · budget/);
  assert.match(model(sel({ breaker: { tripped: true, reason: 'consecutive-request-changes' } })).line,
    /^loop 63M3 · running · breaker: consecutive-request-changes · budget/);
  assert.match(model(sel({ budget: { ...runObj().budget, state: 'soft-stop' } })).line, /budget 41\/200 turns soft-stop · debt/);
  assert.match(model(sel({ budget: { ...runObj().budget, state: 'hard-stop' } })).line, /budget 41\/200 turns hard-stop · debt/);
  assert.match(model(sel({ comprehension: { debt_ratio: 1 / 3, debt_threshold: 0.5, blocked: true } })).line, /debt 0\.33\/0\.5/);
  const none = model(sel({ pending_human_reviews: 0 }));
  assert.equal(none.buttons.some((b) => b.key === 'ack'), false);
  const ack = model(sel({ pending_human_reviews: 2 }));
  assert.deepEqual(ack.buttons.map((b) => b.key), ['status', 'ack', 'hide']);
  assert.deepEqual(ack.buttons[1], { key: 'ack', label: 'Ack', command: '/deep-loop-ack' });
  assert.match(ack.line, /review 2 pending/);
});

test('bandModel: null numeric fields and null next type do not print "null"', () => {
  const m = model(sel({
    budget: { spent: null, total: null, tokens_spent: null, tokens_total: null, state: 'ok', reason: null },
    comprehension: { debt_ratio: null, debt_threshold: null, blocked: false },
    next_action: { type: null, reason: null, next_command: null, blocked_by: [] },
  }));
  assert.doesNotMatch(m.line, /null|undefined|NaN/);
});

test('isDeepLoopCommand', () => {
  assert.equal(isDeepLoopCommand('node /x/scripts/deep-loop.mjs run status'), true);
  assert.equal(isDeepLoopCommand('ls -la'), false);
  assert.equal(isDeepLoopCommand(undefined), false);
  assert.equal(isDeepLoopCommand(42), false);
});

test('fillPlan and toast helpers', () => {
  assert.equal(fillPlan(''), 'fill');
  assert.equal(fillPlan('  \n\t '), 'fill');
  assert.equal(fillPlan('hello'), 'busy');
  assert.equal(fillPlan(undefined), 'busy');
  assert.equal(busyToast('/deep-loop-status'), 'Clear the prompt to insert /deep-loop-status');
  assert.equal(fillOutcomeToast('/deep-loop-status', true), null);
  assert.equal(fillOutcomeToast('/deep-loop-status', false), 'Type /deep-loop-status in the prompt');
  assert.equal(fillOutcomeToast('/deep-loop-status', false, 'dialog'), 'Close the dialog, then press again');
  assert.equal(fillOutcomeToast('/deep-loop-status', false, 'no_composer'), null);
  assert.equal(copyOutcomeToast('/deep-loop-ack', true), 'Copied /deep-loop-ack');
  assert.equal(copyOutcomeToast('/deep-loop-ack', false), 'Type /deep-loop-ack in the prompt');
});
