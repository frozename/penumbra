import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readSourceTranscriptContent } from "../../../../packages/core/src/writers/t2-source-transcript.ts";

const root="/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-span-selection";
const rows=(file:string)=>readFileSync(file,"utf8").trim().split("\n").map(line=>JSON.parse(line));
const old=rows("/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-source-input/historical.jsonl");
const cases=[...rows(root+"/development.jsonl").map(c=>({...c,...(c.kind==="exposed-historical"?{source:old.find(o=>"dev-"+o.id===c.id).source}:{} )})),...rows(root+"/review-packet.jsonl")];
const db=new Database("/Users/aimastermind/.penumbra/db.sqlite",{readonly:true,create:false});db.exec("PRAGMA query_only=ON;PRAGMA busy_timeout=3000");
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");
const metadata:Record<string,unknown>={};
for(const c of cases){
 if(!c.source?.sessionId){metadata[c.id]={sha256:c.sha256,allowedRanges:[{start:0,end:c.transcript.length}],scope:"controlled premise, not a historical human-authorship claim"};continue;}
 const events=db.query<{event_type:string;payload_json:string|null;payload_summary:string|null},[string]>("SELECT event_type,payload_json,payload_summary FROM t0_events WHERE session_id=? AND event_type IN('agent-prompt','agent-response')ORDER BY ts ASC").all(c.source.sessionId);
 let transcript="";const allowedRanges:{start:number;end:number}[]=[];
 for(const event of events){const content=readSourceTranscriptContent(event.payload_json,event.payload_summary);if(!content)continue;if(transcript)transcript+="\n\n";const start=transcript.length;transcript+=(event.event_type==="agent-prompt"?"User: ":"Assistant: ")+content;if(event.event_type==="agent-response")allowedRanges.push({start,end:transcript.length});}
 metadata[c.id]=sha(transcript)===c.sha256?{sha256:c.sha256,allowedRanges,scope:"captured agent responses only; agent prompts remain visible context"}:{sha256:c.sha256,allowedRanges:[],unavailable:true,scope:"source identity changed or absent; fail closed"};
}
db.close();
writeFileSync(root+"/provenance.json",JSON.stringify(metadata,null,2)+"\n",{flag:"wx",mode:0o600});
writeFileSync(root+"/heldout.jsonl",readFileSync(root+"/review-packet.jsonl"),{flag:"wx",mode:0o600});
writeFileSync(new URL("./provenance-manifest.json",import.meta.url),JSON.stringify({method:"Read-only T0 event metadata re-rendered through the actual source reader, exact input hash checked. Agent-response extents are eligible; agent-prompt extents remain context only. No role labels parsed from text to grant eligibility. Controlled dialogue is a declared synthetic premise. No gold label or model result used. Implementation parent received only counts/hashes, not held-out bodies.",cases:cases.length,unavailable:Object.values(metadata).filter((v:any)=>v.unavailable).length,metadataSha256:sha(readFileSync(root+"/provenance.json","utf8")),heldoutInputSha256:sha(readFileSync(root+"/heldout.jsonl","utf8"))},null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({cases:cases.length,unavailable:Object.values(metadata).filter((v:any)=>v.unavailable).length,heldoutBodiesDisclosed:false}));
