export function routeAction(action) {
  if (action === 'inspect') return { plane: 'execution', allowed: true };
  if (action === 'mutate') return { plane: 'control', allowed: true };
  return { plane: 'execution', allowed: false, reason: 'KERNEL_ROUTE_REQUIRED' };
}
