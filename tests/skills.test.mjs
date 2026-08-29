import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillPath = (dir) => join(ROOT, 'skills', dir, 'SKILL.md');
const _rf = readFileSync;
const WORKFLOW_REFS = ['adapters.md', 'review-strategy.md', 'handoff-respawn.md', 'hill-climbing.md', 'checker-bridge.md'];

// Portable recursive .md walk (no reliance on Node ≥20.12 Dirent.parentPath) — Node ≥20 (engines) safe.
function walkMdFiles(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walkMdFiles(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

// 매니페스트: [dir, name, userInvocable, triggers[](영+한 둘 다 포함해야), refsCLI?(mutating이면 CLI 참조 필수)]
const SKILLS = [
  ['deep-loop', 'deep-loop', true, ['/deep-loop', '루프', 'loop engineering'], true],
  ['deep-loop-workflow', 'deep-loop-workflow', false, ['adapter', '어댑터'], false],
  ['deep-loop-discover', 'deep-loop-discover', true, ['/deep-loop-discover', 'discover', '발견'], true],
  ['deep-loop-triage', 'deep-loop-triage', true, ['/deep-loop-triage', 'triage', '분류'], true],
  ['deep-loop-continue', 'deep-loop-continue', true, ['/deep-loop-continue', 'tick', '진행', '계속'], true],
  ['deep-loop-compact', 'deep-loop-compact', true, ['/deep-loop-compact', '$deep-loop:deep-loop-compact', 'compact', '압축'], true],
  ['deep-loop-handoff', 'deep-loop-handoff', true, ['/deep-loop-handoff', 'handoff', '인수인계'], true],
  ['deep-loop-resume', 'deep-loop-resume', true, ['/deep-loop-resume', 'resume', '이어'], true],
  ['deep-loop-status', 'deep-loop-status', true, ['/deep-loop-status', 'status', '상태'], false],
  ['deep-loop-ack', 'deep-loop-ack', true, ['/deep-loop-ack', 'ack', '검토'], true],
  ['deep-loop-finish', 'deep-loop-finish', true, ['/deep-loop-finish', 'finish', '종료'], true],
];

const EXECUTION_DOCS = [
  ...SKILLS.map(([dir]) => skillPath(dir)),
  ...WORKFLOW_REFS.map((name) => join(ROOT, 'skills', 'deep-loop-workflow', 'references', name)),
];

function kernelCommandLines(src) {
  return src.split('\n').filter((line) => /deep-loop\.mjs/.test(line));
}

function frontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(m, 'frontmatter block present');
  return m[1];
}

// Codex r1 sf-4 / r2 sf-3: 2-plane 경계 강제 — durable state 에 대한 *쓰기 지침*만 잡고 읽기/언급/마크다운 인용은 허용.
// durable paths: loop.json · event-log.jsonl · .loop.hash · .deep-loop/runs.
// 셸 redirect 는 **마크다운 blockquote(줄이 '>' 로 시작)를 제외하고** 줄 단위로만 판정한다
// — '> [!IMPORTANT] loop.json + handoff are source of truth' 같은 정상 callout 오탐 방지.
function violatesBoundary(src) {
  // Codex r6 sf-3: 금지 대상은 **커널 전용 durable state 파일 3종**뿐. `.deep-loop/runs/<id>/final-report.md`
  // 같은 비-상태 artifact 쓰기는 /deep-loop-finish 가 정당하게 수행하므로 차단하지 않는다(§12·§15).
  const DUR = '(loop\\.json|event-log\\.jsonl|\\.loop\\.hash)';
  const callForms = [
    new RegExp(`(Write|Edit)\\s*\\([^)]*?${DUR}`),
    new RegExp(`(writeFileSync|appendFileSync|writeFile|appendFile)\\s*\\([^)]*?${DUR}`),
    new RegExp(`\\bsed\\s+-i\\b[^\\n]*?${DUR}`),                     // sed -i 인플레이스
    new RegExp(`\\b(perl|ruby)\\s+-[a-z]*i[a-z]*\\b[^\\n]*?${DUR}`),  // perl/ruby -i 인플레이스
    new RegExp(`open\\s*\\([^)]*${DUR}[^)]*,\\s*["'][wa]`),           // python/ruby open(..., "w"/"a")
  ];
  if (callForms.some(re => re.test(src))) return true;
  // 줄 단위(blockquote 제외): state 파일을 대상으로 하는 셸 쓰기/redirect (cp/mv/rm/truncate/dd).
  const redirect = new RegExp(`(?:>>?|\\btee\\b)\\s+\\S*${DUR}`);
  const shellWrite = new RegExp(`\\b(cp|mv|rm|truncate|install|dd)\\b[^\\n]*${DUR}`);
  return src.split('\n').some(line => {
    if (/^\s*>/.test(line)) return false;   // 마크다운 blockquote — 셸 쓰기 아님
    return redirect.test(line) || shellWrite.test(line);
  });
}

// RouteObservationV1 is a derived artifact rather than kernel state, so it is not
// part of DUR above. Skills still must never publish or edit it directly: only the
// post-commit kernel library emitter owns observations/<subject_sha256>.json.
function violatesObservationBoundary(src) {
  const OBS = 'observations\/[^\\s\'\"]+\\.json';
  const callForms = [
    new RegExp(`(Write|Edit)\\s*\\([^)]*?${OBS}`),
    new RegExp(`(writeFileSync|appendFileSync|writeFile|appendFile)\\s*\\([^)]*?${OBS}`),
    new RegExp(`\\bsed\\s+-i\\b[^\\n]*?${OBS}`),
    new RegExp(`\\b(perl|ruby)\\s+-[a-z]*i[a-z]*\\b[^\\n]*?${OBS}`),
    new RegExp(`open\\s*\\([^)]*${OBS}[^)]*,\\s*[\"'][wa]`),
  ];
  if (callForms.some((re) => re.test(src))) return true;
  const redirect = new RegExp(`(?:>>?|\\btee\\b)\\s+\\S*${OBS}`);
  const shellWrite = new RegExp(`\\b(cp|mv|rm|truncate|install|dd)\\b[^\\n]*${OBS}`);
  return src.split('\n').some((line) => {
    if (/^\s*>/.test(line)) return false;
    return redirect.test(line) || shellWrite.test(line);
  });
}

// Codex r3 sf-4: deep-loop.mjs 를 실제 호출하는 라인 중 mutating subcommand 는 --owner 와 --generation 을 **둘 다** 가져야 한다.
// Task 8: insights emit 도 mutating (lease-fenced) — MUTATING_SUB/MUTATING_CMD 둘 다 확장.
const MUTATING_SUB = /(state\s+patch|episode\s+(?:new|record|abandon)|workstream\s+(?:new|set|terminal)|review\s+(?:configure|dispatch|record)|handoff\s+emit|checkpoint\s+(?:emit|observe|restore)|pause\b|budget\s+record|comprehension\s+ack|breaker\s+reset|session-profile\s+set|launcher-executable\s+approve|lease\s+(?:acquire|release)|finish\b|insights\s+emit)/;
// Codex r5 sf-3: shorthand 명령(예: `episode record --status done`, `finish --status completed`)도 잡는다.
// "command 라인" = deep-loop.mjs 호출이거나, mutating sub 뒤에 CLI 플래그(--xxx)가 오는 경우. 순수 산문 멘션은 무시.
const MUTATING_CMD = /(?:state\s+patch|episode\s+(?:new|record|abandon)|workstream\s+(?:new|set|terminal)|review\s+(?:configure|dispatch|record)|handoff\s+emit|checkpoint\s+(?:emit|observe|restore)|pause|budget\s+record|comprehension\s+ack|breaker\s+reset|session-profile\s+set|launcher-executable\s+approve|lease\s+(?:acquire|release)|finish|insights\s+emit)\b[^\n]*\s--\w/;
function mutatingFenced(text) {
  // Codex r4 sf-2: 셸 라인 연속(\ 로 끝나는 줄)을 논리 명령으로 먼저 합친다 — multi-line unfenced 명령 회피 차단.
  const joined = text.replace(/\r\n?/g, '\n').replace(/\\\n\s*/g, ' ');
  return joined.split('\n').every(line => {
    if (!MUTATING_SUB.test(line)) return true;                       // mutating sub 언급 없음 → OK
    const isCommand = /deep-loop\.mjs/.test(line) || MUTATING_CMD.test(line);
    if (!isCommand) return true;                                     // 산문 멘션(플래그 없음) → 무시
    return /--owner\b/.test(line) && /--generation\b/.test(line);    // mutating 명령 → 두 fence flag 필수 (OR 아님)
  });
}

// R3 high-3: bare-relative `.claude/worktrees/ws`(git이 cwd 기준 해석 → worktree 안에서 중첩)도 위험.
// 안전 조건을 강화: worktree 경로가 등장하면 반드시 $ORIG_ROOT 절대 앵커여야 한다. '..'·foreign-abs·bare-relative 모두 flag.
// 산문 오탐 회피: worktrees 경로 토큰이나 foreign 절대경로가 없는 순수 멘션 라인은 무시.
function worktreeWriteOutsideRoot(src) {
  const joined = src.replace(/\r\n?/g, '\n').replace(/\\\n\s*/g, ' ');   // 백슬래시 연속줄 join (mutatingFenced 패턴)
  return joined.split('\n').some(line => {
    // R5 P2-1: git 옵션(-C 등)이 git 과 worktree add 사이에 와도 매칭.
    if (!/\bgit\b[^\n]*\bworktree\s+add\b/.test(line)) return false;
    if (/\.\.(\/|\\)/.test(line)) return true;                                    // '..' escape
    const origRootAnchored = /(?:\$\{?ORIG_ROOT\}?|<canonical_project_root>)\/[^"'\s]*\.(claude\/worktrees|worktrees)\//.test(line);
    const mentionsWtPath = /\.(claude\/worktrees|worktrees)\//.test(line);
    if (mentionsWtPath && !origRootAnchored) return true;                         // bare/cwd-relative worktrees path
    const hasForeignAbs = /\s["']?\/(?!\/)/.test(line) || /\s["']?[A-Za-z]:\\/.test(line);
    return hasForeignAbs && !origRootAnchored;                                    // /tmp 등 foreign abs
  });
}

test('boundary: worktree-write guard flags root-escape/bare-relative/git-options, allows $ORIG_ROOT-anchored', () => {
  assert.ok(worktreeWriteOutsideRoot('git worktree add /tmp/wt -b x base'), 'abs /tmp flagged');
  assert.ok(worktreeWriteOutsideRoot('git worktree add ../sib/wt -b x base'), '.. flagged');
  assert.ok(worktreeWriteOutsideRoot('git worktree add -b x \\\n  /tmp/wt base'), 'multiline escape flagged');
  assert.ok(worktreeWriteOutsideRoot('git worktree add .claude/worktrees/ws -b x base'), 'bare-relative worktrees flagged (R3 high-3)');
  assert.ok(worktreeWriteOutsideRoot('git -C "$ORIG_ROOT" worktree add /tmp/wt -b x base'), 'git -C option + /tmp flagged (R5 P2-1)');
  assert.ok(!worktreeWriteOutsideRoot('git worktree add -b worktree-ws "$ORIG_ROOT/.claude/worktrees/ws" "$BASE_REF"'), 'ORIG_ROOT-anchored allowed');
  assert.ok(!worktreeWriteOutsideRoot('git worktree add -b "worktree-ws" "<canonical_project_root>/.claude/worktrees/ws" "<base_ref>"'), 'portable canonical-root placeholder allowed');
  assert.ok(!worktreeWriteOutsideRoot('git worktree add \\\n  -b w "$ORIG_ROOT/.claude/worktrees/ws" "$BASE_REF"'), 'ORIG_ROOT-anchored multiline allowed');
  assert.ok(!worktreeWriteOutsideRoot('이미 worktree 안이면 재사용 (산문)'), 'prose without git-worktree-add ignored');
});

test('AGENTS.md: invariant #7 carries explicit worktree-write carve-out', () => {
  // Moved with the invariants when AGENTS.md became the single source. The rule is
  // cross-runtime, so pinning it to the Claude-only file asserted it in the one place
  // a Codex agent does not read.
  const md = _rf(join(ROOT, 'AGENTS.md'), 'utf8');
  assert.match(md, /\.claude\/worktrees\//, 'names .claude/worktrees/ carve-out');
  assert.match(md, /worktree[\s\S]{0,400}(proposal-only|사람 승인|human|containment)/i, 'carve-out rules present');
});

test('boundary scan flags forbidden write forms and allows reads/mentions/blockquotes (fixtures)', () => {
  const bad = [
    'Write({ file_path: ".deep-loop/runs/x/loop.json", content: "..." })',
    'fs.appendFileSync(".deep-loop/runs/x/event-log.jsonl", line)',
    'echo "$JSON" > .deep-loop/runs/$ID/loop.json',
    'sed -i "s/running/paused/" .deep-loop/runs/x/loop.json',
    'cp tmp .deep-loop/runs/$ID/loop.json',
    'mv tmp .deep-loop/runs/x/event-log.jsonl',
    'truncate -s 0 .deep-loop/runs/x/loop.json',
    "python -c \"open('.deep-loop/runs/x/loop.json', 'w')\"",
    'node -e "fs.writeFileSync(\'a/.loop.hash\', h)"',
  ];
  for (const s of bad) assert.ok(violatesBoundary(s), `should flag: ${s}`);
  const ok = [
    'loop.json + handoff 가 source of truth. 이전 대화 가정 금지.',
    '> [!IMPORTANT] loop.json + handoff are the source of truth.',   // blockquote 오탐 금지
    '> .deep-loop/runs/<id>/loop.json 은 커널만 쓴다.',               // blockquote path 언급 허용
    'run dir 은 .deep-loop/runs/<id>/ 이다 (커널만 씀).',             // 비-blockquote path 언급(쓰기 동사 없음) 허용
    'Write({ file_path: ".deep-loop/runs/<id>/final-report.md", content: report })',   // Codex r6 sf-3: 정당한 artifact write 허용
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field status',
    'Read .deep-loop/runs/<id>/handoffs/<ts>-next-session.md first; then /deep-loop-resume',
    'event-log.jsonl 은 커널이 appendAnchored 단일 경로로만 쓴다 (스킬은 절대 직접 쓰지 않음).',
  ];
  for (const s of ok) assert.ok(!violatesBoundary(s), `should allow: ${s}`);
});

test('observation boundary flags direct writers while allowing prose and blockquotes', () => {
  const bad = [
    'Write({ file_path: "observations/abc.json", content: body })',
    'fs.writeFileSync("observations/abc.json", body)',
    'echo "$JSON" > observations/abc.json',
    'tee observations/abc.json',
    'cp tmp observations/abc.json',
    'rm observations/abc.json',
    'sed -i "s/x/y/" observations/abc.json',
    "python -c \"open('observations/abc.json', 'w')\"",
  ];
  for (const source of bad) assert.ok(violatesObservationBoundary(source), `should flag: ${source}`);
  const ok = [
    '관측 파일 `observations/<subject_sha256>.json`은 커널만 쓴다.',
    '> echo "$JSON" > observations/example.json',
    'Read observations/example.json for diagnostics.',
  ];
  for (const source of ok) assert.ok(!violatesObservationBoundary(source), `should allow: ${source}`);
});

test('execution-plane docs never instruct a direct RouteObservationV1 write', () => {
  for (const file of walkMdFiles(join(ROOT, 'skills'))) {
    assert.ok(!violatesObservationBoundary(readFileSync(file, 'utf8')),
      `${file} must not instruct a direct observations/*.json write`);
  }
});

test('continue skill preserves optional router linkage without synthesizing it', () => {
  const source = readFileSync(skillPath('deep-loop-continue'), 'utf8');
  assert.match(source, /decision_fingerprint/);
  assert.match(source, /request_sha256/);
  assert.match(source, /합성하지 않는다|never synthesi[sz]e/i);
});

test('compact hooks never import the RouteObservationV1 emitter', () => {
  for (const name of readdirSync(join(ROOT, 'scripts', 'hooks-impl')).filter((entry) => entry.endsWith('.mjs'))) {
    const source = readFileSync(join(ROOT, 'scripts', 'hooks-impl', name), 'utf8');
    assert.doesNotMatch(source, /(?:from\s+|import\s*\()['\"][^'\"]*route-observation\.mjs['\"]/, name);
  }
});

test('mutatingFenced requires both fence flags on mutating CLI lines (fixtures)', () => {
  assert.ok(mutatingFenced('node x/deep-loop.mjs episode record --status done --owner $R --generation 1'));
  assert.ok(!mutatingFenced('node x/deep-loop.mjs episode record --status done --owner $R'));   // --generation 누락
  assert.ok(!mutatingFenced('node x/deep-loop.mjs review record --verdict APPROVE --generation 1'));   // --owner 누락
  assert.ok(mutatingFenced('node x/deep-loop.mjs next-action --json'));   // read-only → fence 불필요
  assert.ok(mutatingFenced('node x/deep-loop.mjs path resolve --target run-dir --project-root /repo --run-id R'));
  assert.ok(mutatingFenced('record the result via `episode record`'));    // 산문(플래그 없음) → 무시
  // Codex r4 sf-2: 셸 연속줄로 fence 를 분리해 회피하는 시도 차단.
  assert.ok(!mutatingFenced('node x/deep-loop.mjs \\\n  state patch --field discovered_items --value "[]"'));
  assert.ok(!mutatingFenced('node x/deep-loop.mjs \\\r\n  state patch --field discovered_items --value "[]"'));
  assert.ok(mutatingFenced('node x/deep-loop.mjs \\\n  state patch --field x --value "[]" --owner $R --generation 1'));
  // Codex r5 sf-3: deep-loop.mjs 프리픽스 없는 shorthand mutating 명령도 fence 필요.
  assert.ok(!mutatingFenced('episode record --status done --artifacts \'["a"]\''));   // shorthand unfenced
  assert.ok(!mutatingFenced('finish --status completed --report final-report.md'));   // shorthand unfenced
  assert.ok(mutatingFenced('episode record --status done --owner $R --generation 1'));   // shorthand fenced OK
});

// Task 4.1: the execution plane is copied between Claude Code, Codex CLI/App, POSIX,
// PowerShell, and cmd.exe.  Command examples therefore describe argv, never a shell program.
test('portable command contract: every entry derives and substitutes an absolute DEEP_LOOP_ROOT', () => {
  for (const file of EXECUTION_DOCS) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, /loaded SKILL\.md path|로드된 `?SKILL\.md`? 경로/i,
      `${file}: root derivation must start from the loaded SKILL.md path`);
    assert.match(src, /DEEP_LOOP_ROOT[\s\S]{0,360}(?:absolute|절대)/i,
      `${file}: DEEP_LOOP_ROOT must be an absolute derived root`);
    assert.match(src, /(?:replace|substitut|치환)[\s\S]{0,240}DEEP_LOOP_ROOT|DEEP_LOOP_ROOT[\s\S]{0,240}(?:replace|substitut|치환)/i,
      `${file}: the placeholder must be replaced before execution`);
    assert.match(src, /literal[\s\S]{0,160}DEEP_LOOP_ROOT[\s\S]{0,200}(?:never|금지|않)/i,
      `${file}: literal DEEP_LOOP_ROOT must never reach Node`);
  }
});

test('portable command contract: kernel examples are one-line canonical argv templates', () => {
  for (const file of EXECUTION_DOCS) {
    const src = readFileSync(file, 'utf8');
    const commands = kernelCommandLines(src);
    for (const line of commands) {
      assert.match(line, /^\s*node "DEEP_LOOP_ROOT\/scripts\/deep-loop\.mjs"(?:\s|$)/,
        `${file}: non-canonical or non-one-line kernel command: ${line}`);
      assert.doesNotMatch(line, /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}|%(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)%|\$env:(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)/i,
        `${file}: command depends on an ambient plugin-root expansion`);
      assert.doesNotMatch(line, /\\\s*$/, `${file}: command uses backslash continuation`);
    }
  }
});

test('portable command contract: execution docs contain no shell-only construction', () => {
  const forbidden = [
    [/\$\(/, 'command substitution'],
    [/\b[A-Z][A-Z0-9_]*\s*=\s*\(/, 'Bash array'],
    [/\$\{[A-Z][A-Z0-9_]*\[@\]\}/, 'Bash array expansion'],
    [/^\s*[A-Z][A-Z0-9_]*=\S+(?:\s+[A-Z][A-Z0-9_]*=\S+)*\s+\S+/m, 'POSIX env-prefix assignment'],
    [/^\s*\[[^\n]*\]\s*(?:&&|\|\|)/m, 'Bash test/chaining'],
    [/(?:&&|\|\|)/, 'shell command chaining'],
    [/\\\s*$/m, 'backslash continuation'],
  ];
  for (const file of EXECUTION_DOCS) {
    const src = readFileSync(file, 'utf8');
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(src, pattern, `${file}: ${label} is not host-neutral`);
    }
  }
});

test('portable command contract: runtime and resumed mutation identity are explicit', () => {
  const init = kernelCommandLines(readFileSync(skillPath('deep-loop'), 'utf8'))
    .find((line) => /\binit-run\b/.test(line)) || '';
  assert.match(init, /--runtime\s+<claude\|codex\|grok>/, 'init-run must carry the asserted current runtime');
  assert.match(init, /--project-root\s+"<canonical_project_root>"/, 'init-run must pin the canonical root');

  for (const file of EXECUTION_DOCS) {
    const src = readFileSync(file, 'utf8');
    for (const line of kernelCommandLines(src)) {
      if (/\blease acquire\b/.test(line)) {
        assert.match(line, /--runtime\s+<claude\|codex\|grok>/, `${file}: lease acquire must assert runtime`);
      }
      if (/--project-root\b/.test(line)) {
        assert.match(line, /--project-root\s+"<canonical_project_root>"/,
          `${file}: project-root placeholder must be quoted`);
      }
      if (MUTATING_SUB.test(line) && /--owner\b/.test(line)) {
        assert.match(line, /--project-root\s+"<canonical_project_root>"/,
          `${file}: resumed mutation must pin project root`);
        assert.match(line, /--run-id\s+<run_id>/,
          `${file}: resumed mutation must pin logical run id`);
        assert.match(line, /--generation\b/, `${file}: resumed mutation must retain generation fence`);
      }
    }
  }
});

test('entry guidance never presents current as sole active authority', () => {
  const entry = readFileSync(skillPath('deep-loop'), 'utf8');
  const status = readFileSync(skillPath('deep-loop-status'), 'utf8');
  for (const [name, source] of [['deep-loop', entry], ['deep-loop-status', status]]) {
    assert.match(source, /run list/i, `${name}: must list runs before implicit selection`);
    assert.match(source, /current[^\n]{0,180}(?:hint|last-created)|(?:hint|last-created)[^\n]{0,180}current/i,
      `${name}: current must be documented as a hint only`);
    assert.doesNotMatch(source, /current\s+(?:run\s+)?(?:is\s+)?(?:the\s+)?(?:sole|single)\s+(?:authority|source|selection)/i,
      `${name}: current must never be the sole routing authority`);
  }
});

test('mutation examples include valued run-id', () => {
  for (const file of [skillPath('deep-loop'), skillPath('deep-loop-status')]) {
    const source = readFileSync(file, 'utf8')
      .replace(/\r\n?/g, '\n')
      .replace(/\\\n\s*/g, ' ');
    for (const line of kernelCommandLines(source)) {
      if (MUTATING_SUB.test(line) && /--owner\b/.test(line)) {
        assert.match(line, /--run-id\s+<run_id>/, `${file}: mutation must pin valued --run-id: ${line}`);
      }
    }
  }
});

test('inline human mutation shorthands in status remain fully identity-bound', () => {
  const source = readFileSync(skillPath('deep-loop-status'), 'utf8');
  const commandPattern = /`([^`\n]*(?:breaker reset|budget extend|episode abandon|attended-launch approve|attended-launch revoke|pause --mode preserve|root rebind(?:\s|`)|root recover(?:\s|`))[^`\n]*)`/gi;
  for (const match of source.matchAll(commandPattern)) {
    assert.match(match[1], /--project-root\s+/, `status shorthand lacks project root: ${match[1]}`);
    assert.match(match[1], /--run-id\s+/, `status shorthand lacks run id: ${match[1]}`);
  }
});

test('portable host invocation contract: every user entry names Claude slash and Codex qualified dollar forms', () => {
  for (const [dir, name, invocable] of SKILLS) {
    if (!invocable) continue;
    const src = readFileSync(skillPath(dir), 'utf8');
    assert.match(src, new RegExp(`/${name}\\b`), `${dir}: Claude slash invocation missing`);
    assert.match(src, new RegExp(`\\$deep-loop:${name}\\b`), `${dir}: Codex qualified dollar invocation missing`);
  }
});

test('tracked user command inventories expose every user skill on both hosts', () => {
  const expected = SKILLS
    .filter(([, , invocable]) => invocable)
    .map(([, name]) => name);
  for (const path of ['README.md', 'README.ko.md']) {
    const source = readFileSync(join(ROOT, path), 'utf8');
    for (const name of expected) {
      assert.match(source, new RegExp(`/${name}\\b`),
        `${path}: missing Claude command /${name}`);
      assert.match(source, new RegExp(`\\$deep-loop:${name}\\b`),
        `${path}: missing Codex command $deep-loop:${name}`);
    }
    assert.match(source, /(?:Commands|명령어) \((?:10 User Skills|사용자 스킬 10개)\)/,
      `${path}: user skill count must include deep-loop-compact`);
  }
});

// Task 4: deep-loop §2-6 worktree creation discipline
const dlSkill = () => _rf(skillPath('deep-loop'), 'utf8');

test('deep-loop §2-6: git-first preferred .worktrees path; native is not the creator', () => {
  const s = dlSkill();
  const joined = s.replace(/\\\n\s*/g, ' ');
  assert.match(s, /EnterWorktree/, 'native token remains for entry/legacy');
  assert.match(s, /git worktree add/, 'git creation');
  assert.match(s, /\.worktrees\//, 'preferred path');
  const addLines = joined.split('\n').filter((l) => /\bgit\b[^\n]*\bworktree\s+add\b/.test(l));
  assert.ok(addLines.length > 0, 'git worktree add command line');
  for (const addLine of addLines) {
    assert.match(
      addLine,
      /(?:\$\{?ORIG_ROOT\}?|<canonical_project_root>)\/\.worktrees\//,
      'every create is under canonical .worktrees/',
    );
    assert.doesNotMatch(addLine, /\.claude\/worktrees\//, 'creation command is not .claude/worktrees/');
  }
  const table = s.match(/#### 결정표([\s\S]*?)(?:\n### |\n## |$)/)?.[1] || '';
  assert.ok(table.length > 0, 'decision table must extract');
  assert.match(table, /비격리/);
  assert.match(table, /git\(Step 1b\)/);
  assert.doesNotMatch(table, /EnterWorktree/);
});

test('deep-loop §2-6: detection-first + reuse eligibility gate', () => {
  const s = dlSkill();
  assert.match(s, /git-common-dir|이미 (격리|worktree)/, 'Step 0 detection');
  assert.match(s, /clean[\s\S]{0,160}base[\s\S]{0,160}(소유|브랜치)/, 'reuse eligibility');
  assert.match(s, /(사용자 확인|human|승인)/, 'reuse confirm gate');
});

test('deep-loop §2-6: gitignore proposal-only + check-ignore precedes add', () => {
  const s = dlSkill();
  const ci = s.indexOf('check-ignore'), wa = s.indexOf('git worktree add');
  assert.ok(ci !== -1 && wa !== -1 && ci < wa, 'check-ignore precedes worktree add');
  const autoCommit = s.split('\n').some(l => /gitignore/i.test(l) && /\bgit\s+commit\b/.test(l));
  assert.ok(!autoCommit, 'no auto-commit .gitignore');
  assert.match(s, /proposal-only|제안|승인 시에만/, 'gitignore proposal-only');
  assert.match(
    s,
    /git\s+-C\s+"<canonical_project_root>"\s+check-ignore\s+-q\s+--\s+\.worktrees\//,
    'ignore probe is canonical-root anchored',
  );
  assert.doesNotMatch(s, /git check-ignore -q \.worktrees\//);
  assert.doesNotMatch(s, /git check-ignore -q \.claude\/worktrees\//);
});

test('deep-loop §2-6: worktree creation never escapes root + post-init mutations pin root/run', () => {
  const s = dlSkill();
  assert.ok(!worktreeWriteOutsideRoot(s), 'no root-escaping git worktree add');
  const resumedMutations = kernelCommandLines(s).filter((line) => MUTATING_SUB.test(line) && /--owner\b/.test(line));
  assert.ok(resumedMutations.length > 0, 'post-init mutation examples exist');
  for (const line of resumedMutations) {
    assert.match(line, /--project-root\s+"<canonical_project_root>"/);
    assert.match(line, /--run-id\s+<run_id>/);
  }
  assert.ok(mutatingFenced(s), 'mutating CLI still fenced');
});

// Task 5: §0.5 cwd split + artifact ORIG_ROOT-relative + Step 1.5 orphan mitigation
test('deep-loop: ORIG_ROOT/BASE_REF capture (sibling path) + cwd split + artifact ORIG_ROOT-rel', () => {
  const s = dlSkill();
  // Extract the §0.5 section: from its heading to the next #### heading
  const sec05Match = s.match(/####\s*§0\.5[\s\S]*?(?=\n####|\n###|\n##|$)/);
  assert.ok(sec05Match, '§0.5 section present');
  const sec05 = sec05Match[0];
  // Rule 1: ORIG_ROOT/BASE_REF capture must be documented IN the §0.5 section
  assert.match(sec05, /ORIG_ROOT/, 'ORIG_ROOT capture documented in §0.5 section');
  assert.match(sec05, /BASE_REF/, 'BASE_REF capture documented in §0.5 section');
  assert.match(sec05, /(sibling|캡처)/, 'capture purpose (sibling/캡처) documented in §0.5 section');
  // Rule 4: cwd split
  assert.match(sec05, /cwd[\s\S]{0,80}(분리|worktree)/, 'cwd split in §0.5 section');
  // Rule 5: artifact ORIG_ROOT-relative
  assert.match(sec05, /artifact[\s\S]{0,160}(ORIG_ROOT|상대|\.claude\/worktrees)/, 'artifact ORIG_ROOT-relative in §0.5 section');
  // FIX P: ORIG_ROOT must use git-common-dir (main repo root), not bare --show-toplevel
  // (in a linked worktree, --show-toplevel returns the worktree path, not the project root)
  assert.match(sec05, /git-common-dir/, 'ORIG_ROOT must use git-common-dir main-root derivation in §0.5 (not bare --show-toplevel)');
});

test('deep-loop Step 1.5: lease check precheck + orphan handling (no --field lease command)', () => {
  const s = dlSkill();
  assert.match(s, /lease check/, 'lease check precheck');
  assert.ok(!/state\s+get[^\n]*--field\s+lease\b/.test(s), 'no `state get --field lease` command');
  assert.match(s, /(reconcile|audit)/, 'reconcile audit');
  assert.match(s, /(고아|orphan)/, 'orphan handling');
});

for (const [dir, name, invocable, triggers, refsCLI] of SKILLS) {
  test(`skill ${dir}: exists`, () => assert.ok(existsSync(skillPath(dir)), `${dir}/SKILL.md missing`));
  test(`skill ${dir}: frontmatter has exactly name/description/user-invocable`, () => {
    const fm = frontmatter(readFileSync(skillPath(dir), 'utf8'));
    assert.match(fm, new RegExp(`name:\\s*${name}\\b`));
    assert.match(fm, new RegExp(`user-invocable:\\s*${invocable}`));
    assert.match(fm, /description:/);
    // 허용 키만 (다른 top-level 키 금지)
    const keys = fm.split(/\r?\n/).filter(l => /^[a-z-]+:/.test(l)).map(l => l.split(':')[0]);
    for (const k of keys) assert.ok(['name', 'description', 'user-invocable'].includes(k), `unexpected key ${k} in ${dir}`);
  });
  test(`skill ${dir}: triggers present (en+ko)`, () => {
    const src = readFileSync(skillPath(dir), 'utf8');
    for (const t of triggers) assert.ok(src.includes(t), `${dir} missing trigger "${t}"`);
  });
  test(`skill ${dir}: language-detect instruction`, () => {
    const src = readFileSync(skillPath(dir), 'utf8');
    assert.match(src, /언어|language/i);
  });
  test(`skill ${dir}: never instructs a direct durable-state write`, () => {
    assert.ok(!violatesBoundary(readFileSync(skillPath(dir), 'utf8')),
      `${dir} instructs a direct durable-state write — must route through the fenced CLI`);
  });
  if (refsCLI) {
    test(`skill ${dir}: every mutating CLI line carries both fence flags`, () => {
      const src = readFileSync(skillPath(dir), 'utf8');
      assert.match(src, /deep-loop\.mjs/, `${dir} must invoke kernel CLI`);
      // Codex r3 sf-4: --owner 와 --generation 둘 다 (OR 아님). mutating CLI 라인마다 fence 필수.
      assert.ok(mutatingFenced(src), `${dir} has a mutating deep-loop.mjs line missing --owner or --generation`);
    });
  }
  if (invocable && dir !== 'deep-loop-status') {
    test(`skill ${dir}: entry skills carry echo-suppression + safety boilerplate`, () => {
      const src = readFileSync(skillPath(dir), 'utf8');
      assert.match(src, /echo 금지|IMPORTANT/, `${dir} missing echo-suppression callout`);
      assert.match(src, /proposal-only|사람 승인|human/i, `${dir} missing external-action safety note`);
    });
  }
}

test('episode abandon must be fenced (mutatingFenced)', () => {
  assert.equal(mutatingFenced('node deep-loop.mjs episode abandon --id x --reason r --confirm'), false);   // fence 없음 → false
  assert.equal(mutatingFenced('node deep-loop.mjs episode abandon --id x --reason r --confirm --owner R --generation 1'), true);
});

test('deep-loop-workflow references exist', () => {
  for (const r of ['adapters.md', 'review-strategy.md', 'handoff-respawn.md', 'hill-climbing.md'])
    assert.ok(existsSync(join(ROOT, 'skills', 'deep-loop-workflow', 'references', r)), `missing reference ${r}`);
});

// Task 8: hill-climbing protocol reference — Tier 목록 전문 + 증거 계약 (a)~(f) + ledger append 규약.
test('hill-climbing reference: 존재 + Tier 목록 + 증거 계약 (a)~(f)', () => {
  const src = readFileSync(join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'hill-climbing.md'), 'utf8');
  for (const marker of ['Tier 1', 'Tier 2', 'recipes/*.json', 'recipes/automation/*.yml',
    'insights latest', 'falsification', 'hillclimb-ledger.json', '(e)', '(f)', 'append',
    'diff', '수정', '삭제', '재배열', 'git log']) {   // ledger 순수-append 계약 핵심어 (r1 codex S3)
    assert.ok(src.includes(marker), `hill-climbing.md missing marker: ${marker}`);
  }
  assert.ok(mutatingFenced(src), 'mutating commands must carry --owner/--generation');
  assert.ok(!violatesBoundary(src));
});

// Task 8: finish must emit insights (non-fatal on failure); init must read insights latest (read-only).
// Both must go through the kernel CLI — never parse/write .deep-loop/insights/ directly.
test('finish/init 스킬: insights CLI 경유만 (직접 파싱·쓰기 금지)', () => {
  for (const dir of ['deep-loop-finish', 'deep-loop']) {
    const src = readFileSync(skillPath(dir), 'utf8');
    // .deep-loop/insights/ 를 언급하는 명령 라인은 반드시 deep-loop.mjs insights 호출이어야 함
    const bad = src.split('\n').some(line =>
      /\.deep-loop\/insights\//.test(line) && !/deep-loop\.mjs/.test(line)
      && (/(?:^|\s)(?:cat|jq|head|tail)\b/.test(line) || /readFileSync|Read\(/.test(line) || />>?\s*\S*\.deep-loop\/insights\//.test(line)));
      // r1 opus S3: `>`는 \b 워드경계가 안 걸리므로 redirect 분기를 별도 패턴으로 — `> .deep-loop/insights/...` 미탐 방지
    assert.ok(!bad, `${dir}: direct insights file access`);
  }
  assert.ok(readFileSync(skillPath('deep-loop-finish'), 'utf8').includes('insights emit'));
  assert.ok(readFileSync(skillPath('deep-loop'), 'utf8').includes('insights latest'));
});

// G5 (plan Phase 5): 이 파일은 세 문서를 하나도 바꾸지 않아도 GREEN 이므로, 그것만으로는 Phase 5 의
// 산출을 검출하지 못한다. 아래는 **행 번호가 아니라 내용**으로 고정한다(줄 이동에 견디도록).
test('resume/respawn prose: promote only on proceed:true and persist the attempt id before acquiring', () => {
  const resume = _rf(skillPath('deep-loop-resume'), 'utf8');
  const respawn = _rf(join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md'), 'utf8');
  const workflow = _rf(skillPath('deep-loop-workflow'), 'utf8');

  // ① 승격을 말하는 **모든** 문장이 proceed 를 근거로 삼는다.
  //
  // 라운드 5 F5-1: 이전 판은 두 겹으로 무력했다. (가) 파일 단위 `proceed:true` substring 검사는
  // 다른 문단(오용 복구 문단, workflow 의 각주)이 그 문자열을 공급하면 통과했다 — 즉 이 커밋이
  // spec §3.4 대로 추가한 각주가 같은 커밋의 게이트를 무력화했다. (나) 잔존 검사가 **한 물리 줄**만
  // 봤는데 이 문서들은 80칼럼 하드랩이라 원문은 `ok:true` 와 `승격` 이 다른 줄에 놓인다. 실제
  //  커밋 전 문안을 되돌리는 probe 가 세 문서 중 둘에서 통과했다.
  // 그래서 개행을 접어 **승격 언급 주변 창**을 문장 단위로 검사한다 — 백틱·어순·언어에 둔감하다.
  for (const [name, src] of [['deep-loop-resume', resume], ['handoff-respawn', respawn], ['deep-loop-workflow', workflow]]) {
    // 고정 폭 창은 **인접한 정당한 문장**의 `proceed` 를 주워오므로 회피를 통과시킨다(직접 확인).
    // 개행을 접은 뒤 문장 경계(마침표/콜론)로 잘라 문장 단위로 검사한다. `proceed:true` 의 콜론은
    // 뒤에 공백이 없어 경계로 잡히지 않는다.
    const sentences = src.replace(/\s+/g, ' ').split(/(?<=[.:。])\s/)
      .filter(sentence => /승격|promote/i.test(sentence));
    assert.ok(sentences.length > 0, `${name}: must state a promotion rule at all`);
    for (const sentence of sentences) {
      assert.match(sentence, /proceed/,
        `${name}: every promotion sentence must be keyed on proceed, not on success alone: ${sentence.trim()}`);
    }
    assert.ok(sentences.some(sentence => /proceed:true/.test(sentence)),
      `${name}: at least one promotion sentence must name proceed:true`);
    // `proceed` 존재만 보면 같은 문장의 부정절(`proceed:false` 언급)이 토큰을 공급해 반쪽 되돌림이
    // 통과한다(직접 확인). **긍정형 승격 지시**는 반드시 proceed:true 를 명명해야 한다 — 부정형
    // ("승격하지 않고"/"승격하지 말고")은 이 규칙의 대상이 아니다.
    for (const sentence of sentences.filter(s2 => /승격한다|승격하고|승격하라|승격하며|승격 대상|\bpromote(?:d|s)?\b/i.test(s2))) {
      assert.match(sentence, /proceed:true/,
        `${name}: an affirmative promotion instruction must name proceed:true: ${sentence.trim()}`);
    }
    // 라운드 6 F6-1: 문장 검사와 옛 **줄 단위** 잔존 검사의 실패 집합은 서로 교차한다 — 어느 하나가
    // 상위집합이 아니므로 둘을 함께 둔 합집합이 곧 개선이다. 한계는 명시한다: 이 계열은 키워드
    // 게이트이므로 "ok:true 로 승격한다고 명시적으로 반전한 문장"은 잡지 못한다(라운드 5 A9 처분과 동일 근거).
    const staleOkTrueLines = src.split('\n').filter(line => /승격/.test(line) && /`ok:true`/.test(line)
      && !/proceed/.test(line));
    assert.deepEqual(staleOkTrueLines, [], `${name}: no single line may key promotion on ok:true alone`);
  }
  // already-owned 가 ok:true 인데도 승격 대상이 아님을 명시한다.
  assert.match(resume, /already-owned/);
  assert.match(respawn, /already-owned/);

  // ② attempt_id 사전 영속화 순서 — 생성 → 영속화 → acquire, 재시도는 같은 값.
  for (const [name, src] of [['deep-loop-resume', resume], ['handoff-respawn', respawn]]) {
    assert.match(src, /--attempt-id/, `${name}: must show the --attempt-id flag`);
    assert.match(src, /생성[\s\S]{0,80}영속화[\s\S]{0,80}acquire/, `${name}: must state generate → persist → acquire order`);
    assert.match(src, /같은 값[\s\S]{0,40}재사용/, `${name}: retries must reuse the same attempt id`);
    assert.match(src, /amnesiac/, `${name}: must warn that persisting after the call leaves an amnesiac window`);
    // F5-5(라운드 5): 단어 존재만 보면 "호출 후에 기록해도 무방" 같은 의미 반전이 통과한다.
    // 호출 후 영속화가 **금지**라는 규범 자체를 고정한다.
    assert.match(src.replace(/\s+/g, ' '), /호출 후[^.]{0,60}(?:금지|남기므로 금지|안 된다)/,
      `${name}: persisting after the call must be stated as forbidden, not merely mentioned`);
  }

  // ③ resume 단계 1 이 `Status: consumed` 를 비진행으로 처리한다(승격 금지 + status 안내).
  assert.match(resume, /Status: consumed[\s\S]{0,400}\/deep-loop-status/,
    'resume step 1 must treat `Status: consumed` as non-proceeding and point at /deep-loop-status');
  // ④ F5-2 remedy 고정(라운드 6 F6-2): durable 하게 attempt_id 를 보유한 세션은 정지가 아니라
  // 같은 값으로 **정확히 한 번** 재시도하고 `proceed` 로 판단한다. 이것이 없으면 wrapper 재주입
  // 세션이 M1 에서 진행 권한을 재발급받을 재호출을 끝내 하지 않는다 — 커널이 닫은 구멍이 산문 층에서
  // 다시 열린다. 삭제·부분 삭제·반전이 전부 전수 GREEN 이었으므로 여기서 고정한다.
  assert.match(resume.replace(/\s+/g, ' '),
    /보유[^.]{0,80}attempt_id[\s\S]{0,300}정확히 한 번[\s\S]{0,200}proceed/,
    'resume step 1 must keep the same-attempt retry exception (hold an attempt id → retry exactly once → decide on proceed)');
  // ⑤ 오용 복구 — 위임 전 사전 acquire 위반 시 fenced preserve-pause.
  assert.match(resume, /acquire-misuse[\s\S]{0,200}--mode preserve/,
    'resume must document the fenced preserve-pause misuse recovery');
});

test('worktree-aware skills: action-keyed entry in continue; resume defers; handoff no entry; verify unchanged', () => {
  const cont = _rf(skillPath('deep-loop-continue'), 'utf8');
  // continue §1.5 must key entry on action.workstream_id (not blind active workstream pick)
  assert.match(cont, /action\.workstream_id/, 'continue §1.5 keys worktree entry by action.workstream_id — not blind active workstream pick');
  assert.ok(mutatingFenced(cont), 'continue fenced');
  const res = _rf(skillPath('deep-loop-resume'), 'utf8');
  assert.match(res, /(무결성|existsSync|경로.*확인|needs-human)/, 'resume verify unchanged');
  // resume §3.5 defers per-action worktree entry to /deep-loop-continue (avoids mis-routing in multi-parallel runs)
  assert.match(res, /단계 3\.5[\s\S]{0,300}위임/, 'resume §3.5 defers worktree entry to /deep-loop-continue (not pre-entering)');
  // handoff §1.5: kernel resolves root via findRoot; no file work → no worktree entry needed
  const hand = _rf(skillPath('deep-loop-handoff'), 'utf8');
  assert.match(hand, /단계 1\.5[\s\S]{0,200}(불필요|findRoot)/, 'handoff §1.5 documents no worktree entry needed (kernel resolves root via findRoot)');
  assert.ok(mutatingFenced(hand), 'handoff fenced');
});

// Codex r3 sf-4: SKILL.md + workflow references 의 *모든* mutating CLI 라인이 fence(--owner+--generation)를 갖는지 전역 검사.
// deep-loop-workflow 는 references 에 review dispatch/record(mutating)를 담으므로 여기서 함께 검증된다.
test('all skills + workflow references fence every mutating CLI line', () => {
  const files = SKILLS.map(([dir]) => skillPath(dir));
  for (const r of ['adapters.md', 'review-strategy.md', 'handoff-respawn.md'])
    files.push(join(ROOT, 'skills', 'deep-loop-workflow', 'references', r));
  for (const f of files) {
    if (!existsSync(f)) continue;
    assert.ok(mutatingFenced(readFileSync(f, 'utf8')), `${f} has an unfenced mutating CLI invocation`);
  }
});

test('continue + handoff boundary fallback is a fenced preserve-pause', () => {
  for (const dir of ['deep-loop-continue', 'deep-loop-handoff']) {
    const src = readFileSync(skillPath(dir), 'utf8');
    assert.ok(src.includes('--mode preserve'),
      `${dir} must document pause --mode preserve for attended boundary handoff`);
    const hasFencedPause = src.split('\n').some(
      l => l.includes('--mode preserve') && l.includes('--owner') && l.includes('--generation')
    );
    assert.ok(hasFencedPause,
      `${dir} pause --mode preserve must carry --owner and --generation on the same line`);
  }
});

// Task 6: worktree-entry ordering constraints
// resume: integrity-verify (단계 3) MUST precede §3.5 deferral section
test('resume: ordering — integrity-verify step must precede §3.5 worktree-deferral section', () => {
  const res = readFileSync(skillPath('deep-loop-resume'), 'utf8');
  // '무결성' appears in §3 heading/body (path integrity check) — stable, won't move to §3.5
  const verifyIdx = res.indexOf('무결성');
  // '단계 3.5' is the section documenting that worktree entry is DEFERRED to /deep-loop-continue
  const deferIdx  = res.indexOf('단계 3.5');
  assert.ok(verifyIdx !== -1,
    'resume: integrity-verify marker (무결성) must exist in SKILL.md');
  assert.ok(deferIdx !== -1,
    'resume: §3.5 deferral section marker (단계 3.5) must exist in SKILL.md');
  assert.ok(verifyIdx < deferIdx,
    'resume: 무결성 verify step must appear BEFORE 단계 3.5 — verify first, then deferral note explains /deep-loop-continue handles per-action worktree entry');
});

// continue: worktree-entry (§1.5) MUST precede maker/checker dispatch (§2)
test('continue: worktree-entry ordering — §1.5 entry must precede §2 dispatch', () => {
  const cont = readFileSync(skillPath('deep-loop-continue'), 'utf8');
  // '1.5' is the section number in the §1.5 heading (Active Worktree 진입)
  const entryIdx    = cont.indexOf('1.5');
  // '## 2.' is the dispatch/action-branch section header
  const dispatchIdx = cont.indexOf('## 2.');
  assert.ok(entryIdx !== -1,
    'continue: worktree-entry section (§1.5) must exist in SKILL.md');
  assert.ok(dispatchIdx !== -1,
    'continue: dispatch section (## 2.) must exist in SKILL.md');
  assert.ok(entryIdx < dispatchIdx,
    'continue: worktree-entry (§1.5) must appear BEFORE dispatch (§2) — file work must run in the correct worktree');
});

// Task 1.6 follow-up: fresh resume must use descriptor-bound root/run/runtime;
// only per-action worktree entry remains delegated to continue.
test('handoff-respawn resume contract uses descriptor root/run/runtime and exact recovery routes', () => {
  const refPath = join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md');
  const src = readFileSync(refPath, 'utf8');
  assert.match(src, /Resume acquisition[\s\S]{0,800}--project-root "<canonical_project_root>"[\s\S]{0,240}--run-id <run_id>/,
    'resume flow must consume the descriptor canonical root and logical run id');
  assert.match(src, /lease acquire[^\n]*--runtime <claude\|codex\|grok>[^\n]*--project-root "<canonical_project_root>"[^\n]*--run-id <run_id>/,
    'resume lease acquisition must assert runtime and explicit root/run identity');
  assert.match(src, /recovery acquire --capsule/);
  assert.match(src, /root recovery acquire --capsule/);
  assert.match(src, /worktree[\s\S]{0,240}\/deep-loop-continue/i,
    'per-action worktree routing must remain delegated to deep-loop-continue');
});

// FIX D retarget: continuation keeps canonical examples and points to the single workflow-core rule.
test('review-report containment binds to the recorded worktree, not a hardcoded preferred prefix', () => {
  const cont = _rf(skillPath('deep-loop-continue'), 'utf8');
  const adapters = _rf(join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'adapters.md'), 'utf8');
  for (const [name, src] of [['continue', cont], ['adapters', adapters]]) {
    assert.match(src, /기록된 worktree|<recorded-worktree>/, `${name} names the recorded worktree for report containment`);
    const rule = src.split('\n').find((l) => /REVIEW_NO_EVIDENCE/.test(l) && /--report/.test(l)) || '';
    assert.ok(rule.length > 0, `${name} has a --report containment rule`);
    assert.match(rule, /기록된 worktree|<recorded-worktree>/, `${name} rule is recorded-worktree, not a preferred-prefix literal`);
  }
});

test('deep-loop-continue: artifact examples stay prefixed with a concise workflow-core pointer', () => {
  const cont = _rf(skillPath('deep-loop-continue'), 'utf8');
  assert.ok(!cont.includes('"path/to/artifact"'), 'bare "path/to/artifact" must be replaced with worktree-prefixed path');
  assert.ok(!cont.includes('"path/to/fix-output"'), 'bare "path/to/fix-output" must be replaced with worktree-prefixed path');
  assert.match(cont, /(?:\.claude\/worktrees|\.worktrees)\/[^\s"]*\/[^\s"]+/, 'artifact examples must use recorded worktree path (.claude/worktrees/<slug>/ or .worktrees/<slug>/) as prefix');
  assert.match(cont, /artifact[^\n]*(deep-loop-workflow|워크플로우)[^\n]*핵심 불변식/i,
    'continue must point to the workflow core instead of restating the detailed rule');
});

test('deep-loop-finish: proposal-only worktree cleanup + reconcile audit surface', () => {
  const s = _rf(skillPath('deep-loop-finish'), 'utf8');
  assert.match(s, /Worktree 사용 현황/, 'report section');
  assert.match(s, /(ExitWorktree|git worktree remove)/, 'native cleanup proposed');
  assert.match(s, /proposal-only|제안|사람 승인|human/i, 'cleanup proposal-only');
  assert.match(s, /(reconcile|audit|미기록|기록에 없는|고아)/, 'reconcile audit surface');
});

// FIX E: await_result must enter the worktree (it carries action.workstream_id)
test('deep-loop-continue §1.5: await_result is in the worktree-entry set (not skipped)', () => {
  const cont = _rf(skillPath('deep-loop-continue'), 'utf8');
  // The gating sentence must key on action.workstream_id PRESENCE, not a hardcoded type list
  // that excludes await_result. Verify await_result is explicitly mentioned as entering.
  assert.ok(
    cont.includes('await_result'),
    'continue §1.5 must mention await_result'
  );
  // await_result must NOT appear in the skip/건너뛴다 sentence
  const skipLine = cont.split('\n').find(l => /건너뛴다|skip/.test(l) && /await_result/.test(l));
  assert.ok(!skipLine, 'await_result must not appear in the skip sentence of §1.5');
  // The gating sentence must key on workstream_id presence (not an explicit list that omits await_result)
  assert.match(cont, /workstream_id[\s\S]{0,300}await_result|await_result[\s\S]{0,300}workstream_id/, 'await_result and workstream_id must be co-located in §1.5 gating text');
});

// FIX K replacement: final-report uses the kernel-resolved absolute run directory.
test('deep-loop-finish: final-report Write uses path resolve --target run-dir', () => {
  const s = _rf(skillPath('deep-loop-finish'), 'utf8');
  assert.match(s, /path resolve --target run-dir.*--project-root "<canonical_project_root>".*--run-id <run_id>/,
    'must resolve run-dir through the kernel');
  // Must NOT have a bare relative Write to .deep-loop/runs/.../final-report.md (without a project.root anchor).
  const bareWrite = s.split('\n').some(l =>
    /Write\s*\(/.test(l) &&
    /\.deep-loop\/runs\/[^"]*final-report\.md/.test(l) &&
    !/(resolved-run-dir|<run-dir>|\$\{?RUN_DIR\}?)/.test(l)
  );
  assert.ok(!bareWrite, 'must not instruct a bare relative final-report write');
  assert.match(s, /<resolved-run-dir>\/final-report\.md/);
  const resolverLine = s.split('\n').find(line => /deep-loop\.mjs.*path resolve --target run-dir/.test(line)) || '';
  assert.ok(resolverLine, 'resolver command is one physical line');
  assert.doesNotMatch(resolverLine, MUTATING_SUB, 'read-only resolver line must not trip broad mutation vocabulary');
  // deep-wiki delegation args must also be anchored (not bare relative .deep-loop/...)
  const bareWikiArg = s.split('\n').some(l =>
    /wiki-ingest/.test(l) &&
    /args.*\.deep-loop\/runs/.test(l) &&
    !/(resolved-run-dir|<run-dir>|\$\{?RUN_DIR\}?)/.test(l)
  );
  assert.ok(!bareWikiArg, 'deep-wiki delegation must use the resolved run directory');
});

// FIX L retarget: the workflow core is the single detailed owner of artifact correction.
test('workflow core alone explains adapter artifact transformation and kernel correction', () => {
  const workflow = _rf(skillPath('deep-loop-workflow'), 'utf8');
  const core = workflow.match(/## 핵심 불변식([\s\S]*?)(?:\n## |$)/)?.[1] || '';
  assert.match(core, /project-root-relative|project root 기준 상대|프로젝트 루트 기준 상대/i);
  assert.match(core, /maker[\s\S]{0,240}(recorded|기록된)[\s\S]{0,160}worktree[\s\S]{0,120}(prefix|접두)/i);
  assert.match(core, /adapter[\s\S]{0,180}read\.path[\s\S]{0,180}(prefix|접두|변환)/i);
  assert.match(core, /expected[\s\S]{0,160}submitted[\s\S]{0,160}(match|일치)/i);
  assert.match(core, /EPISODE_ARTIFACT_(?:UNSAFE|ESCAPE)[\s\S]{0,180}(교정|correction|expected)/i);

  const entrySection = dlSkill().match(/### 2-7\. 첫 번째 Episode 생성([\s\S]*?)## 단계 3:/)?.[1] || '';
  const continueSection = _rf(skillPath('deep-loop-continue'), 'utf8').match(/## 1\.5\. Action-keyed Worktree 진입([\s\S]*?)## 2\./)?.[1] || '';
  assert.doesNotMatch(entrySection, /adapter[^\n]*read\.path/i, 'entry must not duplicate adapter correction details');
  assert.doesNotMatch(continueSection, /adapter[^\n]*read\.path/i, 'continue must not duplicate adapter correction details');
});

// FIX N: workstream new --worktree must record root-relative path, not $ORIG_ROOT absolute.
// git worktree add uses $ORIG_ROOT absolute (correct — git needs an absolute target); but the
// value RECORDED via workstream new must be root-relative (.worktrees/<slug>) so that
// artifact prefixes are root-relative and pass episode.mjs containment (no absolute/.. paths).
test('deep-loop §2-6: workstream new records root-relative .worktrees/<slug> (not $ORIG_ROOT absolute)', () => {
  const s = dlSkill();
  const joined = s.replace(/\\\n\s*/g, ' ');
  const wsNewLine = joined.split('\n').find((l) => /workstream\s+new/.test(l) && /--worktree/.test(l));
  assert.ok(wsNewLine, 'workstream new --worktree must appear in a joined logical command line');
  assert.ok(
    /--worktree\s+"?\.worktrees\//.test(wsNewLine),
    'workstream new --worktree must record root-relative .worktrees/<slug>',
  );
  assert.ok(
    !/--worktree\s+"?\$\{?ORIG_ROOT\}?\//.test(wsNewLine),
    'workstream new --worktree must NOT use $ORIG_ROOT absolute path for the recorded value',
  );
});

test('deep-loop-continue §1.5: default entry is working-directory/cd; no EnterWorktree create for .worktrees', () => {
  const cont = _rf(skillPath('deep-loop-continue'), 'utf8');
  const section = cont.match(/## 1\.5\. Action-keyed Worktree 진입([\s\S]*?)## 2\./)?.[1] || '';
  assert.ok(section.length > 0, 'continue §1.5 must extract');
  assert.match(section, /working-directory|cd/);
  assert.match(section, /\.worktrees\//);
  assert.match(section, /절대 경로에 attach|새 sibling을 만들지 않/);
  assert.match(section, /EnterWorktree/);
  assert.doesNotMatch(
    section,
    /native attach 도구\(`EnterWorktree` 등\)가 있으면 그것으로 진입/,
    'unconditional native attach is the old text',
  );
  assert.match(section, /EnterWorktree.*생성 수단으로 호출하지 않는다|생성 수단으로 호출하지 않는다/);
});

test('deep-loop-finish audit scans both convention dirs with .worktrees first', () => {
  const s = _rf(skillPath('deep-loop-finish'), 'utf8');
  const audit = s.split('\n').find((l) => /reconcile audit|고아/.test(l) && /\.worktrees/.test(l));
  assert.ok(audit, 'finish audit line names .worktrees');
  assert.ok(audit.indexOf('.worktrees/') !== -1);
  assert.ok(audit.indexOf('.claude/worktrees/') !== -1);
  assert.ok(audit.indexOf('.worktrees/') < audit.indexOf('.claude/worktrees/'));
});

test('deep-loop §2-6 reconcile audit scans both convention dirs', () => {
  const s = dlSkill();
  const audit = s.split('\n').find((l) => /reconcile audit|고아/.test(l) && /\.worktrees/.test(l)) || '';
  assert.ok(audit.length > 0, 'entry skill audit line names .worktrees');
  assert.ok(audit.indexOf('.claude/worktrees/') !== -1);
  assert.ok(audit.indexOf('.worktrees/') < audit.indexOf('.claude/worktrees/'));
});

test('deep-loop §2-6 Step 0 reuse keeps captured convention prefix', () => {
  const s = dlSkill();
  const step0 = s.match(/#### Step 0[\s\S]*?(?=#### Step 1)/)?.[0];
  assert.ok(step0, 'Step 0 section must extract');
  assert.match(step0, /재사용/);
  assert.match(step0, /컨벤션 prefix를 rewrite하지 않는다|prefix를 변환하지 않/);
  assert.doesNotMatch(step0, /\.claude\/worktrees\/<[^>]+>.*\.worktrees\//);
});

test('this repo gitignores .worktrees/', () => {
  const gi = _rf(join(ROOT, '.gitignore'), 'utf8');
  assert.match(gi, /^\.worktrees\/\s*$/m);
});

// FIX O replacement: manual project.root decoding is absent from path sections.
test('deep-loop-finish: final-report section has no manual project.root decoding', () => {
  const s = _rf(skillPath('deep-loop-finish'), 'utf8');
  const section = s.match(/## 단계 1: Final Report 작성([\s\S]*?)## 단계 1\.5:/)?.[1] || '';
  assert.match(section, /path resolve --target run-dir/);
  assert.doesNotMatch(section, /state get --field project\.root|JSON\.parse|tr\s+-d|\bsed\b/);
});

test('deep-loop-continue §1.5: worktree section has no manual project.root decoding', () => {
  const s = _rf(skillPath('deep-loop-continue'), 'utf8');
  const section = s.match(/## 1\.5\. Action-keyed Worktree 진입([\s\S]*?)## 2\./)?.[1] || '';
  assert.match(section, /path resolve --target workstream/);
  assert.doesNotMatch(section, /state get --field project\.root|JSON\.parse|tr\s+-d|\bsed\b/);
  const resolverLine = section.split('\n').find(line => /deep-loop\.mjs.*path resolve --target workstream/.test(line)) || '';
  assert.ok(resolverLine, 'resolver command is one physical line');
  assert.doesNotMatch(resolverLine, MUTATING_SUB, 'read-only resolver line must not trip broad mutation vocabulary');
});

// FIX G retarget: entry keeps one canonical example and a concise pointer, not a full second rule.
test('deep-loop §2-7: artifact example is worktree-prefixed and points to workflow core', () => {
  const s = dlSkill();
  assert.ok(!s.includes('"path/to/expected-output.md"'), 'bare path/to/expected-output.md must be replaced with worktree-prefixed path in episode new example');
  assert.match(s, /--artifacts[\s\S]{0,200}(?:\.claude\/worktrees|\.worktrees)\//, '--artifacts example in episode new must use recorded worktree path (.claude/worktrees/<slug>/ or .worktrees/<slug>/) as prefix');
  const section = s.match(/### 2-7\. 첫 번째 Episode 생성([\s\S]*?)## 단계 3:/)?.[1] || '';
  assert.match(section, /artifact[^\n]*(deep-loop-workflow|워크플로우)[^\n]*핵심 불변식/i,
    'entry must point to the single workflow-core artifact rule');
});

// Task 8: Claude Desktop deeplink respawn — init opt-in offer + handoff/continue desktop branch wiring.
test('desktop skill wiring stays 2-plane (kernel CLI only)', () => {
  for (const dir of ['deep-loop', 'deep-loop-handoff', 'deep-loop-continue']) {
    const s = _rf(skillPath(dir), 'utf8');
    if (/spawn_style==='desktop'|offer-desktop|confirm-desktop/.test(s)) {
      assert.ok(!violatesBoundary(s), `${dir}/SKILL.md must not instruct a direct durable-state write (2-plane)`);
    }
  }
});

test('Task 14 continuity docs never branch on desktop/visible launcher surface state', () => {
  const files = [
    skillPath('deep-loop-continue'),
    skillPath('deep-loop-handoff'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md'),
  ];
  for (const f of files) {
    const s = _rf(f, 'utf8');
    assert.doesNotMatch(s, /spawn_style==='(?:desktop|visible)'|session_spawn\.launcher\s*[!=]=/);
    assert.doesNotMatch(s, /deep-loop\.mjs"\s+respawn[^\n]*--attended/);
  }
});

test('deep-loop entry keeps workstream-session interactive and defers human approval to status', () => {
  const s = dlSkill();
  assert.match(s, /workstream-session/);
  assert.match(s, /spawn_style:'interactive'/);
  assert.match(s, /\/deep-loop-status/);
  assert.doesNotMatch(s, /deep-loop\.mjs"\s+spawn-style\s+(?:offer|confirm|decline|reset)-desktop/);
});

test('continue and resume refresh the active owner session profile (WS1)', () => {
  const paths = [
    '../skills/deep-loop-continue/SKILL.md',
    '../skills/deep-loop-resume/SKILL.md',
  ];
  for (const p of paths) {
    const body = readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.match(body, /session-profile set/, `${p} should reference session-profile set`);
  }
});

test('deep-loop init skill observes + seeds session model/effort into init-run (WS1)', () => {
  const body = readFileSync(new URL('../skills/deep-loop/SKILL.md', import.meta.url), 'utf8');
  assert.match(body, /CLAUDE_EFFORT/, 'init skill observes CLAUDE_EFFORT');
  assert.match(body, /init-run[^\n]*--session-profile\s+'<session_profile_json_compact>'/,
    'init skill threads one compact session profile into init-run');
});

test('runtime-facing skills assert runtime and carry explicit resume root/run identity', () => {
  const entry = readFileSync(new URL('../skills/deep-loop/SKILL.md', import.meta.url), 'utf8');
  assert.match(entry, /init-run[\s\S]{0,500}--runtime\s+<claude\|codex\|grok>/, 'new runs must record the asserted host runtime');

  const resume = readFileSync(new URL('../skills/deep-loop-resume/SKILL.md', import.meta.url), 'utf8');
  assert.match(resume, /\$deep-loop:deep-loop-resume/, 'Codex resume must use the qualified dollar skill token');
  assert.match(resume, /--project-root\s+"<canonical_project_root>"/, 'resume must accept the canonical project root from the descriptor');
  assert.match(resume, /--run-id\s+<run_id>/, 'resume must accept the explicit logical run id from the descriptor');
  // F5-3(라운드 5): 첫 매칭 **물리 줄**을 명령으로 간주하면 코드 블록 위 산문이 명령 이름을
  // 언급하는 순간 혼란스러운 false RED 가 난다(이 저장소의 Phase 5 산문 편집이 실제로 그것을
  // 밟았다). 같은 파일 아래쪽이 이미 쓰는 견고한 관용구 — 커널 명령 줄로 먼저 필터한다.
  const acquire = kernelCommandLines(resume).find((line) => /\blease acquire\b/.test(line)) || '';
  assert.match(acquire, /--runtime\s+<claude\|codex\|grok>/, 'lease acquisition must assert the actual host runtime');
  assert.match(acquire, /--project-root\s+"<canonical_project_root>"/);
  assert.match(acquire, /--run-id\s+<run_id>/);
});

test('resume skill retries a retryable lock-busy acquire only with its persisted attempt id', () => {
  const resume = readFileSync(new URL('../skills/deep-loop-resume/SKILL.md', import.meta.url), 'utf8');
  assert.match(resume, /reason:"lock-busy"[\s\S]{0,180}retryable:true[\s\S]{0,260}같은[\s\S]{0,80}<attempt_id>/);
  assert.match(resume, /제한된 재시도[\s\S]{0,200}사람에게[\s\S]{0,80}멈춘다/);
  assert.match(resume, /`retryable:true` 없는 다른 `proceed:false` 응답은 재시도하지 않는다/);
});

test('handoff execution docs preserve runtime-correct resume tokens and current Codex transport boundaries', () => {
  const paths = [
    '../skills/deep-loop-continue/SKILL.md',
    '../skills/deep-loop-handoff/SKILL.md',
    '../skills/deep-loop-workflow/references/handoff-respawn.md',
  ];
  for (const path of paths) {
    const body = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(body, /\/deep-loop-resume/, `${path} must retain the Claude resume token`);
    assert.match(body, /\$deep-loop:deep-loop-resume/, `${path} must document the Codex resume token`);
    assert.match(body, /codex-transport-not-activated/, `${path} must retain the fail-closed reason for unsupported Codex paths`);
    assert.match(body, /native\s+Windows|네이티브\s+Windows/i,
      `${path} must distinguish the activated native-Windows Codex path`);
    assert.match(body, /macOS\/Linux[\s\S]{0,360}cmux/i,
      `${path} must document approved Codex visible cmux continuation on POSIX`);
    assert.match(body, /macOS[\s\S]{0,360}(?:iTerm2|Terminal\.app)/i,
      `${path} must bind Darwin Codex continuation to the detected Apple terminal`);
    assert.match(body, /runtime-identity-unavailable/,
      `${path} must name the missing approved-runtime fail-closed reason`);
    assert.match(body, /exact|정확|검증한/i,
      `${path} must use kernel-validated exact continuation guidance`);
    assert.match(body, /Codex App[\s\S]{0,240}(?:manual|수동)/i,
      `${path} must keep Codex App new-task continuation manual`);
    assert.doesNotMatch(body, /visible\/headless\/App 자동 process transport는 아직 활성화하지 않는다/,
      `${path} must not retain the obsolete blanket Slice 1 transport claim`);
  }
});

test('runtime-facing headless docs keep measured continuation host-owned without cross-runtime fallback', () => {
  const shared = readFileSync(
    new URL('../skills/deep-loop-workflow/references/handoff-respawn.md', import.meta.url),
    'utf8',
  );
  assert.match(shared, /## Unattended continuation/);
  assert.match(shared, /drive-headless/);
  assert.match(shared, /Claude measured[\s\S]{0,240}Codex incremental JSONL/);
  assert.match(shared, /cross-runtime fallback[\s\S]{0,80}(?:없|금지|하지)/i);
  assert.doesNotMatch(shared, /deep-loop\.mjs"\s+respawn/);
});

test('runtime-neutral adapter reference routes exact skill/agent/blocked descriptors and capability flag', () => {
  const body = readFileSync(new URL('../skills/deep-loop-workflow/references/adapters.md', import.meta.url), 'utf8');
  assert.match(body, /dispatch\.kind = "skill"/, 'maker descriptor example must use production kind=skill');
  assert.match(body, /dispatch\.kind === 'skill'/, 'maker branch must route production kind=skill');
  assert.doesNotMatch(body, /invoke_skill/, 'stale invoke_skill must not remain active in the reference');
  assert.match(body, /Claude[\s\S]{0,240}Skill\(/);
  assert.match(body, /Codex[\s\S]{0,240}\$<descriptor\.skill>/);
  assert.match(body, /checker\.kind === 'skill'[\s\S]{0,260}(?:independent|독립)/,
    'skill checker must run in an independent session');
  assert.match(body, /checker\.kind === 'agent'[\s\S]{0,260}(?:fresh|새)[\s\S]{0,160}code-reviewer/,
    'agent checker must spawn a fresh code-reviewer subagent');
  assert.match(body, /checker\.kind === 'blocked'[\s\S]{0,260}needs-human[\s\S]{0,180}(?:proof|증명)/,
    'blocked checker must route needs-human without proof');
  assert.match(body, /--independent-subagent[\s\S]{0,260}(?:실제로 있을 때만|only when)/,
    'independent-subagent assertion must be capability-gated');
  assert.match(body, /(?:없으면|without)[^\n]{0,180}(?:전달하지|omit)/,
    'reference must omit the flag when cooperative capability is absent');
});

test('checker routing contract is explicit, mutually exclusive, and closes every independent execution path', () => {
  const adapters = readFileSync(new URL('../skills/deep-loop-workflow/references/adapters.md', import.meta.url), 'utf8');
  const cont = readFileSync(new URL('../skills/deep-loop-continue/SKILL.md', import.meta.url), 'utf8');

  assert.match(adapters, /상호 배타|mutually exclusive/i, 'checker routes must be mutually exclusive');

  const cooperative = adapters.match(/### Route A[\s\S]*?(?=\n### Route B)/)?.[0] || '';
  assert.match(cooperative, /cooperative[\s\S]{0,240}(?:실제로 사용 가능|actually available)/i);
  assert.match(cooperative, /--independent-subagent/);
  assert.match(cooperative, /fresh `?code-reviewer`?[\s\S]{0,240}(?:host tool|호스트 도구)/i);
  assert.ok(cooperative.indexOf('실제로 사용 가능') < cooperative.indexOf('review dispatch'),
    'cooperative capability must be asserted before review dispatch');

  const unattended = adapters.match(/### Route B[\s\S]*?(?=\n### Route C)/)?.[0] || '';
  assert.match(unattended, /Codex[\s\S]{0,160}unattended[\s\S]{0,300}host-owned/i);
  assert.match(unattended, /isolated[\s\S]{0,120}read-only[\s\S]{0,180}(?:second|두 번째) `?codex exec`?/i);
  assert.match(unattended, /claim[\s\S]{0,240}import[\s\S]{0,240}accounting/i);
  assert.match(unattended, /execution skill[\s\S]{0,180}review record[\s\S]{0,120}(?:않|never)/i,
    'host-owned checker path must not be recorded by the execution skill');

  const interactive = adapters.match(/### Route C[\s\S]*?(?=\n### Route E)/)?.[0] || '';
  assert.match(interactive, /interactive[\s\S]{0,260}(?:distinct|별도)[\s\S]{0,160}(?:fresh session|fresh task|새 세션|새 task)/i);
  assert.match(interactive, /reviewed worktree|리뷰 대상 worktree/i);
  assert.match(interactive, /Claude[\s\S]{0,180}Skill\([\s\S]{0,300}Codex[\s\S]{0,180}\$<checker\.skill>/i);
  assert.match(interactive, /Codex[\s\S]{0,260}(?:manual|수동)[\s\S]{0,220}(?:task|세션)/i);
  assert.match(interactive, /contained report|containment[\s\S]{0,160}report|포함[\s\S]{0,160}리포트/i);
  assert.match(interactive, /original execution session|원래 execution session/i);
  assert.match(interactive, /same-task|같은 task[\s\S]{0,200}\$<checker\.skill>[\s\S]{0,180}(?:proof|증명)[\s\S]{0,80}(?:금지|아님)/i);

  const bridged = adapters.match(/### Route E[\s\S]*?(?=\n### Route D)/)?.[0] || '';
  assert.match(bridged, /bridge-probe/);
  assert.ok(bridged.indexOf('bridge-probe') < bridged.indexOf('review dispatch'),
    'Route E must probe before review dispatch');
  assert.match(bridged, /verified|separate.process|separate-process/i);
  assert.match(bridged, /자식[\s\S]{0,80}(?:checker|report)|stdout/);
  assert.match(bridged, /spawn_subagent/);
  assert.match(bridged, /needs-human|live 실패/);
  assert.match(bridged, /kind:\s*'agent'[\s\S]{0,160}(?:무시|ignore)/i);

  const bridgeRef = readFileSync(new URL('../skills/deep-loop-workflow/references/checker-bridge.md', import.meta.url), 'utf8');
  assert.match(bridgeRef, /--dispatcher/);
  assert.match(bridgeRef, /--mechanism/);
  assert.match(bridgeRef, /bridge-finalize[\s\S]{0,220}--receipt/);
  assert.match(bridgeRef, /kind:\s*'agent'[\s\S]{0,200}(?:ignore|무시|do not spawn)/i);
  assert.match(bridgeRef, /LLM-evaluated/);
  assert.match(bridgeRef, /exactly one line[\s\S]{0,80}verdict:/);
  assert.match(bridgeRef, /ready_directions/);
  assert.match(bridgeRef, /to_openai/);
  assert.match(bridgeRef, /REVIEW_CONTRACT_UNENFORCEABLE/);

  const blocked = adapters.match(/### Route D[\s\S]*?(?=\n### Verdict 기록)/)?.[0] || '';
  assert.match(blocked, /needs-human/);
  assert.match(blocked, /review dispatch[\s\S]{0,160}(?:하지|금지|never)/i);
  assert.match(blocked, /review record[\s\S]{0,160}(?:하지|금지|never)/i);
  assert.match(blocked, /fabricat|날조|proof[\s\S]{0,80}(?:만들지|금지)/i);
  assert.match(blocked, /checker\.kind === 'agent'[\s\S]{0,260}cooperative[\s\S]{0,220}(?:before|이전|전에)[\s\S]{0,180}review dispatch/i);

  const branch = cont.indexOf('상호 배타 checker routing');
  const record = cont.indexOf('review record', branch);
  assert.ok(branch !== -1 && record > branch,
    'continue must defer to the checker routing contract before review record');
  assert.match(cont, /grok[\s\S]{0,400}(?:bridge-probe|Route E)/);
  assert.match(cont, /(?:전제|ready:false|실패)[\s\S]{0,300}Route D/);
  assert.doesNotMatch(cont, /grok이면 Route D만 사용한다/);
});

test('review strategy separates durable reviewer enums from host invocation skill ids', () => {
  const strategy = readFileSync(new URL('../skills/deep-loop-workflow/references/review-strategy.md', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../skills/deep-loop/SKILL.md', import.meta.url), 'utf8');

  for (const [name, body] of [['review strategy', strategy], ['entry skill', entry]]) {
    assert.match(body, /deep-review[\s\S]{0,500}durable[\s\S]{0,260}"reviewer"\s*:\s*"deep-review-loop"/i,
      `${name}: deep-review selection must store the accepted durable enum`);
    assert.match(body, /subagent[\s\S]{0,500}durable[\s\S]{0,260}"reviewer"\s*:\s*"subagent-checker"/i,
      `${name}: cooperative subagent selection must store subagent-checker`);
    assert.match(body, /descriptor[\s\S]{0,300}deep-review:deep-review-loop/i,
      `${name}: only the returned descriptor uses the qualified invocation id`);
    assert.doesNotMatch(body, /"reviewer"\s*:\s*"deep-review:deep-review-loop"/,
      `${name}: qualified invocation id must never enter durable review JSON`);
  }
});

test('init review JSON is one exact cross-POSIX/PowerShell single-quoted argv argument', () => {
  const entry = readFileSync(new URL('../skills/deep-loop/SKILL.md', import.meta.url), 'utf8');
  const initCommands = kernelCommandLines(entry).filter((line) => /\binit-run\b/.test(line));
  assert.equal(initCommands.length, 1, 'entry exposes exactly one canonical init-run template');
  for (const line of initCommands) {
    assert.match(line, /--review\s+'<review_json_compact>'(?:\s|$)/,
      `init-run review JSON must be one single-quoted argv argument: ${line}`);
    assert.doesNotMatch(line, /--review\s+"<review_json_compact>"/);
    assert.match(line, /--session-profile\s+'<session_profile_json_compact>'(?:\s|$)/,
      `init-run session profile JSON must be one single-quoted argv argument: ${line}`);
  }
  assert.match(entry, /<review_json_compact>[\s\S]{0,360}(?:compact JSON|압축 JSON)[\s\S]{0,240}(?:JSON double quotes|JSON 이중 따옴표)/i,
    'placeholder substitution must preserve JSON double quotes inside the single-quoted argument');
  assert.match(entry, /<session_profile_json_compact>[\s\S]{0,360}(?:compact JSON|압축 JSON)[\s\S]{0,240}(?:JSON double quotes|JSON 이중 따옴표)/i,
    'session profile placeholder must preserve JSON double quotes inside the single-quoted argument');
});

test('continue exposes exactly one canonical session-profile JSON template', () => {
  const body = readFileSync(new URL('../skills/deep-loop-continue/SKILL.md', import.meta.url), 'utf8');
  const commands = kernelCommandLines(body).filter(line => /\bsession-profile set\b/.test(line));
  assert.equal(commands.length, 1, 'continue exposes exactly one session-profile set template');
  assert.match(commands[0], /--session-profile\s+'<session_profile_json_compact>'(?:\s|$)/);
  assert.doesNotMatch(commands[0], /--model\b|--effort\b/);
});

test('portable command contract: free-form reason placeholders remain one argv value', () => {
  for (const file of EXECUTION_DOCS) {
    for (const line of kernelCommandLines(readFileSync(file, 'utf8')).filter((candidate) => /--reason\b/.test(candidate))) {
      if (/--reason\s+"host-session-lost"(?:\s|$)/.test(line)) continue;
      // spec §3.4 가 정한 고정 리터럴 reason — placeholder 가 없고 공백도 없어 본래 argv 하나이므로
      // 이 규칙(자유 서식 placeholder 를 한 값으로 유지)의 대상이 아니다. acquire-misuse 가 그 부류다.
      if (/--reason\s+"(?:workstream-terminal|needs-human:workstream-terminal|per_session_turn_cap|acquire-misuse)"(?:\s|$)/.test(line)) continue;
      assert.match(line, /--reason\s+"[^"]*<[^>]+>[^"]*"(?:\s|$)/,
        `${file}: free-form reason placeholder must be double-quoted: ${line}`);
    }
  }
});

test('lease-fenced argv keeps the immutable logical run id separate from the current lease owner', () => {
  for (const file of EXECUTION_DOCS) {
    const body = readFileSync(file, 'utf8');
    assert.doesNotMatch(body, /--owner\s+<run_id>/,
      `${file}: logical run id must never be used as the lease owner`);

    for (const line of kernelCommandLines(body).filter((candidate) => /--owner\b/.test(candidate))) {
      assert.match(line, /--run-id\s+<run_id>/,
        `${file}: every fenced command must retain the immutable logical run id: ${line}`);
      if (/\blease acquire\b/.test(line)) {
        assert.match(line, /--owner\s+<child_run_id>/,
          `${file}: lease acquire alone uses the reserved child owner: ${line}`);
        assert.match(line, /--generation\s+<current_generation>/,
          `${file}: lease acquire CASes the freshly read current generation: ${line}`);
        assert.doesNotMatch(line, /--generation\s+<new_generation>/,
          `${file}: the next generation is returned by the kernel, not supplied by the skill: ${line}`);
      } else {
        assert.match(line, /--owner\s+<owner_run_id>/,
          `${file}: non-acquire commands use the freshly read lease owner: ${line}`);
        assert.match(line, /--generation\s+<(?:generation|n)>/,
          `${file}: non-acquire commands use the current lease generation placeholder: ${line}`);
      }
    }
  }
});

test('entry, resume, and continue preserve logical identity across lease ownership transitions', () => {
  const entry = readFileSync(skillPath('deep-loop'), 'utf8');
  assert.match(entry, /<run_id>[\s\S]{0,240}(?:logical|논리)[\s\S]{0,160}(?:immutable|불변)/i,
    'entry must define run_id as the immutable logical loop id');
  assert.match(entry, /<owner_run_id>\s*=\s*<run_id>[\s\S]{0,120}<generation>\s*=\s*1/,
    'after init the initial owner equals, but remains distinct from, the logical run id');

  const resume = readFileSync(skillPath('deep-loop-resume'), 'utf8');
  const acquire = kernelCommandLines(resume).find((line) => /\blease acquire\b/.test(line)) || '';
  assert.match(acquire, /--owner\s+<child_run_id>[\s\S]*--run-id\s+<run_id>/,
    'lease acquire must bind the reserved child to the immutable logical run');
  assert.match(resume, /<owner_run_id>\s*=\s*<child_run_id>[\s\S]{0,160}<generation>\s*=\s*<new_generation>/,
    'successful acquire must promote the child and returned generation to current fence variables');
  const postAcquire = resume.slice(resume.indexOf('## 단계 2.5'));
  for (const line of kernelCommandLines(postAcquire).filter((candidate) => /--owner\b/.test(candidate))) {
    assert.match(line, /--owner\s+<owner_run_id>/,
      `post-acquire resume command must use current owner_run_id: ${line}`);
    assert.match(line, /--run-id\s+<run_id>/,
      `post-acquire resume command must preserve logical run_id: ${line}`);
  }

  const cont = readFileSync(skillPath('deep-loop-continue'), 'utf8');
  assert.match(cont, /<run_id>[\s\S]{0,240}(?:logical|논리)[\s\S]{0,160}(?:immutable|불변)/i,
    'continue must preserve the descriptor/current-run logical id');
  assert.match(cont, /<owner_run_id>\s*=\s*(?:`)?lease\.owner_run_id(?:`)?[\s\S]{0,160}<generation>\s*=\s*(?:`)?lease\.generation(?:`)?/,
    'continue must bind fence variables from the freshly read lease');
  assert.doesNotMatch(cont, /(?:<run_id>|(?<!owner_)run_id)(?:`)?\s*=\s*(?:`)?lease\.owner_run_id(?:`)?/,
    'continue must never rebind the logical run id to the session owner');
});

test('mutation entry skills and shared references source fresh fence identity without conflating state keys', () => {
  const freshLeaseSkills = [
    'deep-loop-ack',
    'deep-loop-continue',
    'deep-loop-discover',
    'deep-loop-finish',
    'deep-loop-handoff',
    'deep-loop-status',
    'deep-loop-triage',
  ];
  for (const dir of freshLeaseSkills) {
    const body = readFileSync(skillPath(dir), 'utf8');
    const leaseRead = body.indexOf('state get --field session_chain.lease');
    const firstFencedCommand = kernelCommandLines(body).findIndex((line) => /--owner\b/.test(line));
    const firstFencedOffset = firstFencedCommand === -1
      ? -1
      : body.indexOf(kernelCommandLines(body)[firstFencedCommand]);
    assert.ok(leaseRead !== -1 && firstFencedOffset !== -1 && leaseRead < firstFencedOffset,
      `${dir}: read session_chain.lease before the first fenced mutation`);
    assert.match(body, /<owner_run_id>[\s\S]{0,240}session_chain\.lease\.owner_run_id/,
      `${dir}: owner_run_id must come from the fresh lease state`);
    assert.match(body, /<generation>[\s\S]{0,240}session_chain\.lease\.generation/,
      `${dir}: generation must come from the fresh lease state`);
  }

  const sharedDocs = [
    skillPath('deep-loop-workflow'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'adapters.md'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'hill-climbing.md'),
  ];
  for (const file of sharedDocs) {
    const body = readFileSync(file, 'utf8');
    assert.match(body, /<run_id>[\s\S]{0,240}(?:logical|논리)[\s\S]{0,160}(?:immutable|불변)/i,
      `${file}: shared contract must name immutable logical run identity`);
    assert.match(body, /<owner_run_id>[\s\S]{0,240}session_chain\.lease\.owner_run_id/,
      `${file}: shared contract must source the current owner from lease state`);
    assert.match(body, /<generation>[\s\S]{0,240}session_chain\.lease\.generation/,
      `${file}: shared contract must source the current generation from lease state`);
  }
});

test('deep-loop-compact exposes only explicit prepare and restore modes with public fenced checkpoint routes', () => {
  const body = readFileSync(skillPath('deep-loop-compact'), 'utf8');
  assert.match(body, /\/deep-loop-compact prepare\|restore/);
  assert.match(body, /\$deep-loop:deep-loop-compact prepare\|restore/);
  assert.match(body, /trusted (?:PreCompact|host context)[\s\S]{0,240}prepare/i);
  assert.match(body, /trusted (?:SessionStart|host context)[\s\S]{0,240}restore/i);
  assert.match(body, /checkpoint presence[\s\S]{0,160}(?:never|must not)[\s\S]{0,120}(?:phase|mode)/i);
  assert.match(body, /missing[\s\S]{0,120}unknown[\s\S]{0,160}reject/i);

  const prepare = body.match(/## Prepare([\s\S]*?)## Restore/i)?.[1] ?? '';
  assert.match(prepare, /state get --field session_chain\.lease/);
  assert.match(prepare, /state get --field session_chain\.sessions/);
  assert.match(prepare, /checkpoint emit[^\n]*--owner <owner_run_id>[^\n]*--generation <generation>[^\n]*--runtime <claude\|codex\|grok>/);
  assert.match(prepare, /Claude[\s\S]{0,160}\/compact <focus>/);
  assert.match(prepare, /Codex[\s\S]{0,160}`\/compact`/);
  assert.doesNotMatch(prepare, /Codex:[^\n]*\/compact <focus>/);
  assert.match(prepare, /(?:print|출력)[\s\S]{0,160}(?:never execute|실행하지)/i);

  const restore = body.match(/## Restore([\s\S]*)/i)?.[1] ?? '';
  const trustedStart = restore.indexOf('If trusted host context');
  const inspectStart = restore.indexOf('checkpoint inspect --json');
  assert.ok(trustedStart >= 0 && trustedStart < inspectStart,
    'trusted evidence rejection must branch before checkpoint inspection');
  assert.match(restore, /checkpoint inspect --json/);
  assert.match(restore, /checkpoint restore[^\n]*--checkpoint <checkpoint_rel>[^\n]*--owner <owner_run_id>[^\n]*--generation <generation>[^\n]*--runtime <claude\|codex\|grok>[^\n]*--admission postcompact-observation[^\n]*--source sessionstart[^\n]*--json/);
  assert.match(restore, /checkpoint restore[^\n]*--checkpoint <checkpoint_rel>[^\n]*--owner <owner_run_id>[^\n]*--generation <generation>[^\n]*--runtime <claude\|codex\|grok>[^\n]*--admission human-attested[^\n]*--source direct-human-skill[^\n]*--confirm-manual-compact[^\n]*--json/);
  assert.match(restore, /\/deep-loop-continue/);
  assert.match(restore, /\$deep-loop:deep-loop-continue/);
  assert.match(restore, /same (?:owner )?session|동일 owner 세션/i);
  const trustedBranch = restore.slice(trustedStart, inspectStart);
  assert.match(trustedBranch, /provider-evidence-mismatch[\s\S]{0,300}do not retry without trusted evidence/i);
  assert.doesNotMatch(trustedBranch, /checkpoint inspect --json/);
  assert.match(trustedBranch, /state get --field session_chain\.lease/);
  assert.match(trustedBranch, /state get --field session_chain\.sessions/);
  assert.match(trustedBranch, /(?:execute|invoke)[\s\S]{0,180}public fenced preserve-pause/i);
  assert.match(trustedBranch, /pause[^\n]*--owner <owner_run_id>[^\n]*--generation <generation>[^\n]*--mode preserve[^\n]*--reason "host-session-lost"/);
  assert.match(trustedBranch, /fence (?:failure|rejection)[\s\S]{0,240}host resume/i);
  assert.match(restore, /host resume/i);
  const fallback = restore.match(/For a stale, corrupt, foreign, or missing checkpoint([\s\S]*)/i)?.[1] ?? '';
  assert.match(fallback, /fresh[\s\S]{0,300}same owner[\s\S]{0,300}open bound Workstream affinity/i);
  assert.match(fallback, /otherwise[\s\S]{0,240}(?:execute|invoke)[\s\S]{0,180}public fenced preserve-pause/i);
  assert.match(fallback, /pause[^\n]*--owner <owner_run_id>[^\n]*--generation <generation>[^\n]*--mode preserve[^\n]*--reason "host-session-lost"/);
  assert.match(fallback, /fence (?:failure|rejection)[\s\S]{0,240}host resume/i);
  assert.match(fallback, /do not retry/i);
  assert.doesNotMatch(body, /\/deep-loop-resume/);
  assert.doesNotMatch(body, /deep-loop\.mjs"\s+lease acquire/);
  assert.doesNotMatch(body, /deep-loop\.mjs"\s+handoff emit/);
  assert.doesNotMatch(body, /deep-loop\.mjs"\s+respawn/);
  assert.doesNotMatch(body, /deep-loop\.mjs"\s+(?:finish|workstream terminal)/);
});

test('compact restore directly dispatches exactly one qualified continue tick after reason-keyed admission', () => {
  const body = readFileSync(skillPath('deep-loop-compact'), 'utf8');
  const restore = body.match(/## Restore([\s\S]*)/i)?.[1] ?? '';
  const rejection = restore.indexOf('deep-loop-compact-preserve-pause-only');
  const inspect = restore.indexOf('deep-loop.mjs" checkpoint inspect --json');
  const prepared = restore.indexOf('trusted SessionStart `prepared` capsule');
  const observation = restore.indexOf('--admission postcompact-observation');
  const manual = restore.indexOf('--admission human-attested');
  const direct = restore.indexOf('Direct dispatch boundary');
  const fallback = restore.indexOf('### Fresh-affinity fallback');

  assert.ok(rejection >= 0 && rejection < inspect,
    'trusted rejection marker must route before evidence-free inspect');
  assert.ok(inspect >= 0 && inspect < observation && observation < manual && manual < direct,
    'inspect and mutually exclusive admissions must precede the direct dispatch boundary');
  assert.ok(prepared >= 0 && prepared < inspect && inspect < fallback,
    'trusted prepared SessionStart capsules must branch before checkpoint inspection and restore');
  const preparedBranch = restore.slice(prepared, inspect);
  assert.match(preparedBranch, /route[\s\S]{0,180}Fresh-affinity fallback/i);
  assert.match(preparedBranch, /(?:must not|never)[\s\S]{0,180}checkpoint restore/i,
    'prepared SessionStart has no PostCompact authority and must not call restore');
  assert.match(preparedBranch, /(?:must not|never)[\s\S]{0,180}(?:restored capsule|provider evidence)/i,
    'prepared SessionStart must not fabricate restored provenance');
  assert.match(preparedBranch, /prepared-fallback/i,
    'prepared SessionStart must carry an invocation-local one-tick readvice suppression marker');
  assert.match(restore, /Direct dispatch boundary[\s\S]{0,4000}exactly once[\s\S]{0,500}\$deep-loop:deep-loop-continue/i);
  assert.match(restore, /same model turn/i);
  assert.doesNotMatch(restore, /On success, continue[\s\S]{0,120}(?:invokes|print)/i,
    'a print-only or deferred continuation is not a dispatch');
  assert.doesNotMatch(restore.slice(0, direct), /next-action --json/,
    'restore must not pre-read routing before direct continue dispatch');
  assert.match(restore, /Automatic SessionStart[\s\S]{0,300}must never[\s\S]{0,180}human-attested/i);
  assert.match(restore, /direct-human[\s\S]{0,600}checkpoint inspect[\s\S]{0,600}phase[^\n]*restored/i,
    'direct-human success must derive its restored capsule from a fresh public inspection');
  assert.match(restore, /injected_by[^\n]*direct-human-skill/i,
    'direct-human success must carry explicit non-SessionStart provenance');
  assert.match(restore, /direct-human[\s\S]{0,900}never fabricate `injected_by:"sessionstart"`/i,
    'direct-human success must explicitly forbid fabricated SessionStart provenance');
  assert.match(restore,
    /four and only four top-level keys[\s\S]{0,500}"marker"[\s\S]{0,120}"version"[\s\S]{0,120}"injected_by"[\s\S]{0,120}"capsule"/i,
    'restore must spell the canonical wrapper shape before dispatch');
  assert.match(restore,
    /complete serialized wrapper[\s\S]{0,360}(?:never|must not)[\s\S]{0,240}(?:fresh public descriptor|inner `capsule`)/i,
    'restore must forbid dispatching the flat inspect descriptor or inner capsule');
  assert.match(restore,
    /nested `capsule`[\s\S]{0,1200}`kind`[\s\S]{0,120}`deep-loop-compact-capsule`[\s\S]{0,240}`run_id`[\s\S]{0,120}`<run_id>`[\s\S]{0,800}`restore_command`[\s\S]{0,180}`next_command`/i,
    'restore must spell the literal and renamed fields instead of copying the inspect descriptor');
  assert.match(restore,
    /(?:must not|never)[^\n]*(?:copy|spread)[^\n]*(?:checkpoint_rel|cycle)/i,
    'restore must explicitly exclude inspect-only fields from the nested capsule');
  assert.match(restore,
    /Skill\(\{\s*skill:\s*"deep-loop:deep-loop-continue",\s*args:\s*"<canonical_restored_wire_json>"\s*\}\)/,
    'Claude dispatch must pass the complete canonical wire as Skill args');

  const fallbackBody = restore.slice(fallback);
  for (const field of [
    'session_chain.lease',
    'session_chain.sessions',
    'workstreams',
    'current_episode',
  ]) assert.match(fallbackBody, new RegExp(`state get --field ${field.replace('.', '\\.')}`));
  assert.match(fallbackBody, /open, non-terminal bound Workstream/i);
  assert.match(fallbackBody, /capsule-free[\s\S]{0,240}exactly once/i);
  assert.match(fallbackBody, /otherwise[\s\S]{0,240}(?:execute|invoke)[\s\S]{0,180}public fenced preserve-pause/i,
    'failed prepared affinity proof must preserve-pause');

  const continueBody = readFileSync(skillPath('deep-loop-continue'), 'utf8');
  const invocation = continueBody.slice(
    continueBody.indexOf('## Invocation mode'),
    continueBody.indexOf('## 개요'),
  );
  assert.match(invocation,
    /exactly three mutually exclusive forms[\s\S]{0,500}no\s+arguments[\s\S]{0,300}`prepared-fallback`[\s\S]{0,400}canonical\s+restored wrapper JSON string/i,
    'invocation mode must admit all three mutually exclusive continue inputs');
  assert.match(invocation,
    /canonical\s+restored wrapper[\s\S]{0,360}Stage A[\s\S]{0,300}(?:before|prior to)[\s\S]{0,220}(?:reject|rejection)/i,
    'the wrapper must route to Stage A before generic argument rejection');
  assert.match(continueBody, /prepared-fallback[\s\S]{0,1000}advice[\s\S]{0,160}compact/i,
    'continue must recognize the exact prepared fallback marker and its compact advice');
  assert.match(continueBody, /prepared-fallback[\s\S]{0,1600}(?:ignore|suppress|consume)[\s\S]{0,240}(?:one tick|exactly once)/i,
    'prepared fallback must consume compact readvice for exactly one useful tick');
  assert.match(continueBody, /prepared-fallback[\s\S]{0,1800}(?:underlying|original)[\s\S]{0,240}action\.type/i,
    'prepared fallback must still execute the kernel-returned underlying action');
});

test('continue validates SessionStart and direct-human restored capsules against provenance, cursor, and event head before mutation', () => {
  const body = readFileSync(skillPath('deep-loop-continue'), 'utf8');
  const capsuleGate = body.indexOf('## 0.25. Restored compact capsule gate');
  const profile = body.indexOf('## 0.5.');
  assert.ok(capsuleGate >= 0 && capsuleGate < profile,
    'restored capsule gate must precede session-profile mutation');
  const gate = body.slice(capsuleGate, profile);

  assert.match(gate, /2048 UTF-8 bytes/);
  assert.match(gate, /JSON\.parse/);
  assert.match(gate, /exact (?:top-level )?key/i);
  assert.match(gate, /deep-loop-compact-capsule-v1/);
  assert.match(gate, /canonical restored wire JSON[\s\S]{0,240}single string argument/i,
    'continue must explicitly admit the canonical wrapper as its one dispatch argument');
  assert.match(gate, /phase[^\n]*restored/);
  assert.match(gate, /injected_by[\s\S]{0,240}sessionstart[\s\S]{0,240}direct-human-skill/i);
  assert.match(gate, /direct-human-skill[\s\S]{0,400}human-attested[\s\S]{0,240}direct-human-skill/i,
    'direct-human wire provenance must be coupled to manual admission');
  for (const field of [
    'session_chain.lease',
    'session_chain.sessions',
    'event_log_head',
    'workstreams',
    'current_episode',
    'compact_cursor',
    'checkpoint_key',
    'context_sha256',
    'pre_restore_loop_hash',
    'provider_evidence',
    'admission',
    'restore_event',
  ]) assert.match(gate, new RegExp(field.replace('.', '\\.')));
  assert.match(gate, /restore_event[\s\S]{0,180}event_log_head/);
  assert.match(gate, /\/deep-loop-status[\s\S]{0,180}stop/i);
  assert.doesNotMatch(gate, /next_action/,
    'the restored capsule is immutable identity, not captured routing advice');
});

test('status skill reads the gate decision and durable counters from their real sources', () => {
  const md = readFileSync(skillPath('deep-loop-status'), 'utf8');
  assert.match(md, /comprehension status/);
  assert.match(md, /state get --field comprehension/);
  assert.match(md, /`debt_ratio`, `blocked`/);
  assert.match(md, /`episodes_total`, `episodes_human_reviewed`, `episodes_agent_reviewed`/);
});
test('status skill gates ack targets on live blocked debt and settled unreviewed makers', () => {
  const md = readFileSync(skillPath('deep-loop-status'), 'utf8');
  const selection = md.match(/### 6\. 미검토 Episode([\s\S]*?)### 7\./)?.[1] ?? '';
  assert.match(selection, /`blocked === true`일 때만/);
  assert.match(selection, /아래 조건을 모두 만족/);
  assert.match(selection, /`role === 'maker'`/);
  assert.match(selection, /`status === 'done'`/);
  assert.match(selection, /`human_reviewed !== true`/);
  assert.match(selection, /durable 카운터[\s\S]*ack 대상 선택이나 이 섹션의 표시 여부에 사용하지 않는다/);
  assert.doesNotMatch(selection, /`episodes_human_reviewed`가 낮으면/);
});
test('continue skill surfaces the debt remedy', () => {
  const md = readFileSync(skillPath('deep-loop-continue'), 'utf8');
  assert.match(md, /blocking_episode_ids/);
});
test('ack skill selects every settled maker whose human review is not true', () => {
  const md = readFileSync(skillPath('deep-loop-ack'), 'utf8');
  const selection = md.split('\n').find(line =>
    line.includes('`status`가 `done`') && line.includes('`human_reviewed`'));
  assert.ok(selection, 'ack guidance must define the settled-maker selector');
  assert.match(selection, /`status`가 `done`인 maker 중/);
  assert.match(selection, /`human_reviewed`가 `true`가 아닌/);
  assert.match(selection, /속성이 없는 경우와 값이 명시적으로 `false`인 경우를 모두 포함/);
  assert.doesNotMatch(md, /`human_reviewed:\s*false`인 episode/,
    'a false-only selector misses normal never-acked makers');
});
test('ack skill resumes fan-out only from the kernel blocked decision, including threshold equality', () => {
  const md = readFileSync(skillPath('deep-loop-ack'), 'utf8');
  const report = md.match(/## 단계 3: 결과 보고([\s\S]*)/)?.[1] ?? '';
  assert.match(report, /comprehension status/);
  assert.match(report, /`blocked === false`일 때만[\s\S]*fan-out을 재개/);
  assert.match(report, /`debt_ratio`와 임계치를 스킬에서 직접 비교해 재개 여부를 판단하지 않는다/);
  assert.doesNotMatch(report, /debt_ratio가 임계치 (?:이하|미만|이상이면|초과하면)[\s\S]*fan-out을 재개/);
});

// Task 9 (spec §8.2): 게이트-크리티컬 마커 — 위치-독립 '존재' 단언, 삭제-회귀만 결정론 방어.
// 마커 선정 기준: budget/breaker/comprehension 검사 지시, fence 플래그(--owner/--generation/--expect-generation),
// human-only confirm(--confirm/--actor human/recover --confirm), proposal-only 선언 등 "게이트 의미"를 담은
// 표현만 채택한다 — 테스트를 통과시키기 위한 임의 토큰은 배제(구현 주의 준수).
// 잡는 것은 **삭제**뿐이다: 마커 문자열이 남아 있으면 그 옆의 지시문이 약화·반전되어도 이 존재-검사는 통과한다.
// 의미 반전 탐지는 hill-climb checker 계약 (e)(적대적 diff 리뷰) + 사람 머지 리뷰의 몫이다 — overclaim 금지.
const GATE_MARKERS = {
  'deep-loop-continue': ['budget', 'breaker', 'comprehension', 'action.boundary_event', '--boundary-event'],
  'deep-loop-handoff': ['handoff emit', '--owner', 'action.boundary_event', 'resume-command'],
  'deep-loop-resume': ['lease acquire', '--generation', 'recovery acquire', 'root recovery acquire'],
  'deep-loop-ack': ['--actor human', '--confirm', 'CONFIRM_REQUIRED', 'ACK_REJECTED'],
  'deep-loop-discover': ['state patch', '--owner', '--generation', 'debt_ratio'],
  'deep-loop-finish': ['proof', '--confirm', 'FINISH_PROOF_UNMET', 'proposal-only'],
  'deep-loop': ['proposal-only', 'AskUserQuestion', 'fail-closed', 'recipe_override_auth', 'suitability', '애매하면 루프', '그래도 deep-loop', 'terminal branch', '기본값 없이 중단'],
};
for (const [dir, markers] of Object.entries(GATE_MARKERS)) {
  test(`gate-critical markers present: ${dir}`, () => {
    const src = readFileSync(skillPath(dir), 'utf8');
    for (const m of markers) assert.ok(src.includes(m), `${dir}/SKILL.md lost gate marker: ${m}`);
  });
}

// ── impl-R3 🟡B: finish의 hill-climb 제안 명령 goal에 candidate id 원문을 넣지 않는다 —
// id의 "fix"/"implement" 등이 다른 recipe 트리거와 substring 충돌해 비결정 라우팅이 된다 ───
test('deep-loop-finish: hill-climb 제안 명령은 candidate id 없는 고정 문구다', () => {
  const src = readFileSync(skillPath('deep-loop-finish'), 'utf8');
  assert.ok(!src.includes('하네스 개선: <'), 'goal 템플릿에 candidate id 자리표시자가 남아 있음');
  assert.ok(src.includes('/deep-loop "하네스 개선"'), '고정 문구 제안 명령이 없음');
});

// ── Phase6 ITEM-3: r3 fix 57b8364가 finish 스킬의 제안 명령을 고정 문구로 바꿨지만 계약 문서
// (hill-climbing.md:128)에 콜론-템플릿 형태가 남아 SSOT 불일치가 있었다 — skills/ 전역에서
// 회귀를 결정론적으로 방어한다(위치 무관, 어느 .md 파일이든 이 패턴이 재도입되면 실패) ───
test('skills/ 전역: hill-climb 제안 명령에 candidate id 콜론-템플릿 형태("하네스 개선: )가 남아있지 않다', () => {
  const files = walkMdFiles(join(ROOT, 'skills'));
  assert.ok(files.length > 0, 'skills/ 하위 .md 파일 탐색 실패(회귀 테스트가 무의미해짐)');
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!src.includes('"하네스 개선:'),
      `${f}: candidate id 콜론-템플릿("하네스 개선:) 잔존 — 고정 문구 /deep-loop "하네스 개선" 로 동기화되어야 함`);
  }
});

test('continue SKILL: compact advice uses native same-conversation preparation', () => {
  const md = readFileSync('skills/deep-loop-continue/SKILL.md', 'utf8');
  assert.ok(md.includes('advice'), 'advice 필드 처리 지시 필요');
  assert.match(md, /deep-loop-compact prepare/);
  assert.match(md, /native `\/compact`/);
  assert.match(md, /same conversation|같은 conversation/i);
});
test('continue SKILL: standalone maker consumes inline descriptors without a null skill dispatch', () => {
  const md = readFileSync('skills/deep-loop-continue/SKILL.md', 'utf8');
  assert.match(md, /dispatch\.kind === 'inline'[\s\S]{0,500}(?:direct|직접)[\s\S]{0,240}(?:tool|도구)/i);
  assert.match(md, /dispatch\.kind === 'skill'[\s\S]{0,500}dispatch\.skill/);
  assert.match(md, /inline[\s\S]{0,500}dispatch\.skill[\s\S]{0,160}(?:null|호출하지|must not)/i);
});
test('continue SKILL: handoff uses exact kernel terminal boundary only', () => {
  const md = readFileSync('skills/deep-loop-continue/SKILL.md', 'utf8');
  assert.match(md, /action\.type === 'handoff'/);
  assert.match(md, /action\.reason === 'workstream-terminal'/);
  assert.match(md, /action\.boundary_event/);
  assert.doesNotMatch(md, /unconsumed_milestones/);
});
test('continue SKILL: in-flight continuity is re-read from next-action', () => {
  const md = readFileSync('skills/deep-loop-continue/SKILL.md', 'utf8');
  const s = md.split('## 0.5.')[1] ?? '';
  assert.match(s.slice(0, 1800), /next-action/);
  assert.doesNotMatch(s.slice(0, 1800), /reserved-finalization/);
});
test('continue SKILL: post-compact comprehension check present', () => {
  const md = readFileSync('skills/deep-loop-continue/SKILL.md', 'utf8');
  assert.ok(md.includes('comprehension') && md.includes('SessionStart(compact)'));
});

// Task 14: execution-plane continuity is selected by the kernel, never by
// skill-side milestone, launcher, or recovery heuristics.
const TASK14_AUTONOMOUS_DOCS = [
  skillPath('deep-loop'),
  skillPath('deep-loop-continue'),
  skillPath('deep-loop-handoff'),
  join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md'),
];

test('Task 14 autonomous skills never issue human-only recovery, relief, or attended-approval commands', () => {
  const forbiddenCommand = /deep-loop\.mjs"\s+(?:recover\b[^\n]*--supersede-affinity|root\s+(?:rebind|recover)\b|budget\s+extend\b|breaker\s+reset\b|attended-launch\s+(?:approve|revoke)\b|spawn-style\s+(?:offer-desktop|confirm-desktop|decline-desktop|reset-desktop)\b)/;
  for (const file of TASK14_AUTONOMOUS_DOCS) {
    const body = readFileSync(file, 'utf8');
    assert.doesNotMatch(body, forbiddenCommand,
      `${file}: autonomous execution must stop and report human-only recovery/approval`);
  }
});

test('Task 14 continue and handoff consume the exact kernel Workstream boundary action', () => {
  for (const dir of ['deep-loop-continue', 'deep-loop-handoff']) {
    const body = readFileSync(skillPath(dir), 'utf8');
    assert.match(body, /next-action --json/, `${dir}: kernel next-action is the router`);
    assert.match(body, /action\.type[\s\S]{0,180}handoff/, `${dir}: handoff is action.type-driven`);
    assert.match(body, /action\.boundary_event/, `${dir}: exact boundary identity comes from the action`);
    assert.doesNotMatch(body, /action\.boundary_event\.(?:seq|checksum)/,
      `${dir}: public next-action renders boundary_event as one seq:checksum string`);
    assert.match(body, /action\.boundary_event[\s\S]{0,220}(?:그대로|unchanged)/,
      `${dir}: rendered boundary_event must be forwarded unchanged`);
    assert.match(body,
      /handoff emit[^\n]*--boundary-event <boundary_seq>:<boundary_checksum>[^\n]*--owner <owner_run_id>[^\n]*--generation <(?:generation|n)>/,
      `${dir}: handoff emit must carry the exact rendered boundary event`);
    assert.doesNotMatch(body, /deep-loop\.mjs"\s+respawn[^\n]*--attended/,
      `${dir}: attended launch must not be inferred by the skill`);
  }
});

test('Task 14 interactive handoff prints kernel resume-command output before preserve-pause', () => {
  for (const file of [
    skillPath('deep-loop-continue'),
    skillPath('deep-loop-handoff'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md'),
  ]) {
    const body = readFileSync(file, 'utf8');
    const resumeIndex = body.indexOf('resume-command --project-root');
    const pauseIndex = body.indexOf('--mode preserve');
    assert.ok(resumeIndex !== -1 && pauseIndex > resumeIndex,
      `${file}: print the exact resume-command result, then preserve-pause`);
    assert.match(body.slice(Math.max(0, resumeIndex - 240), pauseIndex), /exact|정확/,
      `${file}: resume text must be kernel-returned and byte-exact`);
  }
});

test('Task 14 resume distinguishes handoff, recovery capsule, and root-relocation recovery', () => {
  const body = readFileSync(skillPath('deep-loop-resume'), 'utf8');
  assert.match(body, /Boundary handoff/i);
  assert.match(body, /Affinity recovery capsule/i);
  assert.match(body, /Project-root relocation recovery/i);
  assert.match(body, /resume-command --project-root/);
  assert.match(body, /recovery acquire --capsule/);
  assert.match(body, /root recovery acquire --capsule/);
  assert.match(body, /root diagnose --candidate-project-root/);
  assert.match(body, /current_root_digest/);
  assert.match(body, /current_binding_generation/);
  assert.match(body, /exact returned command|반환된 정확한 명령/i);
});

test('Task 14 compact restore stays in-conversation and never acquires a lease', () => {
  const body = readFileSync(skillPath('deep-loop-compact'), 'utf8');
  const restore = body.match(/## Restore([\s\S]*)/i)?.[1] ?? '';
  assert.match(restore, /checkpoint restore/);
  assert.match(restore, /same owner session|동일 owner 세션/i);
  assert.match(restore, /\/deep-loop-continue/);
  assert.doesNotMatch(restore, /deep-loop\.mjs"\s+lease acquire/);
});

test('Task 14 migrated policies execute only their fresh boundary-less kernel handoff action', () => {
  for (const file of [
    skillPath('deep-loop-continue'),
    skillPath('deep-loop-handoff'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md'),
  ]) {
    const body = readFileSync(file, 'utf8');
    assert.match(body,
      /continuation_policy[\s\S]{0,260}(?:compact-in-place|rotate-per-unit)[\s\S]{0,420}action\.reason[\s\S]{0,160}per_session_turn_cap/,
      `${file}: compatibility must be policy- and action-keyed`);
    assert.match(body,
      /handoff emit[^\n]*--reason "per_session_turn_cap"[^\n]*--owner <owner_run_id>[^\n]*--generation <(?:generation|n)>/,
      `${file}: legacy action must use the public boundary-less emit route`);
    assert.doesNotMatch(body,
      /per_session_turn_cap[\s\S]{0,500}respawn[^\n]*--attended/,
      `${file}: legacy compatibility must not restore inferred attended launch`);
  }
});

test('slash invocation is not a Claude identity', () => {
  for (const file of EXECUTION_DOCS) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /슬래시\s*⇒\s*Claude|slash\s*(?:⇒|=>|implies|means)\s*Claude/i,
      `${file}: slash must not imply Claude`);
  }
});

test('Route D review argv stays current and has no --runtime', () => {
  for (const file of [
    skillPath('deep-loop-continue'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'adapters.md'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'review-strategy.md'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'checker-bridge.md'),
  ]) {
    const src = readFileSync(file, 'utf8');
    for (const line of kernelCommandLines(src)) {
      if (/\breview (?:dispatch|record|import)\b/.test(line)) {
        assert.doesNotMatch(line, /--runtime\b/, `${file}: review argv must not add --runtime`);
      }
    }
  }
});

test('compact skill does not emit or restore for grok', () => {
  const src = readFileSync(skillPath('deep-loop-compact'), 'utf8');
  assert.match(src, /session_runtime[\s\S]{0,120}grok[\s\S]{0,200}(?:stop|needs-human|do not (?:call|invoke)|호출하지)/i);
  assert.match(src, /grok[\s\S]{0,240}checkpoint emit/i);
  assert.match(src, /grok[\s\S]{0,240}(?:restore|checkpoint restore)/i);
});

test('handoff requires diagnose and executable approve before emit', () => {
  const src = readFileSync(skillPath('deep-loop-handoff'), 'utf8');
  const diagnose = src.indexOf('runtime-executable diagnose');
  const approve = src.indexOf('runtime-executable approve');
  const emit = src.indexOf('handoff emit');
  assert.ok(diagnose !== -1 && approve !== -1 && emit !== -1, 'handoff must name diagnose, approve, and emit');
  assert.ok(diagnose < emit && approve < emit, 'diagnose and exe approve must precede emit');
});

test('Path V requires attended visible approve before emit', () => {
  const src = readFileSync(skillPath('deep-loop-handoff'), 'utf8');
  const attended = src.indexOf('attended-launch approve --style visible');
  const emit = src.indexOf('handoff emit');
  assert.ok(attended !== -1 && emit !== -1, 'Path V must name attended visible approve and emit');
  assert.ok(attended < emit, 'attended visible approve must precede emit');
});
