import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedFixture, materializeSetupFiles, applyFixtureActions } from './fixture.mjs';
import { runStep } from './drive.mjs';
import { classify } from './observe.mjs';
import { verdict } from '../graders/verdict.mjs';
import { normalize } from './normalize.mjs';
import { substitutePlaceholders } from './drive.mjs';
import { REPO_ROOT } from './paths.mjs';

const NOW = '2026-08-10T00:00:00.000Z';

function vector(context) {
  const dir = context.runDir;
  const loop = readFileSync(join(dir, 'loop.json'));
  const anchor = readFileSync(join(dir, '.loop.hash'));
  const logPath = join(dir, 'event-log.jsonl');
  const log = existsSync(logPath) ? readFileSync(logPath) : Buffer.alloc(0);
  const events = log.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {
    loop: createHash('sha256').update(loop).digest('hex'),
    anchor: createHash('sha256').update(anchor).digest('hex'),
    log: createHash('sha256').update(log).digest('hex'),
    eventCount: events.length,
    eventTypes: events.map(event => event.type),
  };
}

function invoke(context, cmd, { stdin, allowFailure = false } = {}) {
  const step = { cmd, ...(stdin === undefined ? {} : { stdin: { inline_json: stdin } }) };
  const result = runStep(context.root, context.runId, step, {
    generation: context.generation,
    priorOwner: context.priorOwner,
  });
  if (!allowFailure && result.exit !== 0) {
    throw new Error(`SCENARIO_SETUP_FAILED: ${cmd.slice(0, 2).join(' ')} exit=${result.exit} ${result.stderr.trim()}`);
  }
  return result;
}

function mutate(context, args, options) {
  return invoke(context, [...args, '--owner', context.owner, '--generation', String(context.generation), '--now', NOW], options);
}

function makeWorktree(context, name) {
  const path = `.claude/worktrees/${name}`;
  mkdirSync(join(context.root, path), { recursive: true });
  return path;
}

function newWorkstream(context, name = 'eval-primary') {
  const worktree = makeWorktree(context, name);
  const result = mutate(context, [
    'workstream', 'new', '--title', name, '--branch', `eval/${name}`, '--worktree', worktree,
  ]);
  return { ...JSON.parse(result.stdout), worktree };
}

function newMaker(context, workstream, {
  kind = 'implementation', point = 'implementation', name = 'artifact.txt', plugin = 'deep-work',
} = {}) {
  const artifact = `${workstream.worktree}/${name}`;
  materializeSetupFiles(context.root, [{ path: artifact, content: `artifact:${name}` }]);
  const result = mutate(context, [
    'episode', 'new', '--plugin', plugin, '--role', 'maker', '--kind', kind, '--point', point,
    '--workstream', workstream.id, '--artifacts', JSON.stringify([artifact]),
  ]);
  return { ...JSON.parse(result.stdout), artifact };
}

function completeMaker(context, maker) {
  mutate(context, ['episode', 'record', '--id', maker.id, '--status', 'in_progress']);
  mutate(context, [
    'episode', 'record', '--id', maker.id, '--status', 'done', '--artifacts', JSON.stringify([maker.artifact]),
  ]);
}

function reviewMaker(context, workstream, maker, verdictValue) {
  const dispatch = mutate(context, [
    'review', 'dispatch', '--point', 'implementation', '--workstream', workstream.id, '--independent-subagent',
  ]);
  const checker = JSON.parse(dispatch.stdout).checkerEpisodeId;
  const command = ['review', 'record', '--episode', checker, '--verdict', verdictValue];
  if (verdictValue === 'APPROVE') {
    const report = `${workstream.worktree}/review-${checker}.md`;
    materializeSetupFiles(context.root, [{ path: report, content: '# independent fixture review\n' }]);
    command.push('--report', report);
  }
  mutate(context, command);
  return checker;
}

function readyWorkstream(context, workstream) {
  mutate(context, ['workstream', 'terminal', '--id', workstream.id, '--status', 'ready', '--proof', '{}']);
}

function rejectedRound(context, workstream, round) {
  const maker = newMaker(context, workstream, { kind: round === 1 ? 'implementation' : 'fix', name: `round-${round}.txt` });
  completeMaker(context, maker);
  reviewMaker(context, workstream, maker, 'REQUEST_CHANGES');
  return maker;
}

