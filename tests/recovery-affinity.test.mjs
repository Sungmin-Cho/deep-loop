import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash, unwrap } from '../scripts/lib/envelope.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { recordReviewOutcome } from '../scripts/lib/review.mjs';
import {
  captureReconciledRunSnapshot,
  pauseRun,
  readState,
  runDir,
  writeState,
} from '../scripts/lib/state.mjs';
import { appendAnchored, readLines } from '../scripts/lib/integrity.mjs';
import {
  acquireLease,
  advanceHandoffPhase,
  releaseLease,
  reserveHandoff,
  rollbackHandoff,
  rollbackReservedEmit,
} from '../scripts/lib/lease.mjs';
import {
  acquireRecovery,
  recoverBoundary,
  recoverRun,
  supersedeAffinity,
} from '../scripts/lib/recover.mjs';
import { extendBudget } from '../scripts/lib/budget.mjs';
import { resetBreaker, tripBreaker } from '../scripts/lib/breaker.mjs';
import { projectRootDigest } from '../scripts/lib/project-root.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'scripts', 'deep-loop.mjs');
const STATE_MODULE_URL = new URL('../scripts/lib/state.mjs', import.meta.url).href;
const NOW = Date.parse('2026-07-23T00:00:00.000Z');

function historicalCursor(owner, workstreamId, episodeId) {
  return {
    checkpoint_key: 'a'.repeat(64), context_sha256: 'b'.repeat(64),
    pre_restore_loop_hash: 'c'.repeat(64), owner_run_id: owner, generation: 1,
    runtime: 'claude', workstream_id: workstreamId, episode_id: episodeId,
    baseline_turns: 7, restored_at: '2026-07-23T00:00:00.000Z', cycle: 1,
    restore_event: { seq: 1, checksum: 'd'.repeat(64) },
    admission: { kind: 'human-attested', source: 'direct-human-skill', receipt_trigger: null },
    provider_evidence: { recorded: false, supplied: false, matched: false },
  };
}

// spec §3.1 의 계약 3필드(proceed/consumed/replayed)는 모든 acquire 반환 객체에 존재한다. 성공 응답의
// `consumed` 는 실행마다 달라지는 식별자를 담으므로, 기존 형태 assertion 은 관심 필드 부분 비교로 바꾸고
// 계약 필드는 별도로 고정한다 — spec §3.2 노트 3 의 갱신 방침.
function withoutContractFields(result) {
  const { proceed: _proceed, consumed: _consumed, replayed: _replayed, ...rest } = result;
  return rest;
}

function assertProceeded(result, { takeoverKind }) {
  assert.equal(result.proceed, true);
  assert.equal(result.replayed, false);
  assert.equal(result.consumed?.takeover_kind, takeoverKind);
}

function openAffinityFixture(runtime = 'claude', episodePhase = 'maker-in-progress') {
  const root = mkdtempSync(join(tmpdir(), 'dl-recovery-affinity-'));
  const { runId } = initRun(root, {
    runtime,
    goal: 'recover one lost workstream affinity',
    now: new Date(NOW),
    detected: {},
    env: {},
    platform: process.platform,
    run: () => ({ code: 1 }),
  });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const { id: workstreamId } = newWorkstream(root, runId, {
    title: 'lost host workstream',
    branch: 'feature/lost-host-workstream',
    worktree: '.worktrees/lost-host-workstream',
    fence,
  });
  const artifact = '.worktrees/lost-host-workstream/recovery-artifact.txt';
  mkdirSync(join(root, '.worktrees/lost-host-workstream'), { recursive: true });
  writeFileSync(join(root, artifact), 'recovery proof');
  const { id: makerId } = newEpisode(root, runId, {
    plugin: 'deep-work',
    role: 'maker',
    kind: 'implementation',
    point: 'implementation',
    workstream: workstreamId,
    expectedArtifacts: [artifact],
    fence,
  });
  recordEpisode(root, runId, makerId, {
    status: 'in_progress',
    fence,
  });
  if (episodePhase !== 'maker-in-progress') {
    recordEpisode(root, runId, makerId, {
      status: 'done',
      artifacts: [artifact],
      proof: {},
      fence,
    });
    const { id: checkerId } = newEpisode(root, runId, {
      plugin: 'deep-review',
      role: 'checker',
      kind: 'implementation-review',
      point: 'implementation',
      workstream: workstreamId,
      targetMaker: makerId,
      fence,
    });
    if (episodePhase === 'checker-in-progress') {
      recordEpisode(root, runId, checkerId, { status: 'in_progress', fence });
    } else if (episodePhase === 'checker-blocked') {
      recordEpisode(root, runId, checkerId, { status: 'blocked', fence });
    } else if (episodePhase === 'checker-rejected') {
      recordReviewOutcome(root, runId, {
        episodeId: checkerId,
        verdict: 'REQUEST_CHANGES',
        fence,
      });
      assert.equal(
        readState(root, runId).data.episodes.find(e => e.id === checkerId).review_source,
        'recorded-path',
      );
    }
  }
  pauseRun(root, runId, {
    reason: 'host-session-lost',
    mode: 'preserve',
    expect: { owner: runId, generation: 1 },
    now: NOW + 1_000,
  });
  const state = readState(root, runId).data;
  state.budget.max_wallclock_sec = 0;
  writeState(root, runId, state);
  return { root, runId, workstreamId, makerId };
}

