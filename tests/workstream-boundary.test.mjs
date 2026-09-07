import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { captureReconciledRunSnapshot, readState, writeState } from '../scripts/lib/state.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { recordWorkstreamTerminal } from '../scripts/lib/workspace.mjs';
import { abandonEpisode, newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview, recordReviewOutcome } from '../scripts/lib/review.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';
import * as finishModule from '../scripts/lib/finish.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { buildLaunchCommand, buildRuntimeResumeDescriptor } from '../scripts/lib/runtime-descriptor.mjs';
import { makeGoalFixture } from './helpers/goal-fixture.mjs';
import {
  createScenarioMaker,
  produceScenarioMaker,
  reviewScenarioMaker,
} from './helpers/goal-scenario.mjs';
import { acquireLease } from '../scripts/lib/lease.mjs';
import { runDir } from '../scripts/lib/state.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { projectRootDigest } from '../scripts/lib/project-root.mjs';
import { respawn } from '../scripts/lib/respawn.mjs';
import { appendAnchored, captureVerifiedRunSnapshot } from '../scripts/lib/integrity.mjs';
import { makeCodexProcessReceipt, settleCodexProcessCost } from '../scripts/lib/budget.mjs';
import { finishRun } from '../scripts/lib/finish.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
const NOW = '2026-07-23T04:05:06.789Z';

function fence(runId, generation = 1) {
  return { owner: runId, generation, intent: 'business' };
}

function runCli(root, runId, args, generation = 1) {
  return spawnSync(process.execPath, [
    CLI, ...args,
    '--owner', runId, '--generation', String(generation),
    '--run-id', runId, '--project-root', root,
  ], { encoding: 'utf8' });
}

function runReadCli(root, runId, args) {
  return spawnSync(process.execPath, [
    CLI, ...args, '--run-id', runId, '--project-root', root,
  ], { encoding: 'utf8' });
}

function durableBytes(root) {
  const files = {};
  const visit = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.lock') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path, rel);
      else files[rel] = readFileSync(path).toString('base64');
    }
  };
  visit(root);
  return files;
}

function durableRunBytes(root, runId) {
  return durableBytes(runDir(root, runId));
}

function seedReviewed(runtime = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'dl-workstream-boundary-'));
  const review = {
    points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model',
    flags: [], converge: true, max_review_rounds: 5, require_human_ack: false,
  };
  const { runId } = initRun(root, {
    runtime, goal: 'g', review, now: new Date('2026-07-23T00:00:00.000Z'),
  });
  const f = fence(runId);
  const worktree = '.claude/worktrees/closure';
  mkdirSync(join(root, worktree), { recursive: true });
  const ws = newWorkstream(root, runId, {
    title: 'closure', branch: 'feature/closure', worktree, fence: f,
  }).id;
  const baseline = addDoneMaker({ root, runId, f, ws, worktree }, 'baseline');
  const checker = dispatchReview(root, runId, {
    point: 'implementation', workstreamId: ws, detected: {}, fence: f,
  }).checkerEpisodeId;
  const report = `${worktree}/baseline-review.md`;
  writeFileSync(join(root, report), '# baseline review\nAPPROVE\n');
  recordReviewOutcome(root, runId, {
    episodeId: checker, verdict: 'APPROVE', proof: { report }, fence: f,
  });
  return { root, runId, f, ws, worktree, baseline, checker };
}

function addMaker(f, name) {
  const artifact = `${f.worktree}/${name}.txt`;
  mkdirSync(dirname(join(f.root, artifact)), { recursive: true });
  writeFileSync(join(f.root, artifact), `${name}\n`);
  const id = newEpisode(f.root, f.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: f.ws, expectedArtifacts: [artifact], fence: f.f,
  }).id;
  return { id, artifact };
}

function addDoneMaker(f, name) {
  const maker = addMaker(f, name);
  recordEpisode(f.root, f.runId, maker.id, { status: 'in_progress', fence: f.f });
  recordEpisode(f.root, f.runId, maker.id, {
    status: 'done', artifacts: [maker.artifact], proof: {}, fence: f.f,
  });
  return maker.id;
}

function addApprovedReview(f, makerId, name) {
  const checkerId = dispatchReview(f.root, f.runId, {
    point: 'implementation', workstreamId: f.ws, detected: {}, fence: f.f,
  }).checkerEpisodeId;
  const report = `${f.worktree}/${name}-review.md`;
  writeFileSync(join(f.root, report), `# ${name} review\nAPPROVE\n`);
  recordReviewOutcome(f.root, f.runId, {
    episodeId: checkerId, verdict: 'APPROVE', proof: { report }, fence: f.f,
  });
  return { makerId, checkerId };
}

function prepareDefect(kind) {
  const f = seedReviewed();
  if (kind === 'pending') {
    addMaker(f, 'pending');
  } else if (kind === 'in-progress') {
    const maker = addMaker(f, 'in-progress');
    recordEpisode(f.root, f.runId, maker.id, { status: 'in_progress', fence: f.f });
  } else if (kind === 'blocked') {
    const maker = addMaker(f, 'blocked');
    recordEpisode(f.root, f.runId, maker.id, { status: 'in_progress', fence: f.f });
    recordEpisode(f.root, f.runId, maker.id, { status: 'blocked', proof: {}, fence: f.f });
  } else if (kind === 'done-unreviewed') {
    addDoneMaker(f, 'done-unreviewed');
  } else if (['checker-pending', 'checker-in-progress', 'checker-blocked'].includes(kind)) {
    addDoneMaker(f, kind);
    const checkerId = dispatchReview(f.root, f.runId, {
      point: 'implementation', workstreamId: f.ws, detected: {}, fence: f.f,
    }).checkerEpisodeId;
    if (kind !== 'checker-pending') {
      const state = readState(f.root, f.runId).data;
      state.episodes.find(ep => ep.id === checkerId).status =
        kind === 'checker-in-progress' ? 'in_progress' : 'blocked';
      writeState(f.root, f.runId, state);
    }
  } else if (kind === 'unresolved-rejected') {
    addDoneMaker(f, 'unresolved-rejected');
    const checkerId = dispatchReview(f.root, f.runId, {
      point: 'implementation', workstreamId: f.ws, detected: {}, fence: f.f,
    }).checkerEpisodeId;
    recordReviewOutcome(f.root, f.runId, {
      episodeId: checkerId, verdict: 'REQUEST_CHANGES', fence: f.f,
    });
  } else if (kind === 'latest-checker-rejected') {
    const makerId = addDoneMaker(f, 'latest-checker-rejected');
    addApprovedReview(f, makerId, 'latest-checker-approved-first');
    const state = readState(f.root, f.runId).data;
    state.episodes.push({
      id: '1000-subagent-checker',
      plugin: 'subagent-checker',
      role: 'checker',
      kind: 'implementation-review',
      point: 'implementation',
      workstream_id: f.ws,
      target_maker: makerId,
      status: 'rejected',
      request_rel: 'episodes/1000-subagent-checker/request.md',
    });
    writeState(f.root, f.runId, state);
  } else if (kind === 'contract-unpinned') {
    const state = readState(f.root, f.runId).data;
    state.recipe = { id: 'harness-hill-climb' };
    delete state.episodes.find(ep => ep.id === f.checker).contract;
    writeState(f.root, f.runId, state);
  } else {
    throw new Error(`unknown defect: ${kind}`);
  }
  return f;
}

