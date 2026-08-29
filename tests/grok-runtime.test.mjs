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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  SESSION_RUNTIMES,
  RUNTIME_CAPABILITIES,
  runtimeCapability,
  skillToken,
  validateSessionRuntime,
} from '../scripts/lib/runtime.mjs';
import { buildInitialLoop, initRun } from '../scripts/lib/initrun.mjs';
import { acquireLease } from '../scripts/lib/lease.mjs';
import { acquireRecovery } from '../scripts/lib/recover.mjs';
import { acquireRootRecovery } from '../scripts/lib/project-root-recovery.mjs';
import { buildRuntimeResumeDescriptor } from '../scripts/lib/runtime-descriptor.mjs';
import {
  approveRuntimeExecutable,
  diagnoseRuntimeExecutable,
  resolveTrustedRuntimeExecutable,
  revalidateTrustedRuntimeExecutable,
} from '../scripts/lib/runtime-executable.mjs';
import { validateRuntimeProfile, EFFORT_LEVELS } from '../scripts/lib/session-profile.mjs';
import { isHeadlessInvocation } from '../scripts/lib/respawn.mjs';
import { respawn } from '../scripts/lib/respawn.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { offerDesktop, confirmDesktop } from '../scripts/lib/spawn-optin.mjs';
import { driveHeadless, driveHeadlessRun } from '../scripts/lib/headless-host.mjs';
import { dispatchReview } from '../scripts/lib/review.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { detectPlugins } from '../scripts/lib/detect.mjs';
import { approveAttendedLaunch } from '../scripts/lib/attended-launch.mjs';
import { validate } from '../scripts/lib/schema.mjs';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { migrateAuthenticLegacyTransport } from './helpers/legacy-transport.mjs';
import { canonicalRealpath, createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'deep-loop.mjs');
const NOW0 = new Date('2026-08-17T00:00:00.000Z');
const NOW1 = Date.parse('2026-08-17T00:01:00.000Z');
const GROK_VERSION_LINE = 'grok 1.0.4 (d846eb93d94d) [stable]';
const FIELDS = [
  'skill_token_style', 'provider_label', 'usage_output_kind', 'entrypoint_heuristic',
  'desktop_transport', 'unattended_checker', 'requires_process_preflight',
  'requires_process_receipt_settlement', 'requires_posix_visible_executable_trust',
  'max_effort_supported', 'executable_name', 'version_probe',
  'supported_platforms', 'measured_headless', 'session_effort_allowed',
  'compact_supported', 'handoff_continuity_note', 'observation_runtime',
  'independent_checker_bridge',
];

function walkScripts(dir = join(ROOT, 'scripts'), out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkScripts(full, out);
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

function durableBytes(root, runId) {
  const dir = runDir(root, runId);
  return Object.fromEntries(['loop.json', '.loop.hash', 'event-log.jsonl'].map(name => {
    const path = join(dir, name);
    return [name, existsSync(path) ? readFileSync(path) : null];
  }));
}

function seedGrok(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-grok-'));
  const { runId } = initRun(root, {
    runtime: 'grok',
    goal: 'g',
    now: NOW0,
    env: {},
    platform: 'darwin',
    run: () => ({ code: 1 }),
    ...overrides,
  });
  return { root, runId };
}

function seedGrokLegacy() {
  const fixture = seedGrok();
  migrateAuthenticLegacyTransport(fixture.root, fixture.runId);
  return fixture;
}

function grokRunVersion() {
  return {
    status: 0,
    signal: null,
    stdout: `${GROK_VERSION_LINE}\n`,
    stderr: '',
  };
}

function grokBinaryFixture() {
  const dir = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-grok-bin-')));
  const executable = join(dir, 'grok-1.0.4-macos-aarch64');
  writeFileSync(executable, '#!/usr/bin/env node\nif (process.argv[2] === "--version") process.stdout.write("grok 1.0.4 (d846eb93d94d) [stable]\\n");\n');
  chmodSync(executable, 0o755);
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  return { dir, executable, sha256, runVersion: grokRunVersion };
}

function grokIdentity(canonicalPath, sha256 = 'a'.repeat(64)) {
  return {
    runtime: 'grok',
    canonical_path: canonicalPath,
    sha256,
    version: '1.0.4',
    platform: 'darwin',
    arch: 'arm64',
    source: 'human-explicit',
    package: null,
    authenticode: null,
    approved_by: 'human',
    approved_at: '2026-08-17T00:00:00.000Z',
  };
}

function approveGrokExe(root, runId, fixture) {
  const diagnosed = diagnoseRuntimeExecutable('grok', {
    explicitPath: fixture.executable,
    platform: 'darwin',
    arch: 'arm64',
    runVersion: fixture.runVersion,
  });
  return approveRuntimeExecutable(root, runId, {
    runtime: 'grok',
    candidatePath: fixture.executable,
    expectedCanonicalPath: diagnosed.identity.canonical_path,
    expectedSha256: diagnosed.identity.sha256,
    actor: 'human',
    confirm: true,
    fence: { owner: runId, generation: 1 },
    now: NOW1,
    platform: 'darwin',
    arch: 'arm64',
    runVersion: fixture.runVersion,
  });
}

const GROK_POSIX_BIN = '/opt/xai/grok-1.0.4-macos-aarch64';
const GROK_POSIX_ROOT = '/tmp/deep-loop-grok-fixture';

function grokDescriptorRoot(root) {
  return process.platform === 'win32' ? GROK_POSIX_ROOT : root;
}

function pinApprovedGrokPosixIdentity(root, runId) {
  const { data } = readState(root, runId);
  const stored = data.autonomy?.runtime_executable_approval;
  if (!stored || typeof stored !== 'object') throw new Error('missing grok runtime approval');
  data.autonomy.runtime_executable_approval = { ...stored, canonical_path: GROK_POSIX_BIN, platform: 'darwin' };
  writeState(root, runId, data);
}

function setVisibleCmuxSpawn(root, runId) {
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'visible';
  data.session_spawn = {
    platform: 'darwin',
    launcher: 'cmux',
    launcher_bin: '/opt/cmux/bin/cmux',
    launcher_socket: '/tmp/cmux.sock',
    launcher_session: null,
    surface: 'workspace',
    reachable: true,
    visible: true,
    signals: {},
    probe: { cmd: ['/opt/cmux/bin/cmux', '--socket', '/tmp/cmux.sock', 'ping'], code: 0 },
    reason: null,
    fallback: 'launch-command-file',
    detected_at: '2026-08-17T00:00:00.000Z',
  };
  writeState(root, runId, data);
}

function doneMaker(root, runId, ws, point, fence) {
  const art = `${point}-art.txt`;
  writeFileSync(join(root, art), 'artifact');
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: point, point, workstream: ws,
    expectedArtifacts: [art], fence,
  });
  recordEpisode(root, runId, id, { status: 'in_progress', fence });
  recordEpisode(root, runId, id, { status: 'done', artifacts: [art], proof: {}, fence });
  return id;
}

