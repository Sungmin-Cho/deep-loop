import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { reconcileBudget } from '../scripts/lib/budget.mjs';
import { newEpisode, recordEpisode, abandonEpisode } from '../scripts/lib/episode.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { ack, computeDebt } from '../scripts/lib/comprehension.mjs';
import { createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';

const ATTENDED = {};
const EPISODE_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deep-loop.mjs');
function runEpisodeCli(root, runId, args) {
  return spawnSync(process.execPath, [
    EPISODE_CLI, ...args, '--owner', runId, '--generation', '1',
    '--project-root', root, '--run-id', runId,
  ], { encoding: 'utf8' });
}

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

function fence(runId) { return { owner: runId, generation: 1, intent: 'business' }; }
function freshRun() { const { root, runId } = seed(); return { root, runId, fence: fence(runId) }; }
function durableEpisodeBytes(root, runId) {
  const dir = runDir(root, runId);
  return {
    loop: readFileSync(join(dir, 'loop.json')),
    hash: readFileSync(join(dir, '.loop.hash')),
    log: readFileSync(join(dir, 'event-log.jsonl')),
  };
}

test('C: the done transition clears a pre-emptive human ack credit', () => {
  const { root, runId, fence } = freshRun();
  const ws = newWorkstream(root, runId, { title: 'a', branch: 'a', worktree: '.claude/worktrees/a', fence }).id;
  writeFileSync(join(root, 'art.txt'), 'x');
  const sibling = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'design', workstream: ws, expectedArtifacts: ['art.txt'], fence }).id;
  recordEpisode(root, runId, sibling, { status: 'in_progress', fence });          // binds owner scope to ws
  const target = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'design', workstream: ws, expectedArtifacts: ['art.txt'], fence }).id;
  ack(root, runId, target, { actor: 'human', confirm: true, env: ATTENDED, fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_human_reviewed, 1);

  recordEpisode(root, runId, target, { status: 'in_progress', fence });
  recordEpisode(root, runId, target, { status: 'done', artifacts: ['art.txt'], fence });
  const d = readState(root, runId).data;
  assert.equal(d.episodes.find(e => e.id === target).human_reviewed, false);
  assert.equal(d.comprehension.episodes_human_reviewed, 0);
  assert.equal(computeDebt(d).blocked, true, 'the settled diff must still need a real human review');
});

test('C: the done transition clears a pre-emptive agent ack credit too', () => {
  const { root, runId, fence } = freshRun();
  const ws = newWorkstream(root, runId, { title: 'a', branch: 'a', worktree: '.claude/worktrees/a', fence }).id;
  writeFileSync(join(root, 'art.txt'), 'x');
  const sibling = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'design', workstream: ws, expectedArtifacts: ['art.txt'], fence }).id;
  recordEpisode(root, runId, sibling, { status: 'in_progress', fence });
  const target = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'design', workstream: ws, expectedArtifacts: ['art.txt'], fence }).id;
  ack(root, runId, target, { actor: 'agent', env: ATTENDED, fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_agent_reviewed, 1);

  recordEpisode(root, runId, target, { status: 'in_progress', fence });
  recordEpisode(root, runId, target, { status: 'done', artifacts: ['art.txt'], fence });
  const d = readState(root, runId).data;
  assert.equal(d.episodes.find(e => e.id === target).agent_reviewed, false);
  assert.equal(d.comprehension.episodes_agent_reviewed, 0);
});

test('H: a workstream-less maker cannot be recorded done under workstream-session', () => {
  const { root, runId, fence } = freshRun();
  writeFileSync(join(root, 'art.txt'), 'x');
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: ['art.txt'], fence });
  assert.throws(() => recordEpisode(root, runId, id, { status: 'done', artifacts: ['art.txt'], fence }), /WORKSTREAM_REQUIRED/);
});

test('H: a workstream-bound maker still records in_progress → done normally', () => {
  const { root, runId, fence } = freshRun();
  const ws = newWorkstream(root, runId, { title: 'a', branch: 'a', worktree: '.claude/worktrees/a', fence }).id;
  writeFileSync(join(root, 'art.txt'), 'x');
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws, expectedArtifacts: ['art.txt'], fence });
  recordEpisode(root, runId, id, { status: 'in_progress', fence });
  recordEpisode(root, runId, id, { status: 'done', artifacts: ['art.txt'], fence });
  assert.equal(readState(root, runId).data.episodes.find(e => e.id === id).status, 'done');
});

