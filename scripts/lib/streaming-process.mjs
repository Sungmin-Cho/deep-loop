import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createCodexJsonlParser,
  isCanonicalCodexProviderThreadId,
  parseClaudeUsage,
  STREAM_LIMITS,
} from './usage-parser.mjs';
import {
  readProcessUsageReceipt,
  validateProcessUsageReceiptDescriptor,
} from './preflight-receipt-journal.mjs';

const WORKER_REQUEST_BYTES = 2 * 1024 * 1024;
// 256 KiB final-message bytes become ~350 KiB canonical base64; add the independently
// bounded 64 KiB stderr diagnostic plus JSON overhead without permitting unbounded output.
const WORKER_RESULT_BYTES = 1024 * 1024;
export const RAW_JSONL_MAX_BYTES = 1024 * 1024;
export const WORKER_RAW_RESULT_BYTES = WORKER_RESULT_BYTES + Math.ceil(RAW_JSONL_MAX_BYTES / 3) * 4 + 128;
const RUNTIME_KILL_GRACE_MS = 250;
const PROCESS_GROUP_VERIFY_MS = 500;
const PROCESS_GROUP_POLL_MS = 10;
const WORKER_TIMEOUT_GRACE_MS = RUNTIME_KILL_GRACE_MS + 1_000;
const NODE_TIMER_MAX_MS = 2_147_483_647;
const POSIX_PLATFORMS = new Set(['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos']);
const workerPath = fileURLToPath(new URL('../workers/streaming-child.mjs', import.meta.url));

function validTimeout(timeoutMs) {
  return Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= NODE_TIMER_MAX_MS;
}

function validProcessGroup(processGroup) {
  return processGroup === 'direct' || processGroup === 'required';
}

function strictUnavailable(platform, trigger = 'unsupported-platform') {
  return {
    ok: false,
    reason: 'process-group-unavailable',
    process_group: {
      mode: 'required',
      platform,
      group_id: null,
      termination_scope: 'none',
      quiescence_confirmed: null,
    },
    termination: {
      trigger,
      term_requested: false,
      kill_requested: false,
      confirmed: false,
    },
  };
}

function strictUnconfirmed(reason, platform, trigger) {
  return {
    ok: false,
    reason,
    process_group: {
      mode: 'required',
      platform,
      group_id: null,
      termination_scope: 'owned-posix-process-group',
      quiescence_confirmed: false,
    },
    termination: {
      trigger,
      term_requested: false,
      kill_requested: false,
      confirmed: false,
    },
  };
}

function strictNoSpawn(reason, platform) {
  return {
    ok: false,
    reason,
    process_group: {
      mode: 'required',
      platform,
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
  };
}

function appendBounded(chunks, chunk, retainedBytes, limit) {
  const remaining = limit - retainedBytes;
  if (remaining <= 0) return retainedBytes;
  const retained = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(retained);
  return retainedBytes + retained.length;
}

function decodeBoundedDiagnostic(chunks) {
  const text = Buffer.concat(chunks).toString('utf8');
  if (Buffer.byteLength(text, 'utf8') <= STREAM_LIMITS.stderrBytes) {
    return { text, encodingTruncated: false };
  }
  let bounded = '';
  let bytes = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character, 'utf8');
    if (bytes + width > STREAM_LIMITS.stderrBytes) break;
    bounded += character;
    bytes += width;
  }
  return { text: bounded, encodingTruncated: true };
}

function withDiagnostic(result, stderrChunks, stderrTruncated) {
  const decoded = decodeBoundedDiagnostic(stderrChunks);
  if (stderrChunks.length > 0) result.stderr = decoded.text;
  if (stderrTruncated || decoded.encodingTruncated) result.stderrTruncated = true;
  return result;
}

