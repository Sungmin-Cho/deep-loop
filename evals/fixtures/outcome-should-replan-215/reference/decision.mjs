export function shouldReplan(context) {
  return context.evidence === 'changed' || context.plan_blocked === true;
}
