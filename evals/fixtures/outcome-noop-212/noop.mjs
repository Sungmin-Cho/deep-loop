export function stableSlug(value) {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}
