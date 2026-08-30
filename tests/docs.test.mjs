import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_CMDS = ['/deep-loop', '/deep-loop-discover', '/deep-loop-triage', '/deep-loop-continue',
  '/deep-loop-compact', '/deep-loop-handoff', '/deep-loop-resume', '/deep-loop-status',
  '/deep-loop-ack', '/deep-loop-finish'];
const CODEX_SKILL_CMDS = SKILL_CMDS.map(command => `$deep-loop:${command.slice(1)}`);
const USER_DOCS = ['README.md', 'README.ko.md'];
// `AGENTS.md` is the single guide surface; `CLAUDE.md` imports it and carries only
// Claude-Code-specific notes, so it is not expected to restate implementation paths.
// `the Claude guide is a thin wrapper over the single source` pins that structure, so
// dropping CLAUDE.md here cannot quietly become "nothing checks it".
const LIVE_SURFACE_DOCS = ['README.md', 'AGENTS.md', 'hooks/hooks.json'];

test('README lists all commands + architecture + safety', () => {
  const s = readFileSync(join(R, 'README.md'), 'utf8');
  for (const c of SKILL_CMDS) assert.ok(s.includes(c), `README missing ${c}`);
  assert.match(s, /2-plane|control plane/i);
  assert.match(s, /proposal-only|human approval|사람 승인/i);
  assert.match(s, /standalone|독립/i);
});

test('AGENTS keeps the fixture command under its own development heading', () => {
  const source = readFileSync(join(R, 'AGENTS.md'), 'utf8');
  const heading = source.indexOf('## Fixture evaluation');
  const command = source.indexOf('npm run eval:fixture -- --out ./evals/results/local --now 2026-08-10T00:00:00Z');
  const release = source.indexOf('## Release — post-merge deep-suite sync');
  assert.ok(heading >= 0 && command > heading, 'fixture command must follow its own heading');
  assert.ok(release < 0 || command < release, 'fixture command must not be nested under release');
});

test('English/Korean docs publish bounded multi-run identity and the remaining TOCTOU', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.match(source, /multi-run|multiple runs|여러 run|다중 run/i, `${path}: multi-run contract missing`);
    assert.match(source, /run list/i, `${path}: bounded run list guidance missing`);
    assert.match(source, /current[^\n]{0,180}(?:hint|last-created)|(?:hint|last-created)[^\n]{0,180}current/i,
      `${path}: current-hint guidance missing`);
    assert.match(source, /unique[^\n]{0,120}(?:worktree|branch)|고유[^\n]{0,120}(?:worktree|branch)/i,
      `${path}: unique worktree/branch requirement missing`);
    assert.match(source, /TOCTOU/i, `${path}: create-record TOCTOU disclosure missing`);
    assert.match(source, /(?:reservation|예약)[^\n]{0,180}(?:not|없|후속|범위 밖)|(?:not|없|후속|범위 밖)[^\n]{0,180}(?:reservation|예약)/i,
      `${path}: must not overclaim strong reservation`);
    assert.match(source, /drive-headless\.mjs[\s\S]{0,240}--project-root[\s\S]{0,100}--run-id/i,
      `${path}: explicit headless identity guidance missing`);
  }
});

test('English/Korean docs distinguish exact no-fallback routes from legacy-current compatibility', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.match(source, /mutation[^\n]{0,120}(?:no|never)[^\n]{0,120}(?:fall\s*back|fallback)|(?:no|never)[^\n]{0,120}(?:fall\s*back|fallback)[^\n]{0,120}mutation/i,
      `${path}: mutation no-fallback boundary missing`);
    assert.match(source, /exact read[^\n]{0,120}(?:no|never)[^\n]{0,120}(?:fall\s*back|fallback)|(?:no|never)[^\n]{0,120}(?:fall\s*back|fallback)[^\n]{0,120}exact read/i,
      `${path}: exact-read no-fallback boundary missing`);
    assert.match(source, /legacy-current[^\n]{0,500}terminal run|terminal run[^\n]{0,500}legacy-current/i,
      `${path}: bounded legacy-current compatibility missing`);
    assert.match(source, /one or more distinct terminal claims|terminal claim이 하나 이상/i,
      `${path}: legacy-current must allow multiple terminal claims within one run`);
  }
});

