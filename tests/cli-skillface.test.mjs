import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { appendAnchored } from '../scripts/lib/integrity.mjs';
import { runDir } from '../scripts/lib/state.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { abandonEpisode, newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview } from '../scripts/lib/review.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
const MUTATING = new Set([
  'state patch', 'budget record', 'budget extend', 'episode new', 'episode record', 'episode abandon',
  'execution prepare', 'execution start', 'execution return', 'execution reconcile', 'review claim',
  'goal dispatch', 'goal start', 'goal record', 'goal reconcile', 'goal obligation', 'goal obligation-resolve',
  'review configure', 'review dispatch', 'review record', 'review import', 'workstream select', 'workstream new', 'workstream set',
  'workstream terminal', 'checkpoint emit', 'checkpoint observe', 'checkpoint restore',
  'lease acquire', 'lease release', 'comprehension ack',
  'breaker reset', 'finish',
]);
const EXACT_READS = new Set([
  'next-action', 'tick', 'state get', 'path resolve', 'lease check', 'budget check',
  'comprehension status', 'breaker check', 'checkpoint inspect', 'root diagnose',
]);
function run(root, args) {
  const first = args[1] && !args[1].startsWith('--') ? args[1] : null;
  const key = args[0] === 'finish' ? 'finish' : first ? `${args[0]} ${first}` : args[0];
  let effective = args;
  if ((MUTATING.has(key) || EXACT_READS.has(key)) && !args.some(arg => arg === '--run-id' || arg.startsWith('--run-id='))) {
    const currentPath = join(root, '.deep-loop', 'current');
    if (existsSync(currentPath)) effective = [...args, '--run-id', readFileSync(currentPath, 'utf8').trim()];
  }
  return execFileSync('node', [CLI, ...effective, '--project-root', root], { encoding: 'utf8' });
}
function runFail(root, args) { try { run(root, args); return 0; } catch (e) { return e.status; } }
function runResult(root, args) {
  try {
    return { status: 0, stdout: execFileSync('node', [CLI, ...args, '--project-root', root], { encoding: 'utf8' }), stderr: '' };
  } catch (e) {
    return { status: e.status, stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '' };
  }
}
function seed(detected = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-sf-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', protocol: 'deep-work', detected, now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}
function operationallyAbandonedChecker(root, runId, reason = 'operational-review-failure: parser-contract-mismatch') {
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const worktree = '.claude/worktrees/review-config';
  mkdirSync(join(root, worktree), { recursive: true });
  const ws = newWorkstream(root, runId, {
    title: 'review config', branch: 'review-config', worktree, fence,
  });
  const artifact = `${worktree}/plan.md`;
  writeFileSync(join(root, artifact), '# plan');
  const maker = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'plan', point: 'plan',
    workstream: ws.id, expectedArtifacts: [artifact], fence,
  });
  recordEpisode(root, runId, maker.id, { status: 'in_progress', fence });
  recordEpisode(root, runId, maker.id, { status: 'done', artifacts: [artifact], proof: {}, fence });
  const created = dispatchReview(root, runId, {
    point: 'plan', workstreamId: ws.id, detected: { 'deep-review': true },
    independentSubagent: true, fence,
  });
  abandonEpisode(root, runId, created.checkerEpisodeId, { reason, confirm: true, fence });
  return created.checkerEpisodeId;
}
function seedMigratedLegacy() {
  const seeded = seed();
  const dir = join(seeded.root, '.deep-loop', 'runs', seeded.runId);
  const loopPath = join(dir, 'loop.json');
  const loop = JSON.parse(readFileSync(loopPath, 'utf8'));
  loop.schema_version = '0.3.0';
  delete loop.project.binding_generation;
  delete loop.autonomy.attended_launch_approval;
  delete loop.session_chain.lease.takeover_kind;
  for (const session of loop.session_chain.sessions) delete session.scope;
  loop.autonomy.continuation_policy = 'rotate-per-unit';
  loop.autonomy.milestone_predicate = ['workstream_status_change'];
  const raw = JSON.stringify(loop, null, 2);
  writeFileSync(loopPath, raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
  return seeded;
}

test('all mutating routes reject missing, value-less, empty, and duplicate run-id before current access', () => {
  const { root } = seed();
  initRun(root, { runtime: 'claude', goal: 'b', protocol: 'deep-work', now: new Date('2026-06-24T00:00:01Z') });
  const routes = [
    ['root', 'recovery', 'acquire'], ['root', 'rebind'], ['root', 'recover'],
    ['runtime-executable', 'approve'], ['launcher-executable', 'approve'],
    ['checkpoint', 'emit'], ['checkpoint', 'observe'], ['checkpoint', 'restore'],
    ['lease', 'acquire'], ['lease', 'release'],
    ['workstream', 'new'], ['workstream', 'select'], ['workstream', 'set'], ['workstream', 'terminal'],
    ['episode', 'new'], ['episode', 'record'], ['episode', 'abandon'],
    ['execution', 'prepare'], ['execution', 'start'], ['execution', 'return'], ['execution', 'reconcile'],
    ['goal', 'dispatch'], ['goal', 'start'], ['goal', 'record'], ['goal', 'reconcile'], ['goal', 'obligation'], ['goal', 'obligation-resolve'],
    ['review', 'configure'], ['review', 'dispatch'], ['review', 'claim'], ['review', 'record'], ['review', 'import'],
    ['handoff', 'emit'], ['respawn'], ['state', 'patch'], ['pause'], ['recover'],
    ['recovery', 'acquire'], ['budget', 'record'], ['budget', 'extend'],
    ['comprehension', 'ack'], ['breaker', 'reset'], ['insights', 'emit'],
    ['spawn-style', 'offer-desktop'], ['spawn-style', 'confirm-desktop'],
    ['spawn-style', 'decline-desktop'], ['spawn-style', 'reset-desktop'],
    ['attended-launch', 'approve'], ['attended-launch', 'revoke'],
    ['session-profile', 'set'], ['detect-terminal'], ['finish'],
  ];
  const expectedInventory = routes.map(route => route[0] === 'root' ? route.join(' ') : route.length > 1 ? route.slice(0, 2).join(' ') : route[0]);
  const source = readFileSync(join(process.cwd(), 'scripts', 'deep-loop.mjs'), 'utf8');
  const inventoryStart = source.indexOf('export const MUTATING_ROUTE_INVENTORY');
  const inventoryEnd = source.indexOf(']);', inventoryStart);
  const productionInventory = [...source.slice(inventoryStart, inventoryEnd).matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(productionInventory, expectedInventory);
  const durableTree = runId => {
    const base = join(root, '.deep-loop', 'runs', runId);
    const result = {};
    const visit = rel => {
      const dir = join(base, rel);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = rel ? join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) visit(child);
        else result[child] = readFileSync(join(base, child));
      }
    };
    visit('');
    return result;
  };
  const ids = readdirSync(join(root, '.deep-loop', 'runs')).sort();
  const beforeTrees = Object.fromEntries(ids.map(id => [id, durableTree(id)]));
  for (const route of routes) {
    assert.equal(runResult(root, route).status, 2, route.join(' '));
    assert.equal(runResult(root, [...route, '--run-id']).status, 2, `${route.join(' ')} value-less`);
    assert.equal(runResult(root, [...route, '--run-id=']).status, 2, `${route.join(' ')} empty`);
    assert.equal(runResult(root, [...route, '--run-id', 'A', '--run-id', 'B']).status, 2, `${route.join(' ')} duplicate`);
  }
  assert.deepEqual(Object.fromEntries(ids.map(id => [id, durableTree(id)])), beforeTrees);
});