export function runStreamingProcess(entry, {
  timeoutMs = 30 * 60 * 1000,
  spawnImpl = spawn,
  processGroup = 'direct',
  platform = process.platform,
  captureRawJsonl = entry?.captureRawJsonl === true,
} = {}) {
  if (!validProcessGroup(processGroup)) {
    return Promise.resolve({ ok: false, reason: 'invalid-process-group' });
  }
  const strictGroup = processGroup === 'required';
  if (strictGroup && !POSIX_PLATFORMS.has(platform)) {
    return Promise.resolve(strictUnavailable(platform));
  }
  const preSpawnFailure = (reason) => strictGroup
    ? strictNoSpawn(reason, platform)
    : { ok: false, reason };
  if (!validTimeout(timeoutMs)) {
    return Promise.resolve(preSpawnFailure('invalid-timeout'));
  }
  if (!entry || typeof entry.bin !== 'string' || !Array.isArray(entry.argv)) {
    return Promise.resolve(preSpawnFailure('invalid-entry'));
  }
  if (entry.shell != null && entry.shell !== false) {
    return Promise.resolve(preSpawnFailure('shell-not-allowed'));
  }

  if (typeof captureRawJsonl !== 'boolean') return Promise.resolve(preSpawnFailure('invalid-raw-capture'));
  const usageKind = entry.usageOutputKind;
  if (usageKind !== 'claude-json' && usageKind !== 'codex-jsonl') {
    return Promise.resolve(preSpawnFailure('unsupported-usage-kind'));
  }
  const stdinPayload = entry.stdin ?? '';
  const stdinRequired = Buffer.isBuffer(stdinPayload)
    ? stdinPayload.length > 0
    : String(stdinPayload).length > 0;

  return new Promise((resolve) => {
    const rawChunks = [];
    let rawBytes = 0, rawTotalBytes = 0;
    let child;
    try {
      child = spawnImpl(entry.bin, entry.argv, {
        cwd: entry.cwd,
        env: entry.env ?? process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(strictGroup ? { detached: true } : {}),
      });
    } catch (error) {
      const failed = { ok: false, reason: `spawn-error: ${error?.message || error}` };
      resolve(strictGroup ? strictNoSpawn(failed.reason, platform) : failed);
      return;
    }

    const stderrChunks = [];
    let stderrBytes = 0;
    let stderrTotalBytes = 0;
    const claudeChunks = [];
    let claudeBytes = 0;
    let claudeTotalBytes = 0;
    let timedOut = false;
    let spawnError = null;
    let stdinError = null;
    let stdinDelivered = !stdinRequired;
    let settled = false;
    let forceKillTimer = null;
    const groupId = strictGroup && Number.isInteger(child.pid) && child.pid > 0 ? child.pid : null;
    const termination = {
      trigger: 'natural-exit',
      term_requested: false,
      kill_requested: false,
      confirmed: false,
    };
    let terminationPromise = null;
    const codexParser = usageKind === 'codex-jsonl'
      ? createCodexJsonlParser({
          captureFinalMessage: entry.captureFinalMessage === true,
          captureProviderThreadId: entry.captureProviderThreadId === true,
        })
      : null;

    const groupExists = () => {
      if (groupId == null) return null;
      try {
        process.kill(-groupId, 0);
        return true;
      } catch (error) {
        if (error?.code === 'ESRCH') return false;
        if (error?.code === 'EPERM') return true;
        return null;
      }
    };
    const signalGroup = (signal) => {
      try {
        process.kill(-groupId, signal);
        return true;
      } catch (error) {
        if (error?.code === 'ESRCH') return false;
        return null;
      }
    };
    const waitForGroupDeath = async (waitMs) => {
      const deadline = Date.now() + waitMs;
      while (Date.now() <= deadline) {
        const exists = groupExists();
        if (exists !== true) return exists === false;
        await new Promise(done => setTimeout(done, PROCESS_GROUP_POLL_MS));
      }
      return groupExists() === false;
    };
    const ensureGroupQuiescent = (trigger) => {
      if (terminationPromise) return terminationPromise;
      terminationPromise = (async () => {
        termination.trigger = trigger;
        const initial = groupExists();
        if (initial === false) {
          termination.confirmed = true;
          return true;
        }
        if (initial !== true) return false;
        if (trigger === 'natural-exit') termination.trigger = 'post-exit-cleanup';
        termination.term_requested = true;
        const termSignal = signalGroup('SIGTERM');
        if (termSignal === false || await waitForGroupDeath(RUNTIME_KILL_GRACE_MS)) {
          termination.confirmed = true;
          return true;
        }
        termination.kill_requested = true;
        const killSignal = signalGroup('SIGKILL');
        if (killSignal === false || await waitForGroupDeath(PROCESS_GROUP_VERIFY_MS)) {
          termination.confirmed = true;
          return true;
        }
        return false;
      })();
      return terminationPromise;
    };
    const strictEvidence = (result, confirmed) => ({
      ...result,
      process_group: {
        mode: 'required',
        platform,
        group_id: groupId,
        termination_scope: 'owned-posix-process-group',
        quiescence_confirmed: confirmed,
      },
      termination: { ...termination, confirmed },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (strictGroup) {
        void ensureGroupQuiescent('deadline');
      } else {
        try { child.kill(); } catch { /* close/error settles the result */ }
        forceKillTimer = setTimeout(() => {
          if (!settled) {
            try { child.kill('SIGKILL'); } catch { /* outer worker bound remains the backstop */ }
          }
        }, RUNTIME_KILL_GRACE_MS);
      }
    }, timeoutMs);
    timer?.unref?.();

    child.stdout.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (captureRawJsonl) {
        rawTotalBytes += buffer.length;
        rawBytes = appendBounded(rawChunks, buffer, rawBytes, RAW_JSONL_MAX_BYTES);
      }
      if (codexParser) {
        codexParser.write(buffer);
        return;
      }
      claudeTotalBytes += buffer.length;
      claudeBytes = appendBounded(claudeChunks, buffer, claudeBytes, STREAM_LIMITS.claudeOutputBytes);
    });
    child.stderr.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrTotalBytes += buffer.length;
      stderrBytes = appendBounded(stderrChunks, buffer, stderrBytes, STREAM_LIMITS.stderrBytes);
    });
    child.stdin.on('error', (error) => {
      if (stdinRequired && stdinError == null) stdinError = error;
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', async (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const diagnostic = (result) => withDiagnostic(
        captureRawJsonl ? { ...result, rawJsonl: Buffer.concat(rawChunks, rawBytes), rawJsonlTruncated: rawTotalBytes > RAW_JSONL_MAX_BYTES } : result,
        stderrChunks,
        stderrTotalBytes > STREAM_LIMITS.stderrBytes,
      );
      let decorate = (result) => result;
      if (strictGroup) {
        const confirmed = await ensureGroupQuiescent(timedOut ? 'deadline' : 'natural-exit');
        decorate = (result) => strictEvidence(result, confirmed);
        if (!confirmed) {
          resolve(diagnostic(decorate({ ok: false, reason: 'process-group-termination-unconfirmed' })));
          return;
        }
      }

      if (spawnError) {
        resolve(diagnostic(decorate({ ok: false, reason: `spawn-error: ${spawnError?.message || spawnError}` })));
        return;
      }
      if (timedOut) {
        resolve(diagnostic(decorate({ ok: false, reason: 'timeout' })));
        return;
      }
      if (code !== 0) {
        resolve(diagnostic(decorate({ ok: false, reason: `exit-${code}` })));
        return;
      }
      if (stdinError || !stdinDelivered) {
        resolve(diagnostic(decorate({ ok: false, reason: 'stdin-error' })));
        return;
      }

      if (codexParser) {
        const parsed = codexParser.end();
        resolve(diagnostic(decorate(parsed.ok
          ? {
              ok: true,
              usage: parsed.usage,
              ...(Buffer.isBuffer(parsed.finalMessage) ? { finalMessage: parsed.finalMessage } : {}),
              ...(typeof parsed.providerThreadId === 'string'
                ? { providerThreadId: parsed.providerThreadId }
                : {}),
            }
          : parsed)));
        return;
      }
      if (claudeTotalBytes > STREAM_LIMITS.claudeOutputBytes) {
        resolve(diagnostic(decorate({ ok: false, reason: 'claude-output-overflow' })));
        return;
      }
      const usage = parseClaudeUsage(Buffer.concat(claudeChunks, claudeBytes));
      resolve(diagnostic(decorate(usage == null
        ? { ok: false, reason: 'unmeasurable-fail-closed' }
        : { ok: true, usage })));
    });

    try {
      child.stdin.end(stdinPayload, (error) => {
        if (!stdinRequired) return;
        if (error && stdinError == null) stdinError = error;
        else if (!error) stdinDelivered = true;
      });
    } catch (error) {
      if (stdinRequired) stdinError = error;
      child.stdin.destroy();
    }
  });
}

