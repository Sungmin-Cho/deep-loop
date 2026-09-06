import { startExecution, returnExecution } from './execution.mjs';
import { isGoalDriven } from './goal-contract.mjs';
import { fileURLToPath } from 'node:url';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  captureReconciledRunSnapshot,
  findRoot,
  pauseRun,
  runDir,
  withReconciledMutationLock,
} from './state.mjs';
import {
  codexCheckerClaimHash,
  recordCost,
  isMeasuredOneTurnUsage,
  settleCodexProcessCost,
  settleCodexPreflightCost,
  settleTerminalCodexMakerCost,
} from './budget.mjs';
import { respawn, respawnGate, resolveSpawnMode } from './respawn.mjs';
import { headlessSpawn } from './spawn-driver.mjs';
import { ensureCodexPreflight } from './codex-preflight.mjs';
import {
  revalidateTrustedRuntimeExecutable,
  resolveAuthenticatedCodexHome,
} from './runtime-executable.mjs';
import { buildMinimalCodexEnv } from './codex-runtime.mjs';
import { buildLaunchCommand } from './runtime-descriptor.mjs';
import { runtimeCapability, sessionRuntime } from './runtime.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import {
  blockIndependentReview,
  claimIndependentReview,
  findPendingIndependentChecker,
  revalidateIndependentReviewClaim,
} from './review.mjs';
import {
  importReviewViaCli,
  resolveTrustedCheckerSkill,
  runIndependentCodexChecker,
  sameCheckerIdentity,
} from './codex-checker.mjs';
import { emitHandoff } from './handoff.mjs';
import { nextAction } from './next-action.mjs';
import { STREAM_LIMITS } from './usage-parser.mjs';
import {
  listProcessUsageReceipts,
  makeProcessUsageReceiptDescriptor,
  removeProcessUsageReceipt,
} from './preflight-receipt-journal.mjs';
import { resolveRunContext } from './run-context.mjs';

const DEFAULT_DEEP_LOOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESUME_SKILL_MAX_BYTES = 4 * 1024 * 1024;
const TRUSTED_NODE_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const HOST_LOCK_GRACE_MS = 15 * 60 * 1000;
const HOST_LOCK_CRASH_GRACE_MS = 30 * 1000;
const NODE_TIMER_MAX_MS = 2_147_483_647;
const CHECKER_IMPORT_TIMEOUT_MS = 30_000;
const captureFreshLoop = (root, runId) => captureReconciledRunSnapshot(root, runId).data;

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function inspectDirectoryNode(path) {
  const lexical = resolve(path);
  const before = lstatSync(lexical, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('directory must be non-symlink');
  const canonical = (realpathSync.native || realpathSync)(lexical);
  if (resolve(canonical) !== lexical) throw new Error('directory must already be canonical');
  const after = lstatSync(canonical, { bigint: true });
  if (after.isSymbolicLink() || !after.isDirectory()
    || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode) {
    throw new Error('directory identity changed');
  }
  return {
    canonical_path: canonical,
    device: String(after.dev),
    inode: String(after.ino),
    mode: String(after.mode),
  };
}

function inspectRegularFileIdentity(path, { maxBytes = RESUME_SKILL_MAX_BYTES } = {}) {
  const lexical = resolve(path);
  const before = lstatSync(lexical, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o444n) === 0n
    || before.size > BigInt(maxBytes)) {
    throw new Error('file must be a bounded readable non-symlink');
  }
  const canonical = (realpathSync.native || realpathSync)(lexical);
  const canonicalStat = lstatSync(canonical, { bigint: true });
  if (resolve(canonical) !== lexical || canonicalStat.isSymbolicLink() || !canonicalStat.isFile()
    || !sameFileIdentity(before, canonicalStat)) {
    throw new Error('file identity changed during canonicalization');
  }
  let fd;
  let bytes;
  try {
    fd = openSync(canonical, 'r');
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(canonicalStat, opened)) throw new Error('file changed before read');
    bytes = readFileSync(fd);
    const read = fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(opened, read)) throw new Error('file changed during read');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const after = lstatSync(canonical, { bigint: true });
  if (!sameFileIdentity(canonicalStat, after)) throw new Error('file changed after read');
  return {
    canonical_path: canonical,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    device: String(after.dev),
    inode: String(after.ino),
    mode: String(after.mode),
    size: String(after.size),
    mtime_ns: String(after.mtimeNs),
    ctime_ns: String(after.ctimeNs),
  };
}

function hostLockTtl(timeoutMs) {
  const bounded = Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= NODE_TIMER_MAX_MS
    ? timeoutMs
    : DEFAULT_PROCESS_TIMEOUT_MS;
  return Math.min(Number.MAX_SAFE_INTEGER, bounded * 3 + HOST_LOCK_GRACE_MS);
}

function defaultProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireHeadlessHostLock(root, runId, {
  timeoutMs,
  wallNow = Date.now,
  processAlive = defaultProcessAlive,
  pid = process.pid,
} = {}) {
  const lockPath = join(runDir(root, runId), '.headless-host.lock');
  const ownerPath = join(lockPath, 'owner');
  const token = randomUUID();
  const ttlMs = hostLockTtl(timeoutMs);
  const ownerPayload = JSON.stringify({ token, pid, started_at_ms: wallNow() });
  let acquired = false;
  try {
    // The kernel lock coordinates only this small metadata transaction. It is released before authentication,
    // preflight, cost recording, maker CAS, or any runtime process, so normal kernel mutations cannot deadlock.
    acquired = withReconciledMutationLock(root, runId, () => {
      try {
        mkdirSync(lockPath, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const ageMs = wallNow() - statSync(lockPath).mtimeMs;
        let observedOwner = null;
        try { observedOwner = readFileSync(ownerPath, 'utf8'); } catch (inspectError) {
          if (inspectError?.code !== 'ENOENT') throw inspectError;
        }
        let owner = null;
        try {
          const parsed = JSON.parse(observedOwner);
          if (parsed && typeof parsed.token === 'string' && parsed.token.length > 0
            && Number.isInteger(parsed.pid) && parsed.pid > 0) owner = parsed;
        } catch { /* malformed metadata is treated like an owner-missing partial acquire */ }
        let alive = true;
        if (owner && ageMs > HOST_LOCK_CRASH_GRACE_MS) {
          try { alive = processAlive(owner.pid); } catch { alive = true; }
        }
        const reclaimable = Number.isFinite(ageMs)
          && (ageMs > ttlMs
            || (ageMs > HOST_LOCK_CRASH_GRACE_MS && (!owner || !alive)));
        if (!reclaimable) return false;
        try {
          if (observedOwner != null) unlinkSync(ownerPath);
          rmdirSync(lockPath);
          mkdirSync(lockPath, { mode: 0o700 });
        } catch {
          return false;
        }
      }
      try {
        writeFileSync(ownerPath, ownerPayload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      } catch (error) {
        try { rmdirSync(lockPath); } catch { /* best effort */ }
        throw error;
      }
      return true;
    });
  } catch (error) {
    // This is a direct library call, so it intentionally never sees the public
    // CLI's `{ reason: 'lock-busy', retryable: true }` envelope.  Treat the
    // same transient lock contention as an unavailable host lock here.
    if (String(error?.message || error).startsWith('LOCK_BUSY')) return null;
    throw error;
  }
  if (!acquired) return null;
  let released = false;
  return {
    release() {
      if (released) return;
      withReconciledMutationLock(root, runId, () => {
        let current;
        try { current = readFileSync(ownerPath, 'utf8'); } catch (error) {
          if (error?.code === 'ENOENT') return;
          throw error;
        }
        if (current !== ownerPayload) return;
        unlinkSync(ownerPath);
        rmdirSync(lockPath);
      }, { retries: 2_000, backoffMs: 5 });
      released = true;
    },
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function terminal(loop) {
  return loop.status === 'completed' || loop.status === 'stopped';
}

function exactChildAcquired(loop, childRunId) {
  const child = (loop.session_chain?.sessions || []).find((session) => session.run_id === childRunId);
  return typeof child?.started_at === 'string' && child.started_at.length > 0;
}

function pendingHandoff(loop) {
  const lease = loop.session_chain?.lease || {};
  return (lease.handoff_phase === 'emitted' || lease.handoff_phase === 'spawned')
    && typeof lease.handoff_child_run_id === 'string'
    && lease.handoff_child_run_id.length > 0;
}

function inProgressIndependentChecker(loop) {
  return (loop.episodes || []).find(episode => episode?.role === 'checker'
    && episode.status === 'in_progress'
    && episode.requires_independent_session === true) || null;
}

function checkerCapabilityReason(error) {
  const message = String(error?.message || error);
  if (message.includes('checker-skill-ambiguous')) return 'checker-skill-ambiguous';
  if (message.includes('checker-skill-unavailable')) return 'checker-skill-unavailable';
  return 'checker-skill-invalid';
}

function accountingFailureReason(error) {
  const message = String(error?.message || error);
  if (message.includes('RUN_TERMINAL')) return 'terminal';
  if (message.includes('LEASE_FENCED')) return 'fenced';
  throw error;
}

function preflightAccountingMode(preflight) {
  const hasSettled = Object.hasOwn(preflight, 'accounting_settled');
  const hasReceipts = Object.hasOwn(preflight, 'accounting_receipts');
  if (!hasSettled && !hasReceipts) return 'legacy';
  if (!hasSettled || !hasReceipts || typeof preflight.accounting_settled !== 'boolean'
    || !Array.isArray(preflight.accounting_receipts)
    || preflight.accounting_receipts.some(id => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id))
    || (preflight.ok
      ? preflight.accounting_receipts.length !== 2
      : ![1, 2].includes(preflight.accounting_receipts.length))
    || (preflight.ok && !preflight.accounting_settled)) return 'invalid';
  return 'receipts';
}

function preflightAccountingEvidence(mode, preflight, settledReceiptIds) {
  if (mode === 'legacy') return settledReceiptIds.length === 0;
  if (mode !== 'receipts' || settledReceiptIds.length > preflight.accounting_receipts.length) return false;
  if (settledReceiptIds.some((id, index) => id !== preflight.accounting_receipts[index])) return false;
  return preflight.accounting_settled
    ? settledReceiptIds.length === preflight.accounting_receipts.length
    : true;
}

function terminalAccountingFailureReason(error) {
  const message = String(error?.message || error);
  if (message.startsWith('LOG_TAMPERED')) return 'log-tampered';
  if (message.startsWith('LEASE_FENCED')) return 'fenced';
  if (message.startsWith('RUNTIME_FENCED')) return 'runtime-fenced';
  if (message.startsWith('TERMINAL_ACCOUNTING_MISMATCH')) return 'usage-mismatch';
  if (message.startsWith('TERMINAL_ACCOUNTING_DUPLICATE')) return 'duplicate-receipt';
  return 'settlement-invalid';
}

function validReceiptSettlement(result) {
  return result != null && typeof result === 'object' && !Array.isArray(result)
    && result.ok === true && typeof result.recorded === 'boolean'
    && (result.recorded ? result.reason === 'recorded' : result.reason === 'already-recorded');
}

function processAccountingFailureReason(error) {
  const message = String(error?.message || error);
  if (message.startsWith('LOG_TAMPERED')) return 'log-tampered';
  if (message.startsWith('LEASE_FENCED')) return 'fenced';
  if (message.startsWith('RUNTIME_FENCED')) return 'runtime-fenced';
  if (message.includes('DUPLICATE')) return 'duplicate-receipt';
  if (message.includes('MISMATCH')) return 'receipt-mismatch';
  if (message.includes('CLEANUP')) return 'receipt-cleanup-failed';
  return 'settlement-invalid';
}

function pauseWithFreshFence(root, runId, { reason, expect, now }) {
  const attempt = (fence) => pauseRun(root, runId, {
    reason,
    mode: 'preserve',
    expect: fence,
    now,
  });
  try {
    attempt(expect);
    return 'paused';
  } catch (error) {
    const message = String(error?.message || error);
    if (message.startsWith('RUN_TERMINAL')) return 'terminal';
    if (!message.startsWith('LEASE_FENCED')) throw error;
  }
  const freshLoop = captureFreshLoop(root, runId);
  if (terminal(freshLoop)) return 'terminal';
  const freshLease = freshLoop.session_chain?.lease || {};
  try {
    attempt({ owner: freshLease.owner_run_id, generation: freshLease.generation });
    return 'paused';
  } catch (error) {
    const message = String(error?.message || error);
    if (message.startsWith('RUN_TERMINAL')) return 'terminal';
    if (message.startsWith('LEASE_FENCED')) return 'raced';
    throw error;
  }
}

function pauseWithOriginalFence(root, runId, { reason, expect, now }) {
  try {
    pauseRun(root, runId, { reason, mode: 'preserve', expect, now });
    return 'paused';
  } catch (error) {
    const message = String(error?.message || error);
    if (message.startsWith('RUN_TERMINAL')) return 'terminal';
    if (message.startsWith('LEASE_FENCED')) return 'fenced';
    throw error;
  }
}

function driveIndependentChecker({
  root,
  runId,
  initialLoop,
  projectRoot,
  runtime,
  parentFence,
  now,
  clock,
  timeoutMs,
  env,
  deepLoopRoot,
  preflightFn,
  recordCostFn,
  settlePreflightCostFn,
  settleProcessCostFn,
  makeProcessReceiptDescriptorFn,
  removeProcessReceiptFn,
  revalidateExecutable,
  resolveCodexHome,
  inspectDirectory,
  inspectResumeSkill,
  resolveCheckerSkill,
  checkerRunFn,
  checkerImportFn,
  emitHandoffFn,
  claimReviewFn,
  blockReviewFn,
  revalidateClaimFn,
  attemptIdFactory,
}) {
  let actionNow = now;
  const stranded = inProgressIndependentChecker(initialLoop);
  if (stranded) {
    return {
      ok: false,
      action: 'checker-in-progress',
      reason: 'needs-human-no-retry',
      checkerEpisodeId: stranded.id,
      attemptId: stranded.attempt_id ?? null,
    };
  }
  const pending = findPendingIndependentChecker(initialLoop);
  if (!pending || !runtimeCapability(runtime, 'unattended_checker')) return null;
  if (initialLoop.session_chain?.lease?.resume_policy === 'human') {
    return runtimeCapability(runtime, 'measured_headless')
      ? { ok: true, skipped: true, reason: 'human-resume-policy' }
      : { ok: false, action: 'unmeasured-runtime' };
  }
  if (initialLoop.status !== 'running') {
    return { ok: false, action: 'terminal', reason: initialLoop.status };
  }

  const parentOwner = parentFence.owner;
  const parentGeneration = parentFence.generation;
  const claimAndBlock = (reason) => {
    let claimed;
    try {
      claimed = claimReviewFn(projectRoot, runId, {
        episodeId: pending.id,
        fence: { owner: parentOwner, generation: parentGeneration, intent: 'business' },
        attemptIdFactory,
        now: actionNow,
      });
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes('LEASE_FENCED') || message.includes('RUN_TERMINAL')) {
        return { ok: false, action: message.includes('RUN_TERMINAL') ? 'terminal' : 'fenced', reason };
      }
      const raceLoop = captureFreshLoop(projectRoot, runId);
      const raced = inProgressIndependentChecker(raceLoop);
      if (raced) {
        return {
          ok: false, action: 'checker-in-progress', reason: 'needs-human-no-retry',
          checkerEpisodeId: raced.id, attemptId: raced.attempt_id ?? null,
        };
      }
      const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
        reason: 'checker-claim-failed', expect: parentFence, now: actionNow,
      });
      return {
        ok: false,
        action: pauseOutcome === 'fenced' ? 'fenced' : (pauseOutcome === 'terminal' ? 'terminal' : 'checker-claim-failed'),
        reason: 'checker-claim-failed',
      };
    }
    if (!claimed?.ok) {
      return {
        ok: false,
        action: 'checker-in-progress',
        reason: 'needs-human-no-retry',
        checkerEpisodeId: pending.id,
        attemptId: null,
      };
    }
    try {
      blockReviewFn(projectRoot, runId, {
        episodeId: pending.id,
        attemptId: claimed.attemptId,
        reason,
        fence: { owner: parentOwner, generation: parentGeneration, intent: 'business' },
      });
      return {
        ok: false,
        action: 'checker-blocked',
        reason,
        checkerEpisodeId: pending.id,
        attemptId: claimed.attemptId,
      };
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes('RUN_TERMINAL')) {
        return { ok: false, action: 'terminal', reason, recorded: false };
      }
      if (message.includes('LEASE_FENCED') || message.includes('REVIEW_BLOCK_CLAIM_MISMATCH')) {
        return { ok: false, action: 'checker-stranded', reason, recorded: false };
      }
      throw error;
    }
  };

  const preliminaryGate = respawnGate(initialLoop, { now: actionNow });
  if (!preliminaryGate.ok) {
    const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
      reason: `checker-gate:${preliminaryGate.reason}`,
      expect: parentFence,
      now: actionNow,
    });
    return {
      ok: false,
      action: pauseOutcome === 'fenced' ? 'fenced' : (pauseOutcome === 'terminal' ? 'terminal' : 'gate-blocked'),
      reason: preliminaryGate.reason,
    };
  }

  // A generic subagent descriptor remains valid for attended/manual review, but has no
  // trusted unattended Codex skill. Claim once so future host ticks cannot retry it.
  if (pending.plugin === 'subagent-checker') return claimAndBlock('checker-capability-unsupported');
  if (pending.plugin !== 'deep-review') return claimAndBlock('checker-capability-unsupported');

  const initialApproval = initialLoop.autonomy?.runtime_executable_approval;
  const outputSchemaPath = join(deepLoopRoot, 'schemas', 'review-import.schema.json');
  const kernelPath = join(deepLoopRoot, 'scripts', 'deep-loop.mjs');
  const resumeSkillPath = join(deepLoopRoot, 'skills', 'deep-loop-resume', 'SKILL.md');
  let executable;
  let codexHome;
  let checkerEnv;
  let projectDirectorySnapshot;
  let pluginDirectorySnapshot;
  let resumeSkillSnapshot;
  let outputSchemaSnapshot;
  let kernelSnapshot;
  let nodeSnapshot;
  let checkerSkillSnapshot;
  try {
    executable = revalidateExecutable(initialApproval);
  } catch {
    const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
      reason: 'checker-executable-invalid', expect: parentFence, now: actionNow,
    });
    return { ok: false, action: pauseOutcome === 'fenced' ? 'fenced' : 'preflight-failed', reason: 'executable-invalid' };
  }
  try {
    codexHome = resolveCodexHome({ env, platform: executable.platform });
    checkerEnv = buildMinimalCodexEnv({
      platform: executable.platform,
      sourceEnv: env,
      codexHome: codexHome.canonical_path,
      runId,
      projectRoot,
      owner: pending.id,
      generation: parentGeneration,
    });
    projectDirectorySnapshot = inspectDirectory(projectRoot);
    pluginDirectorySnapshot = inspectDirectory(deepLoopRoot);
    resumeSkillSnapshot = inspectResumeSkill(resumeSkillPath);
    outputSchemaSnapshot = inspectResumeSkill(outputSchemaPath);
    kernelSnapshot = inspectResumeSkill(kernelPath);
    nodeSnapshot = inspectResumeSkill(process.execPath, { maxBytes: TRUSTED_NODE_MAX_BYTES });
  } catch {
    const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
      reason: 'checker-isolation-invalid', expect: parentFence, now: actionNow,
    });
    return { ok: false, action: pauseOutcome === 'fenced' ? 'fenced' : 'preflight-failed', reason: 'checker-isolation-invalid' };
  }
  try {
    checkerSkillSnapshot = resolveCheckerSkill({ codexHome: codexHome.canonical_path });
  } catch (error) {
    return claimAndBlock(checkerCapabilityReason(error));
  }

  let preflight;
  const settledReceiptIds = [];
  try {
    preflight = preflightFn({
      projectRoot,
      runId,
      executableIdentity: initialApproval,
      codexHomeIdentity: codexHome,
      deepLoopRoot,
      resumeSkillPath,
      sourceEnv: env,
      owner: parentOwner,
      generation: parentGeneration,
      model: initialLoop.autonomy?.session_model ?? null,
      effort: initialLoop.autonomy?.session_effort ?? null,
      timeoutMs,
      goalDriven: isGoalDriven(initialLoop),
      revalidateExecutable,
      resolveCodexHome,
      settleAccountingReceipt: receipt => {
        const result = settlePreflightCostFn(projectRoot, runId, {
          receipt,
          fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
        });
        if (result?.ok === true) settledReceiptIds.push(receipt?.receipt_id);
        return result;
      },
      settleOrphanAccountingReceipt: receipt => settlePreflightCostFn(projectRoot, runId, {
        receipt,
        fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
      }),
    });
  } catch {
    preflight = null;
  }
  const accountingMode = preflight != null && typeof preflight === 'object' && !Array.isArray(preflight)
    ? preflightAccountingMode(preflight)
    : 'invalid';
  const validPreflight = preflight != null
    && typeof preflight === 'object'
    && !Array.isArray(preflight)
    && typeof preflight.ok === 'boolean'
    && Array.isArray(preflight.measured_usage)
    && accountingMode !== 'invalid'
    && preflightAccountingEvidence(accountingMode, preflight, settledReceiptIds)
    && (preflight.ok
      ? typeof preflight.cache_hit === 'boolean'
        && (preflight.cache_hit ? preflight.measured_usage.length === 0 : preflight.measured_usage.length === 2)
      : typeof preflight.reason === 'string' && preflight.reason.length > 0
        && preflight.pause_mode === 'preserve' && preflight.measured_usage.length <= 2);
  if (!validPreflight) {
    const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
      reason: 'checker-preflight-invalid', expect: parentFence, now: actionNow,
    });
    return { ok: false, action: pauseOutcome === 'fenced' ? 'fenced' : 'preflight-failed', reason: 'preflight-invalid' };
  }
  if (preflight.measured_usage.some(usage => !isMeasuredOneTurnUsage(usage))) {
    const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
      reason: 'checker-preflight-usage-invalid', expect: parentFence, now: actionNow,
    });
    return { ok: false, action: pauseOutcome === 'fenced' ? 'fenced' : 'preflight-failed', reason: 'preflight-usage-invalid' };
  }
  for (const usage of accountingMode === 'legacy' ? preflight.measured_usage : []) {
    try {
      recordCostFn(projectRoot, runId, {
        turns: usage.num_turns,
        tokens: usage.tokens,
        fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
      });
    } catch (error) {
      return { ok: false, action: accountingFailureReason(error), reason: 'preflight-accounting-failed' };
    }
  }
  if (!preflight.ok) {
    const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
      reason: preflight.reason, expect: parentFence, now: actionNow,
    });
    return { ok: false, action: pauseOutcome === 'fenced' ? 'fenced' : 'preflight-failed', reason: preflight.reason };
  }

  const postCostLoop = captureFreshLoop(projectRoot, runId);
  const postLease = postCostLoop.session_chain?.lease || {};
  if (postLease.owner_run_id !== parentOwner || postLease.generation !== parentGeneration
    || sessionRuntime(postCostLoop) !== 'codex' || canonicalProjectRoot(postCostLoop.project.root) !== projectRoot) {
    return { ok: false, action: 'fenced', reason: 'checker-post-cost-fenced' };
  }
  actionNow = clock();
  const postGate = respawnGate(postCostLoop, { now: actionNow });
  if (!postGate.ok) {
    const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
      reason: `checker-gate:${postGate.reason}`, expect: parentFence, now: actionNow,
    });
    return { ok: false, action: pauseOutcome === 'fenced' ? 'fenced' : 'gate-blocked', reason: postGate.reason };
  }

  let claimed;
  try {
    claimed = claimReviewFn(projectRoot, runId, {
      episodeId: pending.id,
      fence: { owner: parentOwner, generation: parentGeneration, intent: 'business' },
      attemptIdFactory,
      now: actionNow,
    });
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('LEASE_FENCED')) return { ok: false, action: 'fenced', reason: 'checker-claim-failed' };
    if (message.includes('RUN_TERMINAL')) return { ok: false, action: 'terminal', reason: 'checker-claim-failed' };
    const raceLoop = captureFreshLoop(projectRoot, runId);
    const raced = inProgressIndependentChecker(raceLoop);
    if (raced) {
      return {
        ok: false, action: 'checker-in-progress', reason: 'needs-human-no-retry',
        checkerEpisodeId: raced.id, attemptId: raced.attempt_id ?? null,
      };
    }
    const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
      reason: 'checker-claim-failed', expect: parentFence, now: actionNow,
    });
    return {
      ok: false,
      action: pauseOutcome === 'fenced' ? 'fenced' : (pauseOutcome === 'terminal' ? 'terminal' : 'checker-claim-failed'),
      reason: 'checker-claim-failed',
    };
  }
  if (!claimed?.ok) {
    return {
      ok: false, action: 'checker-in-progress', reason: 'needs-human-no-retry',
      checkerEpisodeId: pending.id, attemptId: null,
    };
  }
  const blockClaim = (reason) => {
    try {
      blockReviewFn(projectRoot, runId, {
        episodeId: pending.id,
        attemptId: claimed.attemptId,
        reason,
        fence: { owner: parentOwner, generation: parentGeneration, intent: 'business' },
      });
      return {
        ok: false, action: 'checker-blocked', reason,
        checkerEpisodeId: pending.id, attemptId: claimed.attemptId,
      };
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes('RUN_TERMINAL')) return { ok: false, action: 'terminal', reason, recorded: false };
      if (message.includes('LEASE_FENCED') || message.includes('REVIEW_BLOCK_CLAIM_MISMATCH')) {
        return { ok: false, action: 'checker-stranded', reason, recorded: false };
      }
      throw error;
    }
  };
  const settleMeasuredFailure = (reason, usage, usageReceipt = null) => {
    const blocked = blockClaim(reason);
    let pauseOutcome = null;
    if (blocked.action === 'checker-stranded') {
      pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
        reason, expect: parentFence, now: actionNow,
      });
    }
    let recorded = false;
    let accountingReason = null;
    try {
      if (usageReceipt != null) {
        const settlement = settleProcessCostFn(projectRoot, runId, {
          receipt: usageReceipt,
          fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
        });
        if (!validReceiptSettlement(settlement)) throw new Error('PROCESS_ACCOUNTING_PROTOCOL_INVALID');
        recorded = true;
        removeProcessReceiptFn({ receipt: usageReceipt, descriptor: checkerUsageReceiptDescriptor });
      } else {
        recordCostFn(projectRoot, runId, {
          turns: usage.num_turns,
          tokens: usage.tokens,
          fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
        });
        recorded = true;
      }
    } catch (error) {
      accountingReason = usageReceipt == null
        ? accountingFailureReason(error)
        : processAccountingFailureReason(error);
    }
    return {
      ...blocked,
      ...(pauseOutcome === 'terminal' ? { action: 'terminal' }
        : pauseOutcome === 'fenced' ? { action: 'fenced' } : {}),
      recorded,
      ...(accountingReason ? { accounting_reason: accountingReason } : {}),
    };
  };

  const identityFresh = () => {
    try {
      const freshLoop = captureFreshLoop(projectRoot, runId);
      const freshLease = freshLoop.session_chain?.lease || {};
      const freshExecutable = revalidateExecutable(freshLoop.autonomy?.runtime_executable_approval);
      const freshHome = resolveCodexHome({ env, expectedIdentity: codexHome, platform: freshExecutable.platform });
      const freshEnv = buildMinimalCodexEnv({
        platform: freshExecutable.platform,
        sourceEnv: env,
        codexHome: freshHome.canonical_path,
        runId,
        projectRoot,
        owner: pending.id,
        generation: parentGeneration,
      });
      const freshCheckerSkill = resolveCheckerSkill({ codexHome: freshHome.canonical_path });
      const freshClaim = revalidateClaimFn(projectRoot, runId, {
        episodeId: pending.id,
        attemptId: claimed.attemptId,
        fence: { owner: parentOwner, generation: parentGeneration, intent: 'business' },
      });
      const checker = freshLoop.episodes.find(episode => episode.id === pending.id);
      return sessionRuntime(freshLoop) === 'codex'
        && canonicalProjectRoot(freshLoop.project.root) === projectRoot
        && freshLease.owner_run_id === parentOwner
        && freshLease.generation === parentGeneration
        && checker?.status === 'in_progress'
        && checker.attempt_id === claimed.attemptId
        && sameValue(checker.review_claim, claimed.claim)
        && sameValue(freshClaim.claim, claimed.claim)
        && sameValue(freshLoop.autonomy?.runtime_executable_approval, initialApproval)
        && sameValue(freshExecutable, executable)
        && freshLoop.autonomy?.session_model === initialLoop.autonomy?.session_model
        && freshLoop.autonomy?.session_effort === initialLoop.autonomy?.session_effort
        && sameValue(freshEnv, checkerEnv)
        && sameValue(inspectDirectory(projectRoot), projectDirectorySnapshot)
        && sameValue(inspectDirectory(deepLoopRoot), pluginDirectorySnapshot)
        && sameValue(inspectResumeSkill(resumeSkillPath), resumeSkillSnapshot)
        && sameValue(inspectResumeSkill(outputSchemaPath), outputSchemaSnapshot)
        && sameValue(inspectResumeSkill(kernelPath), kernelSnapshot)
        && sameValue(inspectResumeSkill(process.execPath, { maxBytes: TRUSTED_NODE_MAX_BYTES }), nodeSnapshot)
        && sameCheckerIdentity(freshCheckerSkill, checkerSkillSnapshot);
    } catch {
      return false;
    }
  };
  if (!identityFresh()) return blockClaim('checker-identity-drift');

  let checkerUsageReceiptDescriptor;
  try {
    checkerUsageReceiptDescriptor = makeProcessReceiptDescriptorFn({
      root: projectRoot,
      runId,
      processKind: 'checker',
      context: {
        origin_owner: parentOwner,
        origin_generation: parentGeneration,
        checker_episode_id: pending.id,
        attempt_id: claimed.attemptId,
        target_maker: claimed.claim.target_maker,
        claim_hash: codexCheckerClaimHash(claimed.claim),
      },
    });
  } catch {
    return blockClaim('checker-accounting-receipt-invalid');
  }

  let checkerResult;
  const goalHandle = `codex-checker:${claimed.attemptId}`;
  try {
    if (isGoalDriven(initialLoop)) startExecution(projectRoot, runId, { episodeId: pending.id, attemptId: claimed.attemptId,
      handle: goalHandle, fence: parentFence, now: clock() });
    checkerResult = checkerRunFn({
      executable: executable.canonical_path,
      projectRoot,
      checkerSkillPath: checkerSkillSnapshot.skill.canonical_path,
      outputSchemaPath,
      contract: {
        schema_version: '1.0',
        reviewer_id: claimed.claim.reviewer_id,
        checker_episode_id: claimed.claim.checker_episode_id,
        target_maker: claimed.claim.target_maker,
        attempt_id: claimed.attemptId,
        workstream_id: claimed.claim.workstream_id,
        point: claimed.claim.point,
        project_root: claimed.claim.project_root,
        artifacts: claimed.claim.artifacts,
        ...(claimed.claim.evidence !== undefined ? { evidence: claimed.claim.evidence } : {}),
        ...(claimed.claim.contract !== undefined ? { contract: claimed.claim.contract } : {}),
      },
      env: checkerEnv,
      model: initialLoop.autonomy?.session_model ?? null,
      effort: initialLoop.autonomy?.session_effort ?? null,
      timeoutMs,
      usageReceipt: checkerUsageReceiptDescriptor,
      goalDriven: isGoalDriven(initialLoop),
    });
  } catch {
    checkerResult = { ok: false, reason: 'checker-process-error' };
  }
  if (checkerResult?.reason === 'checker-final-message-invalid'
    && isMeasuredOneTurnUsage(checkerResult.usage)) {
    return settleMeasuredFailure(
      'checker-process-failed',
      checkerResult.usage,
      checkerResult.usageReceipt ?? null,
    );
  }
  if (!checkerResult || checkerResult.ok !== true
    || !isMeasuredOneTurnUsage(checkerResult.usage)
    || !Buffer.isBuffer(checkerResult.finalMessage)
    || checkerResult.finalMessage.length === 0
    || checkerResult.finalMessage.length > STREAM_LIMITS.finalMessageBytes) {
    return blockClaim('checker-process-failed');
  }
  if (!identityFresh()) {
    return settleMeasuredFailure(
      'checker-identity-drift',
      checkerResult.usage,
      checkerResult.usageReceipt ?? null,
    );
  }

  let imported;
  try {
    if (isGoalDriven(initialLoop)) {
      if (checkerResult.termination?.confirmed !== true || checkerResult.process_group?.quiescence_confirmed !== true) {
        return settleMeasuredFailure('checker-termination-unconfirmed', checkerResult.usage, checkerResult.usageReceipt ?? null);
      }
      const rel = `.deep-loop/runs/${runId}/host-checkers/${claimed.attemptId}`;
      const directory = join(projectRoot, rel);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const outputHash = createHash('sha256').update(checkerResult.finalMessage).digest('hex');
      writeFileSync(join(directory, 'stdout.json'), checkerResult.finalMessage, { flag: 'wx', mode: 0o600 });
      writeFileSync(join(directory, 'receipt.json'), JSON.stringify({attempt_id:claimed.attemptId,
        result:{state:'SUCCEEDED',exit_status:0,termination_confirmed:true,stdout_path:`${rel}/stdout.json`,output_sha256:outputHash}}), {flag:'wx',mode:0o600});
      returnExecution(projectRoot, runId, {episodeId:pending.id,attemptId:claimed.attemptId,artifacts:[],fence:parentFence,now:clock(),
        observation:{source:'supervisor-receipt',state:'succeeded',handle:goalHandle,reference:`${rel}/receipt.json`,output_sha256:outputHash}});
    }
    imported = checkerImportFn({
      processExecutable: process.execPath,
      kernelPath,
      projectRoot,
      runId,
      owner: parentOwner,
      generation: parentGeneration,
      timeoutMs: CHECKER_IMPORT_TIMEOUT_MS,
      env: checkerEnv,
    }, checkerResult.finalMessage);
  } catch {
    imported = { ok: false, reason: 'checker-import-failed' };
  }
  if (imported?.ok) {
    try {
      const proofLoop = captureFreshLoop(projectRoot, runId);
      const proofChecker = proofLoop.episodes.find(episode => episode.id === pending.id);
      if (!['approved', 'rejected'].includes(proofChecker?.status)
        || proofChecker.review_source !== 'imported-stdin'
        || proofChecker.attempt_id !== claimed.attemptId
        || !sameValue(proofChecker.review_claim, claimed.claim)) {
        imported = { ok: false, reason: 'checker-import-proof-missing' };
      }
    } catch {
      imported = { ok: false, reason: 'checker-import-proof-missing' };
    }
  }
  if (!imported?.ok) {
    return settleMeasuredFailure(
      'checker-import-failed',
      checkerResult.usage,
      checkerResult.usageReceipt ?? null,
    );
  }

  let recorded = false;
  let accountingReason = null;
  try {
    if (checkerResult.usageReceipt != null) {
      const settlement = settleProcessCostFn(projectRoot, runId, {
        receipt: checkerResult.usageReceipt,
        fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
      });
      if (!validReceiptSettlement(settlement)) throw new Error('PROCESS_ACCOUNTING_PROTOCOL_INVALID');
      recorded = true;
      removeProcessReceiptFn({
        receipt: checkerResult.usageReceipt,
        descriptor: checkerUsageReceiptDescriptor,
      });
    } else {
      recordCostFn(projectRoot, runId, {
        turns: checkerResult.usage.num_turns,
        tokens: checkerResult.usage.tokens,
        fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
      });
      recorded = true;
    }
  } catch (error) {
    accountingReason = checkerResult.usageReceipt == null
      ? accountingFailureReason(error)
      : processAccountingFailureReason(error);
  }

  let continuation = false;
  let continuationFailure = null;
  const afterAccounting = captureFreshLoop(projectRoot, runId);
  if (recorded && afterAccounting.status === 'running') {
    actionNow = clock();
    const selected = nextAction(afterAccounting, { now: actionNow, unattended: true }).action;
    if (selected?.type === 'await_human'
      && (selected.reason === 'budget' || selected.reason === 'breaker')) {
      const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
        reason: `checker-gate:${selected.reason}`,
        expect: parentFence,
        now: actionNow,
      });
      return {
        ok: false,
        action: pauseOutcome === 'fenced' ? 'fenced'
          : (pauseOutcome === 'terminal' ? 'terminal' : 'gate-blocked'),
        reason: selected.reason,
        checkerEpisodeId: pending.id,
        attemptId: claimed.attemptId,
        continuation: false,
        usage: checkerResult.usage,
        recorded,
      };
    }

    const boundaryPolicy = afterAccounting.autonomy?.continuation_policy === 'workstream-session';
    const routed = boundaryPolicy ? selected : null;
    // Workstream sessions may rotate only at an exact closed boundary. An
    // independent checker completing inside an open affinity continues in the
    // same session; it must not synthesize a transport milestone.
    if (!boundaryPolicy || routed?.type === 'handoff') {
      try {
        const handoff = emitHandoffFn(projectRoot, runId, {
          reason: boundaryPolicy ? routed.reason : 'independent-review-complete',
          trigger: boundaryPolicy
            ? routed.reason
            : `independent-review-complete:${pending.id}:${claimed.attemptId}`,
          ...(boundaryPolicy ? { boundaryEvent: routed.boundary_event } : {}),
          headless: true,
          resumePolicy: 'headless',
          expect: { owner: parentOwner, generation: parentGeneration },
          now: actionNow,
          env,
        });
        continuation = handoff?.ok === true;
        if (!continuation) continuationFailure = handoff?.reason || 'handoff-not-emitted';
      } catch (error) {
        continuationFailure = String(error?.message || error || 'handoff-error').slice(0, 128);
      }
    }
    if (continuationFailure) {
      const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
        reason: 'independent-review-continuation-failed',
        expect: parentFence,
        now: actionNow,
      });
      if (pauseOutcome === 'terminal') continuationFailure = 'terminal';
      else if (pauseOutcome === 'fenced') continuationFailure = 'fenced';
    }
  }
  return {
    ok: continuationFailure == null,
    action: continuationFailure == null ? 'checker-complete' : 'continuation-failed',
    checkerEpisodeId: pending.id,
    attemptId: claimed.attemptId,
    continuation,
    usage: checkerResult.usage,
    recorded,
    ...(continuationFailure ? { reason: continuationFailure } : {}),
    ...(accountingReason ? { accounting_reason: accountingReason } : {}),
  };
}