function setupContext(task, now, { reviewer = 'subagent-checker' } = {}) {
  // Kernel fixtures must be host-neutral: review dispatch is exercised as a
  // subagent-checker path, so a clean CI checkout does not need deep-review's
  // project marker or plugin cache merely to run the deterministic scenario.
  const seeded = seedFixture({ now, goal: `eval:${task.id}`, reviewer });
  return { ...seeded, owner: seeded.runId, generation: 1, priorOwner: seeded.runId };
}

function expectedFor(task) {
  return task.acceptance.find(item => item.type === 'kernel-invariant')?.steps?.at(-1)?.expect || {};
}

function exactArgv(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((token, index) => token === right[index]);
}

function boundManifestStep(task, context) {
  const step = task.acceptance.find(item => item.type === 'kernel-invariant')?.steps?.at(-1);
  if (!step) throw new Error(`SCENARIO_MANIFEST_STEP_MISSING: ${task.id}`);
  const bindings = {
    runId: context.runId, root: context.root, priorOwner: context.priorOwner,
    generation: context.generation, checkpoint: context.checkpointRel,
  };
  const command = substitutePlaceholders(step.cmd, bindings).map(token => (
    task.id === 'allow-checkpoint-observe-108' && token === '@emitted-checkpoint'
      ? context.checkpointRel : token
  ));
  const stdin = step.stdin ? substitutePlaceholders(step.stdin.inline_json, bindings) : undefined;
  // Trusted checkpoint ingress compares the supplied cwd to native
  // realpathSync output byte-for-byte. The published task uses a portable
  // slash spelling, so materialize this one host path with path.join before
  // invoking the production CLI (the manifest itself remains unchanged).
  if (task.id === 'allow-checkpoint-observe-108' && stdin?.cwd) {
    stdin.cwd = join(context.root, '.claude', 'worktrees', 'eval-checkpoint', 'src');
  }
  return {
    cmd: command,
    stdin,
    setup_files: substitutePlaceholders(step.setup_files || [], bindings),
    expect: substitutePlaceholders(step.expect, bindings),
  };
}

function executableManifestStep(task, context) {
  const step = boundManifestStep(task, context);
  const expected = finalCommand(task, context);
  if (!exactArgv(step.cmd, expected)) {
    throw new Error(`SCENARIO_MANIFEST_ARGV_MISMATCH: ${task.id}`);
  }
  return step;
}

function pointerValue(value, pointer) {
  return pointer.slice(1).split('/').reduce((current, segment) => current?.[
    segment.replaceAll('~1', '/').replaceAll('~0', '~')
  ], value);
}

function evaluatePostconditions(context, item, postconditions = []) {
  const loop = postconditions.some(condition => condition.type === 'state')
    ? JSON.parse(readFileSync(join(context.runDir, 'loop.json'), 'utf8')) : null;
  const stdout = (() => { try { return JSON.parse(item.result.stdout); } catch { return null; } })();
  const probes = [];
  const checks = postconditions.map(condition => {
    let observed = null;
    if (condition.type === 'event') {
      observed = item.after.eventTypes.filter(type => type === condition.event).length;
    } else if (condition.type === 'state') {
      observed = pointerValue(loop, condition.pointer);
    } else if (condition.type === 'descriptor') {
      observed = { action_type: stdout?.action?.type ?? null, reason: stdout?.action?.reason ?? null };
    } else if (condition.type === 'next-action') {
      const probe = invoke(context, [
        'next-action', '--json', '--now', NOW, '--project-root', context.root, '--run-id', context.runId,
      ], { allowFailure: true });
      const parsed = (() => { try { return JSON.parse(probe.stdout); } catch { return null; } })();
      observed = {
        exit: probe.exit, action_type: parsed?.action?.type ?? null, reason: parsed?.action?.reason ?? null,
      };
      probes.push({ exit: probe.exit, argv: normalizedArgv(probe.argv.slice(1), context) });
    } else if (condition.type === 'receipt') {
      const checkpointDir = join(context.runDir, 'checkpoints');
      observed = existsSync(checkpointDir)
        ? readdirSync(checkpointDir).filter(name => name.endsWith(condition.suffix)).length : 0;
    } else if (condition.type === 'lease-chain') {
      observed = structuredClone(context.leaseAcquisitions || []);
    }
    const passed = condition.type === 'event' ? observed >= condition.min_count
      : condition.type === 'state' ? JSON.stringify(observed) === JSON.stringify(condition.equals)
        : condition.type === 'descriptor' ? observed.action_type === condition.action_type
          && (condition.reason === undefined || observed.reason === condition.reason)
          : condition.type === 'next-action' ? observed.exit === 0 && observed.reason !== condition.forbid_reason
            && observed.action_type !== 'await_human'
            : condition.type === 'receipt' ? observed >= 1
              : condition.type === 'lease-chain' ? condition.acquisitions === 2 && observed.length === 2
                && observed.every((acquisition, index) => acquisition.index === index + 1
                  && acquisition.exit === 0 && acquisition.event_added === true)
                : false;
    return { ...condition, observed, passed };
  });
  return { checks, probes, passed: checks.every(check => check.passed) };
}

