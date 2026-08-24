import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { durableAtomicCreate } from './atomic-write.mjs';
import { epOrder, isProofCapableChecker } from './episode-predicates.mjs';
import {
  canonicalNonSymlinkDirectory,
  captureStableFileIdentity,
  matchingStableFileIdentity,
  pathWithin,
} from './fs-safe.mjs';
import { locateDeepModelRouter } from './locate-deep-model-router.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import { runtimeCapability, sessionRuntime } from './runtime.mjs';
import { resolveLaunchProfile, validateModel } from './session-profile.mjs';
import { runDir } from './state.mjs';

export const ROUTE_OBSERVATION_ARTIFACT_KIND = 'route-observation';
export const ROUTE_OBSERVATION_SCHEMA_VERSION = '1.0';
export const ROUTE_OBSERVATION_CONTRACT_VERSION = 1;
export const OBSERVATION_DIR = 'observations';
export const OBSERVATION_MAX_FILE_BYTES = 16_384;
export const MANIFEST_MAX_FILE_BYTES = 65_536;
export const IDENTITY_MAX_BYTES = 128;
export const GIT_BRANCH_MAX_BYTES = 128;

const DEEP_LOOP_MANIFEST_PATH = fileURLToPath(
  new URL('../../.claude-plugin/plugin.json', import.meta.url),
);

export const OBSERVATION_REASONS = Object.freeze([
  'git-identity-unavailable',
  'observation-too-large',
  'observation-collision',
  'observation-directory-unsafe',
  'observation-publish-unsupported',
  'observation-write-failed',
  'snapshot-invalid',
  'observation-identity-invalid',
  'kernel-version-unavailable',
  'observation-failed',
]);

export const VALIDATION_REASONS = Object.freeze([
  'router-missing',
  'validator-missing',
  'python-unavailable',
  'timeout',
  'max-buffer',
  'signal',
  'spawn-error',
  'invalid',
  'usage',
]);

const TASK_CLASSES = new Set([
  // deep-model-router validate_observation.py:41-45
  'MECHANICAL', 'DOCUMENTATION', 'TESTING', 'IMPLEMENTATION', 'REFACTORING',
  'DEBUGGING', 'INVESTIGATION', 'MIGRATION', 'ARCHITECTURE', 'REVIEW', 'OPERATIONS',
]);
const FORBIDDEN_KEYS = new Set([
  // deep-model-router validate_observation.py:34-38
  'git_diff', 'stdout', 'stderr', 'report_body', 'prompt', 'task_description', 'changes',
  'diff', 'body', 'output_text', 'canonical_report_text', 'argv', 'red_verification_output', 'goal',
]);
const HEX64_RE = /^[0-9a-f]{64}$/;
const GIT_HEAD_RE = /^[0-9a-f]{7,40}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const PRODUCER_ATTEMPT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_REF_CHAR_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const VALIDATION_STATES = new Set(['disabled', 'valid', 'invalid', 'usage', 'unavailable']);

export const relObservationPath = subject => `${OBSERVATION_DIR}/${subject}.json`;

export function compareCodePoints(a, b) {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0);
    const cy = y.value.codePointAt(0);
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort(compareCodePoints);
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  const scalar = JSON.stringify(value);
  if (scalar === undefined) throw new TypeError('CANONICAL_JSON_UNSUPPORTED');
  return scalar;
}

function escapeNonAscii(text) {
  return text.replace(/[\u0080-\uFFFF]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function asciiCanonicalJson(value) {
  return escapeNonAscii(canonical(value));
}

export function subjectSha256({ producer, run_id, artifact_id }) {
  const preimage = asciiCanonicalJson({ artifact_id, producer, run_id });
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

function noneLinkage() {
  return {
    route_schema_version: null,
    router_plugin_version: null,
    policy_sha256: null,
    request_sha256: null,
    decision_fingerprint: null,
    linkage_quality: 'none',
  };
}

export function classifyLinkage(routing) {
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)
    || routing.provenance !== 'router') return noneLinkage();
  const decision = routing.decision;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)
    || decision.route_schema_version !== 1
    || !SEMVER_RE.test(decision.router_plugin_version || '')
    || !HEX64_RE.test(decision.policy_sha256 || '')) return noneLinkage();
  const fingerprint = HEX64_RE.test(decision.decision_fingerprint || '')
    ? decision.decision_fingerprint
    : null;
  return {
    route_schema_version: 1,
    router_plugin_version: decision.router_plugin_version,
    policy_sha256: decision.policy_sha256,
    request_sha256: HEX64_RE.test(decision.request_sha256 || '') ? decision.request_sha256 : null,
    decision_fingerprint: fingerprint,
    linkage_quality: fingerprint === null ? 'identity_only' : 'full',
  };
}

