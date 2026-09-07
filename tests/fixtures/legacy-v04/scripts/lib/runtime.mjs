export const SESSION_RUNTIMES = Object.freeze(['claude', 'codex', 'grok']);

// 각 필드 주석은 소비자 목록이다(유일 소비자 선언이 아니다).
// claude/codex 값은 1.16 동작의 전사다. grok 값은 Phase 0 attended-Darwin 계약이다.
export const RUNTIME_CAPABILITIES = Object.freeze({
  claude: Object.freeze({
    skill_token_style: 'slash',                      // runtime-descriptor:123 · checkpoint:846 · sessionstart-restore:199,202,213
    provider_label: 'claude-code',                   // checkpoint:1007 · deep-loop:919 · precompact-handoff:40
    usage_output_kind: 'claude-json',                // runtime-descriptor:129 · headless-host 계상 술어
    entrypoint_heuristic: 'claude-code',             // respawn:197 · checkpoint:1172
    desktop_transport: true,                         // handoff:30,232,532 · respawn:499,584
    unattended_checker: false,                       // headless-host:412
    requires_process_preflight: false,               // headless-host:1187,1319
    requires_process_receipt_settlement: false,      // headless-host:1062
    requires_posix_visible_executable_trust: false,  // respawn:490 (플랫폼·모드 조건은 호출부에 남는다)
    max_effort_supported: true,                      // session-profile:27
    executable_name: 'claude',                       // runtime-executable:577
    version_probe: 'claude',                         // runtime-executable:375
    supported_platforms: Object.freeze(['darwin', 'linux', 'win32']), // assertRuntimePlatform · acquireLease · acquireRecovery · acquireRootRecovery · initrun
    measured_headless: true,                         // headless-host skip rewrite / would-spawn pause
    session_effort_allowed: 'kernel-set',            // session-profile validateRuntimeProfile
    compact_supported: true,                         // next-action withAdvice
    compact_measured_cli_versions: null,             // compactSupportedOnHost — unrestricted
    handoff_continuity_note: 'desktop-model-effort',  // handoff markdown
    observation_runtime: 'claude_code',              // route-observation RouteObservationV1 producer runtime
    independent_checker_bridge: null,                // checker-bridge:probeCheckerBridge
  }),
  codex: Object.freeze({
    skill_token_style: 'dollar',
    provider_label: 'codex',
    usage_output_kind: 'codex-jsonl',
    entrypoint_heuristic: null,
    desktop_transport: false,
    unattended_checker: true,
    requires_process_preflight: true,
    requires_process_receipt_settlement: true,
    requires_posix_visible_executable_trust: true,
    max_effort_supported: false,
    executable_name: 'codex',
    version_probe: 'codex',
    supported_platforms: Object.freeze(['darwin', 'linux', 'win32']),
    measured_headless: true,
    session_effort_allowed: 'kernel-set',
    compact_supported: true,
    compact_measured_cli_versions: null,
    handoff_continuity_note: 'codex-preflight',
    observation_runtime: 'codex',
    independent_checker_bridge: null,                // checker-bridge:probeCheckerBridge
  }),
  grok: Object.freeze({
    skill_token_style: 'slash',
    provider_label: 'grok',
    usage_output_kind: 'unmeasured',
    entrypoint_heuristic: null,
    desktop_transport: false,
    unattended_checker: false,
    requires_process_preflight: false,
    requires_process_receipt_settlement: false,
    requires_posix_visible_executable_trust: true,
    max_effort_supported: false,
    executable_name: 'grok',
    version_probe: 'grok',
    supported_platforms: Object.freeze(['darwin']),
    measured_headless: false,
    session_effort_allowed: 'none',
    compact_supported: false,
    compact_measured_cli_versions: Object.freeze([]),
    handoff_continuity_note: 'grok-attended',
    observation_runtime: 'grok',
    independent_checker_bridge: 'model-router-separate-process', // checker-bridge:probeCheckerBridge
  }),
});