test('exact-read handlers do not resolve the ambient current pointer before their verified branch', () => {
  const source = readFileSync(join(process.cwd(), 'scripts', 'deep-loop.mjs'), 'utf8');
  for (const [handler, verb] of [
    ['lease', 'check'], ['state', 'get'], ['budget', 'check'],
    ['comprehension', 'status'], ['breaker', 'check'],
  ]) {
    const start = source.indexOf(`  ${handler}: async`);
    const end = source.indexOf('\n  },', start);
    assert.ok(start >= 0 && end > start, `${handler} handler must be present`);
    const body = source.slice(start, end);
    const branch = body.indexOf(`if (verb === '${verb}')`);
    assert.ok(branch >= 0, `${handler} exact branch must be present`);
    assert.equal(body.slice(0, branch).includes('runIdOf(root, f)'), false, `${handler} reads current too early`);
  }
});

test('explicit exact reads succeed without opening an unreadable current pointer', () => {
  const { root, runId } = seed();
  // A directory at the pointer path makes any accidental readFileSync(current)
  // fail deterministically while the explicit run remains fully readable.
  unlinkSync(join(root, '.deep-loop', 'current'));
  mkdirSync(join(root, '.deep-loop', 'current'));
  const result = runResult(root, ['state', 'get', '--run-id', runId]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).run_id, runId);
});

test('handoff emit and checkpoint restore missing identity preserve both run vectors', () => {
  const { root } = seed();
  initRun(root, { runtime: 'claude', goal: 'b', protocol: 'deep-work', now: new Date('2026-06-24T00:00:01Z') });
  const vector = runId => ['loop.json', '.loop.hash']
    .map(name => readFileSync(join(root, '.deep-loop', 'runs', runId, name), 'utf8'));
  const before = readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim();
  const ids = readdirSync(join(root, '.deep-loop', 'runs')).sort();
  const beforeVectors = Object.fromEntries(ids.map(id => [id, vector(id)]));
  for (const args of [['handoff', 'emit'], ['checkpoint', 'restore']]) {
    assert.equal(runResult(root, args).status, 2, args.join(' '));
  }
  assert.equal(readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim(), before);
  assert.deepEqual(Object.fromEntries(ids.map(id => [id, vector(id)])), beforeVectors);
});

test('run resolve projects selection diagnostics without snapshots or bytes', () => {
  const { root, runId: a } = seed();
  const { runId: b } = initRun(root, { runtime: 'claude', goal: 'b', protocol: 'deep-work', now: new Date('2026-06-24T00:00:01Z') });
  const result = runBoth(root, ['run', 'resolve', '--run-id', a, '--purpose', 'cli-read']);
  assert.equal(result.code, 0, result.err);
  const output = JSON.parse(result.out);
  assert.equal(output.run_id, a);
  assert.equal(output.source, 'explicit');
  assert.equal(output.ok, true);
  assert.equal(output.current, undefined);
  assert.equal(output.snapshot, undefined);
  assert.equal(output.vector, undefined);
  assert.equal(output.bytes, undefined);
  assert.notEqual(output.run_id, b);
});

// Codex r1 should-fix-2: spec §6 의 4-verb 계약을 CLI 가 노출해야 한다 (dispatch 만 X).
test('adapter resolve returns a normalized 4-verb descriptor', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'Add auth']));
  assert.equal(out.dispatch.kind, 'skill');
  assert.equal(out.dispatch.role, 'maker');
  assert.equal(out.dispatch.skill, 'deep-work:deep-work-orchestrator');
  assert.match(out.dispatch.args, /Add auth/);
  assert.equal(out.await.kind, 'poll_file');
  assert.match(out.await.path, /Add auth/);          // path_template <task> 치환
  assert.ok('read' in out);                            // readArtifacts receipt 디스크립터
  assert.match(out.checker_via, /review dispatch/);    // checker 는 review dispatch CLI 경유
});

test('adapter resolve --verb selects a single verb descriptor', () => {
  const { root } = seed();
  const a = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'x', '--verb', 'await']));
  assert.equal(a.selected, 'await');
  assert.equal(a.descriptor.kind, 'poll_file');
});

test('adapter resolve blocks the deep-work implementer entirely under read-only', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'x', '--tier', 'read-only']));
  assert.equal(out.guard.ok, false);   // dispatch 자체가 implementer → 전체 차단
});

// Codex r7 sf-1: read-only superpowers 는 planning(writing-plans)은 허용하고 then(implementer)만 strip.
test('adapter resolve allows planning-only superpowers under read-only', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'superpowers', '--task', 'x', '--tier', 'read-only']));
  assert.equal(out.guard.ok, true);
  assert.equal(out.guard.planning_only, true);
  assert.equal(out.dispatch.skill, 'superpowers:writing-plans');
  assert.equal(out.dispatch.then, null);   // subagent-driven-development(implementer) 차단
});

test('adapter resolve rejects unknown protocol (exit 2)', () => {
  const { root } = seed();
  assert.equal(runFail(root, ['adapter', 'resolve', '--protocol', 'nope', '--task', 'x']), 2);
});

// Codex r1 should-fix-6: 비-fence 인자 누락은 usage 오류(exit 2)지 fence 코드(3) 가 아니다.
test('adapter resolve missing --protocol exits 2 (usage, not fence-3)', () => {
  const { root } = seed();
  assert.equal(runFail(root, ['adapter', 'resolve', '--task', 'x']), 2);
});

