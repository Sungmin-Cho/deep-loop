import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitCompactCheckpoint, emitLegacyCompactCheckpointFromTrustedHook } from '../scripts/lib/checkpoint.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { newWorkstream, setWorkstreamStatus } from '../scripts/lib/workspace.mjs';
import { runDir } from '../scripts/lib/state.mjs';
import { runSessionStartRestore } from '../scripts/hooks-impl/sessionstart-restore.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { buildInitialLoop, initRun } from '../scripts/lib/initrun.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';
import {
  readableSessionRuntime,
  runtimeCapability,
  sessionRuntime,
} from '../scripts/lib/runtime.mjs';
import { migrateAuthenticLegacyTransport } from './helpers/legacy-transport.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-08-17T00:00:00.000Z');
const UNREADABLE_RESTORE =
  'deep-loop: compact 복원 컨텍스트를 확인할 수 없다. 이 run의 상태는 /deep-loop-status(Claude·Grok) 또는 $deep-loop:deep-loop-status(Codex)로 확인하라.';
const CLAUDE_NOTE = '> desktop transport는 URL로 model/effort를 전달할 수 없으니, desktop 재개 시 이 값으로 세션을 맞추세요.';
const CODEX_NOTE = '> Codex model과 low/medium/high/xhigh effort 매핑은 격리 descriptor에 고정되며 max effort는 fail-closed다. 실행은 별도 executable 승인·preflight 전까지 비활성이다.';
const GROK_NOTE = '> Grok는 attended Darwin 세션 런타임이다. desktop transport와 측정 headless 경로가 없고 effort를 seed하지 않으므로, 재개는 승인된 실행파일 정체성으로 사람이 연 세션에서만 가능하다.';

function capLoop(runtime, policy) {
  const loop = buildInitialLoop({
    runtime, goal: 'g', protocol: 'standalone', recipe: { id: 'r', name: 'r', reason: '' },
    runId: `R-${runtime}`, now: new Date(NOW), platform: runtime === 'grok' ? 'darwin' : 'linux',
  });
  loop.autonomy.continuation_policy = policy;
  loop.budget.per_session_turn_cap = 1;
  loop.session_chain.sessions[0].turns = 5;
  return loop;
}

function seedRuntime(runtime, platform = runtime === 'grok' ? 'darwin' : 'linux') {
  const root = mkdtempSync(join(tmpdir(), `dl-guide-${runtime}-`));
  const { runId } = initRun(root, {
    runtime, goal: 'g', now: new Date(NOW), env: {}, platform, run: () => ({ code: 1 }),
  });
  return { root, runId };
}

test('capability enums match the D5 table and are read through runtimeCapability', () => {
  assert.equal(runtimeCapability('claude', 'compact_supported'), true);
  assert.equal(runtimeCapability('codex', 'compact_supported'), true);
  assert.equal(runtimeCapability('grok', 'compact_supported'), false);
  assert.equal(runtimeCapability('claude', 'handoff_continuity_note'), 'desktop-model-effort');
  assert.equal(runtimeCapability('codex', 'handoff_continuity_note'), 'codex-preflight');
  assert.equal(runtimeCapability('grok', 'handoff_continuity_note'), 'grok-attended');
});

test('readableSessionRuntime does not consume the claude fallback', () => {
  assert.equal(sessionRuntime({ autonomy: {} }), 'claude');
  assert.equal(readableSessionRuntime({ autonomy: {} }), null);
  assert.equal(readableSessionRuntime({ autonomy: { session_runtime: undefined } }), null);
  assert.equal(readableSessionRuntime({
    autonomy: { session_runtime: 'grok', runtime_source: 'skill-asserted' },
  }), 'grok');
  assert.equal(readableSessionRuntime({
    autonomy: { session_runtime: 'grok', runtime_source: 'wrong' },
  }), null);
  assert.equal(readableSessionRuntime({ autonomy: { runtime_source: 'skill-asserted' } }), null);
  assert.equal(readableSessionRuntime({ autonomy: null }), null);
});

