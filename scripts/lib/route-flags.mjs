export const LOCATOR = Object.freeze(['project-root', 'run-id', 'now']);
export const FENCE = Object.freeze(['owner', 'generation']);
export const FORBIDDEN_REVIEW = Object.freeze([
  'source', 'workstream', 'workstream-id', 'workstream_id', 'point',
  'target-maker', 'target_maker', 'reviewer-id', 'reviewer_id',
  'review-source', 'review_source', 'runtime', 'attempt-id', 'attempt_id', 'attemptId',
]);

const L = LOCATOR;
const F = FENCE;
const R = FORBIDDEN_REVIEW;

function route(allow, extra = {}) {
  return Object.freeze({ allow: Object.freeze([...allow]), ...extra });
}

export const ROUTE_FLAGS = Object.freeze({
  'path resolve': route(['target', 'workstream', ...L]),
  validate: route([...L]),
  'detect-plugins': route([...L]),
  'recipe-match': route(['goal', ...L]),
  'run list': route([...L]),
  'run resolve': route(['purpose', 'cwd', ...L]),
  'root diagnose': route(['candidate-project-root', ...L]),
  'root rebind': route([
    'candidate-project-root', 'actor', 'confirm',
    'expected-stored-root-digest', 'expected-binding-generation', ...F, ...L,
  ]),
  'root recover': route([
    'candidate-project-root', 'actor', 'confirm',
    'expected-stored-root-digest', 'expected-binding-generation', ...F, ...L,
  ]),
  'root recovery acquire': route([
    'candidate-project-root', 'capsule', 'runtime', 'binding-generation', ...F, ...L,
  ]),
  'runtime-executable diagnose': route(['runtime', 'path', ...L]),
  'runtime-executable approve': route([
    'runtime', 'path', 'canonical-path', 'sha256', 'actor', 'confirm', ...F, ...L,
  ]),
  'launcher-executable diagnose': route(['kind', 'path', ...L]),
  'launcher-executable approve': route([
    'kind', 'path', 'canonical-path', 'sha256', 'actor', 'confirm', ...F, ...L,
  ]),
  'init-run': route([
    'runtime', 'session-profile', 'model', 'effort', 'continuation',
    'goal', 'protocol', 'recipe', 'review', ...L,
  ]),
  'next-action': route(['unattended', 'json', ...L], { unread: Object.freeze(['json']) }),
  'resume-command': route([...L]),
  tick: route(['unattended', 'mode', ...L]),
  'checkpoint emit': route(['runtime', ...F, ...L]),
  'checkpoint inspect': route(['json', ...L]),
  'checkpoint observe': route([
    'checkpoint', 'trigger', 'runtime', 'trusted-postcompact-stdin', 'json', ...F, ...L,
  ]),
  'checkpoint restore': route([
    'checkpoint', 'runtime', 'admission', 'source', 'confirm-manual-compact', 'json', ...F, ...L,
  ]),
  'lease check': route([...F, ...L]),
  'lease acquire': route(['runtime', 'expect-generation', 'attempt-id', ...F, ...L]),
  'lease release': route([...F, ...L]),
  'workstream new': route(['title', 'branch', 'worktree', 'depends-on', ...F, ...L]),
  'workstream set': route(['id', 'status', ...F, ...L]),
  'workstream terminal': route(['id', 'status', 'confirm', 'proof', ...F, ...L]),
  'episode new': route(['plugin', 'role', 'kind', 'point', 'workstream', 'artifacts', ...F, ...L]),
  'episode record': route(['id', 'status', 'artifacts', 'proof', 'routing', ...F, ...L]),
  'episode abandon': route(['id', 'reason', 'confirm', ...F, ...L]),
  'review configure': route(['profile', 'source-checker', 'confirm', ...F, ...L]),
  'review dispatch': route(['point', 'workstream', 'independent-subagent', 'routing', ...F, ...L]),
  'review record': route(['episode', 'verdict', 'report', 'findings', ...R, ...F, ...L], {
    rejected: R,
  }),
  'review import': route(['stdin', ...R, ...F, ...L], { rejected: R }),
  'review bridge-probe': route(['json', ...L], { unread: Object.freeze(['json']) }),
  'handoff emit': route(['boundary-event', 'headless', 'reason', 'trigger', ...F, ...L]),
  respawn: route(['dry-run', 'headless', 'attended', 'timeout-ms', ...F, ...L]),
  'state get': route(['field', 'json', ...L], { unread: Object.freeze(['json']) }),
  'state patch': route(['field', 'value', ...F, ...L]),
  pause: route(['reason', 'mode', ...F, ...L]),
  recover: route(['confirm', 'supersede-affinity', 'reason', ...F, ...L]),
  'recovery acquire': route(['capsule', 'runtime', ...F, ...L]),
  'adapter resolve': route(['protocol', 'task', 'tier', 'verb', ...L]),
  'budget check': route([...L]),
  'budget record': route(['turns', 'tokens', ...F, ...L]),
  'budget extend': route(['confirm', 'reason', 'turns', 'tokens', 'wallclock-sec', ...F, ...L]),
  'comprehension status': route([...L]),
  'comprehension ack': route(['episode', 'actor', 'confirm', ...F, ...L]),
  'breaker check': route([...L]),
  'breaker reset': route(['confirm', ...F, ...L]),
  insights: route(['run', 'json', ...L], { unread: Object.freeze(['json']) }),
  'insights latest': route(['json', ...L], { unread: Object.freeze(['json']) }),
  'insights emit': route([...F, ...L]),
  'spawn-style probe-desktop': route([...L]),
  'spawn-style offer-desktop': route(['nonce', 'ttl-sec', ...F, ...L]),
  'spawn-style confirm-desktop': route(['nonce', ...F, ...L]),
  'spawn-style decline-desktop': route([...F, ...L]),
  'spawn-style reset-desktop': route([...F, ...L]),
  'attended-launch approve': route(['style', 'confirm', ...F, ...L]),
  'attended-launch revoke': route(['confirm', ...F, ...L]),
  'session-profile set': route(['session-profile', 'model', 'effort', ...F, ...L]),
  'detect-terminal': route([...F, ...L]),
  finish: route(['status', 'confirm', 'report', 'proof', ...F, ...L]),
});

