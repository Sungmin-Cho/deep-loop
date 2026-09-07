import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDir } from '../scripts/lib/state.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { emitHandoff as emitHandoffImpl } from '../scripts/lib/handoff.mjs';
import { acquireLease, advanceHandoffPhase, releaseLease } from '../scripts/lib/lease.mjs';
import { respawn as respawnImpl, respawnGate, resolveSpawnMode, isHeadlessInvocation } from '../scripts/lib/respawn.mjs';
import { buildLaunchCommand, buildRuntimeResumeDescriptor } from '../scripts/lib/runtime-descriptor.mjs';
import { sessionRuntime } from '../scripts/lib/runtime.mjs';
import { revalidateTrustedLauncherExecutable } from '../scripts/lib/runtime-executable.mjs';
import { createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';
import { migrateAuthenticLegacyTransport } from './helpers/legacy-transport.mjs';

const NOW0 = new Date('2026-06-24T00:00:00Z');
const NOW1 = Date.parse('2026-06-24T01:00:00Z');
const WINDOWS_TARGET_ROOT = 'C:\\Fixture Project';
const WINDOWS_DEEP_LOOP_ROOT = 'C:\\Fixture Deep Loop';
const POSIX_TARGET_ROOT = '/fixture-project';
const POSIX_DEEP_LOOP_ROOT = '/fixture-deep-loop';
const attendedApproval = style => ({
  style, approved_at: '2026-06-24T00:00:00.000Z',
});

// Inject no-signal env + no-op run so detect-terminal is deterministic regardless of ambient env.
const noOpRun = () => ({ code: 1 });

function windowsDescriptorOptions(options) {
  const deepLoopRoot = /^[A-Za-z]:[\\/]/.test(options.deepLoopRoot || '')
    ? options.deepLoopRoot
    : WINDOWS_DEEP_LOOP_ROOT;
  return { ...options, root: WINDOWS_TARGET_ROOT, deepLoopRoot };
}

function buildWindowsDescriptor(options) {
  return buildRuntimeResumeDescriptor(windowsDescriptorOptions(options));
}

function buildWindowsLaunchCommand(options) {
  return buildLaunchCommand(windowsDescriptorOptions(options));
}

function posixDescriptorOptions(options) {
  return { ...options, root: POSIX_TARGET_ROOT, deepLoopRoot: POSIX_DEEP_LOOP_ROOT };
}

function buildPosixDescriptor(options) {
  return buildRuntimeResumeDescriptor(posixDescriptorOptions(options));
}

function buildPosixLaunchCommand(options) {
  return buildLaunchCommand(posixDescriptorOptions(options));
}

function isForeignWindowsCodexFixture(root, runId, options) {
  return process.platform !== 'win32' && options?.platform === 'win32'
    && sessionRuntime(readState(root, runId).data) === 'codex';
}

function targetPlatform(root, runId, options) {
  return options?.platform ?? readState(root, runId).data.session_spawn?.platform ?? 'linux';
}

function isForeignPosixCodexFixture(root, runId, options) {
  return process.platform === 'win32' && targetPlatform(root, runId, options) !== 'win32'
    && sessionRuntime(readState(root, runId).data) === 'codex';
}

function emitHandoff(root, runId, options = {}) {
  const normalized = { ...options, platform: targetPlatform(root, runId, options) };
  if (isForeignWindowsCodexFixture(root, runId, normalized)) {
    normalized.descriptorBuilder ??= buildWindowsDescriptor;
  } else if (isForeignPosixCodexFixture(root, runId, normalized)) {
    normalized.descriptorBuilder ??= buildPosixDescriptor;
  }
  return emitHandoffImpl(root, runId, normalized);
}

function respawn(root, runId, options = {}) {
  const normalized = { ...options, platform: targetPlatform(root, runId, options) };
  if (readState(root, runId).data.session_spawn?.launcher === 'tmux') {
    normalized.tmuxPanesRun ??= () => ({ code: 0, stdout: '%1 987654 $7\n' });
    normalized.tmuxPsRun ??= () => ({ status: 0, stdout: `${process.pid} 987654\n987654 1\n1 0\n` });
  }
  if (isForeignWindowsCodexFixture(root, runId, normalized)) {
    normalized.launchCommandBuilder ??= buildWindowsLaunchCommand;
  } else if (isForeignPosixCodexFixture(root, runId, normalized)) {
    normalized.launchCommandBuilder ??= buildPosixLaunchCommand;
  }
  return respawnImpl(root, runId, normalized);
}

// 자기완결 seed: run 생성 후 mutate(loop)로 필요한 필드만 조정하고 writeState.
function seed(mutate, runtime = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime, goal: 'g', now: NOW0, env: {}, platform: 'linux', run: noOpRun });
  migrateAuthenticLegacyTransport(root, runId);
  if (mutate) { const { data } = readState(root, runId); mutate(data); writeState(root, runId, data); }
  return { root, runId };
}

function openWorkstreamScope() {
  return {
    kind: 'workstream', workstream_id: null, bound_at_seq: null,
    terminal_event: null, closed_at: null, superseded_at: null,
  };
}

// seed a run with a concrete visible launcher (cmux by default) + spawn_style.
// Existing attended-launch fixtures opt in explicitly; tests covering migration/default safety pass approved:false.
function seedLauncher({
  spawn_style = 'visible', launcher = 'cmux', runtime = 'claude', approved = true,
} = {}) {
  return seed((d) => {
    d.autonomy.spawn_style = spawn_style;
    d.autonomy.attended_launch_approval = approved && ['visible', 'desktop'].includes(spawn_style)
      ? attendedApproval(spawn_style)
      : null;
    d.session_spawn = {
      platform: 'darwin', launcher,
      launcher_bin: '/abs/bin/' + launcher, launcher_socket: '/tmp/' + launcher + '.sock',
      surface: 'multiplexer', reachable: true, visible: true, signals: {}, probe: null,
      reason: 'detected', fallback: 'launch-command-file', detected_at: '2026-06-24T00:00:00Z',
    };
  }, runtime);
}

function tmuxRuntimeIdentity() {
  return {
    runtime: 'codex', canonical_path: '/opt/openai/codex', sha256: 'a'.repeat(64),
    version: '0.144.1', platform: 'linux', arch: process.arch,
    source: 'human-explicit', package: null, authenticode: null,
    approved_by: 'human', approved_at: '2026-06-24T00:00:00.000Z',
  };
}

function seedTmuxLauncher(runtime = 'claude') {
  const seeded = seed(null, runtime);
  const binDir = join(seeded.root, 'bin');
  mkdirSync(binDir);
  const launcherBin = join(binDir, 'tmux');
  writeFileSync(launcherBin, '#!/bin/sh\nprintf "tmux 3.4\\n"\n');
  chmodSync(launcherBin, 0o755);
  const canonicalLauncherBin = realpathSync(launcherBin);
  const launcherIdentity = {
    kind: 'tmux', canonical_path: canonicalLauncherBin,
    sha256: createHash('sha256').update(readFileSync(canonicalLauncherBin)).digest('hex'),
    version: 'tmux 3.4', platform: 'linux', arch: process.arch,
    source: 'human-explicit', authenticode: null,
    approved_by: 'human', approved_at: '2026-06-24T00:00:00.000Z',
  };
  const { data } = readState(seeded.root, seeded.runId);
  data.autonomy.spawn_style = 'visible';
  data.autonomy.attended_launch_approval = attendedApproval('visible');
  data.autonomy.launcher_executable_approvals.tmux = launcherIdentity;
  if (runtime === 'codex') data.autonomy.runtime_executable_approval = tmuxRuntimeIdentity();
  data.session_spawn = {
    platform: 'linux', launcher: 'tmux', launcher_bin: canonicalLauncherBin,
    launcher_identity: launcherIdentity, launcher_socket: '/tmp/tmux-501/default',
    launcher_pid: '12345', launcher_session: '7', surface: 'window',
    reachable: true, visible: true, signals: { tmux: true },
    probe: { cmd: [canonicalLauncherBin, '-S', '/tmp/tmux-501/default', 'display-message', '-p', '#{pid} #{session_id}'], code: 0 },
    reason: null, fallback: 'launch-command-file', detected_at: '2026-06-24T00:00:00.000Z',
  };
  writeState(seeded.root, seeded.runId, data);
  return { ...seeded, launcherBin: canonicalLauncherBin, launcherIdentity };
}

function emitTmux(root, runId, trigger) {
  return emitHandoff(root, runId, {
    trigger, now: NOW1, expect: expect_(runId), platform: 'linux',
    descriptorBuilder: buildPosixDescriptor,
  });
}

const tmuxVersionRun = () => ({ status: 0, signal: null, stdout: 'tmux 3.4\n', stderr: '' });
const tmuxProbeOk = () => ({ code: 0, stdout: '12345 $7\n' });

function expect_(runId) { return { owner: runId, generation: 1 }; }

// Sequence helper for fake pollLease — returns successive values, last value sticks after exhaustion.
function seq(values) { let i = 0; return () => values[Math.min(i++, values.length - 1)]; }
const noSleep = () => {};

// seedTmuxLauncher hashes a PHYSICAL fake tmux binary, and several of these tests exercise the real
// revalidateTrustedLauncherExecutable against it. On a win32 host that physical path is a Windows
// path, which every POSIX tmux validator rejects by design (fail-closed) — the fixtures cannot
// exist there. Same rule as the runtime-executable POSIX fixture skips.
const POSIX_TMUX_FIXTURE_SKIP = process.platform === 'win32'
  ? 'win32 host fixture paths are not POSIX-absolute; the tmux launcher fixtures fail closed by design'
  : false;

test('tmux visible respawn revalidates the approved launcher and socket before spawn', { skip: POSIX_TMUX_FIXTURE_SKIP }, () => {
  const { root, runId, launcherIdentity } = seedTmuxLauncher();
  const h = emitTmux(root, runId, 'tmux-visible-approved');
  let launcherChecks = 0;
  let probeChecks = 0;
  let captured = null;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'linux',
    revalidateLauncherExecutable: (identity, options) => {
      launcherChecks++;
      assert.deepEqual(identity, launcherIdentity);
      return revalidateTrustedLauncherExecutable(identity, options);
    },
    launcherRevalidationOptions: { arch: process.arch, runVersion: tmuxVersionRun },
    tmuxProbeRun: (bin, argv, options) => {
      probeChecks++;
      assert.equal(bin, launcherIdentity.canonical_path);
      assert.deepEqual(argv, ['-S', '/tmp/tmux-501/default', 'display-message', '-p', '#{pid} #{session_id}']);
      assert.equal(options.capture, true);
      return tmuxProbeOk();
    },
    spawnFn: entry => { captured = entry; return { ok: true }; },
    pollLease: () => ({ state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 }),
    sleep: noSleep,
  });

  assert.equal(r.ok, true, `${r.outcome}: ${r.reason}`);
  assert.equal(r.outcome, 'spawned');
  assert.equal(launcherChecks, 3, 'initial, pre-CAS, and post-CAS launcher checks are mandatory');
  assert.equal(probeChecks, 3, 'socket ownership is re-probed at every launcher authority stage');
  assert.equal(captured.bin, launcherIdentity.canonical_path);
  assert.deepEqual(captured.argv.slice(0, 7), [
    '-S', '/tmp/tmux-501/default', 'new-window', '-t', '7', '-c', readState(root, runId).data.project.root,
  ]);
  assert.equal(captured.shell, false);
});

test('tmux post-CAS launcher identity drift rolls back, pauses, and marks failed launch', { skip: POSIX_TMUX_FIXTURE_SKIP }, () => {
  const { root, runId, launcherIdentity } = seedTmuxLauncher();
  const h = emitTmux(root, runId, 'tmux-post-cas-identity-drift');
  const replacement = {
    ...launcherIdentity,
    sha256: 'd'.repeat(64),
    approved_at: '2026-06-24T00:01:00.000Z',
  };
  let launcherChecks = 0;
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'linux',
    revalidateLauncherExecutable: identity => {
      launcherChecks++;
      assert.deepEqual(identity, launcherIdentity);
      if (launcherChecks === 2) {
        const { data } = readState(root, runId);
        data.autonomy.launcher_executable_approvals.tmux = replacement;
        writeState(root, runId, data);
      }
      return identity;
    },
    tmuxProbeRun: tmuxProbeOk,
    spawnFn: () => { spawned++; return { ok: true }; },
    sleep: noSleep,
  });

  assert.equal(launcherChecks, 2, 'post-CAS authority mismatch rejects the replaced approval before a third probe');
  assert.equal(spawned, 0);
  assert.equal(r.outcome, 'failed_launch');
  assert.equal(r.reason, 'launcher-identity-drift');
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'launch-failed');
  assert.equal(after.session_chain.lease.state, 'active');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.lease.handoff_child_run_id, null);
  assert.equal(after.session_chain.sessions.find(session => session.run_id === h.childRunId)?.outcome, 'failed_launch');
});

