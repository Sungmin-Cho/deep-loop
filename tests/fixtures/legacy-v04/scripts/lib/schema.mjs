import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, posix, win32 } from 'node:path';
import { normalizePortableRelativePath } from './fs-safe.mjs';
import { SESSION_RUNTIMES } from './runtime.mjs';
import { isRoutingRecord } from './router-adapter.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const LAUNCHER_KINDS = Object.freeze(['wt', 'powershell', 'tmux']);

export function loadSchema() {
  return JSON.parse(readFileSync(join(here, '../../schemas/loop-run.schema.json'), 'utf8'));
}

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function portableAbsolute(path) {
  return typeof path === 'string' && path.length > 0 && (isAbsolute(path) || win32.isAbsolute(path));
}

function exactObject(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => allowed.has(key));
}

function canonicalIso(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function portableRel(value, prefix = null) {
  const normalized = normalizePortableRelativePath(value);
  return normalized !== null && normalized === value && (prefix === null || normalized.startsWith(prefix));
}

const REVIEW_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FROZEN_REVIEW_CLAIM_KEYS = Object.freeze([
  'run_id', 'reviewer_id', 'checker_episode_id', 'target_maker', 'attempt_id',
  'workstream_id', 'point', 'project_root', 'runtime', 'lease_owner',
  'lease_generation', 'artifacts', 'invalidated_at', 'reason',
]);
const REVIEW_EVIDENCE_KEYS = Object.freeze([
  'insights_path', 'emit_ulid', 'producer_run_id', 'sha256', 'candidates',
]);

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value);
}

function validFrozenArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length > 256) return false;
  let previous = null;
  for (const artifact of artifacts) {
    if (!exactObject(artifact, ['path', 'sha256']) || !portableRel(artifact.path)
      || !SHA256.test(artifact.sha256 || '') || (previous !== null && artifact.path <= previous)) return false;
    previous = artifact.path;
  }
  return true;
}

function validFrozenEvidence(evidence) {
  if (evidence === null) return true;
  return exactObject(evidence, REVIEW_EVIDENCE_KEYS)
    && portableRel(evidence.insights_path, '.deep-loop/insights/')
    && nonEmptyString(evidence.emit_ulid)
    && (evidence.producer_run_id === null || nonEmptyString(evidence.producer_run_id))
    && (evidence.sha256 === null || SHA256.test(evidence.sha256 || ''))
    && Array.isArray(evidence.candidates)
    && evidence.candidates.every(candidate => candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate));
}

function validFrozenContract(contract) {
  return exactObject(contract, ['slice', 'path', 'sha256'])
    && contract.slice === 'HILLCLIMB-001'
    && portableRel(contract.path)
    && SHA256.test(contract.sha256 || '');
}

function validInvalidatedReviewClaim(claim) {
  if (!exactObject(claim, FROZEN_REVIEW_CLAIM_KEYS, ['evidence', 'contract'])) return false;
  for (const field of [
    'run_id', 'checker_episode_id', 'target_maker', 'workstream_id', 'point', 'lease_owner',
  ]) if (!nonEmptyString(claim[field])) return false;
  return ['deep-review', 'subagent-checker'].includes(claim.reviewer_id)
    && REVIEW_ATTEMPT_ID.test(claim.attempt_id || '')
    && portableAbsolute(claim.project_root) && !/[\0\r\n]/.test(claim.project_root)
    && SESSION_RUNTIMES.includes(claim.runtime)
    && Number.isSafeInteger(claim.lease_generation) && claim.lease_generation > 0
    && validFrozenArtifacts(claim.artifacts)
    && claim.reason === 'project-root-relocated'
    && canonicalIso(claim.invalidated_at)
    && (!Object.hasOwn(claim, 'evidence') || validFrozenEvidence(claim.evidence))
    && (!Object.hasOwn(claim, 'contract') || validFrozenContract(claim.contract));
}

function validateAttendedLaunchApproval(value, errors) {
  const fail = detail => errors.push(`autonomy.attended_launch_approval ${detail}`);
  if (value === null) return;
  if (!exactObject(value, ['style', 'approved_at'])) { fail('must be null or an exact style/approved_at object'); return; }
  if (!['visible', 'desktop'].includes(value.style)) fail('style must be visible or desktop');
  if (!canonicalIso(value.approved_at)) fail('approved_at must be canonical ISO-8601');
}