test('README human mutation examples carry complete project-root and run identity', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    const commandPattern = /`(node\s+"[^`\n]*deep-loop\.mjs"[^`\n]*(?:breaker reset|budget extend|episode abandon|attended-launch approve|attended-launch revoke|pause --mode preserve|root rebind(?:\s|`)|root recover(?:\s|`))[^`\n]*)`/gi;
    for (const match of source.matchAll(commandPattern)) {
      assert.match(match[1], /--project-root\s+/, `${path}: mutation shorthand lacks project root: ${match[1]}`);
      assert.match(match[1], /--run-id\s+/, `${path}: mutation shorthand lacks run id: ${match[1]}`);
    }
  }
});

test('README recovery and relief examples preserve exact descriptor authority', () => {
  for (const path of ['README.md', 'README.ko.md']) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.match(source, /exact returned command unchanged|public-kernel command를 정확히 그대로 실행합니다/i,
      `${path}: root relocation must execute the returned descriptor unchanged`);
    assert.doesNotMatch(source, /node\s+"[^"\n]*deep-loop\.mjs"\s+root\s+(?:rebind|recovery\s+acquire)/i,
      `${path}: docs must not synthesize partial root recovery commands`);
    assert.match(source, /independent relief routes|독립적인 relief route/i,
      `${path}: budget and breaker relief must be independent`);
    const pause = source.match(/`([^`\n]*\bpause\s+--mode\s+preserve[^`\n]*)`/i);
    assert.ok(pause, `${path}: pause preserve example is missing`);
    assert.match(pause[1], /--reason\s+"[^"]+"/,
      `${path}: pause preserve must carry a single-valued reason`);
  }
});

test('README.ko mirrors commands', () => {
  const s = readFileSync(join(R, 'README.ko.md'), 'utf8');
  for (const c of SKILL_CMDS) assert.ok(s.includes(c), `README.ko missing ${c}`);
});

