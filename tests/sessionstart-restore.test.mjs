import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emitCompactCheckpoint,
  emitLegacyCompactCheckpointFromTrustedHook,
} from '../scripts/lib/checkpoint.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { finishRun } from '../scripts/lib/finish.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { advanceHandoffPhase, reserveHandoff } from '../scripts/lib/lease.mjs';
import { pauseRun, readState, runDir, writeState } from '../scripts/lib/state.mjs';
import {
  MAX_COMPACT_CAPSULE_WIRE_BYTES,
  MAX_SESSIONSTART_LOOP_BYTES,
  MAX_SESSIONSTART_RUN_ENTRIES,
  resolveSessionStartProjectRoot,
  runSessionStartRestore,
} from '../scripts/hooks-impl/sessionstart-restore.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { newWorkstream, setWorkstreamStatus } from '../scripts/lib/workspace.mjs';

const PROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESTORE_HOOK = join(PROOT, 'scripts', 'hooks-impl', 'sessionstart-restore.mjs');
const EXPECTED_BOOTSTRAP = `node -e "const{join}=require('node:path');const{pathToFileURL}=require('node:url');const r=process.env.CLAUDE_PLUGIN_ROOT||process.env.PLUGIN_ROOT;if(!r){console.error('deep-loop: plugin root unavailable')}else{import(pathToFileURL(join(r,'scripts','hooks-impl','sessionstart-restore.mjs')).href).then(m=>m.main()).catch(()=>console.error('deep-loop: sessionstart hook failed'))}"`;
const BOOTSTRAP_SOURCE = EXPECTED_BOOTSTRAP.slice('node -e "'.length, -1);
const NOW_MS = Date.parse('2026-07-20T00:00:00.000Z');
const NOW = new Date(NOW_MS);
const noRun = () => ({ code: 1, stdout: '', stderr: '' });

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'dl-sessionstart-'));
}

