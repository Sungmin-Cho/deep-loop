export function normalizeAccount(account) {
  return { id: Number(account.id), first: account.first.trim(), last: account.last.trim() };
}
