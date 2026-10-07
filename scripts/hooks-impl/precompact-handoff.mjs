import { readBoundedText } from '../lib/bounded-input.mjs';
import { detectMain } from '../lib/detect-main.mjs';
import { captureReconciledRunSnapshot, findRoot } from '../lib/state.mjs';
import { ROUTING_BOUND_FIELDS, formatBoundedRoutingDiagnostic, resolveRunContext } from '../lib/run-context.mjs';

const boundFields = source => Object.fromEntries(ROUTING_BOUND_FIELDS
  .filter(key => source?.[key] !== undefined).map(key => [key, source[key]]));
import {
  emitCompactCheckpoint,
  emitLegacyCompactCheckpointFromTrustedHook,
} from '../lib/checkpoint.mjs';
import { emitHandoff } from '../lib/handoff.mjs';
import { rollbackHandoff } from '../lib/lease.mjs';
import { respawnGate, resolveSpawnMode, rollbackAndPause } from '../lib/respawn.mjs';
import { runtimeCapability, sessionRuntime } from '../lib/runtime.mjs';
import { isOpenScope, ownerSession } from '../lib/session-scope.mjs';

/**
 * PreCompact emits an artifact only: a strict checkpoint for an open workstream-session affinity,
 * or the legacy clean handoff. Measured fail-closed legacy resumption is the cron `driveHeadless`
 * driver's job (spec §9). Legacy gate-blocked unattended → status=paused (fail-closed).
 *
 * For legacy handoff policies it writes the handoff artifact and updates the lease to `releasing`
 * so the measured cron driver (`driveHeadless`, whose shared host uses `headlessSpawn` with timeout and
 * usage accounting) can pick it up. PreCompact must NOT itself spawn an unmeasured child:
 * - sync spawn would block the hook (compaction delayed indefinitely on long runs)
 * - detached spawn can't measure turns/tokens → violates spec §9 fail-closed requirement
 */

function strictHostSessionEvidence(input, runtime) {
  if (input.hook_event_name !== 'PreCompact'
    || !['manual', 'auto'].includes(input.trigger)) {
    throw new Error('host-context-invalid');
  }
  if (!Object.hasOwn(input, 'session_id')) return undefined;
  if (typeof input.session_id !== 'string'
    || input.session_id.length === 0
    || input.session_id.length > 1024
    || /[\0\r\n]/.test(input.session_id)) {
    throw new Error('host-evidence-invalid');
  }
  return {
    provider: runtimeCapability(runtime, 'provider_label'),
    id: input.session_id,
  };
}

function hasOpenAffinity(loop) {
  try {
    const scope = ownerSession(loop).scope;
    if (!isOpenScope(scope) || scope.closed_at !== null) return false;
    const workstream = (loop.workstreams || []).find(item => item?.id === scope.workstream_id);
    const episode = (loop.episodes || []).find(item => item?.id === loop.current_episode);
    return Boolean(workstream
      && !['ready', 'merged', 'abandoned'].includes(workstream.status)
      && episode
      && episode.workstream_id === scope.workstream_id);
  } catch {
    return false;
  }
}

// spec §3.4.1: 정리 호출자는 rollbackHandoff 반환을 검사해야 한다 — fenced(owner/generation 변경)는
// 비-benign으로 전파하며 절대 no-run-*으로 정규화하지 않는다(실제 lease 경합 은폐 금지).
function sweepLeaseResidue(root, runId, expect, cleanupFn) {
  const res = cleanupFn(root, runId, { owner: expect.owner, generation: expect.generation });
  if (!res.ok) return { ok: false, action: 'fenced', reason: 'residue-cleanup-fenced' };
  return null;
}

// 반환/던짐 RUN_PAUSED 공통 경로: phase='reserved' 잔재만 정리(던짐-분기와 동일 규칙 — emitted/spawned는
// preserve-pause 보존 규칙에 따라 건드리지 않는다) 후 benign no-run-paused.
function normalizePausedEmit(root, runId, expect, cleanupFn) {
  const fresh = captureReconciledRunSnapshot(root, runId).data.session_chain?.lease || {};
  if (fresh.handoff_phase === 'reserved') {
    const fenced = sweepLeaseResidue(root, runId, expect, cleanupFn);
    if (fenced) return fenced;
  }
  return { ok: true, action: 'no-run-paused' };
}

