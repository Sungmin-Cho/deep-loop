import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectoryJunction } from '../helpers/fs-fixtures.mjs';

const atomicApiPromise = import('../../scripts/lib/atomic-write.mjs').catch(() => ({}));
const envelopeApiPromise = import('../../scripts/lib/envelope.mjs');

async function atomicApi() {
  const api = await atomicApiPromise;
  assert.equal(typeof api.renameAtomicWithRetry, 'function', 'renameAtomicWithRetry must be exported');
  assert.equal(typeof api.atomicWrite, 'function', 'atomicWrite must be exported');
  assert.equal(typeof api.durableAtomicWrite, 'function', 'durableAtomicWrite must be exported');
  return api;
}

function sharingError(code) {
  return Object.assign(new Error(`sharing failure: ${code}`), { code });
}

function tempNames(path) {
  return readdirSync(path).filter(name => name.startsWith('.tmp-'));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

test('rename retry window is pinned to one second and envelope re-exports the shared helpers', async () => {
  const api = await atomicApi();
  const envelope = await envelopeApiPromise;
  assert.equal(api.RENAME_RETRY_MAX_ELAPSED_MS, 1_000);
  assert.equal(envelope.renameAtomicWithRetry, api.renameAtomicWithRetry);
  assert.equal(envelope.atomicWrite, api.atomicWrite);
});

for (const code of ['EACCES', 'EPERM', 'EBUSY']) {
  test(`Windows transient ${code} retries the identical rename syscall until success`, async () => {
    const { renameAtomicWithRetry } = await atomicApi();
    const calls = [];
    const sleeps = [];
    let now = 0;
    renameAtomicWithRetry('same-src', 'same-dst', {
      platform: 'win32',
      monotonicNowFn: () => now,
      sleepFn: (ms) => { sleeps.push(ms); now += ms; },
      renameFn: (src, dst) => {
        calls.push([src, dst]);
        if (calls.length < 3) throw sharingError(code);
      },
    });
    assert.deepEqual(calls, [
      ['same-src', 'same-dst'],
      ['same-src', 'same-dst'],
      ['same-src', 'same-dst'],
    ]);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps.every(ms => ms === sleeps[0] && ms > 0), 'backoff must be fixed and positive');
  });
}

test('non-sharing errors fail immediately without sleeping', async () => {
  const { renameAtomicWithRetry } = await atomicApi();
  const expected = sharingError('EIO');
  let attempts = 0;
  let sleeps = 0;
  assert.throws(() => renameAtomicWithRetry('src', 'dst', {
    platform: 'win32',
    monotonicNowFn: () => 0,
    sleepFn: () => { sleeps++; },
    renameFn: () => { attempts++; throw expected; },
  }), error => error === expected);
  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
});

test('transient sharing errors do not retry off Windows', async () => {
  const { renameAtomicWithRetry } = await atomicApi();
  const expected = sharingError('EACCES');
  let attempts = 0;
  let sleeps = 0;
  assert.throws(() => renameAtomicWithRetry('src', 'dst', {
    platform: 'linux',
    monotonicNowFn: () => 0,
    sleepFn: () => { sleeps++; },
    renameFn: () => { attempts++; throw expected; },
  }), error => error === expected);
  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
});

test('retry exhaustion starts no attempt or sleep at or across the monotonic deadline', async () => {
  const { renameAtomicWithRetry, RENAME_RETRY_MAX_ELAPSED_MS } = await atomicApi();
  const expected = sharingError('EBUSY');
  const attemptTimes = [];
  const sleeps = [];
  let now = 0;
  assert.throws(() => renameAtomicWithRetry('src', 'dst', {
    platform: 'win32',
    monotonicNowFn: () => now,
    sleepFn: (ms) => { sleeps.push({ start: now, ms }); now += ms; },
    renameFn: () => { attemptTimes.push(now); throw expected; },
  }), error => error === expected);
  assert.ok(attemptTimes.length > 1, 'an allowlisted Windows error must retry');
  assert.ok(attemptTimes.every(at => at < RENAME_RETRY_MAX_ELAPSED_MS));
  assert.ok(sleeps.every(({ start, ms }) => start < RENAME_RETRY_MAX_ELAPSED_MS
    && start + ms < RENAME_RETRY_MAX_ELAPSED_MS));
  assert.equal(attemptTimes.length, sleeps.length + 1);
});

