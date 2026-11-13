import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { T2_PROMOTION_PROMPT, parseJudgeResponse } from '../../../../packages/daemon/src/workers/t2-promotion.ts';
import { T2MemoryExtractionSchema } from '../../../../packages/core/src/writers/t2.ts';
import { buildDreamQueryRewritePrompt } from '../../../../packages/daemon/src/dreaming/dream-rewriter-prompt.ts';
import { REWRITE_RESPONSE_SCHEMA } from '../../../../packages/daemon/src/dreaming/dream-rewriter-prompt-content.ts';

const flag = (name: string) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const target = flag('--target');
const out = process.argv.includes('--out') ? flag('--out') : '';
if (!out || !existsSync(dirname(out)) || existsSync(out)) throw new Error('Provide a fresh --out file in an existing directory');
const targets = {
  granite: { base: 'http://127.0.0.1:18944/v1', model: 'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf' },
  macbook: { base: 'http://127.0.0.1:7944/v1', model: 'kapitsa-q36-35b-a3b-4bit', config: 'opencode-macbook-kapitsa', provider: 'llamactl-macbook' },
  z13: { base: 'http://127.0.0.1:7944/v1', model: 'Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf', config: 'opencode-z13', provider: 'llamactl-z13' },
};
if (!Object.hasOwn(targets, target)) throw new Error('Choose --target granite|macbook|z13');
const selected = targets[target as keyof typeof targets];
let apiKey: string | undefined;
if ('config' in selected) {
  const config = JSON.parse(readFileSync(join(homedir(), '.config/penumbra', selected.config, 'opencode.json'), 'utf8'));
  const options = config.provider[selected.provider].options;
  if (options.baseURL.replace(/\/$/, '') !== selected.base) throw new Error('Configured proxy changed; inspect before inference');
  apiKey = options.apiKey;
}
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
const rows: Record<string, unknown>[] = [];
const startedAt = new Date().toISOString();
const timeoutMs = 30_000;
const requestExtras = process.argv.includes('--no-thinking') ? {chat_template_kwargs:{enable_thinking:false}} : {};
const method = 'Synthetic output-semantic canary using existing production prompts/parser/schemas. Sequential, no retries, no production writes. Published controls are not independent quality acceptance. Extraction output cap 2048 (earlier Granite canary 16384); rewrite cap 512. Optional --no-thinking is a per-request template hint, not a server configuration change.';
function save() {
  writeFileSync(out, JSON.stringify({target, ...selected, startedAt, updatedAt:new Date().toISOString(), timeoutMs, concurrency:1, temperature:0, responseFormat:'json_object', requestExtras, method, promptSha256:createHash('sha256').update(T2_PROMOTION_PROMPT).digest('hex'), rows},null,2)+'\n');
}
writeFileSync(out, '{}\n', {flag:'wx'});
async function chat(messages: {role:string;content:string}[], maxTokens: number) {
  const response = await fetch(selected.base+'/chat/completions', {
    method:'POST', headers:{'Content-Type':'application/json', ...(apiKey ? {Authorization:'Bearer '+apiKey} : {})},
    signal:AbortSignal.timeout(timeoutMs),
    body:JSON.stringify({model:selected.model,messages,response_format:{type:'json_object'},temperature:0,max_tokens:maxTokens,...requestExtras}),
  });
  if (!response.ok) throw new Error('HTTP '+response.status);
  const data = await response.json() as {model?:string;usage?:unknown;timings?:unknown;choices:{message:{content?:string;reasoning_content?:string};finish_reason:string}[]};
  return {raw:data.choices[0]?.message.content ?? '', reasoningChars:data.choices[0]?.message.reasoning_content?.length ?? 0, finishReason:data.choices[0]?.finish_reason ?? null, returnedModel:data.model ?? null, usage:data.usage ?? null, timings:data.timings ?? null};
}
const only = process.argv.includes('--case') ? flag('--case') : null;
const cases = [
  ...examples.map(c=>({id:c.id, workload:'extraction', maxTokens:2048, messages:[{role:'user',content:T2_PROMOTION_PROMPT.replace('{{TRANSCRIPT}}',c.transcript)}], validate:(raw:string)=>{
    const memories=T2MemoryExtractionSchema.array().parse(parseJudgeResponse(raw));
    return {passed:c.positive ? memories.some(m=>m.promote!==false&&c.terms?.test(m.body)) : memories.length===0, memories};
  }})),
  ...rewrites.map(c=>({id:c.id, workload:'rewriter', maxTokens:512, messages:buildDreamQueryRewritePrompt(c), validate:(raw:string)=>{
    const answer=REWRITE_RESPONSE_SCHEMA.parse(JSON.parse(raw));
    return {passed:answer.kind===c.expected, expected:c.expected, answer};
  }})),
].filter(c=>!only||c.id===only);
if (cases.length===0) throw new Error('Unknown case');
for (const c of cases) {
  const start=performance.now();
  let transportError=false;
  const row: Record<string,unknown> = {id:c.id,workload:c.workload,maxTokens:c.maxTokens,inputSha256:createHash('sha256').update(JSON.stringify(c.messages)).digest('hex')};
  try {
    Object.assign(row,await chat(c.messages,c.maxTokens));
    row.latencyMs=performance.now()-start;
    if (row.finishReason==='length') throw new Error('truncated');
    if (typeof row.raw!=='string'||!row.raw.trim()) throw new Error('empty content');
    Object.assign(row,c.validate(row.raw));
  } catch(error) {
    row.passed=false;
    row.error=String(error);
    row.latencyMs ??= performance.now()-start;
    transportError=!('raw' in row);
  }
  rows.push(row);
  save();
  process.stdout.write(JSON.stringify({target,id:c.id,passed:row.passed,latencyMs:row.latencyMs,error:row.error,finishReason:row.finishReason})+'\n');
  if (transportError) break;
}