function terminalArgs(ws, status, { confirm = status === 'abandoned' } = {}) {
  const proof = status === 'ready'
    ? {}
    : status === 'merged'
      ? { merge_commit: 'abc123', human_approved: true }
      : { reason: 'confirmed cancellation' };
  return [
    'workstream', 'terminal', '--id', ws, '--status', status,
    '--proof', JSON.stringify(proof), '--now', NOW,
    ...(confirm ? ['--confirm'] : []),
  ];
}

for (const status of ['ready', 'abandoned']) {
  for (const defect of [
    'pending',
    'in-progress',
    'blocked',
    'unresolved-rejected',
    'done-unreviewed',
    'checker-pending',
    'checker-in-progress',
    'checker-blocked',
    'latest-checker-rejected',
    'contract-unpinned',
  ]) {
    test(`public ${status} rejects ${defect} closure proof without durable mutation`, () => {
      const f = prepareDefect(defect);
      const before = durableBytes(f.root);
      const result = runCli(f.root, f.runId, terminalArgs(f.ws, status));
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /WORKSTREAM_CLOSURE_UNMET/);
      assert.deepEqual(durableBytes(f.root), before);
    });
  }
}

test('stale terminal fence wins over closure defects and preserves all bytes', () => {
  const f = prepareDefect('pending');
  const before = durableBytes(f.root);
  const result = runCli(f.root, f.runId, terminalArgs(f.ws, 'ready'), 9);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /LEASE_FENCED/);
  assert.doesNotMatch(result.stderr, /WORKSTREAM_CLOSURE_UNMET/);
  assert.deepEqual(durableBytes(f.root), before);
});

