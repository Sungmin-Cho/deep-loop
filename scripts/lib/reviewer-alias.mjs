// Shared identity normalization; dependency resolution and legacy standalone
// capability checks remain owned by the review dispatcher.
export function normalizeReviewerAlias(reviewer) {
 return reviewer==='deep-review:deep-review-loop'||reviewer==='deep-review'?'deep-review-loop':reviewer;
}
