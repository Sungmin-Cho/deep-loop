import { createGoalPlanController, issueGoalExecutionPlan, expireGoalPlanController } from '../scripts/lib/goal-execution-plan.mjs';
import { prepareExecution, returnExecution } from '../scripts/lib/execution.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import {
  blockIndependentReview,
  claimIndependentReview,
  dispatchReview,
  findPendingIndependentChecker,
  importReviewOutcome,
  recordReviewOutcome,
} from '../scripts/lib/review.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';
import { driveHeadlessRun } from '../scripts/lib/headless-host.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { recordCost } from '../scripts/lib/budget.mjs';
import { finishRun } from '../scripts/lib/finish.mjs';
import { verifyHead, verifyLog } from '../scripts/lib/integrity.mjs';
import { canonicalRealpath } from './helpers/fs-fixtures.mjs';
import { migrateAuthenticLegacyTransport } from './helpers/legacy-transport.mjs';
import { recordWorkstreamTerminal } from '../scripts/lib/workspace.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const FIXED_NOW = '2026-07-11T01:00:00.000Z';

function events(root, runId) {
  const path = join(runDir(root, runId), 'event-log.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function seed({ reviewer = 'deep-review', newPolicy = false, observation = false, goalDriven = false, review, model, effort } = {}) {
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-checker-int-')));
  const detected = reviewer === 'deep-review' ? { 'deep-review': true } : { 'deep-review': false };
  const { runId } = initRun(root, {
    runtime: 'codex', goal: 'g', detected, review, model, effort, now: new Date('2026-07-11T00:00:00Z'),
    env: {}, platform: 'linux', run: () => ({ code: 1 }),
    ...(goalDriven ? {goalContract:{version:1,requirements:[{id:'REQ-A',statement:'Deliver A',acceptance:'Artifact is correct'}],non_goals:[]}} : {}),
  });
  if (!newPolicy && !goalDriven) migrateAuthenticLegacyTransport(root, runId);
  const fence = { owner: runId, generation: 1, intent: 'business' };
  if (observation) {
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.22.0' }));
    const observable = readState(root, runId).data;
    observable.project.git = true;
    observable.project.head = 'abcdef1';
    observable.project.branch = 'feat/checker-observation-order';
    writeState(root, runId, observable);
  }
  const worktree = '.claude/worktrees/w';
  const artifact = `${worktree}/artifact.txt`;
  mkdirSync(join(root, worktree), { recursive: true });
  const bytes = Buffer.from('maker artifact bytes');
  writeFileSync(join(root, artifact), bytes);
  const ws = newWorkstream(root, runId, { title: 'w', branch: 'b', worktree, fence, ...(goalDriven?{requirementIds:['REQ-A']}: {}) }).id;
  const makerId = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: [artifact], fence,
  }).id;
  if(goalDriven){const prepared=prepareExecution(root,runId,{episodeId:makerId,mode:'inline',task:'Deliver A',fence,now:FIXED_NOW});returnExecution(root,runId,{episodeId:makerId,attemptId:prepared.execution.attempt_id,artifacts:[artifact],fence,now:FIXED_NOW});}
  else {recordEpisode(root, runId, makerId, { status: 'in_progress', fence });
  recordEpisode(root, runId, makerId, { status: 'done', artifacts: [artifact], fence });}
  const checkerId = dispatchReview(root, runId, {
    point: 'implementation', workstreamId: ws, detected,
    independentSubagent: reviewer !== 'deep-review', fence,
  }).checkerEpisodeId;
  return { root, runId, fence, worktree, artifact, bytes, ws, makerId, checkerId, reviewer };
}

function approveCodexRuntime(f) {
  const state = readState(f.root, f.runId).data;
  state.autonomy.spawn_style = 'headless';
  state.autonomy.runtime_executable_approval = {
    runtime: 'codex', canonical_path: '/opt/codex/bin/codex', sha256: 'e'.repeat(64),
    version: '0.144.1', platform: process.platform, arch: process.arch,
    source: 'human-explicit', package: null, authenticode: null,
    approved_by: 'human', approved_at: '2026-07-11T00:00:00.000Z',
  };
  writeState(f.root, f.runId, state);
  return state.autonomy.runtime_executable_approval;
}

function measuredUsage() {
  return { num_turns: 1, tokens: 12, input_tokens: 5, output_tokens: 7 };
}

function hostDeps(f, { verdict = 'APPROVE', reviewer = f.reviewer } = {}) {
  const executable = approveCodexRuntime(f);
  const skillIdentity = {
    plugin_directory: { canonical_path: '/codex/plugins/cache/deep-review/1.0.0', device: '1', inode: '2', mode: '3' },
    manifest: { canonical_path: '/codex/plugins/cache/deep-review/1.0.0/.codex-plugin/plugin.json', sha256: '1'.repeat(64) },
    skill: { canonical_path: '/codex/plugins/cache/deep-review/1.0.0/skills/deep-review-loop/SKILL.md', sha256: '2'.repeat(64) },
    plugin_version: '1.0.0',
  };
  const codexHome = { canonical_path: '/home/test/.codex', device: '1', inode: '2', birthtime_ns: '3', platform: process.platform };
  const raw = Buffer.from(JSON.stringify(input(f, 'attempt-host', { verdict, reviewer_id: reviewer })));
  return {
    expect: { owner: f.runId, generation: 1 },
    env: { PATH: '/usr/bin', CODEX_HOME: codexHome.canonical_path },
    revalidateExecutable: () => executable,
    resolveCodexHome: () => codexHome,
    preflightFn: () => ({ ok: true, cache_hit: true, measured_usage: [] }),
    resolveCheckerSkill: () => skillIdentity,
    checkerRunFn: (options) => {
      assert.equal(options.env.DEEP_LOOP_OWNER, f.checkerId, 'read-only checker must not receive the live lease owner');
      assert.notEqual(options.env.DEEP_LOOP_OWNER, f.runId);
      return { ok: true, usage: measuredUsage(), finalMessage: raw };
    },
    checkerImportFn: (_options, bytes) => {
      assert.equal(bytes.equals(raw), true);
      return {
        ok: true,
        value: importReviewOutcome(f.root, f.runId, {
          raw: bytes.toString('utf8'), fence: f.fence, now: FIXED_NOW,
        }),
      };
    },
    recordCostFn: recordCost,
    attemptIdFactory: () => 'attempt-host',
  };
}

