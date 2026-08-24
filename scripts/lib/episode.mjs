import { mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { runDir } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { atomicWrite } from './envelope.mjs';
import { slugify } from './slug.mjs';
import { leaseCheck } from './lease.mjs';
import { MUTATION_TURN_FLOOR } from './budget.mjs';
import { assertScopeAllows, bindMakerScope } from './session-scope.mjs';
import { normalizePortableRelativePath, pathWithin } from './fs-safe.mjs';
import { assertRoutingDigest, assertRoutingRecord } from './router-adapter.mjs';
import { observeTerminalEpisode } from './route-observation.mjs';

const NON_TERMINAL = ['pending', 'in_progress', 'blocked'];
const RECORDABLE_TERMINAL = ['done'];
const TERMINAL = RECORDABLE_TERMINAL;
const ALL_TERMINAL = ['done', 'approved', 'rejected', 'abandoned'];
const WORKSTREAM_TERMINAL = new Set(['ready', 'merged', 'abandoned']);

function artifactExpectation(loop, workstreamId) {
  const prefix = loop.workstreams.find(item => item.id === workstreamId)?.worktree;
  return prefix
    ? `expected root-relative, worktree-prefixed: ${prefix}/<path>`
    : 'expected root-relative path without absolute or .. segments';
}

function artifactError(code, artifact, loop, workstreamId) {
  return new Error(`${code}: ${artifact} (${artifactExpectation(loop, workstreamId)})`);
}

function requireNonterminalWorkstream(loop, workstreamId) {
  const workstream = loop.workstreams.find(item => item.id === workstreamId);
  if (!workstream) throw new Error(`WORKSTREAM_NOT_FOUND: ${workstreamId}`);
  if (WORKSTREAM_TERMINAL.has(workstream.status)) {
    throw new Error(`WORKSTREAM_TERMINAL_LOCKED: ${workstreamId} is ${workstream.status}`);
  }
  return workstream;
}

function episodeScopeTarget(loop, episode, { checkerTargetRequired = false } = {}) {
  if (episode?.role !== 'checker') return episode?.workstream_id ?? null;
  if (episode.target_maker) {
    const maker = loop.episodes.find(item => item.id === episode.target_maker);
    if (!maker || maker.role !== 'maker') {
      throw new Error(`REVIEW_TARGET_MAKER_INVALID: ${String(episode.target_maker)}`);
    }
    return maker.workstream_id;
  }
  if (checkerTargetRequired) {
    throw new Error(`SESSION_SCOPE_MISMATCH: checker has no target maker: ${String(episode?.id)}`);
  }
  return episode?.workstream_id ?? null;
}

function requestSkeleton({ id, plugin, role, kind, point, workstream, expectedArtifacts, evidence }) {
  return [
    `# Episode ${id} — request`, '',
    `- plugin: ${plugin}`, `- role: ${role}`, `- kind: ${kind}`,
    `- review point: ${point}`, `- workstream: ${workstream || '(none)'}`, '',
    '## Task', '', '<!-- Execution plane: fill the maker/checker task here -->', '',
    '## Expected artifacts', '', ...(expectedArtifacts.length ? expectedArtifacts.map(a => `- ${a}`) : ['- <!-- list proof artifacts -->']), '',
    // P2 codex r2/r3: checker가 읽을 evidence 사본 — durable 원본은 anchored loop.json의 episode.evidence다
    // (이 파일은 ## Task 편집이 허용되는 가변 문서). undefined면 섹션 자체를 생략(비-hill-climb).
    ...(evidence !== undefined ? ['## Evidence (kernel-verified insights)', '',
      '<!-- 사본 — anchored 원본은 loop.json episodes[].evidence. 불일치 시 loop.json이 이긴다. -->', '',
      '```json', JSON.stringify(evidence, null, 2), '```', ''] : []),
    '## Constraints', '', '- 이전 대화 컨텍스트를 가정하지 말라. loop.json + 이 request가 source of truth.', '',
  ].join('\n');
}

function normalizeRoutingInput(routing) {
  if (routing === undefined) return undefined;
  assertRoutingRecord(routing);
  return structuredClone(routing);
}

function createEpisode(root, runId, { plugin, role, kind, point, workstream = null, expectedArtifacts = [], targetMaker, reviewerResolution, evidence, contract, expectedReviewConfig, routing, initialStatus = 'pending', blockReason, fence, operation, now = Date.now() } = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error(`FENCE_REQUIRED: ${operation}`);
  // Fix 3: validate required non-fence args before any state write
  if (!plugin || typeof plugin !== 'string' || !plugin.length) throw new Error('EPISODE_INPUT_INVALID: plugin');
  if (!role || typeof role !== 'string' || !role.length) throw new Error('EPISODE_INPUT_INVALID: role');
  if (!['maker', 'checker'].includes(role)) throw new Error('EPISODE_INPUT_INVALID: role');
  if (!kind || typeof kind !== 'string' || !kind.length) throw new Error('EPISODE_INPUT_INVALID: kind');
  if (!point || typeof point !== 'string' || !point.length) throw new Error('EPISODE_INPUT_INVALID: point');
  if (!['pending', 'blocked'].includes(initialStatus)) throw new Error('EPISODE_INPUT_INVALID: initialStatus');
  if (routing !== undefined && role === 'maker') throw new Error('EPISODE_ROUTING_ROLE_INVALID');
  if (initialStatus === 'blocked' && role !== 'checker') throw new Error('EPISODE_INPUT_INVALID: only checker episodes may start blocked');
  if (initialStatus === 'blocked' && (!blockReason || typeof blockReason !== 'string')) throw new Error('EPISODE_INPUT_INVALID: blockReason');
  if (reviewerResolution !== undefined && (role !== 'checker' || reviewerResolution === null || typeof reviewerResolution !== 'object' || Array.isArray(reviewerResolution))) {
    throw new Error('EPISODE_INPUT_INVALID: reviewerResolution');
  }
  if (expectedReviewConfig !== undefined && (role !== 'checker' || expectedReviewConfig === null
    || typeof expectedReviewConfig !== 'object' || Array.isArray(expectedReviewConfig))) {
    throw new Error('EPISODE_INPUT_INVALID: expectedReviewConfig');
  }
  // Codex impl r7 🔴: expectedArtifacts must be an array of strings (a null/non-array would throw in the
  // loop below; though that is before appendAnchored, give a clean error rather than a raw TypeError).
  if (!Array.isArray(expectedArtifacts) || !expectedArtifacts.every(a => typeof a === 'string')) throw new Error('EPISODE_INPUT_INVALID: expectedArtifacts must be an array of strings');
  const frozenRouting = normalizeRoutingInput(routing);
  let id, requestPath, requestRel, dir;
  const safePlugin = slugify(plugin) || 'plugin';
  appendAnchored(root, runId, { type: 'episode-new', data: {
    plugin, role, kind, point,
    ...(initialStatus === 'blocked' ? { status: initialStatus, block_reason: blockReason } : {}),
    ...(reviewerResolution ? { reviewer_resolution: reviewerResolution } : {}),
    ...(frozenRouting !== undefined ? { routing: frozenRouting } : {}),
  }, now }, (loop) => {
    const n = String(loop.episodes.length + 1).padStart(3, '0');
    id = `${n}-${safePlugin}`;
    dir = join(runDir(root, runId), 'episodes', id);
    requestRel = `episodes/${id}/request.md`;
    requestPath = join(dir, 'request.md');
    const epObj = {
      id, plugin, role, kind, point, workstream_id: workstream, status: initialStatus,
      request_rel: requestRel, expected_artifacts: expectedArtifacts,
      verification: { checker_episode_required: role === 'maker', checker_plugin: 'deep-review', review_point: point, proof_required: expectedArtifacts },
    };
    if (targetMaker && typeof targetMaker === 'string' && targetMaker.length) epObj.target_maker = targetMaker;
    if (role === 'checker') epObj.requires_independent_session = true;
    if (reviewerResolution) epObj.reviewer_resolution = reviewerResolution;
    if (initialStatus === 'blocked') {
      epObj.block_reason = blockReason;
      epObj.needs_human = true;
    }
    // P2 codex r3: evidence/contract는 anchored loop.json이 원본 — request.md는 편집 가능한(## Task) 사본이라
    // durable 신뢰 원천이 될 수 없다. undefined면 필드 자체를 생략(비-hill-climb 무변화).
    if (evidence !== undefined) epObj.evidence = evidence;
    if (contract !== undefined) epObj.contract = contract;
    if (frozenRouting !== undefined) epObj.routing = structuredClone(frozenRouting);
    loop.episodes.push(epObj);
    loop.current_episode = id;
    if (role === 'maker') loop.comprehension.episodes_total = (loop.comprehension.episodes_total || 0) + 1;
    if (workstream) {
      // preCheck guarantees the workstream exists when non-null (Codex impl r14/r15) — bind episode to it.
      loop.workstreams.find(w => w.id === workstream).episodes.push(id);
    }
  }, (loop) => {
    const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);
    if (role === 'checker' && expectedReviewConfig !== undefined
      && JSON.stringify(loop.review) !== JSON.stringify(expectedReviewConfig)) {
      throw new Error('REVIEW_CONFIG_CHANGED: retry review dispatch');
    }
    // Codex impl r15 🟡: reject a non-null workstream that does not exist — otherwise a maker bound to a phantom
    // workstream becomes unreviewable (dispatchReview rightly rejects WORKSTREAM_NOT_FOUND at review time).
    const scopeTarget = role === 'checker' && targetMaker
      ? episodeScopeTarget(loop, { role, target_maker: targetMaker, workstream_id: workstream })
      : workstream;
    if (scopeTarget) {
      requireNonterminalWorkstream(loop, scopeTarget);
      if (loop.autonomy?.continuation_policy === 'workstream-session') {
        // Change F defensively admits null owner scope for a done checker target; bound cross-workstream scope stays
        // rejected. No kernel path to this topology has been demonstrated; the sole F test proves only that a
        // non-done target remains rejected, so the positive path is unproven.
        const targetIsDone = role === 'checker' && targetMaker
          && loop.episodes.find(e => e.id === targetMaker)?.status === 'done';
        assertScopeAllows(loop, scopeTarget, { allowUnbound: role === 'maker' || !targetMaker || targetIsDone });
      }
    }
    for (const artifact of expectedArtifacts) {
      if (!normalizePortableRelativePath(artifact)) {
        throw artifactError('EPISODE_ARTIFACT_UNSAFE', artifact, loop, scopeTarget);
      }
    }
    if (frozenRouting !== undefined) assertRoutingDigest(loop, frozenRouting);
  }, { floor: MUTATION_TURN_FLOOR });
  // Assert containment before FS writes
  const base = resolve(runDir(root, runId), 'episodes');
  const full = resolve(dir);
  if (full !== base && !full.startsWith(base + sep)) throw new Error('EPISODE_PATH_ESCAPE: ' + id);
  mkdirSync(dir, { recursive: true });
  atomicWrite(requestPath, requestSkeleton({ id, plugin, role, kind, point, workstream, expectedArtifacts, evidence }));
  return { id, requestPath, requestRel };
}

