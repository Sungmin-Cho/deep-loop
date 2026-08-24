import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

export const RENAME_RETRY_MAX_ELAPSED_MS = 1_000;

const RENAME_RETRY_BACKOFF_MS = 50;
const TRANSIENT_WINDOWS_RENAME_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);
const UNSUPPORTED_WINDOWS_PUBLISH_CODES = new Set(['ENOTSUP', 'EINVAL', 'EXDEV']);

function defaultMonotonicNow() { return performance.now(); }
function defaultSleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export function renameAtomicWithRetry(src, dst, {
  platform = process.platform,
  monotonicNowFn = defaultMonotonicNow,
  sleepFn = defaultSleep,
  renameFn = renameSync,
} = {}) {
  const deadline = monotonicNowFn() + RENAME_RETRY_MAX_ELAPSED_MS;
  let retryError = null;
  for (;;) {
    if (retryError && monotonicNowFn() >= deadline) throw retryError;
    try {
      return renameFn(src, dst);
    } catch (error) {
      if (platform !== 'win32' || !TRANSIENT_WINDOWS_RENAME_CODES.has(error?.code)) throw error;
      const now = monotonicNowFn();
      if (!Number.isFinite(now) || now + RENAME_RETRY_BACKOFF_MS >= deadline) throw error;
      sleepFn(RENAME_RETRY_BACKOFF_MS);
      if (monotonicNowFn() >= deadline) throw error;
      retryError = error;
    }
  }
}

export function atomicWrite(path, contents, { writeFn = writeFileSync, ...renameOptions } = {}) {
  const tmp = join(dirname(path), `.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`);
  writeFn(tmp, contents);
  return renameAtomicWithRetry(tmp, path, renameOptions);
}

const WINDOWS_UNSUPPORTED_DIRECTORY_FLUSH = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS', 'EISDIR', 'EPERM']);

function randomTempPath(path) {
  return join(dirname(path), `.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`);
}

export function flushDirectory(path, {
  platform = process.platform,
  openFn = openSync,
  fsyncFn = fsyncSync,
  closeFn = closeSync,
} = {}) {
  let fd;
  try {
    fd = openFn(path, 'r');
    fsyncFn(fd);
  } catch (error) {
    if (platform !== 'win32' || !WINDOWS_UNSUPPORTED_DIRECTORY_FLUSH.has(error?.code)) throw error;
  } finally {
    if (fd !== undefined) closeFn(fd);
  }
}

export function durableAtomicWrite(path, contents, {
  platform = process.platform,
  tempPathFactory = randomTempPath,
  writeFn = writeFileSync,
  openFn = openSync,
  fsyncFn = fsyncSync,
  closeFn = closeSync,
  unlinkFn = unlinkSync,
  renameFn = renameSync,
  monotonicNowFn,
  sleepFn,
  barrierAt = () => {},
  unlinkBeforeRename = false,
  beforeUnlink = () => {},
} = {}) {
  const tmp = tempPathFactory(path);
  let renamed = false;
  try {
    writeFn(tmp, contents, { flag: 'wx', mode: 0o600 });
    barrierAt('write');
    let fd;
    try {
      fd = openFn(tmp, platform === 'win32' ? 'r+' : 'r');
      fsyncFn(fd);
    } finally {
      if (fd !== undefined) closeFn(fd);
    }
    barrierAt('file-flush');
    if (unlinkBeforeRename) {
      beforeUnlink();
      unlinkFn(path);
      barrierAt('unlink');
    }
    renameAtomicWithRetry(tmp, path, {
      platform,
      renameFn,
      ...(monotonicNowFn ? { monotonicNowFn } : {}),
      ...(sleepFn ? { sleepFn } : {}),
    });
    renamed = true;
    barrierAt('rename');
    flushDirectory(dirname(path), { platform, openFn, fsyncFn, closeFn });
    barrierAt('parent-flush');
    return path;
  } finally {
    if (!renamed) {
      try { unlinkFn(tmp); } catch { /* preserve the primary failure */ }
    }
  }
}

function unsupportedPublishError(cause) {
  return new Error('OBSERVATION_PUBLISH_UNSUPPORTED', { cause });
}

function linkAtomicCreateWithRetry(src, dst, {
  platform,
  monotonicNowFn,
  sleepFn,
  linkFn,
  transientCodes,
}) {
  const deadline = monotonicNowFn() + RENAME_RETRY_MAX_ELAPSED_MS;
  let retryError = null;
  for (;;) {
    if (retryError && monotonicNowFn() >= deadline) {
      if (retryError.code === 'EPERM') throw unsupportedPublishError(retryError);
      throw retryError;
    }
    try {
      linkFn(src, dst);
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      if (platform !== 'win32') throw error;
      if (UNSUPPORTED_WINDOWS_PUBLISH_CODES.has(error?.code)) {
        throw unsupportedPublishError(error);
      }
      if (!transientCodes.has(error?.code)) throw error;
      const now = monotonicNowFn();
      if (!Number.isFinite(now) || now + RENAME_RETRY_BACKOFF_MS >= deadline) {
        if (error.code === 'EPERM') throw unsupportedPublishError(error);
        throw error;
      }
      sleepFn(RENAME_RETRY_BACKOFF_MS);
      if (monotonicNowFn() >= deadline) {
        if (error.code === 'EPERM') throw unsupportedPublishError(error);
        throw error;
      }
      retryError = error;
    }
  }
}

export function durableAtomicCreate(path, contents, {
  platform = process.platform,
  tempPathFactory = randomTempPath,
  writeFn = writeFileSync,
  openFn = openSync,
  fsyncFn = fsyncSync,
  closeFn = closeSync,
  linkFn = linkSync,
  unlinkFn = unlinkSync,
  monotonicNowFn = defaultMonotonicNow,
  sleepFn = defaultSleep,
  barrierAt = () => {},
  assertParentFn = () => {},
} = {}) {
  const tmp = tempPathFactory(path);
  let tempCreated = false;
  let result;
  let failure;
  try {
    barrierAt('before-write-check');
    assertParentFn('pre-write');
    barrierAt('write');
    writeFn(tmp, contents, { flag: 'wx', mode: 0o600 });
    tempCreated = true;

    let fd;
    try {
      fd = openFn(tmp, platform === 'win32' ? 'r+' : 'r');
      fsyncFn(fd);
    } finally {
      if (fd !== undefined) closeFn(fd);
    }
    barrierAt('file-flush');

    assertParentFn('pre-link');
    barrierAt('link');
    const created = linkAtomicCreateWithRetry(tmp, path, {
      platform,
      monotonicNowFn,
      sleepFn,
      linkFn,
      transientCodes: TRANSIENT_WINDOWS_RENAME_CODES,
    });
    if (created) {
      assertParentFn('post-link');
      flushDirectory(dirname(path), { platform, openFn, fsyncFn, closeFn });
      barrierAt('parent-flush');
      result = { created: true, path };
    } else {
      result = { created: false, path, code: 'EEXIST' };
    }
  } catch (error) {
    failure = error;
  } finally {
    if (tempCreated) {
      let cleanupSafe = false;
      try {
        assertParentFn('pre-cleanup');
        cleanupSafe = true;
      } catch (error) {
        if (!failure) failure = error;
      }
      if (cleanupSafe) {
        try { unlinkFn(tmp); } catch { /* preserve the primary result or failure */ }
      }
    }
  }
  if (failure) throw failure;
  return result;
}
