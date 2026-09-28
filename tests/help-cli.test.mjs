import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTE_FLAGS } from '../scripts/lib/route-flags.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'deep-loop.mjs');

function invoke(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const HANDLERS = [
  'path', 'validate', 'detect-plugins', 'recipe-match', 'run', 'root',
  'runtime-executable', 'launcher-executable', 'init-run', 'next-action',
  'resume-command', 'tick', 'checkpoint', 'lease', 'workstream', 'episode',
  'review', 'router', 'handoff', 'respawn', 'state', 'pause', 'recover', 'recovery',
  'adapter', 'budget', 'comprehension', 'breaker', 'insights', 'spawn-style',
  'attended-launch', 'session-profile', 'detect-terminal', 'finish',
];

test('help surfaces every route and never advertises rejected flags', () => {
  for (const args of [[], ['help'], ['--help'], ['-h'], ['--help', 'episode']]) {
    const result = invoke(args);
    assert.equal(result.status, 0, args.join(' ') || '<empty>');
    for (const key of Object.keys(ROUTE_FLAGS)) {
      assert.match(result.stdout, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), key);
    }
  }

  const episode = invoke(['help', 'episode']);
  assert.equal(episode.status, 0);
  assert.match(episode.stdout, /--run-id/);
  assert.match(episode.stdout, /--now/);
  assert.match(episode.stdout, /episode new/);

  const state = invoke(['help', 'state']);
  assert.equal(state.status, 0);
  const getFlags = state.stdout.match(/ {2}state get\n {4}([^\n]+)/);
  const patchFlags = state.stdout.match(/ {2}state patch\n {4}([^\n]+)/);
  assert.ok(getFlags, state.stdout);
  assert.match(getFlags[1], /--json/);
  assert.ok(patchFlags, state.stdout);
  assert.doesNotMatch(patchFlags[1], /--json/);

  const review = invoke(['help', 'review']);
  assert.equal(review.status, 0);
  assert.doesNotMatch(review.stdout, /--target-maker/);
  assert.doesNotMatch(review.stdout, /allowed:.*--source/);

  const unknown = invoke(['help', 'not-a-handler']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown subcommand: not-a-handler/);

  const flagHelp = invoke(['episode', 'record', '--help', '--run-id', 'RUN']);
  assert.equal(flagHelp.status, 2);
  assert.match(flagHelp.stderr, /unknown flag --help/);

  for (const handler of HANDLERS) {
    const keys = Object.keys(ROUTE_FLAGS).filter((key) => key === handler || key.startsWith(`${handler} `));
    assert.ok(keys.length > 0, handler);
  }
});
