// Reference integrity for the always-loaded instruction surfaces.
//
// Ported from the guard of the same name in deep-goal (ESM structure, and the
// documentation-placeholder anchor model) carrying the newer rules from
// deep-work's copy: the shipped-set index derived from an authority rather than
// a skip list, malicious-workspace plants derived from that index, the landing
// `isFile()` filter, and the four-arm workspace-output carve-out.
//
// ANCHOR MODEL — documentation placeholder, deliberately NOT a shell variable.
//
// This repo's anchor is the bare token `DEEP_LOOP_ROOT`, and the skills state
// its contract themselves: "Resolve the absolute plugin root from the loaded
// SKILL.md path and replace `DEEP_LOOP_ROOT` before invoking Node. The literal
// `DEEP_LOOP_ROOT` string must never reach Node. Do not use shell expansion."
// The substitution is performed by the AGENT, before a command exists — so the
// whole expansion axis deep-work carries (`nonExpandingAnchors`,
// `expansionState`, `fenceBlocks`, `quotedHeredocLines` and their tests, roughly
// 200 lines) asks a question that cannot have an answer here: there is no shell
// variable, so no quoting context can leave one unexpanded. Porting it would add
// four rules that can never fire, which is worse than absent — a rule that
// cannot fire still looks like coverage.
//
// What IS ported from that axis is the half that survives the model change:
// `the anchor cannot be spelled as a shell variable anywhere`, and its sweep
// over the documents. A `${DEEP_LOOP_ROOT}/x` in an instruction stays literal on
// both hosts, and the consumer then reads a path *named* `${DEEP_LOOP_ROOT}/x`
// relative to the workspace — the exact substitution this guard exists to
// prevent, arriving through a spelling the anchor rule would otherwise accept.
// That rule is written structurally, over the SHAPE of an expanding reference
// rather than over a list of variable names — see EXPANDED_ROOT below.
//
// Fence balance is checked because a `references/` split once truncated a fenced
// template mid-block in a sibling: the entry kept the opening ``` and the first
// dozen template lines, the remainder moved behind a conditional pointer, and
// nothing failed. An odd fence count is the machine-detectable signature.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep, win32 } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALWAYS_LOADED = ['AGENTS.md', 'CLAUDE.md'];

// The scan set: every `.md` under skills/, plus the two always-loaded guides.
// `CLAUDE.md` is a thin `@AGENTS.md` wrapper here, which is a reason to scan it
// and not a reason to skip it — it is loaded on every Claude Code session, so
// anything it names is an instruction the host has already accepted.
function markdownFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) out.push(p);
    }
  };
  walk(join(ROOT, 'skills'));
  // `ALWAYS_LOADED` is asserted to be in the scan set by its own test, so
  // dropping it here fails loudly instead of silently shrinking coverage.
  for (const doc of ALWAYS_LOADED) {
    const p = join(ROOT, doc);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

// Every `.md` under skills/ — the documents an attacker would want to shadow.
// A bare Read(`hill-climbing.md`) names one of these with no basis at all, so it
// resolves against cwd, which is the target workspace.
const PLUGIN_DOCS = (() => {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) names.add(entry.name);
    }
  };
  walk(join(ROOT, 'skills'));
  return names;
})();

// Workspace-shadow guard.
//
// A bare `node scripts/deep-loop.mjs` or `Read references/hill-climbing.md`
// resolves against the *target workspace*, not the plugin. A repository under
// analysis can put a file at that path and have it read as instructions or run
// with the caller's Bash permissions.
//
// Parent-relative forms (`../deep-loop-workflow/references/x.md`) are just as
// shadowable. A markdown link resolves against the source file, but a runtime
// read has no such basis — it resolves against cwd. So this guard must NOT reuse
// the reference-integrity resolution at the bottom of this file: integrity asks
// "does this file exist?" and may resolve relative to the source; the shadow
// guard asks "does this instruction name a trustworthy basis?", and only an
// explicit plugin-root anchor does.
//
// Two clauses, both required for every instruction form:
//   A. anchoring   — the path names the plugin root explicitly.
//   B. containment — the resolved path stays inside the plugin root.
// Clause B is not implied by A: `DEEP_LOOP_ROOT/../workspace/evil.md` carries
// the anchor and still escapes.
//
// Scope: paths the plugin tells an agent to *open or run*. For `.mjs`/`.js`/`.sh`
// that is every mention — naming an executable is only useful for running it —
// so those are checked wherever they appear. A descriptive cross-reference to a
// `.md` in prose is not a load instruction, but deny-by-default below does not
// try to tell the two apart: any token resolving to a real plugin file must be
// anchored regardless of the sentence around it.
//
// SEPARATORS. Windows is a supported host — the kernel has a native-Windows
// branch and portable path helpers — so `scripts\deep-loop.mjs` names the same
// file as `scripts/deep-loop.mjs`. A matcher that knows only `/` lets the whole
// deny-by-default invariant be bypassed with one character, which is what review
// measured in two siblings: the slash form produced failures and the backslash
// form produced none.
//
// The fix is not to teach each matcher a second shape — that leaves the mixed
// form (`scripts\lib/state.mjs`) open and re-opens on the next rule added.
// Instead every extracted token is normalised once, at tokenisation, so
// deny-by-default, the FORMS, bare-basename and containment all judge one
// canonical spelling without being taught anything. Runs of separators collapse,
// so an escaped `scripts\\x.mjs` in a string literal normalises to the same
// path. Over-normalising is the safe direction here: a token only matters once
// it resolves to a real file in the plugin, and prose containing a stray
// backslash resolves to nothing.
const SEP = String.raw`[\\/]`;
const normalizePath = (token) => token.replace(/[\\/]+/g, '/');

// Repo-relative key, in the one spelling both sides of every PLUGIN_FILES
// comparison must use. `relative()` returns the *host's* separator, so on
// Windows it hands back `scripts\lib\state.mjs` while the token being looked up
// has already been normalised to `scripts/lib/state.mjs` — the two never meet
// and every membership test misses. Normalising the token but not the key
// normalises one side of a comparison, which is not normalising at all.
// `rel` is injectable so the Windows spelling can be exercised from a POSIX CI
// run — `win32.relative` is the same implementation that host uses. It defaults
// to the host's and disables nothing, so it is a seam for emulation rather than
// a switch that can turn the rule off.
const repoKey = (from, to, rel = relative) => normalizePath(rel(from, to));

// SHIPPED SET — the index deny-by-default consults.
//
// deep-work derives this from `package.json#files`, because that field is
// exactly what npm packs. This repo declares no `files` field, so that authority
// does not exist here; the one that does is git tracking. These plugins install
// by clone at a pinned SHA, so a file git does not track cannot exist in an
// installed plugin at all — which is precisely the property the index needs, and
// it is the same authority whether the reader is a maintainer's checkout or CI.
// A `readdirSync` walk with a skip list is what this replaces: in a sibling it
// missed five gitignored runtime directories and let 348 of 673 keys come from
// directories absent in a clean clone, so what deny-by-default could see
// differed between a maintainer's machine and CI, with CI on the lax side. Here
// that would be `.deep-loop/`, `.deep-review/`, `.deep-memory/`, `.superpowers/`
// and `.claude/`, all present locally and all absent in CI.
//
// `tests/` is then removed. It ships in a clone, but it is not an instruction
// surface: nothing under skills/ tells an agent to read or run a test file, and
// AGENTS.md names `tests/*.test.mjs` as repo prose addressed to a maintainer.
// The residual is stated rather than hidden — if a skill ever does instruct a
// test read, this index cannot see it, and only the FORMS below would catch it
// (they can, because PLUGIN_DIRS is derived from ALL tracked directories, tests
// included). `docs/` falls out on its own, being gitignored, and is covered by
// the maintainer-only sweep at the bottom instead.
function trackedFiles() {
  return execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0').filter(Boolean).map(normalizePath);
}

const TRACKED = trackedFiles();

function buildPluginFiles({ toKey = (p) => repoKey(ROOT, p), tracked = TRACKED } = {}) {
  const rel = new Set();
  for (const gitPath of tracked) {
    if (gitPath === 'tests' || gitPath.startsWith('tests/')) continue;
    rel.add(normalizePath(toKey(join(ROOT, gitPath))));
  }
  return rel;
}

const PLUGIN_FILES = buildPluginFiles();

// The directory names a plugin path can start with, DERIVED from what git
// tracks rather than listed. A hand list is the same defect one level down: it
// matches the tree on the day it is written and goes quiet the first time a
// directory is added. Every tracked directory counts, `tests/` included — a
// `bash tests/x.mjs` instruction is still an unanchored plugin path even though
// the index above deliberately cannot resolve it.
//
// EVERY segment, not just the top-level one. An instruction writes a path
// relative to wherever the author was standing, and the shape this repo's own
// documents use is `references/hill-climbing.md` — `references` is nested two
// deep under `skills/`, so a top-level-only derivation matched nothing and the
// read-verb FORM went silent on the most common relative spelling in the corpus.
// Deny-by-default cannot cover for that either: it needs the token to resolve
// repo-relative, and `references/…` does not.
const PLUGIN_DIRS = (() => {
  const dirs = new Set();
  for (const p of TRACKED) {
    const segments = p.split('/');
    for (let i = 0; i < segments.length - 1; i += 1) dirs.add(segments[i]);
  }
  return [...dirs].sort().map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
})();

