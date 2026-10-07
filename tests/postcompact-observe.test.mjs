import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emitCompactCheckpoint } from '../scripts/lib/checkpoint.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { resolveRunContext } from '../scripts/lib/run-context.mjs';
import { runDir } from '../scripts/lib/state.mjs';
import { newWorkstream, setWorkstreamStatus } from '../scripts/lib/workspace.mjs';

const PROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER = join(PROOT, 'scripts', 'hooks-impl', 'postcompact-observe.mjs');
const CLI = join(PROOT, 'scripts', 'deep-loop.mjs');
const MANIFEST = join(PROOT, 'hooks', 'hooks.json');
const EXPECTED_BOOTSTRAP = `node -e "const{join}=require('node:path');const{pathToFileURL}=require('node:url');const r=process.env.CLAUDE_PLUGIN_ROOT||process.env.PLUGIN_ROOT;if(!r){console.error('deep-loop: plugin root unavailable')}else{import(pathToFileURL(join(r,'scripts','hooks-impl','postcompact-observe.mjs')).href).then(m=>m.main()).catch(()=>console.error('deep-loop: postcompact hook failed'))}"`;
const EXPECTED_PRECOMPACT = `node -e "const{join}=require('node:path');const{pathToFileURL}=require('node:url');const r=process.env.CLAUDE_PLUGIN_ROOT||process.env.PLUGIN_ROOT;if(!r){console.error('deep-loop: plugin root unavailable')}else{import(pathToFileURL(join(r,'scripts','hooks-impl','precompact-handoff.mjs')).href).then(m=>m.main()).catch(()=>console.error('deep-loop: precompact hook failed'))}"`;
const EXPECTED_SESSIONSTART = `node -e "const{join}=require('node:path');const{pathToFileURL}=require('node:url');const r=process.env.CLAUDE_PLUGIN_ROOT||process.env.PLUGIN_ROOT;if(!r){console.error('deep-loop: plugin root unavailable')}else{import(pathToFileURL(join(r,'scripts','hooks-impl','sessionstart-restore.mjs')).href).then(m=>m.main()).catch(()=>console.error('deep-loop: sessionstart hook failed'))}"`;

function seed(runtime = 'claude', {
  root = realpathSync(mkdtempSync(join(tmpdir(), `dl-postcompact-${runtime}-`))),
  label = runtime,
  now = '2026-08-05T00:00:00.000Z',
  worktree,
} = {}) {
  const { runId } = initRun(root, {
    runtime,
    goal: 'postcompact adapter',
    now: new Date(now),
  });
  const fence = { owner: runId, generation: 1 };
  const resolvedWorktree = worktree ?? `.claude/worktrees/postcompact-${label}`;
  const containedCwd = join(root, resolvedWorktree, 'src');
  mkdirSync(containedCwd, { recursive: true });
  const workstreamId = newWorkstream(root, runId, {
    title: `postcompact-${label}`,
    branch: `feature/postcompact-${label}`,
    worktree: resolvedWorktree,
    fence,
  }).id;
  setWorkstreamStatus(root, runId, workstreamId, 'in_progress', { fence });
  const episodeId = newEpisode(root, runId, {
    plugin: 'deep-work',
    role: 'maker',
    kind: 'implementation',
    point: 'implementation',
    workstream: workstreamId,
    expectedArtifacts: [],
    fence,
  }).id;
  recordEpisode(root, runId, episodeId, { status: 'in_progress', fence });
  const checkpoint = emitCompactCheckpoint(root, runId, {
    fence,
    runtime,
    now: Date.parse(now) + 1_000,
  });
  return { root, runId, runtime, fence, containedCwd, checkpoint };
}