test('tmux executable hash drift preserves the handoff before spawned CAS', { skip: POSIX_TMUX_FIXTURE_SKIP }, () => {
  const { root, runId, launcherBin } = seedTmuxLauncher();
  const h = emitTmux(root, runId, 'tmux-hash-drift');
  writeFileSync(launcherBin, '#!/bin/sh\nprintf "tmux 9.9\\n"\n');
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'linux',
    launcherRevalidationOptions: { arch: process.arch, runVersion: tmuxVersionRun },
    tmuxProbeRun: tmuxProbeOk,
    spawnFn: () => { spawned++; return { ok: true }; }, sleep: noSleep,
  });

  assert.equal(spawned, 0);
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(r.reason, 'launcher-identity-unavailable');
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
});

test('tmux executable replaced by a final symlink is rejected before spawned CAS', { skip: POSIX_TMUX_FIXTURE_SKIP }, (t) => {
  const { root, runId, launcherBin } = seedTmuxLauncher();
  const h = emitTmux(root, runId, 'tmux-symlink-replacement');
  const moved = `${launcherBin}.moved`;
  renameSync(launcherBin, moved);
  if (!createFileSymlinkOrSkip(t, moved, launcherBin)) return;
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'linux',
    launcherRevalidationOptions: { arch: process.arch, runVersion: tmuxVersionRun },
    tmuxProbeRun: tmuxProbeOk,
    spawnFn: () => { spawned++; return { ok: true }; }, sleep: noSleep,
  });

  assert.equal(spawned, 0);
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(r.reason, 'launcher-identity-unavailable');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

test('tmux socket ownership mismatch at pre-CAS revalidation preserves the handoff', { skip: POSIX_TMUX_FIXTURE_SKIP }, () => {
  const { root, runId } = seedTmuxLauncher();
  const h = emitTmux(root, runId, 'tmux-socket-race');
  let probes = 0;
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'linux',
    revalidateLauncherExecutable: identity => identity,
    tmuxProbeRun: () => ({ code: 0, stdout: ++probes === 1 ? '12345 $7\n' : '99999 $7\n' }),
    spawnFn: () => { spawned++; return { ok: true }; }, sleep: noSleep,
  });

  assert.equal(probes, 2);
  assert.equal(spawned, 0);
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(r.reason, 'launcher-socket-unverified');
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
});

test('tmux detection-to-spawn approval replacement is rejected before spawned CAS', { skip: POSIX_TMUX_FIXTURE_SKIP }, () => {
  const { root, runId, launcherIdentity } = seedTmuxLauncher();
  const h = emitTmux(root, runId, 'tmux-approval-race');
  let launcherChecks = 0;
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'linux',
    revalidateLauncherExecutable: identity => {
      launcherChecks++;
      if (launcherChecks === 1) {
        const { data } = readState(root, runId);
        data.autonomy.launcher_executable_approvals.tmux = {
          ...launcherIdentity, sha256: 'd'.repeat(64), approved_at: '2026-06-24T00:01:00.000Z',
        };
        writeState(root, runId, data);
      }
      return identity;
    },
    tmuxProbeRun: tmuxProbeOk,
    spawnFn: () => { spawned++; return { ok: true }; }, sleep: noSleep,
  });

  assert.equal(launcherChecks, 1);
  assert.equal(spawned, 0);
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(r.reason, 'launcher-identity-drift');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

test('tmux stale launcher_session fails closed before spawned CAS', { skip: POSIX_TMUX_FIXTURE_SKIP }, () => {
  const { root, runId } = seedTmuxLauncher();
  const h = emitTmux(root, runId, 'tmux-stale-session');
  let launcherChecks = 0;
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'linux',
    revalidateLauncherExecutable: identity => {
      launcherChecks++;
      if (launcherChecks === 1) {
        const { data } = readState(root, runId);
        data.session_spawn.launcher_session = 'stale-session';
        writeState(root, runId, data);
      }
      return identity;
    },
    tmuxProbeRun: tmuxProbeOk,
    spawnFn: () => { spawned++; return { ok: true }; }, sleep: noSleep,
  });

  assert.equal(spawned, 0);
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(r.reason, 'launcher-session-invalid');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

test('tmux probe-derived session mismatch preserves the emitted handoff before spawned CAS', { skip: POSIX_TMUX_FIXTURE_SKIP }, () => {
  const { root, runId } = seedTmuxLauncher();
  const h = emitTmux(root, runId, 'tmux-session-mismatch');
  let probes = 0;
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'linux',
    revalidateLauncherExecutable: identity => identity,
    tmuxProbeRun: () => ({ code: 0, stdout: ++probes === 1 ? '12345 $7\n' : '12345 $9\n' }),
    spawnFn: () => { spawned++; return { ok: true }; }, sleep: noSleep,
  });

  assert.equal(probes, 2);
  assert.equal(spawned, 0);
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(r.reason, 'launcher-session-unverified');
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
});

test('tmux ambient pane spoof is rejected by fresh ancestry proof before spawned CAS', { skip: POSIX_TMUX_FIXTURE_SKIP }, () => {
  const { root, runId } = seedTmuxLauncher();
  const h = emitTmux(root, runId, 'tmux-pane-spoof');
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: { TMUX_PANE: '%spoofed' }, now: NOW1, platform: 'linux',
    revalidateLauncherExecutable: identity => identity,
    tmuxProbeRun: tmuxProbeOk,
    tmuxPanesRun: () => ({ code: 0, stdout: '%1 987654 $9\n' }),
    tmuxPsRun: () => ({ status: 0, stdout: `${process.pid} 987654\n987654 1\n1 0\n` }),
    spawnFn: () => { spawned++; return { ok: true }; }, sleep: noSleep,
  });

  assert.equal(spawned, 0);
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(r.reason, 'launcher-session-unverified');
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
});

test('tmux ps failure preserves the emitted handoff before spawned CAS', { skip: POSIX_TMUX_FIXTURE_SKIP }, () => {
  const { root, runId } = seedTmuxLauncher();
  const h = emitTmux(root, runId, 'tmux-ps-failure');
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'linux',
    revalidateLauncherExecutable: identity => identity,
    tmuxProbeRun: tmuxProbeOk,
    tmuxPsRun: () => ({ status: 1, stdout: '' }),
    spawnFn: () => assert.fail('spawn must remain unreachable'), sleep: noSleep,
  });
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(r.reason, 'launcher-session-unverified');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

test('respawnGate: total sessions may reach max_sessions but not exceed (off-by-one, Codex r3 🟡6)', () => {
  // 경계: sessions.length == max_sessions (pending child 가 max 번째) → 허용
  const ok = seed((d) => { d.autonomy.max_sessions = 2; d.session_chain.sessions = [{ run_id: 'a', scope: openWorkstreamScope() }, { run_id: 'b', scope: openWorkstreamScope() }]; });
  assert.equal(respawnGate(readState(ok.root, ok.runId).data, { now: NOW1 }).blocked_by.includes('max_sessions'), false);
  // 초과: sessions.length > max_sessions → 차단
  const over = seed((d) => { d.autonomy.max_sessions = 1; d.session_chain.sessions = [{ run_id: 'a', scope: openWorkstreamScope() }, { run_id: 'b', scope: openWorkstreamScope() }]; });
  const r = respawnGate(readState(over.root, over.runId).data, { now: NOW1 });
  assert.equal(r.ok, false);
  assert.ok(r.blocked_by.includes('max_sessions'));
});

// R4-plan: phantom failed-launch sessions (never acquired) must NOT consume max_sessions slots.
test('respawnGate excludes failed_launch sessions from max_sessions (R4-plan, no phantom exhaustion)', () => {
  // 5 sessions but 4 are failed_launch phantoms → live count = 1 → not blocked even at max_sessions=1
  const { root, runId } = seed((d) => {
    d.autonomy.max_sessions = 1;
    d.session_chain.sessions = [
      { run_id: 'live', outcome: null, scope: openWorkstreamScope() },
      { run_id: 'p1', outcome: 'failed_launch', scope: openWorkstreamScope() },
      { run_id: 'p2', outcome: 'failed_launch', scope: openWorkstreamScope() },
      { run_id: 'p3', outcome: 'failed_launch', scope: openWorkstreamScope() },
      { run_id: 'p4', outcome: 'failed_launch', scope: openWorkstreamScope() },
    ];
  });
  const r = respawnGate(readState(root, runId).data, { now: NOW1 });
  assert.equal(r.blocked_by.includes('max_sessions'), false, 'phantom failed_launch sessions must not exhaust max_sessions');
});

// ── mode selection (resolveSpawnMode / isHeadlessInvocation, spec §7) ───────────

test('isHeadlessInvocation: concrete markers true; interactive/markerless false', () => {
  assert.equal(isHeadlessInvocation({ DEEP_LOOP_UNATTENDED: '1' }), true);
  assert.equal(isHeadlessInvocation({ DEEP_LOOP_HEADLESS: 'true' }), true);
  assert.equal(isHeadlessInvocation({ CLAUDE_CODE_ENTRYPOINT: 'sdk-py' }), true);
  assert.equal(isHeadlessInvocation({ CLAUDE_CODE_ENTRYPOINT: 'print' }), true);
  assert.equal(isHeadlessInvocation({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), false);   // interactive TUI
  assert.equal(isHeadlessInvocation({}), false);                                  // markerless
  assert.equal(isHeadlessInvocation(null), false);
});

test('Codex ignores CLAUDE_CODE_ENTRYPOINT while preserving driver-owned headless markers', () => {
  assert.equal(isHeadlessInvocation({ CLAUDE_CODE_ENTRYPOINT: 'sdk-py' }, 'codex'), false);
  assert.equal(isHeadlessInvocation({ CLAUDE_CODE_ENTRYPOINT: 'print' }, 'codex'), false);
  assert.equal(isHeadlessInvocation({ DEEP_LOOP_UNATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }, 'codex'), true);
  assert.equal(isHeadlessInvocation({ DEEP_LOOP_HEADLESS: 'true', CLAUDE_CODE_ENTRYPOINT: 'cli' }, 'codex'), true);

  const { root, runId } = seedLauncher({ spawn_style: 'visible', launcher: 'cmux', runtime: 'codex' });
  const loop = readState(root, runId).data;
  assert.equal(
    resolveSpawnMode(loop, { attended: true, env: { CLAUDE_CODE_ENTRYPOINT: 'print' } }),
    'cmux',
  );
  loop.autonomy.spawn_style = 'headless';
  assert.equal(
    resolveSpawnMode(loop, { attended: true, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } }),
    'headless',
  );
});

test('resolveSpawnMode: precedence (headless flag / spawn_style / invocation > visible launcher > interactive)', () => {
  const vis = readState(...Object.values(seedLauncher({ spawn_style: 'visible', launcher: 'cmux' }))).data;
  // explicit headless flag wins
  assert.equal(resolveSpawnMode(vis, { headless: true, attended: true, env: {} }), 'headless');
  // visible + attended + launcher → launcher
  assert.equal(resolveSpawnMode(vis, { headless: false, attended: true, env: {} }), 'cmux');
  // visible but NOT attended → interactive (no auto-spawn)
  assert.equal(resolveSpawnMode(vis, { headless: false, attended: false, env: {} }), 'interactive');
  // spawn_style headless wins over launcher+attended
  const hl = readState(...Object.values(seedLauncher({ spawn_style: 'headless', launcher: 'cmux' }))).data;
  assert.equal(resolveSpawnMode(hl, { headless: false, attended: true, env: {} }), 'headless');
});

