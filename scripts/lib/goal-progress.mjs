import { pathKeyWithin, sameResolvedPath } from './path-portable.mjs';
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
// Host-local liveness evidence is deliberately separate from completion proof.
// New episode IDs, prose, logs and budget changes never buy another interval.
function milestones(loop) {
 const result=[];
 for(const e of loop.episodes??[]) {
  if(e.role==='maker'&&e.status==='done')result.push(`maker:${e.id}:done`);
  if(e.execution?.phase==='returned')result.push(`execution:${e.id}:${e.execution.stage??''}:returned`);
  if(e.role==='checker'&&['approved','rejected'].includes(e.status))result.push(`checker:${e.target_maker}:${e.status}`);
 }
 for(const w of loop.workstreams??[]) {
  if(['ready','merged'].includes(w.status))result.push(`workstream:${w.id}:ready`);
  for(const r of w.requirement_ids??[])result.push(`requirement:${r}`);
 }
 for(const o of loop.goal_obligations??[])if(o.status==='resolved')result.push(`obligation:${o.id}:resolved`);
 for(const r of loop.goal_reviews??[])if(r.status==='approved')result.push(`goal:${r.id}:approved`);
 return result;
}
export function goalProgressKey(loop,action) {
 const episode=(loop.episodes??[]).find(e=>e.id===action.episode_id);
 if(action.episode_id&&(episode?.execution||['dispatch_maker','fix_episode','resume_maker'].includes(action.type)))return `episode:${action.episode_id}`;
 if(['finish','finish_run','write_final_report'].includes(action.type))return 'report:final';
 if(action.workstream_id)return `setup:${action.workstream_id}`;
 const mapped=new Set((loop.workstreams??[]).flatMap(w=>w.requirement_ids??[]));
 return `setup:unmapped:${(loop.goal_contract?.requirements??[]).map(r=>r.id).filter(id=>!mapped.has(id)).sort().join(',')}`;
}
export function createGoalProgressWatchdog({noProgressTurns=3,limits={no_progress_turns:noProgressTurns,setup_turns:3,activity_extension_turns:2},initial={}}={}) {
 const seen=new Set(milestones(initial)),states=new Map();
 const state=key=>{if(!states.has(key))states.set(key,{turns:0,activity:false,diagnostic:false});return states.get(key);};
 const before=(key='default')=>{const s=state(key),limit=(key.startsWith('setup:')?limits.setup_turns:limits.no_progress_turns)+(s.activity?limits.activity_extension_turns:0);return {allowed:s.turns<limit||!s.diagnostic,diagnostic:s.turns>=limit&&!s.diagnostic,unproductive_turns:s.turns,phase:key.startsWith('setup:')?'setup':'maker'};};
 return {before,
  after(loop,{activityChanged=false,key='default'}={}) {
   const s=state(key),next=milestones(loop),progressed=next.some(x=>!seen.has(x));next.forEach(x=>seen.add(x));
   if(progressed){s.turns=0;s.activity=false;s.diagnostic=false;return;}
   if(before(key).diagnostic)s.diagnostic=true;
   s.turns++;s.activity ||= activityChanged;
  },
 };
}
export { goalRecoveryDiagnostic } from './goal-recovery-diagnostic.mjs';

// Only already-declared regular artifacts participate. No recursive tree scan,
// FIFOs, symlink escapes, logs or candidate-declared progress assertions.
export function boundArtifactActivity(root,loop) {
 const paths=new Set((loop.episodes??[]).flatMap(e=>[...(e.expected_artifacts??[]),...(e.artifacts??[]),...(e.execution?.artifacts??[])]).filter(p=>typeof p==='string'&&!p.startsWith('.deep-loop/')));
 const hashes={};let total=0;
 for(const path of [...paths].sort().slice(0,64)) {
  let fd;
  try {
   const canonicalRoot=realpathSync(root),file=resolve(canonicalRoot,path);
   if(!pathKeyWithin(canonicalRoot,file))continue;
   hashes[path]=null; // Absence of an already-declared artifact is observable.
   const real=realpathSync(file);
   if(!sameResolvedPath(real,file)||!pathKeyWithin(realpathSync(root),real))continue;
   fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   const stat=fstatSync(fd);if(!stat.isFile()||stat.size>1024*1024||total+stat.size>4*1024*1024)continue;
   const bytes=Buffer.alloc(stat.size);const count=readSync(fd,bytes,0,bytes.length,0);total+=count;
   if(count!==stat.size)continue;
   hashes[path]=createHash('sha256').update(bytes).digest('hex');
  } catch {} finally {if(fd!==undefined)closeSync(fd);}
 }
 return hashes;
}
export const changedBoundArtifact=(before,after)=>Object.keys(before).some(path=>after[path]!==undefined&&before[path]!==after[path]);