export function normalizeSeat(role) {
  if (role === 'maker') return 'worker';
  if (role === 'checker') return 'reviewer';
  return 'other';
}

export function normalizeState(status) {
  if (status === 'done' || status === 'approved') return 'succeeded';
  if (status === 'rejected') return 'failed';
  if (status === 'abandoned') return 'cancelled';
  return 'unknown';
}

export function validIdentity(value) {
  return typeof value === 'string'
    && value !== ''
    && !value.startsWith('/')
    && Buffer.byteLength(value, 'utf8') <= IDENTITY_MAX_BYTES;
}

function validKebab(value) {
  return typeof value === 'string'
    && KEBAB_RE.test(value)
    && Buffer.byteLength(value, 'utf8') <= 64;
}

export function normalizeGitBranch(value) {
  if (typeof value !== 'string' || value === '') return 'HEAD';
  if (Buffer.byteLength(value, 'utf8') > GIT_BRANCH_MAX_BYTES) return 'HEAD';
  if (!GIT_REF_CHAR_RE.test(value)) return 'HEAD';
  if (value.endsWith('/') || value.endsWith('.')) return 'HEAD';
  if (value.includes('..') || value.includes('//')) return 'HEAD';
  for (const segment of value.split('/')) {
    if (segment === '' || segment.startsWith('.') || segment.endsWith('.lock')) return 'HEAD';
  }
  if (/(^|\/)\.worktrees(\/|$)|(^|\/)\.claude(\/|$)/.test(value)) return 'HEAD';
  return value;
}

function validExpectedModel(value) {
  if (!validIdentity(value)) return null;
  try {
    validateModel(value);
    return value;
  } catch {
    return null;
  }
}

function sourceArtifactsFor(episode, reviewSource, reportSha256) {
  const paths = [];
  if (episode.role === 'checker' && validIdentity(episode.target_maker)) {
    paths.push({ path: `episodes/${episode.target_maker}/request.md` });
  }
  paths.push({ path: `episodes/${episode.id}/request.md` });
  if (episode.role === 'checker' && reviewSource === 'imported-stdin' && HEX64_RE.test(reportSha256 || '')) {
    paths.push({ path: `reviews/${reportSha256}.json` });
  }
  return paths;
}

function reworkTotal(loop, maker) {
  if (typeof maker.workstream_id !== 'string') return 0;
  return loop.episodes.filter(checker =>
    isProofCapableChecker(checker)
    && checker.status === 'rejected'
    && checker.workstream_id === maker.workstream_id
    && checker.point === maker.point
    && typeof checker.target_maker === 'string'
    && epOrder(checker.target_maker, maker.id) < 0).length;
}

function reviewRounds(loop, checker) {
  if (typeof checker.target_maker !== 'string') return 0;
  return loop.episodes.filter(candidate =>
    isProofCapableChecker(candidate)
    && candidate.target_maker === checker.target_maker
    && (candidate.status === 'approved' || candidate.status === 'rejected')).length;
}

function invalidRequiredIdentity(loop, episode) {
  if (!validKebab('deep-loop') || !validIdentity(loop.run_id) || !validIdentity(episode.id)) return true;
  if (episode.role === 'checker') {
    if (!validKebab(episode.plugin)) return true;
    if (episode.target_maker !== undefined && !validIdentity(episode.target_maker)) return true;
  }
  return false;
}

function importedEvidence(event, reviewSource) {
  if (reviewSource !== 'imported-stdin') {
    return { attempt_id: null, evidence_kind: 'none', evidence_ref: null };
  }
  const attemptId = event?.data?.attempt_id;
  const reportSha256 = event?.data?.report_sha256;
  if (!PRODUCER_ATTEMPT_RE.test(attemptId || '') || !HEX64_RE.test(reportSha256 || '')) return null;
  return {
    attempt_id: attemptId,
    evidence_kind: 'producer_record',
    evidence_ref: { path: `reviews/${reportSha256}.json`, sha256: reportSha256 },
  };
}

