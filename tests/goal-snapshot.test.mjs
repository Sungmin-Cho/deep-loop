import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, copyFileSync, appendFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { captureGoalSnapshot, snapshotEvidenceRefs } from '../scripts/lib/goal-snapshot.mjs';
import { sameResolvedPath } from '../scripts/lib/path-portable.mjs';
import { createDirectoryJunction, createFileSymlink } from './helpers/fs-fixtures.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goal-snapshot-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content = 'source') => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); return path; };
  put('app.txt', 'integrated'); put('.worktrees/a/app.txt', 'workstream');
  const loop = { goal_contract: { sha256: 'a'.repeat(64) }, goal_obligations: [], workstreams: [{ id: 'WS-A', worktree: '.worktrees/a', requirement_ids: ['REQ-A'], depends_on: [], status: 'ready' }], episodes: [{ id: 'EP-A', role: 'maker', status: 'done', workstream_id: 'WS-A', point: 'implementation', artifacts: ['.worktrees/a/app.txt'] }] };
  return { root, put, loop, snap: options => captureGoalSnapshot(root, loop, options) };
}
function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000, env: { ...process.env, GIT_AUTHOR_NAME: 'Snapshot Test', GIT_AUTHOR_EMAIL: 'snapshot@example.invalid', GIT_COMMITTER_NAME: 'Snapshot Test', GIT_COMMITTER_EMAIL: 'snapshot@example.invalid' } });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function gitFixture(t) {
  const f = fixture(t); rmSync(join(f.root, '.worktrees'), { recursive: true });
  f.put('.gitignore', '.worktrees/\n.deep-loop/\nnode_modules/\n');
  git(f.root, 'init', '-q'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'initial');
  git(f.root, 'worktree', 'add', '-qb', 'delivery', join(f.root, '.worktrees/a'));
  return f;
}

