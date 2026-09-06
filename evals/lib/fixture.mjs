import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI_PATH, REPO_ROOT } from './paths.mjs';
import { assertLexicalRelativePath } from './lexical-path.mjs';
import { evalChildEnv } from './child-env.mjs';

const NOW = '2026-08-10T00:00:00.000Z';
const MAX = 64 * 1024;

function within(base, candidate) {
  const rel = relative(base, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolvedThroughExistingParents(candidate) {
  let cursor = candidate;
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  const resolved = realpathSync(cursor);
  return suffix.reduce((path, part) => join(path, part), resolved);
}

function containedPath(base, rel, code) {
  assertLexicalRelativePath(rel, code);
  const canonicalBase = realpathSync(base);
  const candidate = resolvedThroughExistingParents(resolve(canonicalBase, rel));
  if (!within(canonicalBase, candidate)) throw new Error(code);
  return candidate;
}

function copyTree(source, destination, { excludeReference = false } = {}) {
  if (!existsSync(source)) throw new Error(`FIXTURE_SOURCE_MISSING: ${source}`);
  const sourceStat = statSync(source);
  if (sourceStat.isFile()) {
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
    return [destination];
  }
  const copied = [];
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (excludeReference && entry.name === 'reference') continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copied.push(...copyTree(from, to));
    } else if (entry.isFile()) {
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
      copied.push(to);
    } else {
      throw new Error(`FIXTURE_SPECIAL_FILE_FORBIDDEN: ${from}`);
    }
  }
  return copied;
}

function sourceFiles(source, { directOnly = false, excludeReference = false } = {}) {
  const output = [];
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (prefix === '' && excludeReference && entry.name === 'reference') continue;
      const absolute = join(directory, entry.name);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!directOnly) visit(absolute, path);
      } else if (entry.isFile()) output.push({ path, absolute });
      else throw new Error(`FIXTURE_SPECIAL_FILE_FORBIDDEN: ${absolute}`);
    }
  };
  visit(source);
  return output;
}

function referenceCandidates(source, trials) {
  const candidates = [{
    variant: 'reference', source,
    files: sourceFiles(source, { directOnly: trials > 1 }),
  }];
  if (trials > 1) {
    for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        const selected = join(source, entry.name);
        candidates.push({ variant: entry.name, source: selected, files: sourceFiles(selected) });
      }
    }
  }
  if (candidates.some(candidate => candidate.files.length === 0)) throw new Error('REFERENCE_VARIANT_EMPTY');
  return candidates;
}

function hashReferenceFiles(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.path).update('\0').update(readFileSync(file.absolute));
  return hash.digest('hex');
}

export function describeOutcomeReplay(task, { repoRoot = REPO_ROOT } = {}) {
  if (typeof task.fixture !== 'string') throw new Error('OUTCOME_FIXTURE_REQUIRED');
  if (typeof task.reference_solution !== 'string') throw new Error('REFERENCE_SOLUTION_REQUIRED');
  const canonicalRoot = realpathSync(repoRoot);
  const fixtureSource = containedPath(canonicalRoot, task.fixture, 'FIXTURE_PATH_ESCAPE');
  const referenceSource = containedPath(canonicalRoot, task.reference_solution, 'REFERENCE_PATH_ESCAPE');
  const fixtureFiles = sourceFiles(fixtureSource, { excludeReference: true });
  const fixtureHashes = new Map(fixtureFiles.map(file => [
    file.path, createHash('sha256').update(readFileSync(file.absolute)).digest('hex'),
  ]));
  return {
    fixture_files_materialized: fixtureFiles.length,
    acceptance_checked: task.acceptance.length,
    variants: referenceCandidates(referenceSource, task.trials).map(candidate => ({
      variant: candidate.variant,
      reference_files_materialized: candidate.files.length,
      distinct_reference_sha256: hashReferenceFiles(candidate.files),
      changed_files: candidate.files.filter(file => fixtureHashes.get(file.path)
        !== createHash('sha256').update(readFileSync(file.absolute)).digest('hex')).map(file => file.path).sort(),
    })),
  };
}

