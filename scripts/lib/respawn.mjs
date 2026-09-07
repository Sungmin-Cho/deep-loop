import {
  captureReconciledRunSnapshot,
  withReconciledMutationLock,
  writeState,
} from './state.mjs';
import { existsSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { appendAnchored } from './integrity.mjs';
import { checkHardBudget, reconcileBudget } from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import { boundaryHandoffTopologyError } from './lease.mjs';
import { buildLaunchCommand } from './runtime-descriptor.mjs';
import { defaultDesktopProbe } from './desktop-target.mjs';
import { runtimeCapability, sessionRuntime } from './runtime.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import {
  defaultProbeRun, deriveTmuxSessionByAncestry, listTmuxPanes, probeTmuxSocket,
} from './detect-terminal.mjs';
import {
  revalidateTrustedLauncherExecutable,
  revalidateTrustedRuntimeExecutable,
} from './runtime-executable.mjs';
import { nextAction } from './next-action.mjs';
import { attendedLaunchAuthorized } from './attended-launch.mjs';
import { resolveLaunchProfile } from './session-profile.mjs';
import { isGoalDriven } from './goal-contract.mjs';

const DEFAULT_DEEP_LOOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const captureFreshLoop = (root, runId) => captureReconciledRunSnapshot(root, runId).data;

function durableLauncherAuthority(loop, expectedKind) {
  const approvals = loop.autonomy?.launcher_executable_approvals;
  if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)
    || !Object.hasOwn(approvals, expectedKind) || !approvals[expectedKind]
    || typeof approvals[expectedKind] !== 'object' || Array.isArray(approvals[expectedKind])) return null;
  return { source: 'durable-approval', identity: approvals[expectedKind] };
}

function currentLauncherAuthority(loop, expectedKind, { allowDetachedDurable = false } = {}) {
  const approvals = loop.autonomy?.launcher_executable_approvals;
  // A desktop handoff is app-native rather than terminal-native: on Windows its
  // shell-free Start-Process wrapper needs the exact durable PowerShell approval,
  // but it does not require a currently active PowerShell terminal session.
  if (allowDetachedDurable && approvals !== undefined) {
    return durableLauncherAuthority(loop, expectedKind);
  }
  const sessionIdentity = loop.session_spawn?.launcher_identity;
  if (!sessionIdentity || typeof sessionIdentity !== 'object' || Array.isArray(sessionIdentity)
    || loop.session_spawn?.launcher !== expectedKind) return null;
  if (approvals === undefined) return { source: 'legacy-session', identity: sessionIdentity };
  const durable = durableLauncherAuthority(loop, expectedKind);
  if (durable == null || !isDeepStrictEqual(sessionIdentity, durable.identity)) return null;
  return durable;
}

function currentPosixCodexLauncher(loop, expectedMode, platform) {
  if (!['linux', 'darwin'].includes(platform) || !['cmux', 'iterm2', 'terminal-app', 'tmux'].includes(expectedMode)) return null;
  const session = loop.session_spawn;
  if (!session || typeof session !== 'object' || Array.isArray(session)
    || session.platform !== platform || session.launcher !== expectedMode
    || session.reachable !== true || session.visible !== true) return null;
  if (expectedMode === 'tmux') {
    if (session.surface !== 'window'
      || typeof session.launcher_bin !== 'string' || !posix.isAbsolute(session.launcher_bin)
      || typeof session.launcher_socket !== 'string' || !posix.isAbsolute(session.launcher_socket)
      || typeof session.launcher_pid !== 'string' || !/^[1-9][0-9]*$/.test(session.launcher_pid)
      || typeof session.launcher_session !== 'string' || !/^[0-9]+$/.test(session.launcher_session)
      || !session.launcher_identity || typeof session.launcher_identity !== 'object'
      || Array.isArray(session.launcher_identity)) return null;
    const expectedProbe = {
      cmd: [session.launcher_bin, '-S', session.launcher_socket, 'display-message', '-p', '#{pid} #{session_id}'],
      code: 0,
    };
    if (!isDeepStrictEqual(session.probe, expectedProbe)) return null;
  } else if (expectedMode === 'cmux') {
    if (session.surface !== 'workspace'
      || typeof session.launcher_bin !== 'string' || !posix.isAbsolute(session.launcher_bin)
      || typeof session.launcher_socket !== 'string' || session.launcher_socket.length === 0) return null;
    const expectedProbe = {
      cmd: [session.launcher_bin, '--socket', session.launcher_socket, 'ping'],
      code: 0,
    };
    if (!isDeepStrictEqual(session.probe, expectedProbe)) return null;
  } else if (platform !== 'darwin' || session.surface !== 'window'
    || session.launcher_bin !== '/usr/bin/osascript' || session.launcher_socket != null) {
    return null;
  } else {
    const app = expectedMode === 'iterm2' ? 'iTerm' : 'Terminal';
    const expectedProbe = {
      cmd: ['/usr/bin/osascript', '-e', `id of application "${app}"`],
      code: 0,
    };
    if (!isDeepStrictEqual(session.probe, expectedProbe)) return null;
  }
  return {
    platform: session.platform,
    launcher: session.launcher,
    launcher_bin: session.launcher_bin ?? null,
    launcher_identity: session.launcher_identity ?? null,
    launcher_socket: session.launcher_socket ?? null,
    launcher_pid: session.launcher_pid ?? null,
    launcher_session: session.launcher_session ?? null,
    surface: session.surface ?? null,
    reachable: session.reachable,
    visible: session.visible,
    probe: session.probe,
  };
}

