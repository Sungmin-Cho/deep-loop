// Pure logic of the Claude Code status band (issue #75). Imported by both the
// Mods runtime and Node tests: no `node:*`, no `claude-code`, no DOM.

export const REFRESH_DEBOUNCE_MS = 1500;
export const FALLBACK_INTERVAL_MS = 60000;
export const SLOW_EVERY_TICKS = 5;
export const RUN_TIMEOUT_MS = 5000;

const STATUS_COMMAND = '/deep-loop-status';
const ACK_COMMAND = '/deep-loop-ack';
const TERMINAL = new Set(['completed', 'stopped']);
const KINDS = new Set(['selected', 'none', 'ambiguous', 'invalid']);

export function statusArgv(pluginRoot, cwd, runId) {
  const root = String(pluginRoot).replace(/[\\/]$/, '');
  return ['node', `${root}/scripts/deep-loop.mjs`, 'run', 'status', '--json', '--cwd', cwd,
    ...(runId ? ['--run-id', runId] : [])];
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (v) => v === null || isNum(v);
const isStrOrNull = (v) => v === null || isStr(v);

function validResolution(r) {
  return isObj(r) && isStr(r.kind) && KINDS.has(r.kind) && isStrOrNull(r.source) && isStrOrNull(r.reason)
    && isNumOrNull(r.total) && Array.isArray(r.candidates);
}

function validRun(r) {
  if (!isObj(r) || !isStr(r.run_id) || !isStr(r.status) || !isStrOrNull(r.pause_reason)) return false;
  const b = r.budget;
  if (!isObj(b) || !isNumOrNull(b.spent) || !isNumOrNull(b.total) || !isNumOrNull(b.tokens_spent)
    || !isNumOrNull(b.tokens_total) || !isStr(b.state) || !isStrOrNull(b.reason)) return false;
  const c = r.comprehension;
  if (!isObj(c) || !isNumOrNull(c.debt_ratio) || !isNumOrNull(c.debt_threshold) || typeof c.blocked !== 'boolean') return false;
  if (!isNum(r.pending_human_reviews)) return false;
  const k = r.breaker;
  if (!isObj(k) || typeof k.tripped !== 'boolean' || !isStrOrNull(k.reason)) return false;
  const w = r.workstreams;
  if (!isObj(w) || !isNum(w.total) || !isNum(w.terminal) || !isObj(w.by_status)) return false;
  const n = r.next_action;
  return isObj(n) && isStrOrNull(n.type) && isStrOrNull(n.reason) && isStrOrNull(n.next_command) && Array.isArray(n.blocked_by);
}

const FAILURE = Object.freeze({ kind: 'failure' });

export function parseStatus(outcome) {
  try {
    if (!isObj(outcome) || outcome.error !== undefined) return FAILURE;
    const { exitCode, stdout } = outcome;
    if (exitCode !== 0 && exitCode !== 1) return FAILURE;
    if (!isStr(stdout)) return FAILURE;
    const env = JSON.parse(stdout);
    if (!isObj(env) || env.status_version !== 1 || typeof env.ok !== 'boolean') return FAILURE;
    if ((exitCode === 0) !== env.ok) return FAILURE;
    if (!validResolution(env.resolution)) return FAILURE;
    if (env.run !== null && !validRun(env.run)) return FAILURE;
    if ((env.resolution.kind === 'selected') !== (env.run !== null)) return FAILURE;
    // exit 0 = selected|none, exit 1 = ambiguous|invalid (design 4.1.2).
    if (env.ok !== (env.resolution.kind === 'selected' || env.resolution.kind === 'none')) return FAILURE;
    return { kind: 'envelope', envelope: env };
  } catch {
    return FAILURE;
  }
}

const runOf = (parsed) => (parsed?.kind === 'envelope' ? parsed.envelope.run : null);
const resOf = (parsed) => (parsed?.kind === 'envelope' ? parsed.envelope.resolution : null);

export function outcomeKind(parsed) {
  if (parsed?.kind !== 'envelope') return 'failure';
  const kind = parsed.envelope.resolution.kind;
  if (kind !== 'selected') return kind;
  const status = parsed.envelope.run.status;
  if (TERMINAL.has(status)) return 'terminal';
  return status === 'paused' ? 'paused' : 'running';
}

export function pollPolicy(cadence, kind) {
  switch (kind) {
    case 'running': return 'fast';
    case 'paused':
    case 'ambiguous': return 'slow';
    case 'none':
    case 'terminal': return 'off';
    default: return cadence === 'off' ? 'slow' : cadence; // invalid, failure
  }
}

export function shouldPoll(cadence, tick) {
  if (cadence === 'fast') return true;
  if (cadence === 'slow') return tick % SLOW_EVERY_TICKS === 0;
  return false;
}

export function nextBandState(prev, parsed) {
  const kind = outcomeKind(parsed);
  const resKind = resOf(parsed)?.kind;
  const showsBand = resKind === 'selected' || resKind === 'ambiguous';
  return {
    display: showsBand ? parsed : null,
    selected: resKind === 'selected' ? parsed : (prev?.selected ?? null),
    cadence: pollPolicy(prev?.cadence ?? 'slow', kind),
    tick: prev?.tick ?? 0,
  };
}

export function needsCompletionProbe(prevSelected, parsed) {
  const prevRun = runOf(prevSelected);
  if (!prevRun || TERMINAL.has(prevRun.status)) return null;
  const kind = resOf(parsed)?.kind;
  if (kind === undefined || kind === 'invalid') return null; // failure or invalid primary
  if (kind === 'selected' && parsed.envelope.run.run_id === prevRun.run_id) return null;
  return prevRun.run_id;
}

export function applyCompletionProbe(nextState, { prevSelected, probeRunId }, probeParsed) {
  const ok = resOf(probeParsed)?.kind === 'selected' && probeParsed.envelope.run.run_id === probeRunId;
  if (ok) {
    // A nonterminal run keeps being observed; a terminal probe lets the primary cadence stand.
    const live = !TERMINAL.has(probeParsed.envelope.run.status);
    return { ...nextState, selected: probeParsed, cadence: live && nextState.cadence === 'off' ? 'slow' : nextState.cadence };
  }
  return { ...nextState, selected: prevSelected ?? null, cadence: nextState.cadence === 'off' ? 'slow' : nextState.cadence };
}

export function transitions(prevSelected, nextSelected) {
  const a = runOf(prevSelected);
  const b = runOf(nextSelected);
  if (!a || !b || a.run_id !== b.run_id) return [];
  const out = [];
  if (!a.breaker.tripped && b.breaker.tripped) {
    out.push(`deep-loop: breaker tripped${b.breaker.reason ? ` (${b.breaker.reason})` : ''}`);
  }
  if (!a.comprehension.blocked && b.comprehension.blocked) {
    out.push('deep-loop: comprehension debt is blocking new work — /deep-loop-ack');
  }
  if (a.budget.state === 'ok' && (b.budget.state === 'soft-stop' || b.budget.state === 'hard-stop')) {
    out.push(`deep-loop: budget ${b.budget.state}`);
  }
  if (!TERMINAL.has(a.status) && TERMINAL.has(b.status)) {
    out.push(`deep-loop: run ${b.run_id.slice(-4)} ${b.status}`);
  }
  return out;
}

const num = (v) => (isNum(v) ? String(v) : '?');
const statusButton = Object.freeze({ key: 'status', label: 'Status', command: STATUS_COMMAND });
const hideButton = Object.freeze({ key: 'hide', label: 'Hide' });

export function bandModel(display, { hidden, hasSurvey, active } = {}) {
  if (!active || hasSurvey || hidden || display?.kind !== 'envelope') return null;
  const { resolution, run } = display.envelope;
  if (resolution.kind === 'ambiguous') {
    if (resolution.reason === 'multi-active-root-cwd') {
      return { line: `deep-loop · ${num(resolution.total)} active runs · ${STATUS_COMMAND}`, buttons: [{ ...statusButton }, { ...hideButton }] };
    }
    if (resolution.reason === 'duplicate-worktree-claim') {
      return { line: `deep-loop · worktree claimed by ${num(resolution.total)} runs · ${STATUS_COMMAND}`, buttons: [{ ...statusButton }, { ...hideButton }] };
    }
    return null;
  }
  if (run === null || TERMINAL.has(run.status)) return null;
  const parts = [`loop ${run.run_id.slice(-4)}`];
  const reason = run.pause_reason && run.pause_reason !== 'other' ? ` (${run.pause_reason})` : '';
  parts.push(`${run.status}${reason}`);
  if (run.breaker.tripped) parts.push(`breaker: ${run.breaker.reason ?? 'tripped'}`);
  const stop = run.budget.state === 'soft-stop' || run.budget.state === 'hard-stop' ? ` ${run.budget.state}` : '';
  parts.push(`budget ${num(run.budget.spent)}/${num(run.budget.total)} turns${stop}`);
  const ratio = isNum(run.comprehension.debt_ratio) ? run.comprehension.debt_ratio.toFixed(2) : '?';
  parts.push(`debt ${ratio}/${num(run.comprehension.debt_threshold)}`);
  parts.push(`review ${run.pending_human_reviews} pending`);
  parts.push(`ws ${run.workstreams.terminal}/${run.workstreams.total}`);
  if (run.next_action.type) parts.push(`next: ${run.next_action.type}`);
  const buttons = [{ ...statusButton }];
  if (run.pending_human_reviews > 0) buttons.push({ key: 'ack', label: 'Ack', command: ACK_COMMAND });
  buttons.push({ ...hideButton });
  return { line: parts.join(' · '), buttons };
}

export function isDeepLoopCommand(command) {
  return typeof command === 'string' && command.includes('deep-loop.mjs');
}

export function fillPlan(draftText) {
  return typeof draftText === 'string' && draftText.trim() === '' ? 'fill' : 'busy';
}

export const busyToast = (command) => `Clear the prompt to insert ${command}`;

// `no_composer` returns null: the caller then tries to copy (see copyOutcomeToast).
export function fillOutcomeToast(command, filled, refusal) {
  if (filled) return null;
  if (refusal === 'no_composer') return null;
  if (refusal === 'dialog') return 'Close the dialog, then press again';
  return `Type ${command} in the prompt`;
}

export function copyOutcomeToast(command, copied) {
  return copied === true ? `Copied ${command}` : `Type ${command} in the prompt`;
}
