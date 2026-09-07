import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, wrap } from '../scripts/lib/envelope.mjs';

async function descriptorModule() {
  try {
    return await import('../scripts/lib/runtime-descriptor.mjs');
  } catch (error) {
    assert.fail(`runtime descriptor module must load: ${error?.code || error}`);
  }
}

const base = {
  root: '/repo with space',
  platform: 'linux',
  parentRunId: '01PARENT',
  childRunId: '01CHILD',
  handoffRel: 'handoffs/next.md',
};

test('launch metadata validator accepts only the exact M3 boundary envelope and payload', async () => {
  const { validateLaunchCommandMetadata } = await descriptorModule();
  assert.equal(typeof validateLaunchCommandMetadata, 'function');
  const launchBytes = Buffer.from('launch\n');
  const boundaryEvent = { seq: 7, checksum: 'a'.repeat(64) };
  const expected = {
    launchBytes,
    parentRunId: base.parentRunId,
    childRunId: base.childRunId,
    handoffRel: base.handoffRel,
    projectRootDigest: 'b'.repeat(64),
    projectBindingGeneration: 3,
    boundaryEvent,
    generatedAt: '2026-07-23T01:02:03.004Z',
  };
  const metadata = wrap({
    producer: 'deep-loop',
    artifact_kind: 'launch-command-meta',
    schema: { name: 'launch-command-meta', version: '1.0' },
    run_id: base.childRunId,
    parent_run_id: base.parentRunId,
    provenance: { source_artifacts: [base.handoffRel], tool_versions: {} },
    payload: {
      launch_command_sha256: contentHash(launchBytes),
      parent_run_id: base.parentRunId,
      child_run_id: base.childRunId,
      handoff_phase: 'emitted',
      boundary_event: boundaryEvent,
      handoff_rel: base.handoffRel,
      project_root_digest: expected.projectRootDigest,
      project_binding_generation: expected.projectBindingGeneration,
    },
    now: expected.generatedAt,
  });
  assert.equal(validateLaunchCommandMetadata(metadata, expected)?.payload.child_run_id, base.childRunId);

  const mutations = [
    value => { value.extra = true; },
    value => { value.schema_version = '0.9'; },
    value => { value.envelope.extra = true; },
    value => { value.envelope.schema.version = '9.9'; },
    value => { value.envelope.run_id = base.parentRunId; },
    value => { value.envelope.parent_run_id = base.childRunId; },
    value => { value.envelope.generated_at = '2026-07-23T01:02:03Z'; },
    value => { value.envelope.git.extra = true; },
    value => { value.envelope.provenance.extra = true; },
    value => { value.payload.extra = true; },
    value => { value.payload.boundary_event.extra = true; },
  ];
  for (const mutate of mutations) {
    const forged = structuredClone(metadata);
    mutate(forged);
    assert.equal(validateLaunchCommandMetadata(forged, expected), null);
  }
});

test('runtime helpers select the host-native resume token and usage output kind', async () => {
  const { resumeSkillToken, usageOutputKind } = await descriptorModule();
  assert.equal(resumeSkillToken('claude'), '/deep-loop-resume');
  assert.equal(usageOutputKind('claude'), 'claude-json');
  assert.equal(resumeSkillToken('codex'), '$deep-loop:deep-loop-resume');
  assert.equal(usageOutputKind('codex'), 'codex-jsonl');
});

test('recovery descriptor emits only the exact affinity or boundary acquisition route', async () => {
  const { buildRecoveryResumeDescriptor } = await descriptorModule();
  const common = {
    root: '/repo with space',
    runId: '01PARENT',
    childRunId: 'RECOVERY-CHILD',
    recoveryRel: 'recoveries/RECOVERY-CHILD.json',
    generation: 4,
  };
  assert.equal(buildRecoveryResumeDescriptor({
    ...common,
    kind: 'affinity-supersession',
    runtime: 'codex',
  }).acquireInvocation,
  'recovery acquire --capsule "recoveries/RECOVERY-CHILD.json"'
    + ' --owner "RECOVERY-CHILD" --generation 4 --runtime codex'
    + ' --project-root "/repo with space" --run-id "01PARENT"');
  assert.equal(buildRecoveryResumeDescriptor({
    ...common,
    kind: 'boundary-recovery',
    runtime: 'claude',
  }).acquireInvocation,
  'lease acquire --owner "RECOVERY-CHILD" --generation 4 --runtime claude'
    + ' --project-root "/repo with space" --run-id "01PARENT"');
  for (const overrides of [
    { kind: 'boundary-handoff' },
    { recoveryRel: '../capsule.json' },
    { generation: 0 },
    { childRunId: 'bad child' },
  ]) {
    assert.throws(() => buildRecoveryResumeDescriptor({
      ...common,
      kind: 'affinity-supersession',
      runtime: 'claude',
      ...overrides,
    }), /RECOVERY_DESCRIPTOR_INVALID/);
  }
});

