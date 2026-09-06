import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { isMeasuredOneTurnUsage, makeCodexPreflightReceipt } from './budget.mjs';
import { buildCodexExecEntry, buildMinimalCodexEnv } from './codex-runtime.mjs';
import {
  resolveAuthenticatedCodexHome,
  revalidateTrustedRuntimeExecutable,
} from './runtime-executable.mjs';
import {
  listPreflightUsageReceipts,
  readPreflightUsageReceipt,
  validatePreflightUsageReceiptDescriptor,
} from './preflight-receipt-journal.mjs';
import { runStreamingProcessSync } from './streaming-process.mjs';
import { runDir } from './state.mjs';

const CACHE_KEY_CONTRACT = 'deep-loop-codex-preflight-key-v1';
const CACHE_RECORD_CONTRACT = 'deep-loop-codex-preflight-result-v1';
const ACCOUNTING_RECORD_CONTRACT = 'deep-loop-codex-preflight-accounting-v1';
const ENVIRONMENT_POLICY_CONTRACT = 'buildMinimalCodexEnv-core-allowlist-v1';
const WRITE_PROBE_PREFIX = 'DEEP_LOOP_CODEX_WRITE_PROBE=';
const CACHE_RECORD_MAX_BYTES = 8 * 1024;
const ACCOUNTING_RECORD_MAX_BYTES = 16 * 1024;
const RESUME_SKILL_MAX_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const NORMALIZED_PROBE_ROOT = '/__deep_loop_codex_preflight_probe__';
const NORMALIZED_PROBE_PROMPT = '__DEEP_LOOP_CODEX_PREFLIGHT_PROMPT__';
const preflightVerifierPath = fileURLToPath(import.meta.url);
const schemaPath = fileURLToPath(new URL('../../schemas/loop-run.schema.json', import.meta.url));
const budgetPath = fileURLToPath(new URL('./budget.mjs', import.meta.url));
const codexRuntimePath = fileURLToPath(new URL('./codex-runtime.mjs', import.meta.url));
const runtimeExecutablePath = fileURLToPath(new URL('./runtime-executable.mjs', import.meta.url));
const preflightReceiptJournalPath = fileURLToPath(new URL('./preflight-receipt-journal.mjs', import.meta.url));
const streamingProcessPath = fileURLToPath(new URL('./streaming-process.mjs', import.meta.url));
const streamingWorkerPath = fileURLToPath(new URL('../workers/streaming-child.mjs', import.meta.url));
const usageParserPath = fileURLToPath(new URL('./usage-parser.mjs', import.meta.url));

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || seen.has(value)) {
    throw new Error('INVALID_CODEX_PREFLIGHT_KEY_INPUT');
  }
  seen.add(value);
  const encoded = Array.isArray(value)
    ? `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return encoded;
}

function normalizeProbeValue(value, projectRoot, prompt) {
  if (typeof value === 'string') {
    if (value === projectRoot) return NORMALIZED_PROBE_ROOT;
    if (value === prompt) return NORMALIZED_PROBE_PROMPT;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeProbeValue(item, projectRoot, prompt));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, normalizeProbeValue(item, projectRoot, prompt)]));
  }
  return value;
}

export function codexPreflightCacheKey(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)
    || input.normalize == null || typeof input.normalize !== 'object'
    || typeof input.normalize.projectRoot !== 'string' || input.normalize.projectRoot.length === 0
    || typeof input.normalize.prompt !== 'string' || input.normalize.prompt.length === 0) {
    throw new Error('INVALID_CODEX_PREFLIGHT_KEY_INPUT');
  }
  const payload = { ...input };
  const { projectRoot, prompt } = payload.normalize;
  delete payload.normalize;
  const normalized = normalizeProbeValue(payload, projectRoot, prompt);
  return createHash('sha256')
    .update(CACHE_KEY_CONTRACT)
    .update('\0')
    .update(canonicalJson(normalized))
    .digest('hex');
}

function canonicalRealpath(path) {
  const realpath = realpathSync.native || realpathSync;
  return realpath(path);
}

function lstatMaybe(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFileIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function sameDirectoryNode(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function trustedDirectory(path, { parent = null } = {}) {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) {
    throw new Error('directory path must be absolute');
  }
  const lexical = resolve(path);
  const before = lstatSync(lexical, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('directory must be non-symlinked');
  const canonical = canonicalRealpath(lexical);
  const afterLexical = lstatSync(lexical, { bigint: true });
  const afterCanonical = lstatSync(canonical, { bigint: true });
  if (canonical !== lexical || !afterCanonical.isDirectory()
    || !sameFileIdentity(before, afterLexical) || !sameFileIdentity(afterLexical, afterCanonical)
    || (parent != null && !contained(parent, canonical))) {
    throw new Error('directory identity or containment changed');
  }
  return { canonical_path: canonical, stat: afterCanonical };
}

function ensureTrustedDirectory(path, parent) {
  const existing = lstatMaybe(path);
  if (existing == null) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return trustedDirectory(path, { parent });
}

function inspectResumeSkillIdentity(path, { deepLoopRoot }) {
  const lexical = resolve(path);
  const expected = join(deepLoopRoot, 'skills', 'deep-loop-resume', 'SKILL.md');
  if (!isAbsolute(path) || lexical !== expected) throw new Error('resume skill path mismatch');
  const before = lstatSync(lexical, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o444n) === 0n
    || before.size > BigInt(RESUME_SKILL_MAX_BYTES)) {
    throw new Error('resume skill must be a bounded readable regular file');
  }
  const canonical = canonicalRealpath(lexical);
  const canonicalStat = lstatSync(canonical, { bigint: true });
  if (canonical !== lexical || !contained(deepLoopRoot, canonical)
    || canonicalStat.isSymbolicLink() || !canonicalStat.isFile()
    || !sameFileIdentity(before, canonicalStat)) {
    throw new Error('resume skill identity changed during canonicalization');
  }

  let fd;
  let bytes;
  try {
    fd = openSync(canonical, 'r');
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(canonicalStat, opened)) throw new Error('resume skill changed before read');
    bytes = readFileSync(fd);
    const read = fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(opened, read)) throw new Error('resume skill changed during read');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const after = lstatSync(canonical, { bigint: true });
  if (!sameFileIdentity(canonicalStat, after)) throw new Error('resume skill changed after read');
  return {
    canonical_path: canonical,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    device: String(after.dev),
    inode: String(after.ino),
    mode: String(after.mode),
    size: String(after.size),
    mtime_ns: String(after.mtimeNs),
    ctime_ns: String(after.ctimeNs),
  };
}

function validateResumeSkillIdentity(identity, expectedPath, deepLoopRoot) {
  if (identity == null || typeof identity !== 'object' || Array.isArray(identity)
    || identity.canonical_path !== expectedPath || !contained(deepLoopRoot, identity.canonical_path)
    || !/^[0-9a-f]{64}$/.test(identity.sha256 || '')
    || ['device', 'inode', 'mode', 'size', 'mtime_ns', 'ctime_ns']
      .some((field) => typeof identity[field] !== 'string' || identity[field].length === 0)) {
    throw new Error('resume skill identity is invalid');
  }
  return identity;
}

function executableKeyIdentity(identity) {
  return {
    runtime: identity.runtime,
    canonical_path: identity.canonical_path,
    sha256: identity.sha256,
    version: identity.version,
    platform: identity.platform,
    arch: identity.arch,
    source: identity.source,
    package: identity.package ?? null,
    authenticode: identity.authenticode ?? null,
  };
}

function fileContract(label, path) {
  return `${label}:sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function descriptorContract(entry) {
  const { env: _env, ...descriptor } = entry;
  return descriptor;
}

