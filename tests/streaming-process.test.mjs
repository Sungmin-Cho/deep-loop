import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STREAM_LIMITS } from '../scripts/lib/usage-parser.mjs';
import { makeCodexPreflightReceipt } from '../scripts/lib/budget.mjs';
import { canonicalRealpath } from './helpers/fs-fixtures.mjs';

const fixture = fileURLToPath(new URL('./fixtures/stream-emitter.mjs', import.meta.url));
const descendantWriter = String.raw`
  const fs = require('node:fs');
  const markerPath = process.argv[1];
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => fs.appendFileSync(markerPath, '.'), 20);
`;
const processGroupParent = String.raw`
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const descendant = spawn(process.execPath, ['-e', process.argv[1], process.argv[3]], {
    stdio: 'ignore',
  });
  fs.writeFileSync(process.argv[2], String(descendant.pid));
  descendant.unref();
  process.stdout.write(JSON.stringify({ num_turns: 1 }));
  if (process.argv[4] === 'deadline') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1_000);
  } else {
    setTimeout(() => process.exit(0), 80);
  }
`;

function pidIsGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    throw error;
  }
}

async function streamingModule() {
  try {
    return await import('../scripts/lib/streaming-process.mjs');
  } catch (error) {
    assert.fail(`streaming process module must load: ${error?.code || error}`);
  }
}

test('runStreamingProcess streams stdin to one real child with cwd and explicit env', async () => {
  const { runStreamingProcess } = await streamingModule();
  const cwd = mkdtempSync(join(tmpdir(), 'deep-loop-stream-'));
  let spawnCount = 0;
  const previousLeak = process.env.SHOULD_NOT_LEAK;
  process.env.SHOULD_NOT_LEAK = 'host-environment';
  let result;
  try {
    result = await runStreamingProcess({
      bin: process.execPath,
      argv: [fixture, 'checkpoint', cwd],
      cwd,
      env: { STREAM_TOKEN: 'explicit-only' },
      stdin: 'streaming checkpoint',
      shell: false,
      usageOutputKind: 'claude-json',
    }, {
      timeoutMs: 2_000,
      spawnImpl: (bin, argv, options) => {
        spawnCount += 1;
        assert.equal(options.shell, false);
        assert.equal(Object.hasOwn(options, 'detached'), false, 'legacy mode must not alter spawn topology');
        assert.deepEqual(options.env, { STREAM_TOKEN: 'explicit-only' });
        return spawn(bin, argv, options);
      },
    });
  } finally {
    if (previousLeak == null) delete process.env.SHOULD_NOT_LEAK;
    else process.env.SHOULD_NOT_LEAK = previousLeak;
  }

  assert.deepEqual(result.usage, { num_turns: 1, tokens: 12 });
  assert.equal(result.ok, true);
  assert.equal(spawnCount, 1, 'the runtime must be spawned exactly once');
  assert.equal(Object.hasOwn(result, 'stdout'), false, 'raw runtime stdout must never escape');
});

test('strict process-group mode rejects unsupported platforms before async or worker spawn', async () => {
  const { runStreamingProcess, runStreamingProcessSync } = await streamingModule();
  let asyncSpawns = 0;
  const asyncResult = await runStreamingProcess({
    bin: process.execPath,
    argv: [],
    usageOutputKind: 'claude-json',
  }, {
    processGroup: 'required',
    platform: 'win32',
    spawnImpl: () => {
      asyncSpawns += 1;
      throw new Error('unsupported strict mode must not spawn');
    },
  });
  let workerSpawns = 0;
  const syncResult = runStreamingProcessSync({
    bin: process.execPath,
    argv: [],
    usageOutputKind: 'claude-json',
  }, {
    processGroup: 'required',
    platform: 'win32',
    spawnSyncImpl: () => {
      workerSpawns += 1;
      throw new Error('unsupported strict mode must not spawn a worker');
    },
  });

  const unavailable = {
    ok: false,
    reason: 'process-group-unavailable',
    process_group: {
      mode: 'required',
      platform: 'win32',
      group_id: null,
      termination_scope: 'none',
      quiescence_confirmed: null,
    },
    termination: {
      trigger: 'unsupported-platform',
      term_requested: false,
      kill_requested: false,
      confirmed: false,
    },
  };
  assert.deepEqual(asyncResult, unavailable);
  assert.deepEqual(syncResult, unavailable);
  assert.equal(asyncSpawns, 0);
  assert.equal(workerSpawns, 0);
});

