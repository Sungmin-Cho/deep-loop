#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { error } from './lib/log.mjs';
import { classifyKernelError, kernelFailure } from './lib/kernel-failure.mjs';
import {
  HANDLER_OWNED_GRAMMAR,
  ROUTE_FLAGS,
  consumedPositionalCount,
  formatUnknownFlag,
  renderHelp,
  vocabulary,
} from './lib/route-flags.mjs';
import { initRun, buildInitialLoop } from './lib/initrun.mjs';
import { detectPlugins } from './lib/detect.mjs';
import { matchRecipe, recipesDir, validateRecipesDir } from './lib/recipes.mjs';
import { json } from './lib/log.mjs';
import { LAUNCHER_KINDS, validate as validateLoop } from './lib/schema.mjs';
import {
  captureReconciledRunSnapshot,
  writeState,
  patch as patchState,
  pauseRun,
  runDir,
  findRoot,
} from './lib/state.mjs';
import {
  captureVerifiedRunSet,
  captureVerifiedRunSnapshot,
} from './lib/integrity.mjs';
import { resolveRunContext } from './lib/run-context.mjs';
import { leaseCheck, acquireLease, releaseLease, sameBoundaryEvent } from './lib/lease.mjs';
import { newWorkstream, setWorkstreamStatus, recordWorkstreamTerminal } from './lib/workspace.mjs';
import { newEpisode, recordEpisode, abandonEpisode } from './lib/episode.mjs';
import { projectObservationForCli } from './lib/route-observation.mjs';
import {
  configureReviewFlags,
  dispatchReview,
  importReviewOutcome,
  recordReviewOutcome,
} from './lib/review.mjs';
import { probeCheckerBridge } from './lib/checker-bridge.mjs';
import { readBoundedText } from './lib/bounded-input.mjs';
import { nextAction } from './lib/next-action.mjs';
import { emitHandoff } from './lib/handoff.mjs';
import { respawn, respawnGate, resolveSpawnMode } from './lib/respawn.mjs';
import { visibleSpawn } from './lib/spawn-driver.mjs';
import { driveHeadlessRun } from './lib/headless-host.mjs';
import { resolveAdapter, guardTierProtocol, loadProtocol } from './lib/adapters.mjs';
import {
  recordCost,
  checkBudget,
  extendBudget,
  recoveryReservationKind,
} from './lib/budget.mjs';
import { computeDebt, ack as ackComprehension } from './lib/comprehension.mjs';
import { checkBreaker, resetBreaker } from './lib/breaker.mjs';
import { offerDesktop, confirmDesktop, declineDesktop, resetDesktop } from './lib/spawn-optin.mjs';
import { approveAttendedLaunch, revokeAttendedLaunch } from './lib/attended-launch.mjs';
import { setSessionProfile } from './lib/session-profile.mjs';
import { defaultDesktopProbe } from './lib/desktop-target.mjs';
import { finishRun } from './lib/finish.mjs';
import { detectAndPersist } from './lib/detect-terminal.mjs';
import {
  acquireRecovery,
  recoverRun,
  supersedeAffinity,
} from './lib/recover.mjs';
import {
  captureLatestInsightsSet,
  captureVerifiedInsightsRunSet,
  captureReconciledRunSet,
  computeInsights,
  emitInsights,
  latestInsights,
  validateLedger,
} from './lib/insights.mjs';
import {
  acquireRootRecovery,
  diagnoseVerifiedProjectRoot,
  rebindProjectRoot,
  recoverRelocatedRoot,
} from './lib/project-root-recovery.mjs';
import {
  approveLauncherExecutable,
  approveRuntimeExecutable,
  diagnoseLauncherExecutable,
  diagnoseRuntimeExecutable,
} from './lib/runtime-executable.mjs';
import { runtimeCapability, sessionRuntime, validateSessionRuntime } from './lib/runtime.mjs';
import { canonicalProjectRoot, projectRootDigest } from './lib/project-root.mjs';
import { resolveRunPath } from './lib/path-resolve.mjs';
import {
  buildRecoveryResumeDescriptor,
  buildRootRecoveryResumeDescriptor,
  buildRuntimeResumeDescriptor,
  validateLaunchCommandMetadata,
} from './lib/runtime-descriptor.mjs';
import {
  emitCompactCheckpoint,
  inspectCompactCheckpoint,
  observeCompactCheckpoint,
  restoreCompactCheckpoint,
} from './lib/checkpoint.mjs';

const DEEP_LOOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const body = argv[i].slice(2);
    // Support the `--key=value` single-token form (previously silently became a literal key with no
    // value → a flag like `--model=opus` was dropped). Only splits when the '=' is in the SAME token;
    // the space form `--key value` (and values that themselves contain '=') are unaffected.
    const eq = body.indexOf('=');
    if (eq >= 0) { f[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    const v = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    f[body] = v;
  }
  return f;
}

function parseSessionProfileFlags(f) {
  const supplied = f['session-profile'] !== undefined;
  if (supplied && (f.model !== undefined || f.effort !== undefined)) {
    return { error: 'USAGE: --session-profile cannot be combined with --model/--effort', code: 2 };
  }
  if (f['session-profile'] === true || f['session-profile'] === '') {
    return { error: 'USAGE: --session-profile requires non-empty JSON', code: 2 };
  }
  if (!supplied) {
    return {
      value: {
        ...(f.model !== undefined ? { model: String(f.model) } : {}),
        ...(f.effort !== undefined ? { effort: String(f.effort) } : {}),
      },
      source: 'legacy',
    };
  }
  let value;
  try { value = JSON.parse(f['session-profile']); }
  catch { return { error: 'INVALID_SESSION_PROFILE: malformed JSON', code: 1 }; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'INVALID_SESSION_PROFILE: expected object', code: 1 };
  }
  if (Object.keys(value).some(key => !['model', 'effort'].includes(key))) {
    return { error: 'INVALID_SESSION_PROFILE: unknown key', code: 1 };
  }
  if (Object.values(value).some(item => typeof item !== 'string' || item.length === 0)) {
    return { error: 'INVALID_SESSION_PROFILE: values must be non-empty strings', code: 1 };
  }
  return { value, source: 'json' };
}

function exactFlagGrammar(argv, allowed) {
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.startsWith('--')) return false;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq < 0 ? body : body.slice(0, eq);
    if (!allowed.has(name) || seen.has(name)) return false;
    seen.add(name);
    if (eq < 0 && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) index += 1;
  }
  return true;
}

function knownFlagVocabulary(argv, allowed) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.startsWith('--')) return false;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq < 0 ? body : body.slice(0, eq);
    if (!allowed.has(name)) return false;
    if (eq < 0 && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) index += 1;
  }
  return true;
}

function flagOccurrences(argv, name) {
  const flag = `--${name}`;
  return argv.filter(token => token === flag || token.startsWith(`${flag}=`)).length;
}

function parseBoundaryEventFlag(value) {
  if (value === true) return { ok: false, usage: true };
  const match = /^([1-9]\d*):([0-9a-f]{64})$/.exec(String(value));
  if (!match) return { ok: false, usage: false };
  const seq = Number(match[1]);
  if (!Number.isSafeInteger(seq)) return { ok: false, usage: false };
  return { ok: true, value: { seq, checksum: match[2] } };
}

function renderNextAction(result) {
  const boundary = result?.action?.boundary_event;
  if (!boundary) return result;
  return {
    ...result,
    action: {
      ...result.action,
      boundary_event: `${boundary.seq}:${boundary.checksum}`,
    },
  };
}

// --now 관례(v1.5.0, spec §4): 미지정 → Date.now() 폴백. 지정 시 화이트리스트 — ① 순수 정수(epoch ms)
// ② ISO-8601: date-only(YYYY-MM-DD, UTC 자정 해석) 또는 tz 지정자 필수 datetime(YYYY-MM-DDTHH:mm[:ss[.sss]](Z|±HH:MM)).
// 그 외 전부 INVALID_NOW exit 1 (dispatcher 말미의 좁은 catch가 변환; 불변식 #2: 1 = invalid value).
// Date.parse는 쓰지 않는다 — V8이 '2026-02-31'을 3월로 롤오버하고 tz-less를 호스트 타임존으로 해석하므로
// (impl-r1·r2·r3 리뷰), 캡처 정규식 + 자체 Date.UTC 구성 + 컴포넌트 역검증(롤오버 감지)으로 결정론을 완결한다.
const ISO_NOW = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/;
function parseNow(f) {
  if (f.now === undefined) return Date.now();
  if (f.now === true) throw new Error('INVALID_NOW: --now requires a value (epoch ms or ISO-8601 date)');
  const s = String(f.now);
  const bad = () => new Error(`INVALID_NOW: --now must be epoch ms or an ISO-8601 date (got: ${s})`);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n > 8.64e15) throw bad();
    return n;
  }
  const m = ISO_NOW.exec(s);
  if (!m) throw bad();
  const [, y, mo, d, h = '00', mi = '00', sec = '00', frac = '', tz = 'Z'] = m;
  const ms = Number((frac + '000').slice(0, 3));
  if (tz !== 'Z') {
    const offH = Number(tz.slice(1, 3)), offM = Number(tz.slice(4, 6));
    if (offH > 23 || offM > 59) throw bad();   // +09:99 같은 범위 밖 오프셋 거부 (impl-r4)
  }
  const offMin = tz === 'Z' ? 0 : (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6)));
  const n = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, ms) - offMin * 60000;
  // 달력 역검증 — Date.UTC도 2026-02-31을 3월로 롤오버하므로, 입력 오프셋 뷰에서 컴포넌트를 재확인해 거부한다.
  const v = new Date(n + offMin * 60000);
  if (v.getUTCFullYear() !== +y || v.getUTCMonth() !== +mo - 1 || v.getUTCDate() !== +d
    || v.getUTCHours() !== +h || v.getUTCMinutes() !== +mi || v.getUTCSeconds() !== +sec) throw bad();
  if (!Number.isFinite(n) || Math.abs(n) > 8.64e15) throw bad();
  return n;
}

function parseExplicitNow(f) {
  return f.now === undefined ? undefined : parseNow(f);
}

function reqStr(f, name) { const v = f[name]; return (typeof v === 'string' && v.length) ? v : null; }   // 누락 시 null (핸들러가 exit 2 결정)
function optInt(f, name) {   // 미지정 → 0; 지정 시 비음정수 문자열만 허용, 아니면 null(핸들러가 exit 1)
  const v = f[name];
  if (v === undefined) return 0;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  return Number(v);
}

