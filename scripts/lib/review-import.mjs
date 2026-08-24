import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWrite, unwrap, wrap } from './envelope.mjs';
import {
  canonicalNonSymlinkDirectory,
  containedRealFileWithin,
  normalizePortableRelativePath,
  pathWithin,
} from './fs-safe.mjs';
import { runDir } from './state.mjs';
import { REVIEW_IMPORT_MAX_BYTES } from './bounded-input.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import { sessionRuntime } from './runtime.mjs';
import { assertScopeAllows } from './session-scope.mjs';
import { isProofCapableChecker } from './episode-predicates.mjs';

export { isProofCapableChecker };

export const REVIEW_REPORT_BODY_MAX_BYTES = 262_144;
export const REVIEW_IMPORT_MAX_ARTIFACTS = 256;

const TOP_LEVEL_KEYS = Object.freeze([
  'schema_version', 'reviewer_id', 'checker_episode_id', 'target_maker',
  'attempt_id', 'verdict', 'report_body', 'artifacts',
]);
const ARTIFACT_KEYS = Object.freeze(['path', 'sha256']);
const VERDICTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'CONCERN']);
const SHA256 = /^[0-9a-f]{64}$/;
export const REVIEW_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const exactKeys = (value, keys) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const nonEmptyString = value => typeof value === 'string' && value.length > 0;
export const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex');
export function sha256File(path) {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export function parseReviewImport(raw) {
  if (typeof raw !== 'string') throw new Error('REVIEW_IMPORT_RAW_INVALID: expected UTF-8 text');
  if (Buffer.byteLength(raw, 'utf8') > REVIEW_IMPORT_MAX_BYTES) {
    throw new Error(`REVIEW_IMPORT_TOO_LARGE: input exceeds ${REVIEW_IMPORT_MAX_BYTES} bytes`);
  }
  let value;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error('REVIEW_IMPORT_JSON_INVALID: stdin must be one JSON document', { cause: error }); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('REVIEW_IMPORT_OBJECT_INVALID: top level must be an object');
  }
  if (!exactKeys(value, TOP_LEVEL_KEYS)) {
    throw new Error('REVIEW_IMPORT_PROPERTY_INVALID: exact top-level properties are required');
  }
  if (value.schema_version !== '1.0') throw new Error('REVIEW_IMPORT_SCHEMA_INVALID: schema_version must be 1.0');
  if (!nonEmptyString(value.reviewer_id)) throw new Error('REVIEW_IMPORT_REVIEWER_INVALID: reviewer_id must be a non-empty string');
  if (!nonEmptyString(value.checker_episode_id)) throw new Error('REVIEW_IMPORT_CHECKER_INVALID: checker_episode_id must be a non-empty string');
  if (!nonEmptyString(value.target_maker)) throw new Error('REVIEW_IMPORT_TARGET_INVALID: target_maker must be a non-empty string');
  if (!REVIEW_ATTEMPT_ID.test(value.attempt_id || '')) throw new Error('REVIEW_IMPORT_ATTEMPT_INVALID: attempt_id must be a bounded safe identifier');
  if (!VERDICTS.has(value.verdict)) throw new Error(`REVIEW_IMPORT_VERDICT_INVALID: ${String(value.verdict)}`);
  if (typeof value.report_body !== 'string') throw new Error('REVIEW_IMPORT_BODY_INVALID: report_body must be a string');
  if (Buffer.byteLength(value.report_body, 'utf8') > REVIEW_REPORT_BODY_MAX_BYTES) {
    throw new Error(`REVIEW_IMPORT_BODY_TOO_LARGE: report_body exceeds ${REVIEW_REPORT_BODY_MAX_BYTES} UTF-8 bytes`);
  }
  if (!Array.isArray(value.artifacts)) throw new Error('REVIEW_IMPORT_ARTIFACTS_INVALID: artifacts must be an array');
  if (value.artifacts.length > REVIEW_IMPORT_MAX_ARTIFACTS) {
    throw new Error(`REVIEW_IMPORT_ARTIFACTS_TOO_MANY: artifacts exceeds ${REVIEW_IMPORT_MAX_ARTIFACTS}`);
  }

  const seen = new Set();
  const artifacts = value.artifacts.map((artifact) => {
    if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw new Error('REVIEW_IMPORT_ARTIFACT_INVALID: each artifact must be an object');
    }
    if (!exactKeys(artifact, ARTIFACT_KEYS)) {
      throw new Error('REVIEW_IMPORT_ARTIFACT_PROPERTY_INVALID: exact artifact properties are required');
    }
    const path = normalizePortableRelativePath(artifact.path);
    if (!path) throw new Error(`REVIEW_IMPORT_ARTIFACT_PATH_INVALID: ${String(artifact.path)}`);
    if (!SHA256.test(artifact.sha256 || '')) {
      throw new Error(`REVIEW_IMPORT_ARTIFACT_HASH_INVALID: ${path} sha256 must be lowercase 64-hex`);
    }
    if (seen.has(path)) throw new Error(`REVIEW_IMPORT_ARTIFACT_DUPLICATE: ${path}`);
    seen.add(path);
    return { path, sha256: artifact.sha256 };
  });
  return { ...value, artifacts };
}