for (const status of ['ready', 'abandoned']) {
  test(`${status} closes once after per-episode settlement with exact anchored identity`, () => {
    const f = seedReviewed();
    const pending = addMaker(f, `${status}-cancelled`);
    const blocked = runCli(f.root, f.runId, terminalArgs(f.ws, status));
    assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stderr, /WORKSTREAM_CLOSURE_UNMET/);

    abandonEpisode(f.root, f.runId, pending.id, {
      reason: 'explicitly cancelled', confirm: true, fence: f.f,
    });
    const result = runCli(f.root, f.runId, terminalArgs(f.ws, status));
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const state = readState(f.root, f.runId).data;
    const ws = state.workstreams.find(item => item.id === f.ws);
    const scope = state.session_chain.sessions.find(session => session.run_id === f.runId).scope;
    const events = readFileSync(join(f.root, '.deep-loop', 'runs', f.runId, 'event-log.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line));
    const terminal = events.findLast(event => event.type === 'workstream-terminal');
    const identity = { seq: terminal.seq, checksum: terminal.checksum };
    assert.deepEqual(ws.terminal_events, [identity]);
    assert.deepEqual(scope.terminal_event, identity);
    assert.equal(scope.closed_at, terminal.ts);
    assert.deepEqual(Object.keys(ws.terminal_events[0]).sort(), ['checksum', 'seq']);
    assert.deepEqual(nextAction(state, { now: Date.parse(NOW) }).gate.unconsumed_milestones, []);
  });
}

test('public terminal accepts a rejection resolved by a newer approval across 999 to 1000', () => {
  for (const status of ['ready', 'abandoned']) {
    const f = seedReviewed();
    const state = readState(f.root, f.runId).data;
    state.episodes.push(
      {
        id: '999-subagent-checker',
        plugin: 'subagent-checker',
        role: 'checker',
        kind: 'implementation-review',
        point: 'implementation',
        workstream_id: f.ws,
        target_maker: f.baseline,
        status: 'rejected',
        request_rel: 'episodes/999-subagent-checker/request.md',
      },
      {
        id: '1000-subagent-checker',
        plugin: 'subagent-checker',
        role: 'checker',
        kind: 'implementation-review',
        point: 'implementation',
        workstream_id: f.ws,
        target_maker: f.baseline,
        status: 'approved',
        request_rel: 'episodes/1000-subagent-checker/request.md',
      },
    );
    writeState(f.root, f.runId, state);

    const result = runCli(f.root, f.runId, terminalArgs(f.ws, status));
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test('public terminal accepts a rejection resolved by a later done and approved maker', () => {
  for (const status of ['ready', 'abandoned']) {
    const f = seedReviewed();
    const rejectedMaker = addDoneMaker(f, `${status}-rejected`);
    const rejectedChecker = dispatchReview(f.root, f.runId, {
      point: 'implementation', workstreamId: f.ws, detected: {}, fence: f.f,
    }).checkerEpisodeId;
    recordReviewOutcome(f.root, f.runId, {
      episodeId: rejectedChecker, verdict: 'REQUEST_CHANGES', fence: f.f,
    });
    const resolvedMaker = addDoneMaker(f, `${status}-resolved`);
    addApprovedReview(f, resolvedMaker, `${status}-resolved`);
    assert.ok(rejectedMaker);

    const result = runCli(f.root, f.runId, terminalArgs(f.ws, status));
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test('unsupported legacy checker history is neutral at the public terminal boundary', () => {
  for (const status of ['ready', 'abandoned']) {
    const f = seedReviewed();
    const state = readState(f.root, f.runId).data;
    state.episodes.push({
      id: '999-standalone',
      plugin: 'standalone',
      role: 'checker',
      kind: 'implementation-review',
      point: 'implementation',
      workstream_id: f.ws,
      target_maker: f.baseline,
      status: 'rejected',
      request_rel: 'episodes/999-standalone/request.md',
    });
    writeState(f.root, f.runId, state);

    const result = runCli(f.root, f.runId, terminalArgs(f.ws, status));
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test('confirmed abandonment accepts a fully cancelled workstream', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-workstream-fully-cancelled-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', now: new Date('2026-07-23T00:00:00.000Z'),
  });
  const f = {
    root, runId, f: fence(runId),
    worktree: '.claude/worktrees/fully-cancelled',
  };
  mkdirSync(join(root, f.worktree), { recursive: true });
  f.ws = newWorkstream(root, runId, {
    title: 'fully cancelled', branch: 'feature/fully-cancelled',
    worktree: f.worktree, fence: f.f,
  }).id;
  const pending = addMaker(f, 'cancelled-before-work');
  recordEpisode(root, runId, pending.id, { status: 'in_progress', fence: f.f });
  abandonEpisode(root, runId, pending.id, {
    reason: 'cancelled before work', confirm: true, fence: f.f,
  });

  const result = runCli(f.root, f.runId, terminalArgs(f.ws, 'abandoned'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('ready to merged is lifecycle-only and cannot alter the closed boundary', () => {
  const f = seedReviewed();
  assert.equal(runCli(f.root, f.runId, terminalArgs(f.ws, 'ready')).status, 0);
  const ready = readState(f.root, f.runId).data;
  const readyWs = ready.workstreams.find(item => item.id === f.ws);
  const readyScope = ready.session_chain.sessions.find(session => session.run_id === f.runId).scope;
  const boundary = structuredClone(readyWs.terminal_events);
  const scopeBoundary = structuredClone(readyScope);
  const readyAction = nextAction(ready, { now: Date.parse(NOW) }).action;

  const merged = runCli(f.root, f.runId, terminalArgs(f.ws, 'merged'));
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  const after = readState(f.root, f.runId).data;
  const afterWs = after.workstreams.find(item => item.id === f.ws);
  const afterScope = after.session_chain.sessions.find(session => session.run_id === f.runId).scope;
  assert.equal(afterWs.status, 'merged');
  assert.deepEqual(afterWs.terminal_events, boundary);
  assert.deepEqual(afterScope, scopeBoundary);
  assert.deepEqual(nextAction(after, { now: Date.parse(NOW) }).action, readyAction);
});

for (const status of ['ready', 'abandoned', 'merged']) {
  test(`repeat ${status} terminal rejection preserves every durable byte`, () => {
    const f = seedReviewed();
    if (status === 'merged') {
      assert.equal(runCli(f.root, f.runId, terminalArgs(f.ws, 'ready')).status, 0);
    }
    assert.equal(runCli(f.root, f.runId, terminalArgs(f.ws, status)).status, 0);
    const before = durableBytes(f.root);
    const repeated = runCli(f.root, f.runId, terminalArgs(f.ws, status));
    assert.equal(repeated.status, 1, repeated.stdout + repeated.stderr);
    assert.match(repeated.stderr, /WORKSTREAM_TERMINAL_LOCKED/);
    assert.deepEqual(durableBytes(f.root), before);
  });
}

test('shared closure helper exposes literal order-aware proof defects', () => {
  assert.equal(typeof finishModule.workstreamClosureProofState, 'function');
  const loop = {
    recipe: { id: 'harness-hill-climb' },
    episodes: [
      { id: '001-maker', role: 'maker', status: 'done', point: 'implementation', workstream_id: 'w' },
      { id: '002-checker', role: 'checker', plugin: 'subagent-checker', status: 'approved', point: 'implementation', workstream_id: 'w', target_maker: '001-maker' },
      { id: '003-checker', role: 'checker', plugin: 'subagent-checker', status: 'rejected', point: 'implementation', workstream_id: 'w', target_maker: '001-maker' },
    ],
  };
  const proof = finishModule.workstreamClosureProofState(loop, 'w');
  assert.equal(proof.ok, false);
  assert.deepEqual(proof.unsettledEpisodeIds, ['003-checker']);
  assert.deepEqual(proof.unreviewedMakerIds, []);
  assert.deepEqual(proof.unresolvedRejectionIds, ['003-checker']);
  assert.deepEqual(proof.nonConvergedMakerIds, ['001-maker']);
  assert.ok(proof.missing.includes('unsettled-episodes'));
  assert.ok(proof.missing.includes('unresolved-rejection'));
  assert.ok(proof.missing.includes('non-converged-maker'));
});

function closeWithSibling(runtime = 'claude') {
  const f = seedReviewed(runtime);
  const sibling = newWorkstream(f.root, f.runId, {
    title: 'sibling', branch: 'feature/sibling',
    worktree: '.claude/worktrees/sibling', fence: f.f,
  }).id;
  const closed = runCli(f.root, f.runId, terminalArgs(f.ws, 'ready'));
  assert.equal(closed.status, 0, closed.stdout + closed.stderr);
  const state = readState(f.root, f.runId).data;
  const boundary = state.session_chain.sessions
    .find(session => session.run_id === f.runId).scope.terminal_event;
  return { ...f, sibling, boundary };
}

test('v0.5 handoff derives goalDriven from durable schema for its persistent Codex owner descriptor', {
  skip: process.platform === 'win32' ? 'launch-command.txt spelling is POSIX Codex CLI headless' : false,
}, () => {
  const f = makeGoalFixture({
    runtime: 'codex',
    boundaryMode: 'handoff',
    effort: 'ultra',
    review: {
      points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model',
      flags: [], converge: true, max_review_rounds: 5, require_human_ack: false,
    },
  });
  try {
    const workstream = f.workstream('persistent-owner');
    const maker = createScenarioMaker(f, workstream);
    produceScenarioMaker(f, maker);
    reviewScenarioMaker(f, maker.id);
    const closed = f.cli(['workstream', 'terminal', '--id', workstream.id, '--status', 'ready', '--proof', '{}']);
    assert.equal(closed.exit, 0, closed.stderr);
    const boundary = f.state().session_chain.sessions
      .find(session => session.run_id === f.runId).scope.terminal_event;
    let seen;
    const emitted = emitHandoff(f.root, f.runId, {
      boundaryEvent: boundary,
      reason: 'workstream-terminal',
      trigger: 'workstream-terminal',
      now: Date.parse(NOW),
      expect: { owner: f.runId, generation: 1 },
      env: {},
      descriptorBuilder(options) {
        seen = options;
        return buildRuntimeResumeDescriptor({ ...options, codexExecutable: '/trusted/codex' });
      },
    });

    assert.equal(emitted.ok, true);
    assert.equal(seen.goalDriven, true);
    const launch = readFileSync(join(runDir(f.root, f.runId), 'terminal', 'launch-command.txt'), 'utf8');
    assert.match(launch, /Codex CLI headless/);
    assert.match(readFileSync(emitted.handoffPath, 'utf8'), /persistent goal-owner descriptor/);

    let respawnSeen;
    let spawnedEntry;
    const spawned = respawn(f.root, f.runId, {
      childRunId: emitted.childRunId,
      key: emitted.key,
      handoffRel: emitted.handoffRel,
      headless: true,
      now: Date.parse(NOW) + 1,
      env: {},
      codexExecutable: '/trusted/codex',
      launchCommandBuilder(options) {
        respawnSeen = options;
        return buildLaunchCommand(options);
      },
      spawnFn(entry) {
        spawnedEntry = entry;
        return { ok: true };
      },
    });
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    assert.equal(respawnSeen.goalDriven, true);
    assert.equal(spawnedEntry.captureProviderThreadId, true);
    assert.equal(spawnedEntry.argv.includes('--ephemeral'), false);
  } finally {
    f.cleanup();
  }
});

function realBoundaryFixture() {
  const f = seedReviewed();
  const siblingWorkstream = newWorkstream(f.root, f.runId, {
    title: 'sibling workstream', branch: 'feature/sibling-workstream',
    worktree: '.claude/worktrees/sibling-workstream', fence: f.f,
  }).id;
  const siblingRun = initRun(f.root, {
    runtime: 'claude',
    goal: 'sibling clean run',
    now: new Date(Date.parse(NOW) + 1),
  });
  recordWorkstreamTerminal(f.root, f.runId, f.ws, {
    status: 'ready', proof: {}, fence: f.f, now: Date.parse(NOW),
  });
  const { data } = readState(f.root, f.runId);
  const boundary = data.session_chain.sessions
    .find(session => session.run_id === f.runId).scope.terminal_event;
  assert.deepEqual(boundary, nextAction(data, { now: Date.parse(NOW) }).action.boundary_event);
  return { ...f, siblingWorkstream, siblingRunId: siblingRun.runId, boundary };
}

test('R15-REAL-COMMITTED-BOUNDARY preserves committed publication through verified capture and resume', () => {
  const f = realBoundaryFixture();
  const beforeEmit = {
    a: durableRunBytes(f.root, f.runId),
    b: durableRunBytes(f.root, f.siblingRunId),
  };
  const emitted = emitHandoff(f.root, f.runId, {
    boundaryEvent: f.boundary,
    reason: 'workstream-terminal',
    trigger: 'workstream-terminal',
    now: Date.parse(NOW),
    expect: { owner: f.runId, generation: 1 },
    env: {},
  });
  assert.equal(emitted.ok, true);
  assert.equal(emitted.idempotent, false);
  assert.match(emitted.key, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  const committedPath = join(runDir(f.root, f.runId), 'transactions', emitted.key, 'committed.json');
  assert.equal(readFileSync(committedPath).length > 0, true);
  const afterEmit = {
    a: durableRunBytes(f.root, f.runId),
    b: durableRunBytes(f.root, f.siblingRunId),
  };
  assert.notDeepEqual(afterEmit.a, beforeEmit.a);
  assert.deepEqual(afterEmit.b, beforeEmit.b);

  const verified = captureVerifiedRunSnapshot(f.root, f.runId, {
    artifactRels: ['terminal/launch-command.txt', 'terminal/launch-command.meta.json'],
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.kind, 'clean-committed');
  assert.deepEqual(durableRunBytes(f.root, f.runId), afterEmit.a);
  assert.deepEqual(durableRunBytes(f.root, f.siblingRunId), afterEmit.b);

  const resumeSource = readFileSync(CLI, 'utf8');
  const resumeStart = resumeSource.indexOf("'resume-command'");
  assert.ok(resumeStart >= 0);
  const resumeRoute = resumeSource.slice(resumeStart, resumeSource.indexOf("\n  },", resumeStart));
  assert.match(resumeRoute, /captureVerifiedRunSnapshot/);
  assert.doesNotMatch(resumeRoute, /captureReconciledRunSnapshot/);
  const resumed = spawnSync(process.execPath, [
    CLI, 'resume-command', '--project-root', f.root, '--run-id', f.runId,
  ], { encoding: 'utf8' });
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.deepEqual(durableRunBytes(f.root, f.runId), afterEmit.a);
  assert.deepEqual(durableRunBytes(f.root, f.siblingRunId), afterEmit.b);
});

test('public next-action renders one exact closed boundary while the pure action retains its object identity', () => {
  const f = closeWithSibling();
  const pure = nextAction(readState(f.root, f.runId).data, { now: Date.parse(NOW) });
  assert.deepEqual(pure.action, {
    type: 'handoff', reason: 'workstream-terminal', boundary_event: f.boundary,
  });
  assert.equal(typeof pure.action.boundary_event, 'object');
  assert.deepEqual(pure.gate.unconsumed_milestones, []);

  const cli = runReadCli(f.root, f.runId, ['next-action', '--now', NOW]);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const rendered = JSON.parse(cli.stdout);
  assert.equal(rendered.action.boundary_event, `${f.boundary.seq}:${f.boundary.checksum}`);
});

test('public boundary handoff journals four artifacts, exact topology, one event, and no structured milestone cursor', () => {
  const f = closeWithSibling();
  const siblingBoundary = { seq: f.boundary.seq + 100, checksum: 'b'.repeat(64) };
  const before = readState(f.root, f.runId).data;
  before.workstreams.find(ws => ws.id === f.sibling).terminal_events = [siblingBoundary];
  writeState(f.root, f.runId, before);

  const emitted = emitHandoff(f.root, f.runId, {
    boundaryEvent: f.boundary,
    reason: 'workstream-terminal',
    trigger: 'workstream-terminal',
    now: Date.parse(NOW),
    expect: { owner: f.runId, generation: 1 },
    env: {},
  });
  assert.equal(emitted.ok, true);
  const after = readState(f.root, f.runId).data;
  const lease = after.session_chain.lease;
  const parent = after.session_chain.sessions.find(session => session.run_id === f.runId);
  const child = after.session_chain.sessions.find(session => session.run_id === emitted.childRunId);
  assert.deepEqual(lease.handoff_boundary_event, f.boundary);
  assert.equal(lease.handoff_project_binding_generation, after.project.binding_generation);
  assert.equal(lease.handoff_project_root_digest, projectRootDigest(after.project.root));
  assert.equal(lease.takeover_kind, 'boundary-handoff');
  assert.equal(parent.superseded_by, emitted.childRunId);
  assert.equal(child.parent_run_id, f.runId);
  assert.deepEqual(child.parent_boundary_event, f.boundary);
  assert.equal(child.project_binding_generation, after.project.binding_generation);
  assert.equal(child.project_root_digest, projectRootDigest(after.project.root));
  assert.equal(child.scope.workstream_id, null);
  assert.equal(child.scope.terminal_event, null);
  assert.deepEqual(after.session_chain.consumed_milestones, []);
  assert.deepEqual(after.workstreams.find(ws => ws.id === f.sibling).terminal_events, [siblingBoundary]);

  const dir = runDir(f.root, f.runId);
  const artifactRels = [
    emitted.handoffRel,
    `handoffs/${emitted.csName}`,
    'terminal/launch-command.txt',
    'terminal/launch-command.meta.json',
  ];
  for (const rel of artifactRels) assert.equal(readFileSync(join(dir, ...rel.split('/'))).length > 0, true, rel);
  const metaBytes = readFileSync(join(dir, 'terminal', 'launch-command.meta.json'));
  const meta = JSON.parse(metaBytes);
  assert.equal(meta.envelope.artifact_kind, 'launch-command-meta');
  assert.equal(meta.payload.launch_command_sha256, contentHash(readFileSync(join(dir, 'terminal', 'launch-command.txt'))));
  assert.deepEqual(meta.payload.boundary_event, f.boundary);
  assert.equal(meta.payload.parent_run_id, f.runId);
  assert.equal(meta.payload.child_run_id, emitted.childRunId);
  const operationDir = join(dir, 'transactions', emitted.key);
  const prepared = JSON.parse(readFileSync(join(operationDir, 'prepared.json'), 'utf8'));
  assert.deepEqual(prepared.payload.manifest.targets.map(target => target.rel), artifactRels);
  assert.equal(prepared.payload.manifest.eventLines.length, 2);

  const retryBytes = durableBytes(f.root);
  const retry = emitHandoff(f.root, f.runId, {
    boundaryEvent: f.boundary,
    reason: 'workstream-terminal',
    trigger: 'workstream-terminal',
    now: Date.parse(NOW),
    expect: { owner: f.runId, generation: 1 },
    env: {},
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.idempotent, true);
  assert.deepEqual(durableBytes(f.root), retryBytes);

  const acquired = acquireLease(f.root, f.runId, {
    owner: emitted.childRunId, expectGeneration: 1, runtime: 'claude',
    now: Date.parse(NOW) + 1,
  });
  assert.equal(acquired.ok, true);
  const acquiredState = readState(f.root, f.runId).data;
  assert.equal(acquiredState.session_chain.lease.takeover_kind, null);
  assert.equal(acquiredState.session_chain.lease.handoff_boundary_event, undefined);
  assert.equal(acquiredState.session_chain.sessions
    .find(session => session.run_id === emitted.childRunId).started_at,
  new Date(Date.parse(NOW) + 1).toISOString());
  assert.equal(acquiredState.session_chain.sessions
    .find(session => session.run_id === f.runId).outcome, 'took_over');

  mkdirSync(join(f.root, '.claude/worktrees/sibling'), { recursive: true });
  const nextMaker = newEpisode(f.root, f.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: f.sibling, expectedArtifacts: ['.claude/worktrees/sibling/next.txt'],
    fence: fence(emitted.childRunId, 2),
  }).id;
  recordEpisode(f.root, f.runId, nextMaker, {
    status: 'in_progress', fence: fence(emitted.childRunId, 2),
  });
  assert.equal(readState(f.root, f.runId).data.session_chain.sessions
    .find(session => session.run_id === emitted.childRunId).scope.workstream_id, f.sibling);
});

test('expired boundary reservations remain exclusive to the exact child and reject unrelated owners byte-for-byte', () => {
  const f = closeWithSibling();
  const emitted = emitHandoff(f.root, f.runId, {
    boundaryEvent: f.boundary,
    reason: 'workstream-terminal',
    trigger: 'workstream-terminal',
    now: Date.parse(NOW),
    expect: { owner: f.runId, generation: 1 },
    env: {},
  });
  captureReconciledRunSnapshot(f.root, f.runId);
  const dir = runDir(f.root, f.runId);
  const before = ['loop.json', '.loop.hash', 'event-log.jsonl']
    .map(name => readFileSync(join(dir, name)));
  const unrelated = acquireLease(f.root, f.runId, {
    owner: '01KUNRELATEDOWNER0000000000',
    expectGeneration: 1,
    runtime: 'claude',
    now: Date.parse(NOW) + (16 * 60 * 1000),
  });
  assert.deepEqual(unrelated, {
    ok: false,
    generation: 1,
    reason: 'child-not-reserved',
    // 의도된 shape 변경 — spec §3.1 의 응답 계약 3필드는 모든 반환 객체에 존재한다.
    proceed: false,
    consumed: null,
    replayed: false,
  });
  assert.deepEqual(
    ['loop.json', '.loop.hash', 'event-log.jsonl'].map(name => readFileSync(join(dir, name))),
    before,
  );

  const acquired = acquireLease(f.root, f.runId, {
    owner: emitted.childRunId,
    expectGeneration: 1,
    runtime: 'claude',
    now: Date.parse(NOW) + (16 * 60 * 1000),
  });
  assert.equal(acquired.ok, true);
});

test('new-policy Codex boundary key constructs and settles a real terminal maker receipt', () => {
  const f = closeWithSibling('codex');
  const emitted = emitHandoff(f.root, f.runId, {
    boundaryEvent: f.boundary,
    reason: 'workstream-terminal',
    trigger: 'workstream-terminal',
    now: Date.parse(NOW),
    expect: { owner: f.runId, generation: 1 },
    env: {},
  });
  assert.match(emitted.key, /^[a-f0-9]{64}$/);
  const usage = { num_turns: 1, input_tokens: 5, output_tokens: 7, tokens: 12 };
  const receipt = makeCodexProcessReceipt({
    root: f.root,
    runId: f.runId,
    processKind: 'maker',
    context: {
      parent_owner: f.runId,
      parent_generation: 1,
      child_run_id: emitted.childRunId,
      child_generation: 2,
      handoff_key: emitted.key,
      handoff_rel: emitted.handoffRel,
    },
    usage,
  });
  assert.equal(acquireLease(f.root, f.runId, {
    owner: emitted.childRunId,
    expectGeneration: 1,
    runtime: 'codex',
    now: Date.parse(NOW) + 1,
  }).ok, true);
  finishRun(f.root, f.runId, {
    status: 'stopped',
    confirm: true,
    proof: { human_reason: 'public terminal accounting integration' },
    fence: { owner: emitted.childRunId, generation: 2, intent: 'business' },
    now: Date.parse(NOW) + 2,
  });
  assert.deepEqual(settleCodexProcessCost(f.root, f.runId, {
    receipt,
    fence: { owner: emitted.childRunId, generation: 2, intent: 'accounting' },
  }), { ok: true, recorded: true, reason: 'recorded' });
  assert.equal(readState(f.root, f.runId).data.budget.tokens_spent, 12);
});

test('resume-command trusts exact boundary launch metadata and falls back after retired-journal metadata drift', () => {
  for (const [label, mutate] of [
    ['envelope-extra', meta => { meta.envelope.extra = true; }],
    ['payload-extra', meta => { meta.payload.extra = true; }],
    ['schema-version', meta => { meta.envelope.schema.version = '9.9'; }],
    ['timestamp', meta => { meta.envelope.generated_at = '2026-07-23T04:05:06Z'; }],
  ]) {
    const f = closeWithSibling();
    const emitted = emitHandoff(f.root, f.runId, {
      boundaryEvent: f.boundary,
      reason: 'workstream-terminal',
      trigger: 'workstream-terminal',
      now: Date.parse(NOW),
      expect: { owner: f.runId, generation: 1 },
      env: {},
    });
    const dir = runDir(f.root, f.runId);
    const launch = readFileSync(join(dir, 'terminal', 'launch-command.txt'), 'utf8').trimEnd();
    const exact = runReadCli(f.root, f.runId, ['resume-command']);
    assert.equal(exact.status, 0, exact.stdout + exact.stderr);
    assert.ok(exact.stdout.includes(launch), `${label}: exact metadata must bind launch text`);

    rmSync(join(dir, 'transactions', emitted.key), { recursive: true });
    const metaPath = join(dir, 'terminal', 'launch-command.meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    mutate(meta);
    writeFileSync(metaPath, JSON.stringify(meta));
    const fallback = runReadCli(f.root, f.runId, ['resume-command']);
    assert.equal(fallback.status, 0, fallback.stdout + fallback.stderr);
    assert.ok(!fallback.stdout.includes(launch), `${label}: drifted metadata must be ignored`);
    assert.match(fallback.stdout, /Launcher guidance:/);
    assert.ok(fallback.stdout.includes(emitted.childRunId));
  }
});

test('public boundary emit rejects missing, forged, sibling, safety-blocked, and finish-ready calls before bytes', () => {
  {
    const f = closeWithSibling();
    const before = durableBytes(f.root);
    const missing = runCli(f.root, f.runId, [
      'handoff', 'emit', '--reason', 'workstream-terminal',
    ]);
    assert.equal(missing.status, 2, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /boundary-event/i);
    assert.deepEqual(durableBytes(f.root), before);
  }

  for (const [label, boundary] of [
    ['forged', { seq: 999, checksum: 'f'.repeat(64) }],
    ['sibling', { seq: 1000, checksum: 'e'.repeat(64) }],
  ]) {
    const f = closeWithSibling();
    if (label === 'sibling') {
      const state = readState(f.root, f.runId).data;
      state.workstreams.find(ws => ws.id === f.sibling).terminal_events = [boundary];
      writeState(f.root, f.runId, state);
    }
    const before = durableBytes(f.root);
    assert.throws(() => emitHandoff(f.root, f.runId, {
      boundaryEvent: boundary, reason: 'workstream-terminal', trigger: 'workstream-terminal',
      now: Date.parse(NOW), expect: { owner: f.runId, generation: 1 }, env: {},
    }), /BOUNDARY_EVENT_MISMATCH/);
    assert.deepEqual(durableBytes(f.root), before);
  }

  for (const gate of ['budget', 'breaker']) {
    const f = closeWithSibling();
    const state = readState(f.root, f.runId).data;
    if (gate === 'budget') state.budget.spent = state.budget.total;
    else state.circuit_breaker.tripped = true;
    writeState(f.root, f.runId, state);
    const before = durableBytes(f.root);
    assert.throws(() => emitHandoff(f.root, f.runId, {
      boundaryEvent: f.boundary, reason: 'workstream-terminal', trigger: 'workstream-terminal',
      now: Date.parse(NOW), expect: { owner: f.runId, generation: 1 }, env: {},
    }), new RegExp(gate === 'budget' ? 'BUDGET_BLOCKED' : 'BREAKER_BLOCKED'));
    assert.deepEqual(durableBytes(f.root), before);
  }

  {
    const f = seedReviewed();
    assert.equal(runCli(f.root, f.runId, terminalArgs(f.ws, 'ready')).status, 0);
    const boundary = readState(f.root, f.runId).data.session_chain.sessions[0].scope.terminal_event;
    const before = durableBytes(f.root);
    assert.throws(() => emitHandoff(f.root, f.runId, {
      boundaryEvent: boundary, reason: 'workstream-terminal', trigger: 'workstream-terminal',
      now: Date.parse(NOW), expect: { owner: f.runId, generation: 1 }, env: {},
    }), /FINISH_REQUIRED/);
    assert.deepEqual(durableBytes(f.root), before);
  }
});

test('boundary publication rechecks budget, breaker, finish, scope, and history after reservation', () => {
  for (const [label, boundaryName, mutate, error] of [
    ['budget', 'reserved', state => { state.budget.spent = state.budget.total; }, /BUDGET_BLOCKED/],
    ['breaker', 'reserved', state => { state.circuit_breaker.tripped = true; }, /BREAKER_BLOCKED/],
    ['finish', 'artifacts-generated', state => {
      const sibling = state.workstreams.find(ws => ws.status === 'planned');
      sibling.status = 'abandoned';
      sibling.review_points_done = ['implementation'];
      state.active_workstreams = [];
    }, /FINISH_REQUIRED/],
    ['scope', 'artifacts-generated', state => {
      state.session_chain.sessions[0].scope.terminal_event = {
        seq: 999, checksum: 'd'.repeat(64),
      };
    }, /BOUNDARY_EVENT_MISMATCH/],
    ['history', 'artifacts-generated', state => {
      state.workstreams.find(ws => ws.id === state.session_chain.sessions[0].scope.workstream_id)
        .terminal_events = [];
    }, /BOUNDARY_EVENT_MISMATCH/],
  ]) {
    const f = closeWithSibling();
    assert.throws(() => emitHandoff(f.root, f.runId, {
      boundaryEvent: f.boundary,
      reason: 'workstream-terminal',
      trigger: 'workstream-terminal',
      now: Date.parse(NOW),
      expect: { owner: f.runId, generation: 1 },
      env: {},
      onBoundary(name) {
        if (name !== boundaryName) return;
        const state = readState(f.root, f.runId).data;
        mutate(state);
        writeState(f.root, f.runId, state);
      },
    }), error, label);
    const state = readState(f.root, f.runId).data;
    assert.equal(state.session_chain.lease.handoff_phase, 'idle', label);
    assert.equal(state.session_chain.lease.handoff_child_run_id, null, label);
    assert.equal(state.session_chain.sessions.length, 1, label);
  }
});

test('prepared boundary publication replays exactly once and rejects forged manifest topology', () => {
  {
    const f = closeWithSibling();
    let faulted = false;
    assert.throws(() => emitHandoff(f.root, f.runId, {
      boundaryEvent: f.boundary,
      reason: 'workstream-terminal',
      trigger: 'workstream-terminal',
      now: Date.parse(NOW),
      expect: { owner: f.runId, generation: 1 },
      env: {},
      publicationFaultAt(label) {
        if (!faulted && label === 'artifact:0:target-done') {
          faulted = true;
          throw new Error('prepared-boundary-fault');
        }
      },
    }), /TRANSACTION_PENDING/);
    const retry = emitHandoff(f.root, f.runId, {
      boundaryEvent: f.boundary,
      reason: 'workstream-terminal',
      trigger: 'workstream-terminal',
      now: Date.parse(NOW),
      expect: { owner: f.runId, generation: 1 },
      env: {},
    });
    assert.equal(retry.idempotent, true);
    const log = readFileSync(join(runDir(f.root, f.runId), 'event-log.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(log.filter(event => event.type === 'handoff-emitted').length, 1);
  }

  {
    const f = closeWithSibling();
    let faulted = false;
    assert.throws(() => emitHandoff(f.root, f.runId, {
      boundaryEvent: f.boundary,
      reason: 'workstream-terminal',
      trigger: 'workstream-terminal',
      now: Date.parse(NOW),
      expect: { owner: f.runId, generation: 1 },
      env: {},
      publicationFaultAt(label) {
        if (!faulted && label === 'artifact:0:target-done') {
          faulted = true;
          throw new Error('prepared-boundary-fault');
        }
      },
    }), /TRANSACTION_PENDING/);
    const state = readState(f.root, f.runId).data;
    const preparedPath = join(
      runDir(f.root, f.runId),
      'transactions',
      state.session_chain.lease.handoff_idempotency_key,
      'prepared.json',
    );
    const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
    prepared.payload.manifest.topology.boundary_event = {
      seq: f.boundary.seq + 1,
      checksum: 'f'.repeat(64),
    };
    writeFileSync(preparedPath, JSON.stringify(prepared));
    assert.throws(
      () => captureReconciledRunSnapshot(f.root, f.runId),
      /TRANSACTION_RECONCILIATION_REQUIRED: boundary publication/,
    );
  }

  {
    const f = closeWithSibling();
    let faulted = false;
    assert.throws(() => emitHandoff(f.root, f.runId, {
      boundaryEvent: f.boundary,
      reason: 'workstream-terminal',
      trigger: 'workstream-terminal',
      now: Date.parse(NOW),
      expect: { owner: f.runId, generation: 1 },
      env: {},
      publicationFaultAt(label) {
        if (!faulted && label === 'artifact:0:target-done') {
          faulted = true;
          throw new Error('prepared-boundary-fault');
        }
      },
    }), /TRANSACTION_PENDING/);
    const state = readState(f.root, f.runId).data;
    const operationDir = join(
      runDir(f.root, f.runId),
      'transactions',
      state.session_chain.lease.handoff_idempotency_key,
    );
    const preparedPath = join(operationDir, 'prepared.json');
    const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
    const metaIndex = prepared.payload.manifest.targets[3].stage_index;
    const metaPath = join(operationDir, 'stages', `${String(metaIndex).padStart(6, '0')}.bin`);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    meta.payload.unreviewed_extra = true;
    const bytes = Buffer.from(JSON.stringify(meta, null, 2));
    writeFileSync(metaPath, bytes);
    prepared.payload.stages[metaIndex].sha256 = contentHash(bytes);
    prepared.payload.stages[metaIndex].size = String(bytes.length);
    prepared.payload.manifest.targets[3].candidate_sha256 = contentHash(bytes);
    prepared.payload.manifest.targets[3].candidate_size = String(bytes.length);
    writeFileSync(preparedPath, JSON.stringify(prepared));
    assert.throws(
      () => captureReconciledRunSnapshot(f.root, f.runId),
      /TRANSACTION_RECONCILIATION_REQUIRED: boundary publication metadata/,
    );
  }
});

test('respawn refuses forged boundary topology before claim or external spawn', () => {
  const f = closeWithSibling();
  const emitted = emitHandoff(f.root, f.runId, {
    boundaryEvent: f.boundary,
    reason: 'workstream-terminal',
    trigger: 'workstream-terminal',
    now: Date.parse(NOW),
    expect: { owner: f.runId, generation: 1 },
    env: {},
  });
  appendAnchored(f.root, f.runId, {
    type: 'test-boundary-forgery',
    data: {},
    now: Date.parse(NOW) + 1,
  }, state => {
    state.session_chain.sessions.find(session => session.run_id === emitted.childRunId)
      .parent_boundary_event = { seq: f.boundary.seq + 1, checksum: 'e'.repeat(64) };
  });
  let spawned = 0;
  const result = respawn(f.root, f.runId, {
    childRunId: emitted.childRunId,
    key: emitted.key,
    handoffRel: emitted.handoffRel,
    headless: true,
    now: Date.parse(NOW) + 1,
    spawnFn: () => { spawned += 1; return { ok: true }; },
    expect: { owner: f.runId, generation: 1 },
    env: {},
  });
  assert.equal(result.outcome, 'boundary-invalid');
  assert.equal(spawned, 0);
  assert.equal(readState(f.root, f.runId).data.session_chain.lease.handoff_phase, 'emitted');
});

test('spawn claim compensates every ordered boundary gate before external spawn', () => {
  for (const [label, mutate, reason, compensation] of [
    ['budget', state => { state.budget.total = state.budget.spent; }, 'budget', 'pause'],
    ['breaker', state => { state.circuit_breaker.tripped = true; }, 'breaker', 'pause'],
    ['finish', state => {
      state.workstreams.find(ws => ws.status === 'planned').status = 'abandoned';
      state.active_workstreams = [];
    }, 'FINISH_REQUIRED', 'finish'],
    ['boundary', state => {
      state.session_chain.sessions.find(session =>
        session.run_id === state.session_chain.lease.handoff_child_run_id)
        .parent_boundary_event = { seq: 999, checksum: 'd'.repeat(64) };
    }, 'boundary-topology-invalid', 'preserve'],
    ['max-sessions', state => { state.autonomy.max_sessions = 1; }, 'max_sessions', 'pause'],
    ['wallclock', state => { state.budget.max_wallclock_sec = 1; }, 'wallclock', 'pause'],
    ['auto-handoff', state => { state.autonomy.auto_handoff = false; }, 'auto_handoff', 'pause'],
  ]) {
    const f = closeWithSibling();
    const emitted = emitHandoff(f.root, f.runId, {
      boundaryEvent: f.boundary,
      reason: 'workstream-terminal',
      trigger: 'workstream-terminal',
      now: Date.parse(NOW),
      expect: { owner: f.runId, generation: 1 },
      env: {},
      headless: true,
    });
    let spawned = 0;
    const result = respawn(f.root, f.runId, {
      childRunId: emitted.childRunId,
      key: emitted.key,
      handoffRel: emitted.handoffRel,
      headless: true,
      now: Date.parse(NOW) + 1,
      beforeClaim() {
        const state = readState(f.root, f.runId).data;
        mutate(state);
        writeState(f.root, f.runId, state);
      },
      spawnFn: () => { spawned += 1; return { ok: true }; },
      expect: { owner: f.runId, generation: 1 },
      env: {},
      platform: 'linux',
    });
    assert.equal(spawned, 0, label);
    assert.equal(result.ok, false, label);
    assert.equal(result.reason, reason, label);
    const state = readState(f.root, f.runId).data;
    const lease = state.session_chain.lease;
    const parent = state.session_chain.sessions.find(session => session.run_id === f.runId);
    const child = state.session_chain.sessions.find(session => session.run_id === emitted.childRunId);
    assert.deepEqual(parent.scope.terminal_event, f.boundary, label);
    assert.deepEqual(lease.handoff_project_root_digest === undefined
      ? child.project_root_digest
      : lease.handoff_project_root_digest, projectRootDigest(state.project.root), label);
    if (compensation === 'preserve') {
      assert.equal(result.outcome, 'boundary-invalid', label);
      assert.equal(state.status, 'running', label);
      assert.equal(lease.state, 'releasing', label);
      assert.equal(lease.handoff_phase, 'emitted', label);
      assert.equal(lease.handoff_child_run_id, emitted.childRunId, label);
      assert.notEqual(child.outcome, 'failed_launch', label);
      assert.equal(parent.superseded_by, emitted.childRunId, label);
      continue;
    }
    assert.equal(result.outcome, 'gate-blocked', label);
    assert.equal(lease.state, 'active', label);
    assert.equal(lease.handoff_phase, 'idle', label);
    assert.equal(lease.handoff_child_run_id, null, label);
    assert.equal(lease.takeover_kind, null, label);
    assert.equal(lease.handoff_boundary_event, undefined, label);
    assert.equal(lease.handoff_project_binding_generation, undefined, label);
    assert.equal(lease.handoff_project_root_digest, undefined, label);
    assert.equal(child.outcome, 'failed_launch', label);
    assert.deepEqual(child.parent_boundary_event, f.boundary, label);
    assert.equal(parent.superseded_by, null, label);
    assert.equal(parent.scope.superseded_at, null, label);
    if (compensation === 'pause') {
      assert.equal(state.status, 'paused', label);
      assert.equal(state.pause_reason, `gate:${reason}`, label);
      continue;
    }
    assert.equal(state.status, 'running', label);
    assert.notEqual(state.pause_reason, `gate:${reason}`, label);
    assert.equal(nextAction(state, { now: Date.parse(NOW) + 1 }).action.type, 'finish', label);
    writeFileSync(join(runDir(f.root, f.runId), 'final-report.md'), '# complete');
    assert.equal(finishRun(f.root, f.runId, {
      status: 'completed',
      reportRel: 'final-report.md',
      proof: {},
      fence: f.f,
      now: Date.parse(NOW) + 2,
    }).ok, true, label);
  }
});

test('resume-command trusts the journaled launch text only with exact M3 boundary topology', () => {
  const f = closeWithSibling();
  const emitted = emitHandoff(f.root, f.runId, {
    boundaryEvent: f.boundary,
    reason: 'workstream-terminal',
    trigger: 'workstream-terminal',
    now: Date.parse(NOW),
    expect: { owner: f.runId, generation: 1 },
    env: {},
  });
  const launch = readFileSync(
    join(runDir(f.root, f.runId), 'terminal', 'launch-command.txt'),
    'utf8',
  ).trimEnd();
  const result = runReadCli(f.root, f.runId, ['resume-command']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes('Launcher guidance (from launch-command.txt):'));
  assert.ok(result.stdout.includes(launch));
  assert.ok(result.stdout.includes(`child_run_id=${emitted.childRunId}`));
});
