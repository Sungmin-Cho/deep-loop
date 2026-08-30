import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, durableAtomicWrite, flushDirectory } from './atomic-write.mjs';
import { contentHash, ulid, unwrap, wrap } from './envelope.mjs';
import {
  captureStableFileIdentity,
  matchingStableFileIdentity,
  normalizePortableRelativePath,
} from './fs-safe.mjs';
import { nextAction } from './next-action.mjs';
import { canonicalProjectRoot, projectRootDigest } from './project-root.mjs';
import { compactSupportedOnHost, runtimeCapability, sessionRuntime, skillToken, validateSessionRuntime } from './runtime.mjs';
import { validate } from './schema.mjs';
import { isOpenScope, ownerSession } from './session-scope.mjs';
import { runDir, withReconciledMutationLock } from './state.mjs';
import {
  __testCommitOrReplayCompactRestore,
  assertEstablishedFence as assertFence,
  commitOrReplayCompactRestore,
  reconcileCompactPruneTombstonesLocked,
  withFencedReconciledMutationLock,
  withVerifiedReadLock,
  captureVerifiedRunSnapshot,
} from './integrity.mjs';
import {
  compactObservationRel,
  liveCompactRestorePairsLocked,
  readCompactObservationProofLocked,
} from './compact-restore-intent.mjs';
import {
  normalizeProviderEvidence,
  providerEvidenceProjection,
  readStableRegular,
  STRICT_CONTEXT_DOMAIN,
  STRICT_FILE,
  STRICT_SCHEMA_VERSION,
  validateStrictSelf,
} from './checkpoint-validation.mjs';

const KEEP = 5;
const LEGACY_FILE = /^[0-9A-HJKMNP-TV-Z]{26}-compact\.json$/;
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_CHECKPOINT_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_ARTIFACTS = 256;
const MAX_DESCRIPTOR_BYTES = 3072;
const TERMINAL_WORKSTREAM = new Set(['ready', 'merged', 'abandoned']);
const DESCRIPTOR_SLASH_COMMANDS = new Set([
  '/deep-loop-continue',
  '/deep-loop-discover',
  '/deep-loop-finish',
  '/deep-loop-handoff',
  '/deep-loop-status',
]);
function assertCompactHostEnabled(loop, runtime) {
  if (!compactSupportedOnHost(loop)) {
    throw new Error(`CHECKPOINT_RUNTIME_UNSUPPORTED: ${runtime} compact_supported=false`);
  }
}

const PRUNE_FILE = /^([0-9a-f]{64})-compact-prune\.json$/;
const INSPECT_KEYS = Object.freeze([
  'ok', 'phase', 'reason', 'checkpoint_rel', 'checkpoint_key', 'context_sha256',
  'pre_restore_loop_hash', 'owner_run_id', 'generation', 'runtime', 'workstream_id',
  'episode_id', 'trigger', 'cycle', 'admission', 'restore_event', 'next_command',
  'requires_model_turn', 'replay', 'provider_evidence',
]);

const TOP_KEYS = Object.freeze(['schema_version', 'envelope', 'payload']);
const ENVELOPE_KEYS = Object.freeze([
  'producer', 'artifact_kind', 'schema', 'run_id', 'parent_run_id',
  'generated_at', 'git', 'provenance',
]);
const PAYLOAD_KEYS = Object.freeze(['checkpoint_key', 'context', 'context_sha256']);
const CONTEXT_KEYS = Object.freeze([
  'run_id',
  'owner_run_id',
  'generation',
  'project_root_digest',
  'project_binding_generation',
  'runtime',
  'loop_hash',
  'scope',
  'workstream',
  'current_episode',
  'artifacts',
  'next_action',
  'provider_evidence',
]);
const LEGACY_PAYLOAD_KEYS = Object.freeze([
  'owner_run_id',
  'generation',
  'loop_hash',
  'current_episode',
  'current_episode_detail',
  'active_workstreams',
  'next_action_hint',
  'artifacts',
]);

const checkpointDir = (root, runId) => join(runDir(root, runId), 'checkpoints');
const checkpointRel = key => `checkpoints/${key}-compact.json`;
const strictPath = (root, runId, key) => join(checkpointDir(root, runId), `${key}-compact.json`);
const receiptPath = (root, runId, key) => join(
  checkpointDir(root, runId), `${key}-compact-observation.json`,
);
const prunePath = (root, runId, key) => join(checkpointDir(root, runId), `${key}-compact-prune.json`);
const canonicalIso = value => typeof value === 'string'
  && Number.isFinite(new Date(value).getTime())
  && new Date(value).toISOString() === value;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const compareLexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const exactKeys = (value, keys) => plainObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key, index) => Object.keys(value)[index] === key);

function authenticLegacy(loop) {
  let scope;
  try { scope = ownerSession(loop).scope; } catch { return false; }
  return scope?.kind === 'legacy'
    && loop?.autonomy?.continuation_policy !== 'workstream-session';
}

function assertCurrentSchema(loop) {
  const result = validate(loop);
  if (loop?.schema_version !== '0.4.0' || !result.ok) {
    throw new Error(`CHECKPOINT_STATE_INVALID: ${result.errors.join('; ')}`);
  }
}

function assertCheckpointDirectory(root, runId, { create = false } = {}) {
  const dir = checkpointDir(root, runId);
  if (!existsSync(dir)) {
    if (!create) return null;
    mkdirSync(dir, { recursive: true });
  }
  let lexical;
  try { lexical = lstatSync(dir); } catch { throw new Error('CHECKPOINT_PATH_INVALID'); }
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
    throw new Error('CHECKPOINT_PATH_INVALID');
  }
  const canonical = realpathSync(dir);
  if (canonical !== realpathSync(join(runDir(root, runId), 'checkpoints'))) {
    throw new Error('CHECKPOINT_PATH_INVALID');
  }
  return dir;
}

