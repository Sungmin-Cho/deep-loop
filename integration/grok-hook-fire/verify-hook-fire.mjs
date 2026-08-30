import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const STDIN_MAX_BYTES = 256 * 1024;
const POSTCOMPACT_MAX_BYTES = 4096;
const SESSION_ID_MAX = 1024;
const CAPTURE_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const TRIGGERS = new Set(['manual', 'auto']);
const PRODUCTION_BINDING = Object.freeze({
  PreCompact: 'PreCompact:*',
  PostCompact: 'PostCompact:*',
  SessionStart: 'SessionStart:compact',
});
const TYPE_ORDER = Object.freeze(['PreCompact', 'PostCompact', 'SessionStart']);

function fail(reasons, extras = {}) {
  return { ok: false, verdict: 'FAIL', reasons, ...extras };
}

function pass(extras = {}) {
  return { ok: true, verdict: 'PASS', reasons: [], ...extras };
}

function withIdentity(result, { capture, source, version }) {
  return { ...result, capture, source, version };
}

function parseStdin(stdinRaw) {
  if (typeof stdinRaw !== 'string') return { error: 'stdin-not-string' };
  if (Buffer.byteLength(stdinRaw, 'utf8') > STDIN_MAX_BYTES) return { error: 'stdin-too-large' };
  try {
    const value = JSON.parse(stdinRaw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { error: 'stdin-not-object' };
    }
    return { value };
  } catch {
    return { error: 'stdin-malformed-json' };
  }
}

function sessionIdOf(body) {
  if (!Object.hasOwn(body, 'session_id')) return { error: 'session-id-missing' };
  const value = body.session_id;
  if (typeof value !== 'string' || value.length === 0 || value.length > SESSION_ID_MAX
    || /[\0\r\n]/.test(value)) {
    return { error: 'session-id-invalid' };
  }
  return { value };
}

function classify(body) {
  if (body.hook_event_name === 'PreCompact') {
    if (!TRIGGERS.has(body.trigger)) return { error: 'precompact-trigger' };
    return { type: 'PreCompact' };
  }
  if (body.hook_event_name === 'PostCompact') {
    if (!TRIGGERS.has(body.trigger)) return { error: 'postcompact-trigger' };
    if (typeof body.cwd !== 'string' || body.cwd.length === 0 || !isAbsolute(body.cwd)
      || /[\0]/.test(body.cwd)) {
      return { error: 'postcompact-cwd' };
    }
    return { type: 'PostCompact' };
  }
  if (body.hook_event_name === 'SessionStart') {
    if (body.source !== 'compact') return { error: 'sessionstart-source' };
    return { type: 'SessionStart' };
  }
  return { error: 'event-name' };
}

function parseEventsText(eventsText) {
  if (typeof eventsText !== 'string') return { error: 'events-not-text' };
  const lines = eventsText.split(/\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const records = [];
  for (const line of lines) {
    if (line.length === 0) return { error: 'empty-line' };
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { error: 'record-not-object' };
      }
      records.push(value);
    } catch {
      return { error: 'record-malformed-json' };
    }
  }
  return { records };
}

function requiredRecord(record) {
  const keys = [
    'capture_id', 'seq', 'received_at', 'binding_tag', 'argv',
    'source', 'env_subset', 'stdin_raw',
  ];
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) return `missing-key:${key}`;
  }
  if (!Number.isInteger(record.seq) || record.seq < 0) return 'seq';
  if (typeof record.received_at !== 'string' || Number.isNaN(Date.parse(record.received_at))) {
    return 'received-at';
  }
  if (!Array.isArray(record.argv)) return 'argv';
  if (record.env_subset === null || typeof record.env_subset !== 'object'
    || Array.isArray(record.env_subset)) {
    return 'env-subset';
  }
  return null;
}

