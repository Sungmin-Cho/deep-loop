import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonicalRouteTask, locateDeepModelRouter } from './locate-deep-model-router.mjs';
import { MANIFEST_MAX_FILE_BYTES, readBoundedNoFollow } from './route-observation.mjs';
import { routerPinContext } from './router-adapter.mjs';

// Read-only `router probe`: which deep-model-router install the kernel locator
// selects, its manifest version, and the frozen-digest policy_pin to send. It
// establishes a version for the pin decision; it does not authenticate the
// executable. Files only — no process is spawned.

const ROUTER_NAME = 'deep-model-router';
const STRICT_SEMVER = /^\d+\.\d+\.\d+$/;

function readManifest(abs) {
  try {
    const read = readBoundedNoFollow(abs, MANIFEST_MAX_FILE_BYTES);
    if (!read.ok) return null;
    const parsed = JSON.parse(read.bytes.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Same install-root expression as route-observation.mjs readRouterInstallMetadata:
// scripts/ -> model-router/ -> skills/ -> install root.
export function readRouterVersion(routeTaskRealpath) {
  if (typeof routeTaskRealpath !== 'string' || routeTaskRealpath.length === 0) return null;
  const root = resolve(dirname(routeTaskRealpath), '..', '..', '..');
  const pkg = readManifest(join(root, 'package.json'));
  const plugin = readManifest(join(root, '.claude-plugin', 'plugin.json'));
  if (!pkg || !plugin || pkg.name !== ROUTER_NAME || plugin.name !== ROUTER_NAME) return null;
  if (typeof pkg.version !== 'string' || pkg.version !== plugin.version || !STRICT_SEMVER.test(pkg.version)) {
    return null;
  }
  return pkg.version;
}

export function probeRouterPin({
  loopData,
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  locate = locateDeepModelRouter,
} = {}) {
  const located = locate({ env, home, cwd });
  // A relative result means relative to the caller's cwd, not this process's.
  const routeTask = located ? canonicalRouteTask(located, { cwd }) : null;
  const routerReason = located && !routeTask ? 'router-path-rejected' : null;
  const routerVersion = routeTask ? readRouterVersion(routeTask) : null;
  return { ok: true, ...routerPinContext({ loop: loopData, routeTask, routerVersion, routerReason }) };
}