function observeArtifact(root, rel) {
  const normalized = normalizePortableRelativePath(rel);
  if (normalized === null || normalized !== rel) {
    throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${String(rel)}`);
  }
  let current = root;
  const segments = normalized.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    if (!existsSync(current)) {
      return { rel: normalized, state: 'absent', sha256: null, size: null };
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
    }
    const before = captureStableFileIdentity(current);
    const bytes = readFileSync(current);
    const after = captureStableFileIdentity(current);
    if (!matchingStableFileIdentity(before, after) || bytes.length !== stat.size) {
      throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
    }
    return {
      rel: normalized,
      state: 'present',
      sha256: contentHash(bytes),
      size: bytes.length,
      bytes: Buffer.from(bytes),
    };
  }
  throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
}

function affinity(loop) {
  const session = ownerSession(loop);
  const scope = session.scope;
  if (!isOpenScope(scope)
    || scope.closed_at !== null
    || !Number.isSafeInteger(scope.bound_at_seq)
    || scope.bound_at_seq < 1
    || typeof scope.workstream_id !== 'string'
    || scope.workstream_id.length === 0) {
    throw new Error('CHECKPOINT_AFFINITY_INVALID: owner scope is not open and bound');
  }
  const workstream = (loop.workstreams || []).find(item => item?.id === scope.workstream_id);
  const episode = (loop.episodes || []).find(item => item?.id === loop.current_episode);
  if (!workstream
    || TERMINAL_WORKSTREAM.has(workstream.status)
    || !episode
    || episode.workstream_id !== scope.workstream_id) {
    throw new Error('CHECKPOINT_AFFINITY_INVALID: current Workstream or episode mismatch');
  }
  const artifacts = [...new Set([
    ...(Array.isArray(episode.expected_artifacts) ? episode.expected_artifacts : []),
    ...(Array.isArray(episode.artifacts) ? episode.artifacts : []),
  ])].sort();
  if (artifacts.length > MAX_ARTIFACTS) {
    throw new Error('CHECKPOINT_AFFINITY_INVALID: artifact set too large');
  }
  return { scope, workstream, episode, artifacts };
}

function verifiedArtifact(artifactEvidence, rel) {
  const evidence = artifactEvidence?.[rel];
  if (!evidence || evidence.state === 'absent') {
    if (evidence?.state === 'absent') return { rel, state: 'absent', sha256: null, size: null };
    throw new Error('CHECKPOINT_ARTIFACT_INVALID');
  }
  if (evidence.state !== 'present' || !sha256(evidence.sha256)
    || !Number.isSafeInteger(evidence.size) || evidence.size < 0
    || typeof evidence.base64 !== 'string') throw new Error('CHECKPOINT_ARTIFACT_INVALID');
  const bytes = Buffer.from(evidence.base64, 'base64');
  if (bytes.length !== evidence.size || contentHash(bytes) !== evidence.sha256) {
    throw new Error('CHECKPOINT_ARTIFACT_INVALID');
  }
  return { rel, state: 'present', sha256: evidence.sha256, size: evidence.size };
}

function deriveContext(root, runId, snapshot, {
  now, providerEvidence, verifiedOnly = false, artifactEvidence = null,
}) {
  const { data: loop, hash } = snapshot;
  assertCurrentSchema(loop);
  if (loop.autonomy?.continuation_policy !== 'workstream-session') {
    throw new Error('CHECKPOINT_AFFINITY_INVALID: workstream-session required');
  }
  const { scope, workstream, episode, artifacts } = affinity(loop);
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
    artifacts: artifacts.map(rel => {
      const evidence = verifiedOnly
        ? verifiedArtifact(artifactEvidence, rel)
        : observeArtifact(root, rel);
      return {
        rel: evidence.rel,
        state: evidence.state,
        sha256: evidence.sha256,
        size: evidence.size,
      };
    }),
    next_action: nextAction(loop, { now, unattended: false }),
    provider_evidence: providerEvidence,
  };
}

function strictEnvelope(runId, context, now) {
  const contextSha = contentHash(JSON.stringify(context));
  const key = contentHash(JSON.stringify([STRICT_CONTEXT_DOMAIN, context]));
  const env = wrap({
    producer: 'deep-loop',
    artifact_kind: 'compact-checkpoint',
    schema: { name: 'compact-checkpoint', version: STRICT_SCHEMA_VERSION },
    run_id: runId,
    payload: {
      checkpoint_key: key,
      context,
      context_sha256: contextSha,
    },
    now: new Date(now).toISOString(),
  });
  return { env, key };
}

function validateStrictBytes(bytes, {
  root, runId, key, snapshot, now, hostSessionEvidence, verifiedOnly = false, artifactEvidence = null,
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_CHECKPOINT_BYTES) {
    throw new Error('CHECKPOINT_INVALID');
  }
  let env;
  try { env = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('CHECKPOINT_INVALID'); }
  const context = validateStrictSelf(env, { runId, key });
  const expected = deriveContext(root, runId, snapshot, {
    now: Date.parse(env.envelope.generated_at),
    providerEvidence: context.provider_evidence,
    verifiedOnly,
    artifactEvidence,
  });
  if (JSON.stringify(context) !== JSON.stringify(expected)) {
    throw new Error('CHECKPOINT_CONTEXT_MISMATCH');
  }
  const supplied = normalizeProviderEvidence(hostSessionEvidence);
  const providerEvidence = providerEvidenceProjection(context.provider_evidence, supplied);
  if (providerEvidence.recorded && providerEvidence.supplied && !providerEvidence.matched) {
    throw new Error('CHECKPOINT_EVIDENCE_MISMATCH');
  }
  return {
    env,
    context,
    freshNextAction: nextAction(snapshot.data, { now, unattended: false }),
    providerEvidence,
    evidenceMatched: supplied === null ? null : context.provider_evidence !== null,
  };
}

function captureDirectoryEntries(dir) {
  if (dir === null) return [];
  return Object.freeze(readdirSync(dir).sort().map(name => {
    const path = join(dir, name);
    let identity = null;
    let regular = false;
    let removable = false;
    try {
      const stat = lstatSync(path);
      identity = captureStableFileIdentity(path);
      regular = stat.isFile() && !stat.isSymbolicLink();
      removable = !stat.isDirectory();
    } catch {
      // Identity drift is treated as ineligible and cannot displace a valid checkpoint.
    }
    return Object.freeze({ name, path, identity, regular, removable });
  }));
}

function readCapturedStable(entry, invalidCode = 'CHECKPOINT_PATH_INVALID') {
  if (!entry.regular || !entry.identity) throw new Error(invalidCode);
  let before;
  try { before = captureStableFileIdentity(entry.path); } catch { throw new Error(invalidCode); }
  if (!matchingStableFileIdentity(entry.identity, before)) throw new Error(invalidCode);
  const bytes = readFileSync(entry.path);
  let after;
  try { after = captureStableFileIdentity(entry.path); } catch { throw new Error(invalidCode); }
  if (!matchingStableFileIdentity(before, after)
    || !matchingStableFileIdentity(entry.identity, after)) {
    throw new Error(invalidCode);
  }
  return bytes;
}

function capturedStrictMetadata(entry, runId) {
  const match = entry.name.match(STRICT_FILE);
  if (!match) throw new Error('CHECKPOINT_INVALID');
  const bytes = readCapturedStable(entry);
  if (bytes.length === 0 || bytes.length > MAX_CHECKPOINT_BYTES) {
    throw new Error('CHECKPOINT_INVALID');
  }
  let env;
  try { env = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('CHECKPOINT_INVALID'); }
  validateStrictSelf(env, { runId, key: match[1] });
  return {
    entry,
    bytes,
    key: match[1],
    rel: checkpointRel(match[1]),
    generatedAt: env.envelope.generated_at,
  };
}

function compareNewest(left, right) {
  const time = compareLexical(right.generatedAt, left.generatedAt);
  return time !== 0 ? time : compareLexical(left.rel, right.rel);
}

function removeCaptured(entry) {
  if (!entry.identity || !entry.removable) return false;
  let currentIdentity;
  try { currentIdentity = captureStableFileIdentity(entry.path); } catch { return false; }
  if (!matchingStableFileIdentity(entry.identity, currentIdentity)) return false;
  rmSync(entry.path, { force: true });
  return true;
}

function testFault(faultAt, seam) {
  if (typeof faultAt === 'function') faultAt(seam);
}

function tombstonedKeys(entries) {
  return new Set(entries.flatMap(entry => {
    const match = entry.name.match(PRUNE_FILE);
    return match ? [match[1]] : [];
  }));
}

function reconcilePruneTombstonesLocked(root, runId, guard) {
  return reconcileCompactPruneTombstonesLocked(root, runId, guard);
}

function pruneEnvelope(runId, key, checkpointSha256, contextSha256, receiptSha256, now) {
  return wrap({
    producer: 'deep-loop',
    artifact_kind: 'compact-prune',
    schema: { name: 'compact-prune', version: '1.0' },
    run_id: runId,
    provenance: {
      source_artifacts: [checkpointRel(key), compactObservationRel(key)],
      tool_versions: {},
    },
    payload: {
      checkpoint_key: key,
      checkpoint_sha256: checkpointSha256,
      context_sha256: contextSha256,
      receipt_sha256: receiptSha256,
    },
    now: new Date(now).toISOString(),
  });
}

function capturePruneArtifact(path, { optional = false } = {}) {
  try {
    const { bytes, identity } = readStableRegular(path, 'COMPACT_PRUNE_INVALID');
    return { bytes, identity, sha256: contentHash(bytes) };
  } catch (error) {
    if (optional && error?.message === 'CHECKPOINT_NOT_FOUND') return null;
    throw new Error('COMPACT_PRUNE_INVALID');
  }
}

function assertPruneArtifactUnchanged(path, captured) {
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

function pruneCheckpointPairLocked(root, runId, metadata, guard, {
  now,
  faultAt = () => {},
} = {}) {
  const dir = assertCheckpointDirectory(root, runId);
  if (dir === null) return false;
  const key = metadata.key;
  const checkpoint = strictPath(root, runId, key);
  const receipt = receiptPath(root, runId, key);
  const tombstone = prunePath(root, runId, key);
  const capturedCheckpoint = capturePruneArtifact(checkpoint);
  const checkpointSha256 = capturedCheckpoint.sha256;
  let contextSha256 = null;
  try {
    const env = JSON.parse(capturedCheckpoint.bytes.toString('utf8'));
    validateStrictSelf(env, { runId, key });
    contextSha256 = env.payload.context_sha256;
  } catch { /* invalid checkpoints are still pair-pruned */ }
  const capturedReceipt = capturePruneArtifact(receipt, { optional: true });
  const receiptSha256 = capturedReceipt?.sha256 ?? null;
  durableAtomicWrite(
    tombstone,
    JSON.stringify(pruneEnvelope(
      runId,
      key,
      checkpointSha256,
      contextSha256,
      receiptSha256,
      now,
    ), null, 2),
  );
  const capturedTombstone = capturePruneArtifact(tombstone);
  guard.renew();
  testFault(faultAt, 'prune:tombstone-written');
  assertPruneArtifactUnchanged(tombstone, capturedTombstone);
  assertPruneArtifactUnchanged(checkpoint, capturedCheckpoint);
  assertPruneArtifactUnchanged(receipt, capturedReceipt);
  if (capturedReceipt !== null) {
    assertPruneArtifactUnchanged(receipt, capturedReceipt);
    rmSync(receipt, { force: true });
    flushDirectory(dir);
  }
  guard.renew();
  testFault(faultAt, 'prune:receipt-unlinked');
  assertPruneArtifactUnchanged(checkpoint, capturedCheckpoint);
  if (capturedCheckpoint !== null) {
    rmSync(checkpoint, { force: true });
    flushDirectory(dir);
  }
  guard.renew();
  testFault(faultAt, 'prune:checkpoint-unlinked');
  assertPruneArtifactUnchanged(tombstone, capturedTombstone);
  rmSync(tombstone, { force: true });
  flushDirectory(dir);
  guard.renew();
  testFault(faultAt, 'prune:tombstone-cleanup');
  return true;
}

function pruneCapturedLocked(root, runId, guard, currentPath, {
  now,
  faultAt = () => {},
} = {}) {
  const dir = assertCheckpointDirectory(root, runId);
  if (dir === null) return;
  const entries = captureDirectoryEntries(dir);
  let count = entries.filter(entry => entry.removable && entry.name.endsWith('-compact.json')).length;
  if (count <= KEEP) return;
  const pinned = new Set(liveCompactRestorePairsLocked(runDir(root, runId), runId, guard)
    .map(pair => pair.checkpoint_rel));
  const invalid = [];
  const valid = [];
  for (const entry of entries) {
    if (!entry.removable || !entry.name.endsWith('-compact.json')) continue;
    try {
      valid.push(capturedStrictMetadata(entry, runId));
    } catch {
      invalid.push(entry);
    }
  }
  invalid.sort((left, right) => compareLexical(left.name, right.name));
  valid.sort((left, right) => {
    const time = compareLexical(left.generatedAt, right.generatedAt);
    return time !== 0 ? time : compareLexical(right.rel, left.rel);
  });
  const candidates = [
    ...invalid,
    ...valid.map(item => item.entry),
  ];
  for (const entry of candidates) {
    if (count <= KEEP) break;
    if (entry.path === currentPath) continue;
    const match = entry.name.match(STRICT_FILE);
    if (!match || pinned.has(checkpointRel(match[1]))) continue;
    if (pruneCheckpointPairLocked(root, runId, { key: match[1] }, guard, { now, faultAt })) {
      count -= 1;
    }
  }
}

function strictEmit(root, runId, guard, snapshot, options) {
  const runtime = assertFence(snapshot.data, options.fence, options.runtime);
  const providerEvidence = normalizeProviderEvidence(options.hostSessionEvidence);
  const context = deriveContext(root, runId, snapshot, {
    now: options.now,
    providerEvidence,
  });
  if (context.runtime !== runtime) throw new Error('RUNTIME_FENCED: context runtime mismatch');
  const { env, key } = strictEnvelope(runId, context, options.now);
  const bytes = Buffer.from(JSON.stringify(env, null, 2));
  if (bytes.length > MAX_CHECKPOINT_BYTES) throw new Error('CHECKPOINT_TOO_LARGE');

  const dir = assertCheckpointDirectory(root, runId, { create: true });
  const path = strictPath(root, runId, key);
  const rel = checkpointRel(key);
  const result = {
    ok: true,
    checkpoint_rel: rel,
    checkpoint_key: key,
    workstream_id: context.scope.workstream_id,
    created: true,
  };
  if (existsSync(path)) {
    let existing;
    try { existing = readStableRegular(path).bytes; } catch {
      throw new Error('CHECKPOINT_CONFLICT');
    }
    try {
      validateStrictBytes(existing, {
        root,
        runId,
        key,
        snapshot,
        now: options.now,
        hostSessionEvidence: options.hostSessionEvidence,
      });
    } catch {
      throw new Error('CHECKPOINT_CONFLICT');
    }
    pruneCapturedLocked(root, runId, guard, path, {
      now: options.now,
      faultAt: options.faultAt,
    });
    return { ...result, created: false };
  }
  durableAtomicWrite(path, bytes);
  guard.renew();
  pruneCapturedLocked(root, runId, guard, path, {
    now: options.now,
    faultAt: options.faultAt,
  });
  return result;
}

function legacyEmit(root, runId, snapshot, now) {
  const { data: loop, hash } = snapshot;
  const lease = loop.session_chain?.lease || {};
  const ep = (loop.episodes || []).find(episode => episode.id === loop.current_episode) || null;
  const na = nextAction(loop, { now, unattended: false });
  const payload = {
    owner_run_id: lease.owner_run_id,
    generation: lease.generation,
    loop_hash: hash,
    current_episode: loop.current_episode,
    current_episode_detail: ep ? {
      id: ep.id,
      role: ep.role,
      status: ep.status,
      point: ep.point,
      workstream_id: ep.workstream_id,
    } : null,
    active_workstreams: loop.active_workstreams || [],
    next_action_hint: { type: na.action.type, next_command: na.next_command },
    artifacts: ep && Array.isArray(ep.expected_artifacts) ? ep.expected_artifacts : [],
  };
  const env = wrap({
    producer: 'deep-loop',
    artifact_kind: 'compact-checkpoint',
    schema: { name: 'compact-checkpoint', version: '1.0' },
    run_id: runId,
    payload,
    now: new Date(now).toISOString(),
  });
  mkdirSync(checkpointDir(root, runId), { recursive: true });
  const path = join(checkpointDir(root, runId), `${ulid(now)}-compact.json`);
  atomicWrite(path, JSON.stringify(env, null, 2));
  legacyPrune(root, runId, lease.owner_run_id, lease.generation);
  return { ok: true, path };
}

export function emitCompactCheckpoint(root, runId, {
  fence,
  runtime,
  hostSessionEvidence,
  now = Date.now(),
} = {}) {
  return withFencedReconciledMutationLock(root, runId, (guard, snapshot) => {
    assertFence(snapshot.data, fence, runtime);
    assertCompactHostEnabled(snapshot.data, runtime);
    reconcilePruneTombstonesLocked(root, runId, guard);
    if (authenticLegacy(snapshot.data)) {
      assertFence(snapshot.data, fence, runtime);
      throw new Error('CHECKPOINT_LEGACY_TRUST_REQUIRED');
    }
    return strictEmit(root, runId, guard, snapshot, {
      fence,
      runtime,
      hostSessionEvidence,
      now,
    });
  }, { fence, runtime });
}

export function __testEmitCompactCheckpoint(root, runId, options = {}) {
  return withFencedReconciledMutationLock(root, runId, (guard, snapshot) => {
    assertFence(snapshot.data, options.fence, options.runtime);
    if (options.__testSkipHostGate !== true) {
      assertCompactHostEnabled(snapshot.data, options.runtime);
    }
    reconcilePruneTombstonesLocked(root, runId, guard);
    if (authenticLegacy(snapshot.data)) {
      assertFence(snapshot.data, options.fence, options.runtime);
      throw new Error('CHECKPOINT_LEGACY_TRUST_REQUIRED');
    }
    return strictEmit(root, runId, guard, snapshot, options);
  }, { fence: options.fence, runtime: options.runtime });
}

// Compatibility-only adapter for the installed PreCompact hook. Public callers must use
// emitCompactCheckpoint, whose fence/runtime/status checks never downgrade to v1 semantics.
export function emitLegacyCompactCheckpointFromTrustedHook(root, runId, {
  now = Date.now(),
} = {}) {
  return withReconciledMutationLock(root, runId, (_guard, snapshot) => {
    if (!authenticLegacy(snapshot.data)) {
      throw new Error('CHECKPOINT_LEGACY_POLICY_REQUIRED');
    }
    return legacyEmit(root, runId, snapshot, now);
  });
}

function strictRel(value) {
  if (typeof value !== 'string'
    || value.includes('\0')
    || value.includes('\\')
    || normalizePortableRelativePath(value) !== value) {
    throw new Error('CHECKPOINT_REL_INVALID');
  }
  const match = value.match(/^checkpoints\/([0-9a-f]{64})-compact\.json$/);
  if (!match) throw new Error('CHECKPOINT_REL_INVALID');
  return match[1];
}

function pathBearing(value) {
  return value.includes('/')
    || value.includes('\\');
}

function stringSummary(value) {
  return {
    sha256: contentHash(value),
    utf8_bytes: Buffer.byteLength(value),
  };
}

function boundedDescriptorValue(value, depth = 0) {
  if (typeof value === 'string') {
    if (DESCRIPTOR_SLASH_COMMANDS.has(value)
      || (Buffer.byteLength(value) <= 192 && !pathBearing(value))) {
      return value;
    }
    return stringSummary(value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    if (value.length > 8 || depth >= 3) return {
      sha256: contentHash(JSON.stringify(value)),
      items: value.length,
    };
    return value.map(item => boundedDescriptorValue(item, depth + 1));
  }
  if (!plainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 16 || depth >= 4) return {
    sha256: contentHash(JSON.stringify(value)),
    keys: entries.length,
  };
  return Object.fromEntries(entries.map(([key, item]) => [
    key,
    boundedDescriptorValue(item, depth + 1),
  ]));
}

function summarizeScope(value) {
  return boundedDescriptorValue({
    kind: value.kind,
    workstream_id: value.workstream_id,
    bound_at_seq: value.bound_at_seq,
    terminal_event: value.terminal_event,
    closed_at: value.closed_at,
    superseded_at: value.superseded_at,
  });
}

function summarizeWorkstream(value) {
  return {
    id: boundedDescriptorValue(value.id),
    status: boundedDescriptorValue(value.status),
    worktree: boundedDescriptorValue(value.worktree),
  };
}

function summarizeEpisode(value) {
  return {
    id: boundedDescriptorValue(value.id),
    role: boundedDescriptorValue(value.role),
    status: boundedDescriptorValue(value.status),
    point: boundedDescriptorValue(value.point),
    workstream_id: boundedDescriptorValue(value.workstream_id),
  };
}

function descriptor(rel, key, validation) {
  const { context, evidenceMatched, freshNextAction } = validation;
  const result = {
    ok: true,
    checkpoint_rel: rel,
    checkpoint_key: key,
    owner_run_id: boundedDescriptorValue(context.owner_run_id),
    generation: context.generation,
    runtime: context.runtime,
    scope: summarizeScope(context.scope),
    workstream: summarizeWorkstream(context.workstream),
    current_episode: summarizeEpisode(context.current_episode),
    next_action: boundedDescriptorValue(freshNextAction),
    context_sha256: contentHash(JSON.stringify(context)),
    provider_evidence: {
      present: context.provider_evidence !== null,
      matched: evidenceMatched,
    },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_DESCRIPTOR_BYTES) {
    result.scope = {
      kind: boundedDescriptorValue(context.scope.kind),
      workstream_id: boundedDescriptorValue(context.scope.workstream_id),
      bound_at_seq: context.scope.bound_at_seq,
    };
    result.workstream = {
      id: boundedDescriptorValue(context.workstream.id),
      status: boundedDescriptorValue(context.workstream.status),
    };
    result.current_episode = summarizeEpisode(context.current_episode);
    result.next_action = {
      action: { type: boundedDescriptorValue(freshNextAction?.action?.type) },
      next_command: boundedDescriptorValue(freshNextAction?.next_command),
    };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_DESCRIPTOR_BYTES) {
    result.scope = {
      kind: boundedDescriptorValue(context.scope.kind),
      sha256: contentHash(JSON.stringify(context.scope)),
    };
    result.workstream = {
      id: boundedDescriptorValue(context.workstream.id),
      status: boundedDescriptorValue(context.workstream.status),
    };
    result.current_episode = {
      id: boundedDescriptorValue(context.current_episode.id),
      point: boundedDescriptorValue(context.current_episode.point),
    };
    result.next_action = {
      action: { type: boundedDescriptorValue(freshNextAction?.action?.type) },
    };
  }
  return result;
}

function emptyProjection(reason, providerEvidence = {
  recorded: false, supplied: false, matched: false,
}) {
  return Object.fromEntries(INSPECT_KEYS.map(key => [key,
    key === 'ok' ? false
      : key === 'phase' ? 'none'
        : key === 'reason' ? reason
          : key === 'requires_model_turn' ? false
            : key === 'replay' ? 'not-applicable'
              : key === 'provider_evidence' ? structuredClone(providerEvidence)
                : null]));
}

function frozenSafeDescriptor(value) {
  const clone = JSON.parse(JSON.stringify(value));
  const freeze = item => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(clone);
}

function restoreCommand(runtime) {
  return skillToken(runtime, 'deep-loop-compact restore');
}

function successProjection(phase, candidate, {
  providerEvidence,
  receipt = null,
  cursor = null,
  loop,
} = {}) {
  const context = candidate.context;
  const restored = phase === 'restored';
  const compacted = phase === 'compacted';
  const admission = restored
    ? structuredClone(cursor.admission)
    : compacted
      ? { kind: 'postcompact-observation', source: null, receipt_trigger: receipt.payload.trigger }
      : null;
  return {
    ok: true,
    phase,
    reason: null,
    checkpoint_rel: candidate.rel,
    checkpoint_key: candidate.key,
    context_sha256: restored ? cursor.context_sha256 : candidate.contextSha256,
    pre_restore_loop_hash: restored ? cursor.pre_restore_loop_hash : context.loop_hash,
    owner_run_id: restored ? cursor.owner_run_id : context.owner_run_id,
    generation: restored ? cursor.generation : context.generation,
    runtime: restored ? cursor.runtime : context.runtime,
    workstream_id: restored ? cursor.workstream_id : context.workstream.id,
    episode_id: restored ? cursor.episode_id : context.current_episode.id,
    trigger: restored ? cursor.admission.receipt_trigger : compacted ? receipt.payload.trigger : null,
    cycle: restored ? cursor.cycle : null,
    admission,
    restore_event: restored ? structuredClone(cursor.restore_event) : null,
    next_command: restored ? null : restoreCommand(context.runtime),
    requires_model_turn: !restored,
    replay: restored
      ? JSON.stringify(loop.event_log_head) === JSON.stringify(cursor.restore_event) ? 'exact' : 'stale'
      : 'eligible',
    provider_evidence: restored
      ? structuredClone(cursor.provider_evidence)
      : structuredClone(providerEvidence),
  };
}

function cursorCandidate(loop, entries, runId, tombstones) {
  const session = ownerSession(loop);
  const cursor = session.compact_cursor;
  if (!cursor || tombstones.has(cursor.checkpoint_key)) return null;
  const entry = entries.find(item => item.name === `${cursor.checkpoint_key}-compact.json`);
  if (!entry) return null;
  try {
    const metadata = capturedStrictMetadata(entry, runId);
    const env = JSON.parse(metadata.bytes.toString('utf8'));
    const context = validateStrictSelf(env, { runId, key: metadata.key });
    if (metadata.key !== cursor.checkpoint_key
      || env.payload.context_sha256 !== cursor.context_sha256
      || context.loop_hash !== cursor.pre_restore_loop_hash
      || context.owner_run_id !== cursor.owner_run_id
      || context.generation !== cursor.generation
      || context.runtime !== cursor.runtime
      || context.workstream.id !== cursor.workstream_id
      || context.current_episode.id !== cursor.episode_id) return null;
    return {
      ...metadata,
      context,
      contextSha256: env.payload.context_sha256,
      cursor,
      kind: 'cursor',
    };
  } catch {
    return null;
  }
}

function currentCandidates(root, runId, snapshot, now, entries, tombstones) {
  const candidates = [];
  for (const entry of entries) {
    try {
      const metadata = capturedStrictMetadata(entry, runId);
      if (tombstones.has(metadata.key)) continue;
      const validation = validateStrictBytes(metadata.bytes, {
        root,
        runId,
        key: metadata.key,
        snapshot,
        now,
        hostSessionEvidence: undefined,
      });
      candidates.push({
        ...metadata,
        context: validation.context,
        contextSha256: validation.env.payload.context_sha256,
        kind: 'current',
      });
    } catch {
      // Invalid, stale, foreign, or replaced entries remain globally ineligible.
    }
  }
  return candidates;
}

function selectedCandidate(root, runId, snapshot, now, entries) {
  const tombstones = tombstonedKeys(entries);
  const candidates = currentCandidates(root, runId, snapshot, now, entries, tombstones);
  const cursor = cursorCandidate(snapshot.data, entries, runId, tombstones);
  if (cursor) {
    const same = candidates.find(candidate => candidate.key === cursor.key);
    if (same) candidates.splice(candidates.indexOf(same), 1);
    candidates.push(cursor);
  }
  candidates.sort(compareNewest);
  return candidates[0] ?? null;
}

function readSelectedReceipt(root, runId, candidate, guard) {
  const expected = {
    checkpoint_key: candidate.key,
    context_sha256: candidate.contextSha256,
    owner_run_id: candidate.context.owner_run_id,
    generation: candidate.context.generation,
    runtime: candidate.context.runtime,
    workstream_id: candidate.context.workstream.id,
    episode_id: candidate.context.current_episode.id,
  };
  try {
    return readCompactObservationProofLocked(
      runDir(root, runId), runId, candidate.rel, expected, guard,
    );
  } catch (error) {
    if (String(error?.message || error).includes('CHECKPOINT_RECEIPT_REQUIRED')) return null;
    return { invalid: true };
  }
}

function inspectLocked(root, runId, guard, snapshot, {
  hostSessionEvidence,
  now,
} = {}) {
  assertCurrentSchema(snapshot.data);
  if (['completed', 'stopped', 'paused'].includes(snapshot.data.status)) {
    return emptyProjection('run-not-resumable');
  }
  if (snapshot.data.autonomy?.continuation_policy !== 'workstream-session') return null;
  try { affinity(snapshot.data); } catch { return emptyProjection('affinity-not-open'); }
  const dir = assertCheckpointDirectory(root, runId);
  if (dir === null) return emptyProjection('checkpoint-not-found');
  const entries = captureDirectoryEntries(dir);
  const selected = selectedCandidate(root, runId, snapshot, now, entries);
  if (!selected) {
    return emptyProjection(entries.some(entry => entry.name.endsWith('-compact.json'))
      ? 'checkpoint-ineligible'
      : 'checkpoint-not-found');
  }
  const supplied = normalizeProviderEvidence(
    plainObject(hostSessionEvidence)
      && Object.keys(hostSessionEvidence).length === 1
      && typeof hostSessionEvidence.id === 'string'
      ? {
        provider: runtimeCapability(selected.context.runtime, 'provider_label'),
        id: hostSessionEvidence.id,
      }
      : hostSessionEvidence,
  );
  const evidence = providerEvidenceProjection(selected.context.provider_evidence, supplied);
  if (evidence.recorded && evidence.supplied && !evidence.matched) {
    return emptyProjection('trusted-evidence-rejected', evidence);
  }
  if (selected.kind === 'cursor') {
    return successProjection('restored', selected, {
      cursor: selected.cursor,
      loop: snapshot.data,
    });
  }
  const receipt = readSelectedReceipt(root, runId, selected, guard);
  if (receipt?.invalid) return emptyProjection('checkpoint-ineligible');
  return successProjection(receipt ? 'compacted' : 'prepared', selected, {
    providerEvidence: receipt && supplied === null ? receipt.payload.provider_evidence : evidence,
    receipt,
    loop: snapshot.data,
  });
}

export function inspectCompactCheckpoint(root, runId, { now = Date.now() } = {}) {
  return withVerifiedReadLock(root, runId, (guard, snapshot) => (
    inspectLocked(root, runId, guard, snapshot, { now })
      ?? emptyProjection('checkpoint-not-found')
  ));
}

export function inspectCompactForSessionStart(root, runId, {
  hostSessionEvidence,
  now = Date.now(),
} = {}) {
  return withVerifiedReadLock(root, runId, (guard, snapshot) => (
    inspectLocked(root, runId, guard, snapshot, { hostSessionEvidence, now })
  ));
}

function observeLocked(root, runId, guard, snapshot, options) {
  const runtime = assertFence(snapshot.data, options.fence, options.runtime);
  assertCurrentSchema(snapshot.data);
  if (snapshot.data.autonomy?.continuation_policy !== 'workstream-session') {
    throw new Error('CHECKPOINT_AFFINITY_INVALID: workstream-session required');
  }
  affinity(snapshot.data);
  if (!['manual', 'auto'].includes(options.trigger)) throw new Error('CHECKPOINT_TRIGGER_INVALID');
  const key = strictRel(options.checkpointRel);
  const dir = assertCheckpointDirectory(root, runId);
  if (dir === null) throw new Error('CHECKPOINT_NOT_FOUND');
  const entries = captureDirectoryEntries(dir);
  if (tombstonedKeys(entries).has(key)) throw new Error('CHECKPOINT_INELIGIBLE');
  const candidates = currentCandidates(root, runId, snapshot, options.now, entries, new Set());
  candidates.sort(compareNewest);
  const selected = candidates[0];
  if (!selected || selected.key !== key) throw new Error('CHECKPOINT_INELIGIBLE');
  const supplied = normalizeProviderEvidence(options.hostSessionEvidence);
  const evidence = providerEvidenceProjection(selected.context.provider_evidence, supplied);
  if (evidence.recorded && evidence.supplied && !evidence.matched) {
    throw new Error('CHECKPOINT_EVIDENCE_MISMATCH');
  }
  if (selected.context.runtime !== runtime) throw new Error('RUNTIME_FENCED: context runtime mismatch');
  const payload = {
    checkpoint_key: key,
    context_sha256: selected.contextSha256,
    owner_run_id: selected.context.owner_run_id,
    generation: selected.context.generation,
    runtime,
    workstream_id: selected.context.workstream.id,
    episode_id: selected.context.current_episode.id,
    trigger: options.trigger,
    provider_evidence: evidence,
  };
  const path = receiptPath(root, runId, key);
  if (existsSync(path)) {
    const existing = readSelectedReceipt(root, runId, selected, guard);
    if (!existing || existing.invalid) throw new Error('CHECKPOINT_RECEIPT_CONFLICT');
    const retainedPayload = { ...payload, trigger: existing.payload.trigger };
    if (JSON.stringify(existing.payload) !== JSON.stringify(retainedPayload)) {
      throw new Error('CHECKPOINT_RECEIPT_CONFLICT');
    }
    pruneCapturedLocked(root, runId, guard, selected.entry.path, {
      now: options.now,
      faultAt: options.faultAt,
    });
    return {
      ok: true,
      created: false,
      checkpoint_rel: selected.rel,
      checkpoint_key: selected.key,
      trigger: existing.payload.trigger,
      provider_evidence: structuredClone(existing.payload.provider_evidence),
    };
  }
  const envelope = wrap({
    producer: 'deep-loop',
    artifact_kind: 'compact-observation',
    schema: { name: 'compact-observation', version: '1.0' },
    run_id: runId,
    provenance: { source_artifacts: [selected.rel], tool_versions: {} },
    payload,
    now: new Date(options.now).toISOString(),
  });
  durableAtomicWrite(path, JSON.stringify(envelope, null, 2));
  guard.renew();
  pruneCapturedLocked(root, runId, guard, selected.entry.path, {
    now: options.now,
    faultAt: options.faultAt,
  });
  return {
    ok: true,
    created: true,
    checkpoint_rel: selected.rel,
    checkpoint_key: selected.key,
    trigger: options.trigger,
    provider_evidence: evidence,
  };
}

function observeCompactCheckpointInternal(root, runId, options) {
  return withFencedReconciledMutationLock(root, runId, (guard, snapshot) => {
    assertFence(snapshot.data, options.fence, options.runtime);
    if (options.__testSkipHostGate !== true) {
      assertCompactHostEnabled(snapshot.data, options.runtime);
    }
    reconcilePruneTombstonesLocked(root, runId, guard);
    return observeLocked(root, runId, guard, snapshot, options);
  }, { fence: options.fence, runtime: options.runtime });
}

export function observeCompactCheckpoint(root, runId, {
  checkpointRel,
  trigger,
  fence,
  runtime,
  hostSessionEvidence,
  now = Date.now(),
} = {}) {
  return observeCompactCheckpointInternal(root, runId, {
    checkpointRel, trigger, fence, runtime, hostSessionEvidence, now,
  });
}

export function __testObserveCompactCheckpoint(root, runId, options = {}) {
  return observeCompactCheckpointInternal(root, runId, options);
}

function restoreRequest(checkpointRelValue, {
  fence,
  runtime,
  admission,
  source,
  confirmManualCompact = false,
  env = process.env,
} = {}) {
  if (!plainObject(fence)
    || typeof fence.owner !== 'string' || fence.owner.length === 0
    || !Number.isSafeInteger(fence.generation) || fence.generation < 1) {
    throw new Error('FENCE_REQUIRED: owner and positive generation');
  }
  if (typeof admission !== 'string' || typeof source !== 'string') {
    throw new Error('CHECKPOINT_ADMISSION_INVALID');
  }
  const headlessTruthy = value => value === true || value === '1' || value === 'true';
  const claudeEntrypoint = String(env?.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase();
  const headless = headlessTruthy(env?.DEEP_LOOP_UNATTENDED)
    || headlessTruthy(env?.DEEP_LOOP_HEADLESS)
    || (runtimeCapability(runtime, 'entrypoint_heuristic') === 'claude-code'
      && claudeEntrypoint !== ''
      && claudeEntrypoint !== 'cli'
      && (claudeEntrypoint.startsWith('sdk')
        || claudeEntrypoint.includes('print')
        || claudeEntrypoint.includes('headless')
        || claudeEntrypoint.includes('noninteractive')
        || claudeEntrypoint.includes('non-interactive')));
  return {
    checkpointRel: checkpointRelValue,
    checkpointKey: strictRel(checkpointRelValue),
    fence: { owner: fence.owner, generation: fence.generation },
    runtime,
    admission,
    source,
    confirmManualCompact: confirmManualCompact === true,
    headless,
  };
}

export function restoreCompactCheckpoint(root, runId, options = {}) {
  const request = restoreRequest(options.checkpointRel, options);
  return commitOrReplayCompactRestore(root, runId, request, { now: options.now ?? Date.now() });
}

export function __testRestoreCompactCheckpoint(root, runId, options = {}) {
  const request = restoreRequest(options.checkpointRel, options);
  return __testCommitOrReplayCompactRestore(root, runId, request, {
    now: options.now ?? Date.now(),
    faultAt: options.faultAt,
    skipHostGate: options.__testSkipHostGate === true,
  });
}

export function captureCheckpointSet(root, runId) {
  return withReconciledMutationLock(root, runId, (_guard, snapshot) => {
    const checkpoints = [];
    const dir = checkpointDir(root, runId);
    if (existsSync(dir)) {
      const dirStat = lstatSync(dir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('CHECKPOINT_PATH_INVALID');
      const names = Object.freeze(readdirSync(dir)
        .filter(file => file.endsWith('-compact.json'))
        .sort()
        .reverse());
      for (const name of names) {
        const path = join(dir, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        checkpoints.push(Object.freeze({ path, bytes: Buffer.from(readFileSync(path)) }));
      }
    }
    return Object.freeze({ snapshot, checkpoints: Object.freeze(checkpoints) });
  });
}

// Read-only SessionStart boundary.  This deliberately has no lock callback
// capable of reconciliation or writing: the run snapshot is verified first,
// then checkpoint names and bytes are projected from that exact immutable vector.
function expectedArtifactRels(snapshot) {
  const episode = (snapshot.data.episodes || []).find(item => item.id === snapshot.data.current_episode);
  const rels = [...new Set([
    ...(Array.isArray(episode?.expected_artifacts) ? episode.expected_artifacts : []),
    ...(Array.isArray(episode?.artifacts) ? episode.artifacts : []),
  ])].sort();
  if (rels.some(rel => normalizePortableRelativePath(rel) !== rel)) {
    throw new Error('CHECKPOINT_ARTIFACT_INVALID');
  }
  return rels;
}

function normalizeArtifactEvidence(value, rels) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CHECKPOINT_ARTIFACT_INVALID');
  }
  const normalized = Object.create(null);
  for (const rel of rels) {
    const evidence = value[rel];
    if (!evidence || (evidence.state !== 'absent' && evidence.state !== 'present')) {
      throw new Error('CHECKPOINT_ARTIFACT_INVALID');
    }
    if (evidence.state === 'absent') {
      normalized[rel] = Object.freeze({ rel, state: 'absent', sha256: null, size: null });
      continue;
    }
    if (!sha256(evidence.sha256) || !Number.isSafeInteger(evidence.size) || evidence.size < 0) {
      throw new Error('CHECKPOINT_ARTIFACT_INVALID');
    }
    const bytes = typeof evidence.base64 === 'string'
      ? Buffer.from(evidence.base64, 'base64')
      : Buffer.isBuffer(evidence.bytes) ? Buffer.from(evidence.bytes) : null;
    if (!bytes || bytes.length !== evidence.size || contentHash(bytes) !== evidence.sha256) {
      throw new Error('CHECKPOINT_ARTIFACT_INVALID');
    }
    normalized[rel] = Object.freeze({
      rel,
      state: 'present',
      sha256: evidence.sha256,
      size: evidence.size,
      base64: bytes.toString('base64'),
    });
  }
  return Object.freeze(normalized);
}

function captureArtifactEvidence(root, rels, options) {
  const evidence = Object.create(null);
  for (const rel of rels) {
    const observed = (options.observeArtifactFn || observeArtifact)(root, rel);
    if (observed.state === 'absent') {
      evidence[rel] = Object.freeze({ rel, state: 'absent', sha256: null, size: null });
    } else if (observed.state === 'present' && Buffer.isBuffer(observed.bytes)) {
      const bytes = Buffer.from(observed.bytes);
      evidence[rel] = Object.freeze({
        rel,
        state: 'present',
        sha256: contentHash(bytes),
        size: bytes.length,
        base64: bytes.toString('base64'),
      });
    } else {
      throw new Error('CHECKPOINT_ARTIFACT_INVALID');
    }
    options.afterArtifactCapture?.({ rel, evidence: evidence[rel] });
  }
  return Object.freeze(evidence);
}

function verifiedCheckpointEntries(root, runId, snapshot) {
  if (!Array.isArray(snapshot.vector)) throw new Error('CHECKPOINT_VECTOR_REQUIRED');
  const seen = new Set();
  const entries = [];
  for (const vectorEntry of snapshot.vector) {
    if (!Array.isArray(vectorEntry) || typeof vectorEntry[0] !== 'string'
      || typeof vectorEntry[1] !== 'string' || typeof vectorEntry[2] !== 'string') {
      throw new Error('CHECKPOINT_VECTOR_INVALID');
    }
    if (vectorEntry[0] !== runId) throw new Error('CHECKPOINT_VECTOR_FOREIGN_RUN');
    const rel = vectorEntry[1];
    if (seen.has(rel)) throw new Error('CHECKPOINT_VECTOR_DUPLICATE');
    seen.add(rel);
    if (typeof rel !== 'string' || !rel.startsWith('checkpoints/')) continue;
    if (vectorEntry[2] !== 'file' || !vectorEntry[3] || typeof vectorEntry[3].base64 !== 'string') {
      if (vectorEntry[2] === 'ABSENT' || vectorEntry[2] === 'directory') continue;
      throw new Error('CHECKPOINT_VECTOR_INVALID');
    }
    const bytes = Buffer.from(vectorEntry[3].base64, 'base64');
    if (bytes.length !== vectorEntry[3].size || contentHash(bytes) !== vectorEntry[3].sha256) {
      throw new Error('CHECKPOINT_VECTOR_INVALID');
    }
    const name = rel.slice('checkpoints/'.length);
    const match = name.match(STRICT_FILE);
    const legacy = !match && LEGACY_FILE.test(name);
    if (!match && !legacy) throw new Error('CHECKPOINT_INVALID');
    entries.push({
      name,
      path: join(runDir(root, runId), rel),
      bytes,
      ...(match ? { key: match[1], rel } : { legacy: true }),
    });
  }
  entries.sort((left, right) => right.name.localeCompare(left.name));
  return entries;
}

export function captureVerifiedCheckpointSet(rootOrOptions, runIdArg, optionsArg = {}) {
  const objectForm = rootOrOptions && typeof rootOrOptions === 'object' && !Array.isArray(rootOrOptions);
  const root = objectForm ? rootOrOptions.root : rootOrOptions;
  const runId = objectForm ? rootOrOptions.runId : runIdArg;
  const options = objectForm ? rootOrOptions : optionsArg;
  const capture = options.captureVerifiedRunSnapshot || captureVerifiedRunSnapshot;
  const captured = options.snapshot === undefined
    ? capture(root, runId, options)
    : options.snapshot;
  if (captured?.ok === false) {
    return Object.freeze({
      ok: false,
      kind: captured.kind || 'integrity-invalid',
      operation_id: captured.operation_id ?? null,
      phase: captured.phase || 'run-snapshot',
    });
  }
  const snapshot = captured?.snapshot || captured;
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.data
    || snapshot.data.run_id !== runId || typeof snapshot.hash !== 'string') {
    return Object.freeze({ ok: false, kind: 'integrity-invalid', phase: 'run-snapshot' });
  }
  try {
    if (canonicalProjectRoot(root) !== canonicalProjectRoot(snapshot.data.project?.root)) {
      return Object.freeze({ ok: false, kind: 'integrity-invalid', phase: 'run-snapshot' });
    }
  } catch {
    return Object.freeze({ ok: false, kind: 'integrity-invalid', phase: 'run-snapshot' });
  }
  options.afterRunSnapshotCapture?.(snapshot);
  let artifactEvidence;
  const checkpoints = [];
  try {
    const artifactRels = expectedArtifactRels(snapshot);
    artifactEvidence = options.artifactEvidence === undefined
      ? captureArtifactEvidence(root, artifactRels, options)
      : normalizeArtifactEvidence(options.artifactEvidence, artifactRels);
    for (const entry of verifiedCheckpointEntries(root, runId, snapshot)) {
      let safeDescriptor = null;
      let generatedAt = null;
      if (entry.legacy) {
        validateLegacyBytes(entry.bytes, {
          root, runId, snapshot, artifactRels, artifactEvidence, name: entry.name,
        });
      } else {
        const env = JSON.parse(entry.bytes.toString('utf8'));
        validateStrictSelf(env, { runId, key: entry.key });
        const validation = validateStrictBytes(entry.bytes, {
          root,
          runId,
          key: entry.key,
          snapshot,
          now: options.now ?? Date.now(),
          hostSessionEvidence: options.hostSessionEvidence,
          verifiedOnly: true,
          artifactEvidence,
        });
        generatedAt = validation.env.envelope.generated_at;
        safeDescriptor = frozenSafeDescriptor(descriptor(entry.rel, entry.key, validation));
      }
      checkpoints.push(Object.freeze({
        path: entry.path,
        bytes: Buffer.from(entry.bytes),
        ...(safeDescriptor ? {
          rel: entry.rel,
          key: entry.key,
          generatedAt,
          descriptor: safeDescriptor,
        } : {}),
      }));
    }
  } catch (error) {
    return Object.freeze({
      ok: false,
      kind: 'integrity-invalid',
      phase: 'checkpoint',
    });
  }
  return Object.freeze({ ok: true, snapshot, checkpoints: Object.freeze(checkpoints) });
}

// Pure projection for read-only consumers. Every selected field is derived from
// the immutable checkpoint bytes/validation captured above; this function never
// opens the live checkpoint directory and therefore cannot reconcile or replay it.
export function selectVerifiedCheckpointDescriptor(captured) {
  if (captured?.ok === false) return captured;
  if (!captured || !Array.isArray(captured.checkpoints)) {
    return { ok: false, reason: 'CHECKPOINT_NOT_FOUND' };
  }
  if (['completed', 'stopped', 'paused'].includes(captured.snapshot?.data?.status)) {
    return frozenSafeDescriptor(emptyProjection('run-not-resumable'));
  }
  const candidates = captured.checkpoints
    .filter(item => item?.descriptor && typeof item.rel === 'string' && typeof item.key === 'string')
    .map(item => ({
      rel: item.rel,
      key: item.key,
      generatedAt: item.generatedAt,
      descriptor: item.descriptor,
  }))
    .sort(compareNewest);
  if (candidates.length === 0) return { ok: false, reason: 'CHECKPOINT_NOT_FOUND' };
  const selected = candidates[0];
  return frozenSafeDescriptor(selected.descriptor);
}

function listLegacyCheckpoints(root, runId) {
  const dir = checkpointDir(root, runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(file => file.endsWith('-compact.json'))
    .sort()
    .map(file => join(dir, file));
}

function validLegacy(env, runId) {
  return unwrap(env, { producer: 'deep-loop', artifact_kind: 'compact-checkpoint' }) !== null
    && exactKeys(env, TOP_KEYS)
    && env.schema_version === '1.0'
    && exactKeys(env.envelope, ENVELOPE_KEYS)
    && env.envelope.schema?.version === '1.0'
    && env.envelope.run_id === runId
    && exactKeys(env.payload, LEGACY_PAYLOAD_KEYS);
}

function decodeLegacyTimestamp(name) {
  const prefix = name.slice(0, 10);
  if (prefix.length !== 10) throw new Error('CHECKPOINT_INVALID');
  let timestamp = 0;
  for (const character of prefix) {
    const digit = ULID_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('CHECKPOINT_INVALID');
    timestamp = timestamp * 32 + digit;
  }
  // ULID timestamps are 48 bits; the first 50-bit digit must therefore be 0..7.
  if (ULID_ALPHABET.indexOf(prefix[0]) > 7
    || !Number.isSafeInteger(timestamp)
    || timestamp < 0) {
    throw new Error('CHECKPOINT_INVALID');
  }
  try { new Date(timestamp).toISOString(); } catch { throw new Error('CHECKPOINT_INVALID'); }
  return timestamp;
}

function validateLegacyBytes(bytes, { root, runId, snapshot, artifactRels, artifactEvidence, name }) {
  let env;
  try { env = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('CHECKPOINT_INVALID'); }
  if (!validLegacy(env, runId)) throw new Error('CHECKPOINT_INVALID');
  if (!canonicalIso(env.envelope.generated_at)) throw new Error('CHECKPOINT_INVALID');
  const timestamp = decodeLegacyTimestamp(name);
  if (new Date(timestamp).toISOString() !== env.envelope.generated_at) {
    throw new Error('CHECKPOINT_CONTEXT_MISMATCH');
  }
  const payload = env.payload;
  const loop = snapshot.data;
  const lease = loop.session_chain?.lease || {};
  const episode = (loop.episodes || []).find(item => item.id === loop.current_episode) || null;
  const expectedArtifacts = Array.isArray(episode?.expected_artifacts)
    ? episode.expected_artifacts : [];
  const expectedEpisodeDetail = episode ? {
    id: episode.id,
    role: episode.role,
    status: episode.status,
    point: episode.point,
    workstream_id: episode.workstream_id,
  } : null;
  const expectedNextAction = nextAction(loop, {
    now: Date.parse(env.envelope.generated_at),
    unattended: false,
  });
  const expectedNextActionHint = {
    type: expectedNextAction.action.type,
    next_command: expectedNextAction.next_command,
  };
  if (payload.owner_run_id !== lease.owner_run_id
    || payload.generation !== lease.generation
    || payload.loop_hash !== snapshot.hash
    || payload.current_episode !== loop.current_episode
    || JSON.stringify(payload.current_episode_detail) !== JSON.stringify(expectedEpisodeDetail)
    || JSON.stringify(payload.active_workstreams) !== JSON.stringify(loop.active_workstreams || [])
    || JSON.stringify(payload.next_action_hint) !== JSON.stringify(expectedNextActionHint)
    || JSON.stringify(payload.artifacts) !== JSON.stringify(expectedArtifacts)) {
    throw new Error('CHECKPOINT_CONTEXT_MISMATCH');
  }
  for (const rel of artifactRels) {
    const evidence = artifactEvidence?.[rel];
    if (!evidence || !['absent', 'present'].includes(evidence.state)) {
      throw new Error('CHECKPOINT_ARTIFACT_INVALID');
    }
  }
  void root;
}

function legacyPrune(root, runId, owner, generation) {
  const all = listLegacyCheckpoints(root, runId);
  if (all.length <= KEEP) return;
  const owned = new Set(all.filter(path => {
    try {
      const env = JSON.parse(readFileSync(path, 'utf8'));
      if (!validLegacy(env, runId)) return false;
      return env.payload.owner_run_id === owner && env.payload.generation === generation;
    } catch {
      return false;
    }
  }));
  const removable = [
    ...all.filter(path => !owned.has(path)),
    ...all.filter(path => owned.has(path)),
  ];
  for (const path of removable) {
    if (listLegacyCheckpoints(root, runId).length <= KEEP) break;
    rmSync(path, { force: true });
  }
}

export function selectCheckpoint(checkpointSet, { owner, generation, loopHash }) {
  if (!checkpointSet || !Array.isArray(checkpointSet.checkpoints)) {
    throw new Error('CHECKPOINT_SNAPSHOT_REQUIRED');
  }
  if (!authenticLegacy(checkpointSet.snapshot?.data)) return null;
  const runId = checkpointSet.snapshot.data.run_id;
  for (const checkpoint of checkpointSet.checkpoints) {
    try {
      const env = JSON.parse(checkpoint.bytes.toString('utf8'));
      if (!validLegacy(env, runId)) continue;
      const payload = env.payload;
      if (typeof payload.owner_run_id !== 'string' || typeof payload.loop_hash !== 'string') continue;
      if (payload.owner_run_id === owner
        && payload.generation === generation
        && payload.loop_hash === loopHash) {
        return checkpoint;
      }
    } catch {
      // Malformed or foreign artifacts are not eligible restore context.
    }
  }
  return null;
}
