import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexExecEntry,
  buildMinimalCodexEnv,
  codexIsolationProfileDigest,
} from '../../scripts/lib/codex-runtime.mjs';

const BIN = '/opt/codex/bin/codex';
const ROOT = 'C:\\Work Trees\\repo.v1';
const PROMPT = 'Read the absolute resume skill and execute it inline.';

test('buildCodexExecEntry returns the exact isolated stdin-only descriptor', () => {
  const entry = buildCodexExecEntry({ executable: BIN, projectRoot: ROOT, prompt: PROMPT });

  assert.deepEqual(entry, {
    bin: BIN,
    dispatch_kind: 'codex-model-call-v1',
    argv: [
      'exec', '--ephemeral', '--json', '--strict-config',
      '--ignore-user-config', '--ignore-rules',
      '--disable', 'apps', '--disable', 'plugins',
      '--disable', 'browser_use', '--disable', 'browser_use_external',
      '--disable', 'computer_use', '--disable', 'image_generation',
      '--disable', 'in_app_browser',
      '--sandbox', 'workspace-write',
      '-c', 'approval_policy="never"',
      '-c', 'web_search="disabled"',
      '-c', 'sandbox_workspace_write.network_access=false',
      '-c', 'features.skill_mcp_dependency_install=false',
      '-c', 'shell_environment_policy.inherit="core"',
      '-C', ROOT, '-',
    ],
    stdin: PROMPT,
    shell: false,
  });
  assert.ok(!entry.argv.includes(PROMPT), 'prompt must only be supplied on stdin');
  assert.ok(!entry.argv.includes('--profile'), 'named profiles are forbidden');
  assert.ok(!entry.argv.includes('--add-dir'), 'additional writable roots are forbidden');
  assert.equal(
    entry.argv.some(value => typeof value === 'string' && value.startsWith('projects.')),
    false,
    'Codex 0.144.1 strict config rejects projects.<path>.trust_level command-line overrides',
  );
});

test('buildCodexExecEntry maps model and supported effort without weakening isolation', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    const entry = buildCodexExecEntry({ executable: BIN, projectRoot: '/repo', prompt: PROMPT, model: 'gpt-5.4', effort });
    const modelAt = entry.argv.indexOf('--model');
    assert.deepEqual(entry.argv.slice(modelAt, modelAt + 2), ['--model', 'gpt-5.4']);
    assert.ok(entry.argv.includes(`model_reasoning_effort="${effort}"`), effort);
    assert.equal(entry.argv.at(-1), '-');
    assert.equal(entry.shell, false);
  }
});