const WORKSTREAM_SCOPE_KEYS = Object.freeze([
  'kind', 'workstream_id', 'bound_at_seq', 'terminal_event', 'closed_at', 'superseded_at',
]);
const COMPACT_CURSOR_KEYS = Object.freeze([
  'checkpoint_key', 'context_sha256', 'pre_restore_loop_hash', 'owner_run_id',
  'generation', 'runtime', 'workstream_id', 'episode_id', 'baseline_turns',
  'restored_at', 'cycle', 'restore_event', 'admission', 'provider_evidence',
]);
const LEGACY_SCOPE_KEYS = Object.freeze([
  'kind', 'workstream_id', 'bound_at_seq', 'terminal_event', 'closed_at',
]);

function validBoundaryIdentity(value) {
  return exactObject(value, ['seq', 'checksum'])
    && Number.isSafeInteger(value.seq)
    && value.seq > 0
    && /^[0-9a-f]{64}$/.test(value.checksum || '');
}

function validateSessionScope(scope, session, errors) {
  const fail = detail => errors.push(`session_chain.sessions[].scope ${detail}`);
  if (scope?.kind === 'workstream') {
    if (!exactObject(scope, WORKSTREAM_SCOPE_KEYS, ['supersede_reason', 'superseded_by'])) {
      fail('must have the exact Workstream scope shape');
      return;
    }
    if (scope.workstream_id !== null && (typeof scope.workstream_id !== 'string' || scope.workstream_id.length === 0)) {
      fail('workstream_id must be null or a non-empty string');
    }
    if (scope.bound_at_seq !== null && (!Number.isSafeInteger(scope.bound_at_seq) || scope.bound_at_seq < 1)) {
      fail('bound_at_seq must be null or a positive integer');
    }
    if (scope.terminal_event !== null) {
      if (!exactObject(scope.terminal_event, ['seq', 'checksum'])
        || !Number.isSafeInteger(scope.terminal_event.seq) || scope.terminal_event.seq < 1
        || !/^[0-9a-f]{64}$/.test(scope.terminal_event.checksum || '')) {
        fail('terminal_event must be null or exact positive seq/lowercase checksum');
      }
    }
    for (const field of ['closed_at', 'superseded_at']) {
      if (scope[field] !== null && !canonicalIso(scope[field])) fail(`${field} must be null or canonical ISO-8601`);
    }
    const recoveryKeys = ['supersede_reason', 'superseded_by'].filter(key => Object.hasOwn(scope, key));
    if (recoveryKeys.length !== 0 && recoveryKeys.length !== 2) fail('supersede_reason and superseded_by must appear together');
    if (recoveryKeys.length === 2
      && ((typeof scope.supersede_reason !== 'string' || scope.supersede_reason.length === 0)
        || (typeof scope.superseded_by !== 'string' || scope.superseded_by.length === 0))) {
      fail('supersede_reason and superseded_by must be non-empty strings');
    }
    return;
  }
  if (scope?.kind === 'legacy') {
    if (!exactObject(scope, LEGACY_SCOPE_KEYS)) { fail('must have the exact legacy scope shape'); return; }
    if (scope.workstream_id !== null || scope.bound_at_seq !== null || scope.terminal_event !== null) {
      fail('legacy identity fields must be null');
    }
    const expectedClosedAt = session.ended_at ?? null;
    if (scope.closed_at !== expectedClosedAt) fail('legacy closed_at must mirror session.ended_at');
    if (scope.closed_at !== null && !canonicalIso(scope.closed_at)) fail('legacy closed_at must be null or canonical ISO-8601');
    return;
  }
  fail('kind must be workstream or legacy');
}