function positiveDeltaArg(f, name) {
  const v = f[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^[1-9]\d*$/.test(v)) return null;
  const parsed = Number(v);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function rootOf(f) { return f['project-root'] || findRoot(process.cwd()); }
function runIdOf(root, f) {
  if (f['run-id']) return f['run-id'];
  const p = join(root, '.deep-loop', 'current');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

const SAFE_EXACT_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function exactReadRunId(f) {
  const value = f['run-id'];
  if (value === undefined || value === true || value === '') {
    error('USAGE: exact reads require one valued safe --run-id');
    return null;
  }
  if (typeof value !== 'string' || value === '.' || value === '..'
    || !SAFE_EXACT_RUN_ID.test(value) || /[\x00-\x1F\x7F-\x9F/\\]/.test(value)) {
    error(`RUN_ID_INVALID: ${String(value)}`);
    return null;
  }
  return value;
}

function exactReadFailureCode(f) {
  const value = f['run-id'];
  return typeof value === 'string' && value.length > 0 ? 1 : 2;
}

function verifiedExactSnapshot(root, runId, options = {}) {
  try {
    const captured = captureVerifiedRunSnapshot(root, runId, options);
    if (captured?.ok === false) return { ok: false, diagnostic: captured };
    const snapshot = captured?.snapshot || captured;
    if (!snapshot?.data || snapshot.data.run_id !== runId) {
      return { ok: false, diagnostic: { ok: false, kind: 'integrity-invalid', phase: 'run-snapshot' } };
    }
    return { ok: true, snapshot };
  } catch (cause) {
    return { ok: false, error: String(cause?.message || cause) };
  }
}

function reportVerifiedExactFailure(result) {
  if (result.diagnostic) json(result.diagnostic);
  else error(result.error || 'integrity-invalid');
  return 1;
}

function projectRunResolution(result) {
  if (!result || typeof result !== 'object') return { ok: false, kind: 'invalid', reason: 'resolver-invalid' };
  const projected = { ok: result.ok === true, kind: result.kind };
  for (const key of ['reason', 'source', 'status', 'max_run_ids', 'deadline_ms', 'observed_count',
    'total_is_lower_bound', 'total']) if (result[key] !== undefined) projected[key] = result[key];
  if (result.runId !== undefined) projected.run_id = result.runId;
  if (result.matchedWorktree !== undefined) projected.matched_worktree = result.matchedWorktree;
  if (Array.isArray(result.candidates)) {
    projected.candidates = result.candidates.slice(0, 5).map(candidate => ({
      ...(typeof candidate?.run_id === 'string' ? { run_id: candidate.run_id } : {}),
      ...(typeof candidate?.status === 'string' ? { status: candidate.status } : {}),
    }));
  }
  if (result.errors && typeof result.errors === 'object' && !Array.isArray(result.errors)) {
    projected.errors = Object.fromEntries(Object.keys(result.errors).sort().slice(0, 5).map(runId => [runId, {
      ...(typeof result.errors[runId]?.kind === 'string' ? { kind: result.errors[runId].kind } : {}),
      ...(typeof result.errors[runId]?.operation_id === 'string' ? { operation_id: result.errors[runId].operation_id } : {}),
      ...(typeof result.errors[runId]?.phase === 'string' ? { phase: result.errors[runId].phase } : {}),
    }]));
  }
  if (result.expect && typeof result.expect === 'object') {
    projected.expect = {
      ...(typeof result.expect.owner === 'string' ? { owner: result.expect.owner } : {}),
      ...(Number.isSafeInteger(result.expect.generation) ? { generation: result.expect.generation } : {}),
    };
  }
  return projected;
}

// Raw-argv identity gate. This runs before any handler can parse flags, resolve the
// project root, read `.deep-loop/current`, or capture a snapshot. Keep the inventory
// explicit so adding a mutating dispatcher route requires updating this table.
export const MUTATING_ROUTE_INVENTORY = Object.freeze([
  'root recovery acquire', 'root rebind', 'root recover',
  'runtime-executable approve', 'launcher-executable approve',
  'checkpoint emit', 'checkpoint observe', 'checkpoint restore', 'lease acquire', 'lease release',
  'workstream new', 'workstream set', 'workstream terminal',
  'episode new', 'episode record', 'episode abandon',
  'review configure', 'review dispatch', 'review record', 'review import',
  'handoff emit', 'respawn', 'state patch', 'pause', 'recover', 'recovery acquire',
  'budget record', 'budget extend', 'comprehension ack', 'breaker reset',
  'insights emit', 'spawn-style offer-desktop', 'spawn-style confirm-desktop',
  'spawn-style decline-desktop', 'spawn-style reset-desktop',
  'attended-launch approve', 'attended-launch revoke', 'session-profile set',
  'detect-terminal', 'finish',
]);
const MUTATING_ROUTE_SET = new Set(MUTATING_ROUTE_INVENTORY);

function rawRouteKey(command, argv) {
  const first = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  if (command === 'root') return first === 'recovery'
    ? `root recovery ${argv[1] && !argv[1].startsWith('--') ? argv[1] : ''}`
    : `root ${first || ''}`;
  return first ? `${command} ${first}` : command;
}

function requireExactRunId(rawArgv) {
  let count = 0;
  let value;
  let malformed = false;
  for (let index = 0; index < rawArgv.length; index += 1) {
    const token = rawArgv[index];
    if (token === '--run-id') {
      count += 1;
      const next = rawArgv[index + 1];
      if (next === undefined || next.startsWith('--') || next.length === 0) malformed = true;
      else { value = next; index += 1; }
    } else if (typeof token === 'string' && token.startsWith('--run-id=')) {
      count += 1;
      const inline = token.slice('--run-id='.length);
      if (inline.length === 0) malformed = true;
      else value = inline;
    }
  }
  if (malformed || count !== 1) return { ok: false };
  return { ok: true, value };
}

// 변경 명령 펜싱 (spec §9.1) — owner/generation 불일치 시 LEASE_FENCED.
function intArg(f, name) {
  const v = f[name];
  if (typeof v !== 'string' || !/^\d+$/.test(v)) { error('INVALID_' + name.toUpperCase().replace('-', '_') + ': must be a positive integer'); process.exit(3); }
  return Number(v);
}
function strArg(f, name) {
  const v = f[name];
  if (typeof v !== 'string' || v.length === 0) { error('INVALID_' + name.toUpperCase().replace(/-/g, '_') + ': must be a non-empty string'); process.exit(3); }
  return v;
}
function requireLease(root, runId, f, intent = 'business') {
  strArg(f, 'owner');
  const generation = intArg(f, 'generation');
  const { data } = captureReconciledRunSnapshot(root, runId);
  const r = leaseCheck(data, { owner: f.owner, generation, intent });
  if (!r.ok) { error(`LEASE_FENCED: ${r.reason}`); process.exit(3); }
  return data;
}

const rawArgv = process.argv.slice(2);
if (rawArgv.length === 0 || rawArgv[0] === 'help' || rawArgv[0] === '--help' || rawArgv[0] === '-h') {
  const help = renderHelp(rawArgv);
  if (help.stdout) process.stdout.write(help.stdout);
  if (help.stderr) error(help.stderr);
  process.exit(help.code);
}
const [sub, ...rest] = rawArgv;

// validate: 비공허 검증 (Codex impl 🟡4)
// 1) 스키마+빌더 self-test: buildInitialLoop 산출물이 항상 검증 통과해야 함 (regression 게이트)
// 2) 현재/지정 run이 있으면 reconciled snapshot + schema.validate
const handlers = {
  path: async (a) => {
    const [verb, ...args] = a;
    const allowed = new Set(['target', 'workstream', 'project-root', 'run-id', 'now']);
    if (verb !== 'resolve' || !knownFlagVocabulary(args, allowed) || !exactFlagGrammar(args, allowed)) {
      error('USAGE: path resolve has invalid grammar');
      return 2;
    }
    const f = parseFlags(args);
    const target = reqStr(f, 'target');
    const projectRoot = reqStr(f, 'project-root');
    if (!target || !projectRoot) {
      error('USAGE: path resolve requires valued --target, --project-root, and --run-id');
      return 2;
    }
    const runId = exactReadRunId(f);
    if (!runId) return exactReadFailureCode(f);
    if (target !== 'run-dir' && target !== 'workstream') {
      throw new Error(`PATH_TARGET_INVALID: ${target}`);
    }
    const workstreamId = reqStr(f, 'workstream');
    if ((target === 'workstream' && !workstreamId)
      || (target === 'run-dir' && f.workstream !== undefined)) {
      error('USAGE: --workstream is required only for target workstream');
      return 2;
    }
    process.stdout.write(`${resolveRunPath(projectRoot, runId, {
      target, workstreamId: target === 'workstream' ? workstreamId : undefined,
    })}\n`);
    return 0;
  },
  validate: async (a) => {
    const f = parseFlags(a);
    const errors = [];
    const sample = buildInitialLoop({ runtime: 'claude', goal: 'self-test', protocol: 'standalone', recipe: { id: 'r', name: 'r', reason: '' }, runId: 'SELFTEST00000000000000000T', now: new Date() });
    const sv = validateLoop(sample);
    if (!sv.ok) errors.push(`builder self-test: ${sv.errors.join('; ')}`);
    const root = rootOf(f);
    const runId = Object.hasOwn(f, 'run-id') ? exactReadRunId(f) : null;
    if (Object.hasOwn(f, 'run-id') && !runId) return exactReadFailureCode(f);
    if (runId) {
      try {
        const captured = captureVerifiedRunSnapshot(root, runId);
        if (captured?.ok === false) {
          if (!existsSync(join(runDir(root, runId), 'loop.json'))) throw new Error(`STATE_MISSING: ${runId} loop.json absent`);
          throw new Error(captured.kind || 'INTEGRITY_INVALID');
        }
        const { data } = captured.snapshot || captured;
        const rv = validateLoop(data);
        if (!rv.ok) errors.push(`run ${runId}: ${rv.errors.join('; ')}`);
      } catch (e) { errors.push(`run ${runId}: ${e.message}`); }
    }
    // recipe/ledger 정적 검사는 런타임 라우팅이 실제로 읽는 **플러그인 번들** recipesDir 기준이다
    // (project-root 기준이 아님) — --project-root가 타 프로젝트를 가리켜도 그 프로젝트의 recipes/는
    // 검사 대상이 아니고, 번들 recipe는 root와 무관하게 항상 검증된다.
    const ledgerPath = join(recipesDir, 'hillclimb-ledger.json');
    if (existsSync(ledgerPath)) {
      try { const lv = validateLedger(JSON.parse(readFileSync(ledgerPath, 'utf8'))); if (!lv.ok) errors.push(`ledger: ${lv.errors.join('; ')}`); }
      catch (e) { errors.push(`ledger: ${e.message}`); }
    }
    // recipes fail-closed 검증 (impl-R3 🟡C): 런타임 loadRecipes는 손상 파일을 fail-soft로 skip하므로
    // (라우팅 생존), 손상 자체는 여기 validate(preflight/머지 게이트)가 파일명과 함께 잡는다.
    const rv = validateRecipesDir(recipesDir);
    if (!rv.ok) errors.push(...rv.errors);
    if (errors.length) { error(`validate failed:\n - ${errors.join('\n - ')}`); return 1; }
    process.stdout.write(`ok${runId ? ` (run ${runId})` : ' (schema+builder self-test)'}\n`);
    return 0;
  },
  'detect-plugins': async (a) => { const f = parseFlags(a); json(detectPlugins(rootOf(f))); return 0; },
  'recipe-match': async (a) => {
    const f = parseFlags(a); const root = rootOf(f);
    try { json(matchRecipe(f.goal || '', detectPlugins(root))); return 0; }
    catch (e) { error(String(e?.message || e)); return 1; }   // NO_VALID_RECIPES (degraded bundle) → exit 1, no raw stack
  },
  run: async (a) => {
    const [verb, ...rest] = a;
    const f = parseFlags(rest);
    const root = rootOf(f);
    if (verb === 'list') {
      const captured = captureVerifiedRunSet(root, { maxRunIds: 64, deadlineMs: 500 });
      if (captured.ok === false) { json(captured); return 1; }
      const current = (() => {
        try { return readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim(); }
        catch { return null; }
      })();
      const runs = captured.runIds.map(runId => {
        const snapshot = captured.runs[runId]?.snapshot || captured.runs[runId];
        const data = snapshot?.data || {};
        return {
          run_id: runId,
          status: data.status ?? null,
          created_at: data.created_at ?? null,
          updated_at: data.event_log_head?.ts ?? null,
          continuation_policy: data.autonomy?.continuation_policy ?? null,
          worktrees: (data.workstreams || []).map(workstream => workstream.worktree)
            .filter(value => typeof value === 'string' && value.length > 0)
            .sort().slice(0, 8).map(value => value.length > 256 ? `${value.slice(0, 253)}...` : value),
          is_current: runId === current,
        };
      });
      json({ ok: true, runs, errors: captured.errors || {} });
      return 0;
    }
    if (verb === 'resolve') {
      const purpose = reqStr(f, 'purpose') || 'cli-read';
      const result = resolveRunContext({
        root,
        purpose,
        explicitRunId: f['run-id'] === true ? null : (f['run-id'] ?? null),
        cwd: f.cwd === undefined || f.cwd === true ? null : String(f.cwd),
      });
      json(projectRunResolution(result));
      return result.ok ? 0 : 1;
    }
    error(`unknown run verb: ${verb ?? '<none>'}`);
    return 2;
  },
  root: async (a) => {
    const [verb, ...rest] = a;
    if (verb === 'recovery') {
      const [subverb, ...acquireArgs] = rest;
      const f = parseFlags(acquireArgs);
      if (subverb !== 'acquire') { error('USAGE: root recovery acquire'); return 2; }
      const candidateRoot = reqStr(f, 'candidate-project-root');
      const runId = reqStr(f, 'run-id');
      const capsuleRel = reqStr(f, 'capsule');
      const owner = reqStr(f, 'owner');
      const runtime = reqStr(f, 'runtime');
      const generation = reqStr(f, 'generation');
      const bindingGeneration = reqStr(f, 'binding-generation');
      if (!candidateRoot || !runId || !capsuleRel || !owner || !runtime
        || !/^[1-9]\d*$/.test(generation || '')
        || !/^[1-9]\d*$/.test(bindingGeneration || '')) {
        error('USAGE: root recovery acquire requires capsule, owner, generations, runtime, root, and run id');
        return 2;
      }
      try {
        json(acquireRootRecovery(candidateRoot, runId, {
          capsuleRel,
          owner,
          expectGeneration: Number(generation),
          bindingGeneration: Number(bindingGeneration),
          runtime,
          now: parseExplicitNow(f),
        }));
        return 0;
      } catch (e) {
        const failure = kernelFailure(e);
        error(failure.message);
        return failure.code;
      }
    }
    const f = parseFlags(rest);
    if (!['diagnose', 'rebind', 'recover'].includes(verb)) { error(`unknown root verb: ${verb}`); return 2; }
    const candidateRoot = reqStr(f, 'candidate-project-root');
    if (!candidateRoot) { error('USAGE: --candidate-project-root ROOT is required'); return 2; }
    const runId = verb === 'diagnose' ? exactReadRunId(f) : reqStr(f, 'run-id');
    if (!runId) return exactReadFailureCode(f);

    if (verb === 'diagnose') {
      try {
        const diagnosed = diagnoseVerifiedProjectRoot(candidateRoot, runId);
        if (diagnosed?.ok === false) { json(diagnosed); return 1; }
        json(diagnosed); return 0;
      }
      catch (cause) {
        const failure = kernelFailure(cause);
        error(failure.message);
        return failure.code;
      }
      return 0;
    }

    const owner = reqStr(f, 'owner');
    if (!owner) { error('USAGE: --owner OWNER is required'); return 2; }
    if (f.generation === undefined || f.generation === true) {
      error('USAGE: --generation N is required'); return 2;
    }
    if (typeof f.generation !== 'string' || !/^\d+$/.test(f.generation)
      || !Number.isSafeInteger(Number(f.generation))) {
      throw new Error('INVALID_GENERATION: must be a non-negative safe integer');
    }
    const actor = reqStr(f, 'actor');
    if (!actor) { error('USAGE: --actor human is required'); return 2; }
    if (f.confirm !== true && f.confirm !== 'true') {
      error('CONFIRM_REQUIRED: root rebind requires --confirm'); return 2;
    }
    const expectedStoredRootDigest = reqStr(f, 'expected-stored-root-digest');
    if (!expectedStoredRootDigest) {
      error('USAGE: --expected-stored-root-digest SHA256 is required'); return 2;
    }
    const expectedBindingGeneration = reqStr(f, 'expected-binding-generation');
    if (!/^[1-9]\d*$/.test(expectedBindingGeneration || '')) {
      error('USAGE: --expected-binding-generation N is required'); return 2;
    }

    const mutateRoot = verb === 'recover' ? recoverRelocatedRoot : rebindProjectRoot;
    const result = mutateRoot(candidateRoot, runId, {
      actor,
      confirm: true,
      expectedStoredRootDigest,
      expectedBindingGeneration: Number(expectedBindingGeneration),
      fence: { owner, generation: Number(f.generation) },
      now: parseNow(f),
    });
    json(result);
    return 0;
  },
  'runtime-executable': async (a) => {
    const [verb, ...rest] = a;
    const f = parseFlags(rest);
    if (verb !== 'diagnose' && verb !== 'approve') {
      error(`unknown runtime-executable verb: ${verb ?? '<none>'}`);
      return 2;
    }
    const runtime = reqStr(f, 'runtime');
    if (!runtime) { error('USAGE: --runtime <claude|codex|grok> is required'); return 2; }
    const candidatePath = reqStr(f, 'path');
    if (!candidatePath) { error('USAGE: --path ABSOLUTE_EXECUTABLE_OR_WRAPPER is required'); return 2; }

    if (verb === 'diagnose') {
      json(diagnoseRuntimeExecutable(runtime, { explicitPath: candidatePath }));
      return 0;
    }

    const expectedCanonicalPath = reqStr(f, 'canonical-path');
    if (!expectedCanonicalPath) { error('USAGE: --canonical-path ABSOLUTE_NATIVE_EXECUTABLE is required'); return 2; }
    const expectedSha256 = reqStr(f, 'sha256');
    if (!expectedSha256) { error('USAGE: --sha256 LOWERCASE_SHA256 is required'); return 2; }
    const actor = reqStr(f, 'actor');
    if (!actor) { error('USAGE: --actor human is required'); return 2; }
    if (f.confirm !== true && f.confirm !== 'true') {
      error('CONFIRM_REQUIRED: runtime executable approval requires --confirm');
      return 2;
    }
    const owner = reqStr(f, 'owner');
    if (!owner) { error('USAGE: --owner OWNER is required'); return 2; }
    if (f.generation === undefined || f.generation === true) {
      error('USAGE: --generation N is required');
      return 2;
    }
    if (typeof f.generation !== 'string' || !/^(?:0|[1-9]\d*)$/.test(f.generation)
      || !Number.isSafeInteger(Number(f.generation))) {
      throw new Error('INVALID_GENERATION: must be a non-negative safe integer');
    }
    const root = rootOf(f);
    const runId = runIdOf(root, f);
    if (!runId) { error('USAGE: --run-id RUN_ID or .deep-loop/current is required'); return 2; }
    const result = approveRuntimeExecutable(root, runId, {
      runtime,
      candidatePath,
      expectedCanonicalPath,
      expectedSha256,
      actor,
      confirm: true,
      fence: { owner, generation: Number(f.generation) },
      now: parseNow(f),
    });
    json(result);
    return 0;
  },
  'launcher-executable': async (a) => {
    const [verb, ...rest] = a;
    const f = parseFlags(rest);
    if (verb !== 'diagnose' && verb !== 'approve') {
      error(`unknown launcher-executable verb: ${verb ?? '<none>'}`);
      return 2;
    }
    if (flagOccurrences(rest, 'path') > 1) {
      throw new Error('LAUNCHER_EXECUTABLE_AMBIGUOUS: exactly one explicit candidate path is required');
    }
    const kind = reqStr(f, 'kind');
    if (!kind) { error(`USAGE: --kind <${LAUNCHER_KINDS.join('|')}> is required`); return 2; }
    const candidatePath = reqStr(f, 'path');
    if (!candidatePath) { error('USAGE: --path ABSOLUTE_NATIVE_LAUNCHER is required'); return 2; }

    if (verb === 'diagnose') {
      json(diagnoseLauncherExecutable(kind, { explicitPath: candidatePath }));
      return 0;
    }

    const expectedCanonicalPath = reqStr(f, 'canonical-path');
    if (!expectedCanonicalPath) { error('USAGE: --canonical-path ABSOLUTE_NATIVE_LAUNCHER is required'); return 2; }
    const expectedSha256 = reqStr(f, 'sha256');
    if (!expectedSha256) { error('USAGE: --sha256 LOWERCASE_SHA256 is required'); return 2; }
    const actor = reqStr(f, 'actor');
    if (!actor) { error('USAGE: --actor human is required'); return 2; }
    if (f.confirm !== true && f.confirm !== 'true') {
      error('CONFIRM_REQUIRED: launcher executable approval requires --confirm');
      return 2;
    }
    const owner = reqStr(f, 'owner');
    if (!owner) { error('USAGE: --owner OWNER is required'); return 2; }
    if (f.generation === undefined || f.generation === true) {
      error('USAGE: --generation N is required');
      return 2;
    }
    if (typeof f.generation !== 'string' || !/^(?:0|[1-9]\d*)$/.test(f.generation)
      || !Number.isSafeInteger(Number(f.generation))) {
      throw new Error('INVALID_GENERATION: must be a non-negative safe integer');
    }
    const root = rootOf(f);
    const runId = runIdOf(root, f);
    if (!runId) { error('USAGE: --run-id RUN_ID or .deep-loop/current is required'); return 2; }
    const result = approveLauncherExecutable(root, runId, {
      kind,
      candidatePath,
      expectedCanonicalPath,
      expectedSha256,
      actor,
      confirm: true,
      fence: { owner, generation: Number(f.generation) },
      now: parseNow(f),
    });
    json(result);
    return 0;
  },
  'init-run': async (a) => {
    const f = parseFlags(a);
    const root = rootOf(f);
    const runtime = reqStr(f, 'runtime');
    if (!runtime) { error('USAGE: --runtime <claude|codex|grok> is required'); return 2; }
    if (f['session-profile'] === undefined && (f.model === true || f.effort === true)) {
      error('USAGE: --model/--effort require a value'); return 2;
    }
    const profile = parseSessionProfileFlags(f);
    if (profile.error) { error(profile.error); return profile.code; }
    if (f.continuation === true) { error('USAGE: --continuation <workstream-session>'); return 2; }
    const model = profile.value.model ?? null;
    const effort = profile.value.effort ?? null;
    try {
      const { runId } = initRun(root, { runtime, goal: f.goal, protocol: f.protocol, recipe: f.recipe, detected: detectPlugins(root), review: f.review ? JSON.parse(f.review) : undefined, model, effort, continuation: f.continuation ?? null, now: new Date(parseNow(f)) });
      json({ run_id: runId }); return 0;
    } catch (e) {
      error(String(e?.message || e)); return 1;   // INVALID_RUNTIME / INVALID_MODEL / INVALID_EFFORT → exit 1 (fail-closed)
    }
  },
  'next-action': async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = exactReadRunId(f);
    if (!runId) return exactReadFailureCode(f);
    const captured = verifiedExactSnapshot(root, runId);
    if (!captured.ok) return reportVerifiedExactFailure(captured);
    const { data } = captured.snapshot;
    const unattended = !!f.unattended || resolveSpawnMode(data, { env: process.env }) === 'headless';
    json(renderNextAction(nextAction(data, { now: parseNow(f), unattended }))); return 0;
  },
  checkpoint: async (a) => {
    const [verb, ...rest] = a;
    const allowed = {
      emit: new Set(['project-root', 'run-id', 'now', 'owner', 'generation', 'runtime']),
      inspect: new Set(['project-root', 'run-id', 'now', 'json']),
      observe: new Set([
        'project-root', 'run-id', 'now', 'checkpoint', 'trigger', 'owner', 'generation',
        'runtime', 'trusted-postcompact-stdin', 'json',
      ]),
      restore: new Set([
        'project-root', 'run-id', 'now', 'checkpoint', 'owner', 'generation', 'runtime',
        'admission', 'source', 'confirm-manual-compact', 'json',
      ]),
    };
    if (!Object.hasOwn(allowed, verb)) {
      error(`USAGE: checkpoint <emit|inspect|observe|restore> has invalid grammar`);
      return 2;
    }
    let parsedFence = null;
    if (verb !== 'inspect') {
      const preliminary = parseFlags(rest);
      const owner = preliminary.owner;
      const generation = preliminary.generation;
      if (flagOccurrences(rest, 'owner') !== 1
        || flagOccurrences(rest, 'generation') !== 1
        || typeof owner !== 'string'
        || owner.length === 0
        || owner === '.'
        || owner === '..'
        || /[\0\r\n/\\]/.test(owner)
        || typeof generation !== 'string'
        || !/^[1-9]\d*$/.test(generation)
        || !Number.isSafeInteger(Number(generation))) {
        error(`LEASE_FENCED: checkpoint ${verb} requires a valid owner and positive generation`);
        return 3;
      }
      parsedFence = { owner, generation: Number(generation) };
    }
    if (!knownFlagVocabulary(rest, allowed[verb])) {
      error(`USAGE: checkpoint <emit|inspect|observe|restore> has invalid grammar`);
      return 2;
    }
    if (!exactFlagGrammar(rest, allowed[verb])) {
      error(`USAGE: checkpoint <emit|inspect|observe|restore> has invalid grammar`);
      return 2;
    }
    const f = parseFlags(rest);
    if ((Object.hasOwn(f, 'project-root') && reqStr(f, 'project-root') === null)
      || (Object.hasOwn(f, 'run-id') && reqStr(f, 'run-id') === null)) {
      error('USAGE: explicit --project-root and --run-id require a non-empty value');
      return 2;
    }
    const root = rootOf(f);
    const runId = verb === 'inspect' ? exactReadRunId(f) : runIdOf(root, f);
    if (verb === 'inspect' && !runId) return exactReadFailureCode(f);
    if (!runId) { error('USAGE: --run-id RUN_ID or .deep-loop/current is required'); return 2; }

    if (verb === 'inspect') {
      if (f.json !== true) { error('USAGE: checkpoint inspect requires --json'); return 2; }
      json(inspectCompactCheckpoint(root, runId, { now: parseNow(f) }));
      return 0;
    }

    const runtime = reqStr(f, 'runtime');
    if (!runtime) {
      error(`USAGE: checkpoint ${verb} requires --runtime RUNTIME`);
      return 2;
    }
    validateSessionRuntime(runtime);
    const options = {
      fence: parsedFence,
      runtime,
      now: parseNow(f),
    };
    if (verb === 'emit') {
      json(emitCompactCheckpoint(root, runId, options));
      return 0;
    }

    if (verb === 'observe') {
      const requested = reqStr(f, 'checkpoint');
      const trigger = reqStr(f, 'trigger');
      if (!requested || !trigger || f.json !== true) {
        error('USAGE: checkpoint observe requires --checkpoint REL, --trigger TRIGGER, and --json');
        return 2;
      }
      if (!['manual', 'auto'].includes(trigger)
        || !/^checkpoints\/[0-9a-f]{64}-compact\.json$/.test(requested)) {
        error('CHECKPOINT_OBSERVE_VALUE_INVALID');
        return 1;
      }
      if (Object.hasOwn(f, 'trusted-postcompact-stdin')
        && f['trusted-postcompact-stdin'] !== true) {
        error('USAGE: --trusted-postcompact-stdin is a value-less flag');
        return 2;
      }
      if (f['trusted-postcompact-stdin'] !== true) {
        error('OBSERVE_TRUSTED_INGRESS_REQUIRED');
        return 1;
      }
      let body;
      try {
        const raw = await readBoundedText(process.stdin, { maxBytes: 4096 });
        body = JSON.parse(raw);
      } catch {
        error('OBSERVE_TRUSTED_CONTEXT_INVALID');
        return 1;
      }
      const keys = body && typeof body === 'object' && !Array.isArray(body)
        ? Object.keys(body)
        : [];
      if (!body
        || !['hook_event_name', 'cwd', 'trigger'].every(key => keys.includes(key))
        || keys.some(key => !['hook_event_name', 'cwd', 'trigger', 'session_id'].includes(key))
        || body.hook_event_name !== 'PostCompact'
        || body.trigger !== trigger
        || typeof body.cwd !== 'string'
        || body.cwd.length === 0) {
        error('OBSERVE_TRUSTED_CONTEXT_INVALID');
        return 1;
      }
      let canonicalBodyCwd;
      let exactBodyCwd;
      let mappedBodyRoot;
      let canonicalArgRoot;
      try {
        exactBodyCwd = realpathSync(body.cwd);
        canonicalBodyCwd = canonicalProjectRoot(body.cwd);
        mappedBodyRoot = canonicalProjectRoot(findRoot(canonicalBodyCwd));
        canonicalArgRoot = canonicalProjectRoot(root);
      } catch {
        error('OBSERVE_TRUSTED_CONTEXT_INVALID');
        return 1;
      }
      if (resolve(body.cwd) !== body.cwd
        || exactBodyCwd !== body.cwd
        || mappedBodyRoot !== canonicalArgRoot) {
        error('OBSERVE_TRUSTED_CONTEXT_INVALID');
        return 1;
      }
      let hostSessionEvidence;
      if (Object.hasOwn(body, 'session_id')) {
        if (typeof body.session_id !== 'string'
          || body.session_id.length === 0
          || body.session_id.length > 1024
          || /[\0\r\n]/.test(body.session_id)) {
          error('OBSERVE_TRUSTED_CONTEXT_INVALID');
          return 1;
        }
        hostSessionEvidence = {
          provider: runtimeCapability(runtime, 'provider_label'),
          id: body.session_id,
        };
      }
      json(observeCompactCheckpoint(root, runId, {
        checkpointRel: requested,
        trigger,
        hostSessionEvidence,
        ...options,
      }));
      return 0;
    }

    const requested = reqStr(f, 'checkpoint');
    const admission = reqStr(f, 'admission');
    const source = reqStr(f, 'source');
    if (!requested || !admission || !source || f.json !== true) {
      error('USAGE: checkpoint restore requires --checkpoint REL, --admission KIND, --source SOURCE, and --json');
      return 2;
    }
    if (Object.hasOwn(f, 'confirm-manual-compact') && f['confirm-manual-compact'] !== true) {
      error('USAGE: --confirm-manual-compact is a value-less flag');
      return 2;
    }
    if (admission === 'human-attested' && f['confirm-manual-compact'] !== true) {
      error('USAGE: human-attested restore requires --confirm-manual-compact');
      return 2;
    }
    if (!/^checkpoints\/[0-9a-f]{64}-compact\.json$/.test(requested)
      || !['postcompact-observation', 'human-attested'].includes(admission)
      || !['sessionstart', 'external-controller', 'direct-human-skill'].includes(source)
      || (admission === 'human-attested' && source !== 'direct-human-skill')
      || (admission === 'postcompact-observation'
        && !['sessionstart', 'external-controller'].includes(source))
      || (admission === 'postcompact-observation' && f['confirm-manual-compact'] === true)) {
      error('CHECKPOINT_RESTORE_VALUE_INVALID');
      return 1;
    }
    json(restoreCompactCheckpoint(root, runId, {
      checkpointRel: requested,
      admission,
      source,
      confirmManualCompact: f['confirm-manual-compact'] === true,
      ...options,
    }));
    return 0;
  },
  'resume-command': async (a) => {
    const f = parseFlags(a);
    // parseFlags represents a value-less option as boolean true. Reject it before rootOf/runIdOf so
    // true can never become a filesystem root or logical run id.
    if (f['project-root'] === true || f['run-id'] === true) {
      error('USAGE: --project-root and --run-id require a value');
      return 2;
    }
    const root = rootOf(f);
    const runId = exactReadRunId(f);
    if (!runId) return exactReadFailureCode(f);
    const captured = captureVerifiedRunSnapshot(root, runId, {
      artifactRels: ['terminal/launch-command.txt', 'terminal/launch-command.meta.json'],
    });
    if (captured?.ok === false) {
      error(`${captured.kind || 'integrity-invalid'}:${captured.operation_id || 'none'}:${captured.phase || 'verified-vector'}`);
      return 1;
    }
    const snapshot = captured.snapshot;
    const { data } = snapshot;
    const lease = data.session_chain?.lease || {};
    const childRunId = typeof lease.handoff_child_run_id === 'string'
      ? lease.handoff_child_run_id
      : null;
    // spec §3.3 acquired 브랜치 — 전부 durable 영수증 기준이며 read-only 다(이벤트 로그를 읽지 않는다).
    // 판별: 현재 세대의 영수증이고(`to_generation === lease.generation`) 실제로 예약을 소비했을 때만
    // (`takeover_kind !== 'released-takeover'`) 진입한다 → 일반 재획득·stale 영수증은 절대 consumed 를
    // 내지 않는다(B-2(ii) 해소, T1 부정 케이스).
    // `lease.state === 'active'` 는 §3.3 조건에 없지만 필수다 (checker W1): releaseLease 는 spread 로
    // `state: 'released'` 만 바꾸고 `handoff_phase`/`generation` 을 그대로 두므로, 그것 없이는 release 된
    // lease 에서도 이 분기가 발화해 `Status: consumed — 새 진입 시도는 proceed:false` 를 출력한다. 그런데
    // released lease 는 takeable 이라 다음 acquire 가 `proceed:true` 를 낸다 — 마커가 커널과 정면으로
    // 어긋나고, §3.4 가 `Status: consumed` 에서 승격을 금지하므로 **정당한 인수가 교착된다.**
    const receipt = lease.acquisition_receipt;
    if (lease.handoff_phase === 'acquired'
      && lease.state === 'active'
      && receipt && typeof receipt === 'object'
      && receipt.to_generation === lease.generation
      && receipt.takeover_kind !== 'released-takeover') {
      const consumedChild = (data.session_chain?.sessions || [])
        .find(session => session.run_id === receipt.child_run_id);
      const boundary = receipt.boundary_event
        ? `${receipt.boundary_event.seq}:${receipt.boundary_event.checksum}`
        : 'none';
      const head = ['boundary-recovery', 'affinity-supersession', 'project-root'].includes(receipt.takeover_kind)
        ? `Recovery: consumed kind=${receipt.takeover_kind} capsule=${consumedChild?.recovery_rel || 'none'}`
        : `Handoff: consumed child_run_id=${receipt.child_run_id} boundary_event=${boundary} binding_generation=${receipt.project_binding_generation ?? 'none'} root_digest=${receipt.project_root_digest ?? 'none'}`;
      process.stdout.write([
        head,
        `Consumed: takeover_kind=${receipt.takeover_kind} superseded_owner=${receipt.superseded_owner_run_id} transition=${receipt.from_generation}->${receipt.to_generation} at=${receipt.at}`,
        `Lease: owner=${lease.owner_run_id} lease_state=${lease.state} generation=${lease.generation} handoff_phase=${lease.handoff_phase} child_run_id=${childRunId || 'none'}`,
        // 이 줄은 `Handoff:`/`Recovery:` 헤드와 **공유**되므로(§3.3) 어느 방향으로도 무조건 단정할 수
        // 없다. 무조건 `proceed:false` 는 같은-attempt replay 에 대해 거짓이고(라운드 5 F5-2), 무조건
        // "같은 attempt_id는 replay" 는 영수증에 attempt_id 가 없는 소비 — `recovery acquire` /
        // `root recovery acquire` 로 한 소비와 nonce 없이 한 `lease acquire` 소비 — 에 대해 거짓이다
        // (라운드 7 C2). 그래서 **replay 가 실제로 도달 가능할 때만** 붙인다: 영수증이 attempt_id 를
        // 담고 있고(조건 5) run 이 `running` 일 때다 — 사람이 개시한 preserve-pause 와 terminal 은
        // 조건 2·terminal 가드로 replay 를 막지만 이 분기 자체는 계속 발화한다(라운드 8 W2).
        `Status: consumed — 새 진입 시도는 proceed:false (already-owned)${
          typeof receipt.attempt_id === 'string' && receipt.attempt_id.length > 0
            && data.status === 'running'
            ? '; 같은 attempt_id 재호출은 replay'
            : ''}`,
        '',
      ].join('\n'));
      return 0;
    }
    if (!childRunId || !['reserved', 'emitted', 'spawned'].includes(lease.handoff_phase)) {
      process.stdout.write('no pending handoff\n');
      return 0;
    }

    const child = (data.session_chain?.sessions || []).find(session => session.run_id === childRunId);
    if (['affinity-supersession', 'boundary-recovery'].includes(lease.takeover_kind)) {
      if (child?.root_recovery_operation_id) {
        if (lease.recovery_discriminator !== child.root_recovery_operation_id
          || lease.recovery_rel !== child.recovery_rel
          || lease.recovery_sha256 !== child.recovery_sha256
          || child.recovery_project_binding_generation !== data.project?.binding_generation
          || child.recovery_project_root_digest !== projectRootDigest(data.project?.root)) {
          error('ROOT_RECOVERY_TOPOLOGY_INVALID');
          return 1;
        }
        const descriptor = buildRootRecoveryResumeDescriptor({
          runtime: sessionRuntime(data),
          root: canonicalProjectRoot(data.project.root),
          runId,
          childRunId,
          recoveryRel: child.recovery_rel,
          generation: lease.generation,
          bindingGeneration: data.project.binding_generation,
        });
        process.stdout.write([
          descriptor.resumeInvocation,
          `Recovery: kind=project-root capsule=${child.recovery_rel}`,
          `Lease: owner=${lease.owner_run_id} lease_state=${lease.state} generation=${lease.generation} handoff_phase=${lease.handoff_phase} child_run_id=${childRunId}`,
          'Status: exact root recovery child acquisition is required',
          '',
        ].join('\n'));
        return 0;
      }
      if (recoveryReservationKind(data) !== lease.takeover_kind
        || !child
        || child.recovery_kind !== lease.takeover_kind
        || child.recovery_project_binding_generation !== data.project?.binding_generation
        || child.recovery_project_root_digest !== projectRootDigest(data.project?.root)
        || lease.recovery_rel !== child.recovery_rel
        || lease.recovery_sha256 !== child.recovery_sha256) {
        error('RECOVERY_TOPOLOGY_INVALID');
        return 1;
      }
      const descriptor = buildRecoveryResumeDescriptor({
        kind: child.recovery_kind,
        runtime: sessionRuntime(data),
        root: canonicalProjectRoot(data.project.root),
        runId,
        childRunId,
        recoveryRel: child.recovery_rel,
        generation: lease.generation,
      });
      process.stdout.write([
        descriptor.resumeInvocation,
        `Recovery: kind=${child.recovery_kind} capsule=${child.recovery_rel}`,
        `Lease: owner=${lease.owner_run_id} lease_state=${lease.state} generation=${lease.generation} handoff_phase=${lease.handoff_phase} child_run_id=${childRunId}`,
        'Status: exact recovery child acquisition is required',
        '',
      ].join('\n'));
      return 0;
    }
    const handoffRel = child?.handoff_rel || `handoffs/${childRunId}-next-session.md`;
    const canonicalRoot = canonicalProjectRoot(data.project.root);
    const runtime = sessionRuntime(data);
    const descriptor = buildRuntimeResumeDescriptor({
      runtime,
      root: canonicalRoot,
      parentRunId: runId,
      childRunId,
      handoffRel,
      launcher: data.session_spawn?.launcher,
      launcherBin: data.session_spawn?.launcher_bin,
      launcherSocket: data.session_spawn?.launcher_socket,
      platform: process.platform,
      model: data.autonomy?.session_model ?? null,
      effort: data.autonomy?.session_effort ?? null,
      deepLoopRoot: DEEP_LOOP_ROOT,
      runtimeExecutableIdentity: data.autonomy?.runtime_executable_approval ?? null,
      launcherIdentity: data.session_spawn?.launcher_identity ?? null,
    });
    const launchText = snapshot.artifacts['terminal/launch-command.txt'];
    const launchMeta = snapshot.artifacts['terminal/launch-command.meta.json'];
    let boundLaunchText = null;
    if (launchText?.state === 'present' && launchMeta?.state === 'present'
      && Number.isSafeInteger(data.project?.binding_generation)) {
      try {
        const parsed = JSON.parse(launchMeta.bytes.toString('utf8'));
        const parent = child && (data.session_chain?.sessions || [])
          .find(session => session.run_id === child.parent_run_id);
        const validated = validateLaunchCommandMetadata(parsed, {
          launchBytes: launchText.bytes,
          // §6.3 R-r1: lineage 는 논리 runId 가 아니라 **현재 owner** 기준이다. emit 은 owner 를 바꾸지
          // 않으므로 emitted/spawned 동안 `lease.owner_run_id` 가 곧 superseded 대상 부모다. 1세대에서는
          // 두 값이 같아 동작이 바이트 동일하다.
          parentRunId: lease.owner_run_id,
          childRunId,
          handoffRel: child?.handoff_rel,
          projectRootDigest: projectRootDigest(data.project.root),
          projectBindingGeneration: data.project.binding_generation,
          boundaryEvent: lease.handoff_boundary_event,
          generatedAt: parent?.scope?.superseded_at,
        });
        const meta = validated?.payload;
        if (meta
          && lease.takeover_kind === 'boundary-handoff'
          && lease.handoff_project_root_digest === meta.project_root_digest
          && lease.handoff_project_binding_generation === meta.project_binding_generation
          && sameBoundaryEvent(meta.boundary_event, lease.handoff_boundary_event)
          && sameBoundaryEvent(child?.parent_boundary_event, meta.boundary_event)
          && child?.parent_run_id === lease.owner_run_id
          && child?.project_root_digest === meta.project_root_digest
          && child?.project_binding_generation === meta.project_binding_generation
          && parent?.superseded_by === childRunId
          && sameBoundaryEvent(parent?.scope?.terminal_event, meta.boundary_event)) {
          boundLaunchText = launchText.bytes.toString('utf8').trimEnd();
        }
      } catch { /* stale/malformed metadata selects the current-root fallback */ }
    }
    const launcherGuidance = boundLaunchText !== null
      ? `Launcher guidance (from launch-command.txt):\n${boundLaunchText}`
      : `Launcher guidance: ${descriptor.entries.interactive.display}`;
    const leaseState = typeof lease.state === 'string' ? ` lease_state=${lease.state}` : '';
    process.stdout.write([
      descriptor.resumeInvocation,
      launcherGuidance,
      `Lease: owner=${lease.owner_run_id}${leaseState} generation=${lease.generation} handoff_phase=${lease.handoff_phase} child_run_id=${childRunId}`,
      'Status: 인수 확인은 /deep-loop-status',
      '',
    ].join('\n'));
    return 0;
  },
  tick: async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = exactReadRunId(f);
    if (!runId) return exactReadFailureCode(f);
    const captured = verifiedExactSnapshot(root, runId);
    if (!captured.ok) return reportVerifiedExactFailure(captured);
    const { data } = captured.snapshot;
    const unattended = !!f.unattended || resolveSpawnMode(data, { env: process.env }) === 'headless';
    json(renderNextAction({ mode: f.mode || 'advance', ...nextAction(data, { now: parseNow(f), unattended }) })); return 0;
  },
  lease: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f);
    if (verb === 'check') {
      const exactRunId = exactReadRunId(f); if (!exactRunId) return exactReadFailureCode(f);
      const captured = verifiedExactSnapshot(root, exactRunId);
      if (!captured.ok) return reportVerifiedExactFailure(captured);
      json(leaseCheck(captured.snapshot.data, { owner: strArg(f, 'owner'), generation: intArg(f, 'generation') })); return 0;
    }
    if (verb === 'acquire') {
      const runId = runIdOf(root, f);
      const owner = strArg(f, 'owner');
      const expectGeneration = intArg(f, f['expect-generation'] !== undefined ? 'expect-generation' : 'generation');
      const runtime = reqStr(f, 'runtime');
      if (!runtime) { error('USAGE: --runtime <claude|codex|grok> is required'); return 2; }
      // spec §3.6.1: optional additive 플래그. 형식 위반은 **invalid value → exit 1** 이며 strArg 의
      // fence 채널(exit 3)을 타지 않는다. 미지정은 위반이 아니다(현행 동작 완전 보존).
      let attemptId = null;
      if (f['attempt-id'] !== undefined) {
        attemptId = f['attempt-id'];
        if (typeof attemptId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(attemptId)) {
          error('INVALID_ATTEMPT_ID: must match ^[A-Za-z0-9_-]{8,128}$');
          return 1;
        }
      }
      let r;
      try { r = acquireLease(root, runId, {
        owner,
        expectGeneration,
        runtime,
        attemptId,
        now: parseExplicitNow(f),
      }); }
      catch (e) {
        // A held state lock is a transient acquisition failure, not an unclassified
        // kernel crash.  Keep the public acquire contract machine-readable so a
        // resume caller can fail closed now and decide whether to retry later.
        if (/^LOCK_BUSY(?::|$)/.test(String(e?.message || e))) {
          json({
            ok: false,
            generation: expectGeneration,
            reason: 'lock-busy',
            proceed: false,
            consumed: null,
            replayed: false,
            retryable: true,
          });
          return 1;
        }
        const failure = kernelFailure(e, { unclassified: 'rethrow' });
        error(failure.message); return failure.code;
      }
      json(r);
      if (Number.isInteger(r.kernel_exit_code)) return r.kernel_exit_code;
      // terminal/runtime fence는 exit 3 — resume의 소유권 인수 경계에서 성공-모양(exit 0)으로 위장 금지.
      // 그 외 ok:false(generation/takeability)는 기존 exit 0 + JSON 계약을 유지한다.
      return (r.ok === false && (
        r.reason === 'run-terminal'
        || r.reason === 'RUNTIME_FENCED'
        || r.reason === 'RECOVERY_ACQUIRE_REQUIRED'
      )) ? 3 : 0;
    }
    if (verb === 'release') {
      const runId = runIdOf(root, f);
      json(releaseLease(root, runId, { owner: strArg(f, 'owner'), generation: intArg(f, 'generation') })); return 0;
    }
    error(`unknown lease verb: ${verb}`); return 2;
  },
  workstream: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);
    const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
    if (verb === 'new') {
      const title = reqStr(f, 'title'); if (!title) { error('MISSING_TITLE'); return 2; }
      const branch = reqStr(f, 'branch'); if (!branch) { error('MISSING_BRANCH'); return 2; }
      const worktree = reqStr(f, 'worktree'); if (!worktree) { error('MISSING_WORKTREE'); return 2; }
      let dependsOn = [];
      if (f['depends-on'] !== undefined) {
        let parsed;
        try { parsed = JSON.parse(f['depends-on']); } catch { error('INVALID_DEPENDS_ON'); return 1; }
        if (!Array.isArray(parsed) || parsed.some(d => typeof d !== 'string' || d.length === 0)) { error('INVALID_DEPENDS_ON'); return 1; }
        dependsOn = parsed;
      }
      const r = newWorkstream(root, runId, { title, branch, worktree, dependsOn, fence, now: parseNow(f) }); json(r); return 0;
    }
    if (verb === 'set') {
      const id = reqStr(f, 'id'); if (!id) { error('MISSING_ID'); return 2; }
      const status = reqStr(f, 'status'); if (!status) { error('MISSING_STATUS'); return 2; }
      setWorkstreamStatus(root, runId, id, status, { fence, now: parseNow(f) }); json({ ok: true }); return 0;
    }
    // 터미널(ready/merged/abandoned)은 proof 필수 — 커널 파생 (Codex r1 🔴6: CLI 경계로 노출)
    if (verb === 'terminal') {
      const id = reqStr(f, 'id'); if (!id) { error('MISSING_ID'); return 2; }
      const status = reqStr(f, 'status'); if (!status) { error('MISSING_STATUS'); return 2; }
      if (!['ready', 'merged', 'abandoned'].includes(status)) {
        error(`WORKSTREAM_STATUS_INVALID: ${status} is not terminal`); return 1;
      }
      // Confirmation is command grammar, not persisted-state validation. Classify it before proof JSON
      // parsing or any workstream lookup so malformed/missing state cannot change a usage error into exit 1.
      // A single bare flag, `=true`, or space-valued `true` is affirmative; duplicates are always ambiguous.
      const confirmCount = flagOccurrences(rest, 'confirm');
      let confirm;
      if (status === 'abandoned') {
        if (confirmCount !== 1 || (f.confirm !== true && f.confirm !== 'true')) {
          error('CONFIRM_REQUIRED: abandoned requires exactly one affirmative --confirm (human-only)'); return 2;
        }
        confirm = true;
      } else if (confirmCount !== 0) {
        error('CONFIRM_FORBIDDEN: --confirm is only valid for abandoned'); return 2;
      }
      try {
        recordWorkstreamTerminal(root, runId, id, {
          status,
          proof: f.proof ? JSON.parse(f.proof) : {},
          confirm,
          fence,
          now: parseNow(f),
        });
        json({ ok: true }); return 0;
      } catch (e) {
        const failure = kernelFailure(e, { extra: [['CONFIRM_REQUIRED', 2], ['CONFIRM_FORBIDDEN', 2]] });
        error(failure.message); return failure.code;
      }
    }
    error(`unknown workstream verb: ${verb}`); return 2;
  },
  episode: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);
    const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
    if (verb === 'new') {
      const plugin = reqStr(f, 'plugin'); if (!plugin) { error('MISSING_PLUGIN'); return 2; }
      const role = reqStr(f, 'role'); if (!role) { error('MISSING_ROLE'); return 2; }
      const kind = reqStr(f, 'kind'); if (!kind) { error('MISSING_KIND'); return 2; }
      const point = reqStr(f, 'point'); if (!point) { error('MISSING_POINT'); return 2; }
      const r = newEpisode(root, runId, { plugin, role, kind, point, workstream: f.workstream, expectedArtifacts: f.artifacts ? JSON.parse(f.artifacts) : [], fence, now: parseNow(f) }); json({ id: r.id, request_rel: r.requestRel, request_path: r.requestPath }); return 0;
    }
    if (verb === 'record') {
      const id = reqStr(f, 'id'); if (!id) { error('MISSING_ID'); return 2; }
      const status = reqStr(f, 'status'); if (!status) { error('MISSING_STATUS'); return 2; }
      if (status === 'approved' || status === 'rejected') { error(`EPISODE_TERMINAL_VIA_REVIEW: approved/rejected come only from 'review record'`); return 1; }
      if (status === 'abandoned') { error(`EPISODE_ABANDON_VIA_VERB: use 'episode abandon --confirm'`); return 1; }
      let routing;
      if (Object.hasOwn(f, 'routing')) {
        if (status !== 'in_progress') { error('EPISODE_ROUTING_STATUS_INVALID'); return 1; }
        if (f.routing === true || f.routing === '') { error('USAGE: --routing requires JSON'); return 2; }
        try { routing = JSON.parse(f.routing); }
        catch { error('INVALID_ROUTING: must be JSON'); return 1; }
      }
      const result = recordEpisode(root, runId, id, {
        status,
        artifacts: f.artifacts ? JSON.parse(f.artifacts) : [],
        proof: f.proof ? JSON.parse(f.proof) : {},
        ...(routing !== undefined ? { routing } : {}),
        fence,
        now: parseNow(f),
      });
      const observation = projectObservationForCli(result?.observation);
      json({ ok: true, ...(observation ? { observation } : {}) }); return 0;
    }
    if (verb === 'abandon') {
      const id = reqStr(f, 'id'); if (!id) { error('MISSING_ID'); return 2; }
      const reason = reqStr(f, 'reason'); if (!reason) { error('MISSING_REASON'); return 2; }
      // Mirror the recover/breaker-reset human-gate: missing --confirm is a usage error (exit 2), not an
      // uncaught CONFIRM_REQUIRED stack trace (exit 1). Keep passing confirm:true into the lib (defense in depth).
      if (f.confirm !== true && f.confirm !== 'true') { error('CONFIRM_REQUIRED: pass --confirm (human-only)'); return 2; }
      try {
        const result = abandonEpisode(root, runId, id, { reason, confirm: true, fence, now: parseNow(f) });
        const observation = projectObservationForCli(result?.observation);
        json({ ok: true, status: 'abandoned', ...(observation ? { observation } : {}) }); return 0;
      } catch (e) {
        const failure = kernelFailure(e);
        error(failure.message); return failure.code;   // EPISODE_ALREADY_TERMINAL / EPISODE_NOT_FOUND / EPISODE_INPUT_INVALID → exit 1
      }
    }
    error(`unknown episode verb: ${verb}`); return 2;
  },
  review: async (a) => {
    const [verb, ...rest] = a;
    if (verb === 'bridge-probe') {
      const f = parseFlags(rest);
      if (f.json !== true) { error('USAGE: review bridge-probe requires --json'); return 2; }
      const root = rootOf(f);
      const runId = exactReadRunId(f);
      if (!runId) return exactReadFailureCode(f);
      const captured = verifiedExactSnapshot(root, runId);
      if (!captured.ok) return reportVerifiedExactFailure(captured);
      try {
        json(probeCheckerBridge({
          loopData: captured.snapshot.data,
          home: homedir(),
          env: process.env,
        }));
        return 0;
      } catch (cause) {
        error(String(cause?.message || cause));
        return 1;
      }
    }
    if (verb === 'configure') {
      const allowed = new Set(['profile', 'source-checker', 'confirm', 'owner', 'generation', 'project-root', 'run-id', 'now']);
      if (!exactFlagGrammar(rest, allowed)) { error('USAGE: review configure has invalid grammar'); return 2; }
      const locatorFlags = parseFlags(rest);
      if ((Object.hasOwn(locatorFlags, 'project-root') && reqStr(locatorFlags, 'project-root') === null)
        || (Object.hasOwn(locatorFlags, 'run-id') && reqStr(locatorFlags, 'run-id') === null)) {
        error('USAGE: explicit --project-root and --run-id require a non-empty value');
        return 2;
      }
    }
    const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);
    const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
    if (verb === 'configure') {
      const confirmCount = flagOccurrences(rest, 'confirm');
      if (confirmCount !== 1 || (f.confirm !== true && f.confirm !== 'true')) {
        error('CONFIRM_REQUIRED: review configure requires exactly one affirmative --confirm (human-only)'); return 2;
      }
      const profile = reqStr(f, 'profile');
      if (profile === null) { error('MISSING_PROFILE'); return 2; }
      const sourceCheckerId = reqStr(f, 'source-checker');
      if (sourceCheckerId === null) { error('MISSING_SOURCE_CHECKER'); return 2; }
      try {
        json(configureReviewFlags(root, runId, { profile, sourceCheckerId, confirm: true, fence }));
        return 0;
      } catch (e) {
        const failure = kernelFailure(e, { extra: [['CONFIRM_REQUIRED', 2]] });
        error(failure.message); return failure.code;
      }
    }
    if (verb === 'dispatch') {
      const point = reqStr(f, 'point'); if (!point) { error('MISSING_POINT'); return 2; }
      const workstream = reqStr(f, 'workstream'); if (!workstream) { error('MISSING_WORKSTREAM'); return 2; }
      const independentSubagent = f['independent-subagent'] === true || f['independent-subagent'] === 'true';
      let routing;
      if (Object.hasOwn(f, 'routing')) {
        if (f.routing === true || f.routing === '') { error('USAGE: --routing requires JSON'); return 2; }
        try { routing = JSON.parse(f.routing); }
        catch { error('INVALID_ROUTING: must be JSON'); return 1; }
      }
      json(dispatchReview(root, runId, {
        point, workstreamId: workstream, detected: detectPlugins(root), independentSubagent,
        ...(routing !== undefined ? { routing } : {}),
        fence,
      })); return 0;
    }
    // verdict 기록 → checker 터미널 파생 + breaker/comprehension/review_points (Codex r1 🔴6: CLI 경계로 노출)
    if (verb === 'record') {
      for (const key of ['source', 'workstream', 'workstream-id', 'workstream_id', 'point', 'target-maker', 'target_maker', 'reviewer-id', 'reviewer_id', 'review-source', 'review_source', 'runtime', 'attempt-id', 'attempt_id', 'attemptId']) {
        if (Object.hasOwn(f, key)) { error(`REVIEW_METADATA_FORBIDDEN: review record derives ${key}`); return 1; }
      }
      const episode = reqStr(f, 'episode'); if (!episode) { error('MISSING_EPISODE'); return 2; }
      const verdict = reqStr(f, 'verdict'); if (!verdict) { error('MISSING_VERDICT'); return 2; }
      // --report (required for a passing verdict) / --findings (optional aux). The CLI does NOT pre-gate by
      // verdict — the lib decides (CLI-bypass safe); a missing report on APPROVE/CONCERN surfaces REVIEW_NO_EVIDENCE.
      const report = f.report && f.report !== true ? String(f.report) : undefined;
      const findings = f.findings && f.findings !== true ? String(f.findings) : undefined;
      try {
        const result = recordReviewOutcome(root, runId, {
          episodeId: episode, verdict, proof: { report, findings }, fence, now: parseNow(f),
        });
        const { observation: rawObservation, ...payload } = result;
        const observation = projectObservationForCli(rawObservation);
        json({ ...payload, ...(observation ? { observation } : {}) }); return 0;
      }
      catch (e) {
        const failure = kernelFailure(e);
        error(failure.message); return failure.code;
      }
    }
    if (verb === 'import') {
      for (const key of ['source', 'workstream', 'workstream-id', 'workstream_id', 'point', 'target-maker', 'target_maker', 'reviewer-id', 'reviewer_id', 'review-source', 'review_source', 'runtime', 'attempt-id', 'attempt_id', 'attemptId']) {
        if (Object.hasOwn(f, key)) { error(`REVIEW_METADATA_FORBIDDEN: review import derives ${key}`); return 1; }
      }
      if (f.stdin !== true) { error('STDIN_REQUIRED: review import requires --stdin'); return 2; }
      try {
        const raw = await readBoundedText(process.stdin);
        const result = importReviewOutcome(root, runId, { raw, fence, now: parseNow(f) });
        const { observation: rawObservation, ...payload } = result;
        const observation = projectObservationForCli(rawObservation);
        json({ ...payload, ...(observation ? { observation } : {}) });
        return 0;
      } catch (e) {
        const failure = kernelFailure(e);
        error(failure.message); return failure.code;
      }
    }
    error(`unknown review verb: ${verb}`); return 2;
  },
  handoff: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    const data = requireLease(root, runId, f, 'lease');
    const expect = { owner: f.owner, generation: intArg(f, 'generation') };
    if (verb === 'emit') {
      let boundaryEvent;
      if (Object.hasOwn(f, 'boundary-event')) {
        const parsed = parseBoundaryEventFlag(f['boundary-event']);
        if (!parsed.ok) {
          error(parsed.usage
            ? 'USAGE: --boundary-event <seq>:<64-lowercase-hex-checksum>'
            : 'BOUNDARY_EVENT_INVALID: expected positive base10 seq without leading zero plus lowercase checksum');
          return parsed.usage ? 2 : 1;
        }
        boundaryEvent = parsed.value;
      }
      if (data.autonomy?.continuation_policy === 'workstream-session' && !boundaryEvent) {
        error('USAGE: handoff emit requires --boundary-event <seq>:<64-lowercase-hex-checksum>');
        return 2;
      }
      const h = f.headless === true || f.headless === 'true';
      // v1.6 (spec §2.3-2 CLI 매핑): 기존 RUN_PAUSED/HANDOFF_KEY_MISMATCH throw의 uncaught stack 해소 —
      // respawn/pause/recover 핸들러와 동일 패턴. RUN_TERMINAL은 보상 롤백 후 반환 계약(JSON ok:false)이라 여기 안 걸린다.
      try { json(emitHandoff(root, runId, { reason: f.reason, trigger: f.trigger || f.reason || 'milestone', boundaryEvent, headless: h, expect, env: process.env, now: parseNow(f) })); return 0; }
      catch (e) { const failure = kernelFailure(e); error(failure.message); return failure.code; }
    }
    error(`unknown handoff verb: ${verb}`); return 2;
  },
  // respawn --owner <id> --generation <n> [--attended] [--headless]
  // Resolve the spawn mode first: headless routes through the shared measured host; visible/desktop routes through
  // respawn + visibleSpawn. The caller fence is carried into either path and checked again before CAS.
  respawn: async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = runIdOf(root, f);
    if (!runId) { error('MISSING_RUN_ID'); return 2; }
    const { data } = captureReconciledRunSnapshot(root, runId);
    if (f['dry-run']) { json(respawnGate(data)); return 0; }
    // Require + fence --owner/--generation (exit 3). intent 'lease' so a releasing handoff lease is not rejected.
    requireLease(root, runId, f, 'lease');
    const headless = f.headless === true || f.headless === 'true';
    const attended = f.attended === true || f.attended === 'true';
    let timeoutMs;
    if (Object.hasOwn(f, 'timeout-ms')) {
      timeoutMs = optInt(f, 'timeout-ms');
      if (timeoutMs == null || !Number.isSafeInteger(timeoutMs) || timeoutMs > 2_147_483_647) {
        error('INVALID_TIMEOUT_MS: --timeout-ms must be an integer from 0 through 2147483647');
        return 1;
      }
    }
    const mode = resolveSpawnMode(data, { headless, attended, env: process.env });
    const lease = data.session_chain?.lease || {};
    const childRunId = lease.handoff_child_run_id;
    const key = lease.handoff_idempotency_key;
    const cs = (data.session_chain?.sessions || []).find(s => s.run_id === childRunId);
    const handoffRel = cs && cs.handoff_rel;
    const pollLease = () => captureReconciledRunSnapshot(root, runId).data.session_chain.lease;
    const expect = { owner: f.owner, generation: intArg(f, 'generation') };
    const now = parseNow(f);
    try {
      const r = mode === 'headless'
        ? driveHeadlessRun({
          root, runId, expect, headless, now, timeoutMs, env: process.env,
          // An explicit --now pins deterministic tests/diagnosis; ordinary CLI runs refresh after preflight.
          clock: f.now === undefined ? Date.now : null,
          overrideVisiblePolicy: headless,
        })
        : respawn(root, runId, {
          childRunId, key, handoffRel, headless, attended, now,
          spawnFn: visibleSpawn, pollLease, env: process.env,
          expect, expectedMode: mode,
        });
      json({ mode, ...r });
      if (r.action === 'unmeasured-runtime' || r.action === 'paused') return 1;
      return r.ok ? 0 : (r.outcome === 'fenced' || r.outcome === 'terminal' || r.action === 'fenced' || r.action === 'terminal' ? 3 : 0);   // v1.6: terminal 거부는 fence 채널 — soft error(0) 위장 금지 (spec §2.3-5)
    } catch (e) {
      const failure = kernelFailure(e, { extra: [['RESPAWN_FENCED', 3]] });
      error(failure.message); return failure.code;
    }
  },
  state: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f);
    if (verb === 'get') {
      const exactRunId = exactReadRunId(f);
      if (!exactRunId) return exactReadFailureCode(f);
      const captured = verifiedExactSnapshot(root, exactRunId);
      if (!captured.ok) return reportVerifiedExactFailure(captured);
      const { data } = captured.snapshot;
      if (f.field === undefined || f.field === true) { json(data); return 0; }
      const val = String(f.field).split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
      json(val === undefined ? null : val); return 0;
    }
    if (verb === 'patch') {
      const runId = runIdOf(root, f);
      if (runId == null) { error('MISSING_RUN_ID'); return 2; }   // mutating with no run = usage error (before fence)
      requireLease(root, runId, f);   // --owner/--generation 누락·불일치 → exit 3 (fence)
      const field = reqStr(f, 'field'); if (!field) { error('MISSING_FIELD'); return 2; }       // Codex r1 sf-6: 비-fence 누락 → exit 2
      const rawVal = reqStr(f, 'value'); if (rawVal === null) { error('MISSING_VALUE'); return 2; }
      let value; try { value = JSON.parse(rawVal); } catch { error('INVALID_VALUE: must be JSON'); return 1; }   // 무효 값 → exit 1
      try { patchState(root, runId, field, value, { fence: { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' } }); }
      catch (e) { const failure = kernelFailure(e); error(failure.message); return failure.code; }
      json({ ok: true }); return 0;
    }
    error(`unknown state verb: ${verb}`); return 2;
  },
  // pause --owner <id> --generation <n> --reason <r> [--mode preserve|rollback]
  // Two-mode safety pause: RUN_PAUSED blocks business writes; humans resume/recover manually.
  // Exit 3 = LEASE_FENCED (wrong owner/generation); 2 = missing required arg; 0 = success.
  pause: async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = runIdOf(root, f);
    if (!runId) { error('MISSING_RUN_ID'); return 2; }
    const owner = reqStr(f, 'owner'); if (!owner) { error('MISSING_OWNER'); return 2; }
    const reason = reqStr(f, 'reason'); if (!reason) { error('MISSING_REASON'); return 2; }
    const generation = intArg(f, 'generation');   // exits 3 on invalid/missing (consistent with other handlers)
    if (f.mode !== undefined && f.mode !== 'preserve' && f.mode !== 'rollback') {
      error('USAGE: --mode must be preserve or rollback'); return 2;
    }
    const mode = (f.mode === 'rollback') ? 'rollback' : 'preserve';
    try {
      // ARC-3: 다른 verb 와 같은 optional `--now` — §8 fixture 의 timed step 이 결정론적으로 재생되려면
      // pause 도 주입된 시간을 써야 한다. 미지정은 현행대로 Date.now(); 무효 값은 INVALID_NOW → exit 1.
      const explicitNow = parseExplicitNow(f);
      pauseRun(root, runId, {
        reason, mode, expect: { owner, generation }, now: explicitNow ?? Date.now(),
      });
      json({ ok: true, status: 'paused' }); return 0;
    } catch (e) {
      const failure = kernelFailure(e);
      error(failure.message); return failure.code;
    }
  },
  // recover --owner <id> --generation <n> --confirm
  // recover --supersede-affinity --reason <text> --owner <id> --generation <n> --confirm
  // The new-policy route never releases an open affinity to a generic future owner.
  recover: async (a) => {
    const allowed = new Set([
      'confirm', 'supersede-affinity', 'reason', 'owner', 'generation',
      'project-root', 'run-id', 'now',
    ]);
    if (!knownFlagVocabulary(a, allowed) || !exactFlagGrammar(a, allowed)) {
      error('USAGE: recover has invalid grammar');
      return 2;
    }
    const f = parseFlags(a);
    if (['project-root', 'run-id', 'reason', 'owner', 'generation', 'now']
      .some(name => f[name] === true)) {
      error('USAGE: recover option requires a value');
      return 2;
    }
    const root = rootOf(f); const runId = runIdOf(root, f);
    if (!runId) { error('MISSING_RUN_ID'); return 2; }
    if (f.confirm !== true && f.confirm !== 'true') { error('CONFIRM_REQUIRED: pass --confirm (human-only)'); return 2; }
    const owner = reqStr(f, 'owner'); if (!owner) { error('MISSING_OWNER'); return 2; }
    const generation = intArg(f, 'generation');   // exits 3 on invalid/missing
    try {
      let result;
      if (Object.hasOwn(f, 'supersede-affinity')) {
        if (f['supersede-affinity'] !== true && f['supersede-affinity'] !== 'true') {
          error('USAGE: --supersede-affinity must be affirmative');
          return 2;
        }
        const reason = reqStr(f, 'reason');
        if (!reason) { error('USAGE: affinity supersession requires --reason TEXT'); return 2; }
        result = supersedeAffinity(root, runId, {
          reason,
          expect: { owner, generation },
          confirm: true,
          now: parseExplicitNow(f),
        });
      } else {
        if (Object.hasOwn(f, 'reason')) {
          error('USAGE: --reason is valid only with --supersede-affinity');
          return 2;
        }
        result = recoverRun(root, runId, {
          expect: { owner, generation },
          confirm: true,
          now: parseExplicitNow(f),
        });
      }
      json(result); return 0;
    } catch (e) {
      const failure = kernelFailure(e, { extra: [['NOT_RECOVERABLE', 2], ['CONFIRM_REQUIRED', 2]] });
      error(failure.message); return failure.code;
    }
  },
  recovery: async (a) => {
    const [verb, ...rest] = a;
    const allowed = new Set([
      'capsule', 'owner', 'generation', 'runtime', 'project-root', 'run-id', 'now',
    ]);
    if (verb !== 'acquire'
      || !knownFlagVocabulary(rest, allowed)
      || !exactFlagGrammar(rest, allowed)) {
      error('USAGE: recovery acquire has invalid grammar');
      return 2;
    }
    const f = parseFlags(rest);
    if (['capsule', 'owner', 'generation', 'runtime', 'project-root', 'run-id', 'now']
      .some(name => f[name] === true)) {
      error('USAGE: recovery acquire option requires a value');
      return 2;
    }
    const capsuleRel = reqStr(f, 'capsule');
    const owner = reqStr(f, 'owner');
    const runtime = reqStr(f, 'runtime');
    const generationValue = reqStr(f, 'generation');
    if (!capsuleRel || !owner || !runtime
      || !/^[1-9]\d*$/.test(generationValue || '')
      || !Number.isSafeInteger(Number(generationValue))) {
      error('USAGE: recovery acquire requires capsule, owner, positive generation, and runtime');
      return 2;
    }
    const root = rootOf(f);
    const runId = runIdOf(root, f);
    if (!runId) { error('MISSING_RUN_ID'); return 2; }
    try {
      const result = acquireRecovery(root, runId, {
        capsuleRel,
        owner,
        expectGeneration: Number(generationValue),
        runtime,
        now: parseExplicitNow(f),
      });
      json(result);
      return result.ok ? 0 : 1;
    } catch (e) {
      const failure = kernelFailure(e);
      error(failure.message);
      return failure.code;
    }
  },
  adapter: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest);
    if (verb !== 'resolve') { error(`unknown adapter verb: ${verb}`); return 2; }
    const protocol = reqStr(f, 'protocol'); if (!protocol) { error('MISSING_PROTOCOL'); return 2; }
    let ad, p; try { ad = resolveAdapter(protocol); p = loadProtocol(protocol); } catch { error(`UNKNOWN_PROTOCOL: ${protocol}`); return 2; }
    const task = reqStr(f, 'task') || '';
    const ref = { task };
    const fillTask = (t) => String(t || '').replace(/<task>/g, task);
    let dispatch = ad.dispatch(ref);
    const awaitD = ad.awaitResult(ref);
    const read = { path: p.read.receipt_path_template ? fillTask(p.read.receipt_path_template) : null, producer: p.read.producer, artifact_kind: p.read.artifact_kind };
    // guard 는 implementer_verb 기준 (tier×protocol 모순). Codex r7 sf-1: read-only 가 implementer 를 막을 때,
    // implementer_verb 가 'then'(superpowers)이면 planning(dispatch.skill=writing-plans)은 살리고 `then`(subagent-driven-development)만 strip,
    // 'dispatch'(deep-work/standalone)면 dispatch 자체가 implementer 라 전체 차단(guard.ok=false).
    const implGuard = f.tier && f.tier !== true ? guardTierProtocol(f.tier, protocol, p.implementer_verb) : { ok: true, reason: 'no-tier' };
    let guard = implGuard;
    if (!implGuard.ok && p.implementer_verb === 'then') {
      dispatch = { ...dispatch, then: null };                                  // planning-only: writing-plans 실행, then skip
      guard = { ok: true, reason: 'planning-only-readonly', planning_only: true };
    }
    const sel = f.verb && f.verb !== true ? String(f.verb) : null;
    if (sel) {
      const map = { dispatch, await: awaitD, read };
      if (!(sel in map)) { error(`UNKNOWN_VERB: ${sel}`); return 2; }
      json({ protocol, selected: sel, descriptor: map[sel], guard }); return 0;
    }
    json({ protocol, dispatch, await: awaitD, read, checker_via: 'review dispatch --point <p> --workstream <ws> (kernel derives checker episode + descriptor)', guard }); return 0;
  },
  budget: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f);
    if (verb === 'check') {
      const exactRunId = exactReadRunId(f); if (!exactRunId) return exactReadFailureCode(f);
      const captured = verifiedExactSnapshot(root, exactRunId);
      if (!captured.ok) return reportVerifiedExactFailure(captured);
      json(checkBudget(captured.snapshot.data, { now: parseNow(f) })); return 0;
    }
    const runId = runIdOf(root, f);
    if (verb === 'record') {
      requireLease(root, runId, f);
      // Codex r4 sf-4: parseFlags 는 값 없는 플래그를 true 로 둔다 → Number(true)=1 오기록 방지.
      // 미지정 → 0, 지정 시 비음정수 문자열만 허용(true/음수/NaN/Infinity 거부).
      const turns = optInt(f, 'turns'); const tokens = optInt(f, 'tokens');
      if (turns === null || tokens === null) { error('INVALID_COST: --turns/--tokens must be non-negative integers'); return 1; }
      const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
      try { recordCost(root, runId, { turns, tokens, fence }); }
      catch (e) { const failure = kernelFailure(e); error(failure.message); return failure.code; }
      const { data } = captureReconciledRunSnapshot(root, runId);
      json({ ok: true, spent: data.budget.spent, tokens_spent: data.budget.tokens_spent }); return 0;
    }
    if (verb === 'extend') {
      if (f.confirm !== true && f.confirm !== 'true') {
        error('BUDGET_EXTENSION_CONFIRM_REQUIRED: pass --confirm (human-only)'); return 2;
      }
      const reason = reqStr(f, 'reason');
      if (!reason) { error('BUDGET_EXTENSION_REASON_REQUIRED: pass --reason <text>'); return 2; }
      const turns = positiveDeltaArg(f, 'turns');
      const tokens = positiveDeltaArg(f, 'tokens');
      const wallclockSec = positiveDeltaArg(f, 'wallclock-sec');
      if ([turns, tokens, wallclockSec].includes(null)
        || [turns, tokens, wallclockSec].every(value => value === undefined)) {
        error('BUDGET_EXTENSION_INVALID: deltas must be positive safe integers'); return 1;
      }
      const owner = strArg(f, 'owner');
      const generation = intArg(f, 'generation');
      try {
        json(extendBudget(root, runId, {
          turns,
          tokens,
          wallclockSec,
          reason,
          confirm: true,
          fence: { owner, generation },
          now: parseNow(f),
        }));
        return 0;
      } catch (e) {
        const failure = kernelFailure(e);
        error(failure.message); return failure.code;
      }
    }
    error(`unknown budget verb: ${verb}`); return 2;
  },
  comprehension: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f);
    if (verb === 'status') {
      const exactRunId = exactReadRunId(f); if (!exactRunId) return exactReadFailureCode(f);
      const captured = verifiedExactSnapshot(root, exactRunId);
      if (!captured.ok) return reportVerifiedExactFailure(captured);
      json(computeDebt(captured.snapshot.data)); return 0;
    }
    if (verb === 'ack') {
      const runId = runIdOf(root, f);
      requireLease(root, runId, f);   // fence 인자 → exit 3
      const episode = reqStr(f, 'episode'); if (!episode) { error('MISSING_EPISODE'); return 2; }   // Codex r1 sf-6
      if (f.actor === true) { error('USAGE: --actor requires a value (human|agent)'); return 2; }   // value-less 거부
      const actor = f.actor !== undefined ? String(f.actor) : 'agent';
      if (!['human', 'agent'].includes(actor)) { error('INVALID_ACTOR: --actor must be human|agent'); return 2; }
      const confirm = f.confirm === true || f.confirm === 'true';
      // Fast-fail UX + defense-in-depth. The authoritative guard is in ack() itself (CLI-bypass safe).
      if (actor === 'human' && !confirm) { error('CONFIRM_REQUIRED: human ack requires --confirm (human-only)'); return 2; }
      const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
      let r;
      try { r = ackComprehension(root, runId, episode, { actor, confirm, env: process.env, fence }); }
      catch (e) { const failure = kernelFailure(e); error(failure.message); return failure.code; }   // EPISODE_NOT_FOUND → exit 1
      if (r && r.ok === false && r.rejected) {
        // headless-human fail-closed (the ack-rejected event is already appended). Surface as usage error.
        error(`ACK_REJECTED: ${r.reason}`);
        const { data } = captureReconciledRunSnapshot(root, runId); json({ ok: false, ...computeDebt(data) }); return 2;
      }
      const { data } = captureReconciledRunSnapshot(root, runId); json({ ok: true, ...computeDebt(data) }); return 0;
    }
    error(`unknown comprehension verb: ${verb}`); return 2;
  },
  breaker: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f);
    if (verb === 'check') {
      const exactRunId = exactReadRunId(f); if (!exactRunId) return exactReadFailureCode(f);
      const captured = verifiedExactSnapshot(root, exactRunId);
      if (!captured.ok) return reportVerifiedExactFailure(captured);
      json(checkBreaker(captured.snapshot.data)); return 0;
    }
    if (verb === 'reset') {
      const runId = runIdOf(root, f);
      if (f.confirm !== true && f.confirm !== 'true') { error('BREAKER_RESET_REQUIRES_CONFIRM: pass --confirm (human-only)'); return 2; }
      const owner = strArg(f, 'owner');
      const fence = { owner, generation: intArg(f, 'generation'), intent: 'breaker-reset' };
      try { json(resetBreaker(root, runId, { fence })); return 0; }
      catch (e) { const failure = kernelFailure(e); error(failure.message); return failure.code; }
    }
    error(`unknown breaker verb: ${verb}`); return 2;
  },
  // insights [--run <id>] | insights emit --owner --generation | insights latest
  // compute/latest = read-only (fence 불필요, spec §6). emit = mutating → requireLease(외곽) + lib preCheck(락 안).
  insights: async (a) => {
    const verb = a[0] && !a[0].startsWith('--') ? a[0] : null;
    const f = parseFlags(verb ? a.slice(1) : a);
    const root = rootOf(f);
    if (verb === null) {
      const selfRunId = exactReadRunId(f);
      if (!selfRunId) return exactReadFailureCode(f);
      const runSet = captureVerifiedInsightsRunSet(root);
      if (runSet.ok === false) { json(runSet); return 1; }
      if (f.run !== undefined) {
        const target = String(f.run);
        // runDir는 unsafe path segment('/'·'..' 등)에 RUN_ID_INVALID를 throw — read-only 조회에서는
        // 존재하지 않는 run과 동일하게 clean exit 1로 취급한다 (uncaught 스택 금지, impl-R2 ℹ️7).
        let targetDir;
        try { targetDir = runDir(root, target); } catch { error(`RUN_NOT_FOUND: ${target}`); return 1; }
        if (!existsSync(targetDir)) { error(`RUN_NOT_FOUND: ${target}`); return 1; }
        const out = computeInsights(runSet, { selfRunId, now: parseNow(f) });
        json({ ...out, per_run: { [target]: out.per_run[target] ?? null } }); return 0;
      }
      json(computeInsights(runSet, { selfRunId, now: parseNow(f) })); return 0;
    }
    if (verb === 'latest') {
      const result = latestInsights(captureLatestInsightsSet(root));
      json(result);
      return result?.ok === false ? 1 : 0;
    }
    if (verb === 'emit') {
      const runId = runIdOf(root, f);
      requireLease(root, runId, f);
      const nowMs = parseNow(f);
      // Phase6 warning-1: reject future-skewed --now here — emitInsights names the artifact ulid(now) and
      // latestInsights picks the lexicographically-last filename, so a future --now would permanently pin a
      // stale candidate ahead of every later legitimate emit (past --now is self-healing, so only future is blocked).
      if (f.now !== undefined && nowMs > Date.now() + 60_000) { error('INSIGHTS_NOW_FUTURE: --now must not be more than 60s in the future'); return 1; }
      const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
      try { json(emitInsights(root, runId, { fence, now: nowMs })); return 0; }
      catch (e) { const failure = kernelFailure(e); error(failure.message); return failure.code; }
    }
    error(`unknown insights verb: ${verb}`); return 2;
  },
  // spawn-style offer-desktop|confirm-desktop|decline-desktop|reset-desktop --owner <id> --generation <n> [--nonce <n>]
  //           | probe-desktop
  // Durable, nonce-bound desktop opt-in (Task 7; round-6 review parts a/b/c). Fence-fenced like every
  // other mutating subcommand: requireLease is a fast outer pre-check (exit 3 on missing/invalid/
  // mismatched owner-generation); the lib functions re-check the SAME fence in-lock (authoritative — see
  // spawn-optin.mjs). `probe-desktop` is READ-ONLY (no state mutation, no event appended), so it needs no
  // fence/owner/generation/run and is dispatched BEFORE requireLease; the skill uses it to gate whether
  // to even OFFER the opt-in (round-6 part b), and a human/operator can run it standalone with no active
  // run. `reset-desktop` is the other exception (round-7 review Finding 1): it is a HUMAN RECOVERY
  // operation that must work while the run is paused with a releasing lease (the exact state a
  // desktop-unavailable respawn leaves behind), so it skips requireLease's business-intent leaseCheck()
  // and relies on resetDesktop's own bespoke in-lock fence instead (owner/generation only — same LEASE_
  // FENCED exit-3 contract, no RUN_PAUSED/releasing gating). Exit codes: 3 = LEASE_FENCED (fence, incl.
  // missing/invalid --owner/--generation — N/A for probe-desktop), 1 = {ok:false} rejection (NONCE_INVALID/
  // NONCE_EXPIRED/SOURCE_INVALID/PLATFORM_UNSUPPORTED/HANDLER_UNVERIFIED) or any other thrown error, 2 =
  // unknown verb.
  'spawn-style': async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest);
    if (verb === 'probe-desktop') { json(defaultDesktopProbe({ platform: process.platform })); return 0; }
    const root = rootOf(f); const runId = runIdOf(root, f);
    // reset-desktop is a HUMAN RECOVERY operation (round-7 review Finding 1) — it must work in the EXACT
    // stuck state a desktop-unavailable respawn leaves behind: status='paused', lease.state='releasing'
    // (see respawn.mjs preservePause). The shared business-intent requireLease() precheck below rejects
    // both of those, so — mirroring how the `recover` subcommand above ALSO bypasses requireLease and
    // lets its lib function's own bespoke fence be authoritative — reset-desktop skips it too. Shape is
    // still validated fast (missing/non-string --owner → exit 3), matching every other spawn-style verb's
    // exit-3 usage contract; the real fence check happens inside resetDesktop (spawn-optin.mjs), in-lock.
    if (verb === 'reset-desktop') strArg(f, 'owner');
    else requireLease(root, runId, f);
    const expect = { owner: f.owner, generation: intArg(f, 'generation') };
    const now = parseNow(f);
    const nonce = (f.nonce !== undefined && f.nonce !== true) ? String(f.nonce) : undefined;
    if (verb === 'offer-desktop') {
      let ttlSec; if (f['ttl-sec'] !== undefined) { ttlSec = optInt(f, 'ttl-sec'); if (ttlSec === null) { error('INVALID_TTL_SEC'); return 1; } }
      try { const r = offerDesktop(root, runId, { expect, now, nonce, ...(ttlSec != null ? { ttlSec } : {}) }); json(r); return r.ok ? 0 : 1; }
      catch (e) { const failure = kernelFailure(e); error(failure.message); return failure.code; }
    }
    if (verb === 'confirm-desktop') {
      // desktopProbe not injected here — defaults to defaultDesktopProbe (real host probe on process.platform),
      // matching the (uninjected) `platform` default too. Round-6 part (a): a failing probe now returns
      // {ok:false, reason:'HANDLER_UNVERIFIED'} and persists NOTHING.
      try { const r = confirmDesktop(root, runId, { expect, now, nonce }); json(r); return r.ok ? 0 : 1; }
      catch (e) { const failure = kernelFailure(e); error(failure.message); return failure.code; }
    }
    if (verb === 'decline-desktop') {
      try { json(declineDesktop(root, runId, { expect, now })); return 0; }
      catch (e) { const failure = kernelFailure(e); error(failure.message); return failure.code; }
    }
    if (verb === 'reset-desktop') {
      try { const r = resetDesktop(root, runId, { expect, now }); json(r); return r.ok ? 0 : 1; }
      catch (e) { const failure = kernelFailure(e); error(failure.message); return failure.code; }
    }
    error(`unknown spawn-style verb: ${verb}`); return 2;
  },
  // attended-launch approve --style visible --confirm --owner <id> --generation <n>
  // attended-launch revoke --confirm --owner <id> --generation <n>
  // Desktop approval is intentionally exclusive to the nonce + live-handler
  // `spawn-style confirm-desktop` flow.
  'attended-launch': async (a) => {
    const [verb, ...rest] = a;
    const allowed = verb === 'approve'
      ? new Set(['style', 'confirm', 'owner', 'generation', 'now', 'project-root', 'run-id'])
      : new Set(['confirm', 'owner', 'generation', 'now', 'project-root', 'run-id']);
    if (!['approve', 'revoke'].includes(verb)) {
      error(`unknown attended-launch verb: ${verb ?? '<none>'}`);
      return 2;
    }
    if (!exactFlagGrammar(rest, allowed)) {
      error('USAGE: attended-launch flags are malformed, duplicated, or unknown');
      return 2;
    }
    const f = parseFlags(rest);
    if (f.confirm !== true && f.confirm !== 'true') {
      error('CONFIRM_REQUIRED: attended launch mutation requires --confirm');
      return 2;
    }
    const root = rootOf(f);
    const runId = runIdOf(root, f);
    if (!runId) { error('MISSING_RUN_ID'); return 2; }
    const fence = { owner: strArg(f, 'owner'), generation: intArg(f, 'generation') };
    const now = parseNow(f);

    if (verb === 'approve') {
      // Ordinary approval is an active-session mutation. The library repeats
      // the authoritative fence in its anchored transaction.
      requireLease(root, runId, f);
      try {
        const result = approveAttendedLaunch(root, runId, {
          style: f.style === true || f.style === undefined ? undefined : String(f.style),
          confirm: true, fence, now,
        });
        if (result.reason === 'DESKTOP_FLOW_REQUIRED') {
          error('DESKTOP_FLOW_REQUIRED: use spawn-style offer-desktop then spawn-style confirm-desktop');
          return 1;
        }
        if (!result.ok) { error(result.reason); return result.reason === 'CONFIRM_REQUIRED' ? 2 : 1; }
        json(result);
        return 0;
      } catch (error_) {
        const failure = kernelFailure(error_);
        error(failure.message);
        return failure.code;
      }
    }

    // Revoke deliberately bypasses ordinary leaseCheck so it can operate on a
    // safely paused active lease; revokeAttendedLaunch owns the exact in-lock
    // owner/generation, terminal, state, and handoff-phase checks.
    try {
      const result = revokeAttendedLaunch(root, runId, {
        confirm: true, fence, now,
      });
      if (!result.ok) { error(result.reason); return result.reason === 'CONFIRM_REQUIRED' ? 2 : 1; }
      json(result);
      return 0;
    } catch (error_) {
      const failure = kernelFailure(error_);
      error(failure.message);
      return failure.code;
    }
  },
  // session-profile set --model <m> --effort <e> --owner <id> --generation <n>
  // Refresh durable autonomy.session_model/effort (WS1). intent:'lease' (releasing-safe, like respawn/
  // detect-terminal) so an attended session can refresh while a PreCompact handoff is in-flight. Exit
  // codes: 3 = LEASE_FENCED (incl. missing/invalid --owner/--generation), 1 = invalid model/effort, 2 = usage.
  'session-profile': async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb !== 'set') { error(`unknown session-profile verb: ${verb}`); return 2; }
    if (!runId) { error('MISSING_RUN_ID'); return 2; }
    // A value-less --model/--effort (parseFlags → true) is a malformed invocation, NOT an omission —
    // reject as usage (exit 2) so it can never silently drop the field while writing the other.
    if (f['session-profile'] === undefined && (f.model === true || f.effort === true)) {
      error('USAGE: --model/--effort require a value'); return 2;
    }
    const profile = parseSessionProfileFlags(f);
    if (profile.error) { error(profile.error); return profile.code; }
    const model = profile.value.model;
    const effort = profile.value.effort;
    if (profile.source === 'legacy' && model === undefined && effort === undefined) {
      error('NOTHING_TO_SET'); return 2;
    }
    requireLease(root, runId, f, 'lease');   // releasing-safe outer fence (exit 3)
    const expect = { owner: f.owner, generation: intArg(f, 'generation') };
    try {
      const r = setSessionProfile(root, runId, {
        model, effort, expect, now: parseNow(f), allowEmpty: profile.source === 'json',
      });
      json(r); return 0;
    } catch (e) {
      const failure = kernelFailure(e);
      error(failure.message); return failure.code;
    }
  },
  'detect-terminal': async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = runIdOf(root, f);
    if (!runId) { error('MISSING_RUN_ID'); return 2; }
    // intent:'lease' so a releasing lease is not rejected (releasing-safe R11-HH)
    requireLease(root, runId, f, 'lease');
    const now = new Date(parseNow(f)).toISOString();
    try {
      const d = detectAndPersist(root, runId, { owner: f.owner, generation: intArg(f, 'generation'), now });
      json(d); return 0;
    } catch (e) {
      const failure = kernelFailure(e);
      error(failure.message); return failure.code;
    }
  },
  finish: async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);   // fence 인자 → exit 3
    const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
    const status = reqStr(f, 'status'); if (!status) { error('MISSING_STATUS'); return 2; }   // Codex r1 sf-6
    const confirm = f.confirm === true || f.confirm === 'true';
    // #4: stopped is a human-only bypass of completed-proof — mirror the abandon/recover/breaker-reset fast-fail
    // (exit 2). Authoritative guard is in finishRun (CLI-bypass safe); completed is unaffected.
    if (status === 'stopped' && !confirm) { error('CONFIRM_REQUIRED: stopped requires --confirm (human-only)'); return 2; }
    const reportRel = f.report && f.report !== true ? String(f.report) : undefined;
    if (reportRel && (reportRel.startsWith('/') || reportRel.split('/').includes('..'))) { error('FINISH_REPORT_PATH_UNSAFE'); return 1; }
    let proof; try { proof = f.proof ? JSON.parse(f.proof) : {}; } catch { error('INVALID_PROOF: must be JSON'); return 1; }   // 무효 값 → exit 1
    try { const r = finishRun(root, runId, { status, reportRel, proof, confirm, fence, now: parseNow(f) }); json(r); return 0; }
    catch (e) { const failure = kernelFailure(e); error(failure.message); return failure.code; }   // FINISH_STATUS_INVALID/PROOF_UNMET → exit 1
  },
};

