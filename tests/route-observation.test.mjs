import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDirectoryJunction, createFileSymlink, fixtureDir } from './helpers/fs-fixtures.mjs';
import {
  MANIFEST_MAX_FILE_BYTES,
  OBSERVATION_MAX_FILE_BYTES,
  OBSERVATION_REASONS,
  compareExistingObservation,
  emitRouteObservation,
  observeTerminalEpisode,
  readBoundedNoFollow,
  readFlags,
  readKernelManifestVersion,
  subjectSha256,
} from '../scripts/lib/route-observation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'scripts', 'lib', 'route-observation.mjs');
const ATOMIC = join(HERE, '..', 'scripts', 'lib', 'atomic-write.mjs');
const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const EVENT_TS = '2026-08-24T02:10:11.204Z';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);

function fakeStat({ size, dev = 1n, ino = 2n, mtimeNs = 3n, file = true, symlink = false } = {}) {
  return {
    size: BigInt(size),
    dev,
    ino,
    mtimeNs,
    birthtimeNs: 4n,
    isFile: () => file,
    isSymbolicLink: () => symlink,
  };
}

function routing() {
  return {
    request: { task_class: 'IMPLEMENTATION' },
    decision: {
      route_schema_version: 1,
      router_plugin_version: '1.4.0',
      policy_sha256: HEX_A,
      decision_fingerprint: HEX_B,
      request_sha256: HEX_C,
    },
    selected_model: 'claude-fable-5',
    selected_effort_native: 'high',
    effective_policy: {},
    provenance: 'router',
  };
}

function emissionFixture({ runtime = 'claude' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-route-observation-'));
  const run = join(root, '.deep-loop', 'runs', RUN_ID);
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'loop.json'), 'LOOP-SENTINEL');
  writeFileSync(join(run, 'event-log.jsonl'), 'EVENT-SENTINEL\n');
  const episode = {
    id: 'ep-01',
    plugin: 'deep-work',
    role: 'maker',
    kind: 'implementation',
    point: 'implementation',
    workstream_id: 'ws-01',
    status: 'done',
    request_rel: 'episodes/ep-01/request.md',
    routing: routing(),
  };
  const loop = {
    schema_version: '0.4.0',
    run_id: RUN_ID,
    project: { root, head: 'abcdef1', branch: 'feat/route-observation', dirty: false },
    autonomy: {
      session_runtime: runtime,
      runtime_source: 'skill-asserted',
      session_model: 'claude-fable-5',
      session_effort: 'high',
    },
    session_chain: { parent_run_id: null, lease: { owner_run_id: RUN_ID } },
    workstreams: [{ id: 'ws-01', base_commit: '1234567' }],
    episodes: [episode],
  };
  const options = {
    loop,
    event: { seq: 7, ts: EVENT_TS, data: { id: episode.id, status: 'done' } },
    episodeId: episode.id,
    terminalStatus: 'done',
    kernelVersion: '1.22.0',
  };
  const subject = subjectSha256({ producer: 'deep-loop', run_id: RUN_ID, artifact_id: episode.id });
  const dir = join(run, 'observations');
  const path = join(dir, `${subject}.json`);
  return { root, run, dir, path, subject, loop, episode, options };
}

function tmpEntries(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path).filter(name => name.startsWith('.tmp-'));
}

function rebindObservationParentForCompare(f, bytes, variant, label) {
  const moved = `${f.dir}-${label}-moved`;
  const filename = `${f.subject}.json`;
  renameSync(f.dir, moved);
  let external = null;
  let reboundFile = null;
  if (variant === 'replacement') {
    mkdirSync(f.dir);
    reboundFile = f.path;
    writeFileSync(reboundFile, bytes);
  } else if (variant === 'symlink') {
    external = fixtureDir(`dl-compare-${label}-external-`);
    reboundFile = join(external, filename);
    writeFileSync(reboundFile, bytes);
    createDirectoryJunction(external, f.dir);
  }
  return {
    moved,
    external,
    reboundFile,
    reboundBytes: reboundFile ? readFileSync(reboundFile) : null,
    reboundEntries: external ? readdirSync(external) : null,
  };
}

function assertUnsafeCompareRebind(f, bytes, variant, rebound) {
  assert.equal(readFileSync(join(rebound.moved, `${f.subject}.json`)).equals(bytes), true, variant);
  assert.equal(tmpEntries(rebound.moved).length, 0, variant);
  if (rebound.reboundFile) {
    assert.equal(readFileSync(rebound.reboundFile).equals(rebound.reboundBytes), true, variant);
  }
  if (rebound.external) assert.deepEqual(readdirSync(rebound.external), rebound.reboundEntries, variant);
}