test('strict pre-spawn validation reports that no owned process group was created', async () => {
  const { runStreamingProcess } = await streamingModule();
  let spawns = 0;
  const result = await runStreamingProcess({ bin: process.execPath, argv: [] }, {
    processGroup: 'required',
    spawnImpl: () => {
      spawns += 1;
      throw new Error('invalid request must not spawn');
    },
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'unsupported-usage-kind',
    process_group: {
      mode: 'required',
      platform: process.platform,
      group_id: null,
      termination_scope: 'none',
      quiescence_confirmed: true,
    },
    termination: {
      trigger: 'preflight-rejected',
      term_requested: false,
      kill_requested: false,
      confirmed: true,
    },
  });
  assert.equal(spawns, 0);
});

test('strict normal completion terminates and confirms inherited descendants before success', async () => {
  const { runStreamingProcess } = await streamingModule();
  const dir = mkdtempSync(join(tmpdir(), 'deep-loop-stream-group-success-'));
  const pidPath = join(dir, 'descendant.pid');
  const markerPath = join(dir, 'descendant.marker');
  let descendantPid;
  try {
    const result = await runStreamingProcess({
      bin: process.execPath,
      argv: ['-e', processGroupParent, descendantWriter, pidPath, markerPath, 'success'],
      usageOutputKind: 'claude-json',
    }, { timeoutMs: 2_000, processGroup: 'required' });
    descendantPid = Number(readFileSync(pidPath, 'utf8'));
    const markerAtReturn = readFileSync(markerPath, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.usage, { num_turns: 1, tokens: null });
    assert.equal(result.process_group.mode, 'required');
    assert.equal(result.process_group.termination_scope, 'owned-posix-process-group');
    assert.equal(result.process_group.quiescence_confirmed, true);
    assert.equal(result.termination.trigger, 'post-exit-cleanup');
    assert.equal(result.termination.term_requested, true);
    assert.equal(result.termination.confirmed, true);
    assert.equal(pidIsGone(descendantPid), true, 'descendant must be dead before success returns');
    assert.equal(readFileSync(markerPath, 'utf8'), markerAtReturn, 'descendant cannot mutate files after success');
  } finally {
    if (Number.isInteger(descendantPid) && !pidIsGone(descendantPid)) process.kill(descendantPid, 'SIGKILL');
  }
});

test('strict deadline escalates to group SIGKILL and confirms no descendant survives', async () => {
  const { runStreamingProcess } = await streamingModule();
  const dir = mkdtempSync(join(tmpdir(), 'deep-loop-stream-group-timeout-'));
  const pidPath = join(dir, 'descendant.pid');
  const markerPath = join(dir, 'descendant.marker');
  let descendantPid;
  try {
    const result = await runStreamingProcess({
      bin: process.execPath,
      argv: ['-e', processGroupParent, descendantWriter, pidPath, markerPath, 'deadline'],
      usageOutputKind: 'claude-json',
    }, { timeoutMs: 200, processGroup: 'required' });
    descendantPid = Number(readFileSync(pidPath, 'utf8'));
    const markerAtReturn = readFileSync(markerPath, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.reason, 'timeout');
    assert.equal(result.process_group.quiescence_confirmed, true);
    assert.equal(result.termination.trigger, 'deadline');
    assert.equal(result.termination.term_requested, true);
    assert.equal(result.termination.kill_requested, true);
    assert.equal(result.termination.confirmed, true);
    assert.equal(pidIsGone(descendantPid), true, 'deadline must terminate the inherited descendant');
    assert.equal(readFileSync(markerPath, 'utf8'), markerAtReturn, 'deadline descendant cannot keep mutating files');
  } finally {
    if (Number.isInteger(descendantPid) && !pidIsGone(descendantPid)) process.kill(descendantPid, 'SIGKILL');
  }
});