test('a fresh immediately-pre-retry clock check fences a deadline crossed after sleep', async () => {
  const { renameAtomicWithRetry } = await atomicApi();
  const expected = sharingError('EACCES');
  const clock = [0, 0, 999, 1_000];
  let clockReads = 0;
  let attempts = 0;
  let sleeps = 0;
  assert.throws(() => renameAtomicWithRetry('src', 'dst', {
    platform: 'win32',
    monotonicNowFn: () => clock[clockReads++],
    sleepFn: () => { sleeps++; },
    renameFn: () => { attempts++; throw expected; },
  }), error => error === expected);
  assert.equal(attempts, 1, 'no retry may begin when the fresh clock reaches the deadline');
  assert.equal(sleeps, 1);
  assert.equal(clockReads, 4, 'deadline must be sampled again immediately before retry');
});

test('atomicWrite writes one temp payload and retries only its rename', async () => {
  const { atomicWrite } = await atomicApi();
  const writes = [];
  const renames = [];
  const sleeps = [];
  let now = 0;
  atomicWrite('/virtual/final.json', 'payload', {
    platform: 'win32',
    monotonicNowFn: () => now,
    sleepFn: (ms) => { sleeps.push(ms); now += ms; },
    writeFn: (path, contents) => { writes.push([path, contents]); },
    renameFn: (src, dst) => {
      renames.push([src, dst]);
      if (renames.length < 3) throw sharingError('EPERM');
    },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], 'payload');
  assert.equal(renames.length, 3);
  assert.ok(renames.every(([src, dst]) => src === writes[0][0] && dst === '/virtual/final.json'));
  assert.equal(sleeps.length, 2);
});

test('atomicWrite repeatedly replaces an existing destination', async () => {
  const { atomicWrite } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-replace-'));
  const path = join(root, 'artifact.json');
  atomicWrite(path, 'first');
  atomicWrite(path, 'second');
  assert.equal(readFileSync(path, 'utf8'), 'second');
});

test('durableAtomicWrite orders write, file fsync, rename, then parent-directory fsync', async () => {
  const { durableAtomicWrite } = await atomicApi();
  const calls = [];
  let nextFd = 10;
  const fdKinds = new Map();
  durableAtomicWrite('/virtual/parent/final.bin', Buffer.from('bytes'), {
    platform: 'linux',
    tempPathFactory: () => '/virtual/parent/temp.bin',
    writeFn(path, bytes, options) { calls.push(['write', path, Buffer.from(bytes).toString(), options]); },
    openFn(path, mode) {
      assert.equal(mode, 'r');
      const fd = nextFd++;
      fdKinds.set(fd, path);
      calls.push(['open', path]);
      return fd;
    },
    fsyncFn(fd) { calls.push(['fsync', fdKinds.get(fd)]); },
    closeFn(fd) { calls.push(['close', fdKinds.get(fd)]); },
    renameFn(src, dst) { calls.push(['rename', src, dst]); },
  });
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [
    ['write', '/virtual/parent/temp.bin', 'bytes'],
    ['open', '/virtual/parent/temp.bin'],
    ['fsync', '/virtual/parent/temp.bin'],
    ['close', '/virtual/parent/temp.bin'],
    ['rename', '/virtual/parent/temp.bin', '/virtual/parent/final.bin'],
    ['open', '/virtual/parent'],
    ['fsync', '/virtual/parent'],
    ['close', '/virtual/parent'],
  ]);
});