function makeRouterStub({ version = '1.4.0' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-router-stub-'));
  const scripts = join(root, 'skills', 'model-router', 'scripts');
  const pluginDir = join(root, '.claude-plugin');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(pluginDir, { recursive: true });
  const routeTask = join(scripts, 'route_task.py');
  const validator = join(scripts, 'validate_observation.py');
  const marker = join(root, 'validator-calls.jsonl');
  writeFileSync(routeTask, '');
  writeFileSync(validator, [
    'import json, os, signal, sys, time',
    'with open(os.environ["DEEP_LOOP_ROUTE_OBSERVATION_STUB_MARKER"], "a", encoding="utf-8") as f:',
    '  f.write(json.dumps({"argv": sys.argv[1:], "mark": os.environ.get("DEEP_LOOP_ROUTE_OBSERVATION_STUB_MARK")}) + "\\n")',
    'mode = os.environ.get("DEEP_LOOP_ROUTE_OBSERVATION_STUB_MODE", "valid")',
    'if mode == "invalid":',
    '  sys.stderr.write("I-STRING: /Users/private/secret exceeds 128 bytes\\n")',
    '  raise SystemExit(1)',
    'if mode == "traceback":',
    '  sys.stderr.write("Traceback /Users/private/secret\\n")',
    '  raise SystemExit(1)',
    'if mode == "usage": raise SystemExit(2)',
    'if mode == "signal": os.kill(os.getpid(), signal.SIGKILL)',
    'if mode == "max-buffer":',
    '  sys.stdout.write("x" * (1024 * 1024))',
    '  sys.stdout.flush()',
    'raise SystemExit(0)',
  ].join('\n'));
  const manifest = JSON.stringify({ name: 'deep-model-router', version });
  writeFileSync(join(root, 'package.json'), manifest);
  writeFileSync(join(pluginDir, 'plugin.json'), manifest);
  return { root, routeTask, validator, marker };
}

function validationOptions(fixture, stub, overrides = {}) {
  return {
    ...fixture.options,
    env: {
      ...process.env,
      DEEP_LOOP_ROUTE_OBSERVATION_VALIDATE: '1',
      DEEP_MODEL_ROUTER_CLI: stub.routeTask,
      DEEP_LOOP_ROUTE_OBSERVATION_STUB_MARKER: stub.marker,
      DEEP_LOOP_ROUTE_OBSERVATION_STUB_MARK: 'from-options-env',
      ...overrides,
    },
    home: mkdtempSync(join(tmpdir(), 'dl-empty-home-')),
  };
}

test('readFlags always returns an integer and uses O_NOFOLLOW only on POSIX', () => {
  const constants = { O_RDONLY: 2, O_NOFOLLOW: 8 };
  assert.equal(readFlags('win32', constants), 2);
  assert.equal(readFlags('linux', constants), 10);
  assert.equal(Number.isInteger(readFlags('darwin', constants)), true);
});

test('generic bounded reader admits 64 KiB, allocates one growth byte, and rejects 64 KiB plus one before open', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-bounded-reader-'));
  for (const size of [65_535, 65_536]) {
    const path = join(root, `manifest-${size}.json`);
    writeFileSync(path, Buffer.alloc(size, 0x61));
    const allocations = [];
    const result = readBoundedNoFollow(path, MANIFEST_MAX_FILE_BYTES, {
      allocFn: sizeRequested => {
        allocations.push(sizeRequested);
        return Buffer.allocUnsafe(sizeRequested);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.bytes.length, size);
    assert.deepEqual(allocations, [65_537]);
  }

  const tooLarge = join(root, 'manifest-65537.json');
  writeFileSync(tooLarge, Buffer.alloc(65_537, 0x62));
  let opens = 0;
  const result = readBoundedNoFollow(tooLarge, MANIFEST_MAX_FILE_BYTES, {
    openFn: (...args) => { opens += 1; return fs.openSync(...args); },
  });
  assert.equal(result.ok, false);
  assert.equal(opens, 0);
  assert.equal(statSync(tooLarge).size, 65_537);
});

test('generic bounded reader rejects invalid bounds before allocation, stat, or open with its own error code', () => {
  for (const invalid of [0, -1, 1.5, 'x', NaN, null, 65_537, Number.MAX_SAFE_INTEGER]) {
    let allocations = 0;
    let stats = 0;
    let opens = 0;
    assert.throws(() => readBoundedNoFollow('/does/not/matter', invalid, {
      allocFn: () => { allocations += 1; return Buffer.alloc(1); },
      lstatFn: () => { stats += 1; return fakeStat({ size: 0 }); },
      openFn: () => { opens += 1; return 1; },
    }), { name: 'RangeError', message: 'BOUNDED_READ_MAX_BYTES_INVALID' });
    assert.equal(allocations, 0);
    assert.equal(stats, 0);
    assert.equal(opens, 0);
  }
});

test('manifest wrapper returns only structured semver success or failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-manifest-reader-'));
  const good = join(root, 'good.json');
  writeFileSync(good, JSON.stringify({ version: '9.9.9' }));
  assert.deepEqual(readKernelManifestVersion(good), { ok: true, version: '9.9.9' });

  const invalid = join(root, 'invalid.json');
  writeFileSync(invalid, JSON.stringify({ version: 'legacy' }));
  assert.deepEqual(readKernelManifestVersion(invalid), { ok: false });

  const huge = join(root, 'huge.json');
  writeFileSync(huge, Buffer.alloc(65_537, 0x20));
  assert.deepEqual(readKernelManifestVersion(huge), { ok: false });
  assert.deepEqual(readKernelManifestVersion(join(root, 'missing.json')), { ok: false });

  const target = join(root, 'target.json');
  const link = join(root, 'link.json');
  writeFileSync(target, JSON.stringify({ version: '1.2.3' }));
  createFileSymlink(target, link);
  let opens = 0;
  assert.deepEqual(readKernelManifestVersion(link, { openFn: () => { opens += 1; return 1; } }), { ok: false });
  assert.equal(opens, 0);
});

