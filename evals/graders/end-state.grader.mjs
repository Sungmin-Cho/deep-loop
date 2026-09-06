import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { assertLexicalRelativePath } from '../lib/lexical-path.mjs';
import { executeOutcomeCases } from '../lib/outcome-cases.mjs';

const SAFE_COMMANDS = new Set([
  JSON.stringify(['node', '--test']),
  JSON.stringify(['node', '--test', '.eval/verify-outcome.test.mjs']),
]);

function assertFixtureProfile(profile) {
  if (!profile || profile.id !== 'deep-loop-current-v1.22' || profile.driver !== 'fixture'
    || profile.model !== 'none:fixture' || profile.harness !== 'none:fixture'
    || JSON.stringify(profile.allowed_effects) !== JSON.stringify(['read-only'])
    || JSON.stringify(profile.record?.observables) !== JSON.stringify(['exit', 'effects'])) {
    throw new Error('OUTCOME_PROFILE_EFFECT_BOUNDARY_INVALID');
  }
}

function permissionFlag(major) {
  return major >= 23 ? '--permission' : '--experimental-permission';
}

function safeNodeTest(root, command, profile, {
  nodeMajor, forbiddenEffects, taskId, referenceMode,
}) {
  if (!SAFE_COMMANDS.has(JSON.stringify(command))) throw new Error('OUTCOME_COMMAND_FORBIDDEN');
  assertFixtureProfile(profile);
  if (forbiddenEffects.includes('network-write') && nodeMajor < 24) {
    throw new Error('OUTCOME_NETWORK_BOUNDARY_UNAVAILABLE');
  }
  if (typeof taskId !== 'string') throw new Error('OUTCOME_TASK_ID_REQUIRED');
  const base = realpathSync(root);
  const entry = command[2] || '.eval/verify-outcome.test.mjs';
  const result = executeOutcomeCases(base, taskId, {
    nodeMajor, referenceMode,
  });
  const exit = result.process?.exit ?? 1;
  const timedOut = result.process?.timed_out ?? false;
  const check = {
    type: 'command', pass: result.pass, exit,
    unavailable: result.unavailable === true, reason: result.reason,
    behavior_checks: result.checks,
  };
  if (result.unavailable === true) return { check, receipt: null };
  return {
    check,
    receipt: {
      schema_version: 1,
      boundary: `node-permission-model:${permissionFlag(nodeMajor).slice(2)}+network-api-guard-v1`,
      covered_effects: nodeMajor >= 24
        ? ['child-process','file-write','network-write'] : ['child-process','file-write'],
      profile_id: profile.id,
      allowed_effects: [...profile.allowed_effects],
      declared_command: [...command],
      executed_argv: result.process?.executed_argv
        ?? [permissionFlag(nodeMajor), '--allow-fs-read=<FIXTURE_ROOT>', entry],
      trusted_runner: result.process.trusted_runner,
      node_executable: result.process.node_executable,
      result_protocol_verified: result.process.result_protocol_verified,
      exit,
      timed_out: timedOut,
      observed_effects: [],
      passed: result.pass,
    },
  };
}

function containedFile(root, path) {
  assertLexicalRelativePath(path, 'ACCEPTANCE_PATH_ESCAPE');
  const base = realpathSync(root);
  const candidate = resolve(base, path);
  const rel = relative(base, candidate);
  if (rel.startsWith('..') || isAbsolute(rel) || !statSync(candidate).isFile()) throw new Error('ACCEPTANCE_PATH_ESCAPE');
  return candidate;
}

function pointerGet(document, pointer) {
  if (pointer === '' || pointer === '/') return document;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error('ACCEPTANCE_POINTER_INVALID');
  return pointer.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((value, token) => value?.[token], document);
}

function gradeOne(root, acceptance, profile, boundary) {
  if (acceptance.type === 'command') {
    return safeNodeTest(root, acceptance.command, profile, boundary);
  }
  if (acceptance.type === 'state') {
    const document = JSON.parse(readFileSync(containedFile(root, acceptance.path), 'utf8'));
    const actual = pointerGet(document, acceptance.pointer);
    return { check: { type: 'state', pass: JSON.stringify(actual) === JSON.stringify(acceptance.equals), actual }, receipt: null };
  }
  throw new Error(`OUTCOME_ACCEPTANCE_UNSUPPORTED: ${acceptance.type}`);
}

export function gradeEndState(root, acceptance = [], {
  profile, taskId, nodeMajor = Number(process.versions.node.split('.')[0]), forbiddenEffects = [],
  referenceMode = false,
} = {}) {
  const graded = acceptance.map(item => gradeOne(root, item, profile, {
    nodeMajor, forbiddenEffects, taskId, referenceMode,
  }));
  const checks = graded.map(item => item.check);
  const receipts = graded.map(item => item.receipt).filter(Boolean);
  const unavailable = checks.length > 0 && checks.every(check => check.unavailable === true);
  if (receipts.length !== (unavailable ? 0 : 1)) throw new Error('OUTCOME_EXECUTION_RECEIPT_REQUIRED');
  return {
    pass: checks.length > 0 && checks.every(check => check.pass), checked: checks.length, checks,
    effect_receipt: receipts[0] ?? null,
  };
}