function normalizedMakerArtifacts(maker) {
  if (!Array.isArray(maker?.artifacts)) throw new Error('REVIEW_IMPORT_MAKER_ARTIFACT_INVALID: maker artifacts are missing');
  const normalized = [];
  const seen = new Set();
  for (const value of maker.artifacts) {
    const path = normalizePortableRelativePath(value);
    if (!path || seen.has(path)) throw new Error(`REVIEW_IMPORT_MAKER_ARTIFACT_INVALID: ${String(value)}`);
    seen.add(path); normalized.push(path);
  }
  return normalized;
}

export function deriveReviewArtifactContract(root, maker, workstream) {
  const recorded = normalizedMakerArtifacts(maker).sort();
  if (recorded.length > REVIEW_IMPORT_MAX_ARTIFACTS) {
    throw new Error(`REVIEW_IMPORT_MAKER_ARTIFACT_INVALID: artifacts exceeds ${REVIEW_IMPORT_MAX_ARTIFACTS}`);
  }
  const worktree = normalizePortableRelativePath(workstream?.worktree);
  if (!worktree) throw new Error('REVIEW_IMPORT_ARTIFACT_CONTAINMENT: reviewed worktree binding is invalid');
  const worktreeAbs = resolve(root, worktree);
  return recorded.map((path) => {
    const real = containedRealFileWithin(root, path, worktreeAbs);
    if (!real) throw new Error(`REVIEW_IMPORT_ARTIFACT_CONTAINMENT: ${path}`);
    return { path, sha256: sha256File(real) };
  });
}

const canonicalArtifacts = (artifacts) => {
  if (!Array.isArray(artifacts) || artifacts.length > REVIEW_IMPORT_MAX_ARTIFACTS) {
    throw new Error('REVIEW_IMPORT_CLAIM_ARTIFACT_INVALID: persisted claim artifacts are invalid');
  }
  const seen = new Set();
  const result = artifacts.map((artifact) => {
    if (artifact == null || typeof artifact !== 'object' || Array.isArray(artifact)
      || !exactKeys(artifact, ARTIFACT_KEYS)) {
      throw new Error('REVIEW_IMPORT_CLAIM_ARTIFACT_INVALID: persisted claim artifact shape is invalid');
    }
    const path = normalizePortableRelativePath(artifact.path);
    if (!path || seen.has(path) || !SHA256.test(artifact.sha256 || '')) {
      throw new Error('REVIEW_IMPORT_CLAIM_ARTIFACT_INVALID: persisted claim artifact identity is invalid');
    }
    seen.add(path);
    return { path, sha256: artifact.sha256 };
  });
  return result.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
};

