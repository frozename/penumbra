import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { load as parseYaml } from 'js-yaml';
import { BENCH_TASKS } from './bench-prompts.js';

/**
 * bench-grade.ts
 *
 * Helper to grade bench-2 JSONL results using a judge LLM (default: mac-mini gemma E4B).
 * Dispatches one grading prompt per task in parallel.
 */

interface GradeOpts {
  inputPath: string;
  url: string;
  model: string;
  authToken?: string;
  caPath?: string;
  fetch?: typeof fetch;
}

export interface GradeResult {
  task: string;
  verdict: string;
  model: string;
  label: string;
}

export interface GradeResultsOpts {
  results: any[];
  url: string;
  model: string;
  authToken?: string;
  caPath?: string;
  fetch?: typeof fetch;
  /** Abort signal for cancelling the grading. */
  signal?: AbortSignal;
}

export async function gradeResults(opts: GradeResultsOpts): Promise<GradeResult[]> {
  const groundTruthMap = new Map(BENCH_TASKS.map(t => [t.id, t.groundTruth]));
  const fetcher = opts.fetch ?? fetch;

  const promises = opts.results.map(async (entry): Promise<GradeResult> => {
    const groundTruth = groundTruthMap.get(entry.task);
    if (!groundTruth) {
      throw new Error(`unknown task ID: ${entry.task}`);
    }

    const prompt = `Grade ONE bench-2 task. Output STRICTLY one of: PASS / FAIL / PARTIAL — nothing else, no period, no explanation.

GROUND TRUTH:
${groundTruth}

MODEL ANSWER:
${entry.answer ?? '(no answer)'}`;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.authToken) headers.authorization = `Bearer ${opts.authToken}`;

    const body = JSON.stringify({
      model: opts.model,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    const init: any = {
      method: 'POST',
      headers,
      body,
      signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    };

    if (opts.caPath && existsSync(opts.caPath)) {
      init.tls = { ca: readFileSync(opts.caPath, 'utf8') };
    }

    try {
      const res = await fetcher(`${opts.url.replace(/\/$/, '')}/chat/completions`, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: any = await res.json();
      const verdict = (json.choices?.[0]?.message?.content || 'FAIL').trim().toUpperCase();
      
      // Sanitize verdict to strictly PASS/FAIL/PARTIAL
      let finalVerdict = 'FAIL';
      if (verdict.includes('PASS')) finalVerdict = 'PASS';
      else if (verdict.includes('PARTIAL')) finalVerdict = 'PARTIAL';

      return {
        task: entry.task,
        verdict: finalVerdict,
        model: entry.model,
        label: entry.label,
      };
    } catch (err) {
      return {
        task: entry.task,
        verdict: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
        model: entry.model,
        label: entry.label,
      };
    }
  });

  return Promise.all(promises);
}

async function runGrade(opts: GradeOpts): Promise<GradeResult[]> {
  if (!existsSync(opts.inputPath)) {
    throw new Error(`input file not found: ${opts.inputPath}`);
  }

  const lines = readFileSync(opts.inputPath, 'utf8').trim().split('\n');
  const results = lines.filter(l => l.trim()).map(l => JSON.parse(l));

  return gradeResults({
    results,
    url: opts.url,
    model: opts.model,
    authToken: opts.authToken,
    caPath: opts.caPath,
    fetch: opts.fetch,
  });
}

function getApiKeyFromConfig(): string | undefined {
  const configPath = join(homedir(), '.config', 'agentchat', 'agentchat.yaml');
  if (existsSync(configPath)) {
    try {
      const config = parseYaml(readFileSync(configPath, 'utf8')) as any;
      const executor = config?.agents?.find?.((a: any) => a?.name === 'executor');
      return executor?.options?.apiKey;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    return undefined;
  };

  const inputPath = flag('input') || argv[0];
  if (!inputPath || inputPath.startsWith('--')) {
    console.error('usage: bun bench-grade.ts --input <jsonl-path> [--url <url>] [--model <model>] [--auth-token <token>] [--auth-cert <path>]');
    process.exit(1);
  }

  const url = flag('url') || 'https://192.168.68.76:7843/v1';
  const model = flag('model') || 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf';
  const authToken = flag('auth-token') || getApiKeyFromConfig();
  const caPath = flag('auth-cert') || '/tmp/llamactl-mac-mini-ca.pem';

  const results = await runGrade({ inputPath, url, model, authToken, caPath });
  for (const r of results) {
    console.log(JSON.stringify(r));
  }
}

export { runGrade };