function claim(f, attemptId = 'attempt-01') {
  return claimIndependentReview(f.root, f.runId, {
    episodeId: f.checkerId,
    fence: f.fence,
    now: FIXED_NOW,
    attemptIdFactory: () => attemptId,
  });
}

function input(f, attemptId = 'attempt-01', overrides = {}) {
  return {
    schema_version: '1.0',
    reviewer_id: f.reviewer,
    checker_episode_id: f.checkerId,
    target_maker: f.makerId,
    attempt_id: attemptId,
    verdict: 'APPROVE',
    report_body: '# independent review\n\nAPPROVE',
    artifacts: [{ path: f.artifact, sha256: sha256(f.bytes) }],
    ...overrides,
  };
}

test('pending checker discovery prefers eligible current episode then stable episode order', () => {
  const loop = {
    current_episode: 'c2',
    episodes: [
      { id: 'c1', role: 'checker', status: 'pending', requires_independent_session: true },
      { id: 'm1', role: 'maker', status: 'pending' },
      { id: 'c2', role: 'checker', status: 'pending', requires_independent_session: true },
    ],
  };
  assert.equal(findPendingIndependentChecker(loop).id, 'c2');
  loop.current_episode = 'm1';
  assert.equal(findPendingIndependentChecker(loop).id, 'c1');
  loop.episodes[0].status = 'in_progress';
  loop.episodes[2].requires_independent_session = false;
  assert.equal(findPendingIndependentChecker(loop), null);
});

test('durable claim CAS derives one immutable attempt/artifact/root/runtime/lease snapshot', () => {
  const f = seed();
  const before = events(f.root, f.runId).length;
  const first = claim(f);
  const second = claim(f, 'attempt-02');
  assert.equal(first.ok, true);
  assert.equal(first.attemptId, 'attempt-01');
  assert.deepEqual(second, { ok: false, reason: 'already-claimed' });

  const loop = readState(f.root, f.runId).data;
  const checker = loop.episodes.find(e => e.id === f.checkerId);
  assert.equal(checker.status, 'in_progress');
  assert.equal(checker.attempt_id, 'attempt-01');
  assert.deepEqual(checker.review_claim, {
    run_id: f.runId,
    reviewer_id: 'deep-review',
    checker_episode_id: f.checkerId,
    target_maker: f.makerId,
    attempt_id: 'attempt-01',
    workstream_id: f.ws,
    point: 'implementation',
    project_root: f.root,
    runtime: 'codex',
    lease_owner: f.runId,
    lease_generation: 1,
    artifacts: [{ path: f.artifact, sha256: sha256(f.bytes) }],
  });
  const claimed = events(f.root, f.runId).slice(before).filter(event => event.type === 'independent-review-claimed');
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].data.attempt_id, 'attempt-01');
  assert.deepEqual(claimed[0].data.artifacts, checker.review_claim.artifacts);
});

test('claim rejects a malformed reviewed-worktree binding instead of widening containment to project root', () => {
  const f = seed();
  const state = readState(f.root, f.runId).data;
  state.workstreams.find(workstream => workstream.id === f.ws).worktree = '';
  writeState(f.root, f.runId, state);
  const before = events(f.root, f.runId).length;
  assert.throws(() => claim(f), /REVIEW_IMPORT_ARTIFACT_CONTAINMENT/);
  assert.equal(events(f.root, f.runId).length, before);
  assert.equal(readState(f.root, f.runId).data.episodes.find(e => e.id === f.checkerId).status, 'pending');
});

test('blockIndependentReview atomically blocks the exact claim and human-pauses without proof', () => {
  const f = seed();
  claim(f);
  const before = events(f.root, f.runId).length;
  const result = blockIndependentReview(f.root, f.runId, {
    episodeId: f.checkerId,
    attemptId: 'attempt-01',
    reason: 'checker-process-failed',
    fence: f.fence,
  });
  assert.deepEqual(result, { ok: true, status: 'blocked', reason: 'checker-process-failed' });
  const loop = readState(f.root, f.runId).data;
  const checker = loop.episodes.find(e => e.id === f.checkerId);
  assert.equal(checker.status, 'blocked');
  assert.equal(checker.block_reason, 'checker-process-failed');
  assert.equal(checker.needs_human, true);
  assert.equal(checker.review_source, undefined);
  assert.equal(loop.status, 'paused');
  assert.equal(loop.pause_reason, 'independent-review:checker-process-failed');
  assert.equal(loop.session_chain.lease.resume_policy, 'human');
  assert.equal(loop.session_chain.lease.expires_at, null);
  const appended = events(f.root, f.runId).slice(before);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, 'independent-review-blocked');
  assert.equal(appended.some(event => event.type === 'review-outcome'), false);
});

