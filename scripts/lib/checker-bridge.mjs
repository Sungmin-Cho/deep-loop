import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isHeadlessInvocation } from './respawn.mjs';
import {
  locateDeepModelRouter,
  isTrustedInstalledCacheRouteTask,
  skillRootFromRouteTask,
} from './locate-deep-model-router.mjs';
import { pathWithin } from './fs-safe.mjs';
import { runtimeCapability, sessionRuntime } from './runtime.mjs';

const MAX_YAML_BYTES = 1024 * 1024;
const KNOWN_PLACEHOLDERS = new Set([
  'id', 'effort', 'native-effort', 'sandbox', 'mode', 'fresh-uuid', 'cwd', 'prompt',
]);
const SHELL_META = /[$`;|&><]/;
const WRITE_TOKENS = new Set([
  'acceptEdits', 'bypassPermissions', '--dangerously-skip-permissions',
  'workspace-write', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox',
  '--approve-for-me',
]);
const CLAUDE_VALUE_FLAGS = new Set([
  '--model', '--effort', '--permission-mode', '--allowedTools', '--allowed-tools',
]);
// `--strict-mcp-config` takes no value: it drops every MCP server the user's
// global config would otherwise load into the seat. deep-model-router 1.9.0
// ships it on both `to_claude` recipes, and an unknown token here is
// `mechanism-untrusted` — so without this entry a router that boots its Claude
// bridge seats lean is read as one whose recipe cannot be trusted.
const CLAUDE_BOOL_FLAGS = new Set(['-p', '--strict-mcp-config']);
const OPENAI_VALUE_FLAGS = new Set(['-m', '-c', '-s']);
const OPENAI_BOOL_FLAGS = new Set(['exec', '--skip-git-repo-check']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const HEX64 = /^[0-9a-f]{64}$/;
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUPERVISOR_VALUE_FLAGS = new Set([
  '--attempt-id', '--receipt-dir', '--deadline-seconds', '--grace-seconds',
  '--seat', '--runtime', '--transport-id', '--model-id', '--effort-native',
  '--output-schema', '--permission-mode', '--decision-fingerprint', '--policy-sha256',
  '--host-cli-version',
]);
const SUPERVISOR_FLAG_ORDER = [
  '--attempt-id', '--receipt-dir', '--deadline-seconds', '--grace-seconds',
  '--seat', '--runtime', '--transport-id', '--model-id', '--effort-native',
  '--output-schema', '--permission-mode', '--decision-fingerprint', '--policy-sha256',
  '--host-cli-version',
];
const SUPERVISOR_REQUIRED = [
  '--attempt-id', '--receipt-dir', '--deadline-seconds', '--grace-seconds',
  '--seat', '--runtime', '--transport-id', '--model-id', '--effort-native',
  '--output-schema',
];

export function python3Available(env = process.env) {
  const pathVar = env?.PATH;
  if (typeof pathVar !== 'string' || pathVar.length === 0) return false;
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const names = process.platform === 'win32' ? ['python3.exe', 'python.exe'] : ['python3'];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      try {
        if (!existsSync(full) || !statSync(full).isFile()) continue;
        accessSync(full, constants.X_OK);
        return true;
      } catch { /* next candidate */ }
    }
  }
  return false;
}

function commentStrippedLines(text) {
  return String(text).split(/\r?\n/).map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) return '';
    return line;
  });
}

function unquoteYamlScalar(value) {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    const inner = value.slice(1, -1);
    if (/\\[^"\\]/.test(inner)) return null;
    return inner.replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }
  return value;
}

export function scanTransports(yamlText, hostKey) {
  if (typeof yamlText !== 'string') {
    return { ok: false, reason: 'config-ambiguous', hosts: {} };
  }
  if (Buffer.byteLength(yamlText, 'utf8') > MAX_YAML_BYTES) {
    return { ok: false, reason: 'config-oversized', hosts: {} };
  }
  if (typeof hostKey !== 'string' || !/^[A-Za-z0-9_]+$/.test(hostKey)) {
    return { ok: false, reason: 'config-ambiguous', hosts: {} };
  }
  const lines = commentStrippedLines(yamlText);
  let inTransports = false;
  let transportsCount = 0;
  const hosts = Object.create(null);
  let currentHost = null;
  let currentDir = null;

  function fail(reason) {
    return { ok: false, reason, hosts: {} };
  }

  for (const raw of lines) {
    if (raw.length === 0) continue;
    if (raw.includes('\t')) return fail('config-ambiguous');
    const indent = raw.length - raw.trimStart().length;
    const content = raw.trimEnd();
    if (content.length === indent) continue;

    if (!inTransports) {
      if (indent === 0 && content === 'transports:') {
        transportsCount += 1;
        if (transportsCount > 1) return fail('config-ambiguous');
        inTransports = true;
        currentHost = null;
        currentDir = null;
        continue;
      }
      continue;
    }

    if (indent === 0) {
      if (content === 'transports:') return fail('config-ambiguous');
      inTransports = false;
      currentHost = null;
      currentDir = null;
      continue;
    }

    if (indent === 2) {
      const match = content.match(/^  ([A-Za-z0-9_]+):\s*$/);
      if (!match) return fail('config-ambiguous');
      currentHost = match[1];
      currentDir = null;
      if (hosts[currentHost]) return fail('config-ambiguous');
      hosts[currentHost] = { directions: Object.create(null) };
      continue;
    }

    if (indent === 4) {
      if (!currentHost) return fail('config-ambiguous');
      const withValue = content.match(/^    ([A-Za-z0-9_]+):\s+(.+)$/);
      const noValue = content.match(/^    ([A-Za-z0-9_]+):\s*$/);
      if (withValue) {
        const key = withValue[1];
        if (key === 'to_claude' || key === 'to_openai' || key.startsWith('to_')) {
          return fail('config-ambiguous');
        }
        currentDir = null;
        continue;
      }
      if (!noValue) return fail('config-ambiguous');
      currentDir = noValue[1];
      const host = hosts[currentHost];
      if (host.directions[currentDir]) return fail('config-ambiguous');
      host.directions[currentDir] = Object.create(null);
      continue;
    }

    if (indent === 6) {
      if (!currentHost || !currentDir) return fail('config-ambiguous');
      if (/ #/.test(content.slice(6))) return fail('config-ambiguous');
      const match = content.match(/^      ([A-Za-z0-9_]+):\s+(.+)$/);
      if (!match) return fail('config-ambiguous');
      const key = match[1];
      const value = match[2];
      if (value.startsWith('|') || value.startsWith('>')) return fail('config-ambiguous');
      if (key === 'verified' || key === 'isolation' || key.startsWith('mechanism')) {
        // `*` / `&` introduce YAML aliases and anchors only in plain scalars.
        // Inside the double-quoted mechanism shape this scanner already
        // accepts, they are literal argv bytes — notably the shipped
        // `Write(./**)` / `Edit(./**)` maker globs. Rejecting them there made
        // the whole config ambiguous before the requested grok host was ever
        // inspected. Parsing the quote with the same strict helper keeps bad
        // escapes fail-closed while preserving the plain-scalar alias guard.
        const quotedScalar = value.startsWith('"') && value.endsWith('"')
          && unquoteYamlScalar(value) !== null;
        if (value.includes('{')
          || (!quotedScalar && /[&*]/.test(value))
          || value.includes('<<:')) return fail('config-ambiguous');
      }
      const dir = hosts[currentHost].directions[currentDir];
      if (Object.hasOwn(dir, key)) return fail('config-ambiguous');
      dir[key] = value;
      continue;
    }

    return fail('config-ambiguous');
  }

  if (transportsCount === 0) return fail('config-ambiguous');
  return { ok: true, reason: null, hosts };
}

function splitWs(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

function parseToolList(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const tools = value.split(',');
  if (tools.length === 0 || tools.some((name) => name.length === 0)) return null;
  if (new Set(tools).size !== tools.length) return null;
  if (tools.some((name) => !READ_TOOLS.has(name))) return null;
  return tools;
}

function parseFlagPairs(rest, direction) {
  const pairs = [];
  const seen = new Set();
  const valueFlags = direction === 'to_claude' ? CLAUDE_VALUE_FLAGS : OPENAI_VALUE_FLAGS;
  const boolFlags = direction === 'to_claude' ? CLAUDE_BOOL_FLAGS : OPENAI_BOOL_FLAGS;
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    if (WRITE_TOKENS.has(token)) return { ok: false, reason: 'seat-not-readonly' };
    if (direction === 'to_claude' && (token.startsWith('--allowedTools=') || token.startsWith('--allowed-tools='))) {
      const flag = token.startsWith('--allowedTools=') ? '--allowedTools' : '--allowed-tools';
      const value = token.slice(token.indexOf('=') + 1);
      if (seen.has('--allowedTools')) return { ok: false, reason: 'mechanism-untrusted' };
      seen.add('--allowedTools');
      pairs.push([flag, value]);
      i += 1;
      continue;
    }
    if (boolFlags.has(token)) {
      if (seen.has(token)) return { ok: false, reason: 'mechanism-untrusted' };
      seen.add(token);
      pairs.push([token, true]);
      i += 1;
      continue;
    }
    if (valueFlags.has(token)) {
      const value = rest[i + 1];
      if (value === undefined) {
        if (token === '--allowedTools' || token === '--allowed-tools') {
          return { ok: false, reason: 'seat-not-readonly' };
        }
        return { ok: false, reason: 'mechanism-untrusted' };
      }
      if (WRITE_TOKENS.has(value)) return { ok: false, reason: 'seat-not-readonly' };
      const seenKey = (token === '--allowedTools' || token === '--allowed-tools') ? '--allowedTools' : token;
      if (seen.has(seenKey)) return { ok: false, reason: 'mechanism-untrusted' };
      seen.add(seenKey);
      pairs.push([token, value]);
      i += 2;
      continue;
    }
    if (token.includes(',')) return { ok: false, reason: 'seat-not-readonly' };
    return { ok: false, reason: 'mechanism-untrusted' };
  }
  return { ok: true, pairs, seen };
}

export function parseMechanism(rawValue, direction) {
  if (typeof rawValue !== 'string' || rawValue.length === 0) {
    return { ok: false, reason: 'mechanism-untrusted' };
  }
  const unquoted = unquoteYamlScalar(rawValue);
  if (unquoted === null) return { ok: false, reason: 'mechanism-untrusted' };
  if (!unquoted.endsWith(' "<prompt>"') && !unquoted.endsWith(" '<prompt>'")) {
    return { ok: false, reason: 'mechanism-untrusted' };
  }
  const head = unquoted.slice(0, unquoted.endsWith(' "<prompt>"') ? -' "<prompt>"'.length : -" '<prompt>'".length);
  if (head.includes('"') || head.includes("'")) return { ok: false, reason: 'mechanism-untrusted' };
  if (SHELL_META.test(head.replaceAll(/<[^>]+>/g, ''))) return { ok: false, reason: 'mechanism-untrusted' };
  const tokens = splitWs(head);
  if (tokens.length === 0) return { ok: false, reason: 'mechanism-untrusted' };
  for (const token of tokens) {
    const placeholders = [...token.matchAll(/<([^>]+)>/g)].map((match) => match[1]);
    if (placeholders.some((name) => !KNOWN_PLACEHOLDERS.has(name))) {
      return { ok: false, reason: 'mechanism-untrusted' };
    }
  }
  const argv0 = basename(tokens[0]);
  const expectedBin = direction === 'to_claude' ? 'claude' : direction === 'to_openai' ? 'codex' : null;
  if (!expectedBin || argv0 !== expectedBin) return { ok: false, reason: 'mechanism-untrusted' };

  const rest = tokens.slice(1);
  const parsedFlags = parseFlagPairs(rest, direction);
  if (!parsedFlags.ok) return { ok: false, reason: parsedFlags.reason };

  let readonlySeat = false;
  if (direction === 'to_claude') {
    const required = ['-p', '--model', '--effort', '--permission-mode', '--allowedTools'];
    if (required.some((flag) => !parsedFlags.seen.has(flag))) {
      if (!parsedFlags.seen.has('--allowedTools')) return { ok: false, reason: 'seat-not-readonly' };
      return { ok: false, reason: 'mechanism-untrusted' };
    }
    const mode = parsedFlags.pairs.find((pair) => pair[0] === '--permission-mode')?.[1];
    const toolsFlag = parsedFlags.pairs.find((pair) => pair[0] === '--allowedTools' || pair[0] === '--allowed-tools');
    const tools = parseToolList(toolsFlag?.[1]);
    if (mode !== 'plan' && mode !== '<mode>') return { ok: false, reason: 'seat-not-readonly' };
    if (!tools) return { ok: false, reason: 'seat-not-readonly' };
    readonlySeat = true;
  } else if (direction === 'to_openai') {
    const required = ['exec', '-m', '-c', '-s', '--skip-git-repo-check'];
    if (required.some((flag) => !parsedFlags.seen.has(flag))) {
      if (!parsedFlags.seen.has('-s')) return { ok: false, reason: 'seat-not-readonly' };
      return { ok: false, reason: 'mechanism-untrusted' };
    }
    const sandbox = parsedFlags.pairs.find((pair) => pair[0] === '-s')?.[1];
    const config = parsedFlags.pairs.find((pair) => pair[0] === '-c')?.[1];
    if (typeof config !== 'string' || !config.startsWith('model_reasoning_effort=')) {
      return { ok: false, reason: 'mechanism-untrusted' };
    }
    if (sandbox !== 'read-only' && sandbox !== '<sandbox>') return { ok: false, reason: 'seat-not-readonly' };
    readonlySeat = true;
  } else {
    return { ok: false, reason: 'mechanism-untrusted' };
  }

  return { ok: true, reason: null, tokens, argv0, readonlySeat };
}

function inspectDirection(block, direction) {
  const present = block !== undefined;
  const result = {
    present,
    isolation: null,
    verified: false,
    family: direction === 'to_claude' ? 'claude' : direction === 'to_openai' ? 'openai' : null,
    seat_source: null,
    readonly_seat: false,
    mechanism: null,
    reasons: [],
  };
  if (!present) {
    result.reasons.push(`transport-missing:${direction}`);
    return result;
  }
  if (!['to_claude', 'to_openai'].includes(direction)) {
    result.reasons.push(`direction-unknown:${direction}`);
    return result;
  }
  const isolation = block.isolation === undefined ? null : String(block.isolation);
  result.isolation = isolation;
  if (isolation !== 'separate_process') result.reasons.push(`isolation-untrusted:${direction}`);

  const verifiedRaw = block.verified === undefined ? null : String(block.verified);
  result.verified = verifiedRaw === 'true';
  if (verifiedRaw !== 'true') result.reasons.push(`transport-unverified:${direction}`);

  const reviewer = block.mechanism_reviewer;
  const generic = block.mechanism;
  const chosen = reviewer !== undefined ? reviewer : generic;
  result.seat_source = reviewer !== undefined ? 'mechanism_reviewer' : (generic !== undefined ? 'mechanism' : null);
  if (chosen === undefined) {
    result.reasons.push(`mechanism-missing:${direction}`);
    return result;
  }
  const parsed = parseMechanism(chosen, direction);
  if (!parsed.ok) {
    result.reasons.push(`${parsed.reason}:${direction}`);
    return result;
  }
  result.readonly_seat = parsed.readonlySeat;
  if (!parsed.readonlySeat) result.reasons.push(`seat-not-readonly:${direction}`);
  if (result.reasons.length === 0) result.mechanism = unquoteYamlScalar(chosen);
  return result;
}

export function probeCheckerBridge({
  loopData,
  home = homedir(),
  env = process.env,
  cwd = process.cwd(),
  locate = locateDeepModelRouter,
} = {}) {
  const reasons = [];
  const runtime = sessionRuntime(loopData);
  const attended = isHeadlessInvocation(env, runtime) === false
    && loopData?.autonomy?.spawn_style !== 'headless';
  const capability = runtimeCapability(runtime, 'independent_checker_bridge');
  const hostKey = runtimeCapability(runtime, 'observation_runtime');

  if (!attended) reasons.push('attended-required');
  if (capability === null) {
    return {
      ok: true,
      runtime,
      bridge: capability,
      attended,
      ready: false,
      router: null,
      python3: python3Available(env),
      directions: {},
      ready_directions: [],
      reasons: [`bridge-not-applicable:${runtime}`, ...reasons],
    };
  }

  const located = locate({ env, home, cwd });
  if (!located) {
    return emptyProbe(runtime, capability, attended, env, ['router-missing', ...reasons]);
  }
  if (!isTrustedInstalledCacheRouteTask(located, { home })) {
    return emptyProbe(runtime, capability, attended, env, ['router-untrusted-path', ...reasons]);
  }
  const skillRoot = skillRootFromRouteTask(located);
  if (!skillRoot) {
    return emptyProbe(runtime, capability, attended, env, ['router-untrusted-path', ...reasons]);
  }
  const dispatcher = join(skillRoot, 'scripts', 'dispatch_agent.py');
  const yamlPath = join(skillRoot, 'config', 'model-routing.yaml');
  let dispatcherReal;
  let yamlReal;
  try {
    if (!existsSync(dispatcher) || !statSync(dispatcher).isFile()) {
      return emptyProbe(runtime, capability, attended, env, ['dispatcher-missing', ...reasons], {
        router: { root: skillRoot, version: versionOf(located), dispatch_agent: dispatcher },
      });
    }
    dispatcherReal = realpathSync(dispatcher);
    yamlReal = realpathSync(yamlPath);
    if (!pathWithin(skillRoot, dispatcherReal) || !pathWithin(skillRoot, yamlReal)) {
      return emptyProbe(runtime, capability, attended, env, ['router-untrusted-path', ...reasons]);
    }
  } catch {
    return emptyProbe(runtime, capability, attended, env, ['dispatcher-missing', ...reasons]);
  }

  const python3 = python3Available(env);
  if (!python3) reasons.push('python3-unavailable');

  let yamlText;
  try {
    const yamlStat = statSync(yamlReal);
    if (!yamlStat.isFile()) {
      return emptyProbe(runtime, capability, attended, env, ['config-ambiguous', ...reasons], {
        router: { root: skillRoot, version: versionOf(located), dispatch_agent: dispatcherReal },
        python3,
      });
    }
    if (yamlStat.size > MAX_YAML_BYTES) {
      return emptyProbe(runtime, capability, attended, env, ['config-oversized', ...reasons], {
        router: { root: skillRoot, version: versionOf(located), dispatch_agent: dispatcherReal },
        python3,
      });
    }
    yamlText = readFileSync(yamlReal, 'utf8');
  } catch {
    return emptyProbe(runtime, capability, attended, env, ['transport-missing:to_claude', ...reasons], {
      router: { root: skillRoot, version: versionOf(located), dispatch_agent: dispatcherReal },
      python3,
    });
  }

  const scanned = scanTransports(yamlText, hostKey);
  if (!scanned.ok) {
    return emptyProbe(runtime, capability, attended, env, [scanned.reason, ...reasons], {
      router: { root: skillRoot, version: versionOf(located), dispatch_agent: dispatcherReal },
      python3,
    });
  }

  const host = scanned.hosts[hostKey];
  const directions = {};
  const readyDirections = [];
  for (const direction of ['to_claude', 'to_openai']) {
    const inspected = inspectDirection(host?.directions?.[direction], direction);
    directions[direction] = {
      present: inspected.present,
      isolation: inspected.isolation,
      verified: inspected.verified,
      family: inspected.family,
      seat_source: inspected.seat_source,
      readonly_seat: inspected.readonly_seat,
      mechanism: inspected.mechanism,
    };
    reasons.push(...inspected.reasons);
    if (inspected.reasons.length === 0) readyDirections.push(direction);
  }
  for (const name of Object.keys(host?.directions || {})) {
    if (name === 'native' || name === 'to_claude' || name === 'to_openai') continue;
    if (name.startsWith('to_')) reasons.push(`direction-unknown:${name}`);
  }

  const ready = attended && python3 && readyDirections.length > 0 && !reasons.includes('attended-required');
  return {
    ok: true,
    runtime,
    bridge: capability,
    attended,
    ready,
    router: { root: skillRoot, version: versionOf(located), dispatch_agent: dispatcherReal },
    python3,
    directions,
    ready_directions: ready ? readyDirections : [],
    reasons: unique(reasons),
  };
}

function emptyProbe(runtime, bridge, attended, env, reasons, extra = {}) {
  return {
    ok: true,
    runtime,
    bridge,
    attended,
    ready: false,
    router: extra.router || null,
    python3: extra.python3 ?? python3Available(env),
    directions: extra.directions || {},
    ready_directions: [],
    reasons: unique(reasons),
  };
}

function versionOf(routeTaskPath) {
  const match = String(routeTaskPath).replaceAll('\\', '/').match(/\/deep-model-router\/([^/]+)\//);
  return match ? match[1] : '';
}

function unique(values) {
  return [...new Set(values)];
}

export function expandAttestedMechanism(rawValue, {
  direction,
  model,
  effort,
  cwd,
  prompt,
} = {}) {
  const parsed = parseMechanism(rawValue, direction);
  if (!parsed.ok) return parsed;
  if (!parsed.readonlySeat) return { ok: false, reason: 'seat-not-readonly' };
  const replacements = {
    id: model,
    effort,
    'native-effort': effort,
    sandbox: 'read-only',
    mode: 'plan',
    cwd,
    prompt,
  };
  let unbound = null;
  const argv = parsed.tokens.map((token) => token.replaceAll(/<([^>]+)>/g, (_, name) => {
    if (!Object.hasOwn(replacements, name) || replacements[name] === undefined || replacements[name] === '') {
      unbound = name;
      return '';
    }
    return String(replacements[name]);
  }));
  if (unbound) return { ok: false, reason: 'mechanism-placeholder-unbound' };
  argv.push(String(prompt));
  return { ok: true, argv, readonlySeat: parsed.readonlySeat };
}

export function extractVerdictToken(text) {
  const matches = [...String(text).matchAll(/^verdict:\s*(PASS|PASS_WITH_CHANGES|FAIL)\s*$/gm)];
  if (matches.length !== 1) return { ok: false, reason: 'INVALID_OUTPUT' };
  return { ok: true, token: matches[0][1] };
}

export function mapBridgeVerdict(token) {
  if (token === 'PASS') return 'APPROVE';
  if (token === 'PASS_WITH_CHANGES' || token === 'FAIL') return 'REQUEST_CHANGES';
  return null;
}

export function materializeBridgeReport({ stdoutPath, expectedSha256, destPath }) {
  const bytes = readFileSync(stdoutPath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (typeof expectedSha256 !== 'string' || expectedSha256.length !== 64 || actual !== expectedSha256) {
    return { ok: false, reason: 'hash-mismatch', sha256: actual };
  }
  const extracted = extractVerdictToken(bytes.toString('utf8'));
  if (!extracted.ok) return { ok: false, reason: 'INVALID_OUTPUT', sha256: actual };
  const verdict = mapBridgeVerdict(extracted.token);
  if (!verdict) return { ok: false, reason: 'INVALID_OUTPUT', sha256: actual };
  writeFileSync(destPath, bytes, { flag: 'wx' });
  return { ok: true, sha256: actual, token: extracted.token, verdict };
}

export function isTrustedDispatcher(path, { home = homedir() } = {}) {
  if (typeof path !== 'string' || path.length === 0) return false;
  let real;
  try { real = realpathSync(path); } catch { return false; }
  if (basename(real) !== 'dispatch_agent.py') return false;
  return isTrustedInstalledCacheRouteTask(join(dirname(real), 'route_task.py'), { home });
}

function resolvePython3Token(token, env = process.env) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const name = basename(token);
  if (name !== 'python3' && name !== 'python3.exe') return null;
  if (token.includes('/') || token.includes('\\')) {
    try {
      const real = realpathSync(token);
      if (!statSync(real).isFile()) return null;
      return real;
    } catch { return null; }
  }
  const pathVar = env?.PATH;
  if (typeof pathVar !== 'string' || pathVar.length === 0) return null;
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const names = process.platform === 'win32' ? ['python3.exe', 'python.exe'] : ['python3'];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of names) {
      const full = join(dir, candidate);
      try {
        if (!existsSync(full) || !statSync(full).isFile()) continue;
        accessSync(full, constants.X_OK);
        return realpathSync(full);
      } catch { /* next */ }
    }
  }
  return null;
}