test('durableAtomicWrite uses a writable Windows temp-file handle and a read-only directory handle', async () => {
  const { durableAtomicWrite } = await atomicApi();
  const opens = [];
  durableAtomicWrite('/virtual/parent/final.bin', Buffer.from('bytes'), {
    platform: 'win32',
    tempPathFactory: () => '/virtual/parent/temp.bin',
    writeFn() {},
    openFn(path, mode) {
      opens.push([path, mode]);
      if (path === '/virtual/parent/temp.bin') {
        if (mode === 'r') throw Object.assign(new Error('Windows fsync requires a writable file handle'), { code: 'EPERM' });
        assert.equal(mode, 'r+');
        return 10;
      }
      assert.equal(path, '/virtual/parent');
      assert.equal(mode, 'r');
      return 11;
    },
    fsyncFn() {},
    closeFn() {},
    renameFn() {},
  });
  assert.deepEqual(opens, [
    ['/virtual/parent/temp.bin', 'r+'],
    ['/virtual/parent', 'r'],
  ]);
});

test('durableAtomicWrite exposes exact post-operation crash barriers', async () => {
  const { durableAtomicWrite } = await atomicApi();
  const barriers = [];
  let nextFd = 30;
  durableAtomicWrite('/virtual/parent/final.bin', Buffer.from('bytes'), {
    tempPathFactory: () => '/virtual/parent/temp.bin',
    writeFn() {},
    openFn: () => nextFd++,
    fsyncFn() {},
    closeFn() {},
    renameFn() {},
    barrierAt(label) { barriers.push(label); },
  });
  assert.deepEqual(barriers, ['write', 'file-flush', 'rename', 'parent-flush']);
});

test('durableAtomicWrite tolerates Windows EPERM from parent-directory fsync', async () => {
  const { durableAtomicWrite } = await atomicApi();
  const fdKinds = new Map();
  let nextFd = 40;
  let renamed = false;
  let parentClosed = false;
  durableAtomicWrite('/virtual/parent/final.bin', Buffer.from('bytes'), {
    platform: 'win32',
    tempPathFactory: () => '/virtual/parent/temp.bin',
    writeFn() {},
    openFn(path) {
      const fd = nextFd++;
      fdKinds.set(fd, path);
      return fd;
    },
    fsyncFn(fd) {
      if (fdKinds.get(fd) === '/virtual/parent') {
        throw Object.assign(new Error('directory-fsync'), { code: 'EPERM' });
      }
    },
    closeFn(fd) {
      if (fdKinds.get(fd) === '/virtual/parent') parentClosed = true;
    },
    renameFn() { renamed = true; },
  });
  assert.equal(renamed, true);
  assert.equal(parentClosed, true);
});

test('durableAtomicWrite tolerates only documented Windows directory capability errors', async () => {
  const { durableAtomicWrite } = await atomicApi();
  for (const code of ['EINVAL', 'ENOTSUP', 'ENOSYS', 'EISDIR']) {
    assert.doesNotThrow(() => durableAtomicWrite('/virtual/final.bin', 'x', {
      platform: 'win32', tempPathFactory: () => '/virtual/temp.bin', writeFn() {},
      openFn(path) {
        if (path === '/virtual') throw Object.assign(new Error(code), { code });
        return 1;
      },
      fsyncFn() {}, closeFn() {}, renameFn() {},
    }));
  }
  assert.throws(() => durableAtomicWrite('/virtual/final.bin', 'x', {
    platform: 'win32', tempPathFactory: () => '/virtual/temp.bin', writeFn() {},
    openFn(path) {
      if (path === '/virtual') throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return 1;
    },
    fsyncFn() {}, closeFn() {}, renameFn() {},
  }), /EIO/);

  assert.throws(() => durableAtomicWrite('/virtual/final.bin', 'x', {
    platform: 'linux', tempPathFactory: () => '/virtual/temp.bin', writeFn() {},
    openFn(path) {
      if (path === '/virtual') throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      return 1;
    },
    fsyncFn() {}, closeFn() {}, renameFn() {},
  }), /EINVAL/);
});

