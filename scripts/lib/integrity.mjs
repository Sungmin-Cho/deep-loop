import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  opendirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { contentHash, ulid, unwrap } from './envelope.mjs';
import {
  parseHashVerifiedStateBytes,
  runDir,
  readState,
  writeCompactRestoreState,
  writeState,
  withLock,
  withReadLock,
} from './state.mjs';
import {
  assertProjectRootBinding,
  canonicalProjectRoot,
  classifyProjectRootBinding,
  projectRootDigest,
} from './project-root.mjs';
import { validate } from './schema.mjs';
import { durableAtomicWrite, flushDirectory } from './atomic-write.mjs';
import { validateLaunchCommandMetadata } from './runtime-descriptor.mjs';
import {
  classifyArtifactTargetsLocked,
  findPreparedPublicationLocked,
  markPublicationCommittedLocked,
  preparePublicationStagesLocked,
  publicationCommittedLocked,
  publishArtifactTargetsLocked,
  retireCommittedPublicationLocked,
} from './transaction-journal.mjs';
import {
  captureStableFileIdentity,
  matchingStableFileIdentity,
  normalizePortableRelativePath,
} from './fs-safe.mjs';
import {
  normalizeProviderEvidence,
  providerEvidenceProjection,
  readStableRegular,
  validateCompactPruneBytes,
  validateStrictBytes,
  validateStrictSelf,
} from './checkpoint-validation.mjs';
import {
  compactRestoreRequestBinding,
  compactRestoreRequestBindingDigest,
  findCompactRestoreIntentLocked,
  readCompactObservationProofLocked,
  removeCompactRestoreIntentLocked,
  writeCompactRestoreIntentLocked,
} from './compact-restore-intent.mjs';
import { leaseCheck } from './lease.mjs';
import { nextAction } from './next-action.mjs';
import { sessionRuntime, validateSessionRuntime } from './runtime.mjs';
import { isOpenScope, ownerSession } from './session-scope.mjs';

const logPath = (root, runId) => join(runDir(root, runId), 'event-log.jsonl');
const COMPACT_PRUNE_FILE = /^([0-9a-f]{64})-compact-prune\.json$/;

function assertNoCompactRestoreIntentLocked(root, runId, guard) {
  const canonicalRunDir = (realpathSync.native || realpathSync)(runDir(root, runId));
  if (findCompactRestoreIntentLocked(canonicalRunDir, runId, guard)) {
    throw new Error('COMPACT_RESTORE_INTENT_PENDING');
  }
}

function compactRestoreIntentCandidateLocked(root, runId, guard) {
  const canonicalRunDir = (realpathSync.native || realpathSync)(runDir(root, runId));
  guard.assertOwned(canonicalRunDir);
  const dir = join(canonicalRunDir, 'compact-restore-intents');
  if (!existsSync(dir)) return false;
  let stat;
  try { stat = lstatSync(dir); } catch { return true; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
  let candidate;
  try { candidate = readdirSync(dir).some(name => name.endsWith('.prepared.json')); }
  catch { return true; }
  guard.assertOwned(canonicalRunDir);
  return candidate;
}

function compactCheckpointDirectory(root, runId) {
  const dir = join(runDir(root, runId), 'checkpoints');
  if (!existsSync(dir)) return null;
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || realpathSync(dir) !== realpathSync(join(runDir(root, runId), 'checkpoints'))) {
    throw new Error('CHECKPOINT_PATH_INVALID');
  }
  return dir;
}

function captureCompactPruneArtifact(path, { optional = false } = {}) {
  try {
    const { bytes, identity } = readStableRegular(path, 'COMPACT_PRUNE_INVALID');
    return { bytes, identity, sha256: contentHash(bytes) };
  } catch (error) {
    if (optional && error?.message === 'CHECKPOINT_NOT_FOUND') return null;
    throw new Error('COMPACT_PRUNE_INVALID');
  }
}

function assertCompactPruneArtifactUnchanged(path, captured) {
  if (captured === null) {
    if (existsSync(path)) throw new Error('COMPACT_PRUNE_INVALID');
    return;
  }
  let current;
  try { current = readStableRegular(path, 'COMPACT_PRUNE_INVALID'); }
  catch { throw new Error('COMPACT_PRUNE_INVALID'); }
  if (!matchingStableFileIdentity(captured.identity, current.identity)
    || contentHash(current.bytes) !== captured.sha256) {
    throw new Error('COMPACT_PRUNE_INVALID');
  }
}

export function reconcileCompactPruneTombstonesLocked(
  root,
  runId,
  guard,
  { checkpointKey, faultAt = () => {} } = {},
) {
  const dir = compactCheckpointDirectory(root, runId);
  if (dir === null) return false;
  let reconciled = false;
  for (const name of readdirSync(dir).sort()) {
    const match = name.match(COMPACT_PRUNE_FILE);
    if (!match || (checkpointKey !== undefined && match[1] !== checkpointKey)) continue;
    guard.assertOwned(runDir(root, runId));
    const key = match[1];
    const tombstonePath = join(dir, name);
    const checkpointPath = join(dir, `${key}-compact.json`);
    const observationPath = join(dir, `${key}-compact-observation.json`);
    let capturedTombstone;
    let capturedCheckpoint;
    let capturedObservation;
    let payload;
    try {
      capturedTombstone = captureCompactPruneArtifact(tombstonePath);
      payload = validateCompactPruneBytes(capturedTombstone.bytes, { runId, key });
      capturedCheckpoint = captureCompactPruneArtifact(checkpointPath, { optional: true });
      if (capturedCheckpoint !== null) {
        const checkpointBytes = capturedCheckpoint.bytes;
        if (payload.checkpoint_sha256 === null
          || capturedCheckpoint.sha256 !== payload.checkpoint_sha256) {
          throw new Error('COMPACT_PRUNE_INVALID');
        }
        let checkpoint;
        try { checkpoint = JSON.parse(checkpointBytes.toString('utf8')); }
        catch { checkpoint = null; }
        if (checkpoint === null) {
          if (payload.context_sha256 !== null) throw new Error('COMPACT_PRUNE_INVALID');
        } else {
          let context;
          try { context = validateStrictSelf(checkpoint, { runId, key }); }
          catch {
            if (payload.context_sha256 !== null) throw new Error('COMPACT_PRUNE_INVALID');
            context = null;
          }
          if (context !== null && checkpoint.payload.context_sha256 !== payload.context_sha256) {
            throw new Error('COMPACT_PRUNE_INVALID');
          }
        }
      }
      capturedObservation = captureCompactPruneArtifact(observationPath, { optional: true });
      if (capturedObservation !== null) {
        if (payload.receipt_sha256 === null
          || capturedObservation.sha256 !== payload.receipt_sha256) {
          throw new Error('COMPACT_PRUNE_INVALID');
        }
      }
    } catch (error) {
      if (error?.message === 'COMPACT_PRUNE_INVALID') throw error;
      throw new Error('COMPACT_PRUNE_INVALID');
    }
    if (typeof faultAt === 'function') faultAt('prune:reconcile-validated');
    guard.renew();
    assertCompactPruneArtifactUnchanged(tombstonePath, capturedTombstone);
    assertCompactPruneArtifactUnchanged(checkpointPath, capturedCheckpoint);
    assertCompactPruneArtifactUnchanged(observationPath, capturedObservation);
    for (const [path, captured] of [
      [observationPath, capturedObservation],
      [checkpointPath, capturedCheckpoint],
      [tombstonePath, capturedTombstone],
    ]) {
      if (captured === null) continue;
      assertCompactPruneArtifactUnchanged(path, captured);
      rmSync(path, { force: true });
      flushDirectory(dir);
    }
    guard.renew();
    reconciled = true;
  }
  return reconciled;
}

const DIAGNOSTIC_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ORPHAN_ENTRY = /^\.orphan-([A-Za-z0-9][A-Za-z0-9._-]{0,127})-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const TRANSACTION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRANSACTION_OWNER_KEYS = ['protocol_version', 'token', 'pid', 'hostname', 'acquired_at_ms', 'heartbeat_at_ms', 'lock_identity'];
const VERIFIED_VECTOR_DEFAULTS = Object.freeze({
  maxEntries: 10_000,
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 128,
});

function exactObjectKeys(value, keys) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function canonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function canonicalHostname(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim().toLowerCase();
  return normalized && !/[\u0000-\u001f\u007f]/.test(normalized) ? normalized : null;
}

function canonicalRegularEntry(path) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    const canonical = (realpathSync.native || realpathSync)(path);
    const canonicalParent = (realpathSync.native || realpathSync)(dirname(path));
    return resolve(canonical) === resolve(join(canonicalParent, basename(path)));
  } catch (error) {
    if (isVerifiedReadError(error)) throw error;
    return false;
  }
}

function canonicalDirectoryEntry(path) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const canonical = (realpathSync.native || realpathSync)(path);
    const canonicalParent = (realpathSync.native || realpathSync)(dirname(path));
    return resolve(canonical) === resolve(join(canonicalParent, basename(path)));
  } catch (error) {
    if (isVerifiedReadError(error)) throw error;
    return false;
  }
}

function validTransactionOwner(path, runId, operationId, expectedToken = null, allowPrepared = false, readOptions = {}) {
  try {
    if (!canonicalDirectoryEntry(path)) return false;
    const children = readStableDirectoryNames(path, readOptions).names;
    const unpreparedChildren = JSON.stringify(children) === JSON.stringify(['owner.json'])
      || JSON.stringify(children) === JSON.stringify(['owner.json', 'stages']);
    const preparedChildren = children.includes('owner.json')
      && children.includes('stages')
      && children.includes('prepared.json')
      && children.every(name => ['owner.json', 'stages', 'prepared.json', 'markers', 'committed.json'].includes(name));
    if ((!allowPrepared && !unpreparedChildren) || (allowPrepared && !preparedChildren)) return false;
    if (!canonicalRegularEntry(join(path, 'owner.json'))) return false;
    if (children.includes('stages')) {
      if (!canonicalDirectoryEntry(join(path, 'stages'))) return false;
      const stageNames = readStableDirectoryNames(join(path, 'stages'), readOptions).names;
      if (stageNames.some(name => !/^\d{6}\.bin$/.test(name))) return false;
      if (stageNames.some(name => !canonicalRegularEntry(join(path, 'stages', name)))) return false;
    }
    if (allowPrepared && !canonicalRegularEntry(join(path, 'prepared.json'))) return false;
    if (children.includes('markers') && !canonicalDirectoryEntry(join(path, 'markers'))) return false;
    if (children.includes('committed.json') && !canonicalRegularEntry(join(path, 'committed.json'))) return false;
    const env = JSON.parse(readStableRegularFile(join(path, 'owner.json'), readOptions).bytes.toString('utf8'));
    const owner = env?.payload?.lock_owner;
    if (!unwrap(env, { producer: 'deep-loop', artifact_kind: 'transaction-owner' })
      || env.schema_version !== '1.0'
      || env.envelope?.schema?.version !== '1.0'
      || env.envelope?.run_id !== runId
      || !canonicalIsoTimestamp(env.envelope?.generated_at)
      || !exactObjectKeys(env.payload, ['operation_id', 'lock_owner', 'operation_dir_identity', 'created_at'])
      || env.payload.operation_id !== operationId
      || !canonicalIsoTimestamp(env.payload.created_at)
      || env.envelope.generated_at !== env.payload.created_at
      || !exactObjectKeys(owner, TRANSACTION_OWNER_KEYS)
      || owner.protocol_version !== 1
      || !TRANSACTION_UUID.test(owner.token || '')
      || (expectedToken !== null && owner.token !== expectedToken)
      || !Number.isSafeInteger(owner.pid) || owner.pid < 1
      || canonicalHostname(owner.hostname) !== owner.hostname
      || !Number.isSafeInteger(owner.acquired_at_ms) || owner.acquired_at_ms < 0
      || !Number.isSafeInteger(owner.heartbeat_at_ms) || owner.heartbeat_at_ms < owner.acquired_at_ms
      || !matchingStableFileIdentity(owner.lock_identity, owner.lock_identity)
      || !matchingStableFileIdentity(
        captureStableFileIdentity(path),
        env.payload.operation_dir_identity,
      )) return false;
    if (allowPrepared) {
      const prepared = JSON.parse(readStableRegularFile(join(path, 'prepared.json'), readOptions).bytes.toString('utf8'));
      return Boolean(
        unwrap(prepared, { producer: 'deep-loop', artifact_kind: 'anchored-publication' })
          && prepared.schema_version === '1.0'
          && prepared.envelope?.schema?.version === '1.0'
          && prepared.envelope?.run_id === runId
          && canonicalIsoTimestamp(prepared.envelope?.generated_at)
          && prepared.envelope.generated_at === env.payload.created_at
          && exactObjectKeys(prepared.payload, ['manifest', 'stages'])
          && Array.isArray(prepared.payload.stages)
          && prepared.payload.manifest?.operationId === operationId,
      );
    }
    return !children.includes('prepared.json');
  } catch (error) {
    if (isVerifiedReadError(error)) throw error;
    return false;
  }
}

// #3: every business-intent mutation is charged at least this many turns via appendAnchored's `opts.floor`
// (paired cost, same anchor). Lives here (with the floor mechanism) so both state.mjs and budget.mjs can import
// it without a state↔budget cycle; budget.mjs re-exports it for call sites/tests.
export const MUTATION_TURN_FLOOR = 1;