test('existing observation compare is idempotent, bounded, no-follow, and exact-length', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-compare-existing-'));
  const bytes = Buffer.from('same bytes');
  const path = join(root, 'observation.json');
  writeFileSync(path, bytes);
  assert.deepEqual(compareExistingObservation(path, bytes, {
    maxFileBytes: OBSERVATION_MAX_FILE_BYTES,
    platform: process.platform,
  }), { emitted: true, created: false });
  assert.deepEqual(compareExistingObservation(path, Buffer.from('different!'), {
    maxFileBytes: OBSERVATION_MAX_FILE_BYTES,
    platform: process.platform,
  }), { emitted: false, reason: 'observation-collision' });

  const oversized = join(root, 'oversized.json');
  writeFileSync(oversized, Buffer.alloc(OBSERVATION_MAX_FILE_BYTES + 1));
  let opens = 0;
  assert.deepEqual(compareExistingObservation(oversized, bytes, {
    maxFileBytes: OBSERVATION_MAX_FILE_BYTES,
    platform: process.platform,
    openFn: () => { opens += 1; return 1; },
  }), { emitted: false, reason: 'observation-collision' });
  assert.equal(opens, 0);

  const target = join(root, 'target.json');
  const link = join(root, 'symlink.json');
  writeFileSync(target, bytes);
  createFileSymlink(target, link);
  assert.deepEqual(compareExistingObservation(link, bytes, {
    maxFileBytes: OBSERVATION_MAX_FILE_BYTES,
    platform: process.platform,
    openFn: () => { opens += 1; return 1; },
  }), { emitted: false, reason: 'observation-collision' });
  assert.equal(opens, 0);
});

test('existing compare detects growth and replacement and closes descriptors on read failure', () => {
  const expected = Buffer.from('abc');
  const before = fakeStat({ size: expected.length, dev: 4n, ino: 5n });
  let reads = 0;
  let closes = 0;
  const growth = compareExistingObservation('/virtual', expected, {
    maxFileBytes: 16,
    platform: 'linux',
    lstatFn: () => before,
    openFn: () => 11,
    fstatFn: () => before,
    readFn: (_fd, buffer, offset) => {
      reads += 1;
      if (reads === 1) { expected.copy(buffer, offset); return expected.length; }
      if (reads === 2) { buffer[offset] = 0x78; return 1; }
      throw new Error('READ_AFTER_GROWTH');
    },
    closeFn: () => { closes += 1; },
    constants: { O_RDONLY: 2, O_NOFOLLOW: 8 },
  });
  assert.deepEqual(growth, { emitted: false, reason: 'observation-collision' });
  assert.equal(reads, 2);
  assert.equal(closes, 1);

  const replacement = compareExistingObservation('/virtual', expected, {
    maxFileBytes: 16,
    platform: 'linux',
    lstatFn: () => before,
    openFn: () => 12,
    fstatFn: () => fakeStat({ size: expected.length, dev: 4n, ino: 6n }),
    readFn: () => 0,
    closeFn: () => {},
    constants: { O_RDONLY: 2, O_NOFOLLOW: 8 },
  });
  assert.deepEqual(replacement, { emitted: false, reason: 'observation-collision' });

  closes = 0;
  assert.throws(() => compareExistingObservation('/virtual', expected, {
    maxFileBytes: 16,
    platform: 'linux',
    lstatFn: () => before,
    openFn: () => 13,
    fstatFn: () => before,
    readFn: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); },
    closeFn: () => { closes += 1; },
    constants: { O_RDONLY: 2, O_NOFOLLOW: 8 },
  }), { code: 'EIO' });
  assert.equal(closes, 1);
});

test('win32 compare fails closed on zero or changed identity and uses O_RDONLY on a stable file', () => {
  const bytes = Buffer.from('abc');
  let opens = 0;
  assert.deepEqual(compareExistingObservation('/virtual', bytes, {
    maxFileBytes: 16,
    platform: 'win32',
    lstatFn: () => fakeStat({ size: bytes.length, dev: 0n, ino: 0n }),
    openFn: () => { opens += 1; return 1; },
  }), { emitted: false, reason: 'observation-collision' });
  assert.equal(opens, 0);

  const missingIdentity = fakeStat({ size: bytes.length });
  delete missingIdentity.dev;
  delete missingIdentity.ino;
  assert.deepEqual(compareExistingObservation('/virtual', bytes, {
    maxFileBytes: 16,
    platform: 'win32',
    lstatFn: () => missingIdentity,
    openFn: () => { opens += 1; return 99; },
    fstatFn: () => missingIdentity,
    readFn: () => 0,
    closeFn: () => {},
  }), { emitted: false, reason: 'observation-collision' });
  assert.equal(opens, 0);

  const before = fakeStat({ size: bytes.length, dev: 8n, ino: 9n });
  assert.deepEqual(compareExistingObservation('/virtual', bytes, {
    maxFileBytes: 16,
    platform: 'win32',
    lstatFn: () => before,
    openFn: () => 1,
    fstatFn: () => fakeStat({ size: bytes.length, dev: 0n, ino: 0n }),
    readFn: () => 0,
    closeFn: () => {},
  }), { emitted: false, reason: 'observation-collision' });

  let flags;
  let reads = 0;
  assert.deepEqual(compareExistingObservation('/virtual', bytes, {
    maxFileBytes: 16,
    platform: 'win32',
    lstatFn: () => before,
    openFn: (_path, passed) => { flags = passed; return 1; },
    fstatFn: () => before,
    readFn: (_fd, buffer, offset) => {
      reads += 1;
      if (reads === 1) { bytes.copy(buffer, offset); return bytes.length; }
      return 0;
    },
    closeFn: () => {},
    constants: { O_RDONLY: 2, O_NOFOLLOW: 8 },
  }), { emitted: true, created: false });
  assert.equal(flags, 2);
});

