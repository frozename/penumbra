import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadShadowInputs, observeInputs } from '../../../../scripts/system-one-judge-observe.ts';
import { openReplayDb } from '../../../../scripts/typesafe-shadow-eval.ts';
if(!process.argv.includes('--live'))throw new Error('Explicit --live required');
const root=import.meta.dir, config=JSON.parse(readFileSync(join(root,'nano-config.json'),'utf8'));
const controller=new AbortController();
process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
function guard(){const s=JSON.parse(readFileSync(join(root,'guard-state.json'),'utf8'));if(s.abort||Date.now()/1000-s.criticalMeasuredAt>2.5)throw new Error('guard_failed_or_stale');return s;}
let state:any;
for(let i=0;i<160&&!controller.signal.aborted;i++){try{state=guard();if(state.phase==='live')break;}catch{}await Bun.sleep(250);}
if(state?.phase!=='live')throw new Error('no live phase');
const db=openReplayDb('/Users/aimastermind/.penumbra/db.sqlite');
let inputs;try{inputs=loadShadowInputs(db,{since:'2026-09-16T00:00:00Z',limit:20});}finally{db.close();}
const startedAt=new Date().toISOString();
writeFileSync(join(root,'input-manifest.json'),JSON.stringify({selectedAt:startedAt,source:'Existing historical audit rows, read-only, exact body SHA matched, reused development/operational evidence; not hidden acceptance data',cases:inputs.map(x=>({decisionId:x.decisionId,subjectId:x.subjectId,historicalAt:x.historicalAt,inputSha256:createHash('sha256').update(x.body).digest('hex')}))},null,2)+'\n');
writeFileSync(join(root,'observations.jsonl'),'',{flag:'wx',mode:0o600});
let attempted=0,answered=0,endedBy='inputs_exhausted',nextAllowed=0;
try{
 for(const input of inputs){
  while(true){
   state=guard();
   if(controller.signal.aborted)throw new Error('operator_or_guard_abort');
   if(state.phase!=='live'||Date.now()>=state.liveEndsAtMs){endedBy='duration';break;}
   if(state.admission==='admit'&&Date.now()>=nextAllowed)break;
   await Bun.sleep(250);
  }
  if(endedBy==='duration')break;
  const admittedAt=new Date().toISOString();attempted++;nextAllowed=Date.now()+30000;
  await observeInputs([input],{live:true,config,fetch,intervalMs:30000,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(Math.max(1,state.liveEndsAtMs-Date.now()))]),writeDecision:row=>{
   if(row.failure===null)answered++;
   appendFileSync(join(root,'observations.jsonl'),JSON.stringify({...row,admittedAt,admissionAvailableBytes:state.availableFreeInactiveBytes,sourceKind:'historical_replay',simultaneousInference:false,independentLabel:null})+'\n');
   console.log(JSON.stringify({attempted,answered,latencyMs:row.latencyMs,failure:row.failure}));
  }});
 }
}catch(error){endedBy=String(error);controller.abort();}
const result={startedAt,endedAt:new Date().toISOString(),endedBy,selected:inputs.length,attempted,answered,mode:'shadow',applied:false,daemonShadowEnabled:false,productionDbOpenedReadonly:true,labelsSupplied:false,methodology:'Guarded paced historical replay through existing observer and strict client; no new live cases or independent accuracy claim. Resource admission per request; critical sensor separate from slow GPU sampling.'};
writeFileSync(join(root,'observer-run.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
if(!['inputs_exhausted','duration'].includes(endedBy))process.exitCode=2;
