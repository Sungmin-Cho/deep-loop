export function summarizeRecords(records) {
  return records.map(record => record.title).join(' | ');
}