test('runStreamingProcess discards valid usage after timeout or non-zero exit', async () => {
  const { runStreamingProcess } = await streamingModule();
  const timedOut = await runStreamingProcess({
    bin: process.execPath,
    argv: [fixture, 'timeout-valid'],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 40 });
  const nonzero = await runStreamingProcess({
    bin: process.execPath,
    argv: [fixture, 'nonzero-valid'],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 2_000 });

  assert.deepEqual(timedOut, { ok: false, reason: 'timeout' });
  assert.deepEqual(nonzero, { ok: false, reason: 'exit-7' });
  assert.equal(timedOut.usage, undefined);
  assert.equal(nonzero.usage, undefined);
});

test('streaming process APIs reject a missing usageOutputKind before spawning', async () => {
  const { runStreamingProcess, runStreamingProcessSync } = await streamingModule();
  let runtimeSpawns = 0;
  const asyncResult = await runStreamingProcess({ bin: process.execPath, argv: [] }, {
    timeoutMs: 2_000,
    spawnImpl: () => {
      runtimeSpawns += 1;
      throw new Error('missing usageOutputKind must not spawn runtime');
    },
  });
  let workerSpawns = 0;
  const syncResult = runStreamingProcessSync({ bin: process.execPath, argv: [] }, {
    timeoutMs: 2_000,
    spawnSyncImpl: () => {
      workerSpawns += 1;
      throw new Error('missing usageOutputKind must not spawn worker');
    },
  });
  assert.deepEqual(asyncResult, { ok: false, reason: 'unsupported-usage-kind' });
  assert.deepEqual(syncResult, { ok: false, reason: 'unsupported-usage-kind' });
  assert.equal(runtimeSpawns, 0);
  assert.equal(workerSpawns, 0);
});

test('streaming process APIs reject invalid timeouts before spawning runtime or worker', async () => {
  const { runStreamingProcess, runStreamingProcessSync } = await streamingModule();
  const invalidTimeouts = [NaN, Infinity, -Infinity, -1, 1.5, 2_147_483_648];

  for (const timeoutMs of invalidTimeouts) {
    let runtimeSpawns = 0;
    const asyncResult = await runStreamingProcess({ bin: process.execPath, argv: [] }, {
      timeoutMs,
      spawnImpl: () => {
        runtimeSpawns += 1;
        throw new Error('invalid timeout must not spawn runtime');
      },
    });
    let workerSpawns = 0;
    const syncResult = runStreamingProcessSync({ bin: process.execPath, argv: [] }, {
      timeoutMs,
      spawnSyncImpl: () => {
        workerSpawns += 1;
        throw new Error('invalid timeout must not spawn worker');
      },
    });

    assert.deepEqual(asyncResult, { ok: false, reason: 'invalid-timeout' }, String(timeoutMs));
    assert.deepEqual(syncResult, { ok: false, reason: 'invalid-timeout' }, String(timeoutMs));
    assert.equal(runtimeSpawns, 0, String(timeoutMs));
    assert.equal(workerSpawns, 0, String(timeoutMs));
  }
});

function controlledChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.destroy = () => {};
  child.stdin.end = (_payload, callback) => {
    child.completeStdin = callback;
  };
  child.kill = () => true;
  return child;
}

test('non-empty stdin requires flush completion before a zero-exit child can succeed', async () => {
  const { runStreamingProcess } = await streamingModule();
  const child = controlledChild();
  const pending = runStreamingProcess({
    bin: process.execPath,
    argv: [],
    stdin: 'request',
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 2_000, spawnImpl: () => child });
  child.stdout.emit('data', Buffer.from('{"num_turns":1}'));
  child.emit('close', 0);

  assert.deepEqual(await pending, { ok: false, reason: 'stdin-error' });
});

test('empty stdin can succeed even when no flush callback arrives before child close', async () => {
  const { runStreamingProcess } = await streamingModule();
  const child = controlledChild();
  const pending = runStreamingProcess({
    bin: process.execPath,
    argv: [],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 2_000, spawnImpl: () => child });
  child.stdout.emit('data', Buffer.from('{"num_turns":1}'));
  child.emit('close', 0);

  assert.deepEqual(await pending, { ok: true, usage: { num_turns: 1, tokens: null } });
});

