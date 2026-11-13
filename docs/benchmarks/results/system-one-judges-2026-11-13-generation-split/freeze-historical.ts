import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { T2Promotion } from '../../../../packages/core/src/writers/t2.ts';
import { TestEmbedder } from '../../../../packages/core/src/testing/index.ts';

const directory = '/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-generation';
mkdirSync(directory, {recursive:true,mode:0o700});
const source = new Database('/Users/aimastermind/.penumbra/db.sqlite', {readonly:true,create:false});
source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=3000');
const rolls = source.query<{rollup_id:string;session_id:string;started_at:string;project_id:string|null},[]>("SELECT rollup_id,session_id,started_at,project_id FROM t1_rollups WHERE started_at<'2026-11-10' ORDER BY started_at DESC,rollup_id LIMIT 600").all();
const eventQuery=source.query<{event_type:string;payload_summary:string|null;payload_json:string|null;ts:string},[string]>("SELECT event_type,payload_summary,payload_json,ts FROM t0_events WHERE session_id=? AND event_type IN ('agent-prompt','agent-response') ORDER BY ts ASC");
const local = new Database(':memory:');
local.exec('CREATE TABLE t1_rollups(rollup_id TEXT,session_id TEXT,project_id TEXT,user_id TEXT,started_at TEXT,ended_at TEXT,origin TEXT,failed_promotion_attempts INTEGER DEFAULT 0); CREATE TABLE t0_events(event_type TEXT,payload_summary TEXT,payload_json TEXT,session_id TEXT,ts TEXT)');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const cases: {id:string;transcript:string;sha256:string;stratum:string;source:{rollupId:string;sessionId:string;startedAt:string;projectId:string|null}}[]=[];
const counts={short:0,medium:0,long:0};
const seen=new Set<string>();
let excludedStudyContent=0;
for(const row of rolls){
  local.exec('DELETE FROM t1_rollups;DELETE FROM t0_events');
  local.run('INSERT INTO t1_rollups(rollup_id,session_id,project_id,user_id,started_at,ended_at) VALUES(?,?,?,\'evaluation\',?,?)',[row.rollup_id,row.session_id,row.project_id,row.started_at,row.started_at]);
  const events=eventQuery.all(row.session_id);
  for(const e of events)local.run('INSERT INTO t0_events VALUES(?,?,?,?,?)',[e.event_type,e.payload_summary,e.payload_json,row.session_id,e.ts]);
  let transcript='';
  const promotion=new T2Promotion({db:local,embedder:new TestEmbedder({dim:384}),clock:()=>new Date('2026-11-13'),uuid:()=> 'capture',llm:(value)=>{transcript=value;throw new Error('capture_done');}});
  try{await promotion.promoteRollup(row.rollup_id);}catch(error){if(!(error instanceof Error)||error.message!=='capture_done')throw error;}
  if(!transcript||seen.has(sha(transcript)))continue;
  if(/system[- ]one|d3[- ]nano|system-one-judge|7b78ffab|4eead179/i.test(transcript)){excludedStudyContent++;continue;}
  const stratum=transcript.length<2000?'short':transcript.length<8000?'medium':'long';
  if(counts[stratum]>=8)continue;
  seen.add(sha(transcript));counts[stratum]++;
  cases.push({id:'historical-'+String(cases.length+1).padStart(2,'0'),transcript,sha256:sha(transcript),stratum,source:{rollupId:row.rollup_id,sessionId:row.session_id,startedAt:row.started_at,projectId:row.project_id}});
  if(cases.length===24)break;
}
source.close();local.close();
writeFileSync(directory+'/historical.jsonl',cases.map(c=>JSON.stringify(c)).join('\n')+'\n',{flag:'wx',mode:0o600});
const manifest={method:'Read-only production SELECT; invoke actual T2Promotion transcript construction/truncation in a two-table in-memory capture database; sentinel failure writes only to in-memory DB. Latest pre-November10 rollups, up to8 unique inputs per length stratum from600, exclude current System One study content before inference. Not population-random or unseen future data.',counts,cases:cases.length,excludedStudyContent,privatePath:directory+'/historical.jsonl',inputSha256:sha(cases.map(c=>JSON.stringify(c)).join('\n')+'\n'),caseHashes:cases.map(c=>({id:c.id,sha256:c.sha256,stratum:c.stratum,chars:c.transcript.length}))};
writeFileSync(new URL('./historical-manifest.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,counts,excludedStudyContent}));
