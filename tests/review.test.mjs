import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode, abandonEpisode } from '../scripts/lib/episode.mjs';
import {
  configureReviewFlags, resolveReviewer, dispatchReview, importReviewOutcome, makerReviewed, parseVerdict,
  recordReviewOutcome, unsatisfiedReviewPoints,
} from '../scripts/lib/review.mjs';
import { releaseLease, acquireLease } from '../scripts/lib/lease.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';
import { reviewedMakerThenHandoff } from './helpers/unbound-owner.mjs';

function eventLog(root, runId) {
  return readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function runInventory(root, runId) {
  const base = runDir(root, runId);
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
  visit(base);
  return files;
}
// #2 + Fix4: a passing verdict's report must live under the reviewed workstream's worktree — helper writes it there
// and returns the root-relative path.
function wsReport(root, worktreeRel, name = 'review.md', body = '# review report') {
  mkdirSync(join(root, worktreeRel), { recursive: true });
  const rel = join(worktreeRel, name);
  writeFileSync(join(root, rel), body);
  return rel;
}
// A bound, pending checker ready to receive a verdict for (ws, point). Writes a distinct maker artifact.
function boundChecker(root, runId, f, point) {
  const worktree = '.claude/worktrees/w-' + point;
  const ws = newWorkstream(root, runId, { title: point, branch: 'b-' + point, worktree, fence: f }).id;
  doneMaker(root, runId, ws, point, f);
  const r = dispatchReview(root, runId, { point, workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  return { ws, checkerId: r.checkerEpisodeId, worktree };
}

function seed(detected = { 'deep-review': true }) {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', detected, now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

function fence(runId) { return { owner: runId, generation: 1, intent: 'business' }; }

function freshRun() {
  const { root, runId } = seed();
  return { root, runId, fence: fence(runId) };
}

// Every review must bind to a real done maker — dispatchReview now throws REVIEW_NO_ELIGIBLE_MAKER otherwise.
// Helper: create + record a done maker for (ws, point) so a subsequent dispatchReview binds its checker to it.
function doneMaker(root, runId, ws, point, f, file) {
  const art = file || `${point}-art.txt`;
  writeFileSync(join(root, art), 'artifact');
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: point, point, workstream: ws, expectedArtifacts: [art], fence: f });
  recordEpisode(root, runId, id, { status: 'in_progress', fence: f });
  recordEpisode(root, runId, id, { status: 'done', artifacts: [art], proof: {}, fence: f });
  return id;
}

function legacyStandaloneChecker() {
  const { root, runId } = seed();
  const f = fence(runId);
  const worktree = '.claude/worktrees/legacy-review';
  mkdirSync(join(root, worktree), { recursive: true });
  const ws = newWorkstream(root, runId, { title: 'legacy', branch: 'legacy', worktree, fence: f }).id;
  const artifact = `${worktree}/plan-artifact.txt`;
  const makerId = doneMaker(root, runId, ws, 'plan', f, artifact);
  const { checkerEpisodeId } = dispatchReview(root, runId, {
    point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f,
  });
  const state = readState(root, runId).data;
  state.episodes.find(e => e.id === checkerEpisodeId).plugin = 'standalone';
  writeState(root, runId, state);
  return { root, runId, f, worktree, ws, artifact, makerId, checkerEpisodeId };
}

// deep-review가 init 때부터 부재 → 기본 reviewer는 subagent-checker(초기화-시점 기본값, 강등 아님).
// Codex 감지는 durable reviewer identity를 바꾸지 않는다. 구성된 deep-review가 이후 사라지면 fail-closed다.
test('resolveReviewer keeps the init-time default subagent runtime-neutral', () => {
  const { root, runId } = seed({ 'deep-review': false, codex: true });
  const { data } = readState(root, runId);
  assert.equal(resolveReviewer(data, { 'deep-review': false, codex: true }).reviewer, 'subagent-checker');
  assert.equal(resolveReviewer(data, { 'deep-review': false, codex: false }).reviewer, 'subagent-checker');
});

test('parseVerdict reads JSON verdict then keywords', () => {
  assert.equal(parseVerdict('{"verdict":"APPROVE","summary":"ok"}'), 'APPROVE');
  assert.equal(parseVerdict('Overall: REQUEST_CHANGES on 2 findings'), 'REQUEST_CHANGES');
  assert.equal(parseVerdict('looks good, APPROVE'), 'APPROVE');
  assert.equal(parseVerdict('no verdict here'), null);
  assert.equal(parseVerdict('do not APPROVE this'), null);   // 부정문 (Codex r4 ℹ️2)
});

test('dispatchReview creates checker episode + returns descriptor (no call)', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  const makerId = doneMaker(root, runId, ws, 'implementation', f);   // checker must bind to a real done maker
  const r = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  assert.equal(r.reviewer, 'deep-review-loop');
  assert.equal(r.descriptor.kind, 'skill');
  assert.equal(r.descriptor.role, 'checker');
  assert.equal(r.descriptor.skill, 'deep-review:deep-review-loop');
  assert.equal(r.descriptor.requires_independent_session, true);
  const ep = readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId);
  assert.equal(ep.role, 'checker');
  assert.equal(ep.kind, 'implementation-review');
  assert.equal(ep.target_maker, makerId);   // always bound going forward
});