const ANCHOR = String.raw`DEEP_LOOP_ROOT`;
const ANCHORED_TOKEN = new RegExp(`^(?:${ANCHOR})/`);
const PATH_BODY = String.raw`[A-Za-z0-9._/\\${'{}'}|$-]+`;
const REL = String.raw`\.{1,2}${SEP}`;
const ANY_ROOT = String.raw`(?:(?:${ANCHOR})${SEP}|${REL}|(?:${PLUGIN_DIRS})${SEP})`;

// Each pattern captures the path token in group 1, so anchoring and containment
// are judged per token rather than per line — a line mixing an anchored and a
// bare path must still fail on the bare one.
const FORMS = [
  // 1. interpreter exec: `node X`, `bash X`, `sh X`, `python X`
  ['interpreter-exec', new RegExp(String.raw`\b(?:bash|sh|zsh|node|python3?)\s+["'\`]?(${ANY_ROOT}${PATH_BODY})`, 'g')],
  // 2. read verb: `Read X`, `Follow X`, `Read("X")`
  ['read-verb', new RegExp(String.raw`\b(?:Read|Follow|read|follow)\s*\(?\s*["'\`]?(${ANY_ROOT}${PATH_BODY}\.md)`, 'g')],
  // 3. direct exec / source
  ['direct-exec', new RegExp(String.raw`(?:\b(?:source|exec)\s+|^\s*\.\s+)["'\`]?(${ANY_ROOT}${PATH_BODY})`, 'gm')],
  // 4. executable path token anywhere.
  //    The trailing boundary matters: without it `.js` matches the prefix of
  //    `hooks.json` and the guard reports a file that does not exist. `.mjs` is
  //    the extension this repo actually ships — every kernel file is one — so a
  //    list without it would be a rule aimed at nothing.
  ['executable-token', new RegExp(String.raw`(?<![A-Za-z0-9._/\\{}$-])((?:${ANCHOR})${SEP}|${REL}|(?:${PLUGIN_DIRS})${SEP})([A-Za-z0-9._/\\-]*\.(?:mjs|cjs|js|sh)(?![A-Za-z0-9]))`, 'g')],
];

// DENY BY DEFAULT.
//
// Enumerating instruction syntaxes is the losing half of the problem — each
// round of the original review found a form outside the current allowlist. So
// the question is not "is this a known instruction syntax?" but "does this token
// resolve to a real file in the plugin?". Anything that does must be anchored,
// whatever the verb, extension or sentence around it. Anything that does not
// resolve is prose about the target project and passes.

// Single-segment metadata, DERIVED rather than listed. A token with no separator
// that names a root-level file of THIS repo names the same file in every project
// that has one — `README.md`, `AGENTS.md`, `package.json` — so a bare mention is
// descriptive ("package.json declares engines") rather than an instruction with
// a basis, and the reading the author intended is the project's copy anyway.
// Multi-segment paths get no such pass. Deriving it means the exemption tracks
// the repo root instead of a list that was true once.
const ROOT_METADATA = new Set([...PLUGIN_FILES].filter((k) => !k.includes('/')));

// Path-shaped tokens: multi-segment paths, plus dotted single segments.
//
// The `+` on the separator class is load-bearing. Without it a run of separators
// breaks the segment repetition, the whole-path alternative fails, and the
// tokeniser falls back to the bare-basename alternative — which resolves to
// nothing, so deny-by-default never sees the path. `.mjs` names survive that gap
// because the executable-token FORM's body class spans a run on its own; `.md`
// with no read verb has no such umbrella.
//
// `<` and `>` are NOT in the class, unlike the sibling this was ported from.
// There they were admitted solely to let the anchor `<absolute-plugin-root>`
// tokenise, and a leading-`<` trim had to be bolted on afterwards to stop
// `<skills/…/x.md 첨부>` from extracting with the bracket attached and silently
// failing to resolve. This repo's anchor is a bare word, so admitting them buys
// nothing and costs detection: with `<>` out of the class, a foreign placeholder
// root — `<PLUGIN_ROOT>/scripts/deep-loop.mjs`, a spelling nothing here
// substitutes — no longer swallows the path into one unresolvable token. The
// tokeniser yields `scripts/deep-loop.mjs`, which resolves, and deny-by-default
// flags it.
const PATH_TOKEN = /[A-Za-z0-9_.@${}-]+(?:[\\/]+[A-Za-z0-9_.@{}|*-]+)+|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,6}\b/g;