export function newEpisode(root, runId, { plugin, role, kind, point, workstream = null, expectedArtifacts = [], targetMaker, reviewerResolution, evidence, contract, expectedReviewConfig, routing, fence, now = Date.now() } = {}) {
  return createEpisode(root, runId, { plugin, role, kind, point, workstream, expectedArtifacts, targetMaker, reviewerResolution, evidence, contract, expectedReviewConfig, routing, fence, operation: 'newEpisode', now });
}

// Fail-closed compatibility path only: a checker with no independent dispatch capability is born blocked.
// Keeping this separate from newEpisode prevents makers (or arbitrary callers) from selecting an initial blocked state.
export function newBlockedCheckerEpisode(root, runId, { plugin, kind, point, workstream = null, targetMaker, reason, reviewerResolution, expectedReviewConfig, routing, fence } = {}) {
  return createEpisode(root, runId, {
    plugin, role: 'checker', kind, point, workstream, targetMaker, reviewerResolution,
    expectedReviewConfig, routing, initialStatus: 'blocked', blockReason: reason, fence, operation: 'newBlockedCheckerEpisode',
  });
}

// Human-gated escape hatch — settles a stranded non-terminal episode as abandoned.
// Separate from the record path to preserve the done-needs-proof invariant.
export function abandonEpisode(root, runId, episodeId, {
  reason, confirm, fence, now = Date.now(),
} = {}) {
  if (confirm !== true) throw new Error('CONFIRM_REQUIRED: pass --confirm (human-only)');
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: abandonEpisode');
  if (!episodeId || typeof episodeId !== 'string' || !episodeId.length) throw new Error('EPISODE_INPUT_INVALID: episodeId');
  if (!reason || typeof reason !== 'string' || !reason.length) throw new Error('EPISODE_INPUT_INVALID: reason');
  let committed = null;
  appendAnchored(root, runId, {
    type: 'episode-abandon', data: { id: episodeId, reason }, now,
  }, (loop, _spent, tx) => {
    const ep = loop.episodes.find(e => e.id === episodeId);
    ep.status = 'abandoned';
    ep.abandon_reason = reason;
    if (ep.role === 'maker') {
      const c = loop.comprehension || (loop.comprehension = {});
      c.episodes_total = Math.max(0, (c.episodes_total || 0) - 1);
      if (ep.human_reviewed) c.episodes_human_reviewed = Math.max(0, (c.episodes_human_reviewed || 0) - 1);
      if (ep.agent_reviewed) c.episodes_agent_reviewed = Math.max(0, (c.episodes_agent_reviewed || 0) - 1);
    }
    // P2-a: AFTER the decrement (which read the OLD human_reviewed), mark the abandoned episode reviewed so a later
    // `ack`/`recordReviewed` is a no-op — an abandoned maker is out of episodes_total and must never be re-counted
    // into episodes_human_reviewed (which would make reviewed/total exceed 1 and wrongly drop comprehension debt to 0).
    ep.human_reviewed = true;
    committed = {
      loop: structuredClone(loop), event: tx.event, episodeId, terminalStatus: 'abandoned',
    };
  }, (loop) => {
    const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);
    const ep = loop.episodes.find(e => e.id === episodeId);
    if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
    if (ALL_TERMINAL.includes(ep.status)) throw new Error('EPISODE_ALREADY_TERMINAL: ' + episodeId);
    const scopeTarget = episodeScopeTarget(loop, ep);
    if (scopeTarget) {
      if (!loop.workstreams.find(item => item.id === scopeTarget)) {
        throw new Error(`WORKSTREAM_NOT_FOUND: ${scopeTarget}`);
      }
      if (loop.autonomy?.continuation_policy === 'workstream-session') {
        // next-action.mjs:81 routes an orphan maker to await_human BEFORE the debt check, and the status skill
        // offers `episode abandon --confirm` as the only recovery. That remedy must be executable before the owner
        // scope is bound. abandon only READS the scope — binding stays exclusive to bindMakerScope.
        assertScopeAllows(loop, scopeTarget, { allowUnbound: true });
      }
    }
  }, { floor: MUTATION_TURN_FLOOR });
  return { observation: observeTerminalEpisode(root, runId, committed) };
}

