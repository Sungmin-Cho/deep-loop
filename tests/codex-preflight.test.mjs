import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildCodexExecEntry } from '../scripts/lib/codex-runtime.mjs';
import { makeCodexPreflightReceipt } from '../scripts/lib/budget.mjs';
import {
  codexPreflightCacheKey,
  ensureCodexPreflight,
} from '../scripts/lib/codex-preflight.mjs';
import { resolveAuthenticatedCodexHome } from '../scripts/lib/runtime-executable.mjs';
import {
  createFakeCodexRunner,
  measuredUsage,
  parseWriteProbePrompt,
} from './fixtures/fake-codex-native.mjs';
import {
  canonicalRealpath,
  createDirectoryJunction,
  createFileSymlinkOrSkip,
} from './helpers/fs-fixtures.mjs';

const EXECUTABLE = Object.freeze({
  runtime: 'codex',
  canonical_path: '/opt/codex/bin/codex',
  sha256: 'a'.repeat(64),
  version: '0.144.1',
  platform: 'linux',
  arch: 'x64',
  source: 'human-explicit',
  package: null,
  authenticode: null,
});

const RESUME_SKILL = Object.freeze({
  canonical_path: '/repo/skills/deep-loop-resume/SKILL.md',
  sha256: 'b'.repeat(64),
  device: '1',
  inode: '2',
  size: '3',
  mtime_ns: '4',
});

const NONCE = '0123456789abcdef0123456789abcdef';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function executableIdentity(path, version = '0.144.1') {
  const canonicalPath = canonicalRealpath(path);
  return {
    runtime: 'codex',
    canonical_path: canonicalPath,
    sha256: sha256(readFileSync(canonicalPath)),
    version,
    platform: process.platform,
    arch: process.arch,
    source: 'human-explicit',
    package: null,
    authenticode: null,
  };
}

function cacheFiles(cacheDir) {
  return existsSync(cacheDir)
    ? readdirSync(cacheDir).filter((name) => name.endsWith('.json')).sort()
    : [];
}

