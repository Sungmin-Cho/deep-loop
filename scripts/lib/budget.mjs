import {
  appendAnchored,
  appendEvent,
  lastLogHead,
  MUTATION_TURN_FLOOR,
  readLines,
  recomputeSpent,
  verifyLog,
  verifyHead,
  validCost,
} from './integrity.mjs';
import { runDir, writeState, withReconciledMutationLock } from './state.mjs';
import { leaseCheck } from './lease.mjs';
import { sessionRuntime } from './runtime.mjs';
import { contentHash } from './envelope.mjs';
import { canonicalProjectRoot, projectRootDigest } from './project-root.mjs';
import { isOpenScope } from './session-scope.mjs';
import { inspectGoalOwnerReceipt, markGoalOwnerReceiptSettled } from './goal-owner-receipt.mjs';

// #3: re-exported from integrity.mjs (the floor mechanism's home) so call sites/tests can import it from budget.mjs
// while state.mjs imports it directly from integrity.mjs (no state↔budget cycle).
export { MUTATION_TURN_FLOOR };

export function inventoryRelocatedProcessReceipts(root, runId, loop, oldRootDigest) {
  const dir = join(runDir(root, runId), 'preflight', 'process-receipts');
  if (!existsSync(dir)) return { settledReceiptIds: [], costEvents: [] };
  const lines = readLines(root, runId);
  const settledReceiptIds = [];
  const costEvents = [];
  const batchReceiptIds = new Set();
  for (const name of readdirSync(dir).filter(value => value.endsWith('.json')).sort()) {
    let receipt;
    try { receipt = JSON.parse(readFileSync(join(dir, name), 'utf8')); }
    catch { throw new Error('PROJECT_ROOT_ACCOUNTING_UNMEASURABLE'); }
    const payload = { ...receipt };
    delete payload.receipt_id;
    const expectedName = receipt?.process_kind && receipt?.context
      ? `${contentHash(JSON.stringify({
        process_kind: receipt.process_kind,
        context: receipt.context,
      }))}-${receipt.process_kind}.json`
      : null;
    if (receipt.contract !== 'deep-loop-codex-process-accounting-receipt-v1'
      || receipt.run_id !== runId
      || receipt.project_root_digest !== oldRootDigest
      || !/^[0-9a-f]{64}$/.test(receipt.receipt_id || '')
      || receipt.receipt_id !== contentHash(JSON.stringify(payload))
      || name !== expectedName
      || batchReceiptIds.has(receipt.receipt_id)
      || !['maker', 'checker'].includes(receipt.process_kind)
      || !isMeasuredOneTurnUsage(receipt.usage)) {
      throw new Error('PROJECT_ROOT_ACCOUNTING_UNMEASURABLE');
    }
    batchReceiptIds.add(receipt.receipt_id);
    const context = receipt.context || {};
    let origin;
    if (receipt.process_kind === 'maker') {
      const parent = (loop.session_chain.sessions || []).find(
        session => session.run_id === context.parent_owner,
      );
      const child = (loop.session_chain.sessions || []).find(
        session => session.run_id === context.child_run_id,
      );
      const handoffs = lines.filter(event => event.type === 'handoff-emitted'
        && event.data?.child_run_id === context.child_run_id
        && event.data?.key === context.handoff_key);
      const ordinaryHandoff = handoffs.length === 1
        && parent
        && child
        && child.handoff_rel === context.handoff_rel
        && parent.superseded_by === context.child_run_id
        && context.child_generation === context.parent_generation + 1
        && (
          (child.started_at === null
            && loop.session_chain.lease.owner_run_id === context.parent_owner
            && loop.session_chain.lease.generation === context.parent_generation)
          || (child.started_at !== null
            && loop.session_chain.lease.owner_run_id === context.child_run_id
            && loop.session_chain.lease.generation === context.child_generation)
        );
      let recoveryCapsule = false;
      if (parent && child?.recovery_rel === context.handoff_rel
        && child.recovery_sha256 && context.child_generation === context.parent_generation + 1) {
        try {
          const bytes = readFileSync(join(runDir(root, runId), child.recovery_rel));
          const capsule = JSON.parse(bytes.toString('utf8'));
          recoveryCapsule = contentHash(bytes) === child.recovery_sha256
            && capsule.replacement_session_id === context.child_run_id
            && capsule.lease_generation === context.parent_generation
            && capsule.operation_id === child.root_recovery_operation_id;
        } catch {
          recoveryCapsule = false;
        }
      }
      if (!ordinaryHandoff && !recoveryCapsule) {
        throw new Error('PROJECT_ROOT_ACCOUNTING_UNMEASURABLE');
      }
      const acquired = child.started_at !== null;
      origin = acquired
        ? { owner: context.child_run_id, generation: context.child_generation }
        : { owner: context.parent_owner, generation: context.parent_generation };
    } else {
      const checker = (loop.episodes || []).find(
        episode => episode.id === context.checker_episode_id,
      );
      const claim = checker?.review_claim;
      const claims = lines.filter(event => event.type === 'independent-review-claimed'
        && event.data?.episode_id === context.checker_episode_id
        && event.data?.attempt_id === context.attempt_id);
      const claimEvent = claims[0];
      const exactClaimEvent = claims.length === 1
        && JSON.stringify(claimEvent.data) === JSON.stringify({
          episode_id: context.checker_episode_id,
          attempt_id: context.attempt_id,
          reviewer_id: claim?.reviewer_id,
          target_maker: context.target_maker,
          workstream_id: claim?.workstream_id,
          point: claim?.point,
          artifacts: claim?.artifacts,
        });
      if (!claim
        || claim.attempt_id !== context.attempt_id
        || claim.target_maker !== context.target_maker
        || claim.lease_owner !== context.origin_owner
        || claim.lease_generation !== context.origin_generation
        || claim.project_root !== loop.project.root
        || projectRootDigest(claim.project_root) !== oldRootDigest
        || context.claim_hash !== codexCheckerClaimHash(claim)
        || !(loop.session_chain.sessions || []).some(
          session => session.run_id === context.origin_owner,
        )
        || loop.session_chain.lease.owner_run_id !== context.origin_owner
        || loop.session_chain.lease.generation !== context.origin_generation
        || !exactClaimEvent) {
        throw new Error('PROJECT_ROOT_ACCOUNTING_UNMEASURABLE');
      }
      origin = { owner: claim.lease_owner, generation: claim.lease_generation };
    }
    const exact = lines.filter(event =>
      event.type === 'cost' && event.data?.process_receipt_id === receipt.receipt_id);
    const conflicting = lines.filter(event =>
      event.type === 'cost'
      && event.data?.process_kind === receipt.process_kind
      && JSON.stringify(event.data?.process_context) === JSON.stringify(receipt.context)
      && event.data?.process_receipt_id !== receipt.receipt_id);
    if (exact.length > 1 || conflicting.length > 0) {
      throw new Error('PROJECT_ROOT_ACCOUNTING_CONFLICT');
    }
    if (exact.length === 1) {
      const recorded = exact[0].data;
      const eventIndex = lines.indexOf(exact[0]);
      const { tf, tk } = trailingFloor(
        lines.slice(0, eventIndex),
        origin.owner,
        origin.generation,
      );
      const terminalMaker = receipt.process_kind === 'maker'
        && lines.slice(0, eventIndex).some(event => event.type === 'finish');
      const expected = {
        turns: Math.max(0, receipt.usage.num_turns - tf),
        tokens: Math.max(0, receipt.usage.tokens - tk),
        reported_turns: receipt.usage.num_turns,
        reported_tokens: receipt.usage.tokens,
        input_tokens: receipt.usage.input_tokens,
        output_tokens: receipt.usage.output_tokens,
        ...(receipt.usage.cached_input_tokens !== undefined
          ? { cached_input_tokens: receipt.usage.cached_input_tokens } : {}),
        ...(receipt.usage.reasoning_output_tokens !== undefined
          ? { reasoning_output_tokens: receipt.usage.reasoning_output_tokens } : {}),
        owner: origin.owner,
        generation: origin.generation,
        source: `codex-${receipt.process_kind}-measured`,
        process_receipt_id: receipt.receipt_id,
        process_kind: receipt.process_kind,
        process_context: receipt.context,
        ...(terminalMaker ? { terminal_process: 'codex-maker' } : {}),
      };
      if (JSON.stringify(recorded) !== JSON.stringify(expected)) {
        throw new Error('PROJECT_ROOT_ACCOUNTING_CONFLICT');
      }
      settledReceiptIds.push(receipt.receipt_id);
      continue;
    }
    const { tf: absorbedTurns, tk: absorbedTokens } = trailingFloor(
      lines,
      origin.owner,
      origin.generation,
    );
    const terminalMaker = receipt.process_kind === 'maker'
      && lines.some(event => event.type === 'finish');
    costEvents.push({
      type: 'cost',
      data: {
        turns: Math.max(0, receipt.usage.num_turns - absorbedTurns),
        tokens: Math.max(0, receipt.usage.tokens - absorbedTokens),
        reported_turns: receipt.usage.num_turns,
        reported_tokens: receipt.usage.tokens,
        input_tokens: receipt.usage.input_tokens,
        output_tokens: receipt.usage.output_tokens,
        ...(receipt.usage.cached_input_tokens !== undefined
          ? { cached_input_tokens: receipt.usage.cached_input_tokens } : {}),
        ...(receipt.usage.reasoning_output_tokens !== undefined
          ? { reasoning_output_tokens: receipt.usage.reasoning_output_tokens } : {}),
        owner: origin.owner,
        generation: origin.generation,
        source: `codex-${receipt.process_kind}-measured`,
        process_receipt_id: receipt.receipt_id,
        process_kind: receipt.process_kind,
        process_context: receipt.context,
        ...(terminalMaker ? { terminal_process: 'codex-maker' } : {}),
      },
    });
    settledReceiptIds.push(receipt.receipt_id);
  }
  return {
    settledReceiptIds: [...new Set(settledReceiptIds)].sort(),
    costEvents,
  };
}

function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// A Codex process is billable preflight evidence only when the streaming parser proved one complete turn
// with a non-overflowing input+output total. Optional cached/reasoning fields are non-additive breakdowns.
export function isMeasuredOneTurnUsage(usage) {
  if (usage == null || typeof usage !== 'object' || Array.isArray(usage)
    || usage.num_turns !== 1
    || !safeTokenCount(usage.input_tokens) || !safeTokenCount(usage.output_tokens)
    || !safeTokenCount(usage.tokens)
    || !safeTokenCount(usage.input_tokens + usage.output_tokens)
    || usage.tokens !== usage.input_tokens + usage.output_tokens) return false;
  return ['cached_input_tokens', 'reasoning_output_tokens']
    .every((field) => !Object.hasOwn(usage, field) || safeTokenCount(usage[field]));
}