export function readLines(root, runId) {
  const p = logPath(root, runId);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function checksumFor(seq, ts, type, data, prev) {
  return contentHash(`${seq}|${ts}|${type}|${JSON.stringify(data)}|${prev}`);
}

function nextEvent(lines, { type, data, now }) {
  const prev = lines.length ? lines[lines.length - 1].checksum : 'GENESIS';
  const seq = lines.length + 1;
  const date = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('INVALID_NOW: event timestamp');
  const ts = date.toISOString();
  const checksum = checksumFor(seq, ts, type, data, prev);
  return { seq, ts, type, data, checksum };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function transactionError(message) {
  return new Error(`TRANSACTION_RECONCILIATION_REQUIRED: ${message}`);
}

function classifyGenericPublicationJournalLocked(root, runId, guard) {
  const base = runDir(root, runId);
  const transactions = join(base, 'transactions');
  guard.assertOwned(base);
  let stat;
  try {
    stat = lstatSync(transactions, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      guard.renew(base);
      return 'absent';
    }
    throw transactionError('generic publication journal unreadable');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw transactionError('generic publication journal path');
  }
  const before = captureStableFileIdentity(transactions, { lstatFn: () => stat });
  let canonicalBase;
  let canonicalTransactions;
  let entries;
  let after;
  try {
    canonicalBase = (realpathSync.native || realpathSync)(base);
    canonicalTransactions = (realpathSync.native || realpathSync)(transactions);
    entries = readdirSync(transactions);
    after = captureStableFileIdentity(transactions);
  } catch {
    throw transactionError('generic publication journal unreadable');
  }
  guard.renew(base);
  if (resolve(canonicalTransactions) !== resolve(join(canonicalBase, 'transactions'))
    || !matchingStableFileIdentity(before, after)) {
    throw transactionError('generic publication journal identity');
  }
  return entries.length === 0 ? 'empty' : 'unresolved';
}

function assertNoUnresolvedGenericPublicationLocked(root, runId, guard) {
  if (classifyGenericPublicationJournalLocked(root, runId, guard) === 'unresolved') {
    throw transactionError('generic publication pending during compact restore');
  }
}

const VERIFIED_READ_REASON = Object.freeze({
  IDENTITY_DRIFT: 'identity-drift',
  BOUND_EXCEEDED: 'bound-exceeded',
  DEADLINE_EXCEEDED: 'deadline-exceeded',
});
const TRANSIENT_LOCK_RELEASE = /^\.lock\.release-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function inferVerifiedReadReason(message) {
  const text = String(message || '');
  if (text === 'verified vector deadline'
    || text === 'verified capture deadline'
    || /^read deadline /.test(text)
    || /^directory deadline /.test(text)) {
    return VERIFIED_READ_REASON.DEADLINE_EXCEEDED;
  }
  if (text === 'verified vector relative byte limits'
    || text === 'verified vector bound'
    || text === 'verified vector bytes'
    || text === 'verified vector depth'
    || /^read bound /.test(text)
    || /^directory bound /.test(text)) {
    return VERIFIED_READ_REASON.BOUND_EXCEEDED;
  }
  return null;
}

function integrityInvalidError(message, reason = inferVerifiedReadReason(message)) {
  const error = new Error(`VERIFIED_READ_INTEGRITY_INVALID: ${message}`);
  error.code = 'VERIFIED_READ_INTEGRITY_INVALID';
  if (reason !== null) error.verified_read_reason = reason;
  return error;
}

function isVerifiedReadError(error) {
  return error?.code === 'VERIFIED_READ_INTEGRITY_INVALID';
}

function rethrowVerifiedReadError(error, fallbackMessage) {
  if (isVerifiedReadError(error)) throw error;
  throw integrityInvalidError(fallbackMessage);
}

function verifiedReadFailureDescriptor(error, phase = 'verified-vector') {
  let reason = error?.verified_read_reason || null;
  if (error?.message === 'LOCK_DEADLINE_EXCEEDED') reason = VERIFIED_READ_REASON.DEADLINE_EXCEEDED;
  if (reason === VERIFIED_READ_REASON.IDENTITY_DRIFT) {
    return {
      ok: false,
      kind: 'verified-read-race',
      reason,
      retryable: true,
      operation_id: null,
      phase,
    };
  }
  if (reason === VERIFIED_READ_REASON.BOUND_EXCEEDED) {
    return {
      ok: false,
      kind: 'verified-read-bound-exceeded',
      reason,
      retryable: false,
      operation_id: null,
      phase,
    };
  }
  if (reason === VERIFIED_READ_REASON.DEADLINE_EXCEEDED) {
    return {
      ok: false,
      kind: 'verified-read-deadline-exceeded',
      reason,
      retryable: false,
      operation_id: null,
      phase,
    };
  }
  return {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: null,
    phase,
  };
}

function readStableRegularFile(path, options = {}) {
  const maxBytes = options.maxBytes === undefined ? VERIFIED_VECTOR_DEFAULTS.maxBytes : options.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw integrityInvalidError(`read bound ${path}`);
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
  const checkDeadline = () => {
    if (options.deadlineAtMs === undefined) return;
    const current = nowFn();
    const now = current instanceof Date ? current.getTime() : Number(current);
    if (!Number.isFinite(now) || now >= Number(options.deadlineAtMs)) {
      throw integrityInvalidError(`read deadline ${path}`);
    }
  };
  let stat;
  try {
    checkDeadline();
    stat = lstatSync(path, { bigint: true });
  } catch (error) { rethrowVerifiedReadError(error, `read ${path}`); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw integrityInvalidError(`file type ${path}`);
  const initialIdentity = captureStableFileIdentity(path, { lstatFn: () => stat });
  const declaredSize = Number(stat.size);
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maxBytes) {
    throw integrityInvalidError(`read bound ${path}`);
  }
  let before;
  let bytes;
  let after;
  try {
    checkDeadline();
    before = captureStableFileIdentity(path);
    bytes = readFileSync(path);
    checkDeadline();
    after = captureStableFileIdentity(path);
  } catch (error) { rethrowVerifiedReadError(error, `file read ${path}`); }
  const identityDrift = !matchingStableFileIdentity(initialIdentity, before)
    || !matchingStableFileIdentity(before, after);
  if (identityDrift) {
    throw integrityInvalidError(`file identity drift ${path}`, VERIFIED_READ_REASON.IDENTITY_DRIFT);
  }
  if (bytes.length !== declaredSize) {
    throw integrityInvalidError(`file size drift ${path}`);
  }
  return { bytes, before, after };
}

function readStableDirectoryNames(path, options = {}) {
  const maxEntries = options.maxEntries === undefined ? VERIFIED_VECTOR_DEFAULTS.maxEntries : options.maxEntries;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw integrityInvalidError(`directory bound ${path}`);
  }
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
  const deadlineAtMs = options.deadlineAtMs;
  const identityFn = typeof options.identityFn === 'function'
    ? options.identityFn
    : target => captureStableFileIdentity(target);
  const lstatFn = typeof options.lstatFn === 'function' ? options.lstatFn : lstatSync;
  const openDirFn = typeof options.opendirFn === 'function' ? options.opendirFn : opendirSync;
  const excludedNames = options.excludedNames instanceof Set ? options.excludedNames : null;
  const excludedNamePredicate = typeof options.excludedNamePredicate === 'function'
    ? options.excludedNamePredicate
    : null;
  const expectedIdentity = options.expectedIdentity;
  const checkDeadline = () => {
    if (deadlineAtMs === undefined) return;
    const current = nowFn();
    const now = current instanceof Date ? current.getTime() : Number(current);
    if (!Number.isFinite(now) || now >= Number(deadlineAtMs)) {
      throw integrityInvalidError(`directory deadline ${path}`);
    }
  };
  let before;
  let names;
  let after;
  let directory;
  try {
    checkDeadline();
    const stat = lstatFn(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw integrityInvalidError(`directory type ${path}`);
    }
    const initialIdentity = captureStableFileIdentity(path, { lstatFn: () => stat });
    before = identityFn(path);
    if (!matchingStableFileIdentity(initialIdentity, before)
      || (expectedIdentity && !matchingStableFileIdentity(expectedIdentity, before))) {
      throw integrityInvalidError(`directory identity drift ${path}`, VERIFIED_READ_REASON.IDENTITY_DRIFT);
    }
    directory = openDirFn(path);
    names = [];
    while (true) {
      checkDeadline();
      const entry = directory.readSync();
      if (entry === null) break;
      if (excludedNames?.has(entry.name) || excludedNamePredicate?.(entry.name) === true) continue;
      if (names.length >= maxEntries) throw integrityInvalidError(`directory bound ${path}`);
      names.push(entry.name);
    }
    names.sort();
    checkDeadline();
    after = identityFn(path);
  } catch (error) { rethrowVerifiedReadError(error, `directory read ${path}`); }
  finally {
    try { directory?.closeSync(); } catch { /* inspection will fail on identity/read evidence, not cleanup */ }
  }
  if (!matchingStableFileIdentity(before, after)) {
    throw integrityInvalidError(`directory identity drift ${path}`, VERIFIED_READ_REASON.IDENTITY_DRIFT);
  }
  return { names, before, after };
}

function diagnosticOperationId(value) {
  return typeof value === 'string' && DIAGNOSTIC_OPERATION_ID.test(value) ? value : null;
}

function readDeadlineAtMs(options = {}) {
  const vectorOptions = options.vectorOptions || {};
  const explicit = options.vectorDeadlineAtMs
    ?? options.deadlineAtMs
    ?? options.deadlineAt
    ?? vectorOptions.deadlineAtMs
    ?? vectorOptions.deadlineMs;
  if (explicit !== undefined) return explicit;
  const budget = options.deadlineBudgetMs ?? vectorOptions.deadlineBudgetMs;
  if (budget === undefined) return undefined;
  const nowFn = typeof options.nowFn === 'function'
    ? options.nowFn
    : typeof vectorOptions.nowFn === 'function' ? vectorOptions.nowFn : () => Date.now();
  const current = nowFn();
  const now = current instanceof Date ? current.getTime() : Number(current);
  if (!Number.isFinite(now) || !Number.isSafeInteger(budget) || budget < 0) {
    throw integrityInvalidError('verified vector deadline');
  }
  return now + budget;
}

function exactLogBytes(lines) {
  return Buffer.from(lines.map(line => `${JSON.stringify(line)}\n`).join(''));
}

function parseExactLogBytes(bytes, { reconciliation = false } = {}) {
  const fail = message => {
    if (reconciliation) throw transactionError(message);
    throw new Error(`LOG_TAMPERED: ${message}`);
  };
  const raw = Buffer.from(bytes);
  if (raw.length === 0) return { lines: [], lineBytes: [] };
  if (raw.at(-1) !== 0x0a) fail('partial event-log line');
  const lineBytes = [];
  let start = 0;
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== 0x0a) continue;
    const line = Buffer.from(raw.subarray(start, index + 1));
    if (line.length === 1) fail('blank event-log line');
    lineBytes.push(line);
    start = index + 1;
  }
  let lines;
  try { lines = lineBytes.map(line => JSON.parse(line.subarray(0, -1).toString('utf8'))); }
  catch { fail('event-log parse'); }
  const checked = verifyLines(lines);
  if (!checked.ok) fail(`event-log chain: ${checked.errors.join('; ')}`);
  return { lines, lineBytes };
}

function readRawRun(root, runId) {
  const dir = runDir(root, runId);
  const loopBytes = readStableRegularFile(join(dir, 'loop.json')).bytes;
  const hashPath = join(dir, '.loop.hash');
  const logPathForRun = join(dir, 'event-log.jsonl');
  const hashBytes = existsSync(hashPath) ? readStableRegularFile(hashPath).bytes : null;
  const logBytes = existsSync(logPathForRun)
    ? readStableRegularFile(logPathForRun).bytes
    : Buffer.alloc(0);
  return { dir, loopBytes, hashBytes, logBytes };
}

function snapshotRaw(root, runId, raw, { requireSchema = true, requireProjectBinding = true } = {}) {
  const parsed = parseHashVerifiedStateBytes(root, runId, raw.loopBytes, raw.hashBytes, {
    requireSchema,
    requireProjectBinding,
  });
  const { lines: logLines } = parseExactLogBytes(raw.logBytes);
  const head = verifyHeadLines(logLines, parsed.data.event_log_head);
  if (!head.ok) throw new Error(`LOG_TAMPERED: ${head.errors.join('; ')}`);
  return {
    data: structuredClone(parsed.data),
    hash: parsed.hash,
    loopBytes: Buffer.from(raw.loopBytes),
    hashBytes: Buffer.from(raw.hashBytes),
    logBytes: Buffer.from(raw.logBytes),
    logLines: structuredClone(logLines),
  };
}

function captureArtifactLocked(root, runId, rel) {
  if (normalizePortableRelativePath(rel) !== rel) throw new Error(`ARTIFACT_REL_INVALID: ${String(rel)}`);
  const base = runDir(root, runId);
  let canonicalBase;
  try { canonicalBase = (realpathSync.native || realpathSync)(base); }
  catch { throw integrityInvalidError(`ARTIFACT_REL_INVALID: artifact base ${rel}`); }
  const parts = rel.split('/');
  let current = base;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let stat;
    try { stat = lstatSync(current, { bigint: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ state: 'absent' });
      throw integrityInvalidError(`ARTIFACT_REL_INVALID: artifact entry ${rel}`);
    }
    if (stat.isSymbolicLink()) throw integrityInvalidError(`ARTIFACT_REL_INVALID: symlink ${rel}`);
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) throw integrityInvalidError(`ARTIFACT_REL_INVALID: parent ${rel}`);
      let canonical;
      try { canonical = (realpathSync.native || realpathSync)(current); }
      catch { throw integrityInvalidError(`ARTIFACT_REL_INVALID: parent ${rel}`); }
      const expected = join(canonicalBase, ...parts.slice(0, index + 1));
      if (resolve(canonical) !== resolve(expected)) throw integrityInvalidError(`ARTIFACT_REL_INVALID: alias ${rel}`);
      continue;
    }
    if (!stat.isFile()) throw integrityInvalidError(`ARTIFACT_REL_INVALID: target ${rel}`);
    let bytes;
    try { ({ bytes } = readStableRegularFile(current)); }
    catch (error) { rethrowVerifiedReadError(error, `ARTIFACT_REL_INVALID: read ${rel}`); }
    return Object.freeze({ state: 'present', bytes: Buffer.from(bytes), sha256: contentHash(bytes) });
  }
  throw new Error(`ARTIFACT_REL_INVALID: ${rel}`);
}

function captureArtifactsLocked(root, runId, artifactRels = []) {
  if (!Array.isArray(artifactRels) || new Set(artifactRels).size !== artifactRels.length) {
    throw new Error('ARTIFACT_REL_INVALID: fixed unique list required');
  }
  const artifacts = Object.create(null);
  for (const rel of artifactRels) artifacts[rel] = captureArtifactLocked(root, runId, rel);
  return artifacts;
}

function operationTimestamp(now) {
  const date = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('INVALID_NOW: event timestamp');
  return date.toISOString();
}

function materializePublication(publication) {
  if (!publication || typeof publication !== 'object' || Array.isArray(publication)) {
    throw new Error('TRANSACTION_INVALID: publication shape');
  }
  const allowed = new Set([
    'kind', 'operationId', 'artifacts', 'topology', 'faultAt', 'forceUnlinkReplacement',
    'durableWriteFn', 'nowFn', 'artifactFactory',
  ]);
  if (Object.keys(publication).some(key => !allowed.has(key))
    || typeof publication.kind !== 'string' || publication.kind.length === 0
    || typeof publication.operationId !== 'string' || publication.operationId.length === 0
    || (!Array.isArray(publication.artifacts) && typeof publication.artifactFactory !== 'function')
    || !publication.topology || typeof publication.topology !== 'object' || Array.isArray(publication.topology)) {
    throw new Error('TRANSACTION_INVALID: publication shape');
  }
  const materializeArtifacts = input => input.map((artifact, index) => {
    if (!artifact || typeof artifact !== 'object'
      || JSON.stringify(Object.keys(artifact)) !== JSON.stringify(['rel', 'bytes'])
      || normalizePortableRelativePath(artifact.rel) !== artifact.rel
      || !Buffer.isBuffer(artifact.bytes)) {
      throw new Error(`TRANSACTION_INVALID: publication artifact ${index}`);
    }
    return Object.freeze({ rel: artifact.rel, bytes: Buffer.from(artifact.bytes) });
  });
  const artifacts = Array.isArray(publication.artifacts)
    ? materializeArtifacts(publication.artifacts)
    : [];
  return Object.freeze({
    kind: publication.kind,
    operationId: publication.operationId,
    artifacts: Object.freeze(artifacts),
    artifactFactory: typeof publication.artifactFactory === 'function'
      ? context => Object.freeze(materializeArtifacts(publication.artifactFactory(context)))
      : null,
    topology: deepFreeze(structuredClone(publication.topology)),
    faultAt: typeof publication.faultAt === 'function' ? publication.faultAt : () => {},
    forceUnlinkReplacement: publication.forceUnlinkReplacement === true,
    durableWriteFn: publication.durableWriteFn || durableAtomicWrite,
    nowFn: publication.nowFn,
  });
}