test('existing compare rejects observation bounds before any filesystem call', () => {
  for (const invalid of [16_385, 32_769, Number.MAX_SAFE_INTEGER]) {
    let stats = 0;
    let opens = 0;
    assert.throws(() => compareExistingObservation('/virtual', Buffer.alloc(1), {
      maxFileBytes: invalid,
      lstatFn: () => { stats += 1; return fakeStat({ size: 1 }); },
      openFn: () => { opens += 1; return 1; },
    }), { name: 'RangeError', message: 'OBSERVATION_MAX_FILE_BYTES_INVALID' });
    assert.equal(stats, 0);
    assert.equal(opens, 0);
  }
  assert.throws(() => compareExistingObservation('/virtual', Buffer.alloc(1), {
    maxFileBytes: MANIFEST_MAX_FILE_BYTES,
  }), { name: 'RangeError', message: 'OBSERVATION_MAX_FILE_BYTES_INVALID' });
});

test('emitter creates a 0600 deterministic file and a second call is byte-idempotent', () => {
  const f = emissionFixture();
  const first = emitRouteObservation(f.root, RUN_ID, f.options);
  assert.equal(first.emitted, true);
  assert.equal(first.created, true);
  assert.equal(first.path, `observations/${f.subject}.json`);
  assert.equal(first.subject_sha256, f.subject);
  assert.equal(first.sha256, createHash('sha256').update(readFileSync(f.path)).digest('hex'));
  assert.doesNotThrow(() => JSON.parse(readFileSync(f.path, 'utf8')));
  if (process.platform !== 'win32') assert.equal(statSync(f.path).mode & 0o777, 0o600);
  const before = readFileSync(f.path);
  const second = emitRouteObservation(f.root, RUN_ID, structuredClone(f.options));
  assert.deepEqual(second, { ...first, created: false });
  assert.equal(readFileSync(f.path).equals(before), true);
});

test('emitter maps differing, oversized, and symlink destinations to collision without clobbering', () => {
  for (const variant of ['different', 'oversized', 'symlink']) {
    const f = emissionFixture();
    mkdirSync(f.dir);
    let protectedPath = f.path;
    if (variant === 'different') writeFileSync(f.path, 'different');
    if (variant === 'oversized') writeFileSync(f.path, Buffer.alloc(OBSERVATION_MAX_FILE_BYTES + 1));
    if (variant === 'symlink') {
      protectedPath = join(f.root, 'protected-target');
      writeFileSync(protectedPath, 'protected');
      createFileSymlink(protectedPath, f.path);
    }
    const before = readFileSync(protectedPath);
    const result = emitRouteObservation(f.root, RUN_ID, f.options);
    assert.deepEqual(result, { emitted: false, reason: 'observation-collision' }, variant);
    assert.equal(readFileSync(protectedPath).equals(before), true, variant);
  }
});

test('pre-existing compare path fails open when its observation parent is rebound during comparison', () => {
  for (const variant of ['replacement', 'symlink', 'dangling']) {
    const f = emissionFixture();
    const first = emitRouteObservation(f.root, RUN_ID, f.options);
    assert.equal(first.emitted, true, variant);
    const bytes = readFileSync(f.path);
    let compareCalls = 0;
    let rebound;
    const result = emitRouteObservation(f.root, RUN_ID, f.options, {
      compareExistingFn: (abs, expected, deps) => {
        compareCalls += 1;
        rebound = rebindObservationParentForCompare(f, expected, variant, 'fast');
        return compareExistingObservation(abs, expected, deps);
      },
    });
    assert.deepEqual(result, { emitted: false, reason: 'observation-directory-unsafe' }, variant);
    assert.equal(compareCalls, 1, variant);
    assertUnsafeCompareRebind(f, bytes, variant, rebound);
  }
});

test('EEXIST recompare path fails open when its observation parent is rebound during comparison', () => {
  for (const variant of ['replacement', 'symlink', 'dangling']) {
    const f = emissionFixture();
    let linkCalls = 0;
    let compareCalls = 0;
    let winnerBytes;
    let rebound;
    const result = emitRouteObservation(f.root, RUN_ID, f.options, {
      atomicCreateDeps: {
        linkFn: (src, dst) => {
          linkCalls += 1;
          winnerBytes = readFileSync(src);
          writeFileSync(dst, winnerBytes, { flag: 'wx', mode: 0o600 });
          return linkSync(src, dst);
        },
      },
      compareExistingFn: (abs, expected, deps) => {
        compareCalls += 1;
        rebound = rebindObservationParentForCompare(f, expected, variant, 'eexist');
        return compareExistingObservation(abs, expected, deps);
      },
    });
    assert.deepEqual(result, { emitted: false, reason: 'observation-directory-unsafe' }, variant);
    assert.equal(linkCalls, 1, variant);
    assert.equal(compareCalls, 1, variant);
    assertUnsafeCompareRebind(f, winnerBytes, variant, rebound);
  }
});

test('emitter and wrapper preserve expected fail-open reasons and bounded warnings', () => {
  const f = emissionFixture();
  const invalidSnapshots = [
    { ...f.options, loop: 42 },
    { ...f.options, event: null },
    { ...f.options, episodeId: '' },
    { ...f.options, terminalStatus: 'weird' },
  ];
  for (const options of invalidSnapshots) {
    assert.deepEqual(emitRouteObservation(f.root, RUN_ID, options),
      { emitted: false, reason: 'snapshot-invalid' });
  }

  const warnings = [];
  const structured = observeTerminalEpisode(f.root, RUN_ID, { ...f.options, loop: 42 }, {
    stderr: { write: text => warnings.push(text) },
  });
  assert.deepEqual(structured, { emitted: false, reason: 'snapshot-invalid' });
  assert.match(warnings.join(''), /snapshot-invalid/);

  const broken = structuredClone(f.options);
  broken.loop.autonomy.session_runtime = 'weird';
  assert.throws(() => emitRouteObservation(f.root, RUN_ID, broken), /INVALID_RUNTIME/);
  const caught = observeTerminalEpisode(f.root, RUN_ID, broken, {
    stderr: { write: text => warnings.push(text) },
  });
  assert.deepEqual(caught, { emitted: false, reason: 'observation-failed' });
  assert.match(warnings.join(''), /observation-failed \(INVALID_RUNTIME\)/);
  assert.equal(existsSync(f.dir), false);
});