test('resolveSpawnMode: detected visible launcher without durable attended approval stays interactive', () => {
  const { root, runId } = seedLauncher({
    spawn_style: 'visible', launcher: 'cmux', approved: false,
  });
  const loop = readState(root, runId).data;
  assert.equal(loop.autonomy.attended_launch_approval, null);
  assert.equal(resolveSpawnMode(loop, { attended: true, env: {} }), 'interactive');
});

test('desktop mode when spawn_style=desktop and attended', () => {
  const base = (over = {}) => ({
    autonomy: {
      spawn_style: 'desktop', attended_launch_approval: attendedApproval('desktop'),
    },
    session_spawn: { launcher: 'none' }, ...over,
  });
  assert.equal(resolveSpawnMode(base(), { attended: true, env: {} }), 'desktop');
});

test('headless preempts desktop (unattended forces headless)', () => {
  const base = (over = {}) => ({ autonomy: { spawn_style: 'desktop' }, session_spawn: { launcher: 'none' }, ...over });
  assert.equal(resolveSpawnMode(base(), { headless: true, attended: true, env: {} }), 'headless');
  assert.equal(resolveSpawnMode(base(), { attended: true, env: { DEEP_LOOP_UNATTENDED: '1' } }), 'headless');
});

test('desktop requires attended; else interactive', () => {
  const base = (over = {}) => ({ autonomy: { spawn_style: 'desktop' }, session_spawn: { launcher: 'none' }, ...over });
  assert.equal(resolveSpawnMode(base(), { attended: false, env: {} }), 'interactive');
});

test('existing visible launcher path unchanged', () => {
  const loop = {
    autonomy: {
      spawn_style: 'visible', attended_launch_approval: attendedApproval('visible'),
    },
    session_spawn: { launcher: 'iterm2' },
  };
  assert.equal(resolveSpawnMode(loop, { attended: true, env: {} }), 'iterm2');
});

test('respawn rejects an outer/inner mode mismatch before CAS or spawn', () => {
  const { root, runId } = seedLauncher({ spawn_style: 'headless', launcher: 'cmux' });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId,
    key: h.key,
    handoffRel: h.handoffRel,
    attended: true,
    env: {},
    expectedMode: 'cmux',
    now: NOW1,
    spawnFn: () => { spawned += 1; return { ok: true }; },
  });
  assert.deepEqual(r, {
    ok: false,
    outcome: 'mode-changed',
    reason: 'spawn-mode-changed:cmux->headless',
    childRunId: h.childRunId,
  });
  assert.equal(spawned, 0);
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

test('respawn rejects a stale caller parent fence before gate, CAS, or spawn', () => {
  const { root, runId } = seedLauncher({ spawn_style: 'headless', launcher: 'cmux' });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId,
    key: h.key,
    handoffRel: h.handoffRel,
    headless: true,
    expect: { owner: 'STALE', generation: 0 },
    now: NOW1,
    spawnFn: () => { spawned += 1; return { ok: true }; },
  });
  assert.deepEqual(r, {
    ok: false,
    outcome: 'fenced',
    reason: 'caller-parent-fence-mismatch',
    childRunId: h.childRunId,
  });
  assert.equal(spawned, 0);
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

test('spawn_style!=visible → no visible spawn even with launcher present (mode interactive → no-launcher)', () => {
  const { root, runId } = seedLauncher({ spawn_style: 'interactive', launcher: 'cmux' });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => { throw new Error('should not spawn'); }, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'no-launcher');
  // handoff PRESERVED (not rolled back) — the skill pauses via `deep-loop pause --mode preserve`
  const after = readState(root, runId).data.session_chain.lease;
  assert.equal(after.handoff_phase, 'emitted');
  assert.equal(after.handoff_child_run_id, h.childRunId);
});

test('markerless env + no launcher + not attended → interactive → no-launcher (fail-closed to pause)', () => {
  const { root, runId } = seed();   // launcher 'none' (linux + noOpRun); spawn_style 'visible' default
  assert.equal(readState(root, runId).data.session_spawn.launcher, 'none');
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: false, env: {}, now: NOW1, spawnFn: () => { throw new Error('should not spawn'); }, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'no-launcher');
});

test('isHeadlessInvocation true → headless mode even with launcher + attended (and respawn skips readiness poll)', () => {
  const { root, runId } = seedLauncher({ spawn_style: 'visible', launcher: 'cmux' });
  const env = { DEEP_LOOP_UNATTENDED: '1' };
  // even visible + attended + launcher, a headless-invocation env forces headless
  assert.equal(resolveSpawnMode(readState(root, runId).data, { headless: false, attended: true, env }), 'headless');
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let polled = 0;
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env, now: NOW1, spawnFn: () => ({ ok: true }), pollLease: () => { polled++; return { state: 'releasing' }; }, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  assert.equal(polled, 0, 'headless mode must NOT poll for child-readiness');
});

test('spawn_style=headless without --headless flag → headless mode (measured path), no readiness poll', () => {
  const { root, runId } = seedLauncher({ spawn_style: 'headless', launcher: 'cmux' });
  // resolved mode is headless → CLI selects headlessSpawn (measured), not visibleSpawn
  assert.equal(resolveSpawnMode(readState(root, runId).data, { headless: false, attended: true, env: {} }), 'headless');
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let polled = 0;
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => ({ ok: true }), pollLease: () => { polled++; return { state: 'releasing' }; }, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  assert.equal(polled, 0, 'headless mode keeps the synchronous measured path (no poll)');
});

// ── visible bounded child-readiness handshake (R1-B / R10-DD / R6-U) ────────────

test('visible + attended + launcher: spawnFn gets cmds[launcher] (bin+socket threaded); child acquires → success', () => {
  const { root, runId } = seedLauncher({ spawn_style: 'visible', launcher: 'cmux' });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let got;
  const spawnFn = (e) => { got = e; return { ok: true }; };
  const pollLease = seq([{ state: 'releasing', owner_run_id: runId, generation: 1 }, { state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 }]);
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn, pollLease, sleep: noSleep });
  assert.equal(got.bin, '/abs/bin/cmux', 'cmux entry bin === session_spawn.launcher_bin (R3/R7-plan)');
  assert.ok(got.argv.includes('--socket'), 'cmux argv must thread --socket');
  assert.ok(got.argv.includes('/tmp/cmux.sock'), 'cmux argv must thread session_spawn.launcher_socket');
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  // launch-command.txt (written at emit) must also show the threaded bin + socket (not bare cmux/default socket).
  const lc = readFileSync(join(runDir(root, runId), 'terminal', 'launch-command.txt'), 'utf8');
  assert.ok(lc.includes('/abs/bin/cmux'), 'launch-command.txt cmux line must use the absolute launcher_bin');
  assert.ok(lc.includes('/tmp/cmux.sock'), 'launch-command.txt cmux line must thread the launcher_socket');
});

test('attended approval revoked before the lock-held spawn claim fails closed without spawning', () => {
  const { root, runId } = seedLauncher({ spawn_style: 'visible', launcher: 'cmux' });
  const h = emitHandoff(root, runId, {
    trigger: 'attended-approval-race', now: NOW1, expect: expect_(runId),
  });
  let spawned = 0;
  const result = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1,
    beforeClaim: () => {
      const { data } = readState(root, runId);
      data.autonomy.attended_launch_approval = null;
      writeState(root, runId, data);
    },
    spawnFn: () => { spawned += 1; return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'no-launcher');
  assert.equal(result.reason, 'attended-launch-unauthorized');
  assert.equal(spawned, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'attended-launch-unauthorized');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
  assert.equal(after.session_chain.lease.state, 'releasing');
  assert.equal(after.session_chain.lease.handoff_child_run_id, h.childRunId);
  assert.equal(after.session_chain.lease.handoff_idempotency_key, h.key);
});

test('revoke after the spawned claim is HANDOFF_IN_FLIGHT and cannot pretend to cancel launch', async () => {
  const { revokeAttendedLaunch } = await import('../scripts/lib/attended-launch.mjs');
  const { root, runId } = seedLauncher({ spawn_style: 'visible', launcher: 'cmux' });
  const h = emitHandoff(root, runId, {
    trigger: 'attended-post-claim-revoke', now: NOW1, expect: expect_(runId),
  });
  let revokeResult;
  const result = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1,
    spawnFn: () => {
      revokeResult = revokeAttendedLaunch(root, runId, {
        confirm: true, fence: expect_(runId), now: NOW1,
      });
      return { ok: true };
    },
    pollLease: () => ({
      state: 'active', handoff_phase: 'acquired',
      owner_run_id: h.childRunId, generation: 2,
    }),
    sleep: noSleep,
  });
  assert.deepEqual(revokeResult, { ok: false, reason: 'HANDOFF_IN_FLIGHT' });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'spawned');
  assert.deepEqual(readState(root, runId).data.autonomy.attended_launch_approval, {
    style: 'visible', approved_at: '2026-06-24T00:00:00.000Z',
  });
});

test('child-readiness timeout → PRESERVE (reserved child kept, late acquire safe) — R6-plan', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const pollLease = () => ({ state: 'releasing', owner_run_id: runId, generation: 1 });   // never acquires
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => ({ ok: true }), pollLease, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'child-timeout-awaiting');
  const d = readState(root, runId).data;
  assert.equal(d.status, 'paused');
  assert.equal(d.pause_reason, 'child-timeout-awaiting');
  assert.equal(d.session_chain.lease.handoff_child_run_id, h.childRunId);   // NOT invalidated
  assert.equal(d.session_chain.lease.resume_policy, 'human');
  assert.equal(d.session_chain.lease.expires_at, null);
  assert.equal(d.session_chain.lease.state, 'releasing');                    // preserved (acquirable by reserved child)
});

test('child acquires AFTER the timeout window → still succeeds (R6-plan late acquire + Task 8 unpause)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  // 1) readiness timeout → PRESERVE (paused, reserved child kept)
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => ({ ok: true }), pollLease: () => ({ state: 'releasing', owner_run_id: runId, generation: 1 }), sleep: noSleep });
  assert.equal(r.outcome, 'child-timeout-awaiting');
  assert.equal(readState(root, runId).data.status, 'paused');
  // 2) a LATE /deep-loop-resume by the reserved child acquires the still-releasing lease (Task 8) → unpauses
  const acq = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 + 5000 });
  assert.equal(acq.ok, true);
  assert.equal(acq.generation, 2);
  assert.equal(readState(root, runId).data.status, 'running', 'late child acquire must unpause the run');
});

test('visible launch FAILURE (exit≠0) → rollback AND paused (child never started, invalidated)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => ({ ok: false, reason: 'launch-exit-1' }), pollLease: () => ({ state: 'releasing' }), sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'failed_launch');
  const d = readState(root, runId).data;
  assert.equal(d.status, 'paused');
  assert.equal(d.pause_reason, 'launch-failed');
  assert.equal(d.session_chain.lease.handoff_child_run_id, null);   // invalidated (definitive failure)
  assert.equal(d.session_chain.lease.state, 'active');
  assert.equal(d.session_chain.lease.handoff_phase, 'idle');
  assert.equal(d.session_chain.sessions.find(s => s.run_id === h.childRunId).outcome, 'failed_launch');
});

test('fast child already acquired before poll → success not fenced (R6-U)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const pollLease = () => ({ state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => ({ ok: true }), pollLease, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
});

// R6-U stronger: the reserved child actually acquires the REAL lease during spawnFn, BEFORE the parent
// records respawn-spawned → the parent fence fails but it is the reserved child → SUCCESS, not fenced.
test('fast child acquires real lease during spawnFn (before respawn-spawned record) → success not fenced (R6-U)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const spawnFn = () => {
    acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });   // ultra-fast handshake
    return { ok: true };
  };
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn, pollLease: () => readState(root, runId).data.session_chain.lease, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.owner_run_id, h.childRunId);
  assert.equal(lease.generation, 2);
});

test('generation change to a NON-reserved owner during readiness poll → fenced (real fence)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const pollLease = seq([{ state: 'releasing', owner_run_id: runId, generation: 1 }, { state: 'active', handoff_phase: 'acquired', owner_run_id: 'OTHER', generation: 2 }]);
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => ({ ok: true }), pollLease, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'fenced');
});

// ── gate-blocked + headless paths (existing tests, adapted to mode params) ──────

