// Read-only `run status` projection (issue #75). Pure functions: every input is a resolver result or a
// verified snapshot already captured by the caller; nothing here reads the environment or the file system.
import { checkBudget } from './budget.mjs';
import { computeDebt } from './comprehension.mjs';
import { checkBreaker } from './breaker.mjs';
import { nextAction } from './next-action.mjs';

export const RUN_STATUS_VERSION = 1;

// Closed list: the only slash commands a descriptor may surface in the band.
export const PUBLIC_NEXT_COMMANDS = Object.freeze([
  '/deep-loop-continue',
  '/deep-loop-discover',
  '/deep-loop-finish',
  '/deep-loop-handoff',
  '/deep-loop-resume',
  '/deep-loop-status',
]);

// Closed vocabulary of reasons the kernel itself produces as code literals. This is a projection by
// vocabulary, not a proof of origin: free text that happens to equal a listed word is shown as-is, and
// everything else (paths, sentences, goal text) is reduced to "other".
export const PUBLIC_REASONS = Object.freeze(new Set([
  // next-action / goal-actions / execution action reasons
  'active-work-remains', 'breaker', 'budget', 'checker-needs-claim', 'checker-result-needs-import',
  'comprehension-debt', 'dependency-needs-replan', 'episode-blocked', 'goal-checker-unavailable',
  'goal-review-liveness-unknown', 'goal-review-rejected', 'goal-work-missing', 'orphan-maker-no-artifacts',
  'pending-checker-unresolved', 'per_session_turn_cap', 'resume-blocked-inline-work', 'review-point-work-missing',
  'unbound-proof-episode', 'workstream-selection-blocked', 'workstream-terminal', 'run-paused', 'goal-proof',
  'prerequisite', 'next-workstream',
  // execution.mjs executionAction ternary reasons (not reachable by a literal scan)
  'execution-liveness-unknown', 'execution-failed', 'start-not-observed', 'producer-result-required',
  // goal-review proof codes surfaced as dispatch_goal_checker reasons
  'GOAL_PROOF_REQUIRED', 'GOAL_PROOF_UNMET', 'GOAL_PROOF_REJECTED', 'GOAL_PROOF_STALE', 'GOAL_PROOF_UNAVAILABLE',
  // checkBudget
  'ok', 'soft-stop-demote', 'turns-hard-stop', 'tokens-hard-stop', 'wallclock-hard-stop',
  'unmeasurable-usage-fail-closed',
  // breaker
  'consecutive-request-changes', 'tripped',
  // kernel pause reasons
  'project-root-relocated', 'host-session-lost', 'recovered:awaiting-resume', 'fail-closed',
  'child-timeout-awaiting', 'spawn-unconfirmed-awaiting', 'launch-failed',
  // headless / goal host failure reasons that become pause reasons
  'unmeasured-runtime', 'headless-unmeasurable', 'executable-invalid', 'checker-isolation-invalid',
  'checker-executable-invalid', 'checker-preflight-invalid', 'checker-preflight-usage-invalid',
  'checker-process-error', 'checker-termination-unconfirmed', 'checker-final-message-invalid',
  'preflight-invalid', 'preflight-usage-invalid', 'preflight-accounting-failed', 'terminal-accounting-failed',
  'receipt-mismatch', 'duplicate-receipt', 'receipt-cleanup-failed', 'settlement-invalid', 'usage-mismatch',
  'log-tampered', 'fenced', 'runtime-fenced', 'checker-skill-ambiguous', 'checker-skill-invalid',
  'checker-skill-unavailable',
]));
export const PUBLIC_REASON_PREFIXES = Object.freeze([
  'review-point-unsatisfied', 'independent-review', 'recovery', 'gate',
]);

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTION_TYPE = /^[a-z][a-z_]{0,39}$/;
const RESOLVER_REASON = /^[a-z][a-z0-9-]{0,63}$/;
const RUN_STATUSES = new Set(['running', 'paused', 'completed', 'stopped']);
const RESOLUTION_KINDS = new Set(['selected', 'none', 'ambiguous', 'invalid']);
const TERMINAL_WORKSTREAM = new Set(['ready', 'merged', 'abandoned']);

export function publicReason(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (PUBLIC_REASONS.has(value) || PUBLIC_REASON_PREFIXES.includes(value)) return value;
  const colon = value.indexOf(':');
  if (colon > 0) {
    const prefix = value.slice(0, colon);
    if (PUBLIC_REASON_PREFIXES.includes(prefix)) return prefix;
  }
  return 'other';
}

export function emptyResolution(kind, reason = null) {
  return { kind, source: null, reason, total: null, candidates: [] };
}