test('runStreamingProcess fails closed when a non-empty stdin request is not delivered', async () => {
  const { runStreamingProcess } = await streamingModule();
  const result = await runStreamingProcess({
    bin: process.execPath,
    argv: [fixture, 'close-stdin-valid'],
    stdin: 'x'.repeat(1024 * 1024),
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 2_000 });

  assert.deepEqual(result, { ok: false, reason: 'stdin-error' });
  assert.equal(result.usage, undefined);
});

test('runStreamingProcess drains multi-MiB stderr but retains only the diagnostic byte cap', async () => {
  const { runStreamingProcess } = await streamingModule();
  const result = await runStreamingProcess({
    bin: process.execPath,
    argv: [fixture, 'large-stderr'],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 5_000 });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.usage, { num_turns: 1, tokens: 12 });
  assert.equal(Buffer.byteLength(result.stderr, 'utf8'), STREAM_LIMITS.stderrBytes);
  assert.equal(result.stderrTruncated, true);
  assert.equal(Object.hasOwn(result, 'stdout'), false);
});

test('runStreamingProcess keeps encoded stderr diagnostics within the raw byte cap', async () => {
  const { runStreamingProcess } = await streamingModule();
  const result = await runStreamingProcess({
    bin: process.execPath,
    argv: [fixture, 'invalid-stderr'],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 2_000 });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Buffer.byteLength(result.stderr, 'utf8') <= STREAM_LIMITS.stderrBytes);
  assert.equal(result.stderrTruncated, true);
});

test('runStreamingProcess feeds Codex JSONL incrementally without returning raw output', async () => {
  const { runStreamingProcess } = await streamingModule();
  const result = await runStreamingProcess({
    bin: process.execPath,
    argv: [fixture, 'codex-stream'],
    usageOutputKind: 'codex-jsonl',
  }, { timeoutMs: 5_000 });

  assert.deepEqual(result, {
    ok: true,
    usage: {
      num_turns: 1,
      tokens: 24,
      input_tokens: 11,
      output_tokens: 13,
      cached_input_tokens: 4,
      reasoning_output_tokens: 3,
    },
  });
  assert.equal(Object.hasOwn(result, 'stdout'), false);
});

test('streaming async and sync paths return only the parser-verified provider thread UUID', async () => {
  const { runStreamingProcess, runStreamingProcessSync } = await streamingModule();
  const providerThreadId = '019d1234-5678-7abc-8def-0123456789ab';
  const source = [
    JSON.stringify({ type: 'thread.started', thread_id: providerThreadId }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }),
  ].join('\n');
  const entry = {
    bin: process.execPath,
    argv: ['-e', `process.stdout.write(${JSON.stringify(source)})`],
    usageOutputKind: 'codex-jsonl',
    captureProviderThreadId: true,
  };

  const asyncResult = await runStreamingProcess(entry, { timeoutMs: 2_000 });
  const syncResult = runStreamingProcessSync(entry, { timeoutMs: 2_000 });
  for (const result of [asyncResult, syncResult]) {
    assert.deepEqual(result, {
      ok: true,
      usage: {
        num_turns: 1,
        tokens: 5,
        input_tokens: 3,
        output_tokens: 2,
      },
      providerThreadId,
    });
  }
});

test('streaming async and sync paths opt into exact Codex final-message bytes', async () => {
  const { runStreamingProcess, runStreamingProcessSync } = await streamingModule();
  const entry = {
    bin: process.execPath,
    argv: [fixture, 'codex-final-message'],
    usageOutputKind: 'codex-jsonl',
    captureFinalMessage: true,
    shell: false,
  };
  const expected = Buffer.from('  exact review bytes: 한글🙂\n');
  const asyncResult = await runStreamingProcess(entry, { timeoutMs: 2_000 });
  const syncResult = runStreamingProcessSync(entry, { timeoutMs: 2_000 });

  for (const result of [asyncResult, syncResult]) {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(Buffer.isBuffer(result.finalMessage), true);
    assert.equal(result.finalMessage.equals(expected), true);
    assert.deepEqual(result.usage, {
      num_turns: 1,
      tokens: 12,
      input_tokens: 5,
      output_tokens: 7,
    });
  }
});