test('respawn gate-blocked (budget) → rollback + paused, no spawn (mode A; R12-LL rollback)', () => {
  // Codex r1 🟡7: budget.spent 변조는 reconcileBudget 가 BUDGET_TAMPERED 로 throw → total=0 으로 hard-stop 유발.
  const { root, runId } = seed((d) => { d.budget.total = 0; });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let called = false;
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn: () => { called = true; return { ok: true }; } });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'gate-blocked');
  assert.equal(called, false);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.match(after.pause_reason, /^gate:/);
  // R12-LL: gate-blocked now ROLLS BACK the reserved handoff (was: stays emitted)
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.lease.state, 'active');
  assert.equal(after.session_chain.lease.handoff_child_run_id, null);
  assert.equal(after.session_chain.lease.handoff_trigger, null);
});

test('respawn launch failure (throw) → failed_launch + lease rollback + paused (mode B)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn: () => { throw new Error('launch boom'); } });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'failed_launch');
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'launch-failed');
  assert.equal(after.session_chain.lease.state, 'active');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.sessions.find(s => s.run_id === h.childRunId).outcome, 'failed_launch');
  assert.equal(after.session_chain.sessions.find(s => s.run_id === runId).superseded_by, null);
});

// Codex impl r8 🟡: a valid key must not spawn an arbitrary (unreserved) child.
test('respawn rejects childRunId that does not match the reserved handoff child (no spawn, no phase advance)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawned = false;
  const r = respawn(root, runId, { childRunId: 'WRONG-CHILD', key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn: () => { spawned = true; return { ok: true }; } });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'child-mismatch');
  assert.equal(spawned, false);
  const after = readState(root, runId).data.session_chain.lease;
  assert.equal(after.handoff_phase, 'emitted');   // no advance to spawned
  assert.equal(after.state, 'releasing');
});

test('respawn success → spawned (headless), lease stays releasing, child can acquire via handshake; retry idempotent', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const entries = [];
  const spawnFn = (entry) => { entries.push(entry); return { ok: true }; };
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  assert.equal(entries.length, 1);
  // headless entry display references parent run dir (🔴3)
  assert.match(entries[0].display, new RegExp(`\\.deep-loop/runs/${runId}/`));
  const after = readState(root, runId).data;
  assert.equal(after.session_chain.lease.handoff_phase, 'spawned');
  // Fix 2: lease stays 'releasing' — child acquires via handshake
  assert.equal(after.session_chain.lease.state, 'releasing');
  // Codex r1 🔴2: 같은 respawn 재시도는 already-spawned no-op (이중 spawn 금지)
  const retry = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn });
  assert.equal(retry.outcome, 'already-spawned');
  assert.equal(entries.length, 1);
  // Child acquires the releasing lease via handshake (not released — acquiring 'releasing' directly)
  const a = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });
  assert.equal(a.ok, true);
  assert.equal(a.generation, 2);
});

// Fix 2: After respawn, lease stays 'releasing'. Wrong child cannot acquire (not the reserved child, not expired).
test('releasing handoff lease is acquirable only by the reserved child (non-reserved child fenced)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn: () => ({ ok: true }) });
  const wrong = acquireLease(root, runId, { owner: 'WRONG-CHILD', expectGeneration: 1, runtime: 'claude', now: NOW1 });
  assert.equal(wrong.ok, false);
  assert.ok(['child-not-reserved', 'lease-not-takeable'].includes(wrong.reason));
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_child_run_id, h.childRunId);  // binding intact
  const ok = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 2);
});

// Codex r2 🔴3: 외부 spawn 전 원자적 클레임이 동시 호출의 이중 spawn 을 막는지.
test('respawn claims atomically before external spawn → concurrent re-entry does not double-spawn', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawns = 0; let reentered = null;
  const spawnFn = () => {
    spawns++;
    if (spawns === 1) reentered = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn });
    return { ok: true };
  };
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn });
  assert.equal(r.ok, true);
  assert.equal(spawns, 1);                       // 재진입 호출은 외부 spawn 을 추가 실행하지 않음
  assert.equal(reentered.outcome, 'already-spawned');
});

// Codex r3 🔴2: claim(spawned) 후 release 전 크래시는 영구 stranded 가 아니다 — releasing+expired 로 successor 인수 복구.
test('crash after spawned-claim recovers via stale-TTL acquire (not permanently stranded)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });   // expires_at = NOW1 + 900s
  advanceHandoffPhase(root, runId, { key: h.key, toPhase: 'spawned', now: NOW1 });   // claim 만(=respawn 이 release 전 크래시)
  const st = readState(root, runId).data.session_chain.lease;
  assert.equal(st.handoff_phase, 'spawned');
  assert.equal(st.state, 'releasing');
  // TTL 경과 전: 인수 불가
  assert.equal(acquireLease(root, runId, { owner: 'RESUME', expectGeneration: 1, runtime: 'claude', now: NOW1 + 1000 }).ok, false);
  // TTL(900s) 경과 후: releasing+expired → 인수 복구
  const a = acquireLease(root, runId, { owner: 'RESUME', expectGeneration: 1, runtime: 'claude', now: NOW1 + 901 * 1000 });
  assert.equal(a.ok, true);
  assert.equal(a.generation, 2);
});

// Codex r1 🟡8: 동시 다발 실패 시 게이트 순서(budget→breaker→max_sessions→wallclock) 보고가 일관적인지.
test('respawnGate reports documented order; wallclock not mislabeled as budget', () => {
  const { root, runId } = seed((d) => {
    d.autonomy.max_sessions = 1; d.session_chain.sessions = [{ run_id: 'a', scope: openWorkstreamScope() }, { run_id: 'b', scope: openWorkstreamScope() }];
    d.budget.max_wallclock_sec = 1;            // created_at(NOW0) 기준 NOW1 은 1h 경과 → wallclock 초과
  });
  const r = respawnGate(readState(root, runId).data, { now: NOW1 });
  assert.equal(r.ok, false);
  assert.ok(r.blocked_by.includes('max_sessions'));
  assert.ok(r.blocked_by.includes('wallclock'));
  assert.equal(r.blocked_by.includes('budget'), false);  // wallclock 이 budget 으로 오분류되지 않음
});

// Fix 2: spawnFn bumps the lease generation (simulates child acquiring mid-spawn), then throws.
// respawn must return outcome='fenced', NOT mark the active child as failed_launch or corrupt the lease.
test('respawn: lease stolen during spawnFn → fenced outcome, child lease not corrupted', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const CHILD = h.childRunId;
  let spawnCalled = false;
  const spawnFn = () => {
    spawnCalled = true;
    releaseLease(root, runId, { owner: runId, generation: 1 });
    acquireLease(root, runId, { owner: CHILD, expectGeneration: 1, runtime: 'claude', now: NOW1 });
    throw new Error('external-spawn-failed-after-acquire');
  };
  const r = respawn(root, runId, { childRunId: CHILD, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn });
  assert.equal(spawnCalled, true);
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'fenced');
  const after = readState(root, runId).data;
  const lease = after.session_chain.lease;
  assert.equal(lease.owner_run_id, CHILD);
  assert.equal(lease.state, 'active');
  assert.equal(lease.generation, 2);
  const childSession = after.session_chain.sessions.find(s => s.run_id === CHILD);
  assert.notEqual(childSession?.outcome, 'failed_launch');
});

// Codex r5 🔴1: gate-blocked pause write fenced — lease taken over between emit and respawn.
test('respawn gate-blocked with lease takeover before pause → fenced, status NOT paused', () => {
  const { root, runId } = seed((d) => { d.budget.total = 0; });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const CHILD = h.childRunId;
  releaseLease(root, runId, { owner: runId, generation: 1 });
  acquireLease(root, runId, { owner: CHILD, expectGeneration: 1, runtime: 'claude', now: NOW1 });
  const r = respawn(root, runId, { childRunId: CHILD, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn: () => ({ ok: true }) });
  assert.equal(r.ok, false);
  // owner-mismatch check removed; key is nulled by acquireLease → key-mismatch fires (still a fencing outcome).
  assert.ok(r.outcome === 'fenced' || r.outcome === 'key-mismatch', 'must return a fencing outcome when lease changed before pause write');
  const after = readState(root, runId).data;
  assert.notEqual(after.status, 'paused', 'status must NOT be paused when fenced');
});

// ── codex r5 finding A (HIGH): already-spawned re-entry must VERIFY child acquisition ───────────
// CAS-before-spawn ordering means handoff_phase==='spawned' is only the CAS claim, NOT proof the child
// launched + took over. A prior call may have crashed AFTER the CAS, before/during the external spawn.
// The idempotent re-entry must therefore verify child acquisition and recover (bounded wait → preserve-
// pause) instead of returning a false 'already-spawned' success that strands the handoff with no
// autonomous recovery. Re-spawn is NEVER done on this path (the CAS double-spawn guard must hold).

test('already-spawned re-entry, child NEVER acquires (visible) → bounded wait then preserve-pause, no re-spawn (codex-r5a)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  // Simulate a prior respawn that did the emitted→spawned CAS then crashed before/during the external spawn.
  advanceHandoffPhase(root, runId, { key: h.key, toPhase: 'spawned', now: NOW1 });
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'spawned');
  // Reserved child never acquires (poll always shows the parent still releasing). spawnFn must NOT be re-called.
  const pollLease = () => ({ state: 'releasing', owner_run_id: runId, generation: 1 });
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, sleep: noSleep, pollLease,
    spawnFn: () => { throw new Error('must NOT re-spawn on the already-spawned path (CAS double-spawn guard)'); },
  });
  // NOT a bare already-spawned success — it waited to the deadline then preserve-paused (autonomous-detectable).
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'spawn-unconfirmed-awaiting');
  const d = readState(root, runId).data;
  assert.equal(d.status, 'paused');
  assert.equal(d.session_chain.lease.handoff_child_run_id, h.childRunId, 'reserved child preserved (not invalidated)');
  assert.equal(d.session_chain.lease.resume_policy, 'human');
  assert.equal(d.session_chain.lease.expires_at, null);
  assert.equal(d.session_chain.lease.state, 'releasing', 'lease still releasing → reserved child can still acquire');
  // Task 8 late-acquire: a subsequent reserved-child acquireLease STILL succeeds + unpauses.
  const acq = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 + 5000 });
  assert.equal(acq.ok, true);
  assert.equal(acq.generation, 2);
  assert.equal(readState(root, runId).data.status, 'running', 'late reserved-child acquire must unpause');
});

test('already-spawned re-entry where the child HAS acquired → already-spawned immediately, no false pause (codex-r5a)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  advanceHandoffPhase(root, runId, { key: h.key, toPhase: 'spawned', now: NOW1 });
  // Lease already shows the reserved child acquired (a prior call genuinely spawned + the child took over).
  const pollLease = () => ({ state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 });
  let spawned = false;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, sleep: noSleep, pollLease,
    spawnFn: () => { spawned = true; return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'already-spawned');
  assert.equal(spawned, false, 'must NOT re-spawn when the child already acquired');
  assert.notEqual(readState(root, runId).data.status, 'paused', 'genuine already-spawned must not pause');
});

// respawn race (§14 test 12): Continue↔PreCompact 동시 트리거 → 멱등키로 emit 1회
test('double emit + single respawn (race): only one child chain, no double spawn', () => {
  const { root, runId } = seed();
  const ex = expect_(runId);
  const a = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: ex });
  const b = emitHandoff(root, runId, { trigger: 'precompact', now: NOW1, expect: ex });   // idempotent no-op
  assert.equal(a.ok, true); assert.equal(b.ok, true); assert.equal(b.idempotent, true);
  let spawns = 0;
  const r1 = respawn(root, runId, { childRunId: a.childRunId, key: a.key, handoffRel: a.handoffRel, headless: true, now: NOW1, spawnFn: () => { spawns++; return { ok: true }; } });
  assert.equal(r1.ok, true);
  assert.equal(spawns, 1);
  const children = readState(root, runId).data.session_chain.sessions.filter(s => s.run_id !== runId);
  assert.equal(children.length, 1);
});