test('newEpisode scaffolds request.md, bumps episodes_total, sets current', () => {
  const { root, runId } = seed();
  const { id, requestPath } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', fence: fence(runId) });
  assert.match(id, /^001-deep-work$/);
  assert.ok(existsSync(requestPath));
  const { data } = readState(root, runId);
  assert.equal(data.comprehension.episodes_total, 1);
  assert.equal(data.current_episode, id);
  assert.equal(data.episodes[0].status, 'pending');
  assert.equal(data.episodes[0].request_rel, `episodes/${id}/request.md`);
  assert.equal(Object.hasOwn(data.episodes[0], 'request_path'), false);
  assert.equal(requestPath, join(runDir(root, runId), data.episodes[0].request_rel));
  assert.equal(data.episodes[0].verification.checker_episode_required, true);
});

test('recordEpisode non-terminal status + result_* allowed', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const workstream = newWorkstream(root, runId, { title: 'impl', branch: 'impl', worktree: '.claude/worktrees/impl', fence: f }).id;
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', workstream, fence: f });
  recordEpisode(root, runId, id, { status: 'in_progress', proof: { result_summary: 'started' }, fence: f });
  assert.equal(readState(root, runId).data.episodes[0].status, 'in_progress');
});

test('recordEpisode done requires expected artifacts to exist', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, {
    title: 'missing', branch: 'missing', worktree: '.claude/worktrees/missing', fence: f,
  }).id;
  const art = join(root, 'out.txt');
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation',
    workstream: ws, expectedArtifacts: ['out.txt'], fence: f,
  });
  recordEpisode(root, runId, id, { status: 'in_progress', fence: f });
  assert.throws(
    () => recordEpisode(root, runId, id, { status: 'done', artifacts: ['out.txt'], fence: f }),
    /EPISODE_TERMINAL_NO_PROOF/,
  );
  writeFileSync(art, 'x');
  recordEpisode(root, runId, id, { status: 'done', artifacts: ['out.txt'], fence: f });
  assert.equal(readState(root, runId).data.episodes[0].status, 'done');
});

// Fix 3: path-traversal plugin name produces safe id and file is inside episodes dir
test('newEpisode with path-traversal plugin name produces safe id and contained path', () => {
  const { root, runId } = seed();
  const { id, requestPath } = newEpisode(root, runId, { plugin: '../../../../etc/evil', role: 'maker', kind: 'x', point: 'implementation', fence: fence(runId) });
  // id must not contain path separators
  assert.match(id, /^001-[a-z0-9-]+$/);
  assert.ok(!/[/\\]/.test(id), 'id must not contain path separators');
  // request file must exist and be under runDir/episodes
  assert.ok(existsSync(requestPath));
  const base = resolve(runDir(root, runId), 'episodes');
  assert.ok(requestPath.startsWith(base), `requestPath ${requestPath} must start with ${base}`);
});

// Codex r2 🟡: newEpisode 에 절대 경로나 '..' 세그먼트가 있는 expectedArtifacts 는 거부.
test('newEpisode reports workstream-aware correction for portable unsafe expected artifacts before bytes', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, {
    title: 'impl', branch: 'impl', worktree: '.claude/worktrees/impl', fence: f,
  }).id;
  const before = durableEpisodeBytes(root, runId);
  const unsafe = [
    '/tmp/out',
    'C:\\tmp\\out',
    '\\\\server\\share\\out',
    '\\\\?\\C:\\tmp\\out',
    'safe\\..\\out',
    'safe/../out',
  ];
  for (const artifact of unsafe) {
    assert.throws(
      () => newEpisode(root, runId, {
        plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation',
        workstream: ws, expectedArtifacts: [artifact], fence: f,
      }),
      error => error.message === `EPISODE_ARTIFACT_UNSAFE: ${artifact} (expected root-relative, worktree-prefixed: .claude/worktrees/impl/<path>)`,
      artifact,
    );
    assert.deepEqual(durableEpisodeBytes(root, runId), before);
  }
  assert.doesNotThrow(() => reconcileBudget(root, runId));
  assert.doesNotThrow(() => newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation',
    workstream: ws, expectedArtifacts: ['historical-root-relative.txt'], fence: f,
  }));
});