test('claimed import binds attempt and claim-time artifact bytes, then records attempt in envelope/event', () => {
  const f = seed();
  assert.throws(() => importReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(input(f)), fence: f.fence, now: FIXED_NOW,
  }), /REVIEW_IMPORT_CHECKER_NOT_CLAIMED/);
  claim(f);
  assert.throws(() => importReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(input(f, 'attempt-wrong')), fence: f.fence, now: FIXED_NOW,
  }), /REVIEW_IMPORT_ATTEMPT_MISMATCH/);

  const result = importReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(input(f)), fence: f.fence, now: FIXED_NOW,
  });
  assert.equal(result.terminal, 'approved');
  const envelope = JSON.parse(readFileSync(join(f.root, result.report), 'utf8'));
  assert.equal(envelope.envelope.provenance.review_binding.attempt_id, 'attempt-01');
  const outcome = events(f.root, f.runId).findLast(event => event.type === 'review-outcome');
  assert.equal(outcome.data.attempt_id, 'attempt-01');
});

test('artifact mutation after claim fails import with zero proof', () => {
  const f = seed();
  claim(f);
  writeFileSync(join(f.root, f.artifact), 'mutated after claim');
  const before = events(f.root, f.runId).length;
  assert.throws(() => importReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(input(f)), fence: f.fence, now: FIXED_NOW,
  }), /REVIEW_IMPORT_ARTIFACT_HASH_MISMATCH/);
  assert.equal(readState(f.root, f.runId).data.episodes.find(e => e.id === f.checkerId).status, 'in_progress');
  assert.equal(events(f.root, f.runId).length, before);
});

test('a host-claimed checker cannot bypass import through review record', () => {
  const f = seed();
  claim(f);
  const report = `${f.worktree}/review.md`;
  writeFileSync(join(f.root, report), 'APPROVE');
  assert.throws(() => recordReviewOutcome(f.root, f.runId, {
    episodeId: f.checkerId,
    verdict: 'APPROVE',
    proof: { report },
    fence: f.fence,
  }), /REVIEW_CLAIM_REQUIRES_IMPORT/);
});

test('import rechecks persisted claim root/runtime/lease binding under the fresh fence', () => {
  for (const [label, mutate, error] of [
    ['root', claim => { claim.project_root = '/wrong/root'; }, /REVIEW_IMPORT_CLAIM_ROOT_MISMATCH/],
    ['runtime', claim => { claim.runtime = 'claude'; }, /REVIEW_IMPORT_CLAIM_RUNTIME_MISMATCH/],
    ['owner', claim => { claim.lease_owner = 'other'; }, /REVIEW_IMPORT_CLAIM_LEASE_MISMATCH/],
    ['generation', claim => { claim.lease_generation = 99; }, /REVIEW_IMPORT_CLAIM_LEASE_MISMATCH/],
  ]) {
    const f = seed(); claim(f);
    const state = readState(f.root, f.runId).data;
    mutate(state.episodes.find(e => e.id === f.checkerId).review_claim);
    writeState(f.root, f.runId, state);
    assert.throws(() => importReviewOutcome(f.root, f.runId, {
      raw: JSON.stringify(input(f)), fence: f.fence, now: FIXED_NOW,
    }), error, label);
  }
});

test('headless host drives an unclaimed checker before no-pending-handoff and emits one continuation only', () => {
  const f = seed();
  const beforeSpent = readState(f.root, f.runId).data.budget.spent;
  let checkerCalls = 0;
  const deps = hostDeps(f);
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW),
    ...deps,
    checkerRunFn: (...args) => { checkerCalls += 1; return deps.checkerRunFn(...args); },
  });

  assert.equal(result.action, 'checker-complete', JSON.stringify(result));
  assert.equal(result.recorded, true);
  assert.equal(checkerCalls, 1);
  const state = readState(f.root, f.runId).data;
  assert.equal(state.episodes.find(e => e.id === f.checkerId).status, 'approved');
  assert.equal(state.session_chain.lease.handoff_phase, 'emitted');
  assert.equal(state.session_chain.lease.resume_policy, 'headless');
  assert.equal(state.budget.spent, beforeSpent + 1, 'checker import floor is absorbed by its one measured turn');
  const handoffs = events(f.root, f.runId).filter(event => event.type === 'handoff-emitted');
  assert.equal(handoffs.length, 1);
  const explicitCosts = events(f.root, f.runId).filter(event => event.type === 'cost' && event.data.reported_turns === 1);
  assert.equal(explicitCosts.length, 1);
});

test('checker import emits its immutable no-usage observation before process receipt settlement', () => {
  const f = seed({ observation: true });

  const deps = hostDeps(f);
  const calls = [];
  let observationPath;
  let bytesAtImport;
  const result = driveHeadlessRun({
    root: f.root,
    runId: f.runId,
    now: Date.parse(FIXED_NOW),
    ...deps,
    checkerRunFn(options) {
      return { ...deps.checkerRunFn(options), usageReceipt: options.usageReceipt };
    },
    checkerImportFn(options, bytes) {
      calls.push('import');
      const imported = deps.checkerImportFn(options, bytes);
      assert.equal(imported.ok, true);
      assert.equal(imported.value.observation.emitted, true);
      observationPath = join(runDir(f.root, f.runId), imported.value.observation.path);
      bytesAtImport = readFileSync(observationPath);
      const document = JSON.parse(bytesAtImport);
      assert.equal(Object.hasOwn(document.payload.attempts[0], 'usage'), false);
      return imported;
    },
    settleProcessCostFn() {
      calls.push('settle');
      assert.equal(existsSync(observationPath), true);
      assert.deepEqual(readFileSync(observationPath), bytesAtImport);
      const document = JSON.parse(readFileSync(observationPath));
      assert.equal(Object.hasOwn(document.payload.attempts[0], 'usage'), false);
      return { ok: true, recorded: true, reason: 'recorded' };
    },
    removeProcessReceiptFn() {},
  });

  assert.deepEqual(calls, ['import', 'settle']);
  assert.equal(result.action, 'checker-complete', JSON.stringify(result));
  assert.equal(result.recorded, true);
  assert.deepEqual(readFileSync(observationPath), bytesAtImport);
  assert.equal(events(f.root, f.runId).some(event => String(event.type).includes('observation')), false);
});