test('a child owner can emit a second handoff and respawn (multi-session, Fix 1)', () => {
  const { root, runId } = seed();
  const NOWa = Date.parse('2026-06-24T00:01:00Z'), NOWb = Date.parse('2026-06-24T00:02:00Z');
  const h1 = emitHandoff(root, runId, { trigger: 'm1', now: NOWa, expect: { owner: runId, generation: 1 } });
  respawn(root, runId, { childRunId: h1.childRunId, key: h1.key, handoffRel: h1.handoffRel, headless: true, now: NOWa, spawnFn: () => ({ ok: true }) });
  acquireLease(root, runId, { owner: h1.childRunId, expectGeneration: 1, runtime: 'claude', now: NOWa });   // child owns, generation 2
  const h2 = emitHandoff(root, runId, { trigger: 'm2', now: NOWb, expect: { owner: h1.childRunId, generation: 2 } });
  assert.equal(h2.ok, true);
  const r2 = respawn(root, runId, { childRunId: h2.childRunId, key: h2.key, handoffRel: h2.handoffRel, headless: true, now: NOWb, spawnFn: () => ({ ok: true }) });
  assert.equal(r2.ok, true);
  assert.equal(r2.outcome, 'spawned');
  assert.equal(readState(root, runId).data.session_chain.sessions.find(s => s.run_id === h1.childRunId).superseded_by, h2.childRunId);
});

test('child can acquire the releasing lease after a headless respawn via handshake (Fix 2)', () => {
  const { root, runId } = seed();
  const NOWa = Date.parse('2026-06-24T00:01:00Z'), NOWb = Date.parse('2026-06-24T00:02:00Z');
  const h = emitHandoff(root, runId, { trigger: 'm', now: NOWa, expect: { owner: runId, generation: 1 } });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOWa, spawnFn: () => ({ ok: true }) });
  assert.equal(r.outcome, 'spawned');
  // Fix 2: lease stays 'releasing' — child acquires via handshake
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'releasing');
  const acq = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, runtime: 'claude', now: NOWb });
  assert.equal(acq.ok, true); assert.equal(acq.generation, 2);
});

// Descriptor construction still happens before the spawned CAS, but a visible/headless caller cannot be
// relied on to preserve-pause after a soft build-error result. respawn therefore preserves the emitted
// reservation itself under the original fence and returns the original bounded construction reason.
test('respawn: buildLaunchCommand throw self-pauses emitted handoff without advancing to spawned', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1,
    launchCommandBuilder: () => { throw new Error('UNSAFE_SPAWN_ARG: injected descriptor failure'); },
    spawnFn: () => { throw new Error('must not reach spawnFn'); },
  });
  // Lease MUST NOT have advanced to 'spawned' (must be emitted/releasing — re-tryable, not stranded).
  const after = readState(root, runId).data;
  const lease = after.session_chain.lease;
  assert.notEqual(lease.handoff_phase, 'spawned', 'buildLaunchCommand throw must happen before spawned CAS');
  assert.equal(lease.state, 'releasing', 'lease must stay releasing (emitted, re-tryable)');
  assert.equal(lease.handoff_phase, 'emitted', 'lease must stay emitted when build throws before CAS');
  assert.equal(r.ok, false, 'respawn must return ok:false on build error');
  assert.equal(r.outcome, 'build-error');
  assert.match(r.reason, /^UNSAFE_SPAWN_ARG:/);
  assert.equal(after.status, 'paused', 'descriptor build failure must never leave running+emitted');
  assert.equal(after.pause_reason, r.reason, 'the original bounded build reason must be preserved');
  assert.equal(lease.resume_policy, 'human');
  assert.equal(lease.handoff_child_run_id, h.childRunId, 'preserve-pause keeps the reserved child recoverable');
});

test('Codex visible transport without durable runtime approval preserves before spawned CAS', () => {
  const { root, runId } = seedLauncher({ runtime: 'codex', spawn_style: 'visible', launcher: 'cmux' });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawned = false;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1,
    spawnFn: () => { spawned = true; return { ok: true }; },
    sleep: noSleep,
  });
  assert.equal(spawned, false, 'Codex must never auto-launch without approved runtime authority');
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(r.reason, 'runtime-identity-unavailable');
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'runtime-identity-unavailable');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted', 'unavailable transport must be rejected before spawned CAS');
  assert.equal(after.session_chain.lease.state, 'releasing');
  assert.equal(after.session_chain.lease.handoff_child_run_id, h.childRunId, 'logical reservation remains available for manual resume');
});

test('Codex headless transport is rejected before spawned CAS and never reaches spawnFn', () => {
  const { root, runId } = seed(undefined, 'codex');
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawned = false;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    headless: true, now: NOW1,
    spawnFn: () => { spawned = true; return { ok: true }; },
  });
  assert.equal(spawned, false);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'codex-transport-not-activated');
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'codex-transport-not-activated');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
});

test('Windows Codex headless uses the shared host identity path instead of pausing as runtime-identity-unavailable', () => {
  const { root, runId } = seed((data) => {
    data.session_spawn = { ...data.session_spawn, platform: 'win32' };
  }, 'codex');
  const h = emitHandoff(root, runId, {
    trigger: 'win32-headless-host-owned', now: NOW1, expect: expect_(runId), platform: 'win32',
  });
  let spawned = false;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    headless: true, now: NOW1, platform: 'win32',
    codexExecutable: 'C:\\tools\\codex.exe',
    deepLoopRoot: WINDOWS_DEEP_LOOP_ROOT,
    spawnFn: (entry) => {
      spawned = true;
      assert.equal(entry.shell, false);
      return { ok: true };
    },
  });
  assert.notEqual(r.reason, 'runtime-identity-unavailable', JSON.stringify(r));
  assert.equal(spawned, true, JSON.stringify(r));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'spawned');
});

test('Codex App manual continuation never probes the Claude Desktop handler', () => {
  const { root, runId } = seed((data) => {
    data.autonomy.spawn_style = 'desktop';
    data.autonomy.attended_launch_approval = attendedApproval('desktop');
  }, 'codex');
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let probed = false;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1,
    desktopProbe: () => { probed = true; throw new Error('Claude Desktop probe must not run for Codex'); },
    spawnFn: () => { throw new Error('Codex App continuation is manual'); },
  });
  assert.equal(probed, false);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'codex-transport-not-activated');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

// RUN_PAUSED gate: respawn on a paused run returns {ok:false, outcome:'paused'} (Task 6).
test('respawn on a paused run returns paused (RUN_PAUSED precondition)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  { const { data } = readState(root, runId); data.status = 'paused'; writeState(root, runId, data); }
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn: () => { throw new Error('should not spawn'); } });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'paused');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

// R12-LL regression: gate-blocked + no-launcher → gate WINS (rollback), not 'no-launcher' (preserve).
// Before the fix, mode selection fired before respawnGate so a no-launcher run returned 'no-launcher'
// and kept the reserved child alive — bypassing the gate. After the fix, gate is evaluated first.
test('R12-LL: gate-blocked + no-launcher → gate wins, reserved child rolled back (not preserved)', () => {
  // budget.total=0 → gate blocks; default linux+noOpRun seed → launcher='none', attended=false → no-launcher
  // IF mode were checked first (old bug). After fix, gate fires first → rollback.
  const { root, runId } = seed((d) => { d.budget.total = 0; });
  assert.equal(readState(root, runId).data.session_spawn.launcher, 'none', 'seed must have no launcher');
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawned = false;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: false, env: {}, now: NOW1,
    spawnFn: () => { spawned = true; return { ok: true }; },
    sleep: noSleep,
  });

  // Gate MUST win: outcome is 'gate-blocked', not 'no-launcher'
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'gate-blocked', 'gate-blocked must win over no-launcher (R12-LL)');
  assert.equal(spawned, false, 'spawnFn must not be called when gate blocks');

  // Reserved child MUST be invalidated (rollback, not preserve)
  const d = readState(root, runId).data;
  assert.equal(d.status, 'paused');
  assert.match(d.pause_reason, /^gate:/, 'pause_reason must start with gate:');
  assert.equal(d.session_chain.lease.handoff_child_run_id, null, 'handoff_child_run_id must be cleared (invalidated)');
  assert.equal(d.session_chain.lease.handoff_trigger, null, 'handoff_trigger must be cleared with the invalidated reservation');
  assert.equal(d.session_chain.lease.state, 'active', 'lease state must roll back to active');
  assert.equal(d.session_chain.lease.handoff_phase, 'idle', 'handoff_phase must roll back to idle');
  const childSession = d.session_chain.sessions.find(s => s.run_id === h.childRunId);
  assert.equal(childSession.outcome, 'failed_launch', 'child session outcome must be failed_launch (invalidated)');
  const parentSession = d.session_chain.sessions.find(s => s.run_id === runId);
  assert.equal(parentSession.superseded_by, null, 'parent superseded_by must be cleared');

  // Gate must NOT be bypassed: the old reserved child cannot acquire the now-active lease
  const acq = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 + 1000 });
  assert.equal(acq.ok, false, 'old child must not be able to acquire after gate-blocked rollback');
});

// R12-LL companion: gate-OK + no-launcher → 'no-launcher' with reserved child PRESERVED (needs-human).
// Proves the two paths are correctly distinguished after the gate-before-mode reorder.
test('R12-LL: gate-OK + no-launcher → no-launcher outcome, reserved child preserved (needs-human)', () => {
  // Default seed: gate passes (budget.total=200, auto_handoff=true, etc.); launcher='none', attended=false
  const { root, runId } = seed();
  assert.equal(readState(root, runId).data.session_spawn.launcher, 'none', 'seed must have no launcher');
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: false, env: {}, now: NOW1,
    spawnFn: () => { throw new Error('should not spawn'); },
    sleep: noSleep,
  });

  // Gate passes → mode='interactive' → no-launcher (correct: genuine needs-human)
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'no-launcher', 'gate-OK + no-launcher must return no-launcher (not gate-blocked)');

  // Reserved child MUST be PRESERVED (not rolled back): skill pauses via `deep-loop pause --mode preserve`
  const d = readState(root, runId).data;
  assert.equal(d.session_chain.lease.handoff_child_run_id, h.childRunId, 'handoff_child_run_id must be preserved');
  assert.equal(d.session_chain.lease.handoff_phase, 'emitted', 'handoff_phase must stay emitted');
  assert.equal(d.session_chain.lease.state, 'releasing', 'lease state must stay releasing');
  assert.notEqual(d.status, 'paused', 'status must NOT be paused (skill handles pause-mode-preserve separately)');
});

// ── B3: unavailable PowerShell entry (no trusted launcher_bin) routes to no-launcher (plan-ADV6) ──
test('B3: powershell launcher with null launcher_bin → no-launcher (preserve), never spawns', () => {
  const { root, runId } = seed((d) => {
    d.autonomy.spawn_style = 'visible';
    d.autonomy.attended_launch_approval = attendedApproval('visible');
    d.session_spawn = {
      platform: 'win32', launcher: 'powershell', launcher_bin: null, launcher_socket: null,
      surface: 'window', reachable: true, visible: true, signals: {}, probe: null,
      reason: null, fallback: 'launch-command-file', detected_at: '2026-06-24T00:00:00Z',
    };
  });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawned = false;
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => { spawned = true; return { ok: true }; }, sleep: noSleep });
  assert.equal(spawned, false, 'must not spawn a bare powershell');
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'no-launcher');
  // respawn SELF-preserve-pauses — the VISIBLE skill branch (launcher!=='none') runs `respawn --attended` and
  // does NOT inspect the outcome, so without a self-pause the handoff would be stranded (IMPL-ADV1).
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused', 'run must be preserve-paused by respawn itself');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');     // handoff preserved for recovery
  assert.equal(after.session_chain.lease.resume_policy, 'human');
});

function windowsRuntimeIdentity(runtime = 'claude') {
  return {
    runtime, canonical_path: `C:\\Program Files & Tools\\${runtime}\\${runtime}.exe`,
    sha256: 'a'.repeat(64), version: runtime === 'claude' ? '2.1.0' : '0.144.1',
    platform: 'win32', arch: 'x64', source: 'human-explicit', package: null, authenticode: null,
    approved_by: 'human', approved_at: '2026-07-11T08:00:00.000Z',
  };
}

function windowsLauncherIdentity(kind = 'wt') {
  return {
    kind, canonical_path: kind === 'wt'
      ? 'C:\\Program Files\\WindowsApps\\wt.exe'
      : 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    sha256: 'b'.repeat(64), version: '1.0.0', platform: 'win32', arch: 'x64',
    source: 'human-explicit', authenticode: null,
    approved_by: 'human', approved_at: '2026-07-11T08:00:00.000Z',
  };
}