function invoke(root, runId, args) {
  return spawnSync(process.execPath, [
    CLI,
    ...args,
    '--project-root', root,
    '--run-id', runId,
    '--now', '2026-07-23T00:00:02.000Z',
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function invokeReadOnly(root, runId, args) {
  return spawnSync(process.execPath, [
    CLI,
    ...args,
    '--project-root', root,
    '--run-id', runId,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function invokeWithoutNow(root, runId, args) {
  return spawnSync(process.execPath, [
    CLI,
    ...args,
    '--project-root', root,
    '--run-id', runId,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function invokeAt(root, runId, args, now) {
  return spawnSync(process.execPath, [
    CLI,
    ...args,
    '--project-root', root,
    '--run-id', runId,
    '--now', new Date(now).toISOString(),
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function durableBytes(root, runId) {
  const dir = runDir(root, runId);
  const eventPath = join(dir, 'event-log.jsonl');
  return {
    loop: readFileSync(join(dir, 'loop.json')),
    hash: readFileSync(join(dir, '.loop.hash')),
    events: existsSync(eventPath) ? readFileSync(eventPath) : null,
  };
}

function durableRecoveryBytes(root, runId) {
  const recoveries = join(runDir(root, runId), 'recoveries');
  return {
    ...durableBytes(root, runId),
    recoveries: existsSync(recoveries)
      ? readdirSync(recoveries).sort().map(name => ({
        name,
        bytes: readFileSync(join(recoveries, name)),
      }))
      : [],
  };
}

function armRealWallclock(root, runId, maxWallclockSec = 0.2) {
  const startedAt = Date.now();
  const state = readState(root, runId).data;
  state.created_at = new Date(startedAt).toISOString();
  state.budget.max_wallclock_sec = maxWallclockSec;
  writeState(root, runId, state);
  return startedAt;
}

async function stalePreCapNowAfterExpiry(root, runId) {
  const startedAt = armRealWallclock(root, runId, 0.05);
  await new Promise(resolve => setTimeout(resolve, 140));
  return startedAt + 10;
}

async function whileRunLockIsHeld(root, runId, callback, holdMs = 350) {
  const script = `
    import { withLock } from ${JSON.stringify(STATE_MODULE_URL)};
    const [root, runId, holdMs] = process.argv.slice(1);
    withLock(root, runId, () => {
      process.stdout.write('LOCKED\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
    });
  `;
  const holder = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    script,
    root,
    runId,
    String(holdMs),
  ], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  holder.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    let stdout = '';
    holder.once('error', reject);
    holder.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('LOCKED\n')) resolve();
    });
    holder.once('exit', code => {
      if (!stdout.includes('LOCKED\n')) {
        reject(new Error(`lock holder exited ${code}: ${stderr}`));
      }
    });
  });
  let result;
  try {
    result = callback();
  } finally {
    if (holder.exitCode === null) {
      const [code] = await once(holder, 'exit');
      assert.equal(code, 0, stderr);
    } else {
      assert.equal(holder.exitCode, 0, stderr);
    }
  }
  return result;
}

function commandArgs(invocation) {
  return invocation.match(/"(?:[^"\\]|\\.)*"|\S+/g).map(token => (
    token.startsWith('"') ? JSON.parse(token) : token
  ));
}

function executeReturnedCommand(invocation) {
  return spawnSync(process.execPath, [CLI, ...commandArgs(invocation)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function openScopes(loop) {
  return loop.session_chain.sessions.filter(session => (
    session.scope?.kind === 'workstream'
    && session.scope.terminal_event === null
    && session.scope.superseded_at === null
  ));
}

function boundaryFixture(phase) {
  const root = mkdtempSync(join(tmpdir(), `dl-boundary-${phase}-`));
  const { runId } = initRun(root, {
    runtime: 'claude',
    goal: `recover ${phase} boundary`,
    now: new Date(NOW),
    detected: {},
    env: {},
    platform: process.platform,
    run: () => ({ code: 1 }),
  });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const { id: workstreamId } = newWorkstream(root, runId, {
    title: `${phase} boundary`,
    branch: `feature/${phase}-boundary`,
    worktree: `.worktrees/${phase}-boundary`,
    fence,
  });
  const { id: makerId } = newEpisode(root, runId, {
    plugin: 'deep-work',
    role: 'maker',
    kind: 'implementation',
    point: 'implementation',
    workstream: workstreamId,
    expectedArtifacts: [],
    fence,
  });
  recordEpisode(root, runId, makerId, { status: 'in_progress', fence });
  let boundaryEvent;
  appendAnchored(root, runId, {
    type: 'workstream-status',
    data: { id: workstreamId, status: 'ready' },
    now: '2026-07-23T00:00:01.000Z',
  }, (loop, _spent, tx) => {
    boundaryEvent = { ...tx.event_identity };
    const workstream = loop.workstreams.find(item => item.id === workstreamId);
    workstream.status = 'ready';
    workstream.terminal_events = [{ ...boundaryEvent }];
    loop.active_workstreams = loop.active_workstreams.filter(id => id !== workstreamId);
    const parent = loop.session_chain.sessions.find(session => session.run_id === runId);
    parent.scope.terminal_event = { ...boundaryEvent };
    parent.scope.closed_at = '2026-07-23T00:00:01.000Z';
  });
  pauseRun(root, runId, {
    reason: 'boundary-host-lost',
    mode: 'preserve',
    expect: { owner: runId, generation: 1 },
    now: NOW + 2_000,
  });

  const state = readState(root, runId).data;
  const parent = state.session_chain.sessions.find(session => session.run_id === runId);
  const staleSessionId = `STALE-${phase.toUpperCase()}`;
  const rootDigest = projectRootDigest(state.project.root);
  const stale = {
    run_id: staleSessionId,
    started_at: null,
    ended_at: null,
    turns: 0,
    outcome: null,
    superseded_by: null,
    parent_run_id: runId,
    parent_boundary_event: { ...boundaryEvent },
    project_binding_generation: state.project.binding_generation,
    project_root_digest: rootDigest,
    handoff_rel: `handoffs/${staleSessionId}-next-session.md`,
    scope: {
      kind: 'workstream',
      workstream_id: null,
      bound_at_seq: null,
      terminal_event: null,
      closed_at: null,
      superseded_at: null,
    },
  };
  const lease = state.session_chain.lease;
  lease.handoff_phase = phase;
  lease.handoff_idempotency_key = 'b'.repeat(64);
  lease.handoff_child_run_id = staleSessionId;
  lease.handoff_trigger = 'workstream-terminal';
  lease.handoff_boundary_event = { ...boundaryEvent };
  lease.handoff_project_binding_generation = state.project.binding_generation;
  lease.handoff_project_root_digest = rootDigest;
  if (phase === 'reserved') {
    lease.state = 'active';
    lease.takeover_kind = null;
    lease.expires_at = null;
  } else if (phase === 'emitted' || phase === 'spawned') {
    lease.state = 'releasing';
    lease.takeover_kind = 'boundary-handoff';
    lease.expires_at = '2026-07-23T00:15:02.000Z';
    parent.superseded_by = staleSessionId;
    parent.scope.superseded_at = '2026-07-23T00:00:02.000Z';
    state.session_chain.sessions.push(stale);
  } else if (phase === 'acquired') {
    stale.started_at = '2026-07-23T00:00:03.000Z';
    state.session_chain.sessions.push(stale);
    parent.superseded_by = staleSessionId;
    parent.scope.superseded_at = '2026-07-23T00:00:02.000Z';
    lease.owner_run_id = staleSessionId;
    lease.generation = 2;
    lease.state = 'active';
    lease.handoff_phase = 'acquired';
    lease.handoff_idempotency_key = null;
    lease.handoff_child_run_id = null;
    lease.handoff_trigger = null;
    lease.takeover_kind = null;
    lease.expires_at = null;
    delete lease.handoff_boundary_event;
    delete lease.handoff_project_binding_generation;
    delete lease.handoff_project_root_digest;
  } else {
    throw new Error(`unknown boundary phase ${phase}`);
  }
  state.budget.max_wallclock_sec = 0;
  writeState(root, runId, state);
  return {
    root,
    runId,
    workstreamId,
    boundaryEvent,
    staleSessionId,
    expect: {
      owner: phase === 'acquired' ? staleSessionId : runId,
      generation: phase === 'acquired' ? 2 : 1,
    },
  };
}

test('ordinary recover rejects an open workstream affinity without changing durable bytes', () => {
  const { root, runId } = openAffinityFixture();
  const before = durableBytes(root, runId);

  const result = invoke(root, runId, [
    'recover',
    '--confirm',
    '--owner', runId,
    '--generation', '1',
  ]);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /AFFINITY_SUPERSESSION_REQUIRED/);
  assert.deepEqual(durableBytes(root, runId), before);
});

test('ordinary new-policy recovery without a stale closed boundary never falls back to legacy release', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-recovery-no-boundary-'));
  const { runId } = initRun(root, {
    runtime: 'claude',
    goal: 'no legacy fallback',
    now: new Date(NOW),
  });
  pauseRun(root, runId, {
    reason: 'operator-pause',
    mode: 'preserve',
    expect: { owner: runId, generation: 1 },
    now: NOW + 1_000,
  });
  const before = durableBytes(root, runId);
  assert.throws(() => recoverRun(root, runId, {
    confirm: true,
    expect: { owner: runId, generation: 1 },
    now: NOW + 2_000,
  }), /BOUNDARY_RECOVERY_PHASE_INVALID/);
  assert.deepEqual(durableBytes(root, runId), before);
});

test('confirmed lost-host supersession reserves one child with the transferred affinity', () => {
  const { root, runId, workstreamId } = openAffinityFixture();
  const seeded = readState(root, runId).data;
  seeded.session_chain.sessions[0].compact_cursor = historicalCursor(
    runId, workstreamId, seeded.current_episode,
  );
  writeState(root, runId, seeded);
  const before = readState(root, runId).data;
  const oldScope = structuredClone(before.session_chain.sessions[0].scope);

  const result = invoke(root, runId, [
    'recover',
    '--supersede-affinity',
    '--reason', 'original host conversation is irrecoverably lost',
    '--confirm',
    '--owner', runId,
    '--generation', '1',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const after = readState(root, runId).data;
  const lease = after.session_chain.lease;
  const child = after.session_chain.sessions.find(
    session => session.run_id === lease.handoff_child_run_id,
  );
  const parent = after.session_chain.sessions.find(session => session.run_id === runId);

  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'host-session-lost');
  assert.equal(lease.state, 'released');
  assert.equal(lease.handoff_phase, 'reserved');
  assert.equal(lease.takeover_kind, 'affinity-supersession');
  assert.equal(lease.expires_at, null);
  assert.ok(child);
  assert.equal(child.recovery_kind, 'affinity-supersession');
  assert.equal(child.recovered_from, runId);
  assert.equal(child.scope.workstream_id, workstreamId);
  assert.equal(child.scope.bound_at_seq, oldScope.bound_at_seq);
  assert.equal(child.scope.terminal_event, null);
  assert.equal(child.scope.superseded_at, null);
  assert.equal(Object.hasOwn(child, 'compact_cursor'), false);
  assert.deepEqual(parent.compact_cursor, historicalCursor(runId, workstreamId, before.current_episode));
  assert.equal(parent.scope.terminal_event, null);
  assert.equal(parent.scope.superseded_by, child.run_id);
  assert.equal(parent.scope.supersede_reason, 'original host conversation is irrecoverably lost');
  assert.equal(child.recovery_project_binding_generation, after.project.binding_generation);
  assert.equal(child.recovery_project_root_digest, projectRootDigest(after.project.root));
  assert.equal(lease.recovery_rel, child.recovery_rel);
  assert.equal(lease.recovery_sha256, child.recovery_sha256);
  assert.equal(output.child_run_id, child.run_id);
  assert.match(output.resume_command, /recovery acquire/);
  const capsule = readFileSync(join(runDir(root, runId), child.recovery_rel));
  assert.ok(capsule.length <= 256 * 1024);
  assert.equal(contentHash(capsule), child.recovery_sha256);
  const opened = unwrap(JSON.parse(capsule), {
    producer: 'deep-loop',
    artifact_kind: 'affinity-recovery',
  });
  assert.ok(opened);
  assert.equal(opened.payload.parent_loop_hash, contentHash(
    JSON.stringify(before, null, 2),
  ));
  assert.equal(opened.payload.project_binding_generation, after.project.binding_generation);
  assert.equal(opened.payload.project_root_digest, projectRootDigest(after.project.root));
  assert.equal(opened.payload.resume_command, output.resume_command);
  const events = readLines(root, runId).filter(event => (
    event.type === 'affinity-superseded'
    && event.data.child_run_id === child.run_id
  ));
  assert.equal(events.length, 1);
});

for (const episodePhase of [
  'maker-done-checker-pending',
  'checker-in-progress',
  'checker-blocked',
  'checker-rejected',
]) {
  test(`affinity supersession preserves ${episodePhase} without fabricating episode progress`, () => {
    const fixture = openAffinityFixture('claude', episodePhase);
    const before = readState(fixture.root, fixture.runId).data;
    const episodeSnapshot = structuredClone(before.episodes);
    const result = supersedeAffinity(fixture.root, fixture.runId, {
      reason: `lost host during ${episodePhase}`,
      confirm: true,
      expect: { owner: fixture.runId, generation: 1 },
      now: NOW + 2_000,
    });
    const after = readState(fixture.root, fixture.runId).data;
    const child = after.session_chain.sessions.find(
      session => session.run_id === result.child_run_id,
    );
    assert.deepEqual(after.episodes, episodeSnapshot);
    assert.equal(child.scope.workstream_id, fixture.workstreamId);
    assert.equal(child.scope.bound_at_seq, before.session_chain.sessions[0].scope.bound_at_seq);
    assert.equal(after.workstreams[0].status, before.workstreams[0].status);
    assert.equal(after.workstreams[0].terminal_events, undefined);
  });
}

test('affinity exact child executes the returned fresh-process recovery command; generic acquire is fenced', () => {
  const fixture = openAffinityFixture('claude', 'checker-in-progress');
  const recovery = supersedeAffinity(fixture.root, fixture.runId, {
    reason: 'fresh process takeover',
    confirm: true,
    expect: { owner: fixture.runId, generation: 1 },
    now: NOW + 2_000,
  });
  const before = durableBytes(fixture.root, fixture.runId);
  const generic = invoke(fixture.root, fixture.runId, [
    'lease', 'acquire',
    '--owner', recovery.child_run_id,
    '--generation', '1',
    '--runtime', 'claude',
  ]);
  assert.equal(generic.status, 3, generic.stderr);
  assert.match(generic.stdout + generic.stderr, /RECOVERY_ACQUIRE_REQUIRED/);
  assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);
  const resumed = invokeReadOnly(fixture.root, fixture.runId, ['resume-command']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.stdout.split('\n')[0], recovery.resume_command);
  assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);

  const acquired = executeReturnedCommand(recovery.resume_command);
  assert.equal(acquired.status, 0, acquired.stderr);
  const after = readState(fixture.root, fixture.runId).data;
  assert.equal(after.status, 'running');
  assert.equal(after.pause_reason, null);
  assert.equal(after.session_chain.lease.owner_run_id, recovery.child_run_id);
  assert.equal(after.session_chain.lease.generation, 2);
  assert.equal(after.session_chain.lease.takeover_kind, null);
  const child = after.session_chain.sessions.find(
    session => session.run_id === recovery.child_run_id,
  );
  assert.equal(child.scope.workstream_id, fixture.workstreamId);
  assert.ok(child.started_at);
});

test('generic acquire fences an affinity recovery identified by the exact reserved child even if the discriminator is missing', () => {
  const fixture = openAffinityFixture();
  const state = readState(fixture.root, fixture.runId).data;
  const childRunId = 'RECOVERY-CHILD-IDENTITY';
  const parent = state.session_chain.sessions[0];
  parent.superseded_by = childRunId;
  parent.scope.superseded_at = new Date(NOW + 2_000).toISOString();
  parent.scope.supersede_reason = 'child identity remains authoritative';
  parent.scope.superseded_by = childRunId;
  state.session_chain.sessions.push({
    run_id: childRunId,
    started_at: null,
    ended_at: null,
    turns: 0,
    outcome: null,
    superseded_by: null,
    recovered_from: fixture.runId,
    recovery_kind: 'affinity-supersession',
    recovery_rel: `recoveries/${childRunId}.json`,
    recovery_sha256: 'b'.repeat(64),
    recovery_project_binding_generation: state.project.binding_generation,
    recovery_project_root_digest: projectRootDigest(state.project.root),
    scope: {
      kind: 'workstream',
      workstream_id: fixture.workstreamId,
      bound_at_seq: parent.scope.bound_at_seq,
      terminal_event: null,
      closed_at: null,
      superseded_at: null,
    },
  });
  Object.assign(state.session_chain.lease, {
    state: 'released',
    handoff_phase: 'reserved',
    handoff_child_run_id: childRunId,
    handoff_idempotency_key: 'a'.repeat(64),
    handoff_trigger: 'affinity-supersession',
    expires_at: null,
    resume_policy: 'human',
    recovery_rel: `recoveries/${childRunId}.json`,
    recovery_sha256: 'b'.repeat(64),
    recovery_discriminator: 'a'.repeat(64),
  });
  state.session_chain.lease.takeover_kind = null;
  writeState(fixture.root, fixture.runId, state);
  const before = durableBytes(fixture.root, fixture.runId);
  const acquired = acquireLease(fixture.root, fixture.runId, {
    owner: childRunId,
    expectGeneration: 1,
    runtime: 'claude',
    now: NOW + 3_000,
  });
  assert.equal(acquired.reason, 'RECOVERY_ACQUIRE_REQUIRED');
  assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);
});

test('resume-command rejects a malformed recovery topology without falling through to handoff', () => {
  const fixture = openAffinityFixture();
  const recovery = supersedeAffinity(fixture.root, fixture.runId, {
    reason: 'malformed resume topology',
    confirm: true,
    expect: { owner: fixture.runId, generation: 1 },
    now: NOW + 2_000,
  });
  assert.equal(acquireLease(fixture.root, fixture.runId, {
    owner: recovery.child_run_id,
    expectGeneration: 1,
    runtime: 'claude',
    now: NOW + 3_000,
  }).reason, 'RECOVERY_ACQUIRE_REQUIRED');
  const state = readState(fixture.root, fixture.runId).data;
  state.session_chain.sessions.find(
    session => session.run_id === recovery.child_run_id,
  ).recovery_project_root_digest = 'f'.repeat(64);
  writeState(fixture.root, fixture.runId, state);
  const before = durableBytes(fixture.root, fixture.runId);
  const resumed = invokeReadOnly(fixture.root, fixture.runId, ['resume-command']);
  assert.equal(resumed.status, 1, resumed.stderr);
  assert.match(resumed.stderr, /RECOVERY_TOPOLOGY_INVALID/);
  assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);
});

test('affinity acquire safety failure and capsule mismatch preserve the exact reservation', () => {
  const budgetFixture = openAffinityFixture();
  const budgetState = readState(budgetFixture.root, budgetFixture.runId).data;
  budgetState.budget.max_wallclock_sec = 86_400;
  writeState(budgetFixture.root, budgetFixture.runId, budgetState);
  const budgetRecovery = supersedeAffinity(budgetFixture.root, budgetFixture.runId, {
    reason: 'budget recheck',
    confirm: true,
    expect: { owner: budgetFixture.runId, generation: 1 },
    now: NOW + 2_000,
    clock: () => NOW + 2_000,
  });
  const budgetBefore = durableBytes(budgetFixture.root, budgetFixture.runId);
  const blocked = acquireRecovery(budgetFixture.root, budgetFixture.runId, {
    capsuleRel: budgetRecovery.recovery_rel,
    owner: budgetRecovery.child_run_id,
    expectGeneration: 1,
    runtime: 'claude',
    now: NOW + (2 * 86_400_000),
    clock: () => NOW + (2 * 86_400_000),
  });
  assert.deepEqual(blocked, {
    ok: false,
    generation: 1,
    reason: 'BUDGET_BLOCKED',
    preserved: true,
    proceed: false,
    consumed: null,
    replayed: false,
  });
  assert.deepEqual(durableBytes(budgetFixture.root, budgetFixture.runId), budgetBefore);
  assert.deepEqual(extendBudget(budgetFixture.root, budgetFixture.runId, {
    wallclockSec: 200_000,
    reason: 'extend exact affinity reservation',
    confirm: true,
    fence: { owner: budgetFixture.runId, generation: 1 },
    now: NOW + (2 * 86_400_000),
  }), { ok: true, status: 'paused' });
  const budgetAcquired = acquireRecovery(budgetFixture.root, budgetFixture.runId, {
    capsuleRel: budgetRecovery.recovery_rel,
    owner: budgetRecovery.child_run_id,
    expectGeneration: 1,
    runtime: 'claude',
    now: NOW + (2 * 86_400_000),
    clock: () => NOW + (2 * 86_400_000),
  });
  assert.deepEqual(withoutContractFields(budgetAcquired), {
    ok: true,
    generation: 2,
    reason: 'acquired',
  });
  assertProceeded(budgetAcquired, { takeoverKind: 'affinity-supersession' });

  const tamperFixture = openAffinityFixture();
  const tamperRecovery = supersedeAffinity(tamperFixture.root, tamperFixture.runId, {
    reason: 'capsule mismatch',
    confirm: true,
    expect: { owner: tamperFixture.runId, generation: 1 },
    now: NOW + 2_000,
  });
  const capsulePath = join(
    runDir(tamperFixture.root, tamperFixture.runId),
    tamperRecovery.recovery_rel,
  );
  writeFileSync(capsulePath, `${readFileSync(capsulePath, 'utf8')}\n`);
  const stateBeforeMismatch = durableBytes(tamperFixture.root, tamperFixture.runId);
  assert.throws(() => acquireRecovery(tamperFixture.root, tamperFixture.runId, {
    capsuleRel: tamperRecovery.recovery_rel,
    owner: tamperRecovery.child_run_id,
    expectGeneration: 1,
    runtime: 'claude',
    now: NOW + 3_000,
  }), /RECOVERY_CAPSULE_INVALID|TRANSACTION_RECONCILIATION_REQUIRED/);
  assert.deepEqual(durableBytes(tamperFixture.root, tamperFixture.runId), stateBeforeMismatch);
});

test('affinity acquire breaker failure preserves the reservation through reset and retry', () => {
  const fixture = openAffinityFixture();
  const recovery = supersedeAffinity(fixture.root, fixture.runId, {
    reason: 'breaker recheck',
    confirm: true,
    expect: { owner: fixture.runId, generation: 1 },
    now: NOW + 2_000,
  });
  tripBreaker(fixture.root, fixture.runId, 'operator-latched-breaker');
  const before = durableBytes(fixture.root, fixture.runId);
  assert.deepEqual(acquireRecovery(fixture.root, fixture.runId, {
    capsuleRel: recovery.recovery_rel,
    owner: recovery.child_run_id,
    expectGeneration: 1,
    runtime: 'claude',
    now: NOW + 3_000,
  }), {
    ok: false,
    generation: 1,
    reason: 'BREAKER_BLOCKED',
    preserved: true,
    proceed: false,
    consumed: null,
    replayed: false,
  });
  assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);
  assert.deepEqual(resetBreaker(fixture.root, fixture.runId, {
    fence: { owner: fixture.runId, generation: 1, intent: 'breaker-reset' },
  }), { ok: true, status: 'paused' });
  const breakerAcquired = acquireRecovery(fixture.root, fixture.runId, {
    capsuleRel: recovery.recovery_rel,
    owner: recovery.child_run_id,
    expectGeneration: 1,
    runtime: 'claude',
    now: NOW + 3_000,
  });
  assert.deepEqual(withoutContractFields(breakerAcquired), {
    ok: true,
    generation: 2,
    reason: 'acquired',
  });
  assertProceeded(breakerAcquired, { takeoverKind: 'affinity-supersession' });
});