// 게이트 순서: budget → breaker → max_sessions → wallclock → auto_handoff (spec §9). 순수.
export function respawnGate(loop, { now = Date.now() } = {}) {
  const blocked_by = [];
  // Codex r1 🟡8: hard-budget predicate는 created_at 기반 wallclock도 검사하므로, sessionStart=now로 그 내부 검사를
  // 무력화(wall=0)하고 wallclock 은 아래 문서화된 순서(max_sessions 다음)에서 명시 검사 → 순서/라벨 일관.
  const budget = checkHardBudget(loop, { now, sessionStart: now });
  if (budget.blocked) blocked_by.push('budget');
  if (checkBreaker(loop).tripped) blocked_by.push('breaker');
  // Codex r3 🟡6: emitHandoff 가 child 세션을 미리 append 하므로 pending child 가 이미 카운트됨 → `>`(>= 아님)로 비교해
  // 총 세션이 max_sessions 까지는 허용하되 초과는 금지 (off-by-one 방지).
  // R4-plan: phantom failed_launch sessions (never acquired) MUST NOT consume max_sessions slots — otherwise
  // repeated visible launch failures / gate-blocks permanently exhaust max_sessions with dead phantom sessions.
  const liveSessions = (loop.session_chain?.sessions || []).filter(s => s.outcome !== 'failed_launch');
  if (liveSessions.length > (loop.autonomy?.max_sessions ?? 8)) blocked_by.push('max_sessions');
  const start = loop.created_at ? Date.parse(loop.created_at) : now;
  if (loop.budget?.max_wallclock_sec && (now - start) / 1000 >= loop.budget.max_wallclock_sec) blocked_by.push('wallclock');
  if (!loop.autonomy?.auto_handoff) blocked_by.push('auto_handoff');
  return { ok: blocked_by.length === 0, blocked_by, reason: blocked_by.join(',') || 'ok' };
}

function claimSpawnedHandoff(root, runId, {
  key,
  childRunId,
  parentOwner,
  generation,
  now,
  mode,
}) {
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    const lease = data.session_chain?.lease || {};
    if (lease.owner_run_id !== parentOwner || lease.generation !== generation) {
      return { ok: false, reason: 'fenced' };
    }
    if (data.status === 'completed' || data.status === 'stopped') {
      return { ok: false, reason: 'RUN_TERMINAL' };
    }
    if (lease.handoff_idempotency_key !== key) return { ok: false, reason: 'key-mismatch' };
    if (lease.handoff_child_run_id !== childRunId) return { ok: false, reason: 'child-mismatch' };
    if (lease.handoff_phase === 'spawned') return { ok: true, reason: 'idempotent-noop' };
    if (lease.handoff_phase !== 'emitted' || lease.state !== 'releasing') {
      return { ok: false, reason: `illegal-transition ${lease.handoff_phase}->spawned` };
    }

    // The spawned CAS is the final internal authorization boundary before an
    // irreversible external process launch. Re-evaluate in the documented
    // order while holding the same lock that consumes `emitted`.
    const budget = checkHardBudget(data, { now, sessionStart: now });
    if (budget.blocked) return { ok: false, reason: 'budget' };
    if (checkBreaker(data).tripped) return { ok: false, reason: 'breaker' };

    if (lease.takeover_kind === 'boundary-handoff') {
      const topologyError = boundaryHandoffTopologyError(data);
      if (topologyError) return { ok: false, reason: topologyError };
      const action = nextAction(data, { now }).action;
      if (action?.type === 'finish') return { ok: false, reason: 'FINISH_REQUIRED' };
    } else {
      const topologyError = boundaryHandoffTopologyError(data);
      if (topologyError) return { ok: false, reason: topologyError };
    }

    const gate = respawnGate(data, { now });
    if (!gate.ok) return { ok: false, reason: gate.reason };

    const attendedStyle = mode === 'desktop'
      ? 'desktop'
      : (mode === 'headless' ? null : 'visible');
    if (attendedStyle != null && !attendedLaunchAuthorized(data, attendedStyle)) {
      return { ok: false, reason: 'attended-launch-unauthorized' };
    }

    data.session_chain.lease = { ...lease, handoff_phase: 'spawned' };
    writeState(root, runId, data);
    return { ok: true, reason: 'advanced' };
  });
}