test('state get returns whole loop and a field path', () => {
  const { root } = seed();
  const whole = JSON.parse(run(root, ['state', 'get']));
  assert.equal(whole.goal, 'g');
  const status = JSON.parse(run(root, ['state', 'get', '--field', 'status']));
  assert.equal(status, 'running');
  const missing = JSON.parse(run(root, ['state', 'get', '--field', 'nope.deep']));
  assert.equal(missing, null);
});

test('state get drains large JSON output before the CLI exits', () => {
  const { root, runId } = seed();
  const items = Array.from({ length: 2_000 }, (_, index) =>
    `${String(index).padStart(4, '0')}-${'x'.repeat(64)}`);
  appendAnchored(root, runId, {
    type: 'cli-large-output-fixture',
    data: { count: items.length },
    now: '2026-06-24T00:00:01.000Z',
  }, loop => { loop.discovered_items = items; });

  const stdout = run(root, ['state', 'get']);
  assert.ok(Buffer.byteLength(stdout, 'utf8') > 131_072);
  assert.deepEqual(JSON.parse(stdout).discovered_items, items);
});

test('state patch writes whitelisted field with valid fence', () => {
  const { root, runId } = seed({ 'deep-review': true });
  run(root, ['state', 'patch', '--field', 'discovered_items', '--value', '["a","b"]', '--owner', runId, '--generation', '1']);
  const got = JSON.parse(run(root, ['state', 'get', '--field', 'discovered_items']));
  assert.deepEqual(got, ['a', 'b']);
});

test('state patch rejects forbidden field (exit 1)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['state', 'patch', '--field', 'budget.spent', '--value', '999', '--owner', runId, '--generation', '1']), 1);
});

test('state patch is fenced on wrong generation (exit 3)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['state', 'patch', '--field', 'decisions', '--value', '["x"]', '--owner', runId, '--generation', '9']), 3);
});

test('state patch forbids terminal episode status (exit 1)', () => {
  const { root, runId } = seed();
  // episodes.0.status=done 은 터미널 → classifyPatch forbid (episode 가 없어도 분류 단계에서 거부)
  assert.equal(runFail(root, ['state', 'patch', '--field', 'episodes.0.status', '--value', '"done"', '--owner', runId, '--generation', '1']), 1);
});

test('review configure replaces flags through a confirmed fenced transaction', () => {
  const { root, runId } = seed({ 'deep-review': true });
  const sourceChecker = operationallyAbandonedChecker(root, runId);
  const flags = ['--contract', '--codex-only', '--reviewer-strategy', 'static'];
  const out = JSON.parse(run(root, [
    'review', 'configure', '--profile', 'codex-only-static',
    '--source-checker', sourceChecker, '--confirm',
    '--owner', runId, '--generation', '1',
  ]));

  assert.deepEqual(out, { ok: true, profile: 'codex-only-static', source_checker: sourceChecker, flags });
  assert.deepEqual(JSON.parse(run(root, ['state', 'get', '--field', 'review.flags'])), flags);
  assert.equal(JSON.parse(run(root, ['state', 'get', '--field', 'episodes.1.review_reconfiguration_consumed'])), true);

  const events = readFileSync(join(root, '.deep-loop', 'runs', runId, 'event-log.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.findLast(event => event.type === 'review-configured')?.data, {
    profile: 'codex-only-static', source_checker: sourceChecker, flags,
  });
});

test('review configure exposes one closed GPT-5.6 plus Agy diversity profile', () => {
  const { root, runId } = seed({ 'deep-review': true });
  const sourceChecker = operationallyAbandonedChecker(root, runId);
  const flags = [
    '--contract', '--no-fallback', '--no-opus', '--agy', '--codex', '--reviewer-strategy', 'static',
    '--reviewer-model', 'codex-review=gpt-5.6-sol',
    '--reviewer-model', 'codex-adversarial=gpt-5.6-sol',
    '--reviewer-model', 'agy=gemini-3.6-flash-high',
    '--reviewer-effort', 'codex-review=high',
    '--reviewer-effort', 'codex-adversarial=high',
  ];
  const out = JSON.parse(run(root, [
    'review', 'configure', '--profile', 'gpt56-agy-static',
    '--source-checker', sourceChecker, '--confirm',
    '--owner', runId, '--generation', '1',
  ]));

  assert.deepEqual(out, { ok: true, profile: 'gpt56-agy-static', source_checker: sourceChecker, flags });
  assert.deepEqual(JSON.parse(run(root, ['state', 'get', '--field', 'review.flags'])), flags);
});

test('review configure requires human confirmation and preserves existing flags', () => {
  const { root, runId } = seed({ 'deep-review': true });
  const sourceChecker = operationallyAbandonedChecker(root, runId);
  const before = JSON.parse(run(root, ['state', 'get', '--field', 'review.flags']));
  let code = 0, stderr = '';
  try {
    run(root, [
      'review', 'configure', '--profile', 'codex-only-static', '--source-checker', sourceChecker,
      '--owner', runId, '--generation', '1',
    ]);
  } catch (error) {
    code = error.status;
    stderr = String(error.stderr || '');
  }

  assert.equal(code, 2);
  assert.match(stderr, /CONFIRM_REQUIRED/);
  assert.deepEqual(JSON.parse(run(root, ['state', 'get', '--field', 'review.flags'])), before);
});

test('review configure rejects unsupported profiles without changing flags', () => {
  const { root, runId } = seed({ 'deep-review': true });
  const sourceChecker = operationallyAbandonedChecker(root, runId);
  const before = JSON.parse(run(root, ['state', 'get', '--field', 'review.flags']));
  const code = runFail(root, [
    'review', 'configure', '--profile', 'arbitrary-flags', '--source-checker', sourceChecker, '--confirm',
    '--owner', runId, '--generation', '1',
  ]);

  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(run(root, ['state', 'get', '--field', 'review.flags'])), before);
});

test('review configure rejects changes while a checker is non-terminal', () => {
  const { root, runId } = seed({ 'deep-review': true });
  const sourceChecker = operationallyAbandonedChecker(root, runId);
  run(root, [
    'episode', 'new', '--plugin', 'deep-review', '--role', 'checker',
    '--kind', 'plan-review', '--point', 'plan',
    '--owner', runId, '--generation', '1',
  ]);

  const code = runFail(root, [
    'review', 'configure', '--profile', 'codex-only-static', '--source-checker', sourceChecker, '--confirm',
    '--owner', runId, '--generation', '1',
  ]);
  assert.equal(code, 1);
});