function environmentPolicyContract(readEnv, writeEnv, platform) {
  return {
    contract: ENVIRONMENT_POLICY_CONTRACT,
    platform,
    read_keys: Object.keys(readEnv).sort(),
    write_keys: Object.keys(writeEnv).sort(),
    forced: {
      DEEP_LOOP_UNATTENDED: '1',
      DEEP_LOOP_HEADLESS: '1',
      generation_encoding: 'base-10-integer',
      codex_home: 'fresh-authenticated-directory-identity',
    },
  };
}

function cacheRecord(cacheKey, executable, resumeSkill, receiptIds) {
  return {
    contract: CACHE_RECORD_CONTRACT,
    cache_key: cacheKey,
    proof: 'read-only-terminal+maker-write-sentinel',
    accounting_receipts: receiptIds,
    executable: {
      sha256: executable.sha256,
      version: executable.version,
      platform: executable.platform,
      arch: executable.arch,
    },
    resume_skill: {
      sha256: resumeSkill.sha256,
      device: resumeSkill.device,
      inode: resumeSkill.inode,
      mode: resumeSkill.mode,
      size: resumeSkill.size,
      mtime_ns: resumeSkill.mtime_ns,
      ctime_ns: resumeSkill.ctime_ns,
    },
  };
}

function accountingRecord({ cacheKey, runId, attemptId, owner, generation, receipts }) {
  return {
    contract: ACCOUNTING_RECORD_CONTRACT,
    cache_key: cacheKey,
    run_id: runId,
    attempt_id: attemptId,
    origin: { owner, generation },
    receipts,
  };
}

function cacheRecordBytes(record) {
  return Buffer.from(`${canonicalJson(record)}\n`, 'utf8');
}

function validateAccountingRecord(record, { root, runId, cacheKey }) {
  if (record == null || typeof record !== 'object' || Array.isArray(record)
    || record.contract !== ACCOUNTING_RECORD_CONTRACT
    || record.cache_key !== cacheKey || record.run_id !== runId
    || typeof record.attempt_id !== 'string' || !/^[0-9a-f]{32,64}$/.test(record.attempt_id)
    || record.origin == null || typeof record.origin !== 'object' || Array.isArray(record.origin)
    || typeof record.origin.owner !== 'string' || record.origin.owner.length === 0
    || !Number.isInteger(record.origin.generation) || record.origin.generation < 0
    || !Array.isArray(record.receipts) || record.receipts.length !== 2) return null;
  const [storedRead, storedWrite] = record.receipts;
  if (storedRead == null || typeof storedRead !== 'object' || Array.isArray(storedRead)
    || storedWrite == null || typeof storedWrite !== 'object' || Array.isArray(storedWrite)
    || storedRead.usage == null || storedWrite.usage == null) return null;
  try {
    const expectedRead = makeCodexPreflightReceipt({
      root,
      runId,
      cacheKey,
      smokeKind: 'read',
      attemptId: record.attempt_id,
      predecessorReceiptId: null,
      owner: record.origin.owner,
      generation: record.origin.generation,
      usage: storedRead.usage,
    });
    const expectedWrite = makeCodexPreflightReceipt({
      root,
      runId,
      cacheKey,
      smokeKind: 'write',
      attemptId: record.attempt_id,
      predecessorReceiptId: expectedRead.receipt_id,
      owner: record.origin.owner,
      generation: record.origin.generation,
      usage: storedWrite.usage,
    });
    const expected = accountingRecord({
      cacheKey,
      runId,
      attemptId: record.attempt_id,
      owner: record.origin.owner,
      generation: record.origin.generation,
      receipts: [expectedRead, expectedWrite],
    });
    return canonicalJson(record) === canonicalJson(expected) ? expected : null;
  } catch {
    return null;
  }
}