function fileSymlinksAvailableOrSkip(testContext) {
  const root = mkdtempSync(join(tmpdir(), 'dl-codex-preflight-file-link-'));
  const target = join(root, 'target');
  const link = join(root, 'link');
  writeFileSync(target, 'probe');
  try {
    return createFileSymlinkOrSkip(testContext, target, link);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function harness({ readResult, writeResult, writeMode = 'exact' } = {}) {
  const projectRoot = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-codex-preflight-')));
  const runId = 'RUN-1';
  const runRoot = join(projectRoot, '.deep-loop', 'runs', runId);
  const preflightRoot = join(runRoot, 'preflight');
  const cacheDir = join(preflightRoot, 'cache');
  const accountingDir = join(preflightRoot, 'accounting');
  const processReceiptDir = join(preflightRoot, 'process-receipts');
  mkdirSync(runRoot, { recursive: true });

  const executable = join(projectRoot, 'fake-codex-native');
  writeFileSync(executable, 'fake native codex bytes');
  chmodSync(executable, 0o755);

  const deepLoopRoot = join(projectRoot, 'deep-loop-plugin');
  const resumeSkillPath = join(deepLoopRoot, 'skills', 'deep-loop-resume', 'SKILL.md');
  mkdirSync(dirname(resumeSkillPath), { recursive: true });
  writeFileSync(resumeSkillPath, '# exact maker resume skill\n');

  const codexHome = join(projectRoot, 'codex-home');
  mkdirSync(codexHome);
  const codexHomeIdentity = resolveAuthenticatedCodexHome({ path: codexHome });
  const statePath = join(runRoot, 'loop.json');
  const logPath = join(runRoot, 'event-log.jsonl');
  writeFileSync(statePath, '{"budget":{"spent":17,"tokens_spent":31}}\n');
  writeFileSync(logPath, '{"type":"existing-event"}\n');

  const runner = createFakeCodexRunner({
    readResult,
    writeResult,
    writeMode,
    outsideRoot: projectRoot,
  });
  let versionProbeCalls = 0;
  const settledReceipts = new Map();
  const settlementCalls = [];
  const settleAccountingReceipt = (receipt) => {
    settlementCalls.push(structuredClone(receipt));
    const prior = settledReceipts.get(receipt.receipt_id);
    if (prior) {
      assert.deepEqual(receipt, prior, 'a receipt id may never change payload');
      return { ok: true, recorded: false, reason: 'already-recorded' };
    }
    settledReceipts.set(receipt.receipt_id, structuredClone(receipt));
    return { ok: true, recorded: true, reason: 'recorded' };
  };
  const options = {
    projectRoot,
    runId,
    executableIdentity: executableIdentity(executable),
    deepLoopRoot,
    resumeSkillPath,
    codexHomeIdentity,
    sourceEnv: {
      PATH: '/usr/bin',
      HOME: '/home/fake',
      OPENAI_API_KEY: 'auth-material-must-not-persist',
      DEEP_LOOP_TEST_SECRET: 'environment-secret-must-not-persist',
    },
    owner: 'OWNER-1',
    generation: 7,
    model: 'gpt-5.4',
    effort: 'xhigh',
    timeoutMs: 1_234,
    nonceFactory: () => NONCE,
    runVersion: () => {
      versionProbeCalls += 1;
      return { status: 0, signal: null, stdout: 'codex-cli 0.144.1\n', stderr: '' };
    },
    runSync: runner.runSync,
    settleAccountingReceipt,
  };
  return {
    projectRoot,
    runId,
    runRoot,
    preflightRoot,
    cacheDir,
    accountingDir,
    processReceiptDir,
    executable,
    deepLoopRoot,
    resumeSkillPath,
    codexHome,
    codexHomeIdentity,
    statePath,
    logPath,
    runner,
    options,
    versionProbeCalls: () => versionProbeCalls,
    settlementCalls,
    settledReceipts,
    settleAccountingReceipt,
    call(overrides = {}) {
      return ensureCodexPreflight({ ...options, ...overrides });
    },
  };
}

function cacheKeyInput(projectRoot, prompt) {
  return {
    executableIdentity: EXECUTABLE,
    model: 'gpt-5.4',
    effort: 'xhigh',
    goalDriven: false,
    durableSchemaContract: 'loop-run.schema.json:0.3.0',
    usageParserContract: 'codex-jsonl-safe-integer-v1',
    resumeSkillIdentity: RESUME_SKILL,
    isolationProfile: {
      envPolicy: { inherit: 'core', explicitAllowlist: true },
      envBuilderContract: 'codex-runtime-sha256:a',
      preflightVerifierContract: 'codex-preflight-sha256:b',
      descriptor: buildCodexExecEntry({
        executable: EXECUTABLE.canonical_path,
        projectRoot,
        prompt,
        model: 'gpt-5.4',
        effort: 'xhigh',
      }),
    },
    normalize: { projectRoot, prompt },
  };
}

test('schema upgrades invalidate preflight cache and a legacy run can re-probe without rewriting state', () => {
  const h = harness();
  const before = readFileSync(h.statePath);
  const old = h.call({ durableSchemaContract: 'loop-run.schema.json:released-v04' });
  assert.equal(old.ok, true, JSON.stringify(old));
  assert.equal(h.runner.calls.length, 2);
  const upgraded = h.call({ durableSchemaContract: 'loop-run.schema.json:v04-and-v05' });
  assert.equal(upgraded.ok, true, JSON.stringify(upgraded));
  assert.equal(upgraded.cache_hit, false);
  assert.notEqual(upgraded.cache_key, old.cache_key);
  assert.equal(h.runner.calls.length, 4, 'both actual smoke paths run again for the new schema contract');
  const hit = h.call({ durableSchemaContract: 'loop-run.schema.json:v04-and-v05' });
  assert.equal(hit.cache_hit, true);
  assert.equal(h.runner.calls.length, 4);
  assert.deepEqual(readFileSync(h.statePath), before, 'preflight does not migrate or erase the existing state');
});

test('codexPreflightCacheKey is pure and normalizes only probe root and prompt churn', () => {
  const first = codexPreflightCacheKey(cacheKeyInput('/tmp/probe-a', 'write nonce-a'));
  const second = codexPreflightCacheKey(cacheKeyInput('/tmp/probe-b', 'write nonce-b'));

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
});

test('codexPreflightCacheKey changes for every security and compatibility contract input', () => {
  const base = cacheKeyInput('/tmp/probe-a', 'write nonce-a');
  const baseline = codexPreflightCacheKey(base);
  const cases = [
    ['executable hash', (value) => { value.executableIdentity.sha256 = 'c'.repeat(64); }],
    ['executable version', (value) => { value.executableIdentity.version = '0.145.0'; }],
    ['executable path', (value) => { value.executableIdentity.canonical_path = '/opt/codex/bin/codex-new'; }],
    ['model', (value) => { value.model = 'gpt-6'; }],
    ['effort', (value) => { value.effort = 'high'; }],
    ['goal mode', (value) => { value.goalDriven = true; }],
    ['durable schema', (value) => { value.durableSchemaContract = 'loop-run.schema.json:0.4.0'; }],
    ['isolation descriptor', (value) => { value.isolationProfile.descriptor.argv[2] = '--not-json'; }],
    ['environment policy', (value) => { value.isolationProfile.envPolicy.inherit = 'all'; }],
    ['environment builder contract', (value) => { value.isolationProfile.envBuilderContract = 'codex-runtime-sha256:changed'; }],
    ['preflight verifier contract', (value) => { value.isolationProfile.preflightVerifierContract = 'codex-preflight-sha256:changed'; }],
    ['usage parser', (value) => { value.usageParserContract = 'codex-jsonl-v2'; }],
    ['resume skill content', (value) => { value.resumeSkillIdentity.sha256 = 'd'.repeat(64); }],
    ['resume skill path', (value) => { value.resumeSkillIdentity.canonical_path = '/repo/other/SKILL.md'; }],
    ['resume skill identity', (value) => { value.resumeSkillIdentity.inode = '99'; }],
  ];

  for (const [label, mutate] of cases) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.notEqual(codexPreflightCacheKey(changed), baseline, label);
  }
  assert.deepEqual(base, cacheKeyInput('/tmp/probe-a', 'write nonce-a'), 'the pure key function must not mutate input');
});

test('goal-driven preflight accepts max and ultra while keeping both bounded smokes ephemeral', () => {
  for (const effort of ['max', 'ultra']) {
    const h = harness();
    const result = h.call({ goalDriven: true, effort });

    assert.equal(result.ok, true, `${effort}: ${JSON.stringify(result)}`);
    assert.equal(h.runner.calls.length, 2, effort);
    for (const call of h.runner.calls) {
      assert.equal(call.entry.argv[0], 'exec', effort);
      assert.equal(call.entry.argv[1], '--ephemeral', effort);
      assert.equal(call.entry.argv.includes(`model_reasoning_effort="${effort}"`), true, effort);
    }
  }
});

test('preflight cache identity separates goal mode at the same model and effort', () => {
  const h = harness();
  const legacy = h.call();
  const goal = h.call({ goalDriven: true });

  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  assert.equal(goal.ok, true, JSON.stringify(goal));
  assert.equal(goal.cache_hit, false);
  assert.notEqual(goal.cache_key, legacy.cache_key);
  assert.equal(h.runner.calls.length, 4, 'goal mode must run its own two-smoke preflight');
});

test('preflight rejects a non-boolean goal mode before any smoke', () => {
  const h = harness();
  const result = h.call({ goalDriven: 'true', effort: 'xhigh' });
  assert.deepEqual(result, {
    ok: false,
    reason: 'preflight-invalid',
    pause_mode: 'preserve',
    measured_usage: [],
  });
  assert.equal(h.runner.calls.length, 0);
});

test('default cache identity can be invalidated by exact environment-builder and preflight-verifier contracts', () => {
  for (const [field, changed] of [
    ['environmentBuilderContract', 'codex-runtime-sha256:changed'],
    ['preflightVerifierContract', 'codex-preflight-sha256:changed'],
  ]) {
    const h = harness();
    const first = h.call();
    assert.equal(first.ok, true, field);
    const second = h.call({ [field]: changed });
    assert.equal(second.ok, true, field);
    assert.equal(second.cache_hit, false, field);
    assert.notEqual(second.cache_key, first.cache_key, field);
    assert.equal(h.runner.calls.length, 4, field);
  }
});

test('cache miss runs distinct synchronous read-only and production-equivalent write smokes with separate usage', () => {
  const h = harness();
  const result = h.call();

  assert.equal(result?.then, undefined, 'ensureCodexPreflight must remain synchronous');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.cache_hit, false);
  assert.match(result.cache_key, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.measured_usage, [
    measuredUsage(2, 3).usage,
    measuredUsage(5, 7).usage,
  ]);
  assert.equal(result.accounting_settled, true);
  assert.equal(result.accounting_receipts.length, 2);
  assert.equal(h.settlementCalls.length, 2, 'both receipts settle before cache activation');
  assert.equal(h.runner.calls.length, 2);

  const [readCall, writeCall] = h.runner.calls;
  for (const call of h.runner.calls) {
    assert.equal(call.entry.bin, h.executable, 'the trusted native executable must be used directly');
    assert.equal(call.entry.shell, false);
    assert.equal(call.entry.usageOutputKind, 'codex-jsonl');
    assert.equal(call.options.timeoutMs, 1_234);
    assert.equal(typeof call.options.usageReceipt, 'object', 'each physical smoke owns its durable receipt');
    assert.equal(Object.hasOwn(call.entry.env, 'OPENAI_API_KEY'), false);
    assert.equal(Object.hasOwn(call.entry.env, 'DEEP_LOOP_TEST_SECRET'), false);
    assert.ok(call.entry.argv.includes('--strict-config'));
    assert.ok(call.entry.argv.includes('--ignore-user-config'));
    assert.ok(call.entry.argv.includes('--ignore-rules'));
    assert.ok(call.entry.argv.includes('approval_policy="never"'));
    assert.ok(call.entry.argv.includes('web_search="disabled"'));
    assert.ok(call.entry.argv.includes('sandbox_workspace_write.network_access=false'));
    assert.equal(
      call.entry.argv.some(value => typeof value === 'string' && value.startsWith('projects.')),
      false,
      'strict Codex config rejects project trust as a command-line override',
    );
  }
  const readReceiptDescriptor = readCall.options.usageReceipt;
  const writeReceiptDescriptor = writeCall.options.usageReceipt;
  const expectedReadReceipt = makeCodexPreflightReceipt({
    ...readReceiptDescriptor,
    usage: measuredUsage(2, 3).usage,
  });
  assert.deepEqual({ ...readReceiptDescriptor, journalPath: undefined }, {
    journalPath: undefined,
    root: h.projectRoot,
    runId: h.runId,
    cacheKey: result.cache_key,
    smokeKind: 'read',
    attemptId: NONCE,
    predecessorReceiptId: null,
    owner: 'OWNER-1',
    generation: 7,
  });
  assert.deepEqual({ ...writeReceiptDescriptor, journalPath: undefined }, {
    journalPath: undefined,
    root: h.projectRoot,
    runId: h.runId,
    cacheKey: result.cache_key,
    smokeKind: 'write',
    attemptId: NONCE,
    predecessorReceiptId: expectedReadReceipt.receipt_id,
    owner: 'OWNER-1',
    generation: 7,
  });
  for (const descriptor of [readReceiptDescriptor, writeReceiptDescriptor]) {
    assert.equal(dirname(descriptor.journalPath), h.processReceiptDir);
  }
  assert.notEqual(readReceiptDescriptor.journalPath, writeReceiptDescriptor.journalPath);
  const expectedWriteReceipt = makeCodexPreflightReceipt({
    ...writeReceiptDescriptor,
    usage: measuredUsage(5, 7).usage,
  });
  assert.equal(
    existsSync(readReceiptDescriptor.journalPath),
    false,
    'the active accounting record supersedes the raw read journal',
  );
  assert.equal(
    existsSync(writeReceiptDescriptor.journalPath),
    false,
    'the active accounting record supersedes the raw write journal',
  );
  const durableAccounting = JSON.parse(
    readFileSync(join(h.accountingDir, `${result.cache_key}.json`), 'utf8'),
  );
  assert.deepEqual(durableAccounting.receipts, [expectedReadReceipt, expectedWriteReceipt]);
  assert.deepEqual(result.accounting_receipts, [expectedReadReceipt.receipt_id, expectedWriteReceipt.receipt_id]);
  assert.equal(readCall.entry.argv[readCall.entry.argv.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(writeCall.entry.argv[writeCall.entry.argv.indexOf('--sandbox') + 1], 'workspace-write');

  const probe = parseWriteProbePrompt(writeCall.entry.stdin);
  assert.ok(probe);
  assert.equal(probe.workspace, writeCall.entry.cwd);
  assert.equal(probe.nonce, NONCE);
  assert.equal(probe.sentinel, 'sentinel');
  assert.equal(dirname(probe.workspace), h.preflightRoot);
  assert.ok(
    writeCall.entry.stdin.includes(JSON.stringify(h.resumeSkillPath)),
    'maker-write prompt must pin the exact JSON-quoted absolute resume skill path',
  );
  assert.deepEqual(writeCall.entry, {
    ...buildCodexExecEntry({
      executable: h.executable,
      projectRoot: probe.workspace,
      prompt: writeCall.entry.stdin,
      model: 'gpt-5.4',
      effort: 'xhigh',
    }),
    cwd: probe.workspace,
    env: writeCall.entry.env,
    usageOutputKind: 'codex-jsonl',
  }, 'the write smoke must use the production descriptor generator unchanged except root and prompt');
  assert.equal(existsSync(probe.workspace), false, 'successful probe workspace must be completely removed');
  assert.deepEqual(cacheFiles(h.cacheDir), [`${result.cache_key}.json`]);

  const hit = h.call();
  assert.equal(hit.ok, true, JSON.stringify(hit));
  assert.equal(hit.cache_hit, true);
  assert.equal(hit.accounting_settled, true);
  assert.deepEqual(hit.accounting_receipts, result.accounting_receipts);
  assert.deepEqual(hit.measured_usage, [], 'cached process usage must never be replayed');
  assert.equal(h.settlementCalls.length, 4, 'a hit must idempotently verify both durable receipts');
  assert.equal(h.runner.calls.length, 2, 'cache hit must not run either smoke again');
  assert.equal(
    h.versionProbeCalls(),
    8,
    'the executable must be checked initially, at each process, receipt-settlement/cache-activation boundary, and again on the hit',
  );
});

test('zero-receipt accounting interruption leaves only a provisional record and retry activates without rerunning', () => {
  const h = harness();
  let failures = 0;
  const interrupted = h.call({
    settleAccountingReceipt: () => {
      failures += 1;
      throw new Error('INJECTED_BEFORE_FIRST_RECEIPT');
    },
  });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.reason, 'preflight-accounting-failed');
  assert.equal(interrupted.accounting_settled, false);
  assert.equal(failures, 1);
  assert.deepEqual(cacheFiles(h.cacheDir), [], 'an unsettled provisional record is never active authority');
  assert.equal(readdirSync(h.accountingDir).filter(name => name.endsWith('.json')).length, 1);
  assert.equal(h.runner.calls.length, 2);

  const recovered = h.call();
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.cache_hit, true, 'recovery activates the already-proved capability');
  assert.equal(recovered.accounting_settled, true);
  assert.equal(h.runner.calls.length, 2, 'recovery must not replay either physical smoke');
  assert.deepEqual(cacheFiles(h.cacheDir), [`${recovered.cache_key}.json`]);
  assert.equal(h.settledReceipts.size, 2);
});

