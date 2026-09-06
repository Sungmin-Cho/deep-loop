import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { driveGoalRun } from '../scripts/lib/goal-host.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { acquireLease } from '../scripts/lib/lease.mjs';
import { approveRuntimeExecutable } from '../scripts/lib/runtime-executable.mjs';
import { writeProcessUsageReceipt } from '../scripts/lib/preflight-receipt-journal.mjs';
import { makeGoalFixture } from './helpers/goal-fixture.mjs';
import {
  createScenarioMaker,
  produceScenarioMaker,
} from './helpers/goal-scenario.mjs';
import { goalOk, nativeObservation } from './helpers/reviewed-goal.mjs';
import { parseWriteProbePrompt } from './fixtures/fake-codex-native.mjs';

const DEEP_LOOP_ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const PARENT_THREAD = '019d1234-5678-7abc-8def-0123456789ab';
const CHILD_THREAD = '019d1234-5678-7abc-8def-0123456789ac';
const USAGE = Object.freeze({
  num_turns: 1,
  input_tokens: 4,
  output_tokens: 3,
  tokens: 7,
});

function measured(providerThreadId = null, extra = {}) {
  return {
    ok: true,
    usage: USAGE,
    ...(providerThreadId == null ? {} : { providerThreadId }),
    finalMessage: Buffer.from('yield'),
    rawJsonl: Buffer.from('{"type":"turn.completed"}\n'),
    rawJsonlTruncated: false,
    process_group: {
      mode: 'required',
      platform: process.platform,
      group_id: 43210,
      termination_scope: 'owned-posix-process-group',
      quiescence_confirmed: true,
    },
    termination: {
      trigger: 'natural-exit',
      term_requested: false,
      kill_requested: false,
      confirmed: true,
    },
    ...extra,
  };
}

