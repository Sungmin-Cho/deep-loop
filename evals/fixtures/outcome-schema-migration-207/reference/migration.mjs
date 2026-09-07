export function migrateRecord(record) {
  if (record.schema === 2 && typeof record.name === 'string' && typeof record.enabled === 'boolean') {
    return { ok: true, value: { schema: 2, name: record.name, enabled: record.enabled } };
  }
  if (record.schema !== 1 || typeof record.name !== 'string') return { ok: false, error: 'LEGACY_RECORD_INVALID' };
  return { ok: true, value: { schema: 2, name: record.name, enabled: true } };
}