test('checker measured usage that crosses a hard budget settles before routing and preserve-pauses without a child', () => {
  const f = seed({ newPolicy: true });
  newWorkstream(f.root, f.runId, {
    title: 'sibling',
    branch: 'sibling',
    worktree: '.claude/worktrees/sibling',
    fence: f.fence,
  });
  const deps = hostDeps(f);
  const before = readState(f.root, f.runId).data;
  const owner = before.session_chain.lease.owner_run_id;
  const generation = before.session_chain.lease.generation;
  before.budget.tokens_total = before.budget.tokens_spent + measuredUsage().tokens;
  writeState(f.root, f.runId, before);
  const baseImport = deps.checkerImportFn;

  const result = driveHeadlessRun({
    root: f.root,
    runId: f.runId,
    now: Date.parse(FIXED_NOW),
    ...deps,
    checkerImportFn(options, bytes) {
      const imported = baseImport(options, bytes);
      recordWorkstreamTerminal(f.root, f.runId, f.ws, {
        status: 'abandoned',
        proof: { reason: 'budget crossing fixture closed' },
        confirm: true,
        fence: f.fence,
        now: FIXED_NOW,
      });
      return imported;
    },
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.action, 'gate-blocked', JSON.stringify(result));
  assert.equal(result.reason, 'budget');
  assert.equal(result.recorded, true);
  const after = readState(f.root, f.runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'checker-gate:budget');
  assert.equal(after.session_chain.lease.owner_run_id, owner);
  assert.equal(after.session_chain.lease.generation, generation);
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.lease.handoff_child_run_id ?? null, null);
  assert.equal(after.session_chain.sessions.length, 1, 'no continuation child may be reserved');
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'handoff-emitted').length, 0);
  assert.equal(
    events(f.root, f.runId).filter(event => event.type === 'cost' && event.data.reported_tokens === measuredUsage().tokens).length,
    1,
    'the measured checker turn must be durably settled before the pause decision',
  );
});

test('workstream-session headless checker preserves open affinity and emits only an exact closed boundary', () => {
  {
    const f = seed({ newPolicy: true });
    const deps = hostDeps(f);
    let emitCalls = 0;
    const result = driveHeadlessRun({
      root: f.root,
      runId: f.runId,
      now: Date.parse(FIXED_NOW),
      ...deps,
      emitHandoffFn: () => { emitCalls += 1; throw new Error('open affinity must not rotate'); },
    });
    assert.equal(result.action, 'checker-complete', JSON.stringify(result));
    assert.equal(result.continuation, false);
    assert.equal(emitCalls, 0);
    const state = readState(f.root, f.runId).data;
    assert.equal(state.session_chain.lease.handoff_phase, 'idle');
    assert.equal(state.session_chain.sessions[0].scope.workstream_id, f.ws);
  }

  {
    const f = seed({ newPolicy: true });
    newWorkstream(f.root, f.runId, {
      title: 'sibling',
      branch: 'sibling',
      worktree: '.claude/worktrees/sibling',
      fence: f.fence,
    });
    const deps = hostDeps(f);
    let emittedOptions = null;
    let terminalError = null;
    const baseImport = deps.checkerImportFn;
    const result = driveHeadlessRun({
      root: f.root,
      runId: f.runId,
      now: Date.parse(FIXED_NOW),
      ...deps,
      checkerImportFn(options, bytes) {
        const imported = baseImport(options, bytes);
        assert.equal(imported.ok, true);
        try {
          recordWorkstreamTerminal(f.root, f.runId, f.ws, {
            status: 'abandoned',
            proof: { reason: 'checker fixture closed' },
            confirm: true,
            fence: f.fence,
            now: FIXED_NOW,
          });
        } catch (error) {
          terminalError = error;
          throw error;
        }
        return imported;
      },
      emitHandoffFn: (_root, _runId, options) => {
        emittedOptions = options;
        return { ok: true };
      },
    });
    assert.equal(terminalError, null, String(terminalError?.message || terminalError));
    assert.equal(result.action, 'checker-complete', JSON.stringify(result));
    assert.equal(result.continuation, true);
    const state = readState(f.root, f.runId).data;
    const boundary = state.session_chain.sessions[0].scope.terminal_event;
    assert.deepEqual(emittedOptions.boundaryEvent, boundary);
    assert.equal(emittedOptions.reason, 'workstream-terminal');
    assert.equal(emittedOptions.trigger, 'workstream-terminal');
  }
});