test('newEpisode keeps null-workstream, historical root-relative, and worktree-prefixed paths compatible', () => {
  const { root, runId, fence: f } = freshRun();
  const ws = newWorkstream(root, runId, {
    title: 'compat', branch: 'compat', worktree: '.worktrees/compat', fence: f,
  }).id;
  assert.doesNotThrow(() => newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation',
    expectedArtifacts: ['root-level.txt'], fence: f,
  }));
  assert.doesNotThrow(() => newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation',
    workstream: ws, expectedArtifacts: ['historical-root-level.txt'], fence: f,
  }));
  assert.doesNotThrow(() => newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation',
    workstream: ws, expectedArtifacts: ['.worktrees/compat/out.txt'], fence: f,
  }));
});

// Codex r2 🟡: recordEpisode done 에서 artifacts 가 expected_artifacts 를 커버하지 않으면 EPISODE_ARTIFACTS_INCOMPLETE.
test('recordEpisode done throws EPISODE_ARTIFACTS_INCOMPLETE when artifacts do not cover expected', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, {
    title: 'incomplete', branch: 'incomplete', worktree: '.claude/worktrees/incomplete', fence: f,
  }).id;
  const art = join(root, 'out.txt');
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation',
    workstream: ws, expectedArtifacts: ['out.txt'], fence: f,
  });
  recordEpisode(root, runId, id, { status: 'in_progress', fence: f });
  writeFileSync(art, 'x');
  assert.throws(
    () => recordEpisode(root, runId, id, { status: 'done', artifacts: [], fence: f }),
    /EPISODE_ARTIFACTS_INCOMPLETE/,
  );
});

test('recordEpisode refuses approved/rejected even when caller supplies matching verdict proof', () => {
  for (const [status, verdict] of [
    ['approved', 'APPROVE'],
    ['approved', 'REQUEST_CHANGES'],
    ['rejected', 'REQUEST_CHANGES'],
  ]) {
    const { root, runId } = seed();
    const f = fence(runId);
    const { id } = newEpisode(root, runId, {
      plugin: 'deep-review', role: 'checker', kind: 'impl-review', point: 'implementation', fence: f,
    });
    const before = durableEpisodeBytes(root, runId);
    assert.throws(
      () => recordEpisode(root, runId, id, { status, proof: { verdict }, fence: f }),
      error => {
        assert.match(error.message, /EPISODE_TERMINAL_VIA_REVIEW/);
        assert.doesNotMatch(error.message, /EPISODE_STATUS_INVALID/);
        return true;
      },
    );
    assert.equal(readState(root, runId).data.episodes[0].status, 'pending');
    assert.deepEqual(durableEpisodeBytes(root, runId), before);
  }
});

test('recordEpisode keeps unknown statuses distinct from review-owned terminals', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-review', role: 'checker', kind: 'impl-review', point: 'implementation', fence: f,
  });
  assert.throws(
    () => recordEpisode(root, runId, id, { status: 'weird', fence: f }),
    error => {
      assert.match(error.message, /EPISODE_STATUS_INVALID/);
      assert.doesNotMatch(error.message, /EPISODE_TERMINAL_VIA_REVIEW/);
      return true;
    },
  );
});

test('recordEpisode refuses checker done before artifact proof validation', () => {
  for (const withArtifact of [false, true]) {
    const { root, runId } = seed();
    const f = fence(runId);
    const artifact = 'checker-proof.txt';
    if (withArtifact) writeFileSync(join(root, artifact), 'proof');
    const { id } = newEpisode(root, runId, {
      plugin: 'deep-review', role: 'checker', kind: 'impl-review', point: 'implementation',
      expectedArtifacts: withArtifact ? [artifact] : [], fence: f,
    });
    const before = durableEpisodeBytes(root, runId);
    assert.throws(
      () => recordEpisode(root, runId, id, {
        status: 'done', artifacts: withArtifact ? [artifact] : [], fence: f,
      }),
      error => {
        assert.match(error.message, /EPISODE_CHECKER_DONE_FORBIDDEN/);
        assert.doesNotMatch(error.message, /EPISODE_TERMINAL_NO_PROOF/);
        return true;
      },
    );
    assert.equal(readState(root, runId).data.episodes[0].status, 'pending');
    assert.deepEqual(durableEpisodeBytes(root, runId), before);
  }
});

