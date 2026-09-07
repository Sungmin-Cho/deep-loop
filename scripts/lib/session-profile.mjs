import { appendAnchored } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';
import { withReconciledMutationLock } from './state.mjs';
import { runtimeCapability, sessionRuntime, validateSessionRuntime } from './runtime.mjs';

// Session model/effort continuity (WS1). Validation is the write-boundary defense (init-run + this setter);
// buildLaunchCommand later threads already-validated strings into child --model/--effort argv.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Anchored first char rejects a leading '-' so a "model" can never be parsed as a CLI option
// (e.g. `--model -p`). Fixed-length anchored pattern → no ReDoS. Brackets allow ids like `claude-opus-4-8[1m]`.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,127}$/;

export function validateEffort(effort, { allowGoalNative = false } = {}) {
  if (!EFFORT_LEVELS.includes(effort) && !(allowGoalNative && effort === 'ultra')) throw Object.assign(new Error(`INVALID_EFFORT: ${effort}`), { code: 'INVALID_EFFORT' });
  return effort;
}
export function validateModel(model) {
  if (typeof model !== 'string' || !MODEL_RE.test(model)) throw Object.assign(new Error(`INVALID_MODEL: ${model}`), { code: 'INVALID_MODEL' });
  return model;
}

export function validateRuntimeProfile(runtime, { model = null, effort = null } = {}, { goalDriven = false } = {}) {
  const selectedRuntime = validateSessionRuntime(runtime);
  if (model != null) validateModel(model);
  if (effort != null) validateEffort(effort, { allowGoalNative: goalDriven });
  const passthrough = goalDriven && runtimeCapability(selectedRuntime, 'goal_effort_passthrough').includes(effort);
  if (effort != null && runtimeCapability(selectedRuntime, 'session_effort_allowed') === 'none') {
    throw Object.assign(new Error(`UNSUPPORTED_RUNTIME_EFFORT: ${selectedRuntime} ${effort}`), { code: 'UNSUPPORTED_RUNTIME_EFFORT' });
  }
  if (effort === 'ultra' && !passthrough) throw Object.assign(new Error(`UNSUPPORTED_RUNTIME_EFFORT: ${selectedRuntime} ultra`), { code: 'UNSUPPORTED_RUNTIME_EFFORT' });
  if (effort === 'max' && !runtimeCapability(selectedRuntime, 'max_effort_supported') && !passthrough) {
    throw Object.assign(new Error(`UNSUPPORTED_RUNTIME_EFFORT: ${selectedRuntime} max`), { code: 'UNSUPPORTED_RUNTIME_EFFORT' });
  }
  return { model, effort };
}

// Refresh the durable session profile. Fenced with intent:'lease' so it works while a handoff is in-flight
// (lease.state==='releasing') — the exact PreCompact-emitted state self-heal must survive — while still
// rejecting released/paused (leaseCheck). Single appendAnchored (event + state) on the write path. Idempotent
// no-op when the provided fields already match (avoids per-tick event spam). Partial update: only provided
// fields are validated/compared/written.
//
// The no-op decision + fence are done IN-LOCK (fresh read) so a stale caller gets LEASE_FENCED (exit 3) even
// when its values happen to match — never a silent exit-0 no-op. The run lock is non-reentrant (CLAUDE.md inv #7),
// so we only DECIDE inside the lock and, if a write is needed, appendAnchored AFTER releasing it; appendAnchored's
// own in-lock preCheck re-fences the write, so a concurrent lease change between the two locks can never cause
// an unfenced write — the worst case is one harmless redundant event.
// Resume/retry/fix consume a frozen episode.routing when present. This never
// locates or invokes the router — in_progress/done episodes keep their seat.
export function resolveLaunchProfile(loop, { episodeId, locate } = {}) {
  void locate;
  const episodes = Array.isArray(loop?.episodes) ? loop.episodes : [];
  const wantedId = episodeId || loop?.current_episode || null;
  const selected = wantedId
    ? episodes.find(episode => episode.id === wantedId) || null
    : null;
  const routing = selected?.routing;
  if (routing && typeof routing.selected_model === 'string' && typeof routing.selected_effort_native === 'string') {
    return {
      model: routing.selected_model,
      effort: routing.selected_effort_native,
      source: 'episode.routing',
      provenance: routing.provenance || 'router',
    };
  }
  return {
    model: loop?.autonomy?.session_model ?? null,
    effort: loop?.autonomy?.session_effort ?? null,
    source: 'session_profile',
    provenance: 'local-fallback',
  };
}

export function setSessionProfile(root, runId, { model, effort, expect, now = Date.now(), allowEmpty = false } = {}) {
  if (!expect || typeof expect.owner !== 'string' || !Number.isInteger(expect.generation)) throw new Error('FENCE_REQUIRED: setSessionProfile');
  const empty = model == null && effort == null;
  if (empty && !allowEmpty) throw new Error('NOTHING_TO_SET: setSessionProfile');
  if (model != null) validateModel(model);
  if (effort != null) validateEffort(effort, { allowGoalNative: true });

  let needsWrite = false;
  withReconciledMutationLock(root, runId, (_guard, { data }) => {
    const lc = leaseCheck(data, { owner: expect.owner, generation: expect.generation, intent: 'lease' });
    if (!lc.ok) throw new Error('LEASE_FENCED: ' + lc.reason);   // in-lock authoritative fence (even for no-op)
    if (empty) return;
    validateRuntimeProfile(sessionRuntime(data), {
      model: model ?? data.autonomy?.session_model ?? null,
      effort: effort ?? data.autonomy?.session_effort ?? null,
    }, { goalDriven: data.schema_version === '0.5.0' });
    const sameModel = model == null || data.autonomy?.session_model === model;
    const sameEffort = effort == null || data.autonomy?.session_effort === effort;
    needsWrite = !(sameModel && sameEffort);
  });
  if (!needsWrite) return { ok: true, changed: false };

  // Event data records ONLY the fields actually being set (a partial update must not log an omitted
  // field as null — replay/audit consumers would misread that as a clear).
  appendAnchored(root, runId, { type: 'session-profile-set', data: { ...(model != null ? { model } : {}), ...(effort != null ? { effort } : {}) } },
    (l) => {
      // Session-level model/effort only. Frozen episodes[].routing is immutable here.
      if (model != null) l.autonomy.session_model = model;
      if (effort != null) l.autonomy.session_effort = effort;
    },
    (l) => {
      const lc = leaseCheck(l, { owner: expect.owner, generation: expect.generation, intent: 'lease' });
      if (!lc.ok) throw new Error('LEASE_FENCED: ' + lc.reason);
      validateRuntimeProfile(sessionRuntime(l), {
        model: model ?? l.autonomy?.session_model ?? null,
        effort: effort ?? l.autonomy?.session_effort ?? null,
      }, { goalDriven: l.schema_version === '0.5.0' });
    });
  return { ok: true, changed: true };
}
