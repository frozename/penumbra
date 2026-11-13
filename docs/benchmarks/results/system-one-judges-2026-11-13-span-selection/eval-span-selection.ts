import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { reloadAgentChatConfig } from "../../../../packages/config/src/index.ts";
import { llmInvoke } from "../../../../packages/daemon/src/services/llm-invoke.ts";
import { resolveT2ExtractionJudge } from "../../../../packages/daemon/src/workers/t2-promotion.ts";
import { decodeSelection, selectionMessages, sourceUnits, SpanSelectionSchema } from "./span-selector.ts";

const argv=process.argv.slice(2), flag=(key:string)=>argv[argv.indexOf(key)+1];
const target=flag("--target"),split=flag("--split"),out=flag("--out");
if(!argv.includes("--live")||!argv.includes("--out")||existsSync(out)||!["granite","z13","qwen2b"].includes(target)||!["dev","test"].includes(split))throw new Error("Explicit --live, supported target/split and fresh --out required");
const privateRoot="/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-span-selection";
const corpusText=readFileSync(privateRoot+"/"+(split==="dev"?"development.jsonl":"heldout.jsonl"),"utf8");
const cases=corpusText.trim().split("\n").map(line=>JSON.parse(line));
const provenance=JSON.parse(readFileSync(privateRoot+"/provenance.json","utf8"));
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");
if(split==="test"){
 const freeze=JSON.parse(readFileSync(new URL("./candidate-freeze.json",import.meta.url),"utf8"));
 if(freeze.selectorSha256!==sha(readFileSync(new URL("./span-selector.ts",import.meta.url),"utf8"))||freeze.driverSha256!==sha(readFileSync(import.meta.filename,"utf8")))throw new Error("Candidate or driver changed after test freeze");
 if(freeze.testInputSha256!==sha(corpusText)||freeze.provenanceSha256!==sha(readFileSync(privateRoot+"/provenance.json","utf8")))throw new Error("Test capture changed after freeze");
 const labels=readFileSync(privateRoot+"/labels-adjudicated.jsonl","utf8").trim().split("\n").map(line=>JSON.parse(line));
 if(labels.length!==cases.length||cases.some(c=>labels.filter(l=>l.caseId===c.id&&l.inputSha256===c.sha256).length!==1))throw new Error("Independent held-out label mismatch");
}
const model=target==="granite"?"granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf":target==="qwen2b"?"qwen35-2b-eval":"Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf";
let baseUrl=target==="qwen2b"?"http://127.0.0.1:18945/v1":"http://127.0.0.1:18944/v1",apiKey="";
if(target==="z13"){
 const provider=JSON.parse(readFileSync(join(homedir(),".config/penumbra/opencode-z13/opencode.json"),"utf8")).provider["llamactl-z13"].options;
 baseUrl=provider.baseURL;apiKey=provider.apiKey;
 if(baseUrl!=="http://127.0.0.1:7944/v1")throw new Error("Inspect changed proxy");
}
const options={baseUrl,model,apiKey,maxTokens:2048,requestTimeoutMs:30000,candidateSelection:"ordered",requestExtras:target==="granite"?{}:{chat_template_kwargs:{enable_thinking:false}}};
const directory=mkdtempSync(join(tmpdir(),"penumbra-span-eval-")),nativeFetch=globalThis.fetch;
const rows:any[]=[],calls:any[]=[],diagnostics:unknown[]=[];
let currentCase="preflight",variant="preflight";
const startedAt=new Date().toISOString();
const save=()=>writeFileSync(out,JSON.stringify({target,model,split,startedAt,updatedAt:new Date().toISOString(),inputSha256:sha(corpusText),selectorSha256:sha(readFileSync(new URL("./span-selector.ts",import.meta.url),"utf8")),method:"Configured extraction factories for full legacy/source prompts; existing llmInvoke for JSON-mode source-range selection with strict post-validation. IDs are not grammar-constrained at sampling. Complete input capped30k chars/512passages; no clipping or chunking. Body/title/metadata are deterministic source copies. No production writes. DEV is exposed and not acceptance evidence.",rows,calls,diagnostics,applied:false},null,2)+"\n",{mode:0o600});
writeFileSync(out,"{}\n",{flag:"wx",mode:0o600});
globalThis.fetch=Object.assign(async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
 if(String(input)!==baseUrl+"/chat/completions")throw new Error("Unexpected network request refused");
 const start=performance.now(),request=JSON.parse(String(init?.body));
 try{const response=await nativeFetch(input,init);let data:any;try{data=await response.clone().json();}catch{}
 calls.push({caseId:currentCase,variant,at:new Date().toISOString(),status:response.status,latencyMs:performance.now()-start,requestSha256:sha(String(init?.body)),maxTokens:request.max_tokens,returnedModel:data?.model,usage:data?.usage,finishReason:data?.choices?.[0]?.finish_reason,reasoningChars:data?.choices?.[0]?.message?.reasoning_content?.length??0,raw:data?.choices?.[0]?.message?.content});return response;
 }catch(error){calls.push({caseId:currentCase,variant,error:String(error),latencyMs:performance.now()-start});throw error;}
},{preconnect:nativeFetch.preconnect});
try{
 process.env.PENUMBRA_CONFIG_DIR=directory;process.env.PENUMBRA_T2_EXTRACTION_ROLE="span-eval";process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS="30000";
 writeFileSync(join(directory,"agents.yaml"),JSON.stringify({agents:[{name:"span-eval",adapter:"openai-compat-http",api_provider:"local",roles:["span-eval"],options}]}),{mode:0o600});
 writeFileSync(join(directory,"routing.yaml"),"default_roles: {}\n");writeFileSync(join(directory,"quotas.yaml"),"providers: []\n");reloadAgentChatConfig();
 let pool:any;const log={info:(...v:unknown[])=>diagnostics.push(v),warn:(...v:unknown[])=>diagnostics.push(v),error:(...v:unknown[])=>diagnostics.push(v)};
 const extraction=resolveT2ExtractionJudge({log}as any,value=>{pool=value;});if(!extraction||!pool)throw new Error("Extraction pool unavailable");
 for(const chosen of(split==="dev"?["selection"]:["legacy-full","selection"])){
  variant=chosen;process.env.PENUMBRA_T2_SOURCE_TRANSCRIPT=chosen==="grounded-full"?"1":"0";
  for(const c of cases){currentCase=c.id;pool.resetTickHealth();const start=performance.now(),before=calls.length;
   try{let value:unknown;
    if(chosen==="selection"){
     if(!provenance[c.id]||provenance[c.id].unavailable)throw new Error("source provenance unavailable");
     const response=await llmInvoke({baseUrl,model,auth:apiKey?{source:"bearer",token:apiKey}:{source:"none"},options:{...options,maxTokens:256},messages:selectionMessages(c.transcript,provenance[c.id]),schema:SpanSelectionSchema,timeoutMs:30000,temperature:0});
     if(!response.ok)throw new Error(response.reason+": "+response.failureMessage);
     value=decodeSelection(response.value,c.transcript,provenance[c.id]);
    }else value=await extraction(c.transcript);
    rows.push({id:c.id,variant,kind:c.kind??"historical",inputSha256:c.sha256,latencyMs:performance.now()-start,value,calls:calls.length-before,...(chosen==="selection"?{passages:sourceUnits(c.transcript).length}:{})});
   }catch(error){rows.push({id:c.id,variant,kind:c.kind??"historical",inputSha256:c.sha256,latencyMs:performance.now()-start,error:String(error),calls:calls.length-before});}
   save();const result=rows.at(-1);console.log(JSON.stringify({target,split,variant,id:c.id,latencyMs:result.latencyMs,error:result.error,proposals:result.value?.length}));
  }
 }
}finally{globalThis.fetch=nativeFetch;rmSync(directory,{recursive:true,force:true});save();}