test('dispatchReview rejects a checker born from a stale review-config snapshot', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, {
    title: 'race', branch: 'race', worktree: '.claude/worktrees/race', fence: f,
  }).id;
  doneMaker(root, runId, ws, 'plan', f);
  const first = dispatchReview(root, runId, {
    point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f,
  });
  abandonEpisode(root, runId, first.checkerEpisodeId, {
    reason: 'operational-review-failure: parser-contract-mismatch', confirm: true, fence: f,
  });

  assert.throws(() => dispatchReview(root, runId, {
    point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f,
    __testBeforeCheckerCreate: () => configureReviewFlags(root, runId, {
      profile: 'codex-only-static', sourceCheckerId: first.checkerEpisodeId, confirm: true, fence: f,
    }),
  }), /REVIEW_CONFIG_CHANGED/);

  const afterRace = readState(root, runId).data;
  assert.deepEqual(afterRace.review.flags, ['--contract', '--codex-only', '--reviewer-strategy', 'static']);
  assert.equal(afterRace.episodes.filter(e => e.role === 'checker' && e.status === 'pending').length, 0);

  const retried = dispatchReview(root, runId, {
    point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f,
  });
  assert.match(retried.descriptor.args, /--codex-only/);
  assert.match(retried.descriptor.args, /--reviewer-strategy static/);
});

test('dispatchReview rejects a mismatched Workstream scope before reviewer dependency discovery', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const wsA = newWorkstream(root, runId, { title: 'a', branch: 'a', worktree: '.claude/worktrees/a', fence: f }).id;
  const wsB = newWorkstream(root, runId, { title: 'b', branch: 'b', worktree: '.claude/worktrees/b', fence: f }).id;
  doneMaker(root, runId, wsB, 'implementation', f);
  const state = readState(root, runId).data;
  const ownerScope = state.session_chain.sessions.find(session => session.run_id === runId).scope;
  ownerScope.workstream_id = wsA;
  ownerScope.bound_at_seq = 1;
  writeState(root, runId, state);

  assert.throws(() => dispatchReview(root, runId, {
    point: 'implementation',
    workstreamId: wsB,
    detected: { 'deep-review': false },
    fence: f,
  }), /SESSION_SCOPE_MISMATCH/);
});

test('F: an open-unbound owner cannot create a checker for a non-done target maker', () => {
  const f = reviewedMakerThenHandoff();
  const pendingMaker = newEpisode(f.root, f.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: f.siblingWs, fence: f.fence,
  }).id;
  assert.throws(
    () => newEpisode(f.root, f.runId, {
      plugin: 'deep-review', role: 'checker', kind: 'implementation-review',
      point: 'implementation', workstream: f.siblingWs, targetMaker: pendingMaker,
      fence: f.fence,
    }),
    /SESSION_SCOPE_MISMATCH/,
  );
});

test('recordReviewOutcome derives checker terminal + drives breaker/comprehension/points', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  // Create a done maker for 'plan' so dispatchReview binds the checker (target_maker required for review_points_done).
  writeFileSync(join(root, 'plan.txt'), 'plan artifact');
  const { id: planMakerId } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'plan', point: 'plan', workstream: ws, expectedArtifacts: ['plan.txt'], fence: f });
  recordEpisode(root, runId, planMakerId, { status: 'in_progress', fence: f });
  recordEpisode(root, runId, planMakerId, { status: 'done', artifacts: ['plan.txt'], proof: {}, fence: f });
  // REQUEST_CHANGES → checker rejected + breaker++ (Codex r1 🔴5: checker 터미널 파생)
  const r1 = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  recordReviewOutcome(root, runId, { episodeId: r1.checkerEpisodeId, verdict: 'REQUEST_CHANGES', fence: f });
  let d = readState(root, runId).data;
  assert.equal(d.episodes.find(e => e.id === r1.checkerEpisodeId).status, 'rejected');
  assert.equal(d.circuit_breaker.consecutive_request_changes, 1);
  // Fix maker done (second round) and APPROVE → checker approved + point done + breaker reset + comprehension.
  writeFileSync(join(root, 'plan2.txt'), 'plan artifact v2');
  const { id: planMakerId2 } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'plan', point: 'plan', workstream: ws, expectedArtifacts: ['plan2.txt'], fence: f });
  recordEpisode(root, runId, planMakerId2, { status: 'done', artifacts: ['plan2.txt'], proof: {}, fence: f });
  const r2 = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  const rep2 = wsReport(root, '.claude/worktrees/w', 'plan-review.md');
  recordReviewOutcome(root, runId, { episodeId: r2.checkerEpisodeId, verdict: 'APPROVE', proof: { report: rep2 }, fence: f });
  d = readState(root, runId).data;
  assert.equal(d.episodes.find(e => e.id === r2.checkerEpisodeId).status, 'approved');
  assert.equal(d.circuit_breaker.consecutive_request_changes, 0);
  assert.ok(d.workstreams.find(w => w.id === ws).review_points_done.includes('plan'));
});

// (RC → nextAction=fix_episode 종단 테스트는 Task 6 next-action.test.mjs 로 이동 — Task 4 는 next-action.mjs 미존재. Codex r5 🟡1)

// Fix 1: recordReviewOutcome on a maker episode id throws REVIEW_TARGET_NOT_CHECKER
test('recordReviewOutcome throws REVIEW_TARGET_NOT_CHECKER when target is a maker episode', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  // Create a maker episode
  const { id: makerId } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', workstream: ws, fence: f });
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: makerId, verdict: 'APPROVE', fence: f }),
    /REVIEW_TARGET_NOT_CHECKER/
  );
});