function forbiddenKeyPresent(value) {
  if (Array.isArray(value)) return value.some(forbiddenKeyPresent);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN_KEYS.has(key) || forbiddenKeyPresent(child));
}

export function buildRouteObservation({
  loop,
  episodeId,
  event,
  terminalStatus,
  verdict,
  reviewSource,
  kernelVersion,
}) {
  const episode = Array.isArray(loop?.episodes)
    ? loop.episodes.find(candidate => candidate?.id === episodeId)
    : undefined;
  if (!episode || invalidRequiredIdentity(loop, episode)) {
    return { ok: false, reason: 'observation-identity-invalid' };
  }
  if (!GIT_HEAD_RE.test(loop?.project?.head || '')) {
    return { ok: false, reason: 'git-identity-unavailable' };
  }
  if (!SEMVER_RE.test(kernelVersion || '')) {
    return { ok: false, reason: 'kernel-version-unavailable' };
  }

  const effectiveReviewSource = reviewSource === undefined ? event?.data?.review_source : reviewSource;
  const evidence = importedEvidence(event, effectiveReviewSource);
  if (!evidence) return { ok: false, reason: 'observation-identity-invalid' };
  const linkage = classifyLinkage(episode.routing);
  const reportSha256 = event?.data?.report_sha256;
  const sourceArtifacts = sourceArtifactsFor(episode, effectiveReviewSource, reportSha256);
  const profile = resolveLaunchProfile(loop, { episodeId });
  const runtime = runtimeCapability(sessionRuntime(loop), 'observation_runtime');
  const subjectHash = subjectSha256({ producer: 'deep-loop', run_id: loop.run_id, artifact_id: episode.id });
  const workstream = Array.isArray(loop.workstreams)
    ? loop.workstreams.find(candidate => candidate?.id === episode.workstream_id)
    : undefined;
  const producerPhase = typeof episode.point === 'string'
    && episode.point !== ''
    && Buffer.byteLength(episode.point, 'utf8') <= IDENTITY_MAX_BYTES
    ? { producer: 'deep-loop', value: episode.point }
    : null;

  const envelope = {
    producer: 'deep-loop',
    producer_version: kernelVersion,
    artifact_kind: ROUTE_OBSERVATION_ARTIFACT_KIND,
    run_id: loop.run_id,
    ...(validIdentity(loop?.session_chain?.lease?.owner_run_id)
      ? { session_id: loop.session_chain.lease.owner_run_id }
      : {}),
    ...(validIdentity(loop?.session_chain?.parent_run_id)
      ? { parent_run_id: loop.session_chain.parent_run_id }
      : {}),
    generated_at: event?.ts,
    schema: { name: ROUTE_OBSERVATION_ARTIFACT_KIND, version: ROUTE_OBSERVATION_SCHEMA_VERSION },
    git: {
      head: loop.project.head,
      branch: normalizeGitBranch(loop.project.branch),
      dirty: 'unknown',
    },
    provenance: {
      source_artifacts: sourceArtifacts,
      tool_versions: {
        'deep-loop': kernelVersion,
        ...(linkage.linkage_quality !== 'none'
          ? { 'deep-model-router': linkage.router_plugin_version }
          : {}),
      },
    },
  };

  const subject = {
    producer: 'deep-loop',
    run_id: loop.run_id,
    artifact_id: episode.id,
    subject_sha256: subjectHash,
    ...(GIT_HEAD_RE.test(workstream?.base_commit || '') ? { base_commit: workstream.base_commit } : {}),
  };
  const attempt = {
    ...evidence,
    prompt_sha256: null,
    seat: normalizeSeat(episode.role),
    seat_source: { producer: 'deep-loop', value: episode.role },
    expected_model_id: validExpectedModel(profile.model),
    observed_model_id: null,
    observed_model_source: 'unavailable',
    runtime,
    transport_id: null,
    effort_native: validIdentity(profile.effort) ? profile.effort : null,
    state: normalizeState(terminalStatus),
    state_source: { producer: 'deep-loop', value: terminalStatus },
  };
  const payload = {
    contract: {
      plugin: 'deep-model-router',
      observation_schema_version: ROUTE_OBSERVATION_CONTRACT_VERSION,
    },
    decision: linkage,
    subject,
    task: {
      class: TASK_CLASSES.has(episode?.routing?.request?.task_class)
        ? episode.routing.request.task_class
        : null,
      risk_band: null,
      producer_phase: producerPhase,
    },
    attempts: [attempt],
  };

  if (episode.role === 'maker' && terminalStatus === 'done') {
    payload.objective_results = {
      gates: [{ id: 'expected-artifacts', tier: 'required', status: 'PASS' }],
    };
    payload.final = { implementation_attempts: { rework_total: reworkTotal(loop, episode) } };
  }
  if (episode.role === 'checker' && (terminalStatus === 'approved' || terminalStatus === 'rejected')) {
    const normalizedVerdict = ['APPROVE', 'CONCERN', 'REQUEST_CHANGES'].includes(verdict)
      ? verdict
      : terminalStatus === 'approved' ? 'APPROVE' : 'REQUEST_CHANGES';
    payload.review_results = {
      verdicts: [{ producer: episode.plugin, value: normalizedVerdict }],
      rounds: reviewRounds(loop, episode),
    };
    payload.final = {
      accepted: {
        decided_by: 'deep-loop-kernel',
        verdict: terminalStatus === 'approved',
        signals: [{ kind: 'proof-verdict' }],
      },
    };
    if (effectiveReviewSource === 'imported-stdin') {
      payload.artifact_digests = [{
        path: `reviews/${reportSha256}.json`,
        sha256: reportSha256,
      }];
    }
  }

  const document = {
    schema_version: ROUTE_OBSERVATION_SCHEMA_VERSION,
    envelope,
    payload,
  };
  if (forbiddenKeyPresent(document)) throw new Error('OBSERVATION_FORBIDDEN_KEY_INTERNAL');
  return { ok: true, document, subject_sha256: subjectHash };
}