test('durableAtomicWrite never suppresses a Windows temp-file fsync EPERM', async () => {
  const { durableAtomicWrite } = await atomicApi();
  let renamed = false;
  let closed = false;
  assert.throws(() => durableAtomicWrite('/virtual/final.bin', 'x', {
    platform: 'win32', tempPathFactory: () => '/virtual/temp.bin', writeFn() {},
    openFn: () => 7,
    fsyncFn() { throw Object.assign(new Error('file-fsync'), { code: 'EPERM' }); },
    closeFn() { closed = true; },
    renameFn() { renamed = true; },
    unlinkFn() {},
  }), /file-fsync/);
  assert.equal(closed, true);
  assert.equal(renamed, false);
});

test('durableAtomicCreate publishes one durable mode-0600 file and removes its temp name', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-create-'));
  const path = join(root, 'artifact.json');
  const bytes = Buffer.from('{"created":true}\n');

  const result = durableAtomicCreate(path, bytes);

  assert.deepEqual(result, { created: true, path });
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(tempNames(root), []);
});

test('durableAtomicCreate reports EEXIST without changing a pre-existing destination', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-existing-'));
  const path = join(root, 'artifact.json');
  const winner = Buffer.from('winner');
  writeFileSync(path, winner);
  let linkCalls = 0;

  const result = durableAtomicCreate(path, Buffer.from('loser'), {
    linkFn(src, dst) {
      linkCalls++;
      return linkSync(src, dst);
    },
  });

  assert.deepEqual(result, { created: false, path, code: 'EEXIST' });
  assert.deepEqual(readFileSync(path), winner);
  assert.equal(linkCalls, 1);
  assert.deepEqual(tempNames(root), []);
});

test('durableAtomicCreate loses a deterministic publish race without replacing the winner', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-race-'));
  const path = join(root, 'artifact.json');
  const winner = Buffer.from('other-writer');

  const result = durableAtomicCreate(path, Buffer.from('candidate'), {
    barrierAt(stage) {
      if (stage === 'file-flush') writeFileSync(path, winner, { flag: 'wx' });
    },
  });

  assert.deepEqual(result, { created: false, path, code: 'EEXIST' });
  assert.deepEqual(readFileSync(path), winner);
  assert.deepEqual(tempNames(root), []);
});

test('durableAtomicCreate treats an injected EEXIST link result as a no-clobber loss', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-injected-eexist-'));
  const path = join(root, 'artifact.json');
  const temp = join(root, '.tmp-fixed');
  const links = [];

  const result = durableAtomicCreate(path, Buffer.from('candidate'), {
    tempPathFactory: () => temp,
    linkFn(src, dst) {
      links.push([src, dst]);
      throw sharingError('EEXIST');
    },
  });

  assert.deepEqual(result, { created: false, path, code: 'EEXIST' });
  assert.deepEqual(links, [[temp, path]]);
  assert.equal(existsSync(path), false);
  assert.deepEqual(tempNames(root), []);
});

for (const code of ['ENOTSUP', 'EINVAL', 'EXDEV']) {
  test(`durableAtomicCreate classifies Windows ${code} as immediately unsupported`, async () => {
    const { durableAtomicCreate } = await atomicApi();
    const root = mkdtempSync(join(tmpdir(), 'dl-atomic-unsupported-'));
    const path = join(root, 'artifact.json');
    let linkCalls = 0;
    let sleeps = 0;

    assert.throws(() => durableAtomicCreate(path, Buffer.from('candidate'), {
      platform: 'win32',
      linkFn() {
        linkCalls++;
        throw sharingError(code);
      },
      sleepFn() { sleeps++; },
    }), error => error?.message === 'OBSERVATION_PUBLISH_UNSUPPORTED');

    assert.equal(linkCalls, 1);
    assert.equal(sleeps, 0);
    assert.equal(existsSync(path), false);
    assert.deepEqual(tempNames(root), []);
  });
}