export async function runPreCompactHandoff(input = {}, {
  root = findRoot(process.cwd()),
  now = Date.now(),
  env = process.env,
  rollbackFn = rollbackAndPause,
  cleanupFn = rollbackHandoff,
  emitFn = emitHandoff,
  checkpointFn = emitLegacyCompactCheckpointFromTrustedHook,
  resolveContextFn = resolveRunContext,
} = {}) {
  const selection = resolveContextFn({
    root,
    cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
    purpose: 'hook-checkpoint',
    // No nowFn: selection deadlines need an advancing clock, not the business `now`.
  });
  if (!selection?.ok || selection.kind !== 'selected') {
    if (selection?.kind === 'none'
      && ['no-runs', 'no-current', 'no-active-run', 'terminal-residue'].includes(selection.reason)) {
      // A cwd inside a finished run's worktree is benign, but the safety net is off here:
      // say so (issue #77), as the only signal a reused worktree path leaves.
      return selection.reason === 'terminal-residue' && selection.source === 'worktree'
        ? { ok: true, action: 'no-run', reason: 'terminal-residue', source: 'worktree' }
        : { ok: true, action: 'no-run' };
    }
    const action = selection?.kind === 'ambiguous' ? 'ambiguous-run' : 'routing-failed';
    return {
      ok: false,
      action,
      reason: selection?.reason || selection?.kind || 'invalid',
      ...(Array.isArray(selection?.candidates) ? { candidates: selection.candidates } : {}),
      ...(Number.isSafeInteger(selection?.total) ? { total: selection.total } : {}),
      ...boundFields(selection),
      ...(selection?.errors && typeof selection.errors === 'object' && !Array.isArray(selection.errors)
        ? { errors: selection.errors } : {}),
    };
  }
  const runId = selection.runId;
  const loop = selection.snapshot.data;
  const finish = result => ({ ...result, run_id: runId, selection_source: selection.source });

  const policy = loop.autonomy?.continuation_policy;
  if (policy === 'workstream-session') {
    const currentLease = loop.session_chain?.lease || {};
    const currentExpect = {
      owner: currentLease.owner_run_id,
      generation: currentLease.generation,
    };
    let hostSessionEvidence;
    let runtime;
    try {
      runtime = sessionRuntime(loop);
      hostSessionEvidence = strictHostSessionEvidence(input, runtime);
    } catch {
      return finish({
        ok: false,
        action: 'checkpoint-failed',
        reason: 'host-evidence-invalid',
      });
    }
    if (!hasOpenAffinity(loop)) return finish({ ok: true, action: 'no-affinity' });
    const headless = resolveSpawnMode(loop, { headless: false, env }) === 'headless';
    try {
      emitCompactCheckpoint(root, runId, {
        fence: currentExpect,
        runtime,
        hostSessionEvidence,
        now,
      });
    } catch {
      return finish({ ok: false, action: 'checkpoint-failed', reason: 'checkpoint-write-failed' });
    }
    return finish({ ok: true, action: 'checkpointed', headless });
  }

  const lease = loop.session_chain?.lease || {};
  const expect = { owner: lease.owner_run_id, generation: lease.generation };

  // spec §3.4.1: terminal run은 no-run과 동일하게 무해 처리 — emitHandoff의 runtime/canonical-root
  // 선행 검증(버전-스큐에 취약)을 경유하지 않는 검증-선행 전용 정리 경로. 잔재 sweep은 커널의
  // reserve-시점 RUN_TERMINAL rollback과 동일 동작(lease 필드만 정리)이며 session_chain.sessions는
  // 절대 변경하지 않는다(종료된 run의 역사적 기록 — reconcile은 finish/audit 경로의 몫).
  // 잔재 술어는 spec 문언 그대로 phase ≠ idle — handoff/resume을 거친 완료 run의 정상 종료 상태인
  // active/acquired(finishRun은 lease 미초기화)도 released/idle로 불활성 안착시킨다.
  if (loop.status === 'completed' || loop.status === 'stopped') {
    if (lease.handoff_phase !== 'idle' || lease.handoff_idempotency_key || lease.handoff_child_run_id) {
      const fenced = sweepLeaseResidue(root, runId, expect, cleanupFn);
      if (fenced) return finish(fenced);
    }
    return finish({ ok: true, action: 'no-run-terminal' });
  }

  // spec §3.4.1: paused 정리 범위 한정 — 정리 대상은 오직 phase='reserved'(중단·실패 emit의 stale
  // reservation; appendAnchored preCheck-선행 원자성 때문에 child session은 커밋된 적 없음 → lease 필드
  // 정리로 충분). emitted/spawned는 preserve-pause 수명주기가 late child의 lease 인수를 위해 의도적으로
  // 보존하는 연속성 상태 — 무변경 보존(무조건 정리는 수동 재개 파괴 회귀).
  if (loop.status === 'paused') {
    if (lease.handoff_phase === 'reserved') {
      const fenced = sweepLeaseResidue(root, runId, expect, cleanupFn);
      if (fenced) return finish(fenced);
    }
    return finish({ ok: true, action: 'no-run-paused' });
  }

  const headless = resolveSpawnMode(loop, { headless: input.unattended === true, env }) === 'headless';
  // v1.10 policy branch (spec §4.1): attended compact-in-place emits only an artifact checkpoint;
  // headless invocations retain the handoff path. A reserved phase intentionally falls through so the
  // durable reserved-finalization path in emitHandoff runs before any new policy action.
  const phase = lease.handoff_phase;
  // Completed in-flight handoffs are harmless no-ops under every policy and must not re-evaluate gates.
  if (phase === 'emitted' || phase === 'spawned') {
    return finish({ ok: true, action: 'handoff-in-flight' });
  }
  // acquireLease leaves the phase at acquired, so both idle and acquired are valid in-place checkpoint states.
  if (policy === 'compact-in-place' && !headless && (phase === 'idle' || phase === 'acquired')) {
    try { checkpointFn(root, runId, { now }); } catch { /* best-effort: compaction must never be blocked */ }
    return finish({ ok: true, action: 'checkpointed', headless });
  }
  let em;
  try {
    em = emitFn(root, runId, { reason: 'pre-compact', trigger: 'pre-compact', headless, expect, env });
  } catch (e) {
    // spec §3.4.1: reserve 성공 후 append 중 pause → emitHandoff가 rollback 없이 RUN_PAUSED를 던진다
    // (appendAnchored preCheck). reservation(phase/key/child)을 정리한 뒤에만 benign — 정리 없이
    // 정규화만 하면 이후 handoff가 handoff-in-flight로 거부되는 교착이 남는다.
    if (!String(e?.message || e).startsWith('RUN_PAUSED')) throw e;
    return finish(normalizePausedEmit(root, runId, expect, cleanupFn));
  }
  if (!em.ok) {
    // spec §3.4.1: emit-시점 reason-특정 정규화(체크와 emit 사이 상태 전이 경합) — RUN_TERMINAL 반환은
    // emitHandoff가 내부 rollback을 이미 수행(reserve-거부 sweep 또는 보상 rollback). fenced는 진짜
    // lease 이상 신호이므로 정규화 대상이 아니다.
    if (em.reason === 'RUN_TERMINAL') return finish({ ok: true, action: 'no-run-terminal' });
    if (em.reason === 'RUN_PAUSED') return finish(normalizePausedEmit(root, runId, expect, cleanupFn));
    return finish({ ok: false, action: 'fenced', reason: em.reason });
  }

  if (headless && loop.autonomy?.auto_handoff) {
    // Gate check on POST-emit state (Fix 2): emitHandoff appended the reserved child session so
    // sessions.length grew — respawnGate must see the fresh state or max_sessions is off-by-one.
    let fresh;
    try { fresh = captureReconciledRunSnapshot(root, runId).data; }
    catch (error) {
      return finish({ ok: false, action: 'error', reason: String(error?.message || error) });
    }
    const gate = respawnGate(fresh, { now });
    if (!gate.ok) {
      // R12-LL fix: gate-blocked must ROLLBACK (invalidate reserved child), not merely set status=paused.
      // A status-only pause leaves handoff_child_run_id intact, allowing a human to bypass the gate via
      // /deep-loop-resume → acquireLease(reserved child). Use rollbackAndPause (same as respawn's path):
      // child.outcome='failed_launch', superseded_by cleared, lease→active/idle, status='paused'.
      const res = rollbackFn(root, runId, {
        childRunId: em.childRunId, parentOwner: expect.owner, generation: expect.generation,
        eventData: { child_run_id: em.childRunId, gate: gate.reason, trigger: 'pre-compact' },
        pauseReason: `gate:${gate.reason}`,
      });
      if (res.terminal) return finish({ ok: true, action: 'no-run-terminal' });   // spec §3.4.1: rollback 중 terminal 판명 → benign
      if (res.fenced) return finish({
        ok: false,
        action: 'fenced',
        reason: 'lease-changed-before-pause',
        childRunId: em.childRunId,
        headless,
      });
      return finish({ ok: true, action: 'gate-blocked-paused', childRunId: em.childRunId, headless });
    }
    // Gate open: handoff emitted with lease=releasing; measured cron driveHeadless will resume via round-2 handshake.
    return finish({ ok: true, action: 'emitted', childRunId: em.childRunId, headless });
  }
  return finish({ ok: true, action: 'emitted', childRunId: em.childRunId, headless });   // interactive → human uses terminal/launch-command.txt
}

