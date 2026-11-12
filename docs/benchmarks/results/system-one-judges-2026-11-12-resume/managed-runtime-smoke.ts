import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createLocalDecisionClient } from '../../../../packages/integrations/typesafe/src/local-decision.ts';
if(!process.argv.includes('--live'))throw new Error('Explicit --live required');
const base='http://127.0.0.1:18944',events:object[]=[];
const record=(kind:string,details:object={})=>{events.push({ts:Date.now()/1000,kind,...details});writeFileSync(join(import.meta.dir,'managed-runtime-smoke.json'),JSON.stringify({method:'Dedicated launchd router recovery; synthetic control inputs only; no production writes',events},null,2)+'\n');console.log(kind);};
function pid(){const s=execFileSync('launchctl',['print','gui/501/dev.penumbra.local-judges'],{encoding:'utf8'});const m=s.match(/\n\s+pid = (\d+)/);if(!m)throw new Error('no managed process');return Number(m[1]);}
const client=createLocalDecisionClient({baseUrl:base,model:'d3-nano-eval',revision:'ggml-org/vllm-d3-nano-GGUF@f2256dfaff5b8337e8bf67ca064aeef18ee14a79/vllm-d3-nano-Q8_0.gguf',fetch,timeoutMs:5000,maxRetries:0,maxConcurrency:1});
const evaluate=()=>client.evaluate({state:'We keep SQLite writes in one transaction because a partial write must never be visible.',questions:{durable:{type:'noul',instructions:'Does the text state a reusable design decision with rationale?'},category:{type:'choice',instructions:'Choose the type of text.',criteria:{decision:'Reusable technical design choice',progress:'Temporary build progress'}},quality:{type:'score',instructions:'Rate the specificity of the stated rationale.',criteria:['No rationale','Vague rationale','Specific rationale']}}});
for(let i=0;i<120;i++){try{const h=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});if(h.ok)break;}catch{}await Bun.sleep(250);}
record('start',{pid:pid()});
const first=await evaluate();record('before_restart',{result:first});if(!first.ok)throw new Error('native strict validation failed');
const before=pid();const oldChildren=execFileSync('pgrep',['-P',String(before)],{encoding:'utf8'}).trim().split('\n').map(Number);
const args=execFileSync('ps',['-p',String(before),'-o','args='],{encoding:'utf8'});if(!args.includes('/Users/aimastermind/.local/share/penumbra/inference/system-one-llama/2cbe0ec-http-only/bin/llama-server --models-preset'))throw new Error('root identity guard');
process.kill(before,'SIGKILL');record('injected_root_failure',{pid:before,oldChildren});
const down=await evaluate();record('while_down',{result:down});if(down.ok)throw new Error('expected transport abstention during restart');
const start=performance.now();let after:number|undefined;
for(let i=0;i<180;i++){await Bun.sleep(250);try{const p=pid();const r=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});if(p!==before&&r.ok){after=p;break;}}catch{}}
if(!after)throw new Error('launchd did not recover');record('root_recovered',{pid:after,readinessMs:performance.now()-start});
const second=await evaluate();record('after_restart',{result:second});if(!second.ok)throw new Error('post-restart strict inference failed');
const remaining=oldChildren.filter(p=>{try{process.kill(p,0);return true;}catch{return false;}});record('old_children',{remaining});if(remaining.length)throw new Error('orphan runtime child');
const g=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(30_000),body:JSON.stringify({model:'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf',messages:[{role:'user',content:'Return JSON with key ok and boolean true.'}],response_format:{type:'json_object'},max_tokens:32,temperature:0})});
const data=await g.json();record('granite_after_restart',{status:g.status,raw:data});if(!g.ok||JSON.parse(data.choices[0].message.content).ok!==true)throw new Error('Granite inference failed');
record('complete');