function parseSupervisorHead(head) {
  if (!Array.isArray(head) || head.length < 3 || head[2] !== 'run') {
    return { ok: false, reason: 'supervisor-untrusted' };
  }
  const flags = Object.create(null);
  let i = 3;
  while (i < head.length) {
    const token = head[i];
    if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'supervisor-untrusted' };
    if (WRITE_TOKENS.has(token) || token === '--bare' || token === '--prompt-file' || token.startsWith('--prompt-file')) {
      return { ok: false, reason: 'seat-not-readonly' };
    }
    if (token.includes('=') || !SUPERVISOR_VALUE_FLAGS.has(token) || Object.hasOwn(flags, token)) {
      return { ok: false, reason: 'supervisor-untrusted' };
    }
    const value = head[i + 1];
    if (value === undefined || typeof value !== 'string' || value.startsWith('-')) {
      return { ok: false, reason: 'supervisor-untrusted' };
    }
    flags[token] = value;
    i += 2;
  }
  return { ok: true, flags };
}

function containedSidecar(cwdReal, sidecarPath, attemptId) {
  let receiptsReal;
  try { receiptsReal = realpathSync(join(cwdReal, '.deep-review', 'bridge', 'receipts')); }
  catch { return { ok: false, reason: 'sidecar-uncontained' }; }
  const resolved = resolve(sidecarPath);
  if (basename(resolved) !== `${attemptId}-cwd.json`) return { ok: false, reason: 'sidecar-uncontained' };
  let parentReal;
  try { parentReal = realpathSync(dirname(resolved)); } catch { return { ok: false, reason: 'sidecar-uncontained' }; }
  if (parentReal !== receiptsReal) return { ok: false, reason: 'sidecar-uncontained' };
  const dest = join(parentReal, basename(resolved));
  if (existsSync(dest)) return { ok: false, reason: 'sidecar-exists' };
  return { ok: true, sidecar: dest };
}

