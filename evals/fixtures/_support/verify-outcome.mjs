import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const RESULT_PREFIX = '__DEEP_LOOP_OUTCOME_V1__';
const trustedWrite = process.stdout.write.bind(process.stdout);
const trustedStringify = JSON.stringify.bind(JSON);
const initialObjectToJSON = Object.prototype.toJSON;
const initialArrayToJSON = Array.prototype.toJSON;
const moduleUrl = process.env.DEEP_LOOP_OUTCOME_MODULE_URL;
const exportName = process.env.DEEP_LOOP_OUTCOME_EXPORT;
const encoded = process.env.DEEP_LOOP_OUTCOME_INPUTS;
const auth = JSON.parse(readFileSync(0, 'utf8'));
const key = Buffer.from(auth.key, 'base64url');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function emit(payload) {
  const body = trustedStringify(payload);
  const mac = createHmac('sha256', key).update(body).digest('hex');
  trustedWrite(`${RESULT_PREFIX}${Buffer.from(body).toString('base64url')}.${mac}\n`);
}

function assertJsonValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('OUTCOME_NON_JSON_VALUE');
    return;
  }
  if (typeof value !== 'object') throw new Error('OUTCOME_NON_JSON_VALUE');
  if (seen.has(value)) throw new Error('OUTCOME_NON_JSON_VALUE');
  seen.add(value);
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('OUTCOME_NON_JSON_VALUE');
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) assertJsonValue(item, seen);
  seen.delete(value);
}

if (key.length !== 32 || typeof auth.challenge !== 'string'
  || !/^[0-9a-f]{64}$/.test(auth.runner_sha256)
  || sha256(readFileSync(fileURLToPath(import.meta.url))) !== auth.runner_sha256) {
  process.exitCode = 1;
} else {
  emit({
    schema_version: 1, type: 'start', challenge: auth.challenge,
    runner_sha256: auth.runner_sha256,
  });

  const denyNetwork = () => { throw new Error('OUTCOME_NETWORK_FORBIDDEN'); };
  globalThis.fetch = denyNetwork;
  if ('WebSocket' in globalThis) globalThis.WebSocket = class { constructor() { denyNetwork(); } };
  if ('EventSource' in globalThis) globalThis.EventSource = class { constructor() { denyNetwork(); } };
  const http = (await import('node:http')).default;
  const http2 = (await import('node:http2')).default;
  const https = (await import('node:https')).default;
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  const dgram = (await import('node:dgram')).default;
  const dns = (await import('node:dns')).default;
  const dnsPromises = (await import('node:dns/promises')).default;
  for (const api of [http, https]) {
    api.request = denyNetwork;
    api.get = denyNetwork;
    api.ClientRequest = class { constructor() { denyNetwork(); } };
    if (api.Agent?.prototype) api.Agent.prototype.createConnection = denyNetwork;
  }
  http2.connect = denyNetwork;
  http2.createServer = denyNetwork;
  http2.createSecureServer = denyNetwork;
  net.connect = denyNetwork;
  net.createConnection = denyNetwork;
  net.createServer = denyNetwork;
  net.Socket.prototype.connect = denyNetwork;
  net.Server.prototype.listen = denyNetwork;
  tls.connect = denyNetwork;
  tls.createServer = denyNetwork;
  if (tls.TLSSocket?.prototype) tls.TLSSocket.prototype.connect = denyNetwork;
  dgram.createSocket = denyNetwork;
  if (dgram.Socket?.prototype) {
    dgram.Socket.prototype.bind = denyNetwork;
    dgram.Socket.prototype.connect = denyNetwork;
    dgram.Socket.prototype.send = denyNetwork;
  }
  for (const target of [dns, dns.promises, dnsPromises]) {
    for (const name of Object.keys(target || {})) {
      if (name === 'lookup' || name.startsWith('resolve') || name.startsWith('reverse')) target[name] = denyNetwork;
    }
  }
  for (const Resolver of [dns.Resolver, dnsPromises.Resolver]) {
    for (const name of Object.getOwnPropertyNames(Resolver?.prototype || {})) {
      if (name.startsWith('resolve') || name === 'reverse') Resolver.prototype[name] = denyNetwork;
    }
  }
  syncBuiltinESMExports();

  let terminal;
  try {
    if (!moduleUrl || !exportName || !encoded) throw new Error('OUTCOME_RUNNER_INPUT_MISSING');
    const inputs = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const candidate = await import(moduleUrl);
    if (typeof candidate[exportName] !== 'function') throw new Error('OUTCOME_EXPORT_MISSING');
    const actual = [];
    for (const args of inputs) {
      if (!Array.isArray(args)) throw new Error('OUTCOME_INPUT_INVALID');
      const value = structuredClone(await candidate[exportName](...structuredClone(args)));
      assertJsonValue(value);
      actual.push(value);
    }
    if (Object.prototype.toJSON !== initialObjectToJSON || Array.prototype.toJSON !== initialArrayToJSON) {
      throw new Error('OUTCOME_GLOBAL_TAMPER');
    }
    terminal = { schema_version: 1, type: 'terminal', challenge: auth.challenge, ok: true, actual };
  } catch (error) {
    terminal = {
      schema_version: 1, type: 'terminal', challenge: auth.challenge, ok: false,
      error: String(error?.message || error).slice(0, 512),
    };
  }
  emit(terminal);
}