function driveHeadlessRunLocked({
  root,
  runId,
  now,
  clock = null,
  timeoutMs,
  env = process.env,
  expect = null,
  headless = true,
  overrideVisiblePolicy = false,
  deepLoopRoot = DEFAULT_DEEP_LOOP_ROOT,
  spawnFn = headlessSpawn,
  preflightFn = ensureCodexPreflight,
  recordCostFn = recordCost,
  settlePreflightCostFn = settleCodexPreflightCost,
  settleProcessCostFn = settleCodexProcessCost,
  settleTerminalCostFn = settleTerminalCodexMakerCost,
  listProcessReceiptsFn = listProcessUsageReceipts,
  makeProcessReceiptDescriptorFn = makeProcessUsageReceiptDescriptor,
  removeProcessReceiptFn = removeProcessUsageReceipt,
  respawnFn = respawn,
  launchCommandBuilder = buildLaunchCommand,
  revalidateExecutable = revalidateTrustedRuntimeExecutable,
  resolveCodexHome = resolveAuthenticatedCodexHome,
  inspectDirectory = inspectDirectoryNode,
  inspectResumeSkill = inspectRegularFileIdentity,
  resolveCheckerSkill = resolveTrustedCheckerSkill,
  checkerRunFn = runIndependentCodexChecker,
  checkerImportFn = importReviewViaCli,
  emitHandoffFn = emitHandoff,
  claimReviewFn = claimIndependentReview,
  blockReviewFn = blockIndependentReview,
  revalidateClaimFn = revalidateIndependentReviewClaim,
  attemptIdFactory,
} = {}) {
  const sampleNow = typeof clock === 'function' ? clock : (now === undefined ? Date.now : () => now);
  const entryNow = now === undefined ? sampleNow() : now;
  let initialLoop = captureFreshLoop(root, runId);
  const runtime = sessionRuntime(initialLoop);
  const projectRoot = canonicalProjectRoot(initialLoop.project.root);
  const initialLease = initialLoop.session_chain?.lease || {};
  const parentFence = expect ?? {
    owner: initialLease.owner_run_id,
    generation: initialLease.generation,
  };
  if (initialLease.owner_run_id !== parentFence.owner
    || initialLease.generation !== parentFence.generation) {
    return { ok: false, action: 'fenced', reason: 'caller-parent-fence-mismatch' };
  }
  const parentOwner = parentFence.owner;
  const parentGeneration = parentFence.generation;
  const childRunId = initialLease.handoff_child_run_id;
  const key = initialLease.handoff_idempotency_key;
  const initialApproval = initialLoop.autonomy?.runtime_executable_approval;

  if (runtimeCapability(runtime, 'requires_process_receipt_settlement')) {
    let pendingReceipts;
    try {
      pendingReceipts = listProcessReceiptsFn({ root: projectRoot, runId });
      for (const item of pendingReceipts) {
        const settlement = settleProcessCostFn(projectRoot, runId, {
          receipt: item.receipt,
          fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
        });
        if (!validReceiptSettlement(settlement)) {
          throw new Error('PROCESS_ACCOUNTING_PROTOCOL_INVALID');
        }
      }
      // Settle the complete bounded snapshot first, then clean it. A crash during cleanup leaves only
      // already-recorded immutable receipts for the next host, never a partially unaccounted suffix.
      const cleanupOrder = [...pendingReceipts].sort((left, right) => {
        const leftRank = left.receipt?.smoke_kind === 'write' ? 0
          : left.receipt?.smoke_kind === 'read' ? 2 : 1;
        const rightRank = right.receipt?.smoke_kind === 'write' ? 0
          : right.receipt?.smoke_kind === 'read' ? 2 : 1;
        return leftRank - rightRank || left.journalPath.localeCompare(right.journalPath);
      });
      for (const item of cleanupOrder) removeProcessReceiptFn(item);
      if (pendingReceipts.length > 0) initialLoop = captureFreshLoop(projectRoot, runId);
    } catch (error) {
      return {
        ok: false,
        action: 'process-accounting-failed',
        reason: processAccountingFailureReason(error),
      };
    }
  }

  if (terminal(initialLoop)) return { ok: false, action: 'terminal', reason: 'RUN_TERMINAL' };
  const measuredHeadless = runtimeCapability(runtime, 'measured_headless');
  if (!measuredHeadless) {
    const stranded = inProgressIndependentChecker(initialLoop);
    const pendingChecker = findPendingIndependentChecker(initialLoop);
    const wouldDriveChecker = !stranded
      && pendingChecker
      && runtimeCapability(runtime, 'unattended_checker')
      && initialLease.resume_policy !== 'human'
      && initialLoop.status === 'running';
    if (wouldDriveChecker) {
      const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
        reason: 'unmeasured-runtime',
        expect: { owner: parentOwner, generation: parentGeneration },
        now: entryNow,
      });
      if (pauseOutcome === 'terminal') return { ok: false, action: 'fail-closed-terminal', reason: 'unmeasured-runtime' };
      if (pauseOutcome === 'fenced') return { ok: false, action: 'fenced', reason: 'unmeasured-runtime' };
      return { ok: false, action: 'paused' };
    }
  }
  const checkerResult = driveIndependentChecker({
    root,
    runId,
    initialLoop,
    projectRoot,
    runtime,
    parentFence,
    now: entryNow,
    clock: sampleNow,
    timeoutMs,
    env,
    deepLoopRoot,
    preflightFn,
    recordCostFn,
    settlePreflightCostFn,
    settleProcessCostFn,
    makeProcessReceiptDescriptorFn,
    removeProcessReceiptFn,
    revalidateExecutable,
    resolveCodexHome,
    inspectDirectory,
    inspectResumeSkill,
    resolveCheckerSkill,
    checkerRunFn,
    checkerImportFn,
    emitHandoffFn,
    claimReviewFn,
    blockReviewFn,
    revalidateClaimFn,
    attemptIdFactory,
  });
  if (checkerResult) return checkerResult;
  if (!pendingHandoff(initialLoop)) {
    return measuredHeadless
      ? { ok: true, action: 'no-pending-handoff' }
      : { ok: false, action: 'unmeasured-runtime' };
  }
  if (initialLease.resume_policy === 'human') {
    return measuredHeadless
      ? { ok: true, skipped: true, reason: 'human-resume-policy' }
      : { ok: false, action: 'unmeasured-runtime' };
  }
  const visiblePolicyOverride = overrideVisiblePolicy === true
    && initialLoop.status === 'running'
    && initialLease.resume_policy === 'visible';
  if (initialLease.resume_policy !== 'headless' && !visiblePolicyOverride) {
    return measuredHeadless
      ? { ok: true, skipped: true, reason: 'not-headless-intended' }
      : { ok: false, action: 'unmeasured-runtime' };
  }

  if (initialLease.handoff_phase === 'spawned') {
    if (exactChildAcquired(initialLoop, childRunId)) {
      return measuredHeadless
        ? { ok: true, action: 'already-spawned' }
        : { ok: false, action: 'unmeasured-runtime' };
    }
    const pauseOutcome = pauseWithFreshFence(projectRoot, runId, {
      reason: 'headless-child-did-not-acquire',
      expect: parentFence,
      now: entryNow,
    });
    if (pauseOutcome === 'terminal') return { ok: true, action: 'already-spawned' };
    return {
      ok: false,
      action: pauseOutcome === 'raced' ? 'fail-closed-raced' : 'resumed-unconfirmed',
      reason: 'child-did-not-acquire',
      recorded: false,
    };
  }

  const initialMode = resolveSpawnMode(initialLoop, { headless, env });
  if (initialMode !== 'headless') {
    return {
      ok: false,
      action: 'mode-changed',
      reason: `spawn-mode-changed:headless->${initialMode}`,
    };
  }

  if (!measuredHeadless) {
    const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
      reason: 'unmeasured-runtime',
      expect: { owner: parentOwner, generation: parentGeneration },
      now: entryNow,
    });
    if (pauseOutcome === 'terminal') return { ok: false, action: 'fail-closed-terminal', reason: 'unmeasured-runtime' };
    if (pauseOutcome === 'fenced') return { ok: false, action: 'fenced', reason: 'unmeasured-runtime' };
    return { ok: false, action: 'paused' };
  }

  const child = (initialLoop.session_chain?.sessions || []).find((session) => session.run_id === childRunId);
  const handoffRel = child?.handoff_rel || '';
  const resumeSkillPath = join(deepLoopRoot, 'skills', 'deep-loop-resume', 'SKILL.md');
  const preliminaryGate = respawnGate(initialLoop, { now: entryNow });
  const failPreflight = (reason) => {
    const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
      reason,
      expect: { owner: parentOwner, generation: parentGeneration },
      now: entryNow,
    });
    if (pauseOutcome === 'terminal') return { ok: false, action: 'fail-closed-terminal', reason };
    if (pauseOutcome === 'fenced') return { ok: false, action: 'fenced', reason };
    return { ok: false, action: 'preflight-failed', reason };
  };

  let executable = null;
  let codexHome = null;
  let makerEnvSnapshot = null;
  let projectDirectorySnapshot = null;
  let pluginDirectorySnapshot = null;
  let resumeSkillSnapshot = null;
  if (runtimeCapability(runtime, 'requires_process_preflight') && preliminaryGate.ok) {
    try {
      executable = revalidateExecutable(initialLoop.autonomy?.runtime_executable_approval);
    } catch {
      return failPreflight('executable-invalid');
    }
    try {
      codexHome = resolveCodexHome({ env, platform: executable.platform });
    } catch {
      return failPreflight('codex-home-invalid');
    }
    try {
      makerEnvSnapshot = buildMinimalCodexEnv({
        platform: executable.platform,
        sourceEnv: env,
        codexHome: codexHome.canonical_path,
        runId,
        projectRoot,
        owner: childRunId,
        generation: parentGeneration + 1,
      });
    } catch {
      return failPreflight('preflight-invalid');
    }
    try {
      projectDirectorySnapshot = inspectDirectory(projectRoot);
      pluginDirectorySnapshot = inspectDirectory(deepLoopRoot);
    } catch {
      return failPreflight('root-invalid');
    }
    try {
      resumeSkillSnapshot = inspectResumeSkill(resumeSkillPath);
    } catch {
      return failPreflight('resume-skill-invalid');
    }
    let preflight;
    const settledReceiptIds = [];
    try {
      preflight = preflightFn({
        projectRoot,
        runId,
        executableIdentity: initialApproval,
        codexHomeIdentity: codexHome,
        deepLoopRoot,
        resumeSkillPath,
        sourceEnv: env,
        owner: parentOwner,
        generation: parentGeneration,
        model: initialLoop.autonomy?.session_model ?? null,
        effort: initialLoop.autonomy?.session_effort ?? null,
        timeoutMs,
        goalDriven: isGoalDriven(initialLoop),
        revalidateExecutable,
        resolveCodexHome,
        settleAccountingReceipt: receipt => {
          const result = settlePreflightCostFn(projectRoot, runId, {
            receipt,
            fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
          });
          if (result?.ok === true) settledReceiptIds.push(receipt?.receipt_id);
          return result;
        },
        settleOrphanAccountingReceipt: receipt => settlePreflightCostFn(projectRoot, runId, {
          receipt,
          fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
        }),
      });
    } catch {
      return failPreflight('preflight-error');
    }
    const accountingMode = preflight != null && typeof preflight === 'object' && !Array.isArray(preflight)
      ? preflightAccountingMode(preflight)
      : 'invalid';
    const validPreflight = preflight != null
      && typeof preflight === 'object'
      && !Array.isArray(preflight)
      && typeof preflight.ok === 'boolean'
      && Array.isArray(preflight.measured_usage)
      && accountingMode !== 'invalid'
      && preflightAccountingEvidence(accountingMode, preflight, settledReceiptIds)
      && (preflight.ok
        ? typeof preflight.cache_hit === 'boolean'
          && (preflight.cache_hit ? preflight.measured_usage.length === 0 : preflight.measured_usage.length === 2)
        : typeof preflight.reason === 'string' && preflight.reason.length > 0
          && preflight.pause_mode === 'preserve' && preflight.measured_usage.length <= 2);
    if (!validPreflight) return failPreflight('preflight-invalid');
    if (preflight.measured_usage.some(usage => !isMeasuredOneTurnUsage(usage))) {
      return failPreflight('preflight-usage-invalid');
    }
    const measuredUsage = accountingMode === 'legacy' ? preflight.measured_usage : [];
    let preflightRecorded = 0;
    for (const usage of measuredUsage) {
      try {
        recordCostFn(projectRoot, runId, {
          turns: usage.num_turns,
          tokens: usage.tokens,
          fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
        });
        preflightRecorded += 1;
      } catch (error) {
        const message = String(error?.message || error);
        if (!message.startsWith('LEASE_FENCED') && !message.startsWith('RUN_TERMINAL')) throw error;
        const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
          reason: 'preflight-accounting-failed',
          expect: parentFence,
          now: entryNow,
        });
        return {
          ok: false,
          action: pauseOutcome === 'terminal' ? 'fail-closed-terminal'
            : (pauseOutcome === 'fenced' ? 'fenced' : 'preflight-accounting-failed'),
          reason: 'accounting-fenced',
          recorded: preflightRecorded,
        };
      }
    }
    if (!preflight.ok) return failPreflight(preflight.reason);
  }

  let captured = null;
  let makerUsageReceiptDescriptor = null;
  let spawnCalls = 0;
  const capturedDiagnostic = () => ({
    ...(isGoalDriven(initialLoop) && captured ? { providerThreadId: captured.providerThreadId, process_group: captured.process_group, termination: captured.termination, rawJsonl: captured.rawJsonl, rawJsonlTruncated: captured.rawJsonlTruncated } : {}),
    ...(typeof captured?.stderr === 'string'
      && Buffer.byteLength(captured.stderr, 'utf8') <= STREAM_LIMITS.stderrBytes
      ? { stderr: captured.stderr }
      : {}),
    ...(captured?.stderrTruncated === true ? { stderrTruncated: true } : {}),
  });
  const measuredSpawn = (entry) => {
    spawnCalls += 1;
    if (spawnCalls !== 1) return { ok: false, reason: 'maker-spawn-reentry' };
    let enriched = entry;
    if (runtimeCapability(runtime, 'requires_process_preflight')) {
      try {
        let freshProjectDirectory;
        let freshPluginDirectory;
        try {
          freshProjectDirectory = inspectDirectory(projectRoot);
          freshPluginDirectory = inspectDirectory(deepLoopRoot);
        } catch {
          return { ok: false, reason: 'post-cas-root-drift' };
        }
        if (!sameValue(freshProjectDirectory, projectDirectorySnapshot)
          || !sameValue(freshPluginDirectory, pluginDirectorySnapshot)) {
          return { ok: false, reason: 'post-cas-root-drift' };
        }
        const freshLoop = captureFreshLoop(projectRoot, runId);
        const freshLease = freshLoop.session_chain?.lease || {};
        const freshExecutable = revalidateExecutable(freshLoop.autonomy?.runtime_executable_approval);
        const freshHome = resolveCodexHome({
          env,
          expectedIdentity: codexHome,
          platform: freshExecutable.platform,
        });
        const freshMakerEnv = buildMinimalCodexEnv({
          platform: freshExecutable.platform,
          sourceEnv: env,
          codexHome: freshHome.canonical_path,
          runId,
          projectRoot,
          owner: childRunId,
          generation: parentGeneration + 1,
        });
        if (sessionRuntime(freshLoop) !== 'codex'
          || canonicalProjectRoot(freshLoop.project.root) !== projectRoot
          || freshLease.owner_run_id !== parentOwner
          || freshLease.generation !== parentGeneration
          || freshLease.state !== 'releasing'
          || freshLease.handoff_phase !== 'spawned'
          || freshLease.handoff_idempotency_key !== key
          || freshLease.handoff_child_run_id !== childRunId
          || !sameValue(freshLoop.autonomy?.runtime_executable_approval, initialApproval)
          || !sameValue(freshExecutable, executable)
          || freshLoop.autonomy?.session_model !== initialLoop.autonomy?.session_model
          || freshLoop.autonomy?.session_effort !== initialLoop.autonomy?.session_effort) {
          return { ok: false, reason: 'post-cas-identity-drift' };
        }
        if (!sameValue(freshMakerEnv, makerEnvSnapshot)) {
          return { ok: false, reason: 'post-cas-env-drift' };
        }
        const expectedEntry = launchCommandBuilder({
          runtime,
          root: projectRoot,
          parentRunId: runId,
          childRunId,
          handoffRel,
          model: initialLoop.autonomy?.session_model ?? null,
          effort: initialLoop.autonomy?.session_effort ?? null,
          codexExecutable: executable.canonical_path,
          platform: freshExecutable.platform,
          runtimeExecutableIdentity: freshExecutable,
          deepLoopRoot,
          goalDriven: isGoalDriven(initialLoop),
        }).headless;
        if (!sameValue(entry, expectedEntry)) return { ok: false, reason: 'post-cas-entry-mismatch' };
        let freshResumeSkill;
        try {
          freshResumeSkill = inspectResumeSkill(resumeSkillPath);
        } catch {
          return { ok: false, reason: 'post-cas-resume-skill-drift' };
        }
        if (!sameValue(freshResumeSkill, resumeSkillSnapshot)) {
          return { ok: false, reason: 'post-cas-resume-skill-drift' };
        }
        enriched = {
          ...entry,
          cwd: projectRoot,
          env: freshMakerEnv,
          usageOutputKind: 'codex-jsonl',
        };
        makerUsageReceiptDescriptor = makeProcessReceiptDescriptorFn({
          root: projectRoot,
          runId,
          processKind: 'maker',
          context: {
            parent_owner: parentOwner,
            parent_generation: parentGeneration,
            child_run_id: childRunId,
            child_generation: parentGeneration + 1,
            handoff_key: key,
            handoff_rel: handoffRel,
          },
        });
      } catch {
        return { ok: false, reason: 'post-cas-identity-drift' };
      }
    }
    try {
      captured = spawnFn(enriched, {
        timeoutMs,
        ...(isGoalDriven(initialLoop) ? {processGroup: 'required', captureRawJsonl: true} : {}),
        ...(makerUsageReceiptDescriptor == null
          ? {} : { usageReceipt: makerUsageReceiptDescriptor }),
      });
    } catch (error) {
      captured = { ok: false, reason: `spawn-error: ${error?.message || error}` };
    }
    if (captured == null || typeof captured !== 'object' || typeof captured.then === 'function') {
      captured = { ok: false, reason: 'sync-worker-required' };
    }
    if (captured.ok !== true && captured.ok !== false) {
      captured = { ok: false, reason: 'worker-protocol-invalid' };
    } else if (captured.ok === false
      && (typeof captured.reason !== 'string' || captured.reason.length === 0)) {
      captured = { ok: false, reason: 'worker-protocol-invalid' };
    } else if (runtimeCapability(runtime, 'usage_output_kind') === 'codex-jsonl' && captured.ok === true && !isMeasuredOneTurnUsage(captured.usage)) {
      captured = { ok: false, reason: 'worker-protocol-invalid' };
    }
    return captured;
  };

  const respawnNow = preliminaryGate.ok ? sampleNow() : entryNow;

  const result = respawnFn(projectRoot, runId, {
    childRunId,
    key,
    handoffRel,
    headless,
    now: respawnNow,
    env,
    spawnFn: preliminaryGate.ok
      ? measuredSpawn
      : () => ({ ok: false, reason: `preliminary-gate:${preliminaryGate.reason}` }),
    codexExecutable: executable?.canonical_path ?? null,
    deepLoopRoot,
    launchCommandBuilder,
    expect: parentFence,
    expectedMode: 'headless',
  });
  const freshLoop = captureFreshLoop(projectRoot, runId);
  const childAcquired = exactChildAcquired(freshLoop, childRunId);
  if (result.outcome === 'already-spawned' && captured == null) {
    if (terminal(freshLoop) || childAcquired) return { ok: true, action: 'already-spawned' };
    const pauseOutcome = pauseWithFreshFence(projectRoot, runId, {
      reason: 'headless-child-did-not-acquire',
      expect: parentFence,
      now: respawnNow,
    });
    if (pauseOutcome === 'terminal') return { ok: true, action: 'already-spawned' };
    return {
      ok: false,
      action: pauseOutcome === 'raced' ? 'fail-closed-raced' : 'resumed-unconfirmed',
      reason: 'child-did-not-acquire',
      recorded: false,
    };
  }
  if (captured?.ok === false) {
    const reason = captured.reason || result.reason;
    if (terminal(freshLoop)) return { ok: false, action: 'fail-closed-terminal', reason, ...capturedDiagnostic() };
    if (result.outcome === 'failed_launch') return { ok: false, action: 'fail-closed', reason, ...capturedDiagnostic() };
    const pauseOutcome = pauseWithFreshFence(projectRoot, runId, {
      reason: 'headless-unmeasurable',
      expect: parentFence,
      now: respawnNow,
    });
    if (pauseOutcome === 'terminal') return { ok: false, action: 'fail-closed-terminal', reason };
    return {
      ok: false,
      action: pauseOutcome === 'raced' ? 'fail-closed-raced' : 'fail-closed',
      reason,
      ...capturedDiagnostic(),
    };
  }
  if (captured?.ok === true && !terminal(freshLoop) && !childAcquired) {
    let recorded = false;
    let accountingReason = null;
    if (runtimeCapability(runtime, 'usage_output_kind') === 'codex-jsonl' && captured.usage) {
      try {
        if (captured.usageReceipt != null) {
          const settlement = settleProcessCostFn(projectRoot, runId, {
            receipt: captured.usageReceipt,
            fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
          });
          if (!validReceiptSettlement(settlement)) throw new Error('PROCESS_ACCOUNTING_PROTOCOL_INVALID');
          recorded = true;
          removeProcessReceiptFn({
            receipt: captured.usageReceipt,
            descriptor: makerUsageReceiptDescriptor,
          });
        } else {
          recordCostFn(projectRoot, runId, {
            turns: captured.usage.num_turns,
            tokens: captured.usage.tokens,
            fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
          });
          recorded = true;
        }
      } catch (error) {
        if (captured.usageReceipt != null) accountingReason = processAccountingFailureReason(error);
        else {
          const message = String(error?.message || error);
          if (!message.startsWith('LEASE_FENCED') && !message.startsWith('RUN_TERMINAL')) throw error;
          accountingReason = message.startsWith('RUN_TERMINAL') ? 'terminal' : 'fenced';
        }
      }
    }
    const pauseOutcome = pauseWithFreshFence(projectRoot, runId, {
      reason: 'headless-child-did-not-acquire',
      expect: parentFence,
      now: respawnNow,
    });
    if (pauseOutcome === 'terminal') {
      return {
        ok: true, action: 'resumed', usage: captured.usage, recorded,
        ...(accountingReason ? { accounting_reason: accountingReason } : {}),
        ...capturedDiagnostic(),
      };
    }
    return {
      ok: false,
      action: pauseOutcome === 'raced' ? 'fail-closed-raced' : 'resumed-unconfirmed',
      reason: 'child-did-not-acquire',
      ...(runtimeCapability(runtime, 'usage_output_kind') === 'codex-jsonl' ? {
        usage: captured.usage,
        recorded,
        ...(accountingReason ? { accounting_reason: accountingReason } : {}),
      } : {}),
      ...capturedDiagnostic(),
    };
  }

  if (!result.ok && captured?.ok !== true) {
    return {
      ok: false,
      action: result.outcome === 'failed_launch' ? 'fail-closed' : (result.outcome || 'failed'),
      reason: result.reason,
    };
  }
  let recorded = false;
  if (captured?.usage) {
    try {
      const accountingFence = { owner: childRunId, generation: parentGeneration + 1, intent: 'accounting' };
      if (runtimeCapability(runtime, 'usage_output_kind') === 'codex-jsonl' && captured.usageReceipt != null) {
        const settlement = settleProcessCostFn(projectRoot, runId, {
          receipt: captured.usageReceipt,
          fence: accountingFence,
        });
        if (!validReceiptSettlement(settlement)) throw new Error('PROCESS_ACCOUNTING_PROTOCOL_INVALID');
        recorded = true;
        removeProcessReceiptFn({
          receipt: captured.usageReceipt,
          descriptor: makerUsageReceiptDescriptor,
        });
      } else if (runtime === 'codex' && terminal(freshLoop) && childAcquired) {
        const settlement = settleTerminalCostFn(projectRoot, runId, {
          usage: captured.usage,
          fence: accountingFence,
          handoffKey: key,
        });
        if (settlement?.ok !== true || !['recorded', 'already-recorded'].includes(settlement.reason)) {
          throw new Error('TERMINAL_ACCOUNTING_PROTOCOL_INVALID');
        }
        recorded = true;
      } else {
        recordCostFn(projectRoot, runId, {
          turns: captured.usage.num_turns || 0,
          tokens: captured.usage.tokens || 0,
          fence: accountingFence,
        });
        recorded = true;
      }
    } catch (error) {
      if (captured.usageReceipt != null) {
        return {
          ok: false,
          action: terminal(freshLoop) ? 'terminal-accounting-failed' : 'process-accounting-failed',
          reason: terminal(freshLoop) ? 'terminal-accounting-failed' : 'process-accounting-failed',
          usage: captured.usage,
          recorded,
          accounting_reason: processAccountingFailureReason(error),
          ...capturedDiagnostic(),
        };
      }
      if (runtime === 'codex' && terminal(freshLoop) && childAcquired) {
        return {
          ok: false,
          action: 'terminal-accounting-failed',
          reason: 'terminal-accounting-failed',
          usage: captured.usage,
          recorded: false,
          accounting_reason: terminalAccountingFailureReason(error),
          ...capturedDiagnostic(),
        };
      }
      if (!String(error?.message || error).startsWith('LEASE_FENCED')) throw error;
    }
  }
  return { ok: true, action: 'resumed', usage: captured?.usage, recorded, ...capturedDiagnostic() };
}

