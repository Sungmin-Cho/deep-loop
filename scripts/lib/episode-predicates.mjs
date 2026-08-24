const REVIEWERS = new Set(['deep-review', 'subagent-checker']);

// Closed proof identity set shared by record/import, routing, and finish.
// Legacy `standalone` (and unknown plugins) may remain in persisted history, but can never create proof.
export const isProofCapableChecker = checker => checker?.role === 'checker' && REVIEWERS.has(checker.plugin);

// Hybrid episode-order comparator (shared — finish.mjs / next-action.mjs import it). Episode ids are
// `NNN-plugin` zero-padded to only 3 digits, so naive string `>` breaks at the 999→1000 boundary
// ('1000-x' < '999-x' lexicographically). When BOTH ids carry a numeric prefix, compare NUMERICALLY;
// otherwise fall back to string compare (preserves synthetic test ids like m1/m2/c1). "a is later than b"
// iff epOrder(a, b) > 0.
export const epOrder = (a, b) => {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (Number.isInteger(na) && Number.isInteger(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
};