test('checker samples an injectable clock again after preflight and blocks at a crossed wallclock boundary', () => {
  const f = seed();
  const deps = hostDeps(f);
  const state = readState(f.root, f.runId).data;
  const createdAt = Date.parse(state.created_at);
  state.budget.max_wallclock_sec = 3_601;
  writeState(f.root, f.runId, state);
  let clockCalls = 0;
  let preflightCalls = 0;
  let checkerCalls = 0;

  const result = driveHeadlessRun({
    root: f.root,
    runId: f.runId,
    ...deps,
    now: createdAt + 3_600_999,
    clock: () => { clockCalls += 1; return createdAt + 3_601_001; },
    preflightFn: () => {
      preflightCalls += 1;
      return { ok: true, cache_hit: true, measured_usage: [] };
    },
    checkerRunFn: () => { checkerCalls += 1; throw new Error('wallclock gate must block before checker spawn'); },
  });

  assert.deepEqual(result, { ok: false, action: 'gate-blocked', reason: 'wallclock' });
  assert.equal(clockCalls, 1, 'the CLI-shaped live clock must be sampled after preflight');
  assert.equal(preflightCalls, 1, 'the boundary must be crossed during preflight');
  assert.equal(checkerCalls, 0);
  const after = readState(f.root, f.runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.episodes.find(e => e.id === f.checkerId).status, 'pending');
});

test('an in-progress independent checker blocks every pending maker handoff and is never respawned', () => {
  const f = seed(); approveCodexRuntime(f); claim(f, 'stranded-attempt');
  emitHandoff(f.root, f.runId, {
    reason: 'pending-maker', trigger: 'pending-maker', headless: true, resumePolicy: 'headless',
    expect: { owner: f.runId, generation: 1 }, now: Date.parse(FIXED_NOW),
  });
  let sideEffects = 0;
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW),
    checkerRunFn: () => { sideEffects += 1; throw new Error('must not retry checker'); },
    spawnFn: () => { sideEffects += 1; throw new Error('must not spawn maker handoff'); },
  });
  assert.deepEqual(result, {
    ok: false, action: 'checker-in-progress', reason: 'needs-human-no-retry',
    checkerEpisodeId: f.checkerId, attemptId: 'stranded-attempt',
  });
  assert.equal(sideEffects, 0);
  assert.equal(readState(f.root, f.runId).data.episodes.find(e => e.id === f.checkerId).status, 'in_progress');
});

test('unsupported subagent checker is claimed once then atomically blocked without process spawn', () => {
  const f = seed({ reviewer: 'subagent-checker' }); approveCodexRuntime(f);
  let checkerCalls = 0;
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW),
    expect: { owner: f.runId, generation: 1 },
    attemptIdFactory: () => 'attempt-subagent',
    checkerRunFn: () => { checkerCalls += 1; throw new Error('unsupported checker must not spawn'); },
  });
  assert.equal(result.action, 'checker-blocked');
  assert.equal(result.reason, 'checker-capability-unsupported');
  assert.equal(checkerCalls, 0);
  const state = readState(f.root, f.runId).data;
  const checker = state.episodes.find(e => e.id === f.checkerId);
  assert.equal(checker.status, 'blocked');
  assert.equal(checker.attempt_id, 'attempt-subagent');
  assert.equal(state.status, 'paused');
});

test('missing deep-review skill is claimed once then blocked with no proof or retry', () => {
  const f = seed();
  let checkerCalls = 0;
  const deps = hostDeps(f);
  const first = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
    resolveCheckerSkill: () => { throw new Error('checker-skill-unavailable'); },
    checkerRunFn: () => { checkerCalls += 1; throw new Error('missing skill must not spawn'); },
  });
  const second = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
    checkerRunFn: () => { checkerCalls += 1; throw new Error('blocked checker must not spawn'); },
  });
  assert.equal(first.action, 'checker-blocked');
  assert.equal(first.reason, 'checker-skill-unavailable');
  assert.equal(second.action, 'no-pending-handoff');
  assert.equal(checkerCalls, 0);
  const checker = readState(f.root, f.runId).data.episodes.find(e => e.id === f.checkerId);
  assert.equal(checker.status, 'blocked');
  assert.equal(checker.review_source, undefined);
});

test('checker process failure blocks and pauses once without proof or fabricated cost', () => {
  const f = seed();
  const deps = hostDeps(f);
  const beforeCosts = events(f.root, f.runId).filter(event => event.type === 'cost').length;
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
    checkerRunFn: () => ({ ok: false, reason: 'timeout' }),
  });
  assert.equal(result.action, 'checker-blocked');
  assert.equal(result.reason, 'checker-process-failed');
  const state = readState(f.root, f.runId).data;
  assert.equal(state.status, 'paused');
  assert.equal(state.episodes.find(e => e.id === f.checkerId).status, 'blocked');
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'cost').length, beforeCosts);
  assert.equal(events(f.root, f.runId).some(event => event.type === 'review-outcome'), false);
});

test('headless checker immutable prompt carries anchored contract and evidence from the durable claim', () => {
  const f = seed();
  const evidence = { insights_path: '.deep-loop/insights/x.json', emit_ulid: '01TEST', sha256: 'a'.repeat(64), candidates: [] };
  const contract = { slice: 'HILLCLIMB-001', path: `${f.worktree}/.deep-review/contracts/HILLCLIMB-001.yaml`, sha256: 'b'.repeat(64) };
  const state = readState(f.root, f.runId).data;
  const checker = state.episodes.find(episode => episode.id === f.checkerId);
  checker.evidence = evidence;
  checker.contract = contract;
  writeState(f.root, f.runId, state);

  const deps = hostDeps(f);
  let immutableContract;
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
    checkerRunFn: options => {
      immutableContract = options.contract;
      return { ok: false, reason: 'timeout' };
    },
  });

  assert.equal(result.action, 'checker-blocked');
  assert.deepEqual(immutableContract.evidence, evidence);
  assert.deepEqual(immutableContract.contract, contract);
  const claimed = readState(f.root, f.runId).data.episodes.find(episode => episode.id === f.checkerId).review_claim;
  assert.deepEqual(claimed.evidence, evidence);
  assert.deepEqual(claimed.contract, contract);
});

