// Verifier tests of integration/grok-hook-fire/verify-hook-fire.mjs
// and path-containment tests of the probe recorder.
// Synthetic JSONL only — never measurements of a live Grok host.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyHookFire } from '../../integration/grok-hook-fire/verify-hook-fire.mjs';
import { recordHookEvent } from '../../integration/grok-hook-fire/probe-plugin/hooks-impl/record-event.mjs';
import { createDirectoryJunction, createFileSymlink } from '../helpers/fs-fixtures.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAPTURE = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const SESSION = 'sess-grok-1';
const NOW0 = '2026-08-10T00:00:00.000Z';
const NOW1 = '2026-08-10T00:00:01.000Z';
const NOW2 = '2026-08-10T00:00:02.000Z';
const VERSION = '1.0.4';
const RECORDER = join(REPO, 'integration/grok-hook-fire/probe-plugin/hooks-impl/record-event.mjs');
const VERIFIER = join(REPO, 'integration/grok-hook-fire/verify-hook-fire.mjs');
const PROBE_HOOKS = join(REPO, 'integration/grok-hook-fire/probe-plugin/hooks/hooks.json');
const DIAG_HOOKS = join(REPO, 'integration/grok-hook-fire/probe-plugin-matcher-diag/hooks/hooks.json');
const RUNBOOK = join(REPO, 'integration/grok-hook-fire/RUNBOOK.md');

function stdinFor(event, extra = {}) {
  if (event === 'PreCompact') {
    return JSON.stringify({
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      session_id: SESSION,
      ...extra,
    });
  }
  if (event === 'PostCompact') {
    return JSON.stringify({
      hook_event_name: 'PostCompact',
      trigger: 'manual',
      cwd: '/tmp/hook-fire-scratch',
      session_id: SESSION,
      ...extra,
    });
  }
  return JSON.stringify({
    hook_event_name: 'SessionStart',
    source: 'compact',
    session_id: SESSION,
    ...extra,
  });
}

function record(event, overrides = {}) {
  const binding = event === 'SessionStart' ? 'SessionStart:compact' : `${event}:*`;
  const received = event === 'PreCompact' ? NOW0 : event === 'PostCompact' ? NOW1 : NOW2;
  return {
    capture_id: CAPTURE,
    seq: 0,
    received_at: received,
    binding_tag: binding,
    argv: ['node', 'record-event.mjs', binding],
    source: 'claude-cache',
    env_subset: {
      CLAUDE_PLUGIN_ROOT: true,
      PLUGIN_ROOT: false,
      GROK_HOME: true,
      CLAUDE_CODE_ENTRYPOINT: false,
    },
    stdin_raw: stdinFor(event),
    ...overrides,
  };
}

function triple(overridesByEvent = {}) {
  return [
    record('PreCompact', overridesByEvent.PreCompact),
    record('PostCompact', overridesByEvent.PostCompact),
    record('SessionStart', overridesByEvent.SessionStart),
  ];
}