test('recovery-in-flight rejects pause, generic recover/release/reservation, rollback, and double supersession', () => {
  const fixture = openAffinityFixture();
  const recovery = supersedeAffinity(fixture.root, fixture.runId, {
    reason: 'guard every generic escape hatch',
    confirm: true,
    expect: { owner: fixture.runId, generation: 1 },
    now: NOW + 2_000,
  });
  const before = durableBytes(fixture.root, fixture.runId);
  for (const mode of ['preserve', 'rollback']) {
    assert.throws(() => pauseRun(fixture.root, fixture.runId, {
      reason: 'attempted relabel',
      mode,
      expect: { owner: fixture.runId, generation: 1 },
      now: NOW + 3_000,
    }), /RECOVERY_IN_FLIGHT/);
  }
  assert.throws(() => recoverRun(fixture.root, fixture.runId, {
    confirm: true,
    expect: { owner: fixture.runId, generation: 1 },
    now: NOW + 3_000,
  }), /RECOVERY_IN_FLIGHT/);
  assert.deepEqual(releaseLease(fixture.root, fixture.runId, {
    owner: fixture.runId,
    generation: 1,
  }), { ok: false, reason: 'RECOVERY_IN_FLIGHT' });
  assert.equal(reserveHandoff(fixture.root, fixture.runId, {
    trigger: 'manual',
    now: NOW + 3_000,
  }).reason, 'RECOVERY_IN_FLIGHT');
  assert.equal(advanceHandoffPhase(fixture.root, fixture.runId, {
    key: recovery.operation_id,
    toPhase: 'emitted',
  }).reason, 'RECOVERY_IN_FLIGHT');
  assert.equal(rollbackHandoff(fixture.root, fixture.runId, {
    owner: fixture.runId,
    generation: 1,
  }).reason, 'RECOVERY_IN_FLIGHT');
  assert.equal(rollbackReservedEmit(fixture.root, fixture.runId, {
    key: readState(fixture.root, fixture.runId).data.session_chain.lease
      .handoff_idempotency_key,
    childRunId: recovery.child_run_id,
    expect: { owner: fixture.runId, generation: 1 },
  }).reason, 'RECOVERY_IN_FLIGHT');
  assert.throws(() => supersedeAffinity(fixture.root, fixture.runId, {
    reason: 'duplicate',
    confirm: true,
    expect: { owner: fixture.runId, generation: 1 },
    now: NOW + 3_000,
  }), /RECOVERY_IN_FLIGHT/);
  assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);
});

