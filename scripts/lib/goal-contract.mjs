import { createHash } from 'node:crypto';
import { isExecutionRecord } from './attempt-state.mjs';
import { validateScopeHistory } from './session-scope.mjs';

export const GOAL_LIMITS = Object.freeze({ requirements: 64, text: 4096, goal: 65536, workstreams: 256, reviewRounds: 16 });
export const GOAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function exactGoalObject(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}

export function boundedGoalText(value, max = GOAL_LIMITS.text) {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= max && !value.includes('\0');
}

export function normalizeGoalContract(input, goal) {
  const fail = detail => { throw new Error(`GOAL_CONTRACT_INVALID: ${detail}`); };
  if (!exactGoalObject(input, ['version', 'requirements', 'non_goals']) || input.version !== 1) fail('exact version 1 input required');
  if (!boundedGoalText(goal, GOAL_LIMITS.goal)) fail('original goal must be bounded nonempty text');
  if (!Array.isArray(input.requirements) || input.requirements.length < 1
    || input.requirements.length > GOAL_LIMITS.requirements) fail('requirements must contain 1..64 entries');
  const ids = new Set();
  const requirements = input.requirements.map(item => {
    if (!exactGoalObject(item, ['id', 'statement', 'acceptance']) || typeof item.id !== 'string' || !GOAL_ID.test(item.id)
      || !boundedGoalText(item.statement) || !boundedGoalText(item.acceptance)) fail('invalid requirement');
    if (ids.has(item.id)) fail(`duplicate requirement: ${item.id}`);
    ids.add(item.id);
    return { id: item.id, statement: item.statement, acceptance: item.acceptance };
  });
  if (!Array.isArray(input.non_goals) || input.non_goals.length > GOAL_LIMITS.requirements
    || input.non_goals.some(item => !boundedGoalText(item))) fail('invalid non_goals');
  const normalized = { version: 1, requirements, non_goals: [...input.non_goals] };
  const sha256 = createHash('sha256').update(JSON.stringify({ goal, contract: normalized })).digest('hex');
  return { ...normalized, sha256 };
}

export function isGoalDriven(loop) {
  const policy = loop?.orchestration;
  return loop?.schema_version === '0.5.0'
    && exactGoalObject(policy, ['version', 'supervision', 'boundary_mode'])
    && policy.version === 1 && ['delegated', 'human'].includes(policy.supervision)
    && ['continue', 'handoff'].includes(policy.boundary_mode);
}

export function normalizeGoalPolicy({ supervision = 'delegated', boundaryMode = 'continue', review } = {}) {
  if (!['delegated', 'human'].includes(supervision) || !['continue', 'handoff'].includes(boundaryMode)) {
    throw new Error('GOAL_POLICY_INVALID: supervision or boundary mode');
  }
  if (review !== undefined && review?.require_human_ack !== (supervision === 'human')) {
    throw new Error('GOAL_POLICY_INVALID: review.require_human_ack contradicts supervision');
  }
  return { version: 1, supervision, boundary_mode: boundaryMode };
}

export function goalRequirementIds(loop) {
  return Array.isArray(loop?.goal_contract?.requirements) ? loop.goal_contract.requirements.map(item => item?.id) : [];
}

export function assertGoalWorkstreamInput(loop, requirementIds, dependsOn) {
  if (!isGoalDriven(loop)) {
    if (requirementIds !== undefined) throw new Error('GOAL_CONTRACT_REQUIRED: requirement mappings require v0.5');
    return;
  }
  const known = new Set(goalRequirementIds(loop));
  if (!Array.isArray(requirementIds) || requirementIds.length < 1 || requirementIds.length > known.size
    || new Set(requirementIds).size !== requirementIds.length || requirementIds.some(id => !known.has(id))) {
    throw new Error('GOAL_MAPPING_INVALID: nonempty unique known requirement IDs required');
  }
  if (loop.workstreams.length >= GOAL_LIMITS.workstreams) throw new Error('GOAL_MAPPING_INVALID: workstream limit');
  const wsIds = new Set(loop.workstreams.map(ws => ws.id));
  if (!Array.isArray(dependsOn) || new Set(dependsOn).size !== dependsOn.length
    || dependsOn.some(id => !wsIds.has(id))) throw new Error('GOAL_MAPPING_INVALID: unknown or duplicate dependency');
}