test('freezes integrated source and contributing worktree evidence without bookkeeping self-staleness', t => {
  const f = fixture(t), first = f.snap();
  assert.deepEqual(first.sources.map(s => s.subject), ['project', 'WS-A']);
  assert.equal(first.sources[0].files.find(x => x.path === 'app.txt').sha256, createHash('sha256').update('integrated').digest('hex'));
  assert.ok(snapshotEvidenceRefs(first).includes('artifact:EP-A:.worktrees/a/app.txt'));
  f.put('.deep-loop/runs/run/goal-report.json', 'review'); f.put('.deep-review/report.json', 'report'); f.loop.goal_reviews = [{ verdict: 'APPROVE' }]; f.loop.budget = { used: 99 };
  assert.equal(f.snap().sha256, first.sha256);
  f.put('app.txt', 'changed integration'); assert.notEqual(f.snap().sha256, first.sha256);
});
test('explicit ignored dependencies remain evidence, and source and artifact edits stale', t => {
  const f = fixture(t); f.loop.episodes[0].artifacts.push(f.put('.worktrees/a/node_modules/important.txt', 'dependency'));
  const first = f.snap(); f.put('.worktrees/a/node_modules/important.txt', 'updated'); assert.notEqual(f.snap().sha256, first.sha256);
  const next = f.snap(); f.put('.worktrees/a/new.txt', 'new untracked source'); assert.notEqual(f.snap().sha256, next.sha256);
});
test('missing, unreadable and special artifact/source identity fail closed', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.loop.episodes[0].artifacts.push('.worktrees/a/missing'); assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/); f.loop.episodes[0].artifacts.pop();
  chmodSync(join(f.root, 'app.txt'), 0); assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/); chmodSync(join(f.root, 'app.txt'), 0o600);
  const result = spawnSync('/usr/bin/mkfifo', [join(f.root, 'pipe')]); assert.equal(result.status, 0); assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
});
test('rejects escape, symlink ancestor and special declared artifacts without reading FIFO', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.loop.episodes[0].artifacts = ['../outside']; assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
  f.loop.episodes[0].artifacts = ['.worktrees/a/link/passwd']; createDirectoryJunction('/etc', join(f.root, '.worktrees/a/link')); assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
});
test('bounded file count and bytes return unavailable rather than incomplete manifests', t => {
  const f = fixture(t); assert.throws(() => f.snap({ limits: { files: 1 } }), /GOAL_SNAPSHOT_UNAVAILABLE/);
  assert.throws(() => f.snap({ limits: { fileBytes: 2 } }), /GOAL_SNAPSHOT_UNAVAILABLE/);
});
test('actual linked Git worktrees bind HEAD, index, tracked and untracked bytes', t => {
  const f = gitFixture(t), first = f.snap();
  assert.equal(first.sources[0].kind, 'git'); assert.equal(first.sources[1].kind, 'git');
  const projectCommon = first.sources[0].git.common_dir;
  const worktreeCommon = first.sources[1].git.common_dir;
  const sameCommon = projectCommon === worktreeCommon || sameResolvedPath(projectCommon, worktreeCommon)
    || (() => {
      try {
        const left = lstatSync(projectCommon, { bigint: true });
        const right = lstatSync(worktreeCommon, { bigint: true });
        return left.dev === right.dev && left.ino === right.ino && left.ino !== 0n;
      } catch { return false; }
    })();
  assert.equal(sameCommon, true);
  assert.notEqual(first.sources[0].git.git_dir, first.sources[1].git.git_dir);
  const indexBefore = readFileSync(join(f.root, '.git/index'));
  assert.equal(f.snap().sha256, first.sha256); assert.deepEqual(readFileSync(join(f.root, '.git/index')), indexBefore);
  git(f.root, 'commit', '--allow-empty', '-qm', 'same bytes new HEAD'); assert.notEqual(f.snap().sha256, first.sha256);
  const afterHead = f.snap(); git(f.root, 'update-index', '--assume-unchanged', 'app.txt'); assert.notEqual(f.snap().sha256, afterHead.sha256);
  const afterIndex = f.snap(); f.put('app.txt', 'edited'); assert.notEqual(f.snap().sha256, afterIndex.sha256);
  const afterTracked = f.snap(); f.put('new.txt', 'untracked'); assert.notEqual(f.snap().sha256, afterTracked.sha256);
});
test('Git control output does not stale its own review, but deleted tracked paths do', t => {
  const f = gitFixture(t), first = f.snap(); f.put('.deep-loop/report', 'report'); assert.equal(f.snap().sha256, first.sha256);
  rmSync(join(f.root, 'app.txt')); assert.notEqual(f.snap().sha256, first.sha256);
});
test('rejects foreign worktrees, embedded repositories, broken Git and submodules', t => {
  const f = gitFixture(t); f.put('embedded/.git', 'gitdir: /missing\n'); assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/); rmSync(join(f.root, 'embedded'), { recursive: true });
  git(f.root, 'update-index', '--add', '--cacheinfo', `160000,${git(f.root, 'rev-parse', 'HEAD')},submodule`); assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
});
test('Git environment redirection cannot substitute a different repository', t => {
  const f = gitFixture(t), first = f.snap(); const previous = process.env.GIT_DIR; process.env.GIT_DIR = '/does-not-exist';
  try { assert.equal(f.snap().sha256, first.sha256); } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
});
test('refuses candidate-controlled executable and unavailable marked Git query', t => {
  const f = gitFixture(t); f.put('git', '#!/bin/sh\nexit 0\n'); chmodSync(join(f.root, 'git'), 0o755);
  assert.throws(() => f.snap({ gitExecutable: join(f.root, 'git') }), /GOAL_SNAPSHOT_UNAVAILABLE/);
  assert.throws(() => f.snap({ gitExecutable: '/missing/git' }), /GOAL_SNAPSHOT_UNAVAILABLE/);
});
test('a done maker cannot omit one of its declared expected artifacts from the snapshot', t => {
  const f = fixture(t); f.loop.episodes[0].expected_artifacts = ['.worktrees/a/app.txt', '.worktrees/a/omitted.txt'];
  assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
});
test('a FIFO declared under an excluded dependency directory remains unavailable evidence', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); mkdirSync(join(f.root, '.worktrees/a/node_modules'));
  assert.equal(spawnSync('/usr/bin/mkfifo', [join(f.root, '.worktrees/a/node_modules/pipe')]).status, 0);
  f.loop.episodes[0].artifacts.push('.worktrees/a/node_modules/pipe'); assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
});
test('a foreign Git repository at a declared workstream cannot stand in for the project', t => {
  const f = gitFixture(t); git(f.root, 'worktree', 'remove', '--force', join(f.root, '.worktrees/a'));
  f.put('.worktrees/a/app.txt', 'foreign'); git(join(f.root, '.worktrees/a'), 'init', '-q');
  git(join(f.root, '.worktrees/a'), 'add', '.'); git(join(f.root, '.worktrees/a'), 'commit', '-qm', 'foreign root');
  assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
});
test('source executable permission changes stale unchanged bytes', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), first = f.snap(); chmodSync(join(f.root, 'app.txt'), 0o755); assert.notEqual(f.snap().sha256, first.sha256);
});
test('a verified unborn Git branch has explicit identity and remains fresh until changed', t => {
  const f = fixture(t); git(f.root, 'init', '-q'); git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/initial');
  const first = f.snap(); assert.equal(first.sources[0].kind, 'git');
  assert.equal(first.sources[0].git.head, null); assert.equal(first.sources[0].git.unborn, true);
  assert.equal(first.sources[0].git.head_ref, 'refs/heads/initial');
  assert.equal(first.sources[1].kind, 'directory'); assert.equal(f.snap().sha256, first.sha256);
  git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/other'); assert.notEqual(f.snap().sha256, first.sha256);
  const renamed = f.snap(); f.put('.gitignore', '.worktrees/\n');
  git(f.root, 'add', 'app.txt', '.gitignore'); git(f.root, 'commit', '-qm', 'first commit');
  const committed = f.snap(); assert.notEqual(committed.sha256, renamed.sha256);
  assert.equal(committed.sources[0].git.unborn, false); assert.match(committed.sources[0].git.head, /^[0-9a-f]{40,64}$/);
});

