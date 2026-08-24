import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureLatestInsightsSet, latestInsights } from './insights.mjs';
import { captureReconciledRunSnapshot } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { newBlockedCheckerEpisode, newEpisode } from './episode.mjs';
import { leaseCheck } from './lease.mjs';
import { pluginPresent } from './detect.mjs';
import { checkerDescriptor } from './adapters.mjs';
import { attachRoutingToDescriptor } from './router-adapter.mjs';
import { containedRealFile } from './fs-safe.mjs';
import { MUTATION_TURN_FLOOR } from './budget.mjs';
import { sessionRuntime } from './runtime.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import { validate } from './schema.mjs';
import { assertScopeAllows } from './session-scope.mjs';
import { epOrder, isProofCapableChecker } from './episode-predicates.mjs';
import { observeTerminalEpisode } from './route-observation.mjs';
import {
  deriveReviewArtifactContract,
  parseReviewImport,
  prepareImportedReview,
  sha256File,
  validateImportedEvidence,
  REVIEW_ATTEMPT_ID,
} from './review-import.mjs';

export { epOrder, isProofCapableChecker };

const REVIEW_CONFIG_TERMINAL = new Set(['done', 'approved', 'rejected', 'abandoned']);
const REVIEW_RECOVERY_PROFILES = Object.freeze({
  'codex-only-static': Object.freeze(['--contract', '--codex-only', '--reviewer-strategy', 'static']),
  'gpt56-agy-static': Object.freeze([
    '--contract', '--no-fallback', '--no-opus', '--agy', '--codex', '--reviewer-strategy', 'static',
    '--reviewer-model', 'codex-review=gpt-5.6-sol',
    '--reviewer-model', 'codex-adversarial=gpt-5.6-sol',
    '--reviewer-model', 'agy=gemini-3.6-flash-high',
    '--reviewer-effort', 'codex-review=high',
    '--reviewer-effort', 'codex-adversarial=high',
  ]),
});

export function configureReviewFlags(root, runId, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('REVIEW_CONFIG_INPUT_INVALID');
  }
  const { profile, sourceCheckerId, confirm, fence } = options;
  if (confirm !== true) throw new Error('CONFIRM_REQUIRED: pass --confirm (human-only)');
  validFence(fence, 'configureReviewFlags');
  if (!Object.hasOwn(REVIEW_RECOVERY_PROFILES, profile)) {
    throw new Error(`REVIEW_CONFIG_PROFILE_INVALID: ${String(profile)}`);
  }
  if (!sourceCheckerId || typeof sourceCheckerId !== 'string') {
    throw new Error('REVIEW_CONFIG_SOURCE_INVALID: source checker is required');
  }
  const nextFlags = [...REVIEW_RECOVERY_PROFILES[profile]];

  appendAnchored(root, runId, {
    type: 'review-configured',
    data: { profile, source_checker: sourceCheckerId, flags: nextFlags },
  }, (loop) => {
    const source = loop.episodes.find(episode => episode.id === sourceCheckerId);
    source.review_reconfiguration_consumed = true;
    loop.review.flags = nextFlags;
  }, (loop) => {
    const checked = leaseCheck(loop, fence);
    if (!checked.ok) throw new Error('LEASE_FENCED: ' + checked.reason);
    if (!loop.review || typeof loop.review !== 'object' || Array.isArray(loop.review)) {
      throw new Error('STATE_INVALID: review config');
    }
    if (loop.review.reviewer !== 'deep-review-loop') {
      throw new Error(`REVIEW_CONFIG_REVIEWER_INVALID: ${String(loop.review.reviewer)}`);
    }
    const checkers = (loop.episodes || []).filter(episode => episode?.role === 'checker');
    const source = checkers.find(episode => episode.id === sourceCheckerId);
    const sourceMaker = source?.target_maker
      ? loop.episodes.find(episode => episode.id === source.target_maker)
      : null;
    if (!source || source.plugin !== 'deep-review' || source.status !== 'abandoned'
      || typeof source.abandon_reason !== 'string'
      || !/^operational-review-failure:\s*\S/.test(source.abandon_reason)
      || !sourceMaker || sourceMaker.role !== 'maker' || sourceMaker.status !== 'done'
      || sourceMaker.workstream_id !== source.workstream_id || sourceMaker.point !== source.point) {
      throw new Error(`REVIEW_CONFIG_SOURCE_INVALID: ${sourceCheckerId}`);
    }
    const latest = checkers.reduce((current, episode) => (
      !current || epOrder(episode.id, current.id) > 0 ? episode : current
    ), null);
    if (latest?.id !== sourceCheckerId) {
      throw new Error(`REVIEW_CONFIG_SOURCE_STALE: ${sourceCheckerId}`);
    }
    if (source.review_reconfiguration_consumed === true) {
      throw new Error(`REVIEW_CONFIG_SOURCE_CONSUMED: ${sourceCheckerId}`);
    }
    const activeChecker = (loop.episodes || []).find(episode => episode?.role === 'checker'
      && !REVIEW_CONFIG_TERMINAL.has(episode.status));
    if (activeChecker) {
      throw new Error(`REVIEW_CONFIG_ACTIVE_CHECKER: ${activeChecker.id}`);
    }
  }, { floor: MUTATION_TURN_FLOOR });

  return { ok: true, profile, source_checker: sourceCheckerId, flags: nextFlags };
}

export function findPendingIndependentChecker(loop) {
  const eligible = episode => episode?.role === 'checker'
    && episode.status === 'pending'
    && episode.requires_independent_session === true;
  const current = (loop?.episodes || []).find(episode => episode.id === loop?.current_episode);
  if (eligible(current)) return current;
  return (loop?.episodes || []).find(eligible) || null;
}