function replacementWindowsLauncherIdentity(kind = 'wt') {
  const identity = windowsLauncherIdentity(kind);
  return {
    ...identity,
    canonical_path: kind === 'wt'
      ? 'C:\\Fresh\\WindowsTerminal\\wt.exe'
      : 'C:\\Fresh\\PowerShell\\pwsh.exe',
    sha256: 'c'.repeat(64), version: '2.0.0', approved_at: '2026-07-12T08:00:00.000Z',
  };
}

function seedWindowsLauncher(kind = 'wt', runtime = 'claude') {
  const runtimeIdentity = windowsRuntimeIdentity(runtime);
  const launcherIdentity = windowsLauncherIdentity(kind);
  const seeded = seed((data) => {
    data.autonomy.spawn_style = 'visible';
    data.autonomy.attended_launch_approval = attendedApproval('visible');
    data.autonomy.runtime_executable_approval = runtimeIdentity;
    data.autonomy.launcher_executable_approvals = {
      wt: kind === 'wt' ? launcherIdentity : null,
      powershell: kind === 'powershell' ? launcherIdentity : null,
    };
    data.session_spawn = {
      platform: 'win32', launcher: kind, launcher_bin: launcherIdentity.canonical_path,
      launcher_identity: launcherIdentity, launcher_socket: null,
      surface: kind === 'wt' ? 'tab' : 'window', reachable: true, visible: true,
      signals: {}, probe: null, reason: null, fallback: 'launch-command-file',
      detected_at: '2026-06-24T00:00:00Z',
    };
  }, runtime);
  return { ...seeded, runtimeIdentity, launcherIdentity };
}

function seedWindowsDesktop(runtime = 'claude') {
  const launcherIdentity = windowsLauncherIdentity('powershell');
  const seeded = seed((data) => {
    data.autonomy.spawn_style = 'desktop';
    data.autonomy.attended_launch_approval = attendedApproval('desktop');
    data.autonomy.launcher_executable_approvals = {
      wt: null,
      powershell: launcherIdentity,
    };
    data.session_spawn = {
      platform: 'win32', launcher: 'none', launcher_bin: null, launcher_socket: null,
      surface: 'window', reachable: true, visible: true,
      signals: {}, probe: null, reason: null, fallback: 'launch-command-file',
      detected_at: '2026-06-24T00:00:00Z',
    };
  }, runtime);
  return { ...seeded, launcherIdentity };
}

const windowsDesktopTarget = {
  ok: true,
  argvTarget: { kind: 'win-exe', exePath: 'C:\\Program Files\\Claude\\Claude.exe' },
};

function replaceDurableLauncherAuthority(root, runId, kind, identity) {
  const { data } = readState(root, runId);
  data.autonomy.launcher_executable_approvals[kind] = identity;
  writeState(root, runId, data);
}

test('native Windows visible respawn rejects a session launcher identity superseded by durable approval before initial revalidation', () => {
  for (const kind of ['wt', 'powershell']) {
    const { root, runId } = seedWindowsLauncher(kind, 'codex');
    const fresh = replacementWindowsLauncherIdentity(kind);
    replaceDurableLauncherAuthority(root, runId, kind, fresh);
    const h = emitHandoff(root, runId, {
      trigger: `initial-${kind}-authority-mismatch`, now: NOW1, expect: expect_(runId), platform: 'win32',
    });
    let spawned = 0;
    let revalidated = 0;
    const r = respawn(root, runId, {
      childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
      attended: true, env: {}, now: NOW1, platform: 'win32',
      revalidateRuntimeExecutable: identity => identity,
      revalidateLauncherExecutable: identity => { revalidated++; return identity; },
      spawnFn: () => { spawned++; return { ok: true }; },
      pollLease: () => ({ state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 }),
      sleep: noSleep,
    });
    assert.equal(spawned, 0, kind);
    assert.equal(revalidated, 0, `${kind}: mismatched durable/session authority must fail before probing either launcher`);
    assert.equal(r.ok, false, kind);
    assert.equal(r.outcome, 'no-launcher', kind);
    assert.equal(r.reason, 'launcher-identity-unavailable', kind);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', kind);
    assert.equal(after.session_chain.lease.handoff_phase, 'emitted', kind);
  }
});

test('native Windows respawn pre-CAS revalidation observes a concurrent durable launcher replacement', () => {
  const { root, runId, launcherIdentity } = seedWindowsLauncher('wt', 'codex');
  const fresh = replacementWindowsLauncherIdentity('wt');
  const h = emitHandoff(root, runId, {
    trigger: 'pre-cas-launcher-authority-race', now: NOW1, expect: expect_(runId), platform: 'win32',
  });
  let launcherChecks = 0;
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'win32',
    revalidateRuntimeExecutable: identity => identity,
    revalidateLauncherExecutable: identity => {
      launcherChecks++;
      assert.deepEqual(identity, launcherIdentity);
      if (launcherChecks === 1) replaceDurableLauncherAuthority(root, runId, 'wt', fresh);
      return identity;
    },
    spawnFn: () => { spawned++; return { ok: true }; },
    pollLease: () => ({ state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 }),
    sleep: noSleep,
  });
  assert.equal(spawned, 0);
  assert.equal(launcherChecks, 1, 'fresh authority mismatch must fail before revalidating the superseded launcher again');
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(r.reason, 'launcher-identity-drift');
  const after = readState(root, runId).data;
  assert.deepEqual(after.autonomy.launcher_executable_approvals.wt, fresh);
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
  assert.equal(after.session_chain.sessions.find(session => session.run_id === h.childRunId)?.outcome, null);
});

test('native Windows respawn post-CAS revalidation observes a launcher replacement that lands during the pre-CAS probe', () => {
  const { root, runId, launcherIdentity } = seedWindowsLauncher('wt', 'codex');
  const fresh = replacementWindowsLauncherIdentity('wt');
  const h = emitHandoff(root, runId, {
    trigger: 'post-cas-launcher-authority-race', now: NOW1, expect: expect_(runId), platform: 'win32',
  });
  let launcherChecks = 0;
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'win32',
    revalidateRuntimeExecutable: identity => identity,
    revalidateLauncherExecutable: identity => {
      launcherChecks++;
      assert.deepEqual(identity, launcherIdentity);
      if (launcherChecks === 2) replaceDurableLauncherAuthority(root, runId, 'wt', fresh);
      return identity;
    },
    spawnFn: () => { spawned++; return { ok: true }; }, sleep: noSleep,
  });
  assert.equal(spawned, 0);
  assert.equal(launcherChecks, 2, 'post-CAS authority mismatch must fail before a third stale launcher probe');
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'failed_launch');
  assert.equal(r.reason, 'launcher-identity-drift');
  const after = readState(root, runId).data;
  assert.deepEqual(after.autonomy.launcher_executable_approvals.wt, fresh);
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.sessions.find(session => session.run_id === h.childRunId)?.outcome, 'failed_launch');
});

test('native Windows respawn treats a present approval map with no selected authority as unavailable', () => {
  const { root, runId } = seedWindowsLauncher('wt', 'codex');
  const { data } = readState(root, runId);
  data.autonomy.launcher_executable_approvals = { powershell: null };
  writeState(root, runId, data);
  const h = emitHandoff(root, runId, {
    trigger: 'malformed-launcher-authority', now: NOW1, expect: expect_(runId), platform: 'win32',
  });
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'win32',
    revalidateRuntimeExecutable: identity => identity,
    revalidateLauncherExecutable: identity => identity,
    spawnFn: () => { spawned++; return { ok: true }; }, sleep: noSleep,
  });
  assert.equal(spawned, 0);
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(r.reason, 'launcher-identity-unavailable');
});

test('native Windows visible respawn keeps the legacy session-identity boundary only when the approval map is absent', () => {
  for (const kind of ['wt', 'powershell']) {
    const { root, runId, launcherIdentity } = seedWindowsLauncher(kind, 'codex');
    const { data } = readState(root, runId);
    delete data.autonomy.launcher_executable_approvals;
    writeState(root, runId, data);
    const h = emitHandoff(root, runId, {
      trigger: `legacy-${kind}-authority`, now: NOW1, expect: expect_(runId), platform: 'win32',
    });
    let launcherChecks = 0;
    let spawned = 0;
    const r = respawn(root, runId, {
      childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
      attended: true, env: {}, now: NOW1, platform: 'win32',
      revalidateRuntimeExecutable: identity => identity,
      revalidateLauncherExecutable: identity => { launcherChecks++; assert.deepEqual(identity, launcherIdentity); return identity; },
      spawnFn: () => { spawned++; return { ok: true }; },
      pollLease: () => ({ state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 }),
      sleep: noSleep,
    });
    assert.equal(r.ok, true, kind);
    assert.equal(r.outcome, 'spawned', kind);
    assert.equal(spawned, 1, kind);
    assert.equal(launcherChecks, 3, kind);
  }
});

test('native Windows Claude desktop uses exact durable PowerShell authority without an active terminal session', () => {
  const { root, runId, launcherIdentity } = seedWindowsDesktop();
  const h = emitHandoff(root, runId, {
    trigger: 'windows-desktop-durable-powershell', now: NOW1, expect: expect_(runId), platform: 'win32',
    desktopProbe: () => windowsDesktopTarget,
  });
  const checks = { runtime: 0, launcher: 0 };
  let spawns = 0;
  let entry = null;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'win32',
    desktopProbe: () => windowsDesktopTarget,
    revalidateRuntimeExecutable: identity => { checks.runtime++; return identity; },
    revalidateLauncherExecutable: identity => {
      checks.launcher++;
      assert.deepEqual(identity, launcherIdentity);
      return identity;
    },
    spawnFn: value => { spawns++; entry = value; return { ok: true }; },
    pollLease: seq([
      { state: 'releasing', owner_run_id: runId, generation: 1 },
      { state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 },
    ]),
    sleep: noSleep,
  });
  assert.equal(spawns, 1, `outcome=${r.outcome} reason=${r.reason}`);
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  assert.equal(r.reason, 'child-acquired');
  assert.equal(entry.bin, launcherIdentity.canonical_path);
  assert.equal(entry.shell, false);
  assert.deepEqual(entry.argv.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(entry.argv[3], /Start-Process -FilePath '/);
  assert.ok(entry.argv[3].includes(windowsDesktopTarget.argvTarget.exePath));
  assert.match(entry.argv[3], /claude:\/\/code\/new\?folder=/);
  assert.deepEqual(checks, { runtime: 0, launcher: 3 });
});

test('native Windows Claude desktop fails closed on absent, incomplete, or initially drifted durable PowerShell authority', () => {
  const cases = [
    ['absent-map', data => { delete data.autonomy.launcher_executable_approvals; }, identity => identity, 0],
    ['incomplete-map', data => { data.autonomy.launcher_executable_approvals = { wt: null }; }, identity => identity, 0],
    ['initial-file-replacement', () => {}, identity => ({ ...identity, sha256: 'c'.repeat(64) }), 1],
  ];
  for (const [name, mutate, revalidate, expectedChecks] of cases) {
    const { root, runId } = seedWindowsDesktop();
    const { data } = readState(root, runId);
    mutate(data);
    writeState(root, runId, data);
    const h = emitHandoff(root, runId, {
      trigger: `desktop-initial-${name}`, now: NOW1, expect: expect_(runId), platform: 'win32',
      desktopProbe: () => windowsDesktopTarget,
    });
    let launcherChecks = 0;
    let spawns = 0;
    const r = respawn(root, runId, {
      childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
      attended: true, env: {}, now: NOW1, platform: 'win32',
      desktopProbe: () => windowsDesktopTarget,
      revalidateLauncherExecutable: identity => { launcherChecks++; return revalidate(identity); },
      spawnFn: () => { spawns++; return { ok: true }; }, sleep: noSleep,
    });
    assert.equal(spawns, 0, name);
    assert.equal(launcherChecks, expectedChecks, name);
    assert.equal(r.ok, false, name);
    assert.equal(r.outcome, 'no-launcher', name);
    assert.equal(r.reason, 'launcher-identity-unavailable', name);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', name);
    assert.equal(after.session_chain.lease.handoff_phase, 'emitted', name);
  }
});