test('failed affinity prechecks create no capsule, event, child, scope, or generation change', () => {
  for (const configure of [
    { label: 'budget', now: NOW + (2 * 86_400_000), pattern: /BUDGET_BLOCKED/ },
    { label: 'breaker', now: NOW + 2_000, pattern: /BREAKER_BLOCKED/, breaker: true },
  ]) {
    const fixture = openAffinityFixture();
    if (configure.label === 'budget') {
      const state = readState(fixture.root, fixture.runId).data;
      state.budget.max_wallclock_sec = 86_400;
      writeState(fixture.root, fixture.runId, state);
    }
    if (configure.breaker) {
      const state = readState(fixture.root, fixture.runId).data;
      state.circuit_breaker = {
        consecutive_request_changes: 3,
        tripped: true,
        trip_reason: 'consecutive-request-changes',
      };
      writeState(fixture.root, fixture.runId, state);
    }
    const before = durableBytes(fixture.root, fixture.runId);
    assert.throws(() => supersedeAffinity(fixture.root, fixture.runId, {
      reason: `${configure.label} must fail closed`,
      confirm: true,
      expect: { owner: fixture.runId, generation: 1 },
      now: configure.now,
      clock: () => configure.now,
    }), configure.pattern);
    assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);
    assert.equal(existsSync(join(runDir(fixture.root, fixture.runId), 'recoveries')), false);
  }
});

