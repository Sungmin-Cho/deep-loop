import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { assertLexicalRelativePath } from '../lib/lexical-path.mjs';
import { evalChildEnv } from '../lib/child-env.mjs';

const MAX = 64 * 1024;
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

function safeNodeTest(root, command, profile, { nodeMajor, forbiddenEffects }) {
  if (!SAFE_COMMANDS.has(JSON.stringify(command))) throw new Error('OUTCOME_COMMAND_FORBIDDEN');
  assertFixtureProfile(profile);
  if (forbiddenEffects.includes('network-write') && nodeMajor < 24) {
    throw new Error('OUTCOME_NETWORK_BOUNDARY_UNAVAILABLE');
  }
  const base = realpathSync(root);
  const entry = command[2] || '.eval/verify-outcome.test.mjs';
  const target = containedFile(base, entry);
  const executedArgv = [permissionFlag(nodeMajor), `--allow-fs-read=${base}`, target];
  const result = spawnSync(process.execPath, executedArgv, {
    cwd: base, env: evalChildEnv(),
    encoding: 'utf8', timeout: 30_000, maxBuffer: MAX,
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const exit = result.status ?? 1;
  return {
    check: { type: 'command', pass: exit === 0 && !timedOut, exit },
    receipt: {
      schema_version: 1,
      boundary: `node-permission-model:${permissionFlag(nodeMajor).slice(2)}`,
      covered_effects: nodeMajor >= 24
        ? ['child-process','file-write','network-write'] : ['child-process','file-write'],
      profile_id: profile.id,
      allowed_effects: [...profile.allowed_effects],
      declared_command: [...command],
      executed_argv: executedArgv.map(token => token === target ? entry
        : token === `--allow-fs-read=${base}` ? '--allow-fs-read=<FIXTURE_ROOT>' : token),
      exit,
      timed_out: timedOut,
      observed_effects: [],
      passed: exit === 0 && !timedOut,
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
  profile, nodeMajor = Number(process.versions.node.split('.')[0]), forbiddenEffects = [],
} = {}) {
  const graded = acceptance.map(item => gradeOne(root, item, profile, { nodeMajor, forbiddenEffects }));
  const checks = graded.map(item => item.check);
  const receipts = graded.map(item => item.receipt).filter(Boolean);
  if (receipts.length !== 1) throw new Error('OUTCOME_EXECUTION_RECEIPT_REQUIRED');
  return {
    pass: checks.length > 0 && checks.every(check => check.pass), checked: checks.length, checks,
    effect_receipt: receipts[0],
  };
}