// `files` is injectable for the same reason `toKey` is: the Windows key shape
// has to be pinnable in CI, not merely checked once by hand. `rel` is injectable
// alongside it because the `fromSource` normalisation is otherwise unpinnable:
// on POSIX `relative()` already returns slashes, so removing the normalisation
// is a no-op here and no mutation can see it. Only a win32 `relative` exercises
// it, and it has to be injected into the production call site — a copy of the
// logic in a test pins the test's arithmetic, not the guard's.
function resolvesInPlugin(token, sourceFile, files = PLUGIN_FILES, rel = relative) {
  const clean = normalizePath(token).replace(/^\.\//, '');
  if (files.has(clean)) return true;
  try {
    const fromSource = repoKey(ROOT, resolve(dirname(sourceFile), clean), rel);
    if (files.has(fromSource)) return true;
  } catch { /* unresolvable token — prose */ }
  return false;
}

// Scope, defined once. Yields the path tokens on a line that the invariant
// governs, with the documented exemptions applied. Both the classifier and the
// malicious-workspace fixture consume this, so they cannot test different rules.
function* scopedTokens(line, sourceFile = join(ROOT, 'AGENTS.md')) {
  PATH_TOKEN.lastIndex = 0;
  let m;
  while ((m = PATH_TOKEN.exec(line))) {
    // Normalise once, here, so every consumer — the classifier, the exemption
    // lookups and the malicious-workspace fixture alike — judges the same
    // string. Doing it any later means the basename exemption below sees
    // `SKILL.md` where the whole token was `skills\deep-loop\SKILL.md`, which is
    // precisely the hole a sibling shipped with.
    const token = normalizePath(m[0]);
    if (!token.includes('/') && ROOT_METADATA.has(token)) continue;
    // Self-reference. `resolvesInPlugin` also tries the SOURCE-relative branch,
    // so a bare `SKILL.md` written inside skills/x/SKILL.md resolves to the
    // document doing the naming. A document naming itself is not an instruction
    // to load a path from anywhere.
    if (!token.includes('/') && token === basename(sourceFile)) continue;
    const before = line.slice(Math.max(0, m.index - 30), m.index);
    // Already inside an anchored path, written with either separator.
    if (new RegExp(String.raw`${ANCHOR}["'\s]*[\\/]?$`).test(before)) continue;
    // Already inside a WORKSPACE-rooted path. `--artifacts '[".claude/worktrees/
    // <ws>/recipes/ledger.json"]'` is correctly rooted at a workspace output dir,
    // and re-extracting its tail as a separate token reported the tail as an
    // unanchored plugin path. The prefix already answers where it resolves.
    if ([...WORKSPACE_OUTPUT_DIRS].some((d) => new RegExp(
      `${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\/][^\\s"'\`]*$`).test(before))) continue;
    // A git pathspec. Git resolves it against the repository root by its own
    // rules, so `git log -p recipes/x.json` is unambiguous and anchoring it would
    // change what it means. The authority is git's, not this guard's.
    if (/\bgit\s+(?:-[^\s]+\s+)*[a-z-]+(?:\s+-[^\s]+)*\s+$/.test(before)) continue;
    // Markdown link target `](x.md)` — rendered navigation between documents,
    // not an instruction handed to a file tool. Markdown does not interpolate,
    // so these must stay source-relative; the link-destination test below pins
    // that they are never anchored.
    if (/\]\($/.test(before)) continue;
    yield token;
  }
}

function denyByDefaultHits(line, sourceFile, root = ROOT) {
  const out = [];
  for (const token of scopedTokens(line, sourceFile)) {
    if (ANCHORED_TOKEN.test(token)) {
      // Clause B is enforced here, not deferred. deep-work waves anchored tokens
      // through with a "clause B checks these" comment, which is only true where
      // a FORM also matched — a contained-looking path whose component links out
      // of the root is exactly the file an attacker wants accepted, and a `.yaml`
      // or `.json` token matches no FORM at all. `every referenced plugin path
      // resolves inside the root` is a second, independent backstop.
      if (escapesRoot(token)) out.push({ form: 'resolves-in-plugin', token, why: 'escapes plugin root' });
      else if (escapesViaSymlink(token, root)) out.push({ form: 'resolves-in-plugin', token, why: 'escapes via symlink' });
      continue;
    }
    // Forward defence only: a non-shipped path never resolves in the plugin, so
    // this line is unreachable today. All of the actual protection is in the two
    // maintainer-only tests below. It is kept so that adding such a path to the
    // shipped set later fails the caveat test rather than this rule silently.
    if (NON_SHIPPED_DECLARED.has(token)) continue;
    if (resolvesInPlugin(token, sourceFile)) {
      out.push({ form: 'resolves-in-plugin', token, why: 'unanchored' });
    }
  }
  return out;
}

// bare basename read: Read(`hill-climbing.md`). It resolves to no repo-relative
// path, so the rule above cannot see it — yet it is the weakest form of all,
// resolving straight against cwd. Only basenames that name a real plugin
// document are flagged, so ordinary prose is untouched.
const BARE_BASENAME = /\b(?:Read|Follow|read|follow)\s*\(?\s*["'`]([A-Za-z0-9][A-Za-z0-9._-]*\.md)(?:#[^`"']*)?["'`]/g;

// The executable twin. `Read`/`Follow` on a `.md` was covered; an interpreter on
// a runnable file was not, and that shape is strictly more dangerous: `node
// deep-loop.mjs` resolves against cwd — the analysed workspace — and running a
// planted file there is arbitrary code execution with the caller's permissions.
// Membership in the shipped set is still required, so prose that merely names a
// script is untouched; it is the interpreter that makes it an instruction.
const BARE_EXEC_BASENAME =
  /\b(?:node|python3?|deno|bun|bash|sh|zsh)\s+["'`]?([A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|cjs|mjs|py|sh))["'`]?/g;

function bareBasenameHits(line) {
  const out = [];
  BARE_BASENAME.lastIndex = 0;
  let m;
  while ((m = BARE_BASENAME.exec(line))) {
    if (PLUGIN_DOCS.has(m[1])) out.push({ form: 'bare-basename', token: m[1], why: 'unanchored' });
  }
  const shippedBasenames = new Set([...PLUGIN_FILES].map((f) => f.split('/').pop()));
  BARE_EXEC_BASENAME.lastIndex = 0;
  while ((m = BARE_EXEC_BASENAME.exec(line))) {
    if (shippedBasenames.has(m[1])) {
      out.push({ form: 'bare-exec-basename', token: m[1], why: 'unanchored' });
    }
  }
  return out;
}

// JS module load — refused outright, in every spelling.
//
// The rule this enforces is "an instruction document does not embed a JS module
// load of a plugin file", not "anchor it properly". Unlike deep-work there is no
// safe textual form here, because `DEEP_LOOP_ROOT` is a placeholder an *agent*
// substitutes while reading prose — no JS runtime expands it, so
// `require("DEEP_LOOP_ROOT/scripts/lib/state.mjs")` is a bare package specifier
// and Node searches the *workspace* node_modules; loading a planted module there
// is arbitrary code execution. `${DEEP_LOOP_ROOT}` is the same defect, and its
// backtick form additionally interpolates a local variable rather than the
// environment. A relative specifier (`./.claude-plugin/plugin.json`) is the same
// class by a shorter route: it resolves against cwd. This plugin's documented
// runtime interface is the CLI, so any JS module load naming a path inside an
// instruction document is a violation in every spelling.
const JS_MODULE_LOAD = /(?:\brequire\s*\(|\bimport\s*\(|\bimport\b[^;\n]*?\bfrom\s+)\s*["'`]([^"'`\n]+)["'`]/g;

function jsModuleLoadHits(line) {
  const out = [];
  JS_MODULE_LOAD.lastIndex = 0;
  let m;
  while ((m = JS_MODULE_LOAD.exec(line))) {
    const spec = m[1];
    if (/^node:/.test(spec)) continue;                       // built-in, no path
    out.push({
      form: 'js-module-load',
      token: spec,
      why: 'JS specifier — no runtime substitutes the documentation anchor, so the '
        + 'path resolves against the workspace (bare specifiers under its node_modules)',
    });
  }
  return out;
}

const ROOT_SENTINEL = sep === '/' ? '/plugin-root' : 'C:\\plugin-root';

// Clause B. Substitute the anchor with a sentinel root, resolve, and require the
// result to stay inside it. Tokens carrying a placeholder (`<run_id>`,
// `{a|b}`, `$WORK_DIR`) cannot be resolved literally, so they are checked
// lexically for `..` instead. Angle brackets are in the placeholder class here
// because they are this repo's placeholder convention — `<run_id>`,
// `<canonical_project_root>` — where the sibling used `{}` alone.
const PLACEHOLDER = /[{}|$<>]/;

function escapesRoot(token) {
  const body = normalizePath(token).replace(new RegExp(`^(?:${ANCHOR})/`), '');
  if (PLACEHOLDER.test(body)) return body.split('/').includes('..');
  const resolved = resolve(ROOT_SENTINEL, body);
  return resolved !== ROOT_SENTINEL && !resolved.startsWith(ROOT_SENTINEL + sep);
}

// Symlink escape: an anchored, lexically-contained path can still point out of
// the root if a component is a symlink. Only checkable for targets that exist.
//
// `root` is a parameter rather than a closed-over constant so the fixture can
// use a throwaway root outside the repository. A sibling planted its symlink
// *inside* the real root, which raced another test file's repo-tree copy —
// `node --test` runs files in parallel processes — and made the suite fail 5
// runs in 20. A flaky security guard is worse than a missing one: it teaches
// people to re-run until green.
function escapesViaSymlink(token, root = ROOT) {
  const body = normalizePath(token).replace(new RegExp(`^(?:${ANCHOR})/`), '');
  if (PLACEHOLDER.test(body)) return false;
  const target = join(root, body);
  if (!existsSync(target)) return false;
  const real = realpathSync(target);
  const realRoot = realpathSync(root);
  return real !== realRoot && !real.startsWith(realRoot + sep);
}

// Resolve a token for real, from a given cwd, exactly as a runtime agent would.
// Re-running the classifier tells you only what the classifier already believes;
// this performs the resolution and asks which file the instruction lands on. It
// is the second, independent layer, and it is shared by every fixture that needs
// it so no two of them can disagree about what resolution means.
function resolveAsAgentWould(token, cwd) {
  if (ANCHORED_TOKEN.test(token)) {
    return resolve(ROOT, token.replace(new RegExp(`^${ANCHOR}/`), ''));
  }
  return resolve(cwd, token.replace(/^\.\//, ''));
}

// Returns violations on a line: {form, token, why}. Empty when the line is clean.
function shadowableTokens(line, sourceFile = join(ROOT, 'AGENTS.md'), root = ROOT) {
  const out = [];
  for (const [form, re] of FORMS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const token = normalizePath(m[2] === undefined ? m[1] : m[1] + m[2]);
      if (!ANCHORED_TOKEN.test(token)) out.push({ form, token, why: 'unanchored' });
      else if (escapesRoot(token)) out.push({ form, token, why: 'escapes plugin root' });
      else if (escapesViaSymlink(token, root)) out.push({ form, token, why: 'escapes via symlink' });
    }
  }
  out.push(...bareBasenameHits(line));
  out.push(...jsModuleLoadHits(line));
  out.push(...denyByDefaultHits(line, sourceFile, root));
  // A token can match several FORMS plus deny-by-default; report each once.
  const seen = new Set();
  return out.filter((v) => {
    const key = `${v.token}|${v.why}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Indented too: fences nested in a list item or a numbered step are still fences.
const FENCE = /^[ \t]*```/gm;
const fenceCount = (body) => (body.match(FENCE) || []).length;

test('every skill and always-loaded markdown file has balanced code fences', () => {
  // The corpus is balanced today, so the sweep below cannot fail on its own —
  // deleting the whole parity check would leave this test green. The counter is
  // therefore pinned on the axis first, by COUNT rather than by parity: a
  // column-0-only matcher returns zero for the indented rows, and zero is even,
  // so a parity assertion would accept the very mutation this is here to catch.
  // That matcher is not hypothetical — in a sibling it left two reference files
  // with none of their fences checked, because 24 files write fences inside a
  // numbered step.
  assert.equal(fenceCount('```js\nx\n```\n'), 2, 'a closed block is two markers');
  assert.equal(fenceCount('```js\nx\n'), 1, 'an unclosed block is one');
  assert.equal(fenceCount('1. step\n   ```bash\n   x\n   ```\n'), 2,
    'an indented fence pair must be counted, or a truncated list block reads as balanced');
  assert.equal(fenceCount('1. step\n   ```bash\n   x\n'), 1,
    'and its truncated form must read as odd');

  const unbalanced = [];
  for (const file of markdownFiles()) {
    const fences = fenceCount(readFileSync(file, 'utf8'));
    if (fences % 2 !== 0) unbalanced.push(`${relative(ROOT, file)} (${fences})`);
  }
  assert.deepEqual(unbalanced, [],
    `unclosed code fence — a split or edit truncated a fenced block:\n  ${unbalanced.join('\n  ')}`);
});

test('the always-loaded agent guides are in the scan set', () => {
  // Root-level entries in ALWAYS_LOADED have no separator, so a Windows
  // emulation over them alone cannot fail — it would be a decorative assertion.
  // The derivation is pinned against a real nested document instead, which is
  // where the spelling actually diverges. `rel` is a seam, not a switch: it
  // defaults to the host's and turns nothing off.
  const scanKeys = (rel = relative) =>
    markdownFiles().map((f) => normalizePath(rel(ROOT, f)));
  const scanned = scanKeys();
  for (const doc of ALWAYS_LOADED) {
    assert.ok(existsSync(join(ROOT, doc)), `${doc} must exist to be scanned`);
    assert.ok(scanned.includes(doc), `${doc} must be in the shadow-guard scan set`);
  }
  const nested = scanned.find((k) => k.includes('/'));
  assert.ok(nested,
    'the scan set must hold a nested document, or the next assertion proves nothing');
  assert.ok(scanKeys(win32.relative).includes(nested),
    `the Windows spelling of ${nested} must be the same key as the host's — `
    + 'otherwise every membership check against a slash literal misses there');
});

test('no read or exec instruction can be shadowed from the target workspace', () => {
  const violations = [];
  for (const file of markdownFiles()) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const v of shadowableTokens(line, file)) {
        violations.push(`${relative(ROOT, file)}:${i + 1}  [${v.form}] ${v.token} — ${v.why}`);
      }
    });
  }
  assert.deepEqual(violations, [],
    'plugin path read or executed outside the plugin root — anchor it at '
    + `${ANCHOR} and keep it inside the root:\n  ${violations.join('\n  ')}`);
});

// One case per instruction form, so the coverage claim is itself tested. A form
// with no case here is a form the guard does not enforce. `safe` is null for
// js-module-load: that form has no safe textual spelling in this repo, and the
// dedicated test below pins that the anchored spelling is refused too.
const FORM_CASES = [
  ['interpreter-exec', 'node scripts/deep-loop.mjs status --run-id X',
    'node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" status --run-id X'],
  ['read-verb', 'Read `references/hill-climbing.md` and apply §3.4',
    'Read `DEEP_LOOP_ROOT/skills/deep-loop-workflow/references/hill-climbing.md` and apply §3.4'],
  ['direct-exec', 'source scripts/deep-loop.mjs',
    'source DEEP_LOOP_ROOT/scripts/deep-loop.mjs'],
  ['executable-token', 'the kernel lives at `scripts/lib/state.mjs`',
    'the kernel lives at `DEEP_LOOP_ROOT/scripts/lib/state.mjs`'],
  ['bare-basename', 'Read(`hill-climbing.md`)',
    'Read(`DEEP_LOOP_ROOT/skills/deep-loop-workflow/references/hill-climbing.md`)'],
  ['dot-relative', 'Read("../deep-loop-workflow/references/review-strategy.md")',
    'Read("DEEP_LOOP_ROOT/skills/deep-loop-workflow/references/review-strategy.md")'],
  ['js-module-load', 'const { readState } = require("scripts/lib/state.mjs");', null],
];

test('every enumerated instruction form is enforced', () => {
  for (const [form, unsafe, safe] of FORM_CASES) {
    assert.ok(shadowableTokens(unsafe).length > 0, `${form}: guard must flag — ${unsafe}`);
    if (safe === null) continue;
    assert.deepEqual(shadowableTokens(safe), [], `${form}: guard must accept — ${safe}`);
  }
});

test('a JS module load is refused in every spelling, anchored or not', () => {
  for (const line of [
    'const { readState } = require("scripts/lib/state.mjs");',
    'const { readState } = require("DEEP_LOOP_ROOT/scripts/lib/state.mjs");',
    'const { readState } = require("${DEEP_LOOP_ROOT}/scripts/lib/state.mjs");',
    'import { readState } from `${DEEP_LOOP_ROOT}/scripts/lib/state.mjs`;',
    'const v = require(\'./.claude-plugin/plugin.json\');',
  ]) {
    assert.ok(jsModuleLoadHits(line).length > 0, `must flag JS module load: ${line}`);
  }
  assert.deepEqual(jsModuleLoadHits('const { readFileSync } = require("node:fs");'), [],
    'a Node built-in specifier names no path and must pass');

  // WIRING, isolated. Every assertion above calls `jsModuleLoadHits` directly,
  // so all of them keep passing when the rule is unhooked from the classifier —
  // measured: removing it from `shadowableTokens` dropped the corpus sweep by
  // one finding and turned no test red. `FORM_CASES` cannot cover the gap
  // either, because its js-module-load line names a `.mjs` under a real plugin
  // directory and the executable-token FORM flags that on its own. This
  // specifier is reachable by nothing else: `.json` matches no FORM, and the
  // path resolves nowhere so deny-by-default cannot see it.
  assert.deepEqual(
    shadowableTokens('const cfg = require("./missing-dir/settings.json");').map((h) => h.form),
    ['js-module-load'],
    'the JS module-load rule must be wired into the classifier, alone on this line');
});

test('anchored paths that escape the plugin root are rejected (containment)', () => {
  const traversals = [
    'Read `DEEP_LOOP_ROOT/../workspace/evil.md`',
    'node "DEEP_LOOP_ROOT/../workspace/evil.mjs"',
  ];
  for (const line of traversals) {
    const hits = shadowableTokens(line);
    assert.ok(hits.length > 0, `containment must reject: ${line}`);
    assert.equal(hits[0].why, 'escapes plugin root', `wrong reason for: ${line}`);
  }
  // A `..` that stays inside the root is fine.
  assert.deepEqual(
    shadowableTokens('Read `DEEP_LOOP_ROOT/skills/deep-loop/../deep-loop-workflow/SKILL.md`'), [],
    'in-root traversal must be accepted');
});

test('mixed lines fail on the bare token', () => {
  const line = 'Read `DEEP_LOOP_ROOT/skills/deep-loop/SKILL.md` then Read `../deep-loop-workflow/SKILL.md`';
  const hits = shadowableTokens(line);
  assert.equal(hits.length, 1, `exactly the bare token must be flagged, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].why, 'unanchored');
});

test('a malicious workspace cannot shadow any instruction the plugin issues', () => {
  // End-to-end statement of the invariant. Plant shadows in a fake target
  // workspace for every file the plugin ships, then confirm no instruction in
  // the repo would resolve to one of them. Because every instruction is
  // anchored, cwd is irrelevant — which is the property under test, not an
  // accident of this fixture.
  const evil = mkdtempSync(join(tmpdir(), 'dl-evil-workspace-'));
  try {
    // Derived, not enumerated, and at repo-relative paths ONLY. A hand-written
    // plant list covers the paths someone remembered: in a sibling, five unsafe
    // spellings fired the classifier while this layer — the only one that proves
    // a planted file is actually reached — stayed silent, because nothing had
    // been planted where they would land. Planting bare basenames as well was
    // tried and reverted: a document that merely mentions a shipped basename in
    // prose then registers as a landing. That shape is handled by detection
    // instead (BARE_EXEC_BASENAME), where an interpreter is what makes it an
    // instruction.
    for (const rel of PLUGIN_FILES) {
      const dest = join(evil, rel);
      mkdirSync(dirname(dest), { recursive: true });
      if (!existsSync(dest)) writeFileSync(dest, '// SHADOW — must never be read\n');
    }
    // The landing predicate, named once and shared by the controls and the
    // sweep, so no two of them can disagree about what counts as a landing.
    const isLanding = (target) =>
      target.startsWith(evil + sep) && existsSync(target) && statSync(target).isFile();

    // Fixture programs are shipped data, and may legitimately use index.mjs.
    // A loadable directory becomes an instruction surface only when shipped
    // guidance tells the agent to load it by an unanchored name. Keep the
    // directory inventory derived, require every current exception to remain
    // fixture data, and pressure-test the classifier against each directory.
    const loadableDirectories = new Set([...PLUGIN_FILES].flatMap((key) => {
      if (/(^|\/)index\.[cm]?js$/.test(key)) return [normalizePath(dirname(key))];
      if (!/(^|\/)package\.json$/.test(key)) return [];
      const pkg = JSON.parse(readFileSync(join(ROOT, key), 'utf8'));
      return pkg.main || pkg.exports ? [normalizePath(dirname(key))] : [];
    }));
    assert.ok(loadableDirectories.size > 0,
      'the fixture-data distinction needs at least one real loadable directory');
    assert.deepEqual(
      [...loadableDirectories].filter(dir => !dir.startsWith('evals/fixtures/')),
      [],
      'a non-fixture shipped directory became loadable and needs an explicit instruction-surface decision',
    );
    for (const dir of loadableDirectories) {
      assert.ok(shadowableTokens(`node ${dir}`).length > 0,
        `fixture data must not authorize an unanchored directory execution: ${dir}`);
    }
    const loadableInstructionLandings = [];
    for (const file of markdownFiles()) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        for (const hit of shadowableTokens(line, file)) {
          const token = normalizePath(hit.token).replace(/^\.\//, '');
          if (loadableDirectories.has(token)) {
            loadableInstructionLandings.push(`${relative(ROOT, file)}:${index + 1}  ${token}`);
          }
        }
      });
    }
    assert.deepEqual(loadableInstructionLandings, [],
      'shipped guidance must not issue an unanchored load of fixture-data directories');

    // Non-vacuity FIRST, deliberately. The sibling this came from asserts its
    // control after the landing sweep, which is unreachable the moment the sweep
    // reports anything — and a guard newly introduced to a repo reports on day
    // one. An empty landing list must be a property of the documents rather than
    // of a resolver that never finds anything, and that has to stay decidable
    // while the sweep is red.
    //
    // The control token is DERIVED from the plant loop's own source, not written
    // by name. The sibling plants one extra file specifically to be its control,
    // which keeps passing after the derived loop stops writing anything —
    // measured here by neutering that loop: landings went to zero and the whole
    // test went green while proving nothing about any repo-relative path.
    const controlToken = [...PLUGIN_FILES].find((k) => k.includes('/') && k.endsWith('.mjs'));
    assert.ok(controlToken, 'the shipped index must contain a nested module to control on');
    assert.equal(isLanding(resolveAsAgentWould(controlToken, evil)), true,
      `fixture is vacuous — the unanchored token ${controlToken} must land on its plant`);
    assert.equal(isLanding(resolveAsAgentWould(`${ANCHOR}/${controlToken}`, evil)), false,
      'fixture is inverted — an anchored token must resolve into the plugin');

    // The `isFile()` half of the predicate, pinned rather than assumed. Planting
    // every shipped path creates the directories above it, so a token naming a
    // shipped DIRECTORY resolves to something that exists in the evil workspace
    // — and must not count, because nothing shadowable was planted there. Drop
    // `isFile()` and this is what fails; on the corpus alone nothing does,
    // because no document happens to name a bare shipped directory today.
    const dirToken = controlToken.replace(/\/[^/]+$/, '');
    const dirTarget = resolveAsAgentWould(dirToken, evil);
    assert.ok(dirTarget.startsWith(evil + sep) && existsSync(dirTarget),
      'the plant loop must create the directories above each plant');
    assert.equal(isLanding(dirTarget), false,
      'a directory must be excluded by isFile(), not by happening never to exist');

    const landed = [];
    for (const file of markdownFiles()) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const token of scopedTokens(line, file)) {
          const target = resolveAsAgentWould(token, evil);
          if (isLanding(target)) {
            landed.push(`${relative(ROOT, file)}:${i + 1}  ${token} → ${target}`);
          }
        }
      });
    }
    assert.deepEqual(landed, [],
      `these instructions resolve onto a planted shadow file:\n  ${landed.join('\n  ')}`);
  } finally {
    rmSync(evil, { recursive: true, force: true });
  }
});

test('a separator run reaches the planted file, not just the classifier', () => {
  // The defect this pins is invisible to a failure count. With a one-character
  // separator element in PATH_TOKEN, a run-spelled path (`scripts\\lib\\x.mjs`)
  // still makes the classifier report — a FORM matches the raw text — while the
  // reachability fixture goes blind, because scopedTokens dies at the second
  // separator and yields only the bare basename. Counting failures reads that as
  // "caught"; it is the layer that proves an instruction *actually lands on a
  // planted file* that has stopped working, and that is the only layer that
  // demonstrates the attack rather than describing it.
  const evil = mkdtempSync(join(tmpdir(), 'dl-run-evil-'));
  try {
    mkdirSync(join(evil, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(evil, 'scripts', 'lib', 'state.mjs'), '// SHADOW\n');

    for (const [label, line] of [
      ['single slash', 'node scripts/lib/state.mjs --check'],
      ['single backslash', 'node scripts\\lib\\state.mjs --check'],
      ['backslash run', 'node scripts\\\\lib\\\\state.mjs --check'],
      ['slash run', 'node scripts//lib//state.mjs --check'],
      ['mixed run', 'node scripts\\/lib\\/state.mjs --check'],
    ]) {
      assert.ok(shadowableTokens(line).length > 0,
        `layer 1 (classifier) must flag: ${label} — ${line}`);
      const landed = [...scopedTokens(line)]
        .map((t) => resolveAsAgentWould(t, evil))
        .filter((t) => t.startsWith(evil + sep) && existsSync(t) && statSync(t).isFile());
      assert.ok(landed.length > 0,
        `layer 2 (reachability) must land on the planted shadow: ${label} — ${line}. `
        + `scopedTokens yielded ${JSON.stringify([...scopedTokens(line)])}`);
    }

    // Non-vacuity for layer 2: an anchored spelling of the same path must NOT
    // land in the workspace, so "landed" is a property of the token and not of a
    // resolver that points everything at the evil root.
    assert.equal(
      resolveAsAgentWould('DEEP_LOOP_ROOT/scripts/lib/state.mjs', evil).startsWith(evil + sep),
      false, 'an anchored token must resolve into the plugin, never the workspace');
  } finally {
    rmSync(evil, { recursive: true, force: true });
  }
});

test('markdown link destinations are never the plugin-root anchor', () => {
  // The mirror image of the anchor rule. Markdown does not interpolate, and no
  // agent substitutes inside a link target, so an anchored link destination is a
  // literal broken URL. Link targets are an exception class in the guard above;
  // this asserts the exception is actually honoured in the documents.
  const re = () => new RegExp(String.raw`\]\(((?:${ANCHOR}|\$\{|<[A-Z_]+>)[^)]*)\)`, 'g');
  // The corpus currently holds exactly one markdown link, so a sweep alone would
  // pass whatever this pattern did. Pin the pattern on the axis first.
  for (const probe of [
    '[k](DEEP_LOOP_ROOT/scripts/deep-loop.mjs)',
    '[k](${DEEP_LOOP_ROOT}/scripts/deep-loop.mjs)',
    '[k](<PLUGIN_ROOT>/scripts/deep-loop.mjs)',
  ]) {
    assert.ok(re().exec(probe), `the link rule must see: ${probe}`);
  }
  assert.equal(re().exec('[k](README.md#compatibility-and-recovery-contract)'), null,
    'a source-relative link destination is the correct form and must pass');

  const broken = [];
  for (const file of markdownFiles()) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const pattern = re();
      let m;
      while ((m = pattern.exec(line))) broken.push(`${relative(ROOT, file)}:${i + 1}  ](${m[1]})`);
    });
  }
  assert.deepEqual(broken, [],
    'markdown link destination uses a root placeholder that nothing expands — use '
    + `a source-relative path instead:\n  ${broken.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Maintainer-only paths named in shipped documents.
//
// A gitignored directory does not exist in an installed plugin, so a path under
// one can only ever resolve against the ANALYSED PROJECT. Naming it in a shipped
// instruction hands that instruction to the project under analysis — the same
// substitution the anchoring rules exist to prevent, arriving by a route
// deny-by-default cannot see, because the path resolves nowhere in the index.
//
// Derived from `.gitignore`, not hand-listed. A hand-listed pair matched the
// ignore file exactly on the day it was written and would have leaked silently
// the first time a third entry was added.
const IGNORED_DIRS = (() => {
  const body = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  return body.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!') && line.endsWith('/'))
    .map((line) => line.replace(/\/$/, ''));
})();

// Not every gitignored directory is a leak when a document names it. For a
// plugin's declared OUTPUT root, resolving against the analysed project is the
// CONTRACT. Four arms, each with a stated authority, and no list of variable
// names:
//
// (1) ASK THE CODE — a directory this plugin WRITES into a project is its own
//     output root. Writing is the discriminator, not joining: a sibling's
//     release gate joins `docs` onto a project root and only READS it, and an
//     earlier probe that matched any join classified `docs/` as an output root —
//     silencing the rule for the exact class it exists for. A variable-name
//     allowlist was then tried and is what this replaces: it admitted 0 of 8
//     call sites in a repo where the project root is simply called `root`.
// (2) ASK THE CONVENTION — `.deep-*` is the suite's name for a plugin output
//     root. This deliberately covers a SIBLING's root: this repo never writes
//     `.deep-review/`, but `/deep-loop-continue` telling an agent to materialize
//     a checker contract into the project's `.deep-review/contracts/` is a
//     correct workspace-relative reference, and flagging it would be an
//     over-flag. Arm (1) alone would miss it — `.deep-review` and `.deep-memory`
//     appear in `scripts/lib/detect.mjs` only as existence probes.
// (3) ASK THE HOST — a tool's per-project directory. `.claude` is Claude Code's,
//     `.vscode` and `.idea` are the editors'. None belongs to any plugin, all
//     live in the analysed project, and a document may correctly name one — this
//     repo's worktree carve-out still accepts Execution-plane worktrees under
//     `<root>/.claude/worktrees/`. This arm
//     IS a small enumeration and saying so is the point: its growth condition is
//     known — a new host or editor project directory — and the alternative,
//     treating anything unproven as a workspace output, is fail-open.
// (4) ASK THE WORKTREE PARENT — gitignored Execution-plane worktree root.
//     Preferred creation is `<root>/.worktrees/<slug>`. `.claude/worktrees/` is
//     already covered by arm (3) via `.claude`. Kernel code does not write this
//     directory (skills run `git worktree add`), so arm (1) cannot see it.
const HOST_PROJECT_DIRS = new Set(['.claude', '.vscode', '.idea']);
const WORKTREE_PARENT_DIRS = new Set(['.worktrees']);

function pluginWrittenDirs(dirs) {
  const WRITE = /(mkdirSync|writeFileSync|appendFileSync|createWriteStream|rmSync|cpSync|renameSync)/;
  const found = new Set();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.[cm]?js$/.test(e.name) || /\.test\.[cm]?js$/.test(e.name)) continue;
      const body = readFileSync(p, 'utf8');
      for (const d of dirs) {
        if (found.has(d)) continue;
        const re = new RegExp(`['"\`]${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`, 'g');
        let m;
        while ((m = re.exec(body))) {
          if (WRITE.test(body.slice(Math.max(0, m.index - 260), m.index + 260))) { found.add(d); break; }
        }
      }
    }
  };
  ['scripts', 'hooks'].forEach((s) => walk(join(ROOT, s)));
  return found;
}