test('episode record CLI refuses checker done without mutating durable state', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const artifact = 'checker-proof.txt';
  writeFileSync(join(root, artifact), 'proof');
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-review', role: 'checker', kind: 'impl-review', point: 'implementation',
    expectedArtifacts: [artifact], fence: f,
  });
  const before = durableEpisodeBytes(root, runId);
  const result = runEpisodeCli(root, runId, [
    'episode', 'record', '--id', id, '--status', 'done', '--artifacts', JSON.stringify([artifact]),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EPISODE_CHECKER_DONE_FORBIDDEN/);
  assert.equal(readState(root, runId).data.episodes[0].status, 'pending');
  assert.deepEqual(durableEpisodeBytes(root, runId), before);
});

test('episode terminal declarations and checker guard ordering remain independent', () => {
  const source = readFileSync(new URL('../scripts/lib/episode.mjs', import.meta.url), 'utf8');
  assert.match(source, /const RECORDABLE_TERMINAL = \['done'\];/);
  assert.match(source, /const ALL_TERMINAL = \['done', 'approved', 'rejected', 'abandoned'\];/);
  const declarations = source.split('\n').filter(line => /const (?:RECORDABLE_TERMINAL|ALL_TERMINAL) =/.test(line));
  assert.equal(declarations.length, 2);
  assert.equal(declarations.some(line => /\.\.\.(?:RECORDABLE_TERMINAL|TERMINAL)/.test(line)), false);
  assert.doesNotMatch(source, /proof\.verdict/);

  const terminalGuard = source.indexOf('EPISODE_ALREADY_TERMINAL');
  const checkerGuard = source.indexOf('EPISODE_CHECKER_DONE_FORBIDDEN');
  const routingGuard = source.indexOf('EPISODE_ROUTING_STATUS_INVALID', checkerGuard);
  assert.ok(terminalGuard >= 0 && terminalGuard < checkerGuard);
  assert.ok(checkerGuard < routingGuard);
  assert.equal(source.split('EPISODE_CHECKER_DONE_FORBIDDEN').length - 1, 1);
});

// Codex r3 FIX 4: submitted artifact path validation — escaping paths rejected
test('recordEpisode done throws EPISODE_ARTIFACT_ESCAPE for path-traversal in submitted artifacts', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, {
    title: 'escape', branch: 'escape', worktree: '.claude/worktrees/escape', fence: f,
  }).id;
  const artPath = join(root, 'out.txt');
  writeFileSync(artPath, 'x');
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation',
    workstream: ws, expectedArtifacts: ['out.txt'], fence: f,
  });
  recordEpisode(root, runId, id, { status: 'in_progress', fence: f });
  assert.throws(
    () => recordEpisode(root, runId, id, {
      status: 'done', artifacts: ['out.txt', '../outside'], fence: f,
    }),
    /EPISODE_ARTIFACT/,
  );
});

test('recordEpisode reports workstream-aware correction for portable unsafe submitted artifacts', () => {
  const { root, runId, fence: f } = freshRun();
  const worktree = '.claude/worktrees/submitted';
  mkdirSync(join(root, worktree), { recursive: true });
  writeFileSync(join(root, worktree, 'out.txt'), 'proof');
  const ws = newWorkstream(root, runId, {
    title: 'submitted', branch: 'submitted', worktree, fence: f,
  }).id;
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation',
    workstream: ws, expectedArtifacts: [`${worktree}/out.txt`], fence: f,
  });
  recordEpisode(root, runId, id, { status: 'in_progress', fence: f });
  const unsafe = ['/tmp/out', 'D:\\tmp\\out', '\\\\server\\share\\out', '\\\\?\\D:\\tmp\\out', 'safe\\..\\out'];
  for (const artifact of unsafe) {
    assert.throws(
      () => recordEpisode(root, runId, id, {
        status: 'done', artifacts: [`${worktree}/out.txt`, artifact], fence: f,
      }),
      error => error.message === `EPISODE_ARTIFACT_ESCAPE: ${artifact} (expected root-relative, worktree-prefixed: ${worktree}/<path>)`,
      artifact,
    );
  }
});