function validateCompactCursor(cursor, session, errors) {
  if (cursor === undefined) return;
  const fail = detail => errors.push(`session_chain.sessions[].compact_cursor ${detail}`);
  if (!exactObject(cursor, COMPACT_CURSOR_KEYS)) {
    fail('must have the exact compact cursor shape');
    return;
  }
  for (const field of ['checkpoint_key', 'context_sha256', 'pre_restore_loop_hash']) {
    if (!SHA256.test(cursor[field] || '')) fail(`${field} must be lowercase 64-hex`);
  }
  if (cursor.owner_run_id !== session.run_id) fail('owner_run_id must match containing session run_id');
  if (!Number.isSafeInteger(cursor.generation) || cursor.generation < 1) fail('generation must be a positive integer');
  if (!SESSION_RUNTIMES.includes(cursor.runtime)) fail('runtime must be claude, codex, or grok');
  for (const field of ['workstream_id', 'episode_id']) {
    if (!nonEmptyString(cursor[field])) fail(`${field} must be a non-empty safe string`);
  }
  if (!Number.isSafeInteger(cursor.baseline_turns) || cursor.baseline_turns < 0) {
    fail('baseline_turns must be a non-negative safe integer');
  }
  if (!canonicalIso(cursor.restored_at)) fail('restored_at must be canonical ISO-8601');
  if (!Number.isSafeInteger(cursor.cycle) || cursor.cycle < 1) fail('cycle must be a positive integer');
  if (!validBoundaryIdentity(cursor.restore_event)) fail('restore_event must be an exact boundary identity');

  const admission = cursor.admission;
  if (!exactObject(admission, ['kind', 'source', 'receipt_trigger'])) {
    fail('admission must have the exact kind/source/receipt_trigger shape');
  } else if (admission.kind === 'postcompact-observation') {
    if (!['sessionstart', 'external-controller'].includes(admission.source)
      || !['manual', 'auto'].includes(admission.receipt_trigger)) {
      fail('postcompact observation admission is invalid');
    }
  } else if (admission.kind === 'human-attested') {
    if (admission.source !== 'direct-human-skill' || admission.receipt_trigger !== null) {
      fail('human-attested admission is invalid');
    }
  } else {
    fail('admission kind is invalid');
  }

  const evidence = cursor.provider_evidence;
  if (!exactObject(evidence, ['recorded', 'supplied', 'matched'])
    || !['recorded', 'supplied', 'matched'].every(field => typeof evidence?.[field] === 'boolean')) {
    fail('provider_evidence must be an exact ordered boolean object');
  } else if (evidence.matched !== (evidence.recorded && evidence.supplied)) {
    fail('provider_evidence combination is invalid for a successful durable cursor');
  }
}

// spec §3.2: `session_chain.lease.acquisition_receipt` — exact-key object(전 필드 동시 존재), optional.
// 1세대/기존 run 의 lease 에는 필드가 없으므로 undefined 는 통과한다.
const RECEIPT_KEYS = [
  'takeover_kind', 'child_run_id', 'superseded_owner_run_id', 'boundary_event',
  'project_root_digest', 'project_binding_generation', 'handoff_rel', 'reservation_key',
  'from_generation', 'to_generation', 'at', 'attempt_id',
];
const RECEIPT_TAKEOVER_KINDS = [
  'boundary-handoff', 'legacy-handoff', 'boundary-recovery',
  'affinity-supersession', 'project-root', 'released-takeover',
];

function validateAcquisitionReceipt(receipt, errors) {
  if (receipt === undefined) return;
  const fail = detail => errors.push(`session_chain.lease.acquisition_receipt ${detail}`);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    fail('must be an object');
    return;
  }
  const actual = Object.keys(receipt).sort();
  if (actual.join(',') !== [...RECEIPT_KEYS].sort().join(',')) {
    fail(`must carry exactly ${RECEIPT_KEYS.join(', ')}`);
    return;
  }
  if (!RECEIPT_TAKEOVER_KINDS.includes(receipt.takeover_kind)) fail('takeover_kind is invalid');
  for (const key of ['child_run_id', 'superseded_owner_run_id', 'at']) {
    if (typeof receipt[key] !== 'string' || receipt[key].length === 0) fail(`${key} must be a non-empty string`);
  }
  if (receipt.boundary_event !== null && !validBoundaryIdentity(receipt.boundary_event)) {
    fail('boundary_event must be null or an exact boundary identity');
  }
  if (receipt.project_root_digest !== null && !/^[0-9a-f]{64}$/.test(receipt.project_root_digest || '')) {
    fail('project_root_digest must be null or lowercase 64-hex');
  }
  for (const key of ['project_binding_generation']) {
    if (receipt[key] !== null && !(Number.isSafeInteger(receipt[key]) && receipt[key] >= 1)) {
      fail(`${key} must be null or a positive integer`);
    }
  }
  if (receipt.handoff_rel !== null && !portableRel(receipt.handoff_rel, 'handoffs/')) {
    fail('handoff_rel must be null or a safe handoffs/ relative path');
  }
  if (receipt.reservation_key !== null
    && (typeof receipt.reservation_key !== 'string' || receipt.reservation_key.length === 0)) {
    fail('reservation_key must be null or a non-empty string');
  }
  for (const key of ['from_generation', 'to_generation']) {
    if (!Number.isSafeInteger(receipt[key]) || receipt[key] < 1) fail(`${key} must be a positive integer`);
  }
  if (receipt.attempt_id !== null && !/^[A-Za-z0-9_-]{8,128}$/.test(receipt.attempt_id || '')) {
    fail('attempt_id must be null or match ^[A-Za-z0-9_-]{8,128}$');
  }
}

