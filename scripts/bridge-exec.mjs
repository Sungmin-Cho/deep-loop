#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { bindBridgeExec } from './lib/checker-bridge.mjs';

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || index === argv.length - 1) return null;
  return argv[index + 1];
}

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
if (split === -1) {
  process.stderr.write('USAGE: bridge-exec --cwd <dir> --sidecar <file> --dispatcher <dispatch_agent.py> --mechanism <attested> --direction <to_claude|to_openai> --model <id> --effort <native> --prompt <text> -- python3 <dispatcher> run ...\n');
  process.exit(2);
}
const flags = argv.slice(0, split);
const supervisorArgv = argv.slice(split + 1);
const bound = bindBridgeExec({
  cwdFlag: argValue(flags, '--cwd'),
  sidecar: argValue(flags, '--sidecar'),
  dispatcher: argValue(flags, '--dispatcher'),
  mechanism: argValue(flags, '--mechanism'),
  direction: argValue(flags, '--direction'),
  model: argValue(flags, '--model'),
  effort: argValue(flags, '--effort'),
  prompt: argValue(flags, '--prompt'),
  supervisorArgv,
  home: homedir(),
  env: process.env,
});
if (!bound.ok) {
  const code = bound.reason === 'usage' ? 2 : 1;
  process.stderr.write(`${bound.reason}\n`);
  process.exit(code);
}

writeFileSync(bound.sidecar, `${JSON.stringify(bound.sidecarPayload)}\n`, { flag: 'wx' });

const child = spawn(bound.spawnArgv[0], bound.spawnArgv.slice(1), {
  cwd: bound.cwd,
  stdio: 'inherit',
  env: process.env,
});
child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
