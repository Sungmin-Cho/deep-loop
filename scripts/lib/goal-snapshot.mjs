import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync, openSync, closeSync, fstatSync, readSync, opendirSync, accessSync, readlinkSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathKeyWithin, sameResolvedPath } from './path-portable.mjs';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

// These exclusions are part of every manifest. Important ignored dependencies
// must be declared as maker artifacts, which bypass inventory exclusions.
export const GOAL_SNAPSHOT_EXCLUSIONS = Object.freeze([
  '.git', '.deep-loop', '.deep-review', '.deep-work', '.superpowers',
  'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.pytest_cache',
  '.mypy_cache', '.next', '.turbo', '.worktrees', '.claude/worktrees', '.codex/worktrees',
]);
const DEFAULT_LIMITS = Object.freeze({ files: 50000, entries: 150000, fileBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, gitBytes: 16 * 1024 * 1024, milliseconds: 15000 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = reason => { throw new Error(`GOAL_SNAPSHOT_UNAVAILABLE: ${reason}`); };
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const inside = (root, path) => path === root || path.startsWith(root + sep)
  || (process.platform === 'win32' && pathKeyWithin(root, path));
const portable = path => path.split(sep).join('/');
function sameFsPath(left, right) {
  if (sameResolvedPath(left, right)) return true;
  if (process.platform !== 'win32') return false;
  try {
    const a = lstatSync(left, { bigint: true });
    const b = lstatSync(right, { bigint: true });
    return !a.isSymbolicLink() && !b.isSymbolicLink()
      && a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;
  } catch {
    return false;
  }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort(order).map(key => [key, canonical(value[key])]));
  return value;
}
function normalized(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\\0\r\n]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) fail('unsafe relative path');
  return path;
}
function excluded(path) {
  const parts = path.split('/');
  return GOAL_SNAPSHOT_EXCLUSIONS.some(item => item.includes('/')
    ? path === item || path.startsWith(item + '/')
    : parts.includes(item));
}
const identity = s => [s.dev, s.ino, s.size, s.mode, s.mtimeNs, s.ctimeNs].map(String).join(':');

