import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gradeStaticAssertion } from '../evals/graders/static-assertion.grader.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
const json = (p) => JSON.parse(read(p));

// Base e91c504 `hooks/hooks.json` sha256 over LF-normalized content.
const HOOKS_JSON_BASE_SHA256 = '91c3e8a197396cedb44ee178a383192a217a096e686cfea0d88611e68d30446e';
// Base e91c504 `.codex-plugin/plugin.json`, verbatim (LF).
const CODEX_MANIFEST_BASE = "{\n  \"name\": \"deep-loop\",\n  \"version\": \"1.25.0\",\n  \"description\": \"Loop Engineering control plane for Claude Code, Codex CLI, Codex App, Grok CLI, and native Windows\",\n  \"author\": { \"name\": \"Sungmin Cho\" },\n  \"repository\": \"https://github.com/Sungmin-Cho/deep-loop.git\",\n  \"license\": \"MIT\",\n  \"keywords\": [\"loop-engineering\",\"orchestration\",\"durable-state\",\"handoff\",\"claude-code\",\"codex-cli\",\"codex-app\",\"grok-cli\",\"windows\"],\n  \"skills\": \"./skills/\",\n  \"interface\": {\n    \"displayName\": \"Deep Loop\",\n    \"shortDescription\": \"Loop Engineering control plane over the deep-suite\",\n    \"longDescription\": \"Discovers work, routes to sibling deep-* plugins as maker/checker episodes, keeps durable loop state, and hands off to fresh sessions autonomously.\",\n    \"developerName\": \"Sungmin Cho\",\n    \"category\": \"Coding\",\n    \"capabilities\": [\"Interactive\",\"Read\",\"Write\"],\n    \"defaultPrompt\": [\"$deep-loop:deep-loop \\\"<goal>\\\"\"]\n  }\n}\n";

test('T-H1: hooks.claude.json repeats hooks.json hooks verbatim and declares one existing module', () => {
  const base = json('hooks/hooks.json');
  const claude = json('hooks/hooks.claude.json');
  assert.deepEqual(claude.hooks, base.hooks);
  assert.ok(claude.description.startsWith(base.description));
  assert.deepEqual(Object.keys(claude).sort(), ['description', 'hooks', 'modules']);
  assert.equal(claude.modules.length, 1);
  const module = resolve(ROOT, dirname('hooks/hooks.claude.json'), claude.modules[0]);
  assert.ok(existsSync(module), module);
});

test('T-H2: hooks/hooks.json is byte-identical to the base (LF-normalized)', () => {
  assert.equal(createHash('sha256').update(read('hooks/hooks.json')).digest('hex'), HOOKS_JSON_BASE_SHA256);
});

test('T-H2: .codex-plugin/plugin.json differs from the base only by version', () => {
  const { version } = json('.claude-plugin/plugin.json');
  assert.equal(read('.codex-plugin/plugin.json'), CODEX_MANIFEST_BASE.replace('"version": "1.25.0"', `"version": "${version}"`));
});

test('T-H3: .claude-plugin/plugin.json points at the manifest hooks file and the types file', () => {
  const manifest = json('.claude-plugin/plugin.json');
  assert.equal(manifest.hooks, './hooks/hooks.claude.json');
  assert.equal(manifest.types, './hooks/status-band/types.d.ts');
  assert.ok(existsSync(resolve(ROOT, manifest.hooks)));
  assert.ok(existsSync(resolve(ROOT, manifest.types)));
});

test('T-M2: the real-repo static grader covers the band files and passes', () => {
  const result = gradeStaticAssertion('no-external-action-routes', process.cwd());
  assert.equal(result.pass, true, JSON.stringify(result.evidence?.violations));
  for (const expected of ['hooks/status-band/register.mjs', 'hooks/status-band/band.mjs', 'hooks/hooks.claude.json']) {
    assert.ok(result.evidence.production_surfaces.includes(expected), expected);
  }
});