test('grok and unreadable loops never receive compact advice from either cadence', () => {
  for (const policy of ['workstream-session', 'compact-in-place']) {
    const grok = nextAction(capLoop('grok', policy), { now: NOW });
    assert.notEqual(grok.action.advice, 'compact', policy);
    assert.equal(grok.action.advice_reason, undefined, policy);
  }

  const absent = capLoop('claude', 'compact-in-place');
  delete absent.autonomy.session_runtime;
  delete absent.autonomy.runtime_source;
  const absentResult = nextAction(absent, { now: NOW });
  assert.notEqual(absentResult.action.advice, 'compact');

  const thrown = capLoop('claude', 'workstream-session');
  thrown.autonomy = {
    continuation_policy: 'workstream-session',
    session_runtime: 'grok',
    runtime_source: 'wrong',
  };
  thrown.budget.per_session_turn_cap = 1;
  thrown.session_chain.sessions[0].turns = 5;
  assert.doesNotThrow(() => nextAction(thrown, { now: NOW }));
  const thrownResult = nextAction(thrown, { now: NOW });
  assert.notEqual(thrownResult.action.advice, 'compact');

  const grokRotate = nextAction(capLoop('grok', 'rotate-per-unit'), { now: NOW });
  assert.equal(grokRotate.action.type, 'handoff');
  assert.equal(grokRotate.action.reason, 'per_session_turn_cap');
});

test('R4 claude and codex fenced emits succeed with runtime_executable_approval null', () => {
  for (const runtime of ['claude', 'codex']) {
    const { root, runId } = seedRuntime(runtime);
    const fence = { owner: runId, generation: 1 };
    const worktree = `.claude/worktrees/r4-${runtime}`;
    mkdirSync(join(root, worktree), { recursive: true });
    const present = `${worktree}/present.txt`;
    writeFileSync(join(root, present), 'present');
    const workstreamId = newWorkstream(root, runId, {
      title: `r4-${runtime}`,
      branch: `feature/r4-${runtime}`,
      worktree,
      fence,
    }).id;
    setWorkstreamStatus(root, runId, workstreamId, 'in_progress', { fence });
    const episodeId = newEpisode(root, runId, {
      plugin: 'deep-work',
      role: 'maker',
      kind: 'implementation',
      point: 'implementation',
      workstream: workstreamId,
      expectedArtifacts: [present],
      fence,
    }).id;
    recordEpisode(root, runId, episodeId, { status: 'in_progress', fence });
    const loop = JSON.parse(readFileSync(join(runDir(root, runId), 'loop.json'), 'utf8'));
    assert.equal(loop.autonomy.runtime_executable_approval, null);
    const emitted = emitCompactCheckpoint(root, runId, {
      fence,
      runtime,
      now: NOW + 1,
    });
    assert.equal(emitted.ok, true, runtime);
  }
});

test('claude and codex loops still receive compact advice at the cap', () => {
  const claude = nextAction(capLoop('claude', 'compact-in-place'), { now: NOW });
  assert.equal(claude.action.advice, 'compact');
  const codex = nextAction(capLoop('codex', 'compact-in-place'), { now: NOW });
  assert.equal(codex.action.advice, 'compact');
  const claudeWs = nextAction(capLoop('claude', 'workstream-session'), { now: NOW });
  assert.equal(claudeWs.action.advice, 'compact');
});