test('fail-open wrapper survives a throwing stderr getter without changing the structured reason', () => {
  const f = emissionFixture();
  const internal = {};
  Object.defineProperty(internal, 'stderr', {
    enumerable: true,
    get() { throw new Error('stderr getter failed'); },
  });
  let result;
  assert.doesNotThrow(() => {
    result = observeTerminalEpisode(f.root, RUN_ID, { ...f.options, loop: 42 }, internal);
  });
  assert.deepEqual(result, { emitted: false, reason: 'snapshot-invalid' });
});

test('emitter validates maxFileBytes first and maps reachable size and kernel-version failures', () => {
  const f = emissionFixture();
  assert.deepEqual(emitRouteObservation(f.root, RUN_ID, { ...f.options, maxFileBytes: 512 }),
    { emitted: false, reason: 'observation-too-large' });
  assert.equal(existsSync(f.dir), false);

  for (const invalid of [0, -1, 'x', 1.5, 16_385, 32_769, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => emitRouteObservation(f.root, RUN_ID, { ...f.options, loop: 42, maxFileBytes: invalid }),
      { name: 'RangeError', message: 'OBSERVATION_MAX_FILE_BYTES_INVALID' });
    assert.equal(existsSync(f.dir), false);
  }
  assert.deepEqual(observeTerminalEpisode(f.root, RUN_ID, { ...f.options, maxFileBytes: 16_385 }, {
    stderr: { write: () => {} },
  }), { emitted: false, reason: 'observation-failed' });
  assert.deepEqual(emitRouteObservation(f.root, RUN_ID, { ...f.options, kernelVersion: 'legacy' }),
    { emitted: false, reason: 'kernel-version-unavailable' });
  const injected = emitRouteObservation(f.root, RUN_ID, { ...f.options, kernelVersion: '9.9.9' });
  assert.equal(injected.emitted, true);
  const document = JSON.parse(readFileSync(f.path, 'utf8'));
  assert.equal(document.envelope.producer_version, '9.9.9');
  assert.equal(document.envelope.provenance.tool_versions['deep-loop'], '9.9.9');

  rmSync(f.dir, { recursive: true });
  const fromManifest = { ...f.options };
  delete fromManifest.kernelVersion;
  const emitted = emitRouteObservation(f.root, RUN_ID, fromManifest);
  assert.equal(emitted.emitted, true);
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).envelope.producer_version, '1.22.1');
});

test('omitted kernelVersion reads the loaded deep-loop manifest for an ordinary consumer project', () => {
  const f = emissionFixture();
  assert.equal(existsSync(join(f.root, '.claude-plugin')), false);
  const options = { ...f.options };
  delete options.kernelVersion;
  const result = emitRouteObservation(f.root, RUN_ID, options);
  assert.equal(result.emitted, true);
  const actualVersion = JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  assert.equal(actualVersion, '1.22.1');
  const document = JSON.parse(readFileSync(f.path, 'utf8'));
  assert.equal(document.envelope.producer_version, actualVersion);
  assert.equal(document.envelope.provenance.tool_versions['deep-loop'], actualVersion);
});

test('project-local plugin manifest cannot spoof the loaded deep-loop producer version', () => {
  const f = emissionFixture();
  mkdirSync(join(f.root, '.claude-plugin'));
  writeFileSync(join(f.root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '9.9.9' }));
  const options = { ...f.options };
  delete options.kernelVersion;
  const result = emitRouteObservation(f.root, RUN_ID, options);
  assert.equal(result.emitted, true);
  const actualVersion = JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const document = JSON.parse(readFileSync(f.path, 'utf8'));
  assert.equal(document.envelope.producer_version, actualVersion);
  assert.equal(document.envelope.producer_version === '9.9.9', false);
});

test('emitter rejects unsafe observation and dangling or symlink run directories before mkdir', () => {
  const symlinkedObservation = emissionFixture();
  const outside = mkdtempSync(join(tmpdir(), 'dl-observation-outside-'));
  createDirectoryJunction(outside, symlinkedObservation.dir);
  assert.deepEqual(emitRouteObservation(symlinkedObservation.root, RUN_ID, symlinkedObservation.options),
    { emitted: false, reason: 'observation-directory-unsafe' });
  assert.deepEqual(readdirSync(outside), []);

  for (const variant of ['missing', 'symlink']) {
    const f = emissionFixture();
    rmSync(f.run, { recursive: true });
    if (variant === 'symlink') createDirectoryJunction(outside, f.run);
    let mkdirCalls = 0;
    assert.deepEqual(emitRouteObservation(f.root, RUN_ID, f.options, {
      mkdirFn: (...args) => { mkdirCalls += 1; return mkdirSync(...args); },
    }), { emitted: false, reason: 'observation-directory-unsafe' });
    assert.equal(mkdirCalls, 0);
  }
});

