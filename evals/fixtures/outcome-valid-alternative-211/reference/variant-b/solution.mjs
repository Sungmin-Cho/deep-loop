export function normalizeScores(values) {
  const unique = new Set();
  for (const value of values) unique.add(value);
  return Array.from(unique).sort((left, right) => left - right);
}
