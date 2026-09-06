import { existsSync, realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, join, resolve, relative, dirname, basename } from 'node:path';
import { captureReconciledRunSnapshot } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { slugify } from './slug.mjs';
import { leaseCheck } from './lease.mjs';
import { MUTATION_TURN_FLOOR } from './budget.mjs';
import { normalizePortableRelativePath, pathWithin } from './fs-safe.mjs';
import { assertScopeAllows, closeScope } from './session-scope.mjs';
import { workstreamClosureProofState } from './finish.mjs';
import { assertGoalWorkstreamInput } from './goal-contract.mjs';

const NON_TERMINAL = ['planned', 'in_progress', 'in_review', 'parked'];
const TERMINAL = ['ready', 'merged', 'abandoned'];

export function newWorkstream(root, runId, {
  title, branch, worktree, baseCommit = null, dependsOn = [], requirementIds, fence, now = Date.now(),
} = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: newWorkstream');
  if (typeof title !== 'string' || title.length === 0 ||
      typeof branch !== 'string' || branch.length === 0 ||
      typeof worktree !== 'string' || worktree.length === 0) {
    throw new Error('WORKSTREAM_INPUT_INVALID: title/branch/worktree must be non-empty strings');
  }
  if (!Array.isArray(dependsOn) || dependsOn.some(d => typeof d !== 'string' || d.length === 0)) {
    throw new Error('WORKSTREAM_INPUT_INVALID: dependsOn must be an array of strings');
  }
  // §0.6-2: containment — worktree must resolve strictly inside a convention dir:
  //   <root>/.claude/worktrees/  OR  <root>/.worktrees/
  // Root-self ('.', root) and arbitrary under-root paths are rejected; only convention dirs accepted.
  // R5 P2-2: existing paths use realpathSync (blocks symlink escapes); non-existent paths walk up to
  // the nearest existing ancestor for symlink resolution (handles /tmp→/private/tmp on macOS).
  const _rootResolved = realpathSync(root);
  function _resolveDeep(p) {
    const abs = resolve(p);
    if (existsSync(abs)) return realpathSync(abs);
    // FIX M: existsSync follows symlinks and returns false for dangling symlinks.
    // lstatSync does NOT follow symlinks — it detects the symlink itself even when dangling.
    // A dangling symlink component must be rejected: once the target is created the path escapes.
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new Error('WORKSTREAM_WORKTREE_ESCAPE: dangling symlink component: ' + abs);
    } catch (e) {
      if (e.message.startsWith('WORKSTREAM_WORKTREE_ESCAPE')) throw e;
      if (e?.code !== 'ENOENT') {
        throw new Error('WORKSTREAM_WORKTREE_ESCAPE: unresolved worktree component: ' + abs, { cause: e });
      }
      // ENOENT → truly absent leaf; continue walking up
    }
    const par = dirname(abs);
    if (par === abs) return abs; // filesystem root — can't walk further
    return join(_resolveDeep(par), basename(abs));
  }
  const _absoluteInput = isAbsolute(worktree);
  const _portableInput = _absoluteInput ? null : normalizePortableRelativePath(worktree);
  if (!_absoluteInput && !_portableInput) {
    throw new Error('WORKSTREAM_WORKTREE_ESCAPE: invalid relative worktree path: ' + worktree);
  }
  const _wtBase = _absoluteInput ? worktree : join(_rootResolved, _portableInput);
  const _wtResolved = _resolveDeep(_wtBase);
  // Convention prefixes are lexical (rooted at resolved root) — do NOT resolve the convention dirs
  // themselves, so a symlinked .claude/worktrees pointing outside root is still rejected.
  const _conv1 = join(_rootResolved, '.claude', 'worktrees');
  const _conv2 = join(_rootResolved, '.worktrees');
  const _underConvention = [_conv1, _conv2].some(base =>
    pathWithin(base, _wtResolved) && relative(base, _wtResolved) !== '');
  if (worktree.split(/[/\\]/).includes('..') || !_underConvention) {
    throw new Error('WORKSTREAM_WORKTREE_ESCAPE: worktree must resolve under project root: ' + worktree);
  }
  // FIX Q: normalize stored worktree to root-relative form regardless of whether caller passed an
  // absolute or relative path — stored value must be root-relative so artifact prefixes derived from
  // it stay root-relative and pass episode.mjs containment (absolute/.. paths are rejected there).
  const _storedWorktree = normalizePortableRelativePath(relative(_rootResolved, _wtResolved));
  if (!_storedWorktree) throw new Error('WORKSTREAM_WORKTREE_ESCAPE: worktree is not durably relative: ' + worktree);
  let id;
  appendAnchored(root, runId, { type: 'workstream-new', data: { title }, now }, (loop) => {
    const n = String(loop.workstreams.length + 1).padStart(2, '0');
    id = `ws-${n}-${slugify(title) || 'ws'}`;
    loop.workstreams.push({
      id, title, status: 'planned', branch, worktree: _storedWorktree, base_commit: baseCommit,
      dirty_on_handoff: false, pr: { intended: true, state: 'none', url: null },
      episodes: [], review_points_done: [], depends_on: dependsOn,
      ...(requirementIds !== undefined ? { requirement_ids: [...requirementIds] } : {}),
    });
  }, (loop) => {
    const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);
    assertGoalWorkstreamInput(loop, requirementIds, dependsOn);
  }, { floor: MUTATION_TURN_FLOOR });
  return { id };
}

