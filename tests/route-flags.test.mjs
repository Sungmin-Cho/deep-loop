import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN_REVIEW,
  ROUTE_FLAGS,
  allowedNames,
  suggestFlag,
  vocabulary,
} from '../scripts/lib/route-flags.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'deep-loop.mjs');

const EXPECTED_KEYS = Object.freeze([
  'path resolve', 'validate', 'detect-plugins', 'recipe-match',
  'run list', 'run resolve',
  'root diagnose', 'root rebind', 'root recover', 'root recovery acquire',
  'runtime-executable diagnose', 'runtime-executable approve',
  'launcher-executable diagnose', 'launcher-executable approve',
  'init-run', 'next-action', 'resume-command', 'tick',
  'checkpoint emit', 'checkpoint inspect', 'checkpoint observe', 'checkpoint restore',
  'lease check', 'lease acquire', 'lease release',
  'workstream new', 'workstream set', 'workstream terminal',
  'episode new', 'episode record', 'episode abandon',
  'review configure', 'review dispatch', 'review record', 'review import',
  'review bridge-probe',
  'handoff emit', 'respawn', 'state get', 'state patch',
  'pause', 'recover', 'recovery acquire', 'adapter resolve',
  'budget check', 'budget record', 'budget extend',
  'comprehension status', 'comprehension ack',
  'breaker check', 'breaker reset',
  'insights', 'insights latest', 'insights emit',
  'spawn-style probe-desktop', 'spawn-style offer-desktop', 'spawn-style confirm-desktop',
  'spawn-style decline-desktop', 'spawn-style reset-desktop',
  'attended-launch approve', 'attended-launch revoke',
  'session-profile set', 'detect-terminal', 'finish',
]);