test('recordReviewOutcome rejects caller-supplied source/workstream/point metadata before mutation', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const wsA = newWorkstream(root, runId, { title: 'ws-A', branch: 'ba', worktree: '.claude/worktrees/wa', fence: f }).id;
  // Create a done maker for ws-A/plan so dispatchReview binds the checker (required for review_points_done update).
  writeFileSync(join(root, 'plan-a.txt'), 'plan artifact');
  const { id: planMakerId } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'plan', point: 'plan', workstream: wsA, expectedArtifacts: ['plan-a.txt'], fence: f });
  recordEpisode(root, runId, planMakerId, { status: 'in_progress', fence: f });
  recordEpisode(root, runId, planMakerId, { status: 'done', artifacts: ['plan-a.txt'], proof: {}, fence: f });
  // dispatch checker for ws-A / plan — checker is bound to planMakerId
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: wsA, detected: { 'deep-review': true }, fence: f });
  const repA = wsReport(root, '.claude/worktrees/wa', 'a-review.md');
  for (const forbidden of [
    { workstreamId: wsA }, { point: 'plan' }, { source: 'deep-review-approve' }, { reviewSource: 'recorded-path' },
    { attemptId: 'caller-spoof' }, { attempt_id: 'caller-spoof' }, { 'attempt-id': 'caller-spoof' },
  ]) {
    assert.throws(() => recordReviewOutcome(root, runId, {
      episodeId: r.checkerEpisodeId, verdict: 'APPROVE', proof: { report: repA }, fence: f, ...forbidden,
    }), /REVIEW_METADATA_FORBIDDEN/);
  }
  assert.throws(() => recordReviewOutcome(root, runId, {
    episodeId: r.checkerEpisodeId, verdict: 'APPROVE',
    proof: { report: repA, source: 'deep-review-approve' }, fence: f,
  }), /REVIEW_METADATA_FORBIDDEN/);
  const d = readState(root, runId).data;
  assert.equal(d.episodes.find(e => e.id === r.checkerEpisodeId).status, 'pending');
  assert.deepEqual(d.workstreams.find(w => w.id === wsA).review_points_done, []);
});

// Codex r2 🔴: 같은 checker episode 에 두 번 recordReviewOutcome 호출 → 두 번째 throw REVIEW_ALREADY_RECORDED.
test('recordReviewOutcome throws REVIEW_ALREADY_RECORDED on second call to same checker episode', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  doneMaker(root, runId, ws, 'plan', f);
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  const rep = wsReport(root, '.claude/worktrees/w', 'plan-review.md');
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'APPROVE', proof: { report: rep }, fence: f });
  const breakerBefore = readState(root, runId).data.circuit_breaker.consecutive_request_changes;
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'REQUEST_CHANGES', fence: f }),
    /REVIEW_ALREADY_RECORDED/
  );
  // breaker counter must be unchanged by second call
  assert.equal(readState(root, runId).data.circuit_breaker.consecutive_request_changes, breakerBefore);
});

// Codex r2 🔴6: invalid verdict 는 어떤 변경(breaker) 전에 거부.
test('recordReviewOutcome rejects invalid verdict before mutating breaker', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  doneMaker(root, runId, ws, 'plan', f);
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  const before = readState(root, runId).data.circuit_breaker.consecutive_request_changes;
  assert.throws(() => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'APPROV', fence: f }), /REVIEW_VERDICT_INVALID/);
  assert.equal(readState(root, runId).data.circuit_breaker.consecutive_request_changes, before);
});

// Codex r3 FIX 2: concurrent callers — second recordReviewOutcome on same checker throws, no extra breaker mutation
test('recordReviewOutcome twice → second throws EPISODE_ALREADY_TERMINAL, breaker unchanged', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  doneMaker(root, runId, ws, 'plan', f);
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  const rep = wsReport(root, '.claude/worktrees/w', 'plan-review.md');
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'APPROVE', proof: { report: rep }, fence: f });
  const breakerAfterFirst = readState(root, runId).data.circuit_breaker.consecutive_request_changes;
  // Second call with different verdict — must throw and not mutate breaker
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'REQUEST_CHANGES', fence: f }),
    /EPISODE_ALREADY_TERMINAL|REVIEW_ALREADY_RECORDED/
  );
  assert.equal(readState(root, runId).data.circuit_breaker.consecutive_request_changes, breakerAfterFirst);
});