test('review configure requires a latest abandoned operational checker and consumes it once', () => {
  const { root, runId } = seed({ 'deep-review': true });
  const sourceChecker = operationallyAbandonedChecker(root, runId);
  const args = [
    'review', 'configure', '--profile', 'codex-only-static', '--source-checker', sourceChecker, '--confirm',
    '--owner', runId, '--generation', '1',
  ];
  run(root, args);
  assert.equal(runFail(root, args), 1);

  const fresh = seed();
  assert.equal(runFail(fresh.root, [
    'review', 'configure', '--profile', 'codex-only-static', '--source-checker', '999-deep-review', '--confirm',
    '--owner', fresh.runId, '--generation', '1',
  ]), 1);
});

test('review configure has a closed, duplicate-free CLI grammar', () => {
  for (const extra of [
    ['--unknown', 'x'],
    ['positional'],
    ['--profile', 'codex-only-static'],
  ]) {
    const { root, runId } = seed({ 'deep-review': true });
    const sourceChecker = operationallyAbandonedChecker(root, runId);
    const before = JSON.parse(run(root, ['state', 'get', '--field', 'review.flags']));
    const code = runFail(root, [
      'review', 'configure', '--profile', 'codex-only-static', '--source-checker', sourceChecker, '--confirm',
      '--owner', runId, '--generation', '1', ...extra,
    ]);
    assert.equal(code, 2);
    assert.deepEqual(JSON.parse(run(root, ['state', 'get', '--field', 'review.flags'])), before);
  }
});

test('review configure rejects fabricated, non-operational, and non-deep-review sources', () => {
  const fabricated = seed({ 'deep-review': true });
  const fake = JSON.parse(run(fabricated.root, [
    'episode', 'new', '--plugin', 'deep-review', '--role', 'checker', '--kind', 'plan-review', '--point', 'plan',
    '--owner', fabricated.runId, '--generation', '1',
  ])).id;
  run(fabricated.root, [
    'episode', 'abandon', '--id', fake, '--reason', 'operational-review-failure: forged', '--confirm',
    '--owner', fabricated.runId, '--generation', '1',
  ]);
  assert.equal(runFail(fabricated.root, [
    'review', 'configure', '--profile', 'codex-only-static', '--source-checker', fake, '--confirm',
    '--owner', fabricated.runId, '--generation', '1',
  ]), 1);

  const ordinary = seed({ 'deep-review': true });
  const ordinarySource = operationallyAbandonedChecker(ordinary.root, ordinary.runId, 'operator cleanup');
  assert.equal(runFail(ordinary.root, [
    'review', 'configure', '--profile', 'codex-only-static', '--source-checker', ordinarySource, '--confirm',
    '--owner', ordinary.runId, '--generation', '1',
  ]), 1);

  const subagent = seed();
  const subagentSource = operationallyAbandonedChecker(subagent.root, subagent.runId);
  assert.equal(runFail(subagent.root, [
    'review', 'configure', '--profile', 'codex-only-static', '--source-checker', subagentSource, '--confirm',
    '--owner', subagent.runId, '--generation', '1',
  ]), 1);
});

test('review configure validates malformed locators and grammar before lease resolution', () => {
  const { root, runId } = seed({ 'deep-review': true });
  const sourceChecker = operationallyAbandonedChecker(root, runId);
  const base = ['review', 'configure', '--profile', 'codex-only-static', '--source-checker', sourceChecker, '--confirm'];
  assert.equal(runFail(root, [...base, '--owner', runId, '--generation', '1', '--run-id']), 2);
  assert.equal(runFail(root, [...base, '--owner', runId, '--generation', '1', '--project-root']), 2);
  assert.equal(runFail(root, [...base, '--owner', runId, '--generation', '9', '--unknown', 'x']), 2);
});

test('budget record accrues turns/tokens via event log with fence', () => {
  const { root, runId } = seed();
  const r = JSON.parse(run(root, ['budget', 'record', '--turns', '3', '--tokens', '1000', '--owner', runId, '--generation', '1']));
  assert.equal(r.ok, true);
  const spent = JSON.parse(run(root, ['state', 'get', '--field', 'budget.spent']));
  assert.equal(spent, 3);
});

test('budget record is fenced (exit 3)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['budget', 'record', '--turns', '1', '--owner', runId, '--generation', '9']), 3);
});

// Codex r4 sf-4: 값 없는 --turns 는 1 로 오기록하지 말고 거부(exit 1).
test('budget record rejects a valueless --turns (exit 1)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['budget', 'record', '--turns', '--owner', runId, '--generation', '1']), 1);
});

test('budget check is read-only and reports ok', () => {
  const { root } = seed();
  const r = JSON.parse(run(root, ['budget', 'check', '--now', '2026-06-24T00:00:01Z']));
  assert.equal(r.ok, true);
});

// Codex r3 critical-1: budget record 가 세션 turns 를 증가시켜 per_session_turn_cap 마일스톤을 실제로 구동.
test('budget record drives migrated rotate-per-unit cap → legacy unattended handoff', () => {
  const { root, runId } = seedMigratedLegacy();
  run(root, ['budget', 'record', '--turns', '40', '--owner', runId, '--generation', '1']);   // == per_session_turn_cap(40)
  const na = JSON.parse(run(root, ['next-action', '--json', '--now', '2026-06-24T00:00:01Z', '--unattended']));
  assert.equal(na.action.type, 'handoff');
  assert.equal(na.action.reason, 'per_session_turn_cap');
});

// Codex r3 sf-2: 스킬이 쓰는 CLI 경로(workstream new → episode new --workstream --artifacts
// → record in_progress → record done)가 실제로 통과하는지 통합 검증.
test('episode new --artifacts then record done (the skill flow)', () => {
  const { root, runId } = seed();
  const worktree = '.claude/worktrees/skill-flow';
  mkdirSync(join(root, worktree), { recursive: true });
  const ws = JSON.parse(run(root, [
    'workstream', 'new',
    '--title', 'skill flow',
    '--branch', 'test/skill-flow',
    '--worktree', worktree,
    '--owner', runId,
    '--generation', '1',
  ]));
  const artifact = `${worktree}/art.txt`;
  writeFileSync(join(root, artifact), 'x');
  const ep = JSON.parse(run(root, [
    'episode', 'new',
    '--plugin', 'deep-work',
    '--role', 'maker',
    '--kind', 'implementation',
    '--point', 'implementation',
    '--workstream', ws.id,
    '--artifacts', JSON.stringify([artifact]),
    '--owner', runId,
    '--generation', '1',
  ]));
  run(root, [
    'episode', 'record',
    '--id', ep.id,
    '--status', 'in_progress',
    '--owner', runId,
    '--generation', '1',
  ]);
  run(root, [
    'episode', 'record',
    '--id', ep.id,
    '--status', 'done',
    '--artifacts', JSON.stringify([artifact]),
    '--owner', runId,
    '--generation', '1',
  ]);
  assert.equal(JSON.parse(run(root, ['state', 'get', '--field', 'episodes.0.status'])), 'done');
});

