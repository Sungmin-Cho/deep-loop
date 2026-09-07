import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { isTrustedPsBin, trustedPsCandidates } from './detect-terminal.mjs';
import { runtimeCapability, skillToken, validateSessionRuntime } from './runtime.mjs';
import { buildCodexExecEntry, buildCodexGoalOwnerEntry } from './codex-runtime.mjs';
import { validateRuntimeProfile } from './session-profile.mjs';
import { tomlBasicString } from './toml-safe.mjs';
import { contentHash } from './envelope.mjs';

const CODEX_TRANSPORT_UNAVAILABLE = 'codex-transport-not-activated';

// POSIX single-quote wrap: embed s safely in a single-quoted shell argument.
// ' → '\'' (close-quote, literal-quote, reopen-quote).
function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Escape for an AppleScript double-quoted string literal. Backslashes must be
// doubled before quotes are escaped so shell quoting survives AppleScript.
function escApple(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

// PowerShell single-quote escaping: ' → '' (doubling).
function psq(s) { return String(s).replace(/'/g, "''"); }
function psArg(s) { return `'${psq(s)}'`; }

function meArgv(model, effort) {
  const argv = [];
  if (model) argv.push('--model', model);
  if (effort) argv.push('--effort', effort);
  return argv;
}

function meSh(quote, model, effort) {
  return `${model ? ` --model ${quote(model)}` : ''}${effort ? ` --effort ${quote(effort)}` : ''}`;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_HANDOFF_REL = /^handoffs\/[A-Za-z0-9._-]+$/;
const SAFE_RECOVERY_REL = /^recoveries\/[A-Za-z0-9._-]+$/;
const SAFE_ROOT_RECOVERY_REL = /^recoveries\/root\/[A-Za-z0-9._-]+\.json$/;

function exactObjectKeys(value, expected) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalIso(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

// Shared M3 validator for both prepared-publication reconciliation and the
// read-only resume surface. It deliberately validates the complete envelope,
// not merely the fields currently consumed by either caller.
export function validateLaunchCommandMetadata(metadata, {
  launchBytes,
  parentRunId,
  childRunId,
  handoffRel,
  projectRootDigest,
  projectBindingGeneration,
  boundaryEvent,
  generatedAt,
} = {}) {
  const envelopeKeys = [
    'artifact_kind', 'generated_at', 'git', 'parent_run_id',
    'producer', 'provenance', 'run_id', 'schema',
  ];
  const payloadKeys = [
    'boundary_event', 'child_run_id', 'handoff_phase', 'handoff_rel',
    'launch_command_sha256', 'parent_run_id', 'project_binding_generation',
    'project_root_digest',
  ];
  const envelope = metadata?.envelope;
  const payload = metadata?.payload;
  const provenance = envelope?.provenance;
  if (!exactObjectKeys(metadata, ['schema_version', 'envelope', 'payload'])
    || metadata.schema_version !== '1.0'
    || !exactObjectKeys(envelope, envelopeKeys)
    || envelope.producer !== 'deep-loop'
    || envelope.artifact_kind !== 'launch-command-meta'
    || !exactObjectKeys(envelope.schema, ['name', 'version'])
    || envelope.schema.name !== 'launch-command-meta'
    || envelope.schema.version !== '1.0'
    || envelope.run_id !== childRunId
    || envelope.parent_run_id !== parentRunId
    || !canonicalIso(envelope.generated_at)
    || envelope.generated_at !== generatedAt
    || !exactObjectKeys(envelope.git, [])
    || !exactObjectKeys(provenance, ['source_artifacts', 'tool_versions'])
    || JSON.stringify(provenance.source_artifacts) !== JSON.stringify([handoffRel])
    || !exactObjectKeys(provenance.tool_versions, [])
    || !exactObjectKeys(payload, payloadKeys)
    || payload.launch_command_sha256 !== contentHash(launchBytes)
    || payload.parent_run_id !== parentRunId
    || payload.child_run_id !== childRunId
    || payload.handoff_phase !== 'emitted'
    || payload.handoff_rel !== handoffRel
    || payload.project_root_digest !== projectRootDigest
    || payload.project_binding_generation !== projectBindingGeneration
    || !exactObjectKeys(payload.boundary_event, ['checksum', 'seq'])
    || payload.boundary_event.seq !== boundaryEvent?.seq
    || payload.boundary_event.checksum !== boundaryEvent?.checksum) {
    return null;
  }
  return metadata;
}

function validateSpawnArgs({ parentRunId, childRunId, handoffRel }) {
  if (!SAFE_ID.test(String(parentRunId))) {
    throw Object.assign(new Error(`UNSAFE_SPAWN_ARG: parentRunId=${parentRunId}`), { code: 'UNSAFE_SPAWN_ARG' });
  }
  if (!SAFE_ID.test(String(childRunId))) {
    throw Object.assign(new Error(`UNSAFE_SPAWN_ARG: childRunId=${childRunId}`), { code: 'UNSAFE_SPAWN_ARG' });
  }
  if (!SAFE_HANDOFF_REL.test(String(handoffRel))) {
    throw Object.assign(new Error(`UNSAFE_SPAWN_ARG: handoffRel=${handoffRel}`), { code: 'UNSAFE_SPAWN_ARG' });
  }
}

export function resumeSkillToken(runtime = 'claude') {
  return skillToken(runtime, 'deep-loop-resume');
}

export function usageOutputKind(runtime = 'claude') {
  return runtimeCapability(runtime, 'usage_output_kind');
}

function resumeInvocation(runtime, root, runId) {
  return `${resumeSkillToken(runtime)} --project-root ${JSON.stringify(root)} --run-id ${JSON.stringify(runId)}`;
}

function recoveryAcquireInvocation({
  kind,
  runtime,
  root,
  runId,
  childRunId,
  recoveryRel,
  generation,
}) {
  const route = kind === 'affinity-supersession'
    ? `recovery acquire --capsule ${JSON.stringify(recoveryRel)}`
    : 'lease acquire';
  return `${route} --owner ${JSON.stringify(childRunId)} --generation ${generation}`
    + ` --runtime ${runtime} --project-root ${JSON.stringify(root)} --run-id ${JSON.stringify(runId)}`;
}

export function buildRecoveryResumeDescriptor({
  kind,
  runtime = 'claude',
  root,
  runId,
  childRunId,
  recoveryRel,
  generation,
} = {}) {
  const selectedRuntime = validateSessionRuntime(runtime);
  if (!['affinity-supersession', 'boundary-recovery'].includes(kind)
    || !SAFE_ID.test(String(runId))
    || !SAFE_ID.test(String(childRunId))
    || !SAFE_RECOVERY_REL.test(String(recoveryRel))
    || !Number.isSafeInteger(generation)
    || generation < 1
    || typeof root !== 'string'
    || root.length === 0
    || /[\0\r\n]/.test(root)) {
    throw new Error('RECOVERY_DESCRIPTOR_INVALID');
  }
  const acquireInvocation = recoveryAcquireInvocation({
    kind,
    runtime: selectedRuntime,
    root,
    runId,
    childRunId,
    recoveryRel,
    generation,
  });
  return Object.freeze({
    kind,
    runtime: selectedRuntime,
    projectRoot: root,
    runId,
    childRunId,
    recoveryRel,
    generation,
    resumeSkillToken: resumeSkillToken(selectedRuntime),
    resumeInvocation: acquireInvocation,
    acquireInvocation,
  });
}

export function buildRootRecoveryResumeDescriptor({
  runtime = 'claude',
  root,
  runId,
  childRunId,
  recoveryRel,
  generation,
  bindingGeneration,
} = {}) {
  const selectedRuntime = validateSessionRuntime(runtime);
  if (!SAFE_ID.test(String(runId))
    || !SAFE_ID.test(String(childRunId))
    || !SAFE_ROOT_RECOVERY_REL.test(String(recoveryRel))
    || !Number.isSafeInteger(generation) || generation < 1
    || !Number.isSafeInteger(bindingGeneration) || bindingGeneration < 1
    || typeof root !== 'string' || root.length === 0 || /[\0\r\n]/.test(root)) {
    throw new Error('ROOT_RECOVERY_DESCRIPTOR_INVALID');
  }
  const acquireInvocation = [
    'root recovery acquire',
    `--capsule ${JSON.stringify(recoveryRel)}`,
    `--owner ${JSON.stringify(childRunId)}`,
    `--generation ${generation}`,
    `--binding-generation ${bindingGeneration}`,
    `--runtime ${selectedRuntime}`,
    `--candidate-project-root ${JSON.stringify(root)}`,
    `--run-id ${JSON.stringify(runId)}`,
  ].join(' ');
  return {
    runtime: selectedRuntime,
    projectRoot: root,
    runId,
    childRunId,
    recoveryRel,
    generation,
    bindingGeneration,
    acquireInvocation,
    resumeInvocation: acquireInvocation,
  };
}

function targetPathApi(platform) {
  return platform === 'win32' ? win32 : posix;
}

function windowsFullyQualifiedPath(value, { allowUnc = true } = {}) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) return false;
  const normalized = value.replaceAll('/', '\\');
  if (/^[A-Za-z]:\\/.test(normalized)) return true;
  if (!allowUnc || !normalized.startsWith('\\\\') || /^\\\\[?.](?:\\|$)/.test(normalized)) return false;
  const [server, share] = normalized.slice(2).split('\\');
  return Boolean(server && share && !['.', '..'].includes(server) && !['.', '..'].includes(share));
}

function targetAbsolutePath(value, platform) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) return false;
  return platform === 'win32' ? windowsFullyQualifiedPath(value) : posix.isAbsolute(value);
}

function windowsNativeExecutablePath(path) {
  if (!windowsFullyQualifiedPath(path, { allowUnc: false })
    || /\.(?:cmd|bat|ps1|js|mjs|cjs)$/i.test(path)) return null;
  return path;
}

function windowsNativePath(identity, { runtime = null, kind = null } = {}) {
  const path = identity?.canonical_path;
  if (!identity || typeof identity !== 'object' || identity.platform !== 'win32'
    || !windowsNativeExecutablePath(path)
    || (runtime != null && identity.runtime !== runtime)
    || (kind != null && identity.kind !== kind)) return null;
  return path;
}

function unavailableEntry(surface, reason) {
  return { unavailable: true, reason, display: `# ${surface}: manual (${reason})` };
}

function pathFor(platform, root, ...segments) {
  const api = targetPathApi(platform);
  if (!targetAbsolutePath(root, platform)) {
    throw Object.assign(
      new Error(`INVALID_TARGET_PATH: expected an absolute ${platform === 'win32' ? 'Windows' : 'POSIX'} path`),
      { code: 'INVALID_TARGET_PATH' },
    );
  }
  return api.join(root, ...segments);
}

function posixRuntimePath(identity, { runtime, platform }) {
  const path = identity?.canonical_path;
  if (!identity || typeof identity !== 'object' || platform === 'win32'
    || identity.platform !== platform || identity.runtime !== runtime
    || typeof path !== 'string' || !posix.isAbsolute(path) || /[\0\r\n]/.test(path)) return null;
  return path;
}

function codexExecutablePath({ platform, runtimeExecutableIdentity, codexExecutable }) {
  if (platform === 'win32') {
    return windowsNativePath(runtimeExecutableIdentity, { runtime: 'codex' })
      ?? windowsNativeExecutablePath(codexExecutable);
  }
  if (runtimeExecutableIdentity != null) {
    return posixRuntimePath(runtimeExecutableIdentity, { runtime: 'codex', platform });
  }
  if (codexExecutable == null) return null;
  if (!targetAbsolutePath(codexExecutable, platform) || /[\0\r\n]/.test(codexExecutable)) {
    throw Object.assign(
      new Error('INVALID_CODEX_EXECUTABLE: executable must be absolute in the target platform namespace'),
      { code: 'INVALID_CODEX_EXECUTABLE' },
    );
  }
  return codexExecutable;
}

function codexVisibleExecutablePath(platform, runtimeExecutableIdentity) {
  if (platform === 'win32') {
    return windowsNativePath(runtimeExecutableIdentity, { runtime: 'codex' });
  }
  if (!['linux', 'darwin'].includes(platform)) return null;
  return posixRuntimePath(runtimeExecutableIdentity, { runtime: 'codex', platform });
}

function codexInteractiveArgv(root, prompt, model, effort) {
  return [
    '-C', root,
    ...(model == null ? [] : ['--model', model]),
    ...(effort == null ? [] : ['-c', `model_reasoning_effort=${tomlBasicString(effort)}`]),
    prompt,
  ];
}

function claudeInteractiveShellCommand(childRunId, prompt, model, effort) {
  return `claude -n ${q(`deep-loop-${childRunId}`)} ${q(prompt)}${meSh(q, model, effort)}`;
}

function codexInteractiveShellCommand(executable, root, prompt, model, effort) {
  return `${q(executable)} -C ${q(root)}`
    + `${model == null ? '' : ` --model ${q(model)}`}`
    + `${effort == null ? '' : ` -c ${q(`model_reasoning_effort=${tomlBasicString(effort)}`)}`}`
    + ` ${q(prompt)}`;
}

function tmuxEntry({
  root, launcher, launcherBin, launcherSocket, launcherSession, launcherIdentity,
  platform, resumeShellCommand,
}) {
  const approvedBin = launcherIdentity?.canonical_path;
  if (launcher !== 'tmux' || !['linux', 'darwin'].includes(platform)
    || launcherIdentity?.kind !== 'tmux' || launcherIdentity?.platform !== platform
    || launcherIdentity?.source !== 'human-explicit'
    || typeof approvedBin !== 'string' || !posix.isAbsolute(approvedBin)
    || launcherBin !== approvedBin
    || typeof launcherSocket !== 'string' || !posix.isAbsolute(launcherSocket) || /[\0\r\n]/.test(launcherSocket)
    || typeof launcherSession !== 'string' || !/^[0-9]+$/.test(launcherSession)
    || !targetAbsolutePath(root, platform)) {
    return unavailableEntry('tmux', 'trusted-posix-launcher-unavailable');
  }
  const argv = ['-S', launcherSocket, 'new-window', '-t', launcherSession, '-c', root, resumeShellCommand];
  return {
    bin: approvedBin,
    argv,
    shell: false,
    display: `${q(approvedBin)} -S ${q(launcherSocket)} new-window -t ${q(launcherSession)} -c ${q(root)} ${q(resumeShellCommand)}`,
  };
}

function codexInteractivePsArgs(root, prompt, model, effort) {
  return [
    `-C ${psArg(root)}`,
    ...(model == null ? [] : [`--model ${psArg(model)}`]),
    ...(effort == null ? [] : [`-c ${psArg(`model_reasoning_effort=${tomlBasicString(effort)}`)}`]),
    psArg(prompt),
  ].join(' ');
}

function buildGoalAcquirePrompt({ root, runId, childRunId, kernelPath }) {
  const script = [
    "const { spawnSync } = require('node:child_process');",
    `const nodeExecutable = ${JSON.stringify(process.execPath)};`,
    `const kernelPath = ${JSON.stringify(kernelPath)};`,
    `const projectRoot = ${JSON.stringify(root)};`,
    `const runId = ${JSON.stringify(runId)};`,
    `const childRunId = ${JSON.stringify(childRunId)};`,
    "const fail = (reason) => { process.stdout.write(`${JSON.stringify({ ok: false, reason })}\\n`); process.exit(1); };",
    "const runKernel = (args) => {",
    "  const result = spawnSync(nodeExecutable, [kernelPath, ...args, '--project-root', projectRoot, '--run-id', runId], { encoding: 'utf8', timeout: 15000, maxBuffer: 1048576, shell: false });",
    "  if (result.error || result.signal || result.status !== 0) fail(`goal-acquire-kernel-${result.error?.code || result.signal || result.status || 'failed'}`);",
    "  try { return JSON.parse(result.stdout); } catch { fail('goal-acquire-kernel-output-invalid'); }",
    "};",
    "const lease = runKernel(['state', 'get', '--field', 'session_chain.lease']);",
    "if (!lease || typeof lease !== 'object' || Array.isArray(lease) || lease.state !== 'releasing' || lease.handoff_phase !== 'spawned' || lease.handoff_child_run_id !== childRunId || !Number.isSafeInteger(lease.generation) || lease.generation < 1) fail('goal-acquire-lease-mismatch');",
    "const attemptId = 'goal_acquire_' + childRunId;",
    "const acquired = runKernel(['lease', 'acquire', '--owner', childRunId, '--expect-generation', String(lease.generation), '--runtime', 'codex', '--attempt-id', attemptId]);",
    "const consumed = acquired?.consumed;",
    "if (acquired?.ok !== true || acquired.reason !== 'acquired' || acquired.proceed !== true || acquired.replayed !== false || acquired.generation !== lease.generation + 1 || consumed?.takeover_kind !== 'boundary-handoff' || consumed.child_run_id !== childRunId || consumed.superseded_owner_run_id !== lease.owner_run_id || consumed.from_generation !== lease.generation || consumed.to_generation !== lease.generation + 1 || JSON.stringify(consumed.boundary_event) !== JSON.stringify(lease.handoff_boundary_event) || consumed.project_root_digest !== lease.handoff_project_root_digest || consumed.project_binding_generation !== lease.handoff_project_binding_generation) fail('goal-acquire-result-mismatch');",
    "process.stdout.write(`${JSON.stringify(acquired)}\\n`);",
  ].join('\n');
  const argv = [process.execPath, '-e', script];
  return [
    'This is an acquisition-only turn for one already-reserved deep-loop goal owner.',
    'Use exactly one native terminal tool call to execute the typed argv below. Do not alter, wrap, or split it.',
    `GOAL_ACQUIRE_ARGV_JSON=${JSON.stringify(argv)}`,
    'Do not read files, inspect the repository, edit source, initialize Git, invoke another command, or perform business work.',
    'Return only the script stdout, then stop. The host will verify the lease and provide the official owner frame on an exact-thread resume.',
  ].join('\n');
}

function buildCodexEntries({
  root, parentRunId, childRunId, handoffRel,
  launcher, launcherBin, launcherSocket, launcherSession, exists = existsSync,
  model = null, effort = null, codexExecutable = null, deepLoopRoot = null,
  platform = process.platform, runtimeExecutableIdentity = null, launcherIdentity = null,
  goalDriven = false,
}) {
  validateRuntimeProfile('codex', { model, effort }, { goalDriven });
  const invocation = resumeInvocation('codex', root, parentRunId);
  const handoffPath = pathFor(platform, root, '.deep-loop', 'runs', parentRunId, handoffRel);
  const manualPrompt = `Read ${JSON.stringify(handoffPath)} first; then run ${invocation}`;
  const unavailable = (surface) => ({
    unavailable: true,
    reason: CODEX_TRANSPORT_UNAVAILABLE,
    display: `# ${surface}: unavailable (${CODEX_TRANSPORT_UNAVAILABLE})`,
  });
  const entries = {
    cmux: unavailable('cmux'),
    tmux: unavailable('tmux'),
    iterm2: unavailable('iterm2'),
    'terminal-app': unavailable('terminal-app'),
    wt: unavailable('wt'),
    powershell: unavailable('powershell'),
    desktop: {
      unavailable: true,
      reason: CODEX_TRANSPORT_UNAVAILABLE,
      manual: true,
      display: `# Codex App (manual): open a new task at ${JSON.stringify(root)}; then enter ${invocation}`,
    },
    headless: unavailable('headless'),
    interactive: {
      manual: true,
      display: `# Codex CLI (manual): open a new task at ${JSON.stringify(root)}; ${manualPrompt}`,
    },
  };
  const effectiveExecutable = codexExecutablePath({ platform, runtimeExecutableIdentity, codexExecutable });
  const visibleExecutable = codexVisibleExecutablePath(platform, runtimeExecutableIdentity);
  if (effectiveExecutable != null) {
    if (!targetAbsolutePath(deepLoopRoot, platform)) throw new Error('INVALID_DEEP_LOOP_ROOT: explicit absolute deep-loop root required');
    const prompt = goalDriven
      ? buildGoalAcquirePrompt({
          root,
          runId: parentRunId,
          childRunId,
          kernelPath: pathFor(platform, deepLoopRoot, 'scripts', 'deep-loop.mjs'),
        })
      : `Read ${JSON.stringify(handoffPath)} first. Then read ${JSON.stringify(pathFor(platform, deepLoopRoot, 'skills', 'deep-loop-resume', 'SKILL.md'))} and execute that workflow inline for project root ${JSON.stringify(root)} and run id ${JSON.stringify(parentRunId)}.`;
    const buildHeadlessEntry = goalDriven ? buildCodexGoalOwnerEntry : buildCodexExecEntry;
    entries.headless = {
      ...buildHeadlessEntry({ executable: effectiveExecutable, projectRoot: root, prompt, model, effort }),
      ...(platform === 'win32' ? { platform: 'win32', shell: false } : {}),
      display: `# Codex CLI headless: ${JSON.stringify(effectiveExecutable)} (isolated descriptor; prompt via stdin)`,
    };
    if (platform === 'win32') {
      const wtBin = windowsNativePath(launcherIdentity, { kind: 'wt' });
      const psBin = windowsNativePath(launcherIdentity, { kind: 'powershell' });
      const interactiveArgv = codexInteractiveArgv(root, manualPrompt, model, effort);
      const interactivePsArgs = codexInteractivePsArgs(root, manualPrompt, model, effort);
      entries.wt = wtBin
        ? {
          platform: 'win32', bin: wtBin,
          argv: ['-d', root, effectiveExecutable, ...interactiveArgv],
          nativeExecutableArgvIndices: [2], shell: false,
          display: `& ${psArg(wtBin)} -d ${psArg(root)} ${psArg(effectiveExecutable)} ${interactivePsArgs}`,
        }
        : unavailableEntry('wt', 'trusted-native-identity-unavailable');
      if (psBin) {
        const innerPS = `Set-Location -LiteralPath ${psArg(root)}; & ${psArg(effectiveExecutable)} ${interactivePsArgs}`;
        const b64 = Buffer.from(innerPS, 'utf16le').toString('base64');
        const psCmd = `Start-Process ${psArg(psBin)} -ArgumentList '-NoProfile','-NoExit','-EncodedCommand','${b64}'`;
        entries.powershell = {
          platform: 'win32', bin: psBin,
          argv: ['-NoProfile', '-NonInteractive', '-Command', psCmd], shell: false,
          nativeExecutableTargets: [effectiveExecutable],
          display: `& ${psArg(psBin)} -NoProfile -NonInteractive -Command ${psArg(psCmd)}`,
        };
      } else {
        entries.powershell = unavailableEntry('powershell', 'trusted-native-identity-unavailable');
      }
    } else if (visibleExecutable != null) {
      const interactiveArgv = codexInteractiveArgv(root, manualPrompt, model, effort);
      const interactiveCommand = [visibleExecutable, ...interactiveArgv].map(q).join(' ');
      const tmuxResumeShellCommand = codexInteractiveShellCommand(visibleExecutable, root, manualPrompt, model, effort);
      if (launcher === 'cmux' && typeof launcherBin === 'string' && posix.isAbsolute(launcherBin)
        && typeof launcherSocket === 'string' && launcherSocket.length > 0) {
        const cmuxArgv = [
          '--socket', launcherSocket,
          'new-workspace', '--cwd', root,
          '--command', interactiveCommand,
          '--focus', 'true',
        ];
        entries.cmux = {
          bin: launcherBin,
          argv: cmuxArgv,
          shell: false,
          display: `${q(launcherBin)} --socket ${q(launcherSocket)} new-workspace --cwd ${q(root)} --command ${q(interactiveCommand)} --focus true`,
        };
      } else {
        entries.cmux = unavailableEntry('cmux', 'trusted-posix-launcher-unavailable');
      }
      entries.tmux = tmuxEntry({
        root, launcher, launcherBin, launcherSocket, launcherSession, launcherIdentity,
        platform, resumeShellCommand: tmuxResumeShellCommand,
      });

      const osascript = '/usr/bin/osascript';
      if (platform === 'darwin' && exists(osascript)) {
        const innerSh = `cd ${q(root)} && exec ${interactiveCommand}`;
        const iterm2Script = `tell application "iTerm" to create window with default profile command "${escApple(innerSh)}"`;
        const terminalScript = `tell application "Terminal" to do script "${escApple(innerSh)}"`;
        entries.iterm2 = launcher === 'iterm2'
          ? {
            bin: osascript,
            argv: ['-e', iterm2Script],
            shell: false,
            display: `${q(osascript)} -e ${q(iterm2Script)}`,
          }
          : unavailableEntry('iterm2', 'launcher-not-selected');
        entries['terminal-app'] = launcher === 'terminal-app'
          ? {
            bin: osascript,
            argv: ['-e', terminalScript],
            shell: false,
            display: `${q(osascript)} -e ${q(terminalScript)}`,
          }
          : unavailableEntry('terminal-app', 'launcher-not-selected');
      } else {
        entries.iterm2 = unavailableEntry('iterm2', `unsupported-on-${platform}`);
        entries['terminal-app'] = unavailableEntry('terminal-app', `unsupported-on-${platform}`);
      }
    }
  }
  return entries;
}

function buildClaudeEntries({
  root, parentRunId, childRunId, handoffRel,
  launcher, launcherBin, launcherSocket, launcherSession,
  platform = process.platform, desktopTarget = null, exists = existsSync,
  model = null, effort = null,
  runtimeExecutableIdentity = null, launcherIdentity = null,
}) {
  const resumePrompt = `Read .deep-loop/runs/${parentRunId}/${handoffRel} first; then run /deep-loop-resume`;
  const inner = `deep-loop-${childRunId}`;

  // Desktop URLs remain a Claude-only machine argv detail. No URL is ever put
  // in a human-readable display field.
  const desktopUrl = `claude://code/new?folder=${encodeURIComponent(root)}&q=${encodeURIComponent(resumePrompt)}`;
  let desktopEntry;
  if (desktopTarget && desktopTarget.kind === 'macos-app' && platform === 'darwin') {
    desktopEntry = { bin: '/usr/bin/open', argv: ['-a', desktopTarget.appPath, desktopUrl], available: true };
  } else if (desktopTarget && desktopTarget.kind === 'win-exe' && platform === 'win32') {
    const psBin = windowsNativePath(launcherIdentity, { kind: 'powershell' });
    if (psBin) {
      const psCmd = `Start-Process -FilePath '${psq(desktopTarget.exePath)}' -ArgumentList '${psq(desktopUrl)}'`;
      desktopEntry = { bin: psBin, argv: ['-NoProfile', '-NonInteractive', '-Command', psCmd], available: true, platform: 'win32', shell: false };
    } else {
      desktopEntry = { unavailable: true };
    }
  } else {
    desktopEntry = { unavailable: true };
  }

  const cmuxCmdStr = claudeInteractiveShellCommand(childRunId, resumePrompt, model, effort);
  const cmuxArgv = launcherSocket
    ? ['--socket', launcherSocket, 'new-workspace', '--cwd', root, '--command', cmuxCmdStr, '--focus', 'true']
    : ['new-workspace', '--cwd', root, '--command', cmuxCmdStr, '--focus', 'true'];
  const effectiveBin = (launcher == null || launcher === 'cmux') && launcherBin ? launcherBin : 'cmux';

  const innerSh = `cd ${q(root)} && claude -n ${inner} "${resumePrompt}"${meSh(q, model, effort)}`;
  const iterm2Script = `tell application "iTerm" to create window with default profile command "${escApple(innerSh)}"`;
  const terminalScript = `tell application "Terminal" to do script "${escApple(innerSh)}"`;

  let powershellEntry;
  if (isTrustedPsBin(launcherBin)) {
    const innerPS = `Set-Location -LiteralPath '${psq(root)}'; & claude -n '${psq(inner)}' '${psq(resumePrompt)}'${meSh((x) => `'${psq(x)}'`, model, effort)}`;
    const b64 = Buffer.from(innerPS, 'utf16le').toString('base64');
    const psCmd = `Start-Process '${psq(launcherBin)}' -ArgumentList '-NoProfile','-NoExit','-EncodedCommand','${b64}'`;
    powershellEntry = { bin: launcherBin, argv: ['-NoProfile', '-NonInteractive', '-Command', psCmd], display: `& '${psq(launcherBin)}' -NoProfile -NonInteractive -Command "${psCmd}"` };
  } else {
    powershellEntry = { bin: null, argv: null, unavailable: true, display: '# powershell: unavailable (no trusted launcher_bin)' };
  }

  const headlessDisplay = `cd ${q(root)} && claude -p "${resumePrompt}"${meSh(q, model, effort)} --output-format json --permission-mode acceptEdits`;
  const interactiveDisplay = `cd ${q(root)} && claude -n ${inner} "${resumePrompt}"${meSh(q, model, effort)}`;
  const cmuxDisplay = `${effectiveBin}${launcherSocket ? ` --socket ${q(launcherSocket)}` : ''} new-workspace --cwd ${q(root)} --command ${q(cmuxCmdStr)} --focus true`;

  if (platform === 'win32') {
    const runtimeBin = windowsNativePath(runtimeExecutableIdentity, { runtime: 'claude' });
    const wtBin = windowsNativePath(launcherIdentity, { kind: 'wt' });
    const psBin = windowsNativePath(launcherIdentity, { kind: 'powershell' });
    const manual = `# Claude CLI (manual): open a native Claude session at ${JSON.stringify(root)}; then run /deep-loop-resume`;
    let windowsPs = unavailableEntry('powershell', 'trusted-native-identity-unavailable');
    if (runtimeBin && psBin) {
      const innerPS = `Set-Location -LiteralPath '${psq(root)}'; & '${psq(runtimeBin)}' -n '${psq(inner)}' '${psq(resumePrompt)}'${meSh((x) => `'${psq(x)}'`, model, effort)}`;
      const b64 = Buffer.from(innerPS, 'utf16le').toString('base64');
      const psCmd = `Start-Process '${psq(psBin)}' -ArgumentList '-NoProfile','-NoExit','-EncodedCommand','${b64}'`;
      windowsPs = {
        platform: 'win32', bin: psBin, argv: ['-NoProfile', '-NonInteractive', '-Command', psCmd], shell: false,
        nativeExecutableTargets: [runtimeBin],
        display: `& '${psq(psBin)}' -NoProfile -NonInteractive -Command ${psArg(psCmd)}`,
      };
    }
    const wt = runtimeBin && wtBin
      ? {
        platform: 'win32', bin: wtBin,
        argv: ['-d', root, runtimeBin, '-n', inner, resumePrompt, ...meArgv(model, effort)],
        nativeExecutableArgvIndices: [2], shell: false,
        display: `& ${psArg(wtBin)} -d ${psArg(root)} ${psArg(runtimeBin)} -n ${psArg(inner)} ${psArg(resumePrompt)}${meSh(psArg, model, effort)}`,
      }
      : unavailableEntry('wt', 'trusted-native-identity-unavailable');
    const headless = runtimeBin
      ? {
        platform: 'win32', bin: runtimeBin,
        argv: ['-p', resumePrompt, ...meArgv(model, effort), '--output-format', 'json', '--permission-mode', 'acceptEdits'],
        cwd: root, shell: false, usageOutputKind: 'claude-json',
        display: `# Claude CLI headless: ${JSON.stringify(runtimeBin)} (trusted native identity)`,
      }
      : unavailableEntry('headless', 'trusted-native-runtime-unavailable');
    return {
      cmux: unavailableEntry('cmux', 'native-windows-launcher-unavailable'),
      tmux: unavailableEntry('tmux', 'native-windows-launcher-unavailable'),
      iterm2: unavailableEntry('iterm2', 'unsupported-on-win32'),
      'terminal-app': unavailableEntry('terminal-app', 'unsupported-on-win32'),
      wt,
      powershell: windowsPs,
      desktop: desktopEntry,
      headless,
      interactive: { manual: true, display: manual },
    };
  }

  return {
    cmux: {
      bin: effectiveBin,
      argv: cmuxArgv,
      display: cmuxDisplay,
    },
    tmux: tmuxEntry({
      root, launcher, launcherBin, launcherSocket, launcherSession, launcherIdentity,
      platform, resumeShellCommand: cmuxCmdStr,
    }),
    iterm2: {
      bin: 'osascript',
      argv: ['-e', iterm2Script],
      display: `osascript -e '${iterm2Script}'`,
    },
    'terminal-app': {
      bin: 'osascript',
      argv: ['-e', terminalScript],
      display: `osascript -e '${terminalScript}'`,
    },
    wt: {
      bin: 'wt.exe',
      argv: ['-d', root, 'claude', '-n', inner, resumePrompt, ...meArgv(model, effort)],
      display: `wt.exe -d ${q(root)} claude -n ${inner} "${resumePrompt}"${meSh(q, model, effort)}`,
    },
    powershell: powershellEntry,
    desktop: desktopEntry,
    headless: {
      bin: 'claude',
      argv: ['-p', resumePrompt, ...meArgv(model, effort), '--output-format', 'json', '--permission-mode', 'acceptEdits'],
      cwd: root,
      usageOutputKind: 'claude-json',
      display: headlessDisplay,
    },
    interactive: {
      display: interactiveDisplay,
    },
  };
}

function grokModelSh(quote, model) {
  return model ? ` --model ${quote(model)}` : '';
}

function grokCanonicalPath(runtimeExecutableIdentity, platform) {
  if (platform !== 'darwin') return null;
  return posixRuntimePath(runtimeExecutableIdentity, { runtime: 'grok', platform });
}

function buildGrokEntries({
  root, parentRunId, childRunId, handoffRel,
  launcher, launcherBin, launcherSocket, launcherSession,
  platform = process.platform, exists = existsSync,
  model = null, effort = null,
  runtimeExecutableIdentity = null, launcherIdentity = null,
}) {
  void childRunId;
  validateRuntimeProfile('grok', { model, effort });
  const closed = (surface, reason) => unavailableEntry(surface, reason);
  if (platform !== 'darwin') {
    const reason = `unsupported-on-${platform}`;
    return {
      cmux: closed('cmux', reason),
      tmux: closed('tmux', reason),
      iterm2: closed('iterm2', reason),
      'terminal-app': closed('terminal-app', reason),
      wt: closed('wt', reason),
      powershell: closed('powershell', reason),
      desktop: closed('desktop', reason),
      headless: closed('headless', reason),
      interactive: closed('interactive', reason),
    };
  }
  const canonical = grokCanonicalPath(runtimeExecutableIdentity, platform);
  if (canonical == null) {
    const reason = 'runtime-identity-unavailable';
    return {
      cmux: closed('cmux', reason),
      tmux: closed('tmux', reason),
      iterm2: closed('iterm2', reason),
      'terminal-app': closed('terminal-app', reason),
      wt: closed('wt', reason),
      powershell: closed('powershell', reason),
      desktop: closed('desktop', reason),
      headless: closed('headless', reason),
      interactive: closed('interactive', reason),
    };
  }
  const resumePrompt = `Read .deep-loop/runs/${parentRunId}/${handoffRel} first; then run /deep-loop-resume`;
  const interactiveDisplay = `cd ${q(root)} && ${q(canonical)} ${q(resumePrompt)}${grokModelSh(q, model)}`;
  const resumeShellCommand = `${q(canonical)} ${q(resumePrompt)}${grokModelSh(q, model)}`;
  const cmuxCommand = `${q(canonical)} ${q(resumePrompt)}${grokModelSh(q, model)}`;
  let cmux = closed('cmux', 'trusted-posix-launcher-unavailable');
  if (launcher === 'cmux' && typeof launcherBin === 'string' && posix.isAbsolute(launcherBin)
    && typeof launcherSocket === 'string' && launcherSocket.length > 0) {
    const cmuxArgv = [
      '--socket', launcherSocket,
      'new-workspace', '--cwd', root,
      '--command', cmuxCommand,
      '--focus', 'true',
    ];
    cmux = {
      bin: launcherBin,
      argv: cmuxArgv,
      shell: false,
      display: `${q(launcherBin)} --socket ${q(launcherSocket)} new-workspace --cwd ${q(root)} --command ${q(cmuxCommand)} --focus true`,
    };
  }
  const osascript = '/usr/bin/osascript';
  let iterm2 = closed('iterm2', exists(osascript) ? 'launcher-not-selected' : 'osascript-unavailable');
  let terminalApp = closed('terminal-app', exists(osascript) ? 'launcher-not-selected' : 'osascript-unavailable');
  if (exists(osascript)) {
    const innerSh = `cd ${q(root)} && exec ${resumeShellCommand}`;
    const iterm2Script = `tell application "iTerm" to create window with default profile command "${escApple(innerSh)}"`;
    const terminalScript = `tell application "Terminal" to do script "${escApple(innerSh)}"`;
    if (launcher === 'iterm2') {
      iterm2 = {
        bin: osascript,
        argv: ['-e', iterm2Script],
        shell: false,
        display: `${q(osascript)} -e ${q(iterm2Script)}`,
      };
    }
    if (launcher === 'terminal-app') {
      terminalApp = {
        bin: osascript,
        argv: ['-e', terminalScript],
        shell: false,
        display: `${q(osascript)} -e ${q(terminalScript)}`,
      };
    }
  }
  return {
    cmux,
    tmux: tmuxEntry({
      root, launcher, launcherBin, launcherSocket, launcherSession, launcherIdentity,
      platform, resumeShellCommand,
    }),
    iterm2,
    'terminal-app': terminalApp,
    wt: closed('wt', 'grok-transport-unavailable'),
    powershell: closed('powershell', 'grok-transport-unavailable'),
    desktop: closed('desktop', 'grok-transport-unavailable'),
    headless: closed('headless', 'grok-transport-unavailable'),
    interactive: { display: interactiveDisplay },
  };
}

const ENTRY_BUILDERS = Object.freeze({
  claude: buildClaudeEntries,
  codex: buildCodexEntries,
  grok: buildGrokEntries,
});

const RESUME_PROMPTS = Object.freeze({
  claude: ({ parentRunId, handoffRel }) =>
    `Read .deep-loop/runs/${parentRunId}/${handoffRel} first; then run /deep-loop-resume`,
  grok: ({ parentRunId, handoffRel }) =>
    `Read .deep-loop/runs/${parentRunId}/${handoffRel} first; then run /deep-loop-resume`,
  codex: ({ platform, root, parentRunId, handoffRel, invocation }) =>
    `Read ${JSON.stringify(pathFor(platform, root, '.deep-loop', 'runs', parentRunId, handoffRel))} first; then run ${invocation}`,
});

export function buildRuntimeResumeDescriptor({
  runtime = 'claude', root, parentRunId, childRunId, handoffRel,
  launcher, launcherBin, launcherSocket, launcherSession,
  platform = process.platform, desktopTarget = null, exists = existsSync,
  model = null, effort = null,
  goalDriven = false,
  codexExecutable = null, deepLoopRoot = null,
  runtimeExecutableIdentity = null, launcherIdentity = null,
} = {}) {
  const selectedRuntime = validateSessionRuntime(runtime);
  if (typeof goalDriven !== 'boolean') throw new Error('INVALID_GOAL_MODE: goalDriven must be boolean');
  validateRuntimeProfile(selectedRuntime, { model, effort }, { goalDriven });
  validateSpawnArgs({ parentRunId, childRunId, handoffRel });
  const invocation = resumeInvocation(selectedRuntime, root, parentRunId);
  const buildPrompt = RESUME_PROMPTS[selectedRuntime];
  const buildEntries = ENTRY_BUILDERS[selectedRuntime];
  if (buildPrompt === undefined || buildEntries === undefined) {
    throw new Error(`INVALID_RUNTIME: no descriptor strategy for ${selectedRuntime}`);
  }
  const resumePrompt = buildPrompt({ platform, root, parentRunId, handoffRel, invocation });
  const entries = buildEntries({
    root, parentRunId, childRunId, handoffRel,
    launcher, launcherBin, launcherSocket, launcherSession,
    platform, desktopTarget, exists, model, effort,
    goalDriven,
    codexExecutable, deepLoopRoot,
    runtimeExecutableIdentity, launcherIdentity,
  });
  return {
    runtime: selectedRuntime,
    projectRoot: root,
    runId: parentRunId,
    childRunId,
    handoffRel,
    resumeSkillToken: resumeSkillToken(selectedRuntime),
    usageOutputKind: usageOutputKind(selectedRuntime),
    resumeInvocation: invocation,
    resumePrompt,
    entries,
    ...(goalDriven ? { goalDriven: true } : {}),
  };
}

// Compatibility surface: callers historically imported this from handoff.mjs
// and expect the launcher entry map directly.
export function buildLaunchCommand(options = {}) {
  return buildRuntimeResumeDescriptor(options).entries;
}