test('PostCompact resolves a unique cwd-bound run and fails closed on project-wide ambiguity', async () => {
  const first = seed('claude', { label: 'first' });
  const second = seed('claude', {
    root: first.root,
    label: 'second',
    now: '2026-08-05T00:01:00.000Z',
  });
  const { runPostCompactObserve } = await loadAdapter();
  const calls = [];
  const spawnSyncImpl = (bin, argv, options) => {
    calls.push({ bin, argv, options });
    return { status: 0, signal: null, error: undefined };
  };

  const bound = runPostCompactObserve({
    cwd: first.containedCwd,
    hook_event_name: 'PostCompact',
    trigger: 'auto',
  }, { spawnSyncImpl, expectedRoot: first.root });
  assert.deepEqual(bound, { ok: true, action: 'observed' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].argv.at(-1), first.runId,
    'the newer .deep-loop/current run must not steal a cwd-bound PostCompact event');
  assert.equal(calls[0].argv.includes(second.runId), false);

  const ambiguous = runPostCompactObserve({
    cwd: first.root,
    hook_event_name: 'PostCompact',
    trigger: 'auto',
  }, { spawnSyncImpl, expectedRoot: first.root });
  assert.deepEqual(ambiguous, {
    ok: false,
    action: 'ignored',
    reason: 'observation-unavailable',
  });
  assert.equal(calls.length, 1, 'ambiguous project-wide PostCompact must not spawn');
});

test('PostCompact resolves a unique cwd-bound run from .worktrees convention', async () => {
  const first = seed('claude', {
    label: 'plain-first',
    worktree: '.worktrees/postcompact-plain-first',
  });
  const second = seed('claude', {
    root: first.root,
    label: 'plain-second',
    now: '2026-08-05T00:01:00.000Z',
    worktree: '.worktrees/postcompact-plain-second',
  });
  const { runPostCompactObserve } = await loadAdapter();
  const calls = [];
  const spawnSyncImpl = (bin, argv, options) => {
    calls.push({ bin, argv, options });
    return { status: 0, signal: null, error: undefined };
  };
  const bound = runPostCompactObserve({
    cwd: first.containedCwd,
    hook_event_name: 'PostCompact',
    trigger: 'auto',
  }, { spawnSyncImpl, expectedRoot: first.root });
  assert.deepEqual(bound, { ok: true, action: 'observed' });
  assert.equal(calls[0].argv.at(-1), first.runId);
  assert.equal(calls[0].argv.includes(second.runId), false);
});

test('PostCompact fails closed when a cwd-bound run is corrupt instead of observing another active run', async () => {
  const first = seed('claude', { label: 'corrupt-first' });
  const second = seed('claude', {
    root: first.root,
    label: 'valid-second',
    now: '2026-08-05T00:01:00.000Z',
  });
  writeFileSync(join(runDir(first.root, first.runId), 'loop.json'), '{');

  const { runPostCompactObserve } = await loadAdapter();
  let spawns = 0;
  const result = runPostCompactObserve({
    cwd: first.containedCwd,
    hook_event_name: 'PostCompact',
    trigger: 'auto',
  }, {
    expectedRoot: first.root,
    spawnSyncImpl: () => {
      spawns += 1;
      return { status: 0, signal: null, error: undefined };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'ignored',
    reason: 'observation-unavailable',
  });
  assert.equal(spawns, 0);
  assert.equal(existsSync(observationPath(second)), false,
    'a valid concurrent run must not receive false compaction evidence');
});

async function loadAdapter() {
  return import(`${pathToFileURL(ADAPTER).href}?test=${Date.now()}-${Math.random()}`);
}

function manifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

function bootstrapSource() {
  const command = manifest().hooks.PostCompact?.[0]?.hooks?.[0]?.command;
  assert.equal(command, EXPECTED_BOOTSTRAP);
  return command.slice('node -e "'.length, -1);
}

function bootstrapEnv(rootName = 'CLAUDE_PLUGIN_ROOT') {
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.PLUGIN_ROOT;
  if (rootName) env[rootName] = PROOT;
  return env;
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 2_097_152,
    ...options,
  });
}

function observationPath(fixture) {
  return join(
    runDir(fixture.root, fixture.runId),
    fixture.checkpoint.checkpoint_rel.replace(/-compact\.json$/, '-compact-observation.json'),
  );
}

function jsonAtExactBytes(value, bytes) {
  const empty = JSON.stringify({ ...value, ignored_host_field: '' });
  const padding = bytes - Buffer.byteLength(empty, 'utf8');
  assert.ok(padding >= 0);
  const raw = JSON.stringify({ ...value, ignored_host_field: 'x'.repeat(padding) });
  assert.equal(Buffer.byteLength(raw, 'utf8'), bytes);
  return raw;
}