// Fix 1 (round 4): stale fence → LEASE_FENCED thrown, no partial mutation (breaker / review_points_done unchanged)
test('recordReviewOutcome: stale fence throws LEASE_FENCED; breaker and review_points_done not mutated', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T00:00:00Z');
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  doneMaker(root, runId, ws, 'plan', f);
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  // Capture fence with current owner+generation (gen=1)
  const staleFence = { owner: runId, generation: 1, intent: 'business' };
  const breakerBefore = readState(root, runId).data.circuit_breaker.consecutive_request_changes;
  // Now advance the lease generation: release + child acquires (gen bumps to 2)
  releaseLease(root, runId, { owner: runId, generation: 1 });
  acquireLease(root, runId, { owner: 'CHILD-ACTOR', expectGeneration: 1, runtime: 'claude', now });
  // recordReviewOutcome with stale fence must throw LEASE_FENCED somewhere in the chain
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'APPROVE', fence: staleFence }),
    /LEASE_FENCED/
  );
  // Codex impl r10 🔴: ATOMIC — the checker must NOT be terminalized (no half-commit) when the fenced
  // transaction is rejected. With the old multi-lock version the checker was approved before the later
  // fenced writes threw; the single-transaction version leaves it fully unmutated.
  assert.equal(readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId).status, 'pending');
  // Breaker counter must not have been mutated
  assert.equal(readState(root, runId).data.circuit_breaker.consecutive_request_changes, breakerBefore);
  // review_points_done must not contain 'plan'
  const wsData = readState(root, runId).data.workstreams.find(w => w.id === ws);
  assert.ok(!wsData.review_points_done.includes('plan'), 'review_points_done must not include plan after fenced call');
});

// Codex r13: FENCE_REQUIRED — mutators throw when fence is absent
test('dispatchReview throws FENCE_REQUIRED when called without fence', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  assert.throws(
    () => dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true } }),
    /FENCE_REQUIRED/
  );
});

// Codex impl r14 🟡: dispatchReview must reject a missing/nonexistent workstream at dispatch time (no stranded checker).
test('dispatchReview rejects missing/nonexistent workstream and creates no checker episode', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  assert.throws(() => dispatchReview(root, runId, { point: 'plan', workstreamId: 'ws-nope', detected: { 'deep-review': true }, fence: f }), /WORKSTREAM_NOT_FOUND/);
  assert.throws(() => dispatchReview(root, runId, { point: 'plan', detected: { 'deep-review': true }, fence: f }), /WORKSTREAM_NOT_FOUND/);
  assert.equal(readState(root, runId).data.episodes.length, 0);   // no stranded checker
});

// ROOT FIX (1): dispatchReview for a (point, ws) with NO eligible done maker throws REVIEW_NO_ELIGIBLE_MAKER and
// creates NO checker — an unbound checker ("reviewed no maker") can never be created at the source going forward.
test('dispatchReview throws REVIEW_NO_ELIGIBLE_MAKER when no done maker exists for the point', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  // workstream EXISTS but there is no done maker for (ws, 'plan') → refuse to create an unbound checker.
  assert.throws(() => dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f }), /REVIEW_NO_ELIGIBLE_MAKER/);
  assert.equal(readState(root, runId).data.episodes.length, 0);   // no checker created
  // A pending (not done) maker is still not eligible — dispatch stays refused (episode.mjs 'in_progress' fixture).
  newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'plan', point: 'plan', workstream: ws, fence: f });
  assert.throws(() => dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f }), /REVIEW_NO_ELIGIBLE_MAKER/);
});

// ROOT FIX (2) defense-in-depth: recording a verdict on an UNBOUND checker (no target_maker) throws
// REVIEW_UNBOUND_CHECKER — so a legacy pending unbound checker can never be terminalized into a rejected/approved one.
test('recordReviewOutcome throws REVIEW_UNBOUND_CHECKER on a checker with no target_maker', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  // Inject a legacy unbound pending checker directly (dispatchReview can no longer create one) to prove the guard.
  const data = readState(root, runId).data;
  data.episodes.push({
    id: '001-deep-review', role: 'checker', plugin: 'subagent-checker', status: 'pending',
    point: 'plan', workstream_id: ws, kind: 'plan-review',
    request_rel: 'episodes/001-deep-review/request.md',
  });
  writeState(root, runId, data);
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: '001-deep-review', verdict: 'APPROVE', fence: f }),
    /REVIEW_UNBOUND_CHECKER/
  );
});

// FIX 3 regression (a): require_human_ack=true → approved review record does NOT change episodes_human_reviewed
// (even when source is 'deep-review-approve' or any other source). Only /deep-loop-ack may grant comprehension.
test('recordReviewOutcome: require_human_ack=true → episodes_human_reviewed unchanged after approve', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ack-'));
  const reviewCfg = { points: ['implementation'], reviewer: 'deep-review-loop', mode: 'cross-model', flags: [], converge: true, max_review_rounds: 5, require_human_ack: true };
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', review: reviewCfg, detected: { 'deep-review': true }, now: new Date('2026-06-24T00:00:00Z') });
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  doneMaker(root, runId, ws, 'implementation', f);   // done so the checker binds; require_human_ack still gates comprehension
  const r = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  const beforeReviewed = readState(root, runId).data.comprehension?.episodes_human_reviewed || 0;
  // approve with any source — must NOT increment comprehension when require_human_ack=true
  const repI = wsReport(root, '.claude/worktrees/w', 'impl-review.md');
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'APPROVE', proof: { report: repI }, fence: f });
  const afterReviewed = readState(root, runId).data.comprehension?.episodes_human_reviewed || 0;
  assert.equal(afterReviewed, beforeReviewed, 'require_human_ack=true must not increment episodes_human_reviewed from review record');
});

