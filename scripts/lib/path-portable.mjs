import path from 'node:path';

export function ancestorPaths(startDir, { pathApi = path } = {}) {
  const absolute = pathApi.resolve(startDir);
  const root = pathApi.parse(absolute).root;
  const ancestors = [];
  let current = absolute;
  for (;;) {
    ancestors.push(current);
    if (current === root) break;
    const parent = pathApi.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

export function relativePathWithin(base, candidate, { pathApi = path } = {}) {
  if (typeof base !== 'string' || !base.length || typeof candidate !== 'string' || !candidate.length) return false;
  let rel;
  try { rel = pathApi.relative(base, candidate); } catch { return false; }
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + pathApi.sep) && !pathApi.isAbsolute(rel));
}

export function windowsPathKey(value, { pathApi = path.win32 } = {}) {
  if (typeof value !== 'string' || value.length === 0) return '';
  let normalized = pathApi.normalize(value.replaceAll('/', '\\'));
  if (/^\\\\\?\\unc\\/i.test(normalized)) normalized = '\\\\' + normalized.slice(8);
  else if (/^\\\\[.?]\\/.test(normalized)) normalized = normalized.slice(4);
  if (normalized.length > 3 && normalized.endsWith('\\')) normalized = normalized.slice(0, -1);
  return normalized.toLowerCase();
}

export function sameResolvedPath(left, right, { platform = process.platform, pathApi = path } = {}) {
  if (left === right) return true;
  if (typeof left !== 'string' || typeof right !== 'string' || platform !== 'win32') return false;
  const api = pathApi.win32 ?? path.win32;
  return windowsPathKey(left, { pathApi: api }) === windowsPathKey(right, { pathApi: api });
}

export function pathKeyWithin(root, candidate, { platform = process.platform, pathApi = path } = {}) {
  if (relativePathWithin(root, candidate, { pathApi })) return true;
  if (platform !== 'win32') return false;
  const api = pathApi.win32 ?? path.win32;
  const rootKey = windowsPathKey(root, { pathApi: api });
  const candidateKey = windowsPathKey(candidate, { pathApi: api });
  return candidateKey === rootKey || (rootKey.length > 0 && candidateKey.startsWith(`${rootKey}\\`));
}