test('affinity supersession rejects stale handoff residue even when phase is idle', () => {
  const fixture = openAffinityFixture();
  const state = readState(fixture.root, fixture.runId).data;
  state.session_chain.lease.handoff_idempotency_key = 'c'.repeat(64);
  state.session_chain.lease.handoff_trigger = 'stale-reservation';
  writeState(fixture.root, fixture.runId, state);
  const before = durableBytes(fixture.root, fixture.runId);
  assert.throws(() => supersedeAffinity(fixture.root, fixture.runId, {
    reason: 'must not erase stale handoff evidence',
    confirm: true,
    expect: { owner: fixture.runId, generation: 1 },
    now: NOW + 2_000,
  }), /AFFINITY_SUPERSESSION_PHASE_INVALID/);
  assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);
  assert.equal(existsSync(join(runDir(fixture.root, fixture.runId), 'recoveries')), false);
});

for (const stalePhase of ['reserved', 'emitted', 'spawned', 'acquired']) {
  test(`boundary recovery replaces ${stalePhase} with exact journal topology and preserves it across gate retry`, () => {
    const fixture = boundaryFixture(stalePhase);
    const seeded = readState(fixture.root, fixture.runId).data;
    const cursorSource = seeded.session_chain.sessions.find(
      session => session.run_id === fixture.staleSessionId,
    ) ?? seeded.session_chain.sessions.find(session => session.run_id === fixture.runId);
    cursorSource.compact_cursor = historicalCursor(cursorSource.run_id, 'ws-history', 'ep-history');
    const cursorSourceId = cursorSource.run_id;
    writeState(fixture.root, fixture.runId, seeded);
    const predecessor = readState(fixture.root, fixture.runId);
    const result = recoverBoundary(fixture.root, fixture.runId, {
      confirm: true,
      expect: fixture.expect,
      now: NOW + 4_000,
      clock: () => NOW + 4_000,
    });
    const after = readState(fixture.root, fixture.runId).data;
    const lease = after.session_chain.lease;
    const replacement = after.session_chain.sessions.find(
      session => session.run_id === result.child_run_id,
    );
    const stale = after.session_chain.sessions.find(
      session => session.run_id === fixture.staleSessionId,
    );
    const parent = after.session_chain.sessions.find(
      session => session.run_id === fixture.runId,
    );
    assert.equal(result.stale_phase, stalePhase);
    assert.equal(lease.takeover_kind, 'boundary-recovery');
    assert.equal(lease.handoff_phase, 'reserved');
    assert.equal(lease.state, 'released');
    assert.equal(lease.expires_at, null);
    assert.deepEqual(lease.handoff_boundary_event, fixture.boundaryEvent);
    assert.equal(replacement.recovered_from, fixture.staleSessionId);
    assert.equal(Object.hasOwn(replacement, 'compact_cursor'), false);
    assert.deepEqual(
      after.session_chain.sessions.find(session => session.run_id === cursorSourceId).compact_cursor,
      historicalCursor(cursorSourceId, 'ws-history', 'ep-history'),
    );
    assert.equal(replacement.scope.workstream_id, null);
    assert.equal(replacement.scope.bound_at_seq, null);
    assert.equal(replacement.recovery_project_binding_generation, after.project.binding_generation);
    assert.equal(replacement.recovery_project_root_digest, projectRootDigest(after.project.root));
    assert.equal(openScopes(after).length, 1);
    assert.equal(openScopes(after)[0].run_id, replacement.run_id);
    assert.equal(stale.outcome, 'abandoned_recover');
    assert.equal(stale.ended_at, '2026-07-23T00:00:04.000Z');
    assert.equal(stale.superseded_by, replacement.run_id);
    assert.equal(stale.scope.superseded_at, stale.ended_at);
    assert.equal(stale.scope.supersede_reason, 'boundary-recovery');
    assert.equal(stale.scope.superseded_by, replacement.run_id);
    assert.equal(parent.superseded_by, stale.run_id);
    assert.deepEqual(parent.scope.terminal_event, fixture.boundaryEvent);
    assert.ok(parent.scope.closed_at);

    const expectedOperationId = contentHash(JSON.stringify([
      'deep-loop-boundary-recovery-v1',
      fixture.runId,
      fixture.boundaryEvent.seq,
      fixture.boundaryEvent.checksum,
      stalePhase,
      fixture.staleSessionId,
      result.child_run_id,
      predecessor.hash,
    ]));
    assert.equal(result.operation_id, expectedOperationId);
    assert.equal(lease.handoff_idempotency_key, expectedOperationId);
    const events = readLines(fixture.root, fixture.runId);
    const recovered = events.filter(event => event.type === 'boundary-recovered');
    assert.equal(recovered.length, 1);
    assert.deepEqual(Object.keys(recovered[0].data), [
      'operation_id',
      'boundary_event',
      'stale_phase',
      'stale_session_id',
      'replacement_session_id',
      'parent_session_id',
    ]);
    assert.deepEqual(recovered[0].data, {
      operation_id: expectedOperationId,
      boundary_event: fixture.boundaryEvent,
      stale_phase: stalePhase,
      stale_session_id: fixture.staleSessionId,
      replacement_session_id: result.child_run_id,
      parent_session_id: fixture.runId,
    });
    assert.equal(events.some(event => event.type === 'run-recovered'), false);
    const capsule = readFileSync(join(runDir(fixture.root, fixture.runId), result.recovery_rel));
    assert.ok(capsule.length <= 256 * 1024);
    assert.equal(contentHash(capsule), result.recovery_sha256);
    const opened = unwrap(JSON.parse(capsule), {
      producer: 'deep-loop',
      artifact_kind: 'boundary-recovery',
    });
    assert.ok(opened);
    assert.equal(opened.payload.parent_loop_hash, predecessor.hash);
    assert.equal(opened.payload.resume_command, result.resume_command);

    const arbitraryBefore = durableBytes(fixture.root, fixture.runId);
    const arbitrary = acquireLease(fixture.root, fixture.runId, {
      owner: 'ARBITRARY-OWNER',
      expectGeneration: fixture.expect.generation,
      runtime: 'claude',
      now: NOW + 5_000,
    });
    assert.equal(arbitrary.ok, false);
    assert.deepEqual(durableBytes(fixture.root, fixture.runId), arbitraryBefore);

    const budgetState = readState(fixture.root, fixture.runId).data;
    budgetState.budget.max_wallclock_sec = 86_400;
    writeState(fixture.root, fixture.runId, budgetState);
    const reservedBefore = durableBytes(fixture.root, fixture.runId);
    const blocked = acquireLease(fixture.root, fixture.runId, {
      owner: result.child_run_id,
      expectGeneration: fixture.expect.generation,
      runtime: 'claude',
      now: NOW + (2 * 86_400_000),
      clock: () => NOW + (2 * 86_400_000),
    });
    assert.deepEqual(blocked, {
      ok: false,
      generation: fixture.expect.generation,
      reason: 'BUDGET_BLOCKED',
      preserved: true,
      proceed: false,
      consumed: null,
      replayed: false,
    });
    assert.deepEqual(durableBytes(fixture.root, fixture.runId), reservedBefore);

    const topologyBeforeExtension = structuredClone({
      status: after.status,
      pause_reason: after.pause_reason,
      lease: after.session_chain.lease,
      sessions: after.session_chain.sessions,
    });
    assert.deepEqual(extendBudget(fixture.root, fixture.runId, {
      wallclockSec: 200_000,
      reason: `extend ${stalePhase} boundary recovery`,
      confirm: true,
      fence: fixture.expect,
      now: NOW + (2 * 86_400_000),
    }), { ok: true, status: 'paused' });
    const extended = readState(fixture.root, fixture.runId).data;
    assert.deepEqual({
      status: extended.status,
      pause_reason: extended.pause_reason,
      lease: extended.session_chain.lease,
      sessions: extended.session_chain.sessions,
    }, topologyBeforeExtension);

    const acquired = acquireLease(fixture.root, fixture.runId, {
      owner: result.child_run_id,
      expectGeneration: fixture.expect.generation,
      runtime: 'claude',
      now: NOW + (2 * 86_400_000),
      clock: () => NOW + (2 * 86_400_000),
    });
    assert.deepEqual(withoutContractFields(acquired), {
      ok: true,
      generation: fixture.expect.generation + 1,
      reason: 'acquired',
    });
    assertProceeded(acquired, { takeoverKind: 'boundary-recovery' });
    const final = readState(fixture.root, fixture.runId).data;
    assert.equal(final.status, 'running');
    assert.equal(final.session_chain.lease.owner_run_id, result.child_run_id);
    assert.equal(final.session_chain.lease.generation, fixture.expect.generation + 1);
    assert.equal(final.session_chain.lease.takeover_kind, null);
    assert.deepEqual(final.session_chain.sessions.find(
      session => session.run_id === fixture.staleSessionId,
    ).scope.superseded_by, result.child_run_id);
    assert.equal(final.session_chain.sessions.find(
      session => session.run_id === fixture.staleSessionId,
    ).outcome, 'abandoned_recover');
    assert.equal(readLines(fixture.root, fixture.runId).filter(
      event => event.type === 'boundary-recovered',
    ).length, 1);
  });
}

