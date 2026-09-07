import { runStreamingProcess, WORKER_RAW_RESULT_BYTES } from '../lib/streaming-process.mjs';
import {
  validateProcessUsageReceiptDescriptor,
  writeProcessUsageReceipt,
} from '../lib/preflight-receipt-journal.mjs';

const WORKER_REQUEST_BYTES = 2 * 1024 * 1024;
const WORKER_RESULT_BYTES = 1024 * 1024;

async function readRequest() {
  const chunks = [];
  let retained = 0;
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (retained < WORKER_REQUEST_BYTES) {
      const slice = buffer.subarray(0, WORKER_REQUEST_BYTES - retained);
      chunks.push(slice);
      retained += slice.length;
    }
  }
  if (total > WORKER_REQUEST_BYTES) throw new Error('worker-request-overflow');
  return JSON.parse(Buffer.concat(chunks, retained).toString('utf8'));
}

function decodeEntry(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error('worker-request-invalid');
  const stdin = value.stdin;
  if (stdin == null || typeof stdin !== 'object' || Array.isArray(stdin) || typeof stdin.data !== 'string') {
    throw new Error('worker-request-invalid');
  }
  let decodedStdin;
  if (stdin.encoding === 'utf8') decodedStdin = stdin.data;
  else if (stdin.encoding === 'base64') decodedStdin = Buffer.from(stdin.data, 'base64');
  else throw new Error('worker-request-invalid');
  return {
    bin: value.bin,
    argv: value.argv,
    ...(Object.hasOwn(value, 'cwd') ? { cwd: value.cwd } : {}),
    ...(Object.hasOwn(value, 'env') ? { env: value.env } : {}),
    shell: value.shell,
    usageOutputKind: value.usageOutputKind,
    captureFinalMessage: value.captureFinalMessage === true,
    captureProviderThreadId: value.captureProviderThreadId === true,
    stdin: decodedStdin,
  };
}

function boundedMessage(error) {
  return String(error?.message || error || 'worker-error').slice(0, 512);
}

let result;
let captureRawJsonl = false;
try {
  const request = await readRequest();
  const allowedKeys = new Set(['version', 'entry', 'timeoutMs', 'processGroup', 'usageReceipt', 'captureRawJsonl']);
  if (request?.version !== 1 || !Number.isFinite(request.timeoutMs) || request.timeoutMs < 0
    || request == null || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !allowedKeys.has(key))) {
    throw new Error('worker-request-invalid');
  }
  if (Object.hasOwn(request, 'captureRawJsonl') && typeof request.captureRawJsonl !== 'boolean') throw new Error('worker-request-invalid');
  captureRawJsonl = request.captureRawJsonl === true;
  const usageReceipt = Object.hasOwn(request, 'usageReceipt')
    ? validateProcessUsageReceiptDescriptor(request.usageReceipt)
    : null;
  result = await runStreamingProcess(decodeEntry(request.entry), {
    timeoutMs: request.timeoutMs,
    processGroup: request.processGroup ?? 'direct',
    captureRawJsonl,
  });
  if (result?.ok === true && usageReceipt != null) {
    try {
      const receipt = writeProcessUsageReceipt(usageReceipt, result.usage);
      result = { ...result, usageReceipt: receipt };
    } catch {
      result = {
        ok: false,
        reason: 'usage-receipt-write-failed',
        ...(Buffer.isBuffer(result.rawJsonl) ? { rawJsonl: result.rawJsonl, rawJsonlTruncated: result.rawJsonlTruncated } : {}),
        ...(Object.hasOwn(result, 'process_group') ? {
          process_group: result.process_group,
          termination: result.termination,
        } : {}),
      };
    }
  }
} catch (error) {
  const message = boundedMessage(error);
  result = {
    ok: false,
    reason: message.includes('USAGE_RECEIPT_')
      ? 'usage-receipt-write-failed'
      : message,
  };
}

const transportResult = result?.ok === true && Buffer.isBuffer(result.finalMessage)
  ? { ...result, finalMessage: undefined, finalMessageBase64: result.finalMessage.toString('base64') }
  : result;
if (transportResult && Object.hasOwn(transportResult, 'finalMessage') && transportResult.finalMessage === undefined) {
  delete transportResult.finalMessage;
}
if (transportResult && Buffer.isBuffer(transportResult.rawJsonl)) {
  transportResult.rawJsonlBase64 = transportResult.rawJsonl.toString('base64');
  delete transportResult.rawJsonl;
}
let encoded = JSON.stringify(transportResult);
if (Buffer.byteLength(encoded, 'utf8') > (captureRawJsonl ? WORKER_RAW_RESULT_BYTES : WORKER_RESULT_BYTES)) {
  encoded = JSON.stringify({ ok: false, reason: 'worker-result-overflow' });
}
process.stdout.write(encoded);