export function validateImportedEvidence(root, loop, input, { checker, maker, workstream } = {}) {
  if (!isProofCapableChecker(checker)) throw new Error(`REVIEW_IMPORT_REVIEWER_INVALID: unsupported checker plugin ${String(checker?.plugin)}`);
  if (input.reviewer_id !== checker.plugin) throw new Error(`REVIEW_IMPORT_REVIEWER_MISMATCH: ${input.reviewer_id} != ${checker.plugin}`);
  if (input.checker_episode_id !== checker.id) throw new Error(`REVIEW_IMPORT_CHECKER_MISMATCH: ${input.checker_episode_id} != ${checker.id}`);
  if (input.target_maker !== maker.id || input.target_maker !== checker.target_maker) {
    throw new Error(`REVIEW_IMPORT_TARGET_MISMATCH: ${input.target_maker} != ${checker.target_maker}`);
  }
  if (loop.autonomy?.continuation_policy === 'workstream-session') {
    // Change F is defensive: null scope is admitted, while bound cross-workstream scope remains rejected.
    // No kernel reachability is demonstrated; the sole F test covers only non-done-target rejection.
    assertScopeAllows(loop, maker.workstream_id, { allowUnbound: true });
  }

  const claim = checker.review_claim;
  if (checker.status !== 'in_progress' || claim == null || typeof claim !== 'object' || Array.isArray(claim)) {
    throw new Error('REVIEW_IMPORT_CHECKER_NOT_CLAIMED: checker must carry an in-progress host claim');
  }
  if (input.attempt_id !== checker.attempt_id || input.attempt_id !== claim.attempt_id) {
    throw new Error(`REVIEW_IMPORT_ATTEMPT_MISMATCH: ${input.attempt_id} != ${String(checker.attempt_id)}`);
  }
  if (claim.run_id !== loop.run_id || claim.reviewer_id !== checker.plugin
    || claim.checker_episode_id !== checker.id || claim.target_maker !== maker.id
    || claim.workstream_id !== checker.workstream_id || claim.point !== checker.point) {
    throw new Error('REVIEW_IMPORT_CLAIM_BINDING_MISMATCH: persisted checker binding changed');
  }
  if (claim.project_root !== canonicalProjectRoot(root)
    || claim.project_root !== canonicalProjectRoot(loop.project?.root)) {
    throw new Error('REVIEW_IMPORT_CLAIM_ROOT_MISMATCH: canonical project root changed');
  }
  if (claim.runtime !== sessionRuntime(loop)) {
    throw new Error('REVIEW_IMPORT_CLAIM_RUNTIME_MISMATCH: durable runtime changed');
  }
  const lease = loop.session_chain?.lease || {};
  if (claim.lease_owner !== lease.owner_run_id || claim.lease_generation !== lease.generation) {
    throw new Error('REVIEW_IMPORT_CLAIM_LEASE_MISMATCH: claim lease changed');
  }

  const currentContract = deriveReviewArtifactContract(root, maker, workstream);
  const importedContract = canonicalArtifacts(input.artifacts);
  const claimContract = canonicalArtifacts(Array.isArray(claim.artifacts) ? claim.artifacts : []);
  const paths = values => values.map(value => value.path);
  if (JSON.stringify(paths(currentContract)) !== JSON.stringify(paths(importedContract))
    || JSON.stringify(paths(claimContract)) !== JSON.stringify(paths(importedContract))) {
    throw new Error('REVIEW_IMPORT_ARTIFACT_SET_MISMATCH: imported artifacts must equal the terminal maker artifact set');
  }
  if (JSON.stringify(currentContract) !== JSON.stringify(importedContract)
    || JSON.stringify(claimContract) !== JSON.stringify(importedContract)) {
    throw new Error('REVIEW_IMPORT_ARTIFACT_HASH_MISMATCH: imported artifacts changed after claim');
  }

  for (const artifact of input.artifacts) {
    const current = currentContract.find(value => value.path === artifact.path);
    if (!current || current.sha256 !== artifact.sha256) throw new Error(`REVIEW_IMPORT_ARTIFACT_HASH_MISMATCH: ${artifact.path}`);
  }
  return {
    reviewerId: checker.plugin,
    checkerEpisodeId: checker.id,
    targetMaker: maker.id,
    attemptId: checker.attempt_id,
    artifacts: claimContract,
  };
}

