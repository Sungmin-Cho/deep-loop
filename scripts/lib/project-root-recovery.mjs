import { inheritGoalScopeState, ownerSession } from './session-scope.mjs';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { validate } from './schema.mjs';
import {
  captureReconciledRootRecoverySnapshot,
  runDir,
  withReconciledRootRecoveryLock,
  writeState,
} from './state.mjs';
import {
  canonicalProjectRoot,
  classifyProjectRootBinding,
  projectRootDigest,
} from './project-root.mjs';
import {
  appendAnchored,
  captureVerifiedRootRecoverySnapshot,
  readLines,
} from './integrity.mjs';
import { contentHash, unwrap, wrap } from './envelope.mjs';
import { SESSION_RUNTIMES, assertRuntimePlatform, sessionRuntime } from './runtime.mjs';
import { buildRootRecoveryResumeDescriptor } from './runtime-descriptor.mjs';
import {
  checkHardBudget,
  inventoryRelocatedProcessReceipts,
  recoveryReservationKind,
} from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import { buildAcquisitionReceipt, consumedFromReceipt, contractFields } from './recover.mjs';

const ROOT_DIGEST = /^[0-9a-f]{64}$/;
const RECEIPT_LIMIT = 16;

function canonicalCandidate(candidateRoot) {
  try {
    return canonicalProjectRoot(candidateRoot);
  } catch (error) {
    throw new Error('PROJECT_ROOT_UNRESOLVABLE: candidate project root', { cause: error });
  }
}

function assertRecoveryState(loop, runId) {
  if (!loop || typeof loop !== 'object' || loop.run_id !== runId) {
    throw new Error('STATE_INVALID: loop.run_id mismatch');
  }
  const stateValidation = validate(loop);
  if (!stateValidation.ok) throw new Error(`STATE_INVALID: ${stateValidation.errors.join('; ')}`);
  if (!loop.project || typeof loop.project !== 'object') throw new Error('STATE_INVALID: project missing');
  const lease = loop.session_chain?.lease;
  if (!lease || typeof lease.owner_run_id !== 'string' || lease.owner_run_id.length === 0
    || !Number.isSafeInteger(lease.generation) || lease.generation < 1) {
    throw new Error('STATE_INVALID: lease owner/generation missing');
  }
  return lease;
}

function canonicalIso(now) {
  const value = new Date(now);
  if (!Number.isFinite(value.getTime())) throw new Error('INVALID_NOW: project root recovery');
  return value.toISOString();
}

function isOpenWorkstreamScope(scope) {
  return scope?.kind === 'workstream'
    && scope.closed_at === null
    && scope.superseded_at === null;
}

function classifyTopology(loop) {
  const lease = loop.session_chain.lease;
  const sessions = loop.session_chain.sessions || [];
  if (loop.status === 'completed' || loop.status === 'stopped') {
    return { topology: 'terminal', recovery_kind: 'none', actionable: 'rebind' };
  }
  if (lease.takeover_kind === 'affinity-supersession') {
    return { topology: 'affinity-recovery', recovery_kind: 'affinity', actionable: 'relocation-recovery' };
  }
  if (lease.takeover_kind === 'boundary-recovery') {
    return { topology: 'boundary-recovery', recovery_kind: 'boundary', actionable: 'relocation-recovery' };
  }
  const owner = sessions.find(session => session.run_id === lease.owner_run_id);
  if (isOpenWorkstreamScope(owner?.scope) && owner.scope.workstream_id !== null) {
    return { topology: 'open-affinity', recovery_kind: 'affinity', actionable: 'relocation-recovery' };
  }
  if (lease.handoff_phase === 'acquired' && lease.owner_run_id !== loop.run_id) {
    return { topology: 'acquired-unbound', recovery_kind: 'boundary', actionable: 'relocation-recovery' };
  }
  if (['reserved', 'emitted', 'spawned'].includes(lease.handoff_phase)) {
    return { topology: lease.handoff_phase, recovery_kind: 'boundary', actionable: 'relocation-recovery' };
  }
  if (lease.handoff_phase === 'idle'
    && lease.handoff_child_run_id == null
    && lease.takeover_kind == null
    && (!owner || owner.scope?.workstream_id === null)) {
    return { topology: 'quiescent', recovery_kind: 'none', actionable: 'rebind' };
  }
  return { topology: 'unverifiable', recovery_kind: 'none', actionable: 'wait' };
}

