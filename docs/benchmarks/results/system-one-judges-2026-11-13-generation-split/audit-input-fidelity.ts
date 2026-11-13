import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import { T2Promotion } from '../../../../packages/core/src/writers/t2.ts';
import { TestEmbedder } from '../../../../packages/core/src/testing/index.ts';

const privateRoot='/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-generation';
const cases=readFileSync(privateRoot+'/historical.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
const source=new Database('/Users/aimastermind/.penumbra/db.sqlite',{readonly:true,create:false});
source.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=3000');
const local=new Database(':memory:');
local.exec('CREATE TABLE t1_rollups(rollup_id TEXT,session_id TEXT,project_id TEXT,user_id TEXT,started_at TEXT,ended_at TEXT,origin TEXT,failed_promotion_attempts INTEGER DEFAULT 0,t2_promoted_at TEXT);CREATE TABLE t0_events(event_type TEXT,payload_summary TEXT,payload_json TEXT,session_id TEXT,ts TEXT)');
const rows:unknown[]=[];
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
for(const c of cases){
 const events=source.query<{event_type:string;payload_summary:string|null;payload_json:string|null;ts:string},[string]>("SELECT event_type,payload_summary,payload_json,ts FROM t0_events WHERE session_id=? AND event_type IN ('agent-prompt','agent-response') ORDER BY ts ASC").all(c.source.sessionId);
 async function capture(dropSummaries:boolean){
  local.exec('DELETE FROM t1_rollups;DELETE FROM t0_events');
  local.run('INSERT INTO t1_rollups(rollup_id,session_id,project_id,user_id,started_at,ended_at) VALUES(?,?,NULL,\'evaluation\',?,?)',[c.source.rollupId,c.source.sessionId,c.source.startedAt,c.source.startedAt]);
  for(const e of events)local.run('INSERT INTO t0_events VALUES(?,?,?,?,?)',[e.event_type,dropSummaries?null:e.payload_summary,e.payload_json,c.source.sessionId,e.ts]);
  let input='';
  const promotion=new T2Promotion({db:local,embedder:new TestEmbedder({dim:384}),clock:()=>new Date('2026-11-13'),uuid:()=> 'capture',minTranscriptChars:0,llm:value=>{input=value;throw new Error('capture_done');}});
  try{await promotion.promoteRollup(c.source.rollupId);}catch(error){if(!(error instanceof Error)||error.message!=='capture_done')throw error;}
  return input;
 }
 const current=await capture(false),raw=await capture(true);
 rows.push({caseId:c.id,events:events.length,summary240Count:events.filter(e=>e.payload_summary?.length===240).length,currentChars:current.length,rawFallbackChars:raw.length,frozenCurrentMatch:sha(current)===c.sha256,currentSha256:sha(current),rawFallbackSha256:sha(raw),rawFallbackLonger:raw.length>current.length,rawFallbackEmpty:raw.length===0});
}
source.close();local.close();
writeFileSync(new URL('./input-fidelity-audit.json',import.meta.url),JSON.stringify({method:'Read-only source; actual T2Promotion transcript builder in an in-memory capture DB. Compare existing summary-first policy with counterfactual summary=NULL raw fallback. No source policy changed, no model inference, no production writes. Length differences do not establish that raw payloads are complete or trustworthy.',rows},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(rows));