export function seedFixture({ now = NOW, goal = 'eval fixture', reviewer = 'deep-review' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deep-loop-eval-')));
  const review = JSON.stringify({
    points: ['implementation'], reviewer, mode: 'cross-model', flags: [],
    converge: true, max_review_rounds: 5, require_human_ack: false,
  });
  const proc = spawnSync(process.execPath, [
    CLI_PATH, 'init-run', '--runtime', 'codex', '--goal', goal,
    '--continuation', 'workstream-session', '--review', review,
    '--project-root', root, '--now', new Date(now).toISOString(),
  ], { env: evalChildEnv(), encoding: 'utf8', timeout: 30_000, maxBuffer: MAX });
  if (proc.status !== 0) throw new Error(`FIXTURE_INIT_FAILED: ${String(proc.stderr || '').trim()}`);
  const runId = JSON.parse(proc.stdout).run_id;
  return {
    root, runId, fence: { owner: runId, generation: 1, intent: 'business' },
    runDir: join(root, '.deep-loop', 'runs', runId),
  };
}

export function materializeSetupFiles(root, files = [], { fixtureRoot = null } = {}) {
  const canonicalRoot = realpathSync(root);
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('SETUP_FILE_INVALID');
    const out = containedPath(canonicalRoot, file.path, 'SETUP_PATH_ESCAPE');
    const rel = relative(canonicalRoot, out).split('\\').join('/');
    if (rel === '.deep-loop' || rel.startsWith('.deep-loop/')) throw new Error('DURABLE_STATE_SEED_FORBIDDEN');
    const hasContent = typeof file.content === 'string';
    const hasFixture = typeof file.from_fixture === 'string';
    if (hasContent === hasFixture) throw new Error('SETUP_CONTENT_REQUIRED');
    let bytes;
    if (hasContent) bytes = Buffer.from(file.content, 'utf8');
    else {
      if (!fixtureRoot) throw new Error('FIXTURE_SOURCE_REQUIRED');
      const source = containedPath(realpathSync(fixtureRoot), file.from_fixture, 'FIXTURE_SOURCE_ESCAPE');
      if (!statSync(source).isFile()) throw new Error('FIXTURE_SOURCE_NOT_FILE');
      bytes = readFileSync(source);
    }
    if (bytes.length > MAX) throw new Error('SETUP_FILE_TOO_LARGE');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes, { flag: 'wx' });
    if (file.mode !== undefined) chmodSync(out, file.mode);
  }
}

export function applyFixtureActions(root, task, runId = task.__run_id) {
  for (const action of task.fixture_actions || []) {
    if (!action || Object.keys(action).sort().join(',') !== 'offset,operation,target,type'
      || action.type !== 'tamper' || action.target !== 'loop.json'
      || action.operation !== 'flip-byte' || action.offset !== 0) {
      throw new Error('FIXTURE_ACTION_FORBIDDEN');
    }
    if (!runId) throw new Error('FIXTURE_RUN_ID_REQUIRED');
    const path = join(root, '.deep-loop', 'runs', runId, 'loop.json');
    const bytes = Buffer.from(readFileSync(path));
    if (bytes.length === 0) throw new Error('FIXTURE_TAMPER_EMPTY');
    bytes[action.offset] ^= 1;
    writeFileSync(path, bytes);
  }
}

export function materializeFixture(root, task, { repoRoot = REPO_ROOT } = {}) {
  if (typeof task.fixture !== 'string') throw new Error('OUTCOME_FIXTURE_REQUIRED');
  const source = containedPath(realpathSync(repoRoot), task.fixture, 'FIXTURE_PATH_ESCAPE');
  return copyTree(source, root, { excludeReference: true });
}

export function materializeOutcomeSupport(root, task, { repoRoot = REPO_ROOT } = {}) {
  const evalDir = join(root, '.eval');
  mkdirSync(evalDir, { recursive: true });
  writeFileSync(join(evalDir, 'task.json'), `${JSON.stringify({ task_id: task.id })}\n`, { flag: 'wx' });
  return ['.eval/task.json'];
}

export function applyReference(root, task, { repoRoot = REPO_ROOT, trialIndex = 0 } = {}) {
  if (typeof task.reference_solution !== 'string') throw new Error('REFERENCE_SOLUTION_REQUIRED');
  const source = containedPath(realpathSync(repoRoot), task.reference_solution, 'REFERENCE_PATH_ESCAPE');
  const candidate = referenceCandidates(source, task.trials)[trialIndex];
  if (!candidate) throw new Error('REFERENCE_VARIANT_MISSING');
  const selected = candidate.source;
  const label = candidate.variant;
  let copied;
  if (selected === source && task.trials > 1) {
    copied = [];
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const destination = join(root, entry.name);
      cpSync(join(source, entry.name), destination);
      copied.push(destination);
    }
  } else copied = copyTree(selected, root);
  if (copied.length === 0) throw new Error('REFERENCE_VARIANT_EMPTY');
  return {
    ok: true, executed: true, variant: label,
    copied: copied.map(path => relative(root, path).split('\\').join('/')).sort(),
  };
}