test('partial receipt accounting retry no-ops the first and settles only the missing second before activation', () => {
  const h = harness();
  let calls = 0;
  const interrupted = h.call({
    settleAccountingReceipt: (receipt) => {
      calls += 1;
      if (calls === 2) throw new Error('INJECTED_BEFORE_SECOND_RECEIPT');
      return h.settleAccountingReceipt(receipt);
    },
  });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.reason, 'preflight-accounting-failed');
  assert.equal(h.settledReceipts.size, 1);
  assert.deepEqual(cacheFiles(h.cacheDir), []);
  assert.equal(h.runner.calls.length, 2);

  const recovered = h.call();
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.cache_hit, true);
  assert.equal(h.runner.calls.length, 2);
  assert.equal(h.settledReceipts.size, 2);
  const ids = h.settlementCalls.map(receipt => receipt.receipt_id);
  assert.equal(ids.filter(id => id === ids[0]).length, 2, 'the first receipt is verified, not appended twice');
});

test('active cache without its exact durable accounting record fails closed before an empty hit', () => {
  for (const mode of ['missing', 'corrupt']) {
    const h = harness();
    const first = h.call();
    assert.equal(first.ok, true);
    const receiptPath = join(h.accountingDir, `${first.cache_key}.json`);
    if (mode === 'missing') rmSync(receiptPath);
    else writeFileSync(receiptPath, '{"contract":"forged"}\n');

    const result = h.call();
    assert.equal(result.ok, false, mode);
    assert.equal(result.reason, 'cache-invalid', mode);
    assert.deepEqual(result.measured_usage, [], mode);
    assert.equal(h.runner.calls.length, 2, `${mode}: no smoke may rerun behind an active cache`);
  }
});

