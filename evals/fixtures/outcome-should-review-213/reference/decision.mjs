export function shouldReview(context) {
  return context.risk === 'high' || context.changes_auth === true;
}