export function bindBridgeExec({
  cwdFlag,
  sidecar,
  dispatcher,
  mechanism,
  direction,
  model,
  effort,
  prompt,
  supervisorArgv,
  home = homedir(),
  env = process.env,
} = {}) {
  if (!cwdFlag || !sidecar || !dispatcher || !mechanism || !direction || !model || !effort || prompt === undefined || prompt === null || prompt === '') {
    return { ok: false, reason: 'usage' };
  }
  if (direction !== 'to_claude' && direction !== 'to_openai') return { ok: false, reason: 'direction-unknown' };
  if (!Array.isArray(supervisorArgv) || supervisorArgv.length === 0) return { ok: false, reason: 'usage' };

  let cwd;
  try { cwd = realpathSync(cwdFlag); } catch { return { ok: false, reason: 'cwd-unresolvable' }; }
  const expanded = expandAttestedMechanism(mechanism, { direction, model, effort, prompt, cwd });
  if (!expanded.ok) return { ok: false, reason: expanded.reason };

  if (!isTrustedDispatcher(dispatcher, { home })) return { ok: false, reason: 'dispatcher-untrusted' };
  let dispatcherReal;
  try { dispatcherReal = realpathSync(dispatcher); } catch { return { ok: false, reason: 'dispatcher-untrusted' }; }

  const inner = supervisorArgv.indexOf('--');
  const head = inner === -1 ? supervisorArgv : supervisorArgv.slice(0, inner);
  const tail = inner === -1 ? [] : supervisorArgv.slice(inner + 1);
  if (tail.length > 0 && JSON.stringify(tail) !== JSON.stringify(expanded.argv)) {
    return { ok: false, reason: 'argv-mismatch' };
  }
  if (head.length < 3) return { ok: false, reason: 'supervisor-untrusted' };
  const pythonReal = resolvePython3Token(head[0], env);
  if (!pythonReal) return { ok: false, reason: 'supervisor-untrusted' };
  let headDispatcher;
  try { headDispatcher = realpathSync(head[1]); } catch { return { ok: false, reason: 'dispatcher-untrusted' }; }
  if (headDispatcher !== dispatcherReal) return { ok: false, reason: 'dispatcher-mismatch' };
  const parsedHead = parseSupervisorHead([pythonReal, dispatcherReal, ...head.slice(2)]);
  if (!parsedHead.ok) return parsedHead;
  const flags = parsedHead.flags;
  if (SUPERVISOR_REQUIRED.some((flag) => !Object.hasOwn(flags, flag))) {
    return { ok: false, reason: 'supervisor-untrusted' };
  }
  if (flags['--output-schema'] !== 'review') return { ok: false, reason: 'supervisor-untrusted' };
  const supervisorRuntime = runtimeCapability('grok', 'observation_runtime');
  if (flags['--runtime'] !== supervisorRuntime) return { ok: false, reason: 'supervisor-untrusted' };
  if (flags['--transport-id'] !== `${supervisorRuntime}.${direction}`) return { ok: false, reason: 'supervisor-untrusted' };
  if (flags['--model-id'] !== String(model)) return { ok: false, reason: 'argv-mismatch' };
  if (flags['--effort-native'] !== String(effort)) return { ok: false, reason: 'argv-mismatch' };
  const attemptId = flags['--attempt-id'];
  if (!ATTEMPT_ID.test(attemptId)) return { ok: false, reason: 'supervisor-untrusted' };
  if (!['reviewer-1', 'reviewer-2'].includes(flags['--seat'])) return { ok: false, reason: 'supervisor-untrusted' };
  if (!/^[1-9][0-9]{0,5}$/.test(flags['--deadline-seconds'])) return { ok: false, reason: 'supervisor-untrusted' };
  if (!/^[1-9][0-9]{0,3}$/.test(flags['--grace-seconds'])) return { ok: false, reason: 'supervisor-untrusted' };
  if (flags['--permission-mode'] && flags['--permission-mode'] !== 'read-only' && flags['--permission-mode'] !== 'plan') {
    return { ok: false, reason: 'seat-not-readonly' };
  }
  if (flags['--decision-fingerprint'] && !HEX64.test(flags['--decision-fingerprint'])) {
    return { ok: false, reason: 'supervisor-untrusted' };
  }
  if (flags['--policy-sha256'] && !HEX64.test(flags['--policy-sha256'])) {
    return { ok: false, reason: 'supervisor-untrusted' };
  }

  let receiptsReal;
  try { receiptsReal = realpathSync(join(cwd, '.deep-review', 'bridge', 'receipts')); }
  catch { return { ok: false, reason: 'sidecar-uncontained' }; }
  let receiptDirReal;
  try { receiptDirReal = realpathSync(flags['--receipt-dir']); } catch { return { ok: false, reason: 'sidecar-uncontained' }; }
  if (receiptDirReal !== receiptsReal) return { ok: false, reason: 'sidecar-uncontained' };

  const boundSidecar = containedSidecar(cwd, sidecar, attemptId);
  if (!boundSidecar.ok) return boundSidecar;

  const reconstructed = [pythonReal, dispatcherReal, 'run'];
  for (const flag of SUPERVISOR_FLAG_ORDER) {
    if (Object.hasOwn(flags, flag)) reconstructed.push(flag, flags[flag]);
  }
  const spawnArgv = [...reconstructed, '--', ...expanded.argv];
  const argvSha256 = createHash('sha256').update(JSON.stringify(spawnArgv)).digest('hex');
  const sidecarPayload = {
    cwd_realpath: cwd,
    argv_sha256: argvSha256,
    dispatcher: dispatcherReal,
    direction,
    mechanism_sha256: createHash('sha256').update(String(mechanism)).digest('hex'),
    attempt_id: attemptId,
  };
  return {
    ok: true,
    cwd,
    sidecar: boundSidecar.sidecar,
    spawnArgv,
    sidecarPayload,
  };
}