test('a measured checker turn with no final message is charged once while proof stays blocked', () => {
  const f = seed();
  const deps = hostDeps(f);
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
    checkerRunFn: () => ({ ok: false, reason: 'checker-final-message-invalid', usage: measuredUsage() }),
    checkerImportFn: () => { throw new Error('missing final bytes must never reach import'); },
  });

  assert.equal(result.action, 'checker-blocked');
  assert.equal(result.reason, 'checker-process-failed');
  assert.equal(result.recorded, true);
  const state = readState(f.root, f.runId).data;
  assert.equal(state.status, 'paused');
  assert.equal(state.episodes.find(e => e.id === f.checkerId).status, 'blocked');
  assert.equal(events(f.root, f.runId).some(event => event.type === 'review-outcome'), false);
  assert.deepEqual(
    events(f.root, f.runId).filter(event => event.type === 'cost' && event.data.reported_turns === 1)
      .map(event => event.data.reported_tokens),
    [12],
  );
});

test('third REQUEST_CHANGES pauses without continuation but still records the consumed checker turn', () => {
  const f = seed();
  const state = readState(f.root, f.runId).data;
  state.circuit_breaker.consecutive_request_changes = 2;
  writeState(f.root, f.runId, state);
  const deps = hostDeps(f, { verdict: 'REQUEST_CHANGES' });
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
  });
  assert.equal(result.action, 'checker-complete');
  assert.equal(result.recorded, true);
  assert.equal(result.continuation, false);
  const after = readState(f.root, f.runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.circuit_breaker.tripped, true);
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'cost' && event.data.reported_turns === 1).length, 1);
});

test('host rejects a false-positive import adapter success that created no durable checker proof', () => {
  const f = seed();
  const deps = hostDeps(f);
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
    checkerImportFn: () => ({ ok: true, value: { forged: true } }),
  });
  assert.equal(result.action, 'checker-blocked');
  assert.equal(result.reason, 'checker-import-failed');
  assert.equal(result.recorded, true, 'the structurally measured turn is still charged once');
  const state = readState(f.root, f.runId).data;
  assert.equal(state.episodes.find(e => e.id === f.checkerId).status, 'blocked');
  assert.equal(state.session_chain.lease.handoff_phase, 'idle');
  assert.equal(events(f.root, f.runId).some(event => event.type === 'review-outcome'), false);
});

test('durable human resume policy prevents a pending checker from entering unattended claim or spawn', () => {
  const f = seed();
  const deps = hostDeps(f);
  const state = readState(f.root, f.runId).data;
  state.session_chain.lease.resume_policy = 'human';
  writeState(f.root, f.runId, state);
  let checkerCalls = 0;
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
    checkerRunFn: () => { checkerCalls += 1; throw new Error('human policy must not spawn'); },
  });
  assert.deepEqual(result, { ok: true, skipped: true, reason: 'human-resume-policy' });
  assert.equal(checkerCalls, 0);
  assert.equal(readState(f.root, f.runId).data.episodes.find(e => e.id === f.checkerId).status, 'pending');
});

test('artifact drift after the checker process is detected before trusted import is invoked', () => {
  const f = seed();
  const deps = hostDeps(f);
  let importCalls = 0;
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
    checkerRunFn: () => {
      writeFileSync(join(f.root, f.artifact), 'drift after checker');
      return { ok: true, usage: measuredUsage(), finalMessage: Buffer.from(JSON.stringify(input(f, 'attempt-host'))) };
    },
    checkerImportFn: () => { importCalls += 1; throw new Error('drifted artifact must not reach import'); },
  });
  assert.equal(importCalls, 0);
  assert.equal(result.action, 'checker-stranded');
  assert.equal(result.reason, 'checker-identity-drift');
  assert.equal(readState(f.root, f.runId).data.episodes.find(e => e.id === f.checkerId).status, 'in_progress');
});

test('a running post-import continuation failure fail-closes instead of reporting checker completion', () => {
  const f = seed();
  const deps = hostDeps(f);
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
    emitHandoffFn: () => { throw new Error('handoff storage failed'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.action, 'continuation-failed');
  assert.equal(result.recorded, true);
  assert.equal(readState(f.root, f.runId).data.status, 'paused');
  assert.equal(readState(f.root, f.runId).data.episodes.find(e => e.id === f.checkerId).status, 'approved');
});

test('trusted local import has a separate 30 second bound from the model timeout', () => {
  const f = seed();
  const deps = hostDeps(f);
  let importTimeout;
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), timeoutMs: 90_000, ...deps,
    checkerImportFn: (options, bytes) => {
      importTimeout = options.timeoutMs;
      return deps.checkerImportFn(options, bytes);
    },
  });
  assert.equal(result.action, 'checker-complete');
  assert.equal(importTimeout, 30_000);
});

test('a claim race or validation failure is surfaced fail-closed instead of escaping the host transaction', () => {
  const f = seed();
  const deps = hostDeps(f);
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
    claimReviewFn: () => { throw new Error('REVIEW_CLAIM_NOT_PENDING'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.action, 'checker-claim-failed');
  assert.equal(readState(f.root, f.runId).data.status, 'paused');
  assert.equal(readState(f.root, f.runId).data.episodes.find(e => e.id === f.checkerId).status, 'pending');
});

test('nested concurrent hosts produce one claim event and one checker process', () => {
  const f = seed();
  const deps = hostDeps(f);
  let checkerCalls = 0;
  let nested;
  const options = {
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
    checkerRunFn: (checkerOptions) => {
      checkerCalls += 1;
      nested = driveHeadlessRun(options);
      return deps.checkerRunFn(checkerOptions);
    },
  };
  const result = driveHeadlessRun(options);
  assert.equal(result.action, 'checker-complete');
  assert.deepEqual(nested, { ok: true, action: 'already-driving' });
  assert.equal(checkerCalls, 1);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'independent-review-claimed').length, 1);
});

