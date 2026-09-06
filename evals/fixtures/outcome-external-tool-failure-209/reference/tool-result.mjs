export function resolveToolAttempts(attempts) {
  const success = attempts.findIndex(result => result.exit === 0 && result.timed_out !== true);
  if (success >= 0) return { status: 'success', attempts: success + 1 };
  return { status: 'unavailable', attribution: 'environment-error', attempts: attempts.length };
}