// Headless (non-interactive) invocation detection — an ADDITIONAL safety net beyond the driver's explicit
// `headless:true`. PROVISIONAL signal (spec §14-5 open question): the exact `CLAUDE_CODE_ENTRYPOINT` value for
// `claude -p` print mode is not yet pinned, so we recognize the concrete markers we DO control —
// `DEEP_LOOP_UNATTENDED` (set by the headless driver on the child process) / `DEEP_LOOP_HEADLESS` — plus a
// Claude-only conservative entrypoint heuristic (sdk*/print/headless/non-interactive). Codex ignores that
// Claude-owned variable. FAIL-OPEN to false when indeterminate: false + no positive launcher → mode
// 'interactive' → no-launcher → pause (fail-closed).
export function isHeadlessInvocation(env = process.env, runtime = 'claude') {
  if (!env || typeof env !== 'object') return false;
  const truthy = (v) => v === '1' || v === 'true' || v === true;
  if (truthy(env.DEEP_LOOP_UNATTENDED) || truthy(env.DEEP_LOOP_HEADLESS)) return true;
  if (runtimeCapability(runtime, 'entrypoint_heuristic') !== 'claude-code') return false;
  const ep = String(env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase();
  if (!ep || ep === 'cli') return false;   // interactive TUI (or unset) → not headless
  if (ep.startsWith('sdk') || ep.includes('print') || ep.includes('headless') || ep.includes('noninteractive') || ep.includes('non-interactive')) return true;
  return false;
}

// Resolve the spawn mode (spec §7). Returns 'headless' | 'desktop' | a launcher name (cmux|iterm2|terminal-app|wt|powershell)
// | 'interactive'. Headless wins over everything: explicit flag, autonomy.spawn_style==='headless', OR a
// detected headless invocation (regardless of launcher/attended). Then 'desktop' when spawn_style==='desktop' AND
// attended===true (Claude Desktop deeplink transport). A visible launcher mode requires spawn_style==='visible'
// AND attended===true AND a real (non-'none') detected launcher; otherwise 'interactive'.
export function resolveSpawnMode(loop, { headless = false, attended = false, env = process.env } = {}) {
  const runtime = sessionRuntime(loop);
  if (headless || loop?.autonomy?.spawn_style === 'headless' || isHeadlessInvocation(env, runtime)) return 'headless';
  if (attended === true && attendedLaunchAuthorized(loop, 'desktop')) return 'desktop';
  const launcher = loop?.session_spawn?.launcher;
  if (attended === true && attendedLaunchAuthorized(loop, 'visible')
    && launcher && launcher !== 'none') return launcher;
  return 'interactive';
}

function defaultSpawn() {
  // Production callers inject either visibleSpawn or the shared headless host's measured closure.
  throw new Error('SPAWN_NOT_WIRED: provide a synchronous spawnFn');
}
function defaultSleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Classify a polled lease for visible child-readiness (R10-DD exact schema; R6-U fast-child race):
//   'success' — the reserved child has acquired: state==='active' && handoff_phase==='acquired' && owner===child.
//   'fenced'  — a generation change to a NON-reserved owner (some other run/recover took over).
//   'pending' — still releasing / not yet acquired (missing generation counts as pending, not fence).
function classifyReadiness(l, { childRunId, startGeneration }) {
  if (!l) return 'pending';
  if (l.owner_run_id === childRunId && l.state === 'active' && l.handoff_phase === 'acquired') return 'success';
  if (l.generation != null && l.generation !== startGeneration && l.owner_run_id !== childRunId) return 'fenced';
  return 'pending';
}

// Failure handler (a): launch FAILURE (visibleSpawn {ok:false}/throw) AND gate-blocked → ROLLBACK + paused.
// ONE appendAnchored transaction: child.outcome='failed_launch' (excluded from max_sessions), parent.superseded_by
// cleared, lease rolled back to active/idle (stale TTL released), status='paused' + pause_reason. The reserved
// child is invalidated (it never ran). In-lock parent fence → if the lease changed (child took over), abort
// WITHOUT mutating (returns {fenced:true}). No half-commit: event + chain + lease + status are one transaction.
function invalidateHandoff(l, childRunId) {
  const child = l.session_chain.sessions.find(s => s.run_id === childRunId);
  if (child) child.outcome = 'failed_launch';
  const parent = l.session_chain.sessions.find(s => s.superseded_by === childRunId);
  if (parent) {
    parent.superseded_by = null;
    if (parent.scope?.kind === 'workstream') parent.scope.superseded_at = null;
  }
  l.session_chain.lease = {
    ...l.session_chain.lease,
    state: 'active',
    handoff_phase: 'idle',
    handoff_idempotency_key: null,
    handoff_child_run_id: null,
    handoff_trigger: null,
    expires_at: null,
    resume_policy: null,
    takeover_kind: null,
  };
  delete l.session_chain.lease.handoff_boundary_event;
  delete l.session_chain.lease.handoff_project_binding_generation;
  delete l.session_chain.lease.handoff_project_root_digest;
}

export function rollbackAndPause(root, runId, { childRunId, parentOwner, generation, eventData, pauseReason }) {
  try {
    appendAnchored(root, runId, { type: 'respawn-failed', data: { ...eventData, pause_reason: pauseReason } }, (l) => {
      invalidateHandoff(l, childRunId);
      l.status = 'paused';
      l.pause_reason = pauseReason;
    }, (l) => {
      const lease = l.session_chain.lease;
      if (lease.owner_run_id !== parentOwner || lease.generation !== generation) throw new Error('RESPAWN_FENCED: rollback-pause');
      // v1.6 (spec §2.3-5): completed run을 paused로 강등 금지 — 초입 read↔이 append 사이 TOCTOU를 in-lock에서 봉쇄.
      if (l.status === 'completed' || l.status === 'stopped') throw new Error('RUN_TERMINAL: respawn');
    });
  } catch (appendErr) {
    if (String(appendErr.message).startsWith('RESPAWN_FENCED')) return { fenced: true };
    if (String(appendErr.message).startsWith('RUN_TERMINAL')) return { terminal: true };   // v1.6 — caller가 outcome:'terminal'로 전파
    throw appendErr;
  }
  return { ok: true };
}

function cancelHandoffForFinish(root, runId, {
  childRunId, parentOwner, generation, now,
}) {
  try {
    appendAnchored(root, runId, {
      type: 'respawn-cancelled',
      data: { child_run_id: childRunId, reason: 'finish-required' },
      now,
    }, (l) => {
      invalidateHandoff(l, childRunId);
    }, (l) => {
      const lease = l.session_chain.lease;
      if (lease.owner_run_id !== parentOwner || lease.generation !== generation) {
        throw new Error('RESPAWN_FENCED: finish-cancel');
      }
      if (l.status === 'completed' || l.status === 'stopped') {
        throw new Error('RUN_TERMINAL: respawn');
      }
      if (lease.handoff_child_run_id !== childRunId
        || lease.handoff_phase !== 'emitted'
        || lease.state !== 'releasing') {
        throw new Error('RESPAWN_FENCED: finish-cancel');
      }
      if (nextAction(l, { now }).action?.type !== 'finish') {
        throw new Error('FINISH_NO_LONGER_REQUIRED');
      }
    });
  } catch (appendErr) {
    if (String(appendErr.message).startsWith('RESPAWN_FENCED')) return { fenced: true };
    if (String(appendErr.message).startsWith('RUN_TERMINAL')) return { terminal: true };
    if (String(appendErr.message).startsWith('FINISH_NO_LONGER_REQUIRED')) return { changed: true };
    throw appendErr;
  }
  return { ok: true };
}

// Failure handler (b): readiness TIMEOUT (visibleSpawn ok but child not acquired by deadline) → PRESERVE,
// do NOT rollback (R6-plan). A visible child may still be starting (cold start / auth / workspace-trust / user
// prompt). Keep handoff_child_run_id + lease.state (releasing) intact; set resume_policy='human', expires_at=null,
// status='paused', pause_reason='child-timeout-awaiting' so a LATE /deep-loop-resume by the reserved child still
// acquires (Task 8) and unpauses; the headless driver skips it; a human `recover` can abandon it. ONE transaction.
// If the child acquired right at the boundary (fence), distinguish success (reserved child) from a real fence.
function preservePause(root, runId, { childRunId, parentOwner, generation, pauseReason = 'child-timeout-awaiting' }) {
  try {
    appendAnchored(root, runId, { type: 'respawn-timeout', data: { child_run_id: childRunId, pause_reason: pauseReason } }, (l) => {
      l.session_chain.lease = { ...l.session_chain.lease, resume_policy: 'human', expires_at: null };
      l.status = 'paused';
      l.pause_reason = pauseReason;
    }, (l) => {
      const lease = l.session_chain.lease;
      if (lease.owner_run_id !== parentOwner || lease.generation !== generation) throw new Error('RESPAWN_FENCED: timeout-preserve');
      // v1.6 (spec §2.3-5): terminal run은 preserve-pause로도 강등 금지 (readiness-timeout TOCTOU).
      if (l.status === 'completed' || l.status === 'stopped') throw new Error('RUN_TERMINAL: respawn');
    });
  } catch (appendErr) {
    if (String(appendErr.message).startsWith('RUN_TERMINAL')) return { terminal: true };   // v1.6
    if (String(appendErr.message).startsWith('RESPAWN_FENCED')) {
      const fresh = captureFreshLoop(root, runId).session_chain.lease;
      if (fresh.owner_run_id === childRunId && fresh.state === 'active' && fresh.handoff_phase === 'acquired') return { acquired: true };
      return { fenced: true };
    }
    throw appendErr;
  }
  return { ok: true };
}

// Bounded child-readiness handshake shared by the visible first-entry spawn-success path AND the
// already-spawned re-entry recovery (codex r5 finding A). launcher exit 0 (or a prior CAS) is NOT proof the
// reserved child acquired — poll the (releasing) lease until the child takes over (generation+1) or the
// deadline lapses. On deadline → preservePause (do NOT rollback / do NOT re-spawn): a slow child may still
// acquire (Task 8 late-acquire) and a human `recover` can abandon — autonomous-detectable, never silent.
// Count-based loop (maxPolls) with an injectable poll/sleep → deterministic under fixed clocks.
function awaitChildReadiness(root, runId, {
  childRunId, parentOwner, generation, loop, poll, sleep, pollIntervalMs,
  successOutcome, successReason, lateAcquireReason, pauseReason, timeoutOutcome,
}) {
  const timeoutMs = (loop.autonomy?.child_ready_timeout_sec ?? 75) * 1000;
  const interval = pollIntervalMs > 0 ? pollIntervalMs : 1500;
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / interval));
  for (let i = 0; i < maxPolls; i++) {
    const verdict = classifyReadiness(poll(), { childRunId, startGeneration: generation });
    if (verdict === 'success') return { ok: true, outcome: successOutcome, reason: successReason, childRunId };
    if (verdict === 'fenced') return { ok: false, outcome: 'fenced', reason: 'lease-changed-during-readiness', childRunId };
    if (i < maxPolls - 1) sleep(interval);
  }
  // readiness TIMEOUT → PRESERVE (do NOT rollback) — 늦은 /deep-loop-resume 도 reserved child 면 인수 성공.
  const res = preservePause(root, runId, { childRunId, parentOwner, generation, pauseReason });
  if (res.acquired) return { ok: true, outcome: successOutcome, reason: lateAcquireReason, childRunId };
  if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };   // v1.6 (plan r2 high): timeout outcome으로 뭉개짐 금지
  if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-at-timeout', childRunId };
  return { ok: false, outcome: timeoutOutcome, reason: 'readiness-timeout-preserve', childRunId };
}

