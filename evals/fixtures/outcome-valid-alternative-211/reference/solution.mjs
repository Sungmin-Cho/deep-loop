export function normalizeScores(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}