// CLI 진입 — best-effort, 절대 compaction 차단 안 함.
export async function main() {
  try {
    const raw = await readBoundedText(process.stdin);
    const input = raw.length === 0 ? {} : JSON.parse(raw);
    if (input === null || Array.isArray(input) || typeof input !== 'object') throw new Error('input-invalid');
    const cwd = input.cwd ?? process.cwd();
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('root-invalid');
    const response = await runPreCompactHandoff(input, { root: findRoot(cwd) });
    if (response?.ok && response.action === 'no-run' && response.source === 'worktree') {
      process.stderr.write(`deep-loop: precompact ${formatBoundedRoutingDiagnostic({
        action: response.action, reason: response.reason, source: response.source,
      })}\n`);
    } else if (!response?.ok) {
      const detail = formatBoundedRoutingDiagnostic({
        action: response.action,
        reason: response.reason,
        ...(response.errors && typeof response.errors === 'object' && !Array.isArray(response.errors)
          ? { errors: response.errors } : {}),
        ...(response.candidates ? { candidates: response.candidates } : {}),
        ...(response.total !== undefined ? { total: response.total } : {}),
        ...boundFields(response),
      });
      process.stderr.write(`deep-loop: precompact ${detail}\n`);
    }
  } catch {
    process.stderr.write('deep-loop: precompact hook failed\n');
  }
}

const { isMain, diagnostic } = detectMain(import.meta.url, process.argv[1]);
if (diagnostic) {
  process.stderr.write(`${diagnostic}\n`);
} else if (isMain) {
  await main();
}