export function respawn(root, runId, {
  childRunId, key, handoffRel = '', headless = false, attended = false,
  now = Date.now(), spawnFn = defaultSpawn, pollLease, env = process.env,
  sleep = defaultSleep, pollIntervalMs = 1500,
  platform = process.platform, desktopProbe = defaultDesktopProbe,
  codexExecutable = null, deepLoopRoot = DEFAULT_DEEP_LOOP_ROOT,
  descriptorExists = existsSync,
  launchCommandBuilder = buildLaunchCommand,
  expect = null, expectedMode = null,
  revalidateRuntimeExecutable = revalidateTrustedRuntimeExecutable,
  revalidateLauncherExecutable = revalidateTrustedLauncherExecutable,
  runtimeRevalidationOptions = {},
  launcherRevalidationOptions = {},
  tmuxProbeRun = defaultProbeRun,
  tmuxPanesRun = defaultProbeRun,
  tmuxPsRun,
  beforeClaim = () => {},
  locateRouter,
} = {}) {
  void locateRouter;
  reconcileBudget(root, runId);                       // 무결성 fail-stop (탐지 시 throw)
  const loop = captureFreshLoop(root, runId);
  const runtime = sessionRuntime(loop);
  const canonicalRoot = canonicalProjectRoot(loop.project.root);
  const lease = loop.session_chain.lease;
  const generation = lease.generation;
  const parentOwner = lease.owner_run_id;
  const poll = pollLease || (() => captureFreshLoop(root, runId).session_chain.lease);

  if (expect && (lease.owner_run_id !== expect.owner || lease.generation !== expect.generation)) {
    return { ok: false, outcome: 'fenced', reason: 'caller-parent-fence-mismatch', childRunId };
  }

  // v1.6 (spec §2.3-5, r5 P2-a): terminal fast-return — 모든 분기(특히 spawned 재진입 :Codex r5 A)보다 앞.
  // legacy terminal+spawned는 재진입 분기가 already-spawned 성공/preservePause(paused 강등)로 새고,
  // legacy terminal+releasing+emitted는 not-emitted 체크를 통과하므로 초입 차단이 필수.
  if (loop.status === 'completed' || loop.status === 'stopped') {
    return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };
  }
  // 멱등/펜싱 사전조건 (Codex r1 🔴2): 잘못된 key 거부, 이미 spawned 면 재spawn 금지(이중 spawn 차단).
  if (lease.handoff_idempotency_key !== key) return { ok: false, outcome: 'key-mismatch', reason: 'key-mismatch', childRunId };
  // Codex impl r8 🟡: bind the spawn to the RESERVED handoff child — a valid key must not spawn an arbitrary child.
  if (childRunId !== lease.handoff_child_run_id) return { ok: false, outcome: 'child-mismatch', reason: `childRunId ${childRunId} != reserved ${lease.handoff_child_run_id}`, childRunId };
  const topologyError = boundaryHandoffTopologyError(loop);
  if (topologyError) {
    return { ok: false, outcome: 'boundary-invalid', reason: topologyError, childRunId };
  }
  // Codex r5 finding A (HIGH): 'spawned' is the CAS-before-spawn CLAIM, NOT proof the child launched + took
  // over. A prior call may have crashed AFTER the CAS, before/during the external spawn → a blind
  // already-spawned return would strand the handoff with no autonomous recovery. So VERIFY child acquisition;
  // when unconfirmed, recover via the SAME bounded readiness wait the first-entry uses, then preserve-pause.
  // Re-spawn is NEVER done here (that would risk the double spawn the CAS prevents) — recovery is verify+wait+preserve.
  if (lease.handoff_phase === 'spawned') {
    // (1) Reserved child already acquired → genuine already-spawned (a prior call spawned + the child took over).
    if (classifyReadiness(poll(), { childRunId, startGeneration: generation }) === 'success') {
      return { ok: true, outcome: 'already-spawned', reason: 'idempotent', childRunId };
    }
    // (2) Not yet acquired. headless first-entry measures synchronously (the child acquires DURING the
    //     measured subprocess) and interactive never auto-spawns, so a re-entry-before-acquire in those modes
    //     is the normal idempotent-retry / concurrent double-spawn-guard contract — keep the plain no-op (no
    //     spurious pause). An already-paused run was handled by a prior preserve → idempotent no-op too.
    const reMode = resolveSpawnMode(loop, { headless, attended, env });
    if (expectedMode != null && reMode !== expectedMode) {
      return { ok: false, outcome: 'mode-changed', reason: `spawn-mode-changed:${expectedMode}->${reMode}`, childRunId };
    }
    if (reMode === 'headless' || reMode === 'interactive' || loop.status === 'paused') {
      return { ok: true, outcome: 'already-spawned', reason: 'idempotent', childRunId };
    }
    // (3) Visible re-entry: launcher exit was never proof of acquisition + the CAS-doer may have crashed.
    //     Bounded-wait for the reserved child; if it never acquires, preserve-pause (late acquire still safe,
    //     human recover can abandon) — autonomous-detectable, NOT a false success.
    return awaitChildReadiness(root, runId, {
      childRunId, parentOwner, generation, loop, poll, sleep, pollIntervalMs,
      successOutcome: 'already-spawned', successReason: 'child-acquired-on-reentry',
      lateAcquireReason: 'child-acquired-on-reentry-at-timeout',
      pauseReason: 'spawn-unconfirmed-awaiting', timeoutOutcome: 'spawn-unconfirmed-awaiting',
    });
  }
  if (lease.handoff_phase !== 'emitted' || lease.state !== 'releasing') {
    return { ok: false, outcome: 'not-emitted', reason: `phase=${lease.handoff_phase} state=${lease.state}`, childRunId };
  }
  // RUN_PAUSED (Task 6): paused 상태에서는 respawn 금지. respawn 은 leaseCheck 를 경유하지 않으므로 명시 차단.
  if (loop.status === 'paused') return { ok: false, outcome: 'paused', reason: 'RUN_PAUSED', childRunId };

  // ── gate check (spec §9, R12-LL) ─────────────────────────────────────────
  // Gate MUST win regardless of launcher availability (R12-LL fix): a gate-blocked run must always
  // ROLLBACK + pause, even when there is no auto-launcher. Evaluating gate before mode selection ensures
  // that gate-blocked + no-launcher → rollback/invalidate (not preserve). Only after a passing gate does
  // mode selection run; gate-OK + no-launcher is a genuine needs-human → preserve is then correct.
  const gate = respawnGate(loop, { now });
  if (!gate.ok) {
    // 실패모드 (A) gate-blocked: ROLLBACK + paused — ONE 트랜잭션 (R12-LL; 자식 무효화, 결코 실행 안 됨).
    const res = rollbackAndPause(root, runId, { childRunId, parentOwner, generation, eventData: { child_run_id: childRunId, gate: gate.reason }, pauseReason: `gate:${gate.reason}` });
    if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };   // v1.6
    if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-pause', childRunId };
    return { ok: false, outcome: 'gate-blocked', reason: gate.reason, childRunId };
  }

  // ── mode selection (spec §7) ────────────────────────────────────────────────
  const mode = resolveSpawnMode(loop, { headless, attended, env });
  if (expectedMode != null && mode !== expectedMode) {
    return { ok: false, outcome: 'mode-changed', reason: `spawn-mode-changed:${expectedMode}->${mode}`, childRunId };
  }
  if (mode === 'interactive') {
    // No auto-spawn possible; gate already passed → PRESERVE the emitted handoff (do NOT rollback) — the
    // skill pauses via `deep-loop pause --mode preserve`, keeping the reserved child for a human/visible-continue
    // to pick up. This is a genuine needs-human, NOT a gate bypass (gate check already passed above).
    return { ok: false, outcome: 'no-launcher', reason: 'no-auto-launcher', childRunId };
  }
  const isHeadless = mode === 'headless';
  let runtimeExecutableIdentity = null;
  let launcherIdentity = null;
  let launcherAuthoritySnapshot = null;
  let posixLauncherSnapshot = null;
  const requiresPosixVisibleTrust = ['linux', 'darwin'].includes(platform)
    && runtimeCapability(runtime, 'requires_posix_visible_executable_trust')
    && ['cmux', 'iterm2', 'terminal-app', 'tmux'].includes(mode);
  const requiresPosixTmuxLauncher = ['linux', 'darwin'].includes(platform) && mode === 'tmux';
  // The shared headless host owns Codex executable preflight and post-CAS
  // revalidation. This local authority path is for auto-visible continuation;
  // Windows visible wt/powershell still require a direct runtime identity.
  const requiresRuntime = (platform === 'win32' && (mode === 'wt' || mode === 'powershell'))
    || requiresPosixVisibleTrust;
  const requiresWindowsLauncher = platform === 'win32'
    && (mode === 'wt' || mode === 'powershell'
      || (runtimeCapability(runtime, 'desktop_transport') && mode === 'desktop'));
  if (requiresRuntime || requiresWindowsLauncher || requiresPosixVisibleTrust || requiresPosixTmuxLauncher) {
    let identityStage = requiresRuntime ? 'runtime' : 'launcher';
    let identityReason = null;
    try {
      if (requiresRuntime) {
        const stored = loop.autonomy?.runtime_executable_approval;
        runtimeExecutableIdentity = revalidateRuntimeExecutable(stored, { ...runtimeRevalidationOptions, platform });
        if (!runtimeExecutableIdentity || runtimeExecutableIdentity.runtime !== runtime
          || runtimeExecutableIdentity.canonical_path !== stored?.canonical_path
          || !isDeepStrictEqual(runtimeExecutableIdentity, stored)) throw new Error('runtime identity mismatch');
      }
      if (requiresWindowsLauncher) {
        identityStage = 'launcher';
        const expectedKind = mode === 'wt' ? 'wt' : 'powershell';
        launcherAuthoritySnapshot = currentLauncherAuthority(loop, expectedKind, {
          allowDetachedDurable: mode === 'desktop',
        });
        const stored = launcherAuthoritySnapshot?.identity;
        if (stored == null) throw new Error('launcher authority unavailable');
        launcherIdentity = revalidateLauncherExecutable(stored, { ...launcherRevalidationOptions, platform });
        if (!launcherIdentity || launcherIdentity.kind !== expectedKind
          || !isDeepStrictEqual(launcherIdentity, stored)) throw new Error('launcher identity mismatch');
      }
      if (requiresPosixTmuxLauncher) {
        identityStage = 'launcher';
        launcherAuthoritySnapshot = durableLauncherAuthority(loop, 'tmux');
        const stored = launcherAuthoritySnapshot?.identity;
        if (stored == null || !isDeepStrictEqual(loop.session_spawn?.launcher_identity, stored)) {
          throw new Error('launcher authority unavailable');
        }
        launcherIdentity = revalidateLauncherExecutable(stored, { ...launcherRevalidationOptions, platform });
        if (!launcherIdentity || launcherIdentity.kind !== 'tmux'
          || !isDeepStrictEqual(launcherIdentity, stored)) throw new Error('launcher identity mismatch');
        posixLauncherSnapshot = currentPosixCodexLauncher(loop, mode, platform);
        if (posixLauncherSnapshot == null) {
          identityReason = 'launcher-session-invalid';
          throw new Error('launcher session unavailable');
        }
        const socket = probeTmuxSocket(launcherIdentity, {
          socketPath: posixLauncherSnapshot.launcher_socket,
          serverPid: posixLauncherSnapshot.launcher_pid,
          run: tmuxProbeRun,
        });
        if (!socket.ok) {
          identityReason = 'launcher-socket-unverified';
          throw new Error('launcher socket unavailable');
        }
        if (socket.sessionId !== posixLauncherSnapshot.launcher_session) {
          identityReason = 'launcher-session-unverified';
          throw new Error('launcher session unavailable');
        }
        const panes = listTmuxPanes(launcherIdentity, {
          socketPath: posixLauncherSnapshot.launcher_socket, run: tmuxPanesRun,
        });
        const ancestrySession = deriveTmuxSessionByAncestry({
          panes, processPid: process.pid, ...(tmuxPsRun === undefined ? {} : { psRun: tmuxPsRun }),
        });
        if (ancestrySession == null || ancestrySession !== posixLauncherSnapshot.launcher_session) {
          identityReason = 'launcher-session-unverified';
          throw new Error('launcher session unavailable');
        }
      } else if (requiresPosixVisibleTrust) {
        identityStage = 'launcher';
        posixLauncherSnapshot = currentPosixCodexLauncher(loop, mode, platform);
        if (posixLauncherSnapshot == null) throw new Error('launcher session unavailable');
      }
    } catch {
      const reason = identityReason ?? `${identityStage}-identity-unavailable`;
      const res = preservePause(root, runId, { childRunId, parentOwner, generation, pauseReason: reason });
      if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };
      if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-pause', childRunId };
      return { ok: false, outcome: 'no-launcher', reason, childRunId };
    }
  }
  // Codex r3 🔴3: derive effHandoffRel + construct/validate the launch entry BEFORE the spawned CAS.
  // buildLaunchCommand can throw UNSAFE_SPAWN_ARG (or cmds[mode] undefined for an unrecognised mode).
  // A throw here leaves the lease in 'emitted' (no CAS yet → not stranded). Only command CONSTRUCTION
  // moves above the CAS; spawnFn call and its try/catch remain below, unchanged.
  const childSession = loop.session_chain.sessions.find(s => s.run_id === childRunId);
  const effHandoffRel = (childSession && childSession.handoff_rel) || handoffRel;
  // Task 5b: only a Claude 'desktop' mode spawn probes the real (or injected) handler-verification target —
  // Codex and other modes never touch it. A verified target's argvTarget threads through as `desktopTarget`; an
  // unverified/failed probe (dt.ok===false) yields null → buildLaunchCommand's unavailable entry →
  // the generalized unavailable-entry guard below preserve-pauses (never a rollback/fenced-target spawn).
  const dt = runtimeCapability(runtime, 'desktop_transport') && mode === 'desktop'
    ? desktopProbe({ platform }) : null;
  // A goal handoff rotates the coordinator; terminal worker/checker routing is
  // not the profile of its new owner conversation. Legacy episode launch stays frozen.
  const launchProfile = isGoalDriven(loop)
    ? { model: loop.autonomy?.session_model ?? null, effort: loop.autonomy?.session_effort ?? null }
    : resolveLaunchProfile(loop, { episodeId: loop.current_episode });
  let _cmds, _entry;
  try {
    // launcherBin + launcherSocket threading (R3/R7-plan): cmux requires the absolute bundled bin + verified socket.
    // The default binds production descriptors to the canonical state root.
    // Foreign-platform tests may inject the pure builder to keep a physical
    // POSIX fixture distinct from a simulated fully-qualified Windows target.
    _cmds = launchCommandBuilder({
      runtime, root: canonicalRoot, parentRunId: runId, childRunId, handoffRel: effHandoffRel,
      launcher: loop.session_spawn?.launcher,
      launcherBin: loop.session_spawn?.launcher_bin,
      launcherSocket: loop.session_spawn?.launcher_socket,
      launcherSession: loop.session_spawn?.launcher_session,
      platform, desktopTarget: dt && dt.ok ? dt.argvTarget : null,
      exists: descriptorExists,
      model: launchProfile.model, effort: launchProfile.effort,
      goalDriven: isGoalDriven(loop),
      codexExecutable, deepLoopRoot,
      runtimeExecutableIdentity, launcherIdentity,
    });
    _entry = _cmds[mode];
  } catch (buildErr) {
    // A visible caller does not inspect soft outcomes before returning, so even a pre-CAS descriptor error
    // must preserve-pause here. Keep the emitted reservation recoverable and retain the bounded original
    // construction reason rather than replacing it with a generic marker.
    const buildReason = String(buildErr.message || buildErr).slice(0, 512);
    const res = preservePause(root, runId, {
      childRunId, parentOwner, generation, pauseReason: buildReason,
    });
    if (res.acquired) return { ok: true, outcome: 'spawned', reason: 'child-acquired-during-build-error', childRunId };
    if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };
    if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-pause', childRunId };
    return { ok: false, outcome: 'build-error', reason: buildReason, childRunId };
  }

  // Fail closed: ANY visible/desktop mode with an unavailable entry (no trusted launcher_bin — e.g. a
  // stale/migrated launcher='powershell' run — or an unverified desktop target, or (win32 only) a
  // verified win-exe target with no trusted PowerShell bin resolvable — see runtime-descriptor.mjs's win32
  // branch, which otherwise builds a runnable non-blocking `Start-Process` entry) — must NOT spawn.
  // `interactive` never reaches here (it returns above, before `_cmds` is
  // built); headless carries a runtime-selected measured Claude or approved Codex entry, while an
  // unsupported Codex transport remains unavailable and is caught here before CAS; a valid launcher entry
  // always has a `bin` (guard never fires). Unlike the interactive no-launcher path (which the else/none
  // skill branch preserve-pauses), this is reached via the VISIBLE/DESKTOP skill branch (launcher!=='none'
  // → `respawn --attended`), which does NOT inspect the outcome — so respawn must preserve-pause ITSELF here, or
  // the handoff is left emitted/releasing, unpaused, with no child spawned (stranded). Mirrors gate-blocked self-pause.
  if (!_entry || _entry.unavailable || !_entry.bin) {
    const unavailableReason = _entry?.reason || `${mode}-launcher-unavailable`;
    const res = preservePause(root, runId, { childRunId, parentOwner, generation, pauseReason: unavailableReason });
    if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };   // v1.6
    if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-pause', childRunId };
    return { ok: false, outcome: 'no-launcher', reason: unavailableReason, childRunId };
  }

  const revalidateIdentityStage = (sourceLoop) => {
    if (runtimeExecutableIdentity != null) {
      try {
        const stored = sourceLoop.autonomy?.runtime_executable_approval;
        if (!isDeepStrictEqual(stored, loop.autonomy?.runtime_executable_approval)) {
          return 'runtime-identity-drift';
        }
        const fresh = revalidateRuntimeExecutable(stored, { ...runtimeRevalidationOptions, platform });
        if (!isDeepStrictEqual(fresh, runtimeExecutableIdentity)) return 'runtime-identity-drift';
      } catch {
        return 'runtime-identity-drift';
      }
    }
    if (platform === 'win32' && launcherIdentity != null) {
      try {
        const expectedKind = mode === 'wt' ? 'wt' : 'powershell';
        const authority = currentLauncherAuthority(sourceLoop, expectedKind, {
          allowDetachedDurable: mode === 'desktop',
        });
        if (authority == null || launcherAuthoritySnapshot == null
          || authority.source !== launcherAuthoritySnapshot.source
          || !isDeepStrictEqual(authority.identity, launcherAuthoritySnapshot.identity)) {
          return 'launcher-identity-drift';
        }
        const fresh = revalidateLauncherExecutable(authority.identity, { ...launcherRevalidationOptions, platform });
        if (!isDeepStrictEqual(fresh, launcherIdentity)) return 'launcher-identity-drift';
      } catch {
        return 'launcher-identity-drift';
      }
    }
    if (requiresPosixTmuxLauncher && launcherIdentity != null) {
      const session = sourceLoop.session_spawn;
      if (typeof session?.launcher_session !== 'string' || !/^[0-9]+$/.test(session.launcher_session)
        || session.launcher_session !== posixLauncherSnapshot?.launcher_session) {
        return 'launcher-session-invalid';
      }
      try {
        const authority = durableLauncherAuthority(sourceLoop, 'tmux');
        if (authority == null || launcherAuthoritySnapshot == null
          || authority.source !== launcherAuthoritySnapshot.source
          || !isDeepStrictEqual(authority.identity, launcherAuthoritySnapshot.identity)
          || !isDeepStrictEqual(session.launcher_identity, authority.identity)) {
          return 'launcher-identity-drift';
        }
        const freshIdentity = revalidateLauncherExecutable(authority.identity, {
          ...launcherRevalidationOptions, platform,
        });
        if (!isDeepStrictEqual(freshIdentity, launcherIdentity)) return 'launcher-identity-drift';
        const freshSnapshot = currentPosixCodexLauncher(sourceLoop, mode, platform);
        if (!isDeepStrictEqual(freshSnapshot, posixLauncherSnapshot)) return 'launcher-identity-drift';
        const socket = probeTmuxSocket(freshIdentity, {
          socketPath: freshSnapshot.launcher_socket,
          serverPid: freshSnapshot.launcher_pid,
          run: tmuxProbeRun,
        });
        if (!socket.ok) return 'launcher-socket-unverified';
        if (socket.sessionId !== session.launcher_session) return 'launcher-session-unverified';
        const panes = listTmuxPanes(freshIdentity, {
          socketPath: freshSnapshot.launcher_socket, run: tmuxPanesRun,
        });
        const ancestrySession = deriveTmuxSessionByAncestry({
          panes, processPid: process.pid, ...(tmuxPsRun === undefined ? {} : { psRun: tmuxPsRun }),
        });
        if (ancestrySession == null || ancestrySession !== session.launcher_session) {
          return 'launcher-session-unverified';
        }
      } catch {
        return 'launcher-identity-drift';
      }
    } else if (posixLauncherSnapshot != null) {
      const fresh = currentPosixCodexLauncher(sourceLoop, mode, platform);
      if (!isDeepStrictEqual(fresh, posixLauncherSnapshot)) return 'launcher-identity-drift';
    }
    return null;
  };

  // Fresh durable identity + direct version/hash checks immediately before the CAS may authorize spawn.
  const preClaimIdentityFailure = revalidateIdentityStage(captureFreshLoop(root, runId));
  if (preClaimIdentityFailure) {
    const res = preservePause(root, runId, {
      childRunId, parentOwner, generation, pauseReason: preClaimIdentityFailure,
    });
    if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };
    if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-pause', childRunId };
    return { ok: false, outcome: 'no-launcher', reason: preClaimIdentityFailure, childRunId };
  }

  beforeClaim();

  // Codex r2 🔴3: 외부 spawn **이전에** emitted→spawned 를 원자적(withLock CAS)으로 클레임 (이중 외부 spawn 차단).
  // Command is already validated above; only the CAS + spawnFn call remain below.
  const claim = claimSpawnedHandoff(root, runId, {
    key, childRunId, parentOwner, generation, now, mode,
  });
  if (!claim.ok) {
    // v1.6 (spec §2.3-5, plan r1): 초입 read↔클레임 사이 finish 경합 — phase-error로 뭉개짐 금지.
    if (claim.reason === 'RUN_TERMINAL') return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };
    if (claim.reason === 'fenced') return { ok: false, outcome: 'fenced', reason: 'lease-changed-during-claim', childRunId };
    if (claim.reason === 'attended-launch-unauthorized') {
      const preserved = preservePause(root, runId, {
        childRunId, parentOwner, generation, pauseReason: claim.reason,
      });
      if (preserved.acquired) {
        return {
          ok: true, outcome: 'spawned',
          reason: 'child-acquired-during-attended-authorization-race', childRunId,
        };
      }
      if (preserved.terminal) {
        return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };
      }
      if (preserved.fenced) {
        return {
          ok: false, outcome: 'fenced',
          reason: 'lease-changed-before-attended-authorization-pause', childRunId,
        };
      }
      return { ok: false, outcome: 'no-launcher', reason: claim.reason, childRunId };
    }
    if (claim.reason === 'boundary-topology-invalid'
      || claim.reason === 'BOUNDARY_EVENT_MISMATCH') {
      return { ok: false, outcome: 'boundary-invalid', reason: claim.reason, childRunId };
    }
    if (claim.reason === 'FINISH_REQUIRED') {
      const res = cancelHandoffForFinish(root, runId, {
        childRunId, parentOwner, generation, now,
      });
      if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };
      if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-finish-cancel', childRunId };
      if (res.changed) return { ok: false, outcome: 'phase-error', reason: 'FINISH_NO_LONGER_REQUIRED', childRunId };
      return { ok: false, outcome: 'gate-blocked', reason: claim.reason, childRunId };
    }
    if (claim.reason === 'budget' || claim.reason === 'breaker'
      || claim.reason.includes('max_sessions')
      || claim.reason.includes('wallclock')
      || claim.reason.includes('auto_handoff')) {
      const res = rollbackAndPause(root, runId, {
        childRunId, parentOwner, generation,
        eventData: { child_run_id: childRunId, gate: claim.reason },
        pauseReason: `gate:${claim.reason}`,
      });
      if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };
      if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-pause', childRunId };
      return { ok: false, outcome: 'gate-blocked', reason: claim.reason, childRunId };
    }
    return { ok: false, outcome: 'phase-error', reason: claim.reason, childRunId };
  }
  if (claim.reason === 'idempotent-noop') return { ok: true, outcome: 'already-spawned', reason: 'idempotent', childRunId };

  // Codex impl r8 🟡: entry is already built + validated before the CAS above.
  const entry = _entry;
  const identityFailure = revalidateIdentityStage(captureFreshLoop(root, runId));
  if (identityFailure) {
    const res = rollbackAndPause(root, runId, {
      childRunId, parentOwner, generation,
      eventData: { child_run_id: childRunId, error: identityFailure },
      pauseReason: 'launch-failed',
    });
    if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };
    if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-failure-record', childRunId };
    return { ok: false, outcome: 'failed_launch', reason: identityFailure, childRunId };
  }
  try {
    const res = spawnFn(entry);
    if (res && res.ok === false) throw new Error(res.reason || 'spawn-returned-false');
  } catch (e) {
    // 실패모드 (B) launch failure: ROLLBACK + paused — ONE 트랜잭션 (자식 무효화, 결코 시작 안 됨).
    const res = rollbackAndPause(root, runId, { childRunId, parentOwner, generation, eventData: { child_run_id: childRunId, error: String(e.message || e) }, pauseReason: 'launch-failed' });
    if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };   // v1.6
    if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-failure-record', childRunId };
    return { ok: false, outcome: 'failed_launch', reason: String(e.message || e), childRunId };
  }

  // spawn 성공 → respawn-spawned 기록 (parent fence). lease 는 releasing 유지 — 자식이 handshake acquire.
  // (Codex impl r11 🔴: 이벤트 기록과 lease 전이 분리 금지 → 단일 appendAnchored.)
  try {
    appendAnchored(root, runId, { type: 'respawn-spawned', data: { child_run_id: childRunId, headless: isHeadless } }, (_l) => {
      // 자식이 releasing 상태의 lease 를 handshake acquire (acquireLease: releasing && owner===handoff_child_run_id).
    }, (l) => {
      if (l.session_chain.lease.owner_run_id !== parentOwner || l.session_chain.lease.generation !== generation) {
        throw new Error('RESPAWN_FENCED: spawned-append');
      }
      // v1.6 (spec §2.3-5): terminal run에 respawn-spawned 이벤트 append 금지 (spawn↔기록 사이 TOCTOU).
      if (l.status === 'completed' || l.status === 'stopped') throw new Error('RUN_TERMINAL: respawn');
      const boundaryError = boundaryHandoffTopologyError(l);
      if (boundaryError) throw new Error(`RESPAWN_BOUNDARY_INVALID: ${boundaryError}`);
    });
  } catch (appendErr) {
    if (String(appendErr.message).startsWith('RUN_TERMINAL')) {
      return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };   // v1.6
    }
    if (String(appendErr.message).startsWith('RESPAWN_FENCED')) {
      // R6-U: a fast RESERVED child may have acquired before we recorded → that is SUCCESS, not a fence.
      const fresh = captureFreshLoop(root, runId).session_chain.lease;
      if (fresh.owner_run_id === childRunId && fresh.state === 'active' && fresh.handoff_phase === 'acquired') {
        return { ok: true, outcome: 'spawned', reason: 'fast-child-acquired', childRunId };
      }
      return { ok: false, outcome: 'fenced', reason: 'lease-changed-after-spawn', childRunId };
    }
    if (String(appendErr.message).startsWith('RESPAWN_BOUNDARY_INVALID')) {
      return { ok: false, outcome: 'boundary-invalid', reason: 'boundary-topology-invalid', childRunId };
    }
    throw appendErr;
  }

  // headless 경로: 기존대로 동기 측정 (spawnFn 이 동기적으로 측정) — child-readiness poll 불필요.
  if (isHeadless) return { ok: true, outcome: 'spawned', reason: 'spawned', childRunId };

  // visible 경로: bounded child-readiness handshake (R1-B). launcher exit 0 != 자식 생성 증명 — 자식이 releasing
  // lease 를 acquire(generation+1)할 때까지 deadline 동안 poll. deadlock 없음(lease 가 releasing).
  // Same helper as the already-spawned re-entry recovery (codex r5 finding A) — single readiness contract.
  return awaitChildReadiness(root, runId, {
    childRunId, parentOwner, generation, loop, poll, sleep, pollIntervalMs,
    successOutcome: 'spawned', successReason: 'child-acquired',
    lateAcquireReason: 'child-acquired-at-timeout',
    pauseReason: 'child-timeout-awaiting', timeoutOutcome: 'child-timeout-awaiting',
  });
}
