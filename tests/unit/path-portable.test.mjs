import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  pathKeyWithin,
  sameResolvedPath,
  windowsPathKey,
} from '../../scripts/lib/path-portable.mjs';

const win = { pathApi: path.win32, platform: 'win32' };

test('windowsPathKey folds case, separators, long-path prefixes and trailing slashes', () => {
  assert.equal(windowsPathKey('C:\\Temp\\a', win), windowsPathKey('c:/temp/a', win));
  assert.equal(windowsPathKey('\\\\?\\C:\\Temp\\a', win), windowsPathKey('C:\\Temp\\a', win));
  assert.equal(windowsPathKey('\\\\.\\C:\\Temp\\a', win), windowsPathKey('C:\\Temp\\a', win));
  assert.equal(windowsPathKey('C:\\Temp\\a\\', win), windowsPathKey('C:\\Temp\\a', win));
  assert.equal(
    windowsPathKey('\\\\?\\UNC\\server\\share\\a', win),
    windowsPathKey('\\\\server\\share\\a', win),
  );
  assert.notEqual(windowsPathKey('C:\\foo', win), windowsPathKey('C:\\foobar', win));
  assert.notEqual(
    windowsPathKey('C:\\Users\\RUNNER~1\\Temp\\a', win),
    windowsPathKey('C:\\Users\\runneradmin\\Temp\\a', win),
    '8.3 vs long names stay distinct; callers compare NTFS nodes for that alias',
  );
});

test('sameResolvedPath is a no-op exact match off win32 and a folded compare on win32', () => {
  assert.equal(sameResolvedPath('/tmp/a', '/tmp/a', { platform: 'linux' }), true);
  assert.equal(sameResolvedPath('/tmp/a', '/tmp/A', { platform: 'linux' }), false);
  assert.equal(sameResolvedPath('C:\\Temp\\a', 'c:/temp/a', win), true);
  assert.equal(sameResolvedPath('\\\\?\\C:\\Temp\\a', 'C:\\Temp\\a', win), true);
  assert.equal(sameResolvedPath('C:\\foo', 'C:\\foobar', win), false);
});

test('pathKeyWithin accepts Windows prefix aliases without treating a sibling as contained', () => {
  assert.equal(pathKeyWithin('C:\\Temp\\a', 'C:\\Temp\\a\\plugins', win), true);
  assert.equal(pathKeyWithin('\\\\?\\C:\\Temp\\a', 'C:\\Temp\\a\\plugins\\cache', win), true);
  assert.equal(pathKeyWithin('C:\\Temp\\a', 'C:\\Temp\\ab', win), false);
  assert.equal(pathKeyWithin('/tmp/a', '/tmp/a/plugins', { platform: 'linux', pathApi: path.posix }), true);
  assert.equal(pathKeyWithin('/tmp/a', '/tmp/ab', { platform: 'linux', pathApi: path.posix }), false);
});