test('episode new returns a derived absolute request path while durable state stores only request_rel', () => {
  const { root, runId } = seed();
  const ep = JSON.parse(run(root, [
    'episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'implementation',
    '--point', 'implementation', '--owner', runId, '--generation', '1',
  ]));
  assert.equal(ep.request_path, join(root, '.deep-loop', 'runs', runId, ep.request_rel));
  const durable = JSON.parse(run(root, ['state', 'get', '--field', 'episodes.0']));
  assert.equal(durable.request_rel, ep.request_rel);
  assert.equal(Object.hasOwn(durable, 'request_path'), false);
});

test('init-run continuation CLI accepts only workstream-session with pinned usage/invalid exits', () => {
  const validRoot = mkdtempSync(join(tmpdir(), 'dl-init-policy-'));
  const valid = runBoth(validRoot, ['init-run', '--runtime', 'codex', '--goal', 'g', '--continuation', 'workstream-session']);
  assert.equal(valid.code, 0, valid.err);

  const valuelessRoot = mkdtempSync(join(tmpdir(), 'dl-init-policy-'));
  const valueless = runBoth(valuelessRoot, ['init-run', '--runtime', 'claude', '--goal', 'g', '--continuation']);
  assert.equal(valueless.code, 2, valueless.err);
  assert.match(valueless.err, /USAGE: --continuation <workstream-session>/);

  for (const legacy of ['compact-in-place', 'rotate-per-unit']) {
    const root = mkdtempSync(join(tmpdir(), 'dl-init-policy-'));
    const result = runBoth(root, ['init-run', '--runtime', 'claude', '--goal', 'g', '--continuation', legacy]);
    assert.equal(result.code, 1, `${legacy}: ${result.err}`);
    assert.match(result.err, /UNSUPPORTED_RUNTIME_POLICY/);
  }
});

test('handoff boundary-event CLI spelling is strict base10 seq without leading zero plus lowercase checksum', () => {
  for (const [value, expectedCode] of [
    [null, 2],
    ['0:' + 'a'.repeat(64), 1],
    ['01:' + 'a'.repeat(64), 1],
    ['1:' + 'A'.repeat(64), 1],
    ['1:' + 'a'.repeat(63), 1],
    ['1:not-a-checksum', 1],
  ]) {
    const { root, runId } = seed();
    const args = ['handoff', 'emit', '--run-id', runId, '--owner', runId, '--generation', '1', '--boundary-event'];
    if (value !== null) args.push(value);
    const result = runBoth(root, args);
    assert.equal(result.code, expectedCode, `${value}: ${result.err}`);
    assert.match(result.err, value === null ? /USAGE: --boundary-event/ : /BOUNDARY_EVENT_INVALID/);
  }
});

function bindCheckpointAffinity(root, runId) {
  mkdirSync(join(root, '.claude', 'worktrees', 'checkpoint'), { recursive: true });
  const workstream = JSON.parse(run(root, [
    'workstream', 'new',
    '--title', 'checkpoint',
    '--branch', 'feature/checkpoint',
    '--worktree', '.claude/worktrees/checkpoint',
    '--owner', runId,
    '--generation', '1',
  ]));
  const episode = JSON.parse(run(root, [
    'episode', 'new',
    '--plugin', 'deep-work',
    '--role', 'maker',
    '--kind', 'implementation',
    '--point', 'implementation',
    '--workstream', workstream.id,
    '--artifacts', '[".claude/worktrees/checkpoint/result.txt"]',
    '--owner', runId,
    '--generation', '1',
  ]));
  run(root, [
    'episode', 'record',
    '--id', episode.id,
    '--status', 'in_progress',
    '--owner', runId,
    '--generation', '1',
  ]);
  return { workstream, episode };
}

function checkpointDurableInventory(root, runId) {
  const inventory = {};
  const visit = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.lock') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path, rel);
      else inventory[rel] = readFileSync(path).toString('base64');
    }
  };
  visit(runDir(root, runId));
  return inventory;
}

function prepareCheckpointGenericPublication(root, runId, operationId) {
  assert.throws(() => appendAnchored(
    root,
    runId,
    {
      type: 'checkpoint-cli-generic-publication-test',
      data: { operation_id: operationId },
      now: '2026-06-24T00:00:01.500Z',
    },
    loop => { loop.discovered_items.push(operationId); },
    undefined,
    {
      publication: {
        kind: 'workstream-boundary',
        operationId,
        artifacts: [{
          rel: `artifacts/${operationId}.txt`,
          bytes: Buffer.from(`artifact:${operationId}`),
        }],
        topology: { operation_id: operationId, phase: 'prepared' },
        faultAt(label) {
          if (label === 'prepared:digest-verified') throw new Error('prepared publication');
        },
      },
    },
  ), /TRANSACTION_PENDING/);
}

for (const verb of ['emit', 'observe']) {
  test(`public CLI ${verb} fences before generic publication and tombstone reconciliation`, () => {
    const { root, runId } = seed();
    bindCheckpointAffinity(root, runId);
    let emitted;
    let input;
    if (verb === 'observe') {
      emitted = JSON.parse(run(root, [
        'checkpoint', 'emit', '--owner', runId, '--generation', '1', '--runtime', 'claude',
      ]));
      writeFileSync(join(
        runDir(root, runId),
        'checkpoints',
        `${emitted.checkpoint_key}-compact-prune.json`,
      ), '{}');
      const containedCwd = join(realpathSync(root), '.claude', 'worktrees', 'checkpoint', 'src');
      mkdirSync(containedCwd, { recursive: true });
      input = JSON.stringify({
        hook_event_name: 'PostCompact', cwd: containedCwd, trigger: 'manual',
      });
    }
    prepareCheckpointGenericPublication(root, runId, `cli-${verb}-wrong-fence`);
    const before = checkpointDurableInventory(root, runId);
    const args = verb === 'emit'
      ? ['checkpoint', 'emit']
      : [
          'checkpoint', 'observe', '--checkpoint', emitted.checkpoint_rel,
          '--trigger', 'manual', '--trusted-postcompact-stdin', '--json',
        ];
    const result = runBoth(root, [
      ...args,
      '--owner', 'wrong-owner',
      '--generation', '1',
      '--runtime', 'claude',
    ], { input });

    assert.equal(result.code, 3, `${verb}: ${result.err}`);
    assert.match(result.err, /LEASE_FENCED: owner-mismatch/);
    assert.deepEqual(checkpointDurableInventory(root, runId), before, verb);
  });
}

