export function parseConfig(text) {
  try {
    const input = JSON.parse(text);
    const retries = input.retries ?? 3;
    if (!Number.isInteger(input.timeout_ms) || input.timeout_ms < 1
      || !Number.isInteger(retries) || retries < 0) return { ok: false, error: 'CONFIG_INVALID' };
    return { ok: true, value: { timeout_ms: input.timeout_ms, retries } };
  } catch {
    return { ok: false, error: 'CONFIG_INVALID' };
  }
}