export function allowedNames(spec) {
  const rejected = new Set(spec.rejected || []);
  return [...new Set([...LOCATOR, ...spec.allow])].filter((name) => !rejected.has(name)).sort();
}

export function vocabulary(spec) {
  return new Set([...LOCATOR, ...spec.allow]);
}

// These routes keep handler-owned fence-first / exact grammar. The table still
// documents them for help and the landing gate, but the dispatcher must not
// reject unknown flags before the handler's own polarity.
export const HANDLER_OWNED_GRAMMAR = Object.freeze(new Set([
  'path resolve',
  'checkpoint emit', 'checkpoint inspect', 'checkpoint observe', 'checkpoint restore',
  'review configure',
  'recover',
  'recovery acquire',
  'attended-launch approve', 'attended-launch revoke',
]));

export function consumedPositionalCount(command, argv) {
  const first = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  if (command === 'root' && first === 'recovery') {
    return argv[1] && !argv[1].startsWith('--') ? 2 : 1;
  }
  return first ? 1 : 0;
}

export function levenshtein(left, right) {
  const rows = left.length;
  const cols = right.length;
  const grid = Array.from({ length: rows + 1 }, (_, index) => {
    const row = new Array(cols + 1);
    row[0] = index;
    return row;
  });
  for (let col = 0; col <= cols; col += 1) grid[0][col] = col;
  for (let row = 1; row <= rows; row += 1) {
    for (let col = 1; col <= cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      grid[row][col] = Math.min(
        grid[row - 1][col] + 1,
        grid[row][col - 1] + 1,
        grid[row - 1][col - 1] + cost,
      );
    }
  }
  return grid[rows][cols];
}

export function suggestFlag(unknown, allowed) {
  if (typeof unknown !== 'string' || unknown.length > 64) return null;
  let best = [];
  let bestDistance = Infinity;
  for (const name of allowed) {
    const distance = levenshtein(unknown, name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = [name];
    } else if (distance === bestDistance) {
      best.push(name);
    }
  }
  if (bestDistance <= 2 && best.length === 1) return best[0];
  return null;
}

export function formatUnknownFlag(routeKey, flagName, spec) {
  const allowed = allowedNames(spec);
  const suggestion = suggestFlag(flagName, allowed);
  const lines = [
    `USAGE: unknown flag --${flagName} for route \`${routeKey}\``,
  ];
  if (suggestion) lines.push(`  did you mean: --${suggestion}`);
  lines.push(`  allowed: ${allowed.map((name) => `--${name}`).join(' ')}`);
  return lines.join('\n');
}

export function renderHelp(argv) {
  const first = argv[0];
  const topic = first === 'help' ? argv[1] : null;
  if (topic && !Object.keys(ROUTE_FLAGS).some((key) => key === topic || key.startsWith(`${topic} `))) {
    return { code: 2, stderr: `unknown subcommand: ${topic}`, stdout: '' };
  }
  const keys = Object.keys(ROUTE_FLAGS).filter((key) => {
    if (!topic) return true;
    return key === topic || key.startsWith(`${topic} `);
  });
  const lines = topic
    ? [`Usage: deep-loop ${topic} [verb] [flags]`, '']
    : ['Usage: deep-loop <command> [verb] [flags]', '', 'Routes:'];
  for (const key of keys) {
    const flags = allowedNames(ROUTE_FLAGS[key]).map((name) => `--${name}`).join(' ');
    lines.push(`  ${key}`);
    lines.push(`    ${flags}`);
  }
  return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