test('goal host reaches emitted handoff and adopts only the acquired child provider binding', async t => {
  const fixture = makeGoalFixture({
    runtime: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    boundaryMode: 'handoff',
    review: {
      points: ['implementation'],
      reviewer: 'subagent-checker',
      mode: 'cross-model',
      flags: [],
      converge: true,
      max_review_rounds: 5,
      require_human_ack: false,
    },
  });
  const codexHome = realpathSync(mkdtempSync(join(tmpdir(), 'deep-loop-goal-host-home-')));
  t.after(() => {
    fixture.cleanup();
    rmSync(codexHome, { recursive: true, force: true });
  });

  const executable = realpathSync(process.execPath);
  const executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const approval = approveRuntimeExecutable(fixture.root, fixture.runId, {
    runtime: 'codex',
    candidatePath: executable,
    expectedCanonicalPath: executable,
    expectedSha256: executableSha256,
    actor: 'human',
    confirm: true,
    fence: fixture.fence,
    now: Date.parse('2026-09-06T00:00:00.000Z'),
    runVersion: () => ({
      status: 0,
      signal: null,
      stdout: 'codex-cli 0.153.4\n',
      stderr: '',
    }),
  });

  const workstream = fixture.workstream('handoff-owner');
  const maker = createScenarioMaker(fixture, workstream);
  produceScenarioMaker(fixture, maker);
  const terminalRoute = {
    request: { task_class: 'IMPLEMENTATION' },
    decision: {
      route_schema_version: 1,
      router_plugin_version: 'fixture',
      policy_sha256: 'a'.repeat(64),
    },
    selected_model: 'gpt-5.6-sol',
    selected_effort_native: 'low',
    effective_policy: {},
    provenance: 'local-fallback',
  };
  const checker = goalOk(fixture.cli([
    'review', 'dispatch',
    '--point', 'implementation',
    '--workstream', workstream.id,
    '--independent-subagent',
    '--routing', JSON.stringify(terminalRoute),
  ])).checkerEpisodeId;
  const claim = goalOk(fixture.cli(['review', 'claim', '--episode', checker]));
  const checkerHandle = 'synthetic-routed-checker';
  goalOk(fixture.cli([
    'execution', 'start',
    '--episode', checker,
    '--attempt', claim.attemptId,
    '--handle', checkerHandle,
  ]));
  goalOk(fixture.cli([
    'execution', 'return',
    '--episode', checker,
    '--attempt', claim.attemptId,
    '--artifacts', '[]',
    '--observation', JSON.stringify(nativeObservation('succeeded', checkerHandle)),
  ]));
  goalOk(fixture.cli(['review', 'import', '--stdin'], {
    input: JSON.stringify({
      schema_version: '1.0',
      reviewer_id: claim.claim.reviewer_id,
      checker_episode_id: checker,
      target_maker: maker.id,
      attempt_id: claim.attemptId,
      verdict: 'APPROVE',
      report_body: '# Synthetic routed checker\nAPPROVE',
      artifacts: claim.claim.artifacts,
    }),
  }));
  assert.equal(fixture.state().episodes.find(episode => episode.id === checker).routing.selected_model, 'gpt-5.6-sol');
  const closed = fixture.cli([
    'workstream', 'terminal',
    '--id', workstream.id,
    '--status', 'ready',
    '--proof', '{}',
  ]);
  assert.equal(closed.exit, 0, closed.stderr);
  const boundary = fixture.state().session_chain.sessions
    .find(session => session.run_id === fixture.runId).scope.terminal_event;

  const calls = [];
  let ownerEmitted = false;
  let acquiredChild = null;
  const runProcess = (entry, options = {}) => {
    calls.push({ entry, options });
    const writeProbe = parseWriteProbePrompt(entry.stdin);
    if (writeProbe) {
      mkdirSync(writeProbe.workspace, { recursive: true });
      writeFileSync(join(writeProbe.workspace, writeProbe.sentinel), writeProbe.nonce);
    }

    if (options.usageReceipt?.processKind === 'maker') {
      const lease = fixture.state().session_chain.lease;
      acquiredChild = lease.handoff_child_run_id;
      const acquired = acquireLease(fixture.root, fixture.runId, {
        owner: acquiredChild,
        expectGeneration: lease.generation,
        runtime: 'codex',
        now: Date.parse('2026-09-06T00:00:02.000Z'),
      });
      assert.equal(acquired.ok, true, JSON.stringify(acquired));
      const result = measured(CHILD_THREAD);
      return {
        ...result,
        usageReceipt: writeProcessUsageReceipt(options.usageReceipt, result.usage),
      };
    }

    if (options.usageReceipt) {
      const result = measured();
      return {
        ...result,
        usageReceipt: writeProcessUsageReceipt(options.usageReceipt, result.usage),
      };
    }

    assert.equal(ownerEmitted, false, 'only the original owner emits the boundary');
    ownerEmitted = true;
    const emitted = emitHandoff(fixture.root, fixture.runId, {
      boundaryEvent: boundary,
      reason: 'workstream-terminal',
      trigger: 'workstream-terminal',
      now: Date.parse('2026-09-06T00:00:01.000Z'),
      expect: { owner: fixture.runId, generation: 1 },
      env: {},
      headless: true,
      resumePolicy: 'headless',
      deepLoopRoot: DEEP_LOOP_ROOT,
    });
    assert.equal(emitted.ok, true, JSON.stringify(emitted));
    return measured(PARENT_THREAD);
  };

  let wallTick = 0;
  const result = await driveGoalRun({
    root: fixture.root,
    runId: fixture.runId,
    expect: { owner: fixture.runId, generation: 1 },
    timeoutMs: 120_000,
    tokenLimit: 500_000,
    maxTurns: 4,
    env: { ...process.env, CODEX_HOME: codexHome },
    deepLoopRoot: DEEP_LOOP_ROOT,
    profile: 'current',
    now: () => Date.parse('2026-09-06T00:00:03.000Z'),
    wallNow: () => wallTick++ * 5_000,
    lockWallNow: () => 0,
    preflight: () => ({
      ok: true,
      executable: approval.approval,
      codexHome: { canonical_path: codexHome },
      measured_usage: [],
    }),
    goalService: () => ({ ok: false, reason: 'test-stop-after-handoff' }),
    runProcess,
    revalidateExecutable: identity => identity,
    resolveCodexHome: () => ({ canonical_path: codexHome }),
  });

  assert.equal(ownerEmitted, true);
  assert.equal(typeof acquiredChild, 'string', JSON.stringify({
    result,
    calls: calls.map(call => ({
      captureProviderThreadId: call.entry.captureProviderThreadId,
      receiptKeys: Object.keys(call.options.usageReceipt || {}),
    })),
    lease: fixture.state().session_chain.lease,
  }));
  assert.equal(result.reason, 'test-stop-after-handoff');
  assert.equal(result.providerThreadId, CHILD_THREAD);
  const after = fixture.state();
  assert.equal(after.session_chain.lease.owner_run_id, acquiredChild);
  assert.equal(after.session_chain.lease.generation, 2);

  const ownerCalls = calls.filter(call => call.entry.captureProviderThreadId === true);
  assert.equal(ownerCalls.length, 2, 'one original owner and one handoff child are launched');
  assert.equal(ownerCalls[0].entry.argv.includes('--ephemeral'), false);
  assert.equal(ownerCalls[1].entry.argv.includes('--ephemeral'), false);
  const childModelAt = ownerCalls[1].entry.argv.indexOf('--model');
  assert.deepEqual(ownerCalls[1].entry.argv.slice(childModelAt, childModelAt + 2), ['--model', 'gpt-6-astra']);
  assert.equal(ownerCalls[1].entry.argv.includes('model_reasoning_effort="high"'), true);
  assert.equal(ownerCalls[1].options.processGroup, 'required');
  assert.equal(ownerCalls[1].options.captureRawJsonl, true);
  const handoffInvocations = result.invocations.filter(event => event.kind === 'handoff');
  assert.equal(handoffInvocations.length, 1);
  assert.equal(handoffInvocations[0].entry, ownerCalls[1].entry);
  assert.equal(handoffInvocations[0].result.providerThreadId, CHILD_THREAD);
  assert.equal(Buffer.isBuffer(handoffInvocations[0].result.rawJsonl), true);
  assert.equal(handoffInvocations[0].result.rawJsonlTruncated, false);
});