test('durableAtomicCreate classifies exhausted Windows EPERM as unsupported', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-eperm-exhausted-'));
  const path = join(root, 'artifact.json');
  let now = 0;
  let attempts = 0;
  let sleeps = 0;

  assert.throws(() => durableAtomicCreate(path, Buffer.from('candidate'), {
    platform: 'win32',
    monotonicNowFn: () => now,
    sleepFn(ms) { sleeps++; now += ms; },
    linkFn() { attempts++; throw sharingError('EPERM'); },
  }), error => error?.message === 'OBSERVATION_PUBLISH_UNSUPPORTED');

  assert.ok(attempts > 1);
  assert.ok(sleeps >= 1);
  assert.deepEqual(tempNames(root), []);
});

for (const code of ['EACCES', 'EPERM', 'EBUSY']) {
  test(`durableAtomicCreate retries Windows transient ${code} twice before publishing`, async () => {
    const { durableAtomicCreate } = await atomicApi();
    const root = mkdtempSync(join(tmpdir(), 'dl-atomic-transient-success-'));
    const path = join(root, 'artifact.json');
    let attempts = 0;
    let now = 0;
    const sleeps = [];

    const result = durableAtomicCreate(path, Buffer.from(code), {
      platform: 'win32',
      monotonicNowFn: () => now,
      sleepFn(ms) { sleeps.push(ms); now += ms; },
      linkFn(src, dst) {
        attempts++;
        if (attempts < 3) throw sharingError(code);
        return linkSync(src, dst);
      },
    });

    assert.deepEqual(result, { created: true, path });
    assert.equal(attempts, 3);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps.every(ms => ms === sleeps[0] && ms > 0));
    assert.equal(readFileSync(path, 'utf8'), code);
    assert.deepEqual(tempNames(root), []);
  });
}

test('durableAtomicCreate does not retry POSIX EPERM', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-posix-eperm-'));
  const path = join(root, 'artifact.json');
  const expected = sharingError('EPERM');
  let attempts = 0;
  let sleeps = 0;

  assert.throws(() => durableAtomicCreate(path, Buffer.from('candidate'), {
    platform: 'darwin',
    linkFn() { attempts++; throw expected; },
    sleepFn() { sleeps++; },
  }), error => error === expected);

  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
  assert.deepEqual(tempNames(root), []);
});

test('durableAtomicCreate preserves exhausted Windows EACCES as the primary write error', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-eacces-exhausted-'));
  const path = join(root, 'artifact.json');
  const expected = sharingError('EACCES');
  let now = 0;
  let sleeps = 0;

  assert.throws(() => durableAtomicCreate(path, Buffer.from('candidate'), {
    platform: 'win32',
    monotonicNowFn: () => now,
    sleepFn(ms) { sleeps++; now += ms; },
    linkFn() { throw expected; },
  }), error => error === expected);

  assert.ok(sleeps >= 1);
  assert.deepEqual(tempNames(root), []);
});

test('durableAtomicCreate leaves the published destination when parent flush fails', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-parent-flush-'));
  const path = join(root, 'artifact.json');
  const bytes = Buffer.from('published-before-flush');
  const expected = Object.assign(new Error('parent flush failed'), { code: 'EIO' });

  assert.throws(() => durableAtomicCreate(path, bytes, {
    platform: 'darwin',
    openFn(openPath, flags) {
      if (openPath === root) throw expected;
      return openSync(openPath, flags);
    },
  }), error => error === expected);

  assert.deepEqual(readFileSync(path), bytes);
  assert.deepEqual(tempNames(root), []);
});

test('durableAtomicCreate does not create or clean a temp when pre-write parent validation fails', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-prewrite-'));
  const path = join(root, 'artifact.json');
  const temp = join(root, '.tmp-fixed');
  const expected = new Error('unsafe pre-write parent');
  let writes = 0;
  let links = 0;
  let unlinks = 0;

  assert.throws(() => durableAtomicCreate(path, Buffer.from('candidate'), {
    tempPathFactory: () => temp,
    assertParentFn(stage) {
      assert.equal(stage, 'pre-write');
      throw expected;
    },
    writeFn() { writes++; },
    linkFn() { links++; },
    unlinkFn() { unlinks++; },
  }), error => error === expected);

  assert.equal(writes, 0);
  assert.equal(links, 0);
  assert.equal(unlinks, 0);
  assert.deepEqual(readdirSync(root), []);
});