function sameMeasuredUsage(left, right) {
  return ['num_turns', 'input_tokens', 'output_tokens', 'tokens', 'cached_input_tokens', 'reasoning_output_tokens']
    .every(field => Object.hasOwn(left, field) === Object.hasOwn(right, field)
      && (!Object.hasOwn(left, field) || left[field] === right[field]));
}

const OPTIONAL_MEASURED_EVENT_KEYS = [
  'cached_input_tokens',
  'reasoning_output_tokens',
];

function hasCanonicalEventData(data, requiredKeys) {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return false;
  const expected = new Set(requiredKeys);
  for (const key of OPTIONAL_MEASURED_EVENT_KEYS) {
    if (Object.hasOwn(data, key)) expected.add(key);
  }
  const actual = Object.keys(data);
  return actual.length === expected.size && actual.every(key => expected.has(key));
}

function hasExactEventData(data, requiredKeys) {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return false;
  const expected = new Set(requiredKeys);
  const actual = Object.keys(data);
  return actual.length === expected.size && actual.every(key => expected.has(key));
}

const CODEX_PREFLIGHT_RECEIPT_CONTRACT = 'deep-loop-codex-preflight-accounting-receipt-v1';
const CODEX_PROCESS_RECEIPT_CONTRACT = 'deep-loop-codex-process-accounting-receipt-v1';

// New workstream-boundary reservations use the complete SHA-256 digest. The two
// authentic pre-boundary policies retain their historical 16-hex transport key.
// Receipt byte reconstruction does not have loop state, so an omitted policy
// recognizes either canonical grammar; settlement always supplies the durable
// policy and binds the key to the kernel-authored handoff event.
export function isCanonicalHandoffKey(value, continuationPolicy = null) {
  if (typeof value !== 'string') return false;
  if (continuationPolicy === 'workstream-session') return /^[a-f0-9]{64}$/.test(value);
  if (continuationPolicy === 'compact-in-place' || continuationPolicy === 'rotate-per-unit') {
    return /^[a-f0-9]{16}$/.test(value);
  }
  if (continuationPolicy != null) return false;
  return /^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(value);
}

function exactMeasuredUsage(usage) {
  return {
    num_turns: usage.num_turns,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    tokens: usage.tokens,
    ...(usage.cached_input_tokens !== undefined ? { cached_input_tokens: usage.cached_input_tokens } : {}),
    ...(usage.reasoning_output_tokens !== undefined ? { reasoning_output_tokens: usage.reasoning_output_tokens } : {}),
  };
}

function preflightReceiptPayload({ root, runId, cacheKey, smokeKind, attemptId,
  predecessorReceiptId, owner, generation, usage }) {
  if (typeof runId !== 'string' || runId.length === 0
    || typeof cacheKey !== 'string' || !/^[a-f0-9]{64}$/.test(cacheKey)
    || !['read', 'write'].includes(smokeKind)
    || typeof attemptId !== 'string' || !/^[a-f0-9]{32,64}$/.test(attemptId)
    || typeof owner !== 'string' || owner.length === 0
    || !Number.isInteger(generation) || generation < 1
    || !isMeasuredOneTurnUsage(usage)
    || (smokeKind === 'read' && predecessorReceiptId !== null)
    || (smokeKind === 'write'
      && (typeof predecessorReceiptId !== 'string' || !/^[a-f0-9]{64}$/.test(predecessorReceiptId)))) {
    throw new Error('PREFLIGHT_ACCOUNTING_RECEIPT_INVALID');
  }
  const canonicalRoot = canonicalProjectRoot(root);
  return {
    contract: CODEX_PREFLIGHT_RECEIPT_CONTRACT,
    project_root_digest: projectRootDigest(canonicalRoot),
    run_id: runId,
    cache_key: cacheKey,
    smoke_kind: smokeKind,
    attempt_id: attemptId,
    predecessor_receipt_id: predecessorReceiptId,
    owner,
    generation,
    usage: exactMeasuredUsage(usage),
  };
}

export function makeCodexPreflightReceipt(options = {}) {
  const payload = preflightReceiptPayload(options);
  return { ...payload, receipt_id: contentHash(JSON.stringify(payload)) };
}

function boundedText(value, max = 4_096) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

function normalizedProcessContext(processKind, context) {
  if (context == null || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('PROCESS_ACCOUNTING_CONTEXT_INVALID');
  }
  if (processKind === 'maker') {
    if (!boundedText(context.parent_owner, 512)
      || !Number.isInteger(context.parent_generation) || context.parent_generation < 1
      || !boundedText(context.child_run_id, 512)
      || context.child_generation !== context.parent_generation + 1
      || !isCanonicalHandoffKey(context.handoff_key)
      || typeof context.handoff_rel !== 'string' || context.handoff_rel.length > 4_096
      || context.handoff_rel.includes('\0')) {
      throw new Error('PROCESS_ACCOUNTING_CONTEXT_INVALID');
    }
    return {
      parent_owner: context.parent_owner,
      parent_generation: context.parent_generation,
      child_run_id: context.child_run_id,
      child_generation: context.child_generation,
      handoff_key: context.handoff_key,
      handoff_rel: context.handoff_rel,
    };
  }
  if (processKind === 'checker') {
    if (!boundedText(context.origin_owner, 512)
      || !Number.isInteger(context.origin_generation) || context.origin_generation < 1
      || !boundedText(context.checker_episode_id, 512)
      || !boundedText(context.attempt_id, 512)
      || !boundedText(context.target_maker, 512)
      || typeof context.claim_hash !== 'string' || !/^[a-f0-9]{64}$/.test(context.claim_hash)) {
      throw new Error('PROCESS_ACCOUNTING_CONTEXT_INVALID');
    }
    return {
      origin_owner: context.origin_owner,
      origin_generation: context.origin_generation,
      checker_episode_id: context.checker_episode_id,
      attempt_id: context.attempt_id,
      target_maker: context.target_maker,
      claim_hash: context.claim_hash,
    };
  }
  throw new Error('PROCESS_ACCOUNTING_KIND_INVALID');
}

export function codexCheckerClaimHash(claim) {
  if (claim == null || typeof claim !== 'object' || Array.isArray(claim)) {
    throw new Error('PROCESS_ACCOUNTING_CLAIM_INVALID');
  }
  return contentHash(JSON.stringify(claim));
}

export function makeCodexProcessReceipt({ root, runId, processKind, context, usage } = {}) {
  if (typeof runId !== 'string' || runId.length === 0 || !isMeasuredOneTurnUsage(usage)) {
    throw new Error('PROCESS_ACCOUNTING_RECEIPT_INVALID');
  }
  let normalizedContext;
  try {
    normalizedContext = normalizedProcessContext(processKind, context);
  } catch {
    throw new Error('PROCESS_ACCOUNTING_RECEIPT_INVALID');
  }
  const payload = {
    contract: CODEX_PROCESS_RECEIPT_CONTRACT,
    project_root_digest: projectRootDigest(canonicalProjectRoot(root)),
    run_id: runId,
    process_kind: processKind,
    context: normalizedContext,
    usage: exactMeasuredUsage(usage),
  };
  return { ...payload, receipt_id: contentHash(JSON.stringify(payload)) };
}

function validateCodexProcessReceipt(root, runId, receipt) {
  if (receipt == null || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.contract !== CODEX_PROCESS_RECEIPT_CONTRACT || receipt.run_id !== runId) {
    throw new Error('PROCESS_ACCOUNTING_RECEIPT_INVALID');
  }
  let expected;
  try {
    expected = makeCodexProcessReceipt({
      root,
      runId,
      processKind: receipt.process_kind,
      context: receipt.context,
      usage: receipt.usage,
    });
  } catch {
    throw new Error('PROCESS_ACCOUNTING_RECEIPT_INVALID');
  }
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) {
    throw new Error('PROCESS_ACCOUNTING_RECEIPT_INVALID');
  }
  return expected;
}

function validateCodexPreflightReceipt(root, runId, receipt) {
  if (receipt == null || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.contract !== CODEX_PREFLIGHT_RECEIPT_CONTRACT
    || receipt.run_id !== runId) throw new Error('PREFLIGHT_ACCOUNTING_RECEIPT_INVALID');
  let expected;
  try {
    expected = makeCodexPreflightReceipt({
      root,
      runId,
      cacheKey: receipt.cache_key,
      smokeKind: receipt.smoke_kind,
      attemptId: receipt.attempt_id,
      predecessorReceiptId: receipt.predecessor_receipt_id,
      owner: receipt.owner,
      generation: receipt.generation,
      usage: receipt.usage,
    });
  } catch {
    throw new Error('PREFLIGHT_ACCOUNTING_RECEIPT_INVALID');
  }
  if (receipt.project_root_digest !== expected.project_root_digest
    || receipt.receipt_id !== expected.receipt_id
    || JSON.stringify(receipt) !== JSON.stringify(expected)) {
    throw new Error('PREFLIGHT_ACCOUNTING_RECEIPT_INVALID');
  }
  return expected;
}

export function checkHardBudget(loop, { now = Date.now(), sessionStart } = {}) {
  const b = loop.budget;
  // sessionStart 미지정 시 run의 created_at에서 파생 → 호출자가 빠뜨려도 wallclock이 0으로 무력화되지 않음 (Codex impl 🟡6)
  const start = sessionStart ?? (loop.created_at ? Date.parse(loop.created_at) : now);
  const wall = (now - start) / 1000;
  if (b.spent >= b.total * b.hard_stop_ratio) return { blocked: true, reason: 'turns-hard-stop' };
  if (b.tokens_total && b.tokens_spent >= b.tokens_total) return { blocked: true, reason: 'tokens-hard-stop' };
  if (b.max_wallclock_sec && wall >= b.max_wallclock_sec) return { blocked: true, reason: 'wallclock-hard-stop' };
  return { blocked: false, reason: null };
}

export function checkBudget(loop, { now = Date.now(), sessionStart, measurable = true } = {}) {
  const b = loop.budget;
  if (!measurable && b.enforcement !== 'best-effort-interactive' && b.on_unmeasurable_usage === 'fail-closed') {
    return { ok: false, reason: 'unmeasurable-usage-fail-closed', tier_after: loop.autonomy.tier };
  }
  const hard = checkHardBudget(loop, { now, sessionStart });
  if (hard.blocked) return { ok: false, reason: hard.reason, tier_after: loop.autonomy.tier };
  if (b.spent >= b.total * b.soft_stop_ratio) {
    const demoted = ['act-gated', 'act-reversible'].includes(loop.autonomy.tier) ? 'recommend' : loop.autonomy.tier;
    return { ok: true, reason: 'soft-stop-demote', tier_after: demoted };
  }
  return { ok: true, reason: 'ok', tier_after: loop.autonomy.tier };
}