test('sync worker rejects non-canonical or malformed final-message transport', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  const base = { status: 0, signal: null, stderr: '' };
  const usage = { num_turns: 1, tokens: 2, input_tokens: 1, output_tokens: 1 };
  for (const stdout of [
    JSON.stringify({ ok: true, usage, finalMessageBase64: '@@@' }),
    JSON.stringify({ ok: true, usage, finalMessageBase64: Buffer.from('x').toString('base64'), finalMessage: 'spoof' }),
    JSON.stringify({ ok: true, usage, providerThreadId: 'thread-1' }),
  ]) {
    const result = runStreamingProcessSync({
      bin: process.execPath,
      argv: [],
      usageOutputKind: 'codex-jsonl',
      captureFinalMessage: true,
    }, { spawnSyncImpl: () => ({ ...base, stdout }) });
    assert.deepEqual(result, { ok: false, reason: 'worker-protocol-invalid' });
  }
});

test('sync worker bound accommodates the maximum final message plus maximum stderr diagnostic', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  const finalMessage = Buffer.alloc(STREAM_LIMITS.finalMessageBytes, 0x61);
  const stderr = 'e'.repeat(STREAM_LIMITS.stderrBytes);
  const result = runStreamingProcessSync({
    bin: process.execPath,
    argv: [],
    usageOutputKind: 'codex-jsonl',
    captureFinalMessage: true,
  }, {
    spawnSyncImpl: () => ({
      status: 0,
      signal: null,
      stderr: '',
      stdout: JSON.stringify({
        ok: true,
        usage: { num_turns: 1, tokens: 2, input_tokens: 1, output_tokens: 1 },
        finalMessageBase64: finalMessage.toString('base64'),
        stderr,
        stderrTruncated: true,
      }),
    }),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.finalMessage.equals(finalMessage), true);
  assert.equal(Buffer.byteLength(result.stderr), STREAM_LIMITS.stderrBytes);
});

test('runStreamingProcessSync uses one dedicated Node worker and one runtime spawn', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  assert.equal(typeof runStreamingProcessSync, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'deep-loop-stream-sync-'));
  const counterPath = join(dir, 'runtime-spawns.txt');
  let workerSpawnCount = 0;
  let workerArgv;
  let workerInput;
  const result = runStreamingProcessSync({
    bin: process.execPath,
    argv: [fixture, 'count-once', counterPath],
    stdin: 'worker-only stdin',
    env: {},
    shell: false,
    usageOutputKind: 'claude-json',
  }, {
    timeoutMs: 2_000,
    spawnSyncImpl: (bin, argv, options) => {
      workerSpawnCount += 1;
      assert.equal(bin, process.execPath);
      assert.equal(options.shell, false);
      workerArgv = argv;
      workerInput = options.input;
      return spawnSync(bin, argv, options);
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(workerSpawnCount, 1, 'the facade must synchronously spawn one worker');
  assert.equal(readFileSync(counterPath, 'utf8'), 'spawned\n', 'the worker must spawn the runtime once');
  assert.equal(workerArgv.includes('worker-only stdin'), false, 'runtime stdin must not appear in worker argv');
  assert.equal(Buffer.from(workerInput).includes(Buffer.from('worker-only stdin')), true);
  assert.equal(Object.hasOwn(result, 'stdout'), false, 'worker protocol must not expose raw runtime stdout');
});

test('sync worker forwards strict process-group ownership and returns confirmed lifecycle evidence', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  const dir = mkdtempSync(join(tmpdir(), 'deep-loop-stream-group-sync-'));
  const pidPath = join(dir, 'descendant.pid');
  const markerPath = join(dir, 'descendant.marker');
  let descendantPid;
  try {
    const result = runStreamingProcessSync({
      bin: process.execPath,
      argv: ['-e', processGroupParent, descendantWriter, pidPath, markerPath, 'success'],
      usageOutputKind: 'claude-json',
    }, { timeoutMs: 2_000, processGroup: 'required' });
    descendantPid = Number(readFileSync(pidPath, 'utf8'));

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.usage, { num_turns: 1, tokens: null });
    assert.equal(result.process_group.mode, 'required');
    assert.equal(result.process_group.quiescence_confirmed, true);
    assert.equal(result.termination.trigger, 'post-exit-cleanup');
    assert.equal(result.termination.confirmed, true);
    assert.equal(pidIsGone(descendantPid), true);
  } finally {
    if (Number.isInteger(descendantPid) && !pidIsGone(descendantPid)) process.kill(descendantPid, 'SIGKILL');
  }
});