test('user docs publish Claude Code, Codex CLI, and Codex App install and invocation tables', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    for (const command of SKILL_CMDS) {
      assert.ok(source.includes(command), `${path} missing Claude invocation ${command}`);
    }
    for (const command of CODEX_SKILL_CMDS) {
      assert.ok(source.includes(command), `${path} missing Codex invocation ${command}`);
    }
    for (const surface of ['Claude Code', 'Codex CLI', 'Codex App']) {
      assert.match(source, new RegExp(`\\|\\s*${surface.replace(' ', '\\s+')}\\s*\\|`, 'i'),
        `${path} missing ${surface} table row`);
    }
    assert.match(source, /\/plugins/);
    assert.match(source, /~\/\.agents\/plugins\/marketplace\.json/);
    assert.match(source, /~\/\.codex\/plugins\/deep-loop/);
    assert.match(source, /~\/\.codex\/plugins\/deep-loop[\s\S]{0,500}~\/\.agents\/plugins\/marketplace\.json[\s\S]{0,220}source\.path[\s\S]{0,120}"\.\/\.codex\/plugins\/deep-loop"/i,
      `${path} must bind the personal plugin directory to its marketplace-relative source.path value`);
    assert.ok(source.includes('/plugin marketplace add Sungmin-Cho/deep-suite'),
      `${path} missing the exact post-sync Claude marketplace command`);
    assert.ok(source.includes('/plugin install deep-loop@claude-deep-suite'),
      `${path} missing the exact post-sync Claude install command`);
    assert.doesNotMatch(source, /\/plugin (?:marketplace add|install)[^\n`]*\.\.\./,
      `${path} must not ship placeholder Claude install commands`);
    assert.match(source, /ChatGPT desktop app[\s\S]{0,180}(?:select|선택)[\s\S]{0,80}Work or Codex[\s\S]{0,160}(?:open|열)[\s\S]{0,80}Plugins/i);
    assert.match(source, /restart (?:the )?App/i);
    assert.match(source, /new (?:task|session)/i);
  }
});

test('Codex App support is in-task only and preserves the honest manual continuation boundary', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.match(source, /Codex App[\s\S]{0,500}install\/discovery[\s\S]{0,200}in-task (?:skill )?execution/i);
    assert.match(source, /Codex App[\s\S]{0,700}\$deep-loop:deep-loop-resume/i);
    assert.match(source, /Codex App[\s\S]{0,700}(?:manual|수동)/i);
    assert.match(source, /no (?:automated|automatic) app-native task creation/i);
    assert.match(source, /no private app-native task-creation (?:URL|deep link)/i);
    assert.doesNotMatch(source, /no private Codex App (?:URL|deep link)/i);
    assert.match(source, /App smoke pending external evidence/i);
  }
});

test('user docs carry the exact cross-runtime support matrix and distinguish PowerShell from WSL', () => {
  const rows = [
    'Claude Code, macOS/Linux',
    'Claude Code, native Windows',
    'Codex CLI, macOS/Linux',
    'Codex CLI, native Windows',
    'Codex App',
    'Grok CLI, macOS',
  ];
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    for (const row of rows) {
      const line = source.split('\n').find(candidate => candidate.startsWith(`| ${row} |`));
      assert.ok(line, `${path} missing support row ${row}`);
      assert.match(line, /workstream-session/,
        `${path} must publish workstream-session for ${row}`);
    }
    assert.match(source, /native Windows[\s\S]{0,500}PowerShell/i);
    assert.match(source, /WSL[\s\S]{0,500}(?:Linux|not native Windows|네이티브 Windows가 아님)/i);
    assert.match(source, /native Windows CI[^\n]*(?:pending external evidence|외부 증거 대기)/i);
    assert.match(source, /App smoke pending external evidence/i);
    assert.ok(source.includes("$env:DEEP_LOOP_UNATTENDED = '1'"),
      `${path} must include the native PowerShell unattended invocation`);
  }
});

test('user docs publish the compatibility, authorization, recovery, and WAL contract', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.match(source, /^## (?:Compatibility and recovery contract|호환성 및 복구 계약)$/m);
    assert.match(source, /workstream-session[\s\S]{0,300}spawn_style(?:`|')?\s*(?:=|:)\s*(?:`|')?interactive/i);
    assert.match(source, /bound_workstream_first_terminal/);
    assert.match(source, /manual resume/i);
    assert.match(source, /host-mediated restore/i);
    assert.match(source, /provider identity is optional/i);
    assert.match(source, /no unattended mid-Workstream respawn/i);
    assert.match(source, /budget extend[\s\S]{0,240}breaker reset/i);
    assert.match(source, /attended-launch approve --style visible/);
    assert.match(source, /spawn-style offer-desktop[\s\S]{0,240}spawn-style confirm-desktop/);
    for (const command of [
      'recovery acquire --capsule',
      'root diagnose --candidate-project-root',
      'root rebind',
      'root recover',
      'root recovery acquire --capsule',
    ]) assert.ok(source.includes(command), `${path} missing ${command}`);
    assert.match(source, /project\.binding_generation/);
    assert.match(source, /root epoch/i);
    assert.match(source, /relative locator/i);
    assert.match(source, /stale root-bound commands[\s\S]{0,240}never edited in place/i);
    assert.match(source, /write-ahead log|WAL/i);
    assert.match(source, /WAL[\s\S]{0,240}fail-stop|fail-stop[\s\S]{0,240}WAL/i);
    for (const artifact of [
      'checkpoints/<checkpoint-key>-compact.json',
      'checkpoints/<checkpoint-key>-compact-observation.json',
      'checkpoints/<checkpoint-key>-compact-prune.json',
      'compact-restore-intents/<operation-id>.prepared.json',
      'transactions/<operation-id>/prepared.json',
      'transactions/<operation-id>/committed.json',
      'recoveries/<child-run-id>-affinity-recovery.json',
      'recoveries/root/<replacement-session-id>.json',
      'terminal/launch-command.txt',
      'terminal/launch-command.meta.json',
    ]) assert.ok(source.includes(artifact), `${path} missing ${artifact}`);
  }
});