test('native Windows Claude desktop pre-CAS authority removal, malformed replacement, or exact reapproval preserve-pauses', () => {
  const mutations = [
    ['missing', data => { data.autonomy.launcher_executable_approvals.powershell = null; }],
    ['malformed', data => { data.autonomy.launcher_executable_approvals = { wt: null }; }],
    ['replaced', data => { data.autonomy.launcher_executable_approvals.powershell = replacementWindowsLauncherIdentity('powershell'); }],
  ];
  for (const [name, mutate] of mutations) {
    const { root, runId, launcherIdentity } = seedWindowsDesktop();
    const h = emitHandoff(root, runId, {
      trigger: `desktop-pre-cas-${name}`, now: NOW1, expect: expect_(runId), platform: 'win32',
      desktopProbe: () => windowsDesktopTarget,
    });
    let launcherChecks = 0;
    let spawns = 0;
    const r = respawn(root, runId, {
      childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
      attended: true, env: {}, now: NOW1, platform: 'win32',
      desktopProbe: () => windowsDesktopTarget,
      revalidateLauncherExecutable: identity => {
        launcherChecks++;
        assert.deepEqual(identity, launcherIdentity, name);
        if (launcherChecks === 1) {
          const { data } = readState(root, runId);
          mutate(data);
          writeState(root, runId, data);
        }
        return identity;
      },
      spawnFn: () => { spawns++; return { ok: true }; }, sleep: noSleep,
    });
    assert.equal(spawns, 0, name);
    assert.equal(launcherChecks, 1, name);
    assert.equal(r.outcome, 'no-launcher', name);
    assert.equal(r.reason, 'launcher-identity-drift', name);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', name);
    assert.equal(after.session_chain.lease.handoff_phase, 'emitted', name);
    assert.notEqual(after.session_chain.sessions.find(session => session.run_id === h.childRunId)?.outcome, 'failed_launch', name);
  }
});

test('native Windows Claude desktop post-CAS authority removal, malformed replacement, or exact reapproval rolls back', () => {
  const mutations = [
    ['missing', data => { data.autonomy.launcher_executable_approvals.powershell = null; }],
    ['malformed', data => { data.autonomy.launcher_executable_approvals = { wt: null }; }],
    ['replaced', data => { data.autonomy.launcher_executable_approvals.powershell = replacementWindowsLauncherIdentity('powershell'); }],
  ];
  for (const [name, mutate] of mutations) {
    const { root, runId, launcherIdentity } = seedWindowsDesktop();
    const h = emitHandoff(root, runId, {
      trigger: `desktop-post-cas-${name}`, now: NOW1, expect: expect_(runId), platform: 'win32',
      desktopProbe: () => windowsDesktopTarget,
    });
    let launcherChecks = 0;
    let spawns = 0;
    const r = respawn(root, runId, {
      childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
      attended: true, env: {}, now: NOW1, platform: 'win32',
      desktopProbe: () => windowsDesktopTarget,
      revalidateLauncherExecutable: identity => {
        launcherChecks++;
        assert.deepEqual(identity, launcherIdentity, name);
        if (launcherChecks === 2) {
          const { data } = readState(root, runId);
          mutate(data);
          writeState(root, runId, data);
        }
        return identity;
      },
      spawnFn: () => { spawns++; return { ok: true }; }, sleep: noSleep,
    });
    assert.equal(spawns, 0, name);
    assert.equal(launcherChecks, 2, name);
    assert.equal(r.outcome, 'failed_launch', name);
    assert.equal(r.reason, 'launcher-identity-drift', name);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', name);
    assert.equal(after.session_chain.lease.handoff_phase, 'idle', name);
    assert.equal(after.session_chain.sessions.find(session => session.run_id === h.childRunId)?.outcome, 'failed_launch', name);
  }
});

test('native Windows Codex App desktop continuation remains manual and does not consume PowerShell authority', () => {
  const { root, runId } = seedWindowsDesktop('codex');
  const { data } = readState(root, runId);
  data.autonomy.launcher_executable_approvals = { wt: null, powershell: null };
  writeState(root, runId, data);
  let desktopProbes = 0;
  const h = emitHandoff(root, runId, {
    trigger: 'codex-app-manual', now: NOW1, expect: expect_(runId), platform: 'win32',
    desktopProbe: () => { desktopProbes++; return windowsDesktopTarget; },
  });
  let launcherChecks = 0;
  let spawns = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'win32',
    desktopProbe: () => { desktopProbes++; return windowsDesktopTarget; },
    revalidateLauncherExecutable: identity => { launcherChecks++; return identity; },
    spawnFn: () => { spawns++; return { ok: true }; }, sleep: noSleep,
  });
  assert.equal(desktopProbes, 0, 'Codex App must not probe the Claude desktop handler');
  assert.equal(launcherChecks, 0, 'manual Codex App continuation must not require PowerShell authority');
  assert.equal(spawns, 0);
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(r.reason, 'codex-transport-not-activated');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

test('native Windows respawn passes only revalidated absolute launcher/runtime targets with shell false', () => {
  const { root, runId, runtimeIdentity, launcherIdentity } = seedWindowsLauncher('wt');
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId), platform: 'win32' });
  const checks = [];
  const runtimeProbe = () => ({ status: 'valid', signer: 'Runtime Signer', thumbprint: 'aa' });
  const launcherProbe = () => ({ status: 'valid', signer: 'Launcher Signer', thumbprint: 'bb' });
  const runtimePolicy = { signer: 'Runtime Signer', thumbprint: 'aa' };
  const launcherPolicy = { signer: 'Launcher Signer', thumbprint: 'bb' };
  let entry;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'win32',
    runtimeRevalidationOptions: { authenticodeProbe: runtimeProbe, authenticodePolicy: runtimePolicy },
    launcherRevalidationOptions: { authenticodeProbe: launcherProbe, authenticodePolicy: launcherPolicy },
    revalidateRuntimeExecutable: (identity, options) => {
      checks.push('runtime'); assert.deepEqual(identity, runtimeIdentity);
      assert.strictEqual(options.authenticodeProbe, runtimeProbe);
      assert.strictEqual(options.authenticodePolicy, runtimePolicy);
      return identity;
    },
    revalidateLauncherExecutable: (identity, options) => {
      checks.push('launcher'); assert.deepEqual(identity, launcherIdentity);
      assert.strictEqual(options.authenticodeProbe, launcherProbe);
      assert.strictEqual(options.authenticodePolicy, launcherPolicy);
      return identity;
    },
    spawnFn: (value) => { entry = value; return { ok: true }; },
    pollLease: seq([
      { state: 'releasing', owner_run_id: runId, generation: 1 },
      { state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 },
    ]),
    sleep: noSleep,
  });
  assert.equal(r.ok, true);
  assert.equal(entry.bin, launcherIdentity.canonical_path);
  assert.equal(entry.shell, false);
  assert.equal(entry.argv[2], runtimeIdentity.canonical_path);
  assert.deepEqual(entry.nativeExecutableArgvIndices, [2]);
  assert.ok(checks.filter(value => value === 'runtime').length >= 3, 'runtime identity is checked for build, from fresh state before CAS, and immediately before spawn');
  assert.ok(checks.filter(value => value === 'launcher').length >= 3, 'launcher identity is checked for build, from fresh state before CAS, and immediately before spawn');
});

test('native Windows identity drift before CAS blocks spawn, preserve-pauses, and never falls back to a bare name', () => {
  for (const drift of ['runtime', 'launcher']) {
    const { root, runId } = seedWindowsLauncher('wt');
    const h = emitHandoff(root, runId, { trigger: `milestone-${drift}`, now: NOW1, expect: expect_(runId), platform: 'win32' });
    let spawned = 0;
    const r = respawn(root, runId, {
      childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
      attended: true, env: {}, now: NOW1, platform: 'win32',
      revalidateRuntimeExecutable: (identity) => {
        if (drift === 'runtime') throw new Error('RUNTIME_EXECUTABLE_DRIFT');
        return identity;
      },
      revalidateLauncherExecutable: (identity) => {
        if (drift === 'launcher') throw new Error('LAUNCHER_EXECUTABLE_DRIFT');
        return identity;
      },
      spawnFn: () => { spawned++; return { ok: true }; }, sleep: noSleep,
    });
    assert.equal(r.ok, false, drift);
    assert.equal(r.outcome, 'no-launcher', drift);
    assert.equal(spawned, 0, drift);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', drift);
    assert.equal(after.session_chain.lease.handoff_phase, 'emitted', drift);
  }
});

test('native Windows identity drift after CAS but before process call rolls back and pauses without spawn', () => {
  const { root, runId } = seedWindowsLauncher('wt');
  const h = emitHandoff(root, runId, { trigger: 'milestone-post-cas-drift', now: NOW1, expect: expect_(runId), platform: 'win32' });
  let runtimeChecks = 0;
  let spawned = 0;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'win32',
    revalidateRuntimeExecutable: (identity) => {
      runtimeChecks++;
      if (runtimeChecks === 3) throw new Error('RUNTIME_EXECUTABLE_DRIFT');
      return identity;
    },
    revalidateLauncherExecutable: (identity) => identity,
    spawnFn: () => { spawned++; return { ok: true }; }, sleep: noSleep,
  });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'failed_launch');
  assert.equal(r.reason, 'runtime-identity-drift');
  assert.equal(spawned, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.lease.handoff_child_run_id, null);
});

test('native Windows Codex WT production-shaped visible respawn defaults the plugin root and waits for child acquisition', () => {
  const { root, runId, runtimeIdentity, launcherIdentity } = seedWindowsLauncher('wt', 'codex');
  const h = emitHandoff(root, runId, {
    trigger: 'codex-wt-default-root', now: NOW1, expect: expect_(runId), platform: 'win32',
  });
  const checks = { runtime: 0, launcher: 0 };
  let spawns = 0;
  let polls = 0;
  const poll = seq([
    { state: 'releasing', owner_run_id: runId, generation: 1 },
    { state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 },
  ]);
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'win32',
    revalidateRuntimeExecutable: (identity) => { checks.runtime++; assert.deepEqual(identity, runtimeIdentity); return identity; },
    revalidateLauncherExecutable: (identity) => { checks.launcher++; assert.deepEqual(identity, launcherIdentity); return identity; },
    spawnFn: (entry) => {
      spawns++;
      assert.equal(entry.bin, launcherIdentity.canonical_path);
      assert.equal(entry.argv[2], runtimeIdentity.canonical_path);
      assert.deepEqual(entry.nativeExecutableArgvIndices, [2]);
      assert.equal(entry.shell, false);
      return { ok: true };
    },
    pollLease: () => { polls++; return poll(); },
    sleep: noSleep,
  });
  const after = readState(root, runId).data;
  assert.equal(
    spawns,
    1,
    `outcome=${r.outcome} reason=${r.reason} status=${after.status} phase=${after.session_chain.lease.handoff_phase} state=${after.session_chain.lease.state}`,
  );
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  assert.equal(r.reason, 'child-acquired');
  assert.equal(polls, 2, 'launcher exit is not readiness proof; exact child acquisition is required');
  assert.deepEqual(checks, { runtime: 3, launcher: 3 }, 'runtime and matching launcher are checked at build, pre-CAS, and post-CAS');
});

test('native Windows Codex PowerShell visible respawn uses trusted targets and waits for child acquisition', () => {
  const { root, runId, runtimeIdentity, launcherIdentity } = seedWindowsLauncher('powershell', 'codex');
  const h = emitHandoff(root, runId, {
    trigger: 'codex-powershell', now: NOW1, expect: expect_(runId), platform: 'win32',
  });
  const checks = { runtime: 0, launcher: 0 };
  let spawns = 0;
  let polls = 0;
  const poll = seq([
    { state: 'releasing', owner_run_id: runId, generation: 1 },
    { state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 },
  ]);
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, platform: 'win32', deepLoopRoot: 'C:\\Deep Loop',
    revalidateRuntimeExecutable: (identity) => { checks.runtime++; assert.deepEqual(identity, runtimeIdentity); return identity; },
    revalidateLauncherExecutable: (identity) => { checks.launcher++; assert.deepEqual(identity, launcherIdentity); return identity; },
    spawnFn: (entry) => {
      spawns++;
      assert.equal(entry.bin, launcherIdentity.canonical_path);
      assert.deepEqual(entry.nativeExecutableTargets, [runtimeIdentity.canonical_path]);
      assert.equal(entry.shell, false);
      return { ok: true };
    },
    pollLease: () => { polls++; return poll(); },
    sleep: noSleep,
  });
  assert.equal(spawns, 1, `outcome=${r.outcome} reason=${r.reason}`);
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  assert.equal(r.reason, 'child-acquired');
  assert.equal(polls, 2, 'launcher exit is not readiness proof; exact child acquisition is required');
  assert.deepEqual(checks, { runtime: 3, launcher: 3 }, 'runtime and matching launcher are checked at build, pre-CAS, and post-CAS');
});