function invoke(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('ROUTE_FLAGS lists every rawRouteKey the dispatcher can produce', () => {
  assert.deepEqual(Object.keys(ROUTE_FLAGS).sort(), [...EXPECTED_KEYS].sort());
  assert.equal(EXPECTED_KEYS.length, 64);
  const source = readFileSync(CLI, 'utf8');
  const inventory = source.match(/const MUTATING_ROUTE_INVENTORY = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(inventory);
  const mutating = [...inventory.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(mutating.filter((key) => !Object.hasOwn(ROUTE_FLAGS, key)), []);
});

test('unknown flags are usage exit 2 and do not treat verbs as flags', () => {
  const typo = invoke(['episode', 'record', '--generatoin', '1', '--id', 'e1', '--status', 'done', '--run-id', 'RUN']);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /unknown flag --generatoin for route `episode record`/);
  assert.match(typo.stderr, /did you mean: --generation/);
  assert.match(typo.stderr, /--project-root/);
  assert.match(typo.stderr, /--run-id/);
  assert.match(typo.stderr, /--now/);

  const verb = invoke(['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'plan', '--point', 'plan']);
  assert.notEqual(verb.stderr.includes('unknown flag: new'), true);
  assert.notEqual(verb.stderr.includes('unknown episode verb: --plugin'), true);

  const missing = invoke(['episode', 'not-a-verb', '--plugin', 'x']);
  assert.equal(missing.status, 2);

  const stray = invoke(['episode', 'record', '--id', 'e1', 'stray', '--status', 'done', '--run-id', 'RUN']);
  assert.equal(stray.status, 2);
  assert.match(stray.stderr, /unexpected positional `stray`/);
  assert.doesNotMatch(stray.stderr, /unknown flag --id/);

  const empty = invoke(['state', 'get', '--', '--project-root', 'x', '--run-id', 'RUN']);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /unknown flag -- /);
  assert.doesNotMatch(empty.stderr, /unexpected positional/);

  const eqEmpty = invoke(['state', 'get', '--=x', '--project-root', 'x', '--run-id', 'RUN']);
  assert.equal(eqEmpty.status, 2);
  assert.match(eqEmpty.stderr, /unknown flag -- /);
  assert.doesNotMatch(eqEmpty.stderr, /unexpected positional/);
});

test('did you mean fires only for a unique distance-2 candidate', () => {
  assert.equal(suggestFlag('generatoin', ['generation', 'owner']), 'generation');
  assert.equal(suggestFlag('id', ['episode', 'owner']), null);
  assert.equal(suggestFlag('abc', ['abd', 'adc']), null);
  assert.equal(suggestFlag('x'.repeat(65), ['generation']), null);
});

test('state get accepts unread --json used by recipes', () => {
  const { root, runId } = seededReviewArgs();
  const locator = ['--project-root', root, '--run-id', runId];
  const withJson = invoke(['state', 'get', '--field', 'status', '--json', ...locator]);
  const without = invoke(['state', 'get', '--field', 'status', ...locator]);
  assert.equal(withJson.status, 0, withJson.stderr);
  assert.equal(without.status, 0, without.stderr);
  assert.equal(JSON.parse(withJson.stdout), 'running');
  assert.equal(withJson.stdout, without.stdout);

  const whole = invoke(['state', 'get', '--json', ...locator]);
  assert.equal(whole.status, 0, whole.stderr);
  assert.equal(JSON.parse(whole.stdout).status, 'running');
});

function seededReviewArgs() {
  const root = mkdtempSync(join(tmpdir(), 'dl-flag-review-'));
  const created = invoke(['init-run', '--runtime', 'claude', '--goal', 'g', '--protocol', 'standalone', '--project-root', root]);
  assert.equal(created.status, 0, created.stderr);
  const runId = JSON.parse(created.stdout).run_id;
  return { root, runId };
}

for (const route of ['review record', 'review import']) {
  for (const flag of FORBIDDEN_REVIEW) {
    test(`${route} rejects --${flag} with REVIEW_METADATA_FORBIDDEN`, () => {
      const { root, runId } = seededReviewArgs();
      const args = route === 'review import'
        ? ['review', 'import', `--${flag}`, 'x', '--stdin', '--owner', runId, '--generation', '1', '--project-root', root, '--run-id', runId]
        : ['review', 'record', '--episode', 'e', '--verdict', 'APPROVE', `--${flag}`, 'x', '--owner', runId, '--generation', '1', '--project-root', root, '--run-id', runId];
      const result = invoke(args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /REVIEW_METADATA_FORBIDDEN/);
    });
  }
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function routeKeyFromTokens(tokens) {
  const positionals = tokens.filter((token) => token && !token.startsWith('--') && !token.startsWith('<') && !token.startsWith("'"));
  if (positionals.length === 0) return null;
  if (positionals[0] === 'root' && positionals[1] === 'recovery') {
    const key = `root recovery ${positionals[2] || ''}`.trim();
    return Object.hasOwn(ROUTE_FLAGS, key) ? key : null;
  }
  if (positionals[1] && Object.hasOwn(ROUTE_FLAGS, `${positionals[0]} ${positionals[1]}`)) {
    return `${positionals[0]} ${positionals[1]}`;
  }
  return Object.hasOwn(ROUTE_FLAGS, positionals[0]) ? positionals[0] : null;
}

function extractSkillPairs(source) {
  const pairs = [];
  const lineRe = /deep-loop\.mjs"\s+([^\n]+)/g;
  let match;
  while ((match = lineRe.exec(source))) {
    const tokens = match[1].trim().split(/\s+/);
    const key = routeKeyFromTokens(tokens);
    if (!key) continue;
    for (const token of tokens) {
      if (!token.startsWith('--')) continue;
      const flag = token.replace(/^--/, '').replace(/=.*/, '').replace(/[>"'].*$/, '');
      if (flag) pairs.push([key, flag]);
    }
  }
  return pairs;
}

function extractArrayInvocationPairs(source) {
  const pairs = [];
  const blockRe = /deep-loop\.mjs['"]\s*,\s*\[([\s\S]*?)\]/g;
  let match;
  while ((match = blockRe.exec(source))) {
    const tokens = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]);
    const key = routeKeyFromTokens(tokens);
    if (!key) continue;
    for (const token of tokens) {
      if (token.startsWith('--')) pairs.push([key, token.slice(2).split('=')[0]]);
    }
  }
  return pairs;
}

function extractQuotedRoutePairs(source) {
  const pairs = [];
  const blockRe = /\[[^\]]{0,4000}\]/g;
  let match;
  while ((match = blockRe.exec(source))) {
    const tokens = [...match[0].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]);
    const key = routeKeyFromTokens(tokens);
    if (!key) continue;
    for (const token of tokens) {
      if (token.startsWith('--')) pairs.push([key, token.slice(2).split('=')[0]]);
    }
  }
  return pairs;
}

function landingPairs(source) {
  const pairs = [...extractSkillPairs(source), ...extractArrayInvocationPairs(source)];
  if (source.includes('deep-loop.mjs')) pairs.push(...extractQuotedRoutePairs(source));
  return pairs;
}

function isLandingSource(file) {
  return ['.md', '.yml', '.yaml', '.js', '.mjs', '.json'].some((ext) => file.endsWith(ext));
}

const SCRIPT_LANDING_EXEMPT = Object.freeze({
  'scripts/lib/headless-host.mjs': 'kernel path snapshot only; no CLI argv',
});

function extractTestPairs(source) {
  const pairs = [];
  const unresolved = [];
  if (/`--\$\{/.test(source) && !/for \(const \[name/.test(source) && !/FORBIDDEN_REVIEW/.test(source)) {
    unresolved.push('unresolved --${} interpolation');
  }
  const arrayRe = /\[((?:'[^']*'|"[^"]*"|\s|,)+)\]/g;
  let match;
  while ((match = arrayRe.exec(source))) {
    const tokens = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]);
    const key = routeKeyFromTokens(tokens);
    if (!key) continue;
    for (const token of tokens) {
      if (token.startsWith('--')) pairs.push([key, token.slice(2).split('=')[0]]);
    }
  }
  return { pairs, unresolved };
}

test('skill and test (route, flag) pairs are a subset of LOCATOR union allow', () => {
  const allVocab = new Set(Object.values(ROUTE_FLAGS).flatMap((spec) => [...vocabulary(spec)]));
  const missingKeys = [];
  const missingFlags = [];
  const unresolved = [];
  const unreadOutsideAllow = [];
  for (const [key, spec] of Object.entries(ROUTE_FLAGS)) {
    for (const name of spec.unread || []) {
      if (!spec.allow.includes(name)) unreadOutsideAllow.push(`${key} unread --${name}`);
    }
  }
  const silentScripts = [];
  for (const file of [
    ...walkFiles(join(ROOT, 'skills')),
    ...walkFiles(join(ROOT, 'recipes')),
    ...walkFiles(join(ROOT, 'scripts')),
  ]) {
    if (!isLandingSource(file)) continue;
    const source = readFileSync(file, 'utf8');
    const pairs = landingPairs(source);
    const rel = file.slice(ROOT.length + 1).split(/[\\/]/).join('/');
    if (rel.startsWith('scripts/') && source.includes('deep-loop.mjs')
      && pairs.length === 0 && !Object.hasOwn(SCRIPT_LANDING_EXEMPT, rel)) {
      silentScripts.push(rel);
    }
    for (const [route, flag] of pairs) {
      const spec = ROUTE_FLAGS[route];
      if (!spec) { missingKeys.push(`${file}:${route}`); continue; }
      if (!allowedNames(spec).includes(flag)) missingFlags.push(`${file}:${route} --${flag}`);
    }
  }
  for (const file of walkFiles(join(ROOT, 'tests'))) {
    if (!file.endsWith('.test.mjs')) continue;
    const source = readFileSync(file, 'utf8');
    if (!/deep-loop\.mjs/.test(source) && !/\bCLI\b/.test(source)) continue;
    const extracted = extractTestPairs(source);
    unresolved.push(...extracted.unresolved.map((item) => `${file}:${item}`));
    for (const [route, flag] of extracted.pairs) {
      if (!allVocab.has(flag)) continue;
      const spec = ROUTE_FLAGS[route];
      if (!spec) { missingKeys.push(`${file}:${route}`); continue; }
      if (!allowedNames(spec).includes(flag) && !(spec.rejected || []).includes(flag)) {
        missingFlags.push(`${file}:${route} --${flag}`);
      }
    }
  }
  assert.deepEqual(unreadOutsideAllow, []);
  assert.deepEqual(silentScripts, []);
  assert.deepEqual(unresolved, []);
  assert.deepEqual(missingKeys, []);
  assert.deepEqual(missingFlags, []);

  const recipe = readFileSync(join(ROOT, 'recipes', 'automation', 'github-actions-loop.yml'), 'utf8');
  assert.ok(
    extractArrayInvocationPairs(recipe).some(([route, flag]) => route === 'state get' && flag === 'json'),
    'recipe argv array must contribute state get --json',
  );
  const observe = readFileSync(join(ROOT, 'scripts', 'hooks-impl', 'postcompact-observe.mjs'), 'utf8');
  assert.ok(
    extractQuotedRoutePairs(observe).some(([route, flag]) => route === 'checkpoint observe' && flag === 'json'),
    'postcompact observe argv must contribute checkpoint observe --json',
  );
});