function committedRetryResult(prepared, publication, eventInput, floor, now) {
  const manifest = prepared.manifest;
  const artifactMatch = manifest.targets.length === publication.artifacts.length
    && manifest.targets.every((target, index) => target.rel === publication.artifacts[index].rel
      && target.candidate_sha256 === contentHash(publication.artifacts[index].bytes)
      && target.candidate_size === String(publication.artifacts[index].bytes.length));
  const eventCount = floor ? 2 : 1;
  let event;
  try {
    const descriptor = manifest.eventLines[0];
    const bytes = prepared.readStage(descriptor.stage_index).toString('utf8');
    event = JSON.parse(bytes.slice(0, -1));
  } catch {
    throw transactionError('committed retry event');
  }
  if (manifest.kind !== publication.kind
    || JSON.stringify(manifest.topology) !== JSON.stringify(publication.topology)
    || !artifactMatch
    || manifest.eventLines.length !== eventCount
    || event.type !== eventInput.type
    || JSON.stringify(event.data) !== JSON.stringify(eventInput.data)
    || (now !== undefined && event.ts !== operationTimestamp(now))) {
    throw transactionError('committed retry mismatch');
  }
  if (floor) {
    let cost;
    try {
      const descriptor = manifest.eventLines[1];
      const bytes = prepared.readStage(descriptor.stage_index).toString('utf8');
      cost = JSON.parse(bytes.slice(0, -1));
    } catch { throw transactionError('committed retry floor'); }
    if (cost.type !== 'cost' || cost.data?.turns !== floor || cost.data?.tokens !== 0
      || cost.data?.auto_floor !== true || cost.data?.for !== eventInput.type
      || cost.data?.owner !== manifest.expect.owner
      || cost.data?.generation !== manifest.expect.generation) {
      throw transactionError('committed retry floor');
    }
  }
  return {
    ok: true,
    event_identity: { seq: event.seq, checksum: event.checksum },
    operation_id: publication.operationId,
  };
}

function stableArtifactPredecessor(rootDir, rel) {
  const normalized = normalizePortableRelativePath(rel);
  if (!normalized) throw new Error('TRANSACTION_INVALID: artifact target');
  const parts = normalized.split('/');
  let current = rootDir;
  for (let index = 0; index < parts.length - 1; index++) {
    current = join(current, parts[index]);
    if (!existsSync(current)) return { kind: 'absent' };
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw transactionError('artifact parent type');
    const canonical = (realpathSync.native || realpathSync)(current);
    if (resolve(canonical) !== resolve(current)) throw transactionError('artifact parent substitution');
  }
  const target = join(rootDir, ...parts);
  if (!existsSync(target)) return { kind: 'absent' };
  const before = captureStableFileIdentity(target);
  const stat = lstatSync(target, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) throw transactionError('artifact target type');
  const bytes = readFileSync(target);
  const after = captureStableFileIdentity(target);
  if (!matchingStableFileIdentity(before, after)) throw transactionError('artifact predecessor identity drift');
  return {
    kind: 'present',
    sha256: contentHash(bytes),
    identity: before,
    size: String(bytes.length),
  };
}

function exactBoundaryIdentity(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['checksum', 'seq'])
    && Number.isSafeInteger(value.seq)
    && value.seq > 0
    && /^[0-9a-f]{64}$/.test(value.checksum || '');
}

function sameBoundaryIdentity(left, right) {
  return exactBoundaryIdentity(left)
    && exactBoundaryIdentity(right)
    && left.seq === right.seq
    && left.checksum === right.checksum;
}

function validateBoundaryPublication(prepared, candidate) {
  const manifest = prepared.manifest;
  if (manifest.kind !== 'workstream-boundary-handoff') return;
  const topology = manifest.topology;
  const topologyKeys = [
    'boundary_event', 'child_run_id', 'handoff_rel', 'parent_run_id',
    'phase', 'project_binding_generation', 'project_root_digest',
  ];
  if (!topology || typeof topology !== 'object' || Array.isArray(topology)
    || JSON.stringify(Object.keys(topology).sort()) !== JSON.stringify(topologyKeys)
    || topology.parent_run_id !== manifest.expect.owner
    || typeof topology.child_run_id !== 'string' || topology.child_run_id.length === 0
    || topology.phase !== 'emitted'
    || topology.project_binding_generation !== candidate.project?.binding_generation
    || topology.project_root_digest !== projectRootDigest(candidate.project?.root)
    || !sameBoundaryIdentity(topology.boundary_event, topology.boundary_event)) {
    throw transactionError('boundary publication topology');
  }
  const lease = candidate.session_chain?.lease || {};
  const child = (candidate.session_chain?.sessions || [])
    .find(session => session.run_id === topology.child_run_id);
  const parent = (candidate.session_chain?.sessions || [])
    .find(session => session.run_id === topology.parent_run_id);
  const workstream = parent && (candidate.workstreams || [])
    .find(item => item.id === parent.scope?.workstream_id);
  if (lease.takeover_kind !== 'boundary-handoff'
    || lease.handoff_phase !== 'emitted'
    || lease.handoff_idempotency_key !== manifest.operationId
    || lease.handoff_child_run_id !== topology.child_run_id
    || !sameBoundaryIdentity(lease.handoff_boundary_event, topology.boundary_event)
    || lease.handoff_project_binding_generation !== topology.project_binding_generation
    || lease.handoff_project_root_digest !== topology.project_root_digest
    || !child
    || child.parent_run_id !== topology.parent_run_id
    || child.handoff_rel !== topology.handoff_rel
    || child.project_binding_generation !== topology.project_binding_generation
    || child.project_root_digest !== topology.project_root_digest
    || !sameBoundaryIdentity(child.parent_boundary_event, topology.boundary_event)
    || child.scope?.kind !== 'workstream'
    || child.scope.workstream_id !== null
    || child.scope.terminal_event !== null
    || !parent
    || parent.superseded_by !== topology.child_run_id
    || parent.scope?.kind !== 'workstream'
    || parent.scope.closed_at == null
    || parent.scope.superseded_at == null
    || !sameBoundaryIdentity(parent.scope.terminal_event, topology.boundary_event)
    || !workstream
    || !(workstream.terminal_events || [])
      .some(event => sameBoundaryIdentity(event, topology.boundary_event))) {
    throw transactionError('boundary publication candidate topology');
  }
  const expectedTargets = [
    topology.handoff_rel,
    `handoffs/${topology.child_run_id}-compaction-state.json`,
    'terminal/launch-command.txt',
    'terminal/launch-command.meta.json',
  ];
  if (manifest.targets.length !== expectedTargets.length
    || manifest.targets.some((target, index) => target.rel !== expectedTargets[index])) {
    throw transactionError('boundary publication targets');
  }
  let launchBytes;
  let meta;
  try {
    launchBytes = prepared.readStage(manifest.targets[2].stage_index);
    meta = JSON.parse(prepared.readStage(manifest.targets[3].stage_index).toString('utf8'));
  } catch {
    throw transactionError('boundary publication metadata');
  }
  if (!validateLaunchCommandMetadata(meta, {
    launchBytes,
    parentRunId: topology.parent_run_id,
    childRunId: topology.child_run_id,
    handoffRel: topology.handoff_rel,
    projectRootDigest: topology.project_root_digest,
    projectBindingGeneration: topology.project_binding_generation,
    boundaryEvent: topology.boundary_event,
    generatedAt: parent.scope.superseded_at,
  })) {
    throw transactionError('boundary publication metadata');
  }
}

function validatePreparedAuthority(root, runId, prepared, candidate, candidateBytes, candidateHashBytes, {
  rootRecovery = false,
} = {}) {
  const manifest = prepared.manifest;
  const projectAuthorityMatches = rootRecovery
    ? projectRootDigest(manifest.projectRoot) === projectRootDigest(candidate.project?.root)
    : manifest.projectRoot === canonicalProjectRoot(root);
  if (!projectAuthorityMatches
    || candidate.run_id !== runId
    || candidate.autonomy?.session_runtime !== manifest.runtime
    || contentHash(candidateBytes) !== manifest.candidateLoopHash
    || candidateHashBytes.toString('utf8').trim() !== manifest.candidateLoopHash) {
    throw transactionError('prepared candidate authority');
  }
  const lease = candidate.session_chain?.lease;
  const expectedCandidateOwner = rootRecovery
    ? manifest.topology?.new_lease_owner ?? manifest.expect.owner
    : manifest.expect.owner;
  const expectedCandidateGeneration = rootRecovery
    ? manifest.topology?.new_lease_generation ?? manifest.expect.generation
    : manifest.expect.generation;
  if (!lease || lease.owner_run_id !== expectedCandidateOwner || lease.generation !== expectedCandidateGeneration) {
    throw transactionError('prepared fence authority');
  }
  validateBoundaryPublication(prepared, candidate);
}

function classifyPreparedRun(root, runId, guard, prepared, { rootRecovery = false } = {}) {
  const manifest = prepared.manifest;
  const loopStage = prepared.stages.find(stage => stage.role === 'candidate-loop');
  const hashStage = prepared.stages.find(stage => stage.role === 'candidate-loop-hash');
  if (!loopStage || !hashStage) throw transactionError('candidate stages');
  const candidateBytes = prepared.readStage(loopStage.index);
  const candidateHashBytes = prepared.readStage(hashStage.index);
  let candidate;
  try {
    candidate = parseHashVerifiedStateBytes(root, runId, candidateBytes, candidateHashBytes, {
      requireSchema: true,
      requireProjectBinding: !rootRecovery,
    }).data;
  } catch (error) {
    throw transactionError(`candidate state: ${error?.message || error}`);
  }
  validatePreparedAuthority(root, runId, prepared, candidate, candidateBytes, candidateHashBytes, { rootRecovery });

  const stagedEvents = [];
  let expectedHead = manifest.preEventHead;
  for (let index = 0; index < manifest.eventLines.length; index++) {
    const descriptor = manifest.eventLines[index];
    const bytes = prepared.readStage(descriptor.stage_index);
    let event;
    try {
      if (!bytes.toString('utf8').endsWith('\n')) throw new Error('newline');
      event = JSON.parse(bytes.toString('utf8').slice(0, -1));
    } catch { throw transactionError(`event stage ${index}`); }
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || JSON.stringify(Object.keys(event)) !== JSON.stringify(['seq', 'ts', 'type', 'data', 'checksum'])
      || operationTimestamp(event.ts) !== event.ts) {
      throw transactionError(`event shape ${index}`);
    }
    const expected = nextEvent([], { type: event.type, data: event.data, now: event.ts });
    const checksum = checksumFor(event.seq, event.ts, event.type, event.data, expectedHead.checksum);
    if (event.seq !== expectedHead.seq + 1 || event.seq !== descriptor.seq
      || event.checksum !== checksum || event.checksum !== descriptor.checksum
      || contentHash(bytes) !== descriptor.sha256 || String(bytes.length) !== descriptor.size
      || expected.type !== event.type || expected.data === undefined) {
      throw transactionError(`event stage binding ${index}`);
    }
    stagedEvents.push({ event, bytes });
    expectedHead = { seq: event.seq, checksum: event.checksum };
  }
  if (candidate.event_log_head?.seq !== expectedHead.seq
    || candidate.event_log_head?.checksum !== expectedHead.checksum) {
    throw transactionError('candidate event head');
  }
  const costTotal = stagedEvents.reduce((acc, item) => {
    if (item.event.type !== 'cost') return acc;
    if (!validCost(item.event.data)) throw transactionError('candidate cost event');
    return { turns: acc.turns + item.event.data.turns, tokens: acc.tokens + item.event.data.tokens };
  }, { turns: 0, tokens: 0 });

  const raw = readRawRun(root, runId);
  const currentLoopHash = contentHash(raw.loopBytes);
  const storedHash = raw.hashBytes?.toString('utf8');
  const loopState = currentLoopHash === manifest.preLoopHash
    ? 'predecessor'
    : currentLoopHash === manifest.candidateLoopHash ? 'candidate' : 'conflict';
  const hashState = storedHash === manifest.preLoopHash
    ? 'predecessor'
    : storedHash === manifest.candidateLoopHash ? 'candidate' : 'conflict';
  if (loopState === 'conflict' || hashState === 'conflict'
    || (loopState === 'predecessor' && hashState === 'candidate')) {
    throw transactionError('state/hash publication order');
  }
  if (loopState === 'predecessor' && hashState === 'predecessor') {
    let predecessor;
    try {
      predecessor = parseHashVerifiedStateBytes(root, runId, raw.loopBytes, raw.hashBytes, {
        requireSchema: true,
        requireProjectBinding: !rootRecovery,
      }).data;
    } catch (error) {
      throw transactionError(`predecessor state: ${error?.message || error}`);
    }
    const lease = predecessor.session_chain?.lease;
    if (predecessor.autonomy?.session_runtime !== manifest.runtime
      || !lease || lease.owner_run_id !== manifest.expect.owner
      || lease.generation !== manifest.expect.generation) {
      throw transactionError('predecessor authority');
    }
  }

  const currentLog = parseExactLogBytes(raw.logBytes, { reconciliation: true });
  const currentLines = currentLog.lines;
  const preSeq = manifest.preEventHead?.seq;
  if (!Number.isSafeInteger(preSeq) || preSeq < 0 || currentLines.length < preSeq
    || currentLines.length > preSeq + stagedEvents.length
    || JSON.stringify(headOfLines(currentLines.slice(0, preSeq))) !== JSON.stringify(manifest.preEventHead)) {
    throw transactionError('event predecessor');
  }
  const appendedCount = currentLines.length - preSeq;
  for (let index = 0; index < appendedCount; index++) {
    const observedBytes = currentLog.lineBytes[preSeq + index];
    const descriptor = manifest.eventLines[index];
    if (String(observedBytes.length) !== descriptor.size
      || contentHash(observedBytes) !== descriptor.sha256
      || !observedBytes.equals(stagedEvents[index].bytes)) {
      throw transactionError('event publication prefix');
    }
  }
  const predecessorCosts = currentLines.slice(0, preSeq).reduce((acc, item) => {
    if (item.type !== 'cost') return acc;
    return { turns: acc.turns + item.data.turns, tokens: acc.tokens + item.data.tokens };
  }, { turns: 0, tokens: 0 });
  if (candidate.budget?.spent !== predecessorCosts.turns + costTotal.turns
    || candidate.budget?.tokens_spent !== predecessorCosts.tokens + costTotal.tokens) {
    throw transactionError('candidate accounting');
  }

  const artifactVector = classifyArtifactTargetsLocked(raw.dir, guard, manifest);
  const artifactsComplete = artifactVector.classifications.every(item => item.state === 'candidate' && item.targetDone);
  const eventsComplete = appendedCount === stagedEvents.length;
  const stateComplete = loopState === 'candidate' && hashState === 'candidate';
  const committed = publicationCommittedLocked(raw.dir, guard, prepared);
  if ((appendedCount > 0 && !artifactsComplete)
    || (loopState === 'candidate' && !eventsComplete)
    || (hashState === 'candidate' && loopState !== 'candidate')
    || (committed && (!artifactsComplete || !eventsComplete || !stateComplete))) {
    throw transactionError('cross-resource publication order');
  }
  return {
    raw,
    manifest,
    candidateBytes,
    candidateHashBytes,
    stagedEvents,
    appendedCount,
    loopState,
    hashState,
    classifications: artifactVector.classifications,
    committed,
  };
}

function committedMarkerInspection(prepared) {
  const path = join(prepared.operationDir, 'committed.json');
  if (!existsSync(path)) return { present: false, valid: false };
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) return { present: true, valid: false };
    const expected = JSON.stringify({
      kind: 'committed',
      operation_id: prepared.manifest.operationId,
      candidate_loop_hash: prepared.manifest.candidateLoopHash,
    });
    return { present: true, valid: readStableRegularFile(path).bytes.toString('utf8') === expected };
  } catch (error) {
    if (isVerifiedReadError(error)) throw error;
    return { present: true, valid: false };
  }
}