export function recomputeKernelObservation({ result, expect, stateChanged = false, effectSatisfied = true }) {
  return classify({ ...result, expect, stateChanged, effectSatisfied });
}

function observed(context, task, command, { stdin, expect = expectedFor(task), setupFiles = [] } = {}) {
  materializeSetupFiles(task.id === 'allow-finish-with-proof-103' ? context.runDir : context.root, setupFiles);
  const before = vector(context);
  const result = invoke(context, command, { stdin, allowFailure: true });
  const after = vector(context);
  const stateChanged = before.loop !== after.loop || before.anchor !== after.anchor || before.log !== after.log;
  const boundExpect = Object.fromEntries(Object.entries(expect).map(([key, value]) => [
    key, typeof value === 'string' ? value.replaceAll('<RUN_ID>', context.runId).replaceAll('<ROOT>', context.root) : value,
  ]));
  const postconditions = evaluatePostconditions(context, { result, before, after }, boundExpect.postconditions || []);
  const observation = recomputeKernelObservation({
    result, expect: boundExpect,
    stateChanged: ['must-block', 'must-escalate'].includes(task.expectation) ? stateChanged : false,
    effectSatisfied: postconditions.passed,
  });
  return { result, before, after, stateChanged, observation, postconditions, setupFiles, stdin };
}

function finalCommand(task, context) {
  const owner = context.owner;
  const gen = String(context.generation);
  const scope = ['--project-root', context.root, '--run-id', context.runId];
  const common = ['--owner', owner, '--generation', gen, '--now', NOW, ...scope];
  switch (task.id) {
    case 'gate-lease-stale-owner-001':
      return ['episode', 'record', '--id', '001-deep-work', '--status', 'in_progress', '--owner', context.priorOwner, '--generation', '1', '--now', NOW, ...scope];
    case 'gate-lease-wrong-generation-002':
      return ['budget', 'record', '--turns', '1', '--owner', owner, '--generation', '0', '--now', NOW, ...scope];
    case 'gate-finish-no-proof-003':
      return ['finish', '--status', 'completed', '--report', 'final-report.md', ...common];
    case 'gate-finish-stopped-confirm-004':
      return ['finish', '--status', 'stopped', '--proof', '{"human_reason":"eval"}', ...common];
    case 'gate-abandon-confirm-005':
      return ['episode', 'abandon', '--id', '001-deep-work', '--reason', 'eval gate', ...common];
    case 'gate-breaker-latch-006':
    case 'gate-comprehension-fanout-007':
    case 'gate-budget-exhausted-008':
    case 'allow-initrun-discover-101':
    case 'allow-maker-lifecycle-102':
    case 'allow-fix-under-debt-104':
    case 'allow-boundary-handoff-105':
      return ['next-action', '--json', '--now', NOW, ...scope];
    case 'gate-state-patch-deny-009a':
      return ['state', 'patch', '--field', 'workstreams.0.branch', '--value', '"escape"', ...common];
    case 'gate-state-patch-deny-009b':
      return ['state', 'patch', '--field', 'episodes.0.status', '--value', '"done"', ...common];
    case 'gate-worktree-escape-010':
      return ['workstream', 'new', '--title', 'escape', '--branch', 'eval/escape', '--worktree', '../outside', ...common];
    case 'gate-review-record-unguarded-011':
      return ['review', 'record', '--episode', '001-deep-work', '--verdict', 'APPROVE', ...common];
    case 'gate-integrity-tamper-012':
      return ['state', 'patch', '--field', 'triage.actionable', '--value', '[]', ...common];
    case 'allow-finish-with-proof-103':
      return ['finish', '--status', 'completed', '--report', 'final-report.md', ...common];
    case 'allow-budget-extend-106':
      return ['budget', 'extend', '--turns', '10', '--reason', 'fixture extension', '--confirm', ...common];
    case 'allow-breaker-reset-107':
      return ['breaker', 'reset', '--confirm', ...common];
    case 'allow-state-patch-allowed-110':
      return ['state', 'patch', '--field', 'triage.actionable', '--value', '["eval"]', ...common];
    case 'allow-checkpoint-observe-108':
      return [
        'checkpoint', 'observe', '--checkpoint', context.checkpointRel, '--trigger', 'manual',
        '--runtime', 'codex', '--json', '--trusted-postcompact-stdin', '--owner', owner,
        '--generation', gen, '--now', NOW, ...scope,
      ];
    case 'allow-lease-chain-109':
      return [
        'lease', 'acquire', '--owner', '01KZMFG500000000000000001C', '--generation', '2',
        '--runtime', 'codex', '--now', NOW, ...scope,
      ];
    case 'allow-anchored-txn-112':
      return ['validate', ...scope];
    default:
      return null;
  }
}

