import { checkGoalRun } from '../scripts/lib/goal-host.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeGoalFixture } from './helpers/goal-fixture.mjs';
test('static goal check needs no lease and leaves exact state/log bytes intact',()=>{
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high'});
 try {
  assert.equal(f.cli(['budget','record','--turns','1','--tokens','1']).exit,0);
  const files=['loop.json','event-log.jsonl'].map(p=>join(f.root,'.deep-loop','runs',f.runId,p));
  const before=files.map(p=>readFileSync(p));const checked=f.cli(['goal','drive','--check']);
  assert.equal(checked.exit,1,checked.stderr);assert.equal(checked.json?.model_availability,'unprobed');
  assert.equal(checked.json?.remediation?.applies_to,'new-run-only');
  files.forEach((p,i)=>assert.deepEqual(readFileSync(p),before[i]));
 }finally{f.cleanup();}
});

import { approveRuntimeExecutable } from '../scripts/lib/runtime-executable.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
test('static check confirms approved executable and unique installed doctrine without account/model probing',()=>{
 const review={points:['implementation'],reviewer:'subagent-checker',mode:'same-model',flags:[],converge:true,max_review_rounds:5,require_human_ack:false};
 const f=makeGoalFixture({runtime:'codex',model:'gpt-6-astra',effort:'high',review}),home=realpathSync(mkdtempSync(join(tmpdir(),'static-check-home-')));
 try {
  const executable=realpathSync(process.execPath);
  approveRuntimeExecutable(f.root,f.runId,{runtime:'codex',candidatePath:executable,expectedCanonicalPath:executable,expectedSha256:createHash('sha256').update(readFileSync(executable)).digest('hex'),actor:'human',confirm:true,fence:f.fence,now:'2026-09-06T00:00:00Z',runVersion:()=>({status:0,stdout:'codex-cli 0.153.4\n',stderr:''})});
  const plugin=join(home,'plugins/cache/market/deep-review/1.0.0');mkdirSync(join(plugin,'.codex-plugin'),{recursive:true});mkdirSync(join(plugin,'skills/deep-review-loop'),{recursive:true});
  writeFileSync(join(plugin,'.codex-plugin/plugin.json'),JSON.stringify({name:'deep-review',version:'1.0.0',skills:'./skills/'}));writeFileSync(join(plugin,'skills/deep-review-loop/SKILL.md'),'---\nname: deep-review-loop\n---\nRead-only criteria.');
  const loop=join(f.root,'.deep-loop/runs',f.runId,'loop.json'),before=readFileSync(loop);
  const check=()=>checkGoalRun({root:f.root,runId:f.runId,env:{CODEX_HOME:home},revalidateExecutable:()=>({canonical_path:executable,platform:process.platform})});
  const checked=check();
  assert.equal(checked.ok,true,JSON.stringify(checked));assert.equal(checked.model_availability,'unprobed');assert.match(checked.plan.doctrine_sha256,/^[0-9a-f]{64}$/);assert.deepEqual(readFileSync(loop),before);
  rmSync(join(plugin,'skills/deep-review-loop/SKILL.md'));
  const missing=check();assert.equal(missing.ok,false);assert.equal(missing.reason,'checker-skill-unavailable');
 }finally{f.cleanup();rmSync(home,{recursive:true,force:true});}
});
