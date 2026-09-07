import { contentHash } from './envelope.mjs';
const WORKSTREAM_TERMINAL = new Set(['ready', 'merged', 'abandoned']);

function authenticLegacy(loop, scope) {
  return scope?.kind === 'legacy'
    && loop?.autonomy?.continuation_policy !== 'workstream-session';
}

export function ownerSession(loop) {
  const owner = loop?.session_chain?.lease?.owner_run_id;
  const session = Array.isArray(loop?.session_chain?.sessions)
    ? loop.session_chain.sessions.find(item => item?.run_id === owner)
    : null;
  if (!session) throw new Error(`SESSION_SCOPE_MISMATCH: lease owner session not found: ${String(owner)}`);
  return session;
}

export function currentWorkstreamScope(loop) {
  const scope = ownerSession(loop).scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || !['workstream', 'legacy'].includes(scope.kind)) {
    throw new Error('SESSION_SCOPE_MISMATCH: lease owner scope is invalid');
  }
  return scope;
}

export function isOpenScope(scope) {
  return scope?.kind === 'workstream'
    && scope.terminal_event === null
    && scope.superseded_at === null;
}

export function reservedOpenScope(loop) {
  const owner = loop?.session_chain?.lease?.owner_run_id;
  const scopes = (Array.isArray(loop?.session_chain?.sessions) ? loop.session_chain.sessions : [])
    .filter(session => session?.run_id !== owner && isOpenScope(session?.scope))
    .map(session => session.scope);
  if (scopes.length > 1) throw new Error('SESSION_SCOPE_MISMATCH: multiple reserved open scopes');
  return scopes[0] ?? null;
}

export function openScopeSessions(loop) {
  return (Array.isArray(loop?.session_chain?.sessions) ? loop.session_chain.sessions : [])
    .filter(session => isOpenScope(session?.scope));
}

export function assertScopeAllows(loop, workstreamId, { allowUnbound = false, allowCrossWorkstream = false } = {}) {
  if (typeof workstreamId !== 'string' || workstreamId.length === 0) {
    throw new Error('WORKSTREAM_REQUIRED: a non-null Workstream is required');
  }
  const scope = currentWorkstreamScope(loop);
  if (authenticLegacy(loop, scope)) return scope;
  if (!isOpenScope(scope)) {
    throw new Error(`SESSION_SCOPE_MISMATCH: owner scope is closed for ${workstreamId}`);
  }
  if (scope.workstream_id === null && allowUnbound) return scope;
  // allowCrossWorkstream exempts the identity comparison ONLY. The scope-shape validation above and the
  // closed-scope rejection stay in force, so this can never authorize work under a closed owner scope.
  if (allowCrossWorkstream) return scope;
  if (scope.workstream_id !== workstreamId) {
    throw new Error(`SESSION_SCOPE_MISMATCH: ${workstreamId}`);
  }
  return scope;
}

export function bindMakerScope(loop, episode, eventSeq) {
  const scope = currentWorkstreamScope(loop);
  if (authenticLegacy(loop, scope)) return scope;
  if (episode?.role !== 'maker') {
    throw new Error(`SESSION_SCOPE_MISMATCH: checker cannot bind owner scope: ${String(episode?.id)}`);
  }
  const workstreamId = episode.workstream_id;
  if (typeof workstreamId !== 'string' || workstreamId.length === 0) {
    throw new Error(`WORKSTREAM_REQUIRED: ${String(episode?.id)}`);
  }
  const workstream = (loop.workstreams || []).find(item => item.id === workstreamId);
  if (!workstream) throw new Error(`WORKSTREAM_NOT_FOUND: ${workstreamId}`);
  if (WORKSTREAM_TERMINAL.has(workstream.status)) {
    throw new Error(`WORKSTREAM_TERMINAL_LOCKED: ${workstreamId} is ${workstream.status}`);
  }
  assertScopeAllows(loop, workstreamId, { allowUnbound: true });
  if (scope.workstream_id === null) {
    if (!Number.isSafeInteger(eventSeq) || eventSeq < 1) {
      throw new Error('STATE_INVALID: maker scope bind event seq');
    }
    scope.workstream_id = workstreamId;
    scope.bound_at_seq = eventSeq;
  }
  return scope;
}

export function closeScope(loop, workstreamId, terminalEvent, now) {
  const scope = assertScopeAllows(loop, workstreamId);
  if (authenticLegacy(loop, scope)) return scope;
  if (!terminalEvent || typeof terminalEvent !== 'object' || Array.isArray(terminalEvent)
    || !Number.isSafeInteger(terminalEvent.seq) || terminalEvent.seq < 1
    || !/^[0-9a-f]{64}$/.test(terminalEvent.checksum || '')) {
    throw new Error('STATE_INVALID: terminal event identity');
  }
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('INVALID_NOW: scope close');
  const closedAt = timestamp.toISOString();
  scope.terminal_event = terminalEvent;
  scope.closed_at = closedAt;
  return scope;
}

