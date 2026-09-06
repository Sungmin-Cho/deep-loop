export function normalizeScores(values) {
  return values.reduce((result, value) => result.includes(value) ? result : [...result, value], [])
    .sort((left, right) => left - right);
}