export function driveHeadlessRun(options = {}) {
  const acquireHostLock = options.acquireHostLock ?? acquireHeadlessHostLock;
  const lock = acquireHostLock(options.root, options.runId, {
    timeoutMs: options.timeoutMs,
    wallNow: options.lockWallNow,
    processAlive: options.hostProcessAlive,
    pid: options.hostPid,
  });
  if (!lock) return { ok: true, action: 'already-driving' };
  try {
    return driveHeadlessRunLocked(options);
  } finally {
    lock.release();
  }
}

// The goal controller holds the same run-wide host lock while it alternates
// owner turns and the existing checker/handoff service. The service closure is
// valid only during this callback; no public option can bypass lock acquisition.
export async function withHeadlessHostService(options, callback) {
  const lock = acquireHeadlessHostLock(options.root, options.runId, {
    timeoutMs: options.timeoutMs,
    wallNow: options.lockWallNow,
  });
  if (!lock) return { ok: false, action: 'already-driving', reason: 'already-driving' };
  let active = true;
  const service = overrides => {
    if (!active) throw new Error('HOST_SERVICE_EXPIRED');
    return driveHeadlessRunLocked({ ...options, ...overrides, root: options.root, runId: options.runId });
  };
  try { return await callback(service); }
  finally { active = false; lock.release(); }
}