function jsonl(records) {
  return `${records.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function verdictOf(records, extra = {}) {
  return verifyHookFire({
    eventsText: jsonl(records),
    capture: CAPTURE,
    source: 'claude-cache',
    version: VERSION,
    ...extra,
  });
}

test('exactly-one-triple PASS', () => {
  const result = verdictOf(triple());
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.ok, true);
});

test('extra event FAIL', () => {
  const rows = triple();
  rows.push(record('PreCompact', { received_at: '2026-08-10T00:00:03.000Z', seq: 1 }));
  assert.equal(verdictOf(rows).verdict, 'FAIL');
});

test('dual-binding in PASS file FAIL', () => {
  const rows = triple();
  rows.push(record('SessionStart', {
    binding_tag: 'SessionStart:*',
    received_at: NOW2,
    seq: 1,
  }));
  assert.equal(verdictOf(rows).verdict, 'FAIL');
});

test('mixed capture_id FAIL', () => {
  const rows = triple({
    SessionStart: { capture_id: OTHER },
  });
  assert.equal(verdictOf(rows).verdict, 'FAIL');
});

test('CLAUDE_CODE_ENTRYPOINT present FAIL', () => {
  const rows = triple({
    PreCompact: {
      env_subset: {
        CLAUDE_PLUGIN_ROOT: true,
        PLUGIN_ROOT: false,
        GROK_HOME: true,
        CLAUDE_CODE_ENTRYPOINT: true,
      },
    },
  });
  assert.equal(verdictOf(rows).verdict, 'FAIL');
});

test('missing session_id FAIL', () => {
  const rows = triple({
    PostCompact: { stdin_raw: stdinFor('PostCompact', { session_id: undefined }) },
  });
  // JSON.stringify drops undefined extra keys; rebuild without session_id.
  rows[1] = record('PostCompact', {
    stdin_raw: JSON.stringify({
      hook_event_name: 'PostCompact',
      trigger: 'manual',
      cwd: '/tmp/hook-fire-scratch',
    }),
  });
  assert.equal(verdictOf(rows).verdict, 'FAIL');
});

test('disagreeing session_id FAIL', () => {
  const rows = triple({
    SessionStart: { stdin_raw: stdinFor('SessionStart', { session_id: 'other-session' }) },
  });
  assert.equal(verdictOf(rows).verdict, 'FAIL');
});

test('partial fire FAIL', () => {
  assert.equal(verdictOf(triple().slice(0, 2)).verdict, 'FAIL');
});

test('wrong order FAIL', () => {
  const rows = [
    record('SessionStart', { received_at: NOW0 }),
    record('PreCompact', { received_at: NOW1 }),
    record('PostCompact', { received_at: NOW2 }),
  ];
  assert.equal(verdictOf(rows).verdict, 'FAIL');
});

test('equal timestamps PASS when type order holds', () => {
  const rows = triple({
    PreCompact: { received_at: NOW0 },
    PostCompact: { received_at: NOW0 },
    SessionStart: { received_at: NOW0 },
  });
  assert.equal(verdictOf(rows).verdict, 'PASS');
});

test('three-record diagnostic-substitution FAIL', () => {
  const rows = triple({
    SessionStart: { binding_tag: 'SessionStart:*' },
  });
  assert.equal(verdictOf(rows).verdict, 'FAIL');
});

test('reverse equal-time FAIL', () => {
  const rows = [
    record('SessionStart', { received_at: NOW0 }),
    record('PostCompact', { received_at: NOW0 }),
    record('PreCompact', { received_at: NOW0 }),
  ];
  assert.equal(verdictOf(rows).verdict, 'FAIL');
});

test('--source mismatch FAIL', () => {
  assert.equal(verdictOf(triple(), { source: 'grok-native' }).verdict, 'FAIL');
});

test('grok-native --source is never PASS', () => {
  const rows = triple({
    PreCompact: { source: 'grok-native' },
    PostCompact: { source: 'grok-native' },
    SessionStart: { source: 'grok-native' },
  });
  assert.equal(verdictOf(rows, { source: 'grok-native' }).verdict, 'FAIL');
  assert.equal(verdictOf(rows, { source: 'claude-cache' }).verdict, 'FAIL');
});

test('malformed JSON FAIL', () => {
  const rows = triple({
    PreCompact: { stdin_raw: '{not-json' },
  });
  assert.equal(verdictOf(rows).verdict, 'FAIL');
});

test('oversized stdin FAIL', () => {
  const huge = `${'a'.repeat((256 * 1024) + 1)}`;
  const rows = triple({
    PreCompact: { stdin_raw: huge },
  });
  assert.equal(verdictOf(rows).verdict, 'FAIL');
});

test('renamed event names FAIL', () => {
  const rows = triple({
    PreCompact: {
      stdin_raw: JSON.stringify({
        hook_event_name: 'precompact',
        trigger: 'manual',
        session_id: SESSION,
      }),
    },
  });
  assert.equal(verdictOf(rows).verdict, 'FAIL');
});

test('stale extra file concatenated FAIL', () => {
  const stale = record('PreCompact', { capture_id: OTHER, received_at: '2026-08-09T00:00:00.000Z' });
  assert.equal(verdictOf([...triple(), stale]).verdict, 'FAIL');
});

test('diagnostic plugin capture is never PASS', () => {
  const hooks = JSON.parse(readFileSync(DIAG_HOOKS, 'utf8'));
  const sessionStart = hooks.hooks.SessionStart || [];
  const matchers = sessionStart.map((entry) => entry.matcher);
  assert.ok(matchers.includes('compact'));
  assert.ok(matchers.includes('*'));
  const rows = [
    ...triple(),
    record('SessionStart', { binding_tag: 'SessionStart:*', seq: 1 }),
  ];
  assert.equal(verdictOf(rows).verdict, 'FAIL');
});

test('production probe hooks.json has exactly three production matchers', () => {
  const hooks = JSON.parse(readFileSync(PROBE_HOOKS, 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PostCompact', 'PreCompact', 'SessionStart']);
  assert.equal(hooks.hooks.PreCompact.length, 1);
  assert.equal(hooks.hooks.PreCompact[0].matcher, '*');
  assert.equal(hooks.hooks.PostCompact.length, 1);
  assert.equal(hooks.hooks.PostCompact[0].matcher, '*');
  assert.equal(hooks.hooks.SessionStart.length, 1);
  assert.equal(hooks.hooks.SessionStart[0].matcher, 'compact');
});

test('RUNBOOK forbids sharing DEEP_LOOP_HOOK_PROBE_CAPTURE with PASS', () => {
  const text = readFileSync(RUNBOOK, 'utf8');
  assert.match(text, /must not share DEEP_LOOP_HOOK_PROBE_CAPTURE/);
  assert.match(text, /probe-plugin-matcher-diag/);
});

test('probe recorder and verifier never spawn and never touch .deep-loop', () => {
  const files = [
    'integration/grok-hook-fire/probe-plugin/hooks-impl/record-event.mjs',
    'integration/grok-hook-fire/probe-plugin-matcher-diag/hooks-impl/record-event.mjs',
    'integration/grok-hook-fire/verify-hook-fire.mjs',
  ];
  for (const rel of files) {
    const src = readFileSync(join(REPO, rel), 'utf8');
    assert.doesNotMatch(src, /child_process|spawnSync|spawn\(/, rel);
    assert.doesNotMatch(src, /checker-bridge|checkpoint\.mjs/, rel);
    assert.doesNotMatch(src, /\.deep-loop\//, rel);
  }
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dl-hook-fire-'));
  const out = join(root, 'out');
  mkdirSync(out);
  return { root, out };
}

async function recordWith(env, stdin, bindingTag = 'PreCompact:*') {
  return recordHookEvent({
    env,
    stdin,
    argv: [process.execPath, RECORDER, bindingTag],
    now: NOW0,
    bindingTag,
  });
}

test('capture_id with slash is rejected', async () => {
  const { root, out } = sandbox();
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'keep');
  const result = await recordWith({
    DEEP_LOOP_HOOK_PROBE_CAPTURE: `${CAPTURE}/x`,
    DEEP_LOOP_HOOK_PROBE_OUT: out,
    DEEP_LOOP_HOOK_PROBE_SOURCE: 'claude-cache',
    GROK_HOME: '/tmp/grok-home',
  }, stdinFor('PreCompact'));
  assert.equal(result.wrote, false);
  assert.equal(existsSync(join(out, `${CAPTURE}.jsonl`)), false);
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
  rmSync(root, { recursive: true, force: true });
});

test('capture_id with .. is rejected', async () => {
  const { root, out } = sandbox();
  const parentFile = join(root, `${CAPTURE}.jsonl`);
  const result = await recordWith({
    DEEP_LOOP_HOOK_PROBE_CAPTURE: `../${CAPTURE}`,
    DEEP_LOOP_HOOK_PROBE_OUT: out,
    DEEP_LOOP_HOOK_PROBE_SOURCE: 'claude-cache',
    GROK_HOME: '/tmp/grok-home',
  }, stdinFor('PreCompact'));
  assert.equal(result.wrote, false);
  assert.equal(existsSync(parentFile), false);
  assert.equal(existsSync(join(out, `${CAPTURE}.jsonl`)), false);
  rmSync(root, { recursive: true, force: true });
});

test('capture_id that is not a ULID is rejected', async () => {
  const { root, out } = sandbox();
  const result = await recordWith({
    DEEP_LOOP_HOOK_PROBE_CAPTURE: 'not-a-ulid',
    DEEP_LOOP_HOOK_PROBE_OUT: out,
    DEEP_LOOP_HOOK_PROBE_SOURCE: 'claude-cache',
    GROK_HOME: '/tmp/grok-home',
  }, stdinFor('PreCompact'));
  assert.equal(result.wrote, false);
  assert.equal(existsSync(join(out, 'not-a-ulid.jsonl')), false);
  rmSync(root, { recursive: true, force: true });
});

test('symlink DEEP_LOOP_HOOK_PROBE_OUT cannot escape', async () => {
  const { root, out } = sandbox();
  const realOut = join(root, 'real-out');
  mkdirSync(realOut);
  rmSync(out, { recursive: true, force: true });
  createDirectoryJunction(realOut, out);
  const secretDir = join(root, 'secret');
  mkdirSync(secretDir);
  const secret = join(secretDir, 'secret.txt');
  writeFileSync(secret, 'untouched');
  const escaped = await recordWith({
    DEEP_LOOP_HOOK_PROBE_CAPTURE: '../secret/secret',
    DEEP_LOOP_HOOK_PROBE_OUT: out,
    DEEP_LOOP_HOOK_PROBE_SOURCE: 'claude-cache',
    GROK_HOME: '/tmp/grok-home',
  }, stdinFor('PreCompact'));
  assert.equal(escaped.wrote, false);
  assert.equal(readFileSync(secret, 'utf8'), 'untouched');
  const ok = await recordWith({
    DEEP_LOOP_HOOK_PROBE_CAPTURE: CAPTURE,
    DEEP_LOOP_HOOK_PROBE_OUT: out,
    DEEP_LOOP_HOOK_PROBE_SOURCE: 'claude-cache',
    GROK_HOME: '/tmp/grok-home',
  }, stdinFor('PreCompact'));
  assert.equal(ok.wrote, true);
  assert.equal(existsSync(join(realOut, `${CAPTURE}.jsonl`)), true);
  assert.equal(existsSync(join(secretDir, `${CAPTURE}.jsonl`)), false);
  rmSync(root, { recursive: true, force: true });
});

test('existing capture jsonl symlink inside the resolved root does not write outside', async () => {
  const { root, out } = sandbox();
  const outside = join(root, 'outside.jsonl');
  writeFileSync(outside, 'original-bytes\n');
  const dest = join(out, `${CAPTURE}.jsonl`);
  createFileSymlink(outside, dest);
  const result = await recordWith({
    DEEP_LOOP_HOOK_PROBE_CAPTURE: CAPTURE,
    DEEP_LOOP_HOOK_PROBE_OUT: out,
    DEEP_LOOP_HOOK_PROBE_SOURCE: 'claude-cache',
    GROK_HOME: '/tmp/grok-home',
  }, stdinFor('PreCompact'));
  assert.equal(result.wrote, false);
  assert.equal(readFileSync(outside, 'utf8'), 'original-bytes\n');
  rmSync(root, { recursive: true, force: true });
});

test('missing capture env writes nothing exit 0', () => {
  const { root, out } = sandbox();
  const spawned = spawnSync(process.execPath, [RECORDER, 'PreCompact:*'], {
    encoding: 'utf8',
    input: stdinFor('PreCompact'),
    env: {
      PATH: process.env.PATH,
      DEEP_LOOP_HOOK_PROBE_OUT: out,
      DEEP_LOOP_HOOK_PROBE_SOURCE: 'claude-cache',
      GROK_HOME: '/tmp/grok-home',
    },
  });
  assert.equal(spawned.status, 0);
  assert.equal(existsSync(join(out, `${CAPTURE}.jsonl`)), false);
  rmSync(root, { recursive: true, force: true });
});

test('verifier CLI last non-empty line is PASS', () => {
  const { root, out } = sandbox();
  const events = join(out, `${CAPTURE}.jsonl`);
  writeFileSync(events, jsonl(triple()));
  const spawned = spawnSync(process.execPath, [
    VERIFIER,
    '--events', events,
    '--capture', CAPTURE,
    '--source', 'claude-cache',
    '--version', VERSION,
  ], { encoding: 'utf8' });
  assert.equal(spawned.status, 0, spawned.stderr);
  const lines = spawned.stdout.split(/\n/).filter((line) => line.length > 0);
  assert.equal(lines.at(-1), 'PASS');
  rmSync(root, { recursive: true, force: true });
});
