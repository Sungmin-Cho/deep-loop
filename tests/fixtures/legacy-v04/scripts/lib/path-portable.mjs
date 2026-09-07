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