test('unsatisfiedReviewPoints: returns points not covered by any workstream review_points_done', () => {
  const loop = { review: { points: ['design', 'plan', 'implementation'] },
    workstreams: [{ id: 'w', review_points_done: ['design', 'plan'] }] };
  assert.deepEqual(unsatisfiedReviewPoints(loop), ['implementation']);
});
test('unsatisfiedReviewPoints: empty points -> [] (vacuous)', () => {
  assert.deepEqual(unsatisfiedReviewPoints({ review: { points: [] }, workstreams: [] }), []);
  assert.deepEqual(unsatisfiedReviewPoints({ workstreams: [] }), []);
});
test('unsatisfiedReviewPoints: union across multiple workstreams', () => {
  const loop = { review: { points: ['design', 'implementation'] },
    workstreams: [{ id: 'a', review_points_done: ['design'] }, { id: 'b', review_points_done: ['implementation'] }] };
  assert.deepEqual(unsatisfiedReviewPoints(loop), []);
});

test('recordReviewOutcome: rejects recording on an abandoned checker', () => {
  const { root, runId, fence } = freshRun();
  const ws = newWorkstream(root, runId, { title: 'W', branch: 'b', worktree: '.claude/worktrees/wt', fence });
  writeFileSync(join(root, 'art.txt'), 'x');
  const m = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws.id, expectedArtifacts: ['art.txt'], fence });
  recordEpisode(root, runId, m.id, { status: 'in_progress', fence });
  recordEpisode(root, runId, m.id, { status: 'done', artifacts: ['art.txt'], proof: {}, fence });
  const dr = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws.id, detected: { 'deep-review': true }, fence });
  abandonEpisode(root, runId, dr.checkerEpisodeId, { reason: 'stale checker', confirm: true, fence });
  assert.throws(() => recordReviewOutcome(root, runId, { episodeId: dr.checkerEpisodeId, verdict: 'APPROVE', fence }), /REVIEW_ALREADY_RECORDED/);
  // review point 오염 없음
  const ws2 = readState(root, runId).data.workstreams.find(w => w.id === ws.id);
  assert.ok(!ws2.review_points_done.includes('implementation'));
});

test('recordReviewOutcome: rejects recording on a done checker (defensive)', () => {
  const { root, runId, fence } = freshRun();
  const ws = newWorkstream(root, runId, { title: 'W', branch: 'b', worktree: '.claude/worktrees/wt', fence });
  writeFileSync(join(root, 'art.txt'), 'x');
  const m = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws.id, expectedArtifacts: ['art.txt'], fence });
  recordEpisode(root, runId, m.id, { status: 'in_progress', fence });
  recordEpisode(root, runId, m.id, { status: 'done', artifacts: ['art.txt'], proof: {}, fence });
  const dr = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws.id, detected: { 'deep-review': true }, fence });
  // checker 를 'done' 으로 강제(정상 경로로는 도달 불가 — 방어적 가드 확인)
  const data = readState(root, runId).data; data.episodes.find(e => e.id === dr.checkerEpisodeId).status = 'done'; writeState(root, runId, data);
  assert.throws(() => recordReviewOutcome(root, runId, { episodeId: dr.checkerEpisodeId, verdict: 'APPROVE', fence }), /REVIEW_ALREADY_RECORDED/);
});

// #1: a machine APPROVE auto-marks the bound maker AGENT-reviewed (by exactly 1 — only maker2), and never
// touches the human gate counter (episodes_human_reviewed). Machine review must not lower comprehension debt.
test('recordReviewOutcome: bound approve increments episodes_agent_reviewed by 1 (only the bound maker), human gate untouched', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  // Two done makers on the same point — both must be done for dispatchReview to bind to the latest.
  writeFileSync(join(root, 'impl1.txt'), 'artifact 1');
  writeFileSync(join(root, 'impl2.txt'), 'artifact 2');
  const { id: maker1Id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws, expectedArtifacts: ['impl1.txt'], fence: f });
  recordEpisode(root, runId, maker1Id, { status: 'in_progress', fence: f });
  recordEpisode(root, runId, maker1Id, { status: 'done', artifacts: ['impl1.txt'], proof: {}, fence: f });
  const { id: maker2Id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws, expectedArtifacts: ['impl2.txt'], fence: f });
  recordEpisode(root, runId, maker2Id, { status: 'in_progress', fence: f });
  recordEpisode(root, runId, maker2Id, { status: 'done', artifacts: ['impl2.txt'], proof: {}, fence: f });
  // dispatch review — binds to the latest unreviewed done maker (maker2)
  const r = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  const cBefore = readState(root, runId).data.comprehension;
  const repB = wsReport(root, '.claude/worktrees/w', 'review.md', '# review report\nverdict APPROVE');
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'APPROVE', proof: { report: repB }, fence: f });
  const cAfter = readState(root, runId).data.comprehension;
  assert.equal((cAfter.episodes_agent_reviewed || 0) - (cBefore.episodes_agent_reviewed || 0), 1, 'only the bound maker (maker2) should be marked agent_reviewed');
  assert.equal(cAfter.episodes_human_reviewed || 0, cBefore.episodes_human_reviewed || 0, 'machine review must not touch the human gate counter');
});