test('checkpoint emit, inspect, and restore expose the exact public grammar', () => {
  const { root, runId } = seed();
  bindCheckpointAffinity(root, runId);

  const emitted = runBoth(root, [
    'checkpoint', 'emit',
    '--run-id', runId,
    '--owner', runId,
    '--generation', '1',
    '--runtime', 'claude',
  ]);
  assert.equal(emitted.code, 0, emitted.err);
  const checkpoint = JSON.parse(emitted.out);
  assert.match(checkpoint.checkpoint_rel, /^checkpoints\/[0-9a-f]{64}-compact\.json$/);
  assert.equal(Object.hasOwn(checkpoint, 'path'), false);
  assert.equal(emitted.out.includes(root), false);

  const inspected = runBoth(root, ['checkpoint', 'inspect', '--run-id', runId, '--json']);
  assert.equal(inspected.code, 0, `${inspected.err}\n${inspected.out}`);
  assert.equal(JSON.parse(inspected.out).checkpoint_rel, checkpoint.checkpoint_rel);

  const restored = runBoth(root, [
    'checkpoint', 'restore',
    '--run-id', runId,
    '--checkpoint', checkpoint.checkpoint_rel,
    '--owner', runId,
    '--generation', '1',
    '--runtime', 'claude',
    '--admission', 'human-attested',
    '--source', 'direct-human-skill',
    '--confirm-manual-compact',
    '--json',
  ], { env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  assert.equal(restored.code, 0, restored.err);
  const descriptor = JSON.parse(restored.out);
  assert.equal(descriptor.checkpoint_rel, checkpoint.checkpoint_rel);
  assert.equal(descriptor.owner_run_id, runId);
  assert.equal(descriptor.generation, 1);
  assert.equal(descriptor.runtime, 'claude');
  assert.equal(descriptor.phase, 'restored');
  assert.equal(descriptor.workstream_id, checkpoint.workstream_id);
  assert.equal(descriptor.next_command, null);
  assert.equal(descriptor.requires_model_turn, false);
});

test('checkpoint observe accepts only bounded trusted PostCompact stdin and inspect stays evidence-free', () => {
  const { root, runId } = seed();
  bindCheckpointAffinity(root, runId);
  const emitted = JSON.parse(run(root, [
    'checkpoint', 'emit', '--owner', runId, '--generation', '1', '--runtime', 'claude',
  ]));
  const observeArgs = [
    'checkpoint', 'observe',
    '--checkpoint', emitted.checkpoint_rel,
    '--trigger', 'manual',
    '--owner', runId,
    '--generation', '1',
    '--runtime', 'claude',
    '--json',
  ];
  assert.equal(runBoth(root, observeArgs).code, 1, 'trusted ingress is semantic, not grammar');
  const containedCwd = join(realpathSync(root), '.claude', 'worktrees', 'checkpoint', 'src');
  mkdirSync(containedCwd, { recursive: true });
  const body = JSON.stringify({
    hook_event_name: 'PostCompact', cwd: containedCwd, trigger: 'manual', session_id: 'cli-session',
  });
  const observed = runBoth(root, [...observeArgs, '--trusted-postcompact-stdin'], { input: body });
  assert.equal(observed.code, 0, observed.err);
  assert.deepEqual(JSON.parse(observed.out).provider_evidence, {
    recorded: false, supplied: true, matched: false,
  });
  const inspected = runBoth(root, ['checkpoint', 'inspect', '--json']);
  assert.equal(inspected.code, 0, `${inspected.err}\n${inspected.out}`);
  assert.deepEqual(JSON.parse(inspected.out).provider_evidence, {
    recorded: false, supplied: true, matched: false,
  });
  assert.equal(inspected.out.includes('cli-session'), false);
  assert.equal(inspected.out.includes('claude-code'), false);

  for (const input of [
    '{',
    JSON.stringify({ hook_event_name: 'SessionStart', cwd: realpathSync(root), trigger: 'manual' }),
    JSON.stringify({ hook_event_name: 'PostCompact', cwd: realpathSync(root), trigger: 'auto' }),
    JSON.stringify({ hook_event_name: 'PostCompact', cwd: `${root}/..`, trigger: 'manual' }),
    `${JSON.stringify({ hook_event_name: 'PostCompact', cwd: realpathSync(root), trigger: 'manual' })}${' '.repeat(4097)}`,
  ]) {
    assert.equal(
      runBoth(root, [...observeArgs, '--trusted-postcompact-stdin'], { input }).code,
      1,
      input.slice(0, 80),
    );
  }
});

test('checkpoint mutators apply fence-first polarity before all other grammar', () => {
  const { root, runId } = seed();
  bindCheckpointAffinity(root, runId);
  for (const verb of ['emit', 'observe', 'restore']) {
    for (const malformedFence of [
      [],
      ['--owner', runId],
      ['--generation', '1'],
      ['--owner', runId, '--generation', '0'],
      ['--owner', runId, '--generation', '01'],
      ['--owner', runId, '--generation', '1', '--generation', '1'],
    ]) {
      assert.equal(
        runBoth(root, ['checkpoint', verb, ...malformedFence, '--unknown']).code,
        3,
        `${verb}: ${malformedFence.join(' ')}`,
      );
    }
    assert.equal(runBoth(root, [
      'checkpoint', verb, '--owner', runId, '--generation', '1', '--fault', 'x',
    ]).code, 2, `${verb}: production --fault`);
  }
  for (const args of [
    ['checkpoint', 'inspect', '--owner', runId, '--json'],
    ['checkpoint', 'inspect', '--json=true'],
    ['checkpoint', 'inspect', '--json', '--json'],
  ]) assert.equal(runBoth(root, args).code, 2, args.join(' '));
});

test('checkpoint public grammar distinguishes usage, fence, and invalid data exits', () => {
  const { root, runId } = seed();
  bindCheckpointAffinity(root, runId);
  for (const args of [
    ['checkpoint', 'emit', '--owner', runId, '--generation', '1'],
    ['checkpoint', 'inspect', '--run-id', runId],
    ['checkpoint', 'restore', '--checkpoint', 'checkpoints/x-compact.json',
      '--owner', runId, '--generation', '1', '--runtime', 'claude'],
  ]) {
    assert.equal(runBoth(root, args).code, 2, args.join(' '));
  }
  for (const args of [
    ['checkpoint', 'emit', '--run-id', runId, '--runtime', 'claude'],
    ['checkpoint', 'emit', '--run-id', runId, '--owner', runId, '--runtime', 'claude'],
    ['checkpoint', 'emit', '--run-id', runId, '--owner', runId, '--generation', 'zero', '--runtime', 'claude'],
    ['checkpoint', 'emit', '--run-id', runId, '--owner', runId, '--owner', runId,
      '--generation', '1', '--runtime', 'claude'],
    ['checkpoint', 'emit', '--run-id', runId, '--owner', runId,
      '--generation', '1', '--generation', '1', '--runtime', 'claude'],
  ]) {
    assert.equal(runBoth(root, args).code, 3, args.join(' '));
  }
  assert.equal(runBoth(root, [
    'checkpoint', 'emit',
    '--run-id', runId,
    '--owner', runId,
    '--generation', '1',
    '--runtime', 'claude',
    '--runtime', 'claude',
  ]).code, 2);
  assert.equal(runBoth(root, [
    'checkpoint', 'emit',
    '--run-id', runId,
    '--owner', runId,
    '--generation', '9',
    '--runtime', 'claude',
  ]).code, 3);
  assert.equal(runBoth(root, [
    'checkpoint', 'emit',
    '--run-id', runId,
    '--owner', runId,
    '--generation', '1',
    '--runtime', 'invalid',
  ]).code, 1);
  assert.equal(runBoth(root, [
    'checkpoint', 'restore',
    '--run-id', runId,
    '--checkpoint', '../outside.json',
    '--owner', runId,
    '--generation', '1',
    '--runtime', 'claude',
    '--admission', 'human-attested',
    '--source', 'direct-human-skill',
    '--confirm-manual-compact',
    '--json',
  ]).code, 1);

  const admissionCheckpoint = JSON.parse(run(root, [
    'checkpoint', 'emit', '--owner', runId, '--generation', '1', '--runtime', 'claude',
  ]));
  const validRestorePrefix = [
    'checkpoint', 'restore',
    '--checkpoint', admissionCheckpoint.checkpoint_rel,
    '--owner', runId,
    '--generation', '1',
    '--runtime', 'claude',
  ];
  assert.equal(runBoth(root, [
    ...validRestorePrefix,
    '--admission', 'human-attested',
    '--source', 'direct-human-skill',
    '--json',
  ]).code, 2, 'manual confirmation is a required non-fence option');
  assert.equal(runBoth(root, [
    ...validRestorePrefix,
    '--admission', 'invalid',
    '--source', 'direct-human-skill',
    '--json',
  ]).code, 1);
  assert.equal(runBoth(root, [
    ...validRestorePrefix,
    '--admission', 'postcompact-observation',
    '--source', 'sessionstart',
    '--confirm-manual-compact',
    '--json',
  ]).code, 1);
  assert.equal(runBoth(root, [
    ...validRestorePrefix,
    '--admission', 'human-attested',
    '--source', 'direct-human-skill',
    '--confirm-manual-compact',
    '--fault', 'event:appended',
    '--json',
  ]).code, 2, 'production fault argv is unknown usage');
});

test('checkpoint restore ignores inherited test fault environment switches', () => {
  const { root, runId } = seed();
  bindCheckpointAffinity(root, runId);
  const emitted = JSON.parse(run(root, [
    'checkpoint', 'emit',
    '--owner', runId,
    '--generation', '1',
    '--runtime', 'claude',
  ]));
  const result = runBoth(root, [
    'checkpoint', 'restore',
    '--checkpoint', emitted.checkpoint_rel,
    '--owner', runId,
    '--generation', '1',
    '--runtime', 'claude',
    '--admission', 'human-attested',
    '--source', 'direct-human-skill',
    '--confirm-manual-compact',
    '--json',
  ], {
    env: {
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      NODE_ENV: 'test',
      DEEP_LOOP_TEST_FAULT: 'event:appended',
    },
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).disposition, 'committed');
});

test('checkpoint verbs reject explicit-empty and duplicate-empty project roots and run ids before fallback', () => {
  const { root, runId } = seed();
  bindCheckpointAffinity(root, runId);
  const emitted = JSON.parse(run(root, [
    'checkpoint', 'emit',
    '--owner', runId,
    '--generation', '1',
    '--runtime', 'claude',
  ]));
  const verbs = [
    [
      'checkpoint', 'emit',
      '--run-id', runId,
      '--owner', runId,
      '--generation', '1',
      '--runtime', 'claude',
    ],
    ['checkpoint', 'inspect', '--run-id', runId, '--json'],
    [
      'checkpoint', 'restore',
      '--checkpoint', emitted.checkpoint_rel,
      '--owner', runId,
      '--generation', '1',
      '--runtime', 'claude',
      '--json',
    ],
  ];
  for (const verb of verbs) {
    for (const explicitEmpty of [
      [...verb, '--run-id', runId, '--project-root='],
      [...verb, '--run-id', runId, '--project-root', ''],
      [...verb, '--run-id', runId, '--project-root=', '--project-root', root],
      [...verb, '--project-root', root, '--run-id='],
      [...verb, '--project-root', root, '--run-id', ''],
      [...verb, '--project-root', root, '--run-id=', '--run-id', runId],
    ]) {
      const result = runRaw(root, explicitEmpty);
      assert.equal(result.code, 2, explicitEmpty.join(' '));
      assert.match(result.err, /USAGE:/, explicitEmpty.join(' '));
    }
  }
});

test('checkpoint CLI cannot invoke the trusted legacy compatibility emitter', () => {
  const { root, runId } = seedMigratedLegacy();
  const active = runBoth(root, [
    'checkpoint', 'emit',
    '--run-id', runId,
    '--owner', runId,
    '--generation', '1',
    '--runtime', 'claude',
  ]);
  assert.equal(active.code, 1, active.err);
  assert.match(active.err, /CHECKPOINT_LEGACY_TRUST_REQUIRED/);
  assert.equal(
    runBoth(root, [
      'checkpoint', 'emit',
      '--run-id', runId,
      '--owner', runId,
      '--generation', '9',
      '--runtime', 'claude',
    ]).code,
    3,
  );
  assert.equal(
    runBoth(root, [
      'checkpoint', 'emit',
      '--run-id', runId,
      '--owner', runId,
      '--generation', '1',
      '--runtime', 'codex',
    ]).code,
    3,
  );
});

test('comprehension status is read-only', () => {
  const { root } = seed();
  const r = JSON.parse(run(root, ['comprehension', 'status']));
  assert.equal(r.debt_ratio, 0);
});

test('comprehension ack is fenced (exit 3)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['comprehension', 'ack', '--episode', 'x', '--owner', runId, '--generation', '9']), 3);
});

// Codex r1 should-fix-5: 부재 episode ack 는 overcount 를 일으키면 안 된다 → 거부(exit 1).
test('comprehension ack rejects nonexistent episode (exit 1)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['comprehension', 'ack', '--episode', 'ghost', '--owner', runId, '--generation', '1']), 1);
});

