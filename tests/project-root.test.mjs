import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { contentHash, unwrap, wrap } from '../scripts/lib/envelope.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import {
  readState,
  readStateForRootRecovery,
  runDir,
  withLock,
  writeState,
} from '../scripts/lib/state.mjs';
import {
  assertProjectRootBinding,
  canonicalProjectRoot,
  classifyProjectRootBinding,
  projectRootDigest,
} from '../scripts/lib/project-root.mjs';
import { createDirectoryJunction } from './helpers/fs-fixtures.mjs';
import { validate } from '../scripts/lib/schema.mjs';
import {
  appendAnchored,
  captureVerifiedRootRecoverySnapshot,
  verifyHead,
  verifyLog,
} from '../scripts/lib/integrity.mjs';
import { captureStableFileIdentity, matchingStableFileIdentity } from '../scripts/lib/fs-safe.mjs';
import {
  codexCheckerClaimHash,
  extendBudget,
  inventoryRelocatedProcessReceipts,
  makeCodexProcessReceipt,
  recoveryReservationKind,
  settleCodexProcessCost,
} from '../scripts/lib/budget.mjs';
import { resetBreaker } from '../scripts/lib/breaker.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { acquireLease } from '../scripts/lib/lease.mjs';
import { finishRun } from '../scripts/lib/finish.mjs';
import { migrateAuthenticLegacyTransport } from './helpers/legacy-transport.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO_ROOT, 'scripts', 'deep-loop.mjs');
const FIXED_NOW = new Date('2026-07-11T00:00:00.000Z');
const recoveryReaderReferencePattern = /\breadStateForRootRecovery\b/;
const portableRelative = (from, to) => relative(from, to).split(sep).join('/');
const genericRootBypassPattern = /\b(?:(?:skip|bypass|disable|ignore)(?:Project)?Root(?:Check|Binding)?|(?:skip|bypass|disable|ignore)[_-](?:project[_-])?root(?:[_-](?:check|binding))?)\b/i;
const recoveryApiPromise = import('../scripts/lib/project-root-recovery.mjs').catch(() => ({}));

function freshRoot(prefix = 'dl-root-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function init(root, runtime = 'claude') {
  return initRun(root, { runtime, goal: 'bind root', now: FIXED_NOW });
}

function copyDurableState(sourceRoot, candidateRoot) {
  cpSync(join(sourceRoot, '.deep-loop'), join(candidateRoot, '.deep-loop'), { recursive: true });
}

async function recoveryApi() {
  const api = await recoveryApiPromise;
  assert.equal(typeof api.diagnoseProjectRoot, 'function', 'diagnoseProjectRoot must be exported');
  assert.equal(typeof api.rebindProjectRoot, 'function', 'rebindProjectRoot must be exported');
  assert.equal(typeof api.recoverRelocatedRoot, 'function', 'recoverRelocatedRoot must be exported');
  assert.equal(typeof api.acquireRootRecovery, 'function', 'acquireRootRecovery must be exported');
  assert.equal(typeof api.diagnoseVerifiedProjectRoot, 'function', 'diagnoseVerifiedProjectRoot must be exported');
  return api;
}

function invoke(args, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

function eventLines(root, runId) {
  const path = join(runDir(root, runId), 'event-log.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
}

function relocationOptions(moved, overrides = {}) {
  const current = readStateForRootRecovery(moved.candidateRoot, moved.runId).data;
  return {
    actor: 'human',
    confirm: true,
    expectedStoredRootDigest: projectRootDigest(moved.storedRoot),
    expectedBindingGeneration: current.project.binding_generation,
    fence: {
      owner: current.session_chain.lease.owner_run_id,
      generation: current.session_chain.lease.generation,
    },
    now: FIXED_NOW.getTime(),
    ...overrides,
  };
}

function historicalCursor(owner, runtime, workstreamId = 'ws-history') {
  return {
    checkpoint_key: 'a'.repeat(64), context_sha256: 'b'.repeat(64),
    pre_restore_loop_hash: 'c'.repeat(64), owner_run_id: owner, generation: 1,
    runtime, workstream_id: workstreamId, episode_id: 'ep-history', baseline_turns: 7,
    restored_at: '2026-07-11T00:00:00.000Z', cycle: 1,
    restore_event: { seq: 1, checksum: 'd'.repeat(64) },
    admission: { kind: 'human-attested', source: 'direct-human-skill', receipt_trigger: null },
    provider_evidence: { recorded: false, supplied: false, matched: false },
  };
}

function seedRelocationTopology(topology, runtime = 'claude', prefix = 'dl-root-topology-') {
  const parent = freshRoot(prefix);
  const originalRoot = join(parent, `old root 'quoted' ${runtime}`);
  const candidateRoot = join(parent, `new root 'quoted' ${runtime}`);
  mkdirSync(originalRoot);
  const { runId } = init(originalRoot, runtime);
  let affinityWorkstreamId = null;
  if (topology.includes('affinity')) {
    ({ id: affinityWorkstreamId } = newWorkstream(originalRoot, runId, {
      title: 'relocated affinity',
      branch: 'feature/relocated-affinity',
      worktree: '.worktrees/relocated-affinity',
      fence: { owner: runId, generation: 1, intent: 'business' },
    }));
  }
  const { data } = readState(originalRoot, runId);
  data.budget.max_wallclock_sec = 10 * 365 * 24 * 60 * 60;
  const lease = data.session_chain.lease;
  const rootDigest = projectRootDigest(data.project.root);
  const childId = `CHILD-${topology.toUpperCase()}`;
  const child = {
    run_id: childId,
    started_at: topology === 'acquired-unbound' ? '2026-07-11T00:00:01.000Z' : null,
    ended_at: null,
    turns: 0,
    outcome: null,
    superseded_by: null,
    handoff_rel: `handoffs/${childId}-next-session.md`,
    scope: {
      kind: 'workstream',
      workstream_id: affinityWorkstreamId,
      bound_at_seq: topology.includes('affinity') ? 1 : null,
      terminal_event: null,
      closed_at: null,
      superseded_at: null,
    },
  };
  if (topology === 'terminal') {
    data.status = 'stopped';
    lease.state = 'released';
  } else if (topology === 'open-affinity') {
    data.workstreams.find(item => item.id === affinityWorkstreamId).status = 'in_progress';
    data.active_workstreams = [affinityWorkstreamId];
    data.session_chain.sessions[0].scope.workstream_id = affinityWorkstreamId;
    data.session_chain.sessions[0].scope.bound_at_seq = 1;
  } else if (topology !== 'quiescent') {
    lease.handoff_phase = topology === 'acquired-unbound'
      ? 'acquired'
      : topology.replace('-recovery', '') === 'affinity' || topology.replace('-recovery', '') === 'boundary'
        ? 'reserved'
        : topology;
    lease.handoff_child_run_id = childId;
    lease.handoff_idempotency_key = 'a'.repeat(64);
    lease.handoff_trigger = topology.includes('affinity') ? 'affinity-recovery' : 'workstream-terminal';
    if (topology !== 'reserved') {
      data.session_chain.sessions.push(child);
      data.session_chain.sessions[0].superseded_by = childId;
      data.session_chain.sessions[0].scope.superseded_at = '2026-07-11T00:00:01.000Z';
    }
    if (topology === 'emitted' || topology === 'spawned') {
      lease.state = 'releasing';
      lease.takeover_kind = null;
    } else if (topology === 'acquired-unbound') {
      lease.owner_run_id = childId;
      lease.generation = 2;
      lease.state = 'active';
      lease.handoff_idempotency_key = null;
      lease.handoff_child_run_id = null;
      lease.handoff_trigger = null;
    } else if (topology === 'affinity-recovery' || topology === 'boundary-recovery') {
      lease.state = 'releasing';
      lease.takeover_kind = topology === 'affinity-recovery'
        ? 'affinity-supersession'
        : 'boundary-recovery';
      const pending = data.session_chain.sessions.find(session => session.run_id === childId);
      if (pending) {
        pending.recovered_from = runId;
        pending.recovery_kind = topology === 'affinity-recovery'
          ? 'affinity-supersession'
          : 'boundary-recovery';
        pending.recovery_discriminator = 'f'.repeat(64);
        pending.recovery_rel = `recoveries/${topology}/${childId}.json`;
        pending.recovery_sha256 = 'b'.repeat(64);
        pending.recovery_project_binding_generation = data.project.binding_generation;
        pending.recovery_project_root_digest = rootDigest;
      }
    }
  }
  writeState(originalRoot, runId, data);
  const storedRoot = data.project.root;
  renameSync(originalRoot, candidateRoot);
  return { originalRoot, candidateRoot, runId, storedRoot, childId, topology, runtime };
}

function movedRun(prefix = 'dl-root-relocated-') {
  const parent = freshRoot(prefix);
  const originalRoot = join(parent, 'original');
  const candidateRoot = join(parent, 'candidate');
  mkdirSync(originalRoot);
  const { runId } = init(originalRoot);
  const storedRoot = readState(originalRoot, runId).data.project.root;
  renameSync(originalRoot, candidateRoot);
  return { originalRoot, candidateRoot, runId, storedRoot };
}

function movedRunWithProcessReceipt({
  malformed = false,
  conflicting = false,
  unverifiable = false,
  incomplete = false,
  wrongRoot = false,
  unmeasurable = false,
  usage = { num_turns: 1, input_tokens: 2, output_tokens: 3, tokens: 5 },
  existingCostMutation = null,
  terminal = false,
  autoFloors = [],
} = {}) {
  const parent = freshRoot('dl-root-accounting-');
  const originalRoot = join(parent, 'old root');
  const candidateRoot = join(parent, 'new root');
  mkdirSync(originalRoot);
  const { runId } = init(originalRoot, 'codex');
  migrateAuthenticLegacyTransport(originalRoot, runId);
  const handoff = emitHandoff(originalRoot, runId, {
    trigger: 'project-root-accounting',
    headless: true,
    resumePolicy: 'headless',
    expect: { owner: runId, generation: 1 },
    now: FIXED_NOW.getTime() + 1_000,
  });
  assert.equal(handoff.ok, true);
  const context = {
    parent_owner: runId,
    parent_generation: 1,
    child_run_id: handoff.childRunId,
    child_generation: 2,
    handoff_key: handoff.key,
    handoff_rel: handoff.handoffRel,
  };
  let receipt = makeCodexProcessReceipt({
    root: originalRoot,
    runId,
    processKind: 'maker',
    context,
    usage,
  });
  if (unverifiable) receipt = rehashProcessReceipt({
    ...receipt,
    context: {
      ...receipt.context,
      parent_generation: 9,
      child_generation: 10,
    },
  });
  if (wrongRoot) receipt = rehashProcessReceipt({
    ...receipt,
    project_root_digest: '0'.repeat(64),
  });
  if (unmeasurable) receipt = rehashProcessReceipt({
    ...receipt,
    usage: { num_turns: 0, input_tokens: 2, output_tokens: 3, tokens: 5 },
  });
  if (incomplete) {
    receipt = { ...receipt };
    delete receipt.usage;
    receipt = rehashProcessReceipt(receipt);
  }
  if (conflicting) {
    appendAnchored(originalRoot, runId, {
      type: 'cost',
      data: {
        turns: 1,
        tokens: 1,
        owner: runId,
        generation: 1,
        source: 'codex-maker-measured',
        process_receipt_id: 'f'.repeat(64),
        process_kind: 'maker',
        process_context: context,
      },
      now: FIXED_NOW.getTime(),
    }, (loop, spent) => {
      loop.budget.spent = spent.turns;
      loop.budget.tokens_spent = spent.tokens;
      loop.session_chain.sessions[0].turns += 1;
    });
  }
  const receipts = join(runDir(originalRoot, runId), 'preflight', 'process-receipts');
  mkdirSync(receipts, { recursive: true });
  writeFileSync(
    join(receipts, expectedProcessReceiptName(receipt)),
    malformed ? JSON.stringify({ ...receipt, receipt_id: '0'.repeat(64) }) : JSON.stringify(receipt),
  );
  for (const [index, floor] of autoFloors.entries()) {
    appendAnchored(originalRoot, runId, {
      type: 'cost',
      data: {
        turns: floor.turns,
        tokens: floor.tokens,
        owner: runId,
        generation: 1,
        source: `round3-floor-${index}`,
        auto_floor: true,
      },
      now: FIXED_NOW.getTime() + 2_000 + index,
    }, (loop, spent) => {
      loop.budget.spent = spent.turns;
      loop.budget.tokens_spent = spent.tokens;
      loop.session_chain.sessions[0].turns += floor.turns;
    });
  }
  let settlementFence = { owner: runId, generation: 1, intent: 'accounting' };
  if (terminal) {
    assert.equal(acquireLease(originalRoot, runId, {
      owner: handoff.childRunId,
      expectGeneration: 1,
      runtime: 'codex',
      now: FIXED_NOW.getTime() + 10_000,
    }).ok, true);
    finishRun(originalRoot, runId, {
      status: 'stopped',
      confirm: true,
      proof: { human_reason: 'relocated terminal accounting fixture' },
      fence: {
        owner: handoff.childRunId,
        generation: 2,
        intent: 'business',
      },
      now: FIXED_NOW.getTime() + 20_000,
    });
    settlementFence = {
      owner: handoff.childRunId,
      generation: 2,
      intent: 'accounting',
    };
  }
  if (existingCostMutation !== null) {
    assert.deepEqual(settleCodexProcessCost(originalRoot, runId, {
      receipt,
      fence: settlementFence,
    }), { ok: true, recorded: true, reason: 'recorded' });
    rewriteExistingCostEvent(originalRoot, runId, receipt.receipt_id, existingCostMutation);
  }
  const storedRoot = readState(originalRoot, runId).data.project.root;
  renameSync(originalRoot, candidateRoot);
  return {
    originalRoot,
    candidateRoot,
    runId,
    storedRoot,
    receipt,
    receipts,
    handoff,
  };
}

function rewriteExistingCostEvent(root, runId, receiptId, mutate) {
  const data = readState(root, runId).data;
  const path = join(runDir(root, runId), 'event-log.jsonl');
  const lines = eventLines(root, runId);
  const event = lines.find(line =>
    line.type === 'cost' && line.data?.process_receipt_id === receiptId);
  assert.ok(event, 'settled process receipt cost event must exist');
  mutate(event.data);
  let previous = 'GENESIS';
  for (const line of lines) {
    line.checksum = contentHash(
      `${line.seq}|${line.ts}|${line.type}|${JSON.stringify(line.data)}|${previous}`,
    );
    previous = line.checksum;
  }
  writeFileSync(path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  data.event_log_head = { seq: lines.at(-1).seq, checksum: lines.at(-1).checksum };
  data.budget.spent = lines
    .filter(line => line.type === 'cost')
    .reduce((sum, line) => sum + line.data.turns, 0);
  data.budget.tokens_spent = lines
    .filter(line => line.type === 'cost')
    .reduce((sum, line) => sum + line.data.tokens, 0);
  writeState(root, runId, data);
}

function processReceiptDescriptorId(receipt) {
  return contentHash(JSON.stringify({
    process_kind: receipt.process_kind,
    context: receipt.context,
  }));
}

function expectedProcessReceiptName(receipt) {
  return `${processReceiptDescriptorId(receipt)}-${receipt.process_kind}.json`;
}

function rehashProcessReceipt(receipt) {
  const payload = { ...receipt };
  delete payload.receipt_id;
  return { ...payload, receipt_id: contentHash(JSON.stringify(payload)) };
}

function rootReceiptPath(moved, operationId) {
  return join(
    runDir(moved.candidateRoot, moved.runId),
    'recoveries',
    'root-operations',
    `${operationId}.json`,
  );
}

function rootReceiptPayload(document) {
  return document?.payload ?? document;
}

function rewriteRootReceipt(path, document, mutate) {
  const payload = structuredClone(rootReceiptPayload(document));
  mutate(payload);
  if (!document?.envelope) {
    writeFileSync(path, JSON.stringify(payload));
    return;
  }
  writeFileSync(path, JSON.stringify(wrap({
    producer: document.envelope.producer,
    artifact_kind: document.envelope.artifact_kind,
    schema: document.envelope.schema,
    run_id: document.envelope.run_id,
    parent_run_id: document.envelope.parent_run_id,
    payload,
    now: document.envelope.generated_at,
    provenance: document.envelope.provenance,
    git: document.envelope.git,
  })));
}

function splitInvocation(command) {
  return command.match(/"(?:\\.|[^"])*"|[^\s]+/g).map(token =>
    token.startsWith('"') ? JSON.parse(token) : token);
}

function invokeRootAcquire(command, cwd = REPO_ROOT) {
  const parts = splitInvocation(command);
  assert.deepEqual(parts.slice(0, 3), ['root', 'recovery', 'acquire']);
  return invoke(parts, cwd);
}

function exactRootRecoveryCommand(root, runId) {
  const resume = invoke([
    'resume-command',
    '--project-root', root,
    '--run-id', runId,
  ], freshRoot('dl-root-r2-resume-cwd-'));
  assert.equal(resume.status, 0, resume.stderr);
  return resume.stdout.split('\n')[0];
}

function rootReservationEvidence(root, runId) {
  const state = readState(root, runId).data;
  const lease = state.session_chain.lease;
  const child = state.session_chain.sessions.find(
    session => session.run_id === lease.handoff_child_run_id,
  );
  assert.ok(child);
  return {
    project: structuredClone(state.project),
    lease: structuredClone(lease),
    child: structuredClone(child),
    rebound: structuredClone(eventLines(root, runId)
      .filter(event => event.type === 'project-root-rebound')),
    capsule: readFileSync(join(runDir(root, runId), child.recovery_rel), 'utf8'),
    receipt: readFileSync(join(
      runDir(root, runId),
      'recoveries',
      'root-operations',
      `${child.root_recovery_operation_id}.json`,
    ), 'utf8'),
  };
}

function runCliAsync(args, cwd = REPO_ROOT) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolvePromise({ status, stdout, stderr }));
  });
}