test('native Windows Codex pre-CAS runtime or launcher drift preserve-pauses without spawning', () => {
  for (const [kind, drift] of [['wt', 'runtime'], ['powershell', 'launcher']]) {
    const { root, runId } = seedWindowsLauncher(kind, 'codex');
    const h = emitHandoff(root, runId, {
      trigger: `codex-pre-cas-${kind}-${drift}`, now: NOW1, expect: expect_(runId), platform: 'win32',
    });
    const checks = { runtime: 0, launcher: 0 };
    let spawns = 0;
    const r = respawn(root, runId, {
      childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
      attended: true, env: {}, now: NOW1, platform: 'win32', deepLoopRoot: 'C:\\Deep Loop',
      revalidateRuntimeExecutable: (identity) => {
        checks.runtime++;
        if (drift === 'runtime' && checks.runtime === 2) throw new Error('RUNTIME_EXECUTABLE_DRIFT');
        return identity;
      },
      revalidateLauncherExecutable: (identity) => {
        checks.launcher++;
        if (drift === 'launcher' && checks.launcher === 2) throw new Error('LAUNCHER_EXECUTABLE_DRIFT');
        return identity;
      },
      spawnFn: () => { spawns++; return { ok: true }; }, sleep: noSleep,
    });
    assert.equal(spawns, 0, `${kind}/${drift}`);
    assert.equal(r.ok, false, `${kind}/${drift}`);
    assert.equal(r.outcome, 'no-launcher', `${kind}/${drift}`);
    assert.equal(r.reason, `${drift}-identity-drift`, `${kind}/${drift}`);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', `${kind}/${drift}`);
    assert.equal(after.pause_reason, `${drift}-identity-drift`, `${kind}/${drift}`);
    assert.equal(after.session_chain.lease.handoff_phase, 'emitted', `${kind}/${drift}`);
    assert.equal(after.session_chain.lease.handoff_child_run_id, h.childRunId, `${kind}/${drift}`);
    assert.notEqual(after.session_chain.sessions.find(session => session.run_id === h.childRunId)?.outcome, 'failed_launch', `${kind}/${drift}`);
  }
});

test('native Windows Codex post-CAS runtime or launcher drift rolls back, pauses, and marks failed launch', () => {
  for (const [kind, drift] of [['wt', 'runtime'], ['powershell', 'launcher']]) {
    const { root, runId } = seedWindowsLauncher(kind, 'codex');
    const h = emitHandoff(root, runId, {
      trigger: `codex-post-cas-${kind}-${drift}`, now: NOW1, expect: expect_(runId), platform: 'win32',
    });
    const checks = { runtime: 0, launcher: 0 };
    let spawns = 0;
    const r = respawn(root, runId, {
      childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
      attended: true, env: {}, now: NOW1, platform: 'win32', deepLoopRoot: 'C:\\Deep Loop',
      revalidateRuntimeExecutable: (identity) => {
        checks.runtime++;
        if (drift === 'runtime' && checks.runtime === 3) throw new Error('RUNTIME_EXECUTABLE_DRIFT');
        return identity;
      },
      revalidateLauncherExecutable: (identity) => {
        checks.launcher++;
        if (drift === 'launcher' && checks.launcher === 3) throw new Error('LAUNCHER_EXECUTABLE_DRIFT');
        return identity;
      },
      spawnFn: () => { spawns++; return { ok: true }; }, sleep: noSleep,
    });
    assert.equal(spawns, 0, `${kind}/${drift}`);
    assert.equal(r.ok, false, `${kind}/${drift}`);
    assert.equal(r.outcome, 'failed_launch', `${kind}/${drift}`);
    assert.equal(r.reason, `${drift}-identity-drift`, `${kind}/${drift}`);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', `${kind}/${drift}`);
    assert.equal(after.pause_reason, 'launch-failed', `${kind}/${drift}`);
    assert.equal(after.session_chain.lease.handoff_phase, 'idle', `${kind}/${drift}`);
    assert.equal(after.session_chain.lease.handoff_child_run_id, null, `${kind}/${drift}`);
    assert.equal(after.session_chain.sessions.find(session => session.run_id === h.childRunId)?.outcome, 'failed_launch', `${kind}/${drift}`);
  }
});

// ── Task 3: unavailable-entry guard generalized (any mode, not just powershell) ──
// NOTE: post-Task-5b, respawn's desktopProbe defaults to defaultDesktopProbe (a REAL host query) —
// this test explicitly injects a stub `desktopProbe` returning unverified so its outcome stays
// deterministic across hosts/CI (never depends on whether the test machine happens to have Claude
// Desktop installed at the allowlisted path/bundle-id).
test('desktop mode with unverified target (desktopProbe: ok:false) → preserve-pause, not rollback', () => {
  const { root, runId } = seed((d) => {
    d.autonomy.spawn_style = 'desktop';
    d.autonomy.attended_launch_approval = attendedApproval('desktop');
    d.session_spawn = {
      platform: 'darwin', launcher: 'none', launcher_bin: null, launcher_socket: null,
      surface: 'window', reachable: true, visible: true, signals: {}, probe: null,
      reason: null, fallback: 'launch-command-file', detected_at: '2026-06-24T00:00:00Z',
    };
  });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawned = false;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1,
    platform: 'darwin', desktopProbe: () => ({ ok: false }),
    spawnFn: () => { spawned = true; return { ok: true }; }, sleep: noSleep,
  });
  assert.equal(spawned, false, 'must not spawn when the desktop target is unverified');
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(r.reason, 'desktop-launcher-unavailable');
  // respawn SELF-preserve-pauses (same contract as B3) — reserved child preserved, NOT invalidated/rolled back.
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused', 'run must be preserve-paused by respawn itself');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');       // handoff preserved for recovery
  assert.equal(after.session_chain.lease.handoff_child_run_id, h.childRunId, 'reserved child preserved (not invalidated)');
  assert.equal(after.session_chain.lease.resume_policy, 'human');
});

// ── Task 5b: wire the handler-verification probe into respawn (verified desktopTarget reaches
// buildLaunchCommand → spawnFn; unverified → the Task-3 guard above preserve-pauses) ──
function seedDesktop() {
  return seed((d) => {
    d.autonomy.spawn_style = 'desktop';
    d.autonomy.attended_launch_approval = attendedApproval('desktop');
    d.session_spawn = {
      platform: 'darwin', launcher: 'none', launcher_bin: null, launcher_socket: null,
      surface: 'window', reachable: true, visible: true, signals: {}, probe: null,
      reason: null, fallback: 'launch-command-file', detected_at: '2026-06-24T00:00:00Z',
    };
  });
}

test('Task 5b: desktop respawn with a verified probe target reaches spawnFn (open -a Claude.app)', () => {
  const { root, runId } = seedDesktop();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let got;
  const spawnFn = (e) => { got = e; return { ok: true }; };
  // Simulate the reserved child acquiring the lease (same handshake pattern as the visible-launcher
  // success test above) so respawn reports a genuine success outcome, not just command construction.
  const pollLease = seq([
    { state: 'releasing', owner_run_id: runId, generation: 1 },
    { state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 },
  ]);
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1,
    platform: 'darwin',
    desktopProbe: () => ({ ok: true, argvTarget: { kind: 'macos-app', appPath: '/Applications/Claude.app' } }),
    spawnFn, pollLease, sleep: noSleep,
  });
  assert.ok(got, 'spawnFn must have been called with the desktop entry');
  assert.equal(got.bin, '/usr/bin/open');
  assert.equal(got.argv[0], '-a');
  assert.equal(got.argv[1], '/Applications/Claude.app');
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
});

test('Task 5b: desktop respawn with an unverified probe (ok:false) never reaches spawnFn (preserve-pause)', () => {
  const { root, runId } = seedDesktop();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1,
    platform: 'darwin', desktopProbe: () => ({ ok: false }),
    spawnFn: () => { throw new Error('should not spawn'); }, sleep: noSleep,
  });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'no-launcher');
  assert.equal(readState(root, runId).data.status, 'paused');
});

// ── WS1: respawn threads state model/effort into the spawned child entry ──────
test('respawn threads state model/effort into the spawned headless entry (WS1)', () => {
  const { root, runId } = seedLauncher({ spawn_style: 'headless', launcher: 'cmux' });
  { const { data } = readState(root, runId); data.autonomy.session_model = 'claude-opus-4-8[1m]'; data.autonomy.session_effort = 'xhigh'; writeState(root, runId, data); }
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let captured = null;
  const spawnFn = (entry) => { captured = entry; return { ok: true, usage: { num_turns: 1, tokens: 1 } }; };
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1 + 1000, spawnFn });
  assert.equal(r.ok, true);
  assert.ok(captured, 'spawnFn was called');
  assert.ok(captured.argv.includes('--model') && captured.argv.includes('claude-opus-4-8[1m]'), 'headless entry carries --model');
  assert.ok(captured.argv.includes('--effort') && captured.argv.includes('xhigh'), 'headless entry carries --effort');
});

test('respawn threads state model/effort into the spawned VISIBLE entry (WS1)', () => {
  const { root, runId } = seedLauncher({ spawn_style: 'visible', launcher: 'cmux' });
  { const { data } = readState(root, runId); data.autonomy.session_model = 'claude-opus-4-8[1m]'; data.autonomy.session_effort = 'high'; writeState(root, runId, data); }
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let got;
  const spawnFn = (e) => { got = e; return { ok: true }; };
  const pollLease = seq([{ state: 'releasing', owner_run_id: runId, generation: 1 }, { state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 }]);
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn, pollLease, sleep: noSleep });
  assert.equal(r.ok, true);
  const cmuxCmd = got.argv[got.argv.indexOf('--command') + 1];
  assert.match(cmuxCmd, /--model 'claude-opus-4-8\[1m\]' --effort 'high'/);
});

// ── v1.6 terminal guards (spec §2.3-5 / §4-5c) ───────────────────────────────
import { rollbackAndPause } from '../scripts/lib/respawn.mjs';

test('respawn: terminal fast-return before every branch — emitted AND spawned legacy states', () => {
  for (const phase of ['emitted', 'spawned']) {
    const { root, runId } = seed((d) => {
      d.status = 'completed';
      d.session_chain.lease = { ...d.session_chain.lease, state: 'releasing', handoff_phase: phase,
        handoff_child_run_id: 'child-legacy-01', handoff_idempotency_key: 'k1', resume_policy: 'headless' };
    });
    const before = JSON.stringify(readState(root, runId).data);
    const r = respawn(root, runId, { childRunId: 'child-legacy-01', key: 'k1', now: NOW1,
      spawnFn: () => { throw new Error('must not spawn'); } });
    assert.equal(r.ok, false, phase); assert.equal(r.outcome, 'terminal', phase); assert.equal(r.reason, 'RUN_TERMINAL', phase);
    assert.equal(JSON.stringify(readState(root, runId).data), before, `${phase}: 상태 무변`);
  }
});

test('rollbackAndPause: terminal TOCTOU returns {terminal:true} and never demotes a completed run to paused', () => {
  const { root, runId } = seed((d) => {
    d.status = 'completed';
    d.session_chain.lease = { ...d.session_chain.lease, state: 'releasing', handoff_phase: 'emitted',
      handoff_child_run_id: 'child-x', handoff_idempotency_key: 'kx' };
  });
  const r = rollbackAndPause(root, runId, { childRunId: 'child-x', parentOwner: runId, generation: 1,
    eventData: { child_run_id: 'child-x' }, pauseReason: 'gate:budget' });
  assert.deepEqual(r, { terminal: true });
  assert.equal(readState(root, runId).data.status, 'completed');   // paused 강등 없음
});