test('runtime descriptor freezes a minimal root/run/runtime contract', async () => {
  const { buildRuntimeResumeDescriptor } = await descriptorModule();
  const descriptor = buildRuntimeResumeDescriptor({ ...base, runtime: 'codex' });
  assert.deepEqual({
    runtime: descriptor.runtime,
    projectRoot: descriptor.projectRoot,
    runId: descriptor.runId,
    childRunId: descriptor.childRunId,
    handoffRel: descriptor.handoffRel,
    resumeSkillToken: descriptor.resumeSkillToken,
    usageOutputKind: descriptor.usageOutputKind,
  }, {
    runtime: 'codex',
    projectRoot: base.root,
    runId: base.parentRunId,
    childRunId: base.childRunId,
    handoffRel: base.handoffRel,
    resumeSkillToken: '$deep-loop:deep-loop-resume',
    usageOutputKind: 'codex-jsonl',
  });
  assert.ok(descriptor.resumePrompt.includes(base.root));
  assert.ok(descriptor.resumePrompt.includes(base.parentRunId));
  assert.ok(descriptor.resumePrompt.includes('$deep-loop:deep-loop-resume'));
});

test('legacy/default launch command remains byte-compatible with explicit Claude runtime', async () => {
  const { buildLaunchCommand, buildRuntimeResumeDescriptor } = await descriptorModule();
  const legacy = buildLaunchCommand(base);
  const explicit = buildLaunchCommand({ ...base, runtime: 'claude' });
  assert.deepEqual(legacy, explicit);
  assert.deepEqual(explicit, buildRuntimeResumeDescriptor({ ...base, runtime: 'claude' }).entries);
  assert.equal(explicit.headless.bin, 'claude');
  assert.equal(explicit.headless.usageOutputKind, 'claude-json');
  assert.deepEqual(explicit.headless.argv, [
    '-p',
    'Read .deep-loop/runs/01PARENT/handoffs/next.md first; then run /deep-loop-resume',
    '--output-format', 'json', '--permission-mode', 'acceptEdits',
  ]);
});

test('Codex Slice 1 descriptor is manual/fail-closed and never emits Claude transport flags', async () => {
  const { buildRuntimeResumeDescriptor } = await descriptorModule();
  const descriptor = buildRuntimeResumeDescriptor({
    ...base,
    runtime: 'codex',
    model: 'claude-opus-4-8[1m]',
    effort: 'xhigh',
  });
  const unavailable = ['cmux', 'iterm2', 'terminal-app', 'wt', 'powershell', 'headless'];
  for (const name of unavailable) {
    assert.equal(descriptor.entries[name].unavailable, true, name);
    assert.equal(descriptor.entries[name].reason, 'codex-transport-not-activated', name);
    assert.equal(descriptor.entries[name].bin, undefined, name);
  }
  assert.equal(descriptor.entries.interactive.manual, true);
  assert.match(descriptor.entries.interactive.display, /\$deep-loop:deep-loop-resume/);
  assert.match(descriptor.entries.interactive.display, /01PARENT/);

  const app = descriptor.entries.desktop;
  assert.equal(app.manual, true);
  assert.equal(app.unavailable, true);
  assert.equal(app.reason, 'codex-transport-not-activated');
  assert.match(app.display, /Codex App/);
  assert.match(app.display, /\$deep-loop:deep-loop-resume/);
  assert.equal(app.bin, undefined);
  assert.equal(app.argv, undefined);

  const serialized = JSON.stringify(descriptor);
  assert.ok(!serialized.includes('claude://'), 'Codex App descriptor must not invent a private URL');
  assert.ok(!serialized.includes('--model'), 'Claude --model flag must not leak into Codex output');
  assert.ok(!serialized.includes('--effort'), 'Claude --effort flag must not leak into Codex output');
  assert.ok(!serialized.includes('"bin":"claude"'), 'Codex must not route through the Claude process');
});

test('Windows Codex headless uses a fully-qualified native executable when identity is host-supplied', async () => {
  const { buildLaunchCommand } = await descriptorModule();
  const executable = 'C:\\Program Files\\Codex\\codex.exe';
  const cmds = buildLaunchCommand({
    runtime: 'codex',
    root: 'C:\\Fixture Project',
    parentRunId: '01PARENT',
    childRunId: '01CHILD',
    handoffRel: 'handoffs/next.md',
    platform: 'win32',
    codexExecutable: executable,
    deepLoopRoot: 'C:\\Fixture Deep Loop',
  });
  assert.equal(cmds.headless.unavailable, undefined);
  assert.equal(cmds.headless.bin, executable);
  assert.equal(cmds.headless.shell, false);
  assert.equal(cmds.headless.platform, 'win32');
  assert.equal(cmds.wt.unavailable, true);
  assert.equal(cmds.powershell.unavailable, true);
});