test('runStreamingProcessSync durably journals and returns an exact worker-owned usage receipt before success', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'deep-loop-stream-receipt-')));
  const runId = 'RUN-RECEIPT';
  const attemptId = 'b'.repeat(32);
  const journalDir = join(root, '.deep-loop', 'runs', runId, 'preflight', 'process-receipts');
  const journalPath = join(journalDir, `${attemptId}-read.json`);
  mkdirSync(journalDir, { recursive: true });
  const descriptor = {
    journalPath,
    root,
    runId,
    cacheKey: 'a'.repeat(64),
    smokeKind: 'read',
    attemptId,
    predecessorReceiptId: null,
    owner: 'RUN-RECEIPT',
    generation: 1,
  };
  const usage = {
    num_turns: 1,
    tokens: 24,
    input_tokens: 11,
    output_tokens: 13,
    cached_input_tokens: 4,
    reasoning_output_tokens: 3,
  };
  const expectedReceipt = makeCodexPreflightReceipt({ ...descriptor, usage });
  const result = runStreamingProcessSync({
    bin: process.execPath,
    argv: [fixture, 'codex-stream'],
    usageOutputKind: 'codex-jsonl',
  }, { timeoutMs: 2_000, usageReceipt: descriptor });

  assert.deepEqual(result, { ok: true, usage, usageReceipt: expectedReceipt });
  assert.equal(
    readFileSync(journalPath, 'utf8'),
    `${JSON.stringify(expectedReceipt)}\n`,
    'the facade may return success only after the worker has published the exact immutable receipt bytes',
  );
});

test('runStreamingProcessSync fails closed without usage when its receipt journal is invalid or unwritable', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'deep-loop-stream-receipt-fail-')));
  const runId = 'RUN-RECEIPT';
  const journalDir = join(root, '.deep-loop', 'runs', runId, 'preflight', 'process-receipts');
  mkdirSync(journalDir, { recursive: true });
  const base = {
    root,
    runId,
    cacheKey: 'c'.repeat(64),
    smokeKind: 'read',
    attemptId: 'd'.repeat(32),
    predecessorReceiptId: null,
    owner: 'RUN-RECEIPT',
    generation: 1,
  };
  const occupied = join(journalDir, `${base.attemptId}-read.json`);
  const original = '{"immutable":"existing"}\n';
  writeFileSync(occupied, original);
  const cases = [
    ['relative journal', { ...base, journalPath: 'relative-receipt.json' }],
    ['missing journal parent', {
      ...base,
      attemptId: 'e'.repeat(32),
      journalPath: join(root, '.deep-loop', 'runs', 'OTHER', 'preflight', 'process-receipts', `${'e'.repeat(32)}-read.json`),
    }],
    ['occupied immutable journal', { ...base, journalPath: occupied }],
  ];

  for (const [label, usageReceipt] of cases) {
    const result = runStreamingProcessSync({
      bin: process.execPath,
      argv: [fixture, 'codex-stream'],
      usageOutputKind: 'codex-jsonl',
    }, { timeoutMs: 2_000, usageReceipt });
    assert.deepEqual(result, { ok: false, reason: 'usage-receipt-write-failed' }, label);
    assert.equal(Object.hasOwn(result, 'usage'), false, label);
    assert.equal(Object.hasOwn(result, 'usageReceipt'), false, label);
  }
  assert.equal(readFileSync(occupied, 'utf8'), original, 'an existing journal is immutable');

  const strictAttemptId = 'f'.repeat(32);
  const strictOccupied = join(journalDir, `${strictAttemptId}-read.json`);
  writeFileSync(strictOccupied, original);
  const strictResult = runStreamingProcessSync({
    bin: process.execPath,
    argv: [fixture, 'codex-stream'],
    usageOutputKind: 'codex-jsonl',
  }, {
    timeoutMs: 2_000,
    processGroup: 'required',
    usageReceipt: {
      ...base,
      attemptId: strictAttemptId,
      journalPath: strictOccupied,
    },
  });
  assert.equal(strictResult.ok, false);
  assert.equal(strictResult.reason, 'usage-receipt-write-failed');
  assert.equal(strictResult.process_group.quiescence_confirmed, true);
  assert.equal(strictResult.termination.confirmed, true);
  assert.equal(Object.hasOwn(strictResult, 'usage'), false);
  assert.equal(readFileSync(strictOccupied, 'utf8'), original);
});