// ── C2: object-shape routing — P1 의도 변경: 구성된 deep-review reviewer의 부재는 강등이 아니라 fail-closed.
// (구 동작은 codex-cross/subagent-checker로 조용히 대체 — recordReviewOutcome이 report producer를 검증하지
// 않으므로 대체된 checker의 APPROVE도 finish proof를 만족한다. 전체 fail-closed 경로는 reviewer-failclosed.test.mjs.)
test('C2: resolveReviewer fails closed for a configured deep-review reviewer when not present (object shape)', () => {
  const { root, runId } = seed({ 'deep-review': { present: true } });   // → review.reviewer = 'deep-review-loop'
  const { data } = readState(root, runId);
  // deep-review absent → fail-closed, codex 유무 무관 (조용한 대체 제거)
  assert.throws(() => resolveReviewer(data, { 'deep-review': { present: false }, codex: { present: true } }), /REVIEWER_DEPENDENCY_MISSING/);
  assert.throws(() => resolveReviewer(data, { 'deep-review': { present: false }, codex: { present: false } }), /REVIEWER_DEPENDENCY_MISSING/);
  // deep-review present → stays deep-review-loop
  assert.equal(resolveReviewer(data, { 'deep-review': { present: true } }).reviewer, 'deep-review-loop');
  // installed-but-uninitialized (original Problem C) → present:true → stays deep-review-loop
  assert.equal(resolveReviewer(data, { 'deep-review': { installed: true, initialized: false, present: true } }).reviewer, 'deep-review-loop');
});

test('subagent checker descriptor is runtime-neutral and Codex presence does not change it', () => {
  const { root, runId } = seed({ 'deep-review': false, codex: true });
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  doneMaker(root, runId, ws, 'implementation', f);
  const r = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws, detected: { 'deep-review': false, codex: true }, fence: f });
  assert.equal(r.reviewer, 'subagent-checker');
  assert.equal(r.descriptor.kind, 'agent');
  assert.equal(r.descriptor.role, 'checker');
  assert.equal(r.descriptor.agent_role, 'code-reviewer');
  assert.equal(r.descriptor.requires_independent_session, true);
  assert.equal('skill' in r.descriptor, false);
  assert.equal(JSON.stringify(r.descriptor).includes('Task('), false);
});

test('legacy standalone reviewer upgrades only with an explicit independent-subagent assertion and records the decision', () => {
  const { root, runId } = seed({ 'deep-review': false, codex: false });
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f }).id;
  const makerId = doneMaker(root, runId, ws, 'plan', f);
  const { data } = readState(root, runId);
  data.review.reviewer = 'standalone';
  writeState(root, runId, data);

  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { codex: true }, independentSubagent: true, fence: f });
  assert.equal(r.reviewer, 'subagent-checker');
  assert.equal(r.descriptor.kind, 'agent');
  const ep = readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId);
  assert.equal(ep.status, 'pending');
  assert.equal(ep.target_maker, makerId);
  assert.deepEqual(ep.reviewer_resolution, {
    legacy_reviewer: 'standalone',
    decision: 'upgraded',
    reviewer: 'subagent-checker',
    asserted_capability: 'independent-subagent',
  });
  const report = wsReport(root, '.claude/worktrees/w', 'upgraded-review.md');
  recordReviewOutcome(root, runId, {
    episodeId: r.checkerEpisodeId, verdict: 'APPROVE', proof: { report }, fence: f,
  });
  const approved = readState(root, runId).data;
  assert.equal(approved.episodes.find(e => e.id === r.checkerEpisodeId).status, 'approved');
  assert.equal(makerReviewed(approved, approved.episodes.find(e => e.id === makerId)), true);
});

test('legacy standalone reviewer without an independent assertion creates a blocked needs-human checker and cannot become proof', () => {
  const { root, runId } = seed({ 'deep-review': false, codex: true });
  const f = fence(runId);
  const worktree = '.claude/worktrees/w';
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree, fence: f }).id;
  const makerId = doneMaker(root, runId, ws, 'plan', f);
  const { data } = readState(root, runId);
  data.review.reviewer = 'standalone';
  writeState(root, runId, data);

  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { codex: true }, fence: f });
  assert.equal(r.reviewer, 'standalone');
  assert.equal(r.descriptor.kind, 'blocked');
  assert.equal(r.descriptor.role, 'checker');
  assert.equal(r.descriptor.needs_human, true);
  assert.equal(r.descriptor.reason, 'legacy-inline-checker-unsupported');
  const ep = readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId);
  assert.equal(ep.status, 'blocked');
  assert.equal(ep.target_maker, makerId);
  assert.equal(ep.block_reason, 'legacy-inline-checker-unsupported');
  assert.deepEqual(ep.reviewer_resolution, {
    legacy_reviewer: 'standalone',
    decision: 'blocked',
    reason: 'legacy-inline-checker-unsupported',
  });
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'REQUEST_CHANGES', fence: f }),
    /REVIEW_CHECKER_BLOCKED/
  );
  assert.equal(readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId).status, 'blocked');
});

test('proof-capable checker identity: record rejects a target-bound pending legacy standalone checker atomically', () => {
  const f = legacyStandaloneChecker();
  const report = wsReport(f.root, f.worktree, 'legacy-standalone-review.md');
  const beforeHash = readFileSync(join(runDir(f.root, f.runId), '.loop.hash'), 'utf8');
  const beforeEvents = eventLog(f.root, f.runId).length;

  assert.throws(() => recordReviewOutcome(f.root, f.runId, {
    episodeId: f.checkerEpisodeId,
    verdict: 'APPROVE',
    proof: { report },
    fence: f.f,
  }), /REVIEW_CHECKER_IDENTITY_UNSUPPORTED/);

  const after = readState(f.root, f.runId).data;
  assert.equal(after.episodes.find(e => e.id === f.checkerEpisodeId).status, 'pending');
  assert.equal(Boolean(after.episodes.find(e => e.id === f.makerId).agent_reviewed), false);
  assert.deepEqual(after.workstreams.find(w => w.id === f.ws).review_points_done, []);
  assert.equal(eventLog(f.root, f.runId).length, beforeEvents);
  assert.equal(readFileSync(join(runDir(f.root, f.runId), '.loop.hash'), 'utf8'), beforeHash);
});