const WORKSPACE_OUTPUT_DIRS = new Set([
  ...pluginWrittenDirs(IGNORED_DIRS),
  ...IGNORED_DIRS.filter((d) => d.startsWith('.deep-')),
  ...IGNORED_DIRS.filter((d) => HOST_PROJECT_DIRS.has(d)),
  ...IGNORED_DIRS.filter((d) => WORKTREE_PARENT_DIRS.has(d)),
]);
const MAINTAINER_ONLY_DIRS = IGNORED_DIRS
  .filter((d) => !WORKSPACE_OUTPUT_DIRS.has(d) && d !== 'node_modules');

// Declared exceptions: a maintainer-only path a document may name, and the
// clauses that earn the exception. The declaration is not a waiver — the test
// below makes the naming document carry each clause, so an entry here without
// the sentence is a failure rather than a bypass.
//
// Empty today: no shipped document in this repo names a maintainer-only path.
// The mechanism is still pinned below against a synthetic entry, because an
// empty map would otherwise make that test pass without evaluating anything.
const NON_SHIPPED_DECLARED = new Map();

// Blockquote markers and hard wraps must not decide whether a caveat counts, so
// the required clauses are matched against a flattened body.
function flatten(body) {
  return body.replace(/^[ \t]*>[ \t]?/gm, '').replace(/\s+/g, ' ');
}