test('prepared boundary recovery rolls forward once and retry never duplicates the event or topology', () => {
  const fixture = boundaryFixture('reserved');
  assert.throws(() => recoverBoundary(fixture.root, fixture.runId, {
    confirm: true,
    expect: fixture.expect,
    now: NOW + 4_000,
    publicationFaultAt(label) {
      if (label === 'prepared:digest-verified') throw new Error('crash-after-prepare');
    },
  }), /TRANSACTION_PENDING/);
  const reconciled = captureReconciledRunSnapshot(
    fixture.root,
    fixture.runId,
  ).data;
  const lease = reconciled.session_chain.lease;
  const childId = lease.handoff_child_run_id;
  assert.equal(lease.takeover_kind, 'boundary-recovery');
  assert.equal(reconciled.session_chain.sessions.filter(
    session => session.run_id === childId,
  ).length, 1);
  assert.equal(readLines(fixture.root, fixture.runId).filter(
    event => event.type === 'boundary-recovered',
  ).length, 1);
  const beforeRetry = durableBytes(fixture.root, fixture.runId);
  assert.throws(() => recoverRun(fixture.root, fixture.runId, {
    confirm: true,
    expect: fixture.expect,
    now: NOW + 4_000,
  }), /RECOVERY_IN_FLIGHT/);
  assert.deepEqual(durableBytes(fixture.root, fixture.runId), beforeRetry);
  assert.equal(readLines(fixture.root, fixture.runId).filter(
    event => event.type === 'boundary-recovered',
  ).length, 1);
});