function initClaude(root, extra = {}) {
  const { continuation = 'compact-in-place', ...currentOptions } = extra;
  const result = initRun(root, {
    runtime: 'claude', goal: 'g', detected: {}, now: NOW, env: {}, platform: 'darwin', run: noRun, pid: 1,
    ...currentOptions,
  });
  const dir = runDir(root, result.runId);
  const loopPath = join(dir, 'loop.json');
  const legacy = JSON.parse(readFileSync(loopPath, 'utf8'));
  legacy.schema_version = '0.3.0';
  delete legacy.project.binding_generation;
  delete legacy.autonomy.attended_launch_approval;
  delete legacy.session_chain.lease.takeover_kind;
  for (const session of legacy.session_chain.sessions) delete session.scope;
  legacy.autonomy.spawn_style = 'visible';
  legacy.autonomy.continuation_policy = continuation;
  legacy.autonomy.milestone_predicate = continuation === 'compact-in-place'
    ? ['workstream_status_change']
    : ['workstream_status_change', 'review_point_passed', 'per_session_turn_cap_reached'];
  const raw = JSON.stringify(legacy, null, 2);
  writeFileSync(loopPath, raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
  return result;
}

function initBound(root, runtime = 'claude', { worktree } = {}) {
  const { runId } = initRun(root, {
    runtime, goal: 'g', detected: {}, now: NOW, env: {}, platform: 'darwin', run: noRun, pid: 1,
  });
  const ownerFence = { owner: runId, generation: 1 };
  const resolvedWorktree = worktree ?? `.claude/worktrees/sessionstart-${runtime}`;
  const workstreamId = newWorkstream(root, runId, {
    title: `sessionstart-${runtime}`,
    branch: `feature/sessionstart-${runtime}`,
    worktree: resolvedWorktree,
    fence: ownerFence,
  }).id;
  setWorkstreamStatus(root, runId, workstreamId, 'in_progress', { fence: ownerFence });
  const episodeId = newEpisode(root, runId, {
    plugin: 'deep-work',
    role: 'maker',
    kind: 'implementation',
    point: 'implementation',
    workstream: workstreamId,
    expectedArtifacts: [],
    fence: ownerFence,
  }).id;
  recordEpisode(root, runId, episodeId, { status: 'in_progress', fence: ownerFence });
  return { root, runId, runtime, fence: ownerFence, workstreamId, episodeId };
}

const restore = root => runSessionStartRestore({
  hook_event_name: 'SessionStart', source: 'compact',
}, { root, now: NOW_MS });
const fence = runId => ({ owner: runId, generation: 1 });
const loopPathOf = (root, runId) => join(runDir(root, runId), 'loop.json');
const hashPathOf = (root, runId) => join(runDir(root, runId), '.loop.hash');

test('worktree A restores only A', () => {
  const root = freshRoot();
  const a = initBound(root, 'claude');
  const b = initBound(root, 'claude');
  emitCompactCheckpoint(root, a.runId, {
    fence: a.fence,
    runtime: 'claude',
    now: NOW_MS,
  });
  const snapshot = readState(root, a.runId);
  const checkpointPath = join(runDir(root, a.runId), 'checkpoints');
  const checkpointName = readdirSync(checkpointPath)[0];
  const bytes = readFileSync(join(checkpointPath, checkpointName));
  const result = runSessionStartRestore({
    hook_event_name: 'SessionStart',
    session_id: 'session-a',
    cwd: join(root, '.claude', 'worktrees', 'a'),
  }, {
    root,
    now: NOW_MS,
    resolveContextFn: () => ({ ok: true, kind: 'selected', runId: a.runId, source: 'worktree', status: 'running', snapshot }),
    captureVerifiedCheckpointSetFn: () => ({
      ok: true,
      snapshot,
      checkpoints: [{ path: join(runDir(root, a.runId), 'checkpoints', checkpointName), bytes }],
    }),
  });
  assert.equal(result.ok, true);
  const capsule = JSON.parse(result.additionalContext);
  assert.equal(capsule.marker, 'deep-loop-compact-capsule-v1');
  assert.equal(capsule.capsule.run_id, a.runId);
  assert.doesNotMatch(result.additionalContext, new RegExp(b.runId));
});

test('prepared A returns null', () => {
  const root = freshRoot();
  const a = initBound(root, 'claude');
  const snapshot = readState(root, a.runId);
  const result = runSessionStartRestore({}, {
    root,
    now: NOW_MS,
    resolveContextFn: () => ({ ok: true, kind: 'selected', runId: a.runId, source: 'explicit', status: 'running', snapshot }),
    captureVerifiedCheckpointSetFn: () => ({ ok: false, kind: 'reconciliation-required', phase: 'run-snapshot' }),
  });
  assert.equal(result.additionalContext, null);
});

test('SessionStart routing diagnostics preserve bounded object-shaped resolver errors', () => {
  const root = freshRoot();
  const errors = Object.freeze({
    alpha: Object.freeze({ kind: 'integrity-invalid' }),
  });
  const result = runSessionStartRestore({}, {
    root,
    resolveContextFn: () => ({
      ok: false,
      kind: 'invalid',
      reason: 'run-set-integrity',
      errors,
      total: 1,
      max_run_ids: 64,
      deadline_ms: 500,
      observed_count: 1,
      total_is_lower_bound: false,
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.additionalContext, null);
  assert.deepEqual(JSON.parse(result.diagnostic), {
    kind: 'invalid', reason: 'run-set-integrity', errors,
    total: 1, max_run_ids: 64, deadline_ms: 500, observed_count: 1,
    total_is_lower_bound: false,
  });
});

test('terminal residue returns null', () => {
  const root = freshRoot();
  const result = runSessionStartRestore({}, {
    root,
    resolveContextFn: () => ({ ok: true, kind: 'none', reason: 'terminal-residue' }),
  });
  assert.equal(result.additionalContext, null);
});

function assertAdvisory(context, runId, generation = 1) {
  assert.ok(context.startsWith('deep-loop lease '), 'lease advisory must be placed first');
  assert.match(context, new RegExp(`owner=${runId} gen=${generation}`));
  assert.match(context, /mutation을 시도하지 말 것/);
}

function stateBytes(root, runId) {
  return [readFileSync(loopPathOf(root, runId), 'utf8'), readFileSync(hashPathOf(root, runId), 'utf8')];
}

function runHook(root, payload) {
  const normalized = payload && typeof payload === 'object' && !Buffer.isBuffer(payload)
    ? { ...payload, ...(payload.cwd === root ? { cwd: realpathSync(root) } : {}) }
    : payload;
  return spawnSync(process.execPath, [RESTORE_HOOK], {
    cwd: root,
    encoding: 'utf8',
    input: typeof normalized === 'string' || Buffer.isBuffer(normalized)
      ? normalized
      : JSON.stringify(normalized),
    maxBuffer: 2_097_152,
  });
}

function runManifestHook(root, payload, runtime = 'claude') {
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.PLUGIN_ROOT;
  env[runtime === 'claude' ? 'CLAUDE_PLUGIN_ROOT' : 'PLUGIN_ROOT'] = PROOT;
  const normalized = payload && typeof payload === 'object'
    ? { ...payload, ...(payload.cwd === root ? { cwd: realpathSync(root) } : {}) }
    : payload;
  return spawnSync(process.execPath, ['-e', BOOTSTRAP_SOURCE], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(normalized),
    env,
    maxBuffer: 2_097_152,
  });
}

test('exact manifest SessionStart injects one bounded canonical prepared capsule for Claude and Codex', () => {
  const manifest = JSON.parse(readFileSync(join(PROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(manifest.hooks.SessionStart[0].hooks[0].command, EXPECTED_BOOTSTRAP);
  for (const [runtime, evidenceProvider, command] of [
    ['claude', 'claude-code', '/deep-loop-compact restore'],
    ['codex', 'codex', '$deep-loop:deep-loop-compact restore'],
  ]) {
    const root = freshRoot();
    const fixture = initBound(root, runtime);
    const evidenceId = `${runtime}-session`;
    const emitted = emitCompactCheckpoint(root, fixture.runId, {
      fence: fixture.fence,
      runtime,
      hostSessionEvidence: { provider: evidenceProvider, id: evidenceId },
      now: NOW_MS + 1,
    });
    const checkpoint = JSON.parse(readFileSync(join(runDir(root, fixture.runId), emitted.checkpoint_rel), 'utf8'));
    const before = stateBytes(root, fixture.runId);
    const beforeState = structuredClone(readState(root, fixture.runId).data);
    const result = runManifestHook(root, {
      cwd: root, hook_event_name: 'SessionStart', source: 'compact', session_id: evidenceId,
    }, runtime);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.ok(Buffer.byteLength(context, 'utf8') <= 2048);
    const wire = JSON.parse(context);
    assert.deepEqual(Object.keys(wire), ['marker', 'version', 'injected_by', 'capsule']);
    assert.equal(wire.marker, 'deep-loop-compact-capsule-v1');
    assert.equal(wire.version, 1);
    assert.equal(wire.injected_by, 'sessionstart');
    assert.deepEqual(wire.capsule, {
      kind: 'deep-loop-compact-capsule',
      phase: 'prepared',
      run_id: fixture.runId,
      checkpoint_key: emitted.checkpoint_key,
      context_sha256: checkpoint.payload.context_sha256,
      pre_restore_loop_hash: checkpoint.payload.context.loop_hash,
      owner_run_id: fixture.runId,
      generation: 1,
      runtime,
      workstream_id: fixture.workstreamId,
      episode_id: fixture.episodeId,
      provider_evidence: { recorded: true, supplied: true, matched: true },
      admission: null,
      restore_event: null,
      restore_command: command,
    });
    assert.equal(context.includes(evidenceId), false);
    assert.equal(context.includes(root), false);
    assert.deepEqual(stateBytes(root, fixture.runId), before);
    assert.deepEqual(readState(root, fixture.runId).data, beforeState);
  }
});

test('strict SessionStart treats other sources as silent and missing provider evidence as valid', () => {
  const otherRoot = freshRoot();
  const other = initBound(otherRoot, 'claude');
  emitCompactCheckpoint(otherRoot, other.runId, {
    fence: other.fence,
    runtime: 'claude',
    now: NOW_MS + 1,
  });
  const otherResult = runManifestHook(otherRoot, {
    cwd: otherRoot,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  assert.equal(otherResult.status, 0, otherResult.stderr);
  assert.equal(otherResult.stdout, '');
  assert.equal(otherResult.stderr, '');

  const missingRoot = freshRoot();
  const missing = initBound(missingRoot, 'codex');
  const emitted = emitCompactCheckpoint(missingRoot, missing.runId, {
    fence: missing.fence,
    runtime: 'codex',
    now: NOW_MS + 1,
  });
  const missingResult = runManifestHook(missingRoot, {
    cwd: missingRoot,
    hook_event_name: 'SessionStart',
    source: 'compact',
    conversation_id: 'ignored',
  }, 'codex');
  assert.equal(missingResult.status, 0, missingResult.stderr);
  assert.equal(missingResult.stderr, '');
  const context = JSON.parse(missingResult.stdout).hookSpecificOutput.additionalContext;
  const capsule = JSON.parse(context).capsule;
  assert.equal(capsule.restore_command, '$deep-loop:deep-loop-compact restore');
  assert.equal(capsule.checkpoint_key, emitted.checkpoint_key);
  assert.deepEqual(capsule.provider_evidence, {
    recorded: false, supplied: false, matched: false,
  });
});

test('strict SessionStart labels supplied evidence unverified when the stored checkpoint has no evidence', () => {
  const root = freshRoot();
  const fixture = initBound(root, 'claude');
  const emitted = emitCompactCheckpoint(root, fixture.runId, {
    fence: fixture.fence,
    runtime: 'claude',
    now: NOW_MS + 1,
  });

  const result = runManifestHook(root, {
    cwd: root,
    hook_event_name: 'SessionStart',
    source: 'compact',
    session_id: 'newly-supplied-session',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  const capsule = JSON.parse(context).capsule;
  assert.equal(capsule.checkpoint_key, emitted.checkpoint_key);
  assert.deepEqual(capsule.provider_evidence, {
    recorded: false, supplied: true, matched: false,
  });
});

test('strict SessionStart trusted-evidence rejection returns null read-only context', () => {
  for (const [runtime, provider, restoreToken, statusToken, oppositeRestore, oppositeStatus] of [
    ['claude', 'claude-code', '/deep-loop-compact restore', '/deep-loop-status',
      '$deep-loop:deep-loop-compact restore', '$deep-loop:deep-loop-status'],
    ['codex', 'codex', '$deep-loop:deep-loop-compact restore', '$deep-loop:deep-loop-status',
      '/deep-loop-compact restore', '/deep-loop-status'],
  ]) {
    const root = freshRoot();
    const fixture = initBound(root, runtime);
    emitCompactCheckpoint(root, fixture.runId, {
      fence: fixture.fence,
      runtime,
      hostSessionEvidence: { provider, id: 'original-host-session' },
      now: NOW_MS + 1,
    });
    const before = stateBytes(root, fixture.runId);
    const beforeState = structuredClone(readState(root, fixture.runId).data);

    const result = runManifestHook(root, {
      cwd: root,
      hook_event_name: 'SessionStart',
      source: 'compact',
      session_id: 'different-host-session',
    }, runtime);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /deep-loop-compact-preserve-pause-only/);
    assert.match(context, /checkpoint-unavailable-with-trusted-evidence/);
    assert.match(context, /provider-evidence-mismatch/);
    assert.match(context, /preserve-pause only/);
    assert.match(context, /host-resume/i);
    assert.ok(context.includes(restoreToken), `${runtime}: missing ${restoreToken}`);
    assert.ok(context.includes(statusToken), `${runtime}: missing ${statusToken}`);
    assert.equal(context.includes(oppositeRestore), false);
    assert.equal(context.includes(oppositeStatus), false);
    assert.doesNotMatch(context, /lease acquire|handoff emit|\brespawn\b|workstream terminal|\bfinish\b/i);
    assert.equal(context.includes(root), false);
    assert.deepEqual(stateBytes(root, fixture.runId), before);
    assert.deepEqual(readState(root, fixture.runId).data, beforeState);
  }
});

test('strict SessionStart evidence-unverified absence returns null until a verified checkpoint exists', () => {
  for (const [runtime, restoreToken, statusToken, oppositeRestore, oppositeStatus] of [
    ['claude', '/deep-loop-compact restore', '/deep-loop-status',
      '$deep-loop:deep-loop-compact restore', '$deep-loop:deep-loop-status'],
    ['codex', '$deep-loop:deep-loop-compact restore', '$deep-loop:deep-loop-status',
      '/deep-loop-compact restore', '/deep-loop-status'],
  ]) {
    const root = freshRoot();
    const fixture = initBound(root, runtime);
    const before = stateBytes(root, fixture.runId);
    const beforeState = structuredClone(readState(root, fixture.runId).data);

    const result = runManifestHook(root, {
      cwd: root,
      hook_event_name: 'SessionStart',
      source: 'compact',
    }, runtime);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /checkpoint-unavailable/);
    assert.doesNotMatch(context, /checkpoint-unavailable-with-trusted-evidence/);
    assert.ok(context.includes(statusToken), `${runtime}: missing ${statusToken}`);
    assert.equal(context.includes(restoreToken), false);
    assert.equal(context.includes(oppositeRestore), false);
    assert.equal(context.includes(oppositeStatus), false);
    assert.equal(context.includes(root), false);
    assert.deepEqual(stateBytes(root, fixture.runId), before);
    assert.deepEqual(readState(root, fixture.runId).data, beforeState);
  }
});

test('strict SessionStart malformed or ambiguous provider evidence fails best-effort without restore context', () => {
  for (const payload of [
    { session_id: '' },
    { session_id: 42 },
    { hook_event_name: 'PreCompact' },
  ]) {
    const root = freshRoot();
    const fixture = initBound(root, 'claude');
    emitCompactCheckpoint(root, fixture.runId, {
      fence: fixture.fence,
      runtime: 'claude',
      now: NOW_MS + 1,
    });
    const before = stateBytes(root, fixture.runId);
    const result = runManifestHook(root, {
      cwd: root,
      hook_event_name: 'SessionStart',
      source: 'compact',
      ...payload,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'deep-loop: sessionstart restore hook failed\n');
    assert.deepEqual(stateBytes(root, fixture.runId), before);
  }
});

test('workstream SessionStart uses one inspector result, never rereads checkpoint bytes, and fails closed on wire cap', () => {
  const root = freshRoot();
  const fixture = initBound(root);
  let calls = 0;
  const projection = {
    ok: true,
    phase: 'prepared',
    reason: null,
    checkpoint_rel: `checkpoints/${'a'.repeat(64)}-compact.json`,
    checkpoint_key: 'a'.repeat(64),
    context_sha256: 'b'.repeat(64),
    pre_restore_loop_hash: 'c'.repeat(64),
    owner_run_id: fixture.runId,
    generation: 1,
    runtime: 'claude',
    workstream_id: fixture.workstreamId,
    episode_id: fixture.episodeId,
    trigger: null,
    cycle: null,
    admission: null,
    restore_event: null,
    next_command: '/deep-loop-compact restore',
    requires_model_turn: true,
    replay: 'eligible',
    provider_evidence: { recorded: false, supplied: false, matched: false },
  };
  const result = runSessionStartRestore({ hook_event_name: 'SessionStart', source: 'compact' }, {
    root,
    now: NOW_MS,
    inspectCompact: () => { calls += 1; return projection; },
    readCheckpoint: () => { throw new Error('checkpoint-reread'); },
  });
  assert.equal(calls, 1);
  assert.equal(result.branch, 'prepared');
  assert.ok(Buffer.byteLength(result.additionalContext, 'utf8') <= MAX_COMPACT_CAPSULE_WIRE_BYTES);

  const oversized = runSessionStartRestore({ hook_event_name: 'SessionStart', source: 'compact' }, {
    root,
    inspectCompact: () => ({ ...projection, owner_run_id: 'x'.repeat(3000) }),
  });
  assert.deepEqual(oversized, {
    ok: true, branch: 'capsule-unavailable', additionalContext: null,
  });
  const restored = runSessionStartRestore({ hook_event_name: 'SessionStart', source: 'compact' }, {
    root,
    inspectCompact: () => ({ ...projection, phase: 'restored', requires_model_turn: false }),
  });
  assert.deepEqual(restored, { ok: true, branch: 'restored', additionalContext: null });
});

test('SessionStart root mapping accepts only canonical base or contained worktree paths', () => {
  const root = freshRoot();
  initBound(root);
  const base = realpathSync(root);
  const nested = join(base, '.claude', 'worktrees', 'root-map', 'src');
  mkdirSync(nested, { recursive: true });
  assert.equal(resolveSessionStartProjectRoot(base, { expectedRoot: base }), base);
  assert.equal(resolveSessionStartProjectRoot(nested, { expectedRoot: base }), base);
  const nestedPlain = join(base, '.worktrees', 'root-map', 'src');
  mkdirSync(nestedPlain, { recursive: true });
  assert.equal(resolveSessionStartProjectRoot(nestedPlain, { expectedRoot: base }), base);
  assert.equal(resolveSessionStartProjectRoot(`${nested}/..`, { expectedRoot: base }), null);

  const external = realpathSync(freshRoot());
  assert.equal(resolveSessionStartProjectRoot(external, { expectedRoot: base }), null);
  mkdirSync(join(nested, '.deep-loop'), { recursive: true });
  writeFileSync(join(nested, '.deep-loop', 'current'), 'nested\n');
  assert.equal(resolveSessionStartProjectRoot(nested, { expectedRoot: base }), null);
});

test('SessionStart resolves the unique cwd-bound run and fails closed on project-wide ambiguity', () => {
  const root = freshRoot();
  const first = initBound(root, 'claude');
  const second = initBound(root, 'codex');
  const firstCwd = join(root, '.claude', 'worktrees', 'sessionstart-claude', 'src');
  const secondCwd = join(root, '.claude', 'worktrees', 'sessionstart-codex', 'src');
  mkdirSync(firstCwd, { recursive: true });
  mkdirSync(secondCwd, { recursive: true });
  assert.equal(readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim(), second.runId);

  const selected = [];
  const inspectCompact = (_root, runId) => {
    selected.push(runId);
    return { ok: false, reason: 'checkpoint-not-found' };
  };
  const bound = runSessionStartRestore({
    hook_event_name: 'SessionStart',
    source: 'compact',
  }, { root, cwd: firstCwd, now: NOW_MS, inspectCompact });
  assert.equal(bound.branch, 'no-checkpoint');
  assert.deepEqual(selected, [first.runId],
    'a newer project-wide current run must not steal the originating worktree SessionStart');

  selected.length = 0;
  const ambiguous = runSessionStartRestore({
    hook_event_name: 'SessionStart',
    source: 'compact',
  }, { root, cwd: root, now: NOW_MS, inspectCompact });
  assert.equal(ambiguous.ok, true);
  assert.equal(ambiguous.branch, 'multi-active-root-cwd');
  assert.equal(ambiguous.additionalContext, null);
  assert.equal(JSON.parse(ambiguous.diagnostic).reason, 'multi-active-root-cwd');
  assert.deepEqual(selected, [], 'ambiguous base-root SessionStart must not inspect either run');
});

test('SessionStart resolves a unique cwd-bound run from .worktrees convention', () => {
  const root = freshRoot();
  const first = initBound(root, 'claude', { worktree: '.worktrees/sessionstart-claude' });
  const second = initBound(root, 'codex', { worktree: '.worktrees/sessionstart-codex' });
  const firstCwd = join(root, '.worktrees', 'sessionstart-claude', 'src');
  const secondCwd = join(root, '.worktrees', 'sessionstart-codex', 'src');
  mkdirSync(firstCwd, { recursive: true });
  mkdirSync(secondCwd, { recursive: true });
  assert.equal(readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim(), second.runId);

  const selected = [];
  const inspectCompact = (_root, runId) => {
    selected.push(runId);
    return { ok: false, reason: 'checkpoint-not-found' };
  };
  const bound = runSessionStartRestore({
    hook_event_name: 'SessionStart',
    source: 'compact',
  }, { root, cwd: firstCwd, now: NOW_MS, inspectCompact });
  assert.equal(bound.branch, 'no-checkpoint');
  assert.deepEqual(selected, [first.runId],
    'a newer project-wide current run must not steal the originating .worktrees SessionStart');

  selected.length = 0;
  const ambiguous = runSessionStartRestore({
    hook_event_name: 'SessionStart',
    source: 'compact',
  }, { root, cwd: root, now: NOW_MS, inspectCompact });
  assert.equal(ambiguous.ok, true);
  assert.equal(ambiguous.branch, 'multi-active-root-cwd');
  assert.equal(ambiguous.additionalContext, null);
  assert.equal(JSON.parse(ambiguous.diagnostic).reason, 'multi-active-root-cwd');
  assert.deepEqual(selected, [], 'ambiguous base-root SessionStart must not inspect either run');
});

test('SessionStart uses verified run routing despite unrelated inventory and fails closed on oversized loop state', () => {
  assert.equal(MAX_SESSIONSTART_RUN_ENTRIES, 256);
  assert.equal(MAX_SESSIONSTART_LOOP_BYTES, 1024 * 1024);
  let inspections = 0;
  const inspectCompact = () => {
    inspections += 1;
    return { ok: false, reason: 'checkpoint-not-found' };
  };

  const inventoryRoot = freshRoot();
  initBound(inventoryRoot);
  const runs = join(inventoryRoot, '.deep-loop', 'runs');
  for (let index = 0; index < MAX_SESSIONSTART_RUN_ENTRIES; index += 1) {
    writeFileSync(join(runs, `junk-${String(index).padStart(3, '0')}`), 'x');
  }
  const inventory = runSessionStartRestore({
    hook_event_name: 'SessionStart', source: 'compact',
  }, { root: inventoryRoot, inspectCompact });
  assert.equal(inventory.ok, true);
  assert.equal(inventory.branch, 'no-checkpoint');
  assert.equal(inspections, 1);

  const loopRoot = freshRoot();
  const { runId } = initBound(loopRoot);
  writeFileSync(loopPathOf(loopRoot, runId), ' '.repeat(MAX_SESSIONSTART_LOOP_BYTES + 1));
  const oversized = runSessionStartRestore({
    hook_event_name: 'SessionStart', source: 'compact',
  }, { root: loopRoot, inspectCompact });
  assert.equal(oversized.ok, true);
  assert.equal(oversized.branch, 'unreadable');
  assert.equal(oversized.additionalContext, null);
  assert.equal(JSON.parse(oversized.diagnostic).reason, 'run-set-integrity');
  assert.equal(inspections, 1);
});

test('no run / terminal / paused → no injection', () => {
  const noRunRoot = freshRoot();
  assert.deepEqual(restore(noRunRoot), { ok: true, branch: 'no-run', additionalContext: null });

  const pausedRoot = freshRoot();
  const { runId: pausedRunId } = initClaude(pausedRoot);
  pauseRun(pausedRoot, pausedRunId, {
    reason: 'test', mode: 'preserve', expect: fence(pausedRunId), now: NOW_MS + 1,
  });
  assert.deepEqual(restore(pausedRoot), { ok: true, branch: 'terminal-or-paused', additionalContext: null });

  const stoppedRoot = freshRoot();
  const { runId: stoppedRunId } = initClaude(stoppedRoot);
  finishRun(stoppedRoot, stoppedRunId, {
    status: 'stopped', proof: { human_reason: 'test' }, confirm: true,
    fence: fence(stoppedRunId), now: NOW_MS + 1,
  });
  assert.deepEqual(restore(stoppedRoot), { ok: true, branch: 'terminal-residue', additionalContext: null });
});

test('corrupt unattributable loop.json → unreadable with bounded diagnostic', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  writeFileSync(loopPathOf(root, runId), '{');

  const result = restore(root);
  assert.equal(result.ok, true);
  assert.equal(result.branch, 'unreadable');
  assert.equal(result.additionalContext, null);
  assert.equal(JSON.parse(result.diagnostic).reason, 'run-set-integrity');
});

test('bare reserved(active) → recovery capsule, not resume', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  reserveHandoff(root, runId, { trigger: 'milestone', expect: fence(runId), now: NOW_MS + 1 });

  const r = restore(root);

  assert.equal(r.branch, 'reserved-recovery');
  assert.match(r.additionalContext, /reserved-finalization|deep-loop-status/);
  assert.doesNotMatch(r.additionalContext, /새 세션.*resume하라/);
  assertAdvisory(r.additionalContext, runId);
});

test('emitted/releasing with child → rotation capsule with owner advisory', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const emitted = emitHandoff(root, runId, {
    reason: 'milestone', trigger: 'milestone', headless: false,
    expect: fence(runId), env: {}, now: NOW_MS + 1,
  });

  const r = restore(root);

  assert.equal(r.branch, 'rotation');
  assert.match(r.additionalContext, new RegExp(emitted.childRunId));
  assert.match(r.additionalContext, /새 세션/);
  assertAdvisory(r.additionalContext, runId);
});

test('spawned/releasing with child → rotation capsule after emitted→spawned transition', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const emitted = emitHandoff(root, runId, {
    reason: 'milestone', trigger: 'milestone', headless: false,
    expect: fence(runId), env: {}, now: NOW_MS + 1,
  });
  advanceHandoffPhase(root, runId, {
    key: emitted.key,
    toPhase: 'spawned',
    expect: fence(runId),
    now: NOW_MS + 2,
  });

  const r = restore(root);

  assert.equal(r.branch, 'rotation');
  assert.match(r.additionalContext, new RegExp(emitted.childRunId));
  assertAdvisory(r.additionalContext, runId);
});

test('rotate-per-unit + idle → retry-guidance capsule without nonexistent-handoff claim', () => {
  const root = freshRoot();
  const { runId } = initClaude(root, { continuation: 'rotate-per-unit' });

  const r = restore(root);

  assert.equal(r.branch, 'rotate-retry');
  assert.match(r.additionalContext, /handoff 미-emit|emission을 수행/);
  assert.doesNotMatch(r.additionalContext, /reserved child.*resume하라/);
  assertAdvisory(r.additionalContext, runId);
});

test('compact-in-place + matching checkpoint → resume capsule ≤3KB(bytes) with run/ws/episode', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS + 1 });

  const r = restore(root);

  assert.equal(r.branch, 'resume');
  assert.ok(Buffer.byteLength(r.additionalContext, 'utf8') <= 3072);
  assert.match(r.additionalContext, new RegExp(runId));
  assert.match(r.additionalContext, /ws=/);
  assert.match(r.additionalContext, /episode=/);
  assertAdvisory(r.additionalContext, runId);
});

test('migrated compact-in-place ignores workstream-only host identity validation', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS + 1 });

  const restored = runSessionStartRestore({
    hook_event_name: 'SessionStart',
    source: 'compact',
    session_id: 42,
  }, { root, now: NOW_MS });

  assert.equal(restored.ok, true);
  assert.equal(restored.branch, 'resume');
  assertAdvisory(restored.additionalContext, runId);
});

