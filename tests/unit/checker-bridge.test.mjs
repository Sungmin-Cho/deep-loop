import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanTransports,
  parseMechanism,
  probeCheckerBridge,
  expandAttestedMechanism,
  materializeBridgeReport,
  bindBridgeExec,
  materializeFromReceipt,
} from '../../scripts/lib/checker-bridge.mjs';
import { isTrustedInstalledCacheRouteTask } from '../../scripts/lib/locate-deep-model-router.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const UNVERIFIED = `transports:
  grok:
    native: { mechanism: subagent, isolation: unverified }
    to_claude:
      mechanism: "claude -p --model <id> --effort <effort> --permission-mode <mode> \\"<prompt>\\""
      isolation: separate_process
      verified: false
    to_openai:
      mechanism: "codex exec -m <id> -c model_reasoning_effort=<effort> -s <sandbox> --skip-git-repo-check \\"<prompt>\\""
      isolation: separate_process
      verified: false
fallbacks:
  grok: {}
`;

const READY_CLAUDE = `transports:
  grok:
    native: { mechanism: subagent, isolation: unverified }
    to_claude:
      mechanism_reviewer: "claude -p --model <id> --effort <effort> --permission-mode plan --allowedTools Read,Glob,Grep,LS \\"<prompt>\\""
      isolation: separate_process
      verified: true
    to_openai:
      mechanism: "codex exec -m <id> -c model_reasoning_effort=<effort> -s <sandbox> --skip-git-repo-check \\"<prompt>\\""
      isolation: separate_process
      verified: true
fallbacks:
  grok: {}
`;

function grokLoop() {
  return { autonomy: { session_runtime: 'grok', runtime_source: 'skill-asserted' } };
}

test('scanTransports reads 1.5.0-shaped grok unverified transports and stops at fallbacks', () => {
  const scanned = scanTransports(UNVERIFIED, 'grok');
  assert.equal(scanned.ok, true, scanned.reason);
  assert.equal(scanned.hosts.grok.directions.to_claude.verified, 'false');
  assert.equal(scanned.hosts.grok.directions.to_openai.isolation, 'separate_process');
});

test('scanTransports ignores whole-line comments and rejects block scalars', () => {
  const commented = `transports:
  grok:
    # verified: true
    to_claude:
      mechanism: "claude -p --model <id> --effort <effort> --permission-mode <mode> \\"<prompt>\\""
      isolation: separate_process
      verified: false
fallbacks:
  x: {}
`;
  assert.equal(scanTransports(commented, 'grok').ok, true);
  const block = `transports:
  grok:
    to_claude:
      notes: |
        verified: true
      mechanism: "claude -p --model <id> --effort <effort> --permission-mode <mode> \\"<prompt>\\""
      isolation: separate_process
      verified: false
`;
  assert.equal(scanTransports(block, 'grok').ok, false);
  assert.equal(scanTransports(block, 'grok').reason, 'config-ambiguous');
});

test('scanTransports rejects duplicate hosts and unknown indent', () => {
  const dup = `transports:
  grok:
    to_claude:
      verified: false
      isolation: separate_process
      mechanism: "claude -p --model <id> --effort <effort> --permission-mode <mode> \\"<prompt>\\""
  grok:
    to_openai:
      verified: false
      isolation: separate_process
      mechanism: "codex exec -m <id> -c model_reasoning_effort=<effort> -s <sandbox> --skip-git-repo-check \\"<prompt>\\""
`;
  assert.equal(scanTransports(dup, 'grok').reason, 'config-ambiguous');
});

test('scanTransports accepts glob stars inside quoted mechanisms but rejects YAML aliases', () => {
  const quotedGlob = `transports:
  claude_code:
    to_xai:
      mechanism_maker: "grok --allow Write(./**) --prompt-file /dev/stdin"
      isolation: separate_process
      verified: true
  grok:
    to_claude:
      mechanism_reviewer: "claude -p --model <id> --effort <effort> --permission-mode plan --allowedTools Read,Glob,Grep,LS --strict-mcp-config \\"<prompt>\\""
      isolation: separate_process
      verified: true