test('run-directory identity is rechecked before and after mkdir and detects the documented mkdir window', () => {
  const pre = emissionFixture();
  const movedPre = `${pre.run}-moved`;
  let mkdirCalls = 0;
  const preResult = emitRouteObservation(pre.root, RUN_ID, pre.options, {
    directoryBarrierAt: stage => {
      if (stage === 'before-mkdir-check') {
        renameSync(pre.run, movedPre);
        mkdirSync(pre.run);
      }
    },
    mkdirFn: (...args) => { mkdirCalls += 1; return mkdirSync(...args); },
  });
  assert.deepEqual(preResult, { emitted: false, reason: 'observation-directory-unsafe' });
  assert.equal(mkdirCalls, 0);
  assert.equal(existsSync(join(pre.run, 'observations')), false);
  assert.equal(existsSync(join(movedPre, 'observations')), false);

  const post = emissionFixture();
  const movedPost = `${post.run}-moved`;
  const postResult = emitRouteObservation(post.root, RUN_ID, post.options, {
    mkdirFn: (...args) => {
      const result = mkdirSync(...args);
      renameSync(post.run, movedPost);
      mkdirSync(post.run);
      return result;
    },
  });
  assert.deepEqual(postResult, { emitted: false, reason: 'observation-directory-unsafe' });
  assert.equal(existsSync(join(movedPost, 'observations')), true);
  assert.equal(existsSync(join(post.run, 'observations')), false);

  const window = emissionFixture();
  const movedWindow = `${window.run}-moved`;
  const external = mkdtempSync(join(tmpdir(), 'dl-mkdir-window-'));
  const windowResult = emitRouteObservation(window.root, RUN_ID, window.options, {
    directoryBarrierAt: stage => {
      if (stage === 'mkdir') {
        renameSync(window.run, movedWindow);
        createDirectoryJunction(external, window.run);
      }
    },
  });
  assert.deepEqual(windowResult, { emitted: false, reason: 'observation-directory-unsafe' });
  assert.equal(existsSync(join(external, 'observations')), true);
});

test('parent replacement after temp creation is detected without pathname cleanup', () => {
  for (const variant of ['directory', 'symlink', 'dangling']) {
    const f = emissionFixture();
    const moved = `${f.dir}-moved`;
    const external = mkdtempSync(join(tmpdir(), 'dl-parent-rebind-'));
    let links = 0;
    let unlinks = 0;
    const result = emitRouteObservation(f.root, RUN_ID, f.options, {
      atomicCreateDeps: {
        barrierAt: stage => {
          if (stage === 'file-flush') {
            renameSync(f.dir, moved);
            if (variant === 'directory') mkdirSync(f.dir);
            if (variant === 'symlink') createDirectoryJunction(external, f.dir);
          }
        },
        linkFn: (...args) => { links += 1; return linkSync(...args); },
        unlinkFn: (...args) => { unlinks += 1; return unlinkSync(...args); },
      },
    });
    assert.deepEqual(result, { emitted: false, reason: 'observation-directory-unsafe' }, variant);
    assert.equal(links, 0, variant);
    assert.equal(unlinks, 0, variant);
    assert.equal(tmpEntries(moved).length, 1, variant);
    if (variant === 'directory') assert.deepEqual(readdirSync(f.dir), []);
    if (variant === 'symlink') assert.deepEqual(readdirSync(external), []);
  }
});

test('post-link and pre-cleanup replacement leave the moved original intact and touch no replacement path', () => {
  for (const stageVariant of ['post-link', 'pre-cleanup']) {
    const f = emissionFixture();
    const moved = `${f.dir}-moved`;
    let unlinks = 0;
    const atomicCreateDeps = {
      unlinkFn: (...args) => { unlinks += 1; return unlinkSync(...args); },
    };
    if (stageVariant === 'post-link') {
      atomicCreateDeps.linkFn = (src, dst) => {
        linkSync(src, dst);
        renameSync(f.dir, moved);
        mkdirSync(f.dir);
      };
    } else {
      atomicCreateDeps.barrierAt = stage => {
        if (stage === 'parent-flush') {
          renameSync(f.dir, moved);
          mkdirSync(f.dir);
        }
      };
    }
    const result = emitRouteObservation(f.root, RUN_ID, f.options, { atomicCreateDeps });
    assert.deepEqual(result, { emitted: false, reason: 'observation-directory-unsafe' }, stageVariant);
    assert.equal(unlinks, 0, stageVariant);
    assert.equal(existsSync(join(moved, `${f.subject}.json`)), true, stageVariant);
    assert.equal(tmpEntries(moved).length, 1, stageVariant);
    assert.deepEqual(readdirSync(f.dir), [], stageVariant);
  }
});

test('the pre-write check detects replacement, while the following write window remains explicitly observable', () => {
  const detected = emissionFixture();
  const movedDetected = `${detected.dir}-moved`;
  let writes = 0;
  let links = 0;
  let unlinks = 0;
  const detectedResult = emitRouteObservation(detected.root, RUN_ID, detected.options, {
    atomicCreateDeps: {
      barrierAt: stage => {
        if (stage === 'before-write-check') {
          renameSync(detected.dir, movedDetected);
          mkdirSync(detected.dir);
        }
      },
      writeFn: (...args) => { writes += 1; return fs.writeFileSync(...args); },
      linkFn: (...args) => { links += 1; return linkSync(...args); },
      unlinkFn: (...args) => { unlinks += 1; return unlinkSync(...args); },
    },
  });
  assert.deepEqual(detectedResult, { emitted: false, reason: 'observation-directory-unsafe' });
  assert.equal(writes, 0);
  assert.equal(links, 0);
  assert.equal(unlinks, 0);
  assert.deepEqual(readdirSync(movedDetected), []);
  assert.deepEqual(readdirSync(detected.dir), []);

  const window = emissionFixture();
  const movedWindow = `${window.dir}-moved`;
  const external = mkdtempSync(join(tmpdir(), 'dl-write-window-'));
  let cleanupCalls = 0;
  const windowResult = emitRouteObservation(window.root, RUN_ID, window.options, {
    atomicCreateDeps: {
      barrierAt: stage => {
        if (stage === 'write') {
          renameSync(window.dir, movedWindow);
          createDirectoryJunction(external, window.dir);
        }
      },
      unlinkFn: (...args) => { cleanupCalls += 1; return unlinkSync(...args); },
    },
  });
  assert.deepEqual(windowResult, { emitted: false, reason: 'observation-directory-unsafe' });
  assert.equal(cleanupCalls, 0);
  assert.equal(tmpEntries(external).length, 1);
});

