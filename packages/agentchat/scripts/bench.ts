import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_TASKS, BENCH_SYSTEM_PROMPT, type BenchTask } from './bench-prompts.js';

export interface RunBenchOpts {
  label: string;
  url: string;
  model: string;
  authToken?: string;
  caPath?: string;
  /** Override one or more task fixtures (testing seam). */
  fixtureOverrides?: Partial<Record<BenchTask['id'], string>>;
}

export interface BenchResult {
  label: string;
  model: string;
  task: BenchTask['id'];
  description: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  answer?: string;
  groundTruth: string;
  latencyMs: number;
  error?: string;
}

function resolveFixture(scriptsDir: string, fixturePath: string): string {
  return resolve(scriptsDir, fixturePath);
}

export async function runBench(opts: RunBenchOpts): Promise<BenchResult[]> {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const results: BenchResult[] = [];

  for (const task of BENCH_TASKS) {
    const start = Date.now();
    try {
      const fixturePath = opts.fixtureOverrides?.[task.id]
        ? resolve(opts.fixtureOverrides[task.id]!)
        : resolveFixture(scriptsDir, task.fixturePath);
      if (!existsSync(fixturePath)) {
        throw new Error(`fixture not found: ${fixturePath}`);
      }
      const fixtureBody = readFileSync(fixturePath, 'utf8');
      const userContent = `--- File: ${task.fixtureLabel} ---\n${fixtureBody}\n\n---\n\n${task.question}`;
      const body = JSON.stringify({
        model: opts.model,
        temperature: 0,
        max_tokens: task.maxTokens,
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: 'system', content: BENCH_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.authToken) headers.authorization = `Bearer ${opts.authToken}`;
      const init: any = {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(120_000),
      };
      if (opts.caPath) init.tls = { ca: readFileSync(opts.caPath, 'utf8') };

      const res = await fetch(`${opts.url.replace(/\/$/, '')}/chat/completions`, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length === 0) throw new Error('empty response body');
      let json: any;
      try { json = JSON.parse(text); }
      catch { throw new Error(`non-JSON body: ${text.slice(0, 80)}`); }
      const msg = json?.choices?.[0]?.message;
      const answer = (msg?.content && msg.content.length > 0)
        ? msg.content
        : (msg?.reasoning_content ?? '');
      results.push({
        label: opts.label,
        model: opts.model,
        task: task.id,
        description: task.description,
        prompt_tokens: json?.usage?.prompt_tokens,
        completion_tokens: json?.usage?.completion_tokens,
        answer,
        groundTruth: task.groundTruth,
        latencyMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        label: opts.label,
        model: opts.model,
        task: task.id,
        description: task.description,
        groundTruth: task.groundTruth,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const label = flag('label');
  const url = flag('url');
  const model = flag('model') ?? 'local';
  const authToken = flag('auth-token');
  const caPath = flag('auth-cert');
  if (!label || !url) {
    console.error('usage: bun bench.ts --label NAME --url URL [--model M] [--auth-token T] [--auth-cert PATH]');
    process.exit(1);
  }
  const opts: RunBenchOpts = { label, url, model };
  if (authToken) opts.authToken = authToken;
  if (caPath) opts.caPath = caPath;
  const out = await runBench(opts);
  for (const r of out) console.log(JSON.stringify(r));
}
