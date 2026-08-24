import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { dispatchReview } from '../scripts/lib/review.mjs';
import { buildRoutingRecord } from '../scripts/lib/router-adapter.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deep-loop.mjs');
const POLICY_A = 'a'.repeat(64);
const POLICY_B = 'b'.repeat(64);

function fence(runId) {
  return { owner: runId, generation: 1, intent: 'business' };
}

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-ep-route-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-08-16T00:00:00Z') });
  return { root, runId, fence: fence(runId) };
}

function routingFixture(overrides = {}) {
  const request = {
    route_schema_version: 1,
    task_class: 'IMPLEMENTATION',
    complexity: 1,
    uncertainty: 1,
    blast_radius: 0,
    reversibility: 0,
  };
  const decision = {
    route_schema_version: 1,
    router_plugin_version: '1.0.0',
    policy_sha256: POLICY_A,
    selected_model: 'claude-sonnet-5',
    selected_effort_native: 'high',
    effective_policy: { minimum_effort: null },
  };
  return {
    ...buildRoutingRecord(request, decision),
    ...overrides,
    decision: { ...decision, ...(overrides.decision || {}) },
    request: { ...request, ...(overrides.request || {}) },
  };
}

function eventLog(root, runId) {
  return readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function runCli(root, runId, args) {
  return spawnSync(process.execPath, [
    CLI, ...args, '--owner', runId, '--generation', '1',
    '--project-root', root, '--run-id', runId,
  ], { encoding: 'utf8' });
}

function readyMaker(root, runId, f, { routing } = {}) {
  const ws = newWorkstream(root, runId, {
    title: 'impl', branch: 'impl', worktree: '.claude/worktrees/impl', fence: f,
  }).id;
  writeFileSync(join(root, 'art.txt'), 'x');
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: ['art.txt'], fence: f,
  });
  recordEpisode(root, runId, id, { status: 'in_progress', ...(routing ? { routing } : {}), fence: f });
  return { ws, id };
}

test('recordEpisode freezes --routing on in_progress in the same episode-record transaction', () => {
  const { root, runId, fence } = seed();
  const routing = routingFixture();
  const { id } = readyMaker(root, runId, fence, { routing });
  const { data } = readState(root, runId);
  const ep = data.episodes.find((item) => item.id === id);
  assert.equal(ep.status, 'in_progress');
  assert.deepEqual(ep.routing.decision, routing.decision);
  assert.equal(ep.routing.selected_model, 'claude-sonnet-5');
  assert.equal(ep.routing.selected_effort_native, 'high');
  assert.equal(ep.routing.provenance, 'router');
  const records = eventLog(root, runId).filter((event) => event.type === 'episode-record');
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].data.routing.decision.policy_sha256, POLICY_A);
  assert.equal(records[0].data.status, 'in_progress');
});

test('recordEpisode and review dispatch preserve optional fingerprints in durable state and events', () => {
  const { root, runId, fence } = seed();
  const request = { route_schema_version: 1, task_class: 'IMPLEMENTATION' };
  const routedDecision = {
    route_schema_version: 1,
    router_plugin_version: '1.0.0',
    policy_sha256: POLICY_A,
    decision_fingerprint: 'a'.repeat(64),
    request_sha256: 'b'.repeat(64),
    selected_model: 'claude-sonnet-5',
    selected_effort_native: 'high',
    effective_policy: { minimum_effort: null },
  };
  const routing = buildRoutingRecord(request, routedDecision);
  const { ws, id } = readyMaker(root, runId, fence, { routing });
  let ep = readState(root, runId).data.episodes.find((item) => item.id === id);
  assert.equal(ep.routing.decision.decision_fingerprint, 'a'.repeat(64));
  assert.equal(ep.routing.decision.request_sha256, 'b'.repeat(64));
  const record = eventLog(root, runId).find((event) => event.type === 'episode-record');
  assert.equal(record.data.routing.decision.decision_fingerprint, 'a'.repeat(64));
  assert.equal(record.data.routing.decision.request_sha256, 'b'.repeat(64));

  recordEpisode(root, runId, id, { status: 'done', artifacts: ['art.txt'], fence });
  const dispatched = dispatchReview(root, runId, {
    point: 'implementation', workstreamId: ws, detected: { 'deep-review': true }, fence, routing,
  });
  ep = readState(root, runId).data.episodes.find((item) => item.id === dispatched.checkerEpisodeId);
  assert.equal(ep.routing.decision.decision_fingerprint, 'a'.repeat(64));
  assert.equal(ep.routing.decision.request_sha256, 'b'.repeat(64));
  const checkerEvent = eventLog(root, runId).find((event) => event.type === 'episode-new' && event.data.routing);
  assert.equal(checkerEvent.data.routing.decision.decision_fingerprint, 'a'.repeat(64));
  assert.equal(checkerEvent.data.routing.decision.request_sha256, 'b'.repeat(64));
});