// Shared read-only publication classifier.  The input is intentionally an
// in-memory inspection record; it contains no writer, replay, or retirement
// capability and emits only bounded operation/phase diagnostics.
export function inspectAnchoredPublication({
  operationId = null,
  marker = { present: false, valid: false },
  classified = null,
  error = null,
} = {}) {
  const boundedOperationId = diagnosticOperationId(operationId);
  if (marker.present && !marker.valid) {
    return { ok: false, kind: 'integrity-invalid', operation_id: boundedOperationId, phase: 'committed' };
  }
  if (error) {
    const message = String(error?.message || error);
    if (marker.present && marker.valid && message.includes('cross-resource publication order')) {
      return { ok: false, kind: 'reconciliation-required', operation_id: boundedOperationId, phase: 'premature-committed' };
    }
    return {
      ok: false,
      kind: marker.present && marker.valid ? 'integrity-invalid' : 'integrity-invalid',
      operation_id: boundedOperationId,
      phase: marker.present ? 'committed' : 'prepared',
    };
  }
  if (!classified) {
    return { ok: false, kind: 'reconciliation-required', operation_id: boundedOperationId, phase: 'uncommitted' };
  }
  if (classified.committed) {
    return { ok: true, kind: 'clean-committed', operation_id: boundedOperationId, phase: 'committed' };
  }
  const artifactProgress = classified.classifications
    .some(item => item.targetDone || item.replaceIntent || item.state === 'candidate');
  const partial = artifactProgress || classified.appendedCount > 0
    || classified.loopState === 'candidate' || classified.hashState === 'candidate';
  return {
    ok: false,
    kind: 'reconciliation-required',
    operation_id: boundedOperationId,
    phase: partial ? 'partial' : 'prepared',
  };
}

function captureVerifiedDurableVectorLocked(dir, runId, options = {}, sharedDeadlineAtMs) {
  const limits = { ...VERIFIED_VECTOR_DEFAULTS, ...options };
  const integerLimit = (name, fallback) => Number.isSafeInteger(limits[name]) && limits[name] >= 0
    ? limits[name] : fallback;
  const maxEntries = integerLimit('maxEntries', VERIFIED_VECTOR_DEFAULTS.maxEntries);
  const maxBytes = integerLimit('maxBytes', VERIFIED_VECTOR_DEFAULTS.maxBytes);
  const maxDepth = integerLimit('maxDepth', VERIFIED_VECTOR_DEFAULTS.maxDepth);
  const maxBytesByRel = new Map();
  if (limits.maxBytesByRel !== undefined) {
    if (limits.maxBytesByRel === null
      || typeof limits.maxBytesByRel !== 'object'
      || Array.isArray(limits.maxBytesByRel)) {
      throw integrityInvalidError('verified vector relative byte limits');
    }
    for (const [rel, value] of Object.entries(limits.maxBytesByRel)) {
      if (normalizePortableRelativePath(rel) !== rel
        || !Number.isSafeInteger(value)
        || value < 0) {
        throw integrityInvalidError('verified vector relative byte limits');
      }
      maxBytesByRel.set(rel, value);
    }
  }
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
  const lstatFn = typeof options.lstatFn === 'function' ? options.lstatFn : lstatSync;
  const opendirFn = typeof options.opendirFn === 'function' ? options.opendirFn : opendirSync;
  const readFileFn = typeof options.readFileFn === 'function' ? options.readFileFn : readFileSync;
  const identityFn = typeof options.identityFn === 'function'
    ? options.identityFn
    : path => captureStableFileIdentity(path, { lstatFn });
  const deadlineAtMs = sharedDeadlineAtMs ?? options.deadlineAtMs ?? options.deadlineMs;
  if (deadlineAtMs !== undefined && !Number.isFinite(Number(deadlineAtMs))) {
    throw integrityInvalidError('verified vector deadline');
  }
  const entries = [];
  const present = new Set();
  const portableKeys = new Set();
  const expectedRoots = ['transactions', 'artifacts', 'episodes', 'checkpoints', 'loop.json', '.loop.hash', 'event-log.jsonl'];
  let totalBytes = 0;

  const now = () => {
    const value = nowFn();
    const numeric = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(numeric)) throw integrityInvalidError('verified vector clock');
    return numeric;
  };
  const checkDeadline = () => {
    if (deadlineAtMs !== undefined && now() >= deadlineAtMs) {
      throw integrityInvalidError('verified vector deadline');
    }
  };
  const addEntry = (entry, depth) => {
    checkDeadline();
    if (depth > maxDepth || entries.length >= maxEntries) {
      throw integrityInvalidError('verified vector bound');
    }
    entries.push(entry);
  };
  const statAt = path => {
    checkDeadline();
    try { return lstatFn(path, { bigint: true }); }
    catch (error) { rethrowVerifiedReadError(error, `verified vector entry ${path}`); }
  };
  const readNames = (path, expectedIdentity) => readStableDirectoryNames(path, {
    maxEntries: Math.max(0, maxEntries - entries.length),
    deadlineAtMs,
    nowFn,
    identityFn,
    lstatFn,
    opendirFn,
    excludedNames: path === dir ? new Set(['.lock']) : null,
    excludedNamePredicate: path === dir ? name => TRANSIENT_LOCK_RELEASE.test(name) : null,
    expectedIdentity,
  }).names;

  const rootStat = statAt(dir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw integrityInvalidError('verified vector run directory');
  }
  const rootIdentity = captureStableFileIdentity(dir, { lstatFn: () => rootStat });
  addEntry(Object.freeze([runId, '', 'directory', deepFreeze({ identity: rootIdentity })]), 0);
  present.add('');
  const pending = [{ path: dir, rel: '', depth: 0, expectedIdentity: rootIdentity }];
  while (pending.length > 0) {
    checkDeadline();
    const current = pending.pop();
    const names = readNames(current.path, current.expectedIdentity);
    if (current.depth >= maxDepth && names.length > 0) {
      throw integrityInvalidError('verified vector depth');
    }
    for (const name of [...names].reverse()) {
      if (name.includes('\\') || name.includes('/') || /^[A-Za-z]:/.test(name)) {
        throw integrityInvalidError(`verified vector portable path ${name}`);
      }
      const path = join(current.path, name);
      const rel = current.rel ? `${current.rel}/${name}` : name;
      if (normalizePortableRelativePath(rel) !== rel || portableKeys.has(rel)) {
        throw integrityInvalidError(`verified vector portable path ${rel}`);
      }
      portableKeys.add(rel);
      const depth = current.depth + 1;
      const stat = statAt(path);
      if (stat.isSymbolicLink()) throw integrityInvalidError(`verified vector symlink ${rel}`);
      if (stat.isDirectory()) {
        const directoryIdentity = captureStableFileIdentity(path, { lstatFn: () => stat });
        addEntry(Object.freeze([
          runId,
          rel,
          'directory',
          deepFreeze({ identity: directoryIdentity }),
        ]), depth);
        present.add(rel);
        pending.push({ path, rel, depth, expectedIdentity: directoryIdentity });
        continue;
      }
      if (!stat.isFile()) throw integrityInvalidError(`verified vector entry type ${rel}`);
      const before = (() => {
        checkDeadline();
        try { return identityFn(path); }
        catch (error) { rethrowVerifiedReadError(error, `verified vector identity ${rel}`); }
      })();
      const initialIdentity = captureStableFileIdentity(path, { lstatFn: () => stat });
      const declaredSize = Number(stat.size);
      const relativeMaxBytes = maxBytesByRel.get(rel) ?? maxBytes;
      if (!Number.isSafeInteger(declaredSize)
        || declaredSize < 0
        || declaredSize > relativeMaxBytes
        || totalBytes + declaredSize > maxBytes) {
        throw integrityInvalidError('verified vector bytes');
      }
      let bytes;
      try {
        checkDeadline();
        bytes = Buffer.from(readFileFn(path));
      } catch (error) { rethrowVerifiedReadError(error, `verified vector read ${rel}`); }
      const after = (() => {
        checkDeadline();
        try { return identityFn(path); }
        catch (error) { rethrowVerifiedReadError(error, `verified vector identity ${rel}`); }
      })();
      const identityDrift = !matchingStableFileIdentity(initialIdentity, before)
        || !matchingStableFileIdentity(before, after);
      if (identityDrift) {
        throw integrityInvalidError(`verified vector identity drift ${rel}`, VERIFIED_READ_REASON.IDENTITY_DRIFT);
      }
      if (bytes.length !== declaredSize) {
        throw integrityInvalidError(`verified vector size drift ${rel}`);
      }
      totalBytes += bytes.length;
      const portable = deepFreeze({
        base64: bytes.toString('base64'),
        sha256: contentHash(bytes),
        size: bytes.length,
        identity_before: before,
        identity_after: after,
      });
      addEntry(Object.freeze([runId, rel, 'file', portable]), depth);
      present.add(rel);
    }
  }
  for (const rel of expectedRoots) {
    if (!present.has(rel)) addEntry(Object.freeze([runId, rel, 'ABSENT']), 0);
  }
  entries.sort((left, right) => JSON.stringify(left.slice(0, 3)).localeCompare(JSON.stringify(right.slice(0, 3))));
  checkDeadline();
  return Object.freeze(entries);
}

function inspectTransactionTreeLocked(dir, readOptions = {}) {
  const transactions = join(dir, 'transactions');
  if (!existsSync(transactions)) {
    return {
      entries: Object.freeze([]),
      prepared: Object.freeze([]),
      reconciliation: Object.freeze([]),
      error: null,
    };
  }
  let stat;
  let entries;
  try {
    stat = lstatSync(transactions, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return {
        entries: Object.freeze([]),
        error: { ok: false, kind: 'integrity-invalid', operation_id: null, phase: 'transaction-tree' },
      };
    }
    entries = readStableDirectoryNames(transactions, readOptions).names;
  } catch (error) {
    if (isVerifiedReadError(error)) throw error;
    return {
      entries: Object.freeze([]),
      error: { ok: false, kind: 'integrity-invalid', operation_id: null, phase: 'transaction-tree' },
    };
  }

  const prepared = [];
  const orphans = [];
  const unprepared = [];
  const invalid = [];
  for (const name of entries) {
    const operationDir = join(transactions, name);
    const orphan = name.match(ORPHAN_ENTRY);
    if (orphan) {
      if (!validTransactionOwner(operationDir, basename(dir), orphan[1], orphan[2], false, readOptions)) {
        invalid.push({ ok: false, kind: 'integrity-invalid', operation_id: null, phase: 'transaction-tree' });
        continue;
      }
      orphans.push(orphan[1]);
      continue;
    }
    if (!diagnosticOperationId(name)) {
      invalid.push({ ok: false, kind: 'integrity-invalid', operation_id: null, phase: 'transaction-tree' });
      continue;
    }
    try {
      const operationStat = lstatSync(operationDir, { bigint: true });
      if (operationStat.isSymbolicLink() || !operationStat.isDirectory()) {
        invalid.push({
          ok: false,
          kind: 'integrity-invalid',
          operation_id: diagnosticOperationId(name),
          phase: 'transaction-tree',
        });
        continue;
      }
      if (existsSync(join(operationDir, 'prepared.json'))) {
        if (validTransactionOwner(operationDir, basename(dir), name, null, true, readOptions)) prepared.push(name);
        else invalid.push({ ok: false, kind: 'integrity-invalid', operation_id: name, phase: 'transaction-tree' });
      }
      else if (validTransactionOwner(operationDir, basename(dir), name, null, false, readOptions)) unprepared.push(name);
      else invalid.push({ ok: false, kind: 'integrity-invalid', operation_id: null, phase: 'transaction-tree' });
    } catch (error) {
      if (isVerifiedReadError(error)) throw error;
      invalid.push({
        ok: false,
        kind: 'integrity-invalid',
        operation_id: diagnosticOperationId(name),
        phase: 'transaction-tree',
      });
    }
  }

  if (invalid.length > 0) {
    return {
      entries: Object.freeze(entries),
      prepared: Object.freeze(prepared),
      reconciliation: Object.freeze([...orphans, ...unprepared].sort()),
      error: invalid[0],
    };
  }
  if (orphans.length > 0 || unprepared.length > 0) {
    return {
      entries: Object.freeze(entries),
      prepared: Object.freeze(prepared),
      reconciliation: Object.freeze([...orphans, ...unprepared].sort()),
      error: null,
    };
  }
  return { entries: Object.freeze(entries), prepared: Object.freeze(prepared), reconciliation: Object.freeze([]), error: null };
}