export function driveHeadless({
  root = findRoot(process.cwd()),
  driveRun = driveHeadlessRun,
  runId: explicitRunId = null,
  envIdentity,
  env = process.env,
  nowFn,
  sleepFn,
  lockOptions,
  ...options
} = {}) {
  const selection = resolveRunContext({
    root,
    explicitRunId,
    // `null` is an explicit argv-authority sentinel: do not consult ambient
    // environment markers when valued argv selected the run.
    envIdentity: envIdentity === null ? null : (envIdentity === undefined ? env : envIdentity),
    purpose: 'headless',
    cwd: null,
    nowFn,
    sleepFn,
    lockOptions,
  });
  if (!selection?.ok) {
    const action = selection.kind === 'ambiguous' ? 'ambiguous'
      : selection.kind === 'invalid' ? 'routing-invalid' : 'routing-failed';
    return {
      ok: false,
      action,
      reason: selection?.reason || selection?.kind || 'invalid',
      ...(selection?.kind ? { kind: selection.kind } : {}),
      ...(selection?.candidates ? { candidates: selection.candidates } : {}),
      ...(selection?.errors ? { errors: selection.errors } : {}),
      ...(Number.isSafeInteger(selection?.total) ? { total: selection.total } : {}),
      ...(selection?.max_run_ids !== undefined ? { max_run_ids: selection.max_run_ids } : {}),
      ...(selection?.deadline_ms !== undefined ? { deadline_ms: selection.deadline_ms } : {}),
      ...(selection?.observed_count !== undefined ? { observed_count: selection.observed_count } : {}),
      ...(selection?.total_is_lower_bound !== undefined
        ? { total_is_lower_bound: selection.total_is_lower_bound } : {}),
    };
  }
  if (selection.kind === 'none') return { ok: true, action: 'no-run' };
  return driveRun({
    root,
    runId: selection.runId,
    ...options,
    ...(selection.source === 'env' && selection.expect ? { expect: selection.expect } : {}),
  });
}
