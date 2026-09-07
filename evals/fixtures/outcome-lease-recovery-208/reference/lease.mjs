export function acquireLease(current, request) {
  const sameLease = current.owner === request.owner && current.generation === request.generation;
  if (!sameLease && request.now <= current.expires_at) return { ok: false, error: 'LEASE_NOT_TAKEABLE' };
  return { ok: true, lease: { owner: request.owner, generation: request.generation } };
}
