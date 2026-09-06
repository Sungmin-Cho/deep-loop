import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeGoalFixture } from './goal-fixture.mjs';

export function goalOk(result) { assert.equal(result.exit, 0, result.stderr); return result.json; }
export const nativeObservation = (state, handle = 'synthetic-goal-reviewer') => ({ source: 'native-task', state, handle, reference: `synthetic-native-result:${state}` });

export function reviewedGoalWork(t, options = {}) {
  const f = makeGoalFixture({ review: { points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model', flags: [], converge: true, max_review_rounds: 5, require_human_ack: false }, ...options });
  t.after(f.cleanup);
  const delivery = f.workstream('delivery', options.requirementIds || ['REQ-A']);
  const artifact = f.artifact(delivery, 'answer.mjs', 'export const answer = 42;\n');
  const maker = goalOk(f.cli(['episode', 'new', '--plugin', 'standalone', '--role', 'maker', '--kind', 'implementation', '--point', 'implementation', '--workstream', delivery.id, '--artifacts', JSON.stringify([artifact])])).id;
  const execution = goalOk(f.cli(['execution', 'prepare', '--episode', maker, '--mode', 'inline', '--stage', 'primary', '--task', 'Deliver A'])).execution;
  goalOk(f.cli(['execution', 'return', '--episode', maker, '--attempt', execution.attempt_id, '--artifacts', JSON.stringify([artifact])]));
  const checker = goalOk(f.cli(['review', 'dispatch', '--point', 'implementation', '--workstream', delivery.id, '--independent-subagent'])).checkerEpisodeId;
  const claim = goalOk(f.cli(['review', 'claim', '--episode', checker]));
  const handle = 'synthetic-ordinary-reviewer';
  goalOk(f.cli(['execution', 'start', '--episode', checker, '--attempt', claim.attemptId, '--handle', handle]));
  goalOk(f.cli(['execution', 'return', '--episode', checker, '--attempt', claim.attemptId, '--artifacts', '[]', '--observation', JSON.stringify(nativeObservation('succeeded', handle))]));
  const raw = JSON.stringify({ schema_version: '1.0', reviewer_id: claim.claim.reviewer_id, checker_episode_id: checker,
    target_maker: maker, attempt_id: claim.attemptId, verdict: 'APPROVE', report_body: '# Synthetic independent ordinary reviewer\nAPPROVE',
    artifacts: [{ path: artifact, sha256: createHash('sha256').update(readFileSync(join(f.root, artifact))).digest('hex') }] });
  goalOk(f.cli(['review', 'import', '--stdin'], { input: raw }));
  goalOk(f.cli(['workstream', 'terminal', '--id', delivery.id, '--status', 'ready', '--proof', '{}']));
  const reportPath = join(f.root, '.deep-loop', 'runs', f.runId, 'final-report.md');
  writeFileSync(reportPath, '# Synthetic test final report\n');
  return { ...f, delivery, maker, checker, reportPath, productArtifact: artifact };
}
