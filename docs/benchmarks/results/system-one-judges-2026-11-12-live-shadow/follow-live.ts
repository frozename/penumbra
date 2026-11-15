import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadShadowInputs, observeInputs, type ShadowInput } from '../../../../scripts/system-one-judge-observe.ts';
import { openReplayDb } from '../../../../scripts/typesafe-shadow-eval.ts';
if(!process.argv.includes('--live'))throw new Error('Explicit --live required');
const root=import.meta.dir;
const plan=JSON.parse(readFileSync(join(root,'plan.json'),'utf8'));
const config=JSON.parse(readFileSync(join(root,'nano-config.json'),'utf8'));
const guardPath=join(root,'guard-state.json');
const controller=new AbortController();
const events:object[]=[];
const pending:ShadowInput[]=[];
const seen=new Set<string>();
let attempted=0,answered=0,expired=0,discovered=0,nextAllowed=0,maxReadMs=0;
let since='',endedBy='duration';
const event=(kind:string,detail:object={})=>{const e={at:new Date().toISOString(),kind,...detail};events.push(e);writeFileSync(join(root,'observer-events.json'),JSON.stringify(events,null,2)+'\n');console.log(JSON.stringify(e));};
process.once('SIGINT',()=>{endedBy='interrupted';controller.abort();});
process.once('SIGTERM',()=>{endedBy='guard_or_operator_stop';controller.abort();});
function guard(){
 const s=JSON.parse(readFileSync(guardPath,'utf8'));
 if(Date.now()-s.ts*1000>2500||s.abort||!Number.isFinite(s.availableFreeInactiveBytes))throw new Error('stale_or_failed_guard');
 return s;
}
while(!controller.signal.aborted){
 try{const s=guard();if(s.phase==='live'){since=s.liveSince;break;}if(s.phase==='aborted')throw new Error('baseline_guard_failed');}catch(e){if(events.length===0)event('awaiting_baseline');}
 await Bun.sleep(250);
}
if(!since)throw new Error('no admitted live phase');
const db=openReplayDb(plan.dbPath);
writeFileSync(join(root,'observations.jsonl'),'',{flag:'wx',mode:0o600});
event('live_started',{since,method:'Follow only new hash-matched P1 audit records. Existing ballots are recorded observations, not ground truth or simultaneous inference. Daemon local shadow stays off.'});
let nextPoll=0;
try{
 while(!controller.signal.aborted){
  const s=guard();
  if(s.phase!=='live'||Date.now()>=s.liveEndsAtMs)break;
  if(attempted>=plan.maxAttempts){endedBy='attempt_cap';break;}
  if(Date.now()>=nextPoll){
   const start=performance.now();
   const inputs=loadShadowInputs(db,{since,limit:1000}).sort((a,b)=>a.historicalAt.localeCompare(b.historicalAt));
   maxReadMs=Math.max(maxReadMs,performance.now()-start);nextPoll=Date.now()+5000;
   for(const input of inputs){
    const hash=createHash('sha256').update(input.body).digest('hex');
    if(seen.has(hash))continue;
    seen.add(hash);pending.push(input);discovered++;
    event('new_input',{decisionId:input.decisionId,subjectId:input.subjectId,inputSha256:hash,incumbentRecordedAt:input.historicalAt});
   }
  }
  while(pending[0]&&Date.now()-Date.parse(pending[0].historicalAt)>plan.maxEventAgeMs){const input=pending.shift()!;expired++;event('expired_before_admission',{decisionId:input.decisionId});}
  if(pending.length&&Date.now()>=nextAllowed&&s.healthStatus===200&&s.availableFreeInactiveBytes>=plan.admitAvailableBytes){
   const input=pending.shift()!;
   const admittedAt=new Date().toISOString();
   nextAllowed=Date.now()+plan.minIntervalMs;attempted++;
   const result=await observeInputs([input],{live:true,config,fetch,intervalMs:plan.minIntervalMs,signal:controller.signal,writeDecision:row=>{
    if(row.failure===null)answered++;
    const counted=(row.incumbentVotes??[]).filter(v=>!v.abstained);
    const out={...row,admittedAt,observationDelayMs:Date.parse(admittedAt)-Date.parse(input.historicalAt),recordedSite:'dream.p1.promotion',incumbentBallotsContemporaryToWindow:true,simultaneousInference:false,independentLabel:null,countedIncumbentVotes:counted.length,comparableQuorum:counted.length>=2,admissionAvailableBytes:s.availableFreeInactiveBytes};
    appendFileSync(join(root,'observations.jsonl'),JSON.stringify(out)+'\n');
    event('candidate_result',{decisionId:row.decisionId,probability:row.probability,candidatePromote:row.candidatePromote,failure:row.failure,latencyMs:row.latencyMs,countedIncumbentVotes:counted.length});
   }});
   if(result.interrupted)break;
  }
  await Bun.sleep(250);
 }
}catch(error){endedBy=String(error);event('observer_stopped',{reason:endedBy});controller.abort();}
finally{
 db.close();
 const result={startedAt:since,endedAt:new Date().toISOString(),endedBy,discovered,attempted,answered,expired,unattempted:pending.length,maxReadMs,mode:'shadow',applied:false,daemonShadowEnabled:false,productionDatabaseOpenedReadonly:true,qualityLabelsSupplied:false,config,methodology:'Bounded event-following sidecar using existing loader/observer. Only audit records created during live phase; no historical backfill or synthesized workload. Incumbent ballots recorded shortly earlier, not simultaneous calls or ground truth.'};
 writeFileSync(join(root,'observer-run.json'),JSON.stringify(result,null,2)+'\n');event('complete',result);
}