function missingCaveats(declared, files = markdownFiles(), read = readFileSync) {
  const missing = [];
  for (const [token, clauses] of declared) {
    assert.ok(!PLUGIN_FILES.has(token),
      `${token} is declared non-shipped but is in the shipped file set`);
    for (const file of files) {
      const body = read(file, 'utf8');
      if (!body.includes(token)) continue;
      const flat = flatten(body);
      for (const clause of clauses) {
        if (!clause.test(flat)) {
          missing.push(`${relative(ROOT, file)} names ${token} but is missing: ${clause.source}`);
        }
      }
    }
  }
  return missing;
}

test('a path the plugin never ships carries the sentence that makes it safe', () => {
  // The mechanism first, against a synthetic declaration and a synthetic
  // document. Without this the corpus sweep below iterates an empty map and the
  // assertion cannot fail — a decorative test that would go on passing after the
  // clause check was deleted.
  const fakeDocs = [join(ROOT, 'skills', 'fixture.md'), join(ROOT, 'skills', 'other.md')];
  const bodies = new Map([
    [fakeDocs[0], 'See `docs/RULES.md`. It ships with nothing, so never open it at runtime.'],
    [fakeDocs[1], 'See `docs/RULES.md` for the rest.'],
  ]);
  const fakeRead = (f) => bodies.get(f);
  const declared = new Map([['docs/RULES.md', [/ships with nothing/, /never open it at runtime/]]]);
  assert.deepEqual(missingCaveats(declared, [fakeDocs[0]], fakeRead), [],
    'a document carrying every clause must be accepted');
  assert.equal(missingCaveats(declared, fakeDocs, fakeRead).length, 2,
    'a document naming the path without the clauses must be reported, once per clause');
  // And the flattening is what makes the clause survive a rewrap or a blockquote.
  const wrapped = new Map([[fakeDocs[0],
    '> See `docs/RULES.md`. It ships\n> with nothing, so never\n> open it at runtime.']]);
  assert.deepEqual(missingCaveats(declared, [fakeDocs[0]], (f) => wrapped.get(f)), [],
    'a hard-wrapped, blockquoted caveat must still count');

  const missing = missingCaveats(NON_SHIPPED_DECLARED);
  assert.deepEqual(missing, [],
    'a non-shipped path is named without every clause that makes it safe to read:\n  '
    + missing.join('\n  '));
});

