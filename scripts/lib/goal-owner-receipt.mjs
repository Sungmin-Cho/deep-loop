// Host-local capabilities, deliberately not reconstructible from JSON or a file.
// This protects a cooperative-but-fallible parent/child boundary, not hostile code
// executing inside this same trusted host process. Lost bindings fail unavailable.
import { randomUUID } from 'node:crypto';
import { contentHash } from './envelope.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import { withReconciledMutationLock } from './state.mjs';
import { leaseCheck } from './lease.mjs';
import { readLines, verifyHead, verifyLog } from './integrity.mjs';
import { isMeasuredOneTurnUsage } from './budget.mjs';
import { sessionRuntime } from './runtime.mjs';

const bindings = new WeakMap();
const receipts = new WeakMap();
const outstanding = new Map();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function profileCopy(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)
    || typeof profile.model !== 'string' || !profile.model.trim()
    || typeof profile.effort !== 'string' || !profile.effort.trim()) throw new Error('OWNER_TURN_PROFILE_INVALID');
  const bytes = JSON.stringify(profile);
  if (bytes.length > 16_384) throw new Error('OWNER_TURN_PROFILE_INVALID');
  return JSON.parse(bytes);
}
export function issueGoalOwnerTurn(root, runId, { fence, profile, threadId = null } = {}) {
  const canonicalRoot = canonicalProjectRoot(root);
  const copiedProfile = profileCopy(profile);
  if (threadId !== null && !UUID.test(threadId)) throw new Error('OWNER_TURN_THREAD_INVALID');
  return withReconciledMutationLock(canonicalRoot, runId, (_guard, { data: loop }) => {
    const checked = leaseCheck(loop, { ...fence, intent: 'business' }); if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
    if (loop.status !== 'running' || loop.session_chain?.lease?.state !== 'active') throw new Error('OWNER_TURN_RUN_NOT_ACTIVE');
    if (loop.schema_version !== '0.5.0' || sessionRuntime(loop) !== 'codex') {
      throw new Error('OWNER_TURN_RUNTIME_INVALID');
    }
    if (loop.autonomy?.session_model !== copiedProfile.model || loop.autonomy?.session_effort !== copiedProfile.effort) throw new Error('OWNER_TURN_PROFILE_INVALID');
    const key = `${canonicalRoot}\0${runId}`;
    if (outstanding.has(key)) throw new Error('OWNER_TURN_UNSETTLED');
    const log = verifyLog(canonicalRoot, runId); const head = verifyHead(canonicalRoot, runId, loop.event_log_head);
    if (!log.ok || !head.ok) throw new Error('LOG_TAMPERED: owner turn binding');
    const lines = readLines(canonicalRoot, runId); const last = lines.at(-1);
    const value = freeze({ version: 1, turn_id: randomUUID(), root: canonicalRoot, run_id: runId,
      owner: fence.owner, generation: fence.generation, profile: copiedProfile,
      expected_thread_id: threadId, before_seq: last?.seq ?? 0, before_checksum: last?.checksum ?? null });
    bindings.set(value, { key, receipt: null, settled: false }); outstanding.set(key, value);
    return value;
  });
}

export function bindGoalOwnerResult(binding, result = {}) {
  const held = bindings.get(binding); if (!held) throw new Error('OWNER_TURN_BINDING_INVALID');
  if (JSON.stringify(result.profile) !== JSON.stringify(binding.profile)
    || !UUID.test(result.threadId ?? '')
    || (binding.expected_thread_id !== null && binding.expected_thread_id !== result.threadId)
    || !Number.isSafeInteger(result.processId) || result.processId <= 0
    || !HASH.test(result.outputSha256 ?? '')
    || result.terminationConfirmed !== true
    || !(result.exitCode === null || Number.isInteger(result.exitCode))
    || !isMeasuredOneTurnUsage(result.usage)) throw new Error('OWNER_TURN_RESULT_INVALID');
  const body = { ...binding, thread_id: result.threadId, process_id: result.processId,
    output_sha256: result.outputSha256, usage: Object.fromEntries(
      ['num_turns','input_tokens','output_tokens','tokens','cached_input_tokens','reasoning_output_tokens']
        .filter(key=>Object.hasOwn(result.usage,key)).map(key=>[key,result.usage[key]])),
    termination_confirmed: true, exit_code: result.exitCode };
  const receipt = freeze({ ...body, receipt_id: contentHash(JSON.stringify(body)) });
  if (held.receipt) {
    if (held.receipt.receipt_id !== receipt.receipt_id) throw new Error('OWNER_TURN_RESULT_MISMATCH');
    return held.receipt;
  }
  held.receipt = receipt; receipts.set(receipt, { binding, held });
  return receipt;
}

// Only the fixed budget writer consumes this capability. It cannot authorize an
// arbitrary mutation and never treats process exit or accounting as goal proof.
export function inspectGoalOwnerReceipt(receipt, root, runId) {
  if (!receipts.has(receipt) || receipt.root !== canonicalProjectRoot(root) || receipt.run_id !== runId) throw new Error('OWNER_TURN_RECEIPT_INVALID');
  return receipt;
}
export function markGoalOwnerReceiptSettled(receipt) {
  const entry = receipts.get(receipt); if (!entry) throw new Error('OWNER_TURN_RECEIPT_INVALID');
  entry.held.settled = true;
  if (outstanding.get(entry.held.key) === entry.binding) outstanding.delete(entry.held.key);
}