function liveHeadlessProducer(candidateRoot, runId) {
  const ownerPath = join(runDir(candidateRoot, runId), '.headless-host.lock', 'owner');
  if (!existsSync(ownerPath)) return false;
  try {
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return true;
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function shellCommand(verb, candidateRoot, runId, loop) {
  const lease = loop.session_chain.lease;
  return [
    `root ${verb}`,
    `--candidate-project-root ${JSON.stringify(candidateRoot)}`,
    `--run-id ${JSON.stringify(runId)}`,
    '--actor human',
    '--confirm',
    `--expected-stored-root-digest ${projectRootDigest(loop.project.root)}`,
    `--expected-binding-generation ${loop.project.binding_generation}`,
    `--owner ${JSON.stringify(lease.owner_run_id)}`,
    `--generation ${lease.generation}`,
  ].join(' ');
}

function receiptDirectory(candidateRoot, runId) {
  return join(runDir(candidateRoot, runId), 'recoveries', 'root-operations');
}

function latestRootEvent(candidateRoot, runId) {
  const events = readLines(candidateRoot, runId)
    .filter(event => event.type === 'project-root-rebound');
  return events.at(-1) || null;
}

function exactKeys(value, keys) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function exactReceipt(candidateRoot, runId, loop, hash, {
  currentReservation = false,
} = {}) {
  const event = latestRootEvent(candidateRoot, runId);
  if (!event || !ROOT_DIGEST.test(event.data?.operation_id || '')) {
    throw new Error('ROOT_OPERATION_PROOF_MISSING');
  }
  const path = join(receiptDirectory(candidateRoot, runId), `${event.data.operation_id}.json`);
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('ROOT_OPERATION_PROOF_INVALID');
  }
  const opened = unwrap(document, {
    producer: 'deep-loop',
    artifact_kind: 'project-root-operation',
  });
  const envelope = document?.envelope;
  const receipt = document?.payload;
  const expectedEnvelopeKeys = [
    'producer', 'artifact_kind', 'schema', 'run_id', 'parent_run_id',
    'generated_at', 'git', 'provenance',
  ];
  const expectedKeys = [
    'contract', 'run_id', 'route_kind', 'actor', 'confirmed',
    'predecessor_loop_hash', 'operation_id',
    'old_root_digest', 'new_root_digest',
    'old_binding_generation', 'new_binding_generation',
    'old_lease_owner', 'old_lease_generation',
    'new_lease_owner', 'new_lease_generation',
    'recovery_kind', 'stale_session_id', 'replacement_session_id',
    'event', 'artifact_digests', 'candidate_loop_hash',
  ];
  const artifactDigests = receipt?.artifact_digests;
  const replacementRows = (loop.session_chain.sessions || [])
    .filter(session => session.run_id === receipt?.replacement_session_id);
  const replacement = replacementRows[0];
  const expectedOperationId = contentHash(JSON.stringify([
    'deep-loop-root-recovery-v1',
    runId,
    receipt?.old_root_digest,
    receipt?.new_root_digest,
    receipt?.old_binding_generation,
    receipt?.new_binding_generation,
    receipt?.recovery_kind,
    receipt?.stale_session_id,
    receipt?.replacement_session_id,
    receipt?.predecessor_loop_hash,
  ]));
  const eventDataKeys = [
    'operation_id',
    'old_root_digest',
    'new_root_digest',
    'old_binding_generation',
    'new_binding_generation',
    'recovery_kind',
    'stale_session_id',
    'replacement_session_id',
    'invalidated_review_attempt_ids',
    'settled_receipt_ids',
  ];
  if (!opened
    || !exactKeys(document, ['schema_version', 'envelope', 'payload'])
    || document.schema_version !== '1.0'
    || !exactKeys(envelope, expectedEnvelopeKeys)
    || !exactKeys(envelope.schema, ['name', 'version'])
    || envelope.schema.name !== 'project-root-operation'
    || envelope.schema.version !== '1.0'
    || envelope.run_id !== runId
    || envelope.parent_run_id !== null
    || envelope.generated_at !== event.ts
    || !exactKeys(envelope.git, [])
    || !exactKeys(envelope.provenance, ['source_artifacts', 'tool_versions'])
    || JSON.stringify(envelope.provenance.source_artifacts) !== JSON.stringify([])
    || !exactKeys(envelope.provenance.tool_versions, [])
    || !exactKeys(receipt, expectedKeys)
    || receipt.contract !== 'deep-loop-root-operation-v1'
    || receipt.run_id !== runId
    || !['rebind', 'recover'].includes(receipt.route_kind)
    || receipt.route_kind !== (receipt.recovery_kind === 'none' ? 'rebind' : 'recover')
    || receipt.actor !== 'human'
    || receipt.confirmed !== true
    || !ROOT_DIGEST.test(receipt.predecessor_loop_hash || '')
    || receipt.operation_id !== event.data.operation_id
    || receipt.operation_id !== expectedOperationId
    || !ROOT_DIGEST.test(receipt.old_root_digest || '')
    || receipt.new_root_digest !== projectRootDigest(loop.project.root)
    || receipt.old_root_digest !== event.data.old_root_digest
    || receipt.new_root_digest !== event.data.new_root_digest
    || receipt.old_binding_generation !== event.data.old_binding_generation
    || receipt.new_binding_generation !== event.data.new_binding_generation
    || receipt.new_binding_generation !== receipt.old_binding_generation + 1
    || receipt.new_binding_generation !== loop.project.binding_generation
    || receipt.new_lease_owner !== receipt.old_lease_owner
    || receipt.new_lease_generation !== receipt.old_lease_generation + 1
    || (!currentReservation
      && receipt.new_lease_owner !== loop.session_chain.lease.owner_run_id)
    || (!currentReservation
      && receipt.new_lease_generation !== loop.session_chain.lease.generation)
    || !['none', 'boundary', 'affinity'].includes(receipt.recovery_kind)
    || receipt.recovery_kind !== event.data.recovery_kind
    || receipt.stale_session_id !== event.data.stale_session_id
    || receipt.replacement_session_id !== event.data.replacement_session_id
    || (currentReservation
      ? !ROOT_DIGEST.test(receipt.candidate_loop_hash || '')
      : receipt.candidate_loop_hash !== hash)
    || JSON.stringify(receipt.event) !== JSON.stringify(event)
    || !exactKeys(event.data, eventDataKeys)
    || artifactDigests == null || typeof artifactDigests !== 'object'
    || Array.isArray(artifactDigests)) {
    throw new Error('ROOT_OPERATION_PROOF_INVALID');
  }
  const artifactEntries = Object.entries(artifactDigests);
  if (receipt.recovery_kind === 'none') {
    if (receipt.stale_session_id !== null
      || receipt.replacement_session_id !== null
      || artifactEntries.length !== 0) {
      throw new Error('ROOT_OPERATION_PROOF_INVALID');
    }
  } else if (replacementRows.length !== 1
    || replacement?.root_recovery_operation_id !== receipt.operation_id
    || replacement?.recovered_from !== receipt.stale_session_id
    || replacement?.recovery_project_binding_generation !== receipt.new_binding_generation
    || replacement?.recovery_project_root_digest !== receipt.new_root_digest
    || replacement?.recovery_kind !== (receipt.recovery_kind === 'affinity'
      ? 'affinity-supersession' : 'boundary-recovery')
    || loop.session_chain.lease.recovery_discriminator !== receipt.operation_id
    || loop.session_chain.lease.handoff_child_run_id !== receipt.replacement_session_id
    || artifactEntries.length !== 1
    || artifactEntries[0][0] !== replacement.recovery_rel
    || artifactEntries[0][1] !== replacement.recovery_sha256) {
    throw new Error('ROOT_OPERATION_PROOF_INVALID');
  }
  for (const [rel, digest] of artifactEntries) {
    let bytes;
    try { bytes = readFileSync(join(runDir(candidateRoot, runId), rel)); }
    catch { throw new Error('ROOT_OPERATION_PROOF_INVALID'); }
    if (contentHash(bytes) !== digest) throw new Error('ROOT_OPERATION_PROOF_INVALID');
  }
  return { receipt, event };
}

function receiptCreatedAt(dir, name) {
  try {
    const document = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (!unwrap(document, {
      producer: 'deep-loop',
      artifact_kind: 'project-root-operation',
    })) return Number.NEGATIVE_INFINITY;
    const value = Date.parse(document.envelope.generated_at);
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

function protectedReceiptIds(candidateRoot, runId, loop, latestOperationId) {
  const protectedIds = new Set();
  if (ROOT_DIGEST.test(latestOperationId || '')) protectedIds.add(latestOperationId);
  for (const session of loop.session_chain?.sessions || []) {
    if (ROOT_DIGEST.test(session.root_recovery_operation_id || '')) {
      protectedIds.add(session.root_recovery_operation_id);
    }
  }
  const discriminator = loop.session_chain?.lease?.recovery_discriminator;
  if (ROOT_DIGEST.test(discriminator || '')) protectedIds.add(discriminator);
  const recoveryDir = join(runDir(candidateRoot, runId), 'recoveries', 'root');
  if (existsSync(recoveryDir)) {
    for (const name of readdirSync(recoveryDir).filter(value => value.endsWith('.json'))) {
      try {
        const rel = `recoveries/root/${name}`;
        const bytes = readFileSync(join(recoveryDir, name));
        const capsule = JSON.parse(bytes.toString('utf8'));
        const session = (loop.session_chain?.sessions || []).find(
          item => item.recovery_rel === rel
            && item.recovery_sha256 === contentHash(bytes)
            && item.root_recovery_operation_id === capsule.operation_id,
        );
        if (session && ROOT_DIGEST.test(capsule.operation_id || '')) {
          protectedIds.add(capsule.operation_id);
        }
      } catch {
        // Invalid capsules are rejected by proof validation; they confer no retention authority.
      }
    }
  }
  const transactionsDir = join(runDir(candidateRoot, runId), 'transactions');
  if (existsSync(transactionsDir)) {
    for (const name of readdirSync(transactionsDir)) {
      try {
        const prepared = JSON.parse(readFileSync(join(transactionsDir, name, 'prepared.json'), 'utf8'));
        const operationId = prepared?.payload?.manifest?.operationId;
        if (unwrap(prepared, {
          producer: 'deep-loop',
          artifact_kind: 'anchored-publication',
        }) && prepared.payload.manifest?.kind === 'project-root-relocation'
          && ROOT_DIGEST.test(operationId || '')) {
          protectedIds.add(operationId);
        }
      } catch {
        // An incomplete/invalid transaction does not grant a receipt retention reference.
      }
    }
  }
  return protectedIds;
}

function pruneReceipts(candidateRoot, runId, guard, protectedIds) {
  const dir = receiptDirectory(candidateRoot, runId);
  if (!existsSync(dir)) return;
  guard.assertOwned(runDir(candidateRoot, runId));
  const files = readdirSync(dir)
    .filter(name => ROOT_DIGEST.test(name.slice(0, -5)) && name.endsWith('.json'))
    .map(name => ({ name, createdAt: receiptCreatedAt(dir, name) }))
    .sort((left, right) => left.createdAt - right.createdAt
      || left.name.localeCompare(right.name));
  const unprotected = files.filter(({ name }) => !protectedIds.has(name.slice(0, -5)));
  const protectedFileCount = files.length - unprotected.length;
  const removeCount = Math.max(0, files.length - RECEIPT_LIMIT - protectedFileCount);
  for (const { name } of unprotected.slice(0, removeCount)) {
    guard.assertOwned(runDir(candidateRoot, runId));
    rmSync(join(dir, name), { force: true });
  }
}

function alreadyRebound(candidateRoot, runId, snapshot) {
  const { receipt, event } = exactReceipt(candidateRoot, runId, snapshot.data, snapshot.hash);
  return alreadyReboundFromEvidence(receipt, event);
}

function alreadyReboundFromEvidence(receipt, event) {
  return {
    action: 'already-rebound',
    blocker: null,
    topology: receipt.recovery_kind === 'none' ? 'quiescent' : `${receipt.recovery_kind}-recovery`,
    current_root_digest: receipt.new_root_digest,
    current_binding_generation: receipt.new_binding_generation,
    fence: {
      owner: receipt.new_lease_owner,
      generation: receipt.new_lease_generation,
    },
    command: null,
    operation_id: receipt.operation_id,
    recovery_kind: receipt.recovery_kind,
    stale_session_id: receipt.stale_session_id,
    replacement_session_id: receipt.replacement_session_id,
    event_identity: { seq: event.seq, checksum: event.checksum },
  };
}

function sampleDiagnosisEvidence(candidateRoot, runId, snapshot) {
  const loop = snapshot.data;
  const binding = classifyProjectRootBinding(candidateRoot, loop.project.root);
  let rebound = null;
  if (binding.mismatch_class === 'match') {
    const exact = exactReceipt(candidateRoot, runId, loop, snapshot.hash);
    rebound = alreadyReboundFromEvidence(exact.receipt, exact.event);
  }
  // Preserve the established diagnosis order: a live relocated producer is
  // authoritative before accounting is inspected.  Both observations remain
  // frozen in this evidence sample and are never re-read during classification.
  const liveProducer = binding.mismatch_class === 'unresolvable'
    ? liveHeadlessProducer(candidateRoot, runId) : false;
  let accounting = { ok: true };
  if (binding.mismatch_class === 'unresolvable') {
    try {
      inventoryRelocatedProcessReceipts(
        candidateRoot,
        runId,
        loop,
        projectRootDigest(loop.project.root),
      );
    } catch (error) {
      if (!/^PROJECT_ROOT_ACCOUNTING_(?:UNMEASURABLE|CONFLICT)(?::|$)/
        .test(String(error?.message || error))) throw error;
      accounting = { ok: false };
    }
  }
  return Object.freeze({
    binding,
    rebound,
    liveHeadlessProducer: liveProducer,
    accounting,
  });
}

function diagnosis(candidateRoot, runId, snapshot, sampledEvidence = null) {
  const loop = snapshot.data;
  const lease = assertRecoveryState(loop, runId);
  const evidence = sampledEvidence || sampleDiagnosisEvidence(candidateRoot, runId, snapshot);
  const binding = evidence.binding;
  if (binding.mismatch_class === 'match') return evidence.rebound || alreadyRebound(candidateRoot, runId, snapshot);
  if (binding.mismatch_class === 'fenced') {
    throw new Error('PROJECT_ROOT_FENCED: stored project root still resolves');
  }
  if (evidence.liveHeadlessProducer) {
    return {
      action: 'wait',
      blocker: 'live-headless-producer',
      topology: classifyTopology(loop).topology,
      current_root_digest: projectRootDigest(loop.project.root),
      current_binding_generation: loop.project.binding_generation,
      fence: { owner: lease.owner_run_id, generation: lease.generation },
      command: null,
    };
  }
  const classified = classifyTopology(loop);
  if (!evidence.accounting.ok) {
    return {
      action: 'wait',
      blocker: 'project-root-accounting',
      topology: classified.topology,
      current_root_digest: projectRootDigest(loop.project.root),
      current_binding_generation: loop.project.binding_generation,
      fence: { owner: lease.owner_run_id, generation: lease.generation },
      command: null,
    };
  }
  const action = classified.actionable;
  return {
    action,
    blocker: action === 'wait' ? 'unverifiable-topology' : null,
    topology: classified.topology,
    current_root_digest: projectRootDigest(loop.project.root),
    current_binding_generation: loop.project.binding_generation,
    fence: { owner: lease.owner_run_id, generation: lease.generation },
    command: action === 'wait' ? null : shellCommand(
      action === 'rebind' ? 'rebind' : 'recover',
      candidateRoot,
      runId,
      loop,
    ),
  };
}

// Verified read-only diagnosis: evidence is sampled once from the first
// immutable capture, then the complete run vector is recaptured before the
// bounded result is returned. A receipt/lock/tree drift therefore discards the
// diagnosis instead of classifying a stale snapshot.
// A held lock is an ordinary transient, not evidence about the durable bytes: the
// caller never got far enough to verify anything. Classifying it as `integrity-invalid`
// tells an operator their state may be damaged when it is merely in use, and gives an
// automated caller no signal that retrying is the answer. Mirrors the `lease acquire`
// contention envelope (`retryable: true`) rather than inventing a second spelling.
const contentionDiscard = phase => ({
  ok: false,
  kind: 'lock-busy',
  retryable: true,
  phase,
  partial_discarded: true,
});
const isContention = error => /^LOCK_BUSY(?::|$)/.test(String(error?.message || error));

export function diagnoseVerifiedProjectRoot(candidateRoot, runId, options = {}) {
  const candidateCanonical = canonicalCandidate(candidateRoot);
  const captureOptions = options.captureOptions || {};
  let first;
  try {
    first = captureVerifiedRootRecoverySnapshot(candidateCanonical, runId, captureOptions);
  } catch (error) {
    if (/^(?:PROJECT_ROOT_FENCED|PROJECT_BINDING_FENCED)(?::|$)/.test(String(error?.message || error))) {
      throw error;
    }
    if (isContention(error)) return contentionDiscard('run-snapshot');
    return { ok: false, kind: 'integrity-invalid', phase: 'run-snapshot', partial_discarded: true };
  }
  if (!first?.ok) return first;
  let result;
  try {
    const evidence = sampleDiagnosisEvidence(candidateCanonical, runId, first.snapshot);
    options.afterEvidence?.({ snapshot: first.snapshot, evidence });
    options.afterFirstCapture?.({ snapshot: first.snapshot, evidence });
    result = diagnosis(candidateCanonical, runId, first.snapshot, evidence);
  } catch (error) {
    if (/^(?:PROJECT_ROOT_FENCED|PROJECT_BINDING_FENCED)(?::|$)/.test(String(error?.message || error))) {
      throw error;
    }
    if (isContention(error)) return contentionDiscard('diagnosis');
    return { ok: false, kind: 'integrity-invalid', phase: 'diagnosis', partial_discarded: true };
  }
  let second;
  try {
    second = captureVerifiedRootRecoverySnapshot(candidateCanonical, runId, captureOptions);
  } catch (error) {
    if (isContention(error)) return contentionDiscard('diagnosis-recapture');
    return { ok: false, kind: 'integrity-invalid', phase: 'diagnosis-recapture', partial_discarded: true };
  }
  if (!second?.ok) return second;
  if (JSON.stringify(first.snapshot.vector) !== JSON.stringify(second.snapshot.vector)) {
    return { ok: false, kind: 'integrity-invalid', phase: 'diagnosis-recapture', partial_discarded: true };
  }
  return result;
}

export function diagnoseProjectRoot(candidateRoot, runId) {
  const candidateCanonical = canonicalCandidate(candidateRoot);
  return withReconciledRootRecoveryLock(candidateCanonical, runId, (guard, snapshot) => {
    const result = diagnosis(candidateCanonical, runId, snapshot);
    if (result.action === 'already-rebound') {
      const protectedIds = protectedReceiptIds(
        candidateCanonical,
        runId,
        snapshot.data,
        result.operation_id,
      );
      pruneReceipts(candidateCanonical, runId, guard, protectedIds);
    }
    return result;
  });
}

function assertMutationInput(loop, {
  actor,
  confirm,
  expectedStoredRootDigest,
  expectedBindingGeneration,
  fence,
}) {
  const lease = assertRecoveryState(loop, loop.run_id);
  if (actor !== 'human') throw new Error('INVALID_ACTOR: root rebind requires actor human');
  if (confirm !== true) throw new Error('CONFIRM_REQUIRED: root rebind requires confirmation');
  if (!ROOT_DIGEST.test(expectedStoredRootDigest || '')
    || expectedStoredRootDigest !== projectRootDigest(loop.project.root)) {
    throw new Error('INVALID_STORED_ROOT_DIGEST: exact stored lexical root digest required');
  }
  if (!Number.isSafeInteger(expectedBindingGeneration)
    || expectedBindingGeneration !== loop.project.binding_generation) {
    throw new Error('PROJECT_BINDING_FENCED: binding generation mismatch');
  }
  if (!fence || typeof fence.owner !== 'string' || fence.owner.length === 0
    || !Number.isSafeInteger(fence.generation) || fence.generation < 1) {
    throw new Error('FENCE_REQUIRED: root rebind requires owner and generation');
  }
  if (lease.owner_run_id !== fence.owner || lease.generation !== fence.generation) {
    throw new Error('LEASE_FENCED: owner/generation mismatch');
  }
}

function rootContained(storedRoot, value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return value === storedRoot || value.startsWith(storedRoot.endsWith(sep) ? storedRoot : `${storedRoot}${sep}`);
}

function clearRelocatedLaunchAuthority(loop, storedRoot, iso) {
  if (rootContained(storedRoot, loop.autonomy.runtime_executable_approval?.canonical_path)) {
    loop.autonomy.runtime_executable_approval = null;
  }
  for (const kind of ['wt', 'powershell', 'tmux']) {
    if (rootContained(storedRoot, loop.autonomy.launcher_executable_approvals?.[kind]?.canonical_path)) {
      loop.autonomy.launcher_executable_approvals[kind] = null;
    }
  }
  loop.autonomy.attended_launch_approval = null;
  loop.autonomy.spawn_style = 'interactive';
  loop.session_spawn = {
    platform: loop.session_spawn?.platform || process.platform,
    launcher: 'none',
    launcher_bin: null,
    launcher_socket: null,
    surface: null,
    reachable: false,
    visible: false,
    signals: {
      term_program: null,
      cmux_socket: false,
      wt_session: false,
      tmux: false,
      sty: false,
    },
    probe: null,
    reason: 'project-root-relocated',
    fallback: 'launch-command-file',
    detected_at: iso,
  };
}

function invalidatedReviewAttempts(loop, iso) {
  const ids = [];
  for (const episode of loop.episodes || []) {
    const claim = episode.review_claim;
    if (!claim || typeof claim !== 'object') continue;
    const attemptId = claim.attempt_id;
    episode.invalidated_review_claims = [
      ...(episode.invalidated_review_claims || []),
      {
        ...structuredClone(claim),
        invalidated_at: iso,
        reason: 'project-root-relocated',
      },
    ];
    delete episode.review_claim;
    delete episode.attempt_id;
    episode.status = 'blocked';
    episode.block_reason = 'project-root-relocated';
    episode.needs_human = true;
    if (typeof attemptId === 'string') ids.push(attemptId);
  }
  return [...new Set(ids)].sort();
}

function recoveryScope(loop, recoveryKind) {
  if (recoveryKind !== 'affinity') {
    return {
      kind: 'workstream',
      workstream_id: null,
      bound_at_seq: null,
      terminal_event: null,
      closed_at: null,
      superseded_at: null,
    };
  }
  const source = loop.session_chain.sessions
    .find(session => isOpenWorkstreamScope(session.scope) && session.scope.workstream_id !== null);
  if (!source) throw new Error('PROJECT_ROOT_RELOCATION_TOPOLOGY_INVALID');
  return {
    kind: 'workstream',
    workstream_id: source.scope.workstream_id,
    bound_at_seq: source.scope.bound_at_seq,
    terminal_event: null,
    closed_at: null,
    superseded_at: null,
  };
}

function freezeOperation(candidateRoot, runId, snapshot, classified, iso) {
  const loop = snapshot.data;
  const lease = loop.session_chain.lease;
  const oldRootDigest = projectRootDigest(loop.project.root);
  const newRootDigest = projectRootDigest(candidateRoot);
  const oldBindingGeneration = loop.project.binding_generation;
  const newBindingGeneration = oldBindingGeneration + 1;
  const recoveryKind = classified.recovery_kind;
  const staleSessionId = recoveryKind === 'none'
    ? null
    : lease.handoff_child_run_id || lease.owner_run_id;
  const replacementSessionId = recoveryKind === 'none'
    ? null
    : `ROOT-${contentHash(JSON.stringify([
      runId, oldRootDigest, newRootDigest, oldBindingGeneration,
      recoveryKind, staleSessionId, snapshot.hash,
    ])).slice(0, 26).toUpperCase()}`;
  const operationId = contentHash(JSON.stringify([
    'deep-loop-root-recovery-v1',
    runId,
    oldRootDigest,
    newRootDigest,
    oldBindingGeneration,
    newBindingGeneration,
    recoveryKind,
    staleSessionId,
    replacementSessionId,
    snapshot.hash,
  ]));
  const newLeaseGeneration = lease.generation + 1;
  const recoveryRel = replacementSessionId
    ? `recoveries/root/${replacementSessionId}.json`
    : null;
  const descriptor = replacementSessionId
    ? buildRootRecoveryResumeDescriptor({
      runtime: sessionRuntime(loop),
      root: candidateRoot,
      runId,
      childRunId: replacementSessionId,
      recoveryRel,
      generation: newLeaseGeneration,
      bindingGeneration: newBindingGeneration,
    })
    : null;
  const capsulePayload = replacementSessionId ? {
    contract: 'deep-loop-root-recovery-v1',
    operation_id: operationId,
    run_id: runId,
    recovery_kind: recoveryKind,
    stale_session_id: staleSessionId,
    replacement_session_id: replacementSessionId,
    project_root_digest: newRootDigest,
    project_binding_generation: newBindingGeneration,
    lease_generation: newLeaseGeneration,
    runtime: sessionRuntime(loop),
    scope: recoveryScope(loop, recoveryKind),
    ...inheritGoalScopeState(ownerSession(loop)),
    acquire_command: descriptor.acquireInvocation,
    created_at: iso,
  } : null;
  const capsuleBytes = capsulePayload
    ? Buffer.from(`${JSON.stringify(capsulePayload, null, 2)}\n`)
    : null;
  return {
    oldRootDigest,
    newRootDigest,
    oldBindingGeneration,
    newBindingGeneration,
    oldLeaseOwner: lease.owner_run_id,
    oldLeaseGeneration: lease.generation,
    newLeaseOwner: lease.owner_run_id,
    newLeaseGeneration,
    recoveryKind,
    staleSessionId,
    replacementSessionId,
    operationId,
    recoveryRel,
    descriptor,
    capsulePayload,
    capsuleBytes,
    capsuleSha256: capsuleBytes ? contentHash(capsuleBytes) : null,
  };
}

function tombstoneForRelocation(loop, operation, iso) {
  const replacement = operation.replacementSessionId;
  for (const session of loop.session_chain.sessions) {
    if (!isOpenWorkstreamScope(session.scope)) continue;
    session.superseded_by = replacement;
    session.ended_at = session.ended_at || iso;
    session.outcome = session.outcome || 'superseded';
    session.scope.superseded_at = iso;
    session.scope.supersede_reason = 'project-root-relocated';
    session.scope.superseded_by = replacement;
  }
  const kind = operation.recoveryKind === 'affinity'
    ? 'affinity-supersession'
    : 'boundary-recovery';
  const child = {
    run_id: replacement,
    started_at: null,
    ended_at: null,
    turns: 0,
    outcome: null,
    superseded_by: null,
    recovered_from: operation.staleSessionId,
    recovery_kind: kind,
    recovery_rel: operation.recoveryRel,
    recovery_sha256: operation.capsuleSha256,
    recovery_project_binding_generation: operation.newBindingGeneration,
    recovery_project_root_digest: operation.newRootDigest,
    root_recovery_operation_id: operation.operationId,
    scope: structuredClone(operation.capsulePayload.scope),
    ...inheritGoalScopeState(operation.capsulePayload),
  };
  loop.session_chain.sessions.push(child);
  loop.session_chain.lease = {
    ...loop.session_chain.lease,
    generation: operation.newLeaseGeneration,
    state: 'released',
    handoff_phase: 'reserved',
    handoff_child_run_id: replacement,
    handoff_idempotency_key: operation.operationId,
    handoff_trigger: 'project-root-relocated',
    expires_at: null,
    resume_policy: 'human',
    takeover_kind: kind,
    recovery_rel: operation.recoveryRel,
    recovery_sha256: operation.capsuleSha256,
    recovery_discriminator: operation.operationId,
  };
  for (const key of [
    'handoff_boundary_event',
    'handoff_project_binding_generation',
    'handoff_project_root_digest',
  ]) delete loop.session_chain.lease[key];
}

function mutateRoot(loop, candidateRoot, operation, iso) {
  const storedRoot = loop.project.root;
  loop.project.root = candidateRoot;
  loop.project.binding_generation = operation.newBindingGeneration;
  loop.status = 'paused';
  loop.pause_reason = 'project-root-relocated';
  clearRelocatedLaunchAuthority(loop, storedRoot, iso);
  if (operation.recoveryKind === 'none') {
    loop.session_chain.lease.generation = operation.newLeaseGeneration;
    loop.session_chain.lease.expires_at = null;
    loop.session_chain.lease.resume_policy = 'human';
  } else {
    tombstoneForRelocation(loop, operation, iso);
  }
}

function executeRelocation(candidateRoot, runId, input, expectedRoute) {
  const candidateCanonical = canonicalCandidate(candidateRoot);
  const snapshot = captureReconciledRootRecoverySnapshot(candidateCanonical, runId);
  if (snapshot.data.run_id !== runId) throw new Error('STATE_INVALID: loop.run_id mismatch');
  const binding = classifyProjectRootBinding(candidateCanonical, snapshot.data.project.root);
  if (binding.mismatch_class === 'match') {
    const receipt = exactReceipt(candidateCanonical, runId, snapshot.data, snapshot.hash).receipt;
    if (input.actor !== 'human') {
      throw new Error('INVALID_ACTOR: root rebind requires actor human');
    }
    if (input.confirm !== true) {
      throw new Error('CONFIRM_REQUIRED: root rebind requires confirmation');
    }
    if (receipt.route_kind !== expectedRoute
      || input.expectedStoredRootDigest !== receipt.old_root_digest
      || input.expectedBindingGeneration !== receipt.old_binding_generation
      || input.fence?.owner !== receipt.old_lease_owner
      || input.fence?.generation !== receipt.old_lease_generation) {
      throw new Error('ROOT_OPERATION_RETRY_MISMATCH');
    }
    // A retry may have completed the anchored publication during the
    // reconciled capture above. Route the validated retry through the normal
    // reconciled diagnosis path so its committed journal is retired before
    // exact, read-only consumers inspect the run.
    return diagnoseProjectRoot(candidateCanonical, runId);
  }
  assertMutationInput(snapshot.data, input);
  const classified = classifyTopology(snapshot.data);
  if (expectedRoute === 'rebind' && classified.actionable !== 'rebind') {
    throw new Error('PROJECT_ROOT_RELOCATION_RECOVERY_REQUIRED');
  }
  if (expectedRoute === 'recover' && classified.actionable !== 'relocation-recovery') {
    throw new Error('PROJECT_ROOT_RELOCATION_RECOVERY_NOT_REQUIRED');
  }
  if (liveHeadlessProducer(candidateCanonical, runId)) {
    throw new Error('PROJECT_ROOT_RELOCATION_WAIT: live-headless-producer');
  }
  const iso = canonicalIso(input.now ?? Date.now());
  const accounting = inventoryRelocatedProcessReceipts(
    candidateCanonical,
    runId,
    snapshot.data,
    projectRootDigest(snapshot.data.project.root),
  );
  const settledIds = accounting.settledReceiptIds;
  const invalidatedIds = (snapshot.data.episodes || [])
    .map(episode => episode.review_claim?.attempt_id)
    .filter(value => typeof value === 'string')
    .sort();
  const operation = freezeOperation(candidateCanonical, runId, snapshot, classified, iso);
  const eventData = {
    operation_id: operation.operationId,
    old_root_digest: operation.oldRootDigest,
    new_root_digest: operation.newRootDigest,
    old_binding_generation: operation.oldBindingGeneration,
    new_binding_generation: operation.newBindingGeneration,
    recovery_kind: operation.recoveryKind,
    stale_session_id: operation.staleSessionId,
    replacement_session_id: operation.replacementSessionId,
    invalidated_review_attempt_ids: [...new Set(invalidatedIds)],
    settled_receipt_ids: settledIds,
  };
  const topology = {
    old_root_digest: operation.oldRootDigest,
    new_root_digest: operation.newRootDigest,
    old_binding_generation: operation.oldBindingGeneration,
    new_binding_generation: operation.newBindingGeneration,
    old_lease_owner: operation.oldLeaseOwner,
    old_lease_generation: operation.oldLeaseGeneration,
    new_lease_owner: operation.newLeaseOwner,
    new_lease_generation: operation.newLeaseGeneration,
    recovery_kind: operation.recoveryKind,
    stale_session_id: operation.staleSessionId,
    replacement_session_id: operation.replacementSessionId,
    recovery_rel: operation.recoveryRel,
  };
  appendAnchored(
    candidateCanonical,
    runId,
    { type: 'project-root-rebound', data: eventData, now: iso },
    loop => {
      const observedInvalidated = invalidatedReviewAttempts(loop, iso);
      if (JSON.stringify(observedInvalidated) !== JSON.stringify(eventData.invalidated_review_attempt_ids)) {
        throw new Error('PROJECT_ROOT_REVIEW_INVENTORY_CHANGED');
      }
      mutateRoot(loop, candidateCanonical, operation, iso);
    },
    loop => assertMutationInput(loop, input),
    {
      rootRecovery: true,
      additionalEvents: accounting.costEvents,
      publication: {
        kind: 'project-root-relocation',
        operationId: operation.operationId,
        topology,
        faultAt: input.faultAt,
        durableWriteFn: input.durableWriteFn,
        artifactFactory({ candidateLoopHash, event }) {
          const artifacts = [];
          const artifactDigests = {};
          if (operation.capsuleBytes) {
            artifacts.push({ rel: operation.recoveryRel, bytes: operation.capsuleBytes });
            artifactDigests[operation.recoveryRel] = operation.capsuleSha256;
          }
          const receipt = {
            contract: 'deep-loop-root-operation-v1',
            run_id: runId,
            route_kind: expectedRoute,
            actor: 'human',
            confirmed: true,
            predecessor_loop_hash: snapshot.hash,
            operation_id: operation.operationId,
            old_root_digest: operation.oldRootDigest,
            new_root_digest: operation.newRootDigest,
            old_binding_generation: operation.oldBindingGeneration,
            new_binding_generation: operation.newBindingGeneration,
            old_lease_owner: operation.oldLeaseOwner,
            old_lease_generation: operation.oldLeaseGeneration,
            new_lease_owner: operation.newLeaseOwner,
            new_lease_generation: operation.newLeaseGeneration,
            recovery_kind: operation.recoveryKind,
            stale_session_id: operation.staleSessionId,
            replacement_session_id: operation.replacementSessionId,
            event,
            artifact_digests: artifactDigests,
            candidate_loop_hash: candidateLoopHash,
          };
          const document = wrap({
            producer: 'deep-loop',
            artifact_kind: 'project-root-operation',
            schema: { name: 'project-root-operation', version: '1.0' },
            run_id: runId,
            payload: receipt,
            now: event.ts,
          });
          artifacts.push({
            rel: `recoveries/root-operations/${operation.operationId}.json`,
            bytes: Buffer.from(JSON.stringify(document)),
          });
          return artifacts;
        },
      },
    },
  );
  return diagnoseProjectRoot(candidateCanonical, runId);
}

export function rebindProjectRoot(candidateRoot, runId, options = {}) {
  return executeRelocation(candidateRoot, runId, options, 'rebind');
}

export function recoverRelocatedRoot(candidateRoot, runId, options = {}) {
  return executeRelocation(candidateRoot, runId, options, 'recover');
}

export function acquireRootRecovery(candidateRoot, runId, {
  capsuleRel,
  owner,
  expectGeneration,
  bindingGeneration,
  runtime,
  now,
  clock = Date.now,
  platform = process.platform,
} = {}) {
  const root = canonicalCandidate(candidateRoot);
  if (typeof capsuleRel !== 'string' || !capsuleRel.startsWith('recoveries/root/')
    || typeof owner !== 'string' || owner.length === 0
    || !Number.isSafeInteger(expectGeneration) || expectGeneration < 1
    || !Number.isSafeInteger(bindingGeneration) || bindingGeneration < 1
    || !SESSION_RUNTIMES.includes(runtime)) {
    throw new Error('ROOT_RECOVERY_ACQUIRE_INPUT_INVALID');
  }
  assertRuntimePlatform(runtime, platform);
  return withReconciledRootRecoveryLock(root, runId, (guard, snapshot) => {
    const loop = snapshot.data;
    const lease = loop.session_chain.lease;
    const child = loop.session_chain.sessions.find(session => session.run_id === owner);
    const receipt = exactReceipt(root, runId, loop, snapshot.hash, {
      currentReservation: true,
    }).receipt;
    if (recoveryReservationKind(loop) !== child?.recovery_kind
      || lease.generation !== expectGeneration
      || lease.handoff_child_run_id !== owner
      || child?.root_recovery_operation_id !== lease.recovery_discriminator
      || child?.root_recovery_operation_id !== receipt.operation_id
      || child?.recovery_rel !== capsuleRel
      || child?.recovery_project_binding_generation !== bindingGeneration
      || bindingGeneration !== loop.project.binding_generation) {
      throw new Error('LEASE_FENCED: root-recovery-reservation-mismatch');
    }
    if (sessionRuntime(loop) !== runtime) throw new Error('RUNTIME_FENCED: root recovery runtime mismatch');
    const lockedNow = Number(clock());
    if (!Number.isFinite(lockedNow)) throw new Error('INVALID_NOW: root recovery acquire');
    const safety = checkHardBudget(loop, { now: lockedNow });
    if (safety.blocked) throw new Error('BUDGET_BLOCKED');
    if (checkBreaker(loop).tripped) throw new Error('BREAKER_BLOCKED');
    const path = join(runDir(root, runId), capsuleRel);
    guard.assertOwned(runDir(root, runId));
    const bytes = readFileSync(path);
    if (contentHash(bytes) !== child.recovery_sha256) throw new Error('ROOT_RECOVERY_CAPSULE_INVALID');
    let capsule;
    try { capsule = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error('ROOT_RECOVERY_CAPSULE_INVALID'); }
    if (capsule.operation_id !== child.root_recovery_operation_id
      || capsule.replacement_session_id !== owner
      || capsule.project_binding_generation !== bindingGeneration
      || capsule.project_root_digest !== projectRootDigest(loop.project.root)
      || capsule.lease_generation !== expectGeneration
      || capsule.runtime !== runtime) {
      throw new Error('ROOT_RECOVERY_CAPSULE_INVALID');
    }
    const iso = canonicalIso(now ?? lockedNow);
    child.started_at = iso;
    // spec §3.2 예외: 전용 lock 안이므로 appendAnchored 를 중첩 호출할 수 없다(불변식 #7). 이 경로는
    // **영수증 필드만** 같은 트랜잭션에 기록하고 이벤트는 남기지 않는다 — 예약 자체가 project-root-rebound
    // publication + receipt artifact 로 이미 앵커되어 있어 reservation_key 대조로 감사 사슬이 닫힌다.
    const acquisitionReceipt = buildAcquisitionReceipt({
      takeoverKind: 'project-root',
      childRunId: owner,
      supersededOwnerRunId: lease.owner_run_id,
      boundaryEvent: null,
      projectRootDigest: child.recovery_project_root_digest ?? null,
      projectBindingGeneration: bindingGeneration,
      handoffRel: null,
      reservationKey: child.root_recovery_operation_id ?? null,
      fromGeneration: expectGeneration,
      toGeneration: lease.generation + 1,
      at: iso,
      // §3.6.4: root recovery 는 attempt id 를 받지도 기록하지도 않는다.
      attemptId: null,
    });
    loop.session_chain.lease = {
      ...lease,
      owner_run_id: owner,
      generation: lease.generation + 1,
      acquired_at: iso,
      expires_at: null,
      state: 'active',
      handoff_phase: 'acquired',
      handoff_idempotency_key: null,
      handoff_child_run_id: null,
      handoff_trigger: null,
      takeover_kind: null,
      resume_policy: null,
      acquisition_receipt: acquisitionReceipt,
    };
    for (const key of ['recovery_rel', 'recovery_sha256', 'recovery_discriminator']) {
      delete loop.session_chain.lease[key];
    }
    loop.status = 'running';
    delete loop.pause_reason;
    writeState(root, runId, loop);
    // R2-C2: `reason: 'acquired'` 가 없으면 §3.1 의 단일 파생 규칙이 이 경로에 대해 proceed:false 를 낸다.
    return contractFields({
      ok: true,
      owner,
      generation: loop.session_chain.lease.generation,
      project_binding_generation: bindingGeneration,
      reason: 'acquired',
    }, { consumed: consumedFromReceipt(acquisitionReceipt) });
  });
}