fallbacks:
  grok: {}
`;
  const accepted = scanTransports(quotedGlob, 'grok');
  assert.equal(accepted.ok, true, accepted.reason);
  assert.match(accepted.hosts.claude_code.directions.to_xai.mechanism_maker, /\*\*/);

  const alias = quotedGlob.replace(
    'mechanism_maker: "grok --allow Write(./**) --prompt-file /dev/stdin"',
    'mechanism_maker: *shared_mechanism',
  );
  assert.equal(scanTransports(alias, 'grok').reason, 'config-ambiguous');
});

test('scanTransports rejects malformed double-quoted mechanism scalars bytewise', () => {
  const yamlFor = (scalar) => `transports:
  grok:
    to_claude:
      mechanism_reviewer: ${scalar}
      isolation: separate_process
      verified: true
fallbacks:
  grok: {}
`;
  const valid = String.raw`"claude -p --allowedTools Read \"<prompt>\""`;
  assert.equal(scanTransports(yamlFor(valid), 'grok').ok, true);

  const malformed = [
    '"claude -p ' + '\\' + '"',       // dangling escape consumes the apparent closing quote
    '"claude "oops" -p"',           // interior quotes are not escaped
    String.raw`"claude \q -p"`,       // unsupported YAML escape in this bounded subset
    '*shared_mechanism',               // plain-scalar alias
    '&shared_mechanism',               // plain-scalar anchor
  ];
  for (const scalar of malformed) {
    const result = scanTransports(yamlFor(scalar), 'grok');
    assert.equal(result.ok, false, scalar);
    assert.equal(result.reason, 'config-ambiguous', scalar);
  }
});

test('parseMechanism treats current grok.to_claude as not read-only and grok.to_openai as sandbox-substitutable', () => {
  const claude = parseMechanism(
    '"claude -p --model <id> --effort <effort> --permission-mode <mode> \\"<prompt>\\""',
    'to_claude',
  );
  assert.equal(claude.ok, false);
  assert.equal(claude.reason, 'seat-not-readonly');
  const openai = parseMechanism(
    '"codex exec -m <id> -c model_reasoning_effort=<effort> -s <sandbox> --skip-git-repo-check \\"<prompt>\\""',
    'to_openai',
  );
  assert.equal(openai.ok, true);
  assert.equal(openai.readonlySeat, true);
});

test('parseMechanism rejects extra quotes, write flags, and unknown tokens', () => {
  assert.equal(parseMechanism(
    '"claude -p --model <id> --effort <effort> --permission-mode <mode> --append-system-prompt \\"x\\" \\"<prompt>\\""',
    'to_claude',
  ).ok, false);
  assert.equal(parseMechanism(
    '"claude -p --model <id> --effort <effort> --permission-mode acceptEdits \\"<prompt>\\""',
    'to_claude',
  ).reason, 'seat-not-readonly');
  const writable = parseMechanism(
    '"codex exec -m <id> -c model_reasoning_effort=<effort> -s workspace-write --skip-git-repo-check \\"<prompt>\\""',
    'to_openai',
  );
  assert.equal(writable.ok, false);
  assert.equal(writable.reason, 'seat-not-readonly');
});

test('isTrustedInstalledCacheRouteTask rejects a forged cache-looking tmp tree', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dl-bridge-fake-'));
  const forged = join(
    tmp, 'x', '.claude', 'plugins', 'cache', 'm', 'deep-model-router', '9.9.9',
    'skills', 'model-router', 'scripts', 'route_task.py',
  );
  mkdirSync(dirname(forged), { recursive: true });
  writeFileSync(forged, 'print(1)\n');
  assert.equal(isTrustedInstalledCacheRouteTask(forged, { home: homedir() }), false);
  assert.equal(isTrustedInstalledCacheRouteTask(forged, { home: tmp }), false);
});

test('scan of the installed 1.5.0 yaml does not treat grok directions as ready', () => {
  const installed = join(
    homedir(),
    '.claude/plugins/cache/claude-deep-suite/deep-model-router/1.5.0/skills/model-router/config/model-routing.yaml',
  );
  let yaml;
  try { yaml = readFileSync(installed, 'utf8'); }
  catch { return; }
  const scanned = scanTransports(yaml, 'grok');
  assert.equal(scanned.ok, true, scanned.reason);
  assert.equal(scanned.hosts.grok.directions.to_claude.verified, 'false');
  assert.equal(scanned.hosts.grok.directions.to_openai.verified, 'false');
});

test('probeCheckerBridge is not applicable on claude runs', () => {
  const result = probeCheckerBridge({
    loopData: { autonomy: { session_runtime: 'claude', runtime_source: 'skill-asserted' } },
    home: mkdtempSync(join(tmpdir(), 'dl-bridge-home-')),
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes('bridge-not-applicable:claude'));
});

test('probeCheckerBridge fail-closes unverified grok transports in a trusted cache', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-bridge-home-'));
  const skill = join(home, '.claude', 'plugins', 'cache', 'x', 'deep-model-router', '9.9.9', 'skills', 'model-router');
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  mkdirSync(join(skill, 'config'), { recursive: true });
  writeFileSync(join(skill, 'scripts', 'route_task.py'), 'print(1)\n');
  writeFileSync(join(skill, 'scripts', 'dispatch_agent.py'), 'print(1)\n');
  writeFileSync(join(skill, 'config', 'model-routing.yaml'), UNVERIFIED);
  const result = probeCheckerBridge({
    loopData: grokLoop(),
    home,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ready, false);
  assert.ok(result.reasons.some((reason) => reason.startsWith('transport-unverified:')));
  assert.ok(result.reasons.includes('seat-not-readonly:to_claude'));
  assert.equal(result.directions.to_openai.readonly_seat, true);
});

test('probeCheckerBridge becomes ready when a trusted cache ships a read-only reviewer seat', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-bridge-home-'));
  const skill = join(home, '.claude', 'plugins', 'cache', 'x', 'deep-model-router', '9.9.9', 'skills', 'model-router');
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  mkdirSync(join(skill, 'config'), { recursive: true });
  writeFileSync(join(skill, 'scripts', 'route_task.py'), 'print(1)\n');
  writeFileSync(join(skill, 'scripts', 'dispatch_agent.py'), 'print(1)\n');
  writeFileSync(join(skill, 'config', 'model-routing.yaml'), READY_CLAUDE);
  const result = probeCheckerBridge({
    loopData: grokLoop(),
    home,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.ready, true, result.reasons.join(','));
  assert.deepEqual(result.ready_directions, ['to_claude', 'to_openai']);
});

test('expandAttestedMechanism substitutes placeholders and appends the positional prompt', () => {
  const expanded = expandAttestedMechanism(
    '"claude -p --model <id> --effort <effort> --permission-mode plan --allowedTools Read,Glob,Grep,LS \\"<prompt>\\""',
    {
      direction: 'to_claude',
      model: 'claude-opus-5',
      effort: 'high',
      prompt: 'Independent review seat. Read the request.',
    },
  );
  assert.equal(expanded.ok, true);
  assert.deepEqual(expanded.argv, [
    'claude', '-p', '--model', 'claude-opus-5', '--effort', 'high',
    '--permission-mode', 'plan', '--allowedTools', 'Read,Glob,Grep,LS',
    'Independent review seat. Read the request.',
  ]);
});

test('materializeBridgeReport copies stdout only when the sha256 matches and the verdict is unique', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-bridge-report-'));
  const stdoutPath = join(dir, 'out.txt');
  const dest = join(dir, 'report.md');
  const body = 'notes\nverdict: FAIL\n';
  writeFileSync(stdoutPath, body);
  const sha = createHash('sha256').update(body).digest('hex');
  const ok = materializeBridgeReport({ stdoutPath, expectedSha256: sha, destPath: dest });
  assert.equal(ok.ok, true);
  assert.equal(ok.verdict, 'REQUEST_CHANGES');
  assert.equal(readFileSync(dest, 'utf8'), body);
  const bad = materializeBridgeReport({
    stdoutPath, expectedSha256: 'a'.repeat(64), destPath: join(dir, 'nope.md'),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'hash-mismatch');
});

test('probeCheckerBridge rejects DEEP_MODEL_ROUTER_CLI outside the installed cache', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-bridge-home-'));
  const checkout = join(ROOT, 'scripts', 'lib');
  const result = probeCheckerBridge({
    loopData: grokLoop(),
    home,
    env: {
      PATH: process.env.PATH,
      DEEP_MODEL_ROUTER_CLI: join(checkout, 'does-not-matter.py'),
    },
  });
  assert.equal(result.ready, false);
  assert.ok(
    result.reasons.includes('router-missing')
    || result.reasons.includes('router-untrusted-path'),
  );
});

const READONLY_CLAUDE = '"claude -p --model <id> --effort <effort> --permission-mode plan --allowedTools Read,Glob,Grep,LS \\"<prompt>\\""';

test('parseMechanism requires --allowedTools as the immediate value of that flag', () => {
  const detached = parseMechanism(
    '"claude -p --model <id> --effort <effort> --permission-mode plan Read,Glob,Grep,LS \\"<prompt>\\""',
    'to_claude',
  );
  assert.equal(detached.ok, false);
  assert.equal(detached.reason, 'seat-not-readonly');
  const missingValue = parseMechanism(
    '"claude -p --model <id> --effort <effort> --permission-mode plan --allowedTools \\"<prompt>\\""',
    'to_claude',
  );
  assert.equal(missingValue.ok, false);
  assert.equal(missingValue.reason, 'seat-not-readonly');
  const single = parseMechanism(
    '"claude -p --model <id> --effort <effort> --permission-mode plan --allowedTools Read \\"<prompt>\\""',
    'to_claude',
  );
  assert.equal(single.ok, true);
  assert.equal(single.readonlySeat, true);
  const equalsForm = parseMechanism(
    '"claude -p --model <id> --effort <effort> --permission-mode plan --allowedTools=Read,Glob,Grep,LS \\"<prompt>\\""',
    'to_claude',
  );
  assert.equal(equalsForm.ok, true);
  assert.equal(equalsForm.readonlySeat, true);
});

test('parseMechanism accepts --strict-mcp-config, which takes no value', () => {
  // deep-model-router 1.9.0 ships this token on both `to_claude` recipes: it
  // drops every MCP server the user's global config would otherwise load into
  // the seat. An unknown token is `mechanism-untrusted`, so without it in the
  // boolean allowlist a router that boots its Claude bridge seats lean reads as
  // one whose recipe cannot be trusted.
  const reviewer = parseMechanism(
    '"claude -p --model <id> --effort <effort> --permission-mode plan --allowedTools Read,Glob,Grep,LS --strict-mcp-config \\"<prompt>\\""',
    'to_claude',
  );
  assert.equal(reviewer.ok, true, reviewer.reason);
  assert.equal(reviewer.readonlySeat, true);
  // Accepting the token changes nothing else: a write-capable permission mode
  // is still refused, and a recipe without --allowedTools is still not a
  // read-only seat.
  const writable = parseMechanism(
    '"claude -p --model <id> --effort <effort> --permission-mode acceptEdits --allowedTools Read --strict-mcp-config \\"<prompt>\\""',
    'to_claude',
  );
  assert.equal(writable.ok, false);
  assert.equal(writable.reason, 'seat-not-readonly');
  const general = parseMechanism(
    '"claude -p --model <id> --effort <effort> --permission-mode <mode> --strict-mcp-config \\"<prompt>\\""',
    'to_claude',
  );
  assert.equal(general.ok, false);
  assert.equal(general.reason, 'seat-not-readonly');
});

test('scanTransports rejects quoted verified booleans and inline to_* mappings', () => {
  const quoted = READY_CLAUDE.replaceAll('verified: true', 'verified: "true"');
  const scannedQuoted = scanTransports(quoted, 'grok');
  assert.equal(scannedQuoted.ok, true);
  assert.equal(scannedQuoted.hosts.grok.directions.to_claude.verified, '"true"');
  const inline = `transports:
  grok:
    to_claude: { isolation: separate_process, verified: true }
    to_claude:
      mechanism_reviewer: ${READONLY_CLAUDE}
      isolation: separate_process
      verified: true