function boundedBlockReason(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('REVIEW_BLOCK_REASON_INVALID: bounded safe reason required');
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function checkIndependentReviewFence(loop, fence) {
  const runtime = sessionRuntime(loop);
  const checkedFence = leaseCheck(loop, { ...fence, runtime });
  if (!checkedFence.ok) throw new Error('LEASE_FENCED: ' + checkedFence.reason);
  return runtime;
}

function claimedContext(root, loop, episodeId, attemptId, fence) {
  const runtime = checkIndependentReviewFence(loop, fence);
  const context = snapshotContext(loop, episodeId);
  const checker = context.checker;
  if (!checker) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
  if (checker.role !== 'checker' || checker.requires_independent_session !== true) {
    throw new Error('REVIEW_CLAIM_TARGET_INVALID: independent checker required');
  }
  if (!isProofCapableChecker(checker)) throw new Error('REVIEW_CLAIM_REVIEWER_INVALID: proof-capable checker required');
  if (!context.maker || context.maker.role !== 'maker' || context.maker.status !== 'done') {
    throw new Error('REVIEW_CLAIM_MAKER_INVALID: bound done maker required');
  }
  if (!context.workstream || checker.workstream_id !== context.maker.workstream_id
    || checker.point !== context.maker.point) throw new Error('REVIEW_CLAIM_BINDING_INVALID');
  if (loop.autonomy?.continuation_policy === 'workstream-session') {
    // Change F is defensive: allowUnbound admits only a null owner scope; a bound cross-workstream owner stays
    // rejected. No kernel path to this topology has been demonstrated, and the sole F test proves only rejection
    // for a non-done target, not this positive path.
    assertScopeAllows(loop, context.maker.workstream_id, { allowUnbound: true });
  }
  const artifacts = deriveReviewArtifactContract(root, context.maker, context.workstream);
  const lease = loop.session_chain?.lease || {};
  const claim = {
    run_id: loop.run_id,
    reviewer_id: checker.plugin,
    checker_episode_id: checker.id,
    target_maker: context.maker.id,
    attempt_id: attemptId,
    workstream_id: checker.workstream_id,
    point: checker.point,
    project_root: canonicalProjectRoot(root),
    runtime,
    lease_owner: lease.owner_run_id,
    lease_generation: lease.generation,
    artifacts,
    ...(checker.evidence !== undefined ? { evidence: checker.evidence } : {}),
    ...(checker.contract !== undefined ? { contract: checker.contract } : {}),
  };
  return { ...context, runtime, claim };
}

export function claimIndependentReview(root, runId, options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) throw new Error('REVIEW_CLAIM_INPUT_INVALID');
  for (const key of ['attemptId', 'attempt_id', 'reviewer_id', 'target_maker', 'runtime', 'project_root', 'artifacts', 'evidence', 'contract']) {
    if (Object.hasOwn(options, key)) throw new Error(`REVIEW_METADATA_FORBIDDEN: claim derives ${key}`);
  }
  const { episodeId, fence, attemptIdFactory = randomUUID } = options;
  validFence(fence, 'claimIndependentReview');
  if (typeof episodeId !== 'string' || episodeId.length === 0) throw new Error('REVIEW_CLAIM_INPUT_INVALID: episodeId');
  if (typeof attemptIdFactory !== 'function') throw new Error('REVIEW_CLAIM_INPUT_INVALID: attemptIdFactory');
  const attemptId = attemptIdFactory();
  if (!REVIEW_ATTEMPT_ID.test(attemptId || '')) throw new Error('REVIEW_CLAIM_ATTEMPT_INVALID');
  const eventData = { episode_id: episodeId, attempt_id: attemptId };
  let context;
  let alreadyClaimed = false;
  try {
    appendAnchored(root, runId, { type: 'independent-review-claimed', data: eventData }, (loop) => {
      const checker = loop.episodes.find(episode => episode.id === episodeId);
      checker.status = 'in_progress';
      checker.attempt_id = attemptId;
      checker.review_claim = context.claim;
    }, (loop) => {
      checkIndependentReviewFence(loop, fence);
      const checker = loop.episodes.find(episode => episode.id === episodeId);
      if (checker?.status === 'in_progress' && checker.review_claim) {
        alreadyClaimed = true;
        throw Object.assign(new Error('REVIEW_ALREADY_CLAIMED'), { alreadyClaimed: true });
      }
      if (loop.status !== 'running') throw new Error('REVIEW_CLAIM_RUN_NOT_RUNNING');
      if (checker?.status !== 'pending') throw new Error('REVIEW_CLAIM_NOT_PENDING');
      context = claimedContext(root, loop, episodeId, attemptId, fence);
      Object.assign(eventData, {
        reviewer_id: context.claim.reviewer_id,
        target_maker: context.claim.target_maker,
        workstream_id: context.claim.workstream_id,
        point: context.claim.point,
        artifacts: context.claim.artifacts,
      });
    });
  } catch (error) {
    if (error?.alreadyClaimed === true || alreadyClaimed) return { ok: false, reason: 'already-claimed' };
    throw error;
  }
  return { ok: true, checkerEpisodeId: episodeId, attemptId, claim: context.claim };
}

export function blockIndependentReview(root, runId, options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) throw new Error('REVIEW_BLOCK_INPUT_INVALID');
  const { episodeId, attemptId, reason, fence } = options;
  validFence(fence, 'blockIndependentReview');
  if (!REVIEW_ATTEMPT_ID.test(attemptId || '')) throw new Error('REVIEW_BLOCK_ATTEMPT_INVALID');
  const safeReason = boundedBlockReason(reason);
  let locked;
  appendAnchored(root, runId, { type: 'independent-review-blocked', data: {
    episode_id: episodeId, attempt_id: attemptId, reason: safeReason,
  } }, (loop) => {
    const checker = locked.checker;
    checker.status = 'blocked';
    checker.block_reason = safeReason;
    checker.needs_human = true;
    loop.status = 'paused';
    loop.pause_reason = `independent-review:${safeReason}`;
    loop.session_chain.lease.resume_policy = 'human';
    loop.session_chain.lease.expires_at = null;
  }, (loop) => {
    checkIndependentReviewFence(loop, fence);
    const checker = loop.episodes.find(episode => episode.id === episodeId);
    if (checker?.status !== 'in_progress' || checker.attempt_id !== attemptId || !checker.review_claim) {
      throw new Error('REVIEW_BLOCK_CLAIM_MISMATCH');
    }
    locked = claimedContext(root, loop, episodeId, attemptId, fence);
    if (!sameJson(checker.review_claim, locked.claim)) throw new Error('REVIEW_BLOCK_CLAIM_MISMATCH');
  });
  return { ok: true, status: 'blocked', reason: safeReason };
}