export function supersedeScope(scope, {
  reason,
  supersededBy,
  now,
} = {}) {
  if (!isOpenScope(scope)) {
    throw new Error('SESSION_SCOPE_MISMATCH: only an open Workstream scope can be superseded');
  }
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 1_024
    || reason.includes('\0')) {
    throw new Error('RECOVERY_REASON_INVALID');
  }
  if (typeof supersededBy !== 'string' || supersededBy.length === 0) {
    throw new Error('RECOVERY_CHILD_INVALID');
  }
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('INVALID_NOW: scope supersession');
  scope.superseded_at = timestamp.toISOString();
  scope.supersede_reason = reason;
  scope.superseded_by = supersededBy;
  return scope;
}

// History carries identities and evidence only; current scope remains the sole authority.
export const SCOPE_HISTORY_LIMIT = 256;
export function goalScopeEpoch(loop) {
  return loop?.schema_version === '0.5.0' ? ownerSession(loop).scope_epoch : null;
}
function canonicalScopeValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalScopeValue);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalScopeValue(value[key])]));
}
export function scopeToken(loop) {
  const lease = loop.session_chain.lease;
  return contentHash(JSON.stringify(['deep-loop-scope-v1', lease.owner_run_id, lease.generation,
    goalScopeEpoch(loop), canonicalScopeValue(currentWorkstreamScope(loop))]));
}
export function inheritGoalScopeState(sourceSession, { turns = 0 } = {}) {
  if (!Object.hasOwn(sourceSession || {}, 'scope_epoch')) return {};
  return { scope_epoch: sourceSession.scope_epoch,
    scope_history: structuredClone(sourceSession.scope_history), scope_turn_baseline: turns };
}
export function validateScopeHistory(loop, session, errors) {
  const rows = session?.scope_history;
  const fail = () => errors.push('v0.5 scope_history is invalid');
  if (!Array.isArray(rows) || rows.length > SCOPE_HISTORY_LIMIT) { fail(); return; }
  const seen = new Set();
  const workstreams = Array.isArray(loop.workstreams) ? loop.workstreams : [];
  const episodes = Array.isArray(loop.episodes) ? loop.episodes : [];
  const sessions = Array.isArray(loop.session_chain?.sessions) ? loop.session_chain.sessions : [];
  const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
  const text = v => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !v.includes('\0');
  const identity = v => exact(v,['seq','checksum']) && Number.isSafeInteger(v.seq) && v.seq > 0 && /^[a-f0-9]{64}$/.test(v.checksum);
  for (const row of rows) {
    const s = row?.scope, ws = workstreams.find(w => w?.id === s?.workstream_id);
    if (!exact(row,['scope','owner_run_id','generation','scope_epoch','reason','parked_episode_id','parked_cursor_ref'])
      || !exact(s,['kind','workstream_id','bound_at_seq','terminal_event','closed_at','superseded_at'])
      || s.kind !== 'workstream' || !ws || seen.has(ws.id) || s.superseded_at !== null
      || !Number.isSafeInteger(s.bound_at_seq) || s.bound_at_seq < 1
      || !(s.terminal_event === null ? s.closed_at === null : identity(s.terminal_event)
        && typeof s.closed_at === 'string' && Number.isFinite(Date.parse(s.closed_at))
        && new Date(s.closed_at).toISOString() === s.closed_at)
      || !text(row.owner_run_id) || !sessions.some(x => x?.run_id === row.owner_run_id)
      || !Number.isSafeInteger(row.generation) || row.generation < 1
      || !Number.isSafeInteger(row.scope_epoch) || row.scope_epoch < 0 || row.scope_epoch >= session.scope_epoch
      || !text(row.reason)
      || !(row.parked_episode_id === null || episodes.some(e => e?.id === row.parked_episode_id && e.workstream_id === s.workstream_id))
      || !(row.parked_cursor_ref === null || /^checkpoints\/[a-f0-9]{64}-compact\.json$/.test(row.parked_cursor_ref))) { fail(); continue; }
    seen.add(ws.id);
    if (s.terminal_event !== null && !(ws.terminal_events || []).some(event => JSON.stringify(event) === JSON.stringify(s.terminal_event))) fail();
  }
  if (session.run_id === loop.session_chain.lease.owner_run_id && seen.has(session.scope?.workstream_id)) fail();
}