const RECOVERY_TAKEOVER_KINDS = new Set(['affinity-supersession', 'boundary-recovery']);
const HARD_BUDGET_REASONS = new Set([
  'turns-hard-stop',
  'tokens-hard-stop',
  'wallclock-hard-stop',
]);

function hardBudgetPauseReason(reason) {
  if (reason === 'budget' || HARD_BUDGET_REASONS.has(reason)) return true;
  if (typeof reason !== 'string') return false;
  const match = /^(?:gate|checker-gate|budget):(.+)$/.exec(reason);
  return match !== null && (match[1] === 'budget' || HARD_BUDGET_REASONS.has(match[1]));
}

function sameBoundaryIdentity(left, right) {
  return Number.isSafeInteger(left?.seq) && left.seq > 0
    && /^[0-9a-f]{64}$/.test(left.checksum || '')
    && left.seq === right?.seq
    && left.checksum === right?.checksum;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) return null;
  return timestamp;
}

function rootRecoveryReservationKind(loop) {
  const lease = loop.session_chain?.lease || {};
  const kind = lease.takeover_kind;
  const sessions = loop.session_chain?.sessions;
  const operationId = lease.recovery_discriminator;
  if (loop.status !== 'paused'
    || loop.pause_reason !== 'project-root-relocated'
    || lease.state !== 'released'
    || !RECOVERY_TAKEOVER_KINDS.has(kind)
    || lease.handoff_phase !== 'reserved'
    || lease.handoff_trigger !== 'project-root-relocated'
    || lease.expires_at !== null
    || lease.handoff_idempotency_key !== operationId
    || !/^[0-9a-f]{64}$/.test(operationId || '')
    || typeof lease.owner_run_id !== 'string' || lease.owner_run_id.length === 0
    || !Number.isSafeInteger(lease.generation) || lease.generation < 1
    || typeof lease.handoff_child_run_id !== 'string'
    || lease.handoff_child_run_id.length === 0
    || !Array.isArray(sessions)) return null;
  const ownerRows = sessions.filter(session => session?.run_id === lease.owner_run_id);
  const childRows = sessions.filter(session => session?.run_id === lease.handoff_child_run_id);
  const child = childRows[0];
  const predecessorRows = sessions.filter(session => session?.run_id === child?.recovered_from);
  const predecessor = predecessorRows[0];
  const relocatedPredecessors = sessions.filter(
    session => session?.superseded_by === child?.run_id
      && session?.scope?.superseded_by === child?.run_id
      && session?.scope?.supersede_reason === 'project-root-relocated'
      && session?.scope?.superseded_at !== null
      && session?.ended_at !== null
      && session?.outcome === 'superseded',
  );
  const rootOperationRows = sessions.filter(
    session => session?.root_recovery_operation_id === operationId,
  );
  const openSessions = sessions.filter(session => isOpenScope(session?.scope));
  const rootDigest = projectRootDigest(loop.project?.root);
  if (ownerRows.length !== 1
    || childRows.length !== 1
    || predecessorRows.length > 1
    || rootOperationRows.length !== 1
    || rootOperationRows[0] !== child
    || child.recovery_kind !== kind
    || child.started_at !== null
    || child.ended_at !== null
    || child.turns !== 0
    || child.outcome !== null
    || child.superseded_by !== null
    || child.root_recovery_operation_id !== operationId
    || child.recovery_rel !== lease.recovery_rel
    || !/^recoveries\/root\/[^/]+\.json$/.test(child.recovery_rel || '')
    || child.recovery_sha256 !== lease.recovery_sha256
    || !/^[0-9a-f]{64}$/.test(child.recovery_sha256 || '')
    || child.recovery_project_binding_generation !== loop.project?.binding_generation
    || child.recovery_project_root_digest !== rootDigest
    || !isOpenScope(child.scope)
    || openSessions.length !== 1
    || openSessions[0] !== child
    || relocatedPredecessors.length < 1
    || (predecessor !== undefined && !relocatedPredecessors.includes(predecessor))) return null;
  return kind;
}

export function recoveryReservationKind(loop) {
  const rootKind = rootRecoveryReservationKind(loop);
  if (rootKind !== null) return rootKind;
  const lease = loop.session_chain?.lease || {};
  const kind = lease.takeover_kind;
  if (loop.status !== 'paused' || lease.state !== 'released'
    || !RECOVERY_TAKEOVER_KINDS.has(kind)
    || lease.handoff_phase !== 'reserved'
    || lease.expires_at !== null
    || typeof lease.owner_run_id !== 'string' || lease.owner_run_id.length === 0
    || !Number.isSafeInteger(lease.generation) || lease.generation < 1
    || typeof lease.handoff_child_run_id !== 'string' || lease.handoff_child_run_id.length === 0
    || !/^[0-9a-f]{64}$/.test(lease.handoff_idempotency_key || '')) {
    return null;
  }
  const sessions = loop.session_chain?.sessions;
  if (!Array.isArray(sessions)) return null;
  const ownerRows = sessions.filter(session => session?.run_id === lease.owner_run_id);
  if (ownerRows.length !== 1) return null;
  const owner = ownerRows[0];
  const childRows = sessions.filter(session => session?.run_id === lease.handoff_child_run_id);
  if (childRows.length !== 1) return null;
  const child = childRows[0];
  if (child.recovery_kind !== kind
    || typeof child.recovered_from !== 'string' || child.recovered_from.length === 0
    || child.recovered_from === child.run_id
    || child.started_at !== null
    || child.ended_at !== null
    || child.turns !== 0
    || child.outcome !== null
    || child.superseded_by !== null
    || !/^recoveries\/[^/].+/.test(child.recovery_rel || '')
    || !/^[0-9a-f]{64}$/.test(child.recovery_sha256 || '')) return null;
  const scope = child.scope;
  if (!isOpenScope(scope) || scope.closed_at !== null) return null;
  const openSessions = sessions.filter(
    session => isOpenScope(session?.scope) && session.scope.closed_at === null,
  );
  if (openSessions.length !== 1 || openSessions[0] !== child) return null;

  const predecessorRows = sessions.filter(session => session?.run_id === child.recovered_from);
  if (predecessorRows.length !== 1) return null;
  const predecessor = predecessorRows[0];
  const predecessorScope = predecessor.scope;
  if (predecessor.superseded_by !== child.run_id
    || predecessorScope?.kind !== 'workstream'
    || predecessorScope.terminal_event !== null
    || predecessorScope.closed_at !== null
    || predecessorScope.superseded_at === null
    || typeof predecessorScope.supersede_reason !== 'string'
    || predecessorScope.supersede_reason.length === 0
    || predecessorScope.superseded_by !== child.run_id) return null;
  const linkedSessions = sessions.filter(session => session?.superseded_by === child.run_id);
  const linkedScopes = sessions.filter(session => session?.scope?.superseded_by === child.run_id);
  if (linkedSessions.length !== 1 || linkedSessions[0] !== predecessor
    || linkedScopes.length !== 1 || linkedScopes[0] !== predecessor) return null;

  const workstreams = Array.isArray(loop.workstreams) ? loop.workstreams : [];
  if (kind === 'affinity-supersession') {
    const affinityRows = workstreams.filter(
      workstream => workstream?.id === scope.workstream_id,
    );
    const affinityWorkstream = affinityRows[0];
    if (loop.autonomy?.continuation_policy !== 'workstream-session'
      || owner !== predecessor
      || child.recovered_from !== lease.owner_run_id
      || typeof scope.workstream_id !== 'string' || scope.workstream_id.length === 0
      || !Number.isSafeInteger(scope.bound_at_seq) || scope.bound_at_seq < 1
      || predecessorScope.workstream_id !== scope.workstream_id
      || predecessorScope.bound_at_seq !== scope.bound_at_seq
      || affinityRows.length !== 1
      || !['planned', 'in_progress', 'in_review', 'parked'].includes(
        affinityWorkstream?.status,
      )
      || (affinityWorkstream?.terminal_events !== undefined
        && (!Array.isArray(affinityWorkstream.terminal_events)
          || affinityWorkstream.terminal_events.length !== 0))) return null;
  }
  if (kind === 'boundary-recovery'
    && (scope.workstream_id !== null || scope.bound_at_seq !== null
      || predecessorScope.workstream_id !== null
      || predecessorScope.bound_at_seq !== null
      || predecessorScope.supersede_reason !== 'boundary-recovery')) return null;
  if (kind === 'boundary-recovery') {
    const parentRows = sessions.filter(
      session => session?.run_id === predecessor.parent_run_id,
    );
    if (parentRows.length !== 1) return null;
    const parent = parentRows[0];
    const parentScope = parent.scope;
    const staleEndedAt = canonicalTimestamp(predecessor.ended_at);
    const staleStartedAt = canonicalTimestamp(predecessor.started_at);
    const staleRecoveredAt = canonicalTimestamp(predecessorScope.superseded_at);
    const parentClosedAt = canonicalTimestamp(parentScope?.closed_at);
    const parentSupersededAt = canonicalTimestamp(parentScope?.superseded_at);
    const rootDigest = projectRootDigest(loop.project?.root);
    const workstreamRows = workstreams
      .filter(workstream => workstream?.id === parentScope?.workstream_id);
    const workstream = workstreamRows[0];
    const boundaryEventRows = workstreams.flatMap(workstreamRow => (
      Array.isArray(workstreamRow?.terminal_events)
        ? workstreamRow.terminal_events
          .filter(event => sameBoundaryIdentity(event, lease.handoff_boundary_event))
          .map(() => workstreamRow)
        : []
    ));
    const neverAcquiredOwner = owner === parent
      && predecessor.started_at === null
      && staleEndedAt !== null
      && predecessor.turns === 0;
    const acquiredOwner = owner === predecessor
      && staleStartedAt !== null
      && staleEndedAt !== null
      && staleEndedAt >= staleStartedAt
      && parentSupersededAt !== null
      && parentSupersededAt <= staleStartedAt
      && Number.isSafeInteger(predecessor.turns)
      && predecessor.turns >= 0;
    if (parent === predecessor || parent === child
      || parent.superseded_by !== predecessor.run_id
      || parentScope?.kind !== 'workstream'
      || parentClosedAt === null
      || parentSupersededAt === null
      || staleRecoveredAt === null
      || staleEndedAt !== staleRecoveredAt
      || parentClosedAt > parentSupersededAt
      || parentSupersededAt > staleRecoveredAt
      || !sameBoundaryIdentity(
        predecessor.parent_boundary_event,
        parentScope.terminal_event,
      )
      || !sameBoundaryIdentity(
        lease.handoff_boundary_event,
        parentScope.terminal_event,
      )
      || !sameBoundaryIdentity(
        lease.handoff_boundary_event,
        predecessor.parent_boundary_event,
      )
      || predecessor.project_binding_generation !== loop.project?.binding_generation
      || lease.handoff_project_binding_generation !== loop.project?.binding_generation
      || lease.handoff_project_binding_generation !== predecessor.project_binding_generation
      || predecessor.project_root_digest !== rootDigest
      || lease.handoff_project_root_digest !== rootDigest
      || lease.handoff_project_root_digest !== predecessor.project_root_digest
      || workstreamRows.length !== 1
      || !['ready', 'merged', 'abandoned'].includes(workstream?.status)
      || !Array.isArray(workstream?.terminal_events)
      || boundaryEventRows.length !== 1
      || boundaryEventRows[0] !== workstream
      || predecessor.outcome !== 'abandoned_recover'
      || (!neverAcquiredOwner && !acquiredOwner)) {
      return null;
    }
  }
  return kind;
}