test('durableAtomicCreate detects replacement before pre-write without touching either directory', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-before-prewrite-race-'));
  const parent = join(root, 'observations');
  const moved = join(root, 'observations-original');
  const external = join(root, 'external');
  mkdirSync(parent);
  mkdirSync(external);
  const before = lstatSync(parent, { bigint: true });
  const path = join(parent, 'artifact.json');
  let writes = 0;
  let links = 0;
  let unlinks = 0;

  assert.throws(() => durableAtomicCreate(path, Buffer.from('candidate'), {
    barrierAt(stage) {
      if (stage === 'before-write-check') {
        renameSync(parent, moved);
        createDirectoryJunction(external, parent);
      }
    },
    assertParentFn() {
      const current = lstatSync(parent, { bigint: true });
      if (current.isSymbolicLink() || !sameIdentity(before, current)) {
        throw new Error('unsafe replaced parent');
      }
    },
    writeFn() { writes++; },
    linkFn() { links++; },
    unlinkFn() { unlinks++; },
  }), /unsafe replaced parent/);

  assert.equal(writes, 0);
  assert.equal(links, 0);
  assert.equal(unlinks, 0);
  assert.deepEqual(readdirSync(moved), []);
  assert.deepEqual(readdirSync(external), []);
});

test('durableAtomicCreate preserves the pre-link error and leaves the moved temp when cleanup is unsafe', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-prelink-race-'));
  const parent = join(root, 'observations');
  const moved = join(root, 'observations-original');
  mkdirSync(parent);
  const before = lstatSync(parent, { bigint: true });
  const path = join(parent, 'artifact.json');
  const temp = join(parent, '.tmp-fixed');
  const preLinkError = new Error('unsafe pre-link parent');
  let links = 0;
  let unlinks = 0;

  assert.throws(() => durableAtomicCreate(path, Buffer.from('candidate'), {
    tempPathFactory: () => temp,
    barrierAt(stage) {
      if (stage === 'file-flush') {
        renameSync(parent, moved);
        mkdirSync(parent);
      }
    },
    assertParentFn(stage) {
      const current = lstatSync(parent, { bigint: true });
      if (!sameIdentity(before, current)) {
        if (stage === 'pre-link') throw preLinkError;
        throw new Error(`unsafe ${stage} parent`);
      }
    },
    linkFn() { links++; },
    unlinkFn() { unlinks++; },
  }), error => error === preLinkError);

  assert.equal(links, 0);
  assert.equal(unlinks, 0);
  assert.deepEqual(readdirSync(moved), ['.tmp-fixed']);
  assert.deepEqual(readdirSync(parent), []);
});

test('durableAtomicCreate never unlinks rebound paths after post-link parent replacement', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-postlink-race-'));
  const parent = join(root, 'observations');
  const moved = join(root, 'observations-original');
  mkdirSync(parent);
  const before = lstatSync(parent, { bigint: true });
  const path = join(parent, 'artifact.json');
  const temp = join(parent, '.tmp-fixed');
  const postLinkError = new Error('unsafe post-link parent');
  let links = 0;
  let unlinks = 0;

  assert.throws(() => durableAtomicCreate(path, Buffer.from('candidate'), {
    tempPathFactory: () => temp,
    assertParentFn(stage) {
      const current = lstatSync(parent, { bigint: true });
      if (!sameIdentity(before, current)) {
        if (stage === 'post-link') throw postLinkError;
        throw new Error(`unsafe ${stage} parent`);
      }
    },
    linkFn(src, dst) {
      links++;
      linkSync(src, dst);
      renameSync(parent, moved);
      mkdirSync(parent);
    },
    unlinkFn(unlinkPath) { unlinks++; unlinkSync(unlinkPath); },
  }), error => error === postLinkError);

  assert.equal(links, 1);
  assert.equal(unlinks, 0);
  assert.deepEqual(readdirSync(moved).sort(), ['.tmp-fixed', 'artifact.json']);
  assert.deepEqual(readdirSync(parent), []);
});