export function revalidateIndependentReviewClaim(root, runId, options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) throw new Error('REVIEW_CLAIM_INPUT_INVALID');
  const { episodeId, attemptId, fence } = options;
  validFence(fence, 'revalidateIndependentReviewClaim');
  if (!REVIEW_ATTEMPT_ID.test(attemptId || '')) throw new Error('REVIEW_CLAIM_ATTEMPT_INVALID');
  const { data: loop } = captureReconciledRunSnapshot(root, runId);
  const checker = loop.episodes.find(episode => episode.id === episodeId);
  if (checker?.status !== 'in_progress' || checker.attempt_id !== attemptId || !checker.review_claim) {
    throw new Error('REVIEW_CLAIM_MISMATCH');
  }
  const fresh = claimedContext(root, loop, episodeId, attemptId, fence);
  if (!sameJson(checker.review_claim, fresh.claim)) throw new Error('REVIEW_CLAIM_MISMATCH');
  return { ok: true, claim: fresh.claim };
}

// impl-R2 Fix 4: a passing verdict's report must be BOUND to the reviewed workstream — its realpath must sit under
// the workstream's worktree directory. This stops an unrelated stale file (README.md, another ws's report) from
// being reused as fake evidence. `realReport` is already a realpath (via containedRealFile); worktree is realpath'd
// too so a symlinked worktree can't be spoofed.
function reportBoundToWorktree(root, realReport, worktreeRel) {
  if (!realReport || typeof worktreeRel !== 'string' || !worktreeRel.length) return false;
  let wt;
  try { wt = realpathSync(resolve(root, worktreeRel)); } catch { return false; }
  return realReport === wt || realReport.startsWith(wt + sep);
}

// 연속 REQUEST_CHANGES 임계 (breaker.mjs THRESHOLD 미러 — fail-stop latch).
const BREAKER_THRESHOLD = 3;

// UNIFIED rejected-checker resolution predicate — the SINGLE source of truth for
// "is this rejected checker RESOLVED (superseded)?", shared by next-action.mjs (routing)
// AND finish.mjs (settledEp). Before this, the two files answered the question differently
// (next-action: order-aware but ignored UNBOUND rejections; finish: review_points_done/any-approval,
// not order-aware) → a NEWER unbound REQUEST_CHANGES after an approved point could be silently
// finished past (next-action ignored it AND finish settled it). One predicate closes the whole class.
// Order is computed with epOrder (numeric-prefix compare, not string) so the 999→1000 boundary is correct.
//   bound (target_maker set): resolved iff the SAME target maker was re-reviewed and APPROVED by a checker
//     NEWER than this rejection (an OLDER approve followed by a NEWER reject must NOT count), OR a strictly
//     LATER done maker exists for the same (workstream_id, point) (the flow moved on to a newer maker).
//   unbound (no target_maker): ALWAYS resolved (neutral). Such a checker reviewed no maker, so a rejection on it is
//     meaningless — it must neither block finish nor route to action. dispatchReview no longer creates unbound
//     checkers (REVIEW_NO_ELIGIBLE_MAKER), so this branch only settles LEGACY unbound rejected checkers in old
//     loop.json — treating them as neutral avoids BOTH silent-completion (never silently masked by an unrelated
//     approval) AND strand (a terminal unbound checker can neither be abandoned nor re-recorded).
export function rejectionResolved(loop, e) {
  const eps = loop.episodes || [];
  // Unsupported/legacy checker proof is neutral history: it cannot demand a fix and cannot strand finish.
  if (!isProofCapableChecker(e)) return true;
  if (e.target_maker) {
    const reApprovedNewer = eps.some(c => isProofCapableChecker(c) && c.target_maker === e.target_maker && c.status === 'approved' && epOrder(c.id, e.id) > 0);
    const laterDoneMaker = eps.some(m => m.role === 'maker' && m.status === 'done' && m.workstream_id === e.workstream_id && m.point === e.point && epOrder(m.id, e.target_maker) > 0);
    return reApprovedNewer || laterDoneMaker;
  }
  return true;   // unbound → neutral (see comment above)
}

const LEGACY_INLINE_BLOCK_REASON = 'legacy-inline-checker-unsupported';

// Reviewer resolution is fail-closed. Only the documented deep-review namespace is canonicalized;
// unknown ids and a configured-but-missing deep-review dependency never fall back to weaker proof.
const KNOWN_REVIEWERS = ['deep-review-loop', 'subagent-checker', 'standalone'];

// Tracked source for the hill-climb checker contract. The workstream-local materialized copy must
// remain byte-identical to this file at both dispatch and passing-verdict commit.
const TRACKED_CONTRACT_PATH = fileURLToPath(new URL('../../skills/deep-loop-workflow/references/contracts/HILLCLIMB-001.yaml', import.meta.url));

function contractsDirSolo(realContract) {
  try {
    const dir = realContract.slice(0, realContract.lastIndexOf(sep));
    const self = realContract.slice(realContract.lastIndexOf(sep) + 1);
    return readdirSync(dir).filter(file => /\.ya?ml$/i.test(file) && file !== self).length === 0;
  } catch { return false; }
}

export function resolveReviewer(loop, detected = {}, { independentSubagent = false } = {}) {
  const r = loop.review || {};
  let reviewer = r.reviewer === undefined ? 'subagent-checker' : r.reviewer;
  if (typeof reviewer !== 'string' || reviewer.length === 0) {
    throw new Error(`REVIEWER_UNRECOGNIZED: review.reviewer is present but not a non-empty string (${JSON.stringify(r.reviewer)}) — omit the field for the default or set a known reviewer`);
  }
  if (reviewer === 'deep-review:deep-review-loop') reviewer = 'deep-review-loop';
  let reviewerResolution;
  let blockedReason;
  if (reviewer === 'standalone') {
    if (independentSubagent === true) {
      reviewer = 'subagent-checker';
      reviewerResolution = {
        legacy_reviewer: 'standalone',
        decision: 'upgraded',
        reviewer,
        asserted_capability: 'independent-subagent',
      };
    } else {
      blockedReason = LEGACY_INLINE_BLOCK_REASON;
      reviewerResolution = {
        legacy_reviewer: 'standalone',
        decision: 'blocked',
        reason: blockedReason,
      };
    }
  }
  if (reviewer === 'deep-review-loop' || reviewer === 'deep-review') {
    if (!pluginPresent(detected, 'deep-review')) {
      throw new Error(`REVIEWER_DEPENDENCY_MISSING: reviewer '${r.reviewer}' requires the deep-review plugin (silent downgrade removed — install deep-review or re-init with another reviewer)`);
    }
    reviewer = 'deep-review-loop';
  } else if (!KNOWN_REVIEWERS.includes(reviewer)) {
    throw new Error(`REVIEWER_UNRECOGNIZED: '${r.reviewer}' is not a known reviewer (${KNOWN_REVIEWERS.join('|')}) — refusing blocked/inline fallback`);
  }
  return { reviewer, flags: r.flags || [], mode: r.mode || 'cross-model', reviewerResolution, blockedReason };
}