function validateSessions(sc, errors) {
  if (!Array.isArray(sc?.sessions)) {
    errors.push('session_chain.sessions must be array');
    return;
  }
  for (const session of sc.sessions) {
    if (session === null || typeof session !== 'object' || Array.isArray(session)) {
      errors.push('session_chain.sessions[] must be object');
      continue;
    }
    validateSessionScope(session.scope, session, errors);
    validateCompactCursor(session.compact_cursor, session, errors);
    if (Object.hasOwn(session, 'handoff_path')) errors.push('session_chain.sessions[].handoff_path is forbidden in v0.4');
    if (session.handoff_rel !== undefined && !portableRel(session.handoff_rel, 'handoffs/')) {
      errors.push('session_chain.sessions[].handoff_rel must be a safe handoffs/ relative path');
    }
    const boundaryParentFields = [
      'parent_run_id', 'parent_boundary_event',
      'project_binding_generation', 'project_root_digest',
    ];
    const boundaryParentPresent = boundaryParentFields.filter(key => Object.hasOwn(session, key));
    if (boundaryParentPresent.length !== 0 && boundaryParentPresent.length !== boundaryParentFields.length) {
      errors.push('session_chain.sessions[] boundary parent fields must appear together');
    } else if (boundaryParentPresent.length === boundaryParentFields.length) {
      if (typeof session.parent_run_id !== 'string' || session.parent_run_id.length === 0) {
        errors.push('session_chain.sessions[].parent_run_id must be non-empty string');
      }
      if (!validBoundaryIdentity(session.parent_boundary_event)) {
        errors.push('session_chain.sessions[].parent_boundary_event must be an exact boundary identity');
      }
      if (!Number.isSafeInteger(session.project_binding_generation) || session.project_binding_generation < 1) {
        errors.push('session_chain.sessions[].project_binding_generation must be a positive integer');
      }
      if (!/^[0-9a-f]{64}$/.test(session.project_root_digest || '')) {
        errors.push('session_chain.sessions[].project_root_digest must be lowercase 64-hex');
      }
    }
    const recoveryFields = ['recovered_from', 'recovery_kind', 'recovery_rel', 'recovery_sha256'];
    const present = recoveryFields.filter(key => Object.hasOwn(session, key));
    if (present.length !== 0 && present.length !== recoveryFields.length) {
      errors.push('session_chain.sessions[] recovery fields must appear together');
    } else if (present.length === recoveryFields.length) {
      if (typeof session.recovered_from !== 'string' || session.recovered_from.length === 0) errors.push('session_chain.sessions[].recovered_from must be non-empty string');
      if (!['affinity-supersession', 'boundary-recovery'].includes(session.recovery_kind)) errors.push('session_chain.sessions[].recovery_kind is invalid');
      if (!portableRel(session.recovery_rel, 'recoveries/')) errors.push('session_chain.sessions[].recovery_rel must be a safe recoveries/ relative path');
      if (!/^[0-9a-f]{64}$/.test(session.recovery_sha256 || '')) errors.push('session_chain.sessions[].recovery_sha256 must be lowercase 64-hex');
    }
    const recoveryBindingFields = [
      'recovery_project_binding_generation',
      'recovery_project_root_digest',
    ];
    const recoveryBindingPresent = recoveryBindingFields
      .filter(key => Object.hasOwn(session, key));
    if (present.length === recoveryFields.length
      && recoveryBindingPresent.length !== recoveryBindingFields.length) {
      errors.push('session_chain.sessions[] recovery project binding fields are required with recovery fields');
    }
    if (recoveryBindingPresent.length !== 0
      && recoveryBindingPresent.length !== recoveryBindingFields.length) {
      errors.push('session_chain.sessions[] recovery project binding fields must appear together');
    } else if (recoveryBindingPresent.length === recoveryBindingFields.length) {
      if (present.length !== recoveryFields.length) {
        errors.push('session_chain.sessions[] recovery project binding requires recovery fields');
      }
      if (!Number.isSafeInteger(session.recovery_project_binding_generation)
        || session.recovery_project_binding_generation < 1) {
        errors.push('session_chain.sessions[].recovery_project_binding_generation must be a positive integer');
      }
      if (!/^[0-9a-f]{64}$/.test(session.recovery_project_root_digest || '')) {
        errors.push('session_chain.sessions[].recovery_project_root_digest must be lowercase 64-hex');
      }
    }
  }
}