// Codex r1 should-fix-6: 비-fence 인자 누락 → exit 2 (usage).
test('comprehension ack missing --episode exits 2', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['comprehension', 'ack', '--owner', runId, '--generation', '1']), 2);
});

test('breaker reset requires --confirm (exit 2)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['breaker', 'reset', '--owner', runId, '--generation', '1']), 2);   // confirm 없음
});

test('breaker reset with --confirm is still fenced (exit 3)', () => {
  const { root, runId } = seed();   // Codex r2 critical-1: confirm 만으로는 부족, fence 도 필요
  assert.equal(runFail(root, ['breaker', 'reset', '--confirm', '--owner', runId, '--generation', '9']), 3);
});

test('breaker check is read-only', () => {
  const { root } = seed();
  const r = JSON.parse(run(root, ['breaker', 'check']));
  assert.equal(r.tripped, false);
});

// Fix 3: missing required non-fence args → exit 2
test('episode new missing --plugin exits 2', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['episode', 'new', '--role', 'maker', '--kind', 'implementation', '--point', 'implementation', '--owner', runId, '--generation', '1']), 2);
});

test('episode new missing --role exits 2', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['episode', 'new', '--plugin', 'deep-work', '--kind', 'implementation', '--point', 'implementation', '--owner', runId, '--generation', '1']), 2);
});