export function recordEpisode(root, runId, episodeId, {
  status, artifacts = [], proof = {}, routing, fence, now = Date.now(),
} = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: recordEpisode');
  // Fix 3: episodeId must be a non-empty string
  if (!episodeId || typeof episodeId !== 'string' || !episodeId.length) throw new Error('EPISODE_INPUT_INVALID: episodeId');
  // Cheap input validation BEFORE appendAnchored (no state access needed). Codex impl r7 🔴:
  // a null/non-array `artifacts` or null/non-object `proof` would otherwise throw INSIDE the mutate
  // (after the event is appended), staling event_log_head → BUDGET_TAMPERED on next reconcile.
  if (status === 'approved' || status === 'rejected') {
    throw new Error('EPISODE_TERMINAL_VIA_REVIEW: approved/rejected are written only by review record / review import');
  }
  if (![...NON_TERMINAL, ...TERMINAL].includes(status)) throw new Error(`EPISODE_STATUS_INVALID: ${status}`);
  if (!Array.isArray(artifacts) || !artifacts.every(a => typeof a === 'string')) throw new Error('EPISODE_INPUT_INVALID: artifacts must be an array of strings');
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) throw new Error('EPISODE_INPUT_INVALID: proof must be an object');
  if (routing !== undefined && status !== 'in_progress') throw new Error('EPISODE_ROUTING_STATUS_INVALID');
  const frozenRouting = normalizeRoutingInput(routing);
  let committed = null;
  appendAnchored(root, runId, {
    type: 'episode-record',
    data: { id: episodeId, status, artifacts, ...(frozenRouting !== undefined ? { routing: frozenRouting } : {}) },
    now,
  }, (loop, _spent, tx) => {
    const ep = loop.episodes.find(e => e.id === episodeId);
    if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);   // 방어적
    if (status === 'in_progress' && ep.role === 'maker'
      && loop.autonomy?.continuation_policy === 'workstream-session') {
      bindMakerScope(loop, ep, tx.event_identity.seq);
    }
    // Review credit belongs to a SETTLED diff. When a maker confirms its output, any review flag recorded before
    // that point was about a change which did not exist yet, so it is invalidated here. Same anchored transaction
    // as the episode-record event (invariant 3) and no new lock (invariant 7) — mirrors abandonEpisode's counter
    // adjustment. Math.max keeps the counters non-negative; `done` cannot be re-recorded (see the preCheck), so
    // this can never double-decrement.
    if (status === 'done' && ep.role === 'maker') {
      const c = loop.comprehension || (loop.comprehension = {});
      if (ep.human_reviewed) { ep.human_reviewed = false; c.episodes_human_reviewed = Math.max(0, (c.episodes_human_reviewed || 0) - 1); }
      if (ep.agent_reviewed) { ep.agent_reviewed = false; c.episodes_agent_reviewed = Math.max(0, (c.episodes_agent_reviewed || 0) - 1); }
    }
    ep.status = status;
    if (artifacts.length) ep.artifacts = artifacts;
    if (frozenRouting !== undefined) ep.routing = structuredClone(frozenRouting);
    for (const [k, v] of Object.entries(proof)) if (/^result_[A-Za-z0-9_]+$/.test(k)) ep[k] = v;
    if (status === 'done') {
      committed = {
        loop: structuredClone(loop), event: tx.event, episodeId, terminalStatus: status,
      };
    }
  }, (loop) => {
    // Codex r3 🔴: All throwing validations inside preCheck (run on fresh loop, before append)
    if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
    const ep = loop.episodes.find(e => e.id === episodeId);
    if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
    // Codex r3 🔴2 + R1 f2/R2 f1: 현재 status 가 터미널(abandoned 포함)이면 요청 status 무관하게 재기록 불가.
    if (ALL_TERMINAL.includes(ep.status)) {
      throw new Error('EPISODE_ALREADY_TERMINAL: ' + episodeId);
    }
    if (ep.role === 'checker' && status === 'done') {
      throw new Error(`EPISODE_CHECKER_DONE_FORBIDDEN: ${episodeId} checker terminal is written only by review record / review import / episode abandon`);
    }
    if (frozenRouting !== undefined) {
      if (status !== 'in_progress') throw new Error('EPISODE_ROUTING_STATUS_INVALID');
      if (ep.role !== 'maker') throw new Error('EPISODE_ROUTING_ROLE_INVALID');
      if (Object.hasOwn(ep, 'routing')) throw new Error('EPISODE_ROUTING_FROZEN');
      if (ep.status !== 'pending') throw new Error('EPISODE_ROUTING_TRANSITION_INVALID');
      assertRoutingDigest(loop, frozenRouting);
    }
    const newPolicy = loop.autonomy?.continuation_policy === 'workstream-session';
    const scopeTarget = episodeScopeTarget(loop, ep, {
      checkerTargetRequired: newPolicy && status === 'in_progress',
    });
    // Change H: a maker's settlement (done) requires a workstream just as in_progress does. Without it the record
    // creates an unbound-proof-episode dead-end (next-action.mjs:110/:117/:214) that has NO remedy — abandonEpisode
    // rejects a done episode (episode.mjs:178) and ack cannot change routing (makerReviewed is checker-based).
    if (newPolicy && ep.role === 'maker' && status === 'done' && !scopeTarget) {
      throw new Error(`WORKSTREAM_REQUIRED: ${episodeId}`);
    }
    if (newPolicy && status === 'in_progress' && ep.role === 'maker') {
      if (!scopeTarget) throw new Error(`WORKSTREAM_REQUIRED: ${episodeId}`);
      requireNonterminalWorkstream(loop, scopeTarget);
      assertScopeAllows(loop, scopeTarget, { allowUnbound: true });
    } else if (scopeTarget) {
      requireNonterminalWorkstream(loop, scopeTarget);
      if (newPolicy) {
        assertScopeAllows(loop, scopeTarget);
      }
    }
    // 터미널은 커널이 proof에서 파생 — 검증 후에만 (spec §4)
    if (TERMINAL.includes(status)) {
      if (status === 'done') {
        const expected = (ep.expected_artifacts || []);
        const rootResolved = realpathSync(resolve(root));
        for (const artifact of artifacts) {
          const normalized = normalizePortableRelativePath(artifact);
          if (!normalized) throw artifactError('EPISODE_ARTIFACT_ESCAPE', artifact, loop, scopeTarget);
          const full = resolve(root, normalized);
          if (existsSync(full)) {
            let canonical;
            try { canonical = realpathSync(full); }
            catch { throw artifactError('EPISODE_ARTIFACT_ESCAPE', artifact, loop, scopeTarget); }
            if (!pathWithin(rootResolved, canonical)) {
              throw artifactError('EPISODE_ARTIFACT_ESCAPE', artifact, loop, scopeTarget);
            }
          }
        }
        for (const artifact of expected) {
          if (!normalizePortableRelativePath(artifact)) {
            throw artifactError('EPISODE_ARTIFACT_ESCAPE', artifact, loop, scopeTarget);
          }
        }
        const missing = expected.filter(artifact => {
          const normalized = normalizePortableRelativePath(artifact);
          return !normalized || !existsSync(resolve(root, normalized));
        });
        if (expected.length === 0 || missing.length) {
          throw new Error(`EPISODE_TERMINAL_NO_PROOF: ${episodeId} done requires existing artifacts (missing: ${missing.join(',') || 'none-declared'})`);
        }
        // Codex r2 🟡: 제출된 artifacts 가 expected_artifacts 를 모두 커버하는지 확인.
        const submitted = new Set(artifacts);
        const uncovered = expected.filter(a => !submitted.has(a));
        if (uncovered.length) throw new Error('EPISODE_ARTIFACTS_INCOMPLETE: ' + uncovered.join(','));
      }
    }
  }, { floor: MUTATION_TURN_FLOOR });
  if (!committed) return undefined;
  return { observation: observeTerminalEpisode(root, runId, committed) };
}