test('proof-capable checker identity: import rejects a pending legacy standalone checker without materializing proof', () => {
  const f = legacyStandaloneChecker();
  const raw = JSON.stringify({
    schema_version: '1.0',
    reviewer_id: 'standalone',
    checker_episode_id: f.checkerEpisodeId,
    target_maker: f.makerId,
    attempt_id: 'legacy-attempt',
    verdict: 'APPROVE',
    report_body: '# legacy inline review\n\nAPPROVE',
    artifacts: [{
      path: f.artifact,
      sha256: contentHash(readFileSync(join(f.root, f.artifact))),
    }],
  });
  const beforeHash = readFileSync(join(runDir(f.root, f.runId), '.loop.hash'), 'utf8');
  const beforeEvents = eventLog(f.root, f.runId).length;

  assert.throws(() => importReviewOutcome(f.root, f.runId, {
    raw, fence: f.f, now: '2026-07-11T04:00:00.000Z',
  }), /REVIEW_IMPORT_REVIEWER_INVALID/);

  assert.equal(readState(f.root, f.runId).data.episodes.find(e => e.id === f.checkerEpisodeId).status, 'pending');
  assert.equal(eventLog(f.root, f.runId).length, beforeEvents);
  assert.equal(readFileSync(join(runDir(f.root, f.runId), '.loop.hash'), 'utf8'), beforeHash);
  assert.equal(existsSync(join(runDir(f.root, f.runId), 'reviews')), false);
});

// ── #2: a passing verdict needs a REAL, project-root-contained review report (maker symmetry) ──

// #2(a): APPROVE with no report → REVIEW_NO_EVIDENCE (checker can no longer rubber-stamp with zero evidence).
test('#2(a): APPROVE without a report is refused (REVIEW_NO_EVIDENCE)', () => {
  const { root, runId, fence } = freshRun();
  const { ws, checkerId } = boundChecker(root, runId, fence, 'plan');
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: checkerId, verdict: 'APPROVE', proof: {}, fence }),
    /REVIEW_NO_EVIDENCE/
  );
  // checker stays pending (atomic — no half-commit)
  assert.equal(readState(root, runId).data.episodes.find(e => e.id === checkerId).status, 'pending');
});

// #2(b): inline findings alone (no durable report artifact) cannot satisfy a passing verdict — forgeable.
test('#2(b): findings-only APPROVE is refused (forged findings cannot stand in for a report)', () => {
  const { root, runId, fence } = freshRun();
  const { ws, checkerId } = boundChecker(root, runId, fence, 'plan');
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: checkerId, verdict: 'APPROVE', proof: { findings: 'looks fine to me' }, fence }),
    /REVIEW_NO_EVIDENCE/
  );
});

// #2(c): APPROVE + a real report under the reviewed worktree → succeeds AND the review-outcome event records the
// path + content hash.
test('#2(c): APPROVE with a real report under the ws worktree succeeds; event records report path + content hash', () => {
  const { root, runId, fence } = freshRun();
  const { ws, checkerId, worktree } = boundChecker(root, runId, fence, 'plan');
  const report = wsReport(root, worktree, 'plan-review.md', '# plan review\nverdict APPROVE — no blockers');
  recordReviewOutcome(root, runId, { episodeId: checkerId, verdict: 'APPROVE', proof: { report, findings: 'ok' }, fence });
  assert.equal(readState(root, runId).data.episodes.find(e => e.id === checkerId).status, 'approved');
  const ev = eventLog(root, runId).find(e => e.type === 'review-outcome' && e.data.episodeId === checkerId);
  assert.ok(ev, 'a review-outcome event must be appended');
  assert.equal(ev.data.report, report);
  assert.equal(ev.data.report_sha256, contentHash(readFileSync(join(root, report), 'utf8')));
  assert.equal(ev.data.findings, 'ok');
});

test('recordReviewOutcome uses an injected now for the recorded-path event timestamp', () => {
  const fixedNow = Date.parse('2026-08-10T00:00:00Z');
  const { root, runId, fence } = freshRun();
  const { checkerId } = boundChecker(root, runId, fence, 'plan');

  recordReviewOutcome(root, runId, {
    episodeId: checkerId, verdict: 'REQUEST_CHANGES', fence, now: fixedNow,
  });

  const outcome = eventLog(root, runId).findLast(event => event.type === 'review-outcome');
  assert.equal(outcome.ts, '2026-08-10T00:00:00.000Z');
});

test('recordReviewOutcome without now retains a valid wall-clock event timestamp', () => {
  const { root, runId, fence } = freshRun();
  const { checkerId } = boundChecker(root, runId, fence, 'plan');
  const before = Date.now();

  recordReviewOutcome(root, runId, {
    episodeId: checkerId, verdict: 'REQUEST_CHANGES', fence,
  });

  const after = Date.now();
  const outcome = eventLog(root, runId).findLast(event => event.type === 'review-outcome');
  const timestamp = Date.parse(outcome.ts);
  assert.equal(Number.isFinite(timestamp), true);
  assert.ok(timestamp >= before && timestamp <= after, `${outcome.ts} must be within the call interval`);
});

