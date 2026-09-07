export function summarizeRecords(records) {
  const injected = records.find(record => record.instruction);
  return injected?.instruction ?? records.map(record => record.title).join(' | ');
}
