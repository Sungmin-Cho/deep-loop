import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runIdSlug } from './slug.mjs';
import { matchRecipe } from './recipes.mjs';
import { writeState, runDir } from './state.mjs';
import { ulid } from './envelope.mjs';
import { detectTerminal, defaultProbeRun } from './detect-terminal.mjs';
import { pluginPresent } from './detect.mjs';
import { validateRuntimeProfile } from './session-profile.mjs';
import { assertRuntimePlatform, validateSessionRuntime } from './runtime.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import { normalizeGoalContract, normalizeGoalPolicy } from './goal-contract.mjs';

export function buildInitialLoop({ runtime, goal, protocol, recipe, detected = {}, review, now = new Date(), runId, git = {}, env = process.env, platform = process.platform, run = defaultProbeRun, pid = process.pid, model = null, effort = null, continuationPolicy = null, goalContract, supervision, boundaryMode }) {
  validateSessionRuntime(runtime);
  assertRuntimePlatform(runtime, platform);
  validateRuntimeProfile(runtime, { model, effort }, { goalDriven: goalContract !== undefined });
  if (review?.reviewer === 'standalone') throw new Error('REVIEWER_STANDALONE_INVALID: standalone reviewer is supported only for legacy-state resolution');
  if (continuationPolicy != null && continuationPolicy !== 'workstream-session') {
    throw new Error(`UNSUPPORTED_RUNTIME_POLICY: new runs require workstream-session, got ${continuationPolicy}`);
  }
  const iso = now.toISOString();
  const scope = { kind: 'workstream', workstream_id: null, bound_at_seq: null, terminal_event: null, closed_at: null, superseded_at: null };
  const goalDriven = goalContract !== undefined;
  if (!goalDriven && (supervision !== undefined || boundaryMode !== undefined)) throw new Error('GOAL_CONTRACT_REQUIRED: new policies require a goal contract');
  const normalizedContract = goalDriven ? normalizeGoalContract(goalContract, goal) : null;
  const orchestration = goalDriven ? normalizeGoalPolicy({ supervision, boundaryMode, review }) : null;
  const reviewConfig = review || { points: goalDriven ? ['implementation'] : ['design', 'plan', 'implementation'], reviewer: pluginPresent(detected, 'deep-review') ? 'deep-review-loop' : 'subagent-checker', mode: 'cross-model', flags: ['--contract', '--codex'], converge: true, max_review_rounds: 5, require_human_ack: goalDriven ? orchestration.supervision === 'human' : true };
  return {
    schema_version: goalDriven ? '0.5.0' : '0.4.0', run_id: runId, goal, status: 'running',
    ...(goalDriven ? { orchestration, goal_contract: normalizedContract, goal_obligations: [], goal_reviews: [] } : {}),
    created_at: iso, updated_at: iso,
    project: { root: '', binding_generation: 1, git: !!git.head, branch: git.branch || null, head: git.head || null, dirty: !!git.dirty },
    routing: { protocol, selected_by: 'auto' },
    recipe,
    plugins_detected: detected,
    loop_principles: { heartbeat: 'manual-v1', state_is_source_of_truth: true, maker_checker_split: true, human_review_required: goalDriven ? orchestration.supervision === 'human' : true, worktree_isolation_policy: 'recommend' },
    review: reviewConfig,
    autonomy: { driver: 'continue', tier: 'recommend', auto_handoff: true, spawn_style: 'interactive', max_unreviewed_episodes: 3, max_parallel: 2, max_sessions: 8, continuation_policy: 'workstream-session', attended_launch_approval: null, milestone_predicate: ['bound_workstream_first_terminal'], recipe_override_auth: 'user-only', unattended_detect: ['driver:cron|loop', '--unattended', 'headless-invocation'], child_ready_timeout_sec: 75, session_runtime: runtime, runtime_source: 'skill-asserted', runtime_executable_approval: null, launcher_executable_approvals: { wt: null, powershell: null, tmux: null }, ...(model != null ? { session_model: model } : {}), ...(effort != null ? { session_effort: effort } : {}) },
    budget: { unit: 'turns', total: 200, spent: 0, tokens_total: 4000000, tokens_spent: 0, per_session_turn_cap: 40, max_wallclock_sec: 86400, soft_stop_ratio: 0.8, hard_stop_ratio: 1.0, enforcement: 'best-effort-interactive', unattended_requires_headless: true, on_unmeasurable_usage: 'fail-closed', on_exhaust: 'pause-and-handoff' },
    comprehension: { episodes_total: 0, episodes_human_reviewed: 0, episodes_agent_reviewed: 0, unreviewed_diff_lines: 0, debt_ratio: 0, debt_threshold: 0.5 },
    circuit_breaker: { consecutive_request_changes: 0, tripped: false, trip_reason: null },
    event_log_head: { seq: 0, checksum: 'GENESIS' },
    session_chain: { parent_run_id: null, lease: { owner_run_id: runId, generation: 1, acquired_at: iso, expires_at: null, state: 'active', handoff_idempotency_key: null, handoff_phase: 'idle', handoff_trigger: null, takeover_kind: null }, stale_lease_ttl_sec: 900, consumed_milestones: [], sessions: [{ run_id: runId, started_at: iso, ended_at: null, turns: 0, outcome: null, superseded_by: null, scope, ...(goalDriven ? { scope_epoch: 0, scope_history: [], scope_turn_baseline: 0 } : {}) }] },
    session_spawn: detectTerminal({ env, platform, run, now: iso, pid }),
    workspace_policy: 'recommend',
    workstreams: [], active_workstreams: [],
    discovered_items: [], triage: { actionable: [], needs_human: [], blocked: [], archived: [] },
    episodes: [], current_episode: null,
    connectors: { enabled: [], pre_authorized: [] },
    termination: { max_episodes_policy: 'derived', max_episodes: 24, proofs: ['implementation artifacts exist', 'independent review verdict approve or accepted concern', 'final report exists', 'human verification checklist written'] },
  };
}

export function initRun(root, { runtime, goal, protocol, recipe, review, detected = {}, now = new Date(), git = {}, env = process.env, platform = process.platform, run = defaultProbeRun, pid = process.pid, model = null, effort = null, continuation = null, goalContract, supervision, boundaryMode }) {
  validateSessionRuntime(runtime);
  assertRuntimePlatform(runtime, platform);
  validateRuntimeProfile(runtime, { model, effort }, { goalDriven: goalContract !== undefined });
  if (continuation != null && continuation !== 'workstream-session') {
    throw new Error(`UNSUPPORTED_RUNTIME_POLICY: new runs require workstream-session, got ${continuation}`);
  }
  const canonicalRoot = canonicalProjectRoot(root);
  const runId = ulid(now.getTime());
  const m = matchRecipe(goal, detected);
  const proto = protocol || m.protocol;
  const rec = recipe ? { id: recipe, name: recipe, reason: 'user' } : { id: m.recipe, name: m.recipe, reason: m.reason };
  const loop = buildInitialLoop({ runtime, goal, protocol: proto, recipe: rec, detected, review, now, runId, git, env, platform, run, pid, model, effort, continuationPolicy: continuation, goalContract, supervision, boundaryMode });
  loop.project.root = canonicalRoot;
  mkdirSync(runDir(canonicalRoot, runId), { recursive: true });
  writeState(canonicalRoot, runId, loop);
  mkdirSync(join(canonicalRoot, '.deep-loop'), { recursive: true });
  writeFileSync(join(canonicalRoot, '.deep-loop', 'current'), runId + '\n');
  return { runId, loop };
}