function requireReviewDirectory(root, runId, { createReviews = false } = {}) {
  let resolvedRoot;
  try { resolvedRoot = realpathSync(resolve(root)); }
  catch (error) { throw new Error('REVIEW_IMPORT_DIRECTORY_UNSAFE: canonical project root is unavailable', { cause: error }); }
  const canonicalRoot = canonicalNonSymlinkDirectory(resolvedRoot);
  if (!canonicalRoot) throw new Error('REVIEW_IMPORT_DIRECTORY_UNSAFE: canonical project root is not a directory');
  const deepLoop = join(canonicalRoot, '.deep-loop');
  const runs = join(deepLoop, 'runs');
  const run = runDir(canonicalRoot, runId);
  let parent = canonicalRoot;
  for (const path of [deepLoop, runs, run]) {
    const canonical = canonicalNonSymlinkDirectory(path);
    if (!canonical || !pathWithin(parent, canonical)) throw new Error(`REVIEW_IMPORT_DIRECTORY_UNSAFE: ${path}`);
    parent = canonical;
  }
  const reviews = join(run, 'reviews');
  if (createReviews && !existsSync(reviews)) {
    try { mkdirSync(reviews); }
    catch (error) { if (!existsSync(reviews)) throw new Error('REVIEW_IMPORT_DIRECTORY_UNSAFE: cannot create reviews directory', { cause: error }); }
  }
  const canonicalReviews = canonicalNonSymlinkDirectory(reviews);
  if (!canonicalReviews || !pathWithin(parent, canonicalReviews)) {
    throw new Error(`REVIEW_IMPORT_DIRECTORY_UNSAFE: ${reviews}`);
  }
  return { canonicalRoot, run, reviews: canonicalReviews };
}

function generatedAt(now) {
  const value = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(value.getTime())) throw new Error('INVALID_NOW: review import envelope timestamp');
  return value.toISOString();
}

export function prepareImportedReview(root, runId, input, binding, { now } = {}) {
  const canonicalRoot = canonicalProjectRoot(root);
  const run = runDir(canonicalRoot, runId);
  const canonicalRun = canonicalNonSymlinkDirectory(run);
  if (!canonicalRun || !pathWithin(canonicalRoot, canonicalRun)) {
    throw new Error('REVIEW_IMPORT_DIRECTORY_UNSAFE: canonical run directory is unavailable');
  }
  const reviews = join(canonicalRun, 'reviews');
  if (existsSync(reviews)) {
    const canonicalReviews = canonicalNonSymlinkDirectory(reviews);
    if (!canonicalReviews || !pathWithin(canonicalRun, canonicalReviews)) {
      throw new Error('REVIEW_IMPORT_DIRECTORY_UNSAFE: reviews directory is unsafe');
    }
  }
  const generated = generatedAt(now);
  const envelope = wrap({
    producer: 'deep-loop', artifact_kind: 'review-report',
    schema: { name: 'review-report', version: '1.0' }, run_id: runId,
    provenance: {
      source_artifacts: binding.artifacts.map(artifact => artifact.path),
      tool_versions: {},
      review_binding: {
        reviewer_id: binding.reviewerId,
        checker_episode_id: binding.checkerEpisodeId,
        target_maker: binding.targetMaker,
        attempt_id: binding.attemptId,
        artifacts: binding.artifacts.map(artifact => ({ ...artifact })),
      },
    },
    payload: { verdict: input.verdict, report_body: input.report_body },
    now: generated,
  });
  const raw = JSON.stringify(envelope, null, 2);
  const bytes = Buffer.from(raw);
  const reportBytes = bytes.length;
  const reportSha256 = sha256Bytes(bytes);
  const name = `${reportSha256}.json`;
  const reportRel = `reviews/${name}`;
  const reportAbs = join(reviews, name);
  const report = ['.deep-loop', 'runs', runId, 'reviews', name].join('/');
  if (resolve(canonicalRoot, ...report.split('/')) !== reportAbs) {
    throw new Error('REVIEW_IMPORT_DIRECTORY_UNSAFE: durable report path mismatch');
  }
  return {
    report, reportRel, reportAbs, reportBytes, reportSha256, bytes,
    generatedAt: generated, input, binding,
  };
}

