export const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const keys = ['version', 'attempt_id', 'mode', 'stage', 'phase', 'handle', 'observation', 'task', 'required_stages', 'artifacts', 'started_at', 'returned_at'];
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const text = (value, bound = 4096) => typeof value === 'string' && value.trim().length > 0
  && Buffer.byteLength(value) <= bound && !value.includes('\0');
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const stages = value => Array.isArray(value) && (JSON.stringify(value) === '["primary"]'
  || JSON.stringify(value) === '["primary","continuation"]');

export function isAttemptObservation(value) {
  return exact(value, ['source', 'state', 'handle', 'reference'])
    && ['native-task', 'supervisor-receipt'].includes(value.source)
    && ['running', 'succeeded', 'failed', 'absent', 'unknown'].includes(value.state)
    && (value.handle === null || text(value.handle, 512)) && text(value.reference, 2048);
}

export function isExecutionRecord(value) {
  if (!exact(value, keys) || value.version !== 1 || typeof value.attempt_id !== 'string' || !ATTEMPT_ID.test(value.attempt_id)
    || !['inline', 'external'].includes(value.mode) || !['primary', 'continuation'].includes(value.stage)
    || !['prepared', 'running', 'returned', 'blocked'].includes(value.phase) || !text(value.task)
    || !stages(value.required_stages) || !value.required_stages.includes(value.stage)
    || !Array.isArray(value.artifacts) || value.artifacts.length > 256 || value.artifacts.some(path => !text(path, 2048))
    || new Set(value.artifacts).size !== value.artifacts.length
    || !(value.handle === null || text(value.handle, 512))
    || !(value.observation === null || isAttemptObservation(value.observation))
    || !(value.started_at === null || iso(value.started_at)) || !(value.returned_at === null || iso(value.returned_at))) return false;
  if (value.mode === 'inline' && (value.handle !== null || value.observation !== null || value.phase === 'prepared')) return false;
  if (value.phase === 'prepared' && (value.started_at !== null || value.returned_at !== null || value.handle !== null)) return false;
  if (['running', 'returned'].includes(value.phase)
    && (value.started_at === null || (value.mode === 'external' && value.handle === null))) return false;
  if ((value.phase === 'returned') !== (value.returned_at !== null)) return false;
  if (value.phase === 'returned' && value.mode === 'external'
    && (value.observation?.state !== 'succeeded' || value.observation.handle !== value.handle)) return false;
  if (value.phase === 'blocked' && !['unknown', 'failed'].includes(value.observation?.state)) return false;
  return true;
}

export function createExecutionRecord({ attemptId, mode, stage, task, requiredStages = ['primary'], now }) {
  const record = { version: 1, attempt_id: attemptId, mode, stage, phase: mode === 'inline' ? 'running' : 'prepared',
    handle: null, observation: null, task, required_stages: [...requiredStages], artifacts: [],
    started_at: mode === 'inline' ? new Date(now).toISOString() : null, returned_at: null };
  if (!isExecutionRecord(record)) throw new Error('EXECUTION_INPUT_INVALID: invalid attempt record');
  return record;
}

export function attemptIsQuiescent(execution) {
  return isExecutionRecord(execution) && (execution.phase === 'returned'
    || (execution.phase === 'blocked' && execution.observation?.state === 'failed'));
}

export function transitionAttempt(execution, operation, { handle, observation, artifacts = [], now } = {}) {
  if (!isExecutionRecord(execution)) throw new Error('EXECUTION_STATE_INVALID');
  const next = structuredClone(execution);
  if (operation === 'start') {
    if (next.mode !== 'external' || next.phase !== 'prepared' || !text(handle, 512)) throw new Error('EXECUTION_START_INVALID');
    next.phase = 'running'; next.handle = handle; next.observation = null; next.started_at = new Date(now).toISOString();
  } else if (operation === 'return') {
    if (next.phase !== 'running') throw new Error('EXECUTION_RETURN_INVALID: no running attempt');
    if (next.mode === 'external') {
      if (!isAttemptObservation(observation) || observation.state !== 'succeeded' || observation.handle !== next.handle) {
        throw new Error('EXECUTION_RETURN_UNOBSERVED');
      }
      next.observation = structuredClone(observation);
    } else if (observation != null) throw new Error('EXECUTION_RETURN_INVALID: inline work has no external observation');
    next.phase = 'returned'; next.artifacts = [...artifacts]; next.returned_at = new Date(now).toISOString();
  } else if (operation === 'reconcile') {
    if (next.mode !== 'external' || next.phase === 'returned' || !isAttemptObservation(observation)) throw new Error('EXECUTION_RECONCILE_INVALID');
    if (next.handle !== null && observation.handle !== next.handle) throw new Error('EXECUTION_HANDLE_MISMATCH');
    if (['running', 'succeeded', 'failed'].includes(observation.state) && !text(observation.handle, 512)) throw new Error('EXECUTION_HANDLE_REQUIRED');
    next.observation = structuredClone(observation);
    if (observation.state === 'absent') {
      next.phase = 'prepared'; next.handle = null; next.started_at = null;
    } else if (observation.state === 'unknown' || observation.state === 'failed') {
      next.phase = 'blocked';
    } else {
      next.phase = 'running'; next.handle = observation.handle; next.started_at ??= new Date(now).toISOString();
    }
  } else throw new Error('EXECUTION_OPERATION_INVALID');
  if (!isExecutionRecord(next)) throw new Error('EXECUTION_TRANSITION_INVALID');
  return next;
}