test('user docs publish the Grok attended-Darwin contract, closed compact, and 1.17.0 downgrade', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    const grokRow = source.split('\n').find(candidate => candidate.startsWith('| Grok CLI, macOS |'));
    assert.ok(grokRow, `${path} missing support row Grok CLI, macOS`);
    assert.match(grokRow, /workstream-session/, `${path} must publish workstream-session for Grok CLI`);
    assert.match(grokRow, /compact (?:unsupported|미지원)/i, `${path} Grok row must close compact`);
    assert.match(grokRow, /no measured headless/, `${path} Grok row must close measured headless`);
    assert.match(source, /Grok CLI[\s\S]{0,400}attended Darwin/i,
      `${path} must declare Grok as attended Darwin`);
    assert.match(source, /Grok compact is unsupported/i,
      `${path} must publish the Task 3 compact-off sentence`);
    assert.match(source, /matcher `"\*"`.{0,160}did not fire on measured Grok 1\.0\.4 and 1\.0\.13/i,
      `${path} must cite the measured matcher no-fire`);
    assert.match(source, /1\.18[\s\S]{0,80}grok[\s\S]{0,200}1\.17\.0[\s\S]{0,160}validateSessionRuntime/i,
      `${path} must publish the 1.18→1.17.0 grok fail-stop`);
    assert.match(source, /fail-stop/i, `${path} must say grok downgrade fail-stops`);
    assert.match(source, /verified:\s*true|verified: true/,
      `${path} must gate the Grok bridged checker on grok-host verified: true`);
    assert.match(source, /spawn_subagent[\s\S]{0,80}(?:not independence|독립성)/i,
      `${path} must deny native Grok spawn_subagent independence`);
  }
});

test('compatibility docs publish trusted PostCompact ingress and fail-closed compact liveness', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.match(source, /PostCompact[\s\S]{0,300}(?:(?:bounded|4096)[\s\S]{0,180}checkpoint observe|checkpoint observe[\s\S]{0,180}(?:bounded|4096))/i,
      `${path} must describe bounded public observation ingress`);
    assert.match(source, /observation receipt[\s\S]{0,260}(?:corroborat|증명|입증)[\s\S]{0,260}(?:never|not|않|절대)[\s\S]{0,140}(?:mismatch|불일치)/i,
      `${path} must not describe a receipt as a mismatch override`);
    assert.match(source, /prepared[\s\S]{0,220}(?:never|not|않|절대)[\s\S]{0,160}(?:automatic|auto-restore|자동 복원)/i,
      `${path} must not describe prepared state as automatic restore authority`);
    assert.match(source, /unattended[\s\S]{0,260}open[^\n]{0,80}Workstream[\s\S]{0,260}(?:normal action|정상 action)[\s\S]{0,200}(?:no compact advice|compact advice[^\n]{0,40}(?:없|않))[\s\S]{0,200}(?:no[^\n]{0,40}handoff|handoff[^\n]{0,40}(?:없|않))/i,
      `${path} must publish unattended mid-Workstream suppression`);
    assert.match(source, /terminal[\s\S]{0,180}checkpoint (?:observe|restore)[\s\S]{0,180}(?:reject|거부)/i,
      `${path} must publish terminal CLI rejection`);
  }
});

test('visible fallback documents the runtime-correct manual resume command for both hosts', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    const marker = path === 'README.md' ? '**OS-agnostic fallback**' : '**OS 무관 폴백**';
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `${path} missing visible fallback section`);
    const section = source.slice(start, start + 1400);
    assert.ok(section.includes('/deep-loop-resume'), `${path} fallback missing Claude resume`);
    assert.ok(section.includes('$deep-loop:deep-loop-resume'), `${path} fallback missing Codex resume`);
  }
});

test('Codex POSIX visible docs bind approved runtime and exact detected launcher authority', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.match(source, /Codex POSIX[\s\S]{0,500}approved[\s\S]{0,240}runtime/i,
      `${path} must require the durable approved Codex runtime on POSIX`);
    assert.match(source, /Codex POSIX[\s\S]{0,700}cmux[\s\S]{0,300}(?:absolute|절대)[\s\S]{0,180}(?:socket|소켓)/i,
      `${path} must bind cmux to the detected absolute binary and exact socket`);
    assert.match(source, /Codex POSIX[\s\S]{0,1000}\/usr\/bin\/osascript[\s\S]{0,260}(?:iTerm2|Terminal\.app)/i,
      `${path} must bind the selected Darwin launcher to fixed osascript`);
    assert.match(source, /runtime-identity-unavailable/,
      `${path} must name the missing-runtime fail-closed outcome`);
  }
});

