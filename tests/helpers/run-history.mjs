// Terminal run history for issue #77 tests: one real stopped run, loop.json-only clones
// of it (enough for the lock-free history read), and one stopped run whose claim an
// older writer recorded as an absolute path to a since-deleted worktree.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from '../../scripts/lib/envelope.mjs';
import { finishRun } from '../../scripts/lib/finish.mjs';
import { initRun } from '../../scripts/lib/initrun.mjs';
import { runDir } from '../../scripts/lib/state.mjs';
import { newWorkstream } from '../../scripts/lib/workspace.mjs';

function stop(root, runId) {
  finishRun(root, runId, {
    status: 'stopped',
    proof: { human_reason: 'fixture history' },
    confirm: true,
    fence: { owner: runId, generation: 1, intent: 'business' },
  });
}

function rewriteLoop(root, runId, mutate) {
  const dir = runDir(root, runId);
  const data = JSON.parse(readFileSync(join(dir, 'loop.json'), 'utf8'));
  mutate(data);
  const raw = JSON.stringify(data, null, 2);
  writeFileSync(join(dir, 'loop.json'), raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
}

export function addTerminalHistory(root, {
  clones = 69,
  legacyAbsolute = true,
  now = Date.parse('2026-06-01T00:00:00Z'),
} = {}) {
  const current = (() => {
    try { return readFileSync(join(root, '.deep-loop', 'current'), 'utf8'); } catch { return null; }
  })();
  const { runId: source } = initRun(root, { runtime: 'claude', goal: 'history', now: new Date(now) });
  stop(root, source);
  const ids = [source];
  for (let index = 0; index < clones; index += 1) {
    const id = `01HISTORY${String(index).padStart(17, '0')}`;
    mkdirSync(runDir(root, id), { recursive: true });
    const data = JSON.parse(readFileSync(join(runDir(root, source), 'loop.json'), 'utf8'));
    data.run_id = id;
    const raw = JSON.stringify(data, null, 2);
    writeFileSync(join(runDir(root, id), 'loop.json'), raw);
    writeFileSync(join(runDir(root, id), '.loop.hash'), contentHash(raw));
    ids.push(id);
  }
  let legacy = null;
  if (legacyAbsolute) {
    const { runId } = initRun(root, { runtime: 'claude', goal: 'legacy', now: new Date(now + 1_000) });
    const worktree = join(root, '.worktrees', 'legacy-history');
    mkdirSync(worktree, { recursive: true });
    newWorkstream(root, runId, {
      title: 'legacy', branch: 'feature/legacy-history', worktree,
      fence: { owner: runId, generation: 1 },
    });
    stop(root, runId);
    rewriteLoop(root, runId, data => { data.workstreams[0].worktree = worktree; });
    rmSync(worktree, { recursive: true, force: true });
    legacy = runId;
    ids.push(runId);
  }
  // History must not move the current-run hint of the fixture under test.
  if (current !== null) writeFileSync(join(root, '.deep-loop', 'current'), current);
  return { ids, legacy };
}

export { rewriteLoop };