export function parseVerdict(text) {
  if (text == null) return null;
  const s = String(text);
  try { const v = JSON.parse(s)?.verdict; if (['APPROVE', 'REQUEST_CHANGES', 'CONCERN'].includes(v)) return v; } catch { /* not json */ }
  if (/REQUEST_CHANGES/.test(s)) return 'REQUEST_CHANGES';
  if (/\bCONCERN\b/.test(s)) return 'CONCERN';
  if (/\b(?:do not|don't|not|never|cannot|can't)\s+approve\b/i.test(s)) return null;  // 부정문 오분류 방지 (Codex r4 ℹ️2)
  if (/\bAPPROVE\b/.test(s)) return 'APPROVE';
  return null;
}

// A maker is reviewed if there is a terminal checker bound to it (via target_maker) with approved/rejected status.
export function makerReviewed(loop, maker) {
  return (loop.episodes || []).some(e =>
    isProofCapableChecker(e) && e.target_maker === maker.id &&
    (e.status === 'approved' || e.status === 'rejected')
  );
}

// checker episode 생성 + dispatch 디스크립터 반환 — 커널은 sibling을 호출하지 않음 (spec §1.1·§6).
export function dispatchReview(root, runId, {
  point, workstreamId, detected = {}, independentSubagent = false, routing, fence,
  __testBeforeCheckerCreate,
} = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: dispatchReview');
  // Fix 3: validate point before any state read/write
  if (!point || typeof point !== 'string' || !point.length) throw new Error('REVIEW_INPUT_INVALID: point');
  const { data } = captureReconciledRunSnapshot(root, runId);
  const expectedReviewConfig = structuredClone(data.review);
  // Codex impl r14 🟡: validate the workstream EXISTS at dispatch time — otherwise the checker is bound to a phantom
  // workstream and recordReviewOutcome (which derives workstream_id from the checker) later fails WORKSTREAM_NOT_FOUND,
  // stranding a pending checker that can't converge. Fail early instead.
  const dispatchWorkstream = workstreamId && data.workstreams.find(w => w.id === workstreamId);
  if (!dispatchWorkstream) throw new Error(`WORKSTREAM_NOT_FOUND: ${workstreamId}`);
  if (['ready', 'merged', 'abandoned'].includes(dispatchWorkstream.status)) {
    throw new Error(`WORKSTREAM_TERMINAL_LOCKED: ${workstreamId} is ${dispatchWorkstream.status}`);
  }
  // Derive the target maker: the latest done maker for this (workstreamId, point) that does NOT already have a bound terminal checker.
  const eps = data.episodes || [];
  // P2 codex r7: hill-climb 마이그레이션 특례 — pre-patch 커널이 approve한 checker(contract 미pin)에 묶인
  // maker는 makerReviewed=true라 재리뷰 불가, abandonEpisode는 terminal checker를 거부 → finish의
  // hillclimb-contract-unpinned와 함께 사면초가가 된다. latest bound checker가 "approved인데 unpinned"인
  // maker만 재적격으로 되돌린다(새 계약-pinned checker가 최신이 되면 finish 통과). rejected는 fix 경로 유지.
  const legacyUnpinned = (m) => {
    if (data.recipe?.id !== 'harness-hill-climb') return false;
    const cs = eps.filter(e => e.role === 'checker' && e.target_maker === m.id && (e.status === 'approved' || e.status === 'rejected'));
    if (!cs.length) return false;
    const latest = cs.reduce((a, b) => (epOrder(a.id, b.id) >= 0 ? a : b));
    return latest.status === 'approved' && !latest.contract?.sha256;
  };
  const eligibleMakers = eps.filter(e =>
    e.role === 'maker' && e.status === 'done' &&
    e.workstream_id === workstreamId && e.point === point &&
    (!makerReviewed(data, e) || legacyUnpinned(e))
  );
  // Pick the latest episode via epOrder (hybrid numeric/string). Naive string `>` is WRONG here: ids are
  // zero-padded to only 3 digits, so '1000-x' < '999-x' lexicographically — at the 999→1000 boundary it
  // would mis-pick the target maker.
  const targetMakerEp = eligibleMakers.length > 0
    ? eligibleMakers.reduce((a, b) => (epOrder(a.id, b.id) > 0 ? a : b))
    : null;
  // ROOT FIX: a review MUST bind to a real done maker. With no eligible done maker the checker would be UNBOUND
  // ("reviewed no maker") — a degenerate state that either silently completes (if its REQUEST_CHANGES is ignored)
  // or strands the run (a terminal unbound checker can't be abandoned or re-recorded). Refuse to create it at the
  // source, so every checker is ALWAYS bound going forward. (preCheck — thrown before newEpisode: no episode created.)
  if (!targetMakerEp) throw new Error('REVIEW_NO_ELIGIBLE_MAKER: no done maker to review for ' + point + '/' + workstreamId);
  const targetMaker = targetMakerEp.id;
  // Session scope is the local authorization boundary and must fail before optional
  // reviewer discovery. Otherwise an installation-dependent dependency error can
  // mask a cross-Workstream dispatch and make the same durable state behave
  // differently between a developer checkout and a clean CI host.
  if (data.autonomy?.continuation_policy === 'workstream-session') {
    // Change F is defensive: null scope is admitted, while bound cross-workstream scope remains rejected.
    // No kernel reachability is demonstrated; the sole F test covers only non-done-target rejection.
    assertScopeAllows(data, workstreamId, { allowUnbound: true });
  }
  const { reviewer, flags, mode, reviewerResolution, blockedReason } = resolveReviewer(data, detected, { independentSubagent });
  // P2 (hillclimb-ledger 2026-07-10, release-blocking): hill-climb run은 checker 계약(HILLCLIMB-001)이 실제로
  // 강제되는 리뷰만 만들 수 있다. `.deep-review/`는 gitignored라 fresh checkout에는 계약이 없고, deep-review는
  // 무-contract일 때 계약 미강제로 리뷰를 진행한다 — 그 APPROVE는 hill-climbing 방벽 ③이 요구하는 계약-강제
  // 리뷰가 아니다. preCheck 순서상 전부 newEpisode 전에 throw — checker episode가 생성되지 않는다. (codex r1)
  let evidence, contract;
  if (data.recipe?.id === 'harness-hill-climb') {
    // ① 계약을 소비할 수 있는 reviewer만 — generic subagent/standalone은 HILLCLIMB-001.yaml을 읽지
    //    않으므로 계약 파일이 존재해도 무계약 APPROVE가 된다. --contract 플래그 부재는 첫 실사용 시리즈의
    //    재-init #2가 실측한 동일 결함. selector 검증(codex r5/r6/r7): deep-review 파서는
    //    `--contract SLICE-[0-9]+`(공백 형태)만 selector로 소비한다 — `HILLCLIMB-001`은 selector로
    //    파싱되지 않아(bare 취급 + 잔여 토큰 오염) 어떤 명시 selector도 신뢰할 수 없고, `=` 형태는
    //    아예 소비되지 않아 무-contract로 새고, 중복 발생은 뒤 selector가 이길 수 있다. 따라서 허용은
    //    **정확히 1회의 bare `--contract`뿐**이다 — "무엇이 로드되는가"는 아래 ②′의 contracts 디렉터리
    //    유일성(HILLCLIMB-001.yaml 단독)이 결정론으로 보장한다.
    const cIdx = flags.reduce((acc, fl, i) => (fl === '--contract' || String(fl).startsWith('--contract=') ? [...acc, i] : acc), []);
    const bareOnly = cIdx.length === 1 && flags[cIdx[0]] === '--contract'
      && (cIdx[0] + 1 >= flags.length || String(flags[cIdx[0] + 1]).startsWith('--'));
    if (reviewer !== 'deep-review-loop' || !bareOnly) {
      throw new Error(`REVIEW_CONTRACT_UNENFORCEABLE: hill-climb run requires reviewer 'deep-review-loop' with exactly one bare --contract flag (no selector — the deep-review parser only consumes SLICE-NNN selectors, so an explicit selector cannot pin HILLCLIMB-001) (got '${reviewer}', flags [${flags.join(', ')}]) — re-init the run with a contract-capable review config`);
    }
    // ② 게이트 위치 = 소비처. checker는 workstream worktree를 cwd로 deep-review를 실행하고 deep-review는
    //    cwd의 `.deep-review/contracts/`를 읽는다 — project-root의 사본을 게이트하면 "게이트는 통과했는데
    //    checker는 계약을 못 보는" 창이 생긴다.
    // ③ 내용 검증 = tracked 소스와 byte-identical. `status: active` 문자열 매칭만으로는 stale/변조된 사본
    //    (예: criteria 비움 — deep-review는 빈 criteria면 계약 검증을 skip)이 통과한다. 계약은 run-불변이므로
    //    "그대로 복사"가 곧 판정 기준이다.
    const wsRec = data.workstreams.find(w => w.id === workstreamId);
    const contractRel = `${wsRec.worktree}/.deep-review/contracts/HILLCLIMB-001.yaml`;
    let contractOk = false, trackedHash = null;
    try {
      const tracked = readFileSync(TRACKED_CONTRACT_PATH, 'utf8');
      // realpath containment (codex r6): lexical resolve만으로는 `.deep-review`(또는 worktree)가 외부를
      // 가리키는 symlink여도 통과한다 — report proof와 동일 규약으로 realpath가 root+worktree 안이어야 한다.
      const realContract = containedRealFile(resolve(root), contractRel);
      contractOk = !!realContract && reportBoundToWorktree(root, realContract, wsRec.worktree)
        && readFileSync(realContract, 'utf8') === tracked
        && /^slice:\s*HILLCLIMB-001\s*$/m.test(tracked) && /^status:\s*active\s*$/m.test(tracked)
        && /^criteria:/m.test(tracked) && /^\s*-\s+/m.test(tracked)
        // ②′ 유일성(codex r7): bare `--contract`는 디렉터리의 모든 active 계약을 로드하므로,
        //    "HILLCLIMB-001만 로드됨"은 contracts 디렉터리에 다른 계약 파일이 없어야 성립한다.
        && contractsDirSolo(realContract);
      if (contractOk) trackedHash = sha256File(realContract);
    } catch { contractOk = false; }
    if (!contractOk) {
      throw new Error(`REVIEW_CONTRACT_MISSING: hill-climb run requires ${contractRel} byte-identical to the tracked source (skills/deep-loop-workflow/references/contracts/HILLCLIMB-001.yaml) with status: active — materialize (그대로 복사) before dispatching review`);
    }
    // ⑤ codex r3: 검증된 계약 identity를 checker episode에 durable 기록(anchored loop.json) —
    //    recordReviewOutcome이 passing verdict 시점에 같은 파일을 재검증해 dispatch~record 사이
    //    삭제/변조(TOCTOU — deep-review는 무-contract면 조용히 skip) 창을 닫는다.
    contract = { slice: 'HILLCLIMB-001', path: contractRel, sha256: trackedHash };
    // ④ criterion (a)의 결정론 근거 — 커널-검증된 최신 insights를 디스크립터 + checker request.md에 실어
    //    checker가 파일 파싱 없이 인용 지표를 대조할 수 있게 한다. 없으면 null(인용할 검증 지표가 없다는
    //    사실 자체가 checker의 판정 입력). emit_ulid는 artifact 파일명의 emit ULID(envelope.run_id는
    //    producer run — 별도 필드), sha256은 anchored 이벤트 값(codex r2). 바인딩: dispatch 시점 latest가
    //    maker가 인용한 emit과 다를 수 있다 — checker는 evidence의 sha256/emit_ulid를 maker 인용
    //    (ledger 항목의 insights_ref/insights_sha256, design/plan은 문서의 인용)과 대조하고 mismatch를
    //    criterion (a) 위반으로 판정한다(v1 바인딩 메커니즘 — 커널은 T1 ledger를 파싱하지 않는다).
    const li = latestInsights(captureLatestInsightsSet(root));
    if (li?.ok === false) {
      const kind = typeof li.kind === 'string' ? li.kind : 'insights-unavailable';
      const phase = typeof li.phase === 'string' ? li.phase : 'unknown';
      throw new Error(`INSIGHTS_UNAVAILABLE: ${kind} phase=${phase}`);
    }
    evidence = li ? {
      insights_path: li.path,
      emit_ulid: li.path.replace(/^.*\//, '').replace(/-insights\.json$/, ''),
      producer_run_id: li.envelope?.envelope?.run_id ?? null,
      sha256: li.sha256 ?? null,
      candidates: li.envelope?.payload?.candidates ?? [],
    } : null;
  }
  const episodeInput = {
    plugin: reviewer === 'deep-review-loop' || reviewer === 'deep-review' ? 'deep-review' : reviewer,
    kind: `${point}-review`, point, workstream: workstreamId, targetMaker,
    reviewerResolution, evidence, contract, expectedReviewConfig, routing, fence,
  };
  if (__testBeforeCheckerCreate !== undefined && typeof __testBeforeCheckerCreate !== 'function') {
    throw new Error('REVIEW_TEST_SEAM_INVALID');
  }
  __testBeforeCheckerCreate?.();
  const { id } = blockedReason
    ? newBlockedCheckerEpisode(root, runId, { ...episodeInput, reason: blockedReason })
    : newEpisode(root, runId, { ...episodeInput, role: 'checker' });
  const descriptor = attachRoutingToDescriptor({
    ...checkerDescriptor(reviewer, { point, workstreamId, flags, mode, reason: blockedReason }),
    ...(evidence !== undefined ? { evidence } : {}),
  }, routing);
  return { checkerEpisodeId: id, reviewer, descriptor };
}

const REVIEW_TERMINAL = new Set(['done', 'approved', 'rejected', 'abandoned']);
const REVIEW_SOURCES = new Set(['recorded-path', 'imported-stdin']);

function snapshotContext(loop, episodeId) {
  const checker = loop?.episodes?.find(e => e.id === episodeId) || null;
  const maker = checker?.target_maker ? loop.episodes.find(e => e.id === checker.target_maker) || null : null;
  const workstream = checker?.workstream_id ? loop.workstreams.find(w => w.id === checker.workstream_id) || null : null;
  return {
    checker, maker, workstream,
    workstreamId: checker?.workstream_id,
    point: checker?.point,
    targetMaker: checker?.target_maker,
    reviewerId: checker?.plugin,
  };
}

function checkedContext(loop, episodeId, { reviewSource } = {}) {
  const context = snapshotContext(loop, episodeId);
  const checker = context.checker;
  if (!checker) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
  if (checker.role !== 'checker') throw new Error('REVIEW_TARGET_NOT_CHECKER: ' + episodeId);
  if (checker.status === 'blocked') throw new Error('REVIEW_CHECKER_BLOCKED: independent checker capability is required: ' + episodeId);
  if (REVIEW_TERMINAL.has(checker.status)) throw new Error('REVIEW_ALREADY_RECORDED: ' + episodeId);
  if (!isProofCapableChecker(checker)) {
    const code = reviewSource === 'imported-stdin' ? 'REVIEW_IMPORT_REVIEWER_INVALID' : 'REVIEW_CHECKER_IDENTITY_UNSUPPORTED';
    throw new Error(`${code}: unsupported checker plugin ${String(checker.plugin)}`);
  }
  if (reviewSource === 'imported-stdin' && (checker.status !== 'in_progress' || !checker.review_claim)) {
    throw new Error('REVIEW_IMPORT_CHECKER_NOT_CLAIMED: checker must carry an in-progress host claim');
  }
  if (reviewSource === 'imported-stdin'
      && ((checker.contract !== undefined && !sameJson(checker.review_claim.contract, checker.contract))
        || (checker.evidence !== undefined && !sameJson(checker.review_claim.evidence, checker.evidence)))) {
    throw new Error('REVIEW_IMPORT_CLAIM_BINDING_MISMATCH: checker contract/evidence changed after claim');
  }
  if (reviewSource === 'recorded-path' && checker.review_claim) {
    throw new Error('REVIEW_CLAIM_REQUIRES_IMPORT: a host claim can be completed only by review import');
  }
  if (!checker.target_maker) throw new Error('REVIEW_UNBOUND_CHECKER: cannot record a verdict on a checker bound to no maker: ' + episodeId);
  const maker = context.maker;
  if (!maker || maker.role !== 'maker') throw new Error('REVIEW_TARGET_MAKER_INVALID: ' + checker.target_maker);
  if (maker.status !== 'done') throw new Error('REVIEW_TARGET_MAKER_NOT_DONE: ' + maker.id);
  if (checker.workstream_id !== maker.workstream_id || checker.point !== maker.point) {
    throw new Error('REVIEW_MAKER_BINDING_MISMATCH: checker and maker workstream/point differ');
  }
  if (!context.workstream) throw new Error(`WORKSTREAM_NOT_FOUND: ${checker.workstream_id}`);
  if (loop.autonomy?.continuation_policy === 'workstream-session') {
    // Change F is defensive: null scope is admitted, while bound cross-workstream scope remains rejected.
    // No kernel reachability is demonstrated; the sole F test covers only non-done-target rejection.
    assertScopeAllows(loop, maker.workstream_id, { allowUnbound: true });
  }
  return context;
}

function rejectCallerMetadata(options, operation) {
  for (const key of ['source', 'workstreamId', 'workstream_id', 'workstream', 'point', 'targetMaker', 'target_maker', 'reviewer_id', 'reviewSource', 'review_source', 'runtime', 'attemptId', 'attempt_id', 'attempt-id', 'evidence', 'contract']) {
    if (Object.hasOwn(options, key)) throw new Error(`REVIEW_METADATA_FORBIDDEN: ${operation} derives ${key}`);
  }
}

function validFence(fence, operation) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) {
    throw new Error(`FENCE_REQUIRED: ${operation}`);
  }
}