test('terminal submitted proof rejects an external symlink before bytes but accepts a contained symlink', t => {
  const { root, runId, fence: f } = freshRun();
  const worktree = '.claude/worktrees/symlink-proof';
  mkdirSync(join(root, worktree), { recursive: true });
  const externalRoot = mkdtempSync(join(tmpdir(), 'dl-external-artifact-'));
  const external = join(externalRoot, 'outside.txt');
  const artifact = `${worktree}/proof.txt`;
  const link = join(root, artifact);
  writeFileSync(external, 'outside');
  if (!createFileSymlinkOrSkip(t, external, link)) return;
  const ws = newWorkstream(root, runId, {
    title: 'symlink-proof', branch: 'symlink-proof', worktree, fence: f,
  }).id;
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation',
    workstream: ws, expectedArtifacts: [artifact], fence: f,
  });
  recordEpisode(root, runId, id, { status: 'in_progress', fence: f });
  const before = durableEpisodeBytes(root, runId);
  assert.throws(
    () => recordEpisode(root, runId, id, { status: 'done', artifacts: [artifact], fence: f }),
    error => error.message === `EPISODE_ARTIFACT_ESCAPE: ${artifact} (expected root-relative, worktree-prefixed: ${worktree}/<path>)`,
  );
  assert.deepEqual(durableEpisodeBytes(root, runId), before);
  assert.doesNotThrow(() => reconcileBudget(root, runId));

  unlinkSync(link);
  const contained = join(root, worktree, 'contained.txt');
  writeFileSync(contained, 'inside');
  if (!createFileSymlinkOrSkip(t, contained, link)) return;
  recordEpisode(root, runId, id, { status: 'done', artifacts: [artifact], fence: f });
  assert.equal(readState(root, runId).data.episodes.find(item => item.id === id).status, 'done');
});

test('episode CLI preserves invalid-value exit and artifact error class', () => {
  const { root, runId, fence: f } = freshRun();
  const ws = newWorkstream(root, runId, {
    title: 'cli-artifact', branch: 'cli-artifact', worktree: '.claude/worktrees/cli-artifact', fence: f,
  }).id;
  const result = runEpisodeCli(root, runId, [
    'episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'impl',
    '--point', 'implementation', '--workstream', ws, '--artifacts', '["/tmp/out"]',
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EPISODE_ARTIFACT_UNSAFE: \/tmp\/out/);
});

// Codex impl r7 🔴: malformed non-terminal inputs (null artifacts/proof) must fail BEFORE appendAnchored,
// leaving the event-log anchor consistent (no BUDGET_TAMPERED on next reconcile).
test('recordEpisode rejects null artifacts/proof cleanly without staling the event_log_head anchor', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const workstream = newWorkstream(root, runId, { title: 'impl', branch: 'impl', worktree: '.claude/worktrees/impl', fence: f }).id;
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', workstream, fence: f });
  // FENCE_REQUIRED is thrown first when fence is missing, but we pass a valid fence here to test the null artifact/proof path
  assert.throws(() => recordEpisode(root, runId, id, { status: 'in_progress', artifacts: null, fence: f }), /EPISODE_INPUT_INVALID/);
  assert.throws(() => recordEpisode(root, runId, id, { status: 'in_progress', proof: null, fence: f }), /EPISODE_INPUT_INVALID/);
  // anchor must still reconcile (no orphaned event appended)
  assert.doesNotThrow(() => reconcileBudget(root, runId));
  // a well-formed record still works after the rejected attempts
  recordEpisode(root, runId, id, { status: 'in_progress', proof: { result_note: 'ok' }, fence: f });
  assert.equal(readState(root, runId).data.episodes[0].status, 'in_progress');
});

// Codex r13: FENCE_REQUIRED — mutators throw when fence is absent
test('newEpisode throws FENCE_REQUIRED when called without fence', () => {
  const { root, runId } = seed();
  assert.throws(
    () => newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation' }),
    /FENCE_REQUIRED/
  );
});