test('buildCodexExecEntry permits only the explicit read-only preflight sandbox override', () => {
  const readOnly = buildCodexExecEntry({
    executable: BIN,
    projectRoot: '/repo',
    prompt: PROMPT,
    sandbox: 'read-only',
  });
  assert.equal(readOnly.argv[readOnly.argv.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(readOnly.argv.includes('sandbox_workspace_write.network_access=false'));
  assert.equal(readOnly.shell, false);

  for (const sandbox of ['', 'danger-full-access', 'workspace-read', null]) {
    assert.throws(
      () => buildCodexExecEntry({ executable: BIN, projectRoot: '/repo', prompt: PROMPT, sandbox }),
      /INVALID_CODEX_SANDBOX/,
      String(sandbox),
    );
  }
});

test('buildCodexExecEntry fails closed for Codex max effort and non-absolute executables', () => {
  assert.throws(
    () => buildCodexExecEntry({ executable: BIN, projectRoot: '/repo', prompt: PROMPT, effort: 'max' }),
    /UNSUPPORTED_RUNTIME_EFFORT/,
  );
  for (const executable of ['codex', './codex', '', null]) {
    assert.throws(
      () => buildCodexExecEntry({ executable, projectRoot: '/repo', prompt: PROMPT }),
      /INVALID_CODEX_EXECUTABLE/,
      String(executable),
    );
  }
  assert.equal(
    buildCodexExecEntry({ executable: 'C:\\trusted\\codex.exe', projectRoot: '/repo', prompt: PROMPT }).bin,
    'C:\\trusted\\codex.exe',
  );
});

test('buildCodexExecEntry rejects non-absolute project roots', () => {
  for (const projectRoot of ['relative/repo', './repo', 'C:relative', '']) {
    assert.throws(
      () => buildCodexExecEntry({ executable: BIN, projectRoot, prompt: PROMPT }),
      /INVALID_CODEX_PROJECT_ROOT/,
      JSON.stringify(projectRoot),
    );
  }
});

test('buildMinimalCodexEnv keeps only POSIX core variables and overrides hostile required fields', () => {
  const env = buildMinimalCodexEnv({
    platform: 'linux',
    sourceEnv: {
      PATH: '/usr/bin', HOME: '/home/agent', USER: 'agent', LANG: 'C.UTF-8', TMPDIR: '/tmp',
      CODEX_HOME: '/hostile/codex-home', DEEP_LOOP_UNATTENDED: '0', DEEP_LOOP_HEADLESS: '0',
      DEEP_LOOP_RUN_ID: 'wrong', DEEP_LOOP_PROJECT_ROOT: '/wrong', DEEP_LOOP_OWNER: 'wrong', DEEP_LOOP_GENERATION: '999',
      CLAUDE_CONFIG_DIR: '/secret', OPENAI_API_KEY: 'secret', MCP_SERVER_TOKEN: 'secret', NODE_OPTIONS: '--require evil',
    },
    codexHome: '/authenticated/codex-home',
    runId: 'run-1',
    projectRoot: '/repo',
    owner: 'run-1',
    generation: 7,
  });

  assert.deepEqual(env, {
    PATH: '/usr/bin', HOME: '/home/agent', USER: 'agent', LANG: 'C.UTF-8', TMPDIR: '/tmp',
    CODEX_HOME: '/authenticated/codex-home',
    DEEP_LOOP_UNATTENDED: '1',
    DEEP_LOOP_HEADLESS: '1',
    DEEP_LOOP_RUN_ID: 'run-1',
    DEEP_LOOP_PROJECT_ROOT: '/repo',
    DEEP_LOOP_OWNER: 'run-1',
    DEEP_LOOP_GENERATION: '7',
  });
});

test('buildMinimalCodexEnv uses an explicit Windows core allowlist', () => {
  const env = buildMinimalCodexEnv({
    platform: 'win32',
    sourceEnv: {
      Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.EXE;.CMD', TEMP: 'C:\\Temp', TMP: 'C:\\Temp', USERPROFILE: 'C:\\Users\\Agent',
      HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\Agent', APPDATA: 'C:\\Users\\Agent\\AppData',
      CLAUDE_CODE_ENTRYPOINT: 'sdk', PLUGIN_TOKEN: 'secret',
    },
    codexHome: 'C:\\CodexHome',
    runId: 'run-2',
    projectRoot: 'C:\\repo',
    owner: 'run-1',
    generation: 2,
  });

  assert.deepEqual(env, {
    Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.EXE;.CMD', TEMP: 'C:\\Temp', TMP: 'C:\\Temp', USERPROFILE: 'C:\\Users\\Agent',
    HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\Agent',
    CODEX_HOME: 'C:\\CodexHome',
    DEEP_LOOP_UNATTENDED: '1', DEEP_LOOP_HEADLESS: '1',
    DEEP_LOOP_RUN_ID: 'run-2', DEEP_LOOP_PROJECT_ROOT: 'C:\\repo',
    DEEP_LOOP_OWNER: 'run-1', DEEP_LOOP_GENERATION: '2',
  });
});

test('buildMinimalCodexEnv validates required strings and integer generation', () => {
  const valid = { sourceEnv: {}, codexHome: '/home', runId: 'run', projectRoot: '/repo', owner: 'run', generation: 1 };
  for (const key of ['codexHome', 'runId', 'projectRoot', 'owner']) {
    assert.throws(() => buildMinimalCodexEnv({ ...valid, [key]: '' }), /INVALID_CODEX_ENV/, key);
  }
  for (const generation of ['1', 1.5, NaN, null]) {
    assert.throws(() => buildMinimalCodexEnv({ ...valid, generation }), /INVALID_CODEX_ENV/, String(generation));
  }
});

test('codexIsolationProfileDigest is stable across object key order and detects changes', () => {
  const a = codexIsolationProfileDigest({ shell: false, argv: ['exec', '--ephemeral'], env: { B: '2', A: '1' } });
  const b = codexIsolationProfileDigest({ env: { A: '1', B: '2' }, argv: ['exec', '--ephemeral'], shell: false });
  const changed = codexIsolationProfileDigest({ shell: false, argv: ['exec'], env: { A: '1', B: '2' } });
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, changed);
});

test('codexIsolationProfileDigest rejects cyclic profiles fail-closed', () => {
  const cyclicObject = {};
  cyclicObject.self = cyclicObject;
  const cyclicArray = [];
  cyclicArray.push(cyclicArray);
  assert.throws(() => codexIsolationProfileDigest(cyclicObject), /INVALID_CODEX_ISOLATION_PROFILE/);
  assert.throws(() => codexIsolationProfileDigest(cyclicArray), /INVALID_CODEX_ISOLATION_PROFILE/);
});