test('recordReviewOutcome rejects invalid injected now values without mutation', () => {
  for (const now of ['not-a-date', Number.NaN, {}]) {
    const { root, runId, fence } = freshRun();
    const { checkerId } = boundChecker(root, runId, fence, 'plan');
    recordEpisode(root, runId, checkerId, {
      status: 'in_progress', fence, now: Date.parse('2026-08-09T00:00:00Z'),
    });
    const beforeEvents = eventLog(root, runId).length;

    assert.throws(() => recordReviewOutcome(root, runId, {
      episodeId: checkerId, verdict: 'REQUEST_CHANGES', fence, now,
    }), /INVALID_NOW: event timestamp/);

    assert.equal(readState(root, runId).data.episodes.find(e => e.id === checkerId).status, 'in_progress');
    assert.equal(eventLog(root, runId).length, beforeEvents);
  }
});

// impl-R2 Fix 4: an existing root-contained file that is NOT under the reviewed workstream's worktree (e.g. a stale
// README.md) cannot be reused as evidence; a report UNDER the worktree is accepted (positive control).
test('#2(Fix4): a real root file outside the reviewed worktree is refused; a report under the worktree is accepted', () => {
  const { root, runId, fence } = freshRun();
  const { ws, checkerId, worktree } = boundChecker(root, runId, fence, 'plan');
  writeFileSync(join(root, 'README.md'), '# unrelated');   // exists + root-contained, but NOT under the ws worktree
  assert.throws(() => recordReviewOutcome(root, runId, { episodeId: checkerId, verdict: 'APPROVE', proof: { report: 'README.md' }, fence }), /REVIEW_NO_EVIDENCE/);
  const report = wsReport(root, worktree, 'plan-review.md');
  const r = recordReviewOutcome(root, runId, { episodeId: checkerId, verdict: 'APPROVE', proof: { report }, fence });
  assert.equal(r.terminal, 'approved');
});

// #2(d): a report path outside the project root (or absent) → REVIEW_NO_EVIDENCE.
test('#2(d): report outside root or absent is refused', () => {
  const { root, runId, fence } = freshRun();
  const { ws, checkerId } = boundChecker(root, runId, fence, 'plan');
  assert.throws(() => recordReviewOutcome(root, runId, { episodeId: checkerId, verdict: 'APPROVE', proof: { report: '../escape.md' }, fence }), /REVIEW_NO_EVIDENCE/);
  assert.throws(() => recordReviewOutcome(root, runId, { episodeId: checkerId, verdict: 'APPROVE', proof: { report: 'does-not-exist.md' }, fence }), /REVIEW_NO_EVIDENCE/);
});

// #2(e): a SYMLINK under the ws worktree pointing OUTSIDE the project must be refused (realpath deref containment) —
// isAbsolute/'..'+existsSync alone would pass it (design-R3 #6). Placed under the worktree so the ONLY failure
// reason is the escape (not the Fix-4 worktree binding).
test('#2(e): a symlink under the ws worktree escaping the project is refused (realpath containment)', (t) => {
  const { root, runId, fence } = freshRun();
  const { ws, checkerId, worktree } = boundChecker(root, runId, fence, 'plan');
  const outside = mkdtempSync(join(tmpdir(), 'dl-outside-'));
  writeFileSync(join(outside, 'secret.md'), '# outside the project');
  mkdirSync(join(root, worktree), { recursive: true });
  if (!createFileSymlinkOrSkip(t, join(outside, 'secret.md'), join(root, worktree, 'link.md'))) return;
  assert.throws(() => recordReviewOutcome(root, runId, { episodeId: checkerId, verdict: 'APPROVE', proof: { report: join(worktree, 'link.md') }, fence }), /REVIEW_NO_EVIDENCE/);
});

// #2(f): the recorded hash pins the exact report content — a post-hoc edit is detectable (stored hash mismatch).
test('#2(f): recorded report hash detects a post-hoc content change (tamper smoke)', () => {
  const { root, runId, fence } = freshRun();
  const { ws, checkerId, worktree } = boundChecker(root, runId, fence, 'plan');
  const report = wsReport(root, worktree, 'r.md', 'original review');
  recordReviewOutcome(root, runId, { episodeId: checkerId, verdict: 'APPROVE', proof: { report }, fence });
  const ev = eventLog(root, runId).find(e => e.type === 'review-outcome' && e.data.episodeId === checkerId);
  writeFileSync(join(root, report), 'tampered review');   // edit after recording
  assert.notEqual(ev.data.report_sha256, contentHash(readFileSync(join(root, report), 'utf8')), 'a content change must diverge from the recorded hash');
});

// #2(g): REQUEST_CHANGES stays lightweight — no report required (only the passing path opens finish proof).
test('#2(g): REQUEST_CHANGES needs no report (lightweight reject path)', () => {
  const { root, runId, fence } = freshRun();
  const { ws, checkerId } = boundChecker(root, runId, fence, 'plan');
  const r = recordReviewOutcome(root, runId, { episodeId: checkerId, verdict: 'REQUEST_CHANGES', proof: {}, fence });
  assert.equal(r.terminal, 'rejected');
});