function inspectAccountingRecord(accountingDir, accountingPath, preflightRoot, context) {
  let directory;
  try {
    directory = trustedDirectory(accountingDir, { parent: preflightRoot });
  } catch {
    return { status: 'invalid' };
  }
  const before = lstatMaybe(accountingPath);
  if (before == null) return { status: 'miss' };
  if (before.isSymbolicLink() || !before.isFile()
    || before.size > BigInt(ACCOUNTING_RECORD_MAX_BYTES)) return { status: 'invalid' };
  try {
    const canonical = canonicalRealpath(accountingPath);
    const canonicalStat = lstatSync(canonical, { bigint: true });
    if (canonical !== accountingPath || !contained(directory.canonical_path, canonical)
      || canonicalStat.isSymbolicLink() || !canonicalStat.isFile()
      || !sameFileIdentity(before, canonicalStat)) return { status: 'invalid' };
    const bytes = readFileSync(canonical);
    const after = lstatSync(canonical, { bigint: true });
    if (!sameFileIdentity(canonicalStat, after)) return { status: 'invalid' };
    const record = validateAccountingRecord(JSON.parse(bytes.toString('utf8')), context);
    if (record == null || !bytes.equals(cacheRecordBytes(record))) return { status: 'invalid' };
    return { status: 'hit', record };
  } catch {
    return { status: 'invalid' };
  }
}

function writeImmutableRecord(directory, path, parent, bytes, inspect) {
  let created = false;
  let fd;
  try {
    trustedDirectory(directory, { parent });
    const existing = lstatMaybe(path);
    if (existing != null) return inspect().status === 'hit';
    fd = openSync(path, 'wx', 0o600);
    created = true;
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    return inspect().status === 'hit';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* fail-closed result below */ }
    }
    if (created && inspect().status !== 'hit') {
      try { rmSync(path, { force: true }); } catch { /* partial material remains non-authoritative */ }
    }
  }
}

function inspectCacheAuthority(cacheDir, cachePath, preflightRoot, expectedBytes) {
  const cacheDirStat = lstatMaybe(cacheDir);
  if (cacheDirStat == null) return { status: 'miss' };
  let directory;
  try {
    directory = trustedDirectory(cacheDir, { parent: preflightRoot });
  } catch {
    return { status: 'invalid' };
  }
  const before = lstatMaybe(cachePath);
  if (before == null) return { status: 'miss' };
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(CACHE_RECORD_MAX_BYTES)) {
    return { status: 'invalid' };
  }
  try {
    const canonical = canonicalRealpath(cachePath);
    const canonicalStat = lstatSync(canonical, { bigint: true });
    if (canonical !== cachePath || !contained(directory.canonical_path, canonical)
      || canonicalStat.isSymbolicLink() || !canonicalStat.isFile()
      || !sameFileIdentity(before, canonicalStat)) return { status: 'invalid' };
    const bytes = readFileSync(canonical);
    const after = lstatSync(canonical, { bigint: true });
    if (!sameFileIdentity(canonicalStat, after) || !bytes.equals(expectedBytes)) return { status: 'invalid' };
    return { status: 'hit' };
  } catch {
    return { status: 'invalid' };
  }
}

function writeCacheRecord(cacheDir, cachePath, preflightRoot, expectedBytes) {
  const inspect = () => inspectCacheAuthority(cacheDir, cachePath, preflightRoot, expectedBytes);
  return writeImmutableRecord(cacheDir, cachePath, preflightRoot, expectedBytes, inspect);
}

function sanitizedUsage(usage) {
  return {
    num_turns: 1,
    tokens: usage.tokens,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    ...(Object.hasOwn(usage, 'cached_input_tokens') ? { cached_input_tokens: usage.cached_input_tokens } : {}),
    ...(Object.hasOwn(usage, 'reasoning_output_tokens') ? { reasoning_output_tokens: usage.reasoning_output_tokens } : {}),
  };
}