// Fix 3: newEpisode throws EPISODE_INPUT_INVALID for missing required fields
test('newEpisode throws EPISODE_INPUT_INVALID when role is missing', () => {
  const { root, runId } = seed();
  assert.throws(
    () => newEpisode(root, runId, { plugin: 'deep-work', kind: 'impl', point: 'implementation', fence: fence(runId) }),
    /EPISODE_INPUT_INVALID/
  );
});

// Codex impl r15 🟡: a non-null nonexistent workstream is rejected at creation (no stranded/unreviewable maker).
test('newEpisode rejects a non-null nonexistent workstream; no episode created, anchor stays consistent', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  assert.throws(
    () => newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', workstream: 'ws-nope', fence: f }),
    /WORKSTREAM_NOT_FOUND/
  );
  assert.equal(readState(root, runId).data.episodes.length, 0);   // no stranded episode
  assert.doesNotThrow(() => reconcileBudget(root, runId));          // preCheck threw before append → anchor consistent
});

test('public episode routes preserve a bound Workstream and reject cross-scope new/record/abandon before bytes', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  mkdirSync(join(root, '.claude/worktrees'), { recursive: true });
  const wsA = newWorkstream(root, runId, { title: 'a', branch: 'a', worktree: '.claude/worktrees/a', fence: f }).id;
  const wsB = newWorkstream(root, runId, { title: 'b', branch: 'b', worktree: '.claude/worktrees/b', fence: f }).id;
  const makerA = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: wsA, fence: f }).id;
  const makerB = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: wsB, fence: f }).id;
  assert.equal(runEpisodeCli(root, runId, ['episode', 'record', '--id', makerA, '--status', 'in_progress']).status, 0);

  for (const args of [
    ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'implementation', '--point', 'implementation', '--workstream', wsB],
    ['episode', 'record', '--id', makerB, '--status', 'in_progress'],
    ['episode', 'abandon', '--id', makerB, '--reason', 'cross', '--confirm'],
  ]) {
    const loopBefore = readFileSync(join(runDir(root, runId), 'loop.json'));
    const hashBefore = readFileSync(join(runDir(root, runId), '.loop.hash'));
    const logBefore = readFileSync(join(runDir(root, runId), 'event-log.jsonl'));
    const result = runEpisodeCli(root, runId, args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /SESSION_SCOPE_MISMATCH/);
    assert.equal(readFileSync(join(runDir(root, runId), 'loop.json')).equals(loopBefore), true);
    assert.equal(readFileSync(join(runDir(root, runId), '.loop.hash')).equals(hashBefore), true);
    assert.equal(readFileSync(join(runDir(root, runId), 'event-log.jsonl')).equals(logBefore), true);
  }

  const same = runEpisodeCli(root, runId, [
    'episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'fix',
    '--point', 'implementation', '--workstream', wsA,
  ]);
  assert.equal(same.status, 0, same.stderr);
  const sameId = JSON.parse(same.stdout).id;
  const abandon = runEpisodeCli(root, runId, ['episode', 'abandon', '--id', sameId, '--reason', 'settled', '--confirm']);
  assert.equal(abandon.status, 0, abandon.stderr);
});

test('abandonEpisode: non-terminal maker -> abandoned, requires --confirm + reason + fence', () => {
  const { root, runId, fence: f } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence: f });
  assert.throws(() => abandonEpisode(root, runId, id, { reason: 'orphan', confirm: false, fence: f }), /CONFIRM_REQUIRED/);
  assert.throws(() => abandonEpisode(root, runId, id, { reason: '', confirm: true, fence: f }), /EPISODE_INPUT_INVALID/);
  abandonEpisode(root, runId, id, { reason: 'orphan, no artifacts', confirm: true, fence: f });
  const ep = readState(root, runId).data.episodes.find(e => e.id === id);
  assert.equal(ep.status, 'abandoned');
  assert.equal(ep.abandon_reason, 'orphan, no artifacts');
});