function validVerdict(verdict) {
  if (!['APPROVE', 'CONCERN', 'REQUEST_CHANGES'].includes(verdict)) {
    throw new Error(`REVIEW_VERDICT_INVALID: ${verdict}`);
  }
}

// Sole proof transaction for both adapters. appendAnchored performs the root-bound fresh read first; this
// preCheck then applies runtime/lease, checker/maker, and source-evidence checks in the locked order.
function commitReviewOutcome(root, runId, {
  episodeId, verdict, reviewSource, evidence, fence, runtime, snapshot, now,
}) {
  const passed = verdict === 'APPROVE' || verdict === 'CONCERN';
  if (!REVIEW_SOURCES.has(reviewSource)) throw new Error(`REVIEW_SOURCE_INVALID: ${reviewSource}`);
  const eventData = {
    episodeId, verdict,
    workstream_id: snapshot.workstreamId,
    point: snapshot.point,
    target_maker: snapshot.targetMaker,
    reviewer_id: snapshot.reviewerId,
    review_source: reviewSource,
    ...(reviewSource === 'imported-stdin' ? { attempt_id: evidence.input?.attempt_id } : {}),
    ...(evidence.report ? { report: evidence.report, report_sha256: evidence.reportSha256 } : {}),
    ...(evidence.findings ? { findings: evidence.findings } : {}),
  };
  const publication = reviewSource === 'imported-stdin' && evidence.report ? {
    kind: 'review-import',
    operationId: `review-import-${evidence.reportSha256}`,
    artifacts: [{ rel: evidence.reportRel, bytes: evidence.bytes }],
    topology: {
      checker_episode_id: episodeId,
      target_maker: snapshot.targetMaker,
      attempt_id: evidence.input.attempt_id,
      report_sha256: evidence.reportSha256,
    },
  } : null;
  let lockedContext;
  let result;
  let committed = null;
  appendAnchored(root, runId, {
    type: 'review-outcome', data: eventData,
    ...(reviewSource === 'imported-stdin' && evidence.generatedAt
      ? { now: evidence.generatedAt }
      : (now !== undefined ? { now } : {})),
  },
    (loop, _spent, tx) => {
      const checker = lockedContext.checker;
      const maker = lockedContext.maker;
      const workstream = lockedContext.workstream;
      checker.status = passed ? 'approved' : 'rejected';
      checker.review_source = reviewSource;
      const breaker = loop.circuit_breaker;
      if (verdict === 'REQUEST_CHANGES') {
        breaker.consecutive_request_changes = (breaker.consecutive_request_changes || 0) + 1;
        if (breaker.consecutive_request_changes >= BREAKER_THRESHOLD && !breaker.tripped) {
          breaker.tripped = true;
          breaker.trip_reason = 'consecutive-request-changes';
          loop.status = 'paused';
        }
      } else {
        breaker.consecutive_request_changes = 0;
      }
      if (passed) {
        if (!workstream.review_points_done.includes(checker.point)) workstream.review_points_done.push(checker.point);
        if (!maker.human_reviewed && !maker.agent_reviewed) {
          maker.agent_reviewed = true;
          loop.comprehension.episodes_agent_reviewed = (loop.comprehension.episodes_agent_reviewed || 0) + 1;
        }
      }
      result = {
        verdict, passed, terminal: checker.status, review_source: reviewSource,
        ...(evidence.report ? { report: evidence.report, report_sha256: evidence.reportSha256 } : {}),
      };
      committed = {
        loop: structuredClone(loop), event: tx.event, episodeId, terminalStatus: checker.status,
      };
    },
    (loop) => {
      const checkedFence = leaseCheck(loop, { ...fence, runtime });
      if (!checkedFence.ok) throw new Error('LEASE_FENCED: ' + checkedFence.reason);
      lockedContext = checkedContext(loop, episodeId, { reviewSource });
      if (lockedContext.workstreamId !== snapshot.workstreamId
          || lockedContext.point !== snapshot.point
          || lockedContext.targetMaker !== snapshot.targetMaker
          || lockedContext.reviewerId !== snapshot.reviewerId) {
        throw new Error('REVIEW_CONTEXT_FENCED: checker binding changed before commit');
      }
      const breaker = loop.circuit_breaker;
      const comprehension = loop.comprehension;
      if (breaker === null || typeof breaker !== 'object' || Array.isArray(breaker)
          || !Number.isInteger(breaker.consecutive_request_changes) || breaker.consecutive_request_changes < 0
          || typeof breaker.tripped !== 'boolean'
          || !Array.isArray(lockedContext.workstream.review_points_done)
          || comprehension === null || typeof comprehension !== 'object' || Array.isArray(comprehension)
          || !Number.isInteger(comprehension.episodes_agent_reviewed) || comprehension.episodes_agent_reviewed < 0) {
        throw new Error('STATE_INVALID: review outcome mutation structures');
      }
      const stateValidation = validate(loop);
      if (!stateValidation.ok) throw new Error(`STATE_INVALID: ${stateValidation.errors.join('; ')}`);
      if (reviewSource === 'recorded-path') {
        if (passed) {
          const reopened = containedRealFile(resolve(root), evidence.report);
          if (!reopened || reopened !== evidence.realReport
              || !reportBoundToWorktree(root, reopened, lockedContext.workstream.worktree)) {
            throw new Error('REVIEW_NO_EVIDENCE: passing verdict requires proof.report — a real file under the reviewed workstream worktree');
          }
          if (sha256File(reopened) !== evidence.reportSha256) {
            throw new Error('REVIEW_REPORT_HASH_MISMATCH: recorded report bytes changed');
          }
        }
      } else {
        if (evidence.preparationError) throw evidence.preparationError;
        const binding = validateImportedEvidence(root, loop, evidence.input, lockedContext);
        const prepared = prepareImportedReview(root, runId, evidence.input, binding, { now: evidence.generatedAt });
        if (prepared.report !== evidence.report || prepared.reportRel !== evidence.reportRel
          || prepared.reportAbs !== evidence.reportAbs || prepared.reportBytes !== evidence.reportBytes
          || prepared.reportSha256 !== evidence.reportSha256 || !prepared.bytes.equals(evidence.bytes)) {
          throw new Error('REVIEW_REPORT_HASH_MISMATCH: prepared import changed before commit');
        }
      }
      // P2 codex r3/r4: hill-climb run의 passing verdict는 계약-강제 리뷰 proof다 — recipe를 기준으로
      // 게이트한다(체커 필드 유무가 아니라). pre-patch dispatch로 만들어진 legacy pending checker는
      // contract 필드가 없으므로 tgt.contract 조건만으로는 무계약 APPROVE가 통과한다(r4). 기록된
      // identity가 있으면 같은 파일을 record 시점에 재검증한다 — dispatch~record 사이 삭제/변조(TOCTOU)
      // 시 deep-review는 무-contract를 조용히 skip하므로 그 창의 APPROVE를 거부한다. 복구는 재-dispatch가
      // 아니라(제 checker가 pending으로 남아 중복 checker + next-action 정체를 만든다) tracked 소스
      // 재-materialize 후 **같은 checker**로 리뷰 재실행·재기록이다. REQUEST_CHANGES는 경량 reject 유지.
      if (passed && loop.recipe?.id === 'harness-hill-climb') {
        const checker = lockedContext.checker;
        const workstream = lockedContext.workstream;
        if (!checker.contract?.sha256 || !checker.contract?.path) {
          throw new Error('REVIEW_CONTRACT_MISSING: hill-climb passing verdict requires a contract-pinned checker — materialize the tracked contract and dispatch a new contract-pinned review');
        }
        let stillValid = false;
        try {
          const realC = containedRealFile(resolve(root), checker.contract.path);   // symlink-escape 재검증 (r6)
          stillValid = !!realC && reportBoundToWorktree(root, realC, workstream.worktree)
            && sha256File(realC) === checker.contract.sha256
            && contractsDirSolo(realC);   // dispatch~record 창에 다른 계약이 추가되면 bare --contract가 함께 로드 (r7)
        } catch { stillValid = false; }
        if (!stillValid) throw new Error(`REVIEW_CONTRACT_MISSING: contract ${checker.contract.path} was removed or altered since dispatch (recorded sha256 mismatch) — re-materialize the tracked contract (그대로 복사), re-run the review, and record this SAME checker episode (it stays pending; do NOT dispatch a second checker)`);
      }
    }, {
      floor: MUTATION_TURN_FLOOR,
      ...(publication ? { publication } : {}),
    });
  const observation = committed
    ? observeTerminalEpisode(root, runId, { ...committed, verdict, reviewSource })
    : null;
  return observation ? { ...result, observation } : result;
}