test('recordEpisode without --routing keeps current degrade behavior', () => {
  const { root, runId, fence } = seed();
  const { id } = readyMaker(root, runId, fence);
  const ep = readState(root, runId).data.episodes.find((item) => item.id === id);
  assert.equal(ep.status, 'in_progress');
  assert.equal(Object.hasOwn(ep, 'routing'), false);
});

test('newEpisode rejects maker create-time routing; recordEpisode rejects late attach', () => {
  const { root, runId, fence } = seed();
  const ws = newWorkstream(root, runId, {
    title: 'impl', branch: 'impl', worktree: '.claude/worktrees/impl', fence,
  }).id;
  writeFileSync(join(root, 'art.txt'), 'x');
  assert.throws(
    () => newEpisode(root, runId, {
      plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
      workstream: ws, expectedArtifacts: ['art.txt'], fence, routing: routingFixture(),
    }),
    /EPISODE_ROUTING_ROLE_INVALID/,
  );
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: ['art.txt'], fence,
  });
  recordEpisode(root, runId, id, { status: 'in_progress', fence });
  assert.throws(
    () => recordEpisode(root, runId, id, { status: 'in_progress', routing: routingFixture(), fence }),
    /EPISODE_ROUTING_TRANSITION_INVALID/,
  );
});

test('recordEpisode rejects a second routing write on the same episode', () => {
  const { root, runId, fence } = seed();
  const { id } = readyMaker(root, runId, fence, { routing: routingFixture() });
  assert.throws(
    () => recordEpisode(root, runId, id, {
      status: 'in_progress',
      routing: routingFixture({ selected_model: 'claude-opus-4-8[1m]' }),
      fence,
    }),
    /EPISODE_ROUTING_FROZEN/,
  );
  const ep = readState(root, runId).data.episodes.find((item) => item.id === id);
  assert.equal(ep.routing.selected_model, 'claude-sonnet-5');
});

test('recordEpisode rejects --routing unless status is in_progress on a maker', () => {
  const { root, runId, fence } = seed();
  const ws = newWorkstream(root, runId, {
    title: 'impl', branch: 'impl', worktree: '.claude/worktrees/impl', fence,
  }).id;
  writeFileSync(join(root, 'art.txt'), 'x');
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: ['art.txt'], fence,
  });
  assert.throws(
    () => recordEpisode(root, runId, id, { status: 'blocked', routing: routingFixture(), fence }),
    /EPISODE_ROUTING_STATUS_INVALID/,
  );
  recordEpisode(root, runId, id, { status: 'in_progress', fence });
  recordEpisode(root, runId, id, { status: 'done', artifacts: ['art.txt'], fence });
  assert.throws(
    () => recordEpisode(root, runId, id, { status: 'done', artifacts: ['art.txt'], routing: routingFixture(), fence }),
    /EPISODE_ROUTING_STATUS_INVALID|EPISODE_ALREADY_TERMINAL/,
  );
});

test('recordEpisode rejects routing on a checker; dispatchReview freezes it at create', () => {
  const { root, runId, fence } = seed();
  const { ws, id: makerId } = readyMaker(root, runId, fence);
  recordEpisode(root, runId, makerId, { status: 'done', artifacts: ['art.txt'], fence });
  const routing = routingFixture({
    request: { task_class: 'REVIEW', complexity: 2, uncertainty: 1, blast_radius: 1, reversibility: 1 },
  });
  const dispatched = dispatchReview(root, runId, {
    point: 'implementation', workstreamId: ws, detected: { 'deep-review': true }, fence, routing,
  });
  const checker = readState(root, runId).data.episodes.find((item) => item.id === dispatched.checkerEpisodeId);
  assert.equal(checker.role, 'checker');
  assert.equal(checker.status, 'pending');
  assert.deepEqual(checker.routing.decision.policy_sha256, POLICY_A);
  assert.equal(dispatched.descriptor.selected_model, 'claude-sonnet-5');
  assert.equal(dispatched.descriptor.selected_effort_native, 'high');
  const created = eventLog(root, runId).filter((event) => event.type === 'episode-new' && event.data.routing);
  assert.equal(created.length, 1);
  assert.throws(
    () => recordEpisode(root, runId, checker.id, {
      status: 'in_progress', routing: routingFixture({ selected_model: 'other' }), fence,
    }),
    /EPISODE_ROUTING_ROLE_INVALID|EPISODE_ROUTING_FROZEN/,
  );
});