test('the workspace-output split is derived from the convention, and is two-way', () => {
  // The split is the one place this rule can be turned off, so it is asserted in
  // both directions rather than only where it happens to matter today.
  assert.ok(IGNORED_DIRS.length > 0, '.gitignore yielded no ignored directories');
  assert.deepEqual([...WORKSPACE_OUTPUT_DIRS].sort(),
    ['.claude', '.deep-loop', '.deep-memory', '.deep-review', '.worktrees'],
    'the four arms must classify exactly this repo\'s output roots');
  assert.deepEqual(MAINTAINER_ONLY_DIRS.sort(), ['.superpowers', 'docs'],
    'and everything else gitignored must stay maintainer-only');
  for (const dir of MAINTAINER_ONLY_DIRS) {
    assert.ok(!dir.startsWith('.deep-'), `${dir} is an output root but is swept`);
  }
  // The probe's failure mode, pinned. `docs/` IS joined onto a project root in
  // this family, so a probe that keys on *joining* classifies it as an output
  // root and silences the rule for the exact class it exists for. Writing is
  // what separates them: nothing in this family ever writes `docs/`.
  assert.ok(!WORKSPACE_OUTPUT_DIRS.has('docs'),
    'docs is read, never written — a probe that classes it as an output root has '
    + 'silenced the rule');
  assert.ok(MAINTAINER_ONLY_DIRS.length < IGNORED_DIRS.length,
    'nothing was split off — the rule is unchanged, which is not what its comment claims');
  // Arm (1) must be doing work of its own, or its 60 lines are decoration and
  // the convention arm is carrying the whole split.
  assert.ok(pluginWrittenDirs(IGNORED_DIRS).size > 0,
    'the write probe found no output root at all — it has stopped reading the kernel');
});

test('no undeclared path under a maintainer-only directory is named', () => {
  // Lexical over raw lines, never consulting the resolver: that is what makes it
  // immune to any index blind spot, and why both separators are spelled out —
  // `normalizePath` never reaches here, so with `/` alone the backslash spelling
  // walks straight past.
  //
  // Negative lookbehind rather than a prefix list. Enumerating the characters
  // that may precede a path makes every character nobody thought of a bypass:
  // `**docs/X.md**` and `[docs/Y.md](…)` are ordinary markdown and slip past a
  // space/backtick/quote/paren list.
  const escaped = MAINTAINER_ONLY_DIRS.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(String.raw`(?<![A-Za-z0-9._\\/-])((?:${escaped})[\\/][A-Za-z0-9._\\/-]+)`, 'g');

  // Both spellings and both prefix shapes, pinned on the axis rather than left
  // to whatever the corpus happens to contain today — which here is nothing, so
  // without these probes the sweep below could not fail at all.
  for (const probe of ['See `docs/backlog.md` for the rest.', 'See `docs\\backlog.md` too.',
    '**docs/bold.md** matters', '[docs/link.md](x) matters',
    'the skill cache lives at `.superpowers/skills/x.md`']) {
    re.lastIndex = 0;
    assert.ok(re.exec(probe), `the sweep must see: ${probe}`);
  }
  re.lastIndex = 0;
  assert.equal(re.exec('nodocs/notapath.md is mid-token'), null,
    'a match must not start mid-token');
  // And the carve-out is honoured here too: an output root must not be swept.
  re.lastIndex = 0;
  assert.equal(re.exec('worktrees live under `.claude/worktrees/<ws-slug>`'), null,
    'a host project directory must not be reported as maintainer-only');

  const violations = [];
  for (const file of markdownFiles()) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        if (NON_SHIPPED_DECLARED.has(m[1])) continue;   // earned by the caveat test above
        violations.push(`${relative(ROOT, file)}:${i + 1}  ${m[1]}`);
      }
    });
  }
  assert.deepEqual(violations, [],
    'a path under a maintainer-only directory is named in a shipped document; it '
    + `resolves only against the analysed project:\n  ${violations.join('\n  ')}`);
});

test('a backslash separator does not hide a path from the guard', () => {
  // Review found the slash form producing failures and the backslash form
  // producing none in two siblings — the same unanchored reference to the same
  // file, invisible because the matchers knew only `/`. Windows is a supported
  // host, so that is a legitimate spelling and not a typo, and one character
  // bypassed the whole deny-by-default invariant.
  const TABLE = [
    ['unanchored slash', 'Run `node scripts/deep-loop.mjs` to start.'],
    ['unanchored backslash', 'Run `node scripts\\deep-loop.mjs` to start.'],
    ['read-verb slash', 'Read `skills/deep-loop-workflow/SKILL.md`'],
    ['read-verb backslash', 'Read `skills\\deep-loop-workflow\\SKILL.md`'],
    ['mixed separators', 'Run `node scripts\\lib/state.mjs` to start.'],
    ['read-verb mixed', 'Read `skills/deep-loop\\SKILL.md` first.'],
  ];
  for (const [label, line] of TABLE) {
    assert.ok(shadowableTokens(line).length > 0, `${label} must be flagged: ${line}`);
  }

  // An anchored traversal written with backslashes is still a traversal, and
  // must be rejected for that reason rather than as "unanchored". Asserting the
  // reason is what keeps this row from passing for the wrong cause: with
  // normalizePath removed the token stays `DEEP_LOOP_ROOT\..\…`, fails
  // ANCHORED_TOKEN, and is flagged — correctly, but as an anchoring failure.
  const traversal = shadowableTokens('node "DEEP_LOOP_ROOT\\..\\workspace\\evil.json"');
  assert.ok(traversal.length > 0, 'anchored backslash traversal must be flagged');
  assert.equal(traversal[0].why, 'escapes plugin root',
    `traversal must fail on containment, not anchoring: ${JSON.stringify(traversal)}`);

  // PER-AXIS ISOLATION. The rows above are caught by several rules at once, so
  // they prove the bug is closed without proving which piece closed it. Each
  // case below is chosen so exactly one piece can see it.

  // PATH_TOKEN's separator run + the normalise-before-exemption ordering. No
  // read verb, so no FORM matches, and `SKILL.md` is a basename the source-
  // relative branch would resolve anyway — so if the token is not extracted
  // whole and canonicalised before the exemption lookups, nothing sees it.
  assert.ok(
    shadowableTokens('워크플로우 정본은 `skills\\deep-loop-workflow\\SKILL.md` 이다.').length > 0,
    'deny-by-default must extract a backslash path whole, not just its basename');
  assert.ok(shadowableTokens('const p = "skills\\\\deep-loop\\\\SKILL.md";').length > 0,
    'an escaped backslash path must survive tokenisation as one whole token');

  // ANY_ROOT/REL separator, isolated. Deny-by-default asks whether a token
  // resolves inside the plugin, so a path to a file that does not exist is
  // invisible to it — only a FORM can match, and only if the separator directly
  // after the root directory is accepted.
  assert.ok(shadowableTokens('Read `skills\\missing.md` before starting.').length > 0,
    'a FORM must accept a backslash directly after the root directory');

  // PATH_BODY separator, isolated. Slash after the root so ANY_ROOT matches
  // either way; the backslash is inside the body, and the file does not exist so
  // deny-by-default cannot cover for it.
  assert.ok(shadowableTokens('Read `skills/zzz\\missing.md` before starting.').length > 0,
    'a FORM must match a backslash inside the path body');

  // executable-token, isolated. It carries its own inline copy of the root and
  // body patterns rather than sharing ANY_ROOT/PATH_BODY, so the other FORMS
  // learning `\` teaches it nothing. No interpreter, no read verb, and a file
  // that does not exist, so this rule is the only one that can see it.
  for (const line of [
    'the kernel is at `scripts\\lib\\missing-kernel.mjs`',
    'the hook `hooks\\scripts\\missing-helper.sh` runs at Stop',
  ]) {
    assert.deepEqual(shadowableTokens(line).map((h) => h.form), ['executable-token'],
      `executable-token must be the rule that catches this, alone: ${line}`);
  }

  assert.deepEqual(
    shadowableTokens('Read `DEEP_LOOP_ROOT\\skills\\deep-loop\\SKILL.md`'), [],
    'an anchored backslash path must be accepted, not flagged as unanchored');
});

