#!/usr/bin/env node
import { materializeFromReceipt } from './lib/checker-bridge.mjs';

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || index === argv.length - 1) return null;
  return argv[index + 1];
}

const argv = process.argv.slice(2);
const receiptPath = argValue(argv, '--receipt');
const attemptId = argValue(argv, '--attempt-id');
const dest = argValue(argv, '--dest');
const cwdFlag = argValue(argv, '--cwd');
if (!receiptPath || !attemptId || !dest || !cwdFlag) {
  process.stderr.write('USAGE: bridge-finalize --cwd <dir> --receipt <file> --attempt-id <id> --dest <file>\n');
  process.exit(2);
}

let goalSubject = null;
try {
  const rawSubject = argValue(argv, '--goal-subject');
  if (argv.filter(value => value === '--goal-subject').length > 1) throw new Error('duplicate');
  if (rawSubject !== null) goalSubject = JSON.parse(rawSubject);
} catch { process.stderr.write('GOAL_BRIDGE_SUBJECT_INVALID\n'); process.exit(1); }
const result = materializeFromReceipt({
  goalSubject,
  receiptPath,
  attemptId,
  destPath: dest,
  cwdFlag,
  expectedSha256: argValue(argv, '--sha256') || undefined,
  stdoutPath: argValue(argv, '--stdout') || undefined,
  sidecarPath: argValue(argv, '--sidecar') || undefined,
});
if (!result.ok) {
  process.stderr.write(`${result.reason}\n`);
  process.exit(result.reason === 'usage' ? 2 : 1);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
