import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unwrap } from './envelope.mjs';
import { warn } from './log.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const protocolsDir = join(here, '../../protocols');

export function loadProtocol(name) {
  return JSON.parse(readFileSync(join(protocolsDir, `${name}.json`), 'utf8'));
}

const fill = (tpl, brief) => String(tpl || '').replace(/<task>/g, brief.task ?? '');

export function checkerDescriptor(reviewer, { point, workstreamId, flags = [], mode = 'cross-model', reason } = {}) {
  const common = {
    role: 'checker',
    requires_independent_session: true,
    args: Array.isArray(flags) ? flags.join(' ') : '',
    mode,
    review_point: point,
    workstream: workstreamId,
  };
  if (reviewer === 'deep-review-loop' || reviewer === 'deep-review') {
    return { kind: 'skill', ...common, skill: 'deep-review:deep-review-loop' };
  }
  if (reviewer === 'subagent-checker') {
    return { kind: 'agent', ...common, agent_role: 'code-reviewer' };
  }
  return { kind: 'blocked', ...common, needs_human: true, reason: reason || 'checker-capability-unsupported' };
}

export function resolveAdapter(name) {
  const p = loadProtocol(name);
  return {
    protocol: p.protocol,
    dispatch: (brief) => ({
      kind: p.dispatch.kind,
      role: p.dispatch.role,
      skill: p.dispatch.skill,
      then: p.dispatch.then || null,
      ...(p.dispatch.explicit_fallback === true ? { explicit_fallback: true } : {}),
      args: fill(p.dispatch.args_template, brief),
      ...(brief.goalDriven === true ? {
        required_stages: p.dispatch.then && brief.implementation !== false ? ['primary', 'continuation'] : ['primary'],
        completion: 'execution-return',
      } : {}),
    }),
    awaitResult: (ref) => ({ kind: p.await.kind, path: p.await.path_template ? fill(p.await.path_template, ref) : null, doneWhen: p.await.done_when }),
    checker: (ref, reviewConfig = {}) => checkerDescriptor(reviewConfig.reviewer || 'subagent-checker', {
      point: ref.point,
      workstreamId: ref.workstreamId,
      flags: reviewConfig.flags,
      mode: reviewConfig.mode,
    }),
    readArtifacts: (ref) => {
      const rel = p.read.receipt_path_template ? fill(p.read.receipt_path_template, ref) : null;
      if (!rel) return { receipt: null, proofs: [] };
      const path = join(ref.root || '.', rel);
      if (!existsSync(path)) return { receipt: null, proofs: [] };
      const raw = readFileSync(path, 'utf8');
      // producer:null (superpowers 등 비-envelope, 예: markdown 플랜/리포트) → JSON.parse 하지 않고 원문을 정규화 receipt 로 반환 (Codex r4 🟡1)
      if (!p.read.producer) return { receipt: { kind: 'raw', path: rel, content: raw }, proofs: [path] };
      let obj; try { obj = JSON.parse(raw); } catch { warn(`adapter ${name}: non-JSON receipt at ${rel}`); return { receipt: null, proofs: [path] }; }
      const guarded = unwrap(obj, { producer: p.read.producer, artifact_kind: p.read.artifact_kind });
      if (!guarded) { warn(`adapter ${name}: identity guard mismatch at ${rel} (legacy/foreign artifact ignored)`); return { receipt: null, proofs: [path] }; }
      return { receipt: guarded, proofs: [path] };
    },
  };
}

// tier×protocol 모순 가드 (spec §6). read-only는 maker dispatch(implementer 전이) 금지.
export function guardTierProtocol(tier, protocol, verb) {
  const p = loadProtocol(protocol);
  if (tier === 'read-only' && verb === p.implementer_verb && (p.dispatch.kind === 'skill' || p.dispatch.kind === 'inline')) {
    return { ok: false, reason: `read-only tier cannot dispatch implementer for ${protocol}` };
  }
  return { ok: true, reason: 'ok' };
}
