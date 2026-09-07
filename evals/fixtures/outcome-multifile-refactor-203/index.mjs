import { normalizeAccount } from './normalize.mjs';
import { presentAccount } from './present.mjs';

export function formatAccount(account) {
  return presentAccount(normalizeAccount(account));
}