function validateMappings(loop, errors) {
  const workstreams = loop.workstreams;
  if (!Array.isArray(workstreams) || workstreams.length > GOAL_LIMITS.workstreams) {
    errors.push('goal workstreams must be a bounded array'); return;
  }
  const known = new Set(goalRequirementIds(loop));
  const byId = new Map(workstreams.map(ws => [ws?.id, ws]));
  if (byId.size !== workstreams.length || [...byId.keys()].some(id => typeof id !== 'string' || !id.length)) {
    errors.push('goal workstream IDs must be unique nonempty strings'); return;
  }
  for (const ws of workstreams) {
    if (!Array.isArray(ws.requirement_ids) || ws.requirement_ids.length < 1
      || ws.requirement_ids.length > known.size || new Set(ws.requirement_ids).size !== ws.requirement_ids.length
      || ws.requirement_ids.some(id => !known.has(id))) errors.push('goal workstream requirement_ids are invalid');
    if (!Array.isArray(ws.depends_on) || new Set(ws.depends_on).size !== ws.depends_on.length
      || ws.depends_on.some(id => !byId.has(id))) errors.push('goal workstream dependencies are invalid');
  }
  const visiting = new Set(), done = new Set();
  const visit = id => {
    if (visiting.has(id)) return false;
    if (done.has(id)) return true;
    visiting.add(id);
    const dependencies = byId.get(id)?.depends_on;
    if (Array.isArray(dependencies) && dependencies.some(dependency => byId.has(dependency) && !visit(dependency))) return false;
    visiting.delete(id); done.add(id); return true;
  };
  if ([...byId.keys()].some(id => !visit(id))) errors.push('goal workstream dependency cycle');
}

export function validateGoalState(loop, errors) {
  const fields = ['orchestration', 'goal_contract', 'goal_obligations', 'goal_reviews'];
  if (loop.schema_version !== '0.5.0') {
    if (fields.some(field => Object.hasOwn(loop, field))) errors.push('goal fields require schema_version 0.5.0; downgrade is forbidden');
    return;
  }
  if (!isGoalDriven(loop)) errors.push('invalid v0.5 orchestration');
  const contract = loop.goal_contract;
  if (!exactGoalObject(contract, ['version', 'requirements', 'non_goals', 'sha256'])) {
    errors.push('invalid persisted goal contract');
  } else {
    const { sha256, ...input } = contract;
    try {
      if (normalizeGoalContract(input, loop.goal).sha256 !== sha256) errors.push('goal contract digest mismatch');
    } catch (error) { errors.push(error.message); }
  }
  if (loop.autonomy?.continuation_policy !== 'workstream-session') errors.push('v0.5 requires workstream-session');
  const review = loop.review;
  if (!review || review.require_human_ack !== (loop.orchestration?.supervision === 'human')) errors.push('goal supervision and human acknowledgement policy disagree');
  if (!Number.isSafeInteger(review?.max_review_rounds) || review.max_review_rounds < 1
    || review.max_review_rounds > GOAL_LIMITS.reviewRounds) errors.push('v0.5 max_review_rounds must be 1..16');
  if (!Array.isArray(review?.points) || review.points.length < 1 || review.points.length > 16
    || new Set(review.points).size !== review.points.length || review.points.some(point => typeof point !== 'string' || !GOAL_ID.test(point))) errors.push('v0.5 review points are invalid');
  validateGoalLedgers(loop, errors);
  for (const session of (Array.isArray(loop.session_chain?.sessions) ? loop.session_chain.sessions : [])) {
    if (!Number.isSafeInteger(session?.scope_epoch) || session.scope_epoch < 0) errors.push('v0.5 scope_epoch must be a nonnegative safe integer');
    if (!Number.isSafeInteger(session?.scope_turn_baseline) || session.scope_turn_baseline < 0
      || session.scope_turn_baseline > session.turns) errors.push('v0.5 scope_turn_baseline is invalid');
    validateScopeHistory(loop, session, errors);
  }
  validateMappings(loop, errors);
  for (const episode of (Array.isArray(loop.episodes) ? loop.episodes : [])) {
    if (episode.execution !== undefined && !isExecutionRecord(episode.execution)) errors.push('invalid episode execution record');
    if (episode.execution_history !== undefined && (!Array.isArray(episode.execution_history)
      || episode.execution_history.length > 64 || episode.execution_history.some(item => !isExecutionRecord(item)))) errors.push('invalid episode execution history');
    if (episode.retry_of !== undefined && (typeof episode.retry_of !== 'string' || !loop.episodes.some(item => item.id === episode.retry_of && item.role === 'maker'))) errors.push('invalid episode retry source');
    if (episode.role === 'maker' && episode.status === 'done' && (episode.execution?.phase !== 'returned'
      || episode.execution.stage !== episode.execution.required_stages?.at(-1))) errors.push('v0.5 maker done requires returned final execution');
    if (episode.role === 'checker' && episode.review_claim && episode.execution?.attempt_id !== episode.attempt_id) errors.push('checker execution and claim identities disagree');
  }
}