test('UTF-8 clamp preserves code points and the owner advisory within 3072 bytes', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    expectedArtifacts: [`아티팩트-${'한'.repeat(2_000)}`], fence: fence(runId), now: NOW_MS + 1,
  });
  emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS + 2 });

  const r = restore(root);

  assert.equal(r.branch, 'resume');
  assert.ok(Buffer.byteLength(r.additionalContext, 'utf8') <= 3072);
  assert.doesNotMatch(r.additionalContext, /\uFFFD/);
  assert.match(r.additionalContext, /\.\.\.$/);
  assertAdvisory(r.additionalContext, runId);
});

test('stale legacy checkpoint is integrity-invalid without live fallback', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS + 1 });
  const { data } = readState(root, runId);
  data.discovered_items.push({ note: 'advance state revision' });
  writeState(root, runId, data);

  const r = restore(root);

  assert.equal(r.branch, 'integrity-invalid');
  assert.equal(r.additionalContext, null);
});

test('checkpoint parse failure after selection → no-checkpoint with advisory', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const checkpoint = emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS + 1 });

  const r = runSessionStartRestore({ hook_event_name: 'SessionStart', source: 'compact' }, {
    root,
    now: NOW_MS,
    captureVerifiedCheckpointSetFn: ({ snapshot }) => ({
      ok: true,
      snapshot,
      checkpoints: [{ path: checkpoint.path, bytes: Buffer.from('{') }],
    }),
  });

  assert.equal(r.branch, 'no-checkpoint');
  assert.match(r.additionalContext, /deep-loop-status/);
  assertAdvisory(r.additionalContext, runId);
});