test('the link syscall window is detected on cleanup and never follows the rebound path', () => {
  const f = emissionFixture();
  const moved = `${f.dir}-moved`;
  const external = mkdtempSync(join(tmpdir(), 'dl-link-window-'));
  let unlinks = 0;
  const result = emitRouteObservation(f.root, RUN_ID, f.options, {
    atomicCreateDeps: {
      barrierAt: stage => {
        if (stage === 'link') {
          renameSync(f.dir, moved);
          createDirectoryJunction(external, f.dir);
        }
      },
      unlinkFn: (...args) => { unlinks += 1; return unlinkSync(...args); },
    },
  });
  assert.deepEqual(result, { emitted: false, reason: 'observation-directory-unsafe' });
  assert.equal(unlinks, 0);
  assert.equal(tmpEntries(moved).length, 1);
  assert.deepEqual(readdirSync(external), []);
});

test('publisher maps unsupported and ordinary write failures without leaking unsupported OS codes', () => {
  for (const code of ['ENOTSUP', 'EPERM']) {
    const f = emissionFixture();
    let monotonic = 0;
    const result = emitRouteObservation(f.root, RUN_ID, f.options, {
      platform: 'win32',
      atomicCreateDeps: {
        linkFn: () => { throw Object.assign(new Error(code), { code }); },
        monotonicNowFn: () => { monotonic += 1_001; return monotonic; },
        sleepFn: () => {},
      },
    });
    assert.deepEqual(result, { emitted: false, reason: 'observation-publish-unsupported' });
    assert.equal(Object.hasOwn(result, 'code'), false);
    assert.equal(existsSync(f.path), false);
    assert.equal(tmpEntries(f.dir).length, 0);
    assert.ok(OBSERVATION_REASONS.includes(result.reason));
  }

  const failed = emissionFixture();
  const result = emitRouteObservation(failed.root, RUN_ID, failed.options, {
    atomicCreateFn: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  });
  assert.deepEqual(result, { emitted: false, reason: 'observation-write-failed', code: 'EACCES' });
});

test('one validated platform is carried to compare and create and nested platform injection is rejected', () => {
  const create = emissionFixture();
  let createPlatform;
  const created = emitRouteObservation(create.root, RUN_ID, create.options, {
    platform: 'win32',
    atomicCreateFn: (_path, _bytes, deps) => {
      createPlatform = deps.platform;
      return { created: true };
    },
  });
  assert.equal(created.emitted, true);
  assert.equal(createPlatform, 'win32');

  const compare = emissionFixture();
  mkdirSync(compare.dir);
  writeFileSync(compare.path, 'placeholder');
  let comparePlatform;
  const compared = emitRouteObservation(compare.root, RUN_ID, compare.options, {
    platform: 'win32',
    compareExistingFn: (_path, _bytes, deps) => {
      comparePlatform = deps.platform;
      return { emitted: true, created: false };
    },
  });
  assert.equal(compared.emitted, true);
  assert.equal(comparePlatform, 'win32');

  assert.throws(() => emitRouteObservation(compare.root, RUN_ID, compare.options, {
    platform: 'win32',
    atomicCreateDeps: { platform: 'linux' },
  }), /OBSERVATION_INTERNAL_INVALID/);
  assert.throws(() => emitRouteObservation(compare.root, RUN_ID, compare.options, {
    platform: 'not-a-node-platform',
  }), /OBSERVATION_INTERNAL_INVALID/);
});

test('deleting observations or corrupting the event log cannot change emitted bytes', () => {
  const f = emissionFixture();
  const first = emitRouteObservation(f.root, RUN_ID, f.options);
  assert.equal(first.emitted, true);
  const before = readFileSync(f.path);
  rmSync(f.dir, { recursive: true });
  writeFileSync(join(f.run, 'event-log.jsonl'), 'EVENT-SENTINEL\n{"truncated":');
  const second = emitRouteObservation(f.root, RUN_ID, structuredClone(f.options));
  assert.equal(second.emitted, true);
  assert.equal(second.created, true);
  assert.equal(readFileSync(f.path).equals(before), true);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.path, 'utf8')).payload.attempts[0], 'timing'), false);
});