// Contention reaches a caller in two shapes, and a predicate that knows only one of
// them silently stops retrying: verbs that throw print the exact `LOCK_BUSY` line on
// stderr, while `root diagnose` returns a bounded descriptor on stdout with an empty
// stderr. Recognising only the stderr form is what let a busy lock read as a hard
// failure here.
function lockBusyResult(result) {
  if (result?.status !== 1) return false;
  const stderr = String(result?.stderr || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (/^\[deep-loop:error\] LOCK_BUSY(?::[^\r\n]*)?$/.test(stderr)) return true;
  if (stderr.length > 0) return false;
  let descriptor;
  try { descriptor = JSON.parse(String(result?.stdout || '')); } catch { return false; }
  return descriptor?.ok === false && descriptor.kind === 'lock-busy' && descriptor.retryable === true;
}

function retryableVerifiedReadResult(result) {
  if (result?.status !== 1 || String(result?.stderr || '').trim() !== '') return false;
  let descriptor;
  try { descriptor = JSON.parse(String(result?.stdout || '')); } catch { return false; }
  return descriptor?.ok === false
    && descriptor.kind === 'verified-read-race'
    && descriptor.reason === 'identity-drift'
    && descriptor.retryable === true;
}

test('lockBusyResult recognizes only the exact CLI LOCK_BUSY diagnostic', () => {
  assert.equal(lockBusyResult({
    status: 1,
    stderr: '\u001b[31m[deep-loop:error]\u001b[0m LOCK_BUSY: run-a\n',
  }), true);
  assert.equal(lockBusyResult({
    status: 1,
    stderr: '[deep-loop:error] LOCK_BUSY: run-a\n',
  }), true);
  assert.equal(lockBusyResult({
    status: 1,
    stderr: '[deep-loop:error] OTHER_ERROR: run-a\n',
  }), false);
  assert.equal(lockBusyResult({
    status: 2,
    stderr: '[deep-loop:error] LOCK_BUSY: run-a\n',
  }), false);
  assert.equal(lockBusyResult({
    status: 1,
    stderr: 'prefix [deep-loop:error] LOCK_BUSY: run-a\n',
  }), false);
  assert.equal(lockBusyResult({
    status: 1,
    stderr: '[deep-loop:error] LOCK_BUSY: run-a\n[deep-loop:error] STATE_TAMPERED\n',
  }), false);
});

test('lockBusyResult recognizes the stdout contention descriptor and nothing adjacent to it', () => {
  const descriptor = {
    ok: false, kind: 'lock-busy', retryable: true, phase: 'run-snapshot', partial_discarded: true,
  };
  assert.equal(lockBusyResult({ status: 1, stderr: '', stdout: JSON.stringify(descriptor) }), true);
  assert.equal(lockBusyResult({ status: 1, stderr: '  \n', stdout: JSON.stringify(descriptor) }), true);

  // An integrity discard is the signal this predicate must never swallow: retrying it
  // would loop on a genuinely damaged run instead of surfacing it.
  assert.equal(lockBusyResult({
    status: 1,
    stderr: '',
    stdout: JSON.stringify({ ok: false, kind: 'integrity-invalid', phase: 'run-snapshot' }),
  }), false);
  assert.equal(lockBusyResult({
    status: 1,
    stderr: '',
    stdout: JSON.stringify({ ...descriptor, retryable: false }),
  }), false);
  assert.equal(lockBusyResult({
    status: 1,
    stderr: '',
    stdout: JSON.stringify({ ...descriptor, ok: true }),
  }), false);
  assert.equal(lockBusyResult({ status: 1, stderr: '', stdout: 'not json' }), false);
  assert.equal(lockBusyResult({ status: 0, stderr: '', stdout: JSON.stringify(descriptor) }), false);
  // A descriptor carried alongside a real diagnostic is not a clean transient.
  assert.equal(lockBusyResult({
    status: 1,
    stderr: '[deep-loop:error] STATE_TAMPERED\n',
    stdout: JSON.stringify(descriptor),
  }), false);
});

// A contended `root diagnose` must be distinguishable from a corrupt one. The kernel
// reaches the state through a read lock, so a busy lock is an ordinary transient — it
// says nothing about whether the durable bytes verify. Reporting it as
// `integrity-invalid` tells an operator their state may be damaged when it is merely
// in use, and leaves an automated caller with no signal that retrying is the answer.
test('a contended root diagnose reports retryable contention, not an integrity failure', () => {
  const root = freshRoot('dl-root-lock-busy-');
  const { runId } = init(root, 'claude');
  const args = ['root', 'diagnose', '--candidate-project-root', root, '--run-id', runId];
  // Hold the run lock from this process for the whole child lifetime: the holder is
  // alive, so the child cannot reclaim it and exhausts its retries into LOCK_BUSY.
  const contended = withLock(root, runId, () => spawnSync(
    process.execPath,
    [CLI, ...args],
    { cwd: root, encoding: 'utf8' },
  ));

  assert.equal(contended.status, 1);
  assert.deepEqual(JSON.parse(contended.stdout), {
    ok: false,
    kind: 'lock-busy',
    retryable: true,
    phase: 'run-snapshot',
    partial_discarded: true,
  });
});

async function retryLockBusyDiagnose(result, args, cwd, runner = runCliAsync) {
  let current = result;
  // Four concurrent diagnoses on a loaded Windows runner can each hold the lock
  // for longer than 500ms. 100ms × 5 then reports lock-busy for every child
  // even though the bytes are fine. Back off up to 1s and keep trying while
  // the descriptor stays retryable.
  for (let attempt = 0; attempt < 12 && (lockBusyResult(current) || retryableVerifiedReadResult(current)); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1_000)));
    current = await runner(args, cwd);
  }
  return current;
}

test('retryLockBusyDiagnose retries verified-read races but not tamper descriptors', async () => {
  const race = {
    status: 1,
    stderr: '',
    stdout: JSON.stringify({
      ok: false,
      kind: 'verified-read-race',
      reason: 'identity-drift',
      retryable: true,
      operation_id: null,
      phase: 'verified-vector',
    }),
  };
  let attempts = 0;
  const recovered = await retryLockBusyDiagnose(race, [], freshRoot('dl-root-race-retry-'), async () => {
    attempts += 1;
    return { status: 0, stderr: '', stdout: '{}' };
  });
  assert.equal(attempts, 1);
  assert.equal(retryableVerifiedReadResult(race), true);
  const tampered = {
    status: 1,
    stderr: '',
    stdout: JSON.stringify({ ok: false, kind: 'integrity-invalid', phase: 'verified-vector' }),
  };
  const notRetried = await retryLockBusyDiagnose(tampered, [], freshRoot('dl-root-tamper-no-retry-'), async () => {
    attempts += 1;
    return { status: 0, stderr: '', stdout: '{}' };
  });
  assert.equal(retryableVerifiedReadResult(tampered), false);
  assert.equal(notRetried.status, 1);
  assert.equal(attempts, 1);
  assert.equal(recovered.status, 0);
});

function durableSnapshot(root, runId) {
  const dir = runDir(root, runId);
  const eventPath = join(dir, 'event-log.jsonl');
  return {
    loop: readFileSync(join(dir, 'loop.json'), 'utf8'),
    hash: readFileSync(join(dir, '.loop.hash'), 'utf8'),
    event: existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : null,
  };
}