test('the resolved Git executable bytes are bound across captures', {
  skip: process.platform === 'win32' ? 'relocated git.exe needs the Git-for-Windows DLL tree' : false,
}, t => {
  const f = gitFixture(t);
  const toolDir = realpathSync(mkdtempSync(join(tmpdir(), 'goal-snapshot-tool-')));
  t.after(() => rmSync(toolDir, { recursive: true, force: true }));
  // Darwin's /usr/bin/git is a location-sensitive xcrun shim, not a relocatable binary.
  const original = process.platform === 'darwin'
    ? spawnSync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8', timeout: 5000 }).stdout.trim()
    : f.snap().sources[0].git.executable.path;
  const executable = join(toolDir, process.platform === 'win32' ? 'git.exe' : 'git');
  copyFileSync(original, executable); chmodSync(executable, 0o755);
  const first = f.snap({ gitExecutable: executable });
  assert.equal(first.sources[0].git.executable.path, executable);
  appendFileSync(executable, '\nchanged executable bytes\n');
  try { assert.notEqual(f.snap({ gitExecutable: executable }).sha256, first.sha256); }
  catch (error) { assert.match(error.message, /GOAL_SNAPSHOT_UNAVAILABLE/); }
});

test('unresolvable detached HEAD and corrupted symbolic branch are not unborn proof', t => {
  const f = fixture(t); git(f.root, 'init', '-q');
  f.put('.git/HEAD', 'd'.repeat(40) + '\n'); assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
  f.put('.git/HEAD', 'ref: refs/heads/broken\n'); f.put('.git/refs/heads/broken', 'not an object id\n');
  assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
});
test('contained regular-file symlink captures target bytes and retargeting identity', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.put('.worktrees/a/equal.txt', 'workstream');
  createFileSymlink('app.txt', join(f.root, '.worktrees/a/link.txt'));
  f.loop.episodes[0].artifacts.push('.worktrees/a/link.txt');
  const first = f.snap(), link = first.artifacts.find(item => item.path.endsWith('/link.txt'));
  assert.equal(link.symlink.target, 'app.txt'); assert.equal(link.symlink.resolved_path, '.worktrees/a/app.txt');
  assert.equal(link.sha256, createHash('sha256').update('workstream').digest('hex'));
  assert.equal(f.snap().sha256, first.sha256);
  rmSync(join(f.root, '.worktrees/a/link.txt')); createFileSymlink('equal.txt', join(f.root, '.worktrees/a/link.txt'));
  assert.notEqual(f.snap().sha256, first.sha256);
  const retargeted = f.snap(); f.put('.worktrees/a/equal.txt', 'different'); assert.notEqual(f.snap().sha256, retargeted.sha256);
});
test('contained Git-tracked file symlink is evidence, but cross-workstream and directory links fail closed', { skip: process.platform === 'win32' }, t => {
  const f = gitFixture(t); createFileSymlink('app.txt', join(f.root, 'link.txt')); git(f.root, 'add', 'link.txt');
  const snapshot = f.snap(); assert.equal(snapshot.sources[0].files.find(item => item.path === 'link.txt').symlink.target, 'app.txt');
  createFileSymlink('../../app.txt', join(f.root, '.worktrees/a/escape.txt')); assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
  rmSync(join(f.root, '.worktrees/a/escape.txt')); mkdirSync(join(f.root, '.worktrees/a/subdir'));
  createDirectoryJunction('subdir', join(f.root, '.worktrees/a/directory-link')); assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
});
test('symlinked worktree roots remain unavailable even when contained', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); createDirectoryJunction('a', join(f.root, '.worktrees/alias')); f.loop.workstreams[0].worktree = '.worktrees/alias';
  assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
});
test('a tracked dangling file link is unavailable, not a deleted tracked source', { skip: process.platform === 'win32' }, t => {
  const f = gitFixture(t); createFileSymlink('missing.txt', join(f.root, 'dangling.txt')); git(f.root, 'add', 'dangling.txt');
  assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
});
test('contained leaf-link chains preserve intermediate spelling and reject cycles', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); createFileSymlink('app.txt', join(f.root, '.worktrees/a/inner.txt'));
  createFileSymlink('inner.txt', join(f.root, '.worktrees/a/outer.txt'));
  const first = f.snap(), record = first.sources[1].files.find(item => item.path.endsWith('/outer.txt'));
  assert.equal(record.symlink.chain.length, 2); assert.equal(record.symlink.resolved_path, '.worktrees/a/app.txt');
  rmSync(join(f.root, '.worktrees/a/inner.txt')); createFileSymlink('outer.txt', join(f.root, '.worktrees/a/inner.txt'));
  assert.throws(f.snap, /GOAL_SNAPSHOT_UNAVAILABLE/);
});