function skillSources() {
  const skills = join(ROOT, 'skills');
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) out.push(full);
    }
  };
  walk(skills);
  return out;
}

// ── T-enum ──────────────────────────────────────────────────────────────────

test('T-enum: SESSION_RUNTIMES, schema, WAL, and schema messages include grok', () => {
  assert.deepEqual(SESSION_RUNTIMES, ['claude', 'codex', 'grok']);
  assert.equal(validateSessionRuntime('grok'), 'grok');
  assert.throws(() => validateSessionRuntime('other'), /expected claude, codex, or grok/);

  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas/loop-run.schema.json'), 'utf8'));
  assert.deepEqual([...schema.enums['autonomy.session_runtime']].sort(), ['claude', 'codex', 'grok']);

  const yml = readFileSync(join(ROOT, 'recipes/automation/github-actions-loop.yml'), 'utf8');
  assert.ok(yml.includes("!['claude', 'codex', 'grok'].includes(manifest.runtime)"));

  const schemaSrc = readFileSync(join(ROOT, 'scripts/lib/schema.mjs'), 'utf8');
  const messages = [...schemaSrc.matchAll(/runtime must be ([^\n']+)/g)].map(match => match[1]);
  assert.ok(messages.length >= 2, 'schema.mjs compact-cursor and approval messages');
  for (const message of messages) assert.match(message, /claude, codex, or grok/);

  const usage = readFileSync(join(ROOT, 'scripts/deep-loop.mjs'), 'utf8');
  assert.equal((usage.match(/--runtime <claude\|codex\|grok>/g) || []).length, 3);
});

// ── T-sentinel ──────────────────────────────────────────────────────────────

test('T-sentinel: unknown-runtime is the unknown token and grok is valid', () => {
  assert.equal(runtimeCapability('grok', 'skill_token_style'), 'slash');
  assert.throws(() => runtimeCapability('unknown-runtime', 'skill_token_style'), /INVALID_RUNTIME/);
  assert.throws(() => skillToken('unknown-runtime', 'deep-loop-resume'), /INVALID_RUNTIME/);
  assert.doesNotMatch(
    readFileSync(join(ROOT, 'tests/unit/runtime-capabilities.test.mjs'), 'utf8'),
    /runtimeCapability\('grok'/,
  );
  assert.match(
    readFileSync(join(ROOT, 'tests/unit/runtime-capabilities.test.mjs'), 'utf8'),
    /runtimeCapability\('unknown-runtime'/,
  );
});

// ── T-literals ──────────────────────────────────────────────────────────────

test('T-literals: PATTERN includes grok and scripts/ have no undeclared grok identity', () => {
  const literalsSrc = readFileSync(join(ROOT, 'tests/unit/runtime-literals.test.mjs'), 'utf8');
  assert.match(literalsSrc, /claude\|codex\|grok/);
  const pattern = /(?:[!=]==\s*'(?:claude|codex|grok)'|\['claude',\s*'codex'(?:,\s*'grok')?\])/;
  assert.equal(pattern.test("if (runtime === 'grok')"), true);

  const allowlist = JSON.parse(readFileSync(join(ROOT, 'schemas/runtime-literal-allowlist.json'), 'utf8'));
  const declared = new Set(allowlist.entries.map(entry => `${entry.file}:${entry.line}`));
  const undeclared = [];
  for (const file of walkScripts()) {
    const rel = file.slice(ROOT.length + 1).split('\\').join('/');
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (!/(?:[!=]==\s*'grok')/.test(line)) return;
      const key = `${rel}:${index + 1}`;
      if (!declared.has(key)) undeclared.push(`${key}  ${line.trim()}`);
    });
  }
  assert.deepEqual(undeclared, [], `undeclared === 'grok' literals:\n${undeclared.join('\n')}`);
});

// ── T-caps ──────────────────────────────────────────────────────────────────

test('T-caps: grok row is complete and new fields have scripts/ consumers', () => {
  const row = RUNTIME_CAPABILITIES.grok;
  assert.ok(row);
  for (const field of FIELDS) assert.ok(Object.hasOwn(row, field), `grok missing ${field}`);
  assert.equal(Object.keys(row).length, FIELDS.length);
  assert.equal(row.skill_token_style, 'slash');
  assert.equal(row.provider_label, 'grok');
  assert.equal(row.usage_output_kind, 'unmeasured');
  assert.equal(row.entrypoint_heuristic, null);
  assert.equal(row.desktop_transport, false);
  assert.equal(row.unattended_checker, false);
  assert.equal(row.requires_process_preflight, false);
  assert.equal(row.requires_process_receipt_settlement, false);
  assert.equal(row.requires_posix_visible_executable_trust, true);
  assert.equal(row.max_effort_supported, false);
  assert.equal(row.executable_name, 'grok');
  assert.equal(row.version_probe, 'grok');
  assert.deepEqual(row.supported_platforms, ['darwin']);
  assert.equal(row.measured_headless, false);
  assert.equal(row.session_effort_allowed, 'none');
  assert.equal(row.compact_supported, false);
  assert.equal(row.handoff_continuity_note, 'grok-attended');
  assert.equal(row.observation_runtime, 'grok');
  assert.equal(row.independent_checker_bridge, 'model-router-separate-process');
  assert.equal(runtimeCapability('claude', 'independent_checker_bridge'), null);
  assert.equal(runtimeCapability('codex', 'independent_checker_bridge'), null);
  assert.equal(runtimeCapability('claude', 'session_effort_allowed'), 'kernel-set');
  assert.equal(runtimeCapability('codex', 'session_effort_allowed'), 'kernel-set');
  assert.equal(runtimeCapability('claude', 'compact_supported'), true);
  assert.equal(runtimeCapability('grok', 'handoff_continuity_note'), 'grok-attended');

  const sources = walkScripts().map(file => readFileSync(file, 'utf8')).join('\n');
  for (const field of ['supported_platforms', 'measured_headless', 'session_effort_allowed', 'compact_supported', 'handoff_continuity_note', 'observation_runtime', 'independent_checker_bridge']) {
    assert.match(sources, new RegExp(`runtimeCapability\\([^\\n]*'${field}'`), `consumer for ${field}`);
  }
});

// ── T-init-max ──────────────────────────────────────────────────────────────

test('T-init-max: grok rejects every effort and Codex+max still has no files', () => {
  for (const effort of EFFORT_LEVELS) {
    assert.throws(
      () => validateRuntimeProfile('grok', { effort }),
      { message: `UNSUPPORTED_RUNTIME_EFFORT: grok ${effort}` },
    );
    assert.throws(
      () => buildInitialLoop({
        runtime: 'grok', runId: `grok-${effort}`, goal: 'g', recipe: {},
        now: NOW0, env: {}, platform: 'darwin', run: () => ({ code: 1 }), effort,
      }),
      { message: `UNSUPPORTED_RUNTIME_EFFORT: grok ${effort}` },
    );
    const libRoot = mkdtempSync(join(tmpdir(), `dl-grok-effort-${effort}-`));
    assert.throws(
      () => initRun(libRoot, {
        runtime: 'grok', goal: 'g', detected: {}, now: NOW0, env: {},
        platform: 'darwin', run: () => ({ code: 1 }), effort,
      }),
      { message: `UNSUPPORTED_RUNTIME_EFFORT: grok ${effort}` },
    );
    assert.equal(existsSync(join(libRoot, '.deep-loop')), false);

    const cliRoot = mkdtempSync(join(tmpdir(), `dl-grok-effort-cli-${effort}-`));
    mkdirSync(join(cliRoot, '.deep-loop'), { recursive: true });
    writeFileSync(join(cliRoot, '.deep-loop', 'current'), 'OLD\n');
    const result = spawnSync(process.execPath, [
      CLI, 'init-run', '--goal', 'g', '--runtime', 'grok',
      '--session-profile', JSON.stringify({ effort }),
      '--project-root', cliRoot,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(readFileSync(join(cliRoot, '.deep-loop', 'current'), 'utf8'), 'OLD\n');
    assert.equal(existsSync(join(cliRoot, '.deep-loop', 'runs')), false);
  }

  const codexRoot = mkdtempSync(join(tmpdir(), 'dl-codex-max-cli-'));
  mkdirSync(join(codexRoot, '.deep-loop'), { recursive: true });
  writeFileSync(join(codexRoot, '.deep-loop', 'current'), 'OLD\n');
  const codex = spawnSync(process.execPath, [
    CLI, 'init-run', '--goal', 'g', '--runtime', 'codex',
    '--session-profile', '{"effort":"max"}',
    '--project-root', codexRoot,
  ], { encoding: 'utf8' });
  assert.notEqual(codex.status, 0);
  assert.equal(existsSync(join(codexRoot, '.deep-loop', 'runs')), false);
});

// ── T-init-plat ─────────────────────────────────────────────────────────────

test('T-init-plat: grok init on win32/linux writes nothing', () => {
  for (const platform of ['win32', 'linux']) {
    assert.throws(
      () => buildInitialLoop({
        runtime: 'grok', runId: `grok-${platform}`, goal: 'g', recipe: {},
        now: NOW0, env: {}, platform, run: () => ({ code: 1 }),
      }),
      { message: `UNSUPPORTED_RUNTIME_PLATFORM: grok on ${platform}` },
    );
    const root = mkdtempSync(join(tmpdir(), `dl-grok-${platform}-`));
    assert.throws(
      () => initRun(root, {
        runtime: 'grok', goal: 'g', detected: {}, now: NOW0, env: {},
        platform, run: () => ({ code: 1 }),
      }),
      { message: `UNSUPPORTED_RUNTIME_PLATFORM: grok on ${platform}` },
    );
    assert.equal(existsSync(join(root, '.deep-loop')), false);
  }
});

// ── T-acq-plat ──────────────────────────────────────────────────────────────

test('T-acq-plat: live-host linux and win32 reject grok acquire paths with mutation 0', () => {
  const { root, runId } = seedGrok();
  const { data } = readState(root, runId);
  data.session_spawn = { ...data.session_spawn, platform: 'darwin' };
  writeState(root, runId, data);
  assert.equal(readState(root, runId).data.session_spawn.platform, 'darwin');

  for (const platform of ['linux', 'win32']) {
    const beforeLease = durableBytes(root, runId);
    const halted = acquireLease(root, runId, {
      owner: runId, expectGeneration: 1, runtime: 'grok', platform,
    });
    assert.deepEqual(halted, {
      ok: false, reason: 'UNSUPPORTED_RUNTIME_PLATFORM', generation: 1,
      proceed: false, consumed: null, replayed: false,
    });
    assert.deepEqual(durableBytes(root, runId), beforeLease);

    const beforeRecovery = durableBytes(root, runId);
    const recovered = acquireRecovery(root, runId, {
      capsuleRel: 'recoveries/child.json',
      owner: 'CHILD',
      expectGeneration: 1,
      runtime: 'grok',
      platform,
      now: NOW1,
      clock: () => NOW1,
    });
    assert.equal(recovered.ok, false);
    assert.equal(recovered.reason, 'UNSUPPORTED_RUNTIME_PLATFORM');
    assert.equal(recovered.proceed, false);
    assert.deepEqual(durableBytes(root, runId), beforeRecovery);

    const loopPath = join(runDir(root, runId), 'loop.json');
    const beforeRoot = readFileSync(loopPath);
    assert.throws(
      () => acquireRootRecovery(root, runId, {
        capsuleRel: 'recoveries/root/capsule.json',
        owner: 'CHILD',
        expectGeneration: 1,
        bindingGeneration: 1,
        runtime: 'grok',
        platform,
        now: NOW1,
        clock: () => NOW1,
      }),
      /UNSUPPORTED_RUNTIME_PLATFORM: grok on (linux|win32)/,
    );
    assert.equal(readFileSync(loopPath).equals(beforeRoot), true);
  }
});

// ── T-desc ──────────────────────────────────────────────────────────────────

test('T-desc: grok interactive has no -s; desktop/headless/non-darwin unavailable', () => {
  const identity = grokIdentity('/opt/grok/downloads/grok-1.0.4-macos-aarch64');
  const darwin = buildRuntimeResumeDescriptor({
    runtime: 'grok',
    root: '/repo',
    parentRunId: '01PARENT',
    childRunId: '01CHILD',
    handoffRel: 'handoffs/next.md',
    platform: 'darwin',
    model: 'grok-4',
    runtimeExecutableIdentity: identity,
    launcher: 'cmux',
    launcherBin: '/opt/cmux/bin/cmux',
    launcherSocket: '/tmp/cmux.sock',
    exists: path => path === '/usr/bin/osascript',
  });
  assert.equal(darwin.resumePrompt, 'Read .deep-loop/runs/01PARENT/handoffs/next.md first; then run /deep-loop-resume');
  assert.equal(darwin.resumeSkillToken, '/deep-loop-resume');
  assert.match(darwin.entries.interactive.display, /\/opt\/grok\/downloads\/grok-1\.0\.4-macos-aarch64/);
  assert.match(darwin.entries.interactive.display, /--model/);
  assert.doesNotMatch(darwin.entries.interactive.display, /(?:^|\s)-s(?:\s|$)/);
  assert.doesNotMatch(darwin.entries.interactive.display, /--session-id/);
  assert.doesNotMatch(darwin.entries.interactive.display, /--effort/);
  assert.doesNotMatch(darwin.entries.interactive.display, /01CHILD/);
  assert.equal(darwin.entries.desktop.unavailable, true);
  assert.equal(darwin.entries.headless.unavailable, true);
  assert.equal(darwin.entries.wt.unavailable, true);
  assert.equal(darwin.entries.powershell.unavailable, true);
  assert.equal(darwin.entries.cmux.unavailable, undefined);
  assert.match(darwin.entries.cmux.argv.join(' '), /grok-1\.0\.4/);

  assert.throws(
    () => buildRuntimeResumeDescriptor({
      runtime: 'grok', root: '/repo', parentRunId: 'P', childRunId: 'C',
      handoffRel: 'handoffs/next.md', platform: 'darwin', effort: 'high',
      runtimeExecutableIdentity: identity,
    }),
    /UNSUPPORTED_RUNTIME_EFFORT/,
  );

  for (const platform of ['linux', 'win32']) {
    const entries = buildRuntimeResumeDescriptor({
      runtime: 'grok',
      root: platform === 'win32' ? 'C:\\repo' : '/repo',
      parentRunId: 'P',
      childRunId: 'C',
      handoffRel: 'handoffs/next.md',
      platform,
      runtimeExecutableIdentity: { ...identity, platform },
    }).entries;
    for (const name of Object.keys(entries)) {
      assert.equal(entries[name].unavailable, true, `${platform} ${name}`);
    }
  }

  const missing = buildRuntimeResumeDescriptor({
    runtime: 'grok',
    root: '/repo',
    parentRunId: 'P',
    childRunId: 'C',
    handoffRel: 'handoffs/next.md',
    platform: 'darwin',
  }).entries;
  for (const name of Object.keys(missing)) {
    assert.equal(missing[name].unavailable, true, `no-identity ${name}`);
  }
});

// ── T-trust ─────────────────────────────────────────────────────────────────

test('T-trust: no grok native resolver; retarget keeps pin; symlink rejected with canonical printed', async (t) => {
  const fixture = grokBinaryFixture();
  const diagnosed = diagnoseRuntimeExecutable('grok', {
    explicitPath: fixture.executable,
    platform: 'darwin',
    arch: 'arm64',
    runVersion: fixture.runVersion,
  });
  assert.equal(diagnosed.identity.canonical_path, fixture.executable);
  assert.equal(diagnosed.identity.sha256, fixture.sha256);

  assert.throws(
    () => resolveTrustedRuntimeExecutable('grok', {
      explicitPath: fixture.executable, platform: 'darwin', arch: 'arm64',
    }),
    /RUNTIME_EXECUTABLE_UNTRUSTED/,
  );
  const resolverSrc = readFileSync(join(ROOT, 'scripts/lib/runtime-executable.mjs'), 'utf8');
  const table = resolverSrc.match(/NATIVE_TRUST_RESOLVERS = Object\.freeze\(\{([\s\S]*?)\}\)/);
  assert.ok(table);
  assert.doesNotMatch(table[1], /grok/);

  const { root, runId } = seedGrok();
  const approved = approveRuntimeExecutable(root, runId, {
    runtime: 'grok',
    candidatePath: fixture.executable,
    expectedCanonicalPath: fixture.executable,
    expectedSha256: fixture.sha256,
    actor: 'human',
    confirm: true,
    fence: { owner: runId, generation: 1 },
    now: NOW1,
    platform: 'darwin',
    arch: 'arm64',
    runVersion: fixture.runVersion,
  });
  const newer = join(fixture.dir, 'grok-1.0.5-macos-aarch64');
  writeFileSync(newer, 'newer-bytes');
  chmodSync(newer, 0o755);
  const revalidated = revalidateTrustedRuntimeExecutable(approved.approval, {
    platform: 'darwin',
    arch: 'arm64',
    runVersion: fixture.runVersion,
  });
  assert.equal(revalidated.canonical_path, fixture.executable);

  await t.test('symlink input is rejected and diagnose prints the canonical regular file', (st) => {
    const link = join(fixture.dir, 'grok');
    if (!createFileSymlinkOrSkip(st, fixture.executable, link)) return;
    assert.throws(
      () => diagnoseRuntimeExecutable('grok', {
        explicitPath: link, platform: 'darwin', arch: 'arm64', runVersion: fixture.runVersion,
      }),
      error => {
        assert.match(String(error.message), /UNTRUSTED|symlink/i);
        assert.ok(String(error.message).includes(fixture.executable), String(error.message));
        return true;
      },
    );
  });
});

// ── T-order ─────────────────────────────────────────────────────────────────

test('T-order: diagnose+exe approve then emit succeeds; emit then approve mutates 0', () => {
  const bin = grokBinaryFixture();
  const { root, runId } = seedGrokLegacy();
  const approved = approveGrokExe(root, runId, bin);
  assert.equal(approved.ok, true);
  const emitted = emitHandoff(root, runId, {
    trigger: 'milestone',
    expect: { owner: runId, generation: 1 },
    now: NOW1,
    platform: 'darwin',
  });
  assert.equal(emitted.ok, true);

  const other = seedGrokLegacy();
  const before = durableBytes(other.root, other.runId);
  const firstEmit = emitHandoff(other.root, other.runId, {
    trigger: 'milestone',
    expect: { owner: other.runId, generation: 1 },
    now: NOW1,
    platform: 'darwin',
  });
  assert.equal(firstEmit.ok, true);
  const afterEmit = durableBytes(other.root, other.runId);
  assert.throws(
    () => approveRuntimeExecutable(other.root, other.runId, {
      runtime: 'grok',
      candidatePath: bin.executable,
      expectedCanonicalPath: bin.executable,
      expectedSha256: bin.sha256,
      actor: 'human',
      confirm: true,
      fence: { owner: other.runId, generation: 1 },
      now: NOW1,
      platform: 'darwin',
      arch: 'arm64',
      runVersion: bin.runVersion,
    }),
    /LEASE_FENCED/,
  );
  assert.deepEqual(durableBytes(other.root, other.runId), afterEmit);
  assert.notDeepEqual(afterEmit, before);
});

// ── T-path-v ────────────────────────────────────────────────────────────────

test('T-path-v: exe approve → attended visible → emit → respawn; post-emit approves mutation 0', () => {
  const bin = grokBinaryFixture();
  const { root, runId } = seedGrokLegacy();
  assert.equal(approveGrokExe(root, runId, bin).ok, true);
  assert.equal(approveAttendedLaunch(root, runId, {
    style: 'visible', confirm: true, fence: { owner: runId, generation: 1 }, now: NOW1,
  }).ok, true);
  setVisibleCmuxSpawn(root, runId);
  pinApprovedGrokPosixIdentity(root, runId);

  const darwinDescriptor = options => buildRuntimeResumeDescriptor({
    ...options,
    platform: 'darwin',
    root: grokDescriptorRoot(options.root),
    exists: path => path === '/usr/bin/osascript',
  });
  const emitted = emitHandoff(root, runId, {
    trigger: 'milestone',
    expect: { owner: runId, generation: 1 },
    now: NOW1,
    platform: 'darwin',
    exists: path => path === '/usr/bin/osascript',
    descriptorBuilder: darwinDescriptor,
  });
  assert.equal(emitted.ok, true);

  let captured = null;
  const spawned = respawn(root, runId, {
    childRunId: emitted.childRunId,
    key: emitted.key,
    handoffRel: emitted.handoffRel,
    attended: true,
    env: {},
    now: NOW1,
    platform: 'darwin',
    expect: { owner: runId, generation: 1 },
    revalidateRuntimeExecutable: identity => identity,
    launchCommandBuilder: options => darwinDescriptor(options).entries,
    spawnFn: entry => { captured = entry; return { ok: true }; },
    pollLease: () => ({
      state: 'active', handoff_phase: 'acquired', owner_run_id: emitted.childRunId, generation: 2,
    }),
    sleep: () => {},
    pollIntervalMs: 0,
  });
  assert.equal(spawned.ok, true, `${spawned.outcome}: ${spawned.reason}`);
  assert.equal(spawned.outcome, 'spawned', `${spawned.outcome}: ${spawned.reason}`);
  assert.ok(captured, 'injected spawnFn must run');
  assert.equal(captured.bin, '/opt/cmux/bin/cmux');
  const command = captured.argv[captured.argv.indexOf('--command') + 1];
  assert.ok(command.includes(GROK_POSIX_BIN), command);
  assert.doesNotMatch(command, /(?:^|\s)-s(?:\s|$)/);
  assert.doesNotMatch(command, /--session-id/);
  assert.doesNotMatch(command, /--effort/);
  const afterRespawn = durableBytes(root, runId);

  assert.throws(
    () => approveRuntimeExecutable(root, runId, {
      runtime: 'grok',
      candidatePath: bin.executable,
      expectedCanonicalPath: bin.executable,
      expectedSha256: bin.sha256,
      actor: 'human',
      confirm: true,
      fence: { owner: runId, generation: 1 },
      now: NOW1 + 1000,
      platform: 'darwin',
      arch: 'arm64',
      runVersion: bin.runVersion,
    }),
    /LEASE_FENCED/,
  );
  assert.throws(
    () => approveAttendedLaunch(root, runId, {
      style: 'visible', confirm: true, fence: { owner: runId, generation: 1 }, now: NOW1 + 1000,
    }),
    /LEASE_FENCED/,
  );
  assert.deepEqual(durableBytes(root, runId), afterRespawn);
});

// ── T-headless-poll / T-headless-pending ────────────────────────────────────

function seedGrokHeadlessStyle() {
  const { root, runId } = seedGrok();
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'headless';
  writeState(root, runId, data);
  migrateAuthenticLegacyTransport(root, runId);
  return { root, runId };
}

function driveBoth(options) {
  const run = driveHeadlessRun(options);
  const wrap = driveHeadless({
    root: options.root,
    driveRun: driveOptions => driveHeadlessRun({ ...options, ...driveOptions }),
  });
  return { run, wrap };
}

test('T-headless-poll: grok skip predicates are unmeasured-runtime, mutation 0, CLI exit 1', () => {
  const cases = [];

  const idle = seedGrok();
  cases.push({ label: 'no-pending-handoff', root: idle.root, runId: idle.runId });

  const human = seedGrokHeadlessStyle();
  const humanHandoff = emitHandoff(human.root, human.runId, {
    trigger: 'milestone', resumePolicy: 'human',
    expect: { owner: human.runId, generation: 1 }, now: NOW1, platform: 'darwin',
  });
  assert.equal(humanHandoff.ok, true);
  cases.push({ label: 'human-resume-policy', root: human.root, runId: human.runId });

  const visible = seedGrokHeadlessStyle();
  const visibleHandoff = emitHandoff(visible.root, visible.runId, {
    trigger: 'milestone', resumePolicy: 'interactive',
    expect: { owner: visible.runId, generation: 1 }, now: NOW1, platform: 'darwin',
  });
  assert.equal(visibleHandoff.ok, true);
  cases.push({ label: 'not-headless-intended', root: visible.root, runId: visible.runId });

  const spawned = seedGrokHeadlessStyle();
  const spawnedHandoff = emitHandoff(spawned.root, spawned.runId, {
    trigger: 'milestone', resumePolicy: 'headless', headless: true,
    expect: { owner: spawned.runId, generation: 1 }, now: NOW1, platform: 'darwin',
  });
  assert.equal(spawnedHandoff.ok, true);
  const { data } = readState(spawned.root, spawned.runId);
  data.session_chain.lease.handoff_phase = 'spawned';
  const child = data.session_chain.sessions.find(session => session.run_id === spawnedHandoff.childRunId);
  child.started_at = '2026-08-17T00:02:00.000Z';
  writeState(spawned.root, spawned.runId, data);
  cases.push({ label: 'already-spawned', root: spawned.root, runId: spawned.runId });

  for (const fixture of cases) {
    const before = durableBytes(fixture.root, fixture.runId);
    const { run, wrap } = driveBoth({
      root: fixture.root,
      runId: fixture.runId,
      expect: { owner: fixture.runId, generation: 1 },
      now: NOW1,
      headless: true,
    });
    assert.deepEqual(run, { ok: false, action: 'unmeasured-runtime' }, fixture.label);
    assert.equal(wrap.ok, false, fixture.label);
    assert.equal(wrap.action, 'unmeasured-runtime', fixture.label);
    assert.deepEqual(durableBytes(fixture.root, fixture.runId), before, fixture.label);

    const result = spawnSync(process.execPath, [
      CLI, 'respawn', '--headless',
      '--owner', fixture.runId, '--generation', '1',
      '--project-root', fixture.root, '--run-id', fixture.runId,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, `${fixture.label}: ${result.stdout}\n${result.stderr}`);
    assert.deepEqual(durableBytes(fixture.root, fixture.runId), before, fixture.label);
  }
});

test('T-headless-pending: would-spawn pauses with ok:false and CLI exit 1', () => {
  const { root, runId } = seedGrokHeadlessStyle();
  const handoff = emitHandoff(root, runId, {
    trigger: 'milestone', resumePolicy: 'headless', headless: true,
    expect: { owner: runId, generation: 1 }, now: NOW1, platform: 'darwin',
  });
  assert.equal(handoff.ok, true);
  const seq = readState(root, runId).data.event_log_head.seq;
  const run = driveHeadlessRun({
    root, runId, expect: { owner: runId, generation: 1 }, now: NOW1, headless: true,
  });
  assert.equal(run.ok, false);
  assert.equal(run.action, 'paused');
  assert.equal(readState(root, runId).data.status, 'paused');
  assert.ok(readState(root, runId).data.event_log_head.seq >= seq);

  const wrapSeed = seedGrokHeadlessStyle();
  const wrapHandoff = emitHandoff(wrapSeed.root, wrapSeed.runId, {
    trigger: 'milestone', resumePolicy: 'headless', headless: true,
    expect: { owner: wrapSeed.runId, generation: 1 }, now: NOW1, platform: 'darwin',
  });
  assert.equal(wrapHandoff.ok, true);
  const wrap = driveHeadless({
    root: wrapSeed.root,
    driveRun: options => driveHeadlessRun({
      root: wrapSeed.root, runId: wrapSeed.runId,
      expect: { owner: wrapSeed.runId, generation: 1 }, now: NOW1, headless: true,
      ...options,
    }),
  });
  assert.equal(wrap.ok, false);
  assert.equal(wrap.action, 'paused');

  const other = seedGrokHeadlessStyle();
  const otherHandoff = emitHandoff(other.root, other.runId, {
    trigger: 'milestone', resumePolicy: 'headless', headless: true,
    expect: { owner: other.runId, generation: 1 }, now: NOW1, platform: 'darwin',
  });
  assert.equal(otherHandoff.ok, true);
  const result = spawnSync(process.execPath, [
    CLI, 'respawn', '--headless',
    '--owner', other.runId, '--generation', '1',
    '--project-root', other.root, '--run-id', other.runId,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(readState(other.root, other.runId).data.status, 'paused');
});

// ── T-usage ─────────────────────────────────────────────────────────────────

test('T-usage: no claude-json fallback in scripts/; Claude POSIX and win32 headless set the field', () => {
  for (const file of walkScripts()) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /\?\?\s*'claude-json'/, file);
  }
  const posix = buildRuntimeResumeDescriptor({
    runtime: 'claude', root: '/repo', parentRunId: 'P', childRunId: 'C',
    handoffRel: 'handoffs/next.md', platform: 'linux',
  });
  assert.equal(posix.entries.headless.usageOutputKind, 'claude-json');
  const win = buildRuntimeResumeDescriptor({
    runtime: 'claude',
    root: 'C:\\repo',
    parentRunId: 'P',
    childRunId: 'C',
    handoffRel: 'handoffs/next.md',
    platform: 'win32',
    runtimeExecutableIdentity: {
      runtime: 'claude', canonical_path: 'C:\\Tools\\claude.exe', sha256: 'b'.repeat(64),
      version: '1.0.0', platform: 'win32', arch: 'x64', source: 'human-explicit',
      package: null, authenticode: null,
    },
  });
  assert.equal(win.entries.headless.usageOutputKind, 'claude-json');
});

// ── T-desktop ───────────────────────────────────────────────────────────────

test('T-desktop: grok and Codex offer/confirm mutate 0; autonomy seed is skill-asserted', () => {
  const passingProbe = () => ({ ok: true, argvTarget: { kind: 'macos-app', appPath: '/Applications/Claude.app' } });
  for (const runtime of ['grok', 'codex']) {
    const root = mkdtempSync(join(tmpdir(), `dl-desktop-${runtime}-`));
    const { runId } = initRun(root, {
      runtime, goal: 'g', detected: {}, now: NOW0, env: {},
      platform: runtime === 'grok' ? 'darwin' : 'linux',
      run: () => ({ code: 1 }),
    });
    const before = durableBytes(root, runId);
    const seq = readState(root, runId).data.event_log_head.seq;
    assert.equal(readState(root, runId).data.autonomy.runtime_source, 'skill-asserted');
    assert.throws(
      () => offerDesktop(root, runId, { expect: { owner: runId, generation: 1 }, now: NOW1, nonce: 'n1' }),
      /DESKTOP_TRANSPORT_UNSUPPORTED/,
    );
    assert.throws(
      () => confirmDesktop(root, runId, {
        expect: { owner: runId, generation: 1 }, now: NOW1, nonce: 'n1',
        platform: 'darwin', desktopProbe: passingProbe,
      }),
      /DESKTOP_TRANSPORT_UNSUPPORTED/,
    );
    assert.equal(readState(root, runId).data.event_log_head.seq, seq);
    assert.deepEqual(durableBytes(root, runId), before);
  }
  const optin = readFileSync(join(ROOT, 'scripts/lib/spawn-optin.mjs'), 'utf8');
  assert.match(optin, /runtimeCapability\([\s\S]*?'desktop_transport'/);
  assert.doesNotMatch(optin, /===\s*'grok'/);
});

// ── T-entrypoint ────────────────────────────────────────────────────────────

test('T-entrypoint: grok ignores CLAUDE_CODE_ENTRYPOINT; DEEP_LOOP_HEADLESS remains true', () => {
  assert.equal(isHeadlessInvocation({ CLAUDE_CODE_ENTRYPOINT: 'sdk-py' }, 'grok'), false);
  assert.equal(isHeadlessInvocation({ DEEP_LOOP_HEADLESS: '1' }, 'grok'), true);
  assert.equal(isHeadlessInvocation({ DEEP_LOOP_UNATTENDED: '1' }, 'grok'), true);
});

// ── T-route-d ───────────────────────────────────────────────────────────────

test('T-route-d: current review argv has no --runtime; record --runtime is FORBIDDEN; grok skills skip deep-review', () => {
  const { root, runId } = seedGrok();
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const ws = newWorkstream(root, runId, {
    title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence,
  }).id;
  doneMaker(root, runId, ws, 'plan', fence);
  const dispatched = dispatchReview(root, runId, {
    point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence,
  });
  assert.ok(dispatched.checkerEpisodeId);

  const recorded = spawnSync(process.execPath, [
    CLI, 'review', 'record',
    '--episode', dispatched.checkerEpisodeId, '--verdict', 'APPROVE',
    '--runtime', 'grok',
    '--owner', runId, '--generation', '1',
    '--project-root', root, '--run-id', runId,
  ], { encoding: 'utf8' });
  assert.notEqual(recorded.status, 0);
  assert.match(recorded.stderr, /REVIEW_METADATA_FORBIDDEN/);

  const imported = spawnSync(process.execPath, [
    CLI, 'review', 'import', '--stdin', '--runtime', 'grok',
    '--owner', runId, '--generation', '1',
    '--project-root', root, '--run-id', runId,
  ], { encoding: 'utf8', input: '{}' });
  assert.notEqual(imported.status, 0);
  assert.match(imported.stderr, /REVIEW_METADATA_FORBIDDEN/);

  const cliSrc = readFileSync(join(ROOT, 'scripts/deep-loop.mjs'), 'utf8');
  const dispatchBlock = cliSrc.slice(cliSrc.indexOf("if (verb === 'dispatch')"), cliSrc.indexOf('// verdict 기록'));
  assert.doesNotMatch(dispatchBlock, /reqStr\(f, 'runtime'\)|--runtime/);

  for (const file of skillSources()) {
    const src = readFileSync(file, 'utf8');
    if (!/grok/i.test(src)) continue;
    const grokWindows = src.split(/grok/i);
    for (let i = 1; i < grokWindows.length; i += 1) {
      const window = grokWindows[i].slice(0, 400);
      if (/Route D|needs-human|호출하지|never/.test(window)) {
        assert.doesNotMatch(window, /Skill\(\s*\{\s*skill:\s*"deep-review/);
      }
    }
  }
});

// ── T-skills ────────────────────────────────────────────────────────────────

test('T-skills: slash≠Claude; Path M/V; grok never Step 1a / --worktree; compact advice → needs-human', () => {
  const files = skillSources();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /슬래시\s*⇒\s*Claude|slash\s*(?:⇒|=>|implies|means)\s*Claude/i, file);
    for (const line of src.split('\n')) {
      if (/deep-loop\.mjs/.test(line) && /--runtime\s+</.test(line)) {
        assert.match(line, /<claude\|codex\|grok>/, `${file}: ${line}`);
      }
    }
  }

  const entry = readFileSync(join(ROOT, 'skills/deep-loop/SKILL.md'), 'utf8');
  assert.match(entry, /Grok Build/);
  assert.match(entry, /\/deep-loop/);
  assert.match(entry, /Step 1a/);
  assert.match(entry, /grok[\s\S]{0,200}(?:never|금지)[\s\S]{0,200}Step 1a|Step 1a[\s\S]{0,200}grok[\s\S]{0,120}(?:never|금지)/i);
  assert.match(entry, /grok --worktree|never grok `--worktree`|grok[\s\S]{0,80}--worktree[\s\S]{0,80}(?:금지|never)/i);

  const handoff = readFileSync(join(ROOT, 'skills/deep-loop-handoff/SKILL.md'), 'utf8');
  const diagnose = handoff.indexOf('runtime-executable diagnose');
  const approve = handoff.indexOf('runtime-executable approve');
  const attended = handoff.indexOf('attended-launch approve --style visible');
  const emit = handoff.indexOf('handoff emit');
  assert.ok(diagnose !== -1 && approve !== -1 && attended !== -1 && emit !== -1);
  assert.ok(diagnose < emit && approve < emit && attended < emit);
  assert.match(handoff, /advice === 'compact'[\s\S]{0,300}grok[\s\S]{0,200}needs-human|grok[\s\S]{0,200}advice === 'compact'[\s\S]{0,200}needs-human/);

  const cont = readFileSync(join(ROOT, 'skills/deep-loop-continue/SKILL.md'), 'utf8');
  assert.match(cont, /advice === 'compact'[\s\S]{0,400}grok[\s\S]{0,200}needs-human|grok[\s\S]{0,200}compact[\s\S]{0,200}needs-human/);

  const compact = readFileSync(join(ROOT, 'skills/deep-loop-compact/SKILL.md'), 'utf8');
  assert.match(compact, /grok[\s\S]{0,240}(?:stop|needs-human|do not|호출하지)/i);

  const adapters = readFileSync(join(ROOT, 'skills/deep-loop-workflow/references/adapters.md'), 'utf8');
  assert.match(adapters, /Grok[\s\S]{0,200}Route D|Route D[\s\S]{0,200}Grok/i);
  assert.doesNotMatch(
    adapters.split('\n').filter(line => /review (?:dispatch|record|import)/.test(line) && /deep-loop\.mjs/.test(line)).join('\n'),
    /--runtime/,
  );

  const detectSrc = readFileSync(join(ROOT, 'scripts/lib/detect.mjs'), 'utf8');
  assert.match(detectSrc, /join\('\.grok', 'installed-plugins'\)/);
  assert.doesNotMatch(detectSrc, /marketplace-cache/);
});

// ── T-bridge-probe ──────────────────────────────────────────────────────────

const BRIDGE_UNVERIFIED_YAML = `transports:
  grok:
    native: { mechanism: subagent, isolation: unverified }
    to_claude:
      mechanism: "claude -p --model <id> --effort <effort> --permission-mode <mode> \\"<prompt>\\""
      isolation: separate_process
      verified: false
    to_openai:
      mechanism: "codex exec -m <id> -c model_reasoning_effort=<effort> -s <sandbox> --skip-git-repo-check \\"<prompt>\\""
      isolation: separate_process
      verified: false
fallbacks:
  grok: {}
`;

function seedBridgeCache(home, yaml = BRIDGE_UNVERIFIED_YAML) {
  const skill = join(home, '.claude', 'plugins', 'cache', 'x', 'deep-model-router', '9.9.9', 'skills', 'model-router');
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  mkdirSync(join(skill, 'config'), { recursive: true });
  writeFileSync(join(skill, 'scripts', 'route_task.py'), 'print(1)\\n');
  writeFileSync(join(skill, 'scripts', 'dispatch_agent.py'), 'print(1)\\n');
  writeFileSync(join(skill, 'config', 'model-routing.yaml'), yaml);
}

test('T-bridge-probe: grok seed + unverified cache is ready:false, exit 0, durable bytes unchanged', () => {
  const { root, runId } = seedGrok();
  const before = durableBytes(root, runId);
  const home = mkdtempSync(join(tmpdir(), 'dl-bridge-home-'));
  seedBridgeCache(home);
  const result = spawnSync(process.execPath, [
    CLI, 'review', 'bridge-probe', '--json',
    '--project-root', root, '--run-id', runId,
  ], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.ready, false);
  assert.ok(payload.reasons.some((reason) => String(reason).startsWith('transport-unverified:')));
  assert.deepEqual(durableBytes(root, runId), before);
});

test('T-bridge-probe: missing --json is usage 2; missing run-id is usage 2', () => {
  const { root, runId } = seedGrok();
  const noJson = spawnSync(process.execPath, [
    CLI, 'review', 'bridge-probe',
    '--project-root', root, '--run-id', runId,
  ], { encoding: 'utf8' });
  assert.equal(noJson.status, 2);
  const noRun = spawnSync(process.execPath, [
    CLI, 'review', 'bridge-probe', '--json',
    '--project-root', root,
  ], { encoding: 'utf8' });
  assert.equal(noRun.status, 2);
});

test('T-bridge-probe: claude run is bridge-not-applicable', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-bridge-claude-'));
  const { runId } = initRun(root, {
    runtime: 'claude',
    goal: 'g',
    now: NOW0,
    env: {},
    platform: 'darwin',
    run: () => ({ code: 1 }),
  });
  const result = spawnSync(process.execPath, [
    CLI, 'review', 'bridge-probe', '--json',
    '--project-root', root, '--run-id', runId,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.ok(payload.reasons.includes('bridge-not-applicable:claude'));
});

test('T-bridge-probe: missing dispatcher is dispatcher-missing', () => {
  const { root, runId } = seedGrok();
  const home = mkdtempSync(join(tmpdir(), 'dl-bridge-home-'));
  const skill = join(home, '.claude', 'plugins', 'cache', 'x', 'deep-model-router', '9.9.9', 'skills', 'model-router');
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  mkdirSync(join(skill, 'config'), { recursive: true });
  writeFileSync(join(skill, 'scripts', 'route_task.py'), 'print(1)\\n');
  writeFileSync(join(skill, 'config', 'model-routing.yaml'), BRIDGE_UNVERIFIED_YAML);
  const result = spawnSync(process.execPath, [
    CLI, 'review', 'bridge-probe', '--json',
    '--project-root', root, '--run-id', runId,
  ], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.ok(payload.reasons.includes('dispatcher-missing'));
});

// ── T-down ──────────────────────────────────────────────────────────────────

test('T-down: a 1.18 grok fixture fail-stops on a 1.17 validateSessionRuntime and schema enum copy', () => {
  const { root, runId } = seedGrok();
  const loop = JSON.parse(readFileSync(join(runDir(root, runId), 'loop.json'), 'utf8'));
  assert.equal(loop.autonomy.session_runtime, 'grok');
  assert.equal(loop.autonomy.runtime_source, 'skill-asserted');
  assert.equal(validateSessionRuntime(loop.autonomy.session_runtime), 'grok');
  const current = validate(loop);
  assert.equal(current.ok, true, current.errors.join('; '));

  const SESSION_RUNTIMES_1_17 = Object.freeze(['claude', 'codex']);
  function validateSessionRuntime117(value) {
    if (!SESSION_RUNTIMES_1_17.includes(value)) {
      throw new Error(`INVALID_RUNTIME: expected claude or codex, got ${String(value)}`);
    }
    return value;
  }
  assert.throws(
    () => validateSessionRuntime117(loop.autonomy.session_runtime),
    { message: 'INVALID_RUNTIME: expected claude or codex, got grok' },
  );

  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas/loop-run.schema.json'), 'utf8'));
  assert.deepEqual(schema.enums['autonomy.session_runtime'], ['claude', 'codex', 'grok']);
  const schema117 = structuredClone(schema);
  schema117.enums['autonomy.session_runtime'] = ['claude', 'codex'];
  const down = validate(loop, schema117);
  assert.equal(down.ok, false);
  assert.ok(
    down.errors.includes('invalid enum at autonomy.session_runtime: grok'),
    down.errors.join('; '),
  );
});

test('T-skills detect: ~/.grok/installed-plugins is scanned and marketplace-cache is not', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-detect-grok-'));
  const home = mkdtempSync(join(tmpdir(), 'dl-detect-home-'));
  const installed = join(home, '.grok', 'installed-plugins', 'deep-review-entry', '.claude-plugin');
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'plugin.json'), JSON.stringify({ name: 'deep-review' }));
  const market = join(home, '.grok', 'marketplace-cache', 'm1', 'deep-work', '99.99.99', '.claude-plugin');
  mkdirSync(market, { recursive: true });
  writeFileSync(join(market, 'plugin.json'), JSON.stringify({ name: 'deep-work' }));
  const detected = detectPlugins(root, home);
  assert.equal(detected['deep-review'].installed, true);
  assert.equal(detected['deep-work'].installed, false);
});
