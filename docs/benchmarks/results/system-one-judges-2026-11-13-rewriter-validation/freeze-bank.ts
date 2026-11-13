import {Database} from "bun:sqlite";
import {createHash} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {FEW_SHOT_EXAMPLES} from "../../../../packages/daemon/src/dreaming/dream-rewriter-prompt-content.ts";

const privateRoot="/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-rewriter-validation";
mkdirSync(privateRoot,{mode:0o700});
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const db=new Database("/Users/aimastermind/.penumbra/db.sqlite",{readonly:true,create:false});
db.exec("PRAGMA query_only=ON;PRAGMA busy_timeout=3000");
const rows=db.query<any,[]>("SELECT memory_id,title,SUBSTR(body,1,200) AS body_first_200,updated_at,created_at FROM t2_memories WHERE kind!='brief' AND retired_at IS NULL AND title IS NOT NULL AND title!='' AND created_at<'2026-11-10' ORDER BY memory_id").all();
const cached=db.query<any,[]>("SELECT t2_memory_id,memory_updated_at_ms FROM dream_query_rewrites").all();
const excluded=new Set(FEW_SHOT_EXAMPLES.map(example=>sha(JSON.stringify(example.input))));
const records=rows.map(row=>({...row,inputSha256:sha(JSON.stringify({title:row.title,body_first_200:row.body_first_200})),sampleKey:sha("rewriter-validation-v1:"+row.memory_id),cacheRows:cached.filter(c=>c.t2_memory_id===row.memory_id)})).filter(row=>!excluded.has(row.inputSha256)).sort((a,b)=>a.sampleKey.localeCompare(b.sampleKey));
const seen=new Set<string>(),bank:any[]=[],base:any[]=[];
for(const row of [...records.filter(row=>row.cacheRows.length),...records.filter(row=>!row.cacheRows.length)]){
 if(seen.has(row.inputSha256))continue;
 const stratum=row.cacheRows.length?"cached-current":"sampled-current";
 const record={id:"rewrite-"+String(bank.length+1).padStart(3,"0"),title:row.title,body_first_200:row.body_first_200,inputSha256:row.inputSha256,stratum,source:{memoryId:row.memory_id,updatedAt:row.updated_at,createdAt:row.created_at,cacheVersionMatchesCurrent:row.cacheRows.some(c=>c.memory_updated_at_ms===Date.parse(row.updated_at))}};
 bank.push(record);seen.add(row.inputSha256);
 if(stratum==="cached-current"||base.filter(c=>c.stratum==="sampled-current").length<64)base.push(record);
 if(bank.length>=240)break;
}
db.close();
const encode=(rows:any[])=>rows.map(row=>JSON.stringify(row)).join("\n")+"\n";
writeFileSync(privateRoot+"/candidate-bank.jsonl",encode(bank),{flag:"wx",mode:0o600});
writeFileSync(privateRoot+"/base-cohort.jsonl",encode(base),{flag:"wx",mode:0o600});
const manifest={capturedAt:new Date().toISOString(),method:"Read-only eligible current T2 inputs, pre-Nov10 creation. Exact SQL SUBSTR(body,1,200) matches production P4 candidate shape; body truth is not inferred. All recoverable cache-associated inputs followed by64 deterministic SHA-sampled uncached inputs; cached verdicts/models are never captured or treated as labels. Cached inputs are reconstructed current notes; version match is recorded. Remaining bank is available only to an independent enrichment curator. Exact prompt few-shot duplicates excluded. Not an exact historical replay or production-prevalence estimate.",eligibleNotes:rows.length,cachedRows:cached.length,bank:bank.length,base:base.length,cachedCases:base.filter(c=>c.stratum==="cached-current").length,cachedCurrentVersionMatches:base.filter(c=>c.source.cacheVersionMatchesCurrent).length,sampledCases:base.filter(c=>c.stratum==="sampled-current").length,bankSha256:sha(encode(bank)),baseSha256:sha(encode(base)),caseHashes:base.map(c=>({id:c.id,inputSha256:c.inputSha256,stratum:c.stratum}))};
writeFileSync(new URL("./bank-manifest.json",import.meta.url),JSON.stringify(manifest,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({...manifest,caseHashes:undefined}));
