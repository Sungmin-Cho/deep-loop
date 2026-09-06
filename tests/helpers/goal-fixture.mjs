import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../scripts/deep-loop.mjs', import.meta.url));
export const GOAL_NOW = '2026-09-06T00:00:00.000Z';
export const TEST_GOAL_CONTRACT = Object.freeze({
  version: 1,
  requirements: [{ id: 'REQ-A', statement: 'Deliver A', acceptance: 'A behaves correctly on the declared inputs.' }],
  non_goals: [],
});

// This is a synthetic test host. All kernel state is created through public CLI
// routes; only business artifacts and the isolated project directory are local writes.
export function makeGoalFixture(options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deep-loop-goal-')));
  const now = options.now ?? GOAL_NOW;
  const env = { ...process.env, NO_COLOR: '1', DEEP_LOOP_HEADLESS: '' };
  delete env.FORCE_COLOR;
  const invoke = (argv, input) => {
    const processResult = spawnSync(process.execPath, [CLI, ...argv, '--project-root', root, '--now', now], {
      cwd: root, env, input, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    let json = null;
    try { json = JSON.parse(processResult.stdout); } catch { /* Non-JSON errors are preserved below. */ }
    return { exit: processResult.status, stdout: processResult.stdout, stderr: processResult.stderr, json };
  };
  const initArgs = ['init-run', '--runtime', options.runtime ?? 'claude', '--goal', options.goal ?? 'Deliver A', '--protocol', options.protocol ?? 'standalone'];
  if (options.legacy !== true) initArgs.push('--goal-contract', JSON.stringify(options.contract ?? TEST_GOAL_CONTRACT));
  if (options.supervision !== undefined) initArgs.push('--supervision', options.supervision);
  if (options.boundaryMode !== undefined) initArgs.push('--boundary-mode', options.boundaryMode);
  if (options.review !== undefined) initArgs.push('--review', JSON.stringify(options.review));
  const initial = invoke(initArgs);
  if (initial.exit !== 0) {
    rmSync(root, { recursive: true, force: true });
    assert.equal(initial.exit, 0, initial.stderr);
  }
  const runId = initial.json.run_id;
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const cli = (argv, { input, fence: commandFence = fence } = {}) => invoke([
    ...argv, '--run-id', runId,
    ...(['state', 'next-action', 'validate', 'goal'].includes(argv[0])
      && (argv[0] !== 'goal' || argv[1] === 'status') ? [] : ['--owner', commandFence.owner, '--generation', String(commandFence.generation)]),
  ], input);
  const state = () => {
    const result = cli(['state', 'get']);
    assert.equal(result.exit, 0, result.stderr);
    return result.json;
  };
  return {
    root, runId, fence, cli, state,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    workstream(title, requirementIds = ['REQ-A']) {
      const worktree = `.worktrees/${title}`;
      mkdirSync(join(root, worktree), { recursive: true });
      const args = ['workstream', 'new', '--title', title, '--branch', `test/${title}`, '--worktree', worktree];
      if (options.legacy !== true) args.push('--requirements', JSON.stringify(requirementIds));
      const result = cli(args);
      assert.equal(result.exit, 0, result.stderr);
      return { id: result.json.id, worktree };
    },
    artifact(ws, path, content) {
      assert.ok(!path.startsWith('/') && !path.split(/[\\/]/).includes('..'));
      const rel = `${ws.worktree}/${path}`;
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
      return rel;
    },
    select(id, token) {
      return cli(['workstream', 'select', '--id', id, '--expected-scope', token, '--reason', 'test prerequisite change']);
    },
  };
}
