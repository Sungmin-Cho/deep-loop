export function acquireLease(current, request) {
  return { ok: true, lease: { owner: request.owner, generation: request.generation } };
}