test('boundary recovery returned command acquires the exact child in a fresh process', () => {
  const fixture = boundaryFixture('reserved');
  const recovery = recoverBoundary(fixture.root, fixture.runId, {
    confirm: true,
    expect: fixture.expect,
    now: NOW + 4_000,
  });
  const before = durableBytes(fixture.root, fixture.runId);
  const resumed = invokeReadOnly(fixture.root, fixture.runId, ['resume-command']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.stdout.split('\n')[0], recovery.resume_command);
  assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);
  const acquired = executeReturnedCommand(recovery.resume_command);
  assert.equal(acquired.status, 0, acquired.stderr);
  const after = readState(fixture.root, fixture.runId).data;
  assert.equal(after.session_chain.lease.owner_run_id, recovery.child_run_id);
  assert.equal(after.session_chain.lease.generation, 2);
  assert.equal(after.status, 'running');
});

test('boundary acquire breaker failure preserves exact topology through reset and retry', () => {
  const fixture = boundaryFixture('emitted');
  const recovery = recoverBoundary(fixture.root, fixture.runId, {
    confirm: true,
    expect: fixture.expect,
    now: NOW + 4_000,
  });
  tripBreaker(fixture.root, fixture.runId, 'operator-latched-breaker');
  const before = durableBytes(fixture.root, fixture.runId);
  assert.deepEqual(acquireLease(fixture.root, fixture.runId, {
    owner: recovery.child_run_id,
    expectGeneration: fixture.expect.generation,
    runtime: 'claude',
    now: NOW + 5_000,
  }), {
    ok: false,
    generation: fixture.expect.generation,
    reason: 'BREAKER_BLOCKED',
    preserved: true,
    proceed: false,
    consumed: null,
    replayed: false,
  });
  assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);
  assert.deepEqual(resetBreaker(fixture.root, fixture.runId, {
    fence: { ...fixture.expect, intent: 'breaker-reset' },
  }), { ok: true, status: 'paused' });
  const boundaryAcquired = acquireLease(fixture.root, fixture.runId, {
    owner: recovery.child_run_id,
    expectGeneration: fixture.expect.generation,
    runtime: 'claude',
    now: NOW + 5_000,
  });
  assert.deepEqual(withoutContractFields(boundaryAcquired), {
    ok: true,
    generation: fixture.expect.generation + 1,
    reason: 'acquired',
  });
  assertProceeded(boundaryAcquired, { takeoverKind: 'boundary-recovery' });
});

test('affinity publication rejects stale public --now after real wallclock expiry', async () => {
  const fixture = openAffinityFixture();
  const staleNow = await stalePreCapNowAfterExpiry(fixture.root, fixture.runId);
  const before = durableRecoveryBytes(fixture.root, fixture.runId);
  const recovered = invokeAt(fixture.root, fixture.runId, [
    'recover',
    '--supersede-affinity',
    '--reason', 'stale public affinity publication time',
    '--confirm',
    '--owner', fixture.runId,
    '--generation', '1',
  ], staleNow);
  assert.equal(recovered.status, 1, recovered.stderr);
  assert.match(recovered.stderr, /BUDGET_BLOCKED/);
  assert.deepEqual(durableRecoveryBytes(fixture.root, fixture.runId), before);
});

test('boundary publication rejects stale public --now after real wallclock expiry', async () => {
  const fixture = boundaryFixture('reserved');
  const staleNow = await stalePreCapNowAfterExpiry(fixture.root, fixture.runId);
  const before = durableRecoveryBytes(fixture.root, fixture.runId);
  const recovered = invokeAt(fixture.root, fixture.runId, [
    'recover',
    '--confirm',
    '--owner', fixture.expect.owner,
    '--generation', String(fixture.expect.generation),
  ], staleNow);
  assert.equal(recovered.status, 1, recovered.stderr);
  assert.match(recovered.stderr, /BUDGET_BLOCKED/);
  assert.deepEqual(durableRecoveryBytes(fixture.root, fixture.runId), before);
});

test('affinity recovery acquire rejects stale public --now after real wallclock expiry', async () => {
  const fixture = openAffinityFixture();
  const recovery = supersedeAffinity(fixture.root, fixture.runId, {
    reason: 'stale public affinity acquisition time',
    confirm: true,
    expect: { owner: fixture.runId, generation: 1 },
    now: NOW + 2_000,
    clock: () => NOW + 2_000,
  });
  tripBreaker(fixture.root, fixture.runId, 'retire recovery journal');
  resetBreaker(fixture.root, fixture.runId, {
    fence: { owner: fixture.runId, generation: 1, intent: 'breaker-reset' },
  });
  const staleNow = await stalePreCapNowAfterExpiry(fixture.root, fixture.runId);
  const before = durableRecoveryBytes(fixture.root, fixture.runId);
  const acquired = invokeAt(fixture.root, fixture.runId, [
    'recovery', 'acquire',
    '--capsule', recovery.recovery_rel,
    '--owner', recovery.child_run_id,
    '--generation', '1',
    '--runtime', 'claude',
  ], staleNow);
  assert.equal(acquired.status, 1, acquired.stderr);
  assert.deepEqual(JSON.parse(acquired.stdout), {
    ok: false,
    generation: 1,
    reason: 'BUDGET_BLOCKED',
    preserved: true,
    proceed: false,
    consumed: null,
    replayed: false,
  });
  assert.deepEqual(durableRecoveryBytes(fixture.root, fixture.runId), before);
});

test('boundary lease acquire rejects stale public --now after real wallclock expiry', async () => {
  const fixture = boundaryFixture('reserved');
  const recovery = recoverBoundary(fixture.root, fixture.runId, {
    confirm: true,
    expect: fixture.expect,
    now: NOW + 4_000,
    clock: () => NOW + 4_000,
  });
  tripBreaker(fixture.root, fixture.runId, 'retire recovery journal');
  resetBreaker(fixture.root, fixture.runId, {
    fence: { ...fixture.expect, intent: 'breaker-reset' },
  });
  const staleNow = await stalePreCapNowAfterExpiry(fixture.root, fixture.runId);
  const before = durableRecoveryBytes(fixture.root, fixture.runId);
  const acquired = invokeAt(fixture.root, fixture.runId, [
    'lease', 'acquire',
    '--owner', recovery.child_run_id,
    '--generation', String(fixture.expect.generation),
    '--runtime', 'claude',
  ], staleNow);
  assert.equal(acquired.status, 0, acquired.stderr);
  assert.deepEqual(JSON.parse(acquired.stdout), {
    ok: false,
    generation: fixture.expect.generation,
    reason: 'BUDGET_BLOCKED',
    preserved: true,
    proceed: false,
    consumed: null,
    replayed: false,
  });
  assert.deepEqual(durableRecoveryBytes(fixture.root, fixture.runId), before);
});