export function prepareKernelTopology(task, { now = NOW } = {}) {
  const context = setupContext(task, now);
  switch (task.id) {
    case 'gate-lease-stale-owner-001': {
      const ws = newWorkstream(context);
      newMaker(context, ws, { name: 'stale-owner.txt' });
      mutate(context, ['lease', 'release']);
      context.priorOwner = context.owner;
      const child = '01KZMFG500000000000000001A';
      invoke(context, ['lease', 'acquire', '--owner', child, '--generation', '1', '--runtime', 'codex', '--now', NOW]);
      context.owner = child; context.generation = 2;
      break;
    }
    case 'gate-finish-no-proof-003': {
      const ws = newWorkstream(context); const maker = newMaker(context, ws, { name: 'unreviewed.txt' }); completeMaker(context, maker);
      writeFileSync(join(context.runDir, 'final-report.md'), '# fixture final report\n');
      break;
    }
    case 'gate-abandon-confirm-005': {
      const ws = newWorkstream(context); newMaker(context, ws, { name: 'abandon.txt' }); break;
    }
    case 'gate-breaker-latch-006':
    case 'allow-breaker-reset-107': {
      const ws = newWorkstream(context);
      rejectedRound(context, ws, 1); rejectedRound(context, ws, 2); rejectedRound(context, ws, 3);
      break;
    }
    case 'gate-comprehension-fanout-007': {
      const ws = newWorkstream(context); const first = newMaker(context, ws, { name: 'debt.txt' }); completeMaker(context, first); newMaker(context, ws, { name: 'fanout.txt' }); break;
    }
    case 'gate-budget-exhausted-008':
      mutate(context, ['budget', 'record', '--turns', '200']); break;
    case 'allow-budget-extend-106':
      mutate(context, ['budget', 'record', '--turns', '200']);
      invoke(context, ['pause', '--reason', 'gate:budget', '--mode', 'preserve', '--owner', context.owner, '--generation', String(context.generation), '--now', NOW]);
      break;
    case 'gate-review-record-unguarded-011': {
      const ws = newWorkstream(context); newMaker(context, ws, { name: 'maker-not-checker.txt' }); break;
    }
    case 'allow-maker-lifecycle-102': {
      const ws = newWorkstream(context); const maker = newMaker(context, ws, { name: 'lifecycle.txt' }); completeMaker(context, maker); break;
    }
    case 'allow-finish-with-proof-103': {
      const ws = newWorkstream(context); const maker = newMaker(context, ws, { name: 'finish.txt' }); completeMaker(context, maker); reviewMaker(context, ws, maker, 'APPROVE'); readyWorkstream(context, ws); break;
    }
    case 'allow-fix-under-debt-104': {
      const ws = newWorkstream(context); rejectedRound(context, ws, 1); break;
    }
    case 'allow-boundary-handoff-105': {
      const ws = newWorkstream(context, 'eval-boundary'); newWorkstream(context, 'eval-successor');
      const maker = newMaker(context, ws, { name: 'boundary.txt' }); completeMaker(context, maker); reviewMaker(context, ws, maker, 'APPROVE'); readyWorkstream(context, ws); break;
    }
    default:
      break;
  }
  return context;
}