test('review dispatch missing --point exits 2', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['review', 'dispatch', '--workstream', 'ws1', '--owner', runId, '--generation', '1']), 2);
});

// ── Problem A: state get no-active-run guard (2026-06-29 Windows fixes) ──────────
function runBoth(root, args, { env = process.env, input } = {}) {
  const first = args[1] && !args[1].startsWith('--') ? args[1] : null;
  const key = args[0] === 'finish' ? 'finish' : first ? `${args[0]} ${first}` : args[0];
  let effective = args;
  if ((MUTATING.has(key) || EXACT_READS.has(key))
    && !args.some(arg => arg === '--run-id' || arg.startsWith('--run-id='))) {
    const currentPath = join(root, '.deep-loop', 'current');
    if (existsSync(currentPath)) effective = [...args, '--run-id', readFileSync(currentPath, 'utf8').trim()];
  }
  try { const out = execFileSync(process.execPath, [CLI, ...effective, '--project-root', root], { encoding: 'utf8', env, input }); return { out: out.trim(), code: 0, err: '' }; }
  catch (e) { return { out: (e.stdout || '').trim(), code: e.status ?? 1, err: (e.stderr || '').trim() }; }
}
function runRaw(root, args) {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
    return { out: out.trim(), code: 0, err: '' };
  } catch (e) {
    return { out: (e.stdout || '').trim(), code: e.status ?? 1, err: (e.stderr || '').trim() };
  }
}

test('A1: state get with no current pointer requires explicit identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-a1-'));
  const r = runBoth(root, ['state', 'get', '--field', 'status']);
  assert.equal(r.code, 2);
  assert.match(r.err, /exact reads require/);
  assert.ok(!/\bat .*:\d+:\d+/.test(r.err), 'no stacktrace in stderr');
});

test('A1: dangling current does not authorize an exact read', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-a1-'));
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), '01JABCNOTAREALRUN\n');
  const r = runResult(root, ['state', 'get', '--field', 'status']);
  assert.equal(r.status, 2);
});

test('A1: partial state loss (run dir present, loop.json gone) → STATE_MISSING, exit≠0', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-a1-'));
  const rid = '01JABCPARTIALLOSS';
  const rd = join(root, '.deep-loop', 'runs', rid);
  mkdirSync(rd, { recursive: true });
  writeFileSync(join(rd, 'event-log.jsonl'), '{}\n');   // run dir + artifact exist; loop.json does NOT
  writeFileSync(join(root, '.deep-loop', 'current'), rid + '\n');
  const r = runBoth(root, ['state', 'get', '--run-id', rid, '--field', 'status']);
  assert.notEqual(r.code, 0);
  assert.match(`${r.err}${r.out}`, /STATE_MISSING|integrity-invalid|reconciliation-required/);
});

test('A1: explicit --run-id miss → fail closed (not null)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-a1-'));
  const r = runBoth(root, ['state', 'get', '--run-id', '01JABCDOESNOTEXIST', '--field', 'status']);
  assert.notEqual(r.code, 0);
  assert.notEqual(r.out, 'null');
});

test('A1: corrupt loop.json (bad JSON) → fail closed (not null)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-a1-'));
  const rid = '01JABCCORRUPTJSON';
  const rd = join(root, '.deep-loop', 'runs', rid);
  mkdirSync(rd, { recursive: true });
  writeFileSync(join(rd, 'loop.json'), '{ not json');
  writeFileSync(join(rd, '.loop.hash'), 'whatever');
  writeFileSync(join(root, '.deep-loop', 'current'), rid + '\n');
  const r = runBoth(root, ['state', 'get', '--run-id', rid, '--field', 'status']);
  assert.notEqual(r.code, 0);
  assert.notEqual(r.out, 'null');
});

test('A1: state patch with no run → MISSING_RUN_ID, exit 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-a1-'));
  const r = runBoth(root, ['state', 'patch', '--field', 'discovered_items', '--value', '[]', '--owner', 'x', '--generation', '1']);
  assert.equal(r.code, 2);
  assert.match(r.err, /valued --run-id/);
});

// #4: finish --status stopped is a human-only bypass — the CLI fast-fails (exit 2) without --confirm,
// mirroring abandon/recover/breaker-reset. completed is unaffected.
test('finish --status stopped without --confirm exits 2 (#4)', () => {
  const { root, runId } = seed();
  const result = runBoth(root, ['finish', '--status', 'stopped', '--proof', '{"human_reason":"x"}', '--owner', runId, '--generation', '1', '--run-id', runId]);
  assert.equal(result.code, 2);
});