test('PostCompact adapter is CLI-observe-only and never routes restore or continue', async () => {
  assert.equal(existsSync(ADAPTER), true, 'PostCompact adapter must exist');
  const hooks = manifest().hooks;
  assert.deepEqual(hooks.PostCompact?.map(entry => entry.matcher), ['*']);
  assert.equal(hooks.PostCompact[0].hooks[0].command, EXPECTED_BOOTSTRAP);

  const fixture = seed('claude');
  const rawIdentity = 'raw-session-must-remain-pipe-only';
  const calls = [];
  const { runPostCompactObserve } = await loadAdapter();
  const result = runPostCompactObserve({
    cwd: fixture.containedCwd,
    hook_event_name: 'PostCompact',
    trigger: 'manual',
    session_id: rawIdentity,
    transcript_path: '/host-only/ignored.jsonl',
  }, {
    spawnSyncImpl: (bin, argv, options) => {
      calls.push({ bin, argv, options });
      return { status: 0, signal: null, error: undefined };
    },
  });

  assert.deepEqual(result, { ok: true, action: 'observed' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, process.execPath);
  assert.deepEqual(calls[0].argv, [
    CLI,
    'checkpoint', 'observe',
    '--checkpoint', fixture.checkpoint.checkpoint_rel,
    '--trigger', 'manual',
    '--owner', fixture.runId,
    '--generation', '1',
    '--runtime', 'claude',
    '--trusted-postcompact-stdin',
    '--json',
    '--project-root', fixture.root,
    '--run-id', fixture.runId,
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'ignore', 'ignore']);
  assert.deepEqual(JSON.parse(calls[0].options.input), {
    cwd: fixture.containedCwd,
    hook_event_name: 'PostCompact',
    trigger: 'manual',
    session_id: rawIdentity,
  });
  assert.equal(calls[0].argv.includes(rawIdentity), false);
  assert.equal(calls[0].argv.includes('restore'), false);
  assert.equal(calls[0].argv.includes('continue'), false);
  assert.equal(JSON.stringify(result).includes(rawIdentity), false);
});

test('PostCompact validates the bounded common payload and canonical contained root before spawn', async () => {
  const fixture = seed('codex');
  const externalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dl-postcompact-external-')));
  const { runPostCompactObserve } = await loadAdapter();
  let spawns = 0;
  const spawnSyncImpl = () => {
    spawns += 1;
    return { status: 0 };
  };
  const invalid = [
    {},
    { cwd: fixture.root, hook_event_name: 'PreCompact', trigger: 'manual' },
    { cwd: fixture.root, hook_event_name: 'PostCompact', trigger: 'scheduled' },
    { cwd: externalRoot, hook_event_name: 'PostCompact', trigger: 'auto' },
    { cwd: '.', hook_event_name: 'PostCompact', trigger: 'manual' },
    { cwd: fixture.root, hook_event_name: 'PostCompact', trigger: 'manual', session_id: '' },
    { cwd: fixture.root, hook_event_name: 'PostCompact', trigger: 'manual', session_id: 42 },
    { cwd: fixture.root, hook_event_name: 'PostCompact', trigger: 'manual', session_id: 'x\n' },
    { cwd: fixture.root, hook_event_name: 'PostCompact', trigger: 'manual', session_id: 'x'.repeat(1025) },
  ];
  for (const input of invalid) {
    const result = runPostCompactObserve(input, { spawnSyncImpl, expectedRoot: fixture.root });
    assert.deepEqual(result, { ok: false, action: 'ignored', reason: 'host-context-invalid' });
  }
  assert.equal(spawns, 0);
});

test('PostCompact main bounds the full host payload separately from its 4096-byte trusted projection', () => {
  assert.equal(existsSync(ADAPTER), true);
  const fixture = seed('claude');
  const payload = {
    cwd: fixture.root,
    hook_event_name: 'PostCompact',
    trigger: 'auto',
    session_id: 'bounded-session',
  };
  const exact = runNode([ADAPTER], {
    cwd: fixture.root,
    input: jsonAtExactBytes(payload, 262144),
  });
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(exact.stdout, '');
  assert.equal(exact.stderr, '');
  assert.equal(existsSync(observationPath(fixture)), true);

  const oversize = runNode([ADAPTER], {
    cwd: fixture.root,
    input: jsonAtExactBytes(payload, 262145),
  });
  assert.equal(oversize.status, 0);
  assert.equal(oversize.stdout, '');
  assert.equal(oversize.stderr, 'deep-loop: postcompact hook failed\n');

  const malformedUtf8 = spawnSync(process.execPath, [ADAPTER], {
    cwd: fixture.root,
    input: Buffer.from([0xc3, 0x28]),
    maxBuffer: 2_097_152,
  });
  assert.equal(malformedUtf8.status, 0);
  assert.equal(malformedUtf8.stdout.toString(), '');
  assert.equal(malformedUtf8.stderr.toString(), 'deep-loop: postcompact hook failed\n');
});

test('exact manifest PostCompact subprocess observes Claude and Codex without identity output', () => {
  const source = bootstrapSource();
  for (const runtime of ['claude', 'codex']) {
    const fixture = seed(runtime);
    const rawIdentity = `${runtime}-raw-host-session`;
    const result = runNode(['-e', source], {
      cwd: fixture.containedCwd,
      env: bootstrapEnv(runtime === 'claude' ? 'CLAUDE_PLUGIN_ROOT' : 'PLUGIN_ROOT'),
      input: JSON.stringify({
        cwd: fixture.containedCwd,
        hook_event_name: 'PostCompact',
        trigger: runtime === 'claude' ? 'manual' : 'auto',
        session_id: rawIdentity,
        transcript_path: '/ignored/by/adapter',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes(rawIdentity), false);
    assert.equal(result.stderr.includes(rawIdentity), false);
    assert.equal(existsSync(observationPath(fixture)), true);
    assert.equal(readFileSync(observationPath(fixture), 'utf8').includes(rawIdentity), false);
  }
});

test('PostCompact child failures are fixed, bounded, and never expose child or host text', async () => {
  const fixture = seed('claude');
  const rawIdentity = 'sensitive-host-session';
  const { runPostCompactObserve } = await loadAdapter();
  const hostInput = {
    cwd: fixture.root,
    hook_event_name: 'PostCompact',
    trigger: 'manual',
    session_id: rawIdentity,
  };
  // Positive control. Everything below asserts how a FAILING observe child is handled,
  // but each mode collapses to `observation-unavailable` when the fixture never reaches
  // the child at all — the assertions then prove nothing about child handling while
  // still looking like an ordinary red. Establish reachability first, and name what
  // refused when it is not reachable, so the failure is diagnosable where it happens
  // rather than only where it can be reproduced.
  let resolution = null;
  let reachedChild = false;
  const control = runPostCompactObserve(hostInput, {
    spawnSyncImpl: () => { reachedChild = true; return { status: 0, stdout: '{}', stderr: '' }; },
    resolveContextFn: (request) => { resolution = resolveRunContext(request); return resolution; },
  });
  assert.equal(reachedChild, true, 'the observe child was never reached — '
    + `result=${JSON.stringify(control)} `
    + `resolver=${JSON.stringify({
      ok: resolution?.ok,
      kind: resolution?.kind,
      reason: resolution?.reason,
      source: resolution?.source,
      matchedWorktree: resolution?.matchedWorktree,
      runId: resolution?.runId,
    })}`);

  for (const spawnSyncImpl of [
    () => ({ status: 1, stdout: rawIdentity, stderr: rawIdentity }),
    () => ({ status: null, signal: 'SIGTERM', stdout: rawIdentity, stderr: rawIdentity }),
    () => { throw new Error(rawIdentity); },
  ]) {
    const result = runPostCompactObserve(hostInput, { spawnSyncImpl });
    assert.deepEqual(result, { ok: false, action: 'failed', reason: 'observe-child-failed' });
    assert.equal(JSON.stringify(result).includes(rawIdentity), false);
  }
});

test('PostCompact bounds run inventory, loop bytes, checkpoint entries, and observe child time', async () => {
  const fixture = seed('claude');
  const adapter = await loadAdapter();
  assert.equal(adapter.MAX_POSTCOMPACT_RUN_ENTRIES, 512);
  assert.equal(adapter.MAX_POSTCOMPACT_RUN_DIRECTORIES, 256);
  assert.equal(adapter.MAX_POSTCOMPACT_CHECKPOINT_ENTRIES, 256);
  assert.equal(adapter.MAX_POSTCOMPACT_LOOP_BYTES, 1024 * 1024);
  assert.equal(adapter.POSTCOMPACT_OBSERVE_TIMEOUT_MS, 5000);

  let calls = 0;
  const spawnSyncImpl = (_bin, _argv, options) => {
    calls += 1;
    assert.equal(options.timeout, adapter.POSTCOMPACT_OBSERVE_TIMEOUT_MS);
    return { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } };
  };
  const timedOut = adapter.runPostCompactObserve({
    cwd: fixture.containedCwd,
    hook_event_name: 'PostCompact',
    trigger: 'auto',
  }, { spawnSyncImpl, expectedRoot: fixture.root });
  assert.deepEqual(timedOut, { ok: false, action: 'failed', reason: 'observe-child-failed' });
  assert.equal(calls, 1);

  const runs = join(fixture.root, '.deep-loop', 'runs');
  for (let index = 0; index < adapter.MAX_POSTCOMPACT_RUN_ENTRIES; index += 1) {
    writeFileSync(join(runs, `junk-${String(index).padStart(3, '0')}`), 'x');
  }
  const tooManyRuns = adapter.runPostCompactObserve({
    cwd: fixture.containedCwd,
    hook_event_name: 'PostCompact',
    trigger: 'auto',
  }, { spawnSyncImpl, expectedRoot: fixture.root });
  assert.deepEqual(tooManyRuns, { ok: false, action: 'ignored', reason: 'observation-unavailable' });
  assert.equal(calls, 1, 'oversized run inventory must fail before spawn');

  const loopFixture = seed('claude');
  const loopPath = join(runDir(loopFixture.root, loopFixture.runId), 'loop.json');
  const loopBytes = readFileSync(loopPath);
  const oversizedValidLoop = Buffer.concat([
    loopBytes,
    Buffer.alloc(adapter.MAX_POSTCOMPACT_LOOP_BYTES + 1 - loopBytes.length, 0x20),
  ]);
  assert.equal(oversizedValidLoop.length, adapter.MAX_POSTCOMPACT_LOOP_BYTES + 1);
  JSON.parse(oversizedValidLoop.toString('utf8'));
  writeFileSync(loopPath, oversizedValidLoop);
  writeFileSync(join(runDir(loopFixture.root, loopFixture.runId), '.loop.hash'), contentHash(oversizedValidLoop));
  const oversizedLoop = adapter.runPostCompactObserve({
    cwd: loopFixture.containedCwd,
    hook_event_name: 'PostCompact',
    trigger: 'auto',
  }, { spawnSyncImpl, expectedRoot: loopFixture.root });
  assert.deepEqual(oversizedLoop, { ok: false, action: 'ignored', reason: 'observation-unavailable' });
  assert.equal(calls, 1, 'oversized loop must fail before spawn');

  const checkpointFixture = seed('claude');
  const checkpointDir = join(runDir(checkpointFixture.root, checkpointFixture.runId), 'checkpoints');
  for (let index = 0; index < adapter.MAX_POSTCOMPACT_CHECKPOINT_ENTRIES; index += 1) {
    writeFileSync(join(checkpointDir, `junk-${String(index).padStart(3, '0')}`), 'x');
  }
  const tooManyCheckpoints = adapter.runPostCompactObserve({
    cwd: checkpointFixture.containedCwd,
    hook_event_name: 'PostCompact',
    trigger: 'auto',
  }, { spawnSyncImpl, expectedRoot: checkpointFixture.root });
  assert.deepEqual(tooManyCheckpoints, { ok: false, action: 'ignored', reason: 'observation-unavailable' });
  assert.equal(calls, 1, 'oversized checkpoint inventory must fail before spawn');
});

test('PostCompact enforces the loop bound inside the verified selection capture', async () => {
  const fixture = seed('claude');
  const adapter = await loadAdapter();
  const loopPath = join(runDir(fixture.root, fixture.runId), 'loop.json');
  let spawns = 0;
  let grew = false;

  const result = adapter.runPostCompactObserve({
    cwd: fixture.containedCwd,
    hook_event_name: 'PostCompact',
    trigger: 'auto',
  }, {
    expectedRoot: fixture.root,
    resolveContextFn(options) {
      const original = readFileSync(loopPath);
      const oversized = Buffer.concat([
        original,
        Buffer.alloc(adapter.MAX_POSTCOMPACT_LOOP_BYTES + 1 - original.length, 0x20),
      ]);
      writeFileSync(loopPath, oversized);
      writeFileSync(join(runDir(fixture.root, fixture.runId), '.loop.hash'), contentHash(oversized));
      grew = true;
      return resolveRunContext(options);
    },
    spawnSyncImpl: () => {
      spawns += 1;
      return { status: 0, signal: null, error: undefined };
    },
  });

  assert.equal(grew, true, 'the race seam must grow loop.json after the prefilter');
  assert.deepEqual(result, {
    ok: false,
    action: 'ignored',
    reason: 'observation-unavailable',
  });
  assert.equal(spawns, 0);
});

test('PostCompact bootstrap stays shell-free and adapter imports no mutation facade', () => {
  const hooks = manifest().hooks;
  assert.equal(hooks.PreCompact[0].hooks[0].command, EXPECTED_PRECOMPACT);
  assert.equal(hooks.SessionStart[0].hooks[0].command, EXPECTED_SESSIONSTART);
  assert.equal(hooks.PostCompact.length, 1);
  assert.equal(hooks.PostCompact[0].matcher, '*');
  assert.equal(hooks.PostCompact[0].hooks.length, 1);
  assert.deepEqual(hooks.PostCompact[0].hooks[0], {
    type: 'command',
    command: EXPECTED_BOOTSTRAP,
  });
  assert.doesNotMatch(EXPECTED_BOOTSTRAP, /bash|\.sh\b|\$\{|\$\(|`/);

  assert.equal(existsSync(ADAPTER), true);
  const source = readFileSync(ADAPTER, 'utf8');
  assert.doesNotMatch(source, /from\s+['"]\.\.\/lib\/(?:checkpoint|integrity|state)\.mjs['"]/);
  assert.doesNotMatch(
    source,
    /['"](?:restore|continue|handoff|respawn)['"]|\b(?:restore|continue|handoff|respawn|modelTurn)\s*\(/i,
  );
});

// ── issue #77: run history must not switch the compact safety net off ──────────────
import { addTerminalHistory, rewriteLoop } from './helpers/run-history.mjs';

test('T12 PostCompact main() observes the active run beside 71 terminal runs, files and run-id-named files', () => {
  const fixture = seed('claude');
  addTerminalHistory(fixture.root);
  const runs = join(fixture.root, '.deep-loop', 'runs');
  writeFileSync(join(runs, '.DS_Store'), 'x');
  writeFileSync(join(runs, '01FILELOOKSLIKEARUNID00000'), 'x');
  const result = runNode(['-e', bootstrapSource()], {
    cwd: fixture.containedCwd,
    env: bootstrapEnv('CLAUDE_PLUGIN_ROOT'),
    input: JSON.stringify({ cwd: fixture.containedCwd, hook_event_name: 'PostCompact', trigger: 'auto' }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(existsSync(observationPath(fixture)), true);
});

test('T14 PostCompact main() does not observe when an active run holds a non-conforming claim', () => {
  const fixture = seed('claude');
  rewriteLoop(fixture.root, fixture.runId, data => {
    data.workstreams[0].worktree = join(fixture.root, data.workstreams[0].worktree);
  });
  const result = runNode(['-e', bootstrapSource()], {
    cwd: fixture.containedCwd,
    env: bootstrapEnv('CLAUDE_PLUGIN_ROOT'),
    input: JSON.stringify({ cwd: fixture.containedCwd, hook_event_name: 'PostCompact', trigger: 'auto' }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, 'deep-loop: postcompact hook failed\n');
  assert.equal(existsSync(observationPath(fixture)), false);
});

test('T12 PostCompact counts run directories, not files: 300 files beside the runs still observe', () => {
  const fixture = seed('claude');
  const runs = join(fixture.root, '.deep-loop', 'runs');
  for (let index = 0; index < 300; index += 1) writeFileSync(join(runs, `note-${index}`), 'x');
  const result = runNode(['-e', bootstrapSource()], {
    cwd: fixture.containedCwd,
    env: bootstrapEnv('CLAUDE_PLUGIN_ROOT'),
    input: JSON.stringify({ cwd: fixture.containedCwd, hook_event_name: 'PostCompact', trigger: 'auto' }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(existsSync(observationPath(fixture)), true);
});