export function recordReviewOutcome(root, runId, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('REVIEW_INPUT_INVALID: options');
  }
  rejectCallerMetadata(options, 'recordReviewOutcome');
  const { episodeId, verdict, proof = {}, fence, now } = options;
  validFence(fence, 'recordReviewOutcome');
  validVerdict(verdict);
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) throw new Error('REVIEW_INPUT_INVALID: proof');
  rejectCallerMetadata(proof, 'recordReviewOutcome proof');
  const preState = captureReconciledRunSnapshot(root, runId).data;
  const runtime = sessionRuntime(preState);
  const snapshot = snapshotContext(preState, episodeId);
  const passed = verdict === 'APPROVE' || verdict === 'CONCERN';
  const realReport = passed ? containedRealFile(resolve(root), proof.report) : null;
  const evidence = {
    realReport,
    report: realReport ? proof.report : null,
    reportSha256: realReport ? sha256File(realReport) : null,
    findings: proof.findings != null && String(proof.findings).length ? String(proof.findings).slice(0, 2000) : null,
  };
  return commitReviewOutcome(root, runId, {
    episodeId, verdict, reviewSource: 'recorded-path', evidence, fence, runtime, snapshot, now,
  });
}

// The fourth argument is an internal dependency seam for deterministic post-materialization,
// pre-append race tests. CLI callers never populate it.
export function importReviewOutcome(root, runId, options = {}, internal = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('REVIEW_INPUT_INVALID: options');
  }
  const afterMaterialize = internal?.afterMaterialize ?? (() => {});
  if (typeof afterMaterialize !== 'function') throw new Error('REVIEW_INPUT_INVALID: internal.afterMaterialize');
  rejectCallerMetadata(options, 'importReviewOutcome');
  const { raw, fence, now } = options;
  validFence(fence, 'importReviewOutcome');
  const input = parseReviewImport(raw);
  const preState = captureReconciledRunSnapshot(root, runId).data;
  const runtime = sessionRuntime(preState);
  const snapshot = snapshotContext(preState, input.checker_episode_id);
  let evidence;
  try {
    const checked = checkedContext(preState, input.checker_episode_id, { reviewSource: 'imported-stdin' });
    const binding = validateImportedEvidence(root, preState, input, checked);
    evidence = prepareImportedReview(root, runId, input, binding, { now });
    afterMaterialize(Object.freeze({
      report: evidence.report,
      reportAbs: evidence.reportAbs,
      reportSha256: evidence.reportSha256,
      bytes: evidence.bytes,
    }));
  } catch (preparationError) {
    // Preserve the authoritative locked error order. Invalid/stale source material never receives proof,
    // but the commit preCheck still gets to report root/runtime/lease/checker fences first.
    evidence = { input, preparationError, report: null, reportSha256: null };
  }
  const result = commitReviewOutcome(root, runId, {
    episodeId: input.checker_episode_id,
    verdict: input.verdict,
    reviewSource: 'imported-stdin',
    evidence,
    fence,
    runtime,
    snapshot,
    now,
  });
  // Keep the committed publication journal for the next canonical mutation gateway to reconcile
  // and retire under its own lock. A second cleanup lock here can outlive the bounded importer
  // after the proof has already committed, leaving a dead-owner lock that masks successful review.
  return result;
}

// review.points = run-level 계약. 충족은 workstream review_points_done(bound approved checker가 채움)이 단일 출처.
export function unsatisfiedReviewPoints(loop) {
  const pts = loop.review?.points || [];
  const done = (loop.workstreams || []).flatMap(w => w.review_points_done || []);
  return pts.filter(p => !done.includes(p));
}