function runSmoke(kind, entry, runSync, timeoutMs, usageReceipt) {
  let result;
  try {
    result = runSync(entry, { timeoutMs, usageReceipt });
  } catch {
    result = { ok: false, reason: 'spawn-error' };
  }
  let durableReceipt;
  try {
    durableReceipt = readPreflightUsageReceipt(usageReceipt);
  } catch {
    // A parent-directory identity race can make the canonical journal path unreadable
    // after the worker durably wrote and returned its exact receipt. Preserve that
    // measured evidence for the caller's receipt-managed boundary failure; never
    // manufacture evidence when the returned worker protocol itself is not exact.
    if (result != null && typeof result === 'object' && result.ok === true
      && isMeasuredOneTurnUsage(result.usage)) {
      const usage = sanitizedUsage(result.usage);
      try {
        const returnedReceipt = makeCodexPreflightReceipt({ ...usageReceipt, usage });
        if (JSON.stringify(result.usageReceipt) === JSON.stringify(returnedReceipt)) {
          return {
            ok: false,
            reason: `${kind}-smoke:usage-receipt-invalid`,
            receipt: returnedReceipt,
            usage,
          };
        }
      } catch { /* invalid returned evidence remains untrusted */ }
    }
    return { ok: false, reason: `${kind}-smoke:usage-receipt-invalid` };
  }
  if (result == null || typeof result !== 'object' || typeof result.then === 'function') {
    return {
      ok: false,
      reason: `${kind}-smoke:sync-worker-required`,
      ...(durableReceipt == null ? {} : { receipt: durableReceipt, usage: durableReceipt.usage }),
    };
  }
  if (result.ok !== true) {
    const reason = typeof result.reason === 'string' && result.reason.length > 0
      ? result.reason
      : 'worker-protocol-invalid';
    return {
      ok: false,
      reason: `${kind}-smoke:${reason}`,
      ...(durableReceipt == null ? {} : { receipt: durableReceipt, usage: durableReceipt.usage }),
    };
  }
  if (!isMeasuredOneTurnUsage(result.usage)) {
    return {
      ok: false,
      reason: `${kind}-smoke:unmeasured-usage`,
      ...(durableReceipt == null ? {} : { receipt: durableReceipt, usage: durableReceipt.usage }),
    };
  }
  const usage = sanitizedUsage(result.usage);
  let expectedReceipt;
  try {
    expectedReceipt = makeCodexPreflightReceipt({ ...usageReceipt, usage });
  } catch {
    return {
      ok: false,
      reason: `${kind}-smoke:usage-receipt-invalid`,
      ...(durableReceipt == null ? {} : { receipt: durableReceipt, usage: durableReceipt.usage }),
    };
  }
  if (durableReceipt == null
    || JSON.stringify(result.usageReceipt) !== JSON.stringify(expectedReceipt)
    || JSON.stringify(durableReceipt) !== JSON.stringify(expectedReceipt)) {
    if (durableReceipt == null
      && JSON.stringify(result.usageReceipt) === JSON.stringify(expectedReceipt)) {
      return {
        ok: false,
        reason: `${kind}-smoke:usage-receipt-invalid`,
        receipt: expectedReceipt,
        usage,
      };
    }
    return {
      ok: false,
      reason: `${kind}-smoke:usage-receipt-invalid`,
      ...(durableReceipt == null ? {} : { receipt: durableReceipt, usage: durableReceipt.usage }),
    };
  }
  return { ok: true, usage, receipt: durableReceipt };
}

function inspectSentinel(workspace, initialWorkspace, preflightRoot, sentinelName, nonce) {
  let current;
  try {
    current = lstatSync(workspace, { bigint: true });
    if (current.isSymbolicLink() || !current.isDirectory()
      || !sameDirectoryNode(initialWorkspace.stat, current)) return 'sentinel-containment-escape';
    const canonical = canonicalRealpath(workspace);
    if (canonical !== workspace || !contained(preflightRoot, canonical)) return 'sentinel-containment-escape';
  } catch {
    return 'sentinel-containment-escape';
  }

  let entries;
  try {
    entries = readdirSync(workspace, { withFileTypes: true });
  } catch {
    return 'sentinel-containment-escape';
  }
  if (entries.length === 0) return 'sentinel-missing';
  if (entries.length !== 1 || entries[0].name !== sentinelName) return 'sentinel-extra-artifact';

  const sentinel = join(workspace, sentinelName);
  try {
    const before = lstatSync(sentinel, { bigint: true });
    if (before.isSymbolicLink()) return 'sentinel-symlink';
    if (!before.isFile()) return 'sentinel-not-regular';
    const canonical = canonicalRealpath(sentinel);
    if (canonical !== sentinel || !contained(workspace, canonical)) return 'sentinel-containment-escape';
    if (before.size !== BigInt(Buffer.byteLength(nonce, 'utf8'))) return 'sentinel-wrong-bytes';
    const bytes = readFileSync(canonical);
    const after = lstatSync(canonical, { bigint: true });
    if (!sameFileIdentity(before, after)) return 'sentinel-identity-drift';
    return bytes.equals(Buffer.from(nonce, 'utf8')) ? null : 'sentinel-wrong-bytes';
  } catch {
    return 'sentinel-containment-escape';
  }
}

function cleanupWorkspace(workspace, removeWorkspace) {
  try {
    removeWorkspace(workspace);
    return lstatMaybe(workspace) == null;
  } catch {
    return false;
  }
}

function fail(reason, measuredUsage = []) {
  return { ok: false, reason, pause_mode: 'preserve', measured_usage: measuredUsage };
}