export function statusEnvelope({ ok, resolution, run }) {
  return { status_version: RUN_STATUS_VERSION, ok, resolution, run };
}

const finiteOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function projectResolution(result) {
  if (!result || typeof result !== 'object' || !RESOLUTION_KINDS.has(result.kind)) {
    return emptyResolution('invalid', 'resolver-invalid');
  }
  const candidates = Array.isArray(result.candidates)
    ? result.candidates.slice(0, 5)
      .filter(c => typeof c?.run_id === 'string' && RUN_ID.test(c.run_id) && typeof c.status === 'string')
      .map(c => ({ run_id: c.run_id, status: c.status }))
    : [];
  return {
    kind: result.kind,
    source: typeof result.source === 'string' && RESOLVER_REASON.test(result.source) ? result.source : null,
    reason: typeof result.reason === 'string'
      ? (RESOLVER_REASON.test(result.reason) ? result.reason : 'other') : null,
    total: Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : null,
    candidates,
  };
}

function budgetFields(loop, now) {
  const b = checkBudget(loop, { now });
  const state = !b.ok ? 'hard-stop' : (b.reason === 'soft-stop-demote' ? 'soft-stop' : 'ok');
  return {
    spent: finiteOrNull(loop.budget?.spent),
    total: finiteOrNull(loop.budget?.total),
    tokens_spent: finiteOrNull(loop.budget?.tokens_spent),
    tokens_total: finiteOrNull(loop.budget?.tokens_total),
    state,
    reason: publicReason(b.reason),
  };
}

function workstreamFields(loop) {
  const list = Array.isArray(loop.workstreams) ? loop.workstreams : [];
  const counts = {};
  let terminal = 0;
  for (const ws of list) {
    const status = typeof ws?.status === 'string' ? ws.status : 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    if (TERMINAL_WORKSTREAM.has(status)) terminal += 1;
  }
  const by_status = {};
  for (const key of Object.keys(counts).sort()) by_status[key] = counts[key];
  return { total: list.length, terminal, by_status };
}

function nextActionFields(loop, now, unattended) {
  const result = nextAction(loop, { now, unattended, skipGoalProof: true });
  const action = result?.action ?? {};
  const blocked = Array.isArray(result?.gate?.blocked_by) ? result.gate.blocked_by : [];
  return {
    type: typeof action.type === 'string' && ACTION_TYPE.test(action.type) ? action.type : null,
    reason: publicReason(action.reason),
    next_command: PUBLIC_NEXT_COMMANDS.includes(result?.next_command) ? result.next_command : null,
    blocked_by: blocked.filter(item => typeof item === 'string').map(item => publicReason(item)),
  };
}

function runFields(loop, runId, { now, unattended }) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('RUN_ID_INVALID');
  if (!RUN_STATUSES.has(loop?.status)) throw new Error('RUN_STATUS_INVALID');
  const debt = computeDebt(loop);
  const breaker = checkBreaker(loop);
  const episodes = Array.isArray(loop.episodes) ? loop.episodes : [];
  return {
    run_id: runId,
    status: loop.status,
    pause_reason: loop.status === 'paused' ? publicReason(loop.pause_reason) : null,
    budget: budgetFields(loop, now),
    comprehension: {
      debt_ratio: finiteOrNull(debt.debt_ratio),
      debt_threshold: finiteOrNull(loop.comprehension?.debt_threshold ?? 0.5),
      blocked: debt.blocked === true,
    },
    pending_human_reviews: episodes
      .filter(e => e?.role === 'maker' && e.status === 'done' && e.human_reviewed !== true).length,
    breaker: { tripped: breaker.tripped === true, reason: publicReason(breaker.reason) },
    workstreams: workstreamFields(loop),
    next_action: nextActionFields(loop, now, unattended),
  };
}

// `unattended` is a boolean, or a function of the loop (the CLI derives it from the loop and the process env).
export function buildRunStatus(result, { now, unattended = false } = {}) {
  try {
    const resolution = projectResolution(result);
    if (resolution.kind !== 'selected') {
      const ok = resolution.kind === 'none';
      return { envelope: statusEnvelope({ ok, resolution, run: null }), exitCode: ok ? 0 : 1 };
    }
    const loop = result.snapshot?.data;
    const flag = typeof unattended === 'function' ? unattended(loop) === true : unattended === true;
    const run = runFields(loop, result.runId, { now, unattended: flag });
    return { envelope: statusEnvelope({ ok: true, resolution, run }), exitCode: 0 };
  } catch {
    return {
      envelope: statusEnvelope({ ok: false, resolution: emptyResolution('invalid', 'status-compute-failed'), run: null }),
      exitCode: 1,
    };
  }
}
