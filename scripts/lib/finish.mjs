import { appendAnchored } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';
import { runDir } from './state.mjs';
import { isProofCapableChecker, makerReviewed, unsatisfiedReviewPoints, epOrder, rejectionResolved } from './review.mjs';
import { MUTATION_TURN_FLOOR } from './budget.mjs';
import { containedRealFile } from './fs-safe.mjs';
import { isGoalDriven } from './goal-contract.mjs';
import { goalProofState } from './goal-review.mjs';

// A rejected checker is settled only when it is RESOLVED by the SINGLE unified predicate rejectionResolved
// (review.mjs) — the SAME order-aware predicate next-action.mjs uses for routing. (Replaces the old local
// reviewSatisfied, which settled on review_points_done / any same-point approval and was NOT order-aware,
// so a NEWER unbound REQUEST_CHANGES after an approved point was silently settled.) The boundLatestApproved
// convergence check below is complementary (it gates makers, not the rejected checker's settlement).
const settledEp = (loop, e) => ['done', 'approved', 'abandoned'].includes(e.status) || (e.role === 'checker' && e.status === 'rejected' && rejectionResolved(loop, e));
const TERMINAL_WS = ['ready', 'merged', 'abandoned'];

function latestBoundChecker(loop, makerId) {
  const checkers = (loop.episodes || []).filter(episode =>
    isProofCapableChecker(episode)
    && episode.target_maker === makerId
    && (episode.status === 'approved' || episode.status === 'rejected'));
  return checkers.length
    ? checkers.reduce((a, b) => (epOrder(a.id, b.id) >= 0 ? a : b))
    : null;
}

export function workstreamClosureProofState(loop, workstreamId) {
  const episodes = (loop.episodes || []).filter(episode => episode.workstream_id === workstreamId);
  const doneMakers = episodes.filter(episode => episode.role === 'maker' && episode.status === 'done');
  const unsettledEpisodeIds = episodes
    .filter(episode => !settledEp(loop, episode))
    .map(episode => episode.id);
  const unreviewedMakerIds = doneMakers
    .filter(maker => !makerReviewed(loop, maker))
    .map(maker => maker.id);
  const unresolvedRejectionIds = episodes
    .filter(episode =>
      episode.role === 'checker'
      && episode.status === 'rejected'
      && !rejectionResolved(loop, episode))
    .map(episode => episode.id);

  const latestByPoint = new Map();
  for (const maker of doneMakers) {
    const current = latestByPoint.get(maker.point);
    if (!current || epOrder(maker.id, current.id) > 0) latestByPoint.set(maker.point, maker);
  }
  const latestMakers = [...latestByPoint.values()];
  const nonConvergedMakerIds = latestMakers
    .filter(maker => latestBoundChecker(loop, maker.id)?.status !== 'approved')
    .map(maker => maker.id);
  const contractUnpinned = loop.recipe?.id === 'harness-hill-climb'
    && latestMakers.some(maker => {
      const checker = latestBoundChecker(loop, maker.id);
      return checker?.status === 'approved' && !checker.contract?.sha256;
    });

  const missing = [];
  if (unsettledEpisodeIds.length) missing.push('unsettled-episodes');
  if (unreviewedMakerIds.length) missing.push('unreviewed-maker');
  if (unresolvedRejectionIds.length) missing.push('unresolved-rejection');
  if (nonConvergedMakerIds.length) missing.push('non-converged-maker');
  if (contractUnpinned) missing.push('hillclimb-contract-unpinned');
  return {
    ok: missing.length === 0,
    missing,
    unsettledEpisodeIds,
    unreviewedMakerIds,
    unresolvedRejectionIds,
    nonConvergedMakerIds,
  };
}