function writeRecoveryFixture(root, runId, data) {
  const dir = runDir(root, runId);
  data.updated_at = FIXED_NOW.toISOString();
  const raw = JSON.stringify(data, null, 2);
  writeFileSync(join(dir, 'loop.json'), raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
}

function relocatedPendingPublication(barrier, suffix) {
  const parent = freshRoot(`dl-root-wal-${suffix}-`);
  const originalRoot = join(parent, 'original');
  const candidateRoot = join(parent, 'candidate');
  mkdirSync(originalRoot);
  const { runId } = init(originalRoot);
  const storedRoot = readState(originalRoot, runId).data.project.root;
  assert.throws(() => appendAnchored(
    originalRoot,
    runId,
    { type: 'relocated-candidate', data: { barrier }, now: '2026-07-11T00:01:00.000Z' },
    loop => { loop.goal = `candidate:${barrier}`; },
    undefined,
    {
      publication: {
        kind: 'relocated-reader-barrier',
        operationId: `root-${suffix}-${barrier.replaceAll(':', '-')}`,
        artifacts: [],
        topology: { barrier },
        faultAt(label) { if (label === barrier) throw new Error(`fault:${barrier}`); },
      },
    },
  ), /TRANSACTION_PENDING/);
  renameSync(originalRoot, candidateRoot);
  return { candidateRoot, runId, storedRoot };
}

test('candidate-root diagnosis and rebind replay relocated prepared publications at every state barrier', async () => {
  const { diagnoseProjectRoot, rebindProjectRoot } = await recoveryApi();
  const barriers = ['event:0:append', 'state:loop:rename', 'state:hash:rename', 'committed:rename'];
  for (const barrier of barriers) {
    const diagnosed = relocatedPendingPublication(barrier, 'diagnose');
    assert.equal(diagnoseProjectRoot(diagnosed.candidateRoot, diagnosed.runId).action, 'rebind');
    assert.equal(readStateForRootRecovery(diagnosed.candidateRoot, diagnosed.runId).data.goal, `candidate:${barrier}`);

    const rebound = relocatedPendingPublication(barrier, 'rebind');
    rebindProjectRoot(rebound.candidateRoot, rebound.runId, {
      actor: 'human',
      confirm: true,
      expectedStoredRootDigest: projectRootDigest(rebound.storedRoot),
      expectedBindingGeneration: 1,
      fence: { owner: rebound.runId, generation: 1 },
      now: FIXED_NOW.getTime(),
    });
    assert.equal(readState(rebound.candidateRoot, rebound.runId).data.goal, `candidate:${barrier}`);
  }
});

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith('.mjs')) out.push(path);
  }
  return out;
}

test('init through a symlink stores the canonical project root', () => {
  const parent = freshRoot('dl-root-link-');
  const realRoot = join(parent, 'real');
  const aliasRoot = join(parent, 'alias');
  mkdirSync(realRoot);
  createDirectoryJunction(realRoot, aliasRoot);

  const { runId, loop } = init(aliasRoot);
  assert.equal(loop.project.root, canonicalProjectRoot(realRoot));
  assert.equal(readState(aliasRoot, runId).data.project.root, canonicalProjectRoot(realRoot));
});

test('pre-change symlink aliases remain readable when both roots resolve to one identity', () => {
  const parent = freshRoot('dl-root-legacy-link-');
  const realRoot = join(parent, 'real');
  const aliasRoot = join(parent, 'legacy-alias');
  mkdirSync(realRoot);
  createDirectoryJunction(realRoot, aliasRoot);

  const { runId } = init(realRoot);
  const { data } = readState(realRoot, runId);
  data.project.root = aliasRoot; // simulate a pre-canonicalization loop.json
  writeState(realRoot, runId, data);

  assert.equal(readState(realRoot, runId).data.project.root, aliasRoot);
  assert.equal(readState(aliasRoot, runId).data.project.root, aliasRoot);
});

test('a copied run is fenced while the original stored root resolves', () => {
  const originalRoot = freshRoot('dl-root-original-');
  const candidateRoot = freshRoot('dl-root-copy-');
  const { runId } = init(originalRoot);
  copyDurableState(originalRoot, candidateRoot);

  assert.throws(() => readState(candidateRoot, runId), /PROJECT_ROOT_FENCED/);
  assert.equal(readStateForRootRecovery(candidateRoot, runId).data.project.root, canonicalProjectRoot(originalRoot));
});

test('stopping the original run never authorizes a copied candidate root', () => {
  const originalRoot = freshRoot('dl-root-stopped-original-');
  const candidateRoot = freshRoot('dl-root-stopped-copy-');
  const { runId } = init(originalRoot);
  const { data } = readState(originalRoot, runId);
  data.status = 'stopped';
  writeState(originalRoot, runId, data);
  copyDurableState(originalRoot, candidateRoot);

  assert.throws(() => readState(candidateRoot, runId), /PROJECT_ROOT_FENCED/);
  assert.equal(readStateForRootRecovery(candidateRoot, runId).data.status, 'stopped');
});

test('a moved run with an unresolvable stored root requires recovery', () => {
  const parent = freshRoot('dl-root-moved-parent-');
  const originalRoot = join(parent, 'original');
  const candidateRoot = join(parent, 'moved');
  mkdirSync(originalRoot);
  const { runId } = init(originalRoot);
  const storedRoot = readState(originalRoot, runId).data.project.root;
  renameSync(originalRoot, candidateRoot);

  assert.throws(() => readState(candidateRoot, runId), /PROJECT_ROOT_UNRESOLVABLE/);
  assert.equal(readStateForRootRecovery(candidateRoot, runId).data.project.root, storedRoot);
});

test('recovery-only state reads still verify the loop hash', () => {
  const originalRoot = freshRoot('dl-root-recovery-hash-original-');
  const candidateRoot = freshRoot('dl-root-recovery-hash-copy-');
  const { runId } = init(originalRoot);
  copyDurableState(originalRoot, candidateRoot);
  const loopPath = join(runDir(candidateRoot, runId), 'loop.json');
  const raw = JSON.parse(readFileSync(loopPath, 'utf8'));
  raw.goal = 'tampered-without-hash';
  // This direct fixture write intentionally leaves .loop.hash unchanged.
  writeFileSync(loopPath, JSON.stringify(raw, null, 2));

  assert.throws(() => readStateForRootRecovery(candidateRoot, runId), /STATE_TAMPERED/);
});

test('root diagnosis is hash-verified, read-only, path-redacted, and denies a resolvable copy', async () => {
  const originalRoot = freshRoot('dl-root-diagnose-original-');
  const candidateRoot = freshRoot('dl-root-diagnose-copy-');
  const { runId } = init(originalRoot);
  const storedRoot = readState(originalRoot, runId).data.project.root;
  copyDurableState(originalRoot, candidateRoot);
  const before = durableSnapshot(candidateRoot, runId);
  const { diagnoseProjectRoot } = await recoveryApi();

  let message = '';
  assert.throws(() => diagnoseProjectRoot(candidateRoot, runId), error => {
    message = String(error?.message || error);
    return /PROJECT_ROOT_FENCED/.test(message);
  });
  assert.equal(message.includes(originalRoot), false, 'diagnosis must not reveal the stored path');
  assert.equal(message.includes(candidateRoot), false, 'diagnosis must not reveal the candidate path');
  assert.deepEqual(durableSnapshot(candidateRoot, runId), before, 'diagnosis must not mutate state, hash, or event log');

  const loopPath = join(runDir(candidateRoot, runId), 'loop.json');
  const tampered = JSON.parse(readFileSync(loopPath, 'utf8'));
  tampered.goal = 'tampered-without-hash';
  writeFileSync(loopPath, JSON.stringify(tampered, null, 2));
  const tamperedBefore = durableSnapshot(candidateRoot, runId);
  assert.throws(() => diagnoseProjectRoot(candidateRoot, runId), /STATE_TAMPERED/);
  assert.deepEqual(durableSnapshot(candidateRoot, runId), tamperedBefore, 'failed diagnosis must remain read-only');
});

test('only an unresolvable stored root is diagnosed as rebindable', async () => {
  const { candidateRoot, runId, storedRoot } = movedRun();
  const { diagnoseProjectRoot } = await recoveryApi();

  const diagnosed = diagnoseProjectRoot(candidateRoot, runId);
  assert.equal(diagnosed.action, 'rebind');
  assert.equal(diagnosed.topology, 'quiescent');
  assert.equal(diagnosed.current_root_digest, projectRootDigest(storedRoot));
  assert.deepEqual(diagnosed.fence, { owner: runId, generation: 1 });
});

test('verified root-recovery capture diagnoses a moved root from immutable bytes without mutation', async () => {
  const moved = movedRun('dl-root-verified-recovery-');
  const before = durableSnapshot(moved.candidateRoot, moved.runId);
  const { diagnoseVerifiedProjectRoot } = await recoveryApi();
  const diagnosis = diagnoseVerifiedProjectRoot(moved.candidateRoot, moved.runId);
  assert.equal(diagnosis.action, 'rebind');
  assert.equal(diagnosis.current_root_digest, projectRootDigest(moved.storedRoot));
  assert.deepEqual(durableSnapshot(moved.candidateRoot, moved.runId), before);
});

test('verified vectors exclude only exact transient lock-release artifacts', () => {
  const moved = movedRun('dl-root-verified-lock-release-');
  const dir = runDir(moved.candidateRoot, moved.runId);
  const token = '12345678-1234-4234-8234-123456789abc';
  const transient = `.lock.release-${token}`;
  const adjacent = `.lock.release-${token}-adjacent`;
  mkdirSync(join(dir, transient));
  mkdirSync(join(dir, adjacent));

  const captured = captureVerifiedRootRecoverySnapshot(moved.candidateRoot, moved.runId);
  assert.equal(captured.ok, true);
  const rels = captured.snapshot.vector.map(entry => entry[1]);
  assert.equal(rels.includes(transient), false);
  assert.equal(rels.includes(adjacent), true);
});

test('verified root diagnosis propagates the path-free atomic-replacement race descriptor', async () => {
  const moved = movedRun('dl-root-verified-atomic-replacement-');
  const target = join(
    canonicalProjectRoot(moved.candidateRoot),
    '.deep-loop',
    'runs',
    moved.runId,
    'artifacts',
    'atomic-replace.bin',
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'before-replacement');
  let replaced = false;
  const { diagnoseVerifiedProjectRoot } = await recoveryApi();
  const result = diagnoseVerifiedProjectRoot(moved.candidateRoot, moved.runId, {
    captureOptions: {
      vectorOptions: {
        readFileFn(path, ...args) {
          if (path === target && !replaced) {
            const temp = `${target}.tmp`;
            writeFileSync(temp, 'after-replacement');
            renameSync(temp, target);
            replaced = true;
          }
          return readFileSync(path, ...args);
        },
      },
    },
  });

  assert.equal(replaced, true);
  assert.deepEqual(result, {
    ok: false,
    kind: 'verified-read-race',
    reason: 'identity-drift',
    retryable: true,
    operation_id: null,
    phase: 'verified-vector',
  });
  assert.equal(result.kind, 'verified-read-race');
  assert.notEqual(result.kind, 'integrity-invalid');
  assert.equal(JSON.stringify(result).includes(target), false);
});

test('verified root diagnosis keeps same-inode same-length content drift integrity-invalid', async () => {
  const moved = movedRun('dl-root-verified-same-inode-content-');
  const target = join(
    canonicalProjectRoot(moved.candidateRoot),
    '.deep-loop',
    'runs',
    moved.runId,
    'artifacts',
    'same-inode-content.bin',
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'AAAA');
  const before = captureStableFileIdentity(target);
  let rewritten = false;
  const { diagnoseVerifiedProjectRoot } = await recoveryApi();
  const result = diagnoseVerifiedProjectRoot(moved.candidateRoot, moved.runId, {
    captureOptions: {
      vectorOptions: {
        readFileFn(path, ...args) {
          if (path === target && !rewritten) {
            const bytes = readFileSync(path, ...args);
            writeFileSync(path, 'BBBB');
            rewritten = true;
            return bytes;
          }
          return readFileSync(path, ...args);
        },
      },
    },
  });
  const after = captureStableFileIdentity(target);

  assert.equal(rewritten, true);
  assert.equal(matchingStableFileIdentity(before, after), true);
  assert.deepEqual(result, {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: null,
    phase: 'verified-vector',
  });
  assert.notEqual(result.kind, 'verified-read-race');
});