function workerEntry(entry) {
  const stdin = Buffer.isBuffer(entry?.stdin)
    ? { encoding: 'base64', data: entry.stdin.toString('base64') }
    : { encoding: 'utf8', data: entry?.stdin == null ? '' : String(entry.stdin) };
  return {
    bin: entry?.bin,
    argv: entry?.argv,
    ...(entry && Object.hasOwn(entry, 'cwd') ? { cwd: entry.cwd } : {}),
    ...(entry && Object.hasOwn(entry, 'env') ? { env: entry.env } : {}),
    shell: entry?.shell ?? false,
    usageOutputKind: entry?.usageOutputKind,
    captureFinalMessage: entry?.captureFinalMessage === true,
    ...(entry?.captureProviderThreadId === true ? { captureProviderThreadId: true } : {}),
    stdin,
  };
}

function sameUsage(left, right) {
  if (left == null || typeof left !== 'object' || Array.isArray(left)
    || right == null || typeof right !== 'object' || Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function decodeWorkerResult(stdout, usageReceiptDescriptor = null, captureRawJsonl = false) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'worker-protocol-invalid' };
  }
  const allowedKeys = new Set([
    'ok',
    'reason',
    'usage',
    'usageReceipt',
    'stderr',
    'stderrTruncated',
    'finalMessageBase64',
    'providerThreadId',
    'process_group',
    'termination',
  ]);
  if (captureRawJsonl) { allowedKeys.add('rawJsonlBase64'); allowedKeys.add('rawJsonlTruncated'); }
  if (result == null || typeof result !== 'object' || Array.isArray(result)
    || typeof result.ok !== 'boolean'
    || Object.keys(result).some((key) => !allowedKeys.has(key))
    || (Object.hasOwn(result, 'stderr')
      && (typeof result.stderr !== 'string'
        || Buffer.byteLength(result.stderr, 'utf8') > STREAM_LIMITS.stderrBytes))
    || (Object.hasOwn(result, 'stderrTruncated') && typeof result.stderrTruncated !== 'boolean')) {
    return { ok: false, reason: 'worker-protocol-invalid' };
  }
  if (captureRawJsonl && result.ok === true && !Object.hasOwn(result, 'rawJsonlBase64')) return { ok: false, reason: 'worker-protocol-invalid' };
  if (Object.hasOwn(result, 'rawJsonlBase64') || Object.hasOwn(result, 'rawJsonlTruncated')) {
    if (typeof result.rawJsonlBase64 !== 'string' || typeof result.rawJsonlTruncated !== 'boolean'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.rawJsonlBase64)) return { ok: false, reason: 'worker-protocol-invalid' };
    const rawJsonl = Buffer.from(result.rawJsonlBase64, 'base64');
    if (rawJsonl.length > RAW_JSONL_MAX_BYTES || rawJsonl.toString('base64') !== result.rawJsonlBase64
      || (result.rawJsonlTruncated && rawJsonl.length !== RAW_JSONL_MAX_BYTES)) return { ok: false, reason: 'worker-protocol-invalid' };
    delete result.rawJsonlBase64;
    result.rawJsonl = rawJsonl;
  }
  const hasProcessGroup = Object.hasOwn(result, 'process_group');
  const hasTermination = Object.hasOwn(result, 'termination');
  if (hasProcessGroup !== hasTermination) return { ok: false, reason: 'worker-protocol-invalid' };
  if (hasProcessGroup) {
    const group = result.process_group;
    const termination = result.termination;
    const groupKeys = ['group_id', 'mode', 'platform', 'quiescence_confirmed', 'termination_scope'];
    const terminationKeys = ['confirmed', 'kill_requested', 'term_requested', 'trigger'];
    if (group == null || typeof group !== 'object' || Array.isArray(group)
      || termination == null || typeof termination !== 'object' || Array.isArray(termination)
      || Object.keys(group).sort().join('\0') !== groupKeys.sort().join('\0')
      || Object.keys(termination).sort().join('\0') !== terminationKeys.sort().join('\0')
      || group.mode !== 'required' || typeof group.platform !== 'string'
      || (group.group_id !== null && (!Number.isInteger(group.group_id) || group.group_id <= 0))
      || !['none', 'owned-posix-process-group'].includes(group.termination_scope)
      || (group.quiescence_confirmed !== null && typeof group.quiescence_confirmed !== 'boolean')
      || typeof termination.trigger !== 'string'
      || typeof termination.term_requested !== 'boolean'
      || typeof termination.kill_requested !== 'boolean'
      || typeof termination.confirmed !== 'boolean'
      || (result.ok === true
        && (group.termination_scope !== 'owned-posix-process-group'
          || group.quiescence_confirmed !== true || termination.confirmed !== true))) {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
  }
  if (result.ok === false) {
    if (typeof result.reason !== 'string' || Object.hasOwn(result, 'usage')
      || Object.hasOwn(result, 'usageReceipt') || Object.hasOwn(result, 'finalMessageBase64')
      || Object.hasOwn(result, 'providerThreadId')) {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
    return result;
  }
  if (Object.hasOwn(result, 'reason') || result.usage == null || typeof result.usage !== 'object'
    || Array.isArray(result.usage)
    || (!Number.isFinite(result.usage.num_turns) && !Number.isFinite(result.usage.tokens))
    || (Object.hasOwn(result, 'providerThreadId')
      && !isCanonicalCodexProviderThreadId(result.providerThreadId))) {
    return { ok: false, reason: 'worker-protocol-invalid' };
  }
  if (usageReceiptDescriptor == null) {
    if (Object.hasOwn(result, 'usageReceipt')) {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
  } else {
    if (result.usageReceipt == null || typeof result.usageReceipt !== 'object'
      || Array.isArray(result.usageReceipt)) {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
    try {
      const durable = readProcessUsageReceipt(usageReceiptDescriptor);
      if (durable == null || JSON.stringify(result.usageReceipt) !== JSON.stringify(durable)
        || !sameUsage(result.usage, durable.usage)) {
        return { ok: false, reason: 'worker-protocol-invalid' };
      }
      result.usageReceipt = durable;
    } catch {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
  }
  if (Object.hasOwn(result, 'finalMessageBase64')) {
    if (typeof result.finalMessageBase64 !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.finalMessageBase64)) {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
    const finalMessage = Buffer.from(result.finalMessageBase64, 'base64');
    if (finalMessage.length > STREAM_LIMITS.finalMessageBytes
      || finalMessage.toString('base64') !== result.finalMessageBase64) {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
    const { finalMessageBase64: _encoded, ...rest } = result;
    return { ...rest, finalMessage };
  }
  return result;
}

export function runStreamingProcessSync(entry, {
  timeoutMs = 30 * 60 * 1000,
  spawnSyncImpl = spawnSync,
  usageReceipt = null,
  processGroup = 'direct',
  platform = process.platform,
  captureRawJsonl = entry?.captureRawJsonl === true,
} = {}) {
  if (!validProcessGroup(processGroup)) return { ok: false, reason: 'invalid-process-group' };
  const strictGroup = processGroup === 'required';
  if (strictGroup && !POSIX_PLATFORMS.has(platform)) return strictUnavailable(platform);
  const preSpawnFailure = (reason) => strictGroup
    ? strictNoSpawn(reason, platform)
    : { ok: false, reason };
  if (!validTimeout(timeoutMs)) return preSpawnFailure('invalid-timeout');
  if (entry?.usageOutputKind !== 'claude-json' && entry?.usageOutputKind !== 'codex-jsonl') {
    return preSpawnFailure('unsupported-usage-kind');
  }
  if (typeof captureRawJsonl !== 'boolean') return preSpawnFailure('invalid-raw-capture');
  const resultLimit = captureRawJsonl ? WORKER_RAW_RESULT_BYTES : WORKER_RESULT_BYTES;
  let normalizedUsageReceipt = null;
  if (usageReceipt != null) {
    try {
      if (entry?.usageOutputKind !== 'codex-jsonl') throw new Error('usage receipt requires Codex JSONL');
      normalizedUsageReceipt = validateProcessUsageReceiptDescriptor(usageReceipt);
    } catch {
      return preSpawnFailure('usage-receipt-write-failed');
    }
  }
  let request;
  try {
    request = JSON.stringify({
      version: 1,
      entry: workerEntry(entry),
      timeoutMs,
      ...(strictGroup ? { processGroup } : {}),
      ...(captureRawJsonl ? { captureRawJsonl: true } : {}),
      ...(normalizedUsageReceipt == null ? {} : { usageReceipt: normalizedUsageReceipt }),
    });
  } catch {
    return preSpawnFailure('worker-request-invalid');
  }
  if (Buffer.byteLength(request, 'utf8') > WORKER_REQUEST_BYTES) {
    return preSpawnFailure('worker-request-overflow');
  }

  const workerTimeoutMs = timeoutMs + WORKER_TIMEOUT_GRACE_MS;
  let out;
  try {
    out = spawnSyncImpl(process.execPath, [workerPath], {
      input: request,
      encoding: 'utf8',
      maxBuffer: resultLimit,
      timeout: workerTimeoutMs,
      shell: false,
    });
  } catch (error) {
    const reason = `worker-spawn-error: ${error?.message || error}`;
    return strictGroup ? strictUnconfirmed(reason, platform, 'worker-spawn-error') : { ok: false, reason };
  }

  if (out.error) {
    let reason;
    if (out.error.code === 'ETIMEDOUT') reason = 'process-group-termination-unconfirmed';
    else if (out.error.code === 'ENOBUFS') reason = 'worker-result-overflow';
    else reason = `worker-spawn-error: ${out.error?.message || out.error}`;
    return strictGroup ? strictUnconfirmed(reason, platform, 'worker-failure') : {
      ok: false,
      reason: out.error.code === 'ETIMEDOUT' ? 'timeout' : reason,
    };
  }
  if (out.signal != null) return strictGroup
    ? strictUnconfirmed('worker-terminated', platform, 'worker-failure')
    : { ok: false, reason: 'worker-terminated' };
  if (out.status !== 0) return strictGroup
    ? strictUnconfirmed(`worker-exit-${out.status}`, platform, 'worker-failure')
    : { ok: false, reason: `worker-exit-${out.status}` };
  if (Buffer.byteLength(out.stdout || '', 'utf8') > resultLimit) {
    return strictGroup
      ? strictUnconfirmed('worker-result-overflow', platform, 'worker-failure')
      : { ok: false, reason: 'worker-result-overflow' };
  }
  const result = decodeWorkerResult(out.stdout || '', normalizedUsageReceipt, captureRawJsonl);
  if (strictGroup && !Object.hasOwn(result, 'process_group')) {
    return strictUnconfirmed(result.reason || 'worker-protocol-invalid', platform, 'worker-result-unavailable');
  }
  return result;
}