export function serializeObservation(document) {
  const json = JSON.stringify(document, null, 2);
  if (json === undefined) throw new TypeError('OBSERVATION_SERIALIZE_INVALID');
  return Buffer.from(escapeNonAscii(json), 'utf8');
}

export function assertObservationSize(bytes, max = OBSERVATION_MAX_FILE_BYTES) {
  const size = Buffer.byteLength(bytes);
  return size <= max
    ? { ok: true }
    : { ok: false, reason: 'observation-too-large', bytes: size };
}

export function assertMaxFileBytes(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > OBSERVATION_MAX_FILE_BYTES) {
    throw new RangeError('OBSERVATION_MAX_FILE_BYTES_INVALID');
  }
  return value;
}

export function projectValidationForCli(validation) {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)
    || !VALIDATION_STATES.has(validation.state)) return undefined;
  return {
    state: validation.state,
    ...(VALIDATION_REASONS.includes(validation.reason) ? { reason: validation.reason } : {}),
    ...(typeof validation.detail === 'string'
      && /^(?:I-[A-Z0-9-]{1,30}|unknown)$/.test(validation.detail)
      ? { detail: validation.detail }
      : {}),
    ...(Number.isInteger(validation.exit_status) ? { exit_status: validation.exit_status } : {}),
  };
}

export function projectObservationForCli(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return undefined;
  const out = { emitted: observation.emitted === true };
  if (observation.emitted === true) {
    out.created = observation.created === true;
    if (typeof observation.path === 'string'
      && /^observations\/[0-9a-f]{64}\.json$/.test(observation.path)) out.path = observation.path;
    if (HEX64_RE.test(observation.sha256 || '')) out.sha256 = observation.sha256;
    if (HEX64_RE.test(observation.subject_sha256 || '')) out.subject_sha256 = observation.subject_sha256;
  } else if (OBSERVATION_REASONS.includes(observation.reason)) {
    out.reason = observation.reason;
  }
  const validation = projectValidationForCli(observation.validation);
  if (validation) out.validation = validation;
  return out;
}

export function readFlags(platform, constants = fs.constants) {
  return platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
}

const ZERO = 0n;
const identityUsable = stat => typeof stat?.dev === 'bigint'
  && typeof stat?.ino === 'bigint'
  && stat.dev !== ZERO
  && stat.ino !== ZERO;
const sameIdentity = (left, right) => typeof left?.dev === 'bigint'
  && typeof left?.ino === 'bigint'
  && typeof right?.dev === 'bigint'
  && typeof right?.ino === 'bigint'
  && left.dev === right.dev
  && left.ino === right.ino;