function assertExactParentFence(loop, fence) {
  const lease = loop.session_chain?.lease || {};
  if (!fence || typeof fence.owner !== 'string' || fence.owner.length === 0
    || !Number.isSafeInteger(fence.generation) || fence.generation < 1) {
    throw new Error('LEASE_FENCED: invalid-fence');
  }
  if (lease.owner_run_id !== fence.owner) throw new Error('LEASE_FENCED: owner-mismatch');
  if (lease.generation !== fence.generation) throw new Error('LEASE_FENCED: generation-mismatch');
  if (loop.status === 'completed' || loop.status === 'stopped') {
    throw new Error('LEASE_FENCED: RUN_TERMINAL');
  }
}

function positiveDelta(value) {
  return value === undefined || (Number.isSafeInteger(value) && value > 0);
}

function safeIncrement(current, delta) {
  if (delta === undefined) return current;
  const next = current + delta;
  if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(next) || next < current) {
    throw new Error('BUDGET_EXTENSION_INVALID: unsafe total');
  }
  return next;
}

export function extendBudget(root, runId, {
  turns,
  tokens,
  wallclockSec,
  reason,
  confirm,
  fence,
  now = Date.now(),
} = {}) {
  if (confirm !== true) throw new Error('BUDGET_EXTENSION_CONFIRM_REQUIRED');
  if (typeof reason !== 'string' || reason.trim().length === 0
    || reason.length > 1_024 || reason.includes('\0')) {
    throw new Error('BUDGET_EXTENSION_REASON_INVALID');
  }
  if (![turns, tokens, wallclockSec].every(positiveDelta)
    || [turns, tokens, wallclockSec].every(value => value === undefined)) {
    throw new Error('BUDGET_EXTENSION_INVALID: deltas must be positive safe integers');
  }

  let resultStatus = null;
  appendAnchored(
    root,
    runId,
    {
      type: 'budget-extended',
      data: {
        ...(turns !== undefined ? { turns } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
        ...(wallclockSec !== undefined ? { wallclock_sec: wallclockSec } : {}),
        reason,
      },
      now,
    },
    (loop) => {
      loop.budget.total = safeIncrement(loop.budget.total, turns);
      loop.budget.tokens_total = safeIncrement(loop.budget.tokens_total, tokens);
      if (wallclockSec !== undefined) {
        loop.budget.max_wallclock_sec = safeIncrement(loop.budget.max_wallclock_sec, wallclockSec);
      }
      if (recoveryReservationKind(loop) === null) {
        loop.status = 'running';
        loop.pause_reason = null;
      }
      resultStatus = loop.status;
    },
    (loop) => {
      assertExactParentFence(loop, fence);
      const recoveryKind = recoveryReservationKind(loop);
      const ordinaryPause = loop.status === 'paused'
        && hardBudgetPauseReason(loop.pause_reason)
        && loop.session_chain?.lease?.state === 'active';
      if (!ordinaryPause && recoveryKind === null) {
        throw new Error('BUDGET_EXTENSION_STATUS_INVALID');
      }
      if (!checkHardBudget(loop, { now }).blocked) {
        throw new Error('BUDGET_EXTENSION_STATUS_INVALID: budget is not hard-blocked');
      }
      if (wallclockSec !== undefined
        && (!Number.isSafeInteger(loop.budget.max_wallclock_sec)
          || loop.budget.max_wallclock_sec <= 0)) {
        throw new Error('BUDGET_EXTENSION_WALLCLOCK_UNAVAILABLE');
      }
      const candidate = structuredClone(loop);
      candidate.budget.total = safeIncrement(candidate.budget.total, turns);
      candidate.budget.tokens_total = safeIncrement(candidate.budget.tokens_total, tokens);
      if (wallclockSec !== undefined) {
        candidate.budget.max_wallclock_sec = safeIncrement(
          candidate.budget.max_wallclock_sec,
          wallclockSec,
        );
      }
      if (checkHardBudget(candidate, { now }).blocked) {
        throw new Error('BUDGET_EXTENSION_INSUFFICIENT');
      }
    },
  );
  return { ok: true, status: resultStatus };
}

// #3 max-rule: the auto-floor turns/tokens accrued since the last EXPLICIT cost event (i.e. the current "tick").
// An explicit `budget record` ABSORBS this floor rather than stacking on top of it — the tick's contribution is
// max(reported, floor-sum), not the sum. A non-floor (explicit) cost resets the running tick.
// impl-R1 Fix 1: scoped to a SINGLE session (owner+generation). Only floors tagged with THIS session are absorbable;
// a prior session's floors are confirmed consumption and are skipped (never swallowed by a later report). An
// explicit cost of the SAME session closes its tick.
function trailingFloor(lines, owner, generation) {
  let tf = 0, tk = 0;
  for (const e of lines) {
    if (e.type !== 'cost') continue;
    if (e.data?.owner !== owner || e.data?.generation !== generation) continue;   // different session → not ours to absorb
    if (e.data?.auto_floor) { tf += e.data.turns || 0; tk += e.data.tokens || 0; }
    else { tf = 0; tk = 0; }   // this session's explicit cost ends its tick
  }
  return { tf, tk };
}

// Explicit cost report — its own reconciled mutation lock (needs the log to absorb the tick's floor before appending an
// ADJUSTED cost). Mirrors appendAnchored's verify→append→anchor→reconcile sequence; recomputeSpent stays a PURE
// sum so reconcileBudget agrees automatically. Negative/non-finite still rejected (validCost).
export function recordCost(root, runId, { turns = 0, tokens = 0, fence } = {}) {
  if (!validCost({ turns, tokens })) throw new Error(`INVALID_COST: turns/tokens must be finite >= 0 (got ${turns}/${tokens})`);
  return withReconciledMutationLock(root, runId, (_guard, { data: loop }) => {
    if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
    // v1.6 (spec §2.3-7): recordCost는 자체 appendEvent+writeState 경로(appendAnchored 관문 비경유).
    // fence가 있으면 위 leaseCheck가 LEASE_FENCED: RUN_TERMINAL로 선착 — drive-headless의 LEASE_FENCED
    // swallow 계약 보존(순서가 계약). fence-less 직접 호출만 이 자체 가드가 잡는다.
    if (loop.status === 'completed' || loop.status === 'stopped') throw new Error('RUN_TERMINAL: recordCost');
    const v = verifyLog(root, runId); if (!v.ok) throw new Error(`LOG_TAMPERED: ${v.errors.join('; ')}`);
    const h = verifyHead(root, runId, loop.event_log_head); if (!h.ok) throw new Error(`LOG_TAMPERED: ${h.errors.join('; ')}`);
    const lease = loop.session_chain?.lease || {};
    const { tf, tk } = trailingFloor(readLines(root, runId), lease.owner_run_id, lease.generation);   // this session's tick floor only
    const adjTurns = Math.max(0, turns - tf), adjTokens = Math.max(0, tokens - tk);   // tick contribution = max(reported, floor-sum)
    appendEvent(root, runId, { type: 'cost', data: { turns: adjTurns, tokens: adjTokens, reported_turns: turns, reported_tokens: tokens, owner: lease.owner_run_id, generation: lease.generation } });
    loop.event_log_head = lastLogHead(root, runId);
    const spent = recomputeSpent(root, runId);   // pure sum = prior + floors + adjusted = prior-session floors + max(reported, this-session floors)
    loop.budget.spent = spent.turns;
    loop.budget.tokens_spent = spent.tokens;
    // per_session_turn_cap 판정용 session.turns 도 max-rule을 따른다 — 이 tick 기여분 = tf(이미 floor로 반영) + adjTurns.
    const sess = (loop.session_chain?.sessions || []).find(s => s.run_id === lease.owner_run_id);
    if (sess) sess.turns = (sess.turns || 0) + adjTurns;
    writeState(root, runId, loop);
  });
}

function preflightUsageFromEvent(event) {
  return {
    num_turns: event.data?.reported_turns,
    input_tokens: event.data?.input_tokens,
    output_tokens: event.data?.output_tokens,
    tokens: event.data?.reported_tokens,
    ...(event.data?.cached_input_tokens !== undefined
      ? { cached_input_tokens: event.data.cached_input_tokens } : {}),
    ...(event.data?.reasoning_output_tokens !== undefined
      ? { reasoning_output_tokens: event.data.reasoning_output_tokens } : {}),
  };
}

function exactPreflightCostEvent(event, receipt, lines) {
  const eventIndex = lines.indexOf(event);
  if (eventIndex < 0 || !hasCanonicalEventData(event.data, [
    'turns',
    'tokens',
    'reported_turns',
    'reported_tokens',
    'input_tokens',
    'output_tokens',
    'owner',
    'generation',
    'source',
    'preflight_receipt_id',
    'preflight_cache_key',
    'preflight_smoke',
    'preflight_attempt_id',
    'predecessor_receipt_id',
  ])) return false;
  const priorLines = eventIndex < 0 ? [] : lines.slice(0, eventIndex);
  const { tf, tk } = trailingFloor(priorLines, receipt.owner, receipt.generation);
  let eventReceipt;
  try {
    eventReceipt = makeCodexPreflightReceipt({
      root: receipt.__root,
      runId: receipt.run_id,
      cacheKey: event.data?.preflight_cache_key,
      smokeKind: event.data?.preflight_smoke,
      attemptId: event.data?.preflight_attempt_id,
      predecessorReceiptId: event.data?.predecessor_receipt_id,
      owner: event.data?.owner,
      generation: event.data?.generation,
      usage: preflightUsageFromEvent(event),
    });
  } catch {
    return false;
  }
  return event.type === 'cost'
    && event.data?.source === 'codex-preflight-measured'
    && event.data?.preflight_receipt_id === receipt.receipt_id
    && eventReceipt.receipt_id === receipt.receipt_id
    && event.data?.preflight_cache_key === receipt.cache_key
    && event.data?.preflight_smoke === receipt.smoke_kind
    && event.data?.preflight_attempt_id === receipt.attempt_id
    && event.data?.predecessor_receipt_id === receipt.predecessor_receipt_id
    && event.data?.owner === receipt.owner
    && event.data?.generation === receipt.generation
    && event.data?.turns === Math.max(0, receipt.usage.num_turns - tf)
    && event.data?.tokens === Math.max(0, receipt.usage.tokens - tk)
    && sameMeasuredUsage(preflightUsageFromEvent(event), receipt.usage);
}

function samePreflightProcessIdentity(event, receipt) {
  return event.type === 'cost'
    && event.data?.preflight_cache_key === receipt.cache_key
    && event.data?.preflight_smoke === receipt.smoke_kind
    && event.data?.preflight_attempt_id === receipt.attempt_id;
}

function verifyPreflightWritePredecessor(runId, exact, lines) {
  if (exact.smoke_kind !== 'write') return;
  const predecessors = lines.filter(event => samePreflightProcessIdentity(event, {
    cache_key: exact.cache_key,
    smoke_kind: 'read',
    attempt_id: exact.attempt_id,
  }));
  if (predecessors.length === 0) throw new Error('PREFLIGHT_ACCOUNTING_PREDECESSOR_MISSING');
  if (predecessors.length !== 1) throw new Error('PREFLIGHT_ACCOUNTING_DUPLICATE');
  const predecessor = predecessors[0];
  let predecessorReceipt;
  try {
    predecessorReceipt = {
      ...makeCodexPreflightReceipt({
        root: exact.__root,
        runId,
        cacheKey: exact.cache_key,
        smokeKind: 'read',
        attemptId: exact.attempt_id,
        predecessorReceiptId: null,
        owner: exact.owner,
        generation: exact.generation,
        usage: preflightUsageFromEvent(predecessor),
      }),
      __root: exact.__root,
    };
  } catch {
    throw new Error('PREFLIGHT_ACCOUNTING_PREDECESSOR_INVALID');
  }
  if (predecessor.data?.preflight_receipt_id !== exact.predecessor_receipt_id
    || predecessorReceipt.receipt_id !== exact.predecessor_receipt_id
    || !exactPreflightCostEvent(predecessor, predecessorReceipt, lines)) {
    throw new Error('PREFLIGHT_ACCOUNTING_PREDECESSOR_INVALID');
  }
}

// A successful Codex preflight smoke is represented by an immutable, hash-bound receipt before an active cache
// can be published. The current accounting fence authorizes settlement, while the receipt's origin session owns
// the charge. An identical retry is a byte-preserving no-op even after the lease has legitimately advanced.
export function settleCodexPreflightCost(root, runId, { receipt, fence } = {}) {
  const exact = { ...validateCodexPreflightReceipt(root, runId, receipt), __root: canonicalProjectRoot(root) };
  if (!fence || typeof fence.owner !== 'string' || fence.owner.length === 0
    || !Number.isInteger(fence.generation) || fence.generation < 1
    || fence.intent !== 'accounting') {
    throw new Error('PREFLIGHT_ACCOUNTING_FENCE_REQUIRED');
  }
  return withReconciledMutationLock(root, runId, (_guard, { data: loop }) => {
    const lease = loop.session_chain?.lease || {};
    if (lease.owner_run_id !== fence.owner) throw new Error('LEASE_FENCED: owner-mismatch');
    if (lease.generation !== fence.generation) throw new Error('LEASE_FENCED: generation-mismatch');
    if (sessionRuntime(loop) !== 'codex') {
      throw new Error('RUNTIME_FENCED: preflight accounting requires codex');
    }
    const verified = verifyLog(root, runId);
    if (!verified.ok) throw new Error(`LOG_TAMPERED: ${verified.errors.join('; ')}`);
    const anchored = verifyHead(root, runId, loop.event_log_head);
    if (!anchored.ok) throw new Error(`LOG_TAMPERED: ${anchored.errors.join('; ')}`);
    const lines = readLines(root, runId);
    const originSession = (loop.session_chain?.sessions || [])
      .find(session => session.run_id === exact.owner);
    if (!originSession || !Number.isSafeInteger(originSession.turns) || originSession.turns < 0) {
      throw new Error('PREFLIGHT_ACCOUNTING_ORIGIN_INVALID');
    }
    verifyPreflightWritePredecessor(runId, exact, lines);

    const receiptEvents = lines.filter(event => event.type === 'cost'
      && event.data?.preflight_receipt_id === exact.receipt_id);
    const identityEvents = lines.filter(event => samePreflightProcessIdentity(event, exact));
    const relatedEvents = new Set([...receiptEvents, ...identityEvents]);
    if (receiptEvents.length > 1 || identityEvents.length > 1 || relatedEvents.size > 1) {
      throw new Error('PREFLIGHT_ACCOUNTING_DUPLICATE');
    }
    if (receiptEvents.length === 1) {
      if (identityEvents[0] !== receiptEvents[0]
        || !exactPreflightCostEvent(receiptEvents[0], exact, lines)) {
        throw new Error('PREFLIGHT_ACCOUNTING_MISMATCH');
      }
      return { ok: true, recorded: false, reason: 'already-recorded' };
    }
    if (identityEvents.length === 1) throw new Error('PREFLIGHT_ACCOUNTING_MISMATCH');

    const authorized = leaseCheck(loop, fence);
    if (!authorized.ok) throw new Error(`LEASE_FENCED: ${authorized.reason}`);
    const { tf, tk } = trailingFloor(lines, exact.owner, exact.generation);
    const adjustedTurns = Math.max(0, exact.usage.num_turns - tf);
    const adjustedTokens = Math.max(0, exact.usage.tokens - tk);
    appendEvent(root, runId, {
      type: 'cost',
      data: {
        turns: adjustedTurns,
        tokens: adjustedTokens,
        reported_turns: exact.usage.num_turns,
        reported_tokens: exact.usage.tokens,
        input_tokens: exact.usage.input_tokens,
        output_tokens: exact.usage.output_tokens,
        ...(exact.usage.cached_input_tokens !== undefined
          ? { cached_input_tokens: exact.usage.cached_input_tokens } : {}),
        ...(exact.usage.reasoning_output_tokens !== undefined
          ? { reasoning_output_tokens: exact.usage.reasoning_output_tokens } : {}),
        owner: exact.owner,
        generation: exact.generation,
        source: 'codex-preflight-measured',
        preflight_receipt_id: exact.receipt_id,
        preflight_cache_key: exact.cache_key,
        preflight_smoke: exact.smoke_kind,
        preflight_attempt_id: exact.attempt_id,
        predecessor_receipt_id: exact.predecessor_receipt_id,
      },
    });
    loop.event_log_head = lastLogHead(root, runId);
    const spent = recomputeSpent(root, runId);
    loop.budget.spent = spent.turns;
    loop.budget.tokens_spent = spent.tokens;
    originSession.turns += adjustedTurns;
    writeState(root, runId, loop);
    return { ok: true, recorded: true, reason: 'recorded' };
  });
}

function processUsageFromEvent(event) {
  return {
    num_turns: event.data?.reported_turns,
    input_tokens: event.data?.input_tokens,
    output_tokens: event.data?.output_tokens,
    tokens: event.data?.reported_tokens,
    ...(event.data?.cached_input_tokens !== undefined
      ? { cached_input_tokens: event.data.cached_input_tokens } : {}),
    ...(event.data?.reasoning_output_tokens !== undefined
      ? { reasoning_output_tokens: event.data.reasoning_output_tokens } : {}),
  };
}

function exactProcessCostEvent(event, exact, origin, lines) {
  const eventIndex = lines.indexOf(event);
  const followsFinish = eventIndex >= 0
    && lines.slice(0, eventIndex).some(item => item.type === 'finish');
  const terminalMaker = exact.process_kind === 'maker' && followsFinish;
  if (eventIndex < 0
    || !hasCanonicalEventData(event.data, [
      'turns',
      'tokens',
      'reported_turns',
      'reported_tokens',
      'input_tokens',
      'output_tokens',
      'owner',
      'generation',
      'source',
      'process_receipt_id',
      'process_kind',
      'process_context',
      ...(terminalMaker ? ['terminal_process'] : []),
    ])
    || (terminalMaker && event.data?.terminal_process !== 'codex-maker')
    || JSON.stringify(event.data?.process_context) !== JSON.stringify(exact.context)) return false;
  let reconstructed;
  try {
    reconstructed = makeCodexProcessReceipt({
      root: exact.__root,
      runId: exact.run_id,
      processKind: event.data?.process_kind,
      context: event.data?.process_context,
      usage: processUsageFromEvent(event),
    });
  } catch {
    return false;
  }
  const { tf, tk } = trailingFloor(
    lines.slice(0, eventIndex),
    origin.owner,
    origin.generation,
  );
  return event.type === 'cost'
    && event.data?.source === `codex-${exact.process_kind}-measured`
    && event.data?.process_receipt_id === exact.receipt_id
    && event.data?.process_kind === exact.process_kind
    && reconstructed.receipt_id === exact.receipt_id
    && sameMeasuredUsage(processUsageFromEvent(event), exact.usage)
    && event.data?.owner === origin.owner
    && event.data?.generation === origin.generation
    && event.data?.turns === Math.max(0, exact.usage.num_turns - tf)
    && event.data?.tokens === Math.max(0, exact.usage.tokens - tk);
}

function sameProcessIdentity(event, exact) {
  return event.type === 'cost'
    && event.data?.process_kind === exact.process_kind
    && JSON.stringify(event.data?.process_context) === JSON.stringify(exact.context);
}

// An exact event admitted by this writer leaves the stored budget reconciled with the verified cost log.
// This durable footprint distinguishes idempotent history from an append-only lookalike without trusting clocks.
function storedBudgetMatchesLines(loop, lines) {
  const spent = lines.filter(event => event.type === 'cost').reduce((total, event) => ({
    turns: total.turns + event.data.turns,
    tokens: total.tokens + event.data.tokens,
  }), { turns: 0, tokens: 0 });
  return loop.budget?.spent === spent.turns && loop.budget?.tokens_spent === spent.tokens;
}

function exactSession(loop, owner) {
  const session = (loop.session_chain?.sessions || []).find(item => item.run_id === owner);
  if (!session || !Number.isSafeInteger(session.turns) || session.turns < 0) {
    throw new Error('PROCESS_ACCOUNTING_ORIGIN_INVALID');
  }
  return session;
}

function makerContext(loop, exact, lines) {
  const context = exact.context;
  if (!isCanonicalHandoffKey(context.handoff_key, loop.autonomy?.continuation_policy)) {
    throw new Error('PROCESS_ACCOUNTING_CONTEXT_MISMATCH');
  }
  const parent = exactSession(loop, context.parent_owner);
  const child = exactSession(loop, context.child_run_id);
  if (child.handoff_rel !== context.handoff_rel) {
    throw new Error('PROCESS_ACCOUNTING_CONTEXT_MISMATCH');
  }
  const handoffs = lines.filter(event => event.type === 'handoff-emitted'
    && event.data?.child_run_id === context.child_run_id
    && event.data?.key === context.handoff_key);
  if (handoffs.length !== 1) throw new Error('PROCESS_ACCOUNTING_CONTEXT_MISMATCH');
  return { context, parent, child };
}

function acquiredMakerContext(context, parent, child) {
  const acquired = typeof child.started_at === 'string'
    && Number.isFinite(Date.parse(child.started_at))
    && child.outcome !== 'failed_launch'
    && parent.outcome === 'took_over';
  if (acquired && parent.superseded_by !== context.child_run_id) {
    throw new Error('PROCESS_ACCOUNTING_CONTEXT_MISMATCH');
  }
  if (!acquired && (child.started_at != null
    || (parent.superseded_by !== context.child_run_id && child.outcome !== 'failed_launch'))) {
    throw new Error('PROCESS_ACCOUNTING_CONTEXT_MISMATCH');
  }
  return acquired;
}

function makerOrigin(loop, exact, lines) {
  const { context, parent, child } = makerContext(loop, exact, lines);
  const acquired = acquiredMakerContext(context, parent, child);
  return acquired
    ? { session: child, owner: context.child_run_id, generation: context.child_generation, acquired: true }
    : { session: parent, owner: context.parent_owner, generation: context.parent_generation, acquired: false };
}

function historicalMakerOrigin(loop, exact, event, lines) {
  const { context, parent, child } = makerContext(loop, exact, lines);
  const acquired = acquiredMakerContext(context, parent, child);
  if (event.data?.owner === context.parent_owner
    && event.data?.generation === context.parent_generation) {
    return {
      session: parent,
      owner: context.parent_owner,
      generation: context.parent_generation,
      acquired: false,
    };
  }
  if (event.data?.owner === context.child_run_id
    && event.data?.generation === context.child_generation) {
    if (!acquired) throw new Error('PROCESS_ACCOUNTING_MISMATCH');
    return {
      session: child,
      owner: context.child_run_id,
      generation: context.child_generation,
      acquired: true,
    };
  }
  throw new Error('PROCESS_ACCOUNTING_MISMATCH');
}

function checkerOrigin(loop, exact) {
  const context = exact.context;
  const checker = (loop.episodes || []).find(episode => episode.id === context.checker_episode_id);
  if (!checker || checker.attempt_id !== context.attempt_id
    || checker.target_maker !== context.target_maker
    || checker.review_claim?.lease_owner !== context.origin_owner
    || checker.review_claim?.lease_generation !== context.origin_generation
    || codexCheckerClaimHash(checker.review_claim) !== context.claim_hash) {
    throw new Error('PROCESS_ACCOUNTING_CONTEXT_MISMATCH');
  }
  return {
    session: exactSession(loop, context.origin_owner),
    owner: context.origin_owner,
    generation: context.origin_generation,
    acquired: false,
  };
}

function verifyTerminalMakerSettlement(loop, exact, origin, lines) {
  if (!origin.acquired || loop.status !== 'completed' && loop.status !== 'stopped') {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const lease = loop.session_chain?.lease || {};
  if (lease.owner_run_id !== origin.owner || lease.generation !== origin.generation
    || lease.state !== 'active' || lease.handoff_phase !== 'acquired') {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const finishes = lines.filter(event => event.type === 'finish');
  const finish = finishes[0];
  if (finishes.length !== 1 || finish.data?.status !== loop.status
    || typeof loop.termination?.finished_at !== 'string') {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const finishFloor = lines.find(event => event.seq === finish.seq + 1
    && event.type === 'cost' && event.data?.auto_floor === true && event.data?.for === 'finish'
    && event.data?.owner === origin.owner && event.data?.generation === origin.generation);
  const handoff = lines.find(event => event.type === 'handoff-emitted'
    && event.data?.child_run_id === exact.context.child_run_id
    && event.data?.key === exact.context.handoff_key);
  if (!finishFloor || !handoff || handoff.seq >= finish.seq) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const forbidden = lines.some(event => event.seq > finish.seq
    && event !== finishFloor && !exactProcessCostEvent(event, exact, origin, lines));
  if (forbidden) throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
}

function verifyTerminalCheckerSettlement(loop, exact, origin, lines) {
  if (loop.status !== 'completed' && loop.status !== 'stopped') {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const lease = loop.session_chain?.lease || {};
  if (lease.owner_run_id !== origin.owner || lease.generation !== origin.generation
    || lease.state !== 'active') {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const checker = (loop.episodes || []).find(
    episode => episode.id === exact.context.checker_episode_id,
  );
  if (!['approved', 'rejected'].includes(checker?.status)
    || checker.review_source !== 'imported-stdin'
    || checker.attempt_id !== exact.context.attempt_id) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const outcomes = lines.filter(event => event.type === 'review-outcome'
    && event.data?.episodeId === exact.context.checker_episode_id
    && event.data?.attempt_id === exact.context.attempt_id
    && event.data?.target_maker === exact.context.target_maker
    && event.data?.review_source === 'imported-stdin');
  const finishes = lines.filter(event => event.type === 'finish');
  const outcome = outcomes[0];
  const finish = finishes[0];
  if (outcomes.length !== 1 || finishes.length !== 1 || outcome.seq >= finish.seq
    || finish.data?.status !== loop.status || typeof loop.termination?.finished_at !== 'string') {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const finishFloor = lines.find(event => event.seq === finish.seq + 1
    && event.type === 'cost' && event.data?.auto_floor === true && event.data?.for === 'finish'
    && event.data?.owner === origin.owner && event.data?.generation === origin.generation);
  if (!finishFloor) throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  const forbidden = lines.some(event => event.seq > finish.seq
    && event !== finishFloor && !exactProcessCostEvent(event, exact, origin, lines));
  if (forbidden) throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
}

function verifyStoppedPreImportCheckerSettlement(loop, exact, origin, lines) {
  const context = exact.context;
  const lease = loop.session_chain?.lease || {};
  const checker = (loop.episodes || []).find(
    episode => episode.id === context.checker_episode_id,
  );
  const claim = checker?.review_claim;
  if (loop.status !== 'stopped'
    || lease.owner_run_id !== origin.owner || lease.generation !== origin.generation
    || lease.state !== 'active'
    || checker?.status !== 'in_progress' || checker.review_source != null
    || !hasExactEventData(claim, [
      'run_id',
      'reviewer_id',
      'checker_episode_id',
      'target_maker',
      'attempt_id',
      'workstream_id',
      'point',
      'project_root',
      'runtime',
      'lease_owner',
      'lease_generation',
      'artifacts',
    ])
    || claim.run_id !== loop.run_id
    || claim.runtime !== 'codex'
    || claim.project_root !== exact.__root
    || claim.checker_episode_id !== context.checker_episode_id
    || claim.target_maker !== context.target_maker
    || claim.attempt_id !== context.attempt_id
    || claim.lease_owner !== origin.owner
    || claim.lease_generation !== origin.generation
    || !Array.isArray(claim.artifacts)) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }

  const claimIdentityEvents = lines.filter(event => event.type === 'independent-review-claimed'
    && event.data?.episode_id === context.checker_episode_id
    && event.data?.attempt_id === context.attempt_id);
  const claimEvent = claimIdentityEvents[0];
  if (claimIdentityEvents.length !== 1
    || !hasExactEventData(claimEvent?.data, [
      'episode_id',
      'attempt_id',
      'reviewer_id',
      'target_maker',
      'workstream_id',
      'point',
      'artifacts',
    ])
    || claimEvent.data.reviewer_id !== claim.reviewer_id
    || claimEvent.data.target_maker !== claim.target_maker
    || claimEvent.data.workstream_id !== claim.workstream_id
    || claimEvent.data.point !== claim.point
    || JSON.stringify(claimEvent.data.artifacts) !== JSON.stringify(claim.artifacts)) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }

  const finishes = lines.filter(event => event.type === 'finish');
  const finish = finishes[0];
  const finalReport = Object.hasOwn(loop.termination || {}, 'final_report')
    ? loop.termination.final_report : null;
  if (finishes.length !== 1
    || !hasExactEventData(finish?.data, ['status', 'reportRel'])
    || finish.data.status !== 'stopped'
    || finish.data.reportRel !== finalReport
    || claimEvent.seq >= finish.seq
    || typeof loop.termination?.finished_at !== 'string'
    || !Number.isFinite(Date.parse(loop.termination.finished_at))) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }

  const finishFloor = lines.find(event => event.seq === finish.seq + 1);
  if (finishFloor?.type !== 'cost'
    || !hasExactEventData(finishFloor.data, [
      'turns', 'tokens', 'auto_floor', 'for', 'owner', 'generation',
    ])
    || finishFloor.data.turns !== MUTATION_TURN_FLOOR
    || finishFloor.data.tokens !== 0
    || finishFloor.data.auto_floor !== true
    || finishFloor.data.for !== 'finish'
    || finishFloor.data.owner !== origin.owner
    || finishFloor.data.generation !== origin.generation) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }

  const outcomes = lines.filter(event => event.type === 'review-outcome'
    && event.data?.episodeId === context.checker_episode_id
    && event.data?.attempt_id === context.attempt_id);
  const forbiddenAfterFinish = lines.some(event => event.seq > finish.seq
    && event !== finishFloor);
  if (outcomes.length !== 0 || forbiddenAfterFinish) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
}

// Worker-owned maker/checker receipts are immutable before the trusted sync facade can return success.
// Settlement is authorized by the current accounting fence, but charges the context-derived origin session.
// Terminal exceptions are limited to the exact acquired maker with handoff + finish proof and the exact stopped,
// pre-import checker with claim + finish proof. Neither branch can alter proof, status, lease, or event shape.
export function settleCodexProcessCost(root, runId, { receipt, fence } = {}) {
  if (receipt?.contract === CODEX_PREFLIGHT_RECEIPT_CONTRACT) {
    return settleCodexPreflightCost(root, runId, { receipt, fence });
  }
  const exact = { ...validateCodexProcessReceipt(root, runId, receipt), __root: canonicalProjectRoot(root) };
  if (!fence || typeof fence.owner !== 'string' || fence.owner.length === 0
    || !Number.isInteger(fence.generation) || fence.generation < 1
    || fence.intent !== 'accounting') {
    throw new Error('PROCESS_ACCOUNTING_FENCE_REQUIRED');
  }
  return withReconciledMutationLock(root, runId, (_guard, { data: loop }) => {
    const lease = loop.session_chain?.lease || {};
    if (lease.owner_run_id !== fence.owner) throw new Error('LEASE_FENCED: owner-mismatch');
    if (lease.generation !== fence.generation) throw new Error('LEASE_FENCED: generation-mismatch');
    if (sessionRuntime(loop) !== 'codex') {
      throw new Error('RUNTIME_FENCED: process accounting requires codex');
    }
    const verified = verifyLog(root, runId);
    if (!verified.ok) throw new Error(`LOG_TAMPERED: ${verified.errors.join('; ')}`);
    const anchored = verifyHead(root, runId, loop.event_log_head);
    if (!anchored.ok) throw new Error(`LOG_TAMPERED: ${anchored.errors.join('; ')}`);
    const lines = readLines(root, runId);
    const receiptEvents = lines.filter(event => event.type === 'cost'
      && event.data?.process_receipt_id === exact.receipt_id);
    const identityEvents = lines.filter(event => sameProcessIdentity(event, exact));
    const relatedEvents = new Set([...receiptEvents, ...identityEvents]);
    if (receiptEvents.length > 1 || identityEvents.length > 1 || relatedEvents.size > 1) {
      throw new Error('PROCESS_ACCOUNTING_DUPLICATE');
    }
    if (receiptEvents.length === 1) {
      if (!storedBudgetMatchesLines(loop, lines)) {
        throw new Error('PROCESS_ACCOUNTING_MISMATCH');
      }
      const origin = exact.process_kind === 'maker'
        ? historicalMakerOrigin(loop, exact, receiptEvents[0], lines)
        : checkerOrigin(loop, exact);
      if (identityEvents[0] !== receiptEvents[0]
        || !exactProcessCostEvent(receiptEvents[0], exact, origin, lines)) {
        throw new Error('PROCESS_ACCOUNTING_MISMATCH');
      }
      return { ok: true, recorded: false, reason: 'already-recorded' };
    }
    if (identityEvents.length === 1) throw new Error('PROCESS_ACCOUNTING_MISMATCH');

    const origin = exact.process_kind === 'maker'
      ? makerOrigin(loop, exact, lines)
      : checkerOrigin(loop, exact);

    const authorized = leaseCheck(loop, fence);
    if (!authorized.ok) {
      if (authorized.reason !== 'RUN_TERMINAL') {
        throw new Error(`LEASE_FENCED: ${authorized.reason}`);
      }
      if (exact.process_kind === 'maker') verifyTerminalMakerSettlement(loop, exact, origin, lines);
      else if (exact.process_kind === 'checker') {
        const checker = (loop.episodes || []).find(
          episode => episode.id === exact.context.checker_episode_id,
        );
        if (loop.status === 'stopped' && checker?.status === 'in_progress') {
          verifyStoppedPreImportCheckerSettlement(loop, exact, origin, lines);
        } else {
          verifyTerminalCheckerSettlement(loop, exact, origin, lines);
        }
      }
      else throw new Error(`LEASE_FENCED: ${authorized.reason}`);
    }
    const { tf, tk } = trailingFloor(lines, origin.owner, origin.generation);
    const adjustedTurns = Math.max(0, exact.usage.num_turns - tf);
    const adjustedTokens = Math.max(0, exact.usage.tokens - tk);
    appendEvent(root, runId, {
      type: 'cost',
      data: {
        turns: adjustedTurns,
        tokens: adjustedTokens,
        reported_turns: exact.usage.num_turns,
        reported_tokens: exact.usage.tokens,
        input_tokens: exact.usage.input_tokens,
        output_tokens: exact.usage.output_tokens,
        ...(exact.usage.cached_input_tokens !== undefined
          ? { cached_input_tokens: exact.usage.cached_input_tokens } : {}),
        ...(exact.usage.reasoning_output_tokens !== undefined
          ? { reasoning_output_tokens: exact.usage.reasoning_output_tokens } : {}),
        owner: origin.owner,
        generation: origin.generation,
        source: `codex-${exact.process_kind}-measured`,
        process_receipt_id: exact.receipt_id,
        process_kind: exact.process_kind,
        process_context: exact.context,
        ...(exact.process_kind === 'maker'
          && (loop.status === 'completed' || loop.status === 'stopped')
          ? { terminal_process: 'codex-maker' } : {}),
      },
    });
    loop.event_log_head = lastLogHead(root, runId);
    const spent = recomputeSpent(root, runId);
    loop.budget.spent = spent.turns;
    loop.budget.tokens_spent = spent.tokens;
    origin.session.turns += adjustedTurns;
    writeState(root, runId, loop);
    return { ok: true, recorded: true, reason: 'recorded' };
  });
}

// The measured headless Codex maker returns its usage only after the child process exits. A legitimate child may
// finish the run before that exit, so the ordinary recordCost path is correctly terminal-fenced by then. This is
// the one narrow settlement path: it accepts only one measured Codex turn, for the exact acquired child lease,
// after a kernel-authored matching finish event. It is deliberately not exposed by the CLI and cannot mutate
// status, proof, lease, or any caller-selected field/event. An identical retry is a no-write idempotent success.
export function settleTerminalCodexMakerCost(root, runId, { usage, fence, handoffKey } = {}) {
  if (!isMeasuredOneTurnUsage(usage)) throw new Error('TERMINAL_ACCOUNTING_USAGE_INVALID');
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)
    || fence.intent !== 'accounting') {
    throw new Error('TERMINAL_ACCOUNTING_FENCE_REQUIRED');
  }
  return withReconciledMutationLock(root, runId, (_guard, { data: loop }) => {
    if (!isCanonicalHandoffKey(handoffKey, loop.autonomy?.continuation_policy)) {
      throw new Error('TERMINAL_ACCOUNTING_HANDOFF_INVALID');
    }
    const lease = loop.session_chain?.lease || {};
    if (lease.owner_run_id !== fence.owner) throw new Error('LEASE_FENCED: owner-mismatch');
    if (lease.generation !== fence.generation) throw new Error('LEASE_FENCED: generation-mismatch');
    if (loop.status !== 'completed' && loop.status !== 'stopped') throw new Error('RUN_NOT_TERMINAL: terminal maker settlement');
    if (sessionRuntime(loop) !== 'codex') throw new Error('RUNTIME_FENCED: terminal maker settlement requires codex');
    if (lease.state !== 'active' || lease.handoff_phase !== 'acquired') {
      throw new Error('TERMINAL_ACCOUNTING_CHILD_NOT_ACQUIRED');
    }
    const session = (loop.session_chain?.sessions || []).find(item => item.run_id === fence.owner);
    if (!session || typeof session.started_at !== 'string' || !Number.isFinite(Date.parse(session.started_at))
      || session.outcome === 'failed_launch') {
      throw new Error('TERMINAL_ACCOUNTING_SESSION_INVALID');
    }
    if (!Number.isSafeInteger(session.turns) || session.turns < 0) {
      throw new Error('TERMINAL_ACCOUNTING_SESSION_INVALID');
    }

    const v = verifyLog(root, runId);
    if (!v.ok) throw new Error(`LOG_TAMPERED: ${v.errors.join('; ')}`);
    const h = verifyHead(root, runId, loop.event_log_head);
    if (!h.ok) throw new Error(`LOG_TAMPERED: ${h.errors.join('; ')}`);
    const lines = readLines(root, runId);
    const finishes = lines.filter(event => event.type === 'finish');
    const finish = finishes[0];
    if (finishes.length !== 1 || finish.data?.status !== loop.status
      || typeof loop.termination?.finished_at !== 'string') {
      throw new Error('TERMINAL_ACCOUNTING_PROOF_MISSING');
    }
    const handoffs = lines.filter(event => event.type === 'handoff-emitted'
      && event.data?.child_run_id === fence.owner && event.data?.key === handoffKey);
    const finishFloor = lines.find(event => event.seq === finish.seq + 1
      && event.type === 'cost' && event.data?.auto_floor === true && event.data?.for === 'finish'
      && event.data?.owner === fence.owner && event.data?.generation === fence.generation);
    if (handoffs.length !== 1 || handoffs[0].seq >= finish.seq || !finishFloor) {
      throw new Error('TERMINAL_ACCOUNTING_PROOF_MISSING');
    }
    const accountingKey = contentHash(`${runId}|${fence.owner}|${fence.generation}|${handoffKey}|${finish.checksum}`);
    const exactReceipt = event => event.type === 'cost'
      && event.data?.terminal_process === 'codex-maker'
      && event.data?.source === 'terminal-maker-measured'
      && event.data?.accounting_key === accountingKey
      && event.data?.owner === fence.owner
      && event.data?.generation === fence.generation;
    const forbiddenAfterFinish = lines.some(event => event.seq > finish.seq
      && event !== finishFloor
      && !exactReceipt(event));
    if (forbiddenAfterFinish) throw new Error('TERMINAL_ACCOUNTING_PROOF_MISSING');

    const receipts = lines.filter(event => event.type === 'cost'
      && event.data?.terminal_process === 'codex-maker'
      && event.data?.owner === fence.owner
      && event.data?.generation === fence.generation);
    if (receipts.length > 1) throw new Error('TERMINAL_ACCOUNTING_DUPLICATE');
    const prior = receipts[0];
    if (prior) {
      const priorUsage = {
        num_turns: prior.data.reported_turns,
        input_tokens: prior.data.input_tokens,
        output_tokens: prior.data.output_tokens,
        tokens: prior.data.reported_tokens,
        ...(prior.data.cached_input_tokens !== undefined ? { cached_input_tokens: prior.data.cached_input_tokens } : {}),
        ...(prior.data.reasoning_output_tokens !== undefined ? { reasoning_output_tokens: prior.data.reasoning_output_tokens } : {}),
      };
      if (prior.data.accounting_key !== accountingKey || !sameMeasuredUsage(priorUsage, usage)) {
        throw new Error('TERMINAL_ACCOUNTING_MISMATCH');
      }
      return { ok: true, recorded: false, reason: 'already-recorded' };
    }

    const { tf, tk } = trailingFloor(lines, fence.owner, fence.generation);
    const adjTurns = Math.max(0, usage.num_turns - tf);
    const adjTokens = Math.max(0, usage.tokens - tk);
    appendEvent(root, runId, {
      type: 'cost',
      data: {
        turns: adjTurns,
        tokens: adjTokens,
        reported_turns: usage.num_turns,
        reported_tokens: usage.tokens,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        ...(usage.cached_input_tokens !== undefined ? { cached_input_tokens: usage.cached_input_tokens } : {}),
        ...(usage.reasoning_output_tokens !== undefined ? { reasoning_output_tokens: usage.reasoning_output_tokens } : {}),
        owner: fence.owner,
        generation: fence.generation,
        terminal_process: 'codex-maker',
        source: 'terminal-maker-measured',
        accounting_key: accountingKey,
      },
    });
    loop.event_log_head = lastLogHead(root, runId);
    const spent = recomputeSpent(root, runId);
    loop.budget.spent = spent.turns;
    loop.budget.tokens_spent = spent.tokens;
    session.turns += adjTurns;
    writeState(root, runId, loop);
    return { ok: true, recorded: true, reason: 'recorded' };
  });
}

// 저장된 budget vs event-log 재계산 비교 + log head 앵커 대조 — 불일치/손상/truncation 시 fail-stop
export function reconcileBudget(root, runId) {
  try {
    return withReconciledMutationLock(root, runId, (_guard, { data }) => {
      const v = verifyLog(root, runId);
      if (!v.ok) throw new Error(`BUDGET_TAMPERED: event-log integrity: ${v.errors.join('; ')}`);
      const h = verifyHead(root, runId, data.event_log_head);   // suffix truncation 탐지
      if (!h.ok) throw new Error(`BUDGET_TAMPERED: ${h.errors.join('; ')}`);
      const t = recomputeSpent(root, runId);
      if ((data.budget.spent || 0) !== t.turns || (data.budget.tokens_spent || 0) !== t.tokens) {
        throw new Error(`BUDGET_TAMPERED: stored ${data.budget.spent}/${data.budget.tokens_spent} != log ${t.turns}/${t.tokens}`);
      }
      return { turns: t.turns, tokens: t.tokens };
    });
  } catch (error) {
    if (String(error?.message || error).startsWith('LOG_TAMPERED:')) {
      throw new Error(`BUDGET_TAMPERED: ${error.message}`);
    }
    throw error;
  }
}
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Fixed host-only v0.5 owner-turn accounting. The branded pre-spawn receipt is
// required even on active runs. Terminal permission is limited to this exact
// measured turn following an anchored finish by its owner; leaseCheck stays strict.
export function settleGoalOwnerCost(root, runId, { receipt, fence } = {}) {
  const exact = inspectGoalOwnerReceipt(receipt, root, runId);
  if (!fence || fence.owner !== exact.owner || fence.generation !== exact.generation) throw new Error('LEASE_FENCED: owner turn receipt');
  return withReconciledMutationLock(root, runId, (_guard, { data: loop }) => {
    const lease = loop.session_chain?.lease;
    if (lease?.owner_run_id !== exact.owner || lease?.generation !== exact.generation) throw new Error('LEASE_FENCED: owner turn receipt');
    if (loop.schema_version !== '0.5.0' || sessionRuntime(loop) !== 'codex') throw new Error('OWNER_TURN_RUNTIME_INVALID');
    const session = loop.session_chain.sessions.find(item => item.run_id === exact.owner);
    if (!session || !Number.isSafeInteger(session.turns) || session.turns < 0) throw new Error('OWNER_TURN_SESSION_INVALID');
    if (loop.autonomy.session_model !== exact.profile.model || loop.autonomy.session_effort !== exact.profile.effort) throw new Error('OWNER_TURN_PROFILE_INVALID');
    const log = verifyLog(root, runId); const head = verifyHead(root, runId, loop.event_log_head);
    if (!log.ok || !head.ok) throw new Error('LOG_TAMPERED: owner turn settlement');
    const lines = readLines(root, runId);
    const anchor = lines.find(event => event.seq === exact.before_seq);
    if ((exact.before_seq > 0 && anchor?.checksum !== exact.before_checksum)
      || (exact.before_seq === 0 && exact.before_checksum !== null)) throw new Error('OWNER_TURN_ANCHOR_INVALID');
    const matches = lines.filter(event => event.type === 'cost' && event.data?.source === 'goal-owner-measured'
      && event.data?.owner_turn_id === exact.turn_id);
    if (matches.length > 1) throw new Error('OWNER_TURN_ACCOUNTING_DUPLICATE');
    const prior = matches[0];
    const window = lines.filter(event => event.seq > exact.before_seq && (!prior || event.seq < prior.seq));
    const terminal = ['completed', 'stopped'].includes(loop.status);
    let finishChecksum = null;
    if (terminal && (!prior || prior.data?.finish_checksum !== null)) {
      const finishes = lines.filter(event => event.type === 'finish'); const finish = finishes[0];
      const floor = finish && lines.find(event => event.seq === finish.seq + 1 && event.type === 'cost'
        && event.data?.auto_floor === true && event.data?.for === 'finish'
        && event.data?.owner === exact.owner && event.data?.generation === exact.generation);
      if (lease.state !== 'active' || finishes.length !== 1 || finish.seq <= exact.before_seq
        || finish.data?.status !== loop.status || !loop.termination?.finished_at || !floor
        || lines.some(event => event.seq > finish.seq && event !== floor && event !== prior)) throw new Error('OWNER_TURN_FINISH_PROOF_MISSING');
      finishChecksum = finish.checksum;
    } else if (!prior) {
      const checked = leaseCheck(loop, { ...fence, intent: 'accounting' });
      if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
    }
    const { tf, tk } = trailingFloor(window, exact.owner, exact.generation);
    const data = {
      turns: Math.max(0, exact.usage.num_turns - tf), tokens: Math.max(0, exact.usage.tokens - tk),
      reported_turns: exact.usage.num_turns, reported_tokens: exact.usage.tokens,
      input_tokens: exact.usage.input_tokens, output_tokens: exact.usage.output_tokens,
      ...(exact.usage.cached_input_tokens !== undefined ? { cached_input_tokens: exact.usage.cached_input_tokens } : {}),
      ...(exact.usage.reasoning_output_tokens !== undefined ? { reasoning_output_tokens: exact.usage.reasoning_output_tokens } : {}),
      owner: exact.owner, generation: exact.generation, source: 'goal-owner-measured',
      owner_turn_id: exact.turn_id, owner_receipt_id: exact.receipt_id,
      process_id: exact.process_id, thread_id: exact.thread_id, expected_thread_id: exact.expected_thread_id,
      output_sha256: exact.output_sha256, profile: exact.profile,
      before_seq: exact.before_seq, before_checksum: exact.before_checksum,
      finish_checksum: finishChecksum, exit_code: exact.exit_code, termination_confirmed: true,
    };
    if (prior) {
      if (JSON.stringify(prior.data) !== JSON.stringify(data)) throw new Error('OWNER_TURN_ACCOUNTING_MISMATCH');
      markGoalOwnerReceiptSettled(receipt);
      return { ok: true, recorded: false, reason: 'already-recorded' };
    }
    appendEvent(root, runId, { type: 'cost', data });
    loop.event_log_head = lastLogHead(root, runId);
    const spent = recomputeSpent(root, runId); loop.budget.spent = spent.turns; loop.budget.tokens_spent = spent.tokens;
    session.turns += data.turns;
    writeState(root, runId, loop);
    markGoalOwnerReceiptSettled(receipt);
    return { ok: true, recorded: true, reason: 'recorded' };
  });
}

// Pure recognition of the fixed writer's terminal bookkeeping event. Callers
// already hold a verified log+head snapshot. This grants no write authority.
export function isTerminalGoalOwnerCostEvent(event, loop, lines) {
  try {
    const d=event?.data, lease=loop?.session_chain?.lease;
    const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    const hash=value=>typeof value==='string' && /^[0-9a-f]{64}$/.test(value);
    if(event?.type!=='cost'||d?.source!=='goal-owner-measured'||loop?.schema_version!=='0.5.0'
      ||sessionRuntime(loop)!=='codex'||!['completed','stopped'].includes(loop.status)||lease?.state!=='active'
      ||!hasCanonicalEventData(d,['turns','tokens','reported_turns','reported_tokens','input_tokens','output_tokens',
        ...['cached_input_tokens','reasoning_output_tokens'].filter(key=>Object.hasOwn(d,key)),
        'owner','generation','source','owner_turn_id','owner_receipt_id','process_id','thread_id','expected_thread_id',
        'output_sha256','profile','before_seq','before_checksum','finish_checksum','exit_code','termination_confirmed'])
      ||d.owner!==lease.owner_run_id||d.generation!==lease.generation||!uuid(d.owner_turn_id)||!uuid(d.thread_id)
      ||(d.expected_thread_id!==null&&d.expected_thread_id!==d.thread_id)||!hash(d.owner_receipt_id)||!hash(d.output_sha256)
      ||!Number.isSafeInteger(d.process_id)||d.process_id<1||d.termination_confirmed!==true
      ||!(d.exit_code===null||Number.isInteger(d.exit_code))||!Number.isSafeInteger(d.before_seq)||d.before_seq<0
      ||d.profile?.model!==loop.autonomy?.session_model||d.profile?.effort!==loop.autonomy?.session_effort) return false;
    const usage={num_turns:d.reported_turns,input_tokens:d.input_tokens,output_tokens:d.output_tokens,tokens:d.reported_tokens,
      ...Object.fromEntries(['cached_input_tokens','reasoning_output_tokens'].filter(key=>Object.hasOwn(d,key)).map(key=>[key,d[key]]))};
    if(!isMeasuredOneTurnUsage(usage))return false;
    const finishes=lines.filter(e=>e.type==='finish'),finish=finishes[0];
    const floor=finish&&lines.find(e=>e.seq===finish.seq+1&&e.type==='cost'&&e.data?.auto_floor===true
      &&e.data?.for==='finish'&&e.data?.owner===d.owner&&e.data?.generation===d.generation);
    const anchor=lines.find(e=>e.seq===d.before_seq);
    if(!lines.includes(event)||finishes.length!==1||!floor||finish.seq<=d.before_seq||event.seq<=floor.seq
      ||finish.data?.status!==loop.status||!loop.termination?.finished_at||d.finish_checksum!==finish.checksum
      ||(d.before_seq===0?d.before_checksum!==null:anchor?.checksum!==d.before_checksum)
      ||lines.some(e=>e.seq>finish.seq&&e!==floor&&e!==event)
      ||lines.filter(e=>e.type==='cost'&&e.data?.owner_turn_id===d.owner_turn_id).length!==1)return false;
    const {tf,tk}=trailingFloor(lines.filter(e=>e.seq>d.before_seq&&e.seq<event.seq),d.owner,d.generation);
    if(d.turns!==Math.max(0,1-tf)||d.tokens!==Math.max(0,usage.tokens-tk))return false;
    const body={version:1,turn_id:d.owner_turn_id,root:loop.project.root,run_id:loop.run_id,owner:d.owner,generation:d.generation,
      profile:d.profile,expected_thread_id:d.expected_thread_id,before_seq:d.before_seq,before_checksum:d.before_checksum,
      thread_id:d.thread_id,process_id:d.process_id,output_sha256:d.output_sha256,usage,termination_confirmed:true,exit_code:d.exit_code};
    return contentHash(JSON.stringify(body))===d.owner_receipt_id;
  } catch {return false;}
}