test('abandonEpisode: already-terminal episode rejected', () => {
  const { root, runId, fence: f } = freshRun();
  const ws = newWorkstream(root, runId, {
    title: 'terminal', branch: 'terminal', worktree: '.claude/worktrees/terminal', fence: f,
  }).id;
  writeFileSync(join(root, 'art.txt'), 'x');
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: ['art.txt'], fence: f,
  });
  recordEpisode(root, runId, id, { status: 'in_progress', fence: f });
  recordEpisode(root, runId, id, { status: 'done', artifacts: ['art.txt'], proof: {}, fence: f });
  assert.throws(
    () => abandonEpisode(root, runId, id, { reason: 'late', confirm: true, fence: f }),
    /EPISODE_ALREADY_TERMINAL/,
  );
});

test('abandonEpisode: fence enforced', () => {
  const { root, runId, fence: f } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence: f });
  assert.throws(() => abandonEpisode(root, runId, id, { reason: 'r', confirm: true, fence: { owner: 'wrong', generation: 1 } }), /LEASE_FENCED/);
});

test('recordEpisode: status="abandoned" is not recordable (only abandonEpisode writes it)', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  assert.throws(() => recordEpisode(root, runId, id, { status: 'abandoned', fence }), /EPISODE_STATUS_INVALID/);
});

test('recordEpisode: cannot resurrect an abandoned episode to a non-terminal status', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  assert.throws(() => recordEpisode(root, runId, id, { status: 'in_progress', fence }), /EPISODE_ALREADY_TERMINAL/);
});

test('recordEpisode: cannot record over a done episode (current terminal immutable)', () => {
  const { root, runId, fence } = freshRun();
  const ws = newWorkstream(root, runId, {
    title: 'immutable', branch: 'immutable', worktree: '.claude/worktrees/immutable', fence,
  }).id;
  writeFileSync(join(root, 'art.txt'), 'x');
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: ['art.txt'], fence,
  });
  recordEpisode(root, runId, id, { status: 'in_progress', fence });
  recordEpisode(root, runId, id, { status: 'done', artifacts: ['art.txt'], proof: {}, fence });
  assert.throws(
    () => recordEpisode(root, runId, id, { status: 'in_progress', fence }),
    /EPISODE_ALREADY_TERMINAL/,
  );
});

test('recordEpisode: cannot resurrect an approved/rejected episode to non-terminal (R3 — all 4 terminals)', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-review', role: 'checker', kind: 'implementation-review', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  for (const term of ['approved', 'rejected']) {
    const data = readState(root, runId).data; data.episodes.find(e => e.id === id).status = term; writeState(root, runId, data);   // 터미널 고정(approved/rejected는 정상적으론 review record 경유)
    assert.throws(() => recordEpisode(root, runId, id, { status: 'in_progress', fence }), /EPISODE_ALREADY_TERMINAL/);
  }
});

test('B″: unbound owner scope can abandon a workstream-bound orphan maker', () => {
  const { root, runId, fence } = freshRun();
  const ws = newWorkstream(root, runId, { title: 'a', branch: 'a', worktree: '.claude/worktrees/a', fence }).id;
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'design',
    workstream: ws, expectedArtifacts: [], fence,
  });
  // owner scope is still unbound: only `episode record --status in_progress` binds it.
  assert.equal(readState(root, runId).data.session_chain.sessions[0].scope.workstream_id, null);
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  assert.equal(readState(root, runId).data.episodes.find(e => e.id === id).status, 'abandoned');
});

test('B″: a bound owner still cannot abandon another workstream’s episode', () => {
  const { root, runId, fence } = freshRun();
  const wsA = newWorkstream(root, runId, { title: 'a', branch: 'a', worktree: '.claude/worktrees/a', fence }).id;
  const wsB = newWorkstream(root, runId, { title: 'b', branch: 'b', worktree: '.claude/worktrees/b', fence }).id;
  const makerA = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'design', workstream: wsA, expectedArtifacts: ['a'], fence }).id;
  const makerB = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'design', workstream: wsB, expectedArtifacts: [], fence }).id;
  recordEpisode(root, runId, makerA, { status: 'in_progress', fence });   // binds owner scope to wsA
  assert.throws(() => abandonEpisode(root, runId, makerB, { reason: 'x', confirm: true, fence }), /SESSION_SCOPE_MISMATCH/);
});