test('user docs define exact-hook trust and durable fallback without granting isolated children plugins', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    const sectionStart = source.indexOf('## PreCompact Hook');
    assert.notEqual(sectionStart, -1, `${path} missing PreCompact Hook section`);
    const sectionEnd = source.indexOf('\n## ', sectionStart + 1);
    const section = source.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
    assert.match(source, /exact hook definition/i);
    assert.match(source, /direct shell-free Node/i);
    assert.match(source, /PreCompact[\s\S]{0,300}emit-only[\s\S]{0,300}best-effort/i);
    assert.match(section, /workstream-session[\s\S]{0,240}open bound Workstream affinity[\s\S]{0,160}checkpoint[\s\S]{0,160}`no-affinity`[\s\S]{0,80}otherwise/i,
      `${path} must scope workstream-session PreCompact to open-affinity checkpointing`);
    assert.match(section, /first-terminal boundary handoff[\s\S]{0,140}(?:(?:selected by|선택[^.\n]{0,40})\s*`next-action`|`next-action`[^.\n]{0,80}(?:select|선택))/i,
      `${path} must assign first-terminal boundary handoff selection to next-action`);
    assert.match(section, /manual compact restore[\s\S]{0,180}fresh evidence[\s\S]{0,180}same owner[\s\S]{0,180}open bound Workstream affinity[\s\S]{0,180}state-derived continuation[\s\S]{0,180}otherwise[\s\S]{0,100}preserve-pause[\s\S]{0,180}manual resume/i,
      `${path} must define the evidence-derived manual compact restore fallback`);
    assert.match(source, /missing or untrusted hook[\s\S]{0,500}fresh state[\s\S]{0,200}same owner[\s\S]{0,180}open bound Workstream affinity[\s\S]{0,180}(?:continue|continuation)/i,
      `${path} must permit state-derived continuation only with fresh same-owner open-affinity proof`);
    assert.match(source, /otherwise[\s\S]{0,180}preserve-pause[\s\S]{0,250}manual resume/i,
      `${path} must preserve-pause and require manual resume when fresh affinity proof fails`);
    assert.match(source, /isolated Codex child[\s\S]{0,250}(?:disables|disabled)[\s\S]{0,120}plugins[\s\S]{0,120}hooks/i);
  }
});

test('user docs define runtime and launcher executable diagnosis, approval, and drift fencing', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    for (const command of [
      'runtime-executable diagnose',
      'runtime-executable approve',
      'launcher-executable diagnose',
      'launcher-executable approve',
    ]) assert.ok(source.includes(command), `${path} missing ${command}`);
    assert.match(source, /runtime-executable approve --runtime <claude\|codex\|grok> --path "<same-absolute-exe>" --canonical-path "<diagnosed-canonical-path>" --sha256 "<diagnosed-lowercase-sha256>"/);
    assert.match(source, /launcher-executable approve --kind <wt\|powershell> --path "<same-absolute-exe>" --canonical-path "<diagnosed-canonical-path>" --sha256 "<diagnosed-lowercase-sha256>"/);
    for (const token of ['canonical_path', 'sha256', '--actor human', '--confirm', '--owner', '--generation']) {
      assert.ok(source.includes(token), `${path} missing approval token ${token}`);
    }
    assert.match(source, /canonical absolute path/i);
    assert.match(source, /lowercase SHA-256/i);
    assert.match(source, /identity drift[\s\S]{0,250}fail(?:s)? closed[\s\S]{0,180}pause/i);
    assert.match(source, /runtime\/launcher Authenticode signer policy[\s\S]{0,300}pending Windows observation/i);
    assert.match(source, /distinct from[\s\S]{0,180}Claude Desktop handler pin/i);
    assert.match(source, /no bare PATH/i);
    assert.match(source, /no[^\n]*(?:shim|\.cmd|\.ps1)[^\n]*authority/i);
    assert.match(source, /no bare `?wt\.exe`? authority/i);
  }
});