/** Read-only, bounded source proof. A failure is never an empty/partial proof. */
export function captureGoalSnapshot(rootInput, loop, options = {}) {
  try {
    const root = realpathSync(rootInput), limits = { ...DEFAULT_LIMITS };
    for (const [key, value] of Object.entries(options.limits ?? {})) {
      if (!(key in limits) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) fail('invalid snapshot limit');
      limits[key] = value;
    }
    const deadline = performance.now() + limits.milliseconds;
    let entries = 0, files = 0, bytes = 0;
    const observations = new Map();
    const tick = () => { if (performance.now() >= deadline) fail('snapshot deadline exceeded'); };
    const observe = (path, s) => {
      const id = identity(s), previous = observations.get(path);
      if (previous && previous !== id) fail('file identity changed during capture');
      observations.set(path, id);
    };
    function safePath(path, base = root) {
      if (!inside(base, path)) fail('path escapes declared root');
      let current = base;
      for (const part of relative(base, path).split(sep).filter(Boolean)) {
        current = join(current, part);
        const s = lstatSync(current, { bigint: true });
        if (s.isSymbolicLink()) fail('symlink identity is unsupported');
      }
      return path;
    }
    function readRegular(path, { external = false, executable = false } = {}) {
      tick(); if (++files > limits.files) fail('file count exceeded');
      if (!external) safePath(path);
      const before = lstatSync(path, { bigint: true });
      if (!before.isFile() || !(before.mode & 0o444n)) fail('unreadable or non-regular file');
      if (before.size > BigInt(limits.fileBytes)) fail('file byte limit exceeded');
      bytes += Number(before.size); if (bytes > limits.totalBytes) fail('total byte limit exceeded');
      if (executable) accessSync(path, constants.X_OK);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (identity(fstatSync(fd, { bigint: true })) !== identity(before)) fail('file replaced before read');
        const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
        let read = 0;
        while (read < Number(before.size)) {
          tick(); const n = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - read), read);
          if (!n) fail('file truncated during read');
          read += n; hash.update(buffer.subarray(0, n));
        }
        if (identity(fstatSync(fd, { bigint: true })) !== identity(before)
          || identity(lstatSync(path, { bigint: true })) !== identity(before)) fail('file changed during read');
        observe(path, before);
        return { sha256: hash.digest('hex'), bytes: read, mode: Number(before.mode & 0o777n) };
      } finally { closeSync(fd); }
    }
    function readEvidence(path, boundary) {
      safePath(dirname(path));
      let current = path, state = lstatSync(current, { bigint: true });
      const chain = [];
      while (state.isSymbolicLink()) {
        tick();
        if (chain.length >= 32 || ++files > limits.files) fail('symlink traversal limit exceeded');
        if (!inside(boundary, current) || state.size > BigInt(limits.fileBytes)) fail('symlink escapes source or exceeds byte limit');
        const spelling = readlinkSync(current, { encoding: 'buffer' });
        bytes += spelling.length; if (bytes > limits.totalBytes) fail('total byte limit exceeded');
        const target = spelling.toString('utf8');
        if (!Buffer.from(target).equals(spelling) || !target || target.includes('\0')) fail('unresolved symlink spelling');
        if (identity(lstatSync(current, { bigint: true })) !== identity(state)) fail('symlink changed during capture');
        observe(current, state);
        chain.push({ path: portable(relative(root, current)), target });
        current = resolve(dirname(current), target);
        if (!inside(boundary, current)) fail('symlink escapes source boundary');
        // Leaf-to-leaf links are bounded; directory aliases are intentionally not
        // traversed, including a target path whose ancestor is a directory link.
        safePath(dirname(current));
        state = lstatSync(current, { bigint: true });
      }
      const record = readRegular(current);
      return chain.length ? { ...record, symlink: { target: chain[0].target,
        resolved_path: portable(relative(root, current)), chain } } : record;
    }
    const workstreams = (loop.workstreams ?? []).filter(ws => ws.requirement_ids?.length).map(ws => ({
      id: ws.id, worktree: normalized(ws.worktree), requirement_ids: [...ws.requirement_ids].sort(order),
      depends_on: [...(ws.depends_on ?? [])].sort(order), status: ws.status,
    })).sort((a, b) => order(a.id, b.id));
    const candidates = [root, ...workstreams.map(ws => safePath(resolve(root, ws.worktree)))];
    for (const candidate of candidates) if (!lstatSync(candidate).isDirectory()) fail('source directory unavailable');
    let executable;
    function gitExecutable() {
      if (executable) return executable;
      const choices = options.gitExecutable !== undefined ? [options.gitExecutable]
        : (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(path => join(path, process.platform === 'win32' ? 'git.exe' : 'git'));
      for (const choice of choices) {
        if (typeof choice !== 'string' || !isAbsolute(choice)) fail('Git executable must be absolute');
        let actual;
        try { actual = realpathSync(choice); accessSync(actual, constants.X_OK); } catch { if (options.gitExecutable !== undefined) fail('Git executable unavailable'); continue; }
        if (candidates.some(candidate => inside(candidate, actual))) fail('candidate-controlled Git executable');
        executable = { path: actual, ...readRegular(actual, { external: true, executable: true }) };
        return executable;
      }
      fail('Git executable unavailable');
    }
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    gitEnv.GIT_TERMINAL_PROMPT = '0'; gitEnv.GIT_CONFIG_NOSYSTEM = '1'; gitEnv.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const gitQuery = (directory, args, acceptedStatuses = [0]) => {
      tick(); const result = spawnSync(gitExecutable().path, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', directory, ...args], {
        shell: false, env: gitEnv, encoding: 'buffer', maxBuffer: limits.gitBytes,
        timeout: Math.max(1, Math.min(5000, Math.floor(deadline - performance.now()))), windowsHide: true,
      });
      if (result.error || !acceptedStatuses.includes(result.status) || result.signal || !Buffer.isBuffer(result.stdout)) fail('Git query failed');
      const output = result.stdout.toString('utf8');
      if (!Buffer.from(output).equals(result.stdout)) fail('non-UTF8 Git identity');
      return { output, status: result.status };
    };
    const git = (directory, args) => gitQuery(directory, args).output;
    function marker(directory) {
      let current = directory;
      for (;;) {
        try { lstatSync(join(current, '.git')); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = dirname(current); if (parent === current) return false; current = parent;
      }
    }
    function gitIdentity(directory) {
      // An unmarked contributing directory is a directory inventory. Ancestor
      // Git discovery does not grant it a separate worktree identity.
      if (directory !== root) {
        try { lstatSync(join(directory, '.git')); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      }
      if (!marker(directory)) return null;
      const top = realpathSync(git(directory, ['rev-parse', '--show-toplevel']).trim());
      if (!sameFsPath(top, directory)) fail('source is not the declared Git worktree');
      const gitDir = realpathSync(resolve(directory, git(directory, ['rev-parse', '--absolute-git-dir']).trim()));
      const commonDir = realpathSync(resolve(directory, git(directory, ['rev-parse', '--git-common-dir']).trim()));
      const symbolic = gitQuery(directory, ['symbolic-ref', '-q', 'HEAD'], [0, 1]);
      const headRef = symbolic.status === 0 ? symbolic.output.trim() : null;
      const resolvedHead = gitQuery(directory, ['rev-parse', '--verify', 'HEAD^{commit}'], [0, 128]);
      let head = null;
      if (resolvedHead.status === 0) {
        head = git(directory, ['rev-parse', '--verify', 'HEAD']).trim();
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) fail('unresolved Git HEAD');
      } else {
        if (!headRef?.startsWith('refs/heads/')) fail('unresolved detached Git HEAD');
        // Only a valid symbolic branch whose ref is proven absent is unborn.
        // Existing bad refs and corrupt Git metadata are not absence evidence.
        git(directory, ['check-ref-format', headRef]);
        if (gitQuery(directory, ['show-ref', '--verify', '--quiet', headRef], [0, 1]).status !== 1) fail('corrupt Git HEAD target');
      }
      const indexPath = join(gitDir, 'index');
      let index;
      try { index = { path: indexPath, ...readRegular(indexPath, { external: true }) }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; index = { path: indexPath, absent: true }; }
      return { head, unborn: head === null, head_ref: headRef, git_dir: gitDir, common_dir: commonDir, index, executable: gitExecutable() };
    }
    const projectGit = gitIdentity(root);
    function walk(directory, base, output) {
      tick(); safePath(directory); const before = lstatSync(directory, { bigint: true });
      if (!before.isDirectory()) fail('unreadable source directory');
      // Windows directory mode bits are not POSIX r-x; opendirSync is the authority there.
      if (process.platform !== 'win32' && (!(before.mode & 0o444n) || !(before.mode & 0o111n))) fail('unreadable source directory');
      const handle = opendirSync(directory);
      try {
        for (let entry; (entry = handle.readSync()) !== null;) {
          tick(); if (++entries > limits.entries) fail('directory entry limit exceeded');
          const path = join(directory, entry.name), local = portable(relative(base, path));
          if (entry.name === '.git' && directory !== base) fail('embedded Git tree');
          if (excluded(local)) continue;
          const s = lstatSync(path, { bigint: true });
          if (s.isDirectory()) walk(path, base, output);
          else if (s.isFile() || s.isSymbolicLink()) output.push(portable(relative(root, path)));
          else fail('special or symlink source identity');
        }
      } finally { handle.closeSync(); }
      if (identity(lstatSync(directory, { bigint: true })) !== identity(before)) fail('source directory changed during enumeration');
      // Directory mtimes include ignored control files; do not retain them in the
      // final stable-file check or the persisted content digest.
    }
    const inventoryChecks = [];
    function source(subject, directory, gitState) {
      const found = []; walk(directory, directory, found);
      let paths = found, deleted = [];
      const tracked = new Set();
      let stageSha;
      if (gitState) {
        const stage = git(directory, ['ls-files', '-z', '--stage']);
        stageSha = digest(stage);
        for (const entry of stage.split('\0').filter(Boolean)) {
          const match = /^(\d{6}) [0-9a-f]+ ([0-3])\t([\s\S]+)$/.exec(entry);
          if (!match || match[1] === '160000' || match[2] !== '0') fail('submodule or unresolved Git index');
          tracked.add(portable(relative(root, join(directory, normalized(match[3])))));
        }
        paths = [...new Set(git(directory, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))]
          .map(normalized).filter(path => !excluded(path)).map(path => portable(relative(root, join(directory, path))));
      }
      const frozenPaths = [...paths].sort(order);
      inventoryChecks.push(() => {
        const fresh = []; walk(directory, directory, fresh);
        const current = gitState
          ? [...new Set(git(directory, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))]
            .map(normalized).filter(path => !excluded(path)).map(path => portable(relative(root, join(directory, path))))
          : fresh;
        if (JSON.stringify(current.sort(order)) !== JSON.stringify(frozenPaths)) fail('source inventory changed during capture');
        if (gitState && digest(git(directory, ['ls-files', '-z', '--stage'])) !== stageSha) fail('Git index listing changed during capture');
      });
      const records = [];
      for (const path of paths.sort(order)) {
        try { records.push({ ref: `source:${subject}:${path}`, path, ...readEvidence(join(root, path), directory) }); }
        catch (error) {
          if (!gitState || !tracked.has(path) || error.code !== 'ENOENT') throw error;
          // A dangling tracked symlink still exists. Its missing target is
          // unavailable evidence, not proof that the tracked source was deleted.
          let absent = false;
          try { lstatSync(join(root, path)); }
          catch (missing) { if (missing.code !== 'ENOENT') throw missing; absent = true; }
          if (!absent) throw error;
          deleted.push(path);
        }
      }
      return { subject, path: portable(relative(root, directory)) || '.', kind: gitState ? 'git' : 'directory', exclusions: [...GOAL_SNAPSHOT_EXCLUSIONS], files: records,
        ...(gitState ? { git: { ...gitState, stage_sha256: stageSha, deleted } } : {}) };
    }
    const sources = [source('project', root, projectGit)];
    for (const ws of workstreams) {
      const directory = resolve(root, ws.worktree), state = gitIdentity(directory);
      if (state && (!projectGit || !sameFsPath(state.common_dir, projectGit.common_dir))) fail('foreign workstream Git repository');
      sources.push(source(ws.id, directory, state));
    }
    const makers = (loop.episodes ?? []).filter(ep => ep.role === 'maker' && ep.status === 'done').map(ep => {
      if ((ep.expected_artifacts ?? []).some(path => !ep.artifacts?.includes(path))) fail('maker omitted a declared artifact');
      return {
        id: ep.id, workstream_id: ep.workstream_id, point: ep.point,
        artifacts: [...new Set(ep.artifacts ?? [])].map(normalized).sort(order),
      };
    }).sort((a, b) => order(a.id, b.id));
    const artifacts = [];
    for (const maker of makers) {
      const ws = workstreams.find(item => item.id === maker.workstream_id);
      if (!ws || maker.artifacts.length === 0) fail('maker evidence or workstream mapping unavailable');
      for (const path of maker.artifacts) {
        if (!inside(resolve(root, ws.worktree), resolve(root, path))) fail('artifact escapes contributing workstream');
        artifacts.push({ ref: `artifact:${maker.id}:${path}`, path, ...readEvidence(resolve(root, path), resolve(root, ws.worktree)) });
      }
    }
    // Queries never refresh old proof. Re-read HEAD/index metadata at the end so
    // a concurrent checkout cannot yield a mixed source and repository snapshot.
    for (const source of sources.filter(item => item.git)) {
      const state = gitIdentity(resolve(root, source.path));
      const { deleted, stage_sha256, ...before } = source.git;
      if (JSON.stringify(canonical(state)) !== JSON.stringify(canonical(before))) fail('Git identity changed during capture');
    }
    for (const check of inventoryChecks) check();
    for (const [path, expected] of observations) { tick(); if (identity(lstatSync(path, { bigint: true })) !== expected) fail('captured file changed'); }
    if (!/^[0-9a-f]{64}$/.test(loop.goal_contract?.sha256 ?? '')) fail('goal contract digest unavailable');
    const snapshot = canonical({ version: 1, goal_sha256: loop.goal_contract.sha256,
      obligations: [...(loop.goal_obligations ?? [])].sort((a, b) => order(a.id, b.id)), workstreams, makers, artifacts, sources });
    return { ...snapshot, sha256: digest(JSON.stringify(snapshot)) };
  } catch (error) {
    if (error.message?.startsWith('GOAL_SNAPSHOT_UNAVAILABLE:')) throw error;
    fail(error.code ?? error.message ?? 'capture failed');
  }
}

export function snapshotEvidenceRefs(snapshot) {
  return [...new Set([...(snapshot?.artifacts ?? []), ...(snapshot?.sources ?? []).flatMap(source => source.files ?? [])]
    .map(item => item.ref).filter(ref => typeof ref === 'string'))].sort(order);
}