test('runStreamingProcessSync preserves timeout/non-zero precedence across the worker boundary', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  const timedOut = runStreamingProcessSync({
    bin: process.execPath,
    argv: [fixture, 'timeout-valid'],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 40 });
  const nonzero = runStreamingProcessSync({
    bin: process.execPath,
    argv: [fixture, 'nonzero-valid'],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 2_000 });

  assert.deepEqual(timedOut, { ok: false, reason: 'timeout' });
  assert.deepEqual(nonzero, { ok: false, reason: 'exit-7' });
  assert.equal(timedOut.usage, undefined);
  assert.equal(nonzero.usage, undefined);
});

test('runStreamingProcessSync escalates timeout termination so the runtime cannot outlive its worker', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  const dir = mkdtempSync(join(tmpdir(), 'deep-loop-stream-timeout-'));
  const pidPath = join(dir, 'runtime.pid');
  let pid;
  try {
    const result = runStreamingProcessSync({
      bin: process.execPath,
      argv: [fixture, 'ignore-term', pidPath],
      usageOutputKind: 'claude-json',
    }, { timeoutMs: 200 });
    pid = Number(readFileSync(pidPath, 'utf8'));

    assert.deepEqual(result, { ok: false, reason: 'timeout' });
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error?.code === 'ESRCH',
      'timed-out runtime must be gone before the worker returns',
    );
  } finally {
    if (Number.isInteger(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
  }
});

test('runStreamingProcessSync bounds worker request and result protocols before decoding', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  let spawns = 0;
  const requestOverflow = runStreamingProcessSync({
    bin: process.execPath,
    argv: [fixture, 'checkpoint', '/unused'],
    stdin: 'x'.repeat(2 * 1024 * 1024),
    usageOutputKind: 'claude-json',
  }, {
    spawnSyncImpl: () => {
      spawns += 1;
      throw new Error('overflow request must not spawn a worker');
    },
  });
  const rawStdoutProtocol = runStreamingProcessSync({ bin: process.execPath, argv: [], usageOutputKind: 'claude-json' }, {
    spawnSyncImpl: () => ({
      status: 0,
      signal: null,
      stdout: JSON.stringify({ ok: true, usage: { num_turns: 1 }, stdout: 'raw-runtime-output' }),
      stderr: '',
    }),
  });
  const missingUsageProtocol = runStreamingProcessSync({ bin: process.execPath, argv: [], usageOutputKind: 'claude-json' }, {
    spawnSyncImpl: () => ({
      status: 0,
      signal: null,
      stdout: JSON.stringify({ ok: true }),
      stderr: '',
    }),
  });
  const resultOverflow = runStreamingProcessSync({ bin: process.execPath, argv: [], usageOutputKind: 'claude-json' }, {
    spawnSyncImpl: () => ({
      status: 0,
      signal: null,
      stdout: 'x'.repeat(1025 * 1024),
      stderr: '',
    }),
  });

  assert.deepEqual(requestOverflow, { ok: false, reason: 'worker-request-overflow' });
  assert.equal(spawns, 0);
  assert.deepEqual(rawStdoutProtocol, { ok: false, reason: 'worker-protocol-invalid' });
  assert.deepEqual(missingUsageProtocol, { ok: false, reason: 'worker-protocol-invalid' });
  assert.deepEqual(resultOverflow, { ok: false, reason: 'worker-result-overflow' });
});