export function verifyHookFire({
  eventsText,
  eventsPath,
  capture,
  source,
  version,
} = {}) {
  const identity = { capture, source, version };
  if (typeof capture !== 'string' || !CAPTURE_RE.test(capture)) {
    return withIdentity(fail(['capture-id']), identity);
  }
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    return withIdentity(fail(['version']), identity);
  }
  if (source !== 'claude-cache') {
    return withIdentity(fail(['source-not-claude-cache']), identity);
  }

  let text = eventsText;
  if (text === undefined && typeof eventsPath === 'string') {
    try {
      text = readFileSync(eventsPath, 'utf8');
    } catch {
      return withIdentity(fail(['events-unreadable']), identity);
    }
  }
  const parsed = parseEventsText(text);
  if (parsed.error) return withIdentity(fail([parsed.error]), identity);
  if (parsed.records.length !== 3) return withIdentity(fail(['event-count']), identity);

  const classified = [];
  const sessionIds = [];
  for (const record of parsed.records) {
    const shape = requiredRecord(record);
    if (shape) return withIdentity(fail([shape]), identity);
    if (record.capture_id !== capture) return withIdentity(fail(['mixed-capture-id']), identity);
    if (record.source !== 'claude-cache') return withIdentity(fail(['record-source']), identity);
    if (record.env_subset.GROK_HOME !== true) return withIdentity(fail(['grok-home-absent']), identity);
    if (record.env_subset.CLAUDE_CODE_ENTRYPOINT) {
      return withIdentity(fail(['claude-code-entrypoint']), identity);
    }
    const stdin = parseStdin(record.stdin_raw);
    if (stdin.error) return withIdentity(fail([stdin.error]), identity);
    const kind = classify(stdin.value);
    if (kind.error) return withIdentity(fail([kind.error]), identity);
    if (kind.type === 'PostCompact'
      && Buffer.byteLength(record.stdin_raw, 'utf8') > POSTCOMPACT_MAX_BYTES) {
      return withIdentity(fail(['postcompact-too-large']), identity);
    }
    const session = sessionIdOf(stdin.value);
    if (session.error) return withIdentity(fail([session.error]), identity);
    if (record.binding_tag !== PRODUCTION_BINDING[kind.type]) {
      return withIdentity(fail(['binding-tag']), identity);
    }
    sessionIds.push(session.value);
    classified.push({
      type: kind.type,
      received_at: record.received_at,
      index: classified.length,
      body: stdin.value,
    });
  }

  if (new Set(sessionIds).size !== 1) {
    return withIdentity(fail(['session-id-disagree']), identity);
  }
  const typeSet = classified.map((item) => item.type).sort();
  if (typeSet.join(',') !== 'PostCompact,PreCompact,SessionStart') {
    return withIdentity(fail(['type-set']), identity);
  }

  const ordered = [...classified].sort((left, right) => {
    const delta = Date.parse(left.received_at) - Date.parse(right.received_at);
    return delta !== 0 ? delta : left.index - right.index;
  });
  if (ordered.map((item) => item.type).join(',') !== TYPE_ORDER.join(',')) {
    return withIdentity(fail(['type-order']), identity);
  }
  const pre = Date.parse(ordered[0].received_at);
  const post = Date.parse(ordered[1].received_at);
  const start = Date.parse(ordered[2].received_at);
  if (!(pre <= post && post <= start)) {
    return withIdentity(fail(['received-at-order']), identity);
  }

  return pass({
    capture,
    version,
    source,
    session_id: sessionIds[0],
    events: classified.map((item) => item.type),
  });
}

export function formatVerifierReport(result) {
  const lines = [
    '# grok-hook-fire verifier',
    `verdict_reasons: ${(result.reasons || []).join(',') || 'none'}`,
    `capture: ${result.capture ?? ''}`,
    `version: ${result.version ?? ''}`,
    `source: ${result.source ?? ''}`,
  ];
  if (result.ok) {
    lines.push(`events: ${(result.events || []).join(',')}`);
  }
  lines.push(result.verdict);
  return `${lines.join('\n')}\n`;
}

export function parseVerifierArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--events' || key === '--capture' || key === '--source' || key === '--version') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.startsWith('--')) return { error: 'usage' };
      out[key.slice(2)] = value;
      i += 1;
    } else {
      return { error: 'usage' };
    }
  }
  if (!out.events || !out.capture || !out.source || !out.version) return { error: 'usage' };
  return out;
}

export function main(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr) {
  const parsed = parseVerifierArgv(argv);
  if (parsed.error) {
    stderr.write('usage: verify-hook-fire.mjs --events <jsonl> --capture <ulid> --source <claude-cache|grok-native> --version <semver>\n');
    return 2;
  }
  const result = verifyHookFire({
    eventsPath: parsed.events,
    capture: parsed.capture,
    source: parsed.source,
    version: parsed.version,
  });
  stdout.write(formatVerifierReport(result));
  return 0;
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
  process.exitCode = main();
}
