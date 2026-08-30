import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CAPTURE_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const STDIN_MAX_BYTES = 256 * 1024;
const ALLOWED_SOURCES = new Set(['claude-cache', 'grok-native']);
const ENV_KEYS = Object.freeze([
  'CLAUDE_PLUGIN_ROOT',
  'PLUGIN_ROOT',
  'GROK_HOME',
  'CLAUDE_CODE_ENTRYPOINT',
]);
const seqRef = { value: 0 };

function safeCaptureId(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\0') || value.includes('/') || value.includes('\\')) return false;
  if (value.includes('..')) return false;
  return CAPTURE_RE.test(value);
}

async function readBounded(stream, maxBytes = STDIN_MAX_BYTES) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('stdin-invalid');
  }
  const chunks = [];
  let total = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value)
      ? value
      : value instanceof Uint8Array
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : Buffer.from(String(value));
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error('stdin-too-large');
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
}

function isoNow(now) {
  if (typeof now === 'string' && now.length > 0) return now;
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now).toISOString();
  return new Date().toISOString();
}

function envSubset(env) {
  const subset = {};
  for (const key of ENV_KEYS) subset[key] = Boolean(env[key]);
  return subset;
}

function resolveOutRoot(env) {
  const configured = env.DEEP_LOOP_HOOK_PROBE_OUT;
  const outRoot = typeof configured === 'string' && configured.length > 0
    ? configured
    : join(homedir(), '.deep-loop-hook-probe');
  const realOut = realpathSync(outRoot);
  const stat = lstatSync(outRoot);
  if (!stat.isDirectory() && !stat.isSymbolicLink()) return null;
  const realStat = lstatSync(realOut);
  if (!realStat.isDirectory()) return null;
  return realOut;
}

function destinationPath(realOut, captureId) {
  const dest = join(realOut, `${captureId}.jsonl`);
  if (dest !== join(realOut, `${captureId}.jsonl`)) return null;
  if (relative(realOut, dest) !== `${captureId}.jsonl`) return null;
  if (dest.includes('\0')) return null;
  return dest;
}

function appendLine(dest, line) {
  try {
    const existing = lstatSync(dest);
    if (existing.isSymbolicLink() || !existing.isFile()) return false;
  } catch {
    // dest does not exist yet
  }
  let fd;
  try {
    fd = openSync(
      dest,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    );
    writeSync(fd, Buffer.from(line, 'utf8'));
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function recordHookEvent({
  env = process.env,
  stdin = '',
  argv = process.argv,
  now,
  bindingTag = null,
  seqState = seqRef,
} = {}) {
  try {
    const captureId = env.DEEP_LOOP_HOOK_PROBE_CAPTURE;
    if (!safeCaptureId(captureId)) return { wrote: false, reason: 'capture-id' };
    const source = env.DEEP_LOOP_HOOK_PROBE_SOURCE;
    if (!ALLOWED_SOURCES.has(source)) return { wrote: false, reason: 'source' };
    const realOut = resolveOutRoot(env);
    if (realOut === null) return { wrote: false, reason: 'out-root' };
    const dest = destinationPath(realOut, captureId);
    if (dest === null) return { wrote: false, reason: 'dest' };
    const stdinRaw = typeof stdin === 'string' ? stdin : String(stdin ?? '');
    if (Buffer.byteLength(stdinRaw, 'utf8') > STDIN_MAX_BYTES) {
      return { wrote: false, reason: 'stdin-too-large' };
    }
    const seq = seqState.value;
    seqState.value += 1;
    const record = {
      capture_id: captureId,
      seq,
      received_at: isoNow(now),
      binding_tag: bindingTag ?? null,
      argv: Array.isArray(argv) ? argv.map(String) : [],
      source,
      env_subset: envSubset(env),
      stdin_raw: stdinRaw,
    };
    const wrote = appendLine(dest, `${JSON.stringify(record)}\n`);
    if (!wrote) {
      seqState.value = seq;
      return { wrote: false, reason: 'append' };
    }
    return { wrote: true, path: dest };
  } catch {
    return { wrote: false, reason: 'error' };
  }
}

export async function main(bindingTag) {
  try {
    const stdin = await readBounded(process.stdin);
    await recordHookEvent({
      env: process.env,
      stdin,
      argv: process.argv,
      bindingTag: bindingTag ?? process.argv[2] ?? null,
    });
  } catch {
    // exit 0 always
  }
}

function isMainModule(moduleUrl, argvPath) {
  if (typeof argvPath !== 'string' || argvPath.length === 0) return false;
  try {
    return pathToFileURL(resolve(argvPath)).href === moduleUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv[2]).then(
    () => { process.exitCode = 0; },
    () => { process.exitCode = 0; },
  );
}