test('normalising separators does not promote prose into a path', () => {
  // Collapsing separator runs makes over-flagging the failure mode to watch, so
  // the text that must stay silent is pinned. But "produces no violation" has
  // two mechanisms behind it, and asserting only the outcome hides which one is
  // load-bearing. So each line declares its mechanism and is checked against it.

  // A. The tokeniser must not see a path here at all.
  for (const line of [
    'escape a quote with \\" and a backslash with \\\\',
    'Use `\\n` for a newline and `\\t` for a tab.',
    'A literal backslash is written `\\\\` in a JS string literal.',
    'The validator matches /^[A-Za-z]+\\/[a-z-]+$/ against each entry.',
  ]) {
    assert.deepEqual([...scopedTokens(line)], [], `no path token may be extracted from: ${line}`);
    assert.deepEqual(shadowableTokens(line), [], `must not be flagged: ${line}`);
  }

  // B. Here the tokeniser does extract something — a Windows path quoted inside
  //    user input is genuinely path-shaped — and it stays silent only because it
  //    resolves to no plugin file. That is a claim about the rule, so it gets the
  //    non-vacuity check: declare those exact tokens plugin files and the line
  //    must be flagged. Nothing is stubbed; only the file set the rule consults
  //    is changed, so what runs is the real classifier.
  for (const [line, expected] of [
    ['Windows paths in user input (`C:\\Users\\me\\project`) are normalised before use.',
      ['Users/me/project']],
    ['The workspace was at `D:\\repos\\acme\\notes.md` on that machine.',
      ['repos/acme/notes.md']],
    ['const p = "C:\\\\Users\\\\me\\\\notes.md";', ['Users/me/notes.md']],
  ]) {
    assert.deepEqual([...scopedTokens(line)], expected,
      `separator runs must collapse to one canonical token: ${line}`);
    assert.deepEqual(shadowableTokens(line), [], `must not be flagged: ${line}`);

    for (const t of expected) PLUGIN_FILES.add(t);
    try {
      assert.ok(shadowableTokens(line).length > 0,
        'vacuous negative — this line stays silent even when its tokens name real '
        + `plugin files, so asserting its silence proves nothing: ${line}`);
    } finally {
      for (const t of expected) PLUGIN_FILES.delete(t);
    }
  }
});

// EXPANDED ROOT.
//
// The anchor is substituted by the agent, so a `$`-spelling of it is not a
// stylistic variant — it is a defect. Nothing sets `DEEP_LOOP_ROOT` in either
// host's environment, so `${DEEP_LOOP_ROOT}/x` survives verbatim into whatever
// consumes it, and the consumer then reads a path *named* `${DEEP_LOOP_ROOT}/x`
// relative to the workspace: a fixed reference converted into a shadowable one.
//
// Written over the SHAPE, not over a list of names. The sibling this came from
// enumerates three spellings, and an enumeration of spellings is the same trap
// as an enumeration of verbs — it covers what someone remembered.
// `VARIABLE_ROOT` asks the structural question instead: does any path in this
// document take its root from something a shell or JS would expand? That
// catches `${CLAUDE_PLUGIN_ROOT}/…` and `$ANY_OTHER_ROOT/…` without naming
// either. `EXPANDED_ANCHOR` is the narrower companion for the anchor itself,
// which must be wrong even with no path after it.
const VARIABLE_ROOT = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?[\\/]/;
const EXPANDED_ANCHOR = new RegExp(String.raw`\$\{?${ANCHOR}\b`);

test('the anchor cannot be spelled as a shell variable anywhere', () => {
  // Closed by a different mechanism than deep-work uses. There it is a
  // `non-expanding-anchor` check hung off a list of commands, which misses `cp`,
  // `mv`, `install` and any wrapper — enumeration creeping back on a second
  // axis. This plugin bans the shell spelling outright in every scanned file,
  // because neither host sets such a variable and the placeholder is substituted
  // by the agent rather than by a shell, so quoting cannot change the outcome.
  const line = "cp '${DEEP_LOOP_ROOT}/scripts/deep-loop.mjs' /tmp/x";
  assert.ok(EXPANDED_ANCHOR.test(line) || VARIABLE_ROOT.test(line),
    'the expanded-root rule must reject the shell spelling regardless of the command');
  assert.ok(VARIABLE_ROOT.test('node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs"'),
    'and a sibling repo\'s anchor spelling, which nothing here substitutes either');
  assert.ok(EXPANDED_ANCHOR.test('export $DEEP_LOOP_ROOT'),
    'the bare `$` spelling counts even with no path after it');
  // Negatives: the shapes this repo legitimately writes must stay clean, or the
  // rule would ban the Codex skill-invocation syntax and the tmux probe.
  for (const clean of [
    'node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" status',
    'Codex: `$deep-loop:deep-loop-compact prepare|restore`',
    'Terminal detection evaluates `$TMUX` before the native-Windows branch.',
  ]) {
    assert.ok(!VARIABLE_ROOT.test(clean) && !EXPANDED_ANCHOR.test(clean),
      `must stay clean: ${clean}`);
  }
  // And it is verb-agnostic: no command appears in this line at all.
  assert.ok(shadowableTokens('scripts/deep-loop.mjs 를 참조한다').length > 0,
    'deny-by-default must flag a bare plugin path with no command verb present');
});

