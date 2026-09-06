import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STREAM_LIMITS,
  createCodexJsonlParser,
  parseClaudeUsage,
} from '../../scripts/lib/usage-parser.mjs';

function parseCodex(lines, options) {
  const parser = createCodexJsonlParser(options);
  parser.write(Buffer.from(lines.join('\n')));
  return parser.end();
}

function completed(usage = { input_tokens: 7, output_tokens: 5 }) {
  return JSON.stringify({ type: 'turn.completed', usage });
}

test('Codex JSONL parser returns one measured turn from one terminal event', () => {
  assert.deepEqual(STREAM_LIMITS, {
    codexLineBytes: 32 * 1024 * 1024,
    finalMessageBytes: 256 * 1024,
    stderrBytes: 64 * 1024,
    claudeOutputBytes: 4 * 1024 * 1024,
  });

  const parser = createCodexJsonlParser();
  parser.write(Buffer.from('{"type":"turn.completed","usage":{"input_tokens":7,"cached_input_tokens":3,"output_tokens":5,"reasoning_output_tokens":2}}\n'));

  assert.deepEqual(parser.end(), {
    ok: true,
    usage: {
      num_turns: 1,
      tokens: 12,
      input_tokens: 7,
      output_tokens: 5,
      cached_input_tokens: 3,
      reasoning_output_tokens: 2,
    },
  });
});

test('Codex JSONL parser captures one trustworthy provider UUID from thread.started', () => {
  const providerThreadId = '019d1234-5678-7abc-8def-0123456789ab';
  const result = parseCodex([
    JSON.stringify({ type: 'thread.started', thread_id: providerThreadId }),
    JSON.stringify({ type: 'turn.started' }),
    completed(),
  ], { captureProviderThreadId: true });

  assert.deepEqual(result, {
    ok: true,
    usage: {
      num_turns: 1,
      tokens: 12,
      input_tokens: 7,
      output_tokens: 5,
    },
    providerThreadId,
  });
});

test('provider thread capture fails closed on missing, malformed, repeated, or late bindings', () => {
  const first = '019d1234-5678-7abc-8def-0123456789ab';
  const second = '019d1234-5678-7abc-8def-0123456789ac';
  const cases = [
    ['missing', [completed()], 'codex-missing-provider-thread'],
    ['malformed', [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      completed(),
    ], 'codex-invalid-provider-thread'],
    ['repeated', [
      JSON.stringify({ type: 'thread.started', thread_id: first }),
      JSON.stringify({ type: 'thread.started', thread_id: second }),
      completed(),
    ], 'codex-multiple-provider-threads'],
    ['late', [
      completed(),
      JSON.stringify({ type: 'thread.started', thread_id: first }),
    ], 'codex-provider-thread-after-terminal'],
  ];

  for (const [label, lines, reason] of cases) {
    assert.deepEqual(
      parseCodex(lines, { captureProviderThreadId: true }),
      { ok: false, reason },
      label,
    );
  }
});

test('Codex JSONL parser preserves split UTF-8 agent-message bytes across CRLF chunk boundaries', () => {
  const message = '첫 줄\r\n둘째 줄 🙂';
  const stream = Buffer.from([
    JSON.stringify({ type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: message } }),
    completed({ input_tokens: 1, output_tokens: 2 }),
    '',
  ].join('\r\n'));
  const parser = createCodexJsonlParser({ captureFinalMessage: true });

  for (const byte of stream) parser.write(Buffer.from([byte]));

  const result = parser.end();
  assert.equal(result.ok, true);
  assert.deepEqual(result.finalMessage, Buffer.from(message));
  assert.deepEqual(result.usage, {
    num_turns: 1,
    tokens: 3,
    input_tokens: 1,
    output_tokens: 2,
  });
});

test('Codex JSONL parser ignores allowed non-fatal items and does not retain a 16 MiB command output', () => {
  const largeOutput = 'x'.repeat(16 * 1024 * 1024);
  const result = parseCodex([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item-1', type: 'command_execution', aggregated_output: largeOutput, exit_code: 0 },
    }),
    completed(),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.finalMessage, undefined);
  assert.equal(result.items, undefined);
  assert.equal(result.usage.tokens, 12);
});

test('Codex JSONL parser reports distinct fatal stream reasons', () => {
  const cases = [
    ['top-level error', ['{"type":"error","message":"boom"}'], 'codex-top-level-error'],
    ['failed turn', ['{"type":"turn.failed","error":{"message":"boom"}}'], 'codex-turn-failed'],
    ['malformed JSON', ['{"type":"turn.started"'], 'codex-malformed-json'],
    ['missing terminal', ['{"type":"turn.started"}'], 'codex-missing-terminal'],
    ['multiple terminals', [completed(), completed()], 'codex-multiple-terminals'],
  ];

  for (const [label, lines, reason] of cases) {
    assert.deepEqual(parseCodex(lines), { ok: false, reason }, label);
  }
  assert.equal(new Set(cases.map(([, , reason]) => reason)).size, cases.length);
});

