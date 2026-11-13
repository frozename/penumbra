import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const base='http://127.0.0.1:18944';
const granite='granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf', nano='d3-nano-eval';
const root=JSON.parse(readFileSync(join(import.meta.dir,'router-nano-process.json'),'utf8')).pid;
const events:any[]=[], samples:any[]=[]; let stop=false;
function save(){writeFileSync(join(import.meta.dir,'router-concurrency.json'),JSON.stringify({method:'Synthetic lifecycle/queue checks, no production routing or writes; stock router one-hot and idle sleep; not a quality benchmark',root,events,samples},null,2)+'\n');}
function event(kind:string,details:object={}){events.push({ts:Date.now()/1000,kind,...details});save();console.log(kind);}
async function request(path:string,body?:object,signal=AbortSignal.timeout(90_000)){
 const t=performance.now();
 const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal});
 const data=await response.json();
 if(!response.ok)throw new Error('HTTP '+response.status+' '+JSON.stringify(data));
 return {data,latencyMs:performance.now()-t};
}
const gen=(signal?:AbortSignal, long=false)=>request('/v1/chat/completions',{model:granite,messages:[{role:'user',content:long?'Write a detailed 2000-word technical description of SQLite transaction isolation.':'Return JSON with key ok and boolean true.'}],max_tokens:long?3000:32,temperature:0,...(!long?{response_format:{type:'json_object'}}:{})},signal);
const decision=(signal?:AbortSignal)=>request('/v1/systemone',{model:nano,state:'We keep SQLite writes in one transaction because a partial write must never be visible.',questions:{durable:{type:'noul',instructions:'Does the text state a reusable design decision with rationale?'}}},signal);
const sampler=(async()=>{while(!stop){
 const t=performance.now();let health:any;
 try{const r=await fetch('http://127.0.0.1:51257/health',{signal:AbortSignal.timeout(2000)});health={status:r.status,wallMs:performance.now()-t};}catch(e){health={error:String(e),wallMs:performance.now()-t};}
 const rows=execFileSync('ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8'}).trim().split('\n').map(l=>l.trim().split(/\s+/).map(Number));
 const processes=rows.filter(r=>r[0]===root||r[1]===root).map(([pid,ppid,rss])=>({pid,ppid,rssBytes:rss*1024}));
 const models=await request('/models');
 samples.push({ts:Date.now()/1000,health,processes,aggregateRssBytes:processes.reduce((a,p)=>a+p.rssBytes,0),models:models.data.data.map((m:any)=>({model:m.id,status:m.status.value}))});save();
 await Bun.sleep(1000);
}})();
async function footprint(kind:string){
 const rows=execFileSync('ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(l=>l.trim().split(/\s+/).map(Number)).filter(([p,pp])=>p===root||pp===root);
 const values=rows.map(([pid])=>{let lines:string[]=[];try{lines=execFileSync('vmmap',['-summary',String(pid)],{encoding:'utf8',timeout:15000}).split('\n').filter(l=>/Physical footprint/.test(l));}catch(e){lines=[String(e)];}return{pid,lines};});event(kind,{values});
}
try{
 event('start');await footprint('idle_before');
 const typecheck=Bun.spawn(['flock',String(process.env.HOME)+'/.penumbra/locks/heavy-job.lock','bun','run','--cwd','packages/integrations/typesafe','typecheck'],{stdout:'pipe',stderr:'pipe'});
 const latencies:{kind:string,ms:number}[]=[];
 for(let i=0;i<8;i++){
  const results=await Promise.allSettled([gen(),decision()]);
  results.forEach((r,j)=>{if(r.status==='rejected')throw r.reason;latencies.push({kind:j?'native':'generative',ms:r.value.latencyMs});});
  event('concurrent_pair',{iteration:i,results:latencies.slice(-2)});
 }
 const code=await typecheck.exited;const stderr=await new Response(typecheck.stderr).text();const stdout=await new Response(typecheck.stdout).text();
 event('typecheck',{exitCode:code,stdout,stderr});if(code!==0)throw new Error('development typecheck failed');
 await footprint('after_concurrent_load');
 event('complete',{latencies});
} catch(e){event('failed',{error:String(e)});process.exitCode=1;}finally{stop=true;await sampler;save();}