export function materializeImportedReview(root, runId, input, binding, { now } = {}) {
  const prepared = prepareImportedReview(root, runId, input, binding, { now });
  const { canonicalRoot, reviews } = requireReviewDirectory(root, runId, { createReviews: true });
  const { report, reportAbs, reportBytes, reportSha256, bytes } = prepared;
  if (reportAbs !== join(reviews, `${reportSha256}.json`)) {
    throw new Error('REVIEW_IMPORT_DIRECTORY_UNSAFE: prepared report path mismatch');
  }
  if (existsSync(reportAbs)) {
    const st = lstatSync(reportAbs);
    if (st.isSymbolicLink() || !st.isFile() || st.size !== reportBytes || !readFileSync(reportAbs).equals(bytes)) {
      throw new Error(`REVIEW_IMPORT_ENVELOPE_COLLISION: ${reportSha256}.json`);
    }
  } else {
    atomicWrite(reportAbs, bytes);
  }
  if (resolve(canonicalRoot, ...report.split('/')) !== reportAbs) {
    throw new Error('REVIEW_IMPORT_DIRECTORY_UNSAFE: durable report path mismatch');
  }
  return prepared;
}

const sameArtifacts = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function verifyImportedEnvelope(root, runId, evidence, lockedBinding) {
  const { canonicalRoot, reviews } = requireReviewDirectory(root, runId);
  if (!SHA256.test(evidence.reportSha256 || '')) throw new Error('REVIEW_REPORT_HASH_MISMATCH: invalid expected hash');
  const expectedName = `${evidence.reportSha256}.json`;
  const expectedAbs = join(reviews, expectedName);
  const expectedRel = ['.deep-loop', 'runs', runId, 'reviews', expectedName].join('/');
  if (evidence.report !== expectedRel || evidence.reportAbs !== expectedAbs || resolve(canonicalRoot, ...expectedRel.split('/')) !== expectedAbs) {
    throw new Error('REVIEW_IMPORT_ENVELOPE_BINDING_MISMATCH: report path');
  }
  let stat;
  try { stat = lstatSync(expectedAbs); } catch { throw new Error('REVIEW_IMPORT_ENVELOPE_MISSING: report'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('REVIEW_IMPORT_ENVELOPE_CONTAINMENT: report must be a regular non-symlink file');
  if (!Number.isSafeInteger(evidence.reportBytes) || stat.size !== evidence.reportBytes) {
    throw new Error('REVIEW_REPORT_HASH_MISMATCH: envelope size changed');
  }
  const raw = readFileSync(expectedAbs);
  if (sha256Bytes(raw) !== evidence.reportSha256) throw new Error('REVIEW_REPORT_HASH_MISMATCH: envelope bytes changed');
  let object;
  try { object = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch (error) { throw new Error('REVIEW_IMPORT_ENVELOPE_INVALID: envelope JSON/UTF-8', { cause: error }); }
  const opened = unwrap(object, { producer: 'deep-loop', artifact_kind: 'review-report' });
  const binding = opened?.envelope?.provenance?.review_binding;
  if (!opened || opened.schema_version !== '1.0' || opened.envelope.schema?.version !== '1.0'
      || opened.envelope.run_id !== runId
      || binding?.reviewer_id !== lockedBinding.reviewerId
      || binding?.checker_episode_id !== lockedBinding.checkerEpisodeId
      || binding?.target_maker !== lockedBinding.targetMaker
      || binding?.attempt_id !== lockedBinding.attemptId
      || !sameArtifacts(binding?.artifacts, lockedBinding.artifacts)
      || opened.payload?.verdict !== evidence.input.verdict
      || opened.payload?.report_body !== evidence.input.report_body) {
    throw new Error('REVIEW_IMPORT_ENVELOPE_BINDING_MISMATCH: kernel provenance');
  }
  return true;
}