export function ordinaryFinishProofState(loop) {
  const eps = loop.episodes || [];
  const hasWork = eps.length > 0;                                  // Codex r1 critical-1: 빈 run 의 공허-통과 차단
  const closureIds = [...new Set(eps.map(episode => episode.workstream_id))];
  const closures = closureIds.map(workstreamId => workstreamClosureProofState(loop, workstreamId));
  const settled = closures.every(closure => closure.unsettledEpisodeIds.length === 0);
  const noActiveWs = (loop.active_workstreams || []).length === 0;
  const wsAll = (loop.workstreams || []).every(w => TERMINAL_WS.includes(w.status));
  // Per-maker binding check: every done maker must have a bound terminal checker (target_maker === maker.id).
  const doneMakers = eps.filter(e => e.role === 'maker' && e.status === 'done');
  const allMakersReviewed = closures.every(closure => closure.unreviewedMakerIds.length === 0);
  const allPointsConverged = closures.every(closure => closure.nonConvergedMakerIds.length === 0);
  // P2 codex r6: hill-climb run의 review proof는 계약-강제 리뷰여야 한다 — proof를 만족시키는 각 latest
  // APPROVED checker에 dispatch가 pin한 contract(sha256)가 있어야 한다. pre-patch 커널로 approved된
  // legacy checker는 record-시점 게이트를 다시 거치지 않으므로 finish에서 막는다. 마이그레이션(r7,
  // abandon 불필요 — terminal checker는 abandon 불가): dispatchReview의 legacyUnpinned 특례가 해당
  // maker를 재리뷰 재적격으로 되돌리므로, 사람이 `review dispatch`를 다시 실행해 계약-pinned checker가
  // 최신이 되면 이 게이트가 해소된다.
  const contractPinned = closures.every(closure => !closure.missing.includes('hillclimb-contract-unpinned'));
  const reviewedProof = doneMakers.length > 0 && allMakersReviewed && allPointsConverged && contractPinned;
  const unboundDoneMaker = doneMakers.some(m => !m.workstream_id || !(loop.workstreams || []).some(w => w.id === m.workstream_id));
  const missing = [];
  if (!hasWork) missing.push('no-proof-of-work');                  // 최소 1 episode 필요 (Array.every 공허-통과 방지)
  if (!settled) missing.push('unsettled-episodes');
  if (!noActiveWs) missing.push('active-workstreams');
  if (!wsAll) missing.push('non-terminal-workstreams');
  if (!allMakersReviewed) missing.push('unreviewed-maker');        // 미리뷰 done maker 차단
  if (hasWork && !reviewedProof) missing.push('no-independent-review');
  if (hasWork && !contractPinned) missing.push('hillclimb-contract-unpinned');   // legacy approved checker — contract materialize 후 fresh pinned review 필요
  if (unsatisfiedReviewPoints(loop).length) missing.push('review-point-unsatisfied');
  if (unboundDoneMaker) missing.push('unbound-proof-episode');
  return { hasWork, settled, noActiveWs, allWsTerminal: wsAll, allMakersReviewed, reviewedProof, missing };
}

export function finishProofState(loop, { goalProof } = {}) {
  const ordinary = ordinaryFinishProofState(loop);
  if (!isGoalDriven(loop)) return ordinary;
  if (!goalProof?.ok) ordinary.missing.push(...(goalProof?.missing || ['goal-proof-unchecked']));
  return ordinary;
}

export function finishRun(root, runId, { status, reportRel, proof = {}, confirm, fence, now = Date.now() } = {}) {
  // Codex r3 sf-3: fence 는 lib 레벨에서 **필수** (CLI 우회 호출도 fence 강제). newEpisode/recordEpisode 와 동일 규약.
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: finishRun');
  let result;
  appendAnchored(root, runId, { type: 'finish', data: { status, reportRel: reportRel || null } },
    (loop) => {
      loop.status = status;
      loop.termination = loop.termination || {};
      loop.termination.finished_at = new Date(now).toISOString();
      if (reportRel) loop.termination.final_report = reportRel;
      result = { ok: true, status };
    },
    (loop) => {
      const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);   // 무조건 (fence 필수)
      // v1.6 defense-in-depth (spec §2.2): 전면 거부 하에선 위 leaseCheck가 항상 먼저 RUN_TERMINAL을
      // 반환하므로 정상 경로에서 도달 불가 — 미래에 leaseCheck 예외 intent가 도입되어도 finish는
      // 독립적으로 double-finish를 차단한다(의도된 도달-불가 방어-심층, 단위 테스트 비강제).
      if (loop.status === 'completed' || loop.status === 'stopped') throw new Error(`FINISH_ALREADY_TERMINAL: ${loop.status}`);
      if (status !== 'completed' && status !== 'stopped') throw new Error(`FINISH_STATUS_INVALID: ${status}`);
      if (status === 'stopped') {
        // #4: `stopped` bypasses every completed-proof (review/workstream-terminal/report). It is a human-only
        // one-way termination, so it carries the same --confirm gate as the sibling human-only ops (abandon /
        // recover / breaker reset) — enforced in the lib (CLI-bypass safe). human_reason stays a required reason.
        if (confirm !== true) throw new Error('CONFIRM_REQUIRED: stopped requires --confirm (human-only)');
        if (!proof || !proof.human_reason) throw new Error('FINISH_PROOF_UNMET: stopped requires proof.human_reason');
        return;
      }
      // completed: report 는 runDir 하위로 격리(containment)된 **실제 파일**이어야 — CLI 가드 비의존, lib 가 강제.
      // impl-R1 Fix 2: containedRealFile(realpathSync deref)로 교체 — 기존 resolve+startsWith+statSync 는 symlink 를
      // follow 해서 runDir-상대 symlink 가 프로젝트 밖을 가리켜도 통과했다(#2 review report 와 동일 결함 클래스).
      // containedRealFile 은 `--report .` / 디렉터리(isFile 아님) / 부재 / '..'·절대경로도 모두 null 로 거부한다.
      const goalProof = isGoalDriven(loop) ? goalProofState(root, loop) : null;
      if (goalProof && !goalProof.ok) throw new Error(`${goalProof.code}: ${goalProof.missing.join(',')}`);
      const ps = finishProofState(loop, { goalProof });
      const real = reportRel ? containedRealFile(runDir(root, runId), reportRel) : null;
      if (!real) ps.missing.push('final-report-missing');
      if (ps.missing.length) throw new Error(`FINISH_PROOF_UNMET: ${ps.missing.join(',')}`);
    }, { floor: MUTATION_TURN_FLOOR });
  return result;
}