test('read-only: loop.json/.loop.hash bytes remain unchanged across capsule branches', () => {
  const fixtures = [];

  {
    const root = freshRoot(); const { runId } = initClaude(root);
    reserveHandoff(root, runId, { trigger: 'milestone', expect: fence(runId), now: NOW_MS + 1 });
    fixtures.push({ root, runId, branch: 'reserved-recovery' });
  }
  {
    const root = freshRoot(); const { runId } = initClaude(root);
    emitHandoff(root, runId, {
      reason: 'milestone', trigger: 'milestone', headless: false,
      expect: fence(runId), env: {}, now: NOW_MS + 1,
    });
    fixtures.push({ root, runId, branch: 'rotation' });
  }
  {
    const root = freshRoot(); const { runId } = initClaude(root, { continuation: 'rotate-per-unit' });
    fixtures.push({ root, runId, branch: 'rotate-retry' });
  }
  {
    const root = freshRoot(); const { runId } = initClaude(root);
    emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS + 1 });
    fixtures.push({ root, runId, branch: 'resume' });
  }
  {
    const root = freshRoot(); const { runId } = initClaude(root);
    fixtures.push({ root, runId, branch: 'no-checkpoint' });
  }

  for (const { root, runId, branch } of fixtures) {
    const before = stateBytes(root, runId);
    assert.equal(restore(root).branch, branch);
    assert.deepEqual(stateBytes(root, runId), before, `${branch} must not mutate durable state`);
  }
});