test('terminal accounting race is explicit and never adopts another fence', () => {
  const f = seed();
  const deps = hostDeps(f);
  let importedResult;
  const result = driveHeadlessRun({
    root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
    checkerImportFn: (options, bytes) => {
      const imported = deps.checkerImportFn(options, bytes);
      importedResult = imported.value;
      finishRun(f.root, f.runId, {
        status: 'stopped',
        confirm: true,
        proof: { human_reason: 'terminal accounting race fixture' },
        fence: f.fence,
        now: FIXED_NOW,
      });
      return imported;
    },
  });
  assert.equal(result.action, 'checker-complete');
  assert.equal(result.recorded, false);
  assert.equal(result.accounting_reason, 'terminal');
  const state = readState(f.root, f.runId).data;
  assert.equal(state.status, 'stopped');
  assert.equal(state.session_chain.lease.owner_run_id, f.fence.owner);
  assert.equal(state.session_chain.lease.generation, f.fence.generation);
  assert.equal(existsSync(join(runDir(f.root, f.runId), 'transactions',
    `review-import-${importedResult.report_sha256}`)), false);
  assert.deepEqual(verifyLog(f.root, f.runId), { ok: true, errors: [] });
  assert.deepEqual(verifyHead(f.root, f.runId, state.event_log_head), { ok: true, errors: [] });
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'finish').length, 1);
  assert.equal(events(f.root, f.runId).some(event => event.type === 'cost'
    && event.data?.reported_turns === 1 && event.data?.reported_tokens === 12), false);
});

test('session model or effort drift after preflight blocks before checker spawn', () => {
  for (const field of ['session_model', 'session_effort']) {
    const f = seed();
    const deps = hostDeps(f);
    let checkerCalls = 0;
    const result = driveHeadlessRun({
      root: f.root, runId: f.runId, now: Date.parse(FIXED_NOW), ...deps,
      preflightFn: () => {
        const state = readState(f.root, f.runId).data;
        state.autonomy[field] = field === 'session_model' ? 'gpt-5.4' : 'xhigh';
        writeState(f.root, f.runId, state);
        return { ok: true, cache_hit: true, measured_usage: [] };
      },
      checkerRunFn: () => { checkerCalls += 1; throw new Error('drift must block before spawn'); },
    });
    assert.equal(result.action, 'checker-blocked', field);
    assert.equal(result.reason, 'checker-identity-drift', field);
    assert.equal(checkerCalls, 0, field);
  }
});

 test('v0.5 host records measured execution return before importing ordinary checker proof without rotating owner',()=>{
  const f=seed({goalDriven:true});const deps=hostDeps(f);
  const result=driveHeadlessRun({root:f.root,runId:f.runId,now:Date.parse(FIXED_NOW),...deps,
    checkerRunFn:options=>({...deps.checkerRunFn(options),process_group:{mode:'required',group_id:12345,quiescence_confirmed:true},termination:{confirmed:true}})});
  assert.equal(result.action,'checker-complete',JSON.stringify(result));
  const loop=readState(f.root,f.runId).data, checker=loop.episodes.find(x=>x.id===f.checkerId);
  assert.equal(checker.status,'approved');assert.equal(checker.execution.phase,'returned');
  assert.equal(checker.execution.observation.source,'supervisor-receipt');
  assert.equal(loop.session_chain.lease.owner_run_id,f.runId);
  assert.equal(loop.session_chain.lease.handoff_phase,'idle');
 });

test('v0.5 import rejects report bytes differing from the observed checker process output',()=>{
 const f=seed({goalDriven:true});const deps=hostDeps(f);
 const result=driveHeadlessRun({root:f.root,runId:f.runId,now:Date.parse(FIXED_NOW),...deps,
  checkerRunFn:options=>({...deps.checkerRunFn(options),process_group:{mode:'required',group_id:12345,quiescence_confirmed:true},termination:{confirmed:true}}),
  checkerImportFn:(_options,bytes)=>{const changed=JSON.parse(bytes);changed.report_body='A different report';return {ok:true,value:importReviewOutcome(f.root,f.runId,{raw:JSON.stringify(changed),fence:f.fence,now:FIXED_NOW})};}});
 assert.equal(result.ok,false);
 assert.notEqual(readState(f.root,f.runId).data.episodes.find(x=>x.id===f.checkerId).status,'approved');
});