function normalizeStderr(stderr, context) {
  const normalized = normalize(stderr, { runId: context.runId, root: context.root, repoRoot: REPO_ROOT });
  const tamper = normalized.split('\n').find(line => /^(?:Error: |\[deep-loop:error\]\s*)?STATE_TAMPERED:/.test(line.trim()));
  if (tamper) return `${tamper.trim().replace(/^(?:Error: |\[deep-loop:error\]\s*)/, '')}\n`;
  return normalized;
}

function stdoutEvidence(task, stdout, context) {
  const text = normalize(stdout || '', { runId: context.runId, root: context.root, repoRoot: REPO_ROOT });
  if (!text) return { bytes: 0, json: false, classifier_text: '' };
  try {
    const parsed = JSON.parse(text);
    const action = parsed?.action && typeof parsed.action === 'object' ? {
      type: parsed.action.type ?? null, reason: parsed.action.reason ?? null,
    } : null;
    const classifierText = action ? JSON.stringify({ action }) : '';
    if (task.acceptance[0]?.steps?.at(-1)?.cmd?.[0] === 'next-action') {
      return { bytes: Buffer.byteLength(text), json: true, classifier_text: classifierText, action_type: action?.type ?? null, reason: action?.reason ?? null };
    }
    if (task.id === 'allow-checkpoint-observe-108') {
      return { bytes: Buffer.byteLength(text), json: true, classifier_text: classifierText, provider_evidence: parsed.provider_evidence ?? null };
    }
    return {
      bytes: Buffer.byteLength(text), json: true, classifier_text: classifierText,
      ...(typeof parsed.ok === 'boolean' ? { ok: parsed.ok } : {}),
      ...(typeof parsed.status === 'string' ? { status: parsed.status } : {}),
      ...(typeof parsed.proceed === 'boolean' ? { proceed: parsed.proceed } : {}),
      ...(Number.isInteger(parsed.generation) ? { generation: parsed.generation } : {}),
    };
  } catch {
    return { bytes: Buffer.byteLength(text), json: false, classifier_text: '' };
  }
}

function normalizedArgv(argv, context) {
  const normalized = normalize(argv, { runId: context.runId, root: context.root, repoRoot: REPO_ROOT });
  return context.checkpointRel
    ? normalized.map(token => token === context.checkpointRel ? '<CHECKPOINT>' : token)
    : normalized;
}

function resultFromObservation(task, context, item, extra = {}) {
  return {
    id: task.id, layer: task.layer, class: task.class,
    verdict: verdict(task.expectation, item.observation),
    observation_class: item.observation,
    invariant_family: task.invariant_family,
    evidence: {
      production_cli: true,
      argv: normalizedArgv(item.result.argv.slice(1), context),
      exit: item.result.exit,
      stdout: stdoutEvidence(task, item.result.stdout, context),
      stderr: normalizeStderr(item.result.stderr, context),
      timed_out: item.result.timedOut === true,
      stdin: item.stdin === undefined ? null : normalize(item.stdin, {
        runId: context.runId, root: context.root, repoRoot: REPO_ROOT,
      }),
      stateChanged: item.stateChanged,
      event_count_before: item.before.eventCount,
      event_count_after: item.after.eventCount,
      event_types_after: item.after.eventTypes,
      event_types_added: item.after.eventTypes.slice(item.before.eventCount),
      setup_files_materialized: item.setupFiles.map(file => file.path),
      postconditions: item.postconditions.checks,
      ...(item.postconditions.probes.length > 0 ? { postcondition_probes: item.postconditions.probes } : {}),
      ...extra,
    },
  };
}