test('durableAtomicCreate revalidates before cleanup after a successful parent flush', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-precleanup-race-'));
  const parent = join(root, 'observations');
  const moved = join(root, 'observations-original');
  mkdirSync(parent);
  const before = lstatSync(parent, { bigint: true });
  const path = join(parent, 'artifact.json');
  const temp = join(parent, '.tmp-fixed');
  const cleanupError = new Error('unsafe pre-cleanup parent');
  let unlinks = 0;

  assert.throws(() => durableAtomicCreate(path, Buffer.from('candidate'), {
    tempPathFactory: () => temp,
    barrierAt(stage) {
      if (stage === 'parent-flush') {
        renameSync(parent, moved);
        mkdirSync(parent);
      }
    },
    assertParentFn(stage) {
      const current = lstatSync(parent, { bigint: true });
      if (!sameIdentity(before, current)) {
        assert.equal(stage, 'pre-cleanup');
        throw cleanupError;
      }
    },
    unlinkFn(unlinkPath) { unlinks++; unlinkSync(unlinkPath); },
  }), error => error === cleanupError);

  assert.equal(unlinks, 0);
  assert.deepEqual(readdirSync(moved).sort(), ['.tmp-fixed', 'artifact.json']);
  assert.deepEqual(readdirSync(parent), []);
});

test('durableAtomicCreate omits post-link parent validation after EEXIST', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-eexist-parent-sequence-'));
  const path = join(root, 'artifact.json');
  writeFileSync(path, 'winner');
  const stages = [];

  const result = durableAtomicCreate(path, Buffer.from('candidate'), {
    assertParentFn(stage) { stages.push(stage); },
  });

  assert.deepEqual(result, { created: false, path, code: 'EEXIST' });
  assert.deepEqual(stages, ['pre-write', 'pre-link', 'pre-cleanup']);
  assert.deepEqual(tempNames(root), []);
});

test('durableAtomicCreate exposes parent checks immediately around write, link, and cleanup', async () => {
  const { durableAtomicCreate } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-parent-order-'));
  const path = join(root, 'artifact.json');
  const trace = [];

  const result = durableAtomicCreate(path, Buffer.from('candidate'), {
    barrierAt(stage) { trace.push(`barrier:${stage}`); },
    assertParentFn(stage) { trace.push(`assert:${stage}`); },
    writeFn(writePath, contents, options) {
      trace.push('write');
      writeFileSync(writePath, contents, options);
    },
    linkFn(src, dst) {
      trace.push('link');
      linkSync(src, dst);
    },
    unlinkFn(unlinkPath) {
      trace.push('unlink');
      unlinkSync(unlinkPath);
    },
  });

  assert.deepEqual(result, { created: true, path });
  assert.deepEqual(trace, [
    'barrier:before-write-check',
    'assert:pre-write',
    'barrier:write',
    'write',
    'barrier:file-flush',
    'assert:pre-link',
    'barrier:link',
    'link',
    'assert:post-link',
    'barrier:parent-flush',
    'assert:pre-cleanup',
    'unlink',
  ]);
});

test('durableAtomicCreate shares the Windows transient set and has no rename dependency', async () => {
  const { durableAtomicCreate, renameAtomicWithRetry } = await atomicApi();
  const source = readFileSync(new URL('../../scripts/lib/atomic-write.mjs', import.meta.url), 'utf8');
  const declaration = source.match(/const (TRANSIENT_WINDOWS_[A-Z_]+) = new Set\(\['EACCES', 'EPERM', 'EBUSY'\]\)/);
  assert.ok(declaration, 'the shared transient set must have the exact approved members');
  assert.equal(source.match(/new Set\(\['EACCES', 'EPERM', 'EBUSY'\]\)/g)?.length, 1);
  assert.match(renameAtomicWithRetry.toString(), new RegExp(`\\b${declaration[1]}\\b`));
  assert.match(durableAtomicCreate.toString(), new RegExp(`\\b${declaration[1]}\\b`));
  assert.doesNotMatch(durableAtomicCreate.toString(), /renameFn/);
});
