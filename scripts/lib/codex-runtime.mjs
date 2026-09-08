import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { validateRuntimeProfile } from './session-profile.mjs';
import { tomlBasicString } from './toml-safe.mjs';
import { isCanonicalCodexProviderThreadId } from './usage-parser.mjs';

const POSIX_CORE_ENV = Object.freeze([
  ['PATH', ['PATH']],
  ['HOME', ['HOME']],
  ['USER', ['USER']],
  ['LOGNAME', ['LOGNAME']],
  ['SHELL', ['SHELL']],
  ['LANG', ['LANG']],
  ['LC_ALL', ['LC_ALL']],
  ['LC_CTYPE', ['LC_CTYPE']],
  ['TMPDIR', ['TMPDIR']],
  ['TMP', ['TMP']],
  ['TEMP', ['TEMP']],
]);

const WINDOWS_CORE_ENV = Object.freeze([
  ['Path', ['Path', 'PATH']],
  ['SystemRoot', ['SystemRoot', 'SYSTEMROOT']],
  ['ComSpec', ['ComSpec', 'COMSPEC']],
  ['PATHEXT', ['PATHEXT']],
  ['TEMP', ['TEMP']],
  ['TMP', ['TMP']],
  ['USERPROFILE', ['USERPROFILE']],
  ['HOMEDRIVE', ['HOMEDRIVE']],
  ['HOMEPATH', ['HOMEPATH']],
]);

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error(`INVALID_CODEX_ENV: ${name} must be a non-empty string`), { code: 'INVALID_CODEX_ENV' });
  }
  return value;
}

function absoluteExecutable(value) {
  if (typeof value !== 'string' || value.length === 0 || (!posix.isAbsolute(value) && !win32.isAbsolute(value))) {
    throw Object.assign(new Error('INVALID_CODEX_EXECUTABLE: an explicit absolute executable is required'), { code: 'INVALID_CODEX_EXECUTABLE' });
  }
  return value;
}

export function buildCodexExecEntry({
  executable,
  projectRoot,
  prompt,
  model = null,
  effort = null,
  sandbox = 'workspace-write',
  goalDriven = false,
} = {}) {
  const bin = absoluteExecutable(executable);
  if (typeof goalDriven !== 'boolean') {
    throw Object.assign(new Error('INVALID_CODEX_GOAL_MODE: goalDriven must be boolean'), {
      code: 'INVALID_CODEX_GOAL_MODE',
    });
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0 || (!posix.isAbsolute(projectRoot) && !win32.isAbsolute(projectRoot))) {
    throw Object.assign(new Error('INVALID_CODEX_PROJECT_ROOT: expected absolute path'), { code: 'INVALID_CODEX_PROJECT_ROOT' });
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw Object.assign(new Error('INVALID_CODEX_PROMPT: expected non-empty string'), { code: 'INVALID_CODEX_PROMPT' });
  }
  if (sandbox !== 'workspace-write' && sandbox !== 'read-only') {
    throw Object.assign(new Error('INVALID_CODEX_SANDBOX: expected workspace-write or read-only'), { code: 'INVALID_CODEX_SANDBOX' });
  }
  const profile = validateRuntimeProfile('codex', { model, effort }, { goalDriven });
  const modelArgs = profile.model == null ? [] : ['--model', profile.model];
  const effortArgs = profile.effort == null ? [] : ['-c', `model_reasoning_effort=${tomlBasicString(profile.effort)}`];

  return {
    bin,
    dispatch_kind: 'codex-model-call-v1',
    argv: [
      'exec', '--ephemeral', '--json', '--strict-config',
      '--ignore-user-config', '--ignore-rules',
      '--disable', 'apps', '--disable', 'plugins',
      '--disable', 'browser_use', '--disable', 'browser_use_external',
      '--disable', 'computer_use', '--disable', 'image_generation',
      '--disable', 'in_app_browser',
      '--sandbox', sandbox,
      ...modelArgs,
      ...effortArgs,
      '-c', 'approval_policy="never"',
      '-c', 'web_search="disabled"',
      '-c', 'sandbox_workspace_write.network_access=false',
      '-c', 'features.skill_mcp_dependency_install=false',
      '-c', 'shell_environment_policy.inherit="core"',
      '-C', projectRoot, '-',
    ],
    stdin: prompt,
    shell: false,
  };
}