test('handoff continuity notes are the three D5 strings', () => {
  for (const [runtime, note] of [
    ['claude', CLAUDE_NOTE],
    ['codex', CODEX_NOTE],
    ['grok', GROK_NOTE],
  ]) {
    const { root, runId } = seedRuntime(runtime);
    migrateAuthenticLegacyTransport(root, runId);
    const result = emitHandoff(root, runId, {
      now: NOW + 1,
      expect: { owner: runId, generation: 1 },
    });
    assert.equal(result.ok, true, runtime);
    const md = readFileSync(result.handoffPath, 'utf8');
    assert.match(md, new RegExp(note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    if (runtime !== 'claude') assert.doesNotMatch(md, /desktop transport는 URL로/);
    if (runtime !== 'codex') assert.doesNotMatch(md, /Codex model과/);
  }
});

function selectedRestore(loop, inspectReason = 'checkpoint-not-found') {
  return runSessionStartRestore({ hook_event_name: 'SessionStart', source: 'compact' }, {
    root: '/tmp',
    now: NOW,
    resolveContextFn: () => ({
      ok: true,
      kind: 'selected',
      runId: loop.run_id || 'R',
      snapshot: { data: loop, hash: 'h'.repeat(64) },
    }),
    inspectCompact: () => ({ ok: false, reason: inspectReason }),
  });
}

test('unreadable SessionStart runs emit the neutral sentence with both host tokens', () => {
  const base = buildInitialLoop({
    runtime: 'claude', goal: 'g', protocol: 'standalone', recipe: { id: 'r', name: 'r', reason: '' },
    runId: 'R-unread', now: new Date(NOW),
  });

  const absent = structuredClone(base);
  delete absent.autonomy.session_runtime;
  delete absent.autonomy.runtime_source;
  const absentResult = selectedRestore(absent);
  assert.match(absentResult.additionalContext, new RegExp(UNREADABLE_RESTORE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(absentResult.additionalContext, /\/deep-loop-status/);
  assert.match(absentResult.additionalContext, /\$deep-loop:deep-loop-status/);
  assert.doesNotMatch(absentResult.additionalContext, /deep-loop-compact restore/);

  const thrown = structuredClone(base);
  thrown.autonomy = { continuation_policy: 'workstream-session', runtime_source: 'skill-asserted' };
  const thrownResult = selectedRestore(thrown);
  assert.match(thrownResult.additionalContext, new RegExp(UNREADABLE_RESTORE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(thrownResult.additionalContext, /\/deep-loop-status/);
  assert.match(thrownResult.additionalContext, /\$deep-loop:deep-loop-status/);
});

test('readable grok SessionStart uses slash tokens, not the Codex dollar token', () => {
  const grok = buildInitialLoop({
    runtime: 'grok', goal: 'g', protocol: 'standalone', recipe: { id: 'r', name: 'r', reason: '' },
    runId: 'R-grok', now: new Date(NOW), platform: 'darwin',
  });
  const missing = selectedRestore(grok);
  assert.match(missing.additionalContext, /\/deep-loop-status/);
  assert.doesNotMatch(missing.additionalContext, /\$deep-loop:deep-loop-status/);
  assert.doesNotMatch(
    missing.additionalContext,
    new RegExp(UNREADABLE_RESTORE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
});

test('SessionStart production path does not default runtimeHint to claude', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'hooks-impl', 'sessionstart-restore.mjs'), 'utf8');
  assert.doesNotMatch(source, /runtimeHint = 'claude'/);
  assert.doesNotMatch(source, /CLAUDE_PLUGIN_ROOT \? 'claude' : 'codex'/);
  assert.match(source, /autonomy\?\.continuation_policy/);
  assert.doesNotMatch(source, /continuation \(compact-in-place\)/);
});

test('SessionStart resume label uses durable continuation_policy', () => {
  const { root, runId } = seedRuntime('claude');
  migrateAuthenticLegacyTransport(root, runId, 'compact-in-place');
  emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW + 1 });
  const result = runSessionStartRestore({ hook_event_name: 'SessionStart', source: 'compact' }, {
    root, now: NOW,
  });
  assert.equal(result.branch, 'resume', result.branch);
  assert.match(result.additionalContext, /continuation \(compact-in-place\)/);
});
