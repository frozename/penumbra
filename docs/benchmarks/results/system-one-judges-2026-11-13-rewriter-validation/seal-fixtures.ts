import {createHash} from "node:crypto";
import {readFileSync,writeFileSync} from "node:fs";
import {parseBenchCases} from "../../../../scripts/rewriter-bench.ts";

const privateRoot="/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-rewriter-validation";
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const read=(name:string)=>readFileSync(privateRoot+"/"+name,"utf8");
const jsonl=(name:string)=>read(name).trim().split("\n").map(line=>JSON.parse(line));
const freeze=JSON.parse(readFileSync(new URL("./candidate-freeze.json",import.meta.url),"utf8"));
if(sha(read("review-packet.jsonl"))!==freeze.packetSha256)throw new Error("Packet changed");
const packet=jsonl("review-packet.jsonl"),labels=jsonl("labels-adjudicated.jsonl");
if(packet.length!==111||labels.length!==111)throw new Error("Complete adjudicated111case cohort required");
const fixtures=packet.map(c=>{
 const matching=labels.filter(l=>l.caseId===c.id&&l.inputSha256===c.inputSha256);
 if(matching.length!==1)throw new Error("Label identity mismatch");
 return {id:c.id,title:c.title,body_first_200:c.body_first_200,inputSha256:c.inputSha256,stratum:c.stratum,expected_verdict:matching[0].verdict};
});
const encoded=fixtures.map(c=>JSON.stringify(c)).join("\n")+"\n";
parseBenchCases(encoded);
writeFileSync(privateRoot+"/fixtures.jsonl",encoded,{flag:"wx",mode:0o600});
const strata=Object.fromEntries([...new Set(fixtures.map(c=>c.stratum))].map(stratum=>[String(stratum),{cases:fixtures.filter(c=>c.stratum===stratum).length,...Object.fromEntries(["query","skip","uncertain"].map(verdict=>[verdict,fixtures.filter(c=>c.stratum===stratum&&c.expected_verdict===verdict).length]))}]));
const manifest={sealedAt:new Date().toISOString(),method:"Frozen code and source-checked independently adjudicated inputs; current production200character excerpt shape. Cached model decisions never used as gold. Independent AI labels share a model family; not human adjudication or population prevalence.",cases:fixtures.length,strata,fixtureSha256:sha(encoded),labelSha256:sha(read("labels-adjudicated.jsonl")),packetSha256:sha(read("review-packet.jsonl")),reviewASha256:sha(read("review-a.jsonl")),reviewBSha256:sha(read("review-b.jsonl")),adjudicationSha256:sha(read("label-adjudication.json")),caseHashes:fixtures.map(c=>({caseId:c.id,stratum:c.stratum,inputSha256:c.inputSha256,expectedVerdict:c.expected_verdict}))};
writeFileSync(new URL("./test-manifest.json",import.meta.url),JSON.stringify(manifest,null,2)+"\n",{flag:"wx"});
const controlled=fixtures.filter(c=>c.stratum==="controlled").map(c=>({...c,label:labels.find(l=>l.caseId===c.id)}));
writeFileSync(new URL("./controlled-fixtures.jsonl",import.meta.url),controlled.map(c=>JSON.stringify(c)).join("\n")+"\n",{flag:"wx"});
console.log(JSON.stringify({...manifest,caseHashes:undefined}));