export function classifyCompactHost({
  compact_supported,
  compact_measured_cli_versions,
  approval,
  session_runtime,
} = {}) {
  if (compact_supported !== true) return 'unsupported';
  if (compact_measured_cli_versions === null) return 'enabled';
  if (!Array.isArray(compact_measured_cli_versions) || compact_measured_cli_versions.length === 0) {
    return 'unsupported';
  }
  const runtime = approval && typeof approval === 'object' && !Array.isArray(approval)
    ? approval.runtime
    : undefined;
  const version = approval && typeof approval === 'object' && !Array.isArray(approval)
    ? approval.version
    : undefined;
  if (runtime !== session_runtime || typeof version !== 'string' || version.length === 0) {
    return 'needs-approval';
  }
  if (compact_measured_cli_versions.includes(version)) return 'enabled';
  return 'version-mismatch';
}

export function classifyCompactHostForLoop(loop) {
  const runtime = sessionRuntime(loop);
  return classifyCompactHost({
    compact_supported: runtimeCapability(runtime, 'compact_supported'),
    compact_measured_cli_versions: runtimeCapability(runtime, 'compact_measured_cli_versions'),
    approval: loop?.autonomy?.runtime_executable_approval ?? null,
    session_runtime: runtime,
  });
}

export function compactSupportedOnHost(loop) {
  return classifyCompactHostForLoop(loop) === 'enabled';
}

export function runtimeCapability(runtime, field) {
  const selected = validateSessionRuntime(runtime);
  const row = RUNTIME_CAPABILITIES[selected];
  if (row === undefined) {
    throw new Error(`UNKNOWN_RUNTIME_CAPABILITY: ${selected} has no capability row`);
  }
  if (!Object.hasOwn(row, field)) {
    throw new Error(`UNKNOWN_RUNTIME_CAPABILITY: ${selected}.${field}`);
  }
  return row[field];
}

export function assertRuntimePlatform(runtime, platform) {
  const allowed = runtimeCapability(runtime, 'supported_platforms');
  if (!allowed.includes(platform)) {
    throw Object.assign(
      new Error(`UNSUPPORTED_RUNTIME_PLATFORM: ${runtime} on ${platform}`),
      { code: 'UNSUPPORTED_RUNTIME_PLATFORM' },
    );
  }
}

// `deep-loop-compact restore`처럼 인자가 붙는 형태도 그대로 받는다.
// 현행 출력과 문자 그대로 같아야 한다 — 특성화 테스트가 이를 고정한다.
export function skillToken(runtime, skillWithArgs) {
  return runtimeCapability(runtime, 'skill_token_style') === 'dollar'
    ? `$deep-loop:${skillWithArgs}`
    : `/${skillWithArgs}`;
}

export function validateSessionRuntime(value) {
  if (!SESSION_RUNTIMES.includes(value)) {
    throw new Error(`INVALID_RUNTIME: expected claude, codex, or grok, got ${String(value)}`);
  }
  return value;
}

export function sessionRuntime(loop) {
  const autonomy = loop?.autonomy;
  if (autonomy === null || typeof autonomy !== 'object' || Array.isArray(autonomy)) {
    throw new Error('INVALID_RUNTIME_STATE: autonomy must be object');
  }
  const stored = autonomy.session_runtime;
  const source = autonomy.runtime_source;
  if (stored === undefined && source === undefined) return 'claude';
  if (stored === undefined) {
    throw new Error('INVALID_RUNTIME_STATE: runtime_source requires session_runtime');
  }
  if (source !== 'skill-asserted') {
    throw new Error('INVALID_RUNTIME_STATE: session_runtime requires runtime_source skill-asserted');
  }
  return validateSessionRuntime(stored);
}

// Do not treat sessionRuntime's legacy 'claude' fallback as a host identity.
export function readableSessionRuntime(loop) {
  if (loop?.autonomy?.session_runtime === undefined) return null;
  try {
    return sessionRuntime(loop);
  } catch {
    return null;
  }
}

export function runtimeFence(loop, assertedRuntime) {
  const actual = validateSessionRuntime(assertedRuntime);
  const expected = sessionRuntime(loop);
  return expected === actual
    ? { ok: true, runtime: expected }
    : { ok: false, reason: 'RUNTIME_FENCED', expected, actual };
}