test('Codex JSONL parser rejects a line over the exact byte limit without retaining it', () => {
  const parser = createCodexJsonlParser();
  parser.write(Buffer.alloc(STREAM_LIMITS.codexLineBytes + 1, 0x20));
  assert.deepEqual(parser.end(), { ok: false, reason: 'codex-line-overflow' });
});

test('Codex usage requires safe non-negative integer totals and breakdowns', () => {
  const invalidUsages = [
    { input_tokens: -1, output_tokens: 0 },
    { input_tokens: 0.5, output_tokens: 0 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    { input_tokens: 1, output_tokens: 1, cached_input_tokens: -1 },
    { input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 0.5 },
    { input_tokens: 1 },
    { output_tokens: 1 },
  ];

  for (const usage of invalidUsages) {
    assert.deepEqual(parseCodex([completed(usage)]), { ok: false, reason: 'codex-invalid-usage' });
  }
});

test('Codex usage rejects explicitly null token breakdowns while allowing absent breakdowns', () => {
  for (const field of ['cached_input_tokens', 'reasoning_output_tokens']) {
    assert.deepEqual(parseCodex([completed({
      input_tokens: 1,
      output_tokens: 2,
      [field]: null,
    })]), { ok: false, reason: 'codex-invalid-usage' }, field);
  }

  assert.equal(parseCodex([completed({ input_tokens: 1, output_tokens: 2 })]).ok, true);
});

test('Codex JSONL treats a blank record as malformed but permits one normal trailing newline', () => {
  const trailing = createCodexJsonlParser();
  trailing.write(Buffer.from(`${completed()}\n`));
  assert.equal(trailing.end().ok, true);

  const blank = createCodexJsonlParser();
  blank.write(Buffer.from(`{"type":"turn.started"}\n\n${completed()}\n`));
  assert.deepEqual(blank.end(), { ok: false, reason: 'codex-malformed-json' });
});

test('Codex JSONL rejects malformed UTF-8 incrementally with a distinct reason', () => {
  const invalidSequences = [
    Buffer.from([0x80]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xe0, 0x80, 0x80]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xf4, 0x90, 0x80, 0x80]),
    Buffer.from([0xe2, 0x82]),
  ];

  for (const invalid of invalidSequences) {
    const parser = createCodexJsonlParser();
    parser.write(Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"'));
    for (const byte of invalid) parser.write(Buffer.from([byte]));
    parser.write(Buffer.from(`"}}\n${completed()}\n`));
    assert.deepEqual(parser.end(), { ok: false, reason: 'codex-invalid-utf8' }, invalid.toString('hex'));
  }
});

test('Codex cached and reasoning tokens are optional non-additive breakdowns', () => {
  assert.deepEqual(parseCodex([completed({
    input_tokens: 11,
    cached_input_tokens: 7,
    output_tokens: 13,
    reasoning_output_tokens: 5,
  })]), {
    ok: true,
    usage: {
      num_turns: 1,
      tokens: 24,
      input_tokens: 11,
      output_tokens: 13,
      cached_input_tokens: 7,
      reasoning_output_tokens: 5,
    },
  });
});

test('Codex final agent-message capture is byte-bounded and keeps the last structured message', () => {
  const exact = 'a'.repeat(STREAM_LIMITS.finalMessageBytes);
  const atLimit = parseCodex([
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'older' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: exact } }),
    completed(),
  ], { captureFinalMessage: true });
  assert.equal(atLimit.ok, true);
  assert.equal(Buffer.isBuffer(atLimit.finalMessage), true);
  assert.equal(atLimit.finalMessage.length, STREAM_LIMITS.finalMessageBytes);
  assert.equal(atLimit.finalMessage.equals(Buffer.from(exact)), true);

  const overflow = parseCodex([
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `${exact}🙂` } }),
    completed(),
  ], { captureFinalMessage: true });
  assert.deepEqual(overflow, { ok: false, reason: 'codex-final-message-overflow' });
});

test('Claude usage parser preserves legacy JSON and text fallback within its byte bound', () => {
  assert.deepEqual(parseClaudeUsage('{"num_turns":3,"usage":{"input_tokens":10,"output_tokens":4}}'), {
    num_turns: 3,
    tokens: 14,
  });
  assert.deepEqual(parseClaudeUsage('prefix "num_turns": 2 suffix'), {
    num_turns: 2,
    tokens: null,
  });
  assert.equal(parseClaudeUsage('{"total_cost_usd":0.12}'), null);

  const metric = '"num_turns":2';
  const atLimit = `${' '.repeat(STREAM_LIMITS.claudeOutputBytes - Buffer.byteLength(metric))}${metric}`;
  assert.equal(Buffer.byteLength(atLimit), STREAM_LIMITS.claudeOutputBytes);
  assert.equal(parseClaudeUsage(atLimit).num_turns, 2);
  assert.equal(parseClaudeUsage(`${atLimit} `), null);
});