function sameVerifiedVector(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifiedCaptureLocked(root, runId, guard, options) {
  const dir = runDir(root, runId);
  const vectorOptions = options.vectorOptions || {};
  const effectiveVectorOptions = {
    ...vectorOptions,
    ...(vectorOptions.nowFn === undefined && typeof options.nowFn === 'function'
      ? { nowFn: options.nowFn } : {}),
  };
  const inspectionReadOptions = {
    maxEntries: VERIFIED_VECTOR_DEFAULTS.maxEntries,
    maxBytes: VERIFIED_VECTOR_DEFAULTS.maxBytes,
    deadlineAtMs: options.vectorDeadlineAtMs,
    nowFn: effectiveVectorOptions.nowFn,
    identityFn: effectiveVectorOptions.identityFn,
    lstatFn: effectiveVectorOptions.lstatFn,
    opendirFn: effectiveVectorOptions.opendirFn,
  };
  const checkDeadline = () => {
    if (options.vectorDeadlineAtMs === undefined) return;
    const nowFn = typeof effectiveVectorOptions.nowFn === 'function'
      ? effectiveVectorOptions.nowFn : () => Date.now();
    const current = nowFn();
    const now = current instanceof Date ? current.getTime() : Number(current);
    if (!Number.isFinite(now) || now >= Number(options.vectorDeadlineAtMs)) {
      throw integrityInvalidError('verified capture deadline');
    }
  };
  checkDeadline();
  const verifiedVector = captureVerifiedDurableVectorLocked(
    dir,
    runId,
    effectiveVectorOptions,
    options.vectorDeadlineAtMs,
  );
  checkDeadline();
  const transactionTree = inspectTransactionTreeLocked(dir, {
    ...inspectionReadOptions,
  });
  checkDeadline();
  if (transactionTree.error) return transactionTree.error;
  const transactionEntries = transactionTree.entries;
  if (transactionTree.reconciliation.length > 0) {
    return {
      ok: false,
      kind: 'reconciliation-required',
      operation_id: diagnosticOperationId(transactionTree.reconciliation[0]),
      phase: 'transaction-tree',
    };
  }
  if (transactionEntries.length === 0) {
    const snapshot = snapshotRaw(root, runId, readRawRun(root, runId), {
      requireProjectBinding: options.requireProjectBinding !== false,
    });
    const artifacts = captureArtifactsLocked(root, runId, options.artifactRels);
    const finalVector = captureVerifiedDurableVectorLocked(
      dir,
      runId,
      effectiveVectorOptions,
      options.vectorDeadlineAtMs,
    );
    if (!sameVerifiedVector(verifiedVector, finalVector)) {
      throw integrityInvalidError('verified vector phase drift');
    }
    checkDeadline();
    return {
      ok: true,
      kind: 'clean-no-publication',
      snapshot: {
        ...snapshot,
        artifacts,
        vector: verifiedVector,
      },
    };
  }

  let prepared;
  if (transactionTree.prepared.length > 0) {
    try {
      prepared = findPreparedPublicationLocked(dir, guard);
      checkDeadline();
    } catch (error) {
      if (isVerifiedReadError(error)) throw error;
      const operationId = transactionTree.prepared[0] || null;
      const kind = String(error?.message || error).includes('multiple prepared operations')
        ? 'reconciliation-required' : 'integrity-invalid';
      return { ok: false, kind, operation_id: operationId, phase: 'transaction-tree' };
    }
  }
  if (!prepared) {
    return inspectAnchoredPublication({
      operationId: diagnosticOperationId(transactionEntries[0]),
    });
  }

  const operationId = prepared.manifest.operationId;
  const marker = committedMarkerInspection(prepared);
  let classified = null;
  let error = null;
  try {
    checkDeadline();
    classified = classifyPreparedRun(root, runId, guard, prepared, {
      rootRecovery: options.rootRecovery === true,
    });
  } catch (caught) {
    if (isVerifiedReadError(caught)) throw caught;
    error = caught;
  }
  checkDeadline();
  const inspection = inspectAnchoredPublication({ operationId, marker, classified, error });
  if (!inspection.ok) return inspection;
  const snapshot = snapshotRaw(root, runId, classified.raw, {
    requireProjectBinding: options.requireProjectBinding !== false,
  });
  const artifacts = captureArtifactsLocked(root, runId, options.artifactRels);
  const finalVector = captureVerifiedDurableVectorLocked(
    dir,
    runId,
    effectiveVectorOptions,
    options.vectorDeadlineAtMs,
  );
  if (!sameVerifiedVector(verifiedVector, finalVector)) {
    throw integrityInvalidError('verified vector phase drift');
  }
  checkDeadline();
  return {
    ...inspection,
    snapshot: {
      ...snapshot,
      artifacts,
      vector: verifiedVector,
    },
  };
}

// VERIFIED_READ_CLOSURE_START
const VERIFIED_READ_CLOSURE = Object.freeze([
  ['exactObjectKeys', exactObjectKeys],
  ['canonicalIsoTimestamp', canonicalIsoTimestamp],
  ['canonicalHostname', canonicalHostname],
  ['canonicalRegularEntry', canonicalRegularEntry],
  ['canonicalDirectoryEntry', canonicalDirectoryEntry],
  ['deepFreeze', deepFreeze],
  ['transactionError', transactionError],
  ['integrityInvalidError', integrityInvalidError],
  ['diagnosticOperationId', diagnosticOperationId],
  ['readDeadlineAtMs', readDeadlineAtMs],
  ['checksumFor', checksumFor],
  ['nextEvent', nextEvent],
  ['parseExactLogBytes', parseExactLogBytes],
  ['readRawRun', readRawRun],
  ['snapshotRaw', snapshotRaw],
  ['readStableRegularFile', readStableRegularFile],
  ['readStableDirectoryNames', readStableDirectoryNames],
  ['validTransactionOwner', validTransactionOwner],
  ['captureArtifactLocked', captureArtifactLocked],
  ['captureArtifactsLocked', captureArtifactsLocked],
  ['operationTimestamp', operationTimestamp],
  ['exactBoundaryIdentity', exactBoundaryIdentity],
  ['sameBoundaryIdentity', sameBoundaryIdentity],
  ['validateBoundaryPublication', validateBoundaryPublication],
  ['validatePreparedAuthority', validatePreparedAuthority],
  ['classifyPreparedRun', classifyPreparedRun],
  ['committedMarkerInspection', committedMarkerInspection],
  ['inspectAnchoredPublication', inspectAnchoredPublication],
  ['captureVerifiedDurableVectorLocked', captureVerifiedDurableVectorLocked],
  ['inspectTransactionTreeLocked', inspectTransactionTreeLocked],
  ['sameVerifiedVector', sameVerifiedVector],
  ['verifiedCaptureLocked', verifiedCaptureLocked],
  ['validCost', validCost],
  ['headOfLines', headOfLines],
  ['verifyLines', verifyLines],
  ['verifyHeadLines', verifyHeadLines],
  ['enumerateRunIdsBounded', enumerateRunIdsBounded],
]);
export const VERIFIED_READ_CLOSURE_NAMES = Object.freeze(VERIFIED_READ_CLOSURE.map(([name]) => name));
const VERIFIED_READ_FORBIDDEN_CALL = /\b(?:appendAnchored|appendEvent|writeState|durableAtomicWrite|appendFileSync|renameSync|rmSync|unlinkSync|mkdirSync|fsyncSync|openSync|publishArtifactTargetsLocked|markPublicationCommittedLocked|retireCommittedPublicationLocked|reconcileAnchoredPublicationLocked)\s*\(/;
for (const [name, reader] of VERIFIED_READ_CLOSURE) {
  if (VERIFIED_READ_FORBIDDEN_CALL.test(reader.toString())) {
    throw new Error(`VERIFIED_READ_CLOSURE_MUTATION: ${name}`);
  }
}
// VERIFIED_READ_CLOSURE_END

function captureVerifiedReadWithRetry(root, runId, options = {}, {
  rootRecovery = false,
} = {}) {
  let retriedIdentityDrift = false;
  let observedIdentityDrift = false;
  try {
    const vectorDeadlineAtMs = readDeadlineAtMs(options);
    while (true) {
      try {
        const result = withReadLock(
          root,
          runId,
          guard => verifiedCaptureLocked(root, runId, guard, {
            ...options,
            ...(rootRecovery ? { requireProjectBinding: false, rootRecovery: true } : {}),
            vectorDeadlineAtMs,
          }),
          {
            ...options.lockOptions,
            ...(options.lockOptions?.nowFn === undefined && typeof options.nowFn === 'function'
              ? { nowFn: options.nowFn } : {}),
            ...(vectorDeadlineAtMs === undefined ? {} : { deadlineAtMs: vectorDeadlineAtMs }),
          },
        );
        if (observedIdentityDrift && result?.ok === true) {
          return verifiedReadFailureDescriptor({
            verified_read_reason: VERIFIED_READ_REASON.IDENTITY_DRIFT,
          });
        }
        return result;
      } catch (error) {
        if (!retriedIdentityDrift
          && error?.verified_read_reason === VERIFIED_READ_REASON.IDENTITY_DRIFT) {
          observedIdentityDrift = true;
          retriedIdentityDrift = true;
          continue;
        }
        if (isVerifiedReadError(error)
          || String(error?.message || '').startsWith('LOG_TAMPERED')
          || error?.message === 'LOCK_DEADLINE_EXCEEDED') {
          return verifiedReadFailureDescriptor(error);
        }
        throw error;
      }
    }
  } catch (error) {
    if (isVerifiedReadError(error)
      || String(error?.message || '').startsWith('LOG_TAMPERED')
      || error?.message === 'LOCK_DEADLINE_EXCEEDED') {
      return verifiedReadFailureDescriptor(error);
    }
    throw error;
  }
}

export function captureVerifiedRunSnapshot(root, runId, options = {}) {
  return captureVerifiedReadWithRetry(root, runId, options);
}

// Root-recovery diagnosis is a verified read of a relocated run. It deliberately
// keeps the transaction/vector classification above while relaxing only the
// ordinary project-root binding check; no reconciler or writer is reachable.
export function captureVerifiedRootRecoverySnapshot(root, runId, options = {}) {
  return captureVerifiedReadWithRetry(root, runId, options, { rootRecovery: true });
}

function nowMillis(nowFn) {
  const value = (typeof nowFn === 'function' ? nowFn : () => Date.now())();
  return value instanceof Date ? value.getTime() : Number(value);
}

function boundedRunSetError({ maxRunIds, deadlineMs, observedCount, totalIsLowerBound, phase }) {
  const diagnostic = Object.freeze({
    reason: 'run-set-bound-exceeded',
    kind: 'run-set-bound-exceeded',
    max_run_ids: maxRunIds,
    deadline_ms: deadlineMs,
    observed_count: observedCount,
    total_is_lower_bound: totalIsLowerBound,
    phase,
  });
  return Object.freeze(diagnostic);
}

/**
 * Enumerate the implicit historical run directory incrementally.  In
 * particular, do not turn an unbounded readdir result into an array before
 * checking the cap: old terminal history is part of the attack surface.
 */
export function enumerateRunIdsBounded(root, {
  maxRunIds = 64,
  deadlineAtMs,
  deadlineAt,
  deadlineMs = 500,
  nowFn,
  opendirFn = opendirSync,
} = {}) {
  const suppliedDeadlineAt = deadlineAtMs ?? deadlineAt;
  if (!Number.isSafeInteger(maxRunIds) || maxRunIds < 1
    || (suppliedDeadlineAt !== undefined && !Number.isFinite(Number(suppliedDeadlineAt)))
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 0) {
    throw new Error('RUN_SET_OPTIONS_INVALID');
  }
  const now = () => nowMillis(nowFn);
  const absoluteDeadline = suppliedDeadlineAt === undefined ? now() + deadlineMs : Number(suppliedDeadlineAt);
  if (!Number.isSafeInteger(absoluteDeadline)) throw new Error('RUN_SET_OPTIONS_INVALID');
  const observed = [];
  const checkDeadline = () => {
    const current = now();
    if (!Number.isSafeInteger(current)) throw new Error('RUN_SET_DEADLINE_INVALID');
    if (current >= absoluteDeadline) {
      throw boundedRunSetError({
        maxRunIds, deadlineMs, observedCount: observed.length, totalIsLowerBound: false, phase: 'enumeration',
      });
    }
  };
  const runsDir = join(root, '.deep-loop', 'runs');
  if (!existsSync(runsDir)) return Object.freeze({ runIds: Object.freeze([]), deadlineAtMs: absoluteDeadline });

  let directory;
  try {
    checkDeadline();
    directory = opendirFn(runsDir);
    while (true) {
      checkDeadline();
      const entry = directory.readSync();
      if (entry === null) break;
      if (!entry.isDirectory()) continue;
      observed.push(entry.name);
      if (observed.length > maxRunIds) {
        throw boundedRunSetError({
          maxRunIds,
          deadlineMs,
          observedCount: observed.length,
          totalIsLowerBound: true,
          phase: 'enumeration',
        });
      }
    }
    checkDeadline();
  } catch (error) {
    if (error?.kind === 'run-set-bound-exceeded') throw error;
    throw new Error(`RUN_SET_ENUMERATION_FAILED: ${String(error?.message || error)}`);
  } finally {
    try { directory?.closeSync(); } catch { /* bounded read is already failed */ }
  }
  observed.sort();
  for (const id of observed) runDir(root, id);
  return Object.freeze({ runIds: Object.freeze(observed), deadlineAtMs: absoluteDeadline });
}

function defaultReadSleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function captureVerifiedRunSet(root, options = {}) {
  const implicit = options.runIds === undefined;
  let vectorDeadlineAtMs = readDeadlineAtMs(options);
  if (vectorDeadlineAtMs === undefined && options.deadlineMs !== undefined) {
    vectorDeadlineAtMs = nowMillis(options.nowFn) + Number(options.deadlineMs);
  }
  let runIds;
  if (implicit) {
    try {
      const enumeration = enumerateRunIdsBounded(root, {
        maxRunIds: options.maxRunIds ?? 64,
        deadlineAtMs: vectorDeadlineAtMs,
        deadlineMs: options.deadlineMs ?? 500,
        nowFn: options.nowFn,
        opendirFn: options.opendirFn,
      });
      runIds = enumeration.runIds;
      vectorDeadlineAtMs = enumeration.deadlineAtMs;
    } catch (error) {
      if (error?.kind !== 'run-set-bound-exceeded') throw error;
      return Object.freeze({
        root: canonicalProjectRoot(root),
        runIds: Object.freeze([]),
        runs: Object.freeze(Object.create(null)),
        errors: Object.freeze({ run_set: error }),
        ok: false,
        kind: error.kind,
        ...error,
      });
    }
  } else {
    runIds = frozenRunIds(root, options.runIds);
  }
  options.afterEnumeration?.(runIds);
  const runs = Object.create(null);
  const errors = Object.create(null);
  for (const runId of runIds) {
    const capture = () => captureVerifiedRunSnapshot(root, runId, {
      artifactRels: options.artifactRelsByRun?.[runId] || [],
      lockOptions: options.lockOptions,
      vectorOptions: options.vectorOptionsByRun?.[runId] || options.vectorOptions,
      vectorDeadlineAtMs,
      nowFn: options.nowFn,
    });
    try {
      let result;
      try {
        result = capture();
      } catch (firstError) {
        // One retry is allowed, but only outside the per-run lock and only
        // while the same aggregate deadline still has time remaining.
        const retryable = String(firstError?.message || firstError).startsWith('LOCK_BUSY');
        if (!retryable) throw firstError;
        const current = nowMillis(options.nowFn);
        const remaining = vectorDeadlineAtMs === undefined ? null : Number(vectorDeadlineAtMs) - current;
        if (!Number.isSafeInteger(current) || (remaining !== null && remaining <= 0)) {
          throw boundedRunSetError({
            maxRunIds: options.maxRunIds ?? 64,
            deadlineMs: options.deadlineMs ?? 500,
            observedCount: runIds.length,
            totalIsLowerBound: false,
            phase: 'lock-retry',
          });
        }
        const delay = remaining === null ? (options.retryDelayMs ?? 50)
          : Math.min(options.retryDelayMs ?? 50, remaining);
        (options.sleepFn || options.lockOptions?.sleepFn || defaultReadSleep)(delay);
        if (vectorDeadlineAtMs !== undefined && nowMillis(options.nowFn) >= Number(vectorDeadlineAtMs)) {
          throw boundedRunSetError({
            maxRunIds: options.maxRunIds ?? 64,
            deadlineMs: options.deadlineMs ?? 500,
            observedCount: runIds.length,
            totalIsLowerBound: false,
            phase: 'lock-retry',
          });
        }
        result = capture();
      }
      if (result.ok) runs[runId] = result;
      else {
        const aggregateBound = implicit || options.deadlineMs !== undefined || options.maxRunIds !== undefined;
        if (aggregateBound && vectorDeadlineAtMs !== undefined
          && nowMillis(options.nowFn) >= Number(vectorDeadlineAtMs)) {
          throw boundedRunSetError({
            maxRunIds: options.maxRunIds ?? 64,
            deadlineMs: options.deadlineMs ?? 500,
            observedCount: runIds.length,
            totalIsLowerBound: false,
            phase: 'lock-retry',
          });
        }
        errors[runId] = result;
      }
    } catch (error) {
      if (error?.kind === 'run-set-bound-exceeded') {
        const diagnostic = error;
        return Object.freeze({
          root: canonicalProjectRoot(root),
          runIds: Object.freeze([]),
          runs: Object.freeze(Object.create(null)),
          errors: Object.freeze({ run_set: diagnostic }),
          ok: false,
          kind: diagnostic.kind,
          ...diagnostic,
        });
      }
      errors[runId] = Object.freeze({
        kind: error?.message?.startsWith('TRANSACTION_RECONCILIATION_REQUIRED')
          ? 'reconciliation-required' : 'integrity-invalid',
        message: String(error?.message || error).split(':')[0],
      });
    }
  }
  const result = {
    root: canonicalProjectRoot(root),
    runIds,
    runs: Object.freeze(Object.keys(errors).length ? Object.create(null) : runs),
    errors: Object.freeze(errors),
  };
  return Object.freeze(result);
}

function appendDurableLine(path, bytes, guard, faultAt, index) {
  guard.assertOwned();
  const fd = openSync(path, 'a', 0o600);
  try {
    appendFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  faultAt(`event:${index}:append`);
  guard.renew();
}

export function reconcileAnchoredPublicationLocked(root, runId, guard, {
  faultAt = () => {},
  forceUnlinkReplacement = false,
  durableWriteFn = durableAtomicWrite,
  rootRecovery = false,
} = {}) {
  guard.assertOwned();
  if (!existsSync(join(runDir(root, runId), 'transactions'))) {
    return { ok: true, reconciled: false };
  }
  const prepared = findPreparedPublicationLocked(runDir(root, runId), guard);
  if (!prepared) return { ok: true, reconciled: false };
  const classified = classifyPreparedRun(root, runId, guard, prepared, { rootRecovery });
  if (classified.committed) return { ok: true, reconciled: true, committed: true };

  publishArtifactTargetsLocked(runDir(root, runId), guard, classified.manifest, {
    faultAt,
    forceUnlinkReplacement,
    durableWriteFn,
  });
  for (let index = classified.appendedCount; index < classified.stagedEvents.length; index++) {
    appendDurableLine(logPath(root, runId), classified.stagedEvents[index].bytes, guard, faultAt, index);
  }
  if (classified.loopState === 'predecessor') {
    durableWriteFn(join(runDir(root, runId), 'loop.json'), classified.candidateBytes, {
      barrierAt(phase) { faultAt(`state:loop:${phase}`); guard.renew(); },
    });
    faultAt('state:loop:rename');
  }
  if (classified.hashState === 'predecessor') {
    durableWriteFn(join(runDir(root, runId), '.loop.hash'), classified.candidateHashBytes, {
      barrierAt(phase) { faultAt(`state:hash:${phase}`); guard.renew(); },
    });
    faultAt('state:hash:rename');
  }
  const finalClassified = classifyPreparedRun(root, runId, guard, prepared, { rootRecovery });
  if (finalClassified.loopState !== 'candidate' || finalClassified.hashState !== 'candidate'
    || finalClassified.appendedCount !== finalClassified.stagedEvents.length
    || !finalClassified.raw.hashBytes) throw transactionError('incomplete replay');
  markPublicationCommittedLocked(runDir(root, runId), guard, prepared, { durableWriteFn, faultAt });
  return { ok: true, reconciled: true, committed: true };
}

export function captureReconciledRunSnapshot(root, runId, options = {}) {
  return withLock(root, runId, guard => {
    reconcileAnchoredPublicationLocked(root, runId, guard, options);
    const snapshot = snapshotRaw(root, runId, readRawRun(root, runId));
    return { ...snapshot, artifacts: captureArtifactsLocked(root, runId, options.artifactRels) };
  }, options.lockOptions);
}

function frozenRunIds(root, requested) {
  if (requested !== undefined) {
    if (!Array.isArray(requested)) throw new Error('RUN_SET_INVALID: runIds');
    const ids = [...new Set(requested)].sort();
    for (const id of ids) runDir(root, id);
    return Object.freeze(ids);
  }
  const dir = join(root, '.deep-loop', 'runs');
  if (!existsSync(dir)) return Object.freeze([]);
  return Object.freeze([...new Set(readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name))].sort());
}

export function captureReconciledRunSet(root, options = {}) {
  const runIds = frozenRunIds(root, options.runIds);
  options.afterEnumeration?.(runIds);
  const runs = Object.create(null);
  const errors = Object.create(null);
  for (const runId of runIds) {
    const capture = () => captureReconciledRunSnapshot(root, runId, {
      artifactRels: options.artifactRelsByRun?.[runId] || [],
      lockOptions: options.lockOptions,
    });
    try {
      runs[runId] = capture();
    } catch (firstError) {
      try {
        const delay = options.retryDelayMs ?? 50;
        if (options.sleepFn) options.sleepFn(delay);
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        runs[runId] = capture();
      } catch (error) {
        errors[runId] = Object.freeze({
          kind: error?.name === 'SyntaxError' ? 'unreadable' : 'integrity',
          message: String(error?.message || error),
        });
      }
    }
  }
  return Object.freeze({ root: canonicalProjectRoot(root), runIds, runs, errors });
}

function assertRootRecoveryBinding(candidateRoot, snapshot) {
  const binding = classifyProjectRootBinding(candidateRoot, snapshot.data.project?.root);
  if (binding.mismatch_class === 'fenced') {
    throw new Error('PROJECT_ROOT_FENCED: stored project root still resolves');
  }
  if (!['unresolvable', 'match'].includes(binding.mismatch_class)) {
    throw new Error('PROJECT_ROOT_UNRESOLVABLE: invalid root classifier');
  }
  return binding;
}

export function captureReconciledRootRecoverySnapshot(candidateRoot, runId, options = {}) {
  return withLock(candidateRoot, runId, guard => {
    reconcileAnchoredPublicationLocked(candidateRoot, runId, guard, { ...options, rootRecovery: true });
    const snapshot = snapshotRaw(candidateRoot, runId, readRawRun(candidateRoot, runId), {
      requireProjectBinding: false,
    });
    assertRootRecoveryBinding(candidateRoot, snapshot);
    return { ...snapshot, artifacts: captureArtifactsLocked(candidateRoot, runId, options.artifactRels) };
  }, options.lockOptions);
}

export function withReconciledRootRecoveryLock(candidateRoot, runId, callback, options = {}) {
  if (typeof callback !== 'function') throw new Error('MUTATION_CALLBACK_REQUIRED');
  return withLock(candidateRoot, runId, guard => {
    reconcileAnchoredPublicationLocked(candidateRoot, runId, guard, { ...options, rootRecovery: true });
    const snapshot = snapshotRaw(candidateRoot, runId, readRawRun(candidateRoot, runId), {
      requireProjectBinding: false,
    });
    assertRootRecoveryBinding(candidateRoot, snapshot);
    if (existsSync(join(runDir(candidateRoot, runId), 'transactions'))) {
      retireCommittedPublicationLocked(runDir(candidateRoot, runId), guard);
    }
    return callback(guard, snapshot);
  }, options.lockOptions);
}

export function withReconciledMutationLock(root, runId, callback, options = {}) {
  if (typeof callback !== 'function') throw new Error('MUTATION_CALLBACK_REQUIRED');
  const { authorize, ...reconcileOptions } = options;
  if (authorize !== undefined && typeof authorize !== 'function') {
    throw new Error('MUTATION_AUTHORIZER_INVALID');
  }
  return withLock(root, runId, guard => {
    if (authorize && compactRestoreIntentCandidateLocked(root, runId, guard)) {
      const raw = readRawRun(root, runId);
      const authorized = parseHashVerifiedStateBytes(root, runId, raw.loopBytes, raw.hashBytes, {
        requireSchema: false,
      });
      assertProjectRootBinding(root, authorized.data);
      authorize(guard, { data: structuredClone(authorized.data) });
    }
    assertNoCompactRestoreIntentLocked(root, runId, guard);
    reconcileAnchoredPublicationLocked(root, runId, guard, reconcileOptions);
    const snapshot = snapshotRaw(root, runId, readRawRun(root, runId), { requireSchema: false });
    if (authorize) authorize(guard, { ...snapshot, data: structuredClone(snapshot.data) });
    if (existsSync(join(runDir(root, runId), 'transactions'))) {
      retireCommittedPublicationLocked(runDir(root, runId), guard);
    }
    return callback(guard, snapshot);
  }, options.lockOptions);
}

function validatedFenceRequest(fence, runtime) {
  if (!fence || typeof fence !== 'object' || Array.isArray(fence)
    || typeof fence.owner !== 'string'
    || fence.owner.length === 0
    || !Number.isSafeInteger(fence.generation)
    || fence.generation < 1) {
    throw new Error('FENCE_REQUIRED: owner and positive generation');
  }
  return { fence, runtime: validateSessionRuntime(runtime) };
}

export function assertEstablishedFence(loop, fence, runtime) {
  const validated = validatedFenceRequest(fence, runtime);
  const assertedRuntime = validated.runtime;
  if (sessionRuntime(loop) !== assertedRuntime) throw new Error('RUNTIME_FENCED: runtime mismatch');
  const checked = leaseCheck(loop, {
    owner: validated.fence.owner,
    generation: validated.fence.generation,
    runtime: assertedRuntime,
  });
  if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
  return assertedRuntime;
}

function assertPreparedPublicationFence(manifest, fence, runtime) {
  const validated = validatedFenceRequest(fence, runtime);
  if (manifest.runtime !== validated.runtime) throw new Error('RUNTIME_FENCED: runtime mismatch');
  if (manifest.expect.owner !== validated.fence.owner) {
    throw new Error('LEASE_FENCED: owner-mismatch');
  }
  if (manifest.expect.generation !== validated.fence.generation) {
    throw new Error('LEASE_FENCED: generation-mismatch');
  }
  return validated.runtime;
}

export function withFencedReconciledMutationLock(root, runId, callback, {
  fence,
  runtime,
  ...options
} = {}) {
  if (typeof callback !== 'function') throw new Error('MUTATION_CALLBACK_REQUIRED');
  return withLock(root, runId, guard => {
    const prepared = findPreparedPublicationLocked(runDir(root, runId), guard);
    if (prepared) {
      assertPreparedPublicationFence(prepared.manifest, fence, runtime);
    } else {
      const raw = readRawRun(root, runId);
      const current = parseHashVerifiedStateBytes(root, runId, raw.loopBytes, raw.hashBytes, {
        requireSchema: false,
      });
      assertEstablishedFence(current.data, fence, runtime);
    }
    assertNoCompactRestoreIntentLocked(root, runId, guard);
    reconcileAnchoredPublicationLocked(root, runId, guard, options);
    const snapshot = snapshotRaw(root, runId, readRawRun(root, runId), { requireSchema: false });
    assertEstablishedFence(snapshot.data, fence, runtime);
    if (existsSync(join(runDir(root, runId), 'transactions'))) {
      retireCommittedPublicationLocked(runDir(root, runId), guard);
    }
    return callback(guard, snapshot);
  }, options.lockOptions);
}

export function withVerifiedReadLock(root, runId, callback, options = {}) {
  if (typeof callback !== 'function') throw new Error('READ_CALLBACK_REQUIRED');
  return withLock(root, runId, guard => {
    const snapshot = snapshotRaw(root, runId, readRawRun(root, runId), { requireSchema: false });
    return callback(guard, snapshot);
  }, options.lockOptions);
}

const RESTORE_EVENT_DATA_KEYS = Object.freeze([
  'operation_id', 'checkpoint_key', 'context_sha256', 'pre_restore_loop_hash',
  'owner_run_id', 'generation', 'runtime', 'workstream_id', 'episode_id',
  'baseline_turns', 'cycle', 'admission', 'provider_evidence',
]);
const RESTORE_FAULTS = new Set([
  'restore:intent-written', 'event:appended', 'state:written', 'restore:intent-cleanup',
]);
const RESTORE_TERMINAL_WORKSTREAM = new Set(['ready', 'merged', 'abandoned']);

function exactOrderedKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function restoreAffinity(loop) {
  const session = ownerSession(loop);
  const scope = session.scope;
  if (!isOpenScope(scope) || scope.closed_at !== null || scope.superseded_at !== null
    || !Number.isSafeInteger(scope.bound_at_seq) || scope.bound_at_seq < 1
    || typeof scope.workstream_id !== 'string' || scope.workstream_id.length === 0) {
    throw new Error('CHECKPOINT_AFFINITY_INVALID: owner scope is not open and bound');
  }
  const workstream = (loop.workstreams || []).find(item => item?.id === scope.workstream_id);
  const episode = (loop.episodes || []).find(item => item?.id === loop.current_episode);
  if (!workstream || RESTORE_TERMINAL_WORKSTREAM.has(workstream.status)
    || !episode || episode.workstream_id !== scope.workstream_id) {
    throw new Error('CHECKPOINT_AFFINITY_INVALID: current Workstream or episode mismatch');
  }
  const artifacts = [...new Set([
    ...(Array.isArray(episode.expected_artifacts) ? episode.expected_artifacts : []),
    ...(Array.isArray(episode.artifacts) ? episode.artifacts : []),
  ])].sort();
  if (artifacts.length > 256) throw new Error('CHECKPOINT_AFFINITY_INVALID: artifact set too large');
  return { session, scope, workstream, episode, artifacts };
}

function restoreArtifact(root, rel) {
  const normalized = normalizePortableRelativePath(rel);
  if (normalized === null || normalized !== rel) {
    throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${String(rel)}`);
  }
  let current = root;
  const parts = normalized.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    if (!existsSync(current)) return { rel: normalized, state: 'absent', sha256: null, size: null };
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
      continue;
    }
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
    }
    const before = captureStableFileIdentity(current);
    const bytes = readFileSync(current);
    const after = captureStableFileIdentity(current);
    if (!matchingStableFileIdentity(before, after) || bytes.length !== stat.size) {
      throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
    }
    return { rel: normalized, state: 'present', sha256: contentHash(bytes), size: bytes.length };
  }
  throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
}

function expectedRestoreContext(root, runId, loop, hash, recordedEvidence, generatedAt) {
  const { scope, workstream, episode, artifacts } = restoreAffinity(loop);
  return {
    run_id: runId,
    owner_run_id: loop.session_chain.lease.owner_run_id,
    generation: loop.session_chain.lease.generation,
    project_root_digest: projectRootDigest(loop.project.root),
    project_binding_generation: loop.project.binding_generation,
    runtime: sessionRuntime(loop),
    loop_hash: hash,
    scope: structuredClone(scope),
    workstream: structuredClone(workstream),
    current_episode: structuredClone(episode),
    artifacts: artifacts.map(rel => restoreArtifact(root, rel)),
    next_action: nextAction(loop, { now: Date.parse(generatedAt), unattended: false }),
    provider_evidence: structuredClone(recordedEvidence),
  };
}

function strictRestoreFile(root, runId, request) {
  const dir = join(runDir(root, runId), 'checkpoints');
  let stat;
  try { stat = lstatSync(dir); } catch { throw new Error('CHECKPOINT_NOT_FOUND'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || realpathSync(dir) !== realpathSync(join(runDir(root, runId), 'checkpoints'))) {
    throw new Error('CHECKPOINT_PATH_INVALID');
  }
  const path = join(dir, `${request.checkpointKey}-compact.json`);
  if (resolve(path) !== resolve(runDir(root, runId), ...request.checkpointRel.split('/'))) {
    throw new Error('CHECKPOINT_REL_INVALID');
  }
  const { bytes } = readStableRegular(path);
  if (bytes.length === 0 || bytes.length > 256 * 1024) throw new Error('CHECKPOINT_INVALID');
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('CHECKPOINT_INVALID'); }
  const context = validateStrictSelf(envelope, { runId, key: request.checkpointKey });
  return { bytes, envelope, context };
}

function assertRestoreFence(loop, request) {
  const runtime = validateSessionRuntime(request.runtime);
  if (sessionRuntime(loop) !== runtime) throw new Error('RUNTIME_FENCED: runtime mismatch');
  const checked = leaseCheck(loop, {
    owner: request.fence.owner,
    generation: request.fence.generation,
    runtime,
  });
  if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
  return runtime;
}

function assertCheckpointRestoreIdentity(root, loop, request, context, affinity) {
  if (loop.autonomy?.continuation_policy !== 'workstream-session'
    || context.run_id !== request.runId
    || context.owner_run_id !== request.fence.owner
    || context.generation !== request.fence.generation
    || context.runtime !== request.runtime
    || context.project_root_digest !== projectRootDigest(loop.project.root)
    || context.project_binding_generation !== loop.project.binding_generation
    || context.scope?.workstream_id !== affinity.workstream.id
    || context.workstream?.id !== affinity.workstream.id
    || context.current_episode?.id !== affinity.episode.id) {
    throw new Error('CHECKPOINT_CONTEXT_MISMATCH');
  }
  assertProjectRootBinding(root, loop);
}

function validateRestoreAdmission(runDirectory, request, context, affinity, loop, guard) {
  const base = {
    checkpoint_key: request.checkpointKey,
    context_sha256: request.contextSha256,
    owner_run_id: request.fence.owner,
    generation: request.fence.generation,
    runtime: request.runtime,
    workstream_id: affinity.workstream.id,
    episode_id: affinity.episode.id,
  };
  let proof;
  let admission;
  let providerEvidence;
  if (request.admission === 'postcompact-observation') {
    if (!['sessionstart', 'external-controller'].includes(request.source)
      || request.confirmManualCompact !== false) {
      throw new Error('CHECKPOINT_ADMISSION_INVALID');
    }
    const receipt = readCompactObservationProofLocked(
      runDirectory,
      request.runId,
      request.checkpointRel,
      base,
      guard,
    );
    if (receipt.payload.provider_evidence.recorded !== (context.provider_evidence !== null)) {
      throw new Error('CHECKPOINT_RECEIPT_INVALID');
    }
    proof = {
      checkpoint_key: receipt.payload.checkpoint_key,
      context_sha256: receipt.payload.context_sha256,
      owner_run_id: receipt.payload.owner_run_id,
      generation: receipt.payload.generation,
      runtime: receipt.payload.runtime,
      workstream_id: receipt.payload.workstream_id,
      episode_id: receipt.payload.episode_id,
      receipt_sha256: receipt.digest,
    };
    admission = {
      kind: 'postcompact-observation',
      source: request.source,
      receipt_trigger: receipt.payload.trigger,
    };
    providerEvidence = structuredClone(receipt.payload.provider_evidence);
  } else if (request.admission === 'human-attested') {
    if (request.source !== 'direct-human-skill'
      || request.confirmManualCompact !== true
      || request.headless === true
      || loop.autonomy?.spawn_style === 'headless') {
      throw new Error('CHECKPOINT_MANUAL_ATTESTATION_REQUIRED');
    }
    proof = { direct_human_skill: true, non_headless: true, confirmed: true };
    admission = {
      kind: 'human-attested', source: 'direct-human-skill', receipt_trigger: null,
    };
    providerEvidence = providerEvidenceProjection(
      context.provider_evidence,
      normalizeProviderEvidence(undefined),
    );
  } else {
    throw new Error('CHECKPOINT_ADMISSION_INVALID');
  }
  const requestBinding = compactRestoreRequestBinding({
    ...base,
    admission_kind: request.admission,
    source: request.source,
    confirm_manual_compact: request.confirmManualCompact,
    proof,
  });
  return {
    admission,
    providerEvidence,
    requestBinding,
    requestBindingSha256: compactRestoreRequestBindingDigest(requestBinding),
  };
}

function restoreDescriptor(request, cursor, disposition) {
  return {
    ok: true,
    disposition,
    phase: 'restored',
    checkpoint_rel: request.checkpointRel,
    checkpoint_key: cursor.checkpoint_key,
    owner_run_id: cursor.owner_run_id,
    generation: cursor.generation,
    runtime: cursor.runtime,
    workstream_id: cursor.workstream_id,
    episode_id: cursor.episode_id,
    baseline_turns: cursor.baseline_turns,
    cycle: cursor.cycle,
    restore_event: structuredClone(cursor.restore_event),
    admission: structuredClone(cursor.admission),
    provider_evidence: structuredClone(cursor.provider_evidence),
    next_command: null,
    requires_model_turn: false,
    replay: disposition === 'replayed' ? 'exact' : 'not-applicable',
  };
}

function cursorFromIntent(payload) {
  return {
    checkpoint_key: payload.checkpoint_key,
    context_sha256: payload.context_sha256,
    pre_restore_loop_hash: payload.pre_restore_loop_hash,
    owner_run_id: payload.owner_run_id,
    generation: payload.generation,
    runtime: payload.runtime,
    workstream_id: payload.workstream_id,
    episode_id: payload.episode_id,
    baseline_turns: payload.baseline_turns,
    restored_at: payload.timestamp,
    cycle: payload.cycle,
    restore_event: {
      seq: payload.planned_event.seq,
      checksum: payload.planned_event.checksum,
    },
    admission: structuredClone(payload.admission),
    provider_evidence: structuredClone(payload.provider_evidence),
  };
}

function cursorMatchesIntent(cursor, payload) {
  return JSON.stringify(cursor) === JSON.stringify(cursorFromIntent(payload));
}

function restoreCandidateFromIntent(loop, payload) {
  const candidate = structuredClone(loop);
  const session = ownerSession(candidate);
  session.compact_cursor = cursorFromIntent(payload);
  candidate.event_log_head = structuredClone(session.compact_cursor.restore_event);
  candidate.updated_at = payload.timestamp;
  return candidate;
}

function classifyHashFirstRestorePartial(root, runId, raw, intent) {
  // The compact-only pair is published hash-first. A retained intent is the sole
  // authority for interpreting that otherwise-invalid pair: the loop must still
  // be its exact predecessor and the anchor must name the exact derived candidate.
  if (!intent || raw.hashBytes === null
    || contentHash(raw.loopBytes) !== intent.payload.pre_loop_hash) return null;
  let parsed;
  try {
    parsed = parseHashVerifiedStateBytes(
      root,
      runId,
      raw.loopBytes,
      Buffer.from(intent.payload.pre_loop_hash),
      { requireSchema: true },
    );
  } catch {
    return null;
  }
  const candidate = restoreCandidateFromIntent(parsed.data, intent.payload);
  const checked = validate(candidate);
  if (!checked.ok) return null;
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2));
  const candidateHash = contentHash(candidateBytes);
  if (raw.hashBytes.toString('utf8') !== candidateHash) return null;
  return Object.freeze({ parsed });
}

function exactCursorReplay(loop, lines, context, request) {
  const session = ownerSession(loop);
  const cursor = session.compact_cursor;
  if (!cursor
    || cursor.checkpoint_key !== request.checkpointKey
    || cursor.context_sha256 !== request.contextSha256
    || cursor.pre_restore_loop_hash !== context.loop_hash
    || cursor.owner_run_id !== request.fence.owner
    || cursor.generation !== request.fence.generation
    || cursor.runtime !== request.runtime
    || cursor.workstream_id !== context.workstream.id
    || cursor.episode_id !== context.current_episode.id) return null;
  if (JSON.stringify(loop.event_log_head) !== JSON.stringify(cursor.restore_event)) return null;
  const event = lines[cursor.restore_event.seq - 1];
  if (!event || event.type !== 'compact-restored'
    || event.ts !== cursor.restored_at
    || event.checksum !== cursor.restore_event.checksum
    || !exactOrderedKeys(event.data, RESTORE_EVENT_DATA_KEYS)
    || JSON.stringify(event.data) !== JSON.stringify({
      operation_id: event.data.operation_id,
      checkpoint_key: cursor.checkpoint_key,
      context_sha256: cursor.context_sha256,
      pre_restore_loop_hash: cursor.pre_restore_loop_hash,
      owner_run_id: cursor.owner_run_id,
      generation: cursor.generation,
      runtime: cursor.runtime,
      workstream_id: cursor.workstream_id,
      episode_id: cursor.episode_id,
      baseline_turns: cursor.baseline_turns,
      cycle: cursor.cycle,
      admission: cursor.admission,
      provider_evidence: cursor.provider_evidence,
    })) return null;
  return cursor;
}

function classifyRestoreLog(raw, loop, intent) {
  const parsed = parseExactLogBytes(raw.logBytes);
  const payload = intent.payload;
  const preSeq = payload.pre_event_log_head.seq;
  if (parsed.lines.length < preSeq || parsed.lines.length > preSeq + 1
    || JSON.stringify(headOfLines(parsed.lines.slice(0, preSeq)))
      !== JSON.stringify(payload.pre_event_log_head)) {
    throw new Error('LOG_TAMPERED: compact restore predecessor');
  }
  const appended = parsed.lines.length === preSeq + 1;
  if (appended && !parsed.lineBytes[preSeq].equals(Buffer.from(payload.planned_event_line))) {
    throw new Error('LOG_TAMPERED: compact restore suffix');
  }
  const predecessorLoop = contentHash(raw.loopBytes) === payload.pre_loop_hash
    && JSON.stringify(loop.event_log_head) === JSON.stringify(payload.pre_event_log_head);
  const storedHash = raw.hashBytes?.toString('utf8') ?? '';
  const predecessor = predecessorLoop && storedHash === payload.pre_loop_hash;
  const hashFirstPartial = predecessorLoop
    && storedHash === contentHash(Buffer.from(JSON.stringify(
      restoreCandidateFromIntent(loop, payload),
      null,
      2,
    )));
  const candidate = cursorMatchesIntent(ownerSession(loop).compact_cursor, payload)
    && JSON.stringify(loop.event_log_head) === JSON.stringify({
      seq: payload.planned_event.seq, checksum: payload.planned_event.checksum,
    });
  if ((!predecessor && !hashFirstPartial && !candidate) || (candidate && !appended)) {
    throw new Error('LOG_TAMPERED: compact restore state');
  }
  return { parsed, appended, predecessor, hashFirstPartial, candidate };
}

function reconcileRestoreIntent(root, request, guard, loop, raw, intent, faultAt) {
  const classified = classifyRestoreLog(raw, loop, intent);
  const payload = intent.payload;
  if (!classified.appended) {
    appendDurableLine(logPath(root, request.runId), Buffer.from(payload.planned_event_line), guard, () => {}, 0);
    faultAt('event:appended');
  }
  if (classified.predecessor || classified.hashFirstPartial) {
    const candidate = restoreCandidateFromIntent(loop, payload);
    writeCompactRestoreState(root, request.runId, candidate, payload.timestamp);
    guard.renew();
    faultAt('state:written');
  }
  const committedRaw = readRawRun(root, request.runId);
  const committed = snapshotRaw(root, request.runId, committedRaw);
  if (!cursorMatchesIntent(ownerSession(committed.data).compact_cursor, payload)
    || !Buffer.from(committed.logBytes).subarray(-Buffer.byteLength(payload.planned_event_line))
      .equals(Buffer.from(payload.planned_event_line))) {
    throw new Error('LOG_TAMPERED: compact restore commit validation');
  }
  removeCompactRestoreIntentLocked(intent, guard, { faultAt });
  return {
    loop: committed.data,
    disposition: classified.candidate ? 'replayed' : 'committed',
  };
}

function commitOrReplayCompactRestoreInternal(root, runId, normalizedRequest, {
  now = Date.now(),
  faultAt = () => {},
} = {}) {
  const request = { ...normalizedRequest, runId };
  return withLock(root, runId, guard => {
    const raw = readRawRun(root, runId);
    let parsed;
    let retained;
    try {
      parsed = parseHashVerifiedStateBytes(root, runId, raw.loopBytes, raw.hashBytes, {
        requireSchema: true,
      });
    } catch (error) {
      if (!String(error?.message || error).startsWith('STATE_TAMPERED:')) throw error;
      retained = findCompactRestoreIntentLocked(runDir(root, runId), runId, guard);
      const partial = classifyHashFirstRestorePartial(root, runId, raw, retained);
      if (!partial) throw error;
      parsed = partial.parsed;
    }
    const loop = parsed.data;
    assertProjectRootBinding(root, loop);
    assertRestoreFence(loop, request);
    const affinity = restoreAffinity(loop);
    if (reconcileCompactPruneTombstonesLocked(root, runId, guard, {
      checkpointKey: request.checkpointKey,
    })) {
      throw new Error('CHECKPOINT_INELIGIBLE');
    }
    const strict = strictRestoreFile(root, runId, request);
    request.contextSha256 = strict.envelope.payload.context_sha256;
    assertCheckpointRestoreIdentity(root, loop, request, strict.context, affinity);
    const proof = validateRestoreAdmission(
      runDir(root, runId), request, strict.context, affinity, loop, guard,
    );
    retained ??= findCompactRestoreIntentLocked(runDir(root, runId), runId, guard);
    if (retained) {
      if (retained.payload.request_binding_sha256 !== proof.requestBindingSha256
        || JSON.stringify(retained.payload.request_binding) !== JSON.stringify(proof.requestBinding)) {
        throw new Error('CHECKPOINT_RESTORE_REQUEST_MISMATCH');
      }
      assertNoUnresolvedGenericPublicationLocked(root, runId, guard);
      const recovered = reconcileRestoreIntent(root, request, guard, loop, raw, retained, faultAt);
      return restoreDescriptor(request, ownerSession(recovered.loop).compact_cursor, recovered.disposition);
    }

    const log = parseExactLogBytes(raw.logBytes);
    const head = verifyHeadLines(log.lines, loop.event_log_head);
    if (!head.ok) throw new Error(`LOG_TAMPERED: ${head.errors.join('; ')}`);
    const baselineTurns = affinity.session.turns;
    const replay = exactCursorReplay(loop, log.lines, strict.context, request);
    if (replay) {
      assertNoUnresolvedGenericPublicationLocked(root, runId, guard);
      return restoreDescriptor(request, replay, 'replayed');
    }

    validateStrictBytes(strict.bytes, {
      runId,
      key: request.checkpointKey,
      expectedContext: (context, generatedAt) => expectedRestoreContext(
        root, runId, loop, parsed.hash, context.provider_evidence, generatedAt,
      ),
      hostSessionEvidence: undefined,
      freshNextAction: () => nextAction(loop, { now, unattended: false }),
    });
    assertNoUnresolvedGenericPublicationLocked(root, runId, guard);
    const timestamp = operationTimestamp(now);
    const operationId = ulid(Date.parse(timestamp));
    const cycle = affinity.session.compact_cursor ? affinity.session.compact_cursor.cycle + 1 : 1;
    const data = {
      operation_id: operationId,
      checkpoint_key: request.checkpointKey,
      context_sha256: request.contextSha256,
      pre_restore_loop_hash: strict.context.loop_hash,
      owner_run_id: request.fence.owner,
      generation: request.fence.generation,
      runtime: request.runtime,
      workstream_id: affinity.workstream.id,
      episode_id: affinity.episode.id,
      baseline_turns: baselineTurns,
      cycle,
      admission: proof.admission,
      provider_evidence: proof.providerEvidence,
    };
    const event = nextEvent(log.lines, { type: 'compact-restored', data, now: timestamp });
    const plannedEventLine = `${JSON.stringify(event)}\n`;
    const payload = {
      operation_id: operationId,
      pre_event_log_head: structuredClone(loop.event_log_head),
      pre_loop_hash: parsed.hash,
      checkpoint_key: request.checkpointKey,
      context_sha256: request.contextSha256,
      pre_restore_loop_hash: strict.context.loop_hash,
      owner_run_id: request.fence.owner,
      generation: request.fence.generation,
      runtime: request.runtime,
      workstream_id: affinity.workstream.id,
      episode_id: affinity.episode.id,
      baseline_turns: baselineTurns,
      cycle,
      admission: proof.admission,
      provider_evidence: proof.providerEvidence,
      request_binding: proof.requestBinding,
      request_binding_sha256: proof.requestBindingSha256,
      timestamp,
      planned_event_line: plannedEventLine,
      planned_event_sha256: contentHash(plannedEventLine),
      planned_event: {
        seq: event.seq, type: event.type, data: event.data, checksum: event.checksum,
      },
    };
    const intent = writeCompactRestoreIntentLocked(runDir(root, runId), runId, payload, guard, { faultAt });
    const recovered = reconcileRestoreIntent(root, request, guard, loop, raw, intent, faultAt);
    return restoreDescriptor(request, ownerSession(recovered.loop).compact_cursor, recovered.disposition);
  });
}

export function commitOrReplayCompactRestore(root, runId, normalizedRequest, options = {}) {
  return commitOrReplayCompactRestoreInternal(root, runId, normalizedRequest, { now: options.now });
}

export function __testCommitOrReplayCompactRestore(
  root,
  runId,
  normalizedRequest,
  { now = Date.now(), faultAt: requestedFault } = {},
) {
  if (!RESTORE_FAULTS.has(requestedFault)) throw new Error('TEST_FAULT_INVALID');
  let armed = true;
  return commitOrReplayCompactRestoreInternal(root, runId, normalizedRequest, {
    now,
    faultAt(label) {
      if (armed && label === requestedFault) {
        armed = false;
        throw new Error(`TEST_FAULT:${label}`);
      }
    },
  });
}

export function appendEvent(root, runId, { type, data, now }) {
  const event = nextEvent(readLines(root, runId), { type, data, now });
  appendFileSync(logPath(root, runId), JSON.stringify(event) + '\n');
  return event;
}

// line-based 검증 — 호출자가 이미 읽어둔 in-memory 배열을 검증한다. "검증한 배열 == 분석하는 배열"이
// 필요한 소비자(insights의 단일 읽기 스냅샷)가 디스크 재읽기 없이 쓴다 (impl-R2 🟡2: verifyHead와
// readLines 사이 concurrent append가 검증 밖 suffix로 유입되는 창 제거).
export function verifyLines(lines) {
  const errors = [];
  let prev = 'GENESIS';
  lines.forEach((e, i) => {
    if (e.seq !== i + 1) errors.push(`seq gap at ${i + 1}`);
    if (e.checksum !== checksumFor(e.seq, e.ts, e.type, e.data, prev)) errors.push(`checksum break at seq ${e.seq}`);
    if (e.type === 'cost' && !validCost(e.data)) errors.push(`invalid cost data at seq ${e.seq}`);
    prev = e.checksum;
  });
  return { ok: errors.length === 0, errors };
}

export function verifyLog(root, runId) {
  return verifyLines(readLines(root, runId));
}

// cost turns/tokens는 유한 비음수만 허용 (음수 주입으로 spent를 낮추는 우회 차단, Codex impl 🔴2)
export function validCost(d) {
  return d && Number.isFinite(d.turns) && d.turns >= 0 && Number.isFinite(d.tokens) && d.tokens >= 0;
}

export function recomputeSpent(root, runId) {
  return readLines(root, runId).filter(e => e.type === 'cost').reduce((acc, e) => {
    if (!validCost(e.data)) throw new Error(`LOG_CORRUPT: invalid cost event at seq ${e.seq}`);
    return { turns: acc.turns + e.data.turns, tokens: acc.tokens + e.data.tokens };
  }, { turns: 0, tokens: 0 });
}

// 마지막 이벤트의 head {seq, checksum} (빈 로그면 GENESIS) — loop.json 앵커와 대조용 (Codex impl 🔴3)
export function headOfLines(lines) {
  return lines.length ? { seq: lines[lines.length - 1].seq, checksum: lines[lines.length - 1].checksum } : { seq: 0, checksum: 'GENESIS' };
}

export function lastLogHead(root, runId) {
  return headOfLines(readLines(root, runId));
}

// 로그 tail이 기대 head와 일치하는지 — suffix truncation 탐지. line-based 변형은 verifyLines와 같은
// 이유(검증 배열과 소비 배열의 동일성)로 존재한다.
export function verifyHeadLines(lines, expected) {
  const exp = expected || { seq: 0, checksum: 'GENESIS' };
  const head = headOfLines(lines);
  if (head.seq !== exp.seq || head.checksum !== exp.checksum) {
    return { ok: false, errors: [`log head ${head.seq}/${head.checksum} != anchor ${exp.seq}/${exp.checksum}`] };
  }
  return { ok: true, errors: [] };
}

export function verifyHead(root, runId, expected) {
  return verifyHeadLines(readLines(root, runId), expected);
}

// 단일 anchored append 경로 — 이벤트 append + loop.json의 event_log_head 앵커 갱신을 한 lock 안에서.
// 모든 이벤트 기록(cost 포함)은 이 경로를 통해야 앵커가 stale되지 않는다 (Codex impl r2 🟡).
// mutate(loop, spent): 호출자별 상태 변경(예: budget.spent) — 선택.
// preCheck(loop): lock 안 fresh loop 위에서 실행 — throw하면 append 전에 중단 (Codex r3 🔴: 가드 원자성).
// opts.floor (#3): a business-intent mutation is charged a minimum floor of `opts.floor` turns via a PAIRED cost
// event appended in the SAME lock/anchor, so a driver cannot neutralize the turns budget / per_session_turn_cap by
// under-reporting or skipping `budget record`. Omitting floor (control-plane appends, recordCost) keeps the old
// behavior exactly — floor is strictly opt-in.
export function appendAnchored(root, runId, { type, data, now }, mutate, preCheck, opts = {}) {
  return withLock(root, runId, guard => {
    const rootRecovery = opts.rootRecovery === true;
    const publication = opts.publication ? materializePublication(opts.publication) : null;
    if (compactRestoreIntentCandidateLocked(root, runId, guard)) {
      const raw = readRawRun(root, runId);
      const authorized = parseHashVerifiedStateBytes(root, runId, raw.loopBytes, raw.hashBytes, {
        requireSchema: false,
      });
      const authorizationLoop = structuredClone(authorized.data);
      if (rootRecovery) {
        const binding = classifyProjectRootBinding(root, authorizationLoop.project?.root);
        if (binding.mismatch_class === 'fenced') {
          throw new Error('PROJECT_ROOT_FENCED: stored project root still resolves');
        }
        if (binding.mismatch_class !== 'unresolvable') {
          throw new Error('PROJECT_ROOT_REBIND_NOT_ALLOWED: project root already matches');
        }
      } else {
        assertProjectRootBinding(root, authorizationLoop);
      }
      if (preCheck) preCheck(authorizationLoop, { guard });
      if (!rootRecovery
        && (authorizationLoop.status === 'completed' || authorizationLoop.status === 'stopped')) {
        throw new Error('RUN_TERMINAL: append');
      }
      assertNoCompactRestoreIntentLocked(root, runId, guard);
    }
    reconcileAnchoredPublicationLocked(root, runId, guard, {
      faultAt: publication?.faultAt,
      forceUnlinkReplacement: publication?.forceUnlinkReplacement,
      durableWriteFn: publication?.durableWriteFn,
      rootRecovery,
    });
    if (publication && existsSync(join(runDir(root, runId), 'transactions'))) {
      const existing = findPreparedPublicationLocked(runDir(root, runId), guard);
      if (existing?.manifest.operationId === publication.operationId
        && publicationCommittedLocked(runDir(root, runId), guard, existing)) {
        return committedRetryResult(existing, publication, { type, data }, opts.floor, now);
      }
    }
    if (existsSync(join(runDir(root, runId), 'transactions'))) {
      retireCommittedPublicationLocked(runDir(root, runId), guard);
    }
    const before = snapshotRaw(root, runId, readRawRun(root, runId), {
      requireSchema: false,
      requireProjectBinding: !rootRecovery,
    });
    const loop = structuredClone(before.data);
    // Defense in depth at the shared mutation gateway: this check stays inside the existing lock and precedes
    // caller guards and event writes. readState is already strict, so no unbound reader is exposed here.
    if (rootRecovery) {
      const binding = classifyProjectRootBinding(root, loop.project?.root);
      if (binding.mismatch_class === 'fenced') {
        throw new Error('PROJECT_ROOT_FENCED: stored project root still resolves');
      }
      if (binding.mismatch_class !== 'unresolvable') {
        throw new Error('PROJECT_ROOT_REBIND_NOT_ALLOWED: project root already matches');
      }
    } else {
      assertProjectRootBinding(root, loop);
    }
    // #8 (spec §3.2 note 8): a test-only seam between reconciliation and the caller guard. Strictly opt-in —
    // omitting it is not merely a no-op call, there is no call at all. Callers expose it under a __test* name.
    if (opts.preCheckSeam) opts.preCheckSeam(loop, { guard });
    // #6 (spec §3.2 note 6): the guard ctx is ALWAYS passed. Callers whose preCheck needs a `…Locked` helper
    // (lease.mjs / recover.mjs capsule validation) read it here; a preCheck declaring only (loop) is unaffected.
    if (preCheck) preCheck(loop, { guard });   // throws BEFORE append → anchor stays consistent
    // Invariant: do not add a throwing guard after preCheck; preCheck side effects are coupled to this ordering.
    // v1.6 gateway terminal gate (spec §2.1.5): 반드시 caller preCheck **뒤** — fence-first 보존
    // (LEASE_FENCED/RESPAWN_FENCED/RUN_TERMINAL:emitHandoff 등 특정-에러 경로가 먼저 발화해야 한다).
    // 여기 도달했는데 terminal이면 "어떤 preCheck도 못 잡은" fence-less 경로 — 최후 방벽.
    // finish 이벤트는 preCheck 시점 non-terminal(전이는 mutate 단계)이라 자연 통과; double-finish는 차단된다.
    if (!rootRecovery && (loop.status === 'completed' || loop.status === 'stopped')) {
      throw new Error('RUN_TERMINAL: append');
    }
    // Codex impl r12 🔴: verify the existing log (chain + tail vs stored anchor) BEFORE appending. Otherwise a
    // suffix-truncated/tampered log would be laundered — a new append + fresh anchor would hide the loss and
    // reconcileBudget would no longer detect it. Fail-stop here keeps the anchor honest.
    const timestamp = operationTimestamp(now ?? publication?.nowFn?.());
    const frozenData = deepFreeze(structuredClone(data));
    const event = deepFreeze(nextEvent(before.logLines, { type, data: frozenData, now: timestamp }));
    const events = [event];
    if (opts.additionalEvents !== undefined) {
      if (!Array.isArray(opts.additionalEvents)) {
        throw new Error('TRANSACTION_INVALID: additional events');
      }
      for (const additional of opts.additionalEvents) {
        if (!additional || typeof additional.type !== 'string' || additional.type.length === 0
          || additional.data == null || typeof additional.data !== 'object'
          || Array.isArray(additional.data)) {
          throw new Error('TRANSACTION_INVALID: additional event shape');
        }
        events.push(deepFreeze(nextEvent([...before.logLines, ...events], {
          type: additional.type,
          data: deepFreeze(structuredClone(additional.data)),
          now: timestamp,
        })));
      }
    }
    // Paired floor cost — SAME lock/anchor as the mutation event, so verifyHead/reconcileBudget stay consistent.
    // impl-R1 Fix 1: tag the floor with the CURRENT lease owner+generation. recordCost only absorbs floors from its
    // OWN session, so an explicit report in a LATER session cannot swallow an EARLIER session's floors (which are
    // confirmed prior consumption) — that would undercount total spent and weaken per_session_turn_cap.
    if (opts.floor) {
      const lease = loop.session_chain?.lease || {};
      events.push(deepFreeze(nextEvent([...before.logLines, ...events], {
        type: 'cost',
        data: { turns: opts.floor, tokens: 0, auto_floor: true, for: type, owner: lease.owner_run_id, generation: lease.generation },
        now: timestamp,
      })));
    }
    loop.event_log_head = headOfLines([...before.logLines, ...events]);
    const spent = (mutate || opts.floor)
      ? [...before.logLines, ...events].filter(item => item.type === 'cost').reduce((acc, item) => {
        if (!validCost(item.data)) throw new Error(`LOG_CORRUPT: invalid cost event at seq ${item.seq}`);
        return { turns: acc.turns + item.data.turns, tokens: acc.tokens + item.data.tokens };
      }, { turns: 0, tokens: 0 })
      : null;
    if (opts.floor || opts.additionalEvents?.length) {
      loop.budget.spent = spent.turns;
      loop.budget.tokens_spent = spent.tokens;
      // per_session_turn_cap is judged off the lease owner's session.turns (next-action.mjs) — bump it here so
      // the floor drives the handoff cadence (= human checkpoints) too, not only budget.spent.
      const owner = loop.session_chain?.lease?.owner_run_id;
      const sess = (loop.session_chain?.sessions || []).find(s => s.run_id === owner);
      if (opts.floor && sess) sess.turns = (sess.turns || 0) + opts.floor;
      for (const item of events.slice(1, 1 + (opts.additionalEvents?.length || 0))) {
        if (item.type !== 'cost' || !validCost(item.data)) continue;
        const origin = (loop.session_chain?.sessions || []).find(
          session => session.run_id === item.data.owner,
        );
        if (origin) origin.turns = (origin.turns || 0) + item.data.turns;
      }
    }
    const tx = deepFreeze({
      event,
      event_identity: deepFreeze({ seq: event.seq, checksum: event.checksum }),
    });
    if (mutate) mutate(loop, spent, tx);
    loop.updated_at = timestamp;
    assertProjectRootBinding(root, loop);
    const checked = validate(loop);
    if (!checked.ok) throw new Error(`STATE_INVALID: ${checked.errors.join('; ')}`);

    if (!publication) {
      // #7 (spec §3.2 note 7): the publication path already has faultAt barriers; the non-publication path had
      // none, so a crash between the log append and writeState was unreproducible. Opt-in by OBSERVABLE
      // behavior, not by call count — omitting opts.faultAt normalizes to a no-op that still runs twice, so the
      // durable effects are unchanged but the body is not literally the old one. (Contrast #8 above, where the
      // `if (opts.preCheckSeam)` guard means there is genuinely no call.)
      // NOTE: this channel is scoped to the non-publication branch. A publication call must pass
      // opts.publication.faultAt instead (see :792 / materializePublication at :217) — the two share a name at
      // different depths, and handing opts.faultAt to a publication call silently arms nothing.
      const faultAt = opts.faultAt || (() => {});
      for (const item of events) appendFileSync(logPath(root, runId), `${JSON.stringify(item)}\n`);
      faultAt('event:appended');               // log committed, state not yet — the half-commit window
      writeState(root, runId, loop);
      faultAt('state:written');                // both committed, caller has not observed the return yet
      return undefined;
    }

    const dir = (realpathSync.native || realpathSync)(runDir(root, runId));
    const candidateBytes = Buffer.from(JSON.stringify(loop, null, 2));
    const candidateLoopHash = contentHash(candidateBytes);
    const candidateHashBytes = Buffer.from(candidateLoopHash);
    const publicationArtifacts = publication.artifactFactory
      ? publication.artifactFactory({
        candidateLoopHash,
        event: structuredClone(event),
        eventIdentity: structuredClone(tx.event_identity),
        timestamp,
      })
      : publication.artifacts;
    const stages = publicationArtifacts.map(artifact => ({
      role: 'artifact', target_rel: artifact.rel, bytes: artifact.bytes,
    }));
    const targets = publicationArtifacts.map((artifact, stageIndex) => ({
      role: 'artifact',
      rel: artifact.rel,
      stage_index: stageIndex,
      candidate_sha256: contentHash(artifact.bytes),
      candidate_size: String(artifact.bytes.length),
      predecessor: stableArtifactPredecessor(dir, artifact.rel),
    }));
    const eventLines = events.map(item => {
      const bytes = Buffer.from(`${JSON.stringify(item)}\n`);
      const stage_index = stages.length;
      stages.push({ role: 'event-line', target_rel: null, bytes });
      return {
        stage_index,
        seq: item.seq,
        checksum: item.checksum,
        sha256: contentHash(bytes),
        size: String(bytes.length),
      };
    });
    stages.push({ role: 'candidate-loop', target_rel: null, bytes: candidateBytes });
    stages.push({ role: 'candidate-loop-hash', target_rel: null, bytes: candidateHashBytes });
    const lease = before.data.session_chain?.lease;
    if (!lease || typeof lease.owner_run_id !== 'string'
      || !Number.isSafeInteger(lease.generation) || lease.generation < 1) {
      throw new Error('TRANSACTION_INVALID: publication fence');
    }
    const manifest = {
      kind: publication.kind,
      operationId: publication.operationId,
      expect: { owner: lease.owner_run_id, generation: lease.generation },
      runtime: before.data.autonomy?.session_runtime,
      projectRoot: canonicalProjectRoot(root),
      preLoopHash: before.hash,
      preEventHead: structuredClone(before.data.event_log_head),
      eventLines,
      candidateLoopHash,
      topology: publication.topology,
      targets,
    };
    const prepared = preparePublicationStagesLocked(dir, guard, manifest, stages, {
      nowFn: () => Date.parse(timestamp),
      faultAt: publication.faultAt,
      durableWriteFn: publication.durableWriteFn,
    });
    if (!prepared.ok) throw new Error('TRANSACTION_NOT_PREPARED');
    try {
      reconcileAnchoredPublicationLocked(root, runId, guard, {
      faultAt: publication.faultAt,
      forceUnlinkReplacement: publication.forceUnlinkReplacement,
      durableWriteFn: publication.durableWriteFn,
      rootRecovery,
      });
    } catch (error) {
      const message = String(error?.message || error);
      if (message.startsWith('TRANSACTION_RECONCILIATION_REQUIRED') || message.startsWith('LOCK_')) throw error;
      throw new Error('TRANSACTION_PENDING: prepared publication requires reconciliation', { cause: error });
    }
    return { ok: true, event_identity: tx.event_identity, operation_id: publication.operationId };
  });
}