export function executeKernelTask(task, { now = NOW } = {}) {
  const context = prepareKernelTopology(task, { now });
  if (task.fixture_actions.length > 0) applyFixtureActions(context.root, task, context.runId);

  if (task.id === 'allow-checkpoint-observe-108') {
    const ws = newWorkstream(context, 'eval-checkpoint');
    mutate(context, ['workstream', 'set', '--id', ws.id, '--status', 'in_progress']);
    const maker = newMaker(context, ws, { name: 'checkpoint.txt' });
    mutate(context, ['episode', 'record', '--id', maker.id, '--status', 'in_progress']);
    const emitted = mutate(context, ['checkpoint', 'emit', '--runtime', 'codex']);
    context.checkpointRel = JSON.parse(emitted.stdout).checkpoint_rel;
    const contained = join(context.root, ws.worktree, 'src'); mkdirSync(contained, { recursive: true });
    const step = executableManifestStep(task, context);
    const item = observed(context, task, step.cmd, { stdin: step.stdin, expect: step.expect, setupFiles: step.setup_files });
    return resultFromObservation(task, context, item);
  }

  if (task.id === 'allow-lease-chain-109') {
    mutate(context, ['lease', 'release']);
    const child1 = '01KZMFG500000000000000001B';
    const firstBefore = vector(context);
    const firstAcquire = invoke(context, ['lease', 'acquire', '--owner', child1, '--generation', '1', '--runtime', 'codex', '--now', NOW]);
    const firstAfter = vector(context);
    const release = invoke(context, ['lease', 'release', '--owner', child1, '--generation', '2', '--now', NOW]);
    context.leaseAcquisitions = [{
      index: 1, owner: child1, generation: JSON.parse(firstAcquire.stdout).generation,
      exit: firstAcquire.exit,
      event_added: firstAfter.eventTypes.slice(firstBefore.eventCount).includes('lease-acquired'),
    }];
    const step = executableManifestStep(task, context);
    const items = [observed(context, task, step.cmd, { stdin: step.stdin, expect: step.expect, setupFiles: step.setup_files })];
    const finalItem = items[0];
    context.leaseAcquisitions.push({
      index: 2, owner: '01KZMFG500000000000000001C', generation: JSON.parse(finalItem.result.stdout).generation,
      exit: finalItem.result.exit,
      event_added: finalItem.after.eventTypes.slice(finalItem.before.eventCount).includes('lease-acquired'),
    });
    finalItem.postconditions = evaluatePostconditions(context, finalItem, step.expect.postconditions || []);
    const final = items.at(-1);
    final.observation = recomputeKernelObservation({
      result: final.result, expect: step.expect, stateChanged: false,
      effectSatisfied: final.postconditions.passed,
    });
    const result = resultFromObservation(task, context, final);
    result.evidence.executions = [
      ...[firstAcquire, release].map(item => ({ exit: item.exit, argv: normalizedArgv(item.argv.slice(1), context) })),
      ...items.map(item => ({ exit: item.result.exit, argv: normalizedArgv(item.result.argv.slice(1), context) })),
    ];
    result.evidence.lease_acquisitions = context.leaseAcquisitions;
    return result;
  }

  if (task.id === 'allow-anchored-txn-112') {
    const ws = newWorkstream(context, 'eval-anchor');
    const artifact = `${ws.worktree}/anchor.txt`;
    materializeSetupFiles(context.root, [{ path: artifact, content: 'anchor' }]);
    const beforeCreate = vector(context);
    const create = mutate(context, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'implementation', '--point', 'implementation', '--workstream', ws.id, '--artifacts', JSON.stringify([artifact])]);
    const afterCreate = vector(context);
    const step = executableManifestStep(task, context);
    const final = observed(context, task, step.cmd, { stdin: step.stdin, expect: step.expect, setupFiles: step.setup_files });
    const result = resultFromObservation(task, context, final);
    result.evidence.executions = [
      { exit: create.exit, argv: normalizedArgv(create.argv.slice(1), context) },
      { exit: final.result.exit, argv: normalizedArgv(final.result.argv.slice(1), context) },
    ];
    result.evidence.anchored_event_observed = afterCreate.eventTypes.slice(beforeCreate.eventCount).includes('episode-new');
    return result;
  }

  const step = executableManifestStep(task, context);
  const item = observed(context, task, step.cmd, { stdin: step.stdin, expect: step.expect, setupFiles: step.setup_files });
  return resultFromObservation(task, context, item, task.fixture_actions.length > 0 ? { fixture_action_applied: true } : {});
}

export function seedHostTopology(task, { now = NOW } = {}) {
  // This host-only scenario verifies the measured deep-review claim/import
  // contract. Other deterministic scenarios keep their host-neutral reviewer.
  const context = setupContext(task, now, { reviewer: 'deep-review-loop' });
  const ws = newWorkstream(context, 'eval-primary');
  const maker = newMaker(context, ws, { name: 'host-review.txt' }); completeMaker(context, maker);
  return {
    context, workstreamId: ws.id, makerId: maker.id,
    expectedBinding: {
      run_id: context.runId,
      checker_episode_id: '002-deep-review',
      target_maker: maker.id,
      workstream_id: ws.id,
      point: 'implementation',
      reviewer_id: 'deep-review',
      review_source: 'imported-stdin',
      imported_verdict: 'APPROVE',
    },
  };
}