export function ensureCodexPreflight({
  projectRoot,
  runId,
  executableIdentity,
  codexHomeIdentity,
  deepLoopRoot,
  resumeSkillPath,
  sourceEnv = process.env,
  owner,
  generation,
  model = null,
  effort = null,
  goalDriven = false,
  timeoutMs = 30 * 60 * 1000,
  durableSchemaContract = null,
  usageParserContract = null,
  environmentBuilderContract = null,
  preflightVerifierContract = null,
  nonceFactory = () => randomBytes(16).toString('hex'),
  runVersion,
  runSync = runStreamingProcessSync,
  revalidateExecutable = revalidateTrustedRuntimeExecutable,
  resolveCodexHome = resolveAuthenticatedCodexHome,
  inspectResumeSkill = inspectResumeSkillIdentity,
  removeWorkspace = (path) => rmSync(path, { recursive: true, force: true }),
  settleAccountingReceipt,
  settleOrphanAccountingReceipt,
} = {}) {
  const measuredUsage = [];
  if (typeof goalDriven !== 'boolean'
    || typeof runSync !== 'function' || typeof nonceFactory !== 'function'
    || typeof revalidateExecutable !== 'function' || typeof resolveCodexHome !== 'function'
    || typeof inspectResumeSkill !== 'function' || typeof removeWorkspace !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
    return fail('preflight-invalid');
  }

  let executable;
  try {
    executable = revalidateExecutable(executableIdentity, {
      runVersion,
    });
  } catch {
    return fail('executable-invalid');
  }

  let codexHome;
  try {
    codexHome = resolveCodexHome({
      path: codexHomeIdentity?.canonical_path,
      expectedIdentity: codexHomeIdentity,
      platform: executable.platform,
    });
  } catch {
    return fail('codex-home-invalid');
  }

  let projectDirectory;
  let deepLoopDirectory;
  let canonicalProject;
  let canonicalDeepLoop;
  let resumeSkill;
  try {
    projectDirectory = trustedDirectory(projectRoot);
    deepLoopDirectory = trustedDirectory(deepLoopRoot);
    canonicalProject = projectDirectory.canonical_path;
    canonicalDeepLoop = deepLoopDirectory.canonical_path;
    const expectedResumePath = join(canonicalDeepLoop, 'skills', 'deep-loop-resume', 'SKILL.md');
    if (typeof resumeSkillPath !== 'string' || !isAbsolute(resumeSkillPath)
      || resolve(resumeSkillPath) !== expectedResumePath) throw new Error('resume skill path mismatch');
    resumeSkill = validateResumeSkillIdentity(
      inspectResumeSkill(resumeSkillPath, { deepLoopRoot: canonicalDeepLoop }),
      expectedResumePath,
      canonicalDeepLoop,
    );
  } catch {
    return fail('resume-skill-invalid');
  }

  let runDirectory;
  let preflightDirectory;
  let cacheDirectory;
  let accountingDirectory;
  let processReceiptDirectory;
  let canonicalRun;
  let preflightRoot;
  let cacheDir;
  let accountingDir;
  let processReceiptDir;
  try {
    runDirectory = trustedDirectory(runDir(canonicalProject, runId), { parent: canonicalProject });
    canonicalRun = runDirectory.canonical_path;
    const preflightPath = join(canonicalRun, 'preflight');
    preflightDirectory = ensureTrustedDirectory(preflightPath, canonicalRun);
    preflightRoot = preflightDirectory.canonical_path;
    cacheDir = join(preflightRoot, 'cache');
    cacheDirectory = ensureTrustedDirectory(cacheDir, preflightRoot);
    accountingDir = join(preflightRoot, 'accounting');
    accountingDirectory = ensureTrustedDirectory(accountingDir, preflightRoot);
    processReceiptDir = join(preflightRoot, 'process-receipts');
    processReceiptDirectory = ensureTrustedDirectory(processReceiptDir, preflightRoot);
  } catch {
    return fail('cache-invalid');
  }

  const executableFingerprint = canonicalJson(executableKeyIdentity(executable));
  const codexHomeFingerprint = canonicalJson(codexHome);
  const resumeSkillFingerprint = canonicalJson(resumeSkill);

  function revalidateSecurityInputs() {
    try {
      const fresh = revalidateExecutable(executableIdentity, { runVersion });
      if (canonicalJson(executableKeyIdentity(fresh)) !== executableFingerprint) throw new Error('drift');
    } catch {
      return 'executable-invalid';
    }
    try {
      const fresh = resolveCodexHome({
        path: codexHomeIdentity?.canonical_path,
        expectedIdentity: codexHomeIdentity,
        platform: executable.platform,
      });
      if (canonicalJson(fresh) !== codexHomeFingerprint) throw new Error('drift');
    } catch {
      return 'codex-home-invalid';
    }
    try {
      const fresh = validateResumeSkillIdentity(
        inspectResumeSkill(resumeSkillPath, { deepLoopRoot: canonicalDeepLoop }),
        resumeSkill.canonical_path,
        canonicalDeepLoop,
      );
      if (canonicalJson(fresh) !== resumeSkillFingerprint) throw new Error('drift');
    } catch {
      return 'resume-skill-invalid';
    }
    return null;
  }

  function revalidateFilesystemBoundary() {
    try {
      const freshProject = trustedDirectory(canonicalProject);
      const freshDeepLoop = trustedDirectory(canonicalDeepLoop);
      const freshRun = trustedDirectory(canonicalRun, { parent: canonicalProject });
      const freshPreflight = trustedDirectory(preflightRoot, { parent: canonicalRun });
      const freshCache = trustedDirectory(cacheDir, { parent: preflightRoot });
      const freshAccounting = trustedDirectory(accountingDir, { parent: preflightRoot });
      const freshProcessReceipts = trustedDirectory(processReceiptDir, { parent: preflightRoot });
      const pairs = [
        [projectDirectory, freshProject],
        [deepLoopDirectory, freshDeepLoop],
        [runDirectory, freshRun],
        [preflightDirectory, freshPreflight],
        [cacheDirectory, freshCache],
        [accountingDirectory, freshAccounting],
        [processReceiptDirectory, freshProcessReceipts],
      ];
      if (pairs.some(([expected, fresh]) => expected.canonical_path !== fresh.canonical_path
        || !sameDirectoryNode(expected.stat, fresh.stat))) throw new Error('drift');
      return null;
    } catch {
      return 'cache-invalid';
    }
  }

  function revalidateBoundary() {
    return revalidateFilesystemBoundary() ?? revalidateSecurityInputs();
  }

  let nonce;
  try {
    nonce = nonceFactory();
  } catch {
    return fail('preflight-invalid');
  }
  if (typeof nonce !== 'string' || !/^[0-9a-f]{32,64}$/.test(nonce)) return fail('preflight-invalid');
  const sentinelName = 'sentinel';
  const workspace = join(preflightRoot, `probe-${nonce}`);
  const writePrompt = [
    `Read the exact maker resume skill at ${JSON.stringify(resumeSkill.canonical_path)} solely to prove it is readable; do not execute its workflow.`,
    `Create exactly one new regular file named ${JSON.stringify(sentinelName)} in ${JSON.stringify(workspace)}.`,
    `Write exactly the UTF-8 bytes ${JSON.stringify(nonce)} and create no other artifact.`,
    `${WRITE_PROBE_PREFIX}${JSON.stringify({ workspace, sentinel: sentinelName, nonce })}`,
  ].join('\n');
  const readPrompt = 'Complete one terminal JSONL turn without writing files, using tools, or changing project state.';

  let readEntry;
  let writeEntry;
  let cacheKey;
  let cachePath;
  let accountingPath;
  try {
    const readEnv = buildMinimalCodexEnv({
      platform: executable.platform,
      sourceEnv,
      codexHome: codexHome.canonical_path,
      runId,
      projectRoot: canonicalProject,
      owner,
      generation,
    });
    const writeEnv = buildMinimalCodexEnv({
      platform: executable.platform,
      sourceEnv,
      codexHome: codexHome.canonical_path,
      runId,
      projectRoot: workspace,
      owner,
      generation,
    });
    readEntry = {
      ...buildCodexExecEntry({
        executable: executable.canonical_path,
        projectRoot: canonicalProject,
        prompt: readPrompt,
        model,
        effort,
        goalDriven,
        sandbox: 'read-only',
      }),
      cwd: canonicalProject,
      env: readEnv,
      usageOutputKind: 'codex-jsonl',
    };
    writeEntry = {
      ...buildCodexExecEntry({
        executable: executable.canonical_path,
        projectRoot: workspace,
        prompt: writePrompt,
        model,
        effort,
        goalDriven,
      }),
      cwd: workspace,
      env: writeEnv,
      usageOutputKind: 'codex-jsonl',
    };
    const schemaContract = durableSchemaContract
      ?? fileContract('loop-run.schema.json', schemaPath);
    const parserContract = {
      usage: usageParserContract ?? {
        jsonl_parser: fileContract('codex-jsonl-parser', usageParserPath),
        sync_facade: fileContract('streaming-process', streamingProcessPath),
        sync_worker: fileContract('streaming-child', streamingWorkerPath),
        one_turn_validator: fileContract('budget-one-turn-validator', budgetPath),
      },
      process_receipt_journal: fileContract('preflight-receipt-journal', preflightReceiptJournalPath),
    };
    cacheKey = codexPreflightCacheKey({
      executableIdentity: executableKeyIdentity(executable),
      codexHomeIdentity,
      model,
      effort,
      goalDriven,
      durableSchemaContract: schemaContract,
      usageParserContract: parserContract,
      resumeSkillIdentity: resumeSkill,
      isolationProfile: {
        readDescriptor: descriptorContract(readEntry),
        writeDescriptor: descriptorContract(writeEntry),
        envPolicy: environmentPolicyContract(readEnv, writeEnv, executable.platform),
        envBuilderContract: environmentBuilderContract
          ?? fileContract('codex-runtime', codexRuntimePath),
        identityVerifierContract: fileContract('runtime-executable', runtimeExecutablePath),
        preflightVerifierContract: preflightVerifierContract
          ?? fileContract('codex-preflight', preflightVerifierPath),
        timeout_ms: timeoutMs,
      },
      normalize: { projectRoot: workspace, prompt: writePrompt },
    });
    cachePath = join(cacheDir, `${cacheKey}.json`);
    accountingPath = join(accountingDir, `${cacheKey}.json`);
  } catch {
    return fail('preflight-invalid');
  }

  const accountingContext = { root: canonicalProject, runId, cacheKey };
  const inspectAccounting = () => inspectAccountingRecord(
    accountingDir,
    accountingPath,
    preflightRoot,
    accountingContext,
  );
  const validSettlement = result => result != null
    && typeof result === 'object'
    && !Array.isArray(result)
    && result.ok === true
    && typeof result.recorded === 'boolean'
    && ['recorded', 'already-recorded'].includes(result.reason)
    && (result.recorded ? result.reason === 'recorded' : result.reason === 'already-recorded');
  const receiptDescriptor = receipt => validatePreflightUsageReceiptDescriptor({
    journalPath: join(processReceiptDir, `${receipt.attempt_id}-${receipt.smoke_kind}.json`),
    root: canonicalProject,
    runId,
    cacheKey: receipt.cache_key,
    smokeKind: receipt.smoke_kind,
    attemptId: receipt.attempt_id,
    predecessorReceiptId: receipt.predecessor_receipt_id,
    owner: receipt.owner,
    generation: receipt.generation,
  });
  const removeExactRawReceipts = (receipts, { strict = false } = {}) => {
    try {
      // Remove write before read so an interrupted cleanup never strands a write without
      // the raw predecessor required by the next deterministic journal scan.
      for (const receipt of [...receipts].reverse()) {
        const descriptor = receiptDescriptor(receipt);
        const stored = readPreflightUsageReceipt(descriptor);
        if (stored == null) continue;
        if (stored.receipt_id !== receipt.receipt_id) throw new Error('raw receipt changed');
        rmSync(descriptor.journalPath);
        if (lstatMaybe(descriptor.journalPath) != null) throw new Error('raw receipt remained');
      }
      return true;
    } catch {
      return !strict;
    }
  };
  const settleRecord = (record) => {
    const receiptIds = record.receipts.map(receipt => receipt.receipt_id);
    if (typeof settleAccountingReceipt !== 'function') {
      return { ok: false, receiptIds };
    }
    try {
      for (const receipt of record.receipts) {
        const result = settleAccountingReceipt(structuredClone(receipt));
        if (!validSettlement(result)) {
          throw new Error('preflight accounting settlement protocol invalid');
        }
      }
      return { ok: true, receiptIds };
    } catch {
      return { ok: false, receiptIds };
    }
  };
  const accountingFailure = (measured = [], receiptIds = []) => ({
    ...fail('preflight-accounting-failed', measured),
    accounting_settled: false,
    accounting_receipts: receiptIds,
  });
  const receiptManagedFailure = (reason, measured, receipts, settled = false) => ({
    ...fail(reason, measured),
    accounting_settled: settled,
    accounting_receipts: receipts.map(receipt => receipt.receipt_id),
  });
  const activateRecord = (record, { recovered }) => {
    const settled = settleRecord(record);
    if (!settled.ok) return accountingFailure([], settled.receiptIds);
    const drift = revalidateBoundary();
    if (drift != null) {
      return {
        ...fail(drift),
        accounting_settled: true,
        accounting_receipts: settled.receiptIds,
      };
    }
    const expectedCacheBytes = cacheRecordBytes(cacheRecord(
      cacheKey,
      executable,
      resumeSkill,
      settled.receiptIds,
    ));
    const authority = inspectCacheAuthority(cacheDir, cachePath, preflightRoot, expectedCacheBytes);
    if (authority.status === 'invalid') {
      return receiptManagedFailure('cache-invalid', [], record.receipts, true);
    }
    if (authority.status === 'miss'
      && !writeCacheRecord(cacheDir, cachePath, preflightRoot, expectedCacheBytes)) {
      return {
        ...fail('cache-write-failed'),
        accounting_settled: true,
        accounting_receipts: settled.receiptIds,
      };
    }
    const activated = {
      ok: true,
      cache_hit: recovered,
      cache_key: cacheKey,
      measured_usage: [],
      accounting_settled: true,
      accounting_receipts: settled.receiptIds,
    };
    removeExactRawReceipts(record.receipts);
    return activated;
  };

  let provisional;
  try {
    provisional = inspectAccounting();
  } catch {
    return fail('cache-invalid');
  }
  if (provisional.status === 'invalid') return fail('cache-invalid');
  let rawReceipts;
  try {
    rawReceipts = listPreflightUsageReceipts({
      root: canonicalProject,
      runId,
      journalDir: processReceiptDir,
    });
  } catch {
    return fail('cache-invalid');
  }
  const provisionalIds = new Set(provisional.status === 'hit'
    ? provisional.record.receipts.map(receipt => receipt.receipt_id)
    : []);
  const orphanReceipts = rawReceipts.filter(item => !provisionalIds.has(item.receipt.receipt_id));
  if (orphanReceipts.length > 0) {
    if (typeof settleOrphanAccountingReceipt !== 'function') {
      return fail('preflight-accounting-failed');
    }
    try {
      for (const { receipt } of orphanReceipts) {
        const result = settleOrphanAccountingReceipt(structuredClone(receipt));
        if (!validSettlement(result)) throw new Error('orphan accounting settlement protocol invalid');
      }
    } catch {
      return fail('preflight-accounting-failed');
    }
    if (!removeExactRawReceipts(orphanReceipts.map(item => item.receipt), { strict: true })) {
      return fail('preflight-accounting-receipt-cleanup-failed');
    }
  }
  if (provisional.status === 'hit') {
    const receiptIds = provisional.record.receipts.map(receipt => receipt.receipt_id);
    const expectedCacheBytes = cacheRecordBytes(cacheRecord(cacheKey, executable, resumeSkill, receiptIds));
    const authority = inspectCacheAuthority(cacheDir, cachePath, preflightRoot, expectedCacheBytes);
    if (authority.status === 'invalid') return fail('cache-invalid');
    const drift = revalidateBoundary();
    if (drift != null) return fail(drift);
    return activateRecord(provisional.record, { recovered: true });
  }
  if (lstatMaybe(cachePath) != null) {
    return fail('cache-invalid');
  }

  const currentReceipts = [];
  const failCurrent = reason => {
    if (currentReceipts.length === 0) return fail(reason, measuredUsage);
    const settled = settleRecord({ receipts: currentReceipts });
    if (settled.ok) removeExactRawReceipts(currentReceipts);
    return receiptManagedFailure(reason, measuredUsage, currentReceipts, settled.ok);
  };
  let readUsageReceipt;
  try {
    readUsageReceipt = validatePreflightUsageReceiptDescriptor({
      journalPath: join(processReceiptDir, `${nonce}-read.json`),
      root: canonicalProject,
      runId,
      cacheKey,
      smokeKind: 'read',
      attemptId: nonce,
      predecessorReceiptId: null,
      owner,
      generation,
    });
  } catch {
    return fail('preflight-invalid');
  }
  let drift = revalidateBoundary();
  if (drift != null) return fail(drift, measuredUsage);
  const readResult = runSmoke('read', readEntry, runSync, timeoutMs, readUsageReceipt);
  if (readResult.receipt != null) {
    currentReceipts.push(readResult.receipt);
    measuredUsage.push(readResult.usage);
  }
  if (!readResult.ok) {
    const boundaryFailure = revalidateBoundary();
    return failCurrent(boundaryFailure ?? readResult.reason);
  }

  drift = revalidateBoundary();
  if (drift != null) return failCurrent(drift);

  let writeUsageReceipt;
  try {
    writeUsageReceipt = validatePreflightUsageReceiptDescriptor({
      journalPath: join(processReceiptDir, `${nonce}-write.json`),
      root: canonicalProject,
      runId,
      cacheKey,
      smokeKind: 'write',
      attemptId: nonce,
      predecessorReceiptId: readResult.receipt.receipt_id,
      owner,
      generation,
    });
  } catch {
    return failCurrent('preflight-accounting-record-failed');
  }

  let initialWorkspace;
  try {
    if (lstatMaybe(workspace) != null) return failCurrent('probe-collision');
    mkdirSync(workspace, { mode: 0o700 });
    initialWorkspace = trustedDirectory(workspace, { parent: preflightRoot });
  } catch {
    try {
      if (lstatMaybe(workspace) != null && !cleanupWorkspace(workspace, removeWorkspace)) {
        return failCurrent('cleanup-failed');
      }
    } catch {
      return failCurrent('cleanup-failed');
    }
    return failCurrent('probe-setup-failed');
  }

  const writeResult = runSmoke('write', writeEntry, runSync, timeoutMs, writeUsageReceipt);
  let failureReason = null;
  if (writeResult.receipt != null) {
    currentReceipts.push(writeResult.receipt);
    measuredUsage.push(writeResult.usage);
  }
  if (!writeResult.ok) {
    failureReason = writeResult.reason;
  } else {
    failureReason = inspectSentinel(
      workspace,
      initialWorkspace,
      preflightRoot,
      sentinelName,
      nonce,
    );
  }

  if (!cleanupWorkspace(workspace, removeWorkspace)) return failCurrent('cleanup-failed');
  if (failureReason != null) return failCurrent(failureReason);
  drift = revalidateBoundary();
  if (drift != null) return failCurrent(drift);

  let record;
  try {
    if (currentReceipts.length !== 2
      || currentReceipts[0].smoke_kind !== 'read'
      || currentReceipts[1].smoke_kind !== 'write'
      || currentReceipts[1].predecessor_receipt_id !== currentReceipts[0].receipt_id) {
      throw new Error('receipt pair invalid');
    }
    record = accountingRecord({
      cacheKey,
      runId,
      attemptId: nonce,
      owner,
      generation,
      receipts: currentReceipts,
    });
  } catch {
    return failCurrent('preflight-accounting-record-failed');
  }
  const recordBytes = cacheRecordBytes(record);
  const inspectExactAccounting = () => {
    const inspected = inspectAccounting();
    if (inspected.status === 'hit'
      && canonicalJson(inspected.record) !== canonicalJson(record)) {
      return { status: 'invalid' };
    }
    return inspected;
  };
  if (!writeImmutableRecord(
    accountingDir,
    accountingPath,
    preflightRoot,
    recordBytes,
    inspectExactAccounting,
  )) {
    return failCurrent('preflight-accounting-record-failed');
  }
  const settled = settleRecord(record);
  if (!settled.ok) return accountingFailure(measuredUsage, settled.receiptIds);
  drift = revalidateBoundary();
  if (drift != null) {
    return {
      ...fail(drift, measuredUsage),
      accounting_settled: true,
      accounting_receipts: settled.receiptIds,
    };
  }
  const expectedCacheBytes = cacheRecordBytes(cacheRecord(cacheKey, executable, resumeSkill, settled.receiptIds));
  if (!writeCacheRecord(cacheDir, cachePath, preflightRoot, expectedCacheBytes)) {
    return {
      ...fail('cache-write-failed', measuredUsage),
      accounting_settled: true,
      accounting_receipts: settled.receiptIds,
    };
  }
  const activated = {
    ok: true,
    cache_hit: false,
    cache_key: cacheKey,
    measured_usage: measuredUsage,
    accounting_settled: true,
    accounting_receipts: settled.receiptIds,
  };
  removeExactRawReceipts(record.receipts);
  return activated;
}
