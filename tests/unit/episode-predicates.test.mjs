import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  epOrder,
  isProofCapableChecker,
} from '../../scripts/lib/episode-predicates.mjs';

const LIB_DIR = fileURLToPath(new URL('../../scripts/lib/', import.meta.url));

test('epOrder compares numeric episode prefixes across the 999 to 1000 boundary', () => {
  assert.ok(epOrder('999-x', '1000-x') < 0);
  assert.ok(epOrder('1000-x', '999-x') > 0);
  assert.ok(epOrder('m1', 'm2') < 0);
  assert.ok(epOrder('m2', 'm1') > 0);
  assert.equal(epOrder('same', 'same'), 0);
});

test('isProofCapableChecker admits only supported checker plugins', () => {
  assert.equal(isProofCapableChecker({ role: 'checker', plugin: 'deep-review' }), true);
  assert.equal(isProofCapableChecker({ role: 'checker', plugin: 'subagent-checker' }), true);
  assert.equal(isProofCapableChecker({ role: 'checker', plugin: 'standalone' }), false);
  assert.equal(isProofCapableChecker({ role: 'maker', plugin: 'deep-review' }), false);
  assert.equal(isProofCapableChecker(undefined), false);
  assert.equal(isProofCapableChecker(null), false);
});

test('episode predicates have one dependency-neutral source', () => {
  const files = readdirSync(LIB_DIR).filter(name => name.endsWith('.mjs'));
  const source = files.map(name => readFileSync(join(LIB_DIR, name), 'utf8')).join('\n');
  assert.equal((source.match(/export const epOrder/g) || []).length, 1);
  assert.equal((source.match(/export const isProofCapableChecker/g) || []).length, 1);

  const predicateSource = readFileSync(join(LIB_DIR, 'episode-predicates.mjs'), 'utf8');
  assert.doesNotMatch(predicateSource, /from '\.\//);
});