test('hooks.json registers SessionStart(compact) with the static shell-free bootstrap', () => {
  const manifest = JSON.parse(readFileSync(join(PROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(manifest.hooks.SessionStart.length, 1);
  assert.equal(manifest.hooks.SessionStart[0].matcher, 'compact');
  assert.equal(manifest.hooks.SessionStart[0].hooks.length, 1);
  const command = manifest.hooks.SessionStart[0].hooks[0].command;
  assert.equal(command, EXPECTED_BOOTSTRAP);
  assert.doesNotMatch(command, /bash|\.sh\b|\$\{|\$\(|`/);
});

test('Claude and Codex compact payloads receive identical additionalContext JSON', () => {
  const root = freshRoot();
  initClaude(root);
  const currentRunId = readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim();
  emitLegacyCompactCheckpointFromTrustedHook(root, currentRunId, { now: NOW_MS + 1 });
  const claude = runHook(root, { cwd: root, hook_event_name: 'SessionStart', source: 'compact', session_id: 'claude-session' });
  const codex = runHook(root, { cwd: root, hook_event_name: 'SessionStart', source: 'compact', conversation_id: 'codex-conversation' });

  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(claude.stderr, '');
  assert.equal(codex.stderr, '');
  assert.deepEqual(JSON.parse(claude.stdout), JSON.parse(codex.stdout));
  const output = JSON.parse(codex.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(typeof output.hookSpecificOutput.additionalContext, 'string');
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(currentRunId));
});

test('oversize and non-JSON stdin exit zero without injecting context', () => {
  const root = freshRoot();
  const oversized = Buffer.concat([Buffer.from('{}'), Buffer.alloc(1_048_577, 0x20)]);
  for (const input of [oversized, '{']) {
    const result = runHook(root, input);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'deep-loop: sessionstart restore hook failed\n');
  }
});

// ── issue #77: run history must not switch the compact safety net off ──────────────
import { addTerminalHistory, rewriteLoop } from './helpers/run-history.mjs';
import { resolveRunContext as resolveRunContextForTest } from '../scripts/lib/run-context.mjs';

test('T13 SessionStart main() restores the active run beside 71 terminal runs and a legacy absolute claim', () => {
  const root = freshRoot();
  const fixture = initBound(root, 'claude');
  addTerminalHistory(root);
  const emitted = emitCompactCheckpoint(root, fixture.runId, { fence: fixture.fence, runtime: 'claude', now: NOW_MS + 1 });
  const result = runManifestHook(root, {
    cwd: root, hook_event_name: 'SessionStart', source: 'compact', session_id: 'history-session',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const capsule = JSON.parse(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).capsule;
  assert.equal(capsule.run_id, fixture.runId);
  assert.equal(capsule.checkpoint_key, emitted.checkpoint_key);
});

test('T13 SessionStart names an invalid active claim as its branch and carries the diagnostic', () => {
  const root = freshRoot();
  const fixture = initBound(root, 'claude');
  rewriteLoop(root, fixture.runId, data => {
    data.workstreams[0].worktree = join(root, data.workstreams[0].worktree);
  });
  const seen = [];
  const result = runSessionStartRestore({ hook_event_name: 'SessionStart', source: 'compact' }, {
    root,
    now: NOW_MS,
    resolveContextFn: options => {
      seen.push(options);
      return resolveRunContextForTest(options);
    },
  });
  assert.equal(result.branch, 'invalid-worktree-claim');
  assert.match(result.diagnostic, /invalid-worktree-claim/);
  assert.equal(result.additionalContext, null);
  assert.equal(seen[0].nowFn, undefined, 'the business now is not the deadline clock');
});
