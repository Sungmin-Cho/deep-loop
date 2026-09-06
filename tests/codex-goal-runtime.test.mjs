import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexExecEntry,
  buildCodexGoalOwnerEntry,
} from '../scripts/lib/codex-runtime.mjs';

const BIN = '/opt/codex/bin/codex';
const ROOT = '/tmp/goal owner/repo';
const PROMPT = 'Continue the exact bounded owner turn.';
const THREAD_ID = '019d1234-5678-7abc-8def-0123456789ab';

test('goal owner initial entry is persistent and opts into explicit strict isolation', () => {
  const entry = buildCodexGoalOwnerEntry({
    executable: BIN,
    projectRoot: ROOT,
    prompt: PROMPT,
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    isolationProfile: 'strict',
  });

  assert.equal(entry.bin, BIN);
  assert.equal(entry.stdin, PROMPT);
  assert.equal(entry.shell, false);
  assert.equal(entry.captureProviderThreadId, true);
  assert.deepEqual(entry.argv.slice(0, 2), ['exec', '--json']);
  assert.equal(entry.argv.includes('--ephemeral'), false);
  assert.equal(entry.argv.includes('resume'), false);
  assert.equal(entry.argv.includes('--last'), false);
  assert.deepEqual(entry.argv.slice(entry.argv.indexOf('--model'), entry.argv.indexOf('--model') + 2), [
    '--model', 'gpt-5.6-sol',
  ]);
  assert.equal(entry.argv.includes('model_reasoning_effort="ultra"'), true);
  assert.equal(entry.argv.includes('--ignore-user-config'), true);
  assert.equal(entry.argv.includes('--ignore-rules'), true);
  for (const feature of ['hooks', 'memories', 'multi_agent']) {
    const disableAt = entry.argv.findIndex((value, index) => value === '--disable' && entry.argv[index + 1] === feature);
    assert.ok(disableAt > 0, `${feature} must be explicitly disabled`);
  }
  assert.ok(entry.argv.findIndex((value, index) => (
    value === '--enable' && entry.argv[index + 1] === 'skip_host_skill_discovery'
  )) > 0);
  assert.equal(entry.argv.includes('project_doc_max_bytes=0'), true);
  assert.equal(entry.argv.at(-1), '-');
});

test('goal owner resume places parent options before resume and binds one exact provider UUID', () => {
  for (const effort of ['max', 'ultra']) {
    const entry = buildCodexGoalOwnerEntry({
      executable: BIN,
      projectRoot: ROOT,
      prompt: PROMPT,
      model: 'gpt-5.6-sol',
      effort,
      providerThreadId: THREAD_ID,
      isolationProfile: 'strict',
    });
    const resumeAt = entry.argv.indexOf('resume');
    const rootAt = entry.argv.indexOf('-C');
    const sandboxAt = entry.argv.indexOf('--sandbox');
    const effortAt = entry.argv.indexOf(`model_reasoning_effort="${effort}"`);

    assert.ok(resumeAt > 0);
    assert.ok(rootAt > 0 && rootAt < resumeAt, '-C is a parent exec option');
    assert.ok(sandboxAt > 0 && sandboxAt < resumeAt, '--sandbox is a parent exec option');
    assert.ok(effortAt > 0 && effortAt < resumeAt, 'effort is pinned before resume');
    assert.deepEqual(entry.argv.slice(resumeAt), ['resume', THREAD_ID, '-']);
    assert.equal(entry.argv.includes('--last'), false);
    assert.equal(entry.argv.includes('--ephemeral'), false);
  }
});

test('goal owner rejects missing or non-UUID resume bindings without selecting a latest thread', () => {
  for (const providerThreadId of ['', 'thread-1', '--last', '019d1234-5678-7abc-8def-0123456789ag']) {
    assert.throws(
      () => buildCodexGoalOwnerEntry({
        executable: BIN,
        projectRoot: ROOT,
        prompt: PROMPT,
        providerThreadId,
        isolationProfile: 'strict',
      }),
      /INVALID_CODEX_PROVIDER_THREAD_ID/,
      JSON.stringify(providerThreadId),
    );
  }
});

test('legacy Codex entry stays ephemeral and continues rejecting goal-only effort levels', () => {
  const legacy = buildCodexExecEntry({ executable: BIN, projectRoot: ROOT, prompt: PROMPT });
  assert.equal(legacy.argv[0], 'exec');
  assert.equal(legacy.argv[1], '--ephemeral');
  assert.equal(Object.hasOwn(legacy, 'captureProviderThreadId'), false);
  assert.throws(
    () => buildCodexExecEntry({ executable: BIN, projectRoot: ROOT, prompt: PROMPT, effort: 'max' }),
    /UNSUPPORTED_RUNTIME_EFFORT/,
  );
  for (const effort of ['max', 'ultra']) {
    const checker = buildCodexExecEntry({
      executable: BIN,
      projectRoot: ROOT,
      prompt: PROMPT,
      effort,
      goalDriven: true,
    });
    assert.equal(checker.argv[1], '--ephemeral');
    assert.equal(checker.argv.includes(`model_reasoning_effort="${effort}"`), true);
  }
  assert.throws(
    () => buildCodexExecEntry({
      executable: BIN,
      projectRoot: ROOT,
      prompt: PROMPT,
      effort: 'max',
      goalDriven: 'yes',
    }),
    /INVALID_CODEX_GOAL_MODE/,
  );
  assert.throws(
    () => buildCodexGoalOwnerEntry({
      executable: BIN,
      projectRoot: ROOT,
      prompt: PROMPT,
      isolationProfile: 'ambient',
    }),
    /INVALID_CODEX_ISOLATION_PROFILE/,
  );
});