export function setWorkstreamStatus(root, runId, wsId, status, opts = {}) {
  if (TERMINAL.includes(status)) throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${status} is kernel-derived (use recordWorkstreamTerminal)`);
  if (!NON_TERMINAL.includes(status)) throw new Error(`WORKSTREAM_STATUS_INVALID: ${status}`);
  const { fence, now = Date.now() } = opts;
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: setWorkstreamStatus');
  // #3 (R1 Fix 2): route through appendAnchored so this status flip (which drives active_workstreams — a finish
  // proof input — and non-terminal status — a next-action routing input) is BOTH tamper-evident (was a silent
  // withLock+writeState) AND floor-charged. All throwing guards move to preCheck (fresh loop, before the append)
  // so a rejected transition never stales the anchor; the mutate is pure.
  appendAnchored(root, runId, { type: 'workstream-status', data: { id: wsId, status }, now },
    (loop) => {
      if (status === 'in_progress' && !loop.active_workstreams.includes(wsId)) loop.active_workstreams.push(wsId);
      if (status === 'parked') loop.active_workstreams = loop.active_workstreams.filter(x => x !== wsId);
      loop.workstreams.find(w => w.id === wsId).status = status;
    },
    (loop) => {
      if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
      const ws = loop.workstreams.find(w => w.id === wsId);
      if (!ws) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
      if (['ready', 'merged', 'abandoned'].includes(ws.status)) throw new Error(`WORKSTREAM_TERMINAL_LOCKED: ${wsId} is ${ws.status}`);
      if (loop.autonomy?.continuation_policy === 'workstream-session') {
        assertScopeAllows(loop, wsId, { allowUnbound: true });
      }
      if (status === 'in_progress' && !loop.active_workstreams.includes(wsId)) {
        const cap = loop.autonomy?.max_parallel ?? 2;
        if (loop.active_workstreams.length >= cap) throw new Error(`MAX_PARALLEL_EXCEEDED: ${loop.active_workstreams.length}/${cap}`);
      }
    },
    { floor: MUTATION_TURN_FLOOR });
}

export function recordWorkstreamTerminal(root, runId, wsId, {
  status, proof = {}, confirm, fence, now = Date.now(),
} = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: recordWorkstreamTerminal');
  appendAnchored(root, runId, {
    type: 'workstream-terminal', data: { id: wsId, status, proof }, now,
  }, (loop, _spent, tx) => {
    const w = loop.workstreams.find(x => x.id === wsId);
    if (!w) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
    const newPolicy = loop.autonomy?.continuation_policy === 'workstream-session';
    const closesAffinity = newPolicy
      && NON_TERMINAL.includes(w.status)
      && (status === 'ready' || status === 'abandoned');
    w.status = status;
    if (closesAffinity) {
      (w.terminal_events ??= []).push(tx.event_identity);
      closeScope(loop, wsId, tx.event_identity, tx.event.ts);
    } else if (!newPolicy) {
      (w.terminal_events ??= []).push(`${tx.event_identity.seq}:${wsId}:${status}`);
    }
    loop.active_workstreams = loop.active_workstreams.filter(x => x !== wsId);
  }, (loop) => {
    // Codex r3 🔴: all throwing validations inside preCheck on fresh loop (atomic terminal guard)
    if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
    if (!TERMINAL.includes(status)) throw new Error(`WORKSTREAM_STATUS_INVALID: ${status} is not terminal`);
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
      throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${wsId} requires proof object`);
    }
    const ws = loop.workstreams.find(w => w.id === wsId);
    if (!ws) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
    const newPolicy = loop.autonomy?.continuation_policy === 'workstream-session';
    if (status === 'merged' && ws.status !== 'ready') {
      throw new Error(`WORKSTREAM_TERMINAL_LOCKED: ${wsId} ${ws.status}->merged not allowed`);
    }
    // Codex r2 🔴: 터미널→터미널 전환 차단 — merged/abandoned 는 흡수 상태; 유일한 허용 전환은 ready→merged.
    if (TERMINAL.includes(ws.status)) {
      if (!(ws.status === 'ready' && status === 'merged')) {
        throw new Error('WORKSTREAM_TERMINAL_LOCKED: ' + wsId + ' ' + ws.status + '->' + status + ' not allowed');
      }
    }
    if (newPolicy && status === 'abandoned' && confirm !== true) {
      throw new Error('CONFIRM_REQUIRED: abandoned requires --confirm (human-only)');
    }
    if (newPolicy && status !== 'abandoned' && confirm !== undefined) {
      throw new Error('CONFIRM_FORBIDDEN: --confirm is only valid for abandoned');
    }
    const closesAffinity = newPolicy
      && NON_TERMINAL.includes(ws.status)
      && (status === 'ready' || status === 'abandoned');
    if (closesAffinity) {
      assertScopeAllows(loop, wsId);
      const closure = workstreamClosureProofState(loop, wsId);
      if (!closure.ok) {
        throw new Error(`WORKSTREAM_CLOSURE_UNMET: ${wsId} ${closure.missing.join(',')}`);
      }
    }
    const reviewPoints = (loop.review?.points || []);
    const ok =
      status === 'ready'     ? (reviewPoints.length > 0 && reviewPoints.every(p => (ws.review_points_done || []).includes(p))) :
      status === 'merged'    ? (typeof proof.merge_commit === 'string' && proof.human_approved === true) :
      status === 'abandoned' ? (typeof proof.reason === 'string' && proof.reason.length > 0) : false;
    if (!ok) throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${wsId} -> ${status} proof insufficient`);
  }, { floor: MUTATION_TURN_FLOOR });
}

// respawn 인수: active worktree 경로가 디스크에 존재하는지만 확인. 누락은 조용히 재생성 ❌ → fail-safe.
export function inheritWorkstreams(root, runId) {
  const { data } = captureReconciledRunSnapshot(root, runId);
  const inherited = [], missing = [];
  for (const id of data.active_workstreams) {
    const ws = data.workstreams.find(w => w.id === id);
    if (!ws) { missing.push({ id, reason: 'workstream-record-missing' }); continue; }
    const path = isAbsolute(ws.worktree) ? ws.worktree : join(root, ws.worktree);
    if (existsSync(path)) inherited.push(id);
    else missing.push({ id, worktree: ws.worktree, reason: 'worktree-path-missing' });
  }
  return { inherited, missing };
}

// 머지 순서 = depends_on 위상정렬 (spec §8.1). 순환 + 미지 의존 탐지.
export function integrationOrder(loop) {
  const ws = loop.workstreams || [];
  const ids = new Set(ws.map(w => w.id));
  // Codex r2 🟡9: 미지 의존을 silent drop 하지 않는다 — 오타/누락 id 는 needs-human 에스컬레이션.
  const missing = [];
  for (const w of ws) for (const d of (Array.isArray(w.depends_on) ? w.depends_on : [])) if (!ids.has(d)) missing.push({ id: w.id, missing_dep: d });
  if (missing.length) return { order: [], cycle: false, missing };
  const deps = new Map(ws.map(w => [w.id, (Array.isArray(w.depends_on) ? w.depends_on : [])]));
  const order = [], state = new Map(); // 0=unseen 1=visiting 2=done
  let cycle = false;
  const visit = (id) => {
    if (cycle) return;
    const s = state.get(id) || 0;
    if (s === 2) return;
    if (s === 1) { cycle = true; return; }
    state.set(id, 1);
    for (const d of deps.get(id) || []) visit(d);
    state.set(id, 2);
    order.push(id);
  };
  for (const w of ws) visit(w.id);
  return { order: cycle ? [] : order, cycle, missing: [] };
}