test('dispatchReview / newEpisode reject a digest that disagrees with a frozen episode', () => {
  const { root, runId, fence } = seed();
  const { ws, id: makerId } = readyMaker(root, runId, fence, { routing: routingFixture() });
  recordEpisode(root, runId, makerId, { status: 'done', artifacts: ['art.txt'], fence });
  assert.throws(
    () => dispatchReview(root, runId, {
      point: 'implementation', workstreamId: ws, detected: { 'deep-review': true }, fence,
      routing: routingFixture({ decision: { policy_sha256: POLICY_B } }),
    }),
    /EPISODE_ROUTING_DIGEST_MISMATCH/,
  );
  const checkers = readState(root, runId).data.episodes.filter((item) => item.role === 'checker');
  assert.equal(checkers.length, 0);
});

test('CLI episode record --routing only on in_progress and refuses overwrite', () => {
  const { root, runId, fence } = seed();
  const ws = newWorkstream(root, runId, {
    title: 'cli', branch: 'cli', worktree: '.claude/worktrees/cli', fence,
  }).id;
  const created = JSON.parse(runCli(root, runId, [
    'episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'impl',
    '--point', 'implementation', '--workstream', ws, '--artifacts', '[]',
  ]).stdout);
  const blocked = runCli(root, runId, [
    'episode', 'record', '--id', created.id, '--status', 'blocked',
    '--routing', JSON.stringify(routingFixture()),
  ]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /EPISODE_ROUTING_STATUS_INVALID/);
  const first = runCli(root, runId, [
    'episode', 'record', '--id', created.id, '--status', 'in_progress',
    '--routing', JSON.stringify(routingFixture()),
  ]);
  assert.equal(first.status, 0, first.stderr);
  const second = runCli(root, runId, [
    'episode', 'record', '--id', created.id, '--status', 'in_progress',
    '--routing', JSON.stringify(routingFixture({ selected_model: 'claude-opus-4-8[1m]' })),
  ]);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /EPISODE_ROUTING_FROZEN/);
});

test('CLI review dispatch --routing plants the freeze on the new checker', () => {
  const { root, runId, fence } = seed();
  const { ws, id } = readyMaker(root, runId, fence);
  recordEpisode(root, runId, id, { status: 'done', artifacts: ['art.txt'], fence });
  const dispatched = runCli(root, runId, [
    'review', 'dispatch', '--point', 'implementation', '--workstream', ws,
    '--routing', JSON.stringify(routingFixture()),
  ]);
  assert.equal(dispatched.status, 0, dispatched.stderr);
  const body = JSON.parse(dispatched.stdout);
  const checker = readState(root, runId).data.episodes.find((item) => item.id === body.checkerEpisodeId);
  assert.equal(checker.routing.selected_model, 'claude-sonnet-5');
});

test('continue SKILL routes after adapter resolve / route A-B-C and will not mark HIGH/CRITICAL failures in_progress', () => {
  const skill = readFileSync(new URL('../skills/deep-loop-continue/SKILL.md', import.meta.url), 'utf8');
  const maker = skill.slice(skill.indexOf('### dispatch_maker'));
  const checker = skill.slice(skill.indexOf('### dispatch_checker'));
  assert.match(maker, /adapter resolve[\s\S]+--routing[\s\S]+episode record[\s\S]+--status in_progress/);
  assert.match(maker, /HIGH|CRITICAL/);
  assert.match(maker, /await_human/);
  assert.doesNotMatch(
    maker.slice(0, maker.indexOf('episode record')),
    /HIGH[\s\S]{0,200}episode record --status in_progress/,
  );
  assert.match(maker, /session_profile|session-profile|단일 전파/);
  assert.match(checker, /Route A\/B\/C[\s\S]+--routing[\s\S]+(?:spawn|Skill|codex exec|review dispatch)/i);
  assert.match(checker, /HIGH|CRITICAL/);
  assert.match(checker, /await_human/);
  const fix = skill.slice(skill.indexOf('### fix_episode'));
  assert.match(fix, /target_maker|거절된 maker|prior_maker_routing|routing을 다시 호출하지 않는다|라우터를 다시 호출하지 않는다/);
  assert.match(fix, /--routing/);
});
