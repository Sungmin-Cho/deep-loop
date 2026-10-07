import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path, { join } from 'node:path';
import {
  RUN_SELECTION_BOUNDS,
  captureVerifiedRunSet,
  captureVerifiedRunSnapshot,
} from './integrity.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import {
  normalizePortableRelativePath,
  pathWithin,
  recordedClaimKey,
} from './fs-safe.mjs';

const ACTIVE = new Set(['running', 'paused']);
const TERMINAL_WORKSTREAM = new Set(['ready', 'merged', 'abandoned']);
const TERMINAL_RUN = new Set(['completed', 'stopped', 'abandoned', 'terminal', 'finished']);
// Run-level terminal statuses of the loop schema. Only these runs' claims may be
// isolated or normalized; an active run's claims stay strict whatever their workstream.
const HISTORY_RUN = new Set(['completed', 'stopped']);
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNSAFE_RUN_ID = /[\x00-\x1F\x7F-\x9F/\\]/;
const PURPOSES = new Set(['hook-checkpoint', 'hook-restore', 'headless', 'cli-read']);

function safeRunId(value) {
  return typeof value === 'string' && value !== '.' && value !== '..'
    && !UNSAFE_RUN_ID.test(value) && SAFE_RUN_ID.test(value);
}

function compareCodeUnits(left, right) {
  const a = String(left);
  const b = String(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function diagnosticFits(value, maxChars) {
  const encoded = JSON.stringify(value);
  return encoded.length <= maxChars ? encoded : null;
}

// Public hook diagnostics are deliberately a valid, deterministic JSON prefix of the
// bounded resolver result. Optional entries are added whole, so a diagnostic can never
// end in a partial object/array/token. The full resolver result remains untruncated.
export function formatBoundedRoutingDiagnostic(detail, { maxChars = 220 } = {}) {
  const limit = Number.isSafeInteger(maxChars) && maxChars > 32 ? maxChars : 220;
  const result = {};
  const scalarKeys = ['action', 'kind', 'reason', 'source'];
  const boundKeys = ROUTING_BOUND_FIELDS;
  const addScalar = key => {
    if (detail?.[key] === undefined) return;
    const next = { ...result, [key]: detail[key] };
    if (diagnosticFits(next, limit) !== null) Object.assign(result, { [key]: detail[key] });
  };
  // Keep total first and always retain it when supplied, even if other verbose fields do not fit.
  addScalar('total');
  for (const key of scalarKeys) addScalar(key);

  const addMap = (key, values) => {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return;
    const map = {};
    for (const id of Object.keys(values).sort(compareCodeUnits)) {
      const value = values[id];
      const entry = value && typeof value === 'object' ? {
        ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
        ...(typeof value.operation_id === 'string' ? { operation_id: value.operation_id } : {}),
        ...(typeof value.phase === 'string' ? { phase: value.phase } : {}),
      } : value;
      const next = { ...result, [key]: { ...map, [id]: entry } };
      if (diagnosticFits(next, limit) === null) break;
      map[id] = entry;
    }
    if (Object.keys(map).length > 0) result[key] = map;
  };
  addMap('errors', detail?.errors);

  if (Array.isArray(detail?.candidates)) {
    const candidates = [];
    const sorted = [...detail.candidates].sort((left, right) => (
      compareCodeUnits(left?.run_id, right?.run_id)
    ));
    for (const candidate of sorted) {
      const item = {
        ...(typeof candidate?.run_id === 'string' ? { run_id: candidate.run_id } : {}),
        ...(typeof candidate?.status === 'string' ? { status: candidate.status } : {}),
      };
      const next = { ...result, candidates: [...candidates, item] };
      if (diagnosticFits(next, limit) === null) break;
      candidates.push(item);
    }
    if (candidates.length > 0) result.candidates = candidates;
  }
  for (const key of boundKeys) addScalar(key);
  return JSON.stringify(result);
}

function boundedCandidates(values) {
  const sorted = [...values].sort((left, right) => compareCodeUnits(left.run_id, right.run_id));
  return Object.freeze(sorted.slice(0, 5).map(value => Object.freeze({
    run_id: value.run_id,
    status: value.status,
  })));
}

function invalid(reason, extra = {}) {
  return Object.freeze({ ok: false, kind: 'invalid', reason, ...extra });
}

function none(reason, source) {
  return Object.freeze({ ok: true, kind: 'none', reason, ...(source ? { source } : {}) });
}

function selected(source, run, snapshot, matchedWorktree, extra = {}) {
  return Object.freeze({
    ok: true,
    kind: 'selected',
    runId: run.run_id,
    source,
    status: run.status,
    snapshot,
    ...(matchedWorktree ? { matchedWorktree } : {}),
    ...extra,
  });
}

function identityValue(identity, lower, upper) {
  if (!identity || typeof identity !== 'object') return undefined;
  const snake = lower.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  return identity[lower] ?? identity[upper] ?? identity[snake];
}

function truthyMarker(value) {
  return value === true || value === 1 || value === '1';
}

function completeEnvIdentity(identity, purpose, root, realpathFn) {
  if (purpose !== 'headless' || !identity || typeof identity !== 'object') return null;
  const values = {
    runId: identityValue(identity, 'runId', 'DEEP_LOOP_RUN_ID'),
    projectRoot: identityValue(identity, 'projectRoot', 'DEEP_LOOP_PROJECT_ROOT'),
    owner: identityValue(identity, 'owner', 'DEEP_LOOP_OWNER'),
    generation: identityValue(identity, 'generation', 'DEEP_LOOP_GENERATION'),
    headless: identityValue(identity, 'headless', 'DEEP_LOOP_HEADLESS'),
    unattended: identityValue(identity, 'unattended', 'DEEP_LOOP_UNATTENDED'),
  };
  const present = Object.values(values).every(value => value !== undefined && value !== null && value !== '');
  if (!present) return null;
  if (!safeRunId(String(values.runId))
    || typeof values.owner !== 'string' || values.owner.length === 0
    || !/^[1-9]\d*$/.test(String(values.generation))
    || !Number.isSafeInteger(Number(values.generation))
    || !truthyMarker(values.headless) || !truthyMarker(values.unattended)) {
    return { invalid: true };
  }
  let canonicalEnv;
  let canonicalRoot;
  try {
    canonicalEnv = canonicalProjectRoot(String(values.projectRoot), { realpathSync: realpathFn });
    canonicalRoot = canonicalProjectRoot(root, { realpathSync: realpathFn });
  } catch {
    return { invalid: true };
  }
  if (canonicalEnv !== canonicalRoot) return { invalid: true };
  return {
    runId: String(values.runId),
    owner: String(values.owner),
    generation: Number(values.generation),
  };
}

function canonicalRootOf(root, realpathFn) {
  return canonicalProjectRoot(root, { realpathSync: realpathFn });
}

function unwrapCapture(value) {
  if (value?.ok === false) return null;
  return value?.snapshot || value;
}

function snapshotRun(snapshot, runId, root, realpathFn) {
  if (!snapshot?.data || snapshot.data.run_id !== runId) return false;
  try {
    return canonicalRootOf(snapshot.data.project?.root, realpathFn)
      === canonicalRootOf(root, realpathFn);
  } catch {
    return false;
  }
}

export { RUN_SELECTION_BOUNDS };

// Bound diagnostics, most explanatory first: hook diagnostics keep a prefix of these.
export const ROUTING_BOUND_FIELDS = Object.freeze(['phase', 'bound', 'max_run_ids', 'max_full_captures',
  'full_capture_count', 'max_claims', 'deadline_ms', 'observed_count', 'total_is_lower_bound']);
const BOUND_FIELDS = ROUTING_BOUND_FIELDS;

// Capture options shared by cwd selection and `run list` (issue #77 §3.2).
export function runSelectionSetOptions(purpose = 'cli-read') {
  return {
    historyFastPath: true,
    maxRunIds: RUN_SELECTION_BOUNDS.maxRunIds,
    maxFullCaptures: RUN_SELECTION_BOUNDS.maxFullCaptures,
    maxLightBytes: RUN_SELECTION_BOUNDS.maxLightBytes,
    baseDeadlineMs: RUN_SELECTION_BOUNDS.baseDeadlineMs,
    perLightReadMs: RUN_SELECTION_BOUNDS.perLightReadMs,
    perFullCaptureMs: RUN_SELECTION_BOUNDS.perFullCaptureMs,
    maxDeadlineMs: RUN_SELECTION_BOUNDS.maxDeadlineMs[purpose] ?? RUN_SELECTION_BOUNDS.maxDeadlineMs['cli-read'],
  };
}

function boundExceeded(source) {
  const extra = {};
  for (const key of BOUND_FIELDS) if (source?.[key] !== undefined) extra[key] = source[key];
  return invalid('run-set-bound-exceeded', extra);
}

function normalizeRunSet(captured, root, realpathFn) {
  if (!captured || typeof captured !== 'object') return invalid('run-set-integrity');
  if (captured.kind === 'run-set-bound-exceeded' || captured.reason === 'run-set-bound-exceeded') {
    return boundExceeded(captured);
  }
  const errors = captured.errors && typeof captured.errors === 'object' ? captured.errors : {};
  const errorIds = Object.keys(errors).sort(compareCodeUnits);
  if (captured.ok === false || errorIds.length > 0) {
    const hasReconciliation = errorIds.some(id => errors[id]?.kind === 'reconciliation-required');
    const projected = Object.fromEntries(errorIds.slice(0, 5).map(id => [id, {
      kind: errors[id]?.kind || 'integrity-invalid',
      ...(errors[id]?.operation_id ? { operation_id: errors[id].operation_id } : {}),
      ...(errors[id]?.phase ? { phase: errors[id].phase } : {}),
    }]));
    return invalid(hasReconciliation ? 'reconciliation-required' : 'run-set-integrity', {
      errors: Object.freeze(projected),
      total: errorIds.length,
    });
  }
  const runs = captured.runs && typeof captured.runs === 'object' ? captured.runs : null;
  if (!runs) return invalid('run-set-integrity');
  const entries = [];
  for (const runId of Object.keys(runs).sort(compareCodeUnits)) {
    if (!safeRunId(runId)) {
      return invalid('run-set-integrity', {
        errors: Object.freeze({ [runId]: { kind: 'integrity-invalid' } }),
        total: 1,
      });
    }
    const snapshot = unwrapCapture(runs[runId]);
    if (!snapshotRun(snapshot, runId, root, realpathFn)) {
      return invalid('run-set-integrity', {
        errors: Object.freeze({ [runId]: { kind: 'integrity-invalid' } }),
        total: 1,
      });
    }
    entries.push({
      run_id: runId,
      status: snapshot.data.status,
      snapshot,
      verification: runs[runId]?.verification === 'state-hash' ? 'state-hash' : 'full',
    });
  }
  return entries;
}

function captureFailure(runId, failure) {
  const message = typeof failure?.message === 'string' ? failure.message : String(failure ?? '');
  const rawKind = failure?.kind || failure?.code || (message.includes('reconciliation')
    ? 'reconciliation-required' : 'integrity-invalid');
  const reconciliation = rawKind === 'reconciliation-required'
    || String(rawKind).includes('TRANSACTION_RECONCILIATION');
  const detail = {
    kind: reconciliation ? 'reconciliation-required' : 'integrity-invalid',
    ...(typeof failure?.operation_id === 'string' ? { operation_id: failure.operation_id } : {}),
    ...(typeof failure?.phase === 'string' ? { phase: failure.phase } : {}),
  };
  return invalid(reconciliation ? 'reconciliation-required' : 'identity-invalid', {
    errors: Object.freeze({ [runId]: Object.freeze(detail) }),
    total: 1,
  });
}

function currentRunId(root) {
  const path = join(root, '.deep-loop', 'current');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    return safeRunId(value) ? value : null;
  } catch {
    return null;
  }
}

function conventionContained(root, key, platform, pathApi) {
  if (!key.ok) return false;
  const normalizedWorktree = key.normalized;
  const convention = platform === 'win32'
    ? (normalizedWorktree.toLowerCase().startsWith('.claude/worktrees/')
      || normalizedWorktree.toLowerCase().startsWith('.worktrees/'))
    : (normalizedWorktree.startsWith('.claude/worktrees/') || normalizedWorktree.startsWith('.worktrees/'));
  if (!convention) return false;
  const candidate = key.canonical || key.absolute;
  const roots = [pathApi?.resolve(root, '.claude', 'worktrees'), pathApi?.resolve(root, '.worktrees')];
  return pathWithin(root, candidate, { pathApi })
    && roots.some(base => pathWithin(base, candidate, { pathApi })
      && pathApi.relative(base, candidate) !== '');
}

function strictClaimKey(root, worktree, platform, realpathFn, pathApi) {
  const key = recordedClaimKey({ root, worktree, platform, realpathFn, pathApi });
  return conventionContained(root, key, platform, pathApi) ? key : null;
}

// A terminal run's claim recorded as an absolute path by an older writer. It is the
// same claim as its relative form when it lies under one of the bases: the current
// canonical root or the run's stored project root, which binding already proved to
// be an alias of it.
function legacyAbsoluteClaimKey(root, run, worktree, platform, realpathFn, pathApi) {
  if (!pathApi.isAbsolute(worktree)) return null;
  // Lexical normalization of `..` can move a claim across a symlinked component, so a
  // dot segment means the recorded location is not knowable without the old tree.
  if (worktree.split(/[\\/]/).some(segment => segment === '.' || segment === '..')) return null;
  // On POSIX a backslash is a filename character in the native path an old writer
  // recorded; the portable claim grammar would read it as a separator and move the claim.
  if (platform !== 'win32' && worktree.includes('\\')) return null;
  const stored = run.snapshot?.data?.project?.root;
  const bases = [...new Set([root, typeof stored === 'string' ? stored : null].filter(Boolean))];
  for (const base of bases) {
    let rel;
    try { rel = pathApi.relative(base, pathApi.normalize(worktree)); }
    catch { continue; }
    if (!rel || rel.startsWith('..') || pathApi.isAbsolute(rel)) continue;
    const key = strictClaimKey(root, rel.split(pathApi.sep).join('/'), platform, realpathFn, pathApi);
    if (key) return key;
  }
  return null;
}

// An isolated terminal claim keeps only a residue region: the location a relative claim
// names under the portable grammar (`/` and `\` both separate, no `.`/`..`/empty
// segment), and only strictly below `.claude/worktrees/` or `.worktrees/`. It can turn
// a cwd inside it into terminal residue and nothing else.
function residueRegion(root, worktree, realpathFn, pathApi, platform) {
  if (typeof worktree !== 'string' || worktree.length === 0 || worktree.includes('\0')) return null;
  const portable = worktree.replaceAll('\\', '/');
  if (portable.startsWith('/') || /^[A-Za-z]:/.test(portable)) return null;
  const segments = portable.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null;
  const fold = value => (platform === 'win32' ? value.toLowerCase() : value);
  const conventional = (fold(segments[0]) === '.worktrees' && segments.length >= 2)
    || (fold(segments[0]) === '.claude' && fold(segments[1] ?? '') === 'worktrees' && segments.length >= 3);
  if (!conventional) return null;
  let lexical;
  try { lexical = pathApi.resolve(root, ...segments); }
  catch { return null; }
  const candidates = [lexical];
  try { candidates.push(realpathFn(lexical)); } catch { /* a removed worktree keeps its lexical region */ }
  const bases = [pathApi.resolve(root, '.claude', 'worktrees'), pathApi.resolve(root, '.worktrees')];
  const inside = candidates.filter(candidate => {
    try {
      return bases.some(base => pathWithin(base, candidate, { pathApi }) && pathApi.relative(base, candidate) !== '');
    } catch {
      return false;
    }
  });
  return inside.length > 0 ? [...new Set(inside)] : null;
}

function claimInventory(root, entries, platform, realpathFn, pathApi) {
  const claims = [];
  const residues = [];
  const errors = [];
  const history = { isolated_claims: 0, legacy_absolute_claims: 0 };
  let examined = 0;
  for (const run of entries) {
    const workstreams = Array.isArray(run.snapshot.data.workstreams)
      ? run.snapshot.data.workstreams : [];
    const historyRun = HISTORY_RUN.has(run.status);
    for (const workstream of workstreams) {
      if (typeof workstream?.worktree !== 'string') continue;
      // Each claim costs realpath and identity reads; bound them like the run set.
      examined += 1;
      if (examined > RUN_SELECTION_BOUNDS.maxClaims) {
        return { ok: false, bound: true, examined, history };
      }
      const terminal = TERMINAL_WORKSTREAM.has(workstream.status) || TERMINAL_RUN.has(run.status);
      let key = strictClaimKey(root, workstream.worktree, platform, realpathFn, pathApi);
      if (!key && historyRun) {
        key = legacyAbsoluteClaimKey(root, run, workstream.worktree, platform, realpathFn, pathApi);
        if (key) history.legacy_absolute_claims += 1;
      }
      if (key) {
        claims.push({ run, workstream, key, terminal });
        continue;
      }
      if (!historyRun) {
        errors.push({ run_id: run.run_id, kind: 'invalid-worktree-claim' });
        continue;
      }
      history.isolated_claims += 1;
      const region = residueRegion(root, workstream.worktree, realpathFn, pathApi, platform);
      if (region) residues.push({ run, paths: region });
    }
  }
  if (errors.length > 0) return { ok: false, errors, history };
  return { ok: true, claims, residues, history };
}

// Only non-terminal claims can conflict. Terminal history never makes the whole
// project ambiguous: a cwd inside a terminal claim is residue (issue #77, D2).
function duplicateClaims(claims) {
  const byKey = new Map();
  for (const claim of claims) {
    if (claim.terminal) continue;
    for (const key of claim.key.keys) {
      const list = byKey.get(key) || [];
      list.push(claim);
      byKey.set(key, list);
    }
  }
  const duplicate = new Map();
  for (const list of byKey.values()) {
    if (list.length > 1) for (const claim of list) duplicate.set(claim.run.run_id, claim.run);
  }
  return [...duplicate.values()];
}

function residueContains(residue, cwd, pathApi) {
  return residue.paths.some(path => {
    try { return pathWithin(path, cwd, { pathApi }); }
    catch { return false; }
  });
}

function containedClaim(claim, cwd, root, pathApi) {
  const candidate = claim.key.canonical || claim.key.absolute;
  if (!candidate) return false;
  try {
    return pathWithin(root, candidate, { pathApi })
      && pathWithin(candidate, cwd, { pathApi });
  } catch {
    return false;
  }
}

function claimSpecificity(claim) {
  return claim.key.normalized.split('/').length;
}

function selectLegacyCurrent(root, entries, claims, cwd, realpathFn, pathApi, currentRunIdFn = currentRunId) {
  const rawCurrent = currentRunIdFn(root);
  if (rawCurrent !== null && rawCurrent !== undefined && !safeRunId(rawCurrent)) return none('stale-current');
  const current = safeRunId(rawCurrent) ? rawCurrent : null;
  if (!current) return none(existsSync(join(root, '.deep-loop', 'current')) ? 'stale-current' : 'no-current');
  const run = entries.find(entry => entry.run_id === current);
  if (!run) return none('stale-current');
  if (ACTIVE.has(run.status)) return none('no-active-run');
  const terminalClaims = claims.filter(claim => claim.run.run_id === current && claim.terminal);
  if (terminalClaims.length < 1) return none('terminal-residue');
  if (cwd) {
    const matches = terminalClaims.filter(claim => containedClaim(claim, cwd, root, pathApi));
    if (matches.length > 0) {
      const deepest = matches.slice().sort((left, right) => (
        claimSpecificity(right) - claimSpecificity(left)
        || compareCodeUnits(left.key.normalized, right.key.normalized)
      ))[0];
      return selected('legacy-current', run, run.snapshot, deepest.workstream.worktree);
    }
  }
  if (!cwd) return selected('legacy-current', run, run.snapshot);
  return selected('legacy-current', run, run.snapshot);
}

export function resolveRunContext({
  root,
  explicitRunId = null,
  envIdentity = null,
  cwd = null,
  purpose,
  lockOptions,
  vectorOptions,
  nowFn,
  sleepFn,
  opendirFn,
  captureRunSnapshot = captureVerifiedRunSnapshot,
  captureRunSet = captureVerifiedRunSet,
  realpathFn = realpathSync.native || realpathSync,
  pathApi = path,
  platform = process.platform,
  currentRunIdFn = currentRunId,
} = {}) {
  if (typeof purpose !== 'undefined' && !PURPOSES.has(purpose)) return invalid('invalid-purpose');
  let canonicalRoot;
  try { canonicalRoot = canonicalRootOf(root, realpathFn); }
  catch { return invalid('root-unresolvable'); }

  const hasExplicit = explicitRunId !== null && explicitRunId !== undefined && explicitRunId !== '';
  if (hasExplicit && !safeRunId(String(explicitRunId))) return invalid('invalid-run-id');
  const env = completeEnvIdentity(envIdentity, purpose, canonicalRoot, realpathFn);
  if (env?.invalid) return invalid('identity-conflict');
  if (hasExplicit && env && env.runId !== String(explicitRunId)) return invalid('identity-conflict');
  const identityRunId = hasExplicit ? String(explicitRunId) : env?.runId;
  if (identityRunId) {
    let captured;
    try {
      captured = captureRunSnapshot(canonicalRoot, identityRunId, {
        lockOptions, vectorOptions, nowFn, sleepFn,
      });
    } catch (error) {
      return captureFailure(identityRunId, error);
    }
    if (captured?.ok === false) return captureFailure(identityRunId, captured);
    const snapshot = unwrapCapture(captured);
    if (!snapshotRun(snapshot, identityRunId, canonicalRoot, realpathFn)) {
      return invalid('identity-invalid', { errors: Object.freeze({ [identityRunId]: { kind: 'integrity-invalid' } }), total: 1 });
    }
    const run = { run_id: identityRunId, status: snapshot.data.status };
    return selected(hasExplicit ? 'explicit' : 'env', run, snapshot, undefined,
      env ? { expect: Object.freeze({ owner: env.owner, generation: env.generation }) } : {});
  }

  let capturedSet;
  try {
    capturedSet = captureRunSet(canonicalRoot, {
      ...runSelectionSetOptions(purpose),
      lockOptions,
      vectorOptions,
      nowFn,
      sleepFn,
      opendirFn,
    });
  } catch (error) {
    if (error?.kind === 'run-set-bound-exceeded' || String(error?.message || '').includes('run-set-bound-exceeded')) {
      return boundExceeded(error);
    }
    return invalid('run-set-integrity');
  }
  const entries = normalizeRunSet(capturedSet, canonicalRoot, realpathFn);
  if (!Array.isArray(entries)) return entries;
  if (entries.length === 0) return none('no-runs');
  const inventory = claimInventory(canonicalRoot, entries, platform, realpathFn, pathApi);
  if (inventory.bound) {
    return invalid('run-set-bound-exceeded', {
      phase: 'claims', bound: 'count', max_claims: RUN_SELECTION_BOUNDS.maxClaims,
      observed_count: inventory.examined, total_is_lower_bound: true,
    });
  }
  const history = inventory.history.isolated_claims > 0 || inventory.history.legacy_absolute_claims > 0
    ? Object.freeze({ ...inventory.history }) : null;
  const withHistory = result => (history ? Object.freeze({ ...result, history }) : result);
  if (!inventory.ok) return withHistory(invalid('invalid-worktree-claim', {
    errors: Object.freeze(Object.fromEntries(
      [...new Map(inventory.errors.map(error => [error.run_id, { kind: error.kind }]))]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .slice(0, 5),
    )),
    total: new Set(inventory.errors.map(error => error.run_id)).size,
  }));
  const result = selectFromInventory({
    canonicalRoot, entries, inventory, cwd, realpathFn, pathApi, currentRunIdFn,
  });
  return withHistory(confirmHistorySelection(result, entries, {
    canonicalRoot, captureRunSnapshot, lockOptions, vectorOptions, nowFn, sleepFn, realpathFn,
  }));
}

function selectFromInventory({ canonicalRoot, entries, inventory, cwd, realpathFn, pathApi, currentRunIdFn }) {
  const duplicates = duplicateClaims(inventory.claims);
  if (duplicates.length > 0) {
    return Object.freeze({
      ok: false,
      kind: 'ambiguous',
      reason: 'duplicate-worktree-claim',
      candidates: boundedCandidates(duplicates),
      total: duplicates.length,
    });
  }

  let canonicalCwd = null;
  if (cwd !== null && cwd !== undefined) {
    try { canonicalCwd = realpathFn(cwd); }
    catch { return invalid('cwd-unresolvable'); }
  }
  const active = entries.filter(run => ACTIVE.has(run.status));
  if (canonicalCwd) {
    const claimMatches = inventory.claims.filter(claim => claim.terminal
      && containedClaim(claim, canonicalCwd, canonicalRoot, pathApi));
    const regionMatches = inventory.residues.filter(residue => residueContains(residue, canonicalCwd, pathApi));
    const terminalMatches = [...claimMatches, ...regionMatches];
    if (terminalMatches.length > 0) {
      // `source: 'worktree'` marks residue decided by the cwd's own (finished) worktree
      // claim, as opposed to a project whose last run finished (issue #77).
      const insideFinished = () => none('terminal-residue', 'worktree');
      if (active.length > 0) return insideFinished();
      // An isolated claim's region is residue only; it never makes its run legacy-current.
      if (claimMatches.length === 0) return insideFinished();
      const terminalRuns = new Set(terminalMatches.map(claim => claim.run.run_id));
      if (terminalRuns.size > 1) return insideFinished();
      const current = currentRunIdFn(canonicalRoot);
      if (current !== [...terminalRuns][0]) return insideFinished();
      return selectLegacyCurrent(canonicalRoot, entries, inventory.claims, canonicalCwd, realpathFn, pathApi, currentRunIdFn);
    }
    const matches = inventory.claims.filter(claim => !claim.terminal
      && ACTIVE.has(claim.run.status)
      && containedClaim(claim, canonicalCwd, canonicalRoot, pathApi));
    const matchedRuns = new Map(matches.map(claim => [claim.run.run_id, claim]));
    if (matchedRuns.size === 1) {
      const claim = [...matchedRuns.values()][0];
      return selected('worktree', claim.run, claim.run.snapshot, claim.workstream.worktree);
    }
    if (matchedRuns.size > 1) {
      return Object.freeze({
        ok: false,
        kind: 'ambiguous',
        reason: 'multi-active-root-cwd',
        candidates: boundedCandidates([...matchedRuns.values()].map(claim => claim.run)),
        total: matchedRuns.size,
      });
    }
  }
  if (active.length === 1) return selected('single-active', active[0], active[0].snapshot);
  if (active.length > 1) {
    return Object.freeze({
      ok: false,
      kind: 'ambiguous',
      reason: 'multi-active-root-cwd',
      candidates: boundedCandidates(active),
      total: active.length,
    });
  }
  return selectLegacyCurrent(canonicalRoot, entries, inventory.claims, canonicalCwd, realpathFn, pathApi, currentRunIdFn);
}

// A selected run is always returned from a full capture. Terminal history read on the
// lock-free path is captured again before it can leave the resolver.
function confirmHistorySelection(result, entries, {
  canonicalRoot, captureRunSnapshot, lockOptions, vectorOptions, nowFn, sleepFn, realpathFn,
}) {
  if (result?.kind !== 'selected') return result;
  const entry = entries.find(candidate => candidate.run_id === result.runId);
  if (!entry || entry.verification !== 'state-hash') return result;
  const failed = kind => invalid('run-set-integrity', {
    errors: Object.freeze({ [entry.run_id]: Object.freeze({ kind }) }),
    total: 1,
  });
  const startedAt = (typeof nowFn === 'function' ? nowFn : Date.now)();
  const startedMs = startedAt instanceof Date ? startedAt.getTime() : Number(startedAt);
  let captured;
  try {
    captured = captureRunSnapshot(canonicalRoot, entry.run_id, {
      lockOptions,
      vectorOptions,
      nowFn,
      sleepFn,
      ...(Number.isFinite(startedMs)
        ? { vectorDeadlineAtMs: startedMs + RUN_SELECTION_BOUNDS.baseDeadlineMs } : {}),
    });
  } catch (error) {
    if (String(error?.message || error).startsWith('LOCK_BUSY')) return failed('lock-busy');
    return failed(captureFailure(entry.run_id, error).errors?.[entry.run_id]?.kind || 'integrity-invalid');
  }
  if (captured?.ok === false) {
    return failed(captured.kind === 'reconciliation-required' ? 'reconciliation-required' : 'integrity-invalid');
  }
  const snapshot = unwrapCapture(captured);
  if (!snapshotRun(snapshot, entry.run_id, canonicalRoot, realpathFn)) return failed('integrity-invalid');
  const claimsOf = data => JSON.stringify((Array.isArray(data?.workstreams) ? data.workstreams : [])
    .map(workstream => [workstream?.worktree ?? null, workstream?.status ?? null]));
  if (snapshot.data.status !== entry.status
    || claimsOf(snapshot.data) !== claimsOf(entry.snapshot.data)) {
    return failed('state-drift');
  }
  return selected(result.source, { run_id: entry.run_id, status: snapshot.data.status }, snapshot,
    result.matchedWorktree);
}
