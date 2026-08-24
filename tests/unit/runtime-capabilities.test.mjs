import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SESSION_RUNTIMES, RUNTIME_CAPABILITIES, runtimeCapability, skillToken, assertRuntimePlatform } from '../../scripts/lib/runtime.mjs';
import { isHeadlessInvocation } from '../../scripts/lib/respawn.mjs';
import { validateRuntimeProfile } from '../../scripts/lib/session-profile.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walkScripts(dir = join(repoRoot, 'scripts'), out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkScripts(full, out);
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const FIELDS = [
  'skill_token_style', 'provider_label', 'usage_output_kind', 'entrypoint_heuristic',
  'desktop_transport', 'unattended_checker', 'requires_process_preflight',
  'requires_process_receipt_settlement', 'requires_posix_visible_executable_trust',
  'max_effort_supported', 'executable_name', 'version_probe',
  'supported_platforms', 'measured_headless', 'session_effort_allowed',
  'compact_supported', 'handoff_continuity_note', 'observation_runtime',
];

test('every session runtime has every capability field', () => {
  for (const runtime of SESSION_RUNTIMES) {
    const row = RUNTIME_CAPABILITIES[runtime];
    assert.ok(row, `no capability row for ${runtime}`);
    for (const field of FIELDS) {
      assert.ok(Object.hasOwn(row, field), `${runtime} is missing ${field}`);
    }
    assert.equal(Object.keys(row).length, FIELDS.length, `${runtime} has unexpected fields`);
  }
});

test('capability table has no row beyond SESSION_RUNTIMES', () => {
  assert.deepEqual(Object.keys(RUNTIME_CAPABILITIES).sort(), [...SESSION_RUNTIMES].sort());
});

test('an unknown runtime throws instead of falling back', () => {
  assert.throws(() => runtimeCapability('unknown-runtime', 'skill_token_style'), /INVALID_RUNTIME/);
  assert.throws(() => runtimeCapability('', 'skill_token_style'), /INVALID_RUNTIME/);
});

test('an unknown field throws instead of returning undefined', () => {
  assert.throws(() => runtimeCapability('claude', 'no_such_field'), /UNKNOWN_RUNTIME_CAPABILITY/);
});

test('current values match today behavior', () => {
  assert.equal(runtimeCapability('claude', 'skill_token_style'), 'slash');
  assert.equal(runtimeCapability('codex', 'skill_token_style'), 'dollar');
  assert.equal(runtimeCapability('claude', 'provider_label'), 'claude-code');
  assert.equal(runtimeCapability('codex', 'provider_label'), 'codex');
  assert.equal(runtimeCapability('claude', 'usage_output_kind'), 'claude-json');
  assert.equal(runtimeCapability('codex', 'usage_output_kind'), 'codex-jsonl');
  assert.equal(runtimeCapability('claude', 'entrypoint_heuristic'), 'claude-code');
  assert.equal(runtimeCapability('codex', 'entrypoint_heuristic'), null);
  assert.equal(runtimeCapability('claude', 'desktop_transport'), true);
  assert.equal(runtimeCapability('codex', 'desktop_transport'), false);
  assert.equal(runtimeCapability('claude', 'max_effort_supported'), true);
  assert.equal(runtimeCapability('codex', 'max_effort_supported'), false);
  assert.equal(runtimeCapability('claude', 'executable_name'), 'claude');
  assert.equal(runtimeCapability('codex', 'executable_name'), 'codex');
  assert.equal(runtimeCapability('claude', 'unattended_checker'), false);
  assert.equal(runtimeCapability('codex', 'unattended_checker'), true);
  assert.equal(runtimeCapability('claude', 'requires_process_preflight'), false);
  assert.equal(runtimeCapability('codex', 'requires_process_preflight'), true);
  assert.equal(runtimeCapability('claude', 'requires_process_receipt_settlement'), false);
  assert.equal(runtimeCapability('codex', 'requires_process_receipt_settlement'), true);
  assert.equal(runtimeCapability('claude', 'requires_posix_visible_executable_trust'), false);
  assert.equal(runtimeCapability('codex', 'requires_posix_visible_executable_trust'), true);
  assert.equal(runtimeCapability('claude', 'version_probe'), 'claude');
  assert.equal(runtimeCapability('codex', 'version_probe'), 'codex');
  assert.deepEqual(runtimeCapability('claude', 'supported_platforms'), ['darwin', 'linux', 'win32']);
  assert.deepEqual(runtimeCapability('codex', 'supported_platforms'), ['darwin', 'linux', 'win32']);
  assert.equal(runtimeCapability('claude', 'measured_headless'), true);
  assert.equal(runtimeCapability('codex', 'measured_headless'), true);
  assert.equal(runtimeCapability('claude', 'session_effort_allowed'), 'kernel-set');
  assert.equal(runtimeCapability('codex', 'session_effort_allowed'), 'kernel-set');
  assert.equal(runtimeCapability('claude', 'compact_supported'), true);
  assert.equal(runtimeCapability('codex', 'compact_supported'), true);
  assert.equal(runtimeCapability('claude', 'handoff_continuity_note'), 'desktop-model-effort');
  assert.equal(runtimeCapability('codex', 'handoff_continuity_note'), 'codex-preflight');
  assert.equal(runtimeCapability('claude', 'observation_runtime'), 'claude_code');
  assert.equal(runtimeCapability('codex', 'observation_runtime'), 'codex');
});

