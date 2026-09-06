export function verifyCredential(stored, supplied) {
  return stored.length > 0 && supplied.length > 0 && stored === supplied;
}