test('proposal-only scope includes repository, release, deletion, and registry synchronization actions', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    for (const action of ['push', 'PR', 'merge', 'publish', 'delete']) {
      assert.match(source, new RegExp(`proposal-only[^\\n]{0,240}\\b${action}\\b`, 'i'),
        `${path} must include ${action} in proposal-only scope`);
    }
    assert.match(source, /proposal-only[^\n]{0,300}(?:marketplace|deep-suite)[^\n]{0,120}sync/i);
  }
});

test('the Claude guide is a thin wrapper over the single source', () => {
  // AGENTS.md is self-contained because Codex has no `@` import; CLAUDE.md is the
  // line-1 import plus Claude-only remainder. Before the split both files carried the
  // same architecture, invariants and release procedure in two phrasings, which is two
  // definitions of one contract. These assertions are what stops it drifting back.
  const claude = readFileSync(join(R, 'CLAUDE.md'), 'utf8');
  assert.match(claude.split(/\r?\n/u)[0], /^@AGENTS\.md$/,
    'CLAUDE.md must open by importing the single source');
  assert.ok(claude.length < 4096, `CLAUDE.md is ${claude.length}B — remainder only, not a second guide`);
  assert.doesNotMatch(claude, /^## Hard invariants/mu,
    'the invariants live in AGENTS.md, once');
  assert.doesNotMatch(readFileSync(join(R, 'AGENTS.md'), 'utf8'), /^@/mu,
    'AGENTS.md must not import anything — Codex does not support it');
});