test('assertRuntimePlatform accepts current hosts and rejects others without falling back', () => {
  for (const runtime of SESSION_RUNTIMES) {
    const allowed = runtimeCapability(runtime, 'supported_platforms');
    for (const platform of allowed) {
      assert.equal(assertRuntimePlatform(runtime, platform), undefined);
    }
    for (const platform of ['darwin', 'linux', 'win32'].filter(value => !allowed.includes(value))) {
      assert.throws(
        () => assertRuntimePlatform(runtime, platform),
        { message: `UNSUPPORTED_RUNTIME_PLATFORM: ${runtime} on ${platform}`, code: 'UNSUPPORTED_RUNTIME_PLATFORM' },
      );
    }
    assert.throws(
      () => assertRuntimePlatform(runtime, 'aix'),
      { message: `UNSUPPORTED_RUNTIME_PLATFORM: ${runtime} on aix`, code: 'UNSUPPORTED_RUNTIME_PLATFORM' },
    );
  }
  assert.throws(() => assertRuntimePlatform('unknown-runtime', 'darwin'), /INVALID_RUNTIME/);
});

test('every capability field has at least one production consumer', () => {
  // 필드 이름이 scripts/ 어딘가에서 실제로 조회되는지 확인한다. 소비자 없는 필드는
  // 테이블을 사실이 아닌 문서로 만든다.
  // Match actual lookups, not the table declaration (which writes `field: value`).
  const sources = walkScripts().map(f => readFileSync(f, 'utf8')).join('\n');
  for (const field of FIELDS) {
    const lookup = new RegExp(`runtimeCapability\\([^\\n]*'${field}'`);
    assert.match(sources, lookup, `capability ${field} has no runtimeCapability(...) consumer`);
  }
});

test('skillToken renders the host-correct invocation', () => {
  assert.equal(skillToken('claude', 'deep-loop-resume'), '/deep-loop-resume');
  assert.equal(skillToken('codex', 'deep-loop-resume'), '$deep-loop:deep-loop-resume');
  assert.equal(skillToken('claude', 'deep-loop-compact restore'), '/deep-loop-compact restore');
  assert.equal(skillToken('codex', 'deep-loop-compact restore'), '$deep-loop:deep-loop-compact restore');
});

test('skillToken throws for an unknown runtime', () => {
  assert.throws(() => skillToken('unknown-runtime', 'deep-loop-resume'), /INVALID_RUNTIME/);
});

test('grok skill token is slash', () => {
  assert.equal(skillToken('grok', 'deep-loop-resume'), '/deep-loop-resume');
});

test('grok rejects every effort at profile', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.throws(() => validateRuntimeProfile('grok', { effort }), /UNSUPPORTED_RUNTIME_EFFORT/);
  }
});

test('isHeadlessInvocation throws for an unknown runtime without driver markers', () => {
  assert.throws(
    () => isHeadlessInvocation({ CLAUDE_CODE_ENTRYPOINT: 'sdk-py' }, 'unknown-runtime'),
    /INVALID_RUNTIME/,
  );
});

test('isHeadlessInvocation ignores Claude entrypoint on grok', () => {
  assert.equal(isHeadlessInvocation({ CLAUDE_CODE_ENTRYPOINT: 'sdk-py' }, 'grok'), false);
  assert.equal(isHeadlessInvocation({ DEEP_LOOP_HEADLESS: '1' }, 'grok'), true);
});

test('the table is deeply frozen', () => {
  assert.ok(Object.isFrozen(RUNTIME_CAPABILITIES));
  for (const runtime of SESSION_RUNTIMES) assert.ok(Object.isFrozen(RUNTIME_CAPABILITIES[runtime]));
});

test('loop-run.schema.json runtime enum matches SESSION_RUNTIMES', () => {
  const schema = JSON.parse(readFileSync(join(repoRoot, 'schemas/loop-run.schema.json'), 'utf8'));
  assert.deepEqual(
    [...schema.enums['autonomy.session_runtime']].sort(),
    [...SESSION_RUNTIMES].sort(),
  );
});

test('the CI workflow WAL validator enum matches SESSION_RUNTIMES', () => {
  const yml = readFileSync(join(repoRoot, 'recipes/automation/github-actions-loop.yml'), 'utf8');
  const expected = SESSION_RUNTIMES.map(r => `'${r}'`).join(', ');
  assert.ok(
    yml.includes(`![${expected}].includes(manifest.runtime)`),
    'recipes/automation/github-actions-loop.yml duplicates the WAL manifest runtime check; '
    + 'it must be updated whenever SESSION_RUNTIMES changes',
  );
});