function validateEpisodeV040(ep, errors) {
  if (Object.hasOwn(ep, 'request_path')) errors.push('episodes[].request_path is forbidden in v0.4');
  const expectedRequestRel = typeof ep.id === 'string' ? `episodes/${ep.id}/request.md` : null;
  if (!portableRel(ep.request_rel, 'episodes/') || ep.request_rel !== expectedRequestRel) {
    errors.push('episodes[].request_rel must exactly match episodes/<id>/request.md');
  }
  if (Object.hasOwn(ep, 'routing') && !isRoutingRecord(ep.routing)) {
    errors.push('episodes[].routing must be a frozen RouteDecision payload');
  }
  const invalidated = ep.invalidated_review_claims;
  if (invalidated === undefined) return;
  if (!Array.isArray(invalidated)) {
    errors.push('episodes[].invalidated_review_claims must be array');
    return;
  }
  for (const claim of invalidated) {
    if (!validInvalidatedReviewClaim(claim)) errors.push(
      'episodes[].invalidated_review_claims[] must be an exact frozen review claim with canonical invalidation metadata',
    );
  }
}

const APPROVAL_PACKAGE_KEYS = Object.freeze([
  'wrapper_path', 'wrapper_name', 'wrapper_version', 'optional_name', 'optional_spec',
  'native_name', 'native_version', 'target_triple', 'os', 'cpu',
]);
const LAUNCHER_APPROVAL_KEYS = Object.freeze([
  'kind', 'canonical_path', 'sha256', 'version', 'platform', 'arch', 'source',
  'authenticode', 'approved_by', 'approved_at',
]);
const AUTHENTICODE_KEYS = Object.freeze(['status', 'signer', 'thumbprint']);

function validateRuntimeExecutableApproval(approval, autonomy, errors) {
  const fail = detail => errors.push(`autonomy.runtime_executable_approval ${detail}`);
  if (approval === undefined || approval === null) return;
  if (typeof approval !== 'object' || Array.isArray(approval)) { fail('must be object or null'); return; }

  const runtime = approval.runtime;
  const storedRuntime = autonomy.session_runtime ?? 'claude';
  if (!SESSION_RUNTIMES.includes(runtime)) fail('runtime must be claude, codex, or grok');
  else if (runtime !== storedRuntime) fail('runtime must match immutable autonomy.session_runtime');
  if (!portableAbsolute(approval.canonical_path)) fail('canonical_path must be absolute');
  if (!/^[0-9a-f]{64}$/.test(approval.sha256 || '')) fail('sha256 must be lowercase 64-hex');
  for (const field of ['version', 'platform', 'arch', 'source']) {
    if (typeof approval[field] !== 'string' || approval[field].length === 0 || /[\0\r\n]/.test(approval[field])) {
      fail(`${field} must be a non-empty safe string`);
    }
  }
  if (!['official-npm-native', 'human-explicit'].includes(approval.source)) fail('source is invalid');
  if (approval.approved_by !== 'human') fail('approved_by must be human');
  if (typeof approval.approved_at !== 'string') fail('approved_at must be canonical ISO-8601');
  else {
    const timestamp = new Date(approval.approved_at);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== approval.approved_at) {
      fail('approved_at must be canonical ISO-8601');
    }
  }
  if (approval.authenticode !== null && (typeof approval.authenticode !== 'object' || Array.isArray(approval.authenticode))) {
    fail('authenticode must be object or null');
  }

  if (approval.source === 'human-explicit') {
    if (approval.package !== null) fail('human-explicit package must be null');
    return;
  }
  const pkg = approval.package;
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) { fail('package must be an object'); return; }
  const keys = Object.keys(pkg).sort();
  if (keys.length !== APPROVAL_PACKAGE_KEYS.length
    || !APPROVAL_PACKAGE_KEYS.every(key => keys.includes(key))) {
    fail('package fields are incomplete or unknown');
    return;
  }
  for (const field of APPROVAL_PACKAGE_KEYS.filter(field => !['os', 'cpu'].includes(field))) {
    if (typeof pkg[field] !== 'string' || pkg[field].length === 0 || /[\0\r\n]/.test(pkg[field])) {
      fail(`package.${field} must be a non-empty safe string`);
    }
  }
  if (!portableAbsolute(pkg.wrapper_path)) fail('package.wrapper_path must be absolute');
  if (!Array.isArray(pkg.os) || pkg.os.length !== 1 || pkg.os[0] !== approval.platform) {
    fail('package.os must exactly match platform');
  }
  if (!Array.isArray(pkg.cpu) || pkg.cpu.length !== 1 || pkg.cpu[0] !== approval.arch) {
    fail('package.cpu must exactly match arch');
  }
}

