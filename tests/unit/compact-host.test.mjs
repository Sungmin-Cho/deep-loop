import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  classifyCompactHost,
  classifyCompactHostForLoop,
  compactSupportedOnHost,
} from '../../scripts/lib/runtime.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeSrc = readFileSync(join(repoRoot, 'scripts', 'lib', 'runtime.mjs'), 'utf8');

function loopFor(runtime, approval = null) {
  return {
    autonomy: {
      session_runtime: runtime,
      runtime_source: 'skill-asserted',
      runtime_executable_approval: approval,
    },
  };
}

test('classifyCompactHost empty-allowlist / missing-approval / runtime-mismatch / foreign-semver / claude-null-approval', () => {
  assert.equal(classifyCompactHost({
    compact_supported: true,
    compact_measured_cli_versions: Object.freeze([]),
    approval: { runtime: 'grok', version: '1.0.5' },
    session_runtime: 'grok',
  }), 'unsupported');

  assert.equal(classifyCompactHost({
    compact_supported: true,
    compact_measured_cli_versions: Object.freeze(['1.0.5']),
    approval: null,
    session_runtime: 'grok',
  }), 'needs-approval');

  assert.equal(classifyCompactHost({
    compact_supported: true,
    compact_measured_cli_versions: Object.freeze(['1.0.5']),
    approval: { runtime: 'claude', version: '1.0.5' },
    session_runtime: 'grok',
  }), 'needs-approval');

  assert.equal(classifyCompactHost({
    compact_supported: true,
    compact_measured_cli_versions: Object.freeze(['9.9.9']),
    approval: { runtime: 'grok', version: '1.0.4' },
    session_runtime: 'grok',
  }), 'version-mismatch');

  assert.equal(classifyCompactHost({
    compact_supported: true,
    compact_measured_cli_versions: null,
    approval: null,
    session_runtime: 'claude',
  }), 'enabled');
});

test('advice states: enabled and needs-approval only', () => {
  const advice = (state) => state === 'enabled' || state === 'needs-approval';
  assert.equal(advice(classifyCompactHost({
    compact_supported: true,
    compact_measured_cli_versions: Object.freeze([]),
    approval: null,
    session_runtime: 'grok',
  })), false);
  assert.equal(advice(classifyCompactHost({
    compact_supported: true,
    compact_measured_cli_versions: Object.freeze(['1.0.5']),
    approval: null,
    session_runtime: 'grok',
  })), true);
  assert.equal(advice(classifyCompactHost({
    compact_supported: true,
    compact_measured_cli_versions: Object.freeze(['9.9.9']),
    approval: { runtime: 'grok', version: '1.0.4' },
    session_runtime: 'grok',
  })), false);
  assert.equal(advice(classifyCompactHost({
    compact_supported: true,
    compact_measured_cli_versions: Object.freeze(['1.0.5']),
    approval: { runtime: 'grok', version: '1.0.5' },
    session_runtime: 'grok',
  })), true);
});

test('compactSupportedOnHost is classifyCompactHostForLoop === enabled', () => {
  assert.equal(compactSupportedOnHost(loopFor('claude', null)), true);
  assert.equal(classifyCompactHostForLoop(loopFor('claude', null)), 'enabled');
  assert.equal(compactSupportedOnHost(loopFor('codex', null)), true);
  assert.equal(compactSupportedOnHost(loopFor('grok', null)), false);
  assert.equal(classifyCompactHostForLoop(loopFor('grok', { runtime: 'grok', version: '1.0.4' })), 'unsupported');
});

test('compactSupportedOnHost signature has no cliVersion', () => {
  assert.match(runtimeSrc, /export function compactSupportedOnHost\(loop\)/);
  assert.match(runtimeSrc, /export function classifyCompactHostForLoop\(loop\)/);
  assert.doesNotMatch(runtimeSrc, /cliVersion/);
});