test('affinity recovery acquire samples production time after lock contention crosses wallclock', async () => {
  const fixture = openAffinityFixture();
  const recovery = supersedeAffinity(fixture.root, fixture.runId, {
    reason: 'locked affinity acquisition clock',
    confirm: true,
    expect: { owner: fixture.runId, generation: 1 },
    now: NOW + 2_000,
  });
  tripBreaker(fixture.root, fixture.runId, 'retire recovery journal');
  resetBreaker(fixture.root, fixture.runId, {
    fence: { owner: fixture.runId, generation: 1, intent: 'breaker-reset' },
  });
  armRealWallclock(fixture.root, fixture.runId);
  const before = durableRecoveryBytes(fixture.root, fixture.runId);
  const acquired = await whileRunLockIsHeld(
    fixture.root,
    fixture.runId,
    () => executeReturnedCommand(recovery.resume_command),
  );
  assert.equal(acquired.status, 1, acquired.stderr);
  assert.deepEqual(JSON.parse(acquired.stdout), {
    ok: false,
    generation: 1,
    reason: 'BUDGET_BLOCKED',
    preserved: true,
    proceed: false,
    consumed: null,
    replayed: false,
  });
  assert.deepEqual(durableRecoveryBytes(fixture.root, fixture.runId), before);
});

test('boundary recovery acquire samples production time after lock contention crosses wallclock', async () => {
  const fixture = boundaryFixture('reserved');
  const recovery = recoverBoundary(fixture.root, fixture.runId, {
    confirm: true,
    expect: fixture.expect,
    now: NOW + 4_000,
  });
  tripBreaker(fixture.root, fixture.runId, 'retire recovery journal');
  resetBreaker(fixture.root, fixture.runId, {
    fence: { ...fixture.expect, intent: 'breaker-reset' },
  });
  armRealWallclock(fixture.root, fixture.runId);
  const before = durableRecoveryBytes(fixture.root, fixture.runId);
  const acquired = await whileRunLockIsHeld(
    fixture.root,
    fixture.runId,
    () => executeReturnedCommand(recovery.resume_command),
  );
  assert.equal(acquired.status, 0, acquired.stderr);
  assert.deepEqual(JSON.parse(acquired.stdout), {
    ok: false,
    generation: 1,
    reason: 'BUDGET_BLOCKED',
    preserved: true,
    proceed: false,
    consumed: null,
    replayed: false,
  });
  assert.deepEqual(durableRecoveryBytes(fixture.root, fixture.runId), before);
});

test('affinity supersession publication samples production time after lock contention crosses wallclock', async () => {
  const fixture = openAffinityFixture();
  armRealWallclock(fixture.root, fixture.runId);
  const before = durableRecoveryBytes(fixture.root, fixture.runId);
  const recovered = await whileRunLockIsHeld(
    fixture.root,
    fixture.runId,
    () => invokeWithoutNow(fixture.root, fixture.runId, [
      'recover',
      '--supersede-affinity',
      '--reason', 'locked affinity publication clock',
      '--confirm',
      '--owner', fixture.runId,
      '--generation', '1',
    ]),
  );
  assert.equal(recovered.status, 1, recovered.stderr);
  assert.match(recovered.stderr, /BUDGET_BLOCKED/);
  assert.deepEqual(durableRecoveryBytes(fixture.root, fixture.runId), before);
});

test('boundary recovery publication samples production time after lock contention crosses wallclock', async () => {
  const fixture = boundaryFixture('reserved');
  armRealWallclock(fixture.root, fixture.runId);
  const before = durableRecoveryBytes(fixture.root, fixture.runId);
  const recovered = await whileRunLockIsHeld(
    fixture.root,
    fixture.runId,
    () => invokeWithoutNow(fixture.root, fixture.runId, [
      'recover',
      '--confirm',
      '--owner', fixture.expect.owner,
      '--generation', String(fixture.expect.generation),
    ]),
  );
  assert.equal(recovered.status, 1, recovered.stderr);
  assert.match(recovered.stderr, /BUDGET_BLOCKED/);
  assert.deepEqual(durableRecoveryBytes(fixture.root, fixture.runId), before);
});

test('boundary recovery CLI classifies child reservation mismatch as fence exit 3 without mutation', () => {
  const fixture = boundaryFixture('reserved');
  recoverBoundary(fixture.root, fixture.runId, {
    confirm: true,
    expect: fixture.expect,
    now: NOW + 4_000,
  });
  const before = durableRecoveryBytes(fixture.root, fixture.runId);
  const result = invoke(fixture.root, fixture.runId, [
    'lease', 'acquire',
    '--owner', 'ARBITRARY-OWNER',
    '--generation', String(fixture.expect.generation),
    '--runtime', 'claude',
  ]);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, 'child-not-reserved');
  assert.deepEqual(durableRecoveryBytes(fixture.root, fixture.runId), before);
});

test('boundary recovery CLI classifies invalid topology as exit 1 without mutation', () => {
  const fixture = boundaryFixture('reserved');
  const recovery = recoverBoundary(fixture.root, fixture.runId, {
    confirm: true,
    expect: fixture.expect,
    now: NOW + 4_000,
  });
  tripBreaker(fixture.root, fixture.runId, 'retire recovery journal');
  resetBreaker(fixture.root, fixture.runId, {
    fence: { ...fixture.expect, intent: 'breaker-reset' },
  });
  const state = readState(fixture.root, fixture.runId).data;
  state.session_chain.sessions.find(
    session => session.run_id === recovery.child_run_id,
  ).recovery_project_root_digest = 'f'.repeat(64);
  writeState(fixture.root, fixture.runId, state);
  const before = durableRecoveryBytes(fixture.root, fixture.runId);
  const result = invoke(fixture.root, fixture.runId, [
    'lease', 'acquire',
    '--owner', recovery.child_run_id,
    '--generation', String(fixture.expect.generation),
    '--runtime', 'claude',
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, 'recovery-topology-invalid');
  assert.deepEqual(durableRecoveryBytes(fixture.root, fixture.runId), before);
});

test('boundary recovery CLI classifies invalid capsule as exit 1 without mutation', () => {
  const fixture = boundaryFixture('reserved');
  const recovery = recoverBoundary(fixture.root, fixture.runId, {
    confirm: true,
    expect: fixture.expect,
    now: NOW + 4_000,
  });
  tripBreaker(fixture.root, fixture.runId, 'retire recovery journal');
  resetBreaker(fixture.root, fixture.runId, {
    fence: { ...fixture.expect, intent: 'breaker-reset' },
  });
  writeFileSync(join(
    runDir(fixture.root, fixture.runId),
    recovery.recovery_rel,
  ), '{}');
  const before = durableRecoveryBytes(fixture.root, fixture.runId);
  const result = invoke(fixture.root, fixture.runId, [
    'lease', 'acquire',
    '--owner', recovery.child_run_id,
    '--generation', String(fixture.expect.generation),
    '--runtime', 'claude',
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, 'recovery-capsule-invalid');
  assert.deepEqual(durableRecoveryBytes(fixture.root, fixture.runId), before);
});

test('recovery acquire CLI classifies missing command input as usage', () => {
  const fixture = openAffinityFixture();
  const result = invoke(fixture.root, fixture.runId, [
    'recovery', 'acquire',
    '--owner', fixture.runId,
    '--generation', '1',
    '--runtime', 'claude',
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /RECOVERY_ACQUIRE_INPUT_INVALID|USAGE/);
});