function validateLauncherExecutableApprovals(approvals, errors) {
  const prefix = 'autonomy.launcher_executable_approvals';
  const fail = detail => errors.push(`${prefix} ${detail}`);
  if (approvals === undefined) return;
  if (approvals === null || typeof approvals !== 'object' || Array.isArray(approvals)) {
    fail('must be an object when present');
    return;
  }
  const mapKeys = Object.keys(approvals);
  const unknown = mapKeys.filter(key => !LAUNCHER_KINDS.includes(key));
  if (unknown.length > 0) fail(`contains unknown keys: ${unknown.join(',')}`);

  for (const kind of LAUNCHER_KINDS) {
    if (!Object.hasOwn(approvals, kind) || approvals[kind] === null) continue;
    const approval = approvals[kind];
    const slotFail = detail => fail(`${kind} ${detail}`);
    if (typeof approval !== 'object' || Array.isArray(approval)) {
      slotFail('must be an object or null');
      continue;
    }
    const keys = Object.keys(approval).sort();
    if (keys.length !== LAUNCHER_APPROVAL_KEYS.length
      || !LAUNCHER_APPROVAL_KEYS.every(key => keys.includes(key))) {
      slotFail('fields are incomplete or unknown');
    }
    if (approval.kind !== kind) slotFail('kind must match its map key');
    const path = approval.canonical_path;
    const windowsLauncher = kind !== 'tmux';
    if (!portableAbsolute(path) || /[\0\r\n]/.test(path || '')
      || (windowsLauncher && (/^[\\/]{2}/.test(path || '') || /^[\\/](?:\?\?|device)[\\/]/i.test(path || '')))
      || /\.(?:cmd|bat|ps1|js|mjs|cjs)$/i.test(path || '')) {
      slotFail('canonical_path must be a safe absolute native path');
    } else {
      const name = windowsLauncher ? win32.basename(path).toLowerCase() : posix.basename(path);
      if ((kind === 'wt' && name !== 'wt.exe')
        || (kind === 'powershell' && name !== 'pwsh.exe' && name !== 'powershell.exe')
        || (kind === 'tmux' && name !== 'tmux')) {
        slotFail('canonical_path filename does not match kind');
      }
    }
    if (!/^[0-9a-f]{64}$/.test(approval.sha256 || '')) slotFail('sha256 must be lowercase 64-hex');
    if (typeof approval.version !== 'string' || approval.version.length === 0
      || approval.version.length > 256 || /[\0\r\n]/.test(approval.version)) {
      slotFail('version must be a non-empty safe string');
    }
    if (windowsLauncher && approval.platform !== 'win32') slotFail('platform must be win32');
    if (!windowsLauncher && !['linux', 'darwin'].includes(approval.platform)) {
      slotFail('platform must be linux or darwin');
    }
    if (typeof approval.arch !== 'string' || !/^[A-Za-z0-9_-]+$/.test(approval.arch)) {
      slotFail('arch must be a non-empty safe string');
    }
    if (approval.source !== 'human-explicit') slotFail('source must be human-explicit');
    if (approval.approved_by !== 'human') slotFail('approved_by must be human');
    if (typeof approval.approved_at !== 'string') slotFail('approved_at must be canonical ISO-8601');
    else {
      const timestamp = new Date(approval.approved_at);
      if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== approval.approved_at) {
        slotFail('approved_at must be canonical ISO-8601');
      }
    }

    const authenticode = approval.authenticode;
    if (!windowsLauncher && authenticode !== null) {
      slotFail('authenticode must be null for tmux');
      continue;
    }
    if (authenticode !== null) {
      if (typeof authenticode !== 'object' || Array.isArray(authenticode)) {
        slotFail('authenticode must be an exact object or null');
      } else {
        const authKeys = Object.keys(authenticode).sort();
        if (authKeys.length !== AUTHENTICODE_KEYS.length
          || !AUTHENTICODE_KEYS.every(key => authKeys.includes(key))) {
          slotFail('authenticode fields are incomplete or unknown');
        }
        if (authenticode.status !== 'valid') slotFail('authenticode.status must be valid');
        if (typeof authenticode.signer !== 'string' || authenticode.signer.length === 0
          || authenticode.signer.length > 512 || /[\0\r\n]/.test(authenticode.signer)) {
          slotFail('authenticode.signer must be a non-empty safe string');
        }
        if (typeof authenticode.thumbprint !== 'string'
          || !/^[0-9a-f]+$/.test(authenticode.thumbprint) || authenticode.thumbprint.length > 256) {
          slotFail('authenticode.thumbprint must be lowercase hex');
        }
      }
    }
  }
}