function validateGoalLedgers(loop, errors) {
  const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  const reqIds = new Set(goalRequirementIds(loop));
  const wsIds = new Set((Array.isArray(loop.workstreams) ? loop.workstreams : []).map(ws => ws?.id));
  const subset = (values, allowed, min, max) => Array.isArray(values) && values.length >= min && values.length <= max
    && new Set(values).size === values.length && values.every(value => allowed.has(value));
  const boundary = value => exactGoalObject(value, ['seq', 'checksum']) && Number.isSafeInteger(value.seq)
    && value.seq > 0 && hash(value.checksum);
  const obligations = loop.goal_obligations;
  if (!Array.isArray(obligations) || obligations.length > 256) errors.push('goal_obligations must be a bounded array');
  else {
    const seen = new Set();
    for (const item of obligations) {
      if (!exactGoalObject(item, ['id', 'requirement_ids', 'workstream_ids', 'status', 'reason', 'resolution'])
        || typeof item.id !== 'string' || !GOAL_ID.test(item.id) || seen.has(item.id)
        || !subset(item.requirement_ids, reqIds, 1, 64) || !subset(item.workstream_ids, wsIds, 0, 256)
        || !boundedGoalText(item.reason) || !['open', 'mapped', 'resolved'].includes(item.status)) {
        errors.push('invalid goal obligation'); continue;
      }
      seen.add(item.id);
      if (item.status !== 'resolved') {
        if (item.resolution !== null || (item.status === 'mapped') !== (item.workstream_ids.length > 0)) errors.push('invalid open goal obligation mapping');
      } else if (!exactGoalObject(item.resolution, ['kind', 'reason', 'authorization_event'])
        || !['completed-work', 'human-authorized'].includes(item.resolution.kind)
        || !boundedGoalText(item.resolution.reason) || !boundary(item.resolution.authorization_event)
        || (item.resolution.kind === 'completed-work' && item.workstream_ids.length === 0)) errors.push('invalid goal obligation resolution');
    }
  }
  const reviews = loop.goal_reviews;
  if (!Array.isArray(reviews) || reviews.length > 64) { errors.push('goal_reviews must be a bounded array'); return; }
  const seen = new Set(), attempts = new Set();
  for (const item of reviews) {
    if (!exactGoalObject(item, ['id', 'transport', 'goal_sha256', 'snapshot_sha256', 'snapshot_rel', 'snapshot_file_sha256',
      'status', 'execution', 'created_at', 'result_rel', 'result_sha256', 'result_raw_sha256', 'verdict', 'failed_requirement_ids'])
      || typeof item.id !== 'string' || !GOAL_ID.test(item.id) || seen.has(item.id)
      || !['native', 'codex', 'bridge'].includes(item.transport) || item.goal_sha256 !== loop.goal_contract?.sha256
      || !hash(item.snapshot_sha256) || !hash(item.snapshot_file_sha256)
      || item.snapshot_rel !== `goal-reviews/${item.id}/snapshot.json`
      || !['pending', 'approved', 'rejected', 'unavailable'].includes(item.status)
      || !isExecutionRecord(item.execution) || item.execution.mode !== 'external'
      || item.execution.stage !== 'primary' || !sameStrings(item.execution.required_stages, ['primary'])
      || attempts.has(item.execution.attempt_id) || typeof item.created_at !== 'string'
      || !Number.isFinite(Date.parse(item.created_at)) || new Date(item.created_at).toISOString() !== item.created_at
      || !subset(item.failed_requirement_ids, reqIds, 0, 64)) {
      errors.push('invalid goal review'); continue;
    }
    seen.add(item.id); attempts.add(item.execution.attempt_id);
    if (item.status === 'approved' || item.status === 'rejected') {
      if (item.execution.phase !== 'returned' || item.result_rel !== `goal-reviews/${item.id}/result.json`
        || !hash(item.result_sha256) || !hash(item.result_raw_sha256)
        || item.result_raw_sha256 !== item.execution.observation?.output_sha256
        || (item.status === 'approved' && (!['APPROVE', 'CONCERN'].includes(item.verdict) || item.failed_requirement_ids.length !== 0))
        || (item.status === 'rejected' && (item.verdict !== 'REQUEST_CHANGES' || item.failed_requirement_ids.length === 0))) errors.push('invalid terminal goal review');
    } else if (item.result_rel !== null || item.result_sha256 !== null || item.result_raw_sha256 !== null || item.verdict !== null
      || item.failed_requirement_ids.length !== 0 || (item.status === 'unavailable'
        && (item.execution.phase !== 'blocked' || item.execution.observation?.state !== 'failed'))
      || (item.status === 'pending' && item.execution.phase === 'returned')) errors.push('invalid pending goal review');
  }
  if (reviews.filter(item => item?.status === 'pending').length > 1) errors.push('multiple active goal reviewers');
}

function sameStrings(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
