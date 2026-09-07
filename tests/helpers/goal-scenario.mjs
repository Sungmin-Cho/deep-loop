import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeGoalFixture } from './goal-fixture.mjs';
import { goalOk, nativeObservation } from './reviewed-goal.mjs';

export const PHASE_REVIEW = Object.freeze({ points: ['design', 'plan', 'implementation'], reviewer: 'subagent-checker',
  mode: 'cross-model', flags: [], converge: true, max_review_rounds: 5, require_human_ack: false });

export function createScenarioMaker(f, ws, point = 'implementation', { kind = point, retryOf } = {}) {
  const artifact = `${ws.worktree}/${point}.${point === 'implementation' ? 'mjs' : 'md'}`;
  const created = goalOk(f.cli(['episode', 'new', '--plugin', 'standalone', '--role', 'maker', '--kind', kind,
    '--point', point, '--workstream', ws.id, '--artifacts', JSON.stringify([artifact]), ...(retryOf ? ['--retry-of', retryOf] : [])]));
  return { id: created.id, artifact, point, kind, workstream_id: ws.id };
}

export function produceScenarioMaker(f, maker, trace = [], { stage = 'primary', task = `Complete ${maker.point}` } = {}) {
  const prepared = goalOk(f.cli(['execution', 'prepare', '--episode', maker.id, '--mode', 'inline', '--stage', stage, '--task', task]));
  const current = f.state().episodes.find(item => item.id === maker.id);
  const ws = f.state().workstreams.find(item => item.id === current.workstream_id);
  const intermediate = prepared.execution.stage !== prepared.execution.required_stages.at(-1);
  const artifacts = intermediate ? [`${ws.worktree}/implementation-plan.md`] : current.expected_artifacts;
  // This actual fixture producer is distinct from the kernel. All tests mark its
  // reviewer as synthetic; these calls never count as model execution evidence.
  for (const artifact of artifacts) writeFileSync(join(f.root, artifact), artifact.endsWith('.mjs') ? 'export const answer = 42;\n' : '# Reviewed fixture work\n');
  trace.push({ episode: maker.id, kind: current.kind, stage, invocation: prepared.invocation });
  goalOk(f.cli(['execution', 'return', '--episode', maker.id, '--attempt', prepared.execution.attempt_id, '--artifacts', JSON.stringify(artifacts)]));
}

export function reviewScenarioMaker(f, makerId, verdict = 'APPROVE') {
  const maker = f.state().episodes.find(item => item.id === makerId);
  const checker = goalOk(f.cli(['review', 'dispatch', '--point', maker.point, '--workstream', maker.workstream_id, '--independent-subagent'])).checkerEpisodeId;
  const claim = goalOk(f.cli(['review', 'claim', '--episode', checker]));
  const handle = `synthetic-${checker}`;
  goalOk(f.cli(['execution', 'start', '--episode', checker, '--attempt', claim.attemptId, '--handle', handle]));
  goalOk(f.cli(['execution', 'return', '--episode', checker, '--attempt', claim.attemptId, '--artifacts', '[]', '--observation', JSON.stringify(nativeObservation('succeeded', handle))]));
  goalOk(f.cli(['review', 'import', '--stdin'], { input: JSON.stringify({ schema_version: '1.0', reviewer_id: claim.claim.reviewer_id,
    checker_episode_id: checker, target_maker: makerId, attempt_id: claim.attemptId, verdict,
    report_body: `# Synthetic independent scenario reviewer\n${verdict}`, artifacts: claim.claim.artifacts }) }));
  return checker;
}

export function seedPhaseGap() {
  const f = makeGoalFixture({ review: PHASE_REVIEW });
  const ws = f.workstream('delivery');
  const maker = createScenarioMaker(f, ws, 'design');
  produceScenarioMaker(f, maker); reviewScenarioMaker(f, maker.id);
  return { ...f, delivery: ws, designMaker: maker };
}

export function approveScenarioGoal(f) {
  const review = goalOk(f.cli(['goal', 'dispatch', '--transport', 'native'])).review;
  const snapshot = JSON.parse(readFileSync(join(f.root, '.deep-loop', 'runs', f.runId, review.snapshot_rel), 'utf8')).payload;
  const raw = JSON.stringify({ schema_version: 1, review_id: review.id, attempt_id: review.execution.attempt_id,
    goal_sha256: review.goal_sha256, snapshot_sha256: review.snapshot_sha256, verdict: 'APPROVE',
    requirements: f.state().goal_contract.requirements.map(({ id }) => ({ id, status: 'pass', evidence: [snapshot.artifacts[0].ref], reason: null })),
    report_body: '# Synthetic independent whole-goal scenario review\n' });
  const handle = 'synthetic-goal-scenario-reviewer';
  goalOk(f.cli(['goal', 'start', '--id', review.id, '--attempt', review.execution.attempt_id, '--handle', handle]));
  goalOk(f.cli(['goal', 'reconcile', '--id', review.id, '--attempt', review.execution.attempt_id,
    '--observation', JSON.stringify({ ...nativeObservation('succeeded', handle), output_sha256: createHash('sha256').update(raw).digest('hex') })]));
  goalOk(f.cli(['goal', 'record', '--stdin'], { input: raw }));
}

export function driveScenario(f, { firstReview = 'APPROVE', maxTicks = 60 } = {}) {
  const trace = { producerCalls: [], reviewerCalls: [], actions: [] };
  let rejected = false;
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const loop = f.state(); if (loop.status === 'completed') return trace;
    const action = goalOk(f.cli(['next-action', '--json'])).action; trace.actions.push(action);
    const ws = loop.workstreams.find(item => item.id === action.workstream_id);
    if (action.type === 'plan_next_work') {
      const target = ws || f.workstream(`work-${loop.workstreams.length + 1}`, action.requirement_ids);
      createScenarioMaker(f, target, action.point || loop.review.points[0]);
    } else if (action.type === 'select_workstream') {
      goalOk(f.select(action.workstream_id, action.expected_scope));
    } else if (action.type === 'dispatch_maker' || action.type === 'resume_maker') {
      const maker = loop.episodes.find(item => item.id === action.episode_id);
      produceScenarioMaker(f, maker, trace.producerCalls, { stage: action.stage || 'primary', task: maker.execution?.task || `Complete ${maker.point}` });
    } else if (action.type === 'dispatch_checker') {
      const verdict = firstReview === 'REQUEST_CHANGES' && !rejected ? 'REQUEST_CHANGES' : 'APPROVE';
      rejected ||= verdict === 'REQUEST_CHANGES';
      const checker = reviewScenarioMaker(f, action.episode_id, verdict); trace.reviewerCalls.push(checker);
    } else if (action.type === 'fix_episode') {
      const checker = loop.episodes.find(item => item.id === action.episode_id);
      createScenarioMaker(f, ws, action.point, { kind: 'fix', retryOf: checker.target_maker });
    } else if (action.type === 'close_workstream') {
      goalOk(f.cli(['workstream', 'terminal', '--id', ws.id, '--status', 'ready', '--proof', '{}']));
    } else if (action.type === 'dispatch_goal_checker') {
      approveScenarioGoal(f);
    } else if (action.type === 'finish') {
      writeFileSync(join(f.root, '.deep-loop', 'runs', f.runId, 'final-report.md'), '# Scenario final report\n');
      goalOk(f.cli(['finish', '--status', 'completed', '--report', 'final-report.md']));
    } else assert.fail(`unexpected stop/action: ${JSON.stringify(action)}`);
  }
  assert.fail('scenario exceeded its bounded tick count');
}