export function validate(loopJson, schema = loadSchema()) {
  const errors = [];
  for (const f of schema.required) {
    if (get(loopJson, f) === undefined) errors.push(`missing required field: ${f}`);
  }
  for (const [path, allowed] of Object.entries(schema.enums)) {
    const v = get(loopJson, path);
    if (v !== undefined && !allowed.includes(v)) errors.push(`invalid enum at ${path}: ${v}`);
  }
  // schema_version 정확 일치 (legacy는 readHashVerifiedState가 in-memory 마이그레이션 — validate에 구버전이
  // 도달하면 마이그레이션 누락 경로이므로 실패가 옳다)
  if (loopJson.schema_version !== undefined && loopJson.schema_version !== '0.4.0') {
    errors.push(`schema_version must be 0.4.0, got ${loopJson.schema_version}`);
  }
  // 배열 타입
  for (const arr of ['workstreams', 'episodes', 'active_workstreams', 'discovered_items']) {
    const v = get(loopJson, arr);
    if (v !== undefined && !Array.isArray(v)) errors.push(`${arr} must be array`);
  }
  // budget 숫자 필드 (Task 9가 소비하는 모든 수치)
  if (loopJson.budget) for (const k of ['total', 'spent', 'tokens_total', 'tokens_spent', 'per_session_turn_cap', 'max_wallclock_sec', 'soft_stop_ratio', 'hard_stop_ratio']) {
    const v = loopJson.budget[k];
    if (v !== undefined && typeof v !== 'number') errors.push(`budget.${k} must be number`);
  }
  // schema.properties is not read by this validator, so custom optional-field contracts live here.
  // session_effort/session_runtime/runtime_source enum membership is enforced by the loop above.
  const autonomy = loopJson.autonomy;
  const autonomyIsObject = autonomy !== null && typeof autonomy === 'object' && !Array.isArray(autonomy);
  if (autonomy !== undefined && !autonomyIsObject) errors.push('autonomy must be object');
  if (autonomyIsObject) {
    const sm = autonomy.session_model;
    if (sm !== undefined && typeof sm !== 'string') errors.push('autonomy.session_model must be string');
    const runtime = autonomy.session_runtime;
    const source = autonomy.runtime_source;
    if (runtime === undefined && source !== undefined) {
      errors.push('autonomy.runtime_source requires autonomy.session_runtime');
    }
    if (runtime !== undefined && source !== 'skill-asserted') {
      errors.push('autonomy.session_runtime requires autonomy.runtime_source skill-asserted');
    }
    if (!Object.hasOwn(autonomy, 'attended_launch_approval')) errors.push('missing required field: autonomy.attended_launch_approval');
    else validateAttendedLaunchApproval(autonomy.attended_launch_approval, errors);
    validateRuntimeExecutableApproval(autonomy.runtime_executable_approval, autonomy, errors);
    validateLauncherExecutableApprovals(autonomy.launcher_executable_approvals, errors);
  }
  // v1.10 continuation state belongs to session_chain and must remain validated even when autonomy is absent.
  const sc = loopJson.session_chain;
  if (sc && typeof sc === 'object') {
    const cm = sc.consumed_milestones;
    if (cm !== undefined && (!Array.isArray(cm) || cm.some(x => typeof x !== 'string'))) {
      errors.push('session_chain.consumed_milestones must be an array of strings');
    }
    const ht = sc.lease?.handoff_trigger;
    if (ht !== undefined && ht !== null && typeof ht !== 'string') {
      errors.push('session_chain.lease.handoff_trigger must be string or null');
    }
    const takeover = sc.lease?.takeover_kind;
    if (!sc.lease || !Object.hasOwn(sc.lease, 'takeover_kind')) {
      errors.push('missing required field: session_chain.lease.takeover_kind');
    } else if (takeover !== null && !['boundary-handoff', 'boundary-recovery', 'affinity-supersession'].includes(takeover)) {
      errors.push('session_chain.lease.takeover_kind is invalid');
    }
    const boundaryLeaseFields = [
      'handoff_boundary_event',
      'handoff_project_binding_generation',
      'handoff_project_root_digest',
    ];
    const boundaryLeasePresent = boundaryLeaseFields
      .filter(key => Object.hasOwn(sc.lease || {}, key));
    if (boundaryLeasePresent.length !== 0 && boundaryLeasePresent.length !== boundaryLeaseFields.length) {
      errors.push('session_chain.lease boundary handoff fields must appear together');
    } else if (boundaryLeasePresent.length === boundaryLeaseFields.length) {
      if (!validBoundaryIdentity(sc.lease.handoff_boundary_event)) {
        errors.push('session_chain.lease.handoff_boundary_event must be an exact boundary identity');
      }
      if (!Number.isSafeInteger(sc.lease.handoff_project_binding_generation)
        || sc.lease.handoff_project_binding_generation < 1) {
        errors.push('session_chain.lease.handoff_project_binding_generation must be a positive integer');
      }
      if (!/^[0-9a-f]{64}$/.test(sc.lease.handoff_project_root_digest || '')) {
        errors.push('session_chain.lease.handoff_project_root_digest must be lowercase 64-hex');
      }
    }
    if (takeover === 'boundary-handoff' && boundaryLeasePresent.length !== boundaryLeaseFields.length) {
      errors.push('boundary-handoff takeover requires exact boundary handoff fields');
    }
    validateAcquisitionReceipt(sc.lease?.acquisition_receipt, errors);
    validateSessions(sc, errors);
  }
  if (!Number.isSafeInteger(loopJson.project?.binding_generation) || loopJson.project.binding_generation < 1) {
    errors.push('project.binding_generation must be a positive integer');
  }
  // episode/workstream item status는 (skill ∪ kernel) 도메인 안에 있어야 함
  const epAllowed = [...(schema.episode_status?.skill || []), ...(schema.episode_status?.kernel || [])];
  for (const ep of (Array.isArray(loopJson.episodes) ? loopJson.episodes : [])) {
    if (ep?.status !== undefined && !epAllowed.includes(ep.status)) errors.push(`invalid episode status: ${ep.status}`);
    if (ep && typeof ep === 'object' && !Array.isArray(ep)) validateEpisodeV040(ep, errors);
  }
  const wsAllowed = [...(schema.workstream_status?.skill || []), ...(schema.workstream_status?.kernel || [])];
  for (const ws of (Array.isArray(loopJson.workstreams) ? loopJson.workstreams : [])) {
    if (ws?.status !== undefined && !wsAllowed.includes(ws.status)) errors.push(`invalid workstream status: ${ws.status}`);
    const terminalEvents = ws?.terminal_events;
    const validStructuredTerminalEvent = event => !!event
        && typeof event === 'object'
        && !Array.isArray(event)
        && Object.keys(event).length === 2
        && Object.hasOwn(event, 'seq')
        && Object.hasOwn(event, 'checksum')
        && Number.isSafeInteger(event.seq)
        && event.seq > 0
        && /^[0-9a-f]{64}$/.test(event.checksum);
    if (terminalEvents !== undefined) {
      if (autonomy?.continuation_policy === 'workstream-session') {
        if (!Array.isArray(terminalEvents) || terminalEvents.some(event => !validStructuredTerminalEvent(event))) {
          errors.push('workstreams[].terminal_events under workstream-session must contain exact structured event identities');
        }
      } else if (['compact-in-place', 'rotate-per-unit'].includes(autonomy?.continuation_policy)
        && (!Array.isArray(terminalEvents) || terminalEvents.some(event => typeof event !== 'string'))) {
        errors.push('workstreams[].terminal_events under a legacy continuation policy must contain strings');
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
