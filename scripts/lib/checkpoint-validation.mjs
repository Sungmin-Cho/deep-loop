import { lstatSync, readFileSync } from 'node:fs';
import { contentHash } from './envelope.mjs';
import { captureStableFileIdentity, matchingStableFileIdentity } from './fs-safe.mjs';

export const STRICT_SCHEMA_VERSION = '2.0';
export const STRICT_CONTEXT_DOMAIN = 'deep-loop-compact-checkpoint-v2';
export const STRICT_FILE = /^([0-9a-f]{64})-compact\.json$/;
const MAX_CHECKPOINT_BYTES = 256 * 1024;
const MAX_COMPACT_PRUNE_BYTES = 16 * 1024;

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

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plainObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key, index) => Object.keys(value)[index] === key);
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const canonicalIso = value => typeof value === 'string'
  && Number.isFinite(new Date(value).getTime())
  && new Date(value).toISOString() === value;

export function normalizeProviderEvidence(value) {
  if (value === undefined || value === null) return null;
  if (!exactKeys(value, ['provider', 'id'])
    || typeof value.provider !== 'string'
    || value.provider.length === 0
    || value.provider.length > 128
    || /[\0\r\n]/.test(value.provider)
    || typeof value.id !== 'string'
    || value.id.length === 0
    || value.id.length > 1024
    || /[\0\r\n]/.test(value.id)) {
    throw new Error('CHECKPOINT_EVIDENCE_INVALID');
  }
  return {
    provider: value.provider,
    identity_sha256: contentHash(value.id),
  };
}

export function validStoredProviderEvidence(value) {
  return value === null || (exactKeys(value, ['provider', 'identity_sha256'])
    && typeof value.provider === 'string'
    && value.provider.length > 0
    && value.provider.length <= 128
    && !/[\0\r\n]/.test(value.provider)
    && sha256(value.identity_sha256));
}

export function providerEvidenceProjection(recordedEvidence, suppliedEvidence) {
  const recorded = recordedEvidence !== null;
  const supplied = suppliedEvidence !== null;
  const matched = recorded && supplied
    && suppliedEvidence.provider === recordedEvidence.provider
    && suppliedEvidence.identity_sha256 === recordedEvidence.identity_sha256;
  return { recorded, supplied, matched };
}

export function validateStrictSelf(env, { runId, key }) {
  if (!exactKeys(env, TOP_KEYS)
    || env.schema_version !== '1.0'
    || !exactKeys(env.envelope, ENVELOPE_KEYS)
    || env.envelope.producer !== 'deep-loop'
    || env.envelope.artifact_kind !== 'compact-checkpoint'
    || !exactKeys(env.envelope.schema, ['name', 'version'])
    || env.envelope.schema.name !== 'compact-checkpoint'
    || env.envelope.schema.version !== STRICT_SCHEMA_VERSION
    || env.envelope.run_id !== runId
    || env.envelope.parent_run_id !== null
    || !canonicalIso(env.envelope.generated_at)
    || !exactKeys(env.envelope.git, [])
    || !exactKeys(env.envelope.provenance, ['source_artifacts', 'tool_versions'])
    || !Array.isArray(env.envelope.provenance.source_artifacts)
    || env.envelope.provenance.source_artifacts.length !== 0
    || !exactKeys(env.envelope.provenance.tool_versions, [])
    || !exactKeys(env.payload, PAYLOAD_KEYS)
    || env.payload.checkpoint_key !== key
    || !exactKeys(env.payload.context, Object.hasOwn(env.payload.context || {}, 'scope_epoch') ? [...CONTEXT_KEYS, 'scope_epoch'] : CONTEXT_KEYS)
    || (Object.hasOwn(env.payload.context || {}, 'scope_epoch') && (!Number.isSafeInteger(env.payload.context.scope_epoch) || env.payload.context.scope_epoch < 0))
    || !sha256(env.payload.context_sha256)
    || contentHash(JSON.stringify(env.payload.context)) !== env.payload.context_sha256
    || contentHash(JSON.stringify([STRICT_CONTEXT_DOMAIN, env.payload.context])) !== key
    || !validStoredProviderEvidence(env.payload.context.provider_evidence)) {
    throw new Error('CHECKPOINT_INVALID');
  }
  return env.payload.context;
}

export function validateCompactPruneBytes(bytes, { runId, key }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_COMPACT_PRUNE_BYTES) {
    throw new Error('COMPACT_PRUNE_INVALID');
  }
  let env;
  try { env = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('COMPACT_PRUNE_INVALID'); }
  const checkpointRel = `checkpoints/${key}-compact.json`;
  const observationRel = `checkpoints/${key}-compact-observation.json`;
  if (!exactKeys(env, TOP_KEYS)
    || env.schema_version !== '1.0'
    || !exactKeys(env.envelope, ENVELOPE_KEYS)
    || env.envelope.producer !== 'deep-loop'
    || env.envelope.artifact_kind !== 'compact-prune'
    || !exactKeys(env.envelope.schema, ['name', 'version'])
    || env.envelope.schema.name !== 'compact-prune'
    || env.envelope.schema.version !== '1.0'
    || env.envelope.run_id !== runId
    || env.envelope.parent_run_id !== null
    || !canonicalIso(env.envelope.generated_at)
    || !exactKeys(env.envelope.git, [])
    || !exactKeys(env.envelope.provenance, ['source_artifacts', 'tool_versions'])
    || JSON.stringify(env.envelope.provenance.source_artifacts)
      !== JSON.stringify([checkpointRel, observationRel])
    || !exactKeys(env.envelope.provenance.tool_versions, [])
    || !exactKeys(env.payload, [
      'checkpoint_key',
      'checkpoint_sha256',
      'context_sha256',
      'receipt_sha256',
    ])
    || env.payload.checkpoint_key !== key
    || !(env.payload.checkpoint_sha256 === null || sha256(env.payload.checkpoint_sha256))
    || !(env.payload.context_sha256 === null || sha256(env.payload.context_sha256))
    || !(env.payload.receipt_sha256 === null || sha256(env.payload.receipt_sha256))) {
    throw new Error('COMPACT_PRUNE_INVALID');
  }
  return env.payload;
}

export function validateStrictBytes(bytes, {
  runId,
  key,
  expectedContext,
  hostSessionEvidence,
  freshNextAction,
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_CHECKPOINT_BYTES) {
    throw new Error('CHECKPOINT_INVALID');
  }
  let env;
  try { env = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('CHECKPOINT_INVALID'); }
  const context = validateStrictSelf(env, { runId, key });
  if (JSON.stringify(context) !== JSON.stringify(expectedContext(context, env.envelope.generated_at))) {
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
    freshNextAction: freshNextAction(),
    providerEvidence,
  };
}

export function readStableRegular(path, invalidCode = 'CHECKPOINT_PATH_INVALID') {
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error('CHECKPOINT_NOT_FOUND'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(invalidCode);
  const before = captureStableFileIdentity(path);
  const bytes = readFileSync(path);
  const after = captureStableFileIdentity(path);
  if (!matchingStableFileIdentity(before, after)) throw new Error(invalidCode);
  return { bytes, identity: after };
}