function expandedRootOffenders(files = markdownFiles(), read = readFileSync) {
  const offenders = [];
  for (const file of files) {
    read(file, 'utf8').split('\n').forEach((line, i) => {
      if (VARIABLE_ROOT.test(line) || EXPANDED_ANCHOR.test(line)) {
        offenders.push(`${relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  return offenders;
}

test('the plugin uses exactly one anchor spelling', () => {
  // The corpus holds no expanded root today, so the sweep cannot fail by itself
  // — with the whole condition deleted this test would stay green while the rule
  // it names went away. The sweep is therefore driven over a synthetic document
  // first, through the same function the corpus goes through.
  const fake = join(ROOT, 'skills', 'fixture.md');
  const bodies = new Map([[fake, [
    'node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" status',      // the correct form
    'node "${DEEP_LOOP_ROOT}/scripts/deep-loop.mjs" status',   // expanded anchor
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs"',      // a sibling\'s anchor
    'Codex: `$deep-loop:deep-loop-compact prepare`',           // not a path root
  ].join('\n')]]);
  const found = expandedRootOffenders([fake], (f) => bodies.get(f));
  assert.deepEqual(found.map((o) => o.split(':')[1].split(' ')[0]), ['2', '3'],
    `exactly the two expanded roots must be reported, got ${JSON.stringify(found)}`);

  const offenders = expandedRootOffenders();
  assert.deepEqual(offenders, [],
    'a path is rooted at something a shell or JS would expand — this plugin anchors '
    + `on the derived ${ANCHOR} placeholder only:\n  ${offenders.join('\n  ')}`);
});

test('an anchored path that leaves the root through a symlink is rejected', (t) => {
  // `escapes via symlink` is produced on two code paths and, until this test,
  // asserted on neither: containment only ever exercised the lexical `..` form.
  // `resolve` is lexical, so an anchored, `..`-free path whose component is a
  // symlink passes every other check and still lands outside the plugin.
  //
  // The fixture uses this repo's own symlink helper rather than a `symlinkSync`
  // call: `tests/unit/fs-safe.test.mjs` sweeps the test tree for direct calls, and it
  // is the helper that decides junction-vs-dir on Windows and skips on EPERM.
  const outside = mkdtempSync(join(tmpdir(), 'dl-symlink-outside-'));
  const fakeRoot = mkdtempSync(join(tmpdir(), 'dl-symlink-root-'));
  try {
    writeFileSync(join(outside, 'evil.md'), '# SHADOW — outside the plugin root\n');
    mkdirSync(join(fakeRoot, 'skills'), { recursive: true });
    if (!createFileSymlinkOrSkip(t, join(outside, 'evil.md'), join(fakeRoot, 'skills', 'evil.md'))) return;
    writeFileSync(join(fakeRoot, 'skills', 'ok.md'), '# in-root\n');
    const token = 'DEEP_LOOP_ROOT/skills/evil.md';

    // Non-vacuity: the token is anchored and lexically contained, so every other
    // clause accepts it. Only the symlink check can reject it.
    assert.ok(ANCHORED_TOKEN.test(token), 'fixture token must be anchored');
    assert.equal(escapesRoot(token), false, 'fixture token must be lexically contained');

    // Both production sites: the FORMS path and the deny-by-default path.
    const viaForm = shadowableTokens(`Read \`${token}\``, undefined, fakeRoot);
    assert.ok(viaForm.some((v) => v.why === 'escapes via symlink'),
      `read-verb path must reject the symlink: ${JSON.stringify(viaForm)}`);
    const viaDeny = denyByDefaultHits(`증명은 \`${token}\` 를 따른다`, join(ROOT, 'AGENTS.md'), fakeRoot);
    assert.ok(viaDeny.some((v) => v.why === 'escapes via symlink'),
      `deny-by-default path must reject the symlink: ${JSON.stringify(viaDeny)}`);

    // A real in-root target of the same shape is still accepted, so the rule is
    // about where the link points and not about the directory it sits in.
    assert.deepEqual(
      shadowableTokens('Read `DEEP_LOOP_ROOT/skills/ok.md`', undefined, fakeRoot), [],
      'a real in-root file must still be accepted');
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the plugin file index and the tokens looked up in it use one spelling', () => {
  // Normalising the token but not the index normalises one side of a comparison,
  // which is not normalising at all. `relative` returns the host's separator, so
  // on Windows every PLUGIN_FILES key would read `scripts\deep-loop.mjs` while
  // every token looked up in it reads `scripts/deep-loop.mjs` — deny-by-default
  // would then resolve nothing at all, and the isolating cases above would fail
  // on Windows only. Silently green is the worst state a guard can be in, and
  // `ci.yml` runs windows-latest, so this is pinned rather than checked by hand.
  assert.deepEqual([...PLUGIN_FILES].filter((k) => k.includes('\\')), [],
    'PLUGIN_FILES keys must be canonicalised at construction');

  const winRel = win32.relative('C:\\plugin-root', 'C:\\plugin-root\\scripts\\deep-loop.mjs');
  assert.equal(winRel, 'scripts\\deep-loop.mjs',
    'precondition — win32 relative must produce the backslash spelling');
  assert.ok(PLUGIN_FILES.has(normalizePath(winRel)),
    'the canonical spelling must be a key in the index');
  assert.equal(PLUGIN_FILES.has(winRel), false,
    'the host-shaped spelling must not be — otherwise this test proves nothing');
  assert.equal(
    repoKey('C:\\plugin-root', 'C:\\plugin-root\\scripts\\deep-loop.mjs', win32.relative),
    'scripts/deep-loop.mjs',
    'repoKey must canonicalise whatever separator its host relative() returns');

  // End-to-end: rebuild the entire index the way a Windows host would spell it —
  // every real plugin file, re-rooted under a win32 path, run back through the
  // same derivation — and require the result to be identical. This is what makes
  // the whole axis provable from a POSIX runner: with the normalisation removed
  // from repoKey, every one of these keys comes back with backslashes.
  const winRoot = 'C:\\plugin-root';
  const rebuilt = new Set([...PLUGIN_FILES].map((key) =>
    repoKey(winRoot, win32.join(winRoot, ...key.split('/')), win32.relative)));
  assert.deepEqual([...rebuilt].sort(), [...PLUGIN_FILES].sort(),
    'the index a Windows host builds must be key-for-key identical to this one');
  assert.ok(rebuilt.size > 50,
    `emulation swept only ${rebuilt.size} keys — the index is too small to be real`);

  // Both call sites, driven behaviourally rather than pinned by source text. A
  // source-text assertion pins the spelling of a call; it cannot see the
  // normalisation being removed from inside the function that call names.
  const winKeys = buildPluginFiles({ toKey: (p) => relative(ROOT, p).split(sep).join('\\') });
  assert.ok(winKeys.has('scripts/deep-loop.mjs'),
    'key generation must normalise, not merely store what the platform produced');

  // Nested source on purpose: from a root-level document `dirname` is ROOT, so
  // the source-relative branch reproduces the direct branch and would rescue an
  // un-normalised token, hiding what these assertions claim to pin.
  const nested = join(ROOT, 'skills', 'deep-loop-workflow', 'SKILL.md');
  assert.equal(resolvesInPlugin('scripts/deep-loop.mjs', nested, winKeys), true,
    'a slash-shaped lookup must resolve against Windows-shaped keys');
  assert.equal(resolvesInPlugin('scripts\\deep-loop.mjs', nested, winKeys), true,
    'a backslash-shaped lookup must resolve too');

  // The `fromSource` half, exercised through the production call site with a
  // win32 `relative`. On POSIX `relative()` already returns slashes, so removing
  // repoKey's normalisation there is a no-op no local mutation can see.
  const nestedTarget = [...winKeys].find((k) => k.includes('/'));
  const dir = nestedTarget.slice(0, nestedTarget.lastIndexOf('/'));
  const base = nestedTarget.slice(nestedTarget.lastIndexOf('/') + 1);
  const winRelative = (from, to) => relative(from, to).split('/').join('\\');
  // This pin is vacuous unless the DIRECT branch misses. `resolvesInPlugin`
  // strips the leading `./` and looks the bare basename up first; if a file of
  // that name sits at the repo root it returns there and the source-relative
  // branch — the thing being pinned — never runs, while the assertion still sees
  // `true`.
  assert.equal(winKeys.has(base), false,
    `a root-level ${base} would make the next assertion vacuous`);
  assert.equal(
    resolvesInPlugin(`./${base}`, join(ROOT, dir, 'sibling.md'), winKeys, winRelative), true,
    'the source-relative branch must normalise its own result before looking it up');

  // Non-vacuity, with a backslash token on purpose. A slash token makes this
  // pair decorative — the un-normalised key set misses either way, so it passes
  // however the token was handled. The backslash spelling discriminates. It is
  // *dominated* today by the backslash lookup above, which fails first on the
  // same mutation; it is kept as a backstop because the assertion that dominates
  // it is an enumeration of spellings, and enumerations get trimmed.
  const rawKeys = new Set([...winKeys].map((k) => k.split('/').join('\\')));
  assert.equal(resolvesInPlugin('scripts\\deep-loop.mjs', nested, rawKeys), false,
    'un-normalised keys must not be reachable by an un-normalised token');
});

test('every referenced plugin path resolves inside the root', () => {
  const patterns = [
    // Trailing boundary, same reason as the guard: without it `.js` matches the
    // prefix of `.json` and the resolver reports files that never existed. The
    // extension set leads with `mjs` because that is what this repo ships — a
    // set without it would sweep past the entire kernel.
    [new RegExp(String.raw`\b${ANCHOR}[\\/]([A-Za-z0-9._\\/-]+\.(?:mjs|cjs|js|md|sh|json|yaml|yml)(?![A-Za-z0-9]))`, 'g'), false],
    [/`(\.\.[\\/][A-Za-z0-9._\\/-]+\.md)(?:#[a-z0-9-]+)?`/g, true],
    [/\]\((\.\.?[\\/][A-Za-z0-9._\\/-]+\.md)\)/g, true],
    // Read("../x/y.md") — the double-quoted call form, which is how this repo's
    // two cross-references are actually written. Outside the backtick pattern.
    [/Read\("(\.\.[\\/][A-Za-z0-9._\\/-]+\.md)(?:#[a-z0-9-]+)?"\)/g, true],
  ];

  // Either separator in every pattern. This resolver reads the raw body on
  // purpose, so normalizePath never reaches it and each pattern has to accept
  // `\` itself. Slash-only left the backslash spelling of an out-of-root
  // reference visible to the classifier but INVISIBLE here — the layer that
  // actually checks containment. A failure count hides exactly that. Every
  // pattern gets a sample, because two of the four match nothing in the current
  // corpus and a real-file sweep gives them no coverage at all.
  const samples = [
    ['DEEP_LOOP_ROOT/../workspace/evil.json', 'DEEP_LOOP_ROOT\\..\\workspace\\evil.json'],
    ['`../shared/x.md`', '`..\\shared\\x.md`'],
    ['[l](../shared/x.md)', '[l](..\\shared\\x.md)'],
    ['Read("../shared/x.md")', 'Read("..\\shared\\x.md")'],
  ];
  patterns.forEach(([re], i) => {
    for (const spelling of samples[i]) {
      re.lastIndex = 0;
      assert.ok(re.exec(spelling), `pattern ${i} must see both spellings: ${spelling}`);
    }
  });
  // And the `.mjs` half of pattern 0, which the whole kernel depends on.
  patterns[0][0].lastIndex = 0;
  assert.ok(patterns[0][0].exec('DEEP_LOOP_ROOT/scripts/deep-loop.mjs'),
    'pattern 0 must see the extension this repo actually ships');

  const broken = [];
  let resolved = 0;
  const realRoot = realpathSync(ROOT);
  for (const file of markdownFiles()) {
    const body = readFileSync(file, 'utf8');
    for (const [re, isRelative] of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(body))) {
        const spelling = normalizePath(m[1]);
        const target = isRelative ? resolve(dirname(file), spelling) : join(ROOT, spelling);
        if (!existsSync(target)) {
          broken.push(`${relative(ROOT, file)} -> ${m[1]} (missing)`);
          continue;
        }
        // Existing is not enough: a target that resolves outside the plugin root
        // — lexically or through a symlinked component — is exactly the file an
        // attacker wants accepted. Containment is checked here too, so the two
        // tests cannot disagree about what counts as in-root.
        const real = realpathSync(target);
        if (real !== realRoot && !real.startsWith(realRoot + sep)) {
          broken.push(`${relative(ROOT, file)} -> ${m[1]} (resolves outside the plugin root: ${real})`);
          continue;
        }
        resolved += 1;
      }
    }
  }
  assert.deepEqual(broken, [], `unresolvable or out-of-root reference:\n  ${broken.join('\n  ')}`);
  assert.ok(resolved > 0, 'sweep matched no references at all — the patterns have rotted');
});