export function buildCodexGoalOwnerEntry({
  executable,
  projectRoot,
  prompt,
  model = null,
  effort = null,
  sandbox = 'workspace-write',
  providerThreadId = null,
  isolationProfile = 'strict',
} = {}) {
  if (isolationProfile !== 'strict') {
    throw Object.assign(new Error('INVALID_CODEX_ISOLATION_PROFILE: expected strict'), {
      code: 'INVALID_CODEX_ISOLATION_PROFILE',
    });
  }
  if (providerThreadId !== null
    && !isCanonicalCodexProviderThreadId(providerThreadId)) {
    throw Object.assign(new Error('INVALID_CODEX_PROVIDER_THREAD_ID: expected canonical UUID'), {
      code: 'INVALID_CODEX_PROVIDER_THREAD_ID',
    });
  }

  const legacyShape = buildCodexExecEntry({
    executable,
    projectRoot,
    prompt,
    model,
    effort,
    sandbox,
    goalDriven: true,
  });
  const argv = [...legacyShape.argv];
  if (argv[0] !== 'exec' || argv[1] !== '--ephemeral' || argv.at(-1) !== '-') {
    throw Object.assign(new Error('INVALID_CODEX_OWNER_BASE: unexpected exec descriptor'), {
      code: 'INVALID_CODEX_OWNER_BASE',
    });
  }
  argv.splice(1, 1);
  argv.pop();
  const projectRootAt = argv.indexOf('-C');
  argv.splice(projectRootAt, 0,
    '--disable', 'hooks',
    '--disable', 'memories',
    '--disable', 'multi_agent',
    '--enable', 'skip_host_skill_discovery',
    '-c', 'project_doc_max_bytes=0');
  if (providerThreadId == null) argv.push('-');
  else argv.push('resume', providerThreadId, '-');

  return {
    ...legacyShape,
    argv,
    captureProviderThreadId: true,
  };
}

export function buildMinimalCodexEnv({
  platform = process.platform,
  sourceEnv = {},
  codexHome,
  runId,
  projectRoot,
  owner,
  generation,
} = {}) {
  if (sourceEnv === null || typeof sourceEnv !== 'object' || Array.isArray(sourceEnv)) {
    throw Object.assign(new Error('INVALID_CODEX_ENV: sourceEnv must be an object'), { code: 'INVALID_CODEX_ENV' });
  }
  const required = {
    CODEX_HOME: requiredString(codexHome, 'codexHome'),
    DEEP_LOOP_RUN_ID: requiredString(runId, 'runId'),
    DEEP_LOOP_PROJECT_ROOT: requiredString(projectRoot, 'projectRoot'),
    DEEP_LOOP_OWNER: requiredString(owner, 'owner'),
  };
  if (!Number.isInteger(generation)) {
    throw Object.assign(new Error('INVALID_CODEX_ENV: generation must be an integer'), { code: 'INVALID_CODEX_ENV' });
  }

  const env = {};
  const allowlist = platform === 'win32' ? WINDOWS_CORE_ENV : POSIX_CORE_ENV;
  for (const [outputName, candidates] of allowlist) {
    const inputName = candidates.find((name) => typeof sourceEnv[name] === 'string');
    if (inputName !== undefined) env[outputName] = sourceEnv[inputName];
  }
  return {
    ...env,
    ...required,
    DEEP_LOOP_UNATTENDED: '1',
    DEEP_LOOP_HEADLESS: '1',
    DEEP_LOOP_GENERATION: String(generation),
  };
}

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object') throw new Error('INVALID_CODEX_ISOLATION_PROFILE: expected JSON value');
  if (seen.has(value)) throw new Error('INVALID_CODEX_ISOLATION_PROFILE: cyclic value');
  seen.add(value);
  const encoded = Array.isArray(value)
    ? `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return encoded;
}

export function codexIsolationProfileDigest(profile) {
  return createHash('sha256').update(canonicalJson(profile)).digest('hex');
}