const fn = handlers[sub];
if (!fn) { error(`unknown subcommand: ${sub ?? '<none>'}`); process.exit(2); }
const routeKey = rawRouteKey(sub, rest);
const routeSpec = ROUTE_FLAGS[routeKey];
if (!routeSpec) { error(`USAGE: unknown route: ${routeKey}`); process.exit(2); }
if (MUTATING_ROUTE_SET.has(routeKey) && !requireExactRunId(rest).ok) {
  error('USAGE: mutating routes require exactly one valued --run-id');
  process.exit(2);
}
const flagArgv = rest.slice(consumedPositionalCount(sub, rest));
if (!HANDLER_OWNED_GRAMMAR.has(routeKey) && !knownFlagVocabulary(flagArgv, vocabulary(routeSpec))) {
  const names = vocabulary(routeSpec);
  let flagged = null;
  let stray = null;
  for (let index = 0; index < flagArgv.length; index += 1) {
    const token = flagArgv[index];
    if (typeof token !== 'string') continue;
    if (!token.startsWith('--')) {
      stray = token;
      break;
    }
    const body = token.slice(2);
    const flag = body.includes('=') ? body.slice(0, body.indexOf('=')) : body;
    if (!names.has(flag)) { flagged = flag; break; }
    if (!body.includes('=') && flagArgv[index + 1] !== undefined && !String(flagArgv[index + 1]).startsWith('--')) {
      index += 1;
    }
  }
  if (flagged !== null) error(formatUnknownFlag(routeKey, flagged, routeSpec));
  else if (stray !== null) error(`USAGE: unexpected positional \`${stray}\` for route \`${routeKey}\``);
  else error(`USAGE: unexpected token for route \`${routeKey}\``);
  process.exit(2);
}
// 명시적으로 분류된 커널 계약 오류만 변환하는 좁은 catch — 그 외 예외는 기존 fail-stop(uncaught) 그대로 재-throw
// (integrity 등의 detect-and-fail-stop 모델을 넓은 catch로 삼키지 않는다).
try {
  process.exitCode = await fn(rest);
} catch (e) {
  const classified = classifyKernelError(e);
  if (classified) { error(classified.message); process.exitCode = classified.code; }
  else throw e;
}
