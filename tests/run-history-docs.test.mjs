import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUN_SELECTION_BOUNDS } from '../scripts/lib/integrity.mjs';
import { INVALID_BAND_REASONS } from '../hooks/status-band/band.mjs';

// Issue #77 documentation contract: the prose states the code's bounds and reasons.
test('T16 README, README.ko and the status skill state the code bounds and reasons', () => {
  const read = rel => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
  const readme = read('README.md');
  const ko = read('README.ko.md');
  const skill = read('skills/deep-loop-status/SKILL.md');
  const b = RUN_SELECTION_BOUNDS;
  assert.ok(readme.includes(`At most ${b.maxRunIds} run directories, at most ${b.maxFullCaptures} runs that need the full verification, at most ${b.maxClaims} worktree claims`));
  assert.ok(readme.includes(`${b.baseDeadlineMs} ms plus ${b.perLightReadMs} ms per run directory`));
  assert.ok(readme.includes(`${b.baseDeadlineMs} ms plus ${b.perFullCaptureMs} ms per full verification, capped at ${b.maxDeadlineMs['cli-read']} ms for CLI reads and ${b.maxDeadlineMs['hook-checkpoint']} ms for hooks and \`run list\``));
  assert.ok(ko.includes(`run 디렉터리 ${b.maxRunIds}개, 전체 검증이 필요한 run ${b.maxFullCaptures}개, worktree claim ${b.maxClaims}개`));
  assert.ok(ko.includes(`${b.baseDeadlineMs}ms + run 디렉터리 1개당 ${b.perLightReadMs}ms`));
  assert.ok(ko.includes(`${b.baseDeadlineMs}ms + 전체 검증 1개당 ${b.perFullCaptureMs}ms이고, CLI 읽기는 ${b.maxDeadlineMs['cli-read']}ms, hook과 \`run list\`는 ${b.maxDeadlineMs['hook-checkpoint']}ms`));
  for (const purpose of ['hook-restore', 'run-list', 'headless']) {
    assert.equal(b.maxDeadlineMs[purpose], b.maxDeadlineMs['hook-checkpoint'], purpose);
  }
  for (const src of [readme, ko]) assert.ok(src.includes('this worktree belongs to a finished run'));
  for (const reason of INVALID_BAND_REASONS) {
    assert.ok(readme.includes(`\`${reason}\``), `README: ${reason}`);
    assert.ok(ko.includes(`\`${reason}\``), `README.ko: ${reason}`);
    assert.ok(skill.includes(`\`${reason}\``), `status skill: ${reason}`);
  }
  for (const word of ['state-missing', 'lock-busy', 'terminal-residue', 'source: worktree', '/deep-loop-finish', 'human_reason', 'phase: full-capture-count']) {
    assert.ok(skill.includes(word), `status skill: ${word}`);
  }
  assert.match(skill, /run resolve --cwd "<session_cwd>" --project-root "<canonical_project_root>"/);
});

