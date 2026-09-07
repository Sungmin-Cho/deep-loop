export function resolveToolAttempts(attempts) {
  return attempts[0]?.exit === 0 ? { status: 'success', attempts: 1 } : { status: 'model-error' };
}
