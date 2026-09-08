import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { makeGoalFixture } from './helpers/goal-fixture.mjs';
import { driveGoalRun } from '../scripts/lib/goal-host.mjs';
const review={points:['implementation'],reviewer:'subagent-checker',mode:'same-model',flags:[],converge:true,max_review_rounds:5,require_human_ack:false};
test('owned host SIGKILL leaves a lost binding that refuses every automatic restart before model dispatch',{skip:process.platform==='win32'},async()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high',review});
 try {
  const source=`import { driveGoalRun } from ${JSON.stringify(new URL('../scripts/lib/goal-host.mjs',import.meta.url).href)};\nawait driveGoalRun({root:${JSON.stringify(f.root)},runId:${JSON.stringify(f.runId)},now:'2026-09-06T00:00:00Z',timeoutMs:30000,resolveCheckerSkill:()=>({skill:{canonical_path:'/fixture/SKILL.md'}}),revalidateExecutable:()=>({canonical_path:process.execPath}),preflight:()=>({ok:true,executable:{canonical_path:process.execPath},codexHome:{canonical_path:'/tmp/fixture-codex'}}),runProcess:()=>process.kill(process.pid,'SIGKILL')});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:30000});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  let probes=0;
  for(let i=0;i<2;i++) {
   const r=await driveGoalRun({root:f.root,runId:f.runId,now:'2026-09-06T00:00:00Z',preflight:()=>{probes++;throw Error('unexpected probe');}});
   assert.equal(r.ok,false);assert.notEqual(f.state().status,'completed');
   assert.ok(['already-driving','owner-provider-binding-unavailable','run-paused'].includes(r.reason),JSON.stringify(r));
  }
  assert.equal(probes,0);
 } finally {f.cleanup();}
});