test('a different valid provisional record racing the same cache key is never adopted or activated', () => {
  const h = harness();
  const first = h.call();
  assert.equal(first.ok, true);
  const accountingPath = join(h.accountingDir, `${first.cache_key}.json`);
  const cachePath = join(h.cacheDir, `${first.cache_key}.json`);
  const priorRecord = readFileSync(accountingPath);
  rmSync(accountingPath);
  rmSync(cachePath);

  const result = h.call({
    nonceFactory: () => 'f'.repeat(32),
    runSync: (entry, options) => {
      const output = h.runner.runSync(entry, options);
      if (h.runner.calls.length === 4) writeFileSync(accountingPath, priorRecord);
      return output;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'preflight-accounting-record-failed');
  assert.deepEqual(result.measured_usage, [measuredUsage(2, 3).usage, measuredUsage(5, 7).usage]);
  assert.equal(result.accounting_settled, true, 'known durable receipts settle even when cache publication loses its race');
  assert.deepEqual(
    result.accounting_receipts,
    h.runner.calls.slice(-2).map(call => call.options.usageReceipt).map((descriptor, index) => (
      makeCodexPreflightReceipt({
        ...descriptor,
        usage: index === 0 ? measuredUsage(2, 3).usage : measuredUsage(5, 7).usage,
      }).receipt_id
    )),
  );
  assert.deepEqual(readFileSync(accountingPath), priorRecord, 'the raced durable record is never overwritten');
  assert.equal(existsSync(cachePath), false, 'no active authority may bind the in-memory competing receipts');
});

test('write probe rejects missing, wrong, extra, and directory-escape sentinels', () => {
  const cases = [
    ['missing', 'sentinel-missing'],
    ['wrong', 'sentinel-wrong-bytes'],
    ['extra', 'sentinel-extra-artifact'],
    ['escape', 'sentinel-containment-escape'],
  ];

  for (const [writeMode, reason] of cases) {
    const h = harness({ writeMode });
    const result = h.call();
    assert.equal(result.ok, false, writeMode);
    assert.equal(result.reason, reason, writeMode);
    assert.deepEqual(result.measured_usage, [
      measuredUsage(2, 3).usage,
      measuredUsage(5, 7).usage,
    ], writeMode);
    assert.deepEqual(cacheFiles(h.cacheDir), [], `${writeMode}: no failure may create a cache record`);
    if (existsSync(h.preflightRoot)) {
      assert.equal(
        readdirSync(h.preflightRoot).some((name) => name.startsWith('probe-')),
        false,
        `${writeMode}: failed workspaces must still be removed`,
      );
    }
  }
});

test('write probe rejects a file-symlink sentinel when file links are supported', (t) => {
  if (!fileSymlinksAvailableOrSkip(t)) return;
  const h = harness({ writeMode: 'symlink' });
  const result = h.call();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sentinel-symlink');
  assert.deepEqual(result.measured_usage, [
    measuredUsage(2, 3).usage,
    measuredUsage(5, 7).usage,
  ]);
  assert.deepEqual(cacheFiles(h.cacheDir), []);
  if (existsSync(h.preflightRoot)) {
    assert.equal(readdirSync(h.preflightRoot).some((name) => name.startsWith('probe-')), false);
  }
});

test('a measured write turn that refuses or prompts and creates no sentinel fails by absent sentinel', () => {
  const h = harness({ writeMode: 'missing' });
  const result = h.call();

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sentinel-missing');
  assert.deepEqual(result.measured_usage, [measuredUsage(2, 3).usage, measuredUsage(5, 7).usage]);
  assert.equal(Object.hasOwn(result, 'final_message'), false, 'streaming protocol does not expose textual refusal output');
  assert.deepEqual(cacheFiles(h.cacheDir), []);
});

test('incomplete probe cleanup fails closed after preserving both measured turns', () => {
  const h = harness();
  const result = h.call({
    removeWorkspace: () => {
      throw Object.assign(new Error('simulated sharing violation'), { code: 'EBUSY' });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cleanup-failed');
  assert.deepEqual(result.measured_usage, [measuredUsage(2, 3).usage, measuredUsage(5, 7).usage]);
  assert.deepEqual(cacheFiles(h.cacheDir), []);
});

test('machine and JSONL failures preserve stable smoke reasons and only prior measured usage', () => {
  const cases = [
    ['read timeout', { readResult: { ok: false, reason: 'timeout' } }, 'read-smoke:timeout', []],
    ['read non-zero', { readResult: { ok: false, reason: 'exit-7' } }, 'read-smoke:exit-7', []],
    ['read malformed JSONL', { readResult: { ok: false, reason: 'codex-malformed-json' } }, 'read-smoke:codex-malformed-json', []],
    ['read unmeasured JSONL', { readResult: { ok: false, reason: 'codex-invalid-usage' } }, 'read-smoke:codex-invalid-usage', []],
    ['hostile worker output', { readResult: { ok: false, reason: 'worker-protocol-invalid' } }, 'read-smoke:worker-protocol-invalid', []],
    ['write timeout', { writeResult: { ok: false, reason: 'timeout' } }, 'write-smoke:timeout', [measuredUsage(2, 3).usage]],
    ['write non-zero', { writeResult: { ok: false, reason: 'exit-9' } }, 'write-smoke:exit-9', [measuredUsage(2, 3).usage]],
    ['write malformed JSONL', { writeResult: { ok: false, reason: 'codex-malformed-json' } }, 'write-smoke:codex-malformed-json', [measuredUsage(2, 3).usage]],
    ['write unmeasured JSONL', { writeResult: { ok: false, reason: 'codex-invalid-usage' } }, 'write-smoke:codex-invalid-usage', [measuredUsage(2, 3).usage]],
  ];

  for (const [label, setup, reason, usage] of cases) {
    const h = harness(setup);
    const result = h.call();
    assert.equal(result.ok, false, label);
    assert.equal(result.reason, reason, label);
    assert.deepEqual(result.measured_usage, usage, label);
    assert.deepEqual(cacheFiles(h.cacheDir), [], label);
  }
});

test('invalid process bounds fail before cache authority or either smoke', () => {
  const h = harness();
  assert.equal(h.call().ok, true);
  for (const timeoutMs of [-1, 1.5, Number.MAX_SAFE_INTEGER, NaN]) {
    const result = h.call({ timeoutMs });
    assert.equal(result.ok, false, String(timeoutMs));
    assert.equal(result.reason, 'preflight-invalid', String(timeoutMs));
    assert.deepEqual(result.measured_usage, [], String(timeoutMs));
    assert.equal(h.runner.calls.length, 2, `${timeoutMs}: invalid bound must precede cache authority and spawn`);
  }
});

test('nonce generation failure returns a stable fail-closed result before either smoke', () => {
  const h = harness();
  const result = h.call({
    nonceFactory: () => {
      throw new Error('entropy unavailable');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'preflight-invalid');
  assert.deepEqual(result.measured_usage, []);
  assert.equal(h.runner.calls.length, 0);
});

test('ok:true runner output is not measured unless it is exactly one safe Codex turn', () => {
  const invalid = {
    ok: true,
    usage: { num_turns: 2, tokens: 3, input_tokens: 1, output_tokens: 2 },
  };
  const read = harness({ readResult: invalid });
  let result = read.call();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'read-smoke:usage-receipt-write-failed');
  assert.deepEqual(result.measured_usage, []);
  assert.deepEqual(cacheFiles(read.cacheDir), []);

  const write = harness({ writeResult: {
    ok: true,
    usage: {
      num_turns: 1,
      tokens: Number.MAX_SAFE_INTEGER + 1,
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 1,
    },
  } });
  result = write.call();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'write-smoke:usage-receipt-write-failed');
  assert.deepEqual(result.measured_usage, [measuredUsage(2, 3).usage]);
  assert.deepEqual(cacheFiles(write.cacheDir), []);
});

test('corrupt cache fails cache-invalid without rerun, deletion, or overwrite', () => {
  const h = harness();
  const first = h.call();
  assert.equal(first.ok, true, JSON.stringify(first));
  const cachePath = join(h.cacheDir, `${first.cache_key}.json`);
  const corrupt = '{"kind":"forged-success"}\n';
  writeFileSync(cachePath, corrupt);

  const result = h.call();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cache-invalid');
  assert.deepEqual(result.measured_usage, []);
  assert.equal(h.runner.calls.length, 2, 'corrupt cache must not trigger either smoke');
  assert.equal(readFileSync(cachePath, 'utf8'), corrupt, 'corrupt authority must not be repaired or overwritten');
});

test('symlinked cache file fails cache-invalid even when its target contains valid bytes', (t) => {
  const h = harness();
  const first = h.call();
  const cachePath = join(h.cacheDir, `${first.cache_key}.json`);
  const outside = join(h.projectRoot, 'outside-cache.json');
  writeFileSync(outside, readFileSync(cachePath));
  rmSync(cachePath);
  if (!createFileSymlinkOrSkip(t, outside, cachePath)) return;

  const result = h.call();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cache-invalid');
  assert.equal(h.runner.calls.length, 2);
  assert.equal(existsSync(outside), true);
});

test('symlinked cache directory and escaped preflight directory are never cache authority', () => {
  for (const attack of ['cache-directory-symlink', 'preflight-escape']) {
    const h = harness();
    const first = h.call();
    assert.equal(first.ok, true, attack);
    if (attack === 'cache-directory-symlink') {
      const outside = join(h.projectRoot, 'outside-cache-directory');
      renameSync(h.cacheDir, outside);
      createDirectoryJunction(outside, h.cacheDir);
    } else {
      const outside = join(h.projectRoot, 'outside-preflight-directory');
      renameSync(h.preflightRoot, outside);
      createDirectoryJunction(outside, h.preflightRoot);
    }

    const result = h.call();
    assert.equal(result.ok, false, attack);
    assert.equal(result.reason, 'cache-invalid', attack);
    assert.deepEqual(result.measured_usage, [], attack);
    assert.equal(h.runner.calls.length, 2, `${attack}: no process may rerun`);
  }
});

test('resume skill must be absolute, readable, contained, regular, and non-symlinked before any smoke', () => {
  const relative = harness();
  let result = relative.call({ resumeSkillPath: 'skills/deep-loop-resume/SKILL.md' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'resume-skill-invalid');
  assert.equal(relative.runner.calls.length, 0);

  const escaped = harness();
  const outside = join(escaped.projectRoot, 'outside-resume-skill.md');
  writeFileSync(outside, '# outside\n');
  result = escaped.call({ resumeSkillPath: outside });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'resume-skill-invalid');
  assert.equal(escaped.runner.calls.length, 0);

  const unreadable = harness();
  result = unreadable.call({
    inspectResumeSkill: () => {
      throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'resume-skill-invalid');
  assert.equal(unreadable.runner.calls.length, 0);
});

test('cache hit revalidation fails closed on executable drift and unreadable resume skill', () => {
  const executableDrift = harness();
  assert.equal(executableDrift.call().ok, true);
  writeFileSync(executableDrift.executable, 'replaced executable bytes');
  let result = executableDrift.call();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'executable-invalid');
  assert.deepEqual(result.measured_usage, []);
  assert.equal(executableDrift.runner.calls.length, 2);

  const unreadableHit = harness();
  assert.equal(unreadableHit.call().ok, true);
  result = unreadableHit.call({
    inspectResumeSkill: () => {
      throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'resume-skill-invalid');
  assert.deepEqual(result.measured_usage, []);
  assert.equal(unreadableHit.runner.calls.length, 2);
});

test('cache hit revalidation rejects a resume skill replaced by a file symlink', (t) => {
  const skillDrift = harness();
  assert.equal(skillDrift.call().ok, true);
  const replacementTarget = `${skillDrift.resumeSkillPath}.replacement`;
  renameSync(skillDrift.resumeSkillPath, replacementTarget);
  if (!createFileSymlinkOrSkip(t, replacementTarget, skillDrift.resumeSkillPath)) return;

  const result = skillDrift.call();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'resume-skill-invalid');
  assert.deepEqual(result.measured_usage, []);
  assert.equal(skillDrift.runner.calls.length, 2);
});

test('stored executable platform and architecture are checked against the actual host before any smoke', () => {
  const cases = [
    ['platform', process.platform === 'win32' ? 'linux' : 'win32', process.arch],
    ['architecture', process.platform, process.arch === 'arm64' ? 'x64' : 'arm64'],
  ];
  for (const [label, platform, arch] of cases) {
    const h = harness();
    const result = h.call({
      executableIdentity: { ...h.options.executableIdentity, platform, arch },
    });
    assert.equal(result.ok, false, label);
    assert.equal(result.reason, 'executable-invalid', label);
    assert.deepEqual(result.measured_usage, [], label);
    assert.equal(h.runner.calls.length, 0, label);
  }
});

test('security identities are revalidated between smokes before the maker process can run', () => {
  const cases = [
    ['executable-invalid', (h) => writeFileSync(h.executable, 'between-smoke executable replacement')],
    ['resume-skill-invalid', (h) => writeFileSync(h.resumeSkillPath, '# between-smoke skill replacement\n')],
    ['codex-home-invalid', (h) => {
      renameSync(h.codexHome, `${h.codexHome}.between-smoke-old`);
      mkdirSync(h.codexHome);
    }],
  ];

  for (const [reason, mutate] of cases) {
    const h = harness();
    const result = h.call({
      runSync: (entry, options) => {
        const out = h.runner.runSync(entry, options);
        if (h.runner.calls.length === 1) mutate(h);
        return out;
      },
    });
    assert.equal(result.ok, false, reason);
    assert.equal(result.reason, reason, reason);
    assert.deepEqual(result.measured_usage, [measuredUsage(2, 3).usage], reason);
    assert.equal(h.runner.calls.length, 1, `${reason}: stale identity must block maker spawn`);
    assert.deepEqual(cacheFiles(h.cacheDir), [], reason);
  }
});

test('executable drift after the write smoke is detected before cache publication and after cleanup', () => {
  const h = harness();
  const result = h.call({
    runSync: (entry, options) => {
      const out = h.runner.runSync(entry, options);
      if (h.runner.calls.length === 2) writeFileSync(h.executable, 'post-write executable replacement');
      return out;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'executable-invalid');
  assert.deepEqual(result.measured_usage, [measuredUsage(2, 3).usage, measuredUsage(5, 7).usage]);
  assert.equal(h.runner.calls.length, 2);
  assert.deepEqual(cacheFiles(h.cacheDir), []);
  assert.equal(
    readdirSync(h.preflightRoot).some((name) => name.startsWith('probe-')),
    false,
    'the verified workspace must be removed before a post-write identity failure returns',
  );
});

test('preflight parent replacement during the read smoke is rejected before any workspace path write', () => {
  const h = harness();
  const redirected = join(h.projectRoot, 'redirected-preflight');
  mkdirSync(redirected);
  let cleanupCalls = 0;
  const result = h.call({
    runSync: (entry, options) => {
      const out = h.runner.runSync(entry, options);
      if (h.runner.calls.length === 1) {
        renameSync(h.preflightRoot, join(h.projectRoot, 'original-preflight'));
        createDirectoryJunction(redirected, h.preflightRoot);
      }
      return out;
    },
    removeWorkspace: (path) => {
      cleanupCalls += 1;
      rmSync(path, { recursive: true, force: true });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cache-invalid');
  assert.deepEqual(result.measured_usage, [measuredUsage(2, 3).usage]);
  assert.equal(h.runner.calls.length, 1);
  assert.equal(cleanupCalls, 0, 'no workspace path may be created through the replaced parent');
  assert.deepEqual(readdirSync(redirected), []);
});

test('authenticated CODEX_HOME identity is revalidated before cache authority or a process spawn', () => {
  const beforeMiss = harness();
  renameSync(beforeMiss.codexHome, `${beforeMiss.codexHome}.old`);
  mkdirSync(beforeMiss.codexHome);
  let result = beforeMiss.call();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex-home-invalid');
  assert.deepEqual(result.measured_usage, []);
  assert.equal(beforeMiss.runner.calls.length, 0);

  const beforeHit = harness();
  assert.equal(beforeHit.call().ok, true);
  renameSync(beforeHit.codexHome, `${beforeHit.codexHome}.old`);
  mkdirSync(beforeHit.codexHome);
  result = beforeHit.call();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex-home-invalid');
  assert.deepEqual(result.measured_usage, []);
  assert.equal(beforeHit.runner.calls.length, 2, 'swapped auth home must be rejected before cached authority');
});

test('stable resume-skill content change invalidates the key and requires two fresh smokes', () => {
  const h = harness();
  const first = h.call();
  assert.equal(first.ok, true, JSON.stringify(first));
  writeFileSync(h.resumeSkillPath, '# exact maker resume skill v2\n');

  const second = h.call();
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.cache_hit, false);
  assert.notEqual(second.cache_key, first.cache_key);
  assert.equal(h.runner.calls.length, 4);
  assert.deepEqual(cacheFiles(h.cacheDir), [`${first.cache_key}.json`, `${second.cache_key}.json`].sort());
});

test('cache bytes exclude prompts, authentication material, environment secrets, and per-run usage', () => {
  const h = harness();
  const stateBefore = readFileSync(h.statePath);
  const logBefore = readFileSync(h.logPath);
  const result = h.call();
  assert.equal(result.ok, true, JSON.stringify(result));

  const raw = readFileSync(join(h.cacheDir, `${result.cache_key}.json`), 'utf8');
  for (const forbidden of [
    ...h.runner.calls.map((call) => call.entry.stdin),
    NONCE,
    'auth-material-must-not-persist',
    'environment-secret-must-not-persist',
    h.codexHome,
    'OPENAI_API_KEY',
    'DEEP_LOOP_TEST_SECRET',
    'measured_usage',
    'input_tokens',
    'output_tokens',
    'num_turns',
    '"usage"',
    '"stdin"',
  ]) {
    assert.equal(raw.includes(forbidden), false, `cache leaked ${JSON.stringify(forbidden)}`);
  }
  assert.deepEqual(readFileSync(h.statePath), stateBefore, 'preflight must not mutate loop state or budget');
  assert.deepEqual(readFileSync(h.logPath), logBefore, 'preflight must not append budget or event-log entries');
});

test('failed preflight also leaves loop state, event log, and budget bytes untouched', () => {
  const h = harness({ writeResult: { ok: false, reason: 'timeout' } });
  const stateBefore = readFileSync(h.statePath);
  const logBefore = readFileSync(h.logPath);

  const result = h.call();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'write-smoke:timeout');
  assert.deepEqual(readFileSync(h.statePath), stateBefore);
  assert.deepEqual(readFileSync(h.logPath), logBefore);
  assert.deepEqual(cacheFiles(h.cacheDir), []);
});

test('every failure category carries the explicit preserve-pause contract for Task 2.6', () => {
  const invalid = harness();
  const machine = harness({ readResult: { ok: false, reason: 'timeout' } });
  const artifact = harness({ writeMode: 'missing' });
  const results = [
    invalid.call({ timeoutMs: -1 }),
    machine.call(),
    artifact.call(),
  ];

  for (const result of results) {
    assert.equal(result.ok, false);
    assert.equal(result.pause_mode, 'preserve');
    assert.equal(typeof result.reason, 'string');
    assert.ok(Array.isArray(result.measured_usage));
  }
});