test('maintainer guides use portable test discovery and the tracked README compatibility contract without fixed module counts', () => {
  for (const path of ['AGENTS.md']) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.match(source, /node --test/);
    assert.doesNotMatch(source, /node --test tests\/\*\.test\.mjs/,
      `${path} must not document shell-expanded test discovery`);
    assert.ok(source.includes('README.md#compatibility-and-recovery-contract'),
      `${path} must link the tracked compatibility contract`);
    assert.doesNotMatch(source, /docs\/superpowers\/specs\/2026-07-10-codex-windows-compatibility-design\.md/,
      `${path} must not point at the ignored compatibility spec`);
    assert.doesNotMatch(source, /scripts\/lib\/\*\.mjs`?\s*\(\d+ modules\)/i);
  }
});

test('maintainer guide documents observation ownership, shared predicates, and the conditional M3 parent', () => {
  const source = readFileSync(join(R, 'AGENTS.md'), 'utf8');
  assert.match(source, /route-observation\.mjs/);
  assert.match(source, /episode-predicates\.mjs/);
  assert.match(source, /RouteObservationV1[\s\S]{0,500}\bomits\b[\s\S]{0,240}parent_run_id[\s\S]{0,240}present-but-null/i);
});

test('deep-suite patch declares node-only runtime and current durable artifacts without stale test counts', () => {
  const source = readFileSync(join(R, 'integration/deep-suite.patch.md'), 'utf8');
  assert.match(source, /"runtime":\s*\["node"\]/);
  assert.doesNotMatch(source, /"runtime":\s*\[[^\]]*"bash"/);
  assert.doesNotMatch(source, /\b\d+ tests green\b/i);
  for (const artifact of [
    '.deep-loop/runs/<run-id>/observations/<subject_sha256>.json',
    '.deep-loop/runs/<run-id>/reviews/<sha256>.json',
    '.deep-loop/runs/<run-id>/preflight/cache/<cache-key>.json',
    '.deep-loop/runs/<run-id>/preflight/accounting/<cache-key>.json',
    '.deep-loop/runs/<run-id>/preflight/process-receipts/<receipt>.json',
    '.deep-loop/runs/<run-id>/checkpoints/<checkpoint-key>-compact.json',
    '.deep-loop/runs/<run-id>/checkpoints/<checkpoint-key>-compact-observation.json',
    '.deep-loop/runs/<run-id>/checkpoints/<checkpoint-key>-compact-prune.json',
    '.deep-loop/runs/<run-id>/compact-restore-intents/<operation-id>.prepared.json',
    '.deep-loop/runs/<run-id>/transactions/<operation-id>/prepared.json',
    '.deep-loop/runs/<run-id>/transactions/<operation-id>/committed.json',
    '.deep-loop/runs/<run-id>/recoveries/<child-run-id>-affinity-recovery.json',
    '.deep-loop/runs/<run-id>/recoveries/root/<replacement-session-id>.json',
    '.deep-loop/runs/<run-id>/terminal/launch-command.txt',
    '.deep-loop/runs/<run-id>/terminal/launch-command.meta.json',
  ]) assert.ok(source.includes(artifact), `integration patch missing ${artifact}`);
  assert.match(source, /"hooks_active":\s*\["PreCompact",\s*"PostCompact",\s*"SessionStart"\]/);
  assert.ok(source.includes('"x-session-start-sources":["compact"]'),
    'integration patch must include the exact schema-valid SessionStart compact source sidecar');
  assert.match(source, /PreCompact[\s\S]{0,180}workstream-session[\s\S]{0,180}open affinity[\s\S]{0,120}checkpoint[\s\S]{0,160}closed boundary[\s\S]{0,120}no-affinity/i,
    'integration patch must describe workstream-session checkpoint/no-affinity behavior');
  assert.match(source, /migrated polic(?:y|ies)[\s\S]{0,200}legacy[\s\S]{0,120}handoff/i,
    'integration patch must reserve the legacy pre-compact handoff path for migrated policies');
  assert.doesNotMatch(source, /PreCompact[^.\n]*(?:exact-boundary|exact boundary)[^.\n]*handoff/i,
    'integration patch must not claim workstream-session PreCompact prepares an exact-boundary handoff');
  assert.match(source, /SessionStart[\s\S]{0,120}(?:source|matcher)[\s\S]{0,40}compact/i);
  assert.match(source, /\.claude-plugin\/marketplace\.json[\s\S]{0,240}\.agents\/plugins\/marketplace\.json/);
  assert.match(source, /generated docs|생성 문서/i);
  assert.match(source, /deep-suite `npm run preflight`[\s\S]{0,300}(?:PR|merge)/i);
  assert.match(source, /post-merge[\s\S]{0,240}(?:separate approval|별도 승인)/i);
  assert.match(source, /marketplace[\s\S]{0,200}sync[\s\S]{0,200}(?:proposal-only|별도 승인)/i);
});

test('1.22 observation docs describe best-effort zero-or-one emission and its bounded race scope', () => {
  const changelog = readFileSync(join(R, 'CHANGELOG.md'), 'utf8');
  const start = changelog.indexOf('## [1.22.0]');
  const end = changelog.indexOf('\n## [', start + 1);
  const release = changelog.slice(start, end < 0 ? undefined : end);
  for (const marker of ['mkdirSync', 'temp write', 'linkSync', 'cleanup', 'fail-open', 'scope', 'moved-original']) {
    assert.match(release, new RegExp(marker.replaceAll('-', '\\-'), 'i'), `CHANGELOG missing ${marker}`);
  }
  for (const [path, required] of [
    ['README.md', /observations\/<subject_sha256>\.json[\s\S]{0,700}(?:best-effort|at-most-once|zero-or-one)/i],
    ['README.ko.md', /observations\/<subject_sha256>\.json[\s\S]{0,700}0개 또는 1개/i],
  ]) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.match(source, required, `${path}: bounded observation emission missing`);
    const observation = source.slice(source.indexOf('observations/<subject_sha256>.json'), source.indexOf('observations/<subject_sha256>.json') + 1400);
    assert.doesNotMatch(observation, /race-free|TOCTOU-safe|prevents parent replacement|부모 교체를 방지/i,
      `${path}: observation docs overclaim the race boundary`);
  }
  assert.doesNotMatch(release, /race-free|TOCTOU-safe|prevents parent replacement|부모 교체를 방지/i);
});

test('live-surface docs name all three shell-free compact hook implementations and never the deleted Bash wrapper', () => {
  const staleWrapperReferences = [];
  const missingImplementationReferences = [];
  for (const path of LIVE_SURFACE_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    if (source.includes('hooks/scripts/precompact-handoff.sh')) staleWrapperReferences.push(path);
    for (const implementation of [
      'precompact-handoff.mjs',
      'postcompact-observe.mjs',
      'sessionstart-restore.mjs',
    ]) {
      const namesImplementation = path === 'hooks/hooks.json'
        ? source.includes(`'scripts','hooks-impl','${implementation}'`)
        : source.includes(`scripts/hooks-impl/${implementation}`);
      if (!namesImplementation) missingImplementationReferences.push(`${path}:${implementation}`);
    }
  }
  assert.deepEqual({ staleWrapperReferences, missingImplementationReferences }, {
    staleWrapperReferences: [],
    missingImplementationReferences: [],
  });
});

test('hook manifest describes cross-host affinity checkpointing while retaining legacy handoff compatibility', () => {
  const manifest = JSON.parse(readFileSync(join(R, 'hooks/hooks.json'), 'utf8'));
  assert.match(manifest.description, /Claude and Codex/i);
  assert.match(manifest.description, /workstream affinity/i);
  assert.match(manifest.description, /artifact-only checkpoint/i);
  assert.match(manifest.description, /legacy handoff/i);
  assert.match(manifest.description, /\bemit-only\b/i);
  assert.match(manifest.description, /unattended continuation is deferred to the measured driveHeadless driver/i);
  assert.doesNotMatch(manifest.description, /\b(?:headless\s+)?respawn\b/i);
});

test('CHANGELOG documents the current plugin release', () => {
  assert.ok(existsSync(join(R, 'CHANGELOG.md')));
  const version = JSON.parse(readFileSync(join(R, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  assert.match(readFileSync(join(R, 'CHANGELOG.md'), 'utf8'), new RegExp(`## \\[${version.replaceAll('.', '\\.')}\\]`));
});

test('README documents the suitability gate in both languages', () => {
  const en = readFileSync(join(R, 'README.md'), 'utf8');
  const ko = readFileSync(join(R, 'README.ko.md'), 'utf8');
  assert.match(en, /suitability gate/i);
  assert.match(ko, /적합성 게이트/);
});

test('Task 14 continuity docs do not route new sessions from legacy policy or launcher heuristics', () => {
  const decisionDocs = [
    'skills/deep-loop-continue/SKILL.md',
    'skills/deep-loop-handoff/SKILL.md',
    'skills/deep-loop-workflow/references/handoff-respawn.md',
  ];
  for (const path of decisionDocs) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.doesNotMatch(source, /gate\.unconsumed_milestones|spawn_style==='(?:desktop|visible)'/,
      `${path}: continuity must follow next-action, not a surface heuristic`);
    assert.match(source, /workstream-session[\s\S]{0,320}action\.boundary_event/,
      `${path}: new-policy handoff must remain exact-boundary-only`);
    assert.match(source, /(?:compact-in-place|rotate-per-unit)[\s\S]{0,420}per_session_turn_cap/,
      `${path}: migrated policies must retain their explicit kernel-action compatibility path`);
    assert.match(source, /action\.boundary_event/,
      `${path}: exact Workstream boundary identity must come from the kernel action`);
    assert.match(source, /native[\s\S]{0,120}\/compact|\/compact[\s\S]{0,120}native/i,
      `${path}: compact advice must use the native same-conversation path`);
  }
});

test('Task 14 execution docs keep durable state read-only outside public kernel commands', () => {
  const paths = [
    'skills/deep-loop/SKILL.md',
    'skills/deep-loop-continue/SKILL.md',
    'skills/deep-loop-handoff/SKILL.md',
    'skills/deep-loop-resume/SKILL.md',
    'skills/deep-loop-status/SKILL.md',
    'skills/deep-loop-workflow/references/handoff-respawn.md',
  ];
  const directWrite = /(?:writeFile|appendFile|Write|Edit)\s*\([^)]*(?:loop\.json|event-log\.jsonl|\.loop\.hash|transactions\/)/i;
  for (const path of paths) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.doesNotMatch(source, directWrite, `${path}: durable state is kernel-owned`);
    assert.match(source, /state[\s\S]{0,80}(?:read-only|읽기만|읽기 전용)|상태 파일을 직접 쓰지 않/i,
      `${path}: read-only execution-plane boundary must be explicit`);
  }
});