const PLAN_REVIEW={points:['implementation'],reviewer:'subagent-checker',mode:'same-model',flags:[],converge:true,max_review_rounds:5,require_human_ack:false};
const OWNER_THREAD='019c7714-3b77-74d1-9866-e1f484aae2ab';
const CHECKER_THREAD='019c7714-3b77-74d1-9866-e1f484aae2ac';
for(const veto of [null,'same-session','missing-session','termination','doctrine','config']) {
 test(`issued goal plan supervises actual subagent import boundary: ${veto??'success'}`,()=>{
  const f=seed({goalDriven:true,reviewer:'subagent-checker',review:PLAN_REVIEW,model:'gpt-6-astra',effort:'high'}),deps=hostDeps(f);
  const controller=createGoalPlanController();
  const plan=issueGoalExecutionPlan(controller,{loop:readState(f.root,f.runId).data,doctrine:deps.resolveCheckerSkill()});
  let imports=0,changed=false;const tokensBefore=readState(f.root,f.runId).data.budget.tokens_spent;
  try {
   const result=driveHeadlessRun({root:f.root,runId:f.runId,now:Date.parse(FIXED_NOW),...deps,goalExecutionPlan:plan,goalOwnerThreads:[OWNER_THREAD],
    resolveCheckerSkill:()=>changed&&veto==='doctrine'?{...deps.resolveCheckerSkill(),plugin_version:'changed'}:deps.resolveCheckerSkill(),
    checkerRunFn:options=>{
     assert.equal(options.model,'gpt-6-astra');assert.equal(options.effort,'high');changed=true;
     if(veto==='config'){const state=readState(f.root,f.runId).data;state.review.mode='cross-model';writeState(f.root,f.runId,state);}
     return {...deps.checkerRunFn(options),providerThreadId:veto==='same-session'?OWNER_THREAD:veto==='missing-session'?null:CHECKER_THREAD,
      process_group:{mode:'required',group_id:12345,quiescence_confirmed:veto!=='termination'},termination:{confirmed:veto!=='termination'}};
    },checkerImportFn:(...args)=>{imports++;return deps.checkerImportFn(...args);}});
   const after=readState(f.root,f.runId).data,checker=after.episodes.find(e=>e.id===f.checkerId);
   assert.equal(after.budget.tokens_spent-tokensBefore,veto==='termination'?0:12);
   if(veto===null){assert.equal(result.ok,true,JSON.stringify(result));assert.equal(imports,1);assert.equal(checker.review_source,'imported-stdin');assert.equal(checker.status,'approved');}
   else {assert.equal(result.ok,false,JSON.stringify(result));assert.equal(imports,0);assert.notEqual(checker.status,'approved');assert.equal(existsSync(join(runDir(f.root,f.runId),'host-checkers','attempt-host','receipt.json')),false);}
  } finally {expireGoalPlanController(controller);}
 });
}
test('forged plan is a caller error and stale issued configuration pauses before any checker claim',()=>{
 const f=seed({goalDriven:true,reviewer:'subagent-checker',review:PLAN_REVIEW,model:'gpt-6-astra',effort:'high'}),deps=hostDeps(f);
 const controller=createGoalPlanController(),plan=issueGoalExecutionPlan(controller,{loop:readState(f.root,f.runId).data,doctrine:deps.resolveCheckerSkill()});
 try {
  const before=readFileSync(join(runDir(f.root,f.runId),'loop.json'));
  assert.throws(()=>driveHeadlessRun({root:f.root,runId:f.runId,...deps,goalExecutionPlan:structuredClone(plan)}),/GOAL_PLAN_NOT_ISSUED/);
  assert.deepEqual(readFileSync(join(runDir(f.root,f.runId),'loop.json')),before);
  const state=readState(f.root,f.runId).data;state.review.mode='cross-model';writeState(f.root,f.runId,state);
  let calls=0;const result=driveHeadlessRun({root:f.root,runId:f.runId,now:Date.parse(FIXED_NOW),...deps,goalExecutionPlan:plan,goalOwnerThreads:[OWNER_THREAD],checkerRunFn:()=>{calls++;throw Error('must not run');}});
  assert.equal(result.reason,'goal-execution-plan-stale');assert.equal(calls,0);
  const after=readState(f.root,f.runId).data,checker=after.episodes.find(e=>e.id===f.checkerId);
  assert.equal(after.status,'paused');assert.equal(checker.status,'pending');assert.equal(checker.attempt_id,undefined);assert.equal(checker.execution,undefined);
 }finally{expireGoalPlanController(controller);}
});

import { createGoalCallBudget } from '../scripts/lib/goal-call-budget.mjs';
for(const timing of ['before-claim','after-claim'])test(`host admission refusal preserves checker authority: ${timing}`,()=>{
 const f=seed({goalDriven:true,reviewer:'subagent-checker',review:PLAN_REVIEW,model:'gpt-6-astra',effort:'high'}),deps=hostDeps(f);
 const controller=createGoalPlanController(),plan=issueGoalExecutionPlan(controller,{loop:readState(f.root,f.runId).data,doctrine:deps.resolveCheckerSkill()});
 const b=createGoalCallBudget({readLoop:()=>readState(f.root,f.runId).data,tokenLimit:100,remaining:()=>0,callTimeoutMs:1000,now:()=>Date.parse(FIXED_NOW),runProcess:()=>{throw Error('must not spawn');}});
 let invoked=0;
 try {
  const result=driveHeadlessRun({root:f.root,runId:f.runId,now:Date.parse(FIXED_NOW),...deps,goalExecutionPlan:plan,goalOwnerThreads:[OWNER_THREAD],goalCallAdmission:()=>{if(timing==='before-claim')b.admit();},checkerRunFn:()=>{invoked++;b.admit();}});
  assert.equal(result.reason,'goal-host-deadline');assert.equal(result.spawn_state,'not-started');assert.equal(invoked,timing==='before-claim'?0:1);
  const after=readState(f.root,f.runId).data,checker=after.episodes.find(e=>e.id===f.checkerId);
  assert.equal(after.status,'paused');assert.notEqual(checker.status,'blocked');assert.notEqual(checker.status,'approved');
  if(timing==='before-claim'){assert.equal(checker.status,'pending');assert.equal(checker.attempt_id,undefined);}else{assert.equal(checker.attempt_id,result.attemptId);assert.equal(checker.execution.phase,'running');}
 }finally{expireGoalPlanController(controller);}
});