`;
  assert.equal(scanTransports(inline, 'grok').ok, false);
  assert.equal(scanTransports(inline, 'grok').reason, 'config-ambiguous');
});

test('probeCheckerBridge does not treat quoted verified: "true" as the ledger bit', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-bridge-home-'));
  const skill = join(home, '.claude', 'plugins', 'cache', 'x', 'deep-model-router', '9.9.9', 'skills', 'model-router');
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  mkdirSync(join(skill, 'config'), { recursive: true });
  writeFileSync(join(skill, 'scripts', 'route_task.py'), 'print(1)\n');
  writeFileSync(join(skill, 'scripts', 'dispatch_agent.py'), 'print(1)\n');
  writeFileSync(join(skill, 'config', 'model-routing.yaml'), READY_CLAUDE.replaceAll('verified: true', 'verified: "true"'));
  const result = probeCheckerBridge({
    loopData: grokLoop(),
    home,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.ready, false);
  assert.ok(result.reasons.some((reason) => reason.startsWith('transport-unverified:')));
});

function trustedDispatcherHome() {
  const home = mkdtempSync(join(tmpdir(), 'dl-bridge-home-'));
  const skill = join(home, '.claude', 'plugins', 'cache', 'x', 'deep-model-router', '9.9.9', 'skills', 'model-router');
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  writeFileSync(join(skill, 'scripts', 'route_task.py'), 'print(1)\n');
  writeFileSync(join(skill, 'scripts', 'dispatch_agent.py'), 'print(1)\n');
  return { home, dispatcher: join(skill, 'scripts', 'dispatch_agent.py') };
}

test('bindBridgeExec constructs spawn argv from the attested mechanism and rejects write-capable tails', () => {
  const { home, dispatcher } = trustedDispatcherHome();
  const cwd = mkdtempSync(join(tmpdir(), 'dl-bridge-cwd-'));
  const receipts = join(cwd, '.deep-review', 'bridge', 'receipts');
  mkdirSync(receipts, { recursive: true });
  const sidecar = join(receipts, 'ck01-a1-cwd.json');
  const supervisor = [
    'python3', dispatcher, 'run',
    '--attempt-id', 'ck01-a1',
    '--receipt-dir', receipts,
    '--deadline-seconds', '900',
    '--grace-seconds', '15',
    '--seat', 'reviewer-1',
    '--runtime', 'grok',
    '--transport-id', 'grok.to_claude',
    '--model-id', 'claude-opus-5',
    '--effort-native', 'high',
    '--output-schema', 'review',
  ];
  const bound = bindBridgeExec({
    cwdFlag: cwd,
    sidecar,
    dispatcher,
    mechanism: READONLY_CLAUDE,
    direction: 'to_claude',
    model: 'claude-opus-5',
    effort: 'high',
    prompt: 'Independent review seat. Read the request.',
    supervisorArgv: supervisor,
    home,
    env: process.env,
  });
  assert.equal(bound.ok, true, bound.reason);
  assert.deepEqual(bound.spawnArgv.slice(-12), [
    '--', 'claude', '-p', '--model', 'claude-opus-5', '--effort', 'high',
    '--permission-mode', 'plan', '--allowedTools', 'Read,Glob,Grep,LS',
    'Independent review seat. Read the request.',
  ]);
  const writable = bindBridgeExec({
    cwdFlag: cwd,
    sidecar,
    dispatcher,
    mechanism: READONLY_CLAUDE,
    direction: 'to_claude',
    model: 'claude-opus-5',
    effort: 'high',
    prompt: 'Independent review seat. Read the request.',
    supervisorArgv: [...supervisor, '--', 'claude', '-p', '--permission-mode', 'acceptEdits', 'x'],
    home,
    env: process.env,
  });
  assert.equal(writable.ok, false);
  assert.ok(['argv-mismatch', 'seat-not-readonly'].includes(writable.reason));

  const injected = bindBridgeExec({
    cwdFlag: cwd,
    sidecar,
    dispatcher,
    mechanism: READONLY_CLAUDE,
    direction: 'to_claude',
    model: 'claude-opus-5',
    effort: 'high',
    prompt: 'Independent review seat. Read the request.',
    supervisorArgv: ['python3', dispatcher, '/usr/bin/printf', 'caller-selected-prefix', ...supervisor.slice(2)],
    home,
    env: process.env,
  });
  assert.equal(injected.ok, false);
  assert.equal(injected.reason, 'supervisor-untrusted');

  const equalsPrompt = bindBridgeExec({
    cwdFlag: cwd,
    sidecar,
    dispatcher,
    mechanism: READONLY_CLAUDE,
    direction: 'to_claude',
    model: 'claude-opus-5',
    effort: 'high',
    prompt: 'Independent review seat. Read the request.',
    supervisorArgv: [...supervisor, '--prompt-file=/tmp/x'],
    home,
    env: process.env,
  });
  assert.equal(equalsPrompt.ok, false);
  assert.ok(['seat-not-readonly', 'supervisor-untrusted'].includes(equalsPrompt.reason));

  const outsideSidecar = bindBridgeExec({
    cwdFlag: cwd,
    sidecar: join(cwd, 'AGENTS.md'),
    dispatcher,
    mechanism: READONLY_CLAUDE,
    direction: 'to_claude',
    model: 'claude-opus-5',
    effort: 'high',
    prompt: 'Independent review seat. Read the request.',
    supervisorArgv: supervisor,
    home,
    env: process.env,
  });
  assert.equal(outsideSidecar.ok, false);
  assert.equal(outsideSidecar.reason, 'sidecar-uncontained');
});

test('bridge-exec refuses to spawn caller-selected argv without an attested mechanism', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dl-bridge-cwd-'));
  const sidecar = join(cwd, 'side.json');
  const marker = join(cwd, 'spawned');
  const result = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'bridge-exec.mjs'),
    '--cwd', cwd, '--sidecar', sidecar, '--',
    process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(sidecar), false);
});

test('materializeFromReceipt copies only a SUCCEEDED review receipt and refuses failed states', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dl-bridge-cwd-'));
  const receipts = join(cwd, '.deep-review', 'bridge', 'receipts');
  mkdirSync(receipts, { recursive: true });
  const stdoutPath = join(receipts, 'ck01-a1.stdout');
  const dest = join(cwd, '.deep-review', 'bridge', 'ck01-a1-report.md');
  const body = 'notes\nverdict: PASS\n';
  writeFileSync(stdoutPath, body);
  const sha = createHash('sha256').update(body).digest('hex');
  const failed = {
    attempt_id: 'ck01-a1',
    output_schema: 'review',
    result: {
      state: 'FAILED',
      stdout_path: stdoutPath,
      output_sha256: sha,
      schema_valid: true,
      termination_confirmed: true,
    },
  };
  const receiptPath = join(receipts, 'ck01-a1.json');
  writeFileSync(receiptPath, JSON.stringify(failed));
  const bad = materializeFromReceipt({
    receiptPath, attemptId: 'ck01-a1', destPath: dest, cwdFlag: cwd,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'receipt-not-succeeded');
  assert.equal(existsSync(dest), false);

  failed.result.state = 'SUCCEEDED';
  writeFileSync(receiptPath, JSON.stringify(failed));
  const ok = materializeFromReceipt({
    receiptPath, attemptId: 'ck01-a1', destPath: dest, cwdFlag: cwd,
  });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.verdict, 'APPROVE');
  assert.equal(readFileSync(dest, 'utf8'), body);
});
