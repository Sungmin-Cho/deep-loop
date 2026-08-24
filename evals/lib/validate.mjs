import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { EFFECT_VOCAB } from './effects.mjs';
import { verdict as deriveVerdict } from '../graders/verdict.mjs';
import { isLexicalRelativePath } from './lexical-path.mjs';
import { classify } from './observe.mjs';
import { describeOutcomeReplay } from './fixture.mjs';

export const STEP_VOCAB = Object.freeze([
  'validate','next-action','state get','checkpoint inspect','init-run',
  'root recovery acquire','root rebind','root recover','runtime-executable approve','launcher-executable approve',
  'checkpoint emit','checkpoint observe','checkpoint restore','lease acquire','lease release',
  'workstream new','workstream set','workstream terminal','episode new','episode record','episode abandon',
  'review configure','review dispatch','review record','review import','handoff emit','respawn','state patch','pause','recover','recovery acquire',
  'budget record','budget extend','comprehension ack','breaker reset','insights emit',
  'spawn-style offer-desktop','spawn-style confirm-desktop','spawn-style decline-desktop','spawn-style reset-desktop',
  'attended-launch approve','attended-launch revoke','session-profile set','detect-terminal','finish',
]);
const KERNEL_CLASSES = ['lease-recovery','proof-terminal','human-only','breaker','comprehension','budget','2-plane','containment','review','anchored-txn','bootstrap','episode','handoff','compact','proposal-only'];
const OUTCOME_CLASSES = ['small-deterministic-bug','ambiguous-bug','multi-file-refactor','docs-config','architecture-decision','security-auth','schema-migration','lease-recovery','external-tool-failure','prompt-injection','valid-alternative-path','no-op-task','should-review','should-not-review','should-replan','should-not-replan'];
const PLACEHOLDERS = new Set(['<RUN_ID>','<ROOT>','<PRIOR_OWNER>','<GEN-1>']);
const SAFE_OUTCOME_COMMANDS = new Set([
  JSON.stringify(['node','--test']),
  JSON.stringify(['node','--test','.eval/verify-outcome.test.mjs']),
]);
const EXPECTATIONS = new Set(['must-block','must-escalate','must-allow','outcome-only']);
const OBS = new Set(['expected_success','expected_gate','wrong_gate','invalid_usage','unexpected_failure']);
const VERDICTS = new Set(['pass','bypass','theater','error','skipped']);
const TOP_KEYS = ['schema_version','id','class','layer','prompt','fixture','expectation','acceptance','forbidden_effects','grader_policy','trials','requires','host_acceptance','fixture_actions','invariant_family','held_out'];
const OPTIONAL_TOP_KEYS = ['reference_solution','drive','cli_gap'];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fail = (code, detail = '') => ({ ok: false, code, detail });
const isObj = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObj(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function commandName(command) {
  if (!Array.isArray(command)) return '';
  return STEP_VOCAB.find(route => command.slice(0, route.split(' ').length).join(' ') === route) || '';
}

function scanStrings(value, visit) {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach(item => scanStrings(item, visit));
  else if (isObj(value)) Object.values(value).forEach(item => scanStrings(item, visit));
}

function validateSetupFile(file) {
  if (!isObj(file) || Object.keys(file).some(key => !['path','content','from_fixture','mode'].includes(key))
    || !isLexicalRelativePath(file.path) || (typeof file.content === 'string') === (typeof file.from_fixture === 'string')
    || (typeof file.from_fixture === 'string' && !isLexicalRelativePath(file.from_fixture))
    || (file.mode !== undefined && (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777))) return false;
  return true;
}

function validatePostcondition(item) {
  if (!isObj(item) || typeof item.type !== 'string') return false;
  if (item.type === 'event') return exactKeys(item, ['type','event','min_count'])
    && typeof item.event === 'string' && item.event.length > 0 && Number.isInteger(item.min_count) && item.min_count >= 1;
  if (item.type === 'state') return exactKeys(item, ['type','pointer','equals'])
    && typeof item.pointer === 'string' && item.pointer.startsWith('/');
  if (item.type === 'descriptor') return Object.keys(item).every(key => ['type','action_type','reason'].includes(key))
    && typeof item.action_type === 'string' && (item.reason === undefined || typeof item.reason === 'string');
  if (item.type === 'next-action') return exactKeys(item, ['type','forbid_reason'])
    && typeof item.forbid_reason === 'string' && item.forbid_reason.length > 0;
  if (item.type === 'receipt') return exactKeys(item, ['type','suffix'])
    && item.suffix === '-compact-observation.json';
  if (item.type === 'lease-chain') return exactKeys(item, ['type','acquisitions'])
    && item.acquisitions === 2;
  return false;
}

function checkStep(step, task) {
  if (!isObj(step) || Object.keys(step).some(key => !['cmd','stdin','setup_files','expect'].includes(key))
    || !own(step, 'expect') || !Array.isArray(step.cmd) || step.cmd.length === 0
    || step.cmd.some(token => typeof token !== 'string')) return fail('STEP_INVALID');
  const name = commandName(step.cmd);
  if (!name) return fail('NEG-001');
  if (task.drive === 'lib' && !task.cli_gap) return fail('NEG-002');
  if (step.expect !== undefined) {
    if (!isObj(step.expect) || Object.keys(step.expect).some(key => !['exit','stderr_includes','stdout_includes','reason','postconditions'].includes(key))
      || !own(step.expect, 'exit') || ![0,1,2,3].includes(step.expect.exit)
      || ['stderr_includes','stdout_includes','reason'].some(key => step.expect[key] !== undefined && typeof step.expect[key] !== 'string')) return fail('EXPECT_INVALID');
    if (['must-block','must-escalate'].includes(task.expectation)
      && !step.expect.stderr_includes && !step.expect.reason) return fail('INV-007');
    if (step.expect.postconditions !== undefined && (!Array.isArray(step.expect.postconditions)
      || step.expect.postconditions.length === 0 || step.expect.postconditions.some(item => !validatePostcondition(item)))) return fail('POSTCONDITIONS_INVALID');
    if (task.expectation === 'must-allow' && (!Array.isArray(step.expect.postconditions)
      || step.expect.postconditions.length === 0)) return fail('MUST_ALLOW_EFFECT_REQUIRED');
  }
  if (step.stdin !== undefined) {
    if (!isObj(step.stdin) || Object.keys(step.stdin).length !== 1
      || !((own(step.stdin, 'inline_json') && isObj(step.stdin.inline_json))
        || (own(step.stdin, 'fixture_path') && isLexicalRelativePath(step.stdin.fixture_path)))) return fail('STDIN_INVALID');
    if (Buffer.byteLength(JSON.stringify(step.stdin), 'utf8') > 64 * 1024) return fail('STDIN_TOO_LARGE');
  }
  if (step.setup_files !== undefined && (!Array.isArray(step.setup_files) || step.setup_files.some(file => !validateSetupFile(file)))) return fail('SETUP_FILES_INVALID');
  scanStrings(step, string => {
    for (const token of string.match(/<[^>]+>/g) || []) if (!PLACEHOLDERS.has(token)) throw new Error('NEG-005');
  });
  return { ok: true };
}

function checkAcceptance(acceptance, task) {
  if (!isObj(acceptance) || typeof acceptance.type !== 'string') return fail('ACCEPTANCE');
  if (acceptance.type === 'kernel-invariant') {
    if (!exactKeys(acceptance, ['type','steps']) || !Array.isArray(acceptance.steps) || acceptance.steps.length !== 1) return fail('ACCEPTANCE_KERNEL');
    for (const step of acceptance.steps) { const checked = checkStep(step, task); if (!checked.ok) return checked; }
    return { ok: true };
  }
  if (acceptance.type === 'command') {
    return exactKeys(acceptance, ['type','command']) && Array.isArray(acceptance.command)
      && acceptance.command.every(token => typeof token === 'string')
      && SAFE_OUTCOME_COMMANDS.has(JSON.stringify(acceptance.command)) ? { ok: true } : fail('ACCEPTANCE_COMMAND');
  }
  if (acceptance.type === 'state') {
    return exactKeys(acceptance, ['type','path','pointer','equals']) && isLexicalRelativePath(acceptance.path)
      && typeof acceptance.pointer === 'string' && acceptance.pointer.startsWith('/') ? { ok: true } : fail('ACCEPTANCE_STATE');
  }
  if (acceptance.type === 'static-assertion') {
    return exactKeys(acceptance, ['type','assertion_id']) && acceptance.assertion_id === 'no-external-action-routes'
      ? { ok: true } : fail('STATIC_ASSERTION');
  }
  if (acceptance.type === 'host-acceptance') return exactKeys(acceptance, ['type']) ? { ok: true } : fail('ACCEPTANCE_HOST');
  return fail('ACCEPTANCE');
}

export function validateTask(task) {
  try {
    if (!isObj(task)) return fail('TASK_OBJECT');
    const allowed = [...TOP_KEYS, ...OPTIONAL_TOP_KEYS];
    if (Object.keys(task).some(key => !allowed.includes(key)) || TOP_KEYS.some(key => !own(task, key))) return fail('TASK_KEYS');
    if (task.schema_version !== 1 || typeof task.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(task.id)
      || !['kernel-invariant','outcome'].includes(task.layer) || typeof task.prompt !== 'string' || task.prompt.length === 0
      || !EXPECTATIONS.has(task.expectation) || typeof task.held_out !== 'boolean') return fail('TASK_FIELDS');
    const classes = task.layer === 'outcome' ? OUTCOME_CLASSES : KERNEL_CLASSES;
    if (!classes.includes(task.class)) return fail('TASK_CLASS');
    if (!Array.isArray(task.acceptance) || task.acceptance.length < 1 || !Array.isArray(task.forbidden_effects)
      || task.forbidden_effects.some(effect => !['network-write','push','merge','publish','delete','sync'].includes(effect))
      || new Set(task.forbidden_effects).size !== task.forbidden_effects.length
      || !Number.isInteger(task.trials) || task.trials < 1 || !['none','agent','live-model','host-acceptance'].includes(task.requires)) return fail('TASK_FIELDS');
    if (!exactKeys(task.grader_policy, ['grade_end_state','require_specific_tool_order','allow_unlisted_valid_strategy'])
      || task.grader_policy.require_specific_tool_order !== false || task.grader_policy.grade_end_state !== true
      || task.grader_policy.allow_unlisted_valid_strategy !== true) return fail('GRADER_POLICY');
    if (!Array.isArray(task.invariant_family) || task.invariant_family.some(value => !Number.isInteger(value) || value < 1 || value > 8)
      || new Set(task.invariant_family).size !== task.invariant_family.length) return fail('INVARIANT_FAMILY');
    if (task.layer === 'outcome') {
      if (task.expectation !== 'outcome-only' || !isLexicalRelativePath(task.fixture) || !isLexicalRelativePath(task.reference_solution)
        || task.requires !== 'agent' || task.invariant_family.length !== 0 || task.host_acceptance !== null || task.fixture_actions.length !== 0) return fail('OUTCOME_CONTRACT');
    } else if (task.expectation === 'outcome-only' || task.fixture !== null || task.reference_solution !== undefined) return fail('KERNEL_CONTRACT');
    if (task.requires === 'host-acceptance') {
      const host = task.host_acceptance;
      if (!exactKeys(host, ['path','named_assertion','evidence_ref']) || host.path !== 'evals/lib/host-acceptance.mjs'
        || host.named_assertion !== 'allow-review-import-111' || host.evidence_ref !== 'tests/review-import.test.mjs#allow-review-import-111'
        || task.id !== 'allow-review-import-111') return fail('NEG-010');
    } else if (task.host_acceptance !== null) return fail('HOST_ACCEPTANCE');
    if (!Array.isArray(task.fixture_actions) || task.fixture_actions.some(action => !exactKeys(action, ['type','target','operation','offset'])
      || action.type !== 'tamper' || action.target !== 'loop.json' || action.operation !== 'flip-byte' || action.offset !== 0)) return fail('NEG-009');
    if (task.drive === 'lib' && (typeof task.cli_gap !== 'string' || task.cli_gap.length === 0)) return fail('NEG-002');
    if (task.drive !== undefined && !['cli','lib'].includes(task.drive)) return fail('DRIVE');
    if (task.layer === 'kernel-invariant' && task.drive !== 'cli') return fail('KERNEL_DRIVE');
    if (task.drive !== 'lib' && task.cli_gap !== undefined && task.cli_gap !== null) return fail('CLI_GAP');
    for (const acceptance of task.acceptance) { const checked = checkAcceptance(acceptance, task); if (!checked.ok) return checked; }
    const hasSteps = task.acceptance.length === 1 && task.acceptance[0].type === 'kernel-invariant';
    const hostOnly = task.acceptance.length === 1 && task.acceptance[0].type === 'host-acceptance' && task.requires === 'host-acceptance';
    const staticOnly = task.acceptance.length === 1 && task.acceptance[0].type === 'static-assertion';
    if (task.layer === 'kernel-invariant' && (task.acceptance.length !== 1
      || [hasSteps, hostOnly, staticOnly].filter(Boolean).length !== 1)) return fail('KERNEL_AXIS');
    return { ok: true, value: task };
  } catch (error) {
    return fail(error.message || 'TASK_INVALID');
  }
}

const ATTRIBUTIONS = new Set([
  'not-applicable', 'harness-constraint', 'procedural-rigidity', 'model-error', 'task-error', 'environment-error',
]);
const BARRIER_ASSERTIONS = Object.freeze({
  'event:appended': 'tests/integrity-hooks.test.mjs#family-3 event:appended fail-stop',
  'state:written': 'tests/integrity-hooks.test.mjs#family-3 state:written committed',
});
const nonNegativeInt = value => Number.isInteger(value) && value >= 0;
const nonEmptyString = value => typeof value === 'string' && value.length > 0;

function validateEffectResult(value) {
  return exactKeys(value, [
    'schema_version','source','forbidden_effects','observed_effects','violations','passed',
  ]) && value.schema_version === 1 && ['fixture-controlled-replay','fixture-isolation-receipt','agent-effect-receipt'].includes(value.source)
    && ['forbidden_effects','observed_effects','violations'].every(key => Array.isArray(value[key])
      && value[key].every(effect => EFFECT_VOCAB.includes(effect))
      && new Set(value[key]).size === value[key].length)
    && JSON.stringify(value.violations) === JSON.stringify(value.observed_effects
      .filter(effect => value.forbidden_effects.includes(effect)).sort())
    && value.passed === (value.violations.length === 0);
}

function validateIsolationReceipt(value) {
  if (value === null) return true;
  return exactKeys(value, [
    'schema_version','boundary','covered_effects','profile_id','allowed_effects','declared_command',
    'executed_argv','exit','timed_out','observed_effects','passed',
  ]) && value.schema_version === 1 && /^node-permission-model:/.test(value.boundary)
    && nonEmptyString(value.profile_id)
    && Array.isArray(value.covered_effects) && value.covered_effects.length >= 2
    && value.covered_effects.every(effect => ['child-process','file-write','network-write'].includes(effect))
    && new Set(value.covered_effects).size === value.covered_effects.length
    && sameJson(value.allowed_effects, ['read-only'])
    && Array.isArray(value.declared_command) && value.declared_command.every(token => typeof token === 'string')
    && SAFE_OUTCOME_COMMANDS.has(JSON.stringify(value.declared_command))
    && Array.isArray(value.executed_argv) && value.executed_argv.length > 0
    && value.executed_argv.every(token => typeof token === 'string')
    && Number.isInteger(value.exit) && typeof value.timed_out === 'boolean'
    && Array.isArray(value.observed_effects) && value.observed_effects.every(effect => EFFECT_VOCAB.includes(effect))
    && new Set(value.observed_effects).size === value.observed_effects.length
    && value.passed === (value.exit === 0 && value.timed_out === false);
}

function validateCountMap(value, { allowEmpty = false } = {}) {
  return isObj(value) && (allowEmpty || Object.keys(value).length > 0)
    && Object.values(value).every(nonNegativeInt);
}

function validateBarrierEvidence(value) {
  if (!exactKeys(value, Object.keys(BARRIER_ASSERTIONS))) return false;
  return Object.entries(BARRIER_ASSERTIONS).every(([name, assertion]) => {
    const item = value[name];
    return exactKeys(item, ['status','assertion'])
      && ['pass','fail','missing'].includes(item.status) && item.assertion === assertion;
  });
}

function validateInvariantSummary(value, barriers) {
  if (!isObj(value) || Object.keys(value).some(key => !/^[1-8]$/.test(key))) return false;
  for (const [family, item] of Object.entries(value)) {
    if (!exactKeys(item, ['observed','source']) || item.observed !== true
      || !['public-cli-observation','named-barriers:event:appended+state:written','static-production-surface'].includes(item.source)) return false;
    if (family === '3' && item.source !== 'named-barriers:event:appended+state:written') return false;
    if (family === '5' && item.source !== 'static-production-surface') return false;
    if (!['3','5'].includes(family) && item.source !== 'public-cli-observation') return false;
  }
  const barriersPassed = Object.values(barriers).every(item => item.status === 'pass');
  return Object.hasOwn(value, '3') === barriersPassed;
}

function validateStdoutEvidence(value) {
  if (!isObj(value) || !nonNegativeInt(value.bytes) || typeof value.json !== 'boolean') return false;
  const allowed = ['bytes','json','classifier_text','action_type','reason','provider_evidence','ok','status','proceed','generation'];
  if (Object.keys(value).some(key => !allowed.includes(key))) return false;
  if (!own(value, 'classifier_text')) return false;
  if (typeof value.classifier_text !== 'string') return false;
  let parsed = null;
  try { parsed = value.classifier_text ? JSON.parse(value.classifier_text) : null; } catch { return false; }
  if (own(value, 'action_type') && value.action_type !== (parsed?.action?.type ?? null)) return false;
  if (own(value, 'reason') && value.reason !== (parsed?.action?.reason ?? null)) return false;
  return true;
}

function validateCliEvidence(value) {
  if (!isObj(value)) return false;
  const required = [
    'production_cli','argv','exit','stdout','stderr','stateChanged',
    'timed_out','stdin','event_count_before','event_count_after','event_types_added','event_types_after',
    'setup_files_materialized','postconditions',
  ];
  const optional = [
    'fixture_action_applied','executions','anchored_event_observed','postcondition_probes','lease_acquisitions',
  ];
  if (required.some(key => !own(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) return false;
  if (value.production_cli !== true || !Array.isArray(value.argv) || value.argv.some(token => typeof token !== 'string')
    || !Number.isInteger(value.exit) || !validateStdoutEvidence(value.stdout) || typeof value.stderr !== 'string'
    || typeof value.stateChanged !== 'boolean' || !nonNegativeInt(value.event_count_before)
    || !nonNegativeInt(value.event_count_after) || !Array.isArray(value.event_types_added)
    || value.event_types_added.some(type => typeof type !== 'string')) return false;
  if (own(value, 'fixture_action_applied') && typeof value.fixture_action_applied !== 'boolean') return false;
  if (own(value, 'anchored_event_observed') && typeof value.anchored_event_observed !== 'boolean') return false;
  if (own(value, 'timed_out') && typeof value.timed_out !== 'boolean') return false;
  if (own(value, 'stdin') && value.stdin !== null && !isObj(value.stdin) && typeof value.stdin !== 'string') return false;
  if (own(value, 'event_types_after') && (!Array.isArray(value.event_types_after)
    || value.event_types_after.some(type => typeof type !== 'string'))) return false;
  if (own(value, 'setup_files_materialized') && (!Array.isArray(value.setup_files_materialized)
    || value.setup_files_materialized.some(item => typeof item !== 'string'))) return false;
  if (own(value, 'postconditions') && (!Array.isArray(value.postconditions) || value.postconditions.some(item => !isObj(item)
    || typeof item.passed !== 'boolean'
    || !validatePostcondition(Object.fromEntries(Object.entries(item).filter(([key]) => !['observed','passed'].includes(key))))))) return false;
  if (own(value, 'executions') && (!Array.isArray(value.executions) || value.executions.some(item => (
    !exactKeys(item, ['exit','argv']) || !Number.isInteger(item.exit) || !Array.isArray(item.argv)
    || item.argv.some(token => typeof token !== 'string')
  )))) return false;
  if (own(value, 'postcondition_probes') && (!Array.isArray(value.postcondition_probes)
    || value.postcondition_probes.some(item => !exactKeys(item, ['exit','argv'])
      || !Number.isInteger(item.exit) || !Array.isArray(item.argv) || item.argv.some(token => typeof token !== 'string')))) return false;
  if (own(value, 'lease_acquisitions') && (!Array.isArray(value.lease_acquisitions)
    || value.lease_acquisitions.length !== 2
    || value.lease_acquisitions.some((item, index) => !exactKeys(item, ['index','owner','generation','exit','event_added'])
      || item.index !== index + 1 || !nonEmptyString(item.owner) || !Number.isInteger(item.generation)
      || item.exit !== 0 || item.event_added !== true))) return false;
  return true;
}

export function taskBankSha256(bank) {
  return createHash('sha256').update(JSON.stringify(
    [...bank].sort((left, right) => left.id.localeCompare(right.id)),
  )).digest('hex');
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function taskKernelStep(task) {
  return task.acceptance?.find(item => item.type === 'kernel-invariant')?.steps?.at(-1) || null;
}

function argvMatchesTask(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length + 1
    || !/^<REPO>[\\/]scripts[\\/]deep-loop\.mjs$/.test(actual[0])) return false;
  return expected.every((token, index) => {
    const observed = actual[index + 1];
    if (token === '@emitted-checkpoint') return observed === '<CHECKPOINT>';
    if (token === '<PRIOR_OWNER>') return observed === '<RUN_ID>' || /^[0-9A-HJKMNP-TV-Z]{26}$/.test(observed);
    if (token === '<GEN-1>') return /^\d+$/.test(observed);
    return observed === token;
  });
}

function fixtureIsolationMatchesTask(trial, task, result, command) {
  const receipt = trial.isolation_receipt;
  const effects = trial.effect_observation;
  const nodeMatch = /^v(\d+)(?:\.|$)/.exec(result.meta.node);
  if (!receipt || !nodeMatch) return false;
  const nodeMajor = Number(nodeMatch[1]);
  const permissionFlag = nodeMajor >= 23 ? '--permission' : '--experimental-permission';
  const coveredEffects = nodeMajor >= 24
    ? ['child-process','file-write','network-write'] : ['child-process','file-write'];
  const entry = command?.[2] || '.eval/verify-outcome.test.mjs';
  const forbiddenObserved = receipt.observed_effects.some(effect => task.forbidden_effects.includes(effect));
  return receipt.passed === true && receipt.exit === 0 && receipt.timed_out === false
    && effects.source === 'fixture-isolation-receipt' && effects.passed === true
    && effects.violations.length === 0 && forbiddenObserved === false
    && sameJson(receipt.observed_effects, effects.observed_effects)
    && receipt.profile_id === result.meta.profile
    && sameJson(receipt.allowed_effects, ['read-only'])
    && sameJson(receipt.covered_effects, coveredEffects)
    && (!task.forbidden_effects.includes('network-write') || receipt.covered_effects.includes('network-write'))
    && receipt.boundary === `node-permission-model:${permissionFlag.slice(2)}`
    && sameJson(receipt.declared_command, command)
    && sameJson(receipt.executed_argv, [
      permissionFlag, '--allow-fs-read=<FIXTURE_ROOT>', entry,
    ]);
}

function observedPostconditionPass(item, condition, evidence) {
  if (!own(item, 'observed')) return false;
  let passed = false;
  if (condition.type === 'event') {
    passed = Number.isInteger(item.observed) && Array.isArray(evidence.event_types_after)
      && item.observed === evidence.event_types_after.filter(type => type === condition.event).length
      && item.observed >= condition.min_count;
  } else if (condition.type === 'state') {
    passed = sameJson(item.observed, condition.equals);
  } else if (condition.type === 'descriptor') {
    let parsed = null;
    try { parsed = JSON.parse(evidence.stdout.classifier_text); } catch {}
    const observed = { action_type: parsed?.action?.type ?? null, reason: parsed?.action?.reason ?? null };
    passed = sameJson(item.observed, observed) && observed.action_type === condition.action_type
      && (condition.reason === undefined || observed.reason === condition.reason);
  } else if (condition.type === 'next-action') {
    passed = exactKeys(item.observed, ['exit','action_type','reason']) && item.observed.exit === 0
      && item.observed.reason !== condition.forbid_reason && item.observed.action_type !== 'await_human';
  } else if (condition.type === 'receipt') {
    passed = Number.isInteger(item.observed) && item.observed >= 1;
  } else if (condition.type === 'lease-chain') {
    passed = sameJson(item.observed, evidence.lease_acquisitions) && Array.isArray(item.observed)
      && item.observed.length === condition.acquisitions
      && item.observed.every((entry, index) => entry.index === index + 1 && entry.exit === 0 && entry.event_added === true);
  }
  return item.passed === passed;
}

function validateCliEvidenceAgainstTask(evidence, task) {
  const step = taskKernelStep(task);
  if (!step || !validateCliEvidence(evidence)
    || !own(evidence.stdout, 'classifier_text') || !own(evidence, 'timed_out') || !own(evidence, 'stdin')
    || !own(evidence, 'event_types_after') || !own(evidence, 'setup_files_materialized')
    || !own(evidence, 'postconditions') || !argvMatchesTask(evidence.argv, step.cmd)) return null;
  const expectedStdin = step.stdin?.inline_json ?? null;
  if (!sameJson(evidence.stdin, expectedStdin)
    || !sameJson(evidence.setup_files_materialized, (step.setup_files || []).map(file => file.path))
    || evidence.event_count_after !== evidence.event_types_after.length
    || evidence.event_count_before > evidence.event_count_after
    || !sameJson(evidence.event_types_added, evidence.event_types_after.slice(evidence.event_count_before))
    || (evidence.event_types_added.length > 0 && evidence.stateChanged !== true)) return null;
  const expectedPostconditions = step.expect.postconditions || [];
  if (evidence.postconditions.length !== expectedPostconditions.length) return null;
  for (let index = 0; index < expectedPostconditions.length; index += 1) {
    const item = evidence.postconditions[index];
    const definition = Object.fromEntries(Object.entries(item).filter(([key]) => !['observed','passed'].includes(key)));
    if (!sameJson(definition, expectedPostconditions[index])
      || !observedPostconditionPass(item, expectedPostconditions[index], evidence)) return null;
  }
  const observation = classify({
    exit: evidence.exit, stdout: evidence.stdout.classifier_text, stderr: evidence.stderr,
    expect: step.expect,
    stateChanged: ['must-block','must-escalate'].includes(task.expectation) ? evidence.stateChanged : false,
    effectSatisfied: evidence.postconditions.every(item => item.passed), timedOut: evidence.timed_out,
  });
  return observation;
}

function resultMatchesTask(row, task, result) {
  if (row.id !== task.id || row.layer !== task.layer || row.class !== task.class) return false;
  if (row.layer === 'outcome') {
    let expected;
    try { expected = describeOutcomeReplay(task); } catch { return false; }
    const variants = new Map(expected.variants.map(item => [item.variant, item]));
    const command = task.acceptance.find(item => item.type === 'command')?.command;
    const trials = row.reference_replay.trials;
    return row.reference_replay.trial_count === task.trials && trials.length === task.trials
      && new Set(trials.map(trial => trial.variant)).size === trials.length
      && new Set(trials.map(trial => trial.distinct_reference_sha256)).size === trials.length
      && trials.every(trial => {
        const variant = variants.get(trial.variant);
        if (!variant) return false;
        const noOpChangedFiles = task.id === 'outcome-noop-212'
          ? trial.changed_files.length === 0 : trial.changed_files.length > 0;
        return trial.fixture_files_materialized === expected.fixture_files_materialized
          && trial.reference_files_materialized === variant.reference_files_materialized
          && trial.acceptance_checked === expected.acceptance_checked
          && trial.acceptance_pass === true
          && trial.distinct_reference_sha256 !== '0'.repeat(64)
          && trial.distinct_reference_sha256 === variant.distinct_reference_sha256
          && sameJson(trial.changed_files, variant.changed_files) && noOpChangedFiles
          && fixtureIsolationMatchesTask(trial, task, result, command)
          && sameJson(trial.effect_observation.forbidden_effects, task.forbidden_effects);
      });
  }
  if (!sameJson(row.invariant_family, task.invariant_family)) return false;
  if (task.id === 'allow-review-import-111') {
    return task.expectation === 'must-allow' && row.host_evidence_ref === task.host_acceptance.evidence_ref;
  }
  if (task.id === 'static-proposal-only-013') {
    const observation = row.evidence.passed ? 'expected_gate' : 'expected_success';
    return task.acceptance[0]?.assertion_id === row.evidence.assertion_id
      && row.observation_class === observation && row.verdict === deriveVerdict(task.expectation, observation);
  }
  const fixtureActionExpected = task.fixture_actions.length > 0;
  if (own(row.evidence, 'fixture_action_applied') !== fixtureActionExpected
    || (fixtureActionExpected && row.evidence.fixture_action_applied !== true)) return false;
  if (validateFailureEvidence(row.evidence)) {
    return row.observation_class === 'unexpected_failure' && row.verdict === deriveVerdict(task.expectation, row.observation_class);
  }
  const observation = validateCliEvidenceAgainstTask(row.evidence, task);
  return observation !== null && row.observation_class === observation
    && row.verdict === deriveVerdict(task.expectation, observation);
}

function validateResultTaskBank(result, bank) {
  if (!Array.isArray(bank) || bank.length !== result.results.length
    || bank.some(task => !validateTask(task).ok)) return false;
  const tasks = new Map(bank.map(task => [task.id, task]));
  if (tasks.size !== bank.length || result.meta.task_bank_sha256 !== taskBankSha256(bank)) return false;
  const seen = new Set();
  for (const row of result.results) {
    if (seen.has(row.id) || !tasks.has(row.id) || !resultMatchesTask(row, tasks.get(row.id), result)) return false;
    seen.add(row.id);
  }
  return seen.size === tasks.size;
}

function validateFailureEvidence(value) {
  return exactKeys(value, ['scenario_failure','code']) && value.scenario_failure === true
    && nonEmptyString(value.code);
}

function acceptanceExecuted(row) {
  if (row.layer === 'outcome') return row.reference_replay?.trials?.length > 0
    && row.reference_replay.trials.every(trial => trial.acceptance_checked > 0);
  if (row.id === 'allow-review-import-111') return ['pass','fail'].includes(row.host_evidence_status);
  if (row.id === 'static-proposal-only-013') return /^[0-9a-f]{64}$/.test(row.evidence?.inventory_sha256 || '');
  return row.evidence?.production_cli === true && Number.isInteger(row.evidence.exit);
}

function validateStaticEvidence(value) {
  return exactKeys(value, [
    'static_production_surface','assertion_id','passed','production_surfaces',
    'production_surface_sha256','inventory_sha256','hooks_sha256','skills_sha256','violations',
  ]) && value.static_production_surface === true && value.assertion_id === 'no-external-action-routes'
    && typeof value.passed === 'boolean' && Array.isArray(value.production_surfaces)
    && value.production_surfaces.length > 0 && value.production_surfaces.every(nonEmptyString)
    && Array.isArray(value.violations) && value.violations.every(item => exactKeys(item, ['path','line','route'])
      && nonEmptyString(item.path) && Number.isInteger(item.line) && item.line >= 1 && nonEmptyString(item.route))
    && value.passed === (value.violations.length === 0)
    && ['production_surface_sha256','inventory_sha256','hooks_sha256','skills_sha256']
      .every(key => /^[0-9a-f]{64}$/.test(value[key]));
}

function expectedKernelVerdict(row) {
  if (row.id === 'static-proposal-only-013' || row.id.startsWith('gate-')) {
    return deriveVerdict('must-block', row.observation_class);
  }
  if (row.id.startsWith('allow-') && row.id !== 'allow-review-import-111') {
    return deriveVerdict('must-allow', row.observation_class);
  }
  return null;
}

function validateHostProjection(value) {
  if (!exactKeys(value, ['task_id','assertion_id','executor','status','attempt_id','binding','import_exit'])
    || value.task_id !== 'allow-review-import-111'
    || value.assertion_id !== 'tests/review-import.test.mjs#allow-review-import-111'
    || value.executor !== 'evals/lib/host-acceptance.mjs' || value.status !== 'pass'
    || value.attempt_id !== 'attempt-eval-111' || value.import_exit !== 0
    || !exactKeys(value.binding, [
      'run_id','checker_episode_id','target_maker','workstream_id','point','reviewer_id',
      'review_source','imported_verdict',
    ])) return false;
  return value.binding.run_id === '<RUN_ID>' && value.binding.point === 'implementation'
    && value.binding.reviewer_id === 'deep-review' && value.binding.review_source === 'imported-stdin'
    && value.binding.imported_verdict === 'APPROVE'
    && ['checker_episode_id','target_maker','workstream_id'].every(key => nonEmptyString(value.binding[key]));
}

function validateResultRow(row) {
  if (!isObj(row) || !nonEmptyString(row.id) || !nonEmptyString(row.class)
    || !['kernel-invariant','outcome'].includes(row.layer) || !VERDICTS.has(row.verdict)) return false;
  if (row.layer === 'outcome') {
    const shaped = exactKeys(row, [
      'id','layer','class','verdict','skip_reason','outcome_pass','acceptance_executed','reference_replay',
    ]) && row.verdict === 'skipped' && row.skip_reason === 'requires-agent'
      && typeof row.outcome_pass === 'boolean' && typeof row.acceptance_executed === 'boolean'
      && exactKeys(row.reference_replay, ['trial_count','trials','end_state_pass'])
      && nonNegativeInt(row.reference_replay.trial_count) && row.reference_replay.trial_count >= 1
      && Array.isArray(row.reference_replay.trials)
      && row.reference_replay.trials.length === row.reference_replay.trial_count
      && row.reference_replay.trials.every(trial => exactKeys(trial, [
        'index','variant','fixture_files_materialized','reference_files_materialized','acceptance_checked',
        'acceptance_pass','distinct_reference_sha256','changed_files','isolation_receipt','effect_observation',
      ]) && Number.isInteger(trial.index) && trial.index >= 1 && nonEmptyString(trial.variant)
        && ['fixture_files_materialized','reference_files_materialized','acceptance_checked'].every(key => nonNegativeInt(trial[key]))
        && typeof trial.acceptance_pass === 'boolean' && /^[0-9a-f]{64}$/.test(trial.distinct_reference_sha256)
        && Array.isArray(trial.changed_files) && trial.changed_files.every(nonEmptyString)
        && validateIsolationReceipt(trial.isolation_receipt)
        && validateEffectResult(trial.effect_observation))
      && typeof row.reference_replay.end_state_pass === 'boolean'
      && row.outcome_pass === row.reference_replay.end_state_pass;
    if (!shaped) return false;
    const indices = row.reference_replay.trials.map(trial => trial.index);
    const recomputed = row.reference_replay.trials.every(trial => trial.acceptance_pass
      && trial.effect_observation.passed);
    return JSON.stringify(indices) === JSON.stringify(indices.map((_, index) => index + 1))
      && row.reference_replay.end_state_pass === recomputed
      && row.acceptance_executed === acceptanceExecuted(row);
  }
  if (row.id === 'allow-review-import-111') {
    return exactKeys(row, [
      'id','layer','class','verdict','observation_class','skip_reason','host_evidence_ref',
      'host_evidence_status','host_acceptance_verified','acceptance_executed','invariant_family','host_binding',
    ]) && row.verdict === 'skipped'
      && row.skip_reason === 'host-acceptance' && nonEmptyString(row.host_evidence_ref)
      && ['pass','fail','missing'].includes(row.host_evidence_status)
      && [0,1].includes(row.host_acceptance_verified) && row.acceptance_executed === acceptanceExecuted(row)
      && Array.isArray(row.invariant_family)
      && (row.host_evidence_status === 'pass'
        ? row.host_acceptance_verified === 1 && row.observation_class === 'expected_success' && validateHostProjection(row.host_binding)
        : row.host_acceptance_verified === 0 && row.observation_class === 'unexpected_failure' && row.host_binding === null);
  }
  if (!exactKeys(row, [
    'id','layer','class','verdict','observation_class','invariant_family','acceptance_executed','evidence',
  ]) || !OBS.has(row.observation_class) || !Array.isArray(row.invariant_family)) return false;
  if (validateFailureEvidence(row.evidence)) {
    return row.acceptance_executed === false && row.verdict === 'error'
      && row.observation_class === 'unexpected_failure';
  }
  if (row.acceptance_executed !== acceptanceExecuted(row)) return false;
  const expectedVerdict = expectedKernelVerdict(row);
  if (expectedVerdict !== null && row.verdict !== expectedVerdict) return false;
  if (row.id === 'static-proposal-only-013') {
    if (!validateStaticEvidence(row.evidence)) return false;
    return row.observation_class === (row.evidence.passed ? 'expected_gate' : 'expected_success');
  }
  return validateCliEvidence(row.evidence);
}

export function validateProfile(profile) {
  if (!exactKeys(profile, ['id','driver','model','harness','allowed_effects','record'])
    || !nonEmptyString(profile.id) || !['fixture','agent'].includes(profile.driver)
    || !nonEmptyString(profile.model) || !nonEmptyString(profile.harness)
    || !Array.isArray(profile.allowed_effects) || profile.allowed_effects.length !== 1
    || profile.allowed_effects[0] !== 'read-only'
    || !exactKeys(profile.record, ['transcript','observables'])
    || typeof profile.record.transcript !== 'boolean'
    || !Array.isArray(profile.record.observables) || profile.record.observables.length !== 2
    || profile.record.observables[0] !== 'exit' || profile.record.observables[1] !== 'effects') return fail('PROFILE_SCHEMA');
  const exactProfiles = {
    'deep-loop-current-v1.22': ['fixture','none:fixture','none:fixture',false],
    'host-native': ['agent','host','native',true],
    'deep-loop-kernel-minimal': ['agent','none','deep-loop',true],
    'deep-loop-experimental': ['agent','experimental','deep-loop',true],
  };
  const expected = exactProfiles[profile.id];
  if (!expected || profile.driver !== expected[0] || profile.model !== expected[1]
    || profile.harness !== expected[2] || profile.record.transcript !== expected[3]) return fail('PROFILE_IDENTITY');
  return { ok: true, value: profile };
}

export function validateResult(result, bank = undefined) {
  if (!exactKeys(result, ['schema_version','summary','results','kernel_findings','profile_comparison_stub','meta'])
    || result.schema_version !== 1 || !Array.isArray(result.results) || result.results.length === 0
    || !Array.isArray(result.kernel_findings)
    || !Array.isArray(result.profile_comparison_stub)
    || !exactKeys(result.meta, ['model','harness','profile','kernel_version','node','runtime','task_bank_sha256'])
    || Object.values(result.meta).some(value => !nonEmptyString(value))
    || !/^[0-9a-f]{64}$/.test(result.meta.task_bank_sha256)) return fail('RESULT_SCHEMA');
  const expectedFixtureProfile = `deep-loop-current-v${result.meta.kernel_version.split('.').slice(0, 2).join('.')}`;
  if (result.meta.runtime === 'fixture' && (result.meta.profile !== expectedFixtureProfile
    || result.meta.model !== 'none:fixture' || result.meta.harness !== 'none:fixture')) return fail('RESULT_META_BINDING');
  const summary = result.summary;
  if (!exactKeys(summary, [
    'by_verdict','by_invariant_family','by_class','by_layer','in_process_barriers','accounting',
  ]) || !exactKeys(summary.by_verdict, ['pass','bypass','theater','error','skipped'])
    || Object.values(summary.by_verdict).some(value => !nonNegativeInt(value))
    || !validateCountMap(summary.by_class)
    || !validateCountMap(summary.by_layer)
    || !validateBarrierEvidence(summary.in_process_barriers)
    || !validateInvariantSummary(summary.by_invariant_family, summary.in_process_barriers)
    || !exactKeys(summary.accounting, [
      'runner_driven_count','runner_error_denominator','host_acceptance_required',
      'host_acceptance_verified','kernel_acceptance_executed','outcome_reference_replays',
    ]) || Object.values(summary.accounting).some(value => !nonNegativeInt(value))) return fail('RESULT_SUMMARY');
  if (result.results.some(row => !validateResultRow(row))) return fail('RESULT_ROW');
  const exactCounts = (field, expected) => {
    const actual = {};
    for (const row of result.results) actual[row[field]] = (actual[row[field]] || 0) + 1;
    return JSON.stringify(Object.fromEntries(Object.entries(actual).sort()))
      === JSON.stringify(Object.fromEntries(Object.entries(expected).sort()));
  };
  const verdictCounts = Object.fromEntries([...VERDICTS].map(value => [value, 0]));
  for (const row of result.results) verdictCounts[row.verdict] += 1;
  if (JSON.stringify(verdictCounts) !== JSON.stringify(summary.by_verdict)
    || !exactCounts('class', summary.by_class) || !exactCounts('layer', summary.by_layer)) return fail('RESULT_COUNTS');
  const kernel = result.results.filter(row => row.layer === 'kernel-invariant');
  const outcome = result.results.filter(row => row.layer === 'outcome');
  const expectedAccounting = {
    runner_driven_count: kernel.filter(row => row.id !== 'allow-review-import-111').length,
    runner_error_denominator: kernel.filter(row => row.id !== 'allow-review-import-111').length,
    host_acceptance_required: kernel.filter(row => row.id === 'allow-review-import-111').length,
    host_acceptance_verified: kernel.filter(row => row.id === 'allow-review-import-111'
      && row.host_evidence_status === 'pass' && row.host_acceptance_verified === 1).length,
    kernel_acceptance_executed: kernel.filter(row => acceptanceExecuted(row)).length,
    outcome_reference_replays: outcome.reduce((total, row) => total + row.reference_replay.trial_count, 0),
  };
  if (!exactKeys(summary.accounting, Object.keys(expectedAccounting))
    || Object.entries(expectedAccounting).some(([key, value]) => summary.accounting[key] !== value)) return fail('RESULT_ACCOUNTING');
  if (result.kernel_findings.some(item => !exactKeys(item, ['task_id','kind','verdict','observation_class'])
    || !nonEmptyString(item.task_id) || !['kernel-invariant-contradiction','outcome-trial-failure'].includes(item.kind)
    || !VERDICTS.has(item.verdict) || (item.observation_class !== null && !OBS.has(item.observation_class)))) return fail('RESULT_FINDINGS');
  const expectedFindings = result.results.filter(row => (row.layer === 'kernel-invariant'
    && row.id !== 'allow-review-import-111' && row.verdict !== 'pass')
    || (row.layer === 'outcome' && row.outcome_pass !== true)).map(row => ({
    task_id: row.id,
    kind: row.layer === 'kernel-invariant' ? 'kernel-invariant-contradiction' : 'outcome-trial-failure',
    verdict: row.verdict,
    observation_class: row.observation_class || null,
  })).sort((left, right) => left.task_id.localeCompare(right.task_id));
  const actualFindings = [...result.kernel_findings].sort((left, right) => left.task_id.localeCompare(right.task_id));
  if (JSON.stringify(actualFindings) !== JSON.stringify(expectedFindings)) return fail('RESULT_FINDINGS_SEMANTICS');
  const comparisonProfiles = new Set(['host-native','deep-loop-kernel-minimal','deep-loop-current-v1.22','deep-loop-experimental']);
  if (result.profile_comparison_stub.some(row => !exactKeys(row, [
    'task_id','profile','outcome_pass','agency_loss_incident','harness_block_incident','hard_safety_invariant_violated','attribution',
  ]) || !nonEmptyString(row.task_id) || !comparisonProfiles.has(row.profile)
    || typeof row.outcome_pass !== 'boolean' || typeof row.agency_loss_incident !== 'boolean'
    || typeof row.harness_block_incident !== 'boolean' || typeof row.hard_safety_invariant_violated !== 'boolean'
    || !ATTRIBUTIONS.has(row.attribution)
    || (row.outcome_pass && (row.attribution !== 'not-applicable' || row.agency_loss_incident))
    || (row.agency_loss_incident && (row.outcome_pass || !['harness-constraint','procedural-rigidity'].includes(row.attribution)
      || row.hard_safety_invariant_violated)))) return fail('RESULT_PROFILE_COMPARISON');
  for (const row of result.profile_comparison_stub.filter(item => item.agency_loss_incident)) {
    if (row.profile !== 'deep-loop-experimental') return fail('RESULT_AGENCY_PROFILE');
    const counterpart = result.profile_comparison_stub.some(item => item.task_id === row.task_id
      && ['host-native','deep-loop-current-v1.22'].includes(item.profile) && item.outcome_pass === true);
    if (!counterpart) return fail('RESULT_AGENCY_COUNTERFACTUAL');
  }
  if (bank !== undefined && !validateResultTaskBank(result, bank)) return fail('RESULT_TASK_BINDING');
  return { ok: true, value: result };
}

export function readTask(file) {
  const task = JSON.parse(readFileSync(file, 'utf8'));
  const validated = validateTask(task);
  if (!validated.ok) throw new Error(`${validated.code}: ${file}`);
  return task;
}

export function taskFile(root, id) {
  return join(root, 'evals', 'tasks', `${id}.json`);
}