function stableOpenedFile(before, opened, platform) {
  if (!opened.isFile() || opened.size !== before.size) return false;
  if (platform === 'win32') {
    return identityUsable(before) && identityUsable(opened) && sameIdentity(before, opened);
  }
  return sameIdentity(before, opened);
}

export function readBoundedNoFollow(abs, maxBytes, deps = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MANIFEST_MAX_FILE_BYTES) {
    throw new RangeError('BOUNDED_READ_MAX_BYTES_INVALID');
  }
  const {
    platform = process.platform,
    lstatFn = fs.lstatSync,
    openFn = fs.openSync,
    fstatFn = fs.fstatSync,
    readFn = fs.readSync,
    closeFn = fs.closeSync,
    constants = fs.constants,
    allocFn = Buffer.allocUnsafe,
  } = deps;
  const before = lstatFn(abs, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) return { ok: false, reason: 'not-regular' };
  if (before.size > BigInt(maxBytes)) return { ok: false, reason: 'too-large' };
  if (platform === 'win32' && !identityUsable(before)) return { ok: false, reason: 'identity-unavailable' };

  let fd;
  try {
    fd = openFn(abs, readFlags(platform, constants));
    const opened = fstatFn(fd, { bigint: true });
    if (!stableOpenedFile(before, opened, platform)) return { ok: false, reason: 'unstable' };
    if (opened.size > BigInt(maxBytes)) return { ok: false, reason: 'too-large' };
    const buffer = allocFn(maxBytes + 1);
    let offset = 0;
    for (;;) {
      const count = readFn(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
      if (offset > maxBytes || BigInt(offset) > opened.size) {
        return { ok: false, reason: 'grew' };
      }
    }
    const after = fstatFn(fd, { bigint: true });
    if (after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || !sameIdentity(after, opened)
      || BigInt(offset) !== opened.size) return { ok: false, reason: 'unstable' };
    return { ok: true, bytes: buffer.subarray(0, offset), size: opened.size };
  } finally {
    if (fd !== undefined) closeFn(fd);
  }
}

export function compareExistingObservation(abs, bytes, {
  maxFileBytes = OBSERVATION_MAX_FILE_BYTES,
  platform = process.platform,
  lstatFn = fs.lstatSync,
  openFn = fs.openSync,
  fstatFn = fs.fstatSync,
  readFn = fs.readSync,
  closeFn = fs.closeSync,
  constants = fs.constants,
  allocFn = Buffer.allocUnsafe,
} = {}) {
  assertMaxFileBytes(maxFileBytes);
  const collision = { emitted: false, reason: 'observation-collision' };
  const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const before = lstatFn(abs, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) return collision;
  if (before.size > BigInt(maxFileBytes) || before.size !== BigInt(expected.length)) return collision;
  if (platform === 'win32' && !identityUsable(before)) return collision;
  const result = readBoundedNoFollow(abs, maxFileBytes, {
    platform,
    lstatFn: () => before,
    openFn,
    fstatFn,
    readFn,
    closeFn,
    constants,
    allocFn,
  });
  if (!result.ok || result.size !== BigInt(expected.length) || result.bytes.length !== expected.length) {
    return collision;
  }
  return result.bytes.equals(expected) ? { emitted: true, created: false } : collision;
}