test('route observation source has no lock, event, log, rename, unbounded-read, or overclaim vocabulary', () => {
  const source = readFileSync(MODULE, 'utf8');
  for (const forbidden of [
    'withLock(', 'withReconciledMutationLock(', 'withFencedReconciledMutationLock(',
    'appendAnchored(', 'appendEvent(', 'writeState(', 'verifyLines(', 'verifyHeadLines(',
    'readLines(', "from './integrity.mjs'", 'durableAtomicWrite(', 'renameSync(', 'readFileSync(',
    'noFollowReadFlags', 'deriveAttemptTiming', 'deriveAttemptUsage', '?? null',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  const comments = `${source}\n${readFileSync(ATOMIC, 'utf8')}`;
  assert.doesNotMatch(comments, /TOCTOU|race-free|race free|prevents|\uacbd\ud569 \ubc29\uc9c0|\ubc29\uc9c0\ud55c\ub2e4/i);
  assert.match(source, /fail-open|detect/i);

  const genericBody = source.slice(source.indexOf('export function readBoundedNoFollow'),
    source.indexOf('export function compareExistingObservation'));
  assert.doesNotMatch(genericBody, /assertMaxFileBytes|OBSERVATION_MAX_FILE_BYTES/);
});

test('validator is default-off and missing-router remains a post-publication unavailable label', () => {
  const disabledFixture = emissionFixture();
  const disabled = emitRouteObservation(disabledFixture.root, RUN_ID, {
    ...disabledFixture.options,
    env: {},
  });
  assert.equal(disabled.emitted, true);
  assert.deepEqual(disabled.validation, { state: 'disabled' });
  assert.equal(existsSync(disabledFixture.path), true);

  const missingFixture = emissionFixture();
  const missing = emitRouteObservation(missingFixture.root, RUN_ID, {
    ...missingFixture.options,
    env: { DEEP_LOOP_ROUTE_OBSERVATION_VALIDATE: '1' },
    home: mkdtempSync(join(tmpdir(), 'dl-router-missing-home-')),
  });
  assert.equal(missing.emitted, true);
  assert.deepEqual(missing.validation, { state: 'unavailable', reason: 'router-missing' });
  assert.equal(existsSync(missingFixture.path), true);
});

test('validator runs after both created and idempotent publication with synchronized install metadata', () => {
  const f = emissionFixture();
  const stub = makeRouterStub();
  const options = validationOptions(f, stub);
  const first = emitRouteObservation(f.root, RUN_ID, options);
  assert.equal(first.created, true);
  assert.deepEqual(first.validation, { state: 'valid', exit_status: 0 });
  const before = readFileSync(f.path);
  const second = emitRouteObservation(f.root, RUN_ID, options);
  assert.equal(second.created, false);
  assert.deepEqual(second.validation, { state: 'valid', exit_status: 0 });
  assert.equal(readFileSync(f.path).equals(before), true);
  const calls = readFileSync(stub.marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2);
  const canonicalRoot = (fs.realpathSync.native || fs.realpathSync)(f.root);
  const canonicalRun = join(canonicalRoot, '.deep-loop', 'runs', RUN_ID);
  const canonicalPath = join(canonicalRun, 'observations', `${f.subject}.json`);
  for (const call of calls) {
    assert.deepEqual(call.argv, ['--file', canonicalPath, '--root', canonicalRun, '--check-refs']);
    assert.equal(call.mark, 'from-options-env');
  }
});

test('validator rejects missing, stale, mismatched, symlinked, or non-regular install metadata without spawn', () => {
  const mutations = [
    stub => unlinkSync(join(stub.root, 'package.json')),
    stub => unlinkSync(join(stub.root, '.claude-plugin', 'plugin.json')),
    stub => {
      const stale = JSON.stringify({ name: 'deep-model-router', version: '1.3.9' });
      writeFileSync(join(stub.root, 'package.json'), stale);
      writeFileSync(join(stub.root, '.claude-plugin', 'plugin.json'), stale);
    },
    stub => writeFileSync(join(stub.root, 'package.json'), JSON.stringify({ name: 'other', version: '1.4.0' })),
    stub => writeFileSync(join(stub.root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'deep-model-router', version: '1.4.1' })),
    stub => {
      const real = `${stub.validator}.real`;
      renameSync(stub.validator, real);
      createFileSymlink(real, stub.validator);
    },
    stub => {
      unlinkSync(stub.validator);
      mkdirSync(stub.validator);
    },
  ];
  for (const mutate of mutations) {
    const f = emissionFixture();
    const stub = makeRouterStub();
    mutate(stub);
    const result = emitRouteObservation(f.root, RUN_ID, validationOptions(f, stub));
    assert.equal(result.emitted, true);
    assert.equal(result.validation.state, 'unavailable');
    assert.ok(['router-missing', 'validator-missing'].includes(result.validation.reason));
    assert.equal(existsSync(stub.marker), false);
    assert.equal(existsSync(f.path), true);
  }
});

test('validator maps exit, signal, buffer, and spawn failures to closed non-sensitive tokens', () => {
  const cases = [
    ['invalid', { state: 'invalid', reason: 'invalid', detail: 'I-STRING', exit_status: 1 }, {}],
    ['traceback', { state: 'invalid', reason: 'invalid', detail: 'unknown', exit_status: 1 }, {}],
    ['usage', { state: 'usage', reason: 'usage', exit_status: 2 }, {}],
    ...(process.platform === 'win32'
      ? []
      : [['signal', { state: 'unavailable', reason: 'signal' }, {}]]),
    ['max-buffer', { state: 'unavailable', reason: 'max-buffer' }, {}],
    ['python-missing', { state: 'unavailable', reason: 'python-unavailable' }, { python: '/nonexistent/python3' }],
  ];
  for (const [mode, expected, extraOptions] of cases) {
    const f = emissionFixture();
    const stub = makeRouterStub();
    const options = validationOptions(f, stub, { DEEP_LOOP_ROUTE_OBSERVATION_STUB_MODE: mode });
    Object.assign(options, extraOptions);
    const result = emitRouteObservation(f.root, RUN_ID, options);
    assert.equal(result.emitted, true, mode);
    assert.deepEqual(result.validation, expected, mode);
    const serialized = JSON.stringify(result.validation);
    assert.equal(serialized.includes(f.root), false, mode);
    assert.equal(serialized.includes(stub.validator), false, mode);
    assert.equal(serialized.includes('ENOENT'), false, mode);
    assert.ok(Object.keys(result.validation).every(key => ['state', 'reason', 'detail', 'exit_status'].includes(key)), mode);
  }
});
