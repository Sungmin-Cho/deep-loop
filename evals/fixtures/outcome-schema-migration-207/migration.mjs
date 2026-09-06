export function migrateRecord(record) {
  return { ok: true, value: { ...record, schema: 2 } };
}