test('verified root diagnosis discards the result when the run vector drifts after evidence sampling', async () => {
  const moved = movedRun('dl-root-verified-drift-');
  const { diagnoseVerifiedProjectRoot } = await recoveryApi();
  const result = diagnoseVerifiedProjectRoot(moved.candidateRoot, moved.runId, {
    afterEvidence: () => {
      const path = join(runDir(moved.candidateRoot, moved.runId), 'loop.json');
      const loop = JSON.parse(readFileSync(path, 'utf8'));
      loop.goal = 'intentional diagnosis drift';
      writeFileSync(path, JSON.stringify(loop, null, 2));
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'integrity-invalid');
  assert.equal(result.partial_discarded, true);
  assert.equal(Object.hasOwn(result, 'action'), false);
});

test('a stopped original still fences diagnosis and rebind while its stored root resolves', async () => {
  const originalRoot = freshRoot('dl-root-rebind-stopped-original-');
  const candidateRoot = freshRoot('dl-root-rebind-stopped-copy-');
  const { runId } = init(originalRoot);
  const { data } = readState(originalRoot, runId);
  data.status = 'stopped';
  writeState(originalRoot, runId, data);
  copyDurableState(originalRoot, candidateRoot);
  const storedRoot = data.project.root;
  const before = durableSnapshot(candidateRoot, runId);
  const { diagnoseProjectRoot, rebindProjectRoot } = await recoveryApi();

  assert.throws(() => diagnoseProjectRoot(candidateRoot, runId), /PROJECT_ROOT_FENCED/);
  assert.throws(
    () => rebindProjectRoot(candidateRoot, runId, {
      actor: 'human', confirm: true,
      expectedStoredRootDigest: projectRootDigest(storedRoot),
      expectedBindingGeneration: 1,
      fence: { owner: runId, generation: 1 }, now: FIXED_NOW.getTime(),
    }),
    /PROJECT_ROOT_FENCED/
  );
  assert.deepEqual(durableSnapshot(candidateRoot, runId), before);
});

test('rebind requires the exact human confirmation, stored-root digest, owner, and generation', async () => {
  const { rebindProjectRoot } = await recoveryApi();
  const variants = [
    ['actor', ({ runId, digest }) => ({ actor: 'agent', confirm: true, expectedStoredRootDigest: digest, expectedBindingGeneration: 1, fence: { owner: runId, generation: 1 } }), /INVALID_ACTOR/],
    ['confirm', ({ runId, digest }) => ({ actor: 'human', confirm: false, expectedStoredRootDigest: digest, expectedBindingGeneration: 1, fence: { owner: runId, generation: 1 } }), /CONFIRM_REQUIRED/],
    ['missing digest', ({ runId }) => ({ actor: 'human', confirm: true, expectedBindingGeneration: 1, fence: { owner: runId, generation: 1 } }), /INVALID_STORED_ROOT_DIGEST/],
    ['wrong digest', ({ runId }) => ({ actor: 'human', confirm: true, expectedStoredRootDigest: '0'.repeat(64), expectedBindingGeneration: 1, fence: { owner: runId, generation: 1 } }), /INVALID_STORED_ROOT_DIGEST/],
    ['non-canonical digest spelling', ({ runId }) => ({ actor: 'human', confirm: true, expectedStoredRootDigest: 'A'.repeat(64), expectedBindingGeneration: 1, fence: { owner: runId, generation: 1 } }), /INVALID_STORED_ROOT_DIGEST/],
    ['missing owner', ({ digest }) => ({ actor: 'human', confirm: true, expectedStoredRootDigest: digest, expectedBindingGeneration: 1, fence: { generation: 1 } }), /FENCE_REQUIRED/],
    ['missing generation', ({ runId, digest }) => ({ actor: 'human', confirm: true, expectedStoredRootDigest: digest, expectedBindingGeneration: 1, fence: { owner: runId } }), /FENCE_REQUIRED/],
  ];

  for (const [label, optionsFor, expectedError] of variants) {
    const moved = movedRun(`dl-root-guard-${label.replaceAll(' ', '-')}-`);
    const digest = projectRootDigest(moved.storedRoot);
    const before = durableSnapshot(moved.candidateRoot, moved.runId);
    assert.throws(
      () => rebindProjectRoot(moved.candidateRoot, moved.runId, {
        ...optionsFor({ ...moved, digest }), now: FIXED_NOW.getTime(),
      }),
      expectedError,
      label
    );
    assert.deepEqual(durableSnapshot(moved.candidateRoot, moved.runId), before, `${label} must not mutate durable state`);
  }
});

test('rebind rejects stale owner or generation without changing event, hash, or state', async () => {
  const { rebindProjectRoot } = await recoveryApi();
  for (const fence of [{ owner: 'stale-owner', generation: 1 }, { owner: null, generation: 9 }]) {
    const moved = movedRun('dl-root-stale-fence-');
    const before = durableSnapshot(moved.candidateRoot, moved.runId);
    const actualFence = { ...fence, owner: fence.owner ?? moved.runId };
    assert.throws(
      () => rebindProjectRoot(moved.candidateRoot, moved.runId, {
        actor: 'human', confirm: true,
        expectedStoredRootDigest: projectRootDigest(moved.storedRoot),
        expectedBindingGeneration: 1,
        fence: actualFence, now: FIXED_NOW.getTime(),
      }),
      /LEASE_FENCED/
    );
    assert.deepEqual(durableSnapshot(moved.candidateRoot, moved.runId), before);
  }
});

test('successful relocation commits one fixed event, root, and anchor then restores strict access', async () => {
  const moved = movedRun('dl-root-rebind-success-');
  const before = durableSnapshot(moved.candidateRoot, moved.runId);
  const { rebindProjectRoot } = await recoveryApi();

  rebindProjectRoot(moved.candidateRoot, moved.runId, {
    actor: 'human', confirm: true,
    expectedStoredRootDigest: projectRootDigest(moved.storedRoot),
    expectedBindingGeneration: 1,
    fence: { owner: moved.runId, generation: 1 },
    now: FIXED_NOW.getTime(),
  });

  const { data } = readState(moved.candidateRoot, moved.runId);
  const lines = readFileSync(join(runDir(moved.candidateRoot, moved.runId), 'event-log.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'project-root-rebound');
  assert.equal(lines[0].ts, FIXED_NOW.toISOString());
  assert.equal(lines[0].data.old_root_digest, projectRootDigest(moved.storedRoot));
  assert.equal(lines[0].data.new_root_digest, projectRootDigest(canonicalProjectRoot(moved.candidateRoot)));
  assert.equal(data.project.root, canonicalProjectRoot(moved.candidateRoot));
  assert.deepEqual(data.event_log_head, { seq: lines[0].seq, checksum: lines[0].checksum });
  assert.notEqual(durableSnapshot(moved.candidateRoot, moved.runId).hash, before.hash);
});

test('Task 13 plain rebind matrix preserves topology and journals root plus lease epochs for both runtimes', async () => {
  const { diagnoseProjectRoot, rebindProjectRoot } = await recoveryApi();
  for (const runtime of ['claude', 'codex']) {
    for (const topology of ['terminal', 'quiescent']) {
      const moved = seedRelocationTopology(topology, runtime, `dl-root-plain-${runtime}-${topology}-`);
      const before = readStateForRootRecovery(moved.candidateRoot, moved.runId).data;
      const oldOwner = before.session_chain.lease.owner_run_id;
      const oldSessions = structuredClone(before.session_chain.sessions);
      before.autonomy.attended_launch_approval = {
        style: 'visible',
        approved_at: '2026-07-11T00:00:00.000Z',
      };
      before.autonomy.runtime_executable_approval = {
        runtime,
        canonical_path: join(moved.storedRoot, 'bin', runtime),
        sha256: 'a'.repeat(64),
        version: '1.0.0',
        platform: process.platform,
        arch: process.arch,
        source: 'human-explicit',
        package: null,
        authenticode: null,
        approved_by: 'human',
        approved_at: '2026-07-11T00:00:00.000Z',
      };
      before.autonomy.launcher_executable_approvals.tmux = {
        kind: 'tmux',
        canonical_path: '/opt/external/tmux',
        sha256: 'b'.repeat(64),
        version: 'tmux 3.4',
        platform: 'linux',
        arch: 'x64',
        source: 'human-explicit',
        authenticode: null,
        approved_by: 'human',
        approved_at: '2026-07-11T00:00:00.000Z',
      };
      writeRecoveryFixture(moved.candidateRoot, moved.runId, before);

      const diagnosis = diagnoseProjectRoot(moved.candidateRoot, moved.runId);
      assert.equal(diagnosis.action, 'rebind');
      assert.equal(diagnosis.current_root_digest, projectRootDigest(moved.storedRoot));
      assert.equal(diagnosis.current_binding_generation, before.project.binding_generation);
      assert.equal(diagnosis.fence.owner, oldOwner);
      assert.equal(diagnosis.fence.generation, before.session_chain.lease.generation);
      assert.match(diagnosis.command, /root rebind/);
      assert.match(diagnosis.command, /--expected-stored-root-digest [0-9a-f]{64}/);
      assert.match(diagnosis.command, /--expected-binding-generation 1/);

      const result = rebindProjectRoot(moved.candidateRoot, moved.runId, relocationOptions(moved));
      const rebound = readState(moved.candidateRoot, moved.runId).data;
      assert.equal(result.action, 'already-rebound');
      assert.equal(rebound.project.binding_generation, before.project.binding_generation + 1);
      assert.equal(rebound.session_chain.lease.generation, before.session_chain.lease.generation + 1);
      assert.equal(rebound.session_chain.lease.owner_run_id, oldOwner);
      assert.deepEqual(
        rebound.session_chain.sessions.map(({ run_id }) => run_id),
        oldSessions.map(({ run_id }) => run_id),
      );
      assert.equal(rebound.status, 'paused');
      assert.equal(rebound.autonomy.attended_launch_approval, null);
      assert.equal(rebound.autonomy.runtime_executable_approval, null);
      assert.equal(rebound.autonomy.launcher_executable_approvals.tmux.canonical_path, '/opt/external/tmux');
      assert.equal(rebound.session_spawn.launcher, 'none');
      assert.equal(rebound.autonomy.spawn_style, 'interactive');
      const rootEvents = eventLines(moved.candidateRoot, moved.runId)
        .filter(event => event.type === 'project-root-rebound');
      assert.equal(rootEvents.length, 1);
      assert.deepEqual(Object.keys(rootEvents[0].data), [
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
      ]);
      assert.equal(existsSync(join(
        runDir(moved.candidateRoot, moved.runId),
        'recoveries',
        'root-operations',
        `${rootEvents[0].data.operation_id}.json`,
      )), true);
    }
  }
});

test('Task 13 relocation topology matrix rejects plain rebind and creates one fresh scoped child', async () => {
  const { diagnoseProjectRoot, rebindProjectRoot, recoverRelocatedRoot } = await recoveryApi();
  const matrix = [
    ['reserved', 'boundary'],
    ['emitted', 'boundary'],
    ['spawned', 'boundary'],
    ['acquired-unbound', 'boundary'],
    ['open-affinity', 'affinity'],
    ['affinity-recovery', 'affinity'],
    ['boundary-recovery', 'boundary'],
  ];
  for (const runtime of ['claude', 'codex']) {
    for (const [topology, recoveryKind] of matrix) {
      const moved = seedRelocationTopology(topology, runtime, `dl-root-recovery-${runtime}-${topology}-`);
      const before = durableSnapshot(moved.candidateRoot, moved.runId);
      const beforeLoop = readStateForRootRecovery(moved.candidateRoot, moved.runId).data;
      const cursorOwner = beforeLoop.session_chain.sessions.find(
        session => session.run_id === beforeLoop.session_chain.lease.owner_run_id,
      ) ?? beforeLoop.session_chain.sessions[0];
      cursorOwner.compact_cursor = historicalCursor(
        cursorOwner.run_id,
        runtime,
        cursorOwner.scope?.workstream_id ?? 'ws-history',
      );
      writeRecoveryFixture(moved.candidateRoot, moved.runId, beforeLoop);
      const beforeWithCursor = durableSnapshot(moved.candidateRoot, moved.runId);
      const diagnosed = diagnoseProjectRoot(moved.candidateRoot, moved.runId);
      assert.equal(diagnosed.action, 'relocation-recovery', `${runtime}/${topology}`);
      assert.equal(diagnosed.topology, topology);
      assert.match(diagnosed.command, /root recover/);
      assert.throws(
        () => rebindProjectRoot(moved.candidateRoot, moved.runId, relocationOptions(moved)),
        /PROJECT_ROOT_RELOCATION_RECOVERY_REQUIRED/,
      );
      assert.notDeepEqual(beforeWithCursor, before, 'characterization fixture must persist a source cursor');
      assert.deepEqual(durableSnapshot(moved.candidateRoot, moved.runId), beforeWithCursor);

      const result = recoverRelocatedRoot(
        moved.candidateRoot,
        moved.runId,
        relocationOptions(moved),
      );
      const rebound = readState(moved.candidateRoot, moved.runId).data;
      const replacements = rebound.session_chain.sessions.filter(
        session => !beforeLoop.session_chain.sessions.some(old => old.run_id === session.run_id),
      );
      assert.equal(replacements.length, 1, `${runtime}/${topology}`);
      assert.equal(Object.hasOwn(replacements[0], 'compact_cursor'), false, `${runtime}/${topology}`);
      assert.notEqual(replacements[0].run_id, moved.childId);
      assert.equal(result.recovery_kind, recoveryKind);
      assert.equal(
        replacements[0].scope.workstream_id,
        recoveryKind === 'affinity'
          ? beforeLoop.session_chain.sessions.find(
            session => session.scope?.workstream_id,
          )?.scope.workstream_id
          : null,
      );
      assert.equal(existsSync(join(runDir(moved.candidateRoot, moved.runId), replacements[0].recovery_rel)), true);
      assert.equal(eventLines(moved.candidateRoot, moved.runId)
        .filter(event => event.type === 'project-root-rebound').length, 1);
    }
  }
});

test('Task 13 active checker is invalidated exactly and a live headless producer makes diagnosis wait', async () => {
  const { diagnoseProjectRoot, diagnoseVerifiedProjectRoot, recoverRelocatedRoot } = await recoveryApi();
  const moved = seedRelocationTopology('open-affinity', 'codex', 'dl-root-review-headless-');
  const { data } = readStateForRootRecovery(moved.candidateRoot, moved.runId);
  const claim = {
    run_id: moved.runId,
    reviewer_id: 'deep-review',
    checker_episode_id: 'checker-1',
    target_maker: 'maker-1',
    attempt_id: 'attempt-root-relocation',
    workstream_id: data.session_chain.sessions[0].scope.workstream_id,
    point: 'implementation',
    project_root: moved.storedRoot,
    runtime: 'codex',
    lease_owner: data.session_chain.lease.owner_run_id,
    lease_generation: data.session_chain.lease.generation,
    artifacts: [],
  };
  data.episodes.push({
    id: 'checker-1',
    role: 'checker',
    status: 'in_progress',
    request_rel: 'episodes/checker-1/request.md',
    attempt_id: claim.attempt_id,
    target_maker: claim.target_maker,
    review_claim: claim,
  });
  writeRecoveryFixture(moved.candidateRoot, moved.runId, data);
  const hostLock = join(runDir(moved.candidateRoot, moved.runId), '.headless-host.lock');
  mkdirSync(hostLock);
  writeFileSync(join(hostLock, 'owner'), JSON.stringify({
    token: 'live-root-relocation-producer',
    pid: process.pid,
    started_at_ms: FIXED_NOW.getTime(),
  }));
  const verifiedWaiting = diagnoseVerifiedProjectRoot(moved.candidateRoot, moved.runId);
  assert.equal(verifiedWaiting.action, 'wait');
  assert.equal(verifiedWaiting.blocker, 'live-headless-producer');
  const waiting = diagnoseProjectRoot(moved.candidateRoot, moved.runId);
  assert.equal(waiting.action, 'wait');
  assert.equal(waiting.blocker, 'live-headless-producer');
  rmSync(hostLock, { recursive: true });

  recoverRelocatedRoot(moved.candidateRoot, moved.runId, relocationOptions(moved));
  const rebound = readState(moved.candidateRoot, moved.runId).data;
  const checker = rebound.episodes.find(episode => episode.id === 'checker-1');
  assert.equal(checker.review_claim, undefined);
  assert.equal(checker.attempt_id, undefined);
  assert.equal(checker.status, 'blocked');
  assert.equal(checker.block_reason, 'project-root-relocated');
  assert.equal(checker.needs_human, true);
  assert.deepEqual(checker.invalidated_review_claims, [{
    ...claim,
    invalidated_at: FIXED_NOW.toISOString(),
    reason: 'project-root-relocated',
  }]);
});

test('Task 13 verified orphan accounting settles once while malformed receipts fail closed', async () => {
  const { diagnoseProjectRoot, diagnoseVerifiedProjectRoot, recoverRelocatedRoot } = await recoveryApi();
  const moved = movedRunWithProcessReceipt();
  const result = recoverRelocatedRoot(
    moved.candidateRoot,
    moved.runId,
    relocationOptions(moved),
  );
  const lines = eventLines(moved.candidateRoot, moved.runId);
  const costs = lines.filter(event =>
    event.type === 'cost' && event.data?.process_receipt_id === moved.receipt.receipt_id);
  assert.equal(costs.length, 1);
  assert.equal(costs[0].data.owner, moved.runId);
  assert.equal(costs[0].data.turns, 1);
  assert.equal(costs[0].data.tokens, 5);
  const rebound = lines.find(event => event.type === 'project-root-rebound');
  assert.deepEqual(rebound.data.settled_receipt_ids, [moved.receipt.receipt_id]);
  const beforeRetry = durableSnapshot(moved.candidateRoot, moved.runId);
  assert.equal(recoverRelocatedRoot(moved.candidateRoot, moved.runId, {
    actor: 'human',
    confirm: true,
    expectedStoredRootDigest: projectRootDigest(moved.storedRoot),
    expectedBindingGeneration: 1,
    fence: { owner: moved.runId, generation: 1 },
  }).operation_id, result.operation_id);
  assert.deepEqual(durableSnapshot(moved.candidateRoot, moved.runId), beforeRetry);

  const bad = movedRunWithProcessReceipt({ malformed: true });
  const beforeBad = durableSnapshot(bad.candidateRoot, bad.runId);
  assert.throws(
    () => recoverRelocatedRoot(bad.candidateRoot, bad.runId, relocationOptions(bad)),
    /PROJECT_ROOT_ACCOUNTING_UNMEASURABLE/,
  );
  assert.deepEqual(durableSnapshot(bad.candidateRoot, bad.runId), beforeBad);

  for (const [label, fixture, error] of [
    ['conflicting', movedRunWithProcessReceipt({ conflicting: true }), /PROJECT_ROOT_ACCOUNTING_CONFLICT/],
    ['unverifiable', movedRunWithProcessReceipt({ unverifiable: true }), /PROJECT_ROOT_ACCOUNTING_UNMEASURABLE/],
  ]) {
    const before = durableSnapshot(fixture.candidateRoot, fixture.runId);
    assert.throws(
      () => recoverRelocatedRoot(fixture.candidateRoot, fixture.runId, relocationOptions(fixture)),
      error,
      label,
    );
    assert.deepEqual(durableSnapshot(fixture.candidateRoot, fixture.runId), before, label);
  }

  const live = movedRunWithProcessReceipt();
  const lock = join(runDir(live.candidateRoot, live.runId), '.headless-host.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), JSON.stringify({
    token: 'live-accounting-producer',
    pid: process.pid,
    started_at_ms: FIXED_NOW.getTime(),
  }));
  assert.deepEqual(
    diagnoseProjectRoot(live.candidateRoot, live.runId).action,
    'wait',
  );
  const beforeLive = durableSnapshot(live.candidateRoot, live.runId);
  assert.throws(
    () => recoverRelocatedRoot(live.candidateRoot, live.runId, relocationOptions(live)),
    /PROJECT_ROOT_RELOCATION_WAIT/,
  );
  assert.deepEqual(durableSnapshot(live.candidateRoot, live.runId), beforeLive);

  const unmeasurable = movedRunWithProcessReceipt({ unmeasurable: true });
  const verifiedAccounting = diagnoseVerifiedProjectRoot(
    unmeasurable.candidateRoot,
    unmeasurable.runId,
  );
  assert.equal(verifiedAccounting.action, 'wait');
  assert.equal(verifiedAccounting.blocker, 'project-root-accounting');
});

test('Task 13 post-candidate retry is proof-bound and forged root-operation receipts fail closed', async () => {
  const { diagnoseProjectRoot, rebindProjectRoot } = await recoveryApi();
  const moved = seedRelocationTopology('quiescent', 'claude', 'dl-root-idempotent-');
  const first = rebindProjectRoot(moved.candidateRoot, moved.runId, relocationOptions(moved));
  const beforeRetry = durableSnapshot(moved.candidateRoot, moved.runId);
  const diagnosed = diagnoseProjectRoot(moved.candidateRoot, moved.runId);
  assert.equal(diagnosed.action, 'already-rebound');
  assert.equal(diagnosed.operation_id, first.operation_id);
  const retried = rebindProjectRoot(moved.candidateRoot, moved.runId, {
    ...relocationOptions({
      ...moved,
      storedRoot: moved.storedRoot,
    }),
    expectedStoredRootDigest: projectRootDigest(moved.storedRoot),
    expectedBindingGeneration: 1,
    fence: { owner: moved.runId, generation: 1 },
  });
  assert.equal(retried.operation_id, first.operation_id);
  assert.deepEqual(durableSnapshot(moved.candidateRoot, moved.runId), beforeRetry);

  const receiptPath = join(
    runDir(moved.candidateRoot, moved.runId),
    'recoveries',
    'root-operations',
    `${first.operation_id}.json`,
  );
  const forged = JSON.parse(readFileSync(receiptPath, 'utf8'));
  forged.candidate_loop_hash = '0'.repeat(64);
  writeFileSync(receiptPath, JSON.stringify(forged));
  assert.throws(
    () => diagnoseProjectRoot(moved.candidateRoot, moved.runId),
    /ROOT_OPERATION_PROOF_INVALID/,
  );
  assert.deepEqual(durableSnapshot(moved.candidateRoot, moved.runId), beforeRetry);
});

test('Task 13 stale launch metadata and old-root text never override the candidate-root descriptor', async () => {
  const { recoverRelocatedRoot } = await recoveryApi();
  for (const runtime of ['claude', 'codex']) {
    const moved = seedRelocationTopology('reserved', runtime, `dl-root-launch-${runtime}-`);
    const result = recoverRelocatedRoot(moved.candidateRoot, moved.runId, relocationOptions(moved));
    const dir = join(runDir(moved.candidateRoot, moved.runId), 'terminal');
    mkdirSync(dir, { recursive: true });
    const variants = [
      null,
      '{malformed',
      JSON.stringify({ launch_command_sha256: '0'.repeat(64) }),
      JSON.stringify({
        launch_command_sha256: contentHash(Buffer.from(`OLD:${moved.storedRoot}\n`)),
        parent_run_id: moved.runId,
        child_run_id: 'WRONG-CHILD',
        topology: 'wrong',
        project_root_digest: projectRootDigest(moved.storedRoot),
        project_binding_generation: 1,
      }),
    ];
    for (const meta of variants) {
      writeFileSync(join(dir, 'launch-command.txt'), `OLD:${moved.storedRoot}\n`);
      const metaPath = join(dir, 'launch-command.meta.json');
      if (meta === null) rmSync(metaPath, { force: true });
      else writeFileSync(metaPath, meta);
      const cli = invoke([
        'resume-command',
        '--project-root', moved.candidateRoot,
        '--run-id', moved.runId,
      ], freshRoot('dl-root-launch-cwd-'));
      assert.equal(cli.status, 0, cli.stderr);
      const command = splitInvocation(cli.stdout.split('\n')[0]);
      const rootIndex = command.indexOf('--candidate-project-root');
      assert.notEqual(rootIndex, -1);
      assert.equal(command[rootIndex + 1], canonicalProjectRoot(moved.candidateRoot));
      assert.equal(command.includes(moved.storedRoot), false);
      assert.match(cli.stdout, new RegExp(result.replacement_session_id));
    }
  }
});

test('Task 13 committed receipt retention keeps referenced retries and prunes only unreferenced oldest entries', async () => {
  const { diagnoseProjectRoot, rebindProjectRoot } = await recoveryApi();
  const moved = seedRelocationTopology('quiescent', 'claude', 'dl-root-retention-');
  const first = rebindProjectRoot(moved.candidateRoot, moved.runId, relocationOptions(moved));
  const receipts = join(runDir(moved.candidateRoot, moved.runId), 'recoveries', 'root-operations');
  mkdirSync(receipts, { recursive: true });
  for (let index = 0; index < 40; index += 1) {
    writeFileSync(join(receipts, `${String(index).padStart(64, '0')}.json`), JSON.stringify({
      operation_id: String(index).padStart(64, '0'),
      unreferenced_fixture: true,
    }));
  }
  const diagnosis = diagnoseProjectRoot(moved.candidateRoot, moved.runId);
  assert.equal(diagnosis.action, 'already-rebound');
  assert.equal(existsSync(join(receipts, `${first.operation_id}.json`)), true);
  assert.ok(readdirSync(receipts).length <= 17, 'bounded retention keeps latest proof plus configured history');
});

test('Task 13 root recovery acquire is the sole fresh-process takeover path', async () => {
  const { recoverRelocatedRoot } = await recoveryApi();
  const moved = seedRelocationTopology('open-affinity', 'codex', 'dl-root-acquire-');
  const recovered = recoverRelocatedRoot(
    moved.candidateRoot,
    moved.runId,
    relocationOptions(moved),
  );
  const before = readState(moved.candidateRoot, moved.runId).data;
  const child = before.session_chain.sessions.find(
    session => session.run_id === recovered.replacement_session_id,
  );
  const generic = invoke([
    'lease', 'acquire',
    '--owner', child.run_id,
    '--generation', String(before.session_chain.lease.generation),
    '--runtime', 'codex',
    '--project-root', moved.candidateRoot,
    '--run-id', moved.runId,
  ]);
  assert.notEqual(generic.status, 0, generic.stdout);
  assert.equal(readState(moved.candidateRoot, moved.runId).data.session_chain.lease.owner_run_id,
    before.session_chain.lease.owner_run_id);

  const acquired = invoke([
    'root', 'recovery', 'acquire',
    '--capsule', child.recovery_rel,
    '--owner', child.run_id,
    '--generation', String(before.session_chain.lease.generation),
    '--binding-generation', String(before.project.binding_generation),
    '--runtime', 'codex',
    '--candidate-project-root', moved.candidateRoot,
    '--run-id', moved.runId,
  ], freshRoot('dl-root-acquire-cwd-'));
  assert.equal(acquired.status, 0, acquired.stderr);
  const after = readState(moved.candidateRoot, moved.runId).data;
  assert.equal(after.session_chain.lease.owner_run_id, child.run_id);
  assert.equal(after.session_chain.lease.generation, before.session_chain.lease.generation + 1);
  assert.equal(after.status, 'running');
});

test('Task 13 plain and replacement root publications roll forward exactly once at every crash barrier', async () => {
  const { rebindProjectRoot, recoverRelocatedRoot } = await recoveryApi();
  const barriers = [
    'artifact:0:rename',
    'event:0:append',
    'state:loop:rename',
    'state:hash:rename',
    'committed:rename',
  ];
  for (const [route, mutate, topology] of [
    ['plain', rebindProjectRoot, 'quiescent'],
    ['replacement', recoverRelocatedRoot, 'open-affinity'],
  ]) {
    for (const barrier of barriers) {
      const moved = seedRelocationTopology(
        topology,
        route === 'plain' ? 'claude' : 'codex',
        `dl-root-crash-${route}-${barrier.replaceAll(':', '-')}-`,
      );
      const retryOptions = relocationOptions(moved);
      assert.throws(
        () => mutate(moved.candidateRoot, moved.runId, {
          ...retryOptions,
          faultAt(label) { if (label === barrier) throw new Error(`fault:${barrier}`); },
        }),
        /TRANSACTION_PENDING|TRANSACTION_RECONCILIATION_REQUIRED/,
        `${route}/${barrier}`,
      );
      mutate(moved.candidateRoot, moved.runId, retryOptions);
      const reopened = invoke([
        'root', 'diagnose',
        '--candidate-project-root', moved.candidateRoot,
        '--run-id', moved.runId,
      ], freshRoot('dl-root-crash-cwd-'));
      assert.equal(reopened.status, 0, `${route}/${barrier}: ${reopened.stderr}`);
      const result = JSON.parse(reopened.stdout);
      assert.equal(result.action, 'already-rebound', `${route}/${barrier}`);
      const state = readState(moved.candidateRoot, moved.runId);
      assert.equal(
        contentHash(readFileSync(join(runDir(moved.candidateRoot, moved.runId), 'loop.json'))),
        state.hash,
        `${route}/${barrier}`,
      );
      assert.equal(eventLines(moved.candidateRoot, moved.runId)
        .filter(event => event.type === 'project-root-rebound').length, 1, `${route}/${barrier}`);
    }
  }
});

for (const [label, options] of [
  ['incomplete', { incomplete: true }],
  ['wrong-root', { wrongRoot: true }],
  ['unmeasurable', { unmeasurable: true }],
  ['conflicting', { conflicting: true }],
  ['unassociated', { unverifiable: true }],
]) {
  test(`Round1 diagnosis accounting RED: ${label} evidence waits without a command`, async () => {
    const { diagnoseProjectRoot } = await recoveryApi();
    const moved = movedRunWithProcessReceipt(options);
    const before = durableSnapshot(moved.candidateRoot, moved.runId);
    const result = diagnoseProjectRoot(moved.candidateRoot, moved.runId);
    assert.equal(result.action, 'wait');
    assert.equal(result.blocker, 'project-root-accounting');
    assert.equal(result.command, null);
    assert.deepEqual(durableSnapshot(moved.candidateRoot, moved.runId), before);
  });
}

test('Round1 settlement RED: filename identity, batch uniqueness, and predecessor handoff are mandatory', async () => {
  const { diagnoseProjectRoot, recoverRelocatedRoot } = await recoveryApi();
  const accepted = [];

  for (const [label, mutateFixture] of [
    ['filename-mismatch', (moved) => {
      const dir = join(runDir(moved.candidateRoot, moved.runId), 'preflight', 'process-receipts');
      const source = join(dir, expectedProcessReceiptName(moved.receipt));
      renameSync(source, join(dir, `${'f'.repeat(64)}-maker.json`));
    }],
    ['duplicate-content', (moved) => {
      const dir = join(runDir(moved.candidateRoot, moved.runId), 'preflight', 'process-receipts');
      const source = join(dir, expectedProcessReceiptName(moved.receipt));
      cpSync(source, join(dir, `${'e'.repeat(64)}-maker.json`));
    }],
    ['unrelated-generation', () => {}],
    ['unrelated-handoff', (moved) => {
      const dir = join(runDir(moved.candidateRoot, moved.runId), 'preflight', 'process-receipts');
      const source = join(dir, expectedProcessReceiptName(moved.receipt));
      const unrelated = rehashProcessReceipt({
        ...moved.receipt,
        context: { ...moved.receipt.context, handoff_key: 'f'.repeat(64) },
      });
      rmSync(source);
      writeFileSync(join(dir, expectedProcessReceiptName(unrelated)), JSON.stringify(unrelated));
    }],
  ]) {
    const moved = movedRunWithProcessReceipt(
      label === 'unrelated-generation' ? { unverifiable: true } : {},
    );
    mutateFixture(moved);
    const before = durableSnapshot(moved.candidateRoot, moved.runId);
    try {
      recoverRelocatedRoot(moved.candidateRoot, moved.runId, relocationOptions(moved));
      accepted.push(label);
    } catch (error) {
      assert.match(String(error?.message || error), /PROJECT_ROOT_ACCOUNTING_(?:UNMEASURABLE|CONFLICT)/);
      assert.deepEqual(durableSnapshot(moved.candidateRoot, moved.runId), before, label);
      const diagnosis = diagnoseProjectRoot(moved.candidateRoot, moved.runId);
      assert.equal(diagnosis.action, 'wait', label);
      assert.equal(diagnosis.command, null, label);
    }
  }
  assert.deepEqual(accepted, []);
});

test('Round1 settlement RED: checker receipt must match the exact immutable claim hash', async () => {
  const parent = freshRoot('dl-root-checker-accounting-');
  const originalRoot = join(parent, 'old root');
  const candidateRoot = join(parent, 'new root');
  mkdirSync(originalRoot);
  const { runId } = init(originalRoot, 'codex');
  const { id: workstreamId } = newWorkstream(originalRoot, runId, {
    title: 'checker accounting',
    branch: 'feature/checker-accounting',
    worktree: '.worktrees/checker-accounting',
    fence: { owner: runId, generation: 1, intent: 'business' },
  });
  const { data } = readState(originalRoot, runId);
  data.workstreams.find(item => item.id === workstreamId).status = 'in_progress';
  data.active_workstreams = [workstreamId];
  data.session_chain.sessions[0].scope.workstream_id = workstreamId;
  data.session_chain.sessions[0].scope.bound_at_seq = 1;
  const claim = {
    run_id: runId,
    reviewer_id: 'deep-review',
    checker_episode_id: 'checker-accounting',
    target_maker: 'maker-accounting',
    attempt_id: 'attempt-accounting',
    workstream_id: workstreamId,
    point: 'implementation',
    project_root: data.project.root,
    runtime: 'codex',
    lease_owner: runId,
    lease_generation: 1,
    artifacts: [],
  };
  data.episodes.push({
    id: claim.checker_episode_id,
    role: 'checker',
    status: 'in_progress',
    request_rel: `episodes/${claim.checker_episode_id}/request.md`,
    attempt_id: claim.attempt_id,
    target_maker: claim.target_maker,
    review_claim: claim,
  });
  writeState(originalRoot, runId, data);
  appendAnchored(originalRoot, runId, {
    type: 'independent-review-claimed',
    data: {
      episode_id: claim.checker_episode_id,
      attempt_id: claim.attempt_id,
      reviewer_id: claim.reviewer_id,
      target_maker: claim.target_maker,
      workstream_id: claim.workstream_id,
      point: claim.point,
      artifacts: claim.artifacts,
    },
    now: FIXED_NOW.getTime() + 1_000,
  }, () => {});
  const context = {
    origin_owner: runId,
    origin_generation: 1,
    checker_episode_id: claim.checker_episode_id,
    attempt_id: claim.attempt_id,
    target_maker: claim.target_maker,
    claim_hash: '0'.repeat(64),
  };
  const receipt = makeCodexProcessReceipt({
    root: originalRoot,
    runId,
    processKind: 'checker',
    context,
    usage: { num_turns: 1, input_tokens: 2, output_tokens: 3, tokens: 5 },
  });
  assert.notEqual(receipt.context.claim_hash, codexCheckerClaimHash(claim));
  const receipts = join(runDir(originalRoot, runId), 'preflight', 'process-receipts');
  mkdirSync(receipts, { recursive: true });
  writeFileSync(join(receipts, expectedProcessReceiptName(receipt)), JSON.stringify(receipt));
  const storedRoot = data.project.root;
  renameSync(originalRoot, candidateRoot);
  const moved = { originalRoot, candidateRoot, runId, storedRoot };
  const before = durableSnapshot(candidateRoot, runId);
  const { recoverRelocatedRoot } = await recoveryApi();
  assert.throws(
    () => recoverRelocatedRoot(candidateRoot, runId, relocationOptions(moved)),
    /PROJECT_ROOT_ACCOUNTING_UNMEASURABLE/,
  );
  assert.deepEqual(durableSnapshot(candidateRoot, runId), before);
});

test('Round1 retained proof RED: committed receipt is one exact M3 wrapped schema', async () => {
  const { rebindProjectRoot } = await recoveryApi();
  const moved = seedRelocationTopology('quiescent', 'claude', 'dl-root-proof-wrap-');
  const result = rebindProjectRoot(moved.candidateRoot, moved.runId, relocationOptions(moved));
  const document = JSON.parse(readFileSync(rootReceiptPath(moved, result.operation_id), 'utf8'));
  const opened = unwrap(document, {
    producer: 'deep-loop',
    artifact_kind: 'project-root-operation',
  });
  assert.ok(opened);
  assert.deepEqual(Object.keys(document), ['schema_version', 'envelope', 'payload']);
  assert.deepEqual(Object.keys(document.envelope.schema), ['name', 'version']);
  assert.equal(document.envelope.schema.name, 'project-root-operation');
  assert.equal(document.envelope.schema.version, '1.0');
});

test('Round1 retained proof RED: every frozen field, exact event/artifact, and operation identity is revalidated', async () => {
  const { diagnoseProjectRoot, recoverRelocatedRoot } = await recoveryApi();
  const moved = seedRelocationTopology('open-affinity', 'codex', 'dl-root-proof-fields-');
  const result = recoverRelocatedRoot(moved.candidateRoot, moved.runId, relocationOptions(moved));
  const path = rootReceiptPath(moved, result.operation_id);
  const originalBytes = readFileSync(path);
  const original = JSON.parse(originalBytes);
  const accepted = [];
  const mutations = [
    ['old-root', payload => { payload.old_root_digest = '0'.repeat(64); }],
    ['new-root', payload => { payload.new_root_digest = '0'.repeat(64); }],
    ['old-binding-generation', payload => { payload.old_binding_generation += 9; }],
    ['new-binding-generation', payload => { payload.new_binding_generation += 9; }],
    ['old-lease-owner', payload => { payload.old_lease_owner = 'OTHER'; }],
    ['old-lease-generation', payload => { payload.old_lease_generation += 9; }],
    ['new-lease-owner', payload => { payload.new_lease_owner = 'OTHER'; }],
    ['new-lease-generation', payload => { payload.new_lease_generation += 9; }],
    ['recovery-kind', payload => { payload.recovery_kind = 'boundary'; }],
    ['stale-session', payload => { payload.stale_session_id = 'OTHER'; }],
    ['replacement-session', payload => { payload.replacement_session_id = 'OTHER'; }],
    ['predecessor-loop-hash', payload => { payload.predecessor_loop_hash = '0'.repeat(64); }],
    ['route-kind', payload => { payload.route_kind = 'rebind'; }],
    ['actor', payload => { payload.actor = 'agent'; }],
    ['confirmation', payload => { payload.confirmed = false; }],
    ['exact-event', payload => {
      if (payload.event) payload.event.data = { ...payload.event.data, extra: true };
      else payload.event_identity = { ...payload.event_identity, seq: payload.event_identity.seq + 1 };
    }],
    ['exact-artifacts', payload => { payload.artifact_digests = {}; }],
    ['candidate-loop-hash', payload => { payload.candidate_loop_hash = '0'.repeat(64); }],
  ];
  for (const [label, mutate] of mutations) {
    rewriteRootReceipt(path, original, mutate);
    try {
      diagnoseProjectRoot(moved.candidateRoot, moved.runId);
      accepted.push(label);
    } catch (error) {
      assert.match(String(error?.message || error), /ROOT_OPERATION_PROOF_INVALID/);
    } finally {
      writeFileSync(path, originalBytes);
    }
  }
  assert.deepEqual(accepted, []);
});

test('Round1 retained proof RED: retry pins route, human actor, and confirmation', async () => {
  const { rebindProjectRoot, recoverRelocatedRoot } = await recoveryApi();
  const moved = seedRelocationTopology('quiescent', 'claude', 'dl-root-proof-retry-');
  rebindProjectRoot(moved.candidateRoot, moved.runId, relocationOptions(moved));
  const retryOptions = {
    actor: 'human',
    confirm: true,
    expectedStoredRootDigest: projectRootDigest(moved.storedRoot),
    expectedBindingGeneration: 1,
    fence: { owner: moved.runId, generation: 1 },
    now: FIXED_NOW.getTime(),
  };
  const accepted = [];
  for (const [label, mutate, options] of [
    ['wrong-route', recoverRelocatedRoot, retryOptions],
    ['missing-actor', rebindProjectRoot, { ...retryOptions, actor: undefined }],
    ['missing-confirm', rebindProjectRoot, { ...retryOptions, confirm: undefined }],
  ]) {
    try {
      mutate(moved.candidateRoot, moved.runId, options);
      accepted.push(label);
    } catch (error) {
      assert.match(String(error?.message || error), /ROOT_OPERATION_RETRY_MISMATCH|INVALID_ACTOR|CONFIRM_REQUIRED/);
    }
  }
  assert.deepEqual(accepted, []);
});

test('Round1 acceptance RED: every relocation topology replays every artifact and executes fresh acquisition', async () => {
  const { recoverRelocatedRoot } = await recoveryApi();
  const topologies = [
    'reserved',
    'emitted',
    'spawned',
    'acquired-unbound',
    'open-affinity',
    'affinity-recovery',
    'boundary-recovery',
  ];
  const barriers = [
    'artifact:0:rename',
    'artifact:1:rename',
    'event:0:append',
    'state:loop:rename',
    'state:hash:rename',
    'committed:rename',
  ];
  for (const topology of topologies) {
    for (const barrier of barriers) {
      const moved = seedRelocationTopology(
        topology,
        'codex',
        `dl-root-r1-crash-${topology}-${barrier.replaceAll(':', '-')}-`,
      );
      const retryOptions = relocationOptions(moved);
      assert.throws(
        () => recoverRelocatedRoot(moved.candidateRoot, moved.runId, {
          ...retryOptions,
          faultAt(label) { if (label === barrier) throw new Error(`fault:${barrier}`); },
        }),
        /TRANSACTION_PENDING|TRANSACTION_RECONCILIATION_REQUIRED/,
        `${topology}/${barrier}`,
      );
      recoverRelocatedRoot(moved.candidateRoot, moved.runId, retryOptions);
      const reopened = invoke([
        'root', 'diagnose',
        '--candidate-project-root', moved.candidateRoot,
        '--run-id', moved.runId,
      ], freshRoot('dl-root-r1-crash-diagnose-'));
      assert.equal(reopened.status, 0, `${topology}/${barrier}: ${reopened.stderr}`);
      assert.equal(JSON.parse(reopened.stdout).action, 'already-rebound');
      const resume = invoke([
        'resume-command',
        '--project-root', moved.candidateRoot,
        '--run-id', moved.runId,
      ], freshRoot('dl-root-r1-crash-resume-'));
      assert.equal(resume.status, 0, `${topology}/${barrier}: ${resume.stderr}`);
      const command = resume.stdout.split('\n')[0];
      const acquired = invokeRootAcquire(command, freshRoot('dl-root-r1-crash-acquire-'));
      assert.equal(acquired.status, 0, `${topology}/${barrier}: ${acquired.stderr}`);
      const after = readState(moved.candidateRoot, moved.runId).data;
      assert.equal(after.status, 'running');
      assert.equal(after.session_chain.lease.owner_run_id, JSON.parse(acquired.stdout).owner);
      assert.equal(eventLines(moved.candidateRoot, moved.runId)
        .filter(event => event.type === 'project-root-rebound').length, 1);
    }
  }
});

test('Round1 acceptance RED: retention removes commit-oldest only and concurrent retries preserve references', async () => {
  const { rebindProjectRoot, diagnoseProjectRoot, recoverRelocatedRoot } = await recoveryApi();
  const parent = freshRoot('dl-root-r1-retention-order-');
  let currentRoot = join(parent, 'root-00');
  mkdirSync(currentRoot);
  const { runId } = init(currentRoot, 'claude');
  const operationIds = [];
  for (let index = 1; index <= 24; index += 1) {
    const storedRoot = readState(currentRoot, runId).data.project.root;
    const candidateRoot = join(parent, `root-${String(index).padStart(2, '0')}`);
    renameSync(currentRoot, candidateRoot);
    const moved = { candidateRoot, runId, storedRoot };
    const result = rebindProjectRoot(candidateRoot, runId, {
      ...relocationOptions(moved),
      now: FIXED_NOW.getTime() + index * 1_000,
    });
    operationIds.push(result.operation_id);
    currentRoot = candidateRoot;
  }
  const receiptDir = join(runDir(currentRoot, runId), 'recoveries', 'root-operations');
  const retained = new Set(readdirSync(receiptDir).map(name => name.slice(0, -5)));
  assert.deepEqual(
    operationIds.slice(-17).filter(id => !retained.has(id)),
    [],
    'the current proof plus the sixteen newest committed retries must survive',
  );
  assert.equal(
    operationIds.slice(0, -17).some(id => retained.has(id)),
    false,
    'commit-oldest unreferenced receipts must be pruned first',
  );

  assert.equal(
    existsSync(join(runDir(currentRoot, runId), '.lock')),
    false,
    'in-process rebind must drop the lock before concurrent diagnose',
  );

  const diagnoseArgs = [
    'root', 'diagnose',
    '--candidate-project-root', currentRoot,
    '--run-id', runId,
  ];
  const concurrentInitial = await Promise.all(Array.from({ length: 4 }, () => {
    const cwd = freshRoot('dl-root-r1-retention-cwd-');
    return runCliAsync(diagnoseArgs, cwd).then(result => ({ result, cwd }));
  }));
  const concurrent = await Promise.all(concurrentInitial.map(({ result, cwd }) => (
    retryLockBusyDiagnose(result, diagnoseArgs, cwd)
  )));
  // A non-zero status here is a discard descriptor on stdout with an empty stderr, and
  // status+stderr alone cannot say which discard it was. `lock-busy` means the retry
  // budget was too small; an `integrity-invalid` phase means a different transient is
  // being classified as damage. Report the descriptor so the failure names its own
  // cause instead of requiring a reproduction to find out.
  assert.deepEqual(concurrent.map(result => result.status), [0, 0, 0, 0],
    JSON.stringify(concurrent.map(result => {
      if (result.status === 0) return { status: 0 };
      let descriptor;
      try { descriptor = JSON.parse(String(result.stdout || '')); } catch { descriptor = null; }
      return {
        status: result.status,
        stderr: result.stderr,
        kind: descriptor?.kind ?? null,
        phase: descriptor?.phase ?? null,
        retryable: descriptor?.retryable ?? null,
      };
    })));
  assert.deepEqual(
    concurrent.map(result => JSON.parse(result.stdout).operation_id),
    Array(4).fill(operationIds.at(-1)),
  );
  assert.equal(existsSync(join(receiptDir, `${operationIds.at(-1)}.json`)), true);
  assert.equal(diagnoseProjectRoot(currentRoot, runId).action, 'already-rebound');

  const recovery = seedRelocationTopology('open-affinity', 'codex', 'dl-root-r1-retention-child-');
  const recovered = recoverRelocatedRoot(
    recovery.candidateRoot,
    recovery.runId,
    relocationOptions(recovery),
  );
  const childBefore = readState(recovery.candidateRoot, recovery.runId).data.session_chain.sessions
    .find(session => session.run_id === recovered.replacement_session_id);
  const recoveryReceipts = join(
    runDir(recovery.candidateRoot, recovery.runId),
    'recoveries',
    'root-operations',
  );
  for (let index = 0; index < 40; index += 1) {
    writeFileSync(join(recoveryReceipts, `${String(index).padStart(64, '0')}.json`), '{}');
  }
  assert.equal(diagnoseProjectRoot(recovery.candidateRoot, recovery.runId).action, 'already-rebound');
  assert.equal(existsSync(rootReceiptPath(recovery, recovered.operation_id)), true);
  assert.equal(existsSync(join(
    runDir(recovery.candidateRoot, recovery.runId),
    childBefore.recovery_rel,
  )), true);
});

test('Round1 acceptance RED: acquisition gates preserve the exact root reservation', async () => {
  const { acquireRootRecovery, recoverRelocatedRoot } = await recoveryApi();
  for (const [label, configure, expected, clock] of [
    ['budget', data => {
      data.budget.total = 1;
      data.budget.spent = 1;
    }, /BUDGET_BLOCKED/, FIXED_NOW.getTime()],
    ['breaker', data => {
      data.circuit_breaker.tripped = true;
      data.circuit_breaker.consecutive_request_changes = 3;
      data.circuit_breaker.trip_reason = 'consecutive-request-changes';
    }, /BREAKER_BLOCKED/, FIXED_NOW.getTime()],
    ['wallclock', data => {
      data.budget.max_wallclock_sec = 1;
    }, /BUDGET_BLOCKED/, FIXED_NOW.getTime() + 2_000],
  ]) {
    const moved = seedRelocationTopology('open-affinity', 'codex', `dl-root-r1-acquire-${label}-`);
    const { data } = readStateForRootRecovery(moved.candidateRoot, moved.runId);
    configure(data);
    writeRecoveryFixture(moved.candidateRoot, moved.runId, data);
    const recovered = recoverRelocatedRoot(
      moved.candidateRoot,
      moved.runId,
      relocationOptions(moved),
    );
    const before = readState(moved.candidateRoot, moved.runId).data;
    const child = before.session_chain.sessions.find(
      session => session.run_id === recovered.replacement_session_id,
    );
    const snapshot = durableSnapshot(moved.candidateRoot, moved.runId);
    assert.throws(
      () => acquireRootRecovery(moved.candidateRoot, moved.runId, {
        capsuleRel: child.recovery_rel,
        owner: child.run_id,
        expectGeneration: before.session_chain.lease.generation,
        bindingGeneration: before.project.binding_generation,
        runtime: 'codex',
        now: FIXED_NOW.getTime(),
        clock: () => clock,
      }),
      expected,
      label,
    );
    assert.deepEqual(durableSnapshot(moved.candidateRoot, moved.runId), snapshot, label);
  }
});

for (const [label, blocker, relieve] of [
  ['budget', data => {
    data.budget.max_wallclock_sec = 1;
  }, (root, runId, state) => extendBudget(root, runId, {
    wallclockSec: 10 * 365 * 24 * 60 * 60,
    reason: 'resume exact relocated-root reservation',
    confirm: true,
    fence: {
      owner: state.session_chain.lease.owner_run_id,
      generation: state.session_chain.lease.generation,
    },
    now: FIXED_NOW.getTime() + 10_000,
  })],
  ['breaker', data => {
    data.circuit_breaker = {
      consecutive_request_changes: 3,
      tripped: true,
      trip_reason: 'consecutive-request-changes',
    };
  }, (root, runId, state) => resetBreaker(root, runId, {
    fence: {
      owner: state.session_chain.lease.owner_run_id,
      generation: state.session_chain.lease.generation,
      intent: 'breaker-reset',
    },
  })],
]) {
  for (const [topology, expectedKind] of [
    ['open-affinity', 'affinity-supersession'],
    ['boundary-recovery', 'boundary-recovery'],
  ]) {
    test(`Round2 reservation RED: ${label} relief preserves and acquires ${expectedKind} root recovery`, async () => {
      const { recoverRelocatedRoot } = await recoveryApi();
      const moved = seedRelocationTopology(
        topology,
        'codex',
        `dl-root-r2-${label}-${topology}-`,
      );
      const { data } = readStateForRootRecovery(moved.candidateRoot, moved.runId);
      blocker(data);
      writeRecoveryFixture(moved.candidateRoot, moved.runId, data);
      recoverRelocatedRoot(
        moved.candidateRoot,
        moved.runId,
        relocationOptions(moved),
      );
      const command = exactRootRecoveryCommand(moved.candidateRoot, moved.runId);
      const beforeBlockedAcquire = durableSnapshot(moved.candidateRoot, moved.runId);
      const blocked = invokeRootAcquire(command, freshRoot('dl-root-r2-blocked-acquire-'));
      assert.notEqual(blocked.status, 0, `${label}/${topology}: acquisition must be gated`);
      assert.match(blocked.stderr, label === 'budget' ? /BUDGET_BLOCKED/ : /BREAKER_BLOCKED/);
      assert.deepEqual(
        durableSnapshot(moved.candidateRoot, moved.runId),
        beforeBlockedAcquire,
        `${label}/${topology}: blocked acquisition must be read-only`,
      );

      const beforeRelief = rootReservationEvidence(moved.candidateRoot, moved.runId);
      const stateBeforeRelief = readState(moved.candidateRoot, moved.runId).data;
      assert.equal(recoveryReservationKind(stateBeforeRelief), expectedKind);
      relieve(moved.candidateRoot, moved.runId, stateBeforeRelief);
      const afterRelief = rootReservationEvidence(moved.candidateRoot, moved.runId);
      assert.deepEqual(afterRelief, beforeRelief, `${label}/${topology}: reservation drift`);
      assert.equal(
        recoveryReservationKind(readState(moved.candidateRoot, moved.runId).data),
        expectedKind,
      );

      const acquired = invokeRootAcquire(command, freshRoot('dl-root-r2-relieved-acquire-'));
      assert.equal(acquired.status, 0, `${label}/${topology}: ${acquired.stderr}`);
      const result = JSON.parse(acquired.stdout);
      const finalState = readState(moved.candidateRoot, moved.runId).data;
      const finalChild = finalState.session_chain.sessions.find(
        session => session.run_id === beforeRelief.child.run_id,
      );
      assert.equal(finalState.status, 'running');
      assert.deepEqual(finalState.project, beforeRelief.project);
      assert.equal(finalState.session_chain.lease.owner_run_id, beforeRelief.child.run_id);
      assert.equal(finalState.session_chain.lease.generation, beforeRelief.lease.generation + 1);
      assert.equal(finalState.session_chain.lease.handoff_phase, 'acquired');
      assert.equal(finalState.session_chain.lease.takeover_kind, null);
      assert.equal(finalChild.root_recovery_operation_id, beforeRelief.child.root_recovery_operation_id);
      assert.equal(finalChild.recovery_rel, beforeRelief.child.recovery_rel);
      assert.equal(finalChild.recovery_sha256, beforeRelief.child.recovery_sha256);
      assert.equal(result.owner, beforeRelief.child.run_id);
      assert.equal(Number.isFinite(Date.parse(finalChild.started_at)), true);
      assert.deepEqual(
        eventLines(moved.candidateRoot, moved.runId)
          .filter(event => event.type === 'project-root-rebound'),
        beforeRelief.rebound,
      );
      assert.equal(
        readFileSync(join(runDir(moved.candidateRoot, moved.runId), beforeRelief.child.recovery_rel), 'utf8'),
        beforeRelief.capsule,
      );
      assert.equal(
        readFileSync(rootReceiptPath(moved, beforeRelief.child.root_recovery_operation_id), 'utf8'),
        beforeRelief.receipt,
      );
    });
  }
}

test('Round2 accounting RED: existing cost evidence must match the complete normalized event', async () => {
  const { diagnoseProjectRoot } = await recoveryApi();
  const usage = {
    num_turns: 1,
    input_tokens: 2,
    output_tokens: 3,
    tokens: 5,
    cached_input_tokens: 1,
    reasoning_output_tokens: 2,
  };
  const valid = movedRunWithProcessReceipt({
    usage,
    existingCostMutation() {},
  });
  assert.equal(
    diagnoseProjectRoot(valid.candidateRoot, valid.runId).action,
    'relocation-recovery',
  );

  const accepted = [];
  for (const [label, mutate] of [
    ['effective-turns', data => { data.turns += 7; }],
    ['effective-tokens', data => { data.tokens += 7; }],
    ['cached-input', data => { data.cached_input_tokens += 1; }],
    ['reasoning-output', data => { data.reasoning_output_tokens += 1; }],
    ['owner', data => { data.owner = 'UNRELATED-OWNER'; }],
    ['generation', data => { data.generation += 1; }],
    ['source', data => { data.source = 'unrelated-source'; }],
    ['receipt-id', data => { data.process_receipt_id = 'f'.repeat(64); }],
    ['process-kind', data => { data.process_kind = 'checker'; }],
    ['process-context', data => { data.process_context = { unrelated: true }; }],
    ['extra-field', data => { data.unexpected = true; }],
  ]) {
    const moved = movedRunWithProcessReceipt({
      usage,
      existingCostMutation: mutate,
    });
    const result = diagnoseProjectRoot(moved.candidateRoot, moved.runId);
    if (result.action !== 'wait'
      || result.blocker !== 'project-root-accounting'
      || result.command !== null) {
      accepted.push(label);
    }
  }
  assert.deepEqual(accepted, []);
});

test('Round3 accounting RED: terminal maker evidence preserves the canonical terminal marker', async () => {
  const { diagnoseProjectRoot } = await recoveryApi();
  const moved = movedRunWithProcessReceipt({
    terminal: true,
    existingCostMutation() {},
  });
  const terminalCost = eventLines(moved.candidateRoot, moved.runId).find(
    event => event.data?.process_receipt_id === moved.receipt.receipt_id,
  );
  assert.equal(terminalCost.data.terminal_process, 'codex-maker');
  assert.equal(
    diagnoseProjectRoot(moved.candidateRoot, moved.runId).action,
    'rebind',
  );
});

test('Round3 accounting RED: unsettled relocation absorbs the complete trailing floor', () => {
  const moved = movedRunWithProcessReceipt({
    usage: {
      num_turns: 1,
      input_tokens: 4,
      output_tokens: 6,
      tokens: 10,
    },
    autoFloors: [
      { turns: 0, tokens: 2 },
      { turns: 0, tokens: 3 },
    ],
  });
  const loop = readStateForRootRecovery(moved.candidateRoot, moved.runId).data;
  const accounting = inventoryRelocatedProcessReceipts(
    moved.candidateRoot,
    moved.runId,
    loop,
    projectRootDigest(moved.storedRoot),
  );
  assert.equal(accounting.costEvents.length, 1);
  assert.equal(accounting.costEvents[0].data.turns, 1);
  assert.equal(accounting.costEvents[0].data.tokens, 5);
});

test('legacy 0.2.0 relocation diagnoses and rebinds from the migrated view without assuming data/hash content equivalence', async () => {
  const parent = freshRoot('dl-root-legacy-rebind-');
  const originalRoot = join(parent, 'original');
  const candidateRoot = join(parent, 'candidate');
  mkdirSync(originalRoot);
  const { runId } = init(originalRoot);
  const storedRoot = readState(originalRoot, runId).data.project.root;
  const dir = runDir(originalRoot, runId);
  const loopPath = join(dir, 'loop.json');
  const legacy = JSON.parse(readFileSync(loopPath, 'utf8'));
  legacy.schema_version = '0.2.0';
  delete legacy.project.binding_generation;
  delete legacy.autonomy.attended_launch_approval;
  delete legacy.session_chain.lease.takeover_kind;
  for (const session of legacy.session_chain.sessions) delete session.scope;
  delete legacy.autonomy.continuation_policy;
  delete legacy.session_chain.consumed_milestones;
  delete legacy.session_chain.lease.handoff_trigger;
  const legacyRaw = JSON.stringify(legacy, null, 2);
  writeFileSync(loopPath, legacyRaw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(legacyRaw));
  renameSync(originalRoot, candidateRoot);

  const recoveryView = readStateForRootRecovery(candidateRoot, runId);
  assert.equal(recoveryView.data.schema_version, '0.4.0');
  assert.notEqual(
    contentHash(JSON.stringify(recoveryView.data, null, 2)),
    recoveryView.hash,
    'legacy migration intentionally returns 0.4.0 data with the 0.2.0 on-disk hash',
  );

  const { diagnoseProjectRoot, rebindProjectRoot } = await recoveryApi();
  const diagnosed = diagnoseProjectRoot(candidateRoot, runId);
  assert.equal(diagnosed.action, 'rebind');
  assert.equal(diagnosed.current_root_digest, projectRootDigest(storedRoot));
  assert.deepEqual(diagnosed.fence, { owner: runId, generation: 1 });

  rebindProjectRoot(candidateRoot, runId, {
    actor: 'human', confirm: true,
    expectedStoredRootDigest: projectRootDigest(storedRoot),
    expectedBindingGeneration: 1,
    fence: { owner: runId, generation: 1 },
    now: FIXED_NOW.getTime(),
  });

  const rebound = readState(candidateRoot, runId).data;
  assert.equal(rebound.schema_version, '0.4.0');
  assert.equal(rebound.autonomy.continuation_policy, 'rotate-per-unit');
  assert.equal(rebound.project.root, canonicalProjectRoot(candidateRoot));
  assert.equal(validate(rebound).ok, true);
  assert.equal(verifyLog(candidateRoot, runId).ok, true);
  assert.equal(verifyHead(candidateRoot, runId, rebound.event_log_head).ok, true);
  assert.deepEqual(readState(candidateRoot, runId).data, rebound, 'fresh post-rebind read must succeed');
});

test('rebind rejects a loop.run_id mismatch without durable mutation', async () => {
  const parent = freshRoot('dl-root-run-id-mismatch-');
  const originalRoot = join(parent, 'original');
  const candidateRoot = join(parent, 'candidate');
  mkdirSync(originalRoot);
  const { runId } = init(originalRoot);
  const { data } = readState(originalRoot, runId);
  data.run_id = 'DIFFERENT-RUN-ID';
  writeState(originalRoot, runId, data);
  const storedRoot = data.project.root;
  renameSync(originalRoot, candidateRoot);
  const before = durableSnapshot(candidateRoot, runId);
  const { rebindProjectRoot } = await recoveryApi();

  assert.throws(
    () => rebindProjectRoot(candidateRoot, runId, {
      actor: 'human', confirm: true,
      expectedStoredRootDigest: projectRootDigest(storedRoot),
      expectedBindingGeneration: 1,
      fence: { owner: runId, generation: 1 }, now: FIXED_NOW.getTime(),
    }),
    /STATE_INVALID/
  );
  assert.deepEqual(durableSnapshot(candidateRoot, runId), before);
});

test('injected Windows case, drive-root, and UNC aliases compare by canonical identity', () => {
  const canonicalByInput = new Map([
    ['C:\\Repo', 'C:\\Repo'],
    ['c:\\repo', 'C:\\Repo'],
    ['C:\\', 'C:\\'],
    ['c:\\', 'C:\\'],
    ['\\\\Server\\Share\\Repo', '\\\\Server\\Share\\Repo'],
    ['\\\\server\\share\\repo', '\\\\Server\\Share\\Repo'],
    ['D:\\Repo', 'D:\\Repo'],
  ]);
  const deps = {
    realpathSync(value) {
      if (!canonicalByInput.has(value)) throw new Error(`ENOENT: ${value}`);
      return canonicalByInput.get(value);
    },
  };

  for (const [candidate, stored] of [
    ['c:\\repo', 'C:\\Repo'],
    ['c:\\', 'C:\\'],
    ['\\\\server\\share\\repo', '\\\\Server\\Share\\Repo'],
  ]) {
    const result = classifyProjectRootBinding(candidate, stored, deps);
    assert.equal(result.ok, true, `${candidate} and ${stored} should be one canonical identity`);
    assert.equal(result.mismatch_class, 'match');
  }

  assert.equal(classifyProjectRootBinding('D:\\Repo', 'C:\\Repo', deps).mismatch_class, 'fenced');
  assert.throws(
    () => assertProjectRootBinding('D:\\Repo', { project: { root: 'C:\\Repo' } }, deps),
    /PROJECT_ROOT_FENCED/
  );
});

test('projectRootDigest is the stable sha256 digest of the stored lexical root', () => {
  const storedRoot = 'C:\\Repo\\Legacy-Case';
  const expected = createHash('sha256').update(storedRoot).digest('hex');
  assert.equal(projectRootDigest(storedRoot), expected);
  assert.notEqual(projectRootDigest(storedRoot), projectRootDigest(storedRoot.toLowerCase()));
});

test('source guard detects namespace, alias/reference, and dynamic recovery-reader access', () => {
  const hostileSources = [
    `import * as state from './state.mjs'; state.readStateForRootRecovery(root, runId);`,
    `const recover = state['readStateForRootRecovery']; recover(root, runId);`,
    `const { readStateForRootRecovery: recover } = await import('./state.mjs');`,
  ];
  for (const source of hostileSources) {
    assert.equal(recoveryReaderReferencePattern.test(source), true, `must detect: ${source}`);
  }
});

test('source guard detects generic root-check bypass spellings', () => {
  const hostileSources = [
    'const skipRootCheck = true;',
    'const bypassProjectRootBinding = true;',
    'const disable_root_check = true;',
    `const option = 'ignore-project-root-check';`,
  ];
  for (const source of hostileSources) {
    assert.equal(genericRootBypassPattern.test(source), true, `must detect: ${source}`);
  }
});

test('only the state export and dedicated recovery module may reference readStateForRootRecovery', () => {
  const violations = [];
  for (const path of sourceFiles(join(REPO_ROOT, 'scripts'))) {
    const rel = portableRelative(REPO_ROOT, path);
    const source = readFileSync(path, 'utf8');
    const references = source.match(/\breadStateForRootRecovery\b/g) || [];
    if (rel === 'scripts/lib/state.mjs') {
      const definitions = source.match(/\bexport\s+function\s+readStateForRootRecovery\s*\(/g) || [];
      if (references.length !== 1 || definitions.length !== 1) {
        violations.push(`${rel}: expected exactly one export definition, found ${references.length} references/${definitions.length} definitions`);
      }
    } else if (rel !== 'scripts/lib/project-root-recovery.mjs' && references.length > 0) {
      violations.push(`${rel}: ${references.length} forbidden recovery-reader reference(s)`);
    }
  }
  assert.deepEqual(violations, []);
});

test('scripts contain no generic project-root binding bypass tokens', () => {
  const violations = sourceFiles(join(REPO_ROOT, 'scripts'))
    .map(path => ({ path: relative(REPO_ROOT, path), source: readFileSync(path, 'utf8') }))
    .filter(({ source }) => genericRootBypassPattern.test(source))
    .map(({ path }) => path);
  assert.deepEqual(violations, []);
});
