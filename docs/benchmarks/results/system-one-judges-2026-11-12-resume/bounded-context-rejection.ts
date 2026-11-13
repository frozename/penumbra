import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalDecisionClient } from '../../../../packages/integrations/typesafe/src/local-decision.ts';
if(!process.argv.includes('--live'))throw new Error('Explicit --live required');
const client=createLocalDecisionClient({baseUrl:'http://127.0.0.1:18944',model:'d3-nano-eval',revision:'ggml-org/vllm-d3-nano-GGUF@f2256dfaff5b8337e8bf67ca064aeef18ee14a79/vllm-d3-nano-Q8_0.gguf',fetch,maxConcurrency:1,timeoutMs:5000,maxRetries:0});
const start=performance.now();const result=await client.evaluate({state:'Temporary build progress, no durable conclusion. '.repeat(800),questions:{durable:{type:'noul',instructions:'Does this text contain a reusable design decision with rationale?'}}});
const evidence={method:'Explicit oversized synthetic input at managed2048 context; assert abstention rather than silent truncation',latencyMs:performance.now()-start,result};writeFileSync(join(import.meta.dir,'bounded-context-rejection.json'),JSON.stringify(evidence,null,2)+'\n');if(result.ok)throw new Error('oversized request unexpectedly answered');console.log(JSON.stringify(evidence));