function containedDest(cwdReal, destPath) {
  let bridgeReal;
  let destDirReal;
  try {
    bridgeReal = realpathSync(join(cwdReal, '.deep-review', 'bridge'));
    destDirReal = realpathSync(dirname(resolve(destPath)));
  } catch { return { ok: false, reason: 'dest-uncontained' }; }
  const destResolved = resolve(destPath);
  if (!pathWithin(bridgeReal, destDirReal)) return { ok: false, reason: 'dest-uncontained' };
  const receipts = join(bridgeReal, 'receipts');
  try {
    if (existsSync(receipts)) {
      const receiptsReal = realpathSync(receipts);
      if (pathWithin(receiptsReal, destDirReal)) return { ok: false, reason: 'dest-uncontained' };
    }
  } catch { /* receipts dir optional */ }
  if (existsSync(destResolved)) return { ok: false, reason: 'dest-exists' };
  if (!destResolved.endsWith('.md')) return { ok: false, reason: 'dest-uncontained' };
  return { ok: true, destPath: destResolved };
}

export function materializeFromReceipt({
  receiptPath,
  attemptId,
  destPath,
  cwdFlag,
  expectedSha256,
  stdoutPath,
  sidecarPath,
} = {}) {
  if (!receiptPath || !attemptId || !destPath || !cwdFlag) {
    return { ok: false, reason: 'usage' };
  }
  if (!ATTEMPT_ID.test(attemptId)) return { ok: false, reason: 'attempt-id-invalid' };
  let cwdReal;
  try { cwdReal = realpathSync(cwdFlag); } catch { return { ok: false, reason: 'cwd-unresolvable' }; }
  const dest = containedDest(cwdReal, destPath);
  if (!dest.ok) return dest;

  let receiptReal;
  try { receiptReal = realpathSync(receiptPath); } catch { return { ok: false, reason: 'receipt-unreadable' }; }
  if (basename(receiptReal) !== `${attemptId}.json`) return { ok: false, reason: 'receipt-mismatch' };
  try {
    const receiptsReal = realpathSync(join(cwdReal, '.deep-review', 'bridge', 'receipts'));
    if (!pathWithin(receiptsReal, receiptReal)) return { ok: false, reason: 'receipt-uncontained' };
  } catch { return { ok: false, reason: 'receipt-uncontained' }; }

  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptReal, 'utf8')); }
  catch { return { ok: false, reason: 'receipt-unreadable' }; }
  if (receipt?.attempt_id !== attemptId) return { ok: false, reason: 'receipt-mismatch' };
  if (receipt?.result?.state !== 'SUCCEEDED') return { ok: false, reason: 'receipt-not-succeeded' };
  if (receipt?.output_schema !== 'review') return { ok: false, reason: 'receipt-not-succeeded' };
  if (receipt?.result?.schema_valid !== true) return { ok: false, reason: 'receipt-not-succeeded' };
  if (receipt?.result?.termination_confirmed !== true) return { ok: false, reason: 'receipt-not-succeeded' };
  const digest = receipt?.result?.output_sha256;
  if (typeof digest !== 'string' || !HEX64.test(digest)) return { ok: false, reason: 'receipt-not-succeeded' };
  if (expectedSha256 !== undefined && expectedSha256 !== digest) return { ok: false, reason: 'hash-mismatch' };

  const receiptStdout = receipt?.result?.stdout_path;
  if (typeof receiptStdout !== 'string' || receiptStdout.length === 0) {
    return { ok: false, reason: 'receipt-not-succeeded' };
  }
  let stdoutReal;
  try { stdoutReal = realpathSync(receiptStdout); } catch { return { ok: false, reason: 'stdout-unreadable' }; }
  if (stdoutPath) {
    let callerStdout;
    try { callerStdout = realpathSync(stdoutPath); } catch { return { ok: false, reason: 'stdout-unreadable' }; }
    if (callerStdout !== stdoutReal) return { ok: false, reason: 'stdout-mismatch' };
  }
  try {
    const receiptsReal = realpathSync(join(cwdReal, '.deep-review', 'bridge', 'receipts'));
    if (!pathWithin(receiptsReal, stdoutReal)) return { ok: false, reason: 'stdout-uncontained' };
  } catch { return { ok: false, reason: 'stdout-uncontained' }; }

  if (sidecarPath) {
    let sidecar;
    try { sidecar = JSON.parse(readFileSync(realpathSync(sidecarPath), 'utf8')); }
    catch { return { ok: false, reason: 'sidecar-mismatch' }; }
    if (sidecar?.cwd_realpath !== cwdReal) return { ok: false, reason: 'sidecar-mismatch' };
    if (sidecar?.attempt_id && sidecar.attempt_id !== attemptId) return { ok: false, reason: 'sidecar-mismatch' };
  }

  return materializeBridgeReport({
    stdoutPath: stdoutReal,
    expectedSha256: digest,
    destPath: dest.destPath,
  });
}