export function readKernelManifestVersion(abs, deps = {}) {
  try {
    const result = readBoundedNoFollow(abs, MANIFEST_MAX_FILE_BYTES, deps);
    if (!result.ok) return { ok: false };
    const manifest = JSON.parse(result.bytes.toString('utf8'));
    return SEMVER_RE.test(manifest?.version || '')
      ? { ok: true, version: manifest.version }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function readJsonManifest(abs) {
  try {
    const result = readBoundedNoFollow(abs, MANIFEST_MAX_FILE_BYTES);
    if (!result.ok) return null;
    const parsed = JSON.parse(result.bytes.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function supportedRouterVersion(version) {
  if (!SEMVER_RE.test(version || '')) return false;
  const [major, minor] = version.split('.', 2).map(Number);
  return major > 1 || (major === 1 && minor >= 4);
}

function readRouterInstallMetadata(routeTaskRealpath) {
  const root = resolve(dirname(routeTaskRealpath), '..', '..', '..');
  const packageManifest = readJsonManifest(join(root, 'package.json'));
  const pluginManifest = readJsonManifest(join(root, '.claude-plugin', 'plugin.json'));
  if (!packageManifest || !pluginManifest
    || packageManifest.name !== 'deep-model-router'
    || pluginManifest.name !== packageManifest.name
    || pluginManifest.version !== packageManifest.version
    || !supportedRouterVersion(packageManifest.version)) {
    return { ok: false, reason: 'router-missing' };
  }
  const validator = join(dirname(routeTaskRealpath), 'validate_observation.py');
  try {
    const stat = fs.lstatSync(validator);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { ok: false, reason: 'validator-missing' };
    }
    const canonicalValidator = (fs.realpathSync.native || fs.realpathSync)(validator);
    // The route-task parent is already canonical and the final component was
    // lstat-checked above. Keep the OS-canonical spelling: Windows realpath may
    // legitimately change drive-letter casing or separators for the same file.
    return {
      ok: true,
      root,
      version: packageManifest.version,
      validator: canonicalValidator,
    };
  } catch {
    return { ok: false, reason: 'validator-missing' };
  }
}

function validatorDetail(stderr) {
  const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
  const match = text.match(/^(I-[A-Z0-9-]{1,30})/);
  return match ? match[1] : 'unknown';
}

function withExitStatus(validation, status) {
  return Number.isInteger(status) ? { ...validation, exit_status: status } : validation;
}

function runObservationValidator({ env, home, python, abs, run }) {
  if (env.DEEP_LOOP_ROUTE_OBSERVATION_VALIDATE !== '1') return { state: 'disabled' };
  let routeTask;
  try {
    routeTask = locateDeepModelRouter({ env, home });
  } catch {
    routeTask = null;
  }
  if (!routeTask) return { state: 'unavailable', reason: 'router-missing' };
  const metadata = readRouterInstallMetadata(routeTask);
  if (!metadata.ok) return { state: 'unavailable', reason: metadata.reason };
  const executable = python || env.PYTHON || 'python3';
  const result = spawnSync(executable, [
    metadata.validator,
    '--file', abs,
    '--root', run,
    '--check-refs',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
    env,
    cwd: run,
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') {
    return { state: 'unavailable', reason: 'python-unavailable' };
  }
  if (result.error?.code === 'ETIMEDOUT') {
    return { state: 'unavailable', reason: 'timeout' };
  }
  if (result.error?.code === 'ENOBUFS') {
    return { state: 'unavailable', reason: 'max-buffer' };
  }
  if (result.error) return { state: 'unavailable', reason: 'spawn-error' };
  if (result.signal !== null) return { state: 'unavailable', reason: 'signal' };
  if (result.status === 0) return { state: 'valid', exit_status: 0 };
  if (result.status === 1) {
    return { state: 'invalid', reason: 'invalid', detail: validatorDetail(result.stderr), exit_status: 1 };
  }
  if (result.status === 2) return { state: 'usage', reason: 'usage', exit_status: 2 };
  return withExitStatus({ state: 'unavailable', reason: 'spawn-error' }, result.status);
}

const NODE_PLATFORMS = new Set([
  'aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32',
]);
const INTERNAL_KEYS = new Set([
  'platform', 'mkdirFn', 'directoryBarrierAt', 'atomicCreateDeps', 'atomicCreateFn',
  'compareExistingFn', 'stderr',
]);
const ATOMIC_CREATE_DEP_KEYS = new Set([
  'tempPathFactory', 'writeFn', 'openFn', 'fsyncFn', 'closeFn', 'linkFn', 'unlinkFn',
  'monotonicNowFn', 'sleepFn', 'barrierAt', 'assertParentFn',
]);
const TERMINAL_STATUSES = new Set(['done', 'abandoned', 'approved', 'rejected']);

function invalidInternal() {
  throw new Error('OBSERVATION_INTERNAL_INVALID');
}

function validateInternal(internal) {
  if (!internal || typeof internal !== 'object' || Array.isArray(internal)) invalidInternal();
  for (const key of Object.keys(internal)) if (!INTERNAL_KEYS.has(key)) invalidInternal();
  const atomicCreateDeps = internal.atomicCreateDeps === undefined ? {} : internal.atomicCreateDeps;
  if (!atomicCreateDeps || typeof atomicCreateDeps !== 'object' || Array.isArray(atomicCreateDeps)) invalidInternal();
  for (const key of Object.keys(atomicCreateDeps)) {
    if (key === 'platform' || !ATOMIC_CREATE_DEP_KEYS.has(key)) invalidInternal();
  }
  const platform = internal.platform === undefined ? process.platform : internal.platform;
  if (!NODE_PLATFORMS.has(platform)) invalidInternal();
  for (const key of ['mkdirFn', 'directoryBarrierAt', 'atomicCreateFn', 'compareExistingFn']) {
    if (internal[key] !== undefined && typeof internal[key] !== 'function') invalidInternal();
  }
  return { platform, atomicCreateDeps };
}

function snapshotValid(loop, runId, event, episodeId, terminalStatus) {
  return !!loop
    && typeof loop === 'object'
    && !Array.isArray(loop)
    && loop.run_id === runId
    && Array.isArray(loop.episodes)
    && typeof episodeId === 'string'
    && episodeId !== ''
    && loop.episodes.some(episode => episode?.id === episodeId)
    && !!event
    && typeof event === 'object'
    && !Array.isArray(event)
    && Number.isInteger(event.seq)
    && typeof event.ts === 'string'
    && TERMINAL_STATUSES.has(terminalStatus);
}

function directoryUnsafe() {
  return { emitted: false, reason: 'observation-directory-unsafe' };
}

function mappedPublicationFailure(error, parentUnsafeObserved) {
  const message = String(error?.message || error);
  if (parentUnsafeObserved
    || message.startsWith('OBSERVATION_DIRECTORY_UNSAFE')
    || message.startsWith('FILE_IDENTITY_UNAVAILABLE')) return directoryUnsafe();
  if (message.startsWith('OBSERVATION_PUBLISH_UNSUPPORTED')) {
    return { emitted: false, reason: 'observation-publish-unsupported' };
  }
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code)
    ? error.code
    : undefined;
  return {
    emitted: false,
    reason: 'observation-write-failed',
    ...(code ? { code } : {}),
  };
}

function emittedResult({ created, path, bytes, subject }) {
  return {
    emitted: true,
    created,
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    subject_sha256: subject,
  };
}

// Parent identity checks detect observable replacement and fail-open. Path-only Node fs calls still
// leave the adjacent syscall windows described by the repository's cooperative threat model.
export function emitRouteObservation(root, runId, options, internal = {}) {
  const optionObject = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const maxFileBytes = optionObject.maxFileBytes === undefined
    ? OBSERVATION_MAX_FILE_BYTES
    : optionObject.maxFileBytes;
  assertMaxFileBytes(maxFileBytes);
  const { platform: effectivePlatform, atomicCreateDeps } = validateInternal(internal);
  const {
    loop,
    event,
    episodeId,
    terminalStatus,
    verdict,
    reviewSource,
    env = process.env,
    home,
    python,
    kernelVersion,
  } = optionObject;
  if (!snapshotValid(loop, runId, event, episodeId, terminalStatus)) {
    return { emitted: false, reason: 'snapshot-invalid' };
  }

  let canonicalRoot;
  let effectiveKernelVersion = kernelVersion;
  if (effectiveKernelVersion === undefined) {
    const manifest = readKernelManifestVersion(DEEP_LOOP_MANIFEST_PATH);
    if (!manifest.ok) return { emitted: false, reason: 'kernel-version-unavailable' };
    effectiveKernelVersion = manifest.version;
  }
  const built = buildRouteObservation({
    loop,
    event,
    episodeId,
    terminalStatus,
    verdict,
    reviewSource,
    kernelVersion: effectiveKernelVersion,
  });
  if (!built.ok) return { emitted: false, reason: built.reason };
  const bytes = serializeObservation(built.document);
  const size = assertObservationSize(bytes, maxFileBytes);
  if (!size.ok) return { emitted: false, reason: size.reason };

  canonicalRoot ||= canonicalProjectRoot(root);
  let parentUnsafeObserved = false;
  let publication;
  let publishedAbs;
  let publishedRun;
  try {
    const lexicalRun = runDir(canonicalRoot, runId);
    const run = canonicalNonSymlinkDirectory(lexicalRun);
    if (!run || !pathWithin(canonicalRoot, run)) return directoryUnsafe();
    let runBefore;
    try {
      runBefore = captureStableFileIdentity(run);
    } catch {
      return directoryUnsafe();
    }
    const assertRunParent = () => {
      const again = canonicalNonSymlinkDirectory(lexicalRun);
      if (!again || again !== run || !pathWithin(canonicalRoot, again)
        || !matchingStableFileIdentity(runBefore, captureStableFileIdentity(again))) {
        throw new Error('OBSERVATION_DIRECTORY_UNSAFE');
      }
    };
    const mkdirFn = internal.mkdirFn || fs.mkdirSync;
    const directoryBarrierAt = internal.directoryBarrierAt || (() => {});
    const dir = join(run, OBSERVATION_DIR);
    directoryBarrierAt('before-mkdir-check');
    assertRunParent('pre-mkdir');
    directoryBarrierAt('mkdir');
    mkdirFn(dir, { recursive: true });
    assertRunParent('post-mkdir');

    const canonicalDir = canonicalNonSymlinkDirectory(dir);
    if (!canonicalDir || !pathWithin(run, canonicalDir)) return directoryUnsafe();
    let parentBefore;
    try {
      parentBefore = captureStableFileIdentity(canonicalDir);
    } catch {
      return directoryUnsafe();
    }
    const assertObservationParent = () => {
      try {
        const again = canonicalNonSymlinkDirectory(dir);
        if (!again || again !== canonicalDir || !pathWithin(run, again)
          || !matchingStableFileIdentity(parentBefore, captureStableFileIdentity(again))) {
          throw new Error('OBSERVATION_DIRECTORY_UNSAFE');
        }
      } catch (error) {
        parentUnsafeObserved = true;
        if (String(error?.message || error).startsWith('OBSERVATION_DIRECTORY_UNSAFE')) throw error;
        throw new Error('OBSERVATION_DIRECTORY_UNSAFE', { cause: error });
      }
    };
    const relativePath = relObservationPath(built.subject_sha256);
    const abs = join(canonicalDir, `${built.subject_sha256}.json`);
    const compareExistingFn = internal.compareExistingFn || compareExistingObservation;
    const compare = () => {
      assertObservationParent('pre-compare');
      try {
        return compareExistingFn(abs, bytes, {
          maxFileBytes,
          platform: effectivePlatform,
        });
      } finally {
        assertObservationParent('post-compare');
      }
    };
    if (fs.existsSync(abs)) {
      const compared = compare();
      if (!compared.emitted) return compared;
      publication = emittedResult({
        created: false,
        path: relativePath,
        bytes,
        subject: built.subject_sha256,
      });
    } else {
      const atomicCreateFn = internal.atomicCreateFn || durableAtomicCreate;
      const published = atomicCreateFn(abs, bytes, {
        ...atomicCreateDeps,
        platform: effectivePlatform,
        assertParentFn: assertObservationParent,
      });
      if (published.created === false) {
        const compared = compare();
        if (!compared.emitted) return compared;
        publication = emittedResult({
          created: false,
          path: relativePath,
          bytes,
          subject: built.subject_sha256,
        });
      } else {
        publication = emittedResult({
          created: true,
          path: relativePath,
          bytes,
          subject: built.subject_sha256,
        });
      }
    }
    publishedAbs = abs;
    publishedRun = run;
  } catch (error) {
    return mappedPublicationFailure(error, parentUnsafeObserved);
  }
  const validation = runObservationValidator({
    env,
    home,
    python,
    abs: publishedAbs,
    run: publishedRun,
  });
  return { ...publication, validation };
}

function boundedReason(error) {
  const match = String(error?.message || error).match(/^([A-Z_][A-Z0-9_-]{0,63})/);
  return match ? match[1] : 'UNKNOWN';
}

function warnObservation(runId, text, stderr) {
  try {
    const safeRunId = validIdentity(runId) ? runId : 'unknown';
    const target = stderr && typeof stderr.write === 'function' ? stderr : process.stderr;
    target.write(`[deep-loop:warn] route-observation ${safeRunId}: ${text} — skipped\n`);
  } catch {
    // Warning output is best-effort and cannot change a committed terminal mutation.
  }
}

function safeStderr(internal) {
  try { return internal?.stderr; } catch { return { write: () => {} }; }
}

export function observeTerminalEpisode(root, runId, options, internal = {}) {
  try {
    const result = emitRouteObservation(root, runId, options, internal);
    if (result.emitted === false) warnObservation(runId, result.reason, safeStderr(internal));
    return result;
  } catch (error) {
    let code = 'UNKNOWN';
    try { code = boundedReason(error); } catch { /* retain the bounded fallback */ }
    warnObservation(runId, `observation-failed (${code})`, safeStderr(internal));
    return { emitted: false, reason: 'observation-failed' };
  }
}
