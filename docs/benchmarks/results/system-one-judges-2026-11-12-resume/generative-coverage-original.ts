import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { T2_PROMOTION_PROMPT, parseJudgeResponse } from '../../../../packages/daemon/src/workers/t2-promotion.ts';
import { T2MemoryExtractionSchema } from '../../../../packages/core/src/writers/t2.ts';
import { buildDreamQueryRewritePrompt } from '../../../../packages/daemon/src/dreaming/dream-rewriter-prompt.ts';
import { REWRITE_RESPONSE_SCHEMA } from '../../../../packages/daemon/src/dreaming/dream-rewriter-prompt-content.ts';

const base = process.env.JUDGE_ROUTER_TEST_URL ?? 'http://127.0.0.1:18944';
const model = 'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf';
const rows: unknown[] = [];
const out = join(import.meta.dir, 'generative-coverage-original.json');
const examples = [
  {id:'decision', transcript:'User: Keep the public API backward compatible for the next two releases. Our deployed clients update quarterly, so breaking the API early would strand those clients. Assistant: We will preserve compatibility for two releases because client update schedules are outside our control.', positive:true, terms:/client|compatib|quarter/i},
  {id:'preference', transcript:'User: Always show dates in YYYY-MM-DD format in reports. I compare reports across regions and slash-formatted dates cause ambiguity. Assistant: I will use ISO dates in reports to avoid regional ambiguity.', positive:true, terms:/date|YYYY|ISO/i},
  {id:'ephemeral', transcript:'User: Run the tests and commit this patch. Assistant: Ten tests passed in32ms. Commit abc1234 was created. The build is green and this task is complete.', positive:false},
  {id:'long-mixed', transcript:'Build step started. Temporary progress:23 percent. Test run finished.\n'.repeat(180)+'\nUser: Audit records must be append-only for seven years because our contractual audit requirements prohibit rewriting historical records. Assistant: We will retain immutable audit history for seven years to satisfy that contractual obligation.', positive:true, terms:/audit|seven|7|immutab/i},
];
const rewrites = [
  {id:'public-sqlite',title:'SQLite WAL checkpoint starvation',bodyFirst200:'Long-running read transactions can prevent a WAL checkpoint from completing. We need public guidance on SQLite checkpoint modes and busy handling.',expected:'query'},
  {id:'public-backpressure',title:'Bounded queues and backpressure',bodyFirst200:'An overloaded asynchronous service needs a bounded work queue and explicit backpressure to avoid unbounded memory growth.',expected:'query'},
  {id:'internal',title:'dispatch_land resolveBranchName',bodyFirst200:'Update handoff.project_id handling inside the private resolveBranchName helper for task ID8dcf42.',expected:'skip'},
];
async function chat(messages: {role:string;content:string}[], maxTokens: number) {
  const response = await fetch(base+'/v1/chat/completions', {method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(90_000),body:JSON.stringify({model,messages,response_format:{type:'json_object'},temperature:0,max_tokens:maxTokens})});
  if (!response.ok) throw new Error('HTTP'+response.status);
  const data = await response.json() as {choices:{message:{content:string};finish_reason:string}[]};
  if (data.choices[0]?.finish_reason === 'length') throw new Error('truncated');
  return data.choices[0]?.message.content ?? '';
}
if (!process.argv.includes('--live')) throw new Error('Explicit --live required; no automatic production inference');
for (const c of examples) {
  const start=performance.now();
  try {
    const raw=await chat([{role:'user',content:T2_PROMOTION_PROMPT.replace('{{TRANSCRIPT}}',c.transcript)}],16384);
    const memories=T2MemoryExtractionSchema.array().parse(parseJudgeResponse(raw));
    const passed=c.positive ? memories.some(m=>m.promote!==false&&c.terms?.test(m.body)) : memories.length===0;
    rows.push({id:c.id,workload:'extraction',passed,latencyMs:performance.now()-start,memories,raw});
  } catch(error) {rows.push({id:c.id,workload:'extraction',passed:false,error:String(error),latencyMs:performance.now()-start});}
  writeFileSync(out,JSON.stringify({model,base,method:'Synthetic output-semantic regression, existing prompt/parser/schemas; no production database writes or independent quality-acceptance claim',rows},null,2)+'\n');
}
for (const c of rewrites) {
  const start=performance.now();
  try {
    const raw=await chat(buildDreamQueryRewritePrompt(c),512);
    const answer=REWRITE_RESPONSE_SCHEMA.parse(JSON.parse(raw));
    rows.push({id:c.id,workload:'rewriter',passed:answer.kind===c.expected,expected:c.expected,answer,raw,latencyMs:performance.now()-start});
  } catch(error) {rows.push({id:c.id,workload:'rewriter',passed:false,error:String(error),latencyMs:performance.now()-start});}
  writeFileSync(out,JSON.stringify({model,base,method:'Synthetic output-semantic regression, existing prompt/parser/schemas; no production database writes or independent quality-acceptance claim',rows},null,2)+'\n');
}
process.stdout.write(JSON.stringify(rows)+'\n');
