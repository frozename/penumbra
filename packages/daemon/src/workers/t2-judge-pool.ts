import { readFileSync } from 'node:fs';
import type { T2MemoryExtraction } from '@penumbra/core';

export interface JudgeEntry {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  caPath?: string;
}

export interface JudgePoolOpts {
  judges: JudgeEntry[];
  log: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error?: (...a: any[]) => void };
  fetch?: typeof fetch;
  maxTokens?: number;
  unhealthyAfter?: number;
  promptBuilder: (transcript: string) => string;
  parseResponse: (rawContent: string) => T2MemoryExtraction[];
}

export interface JudgePool {
  invoke(transcript: string): Promise<T2MemoryExtraction[]>;
  resetTickHealth(): void;
  judgeCount(): number;
}

type JudgeState = JudgeEntry & { failCount: number; unhealthy: boolean; caPem?: string };

export function createJudgePool(opts: JudgePoolOpts): JudgePool {
  const fetchImpl = opts.fetch ?? fetch;
  // Bumped from 4096 → 8192: granite-8b's reasoning_content + JSON output
  // sometimes overflows 4096, causing mid-array truncation ("Expected ']'").
  // 8192 leaves headroom for verbose multi-extraction responses while still
  // bounding cost on the slower judges.
  const maxTokens = opts.maxTokens ?? 16384;
  const unhealthyAfter = opts.unhealthyAfter ?? 2;
  const judges: JudgeState[] = [];
  for (const judge of opts.judges) {
    try {
      judges.push({
        ...judge,
        failCount: 0,
        unhealthy: false,
        caPem: judge.caPath ? readFileSync(judge.caPath, 'utf8') : undefined,
      });
    } catch (err) {
      opts.log.warn(
        { judge: judge.name, caPath: judge.caPath, err: err instanceof Error ? err.message : String(err) },
        't2 promotion: judge init failed',
      );
    }
  }
  if (judges.length === 0) {
    throw new Error('no_judges_available');
  }
  let nextIndex = 0;

  function markFailure(judge: JudgeState): void {
    judge.failCount++;
    if (judge.failCount >= unhealthyAfter) {
      judge.unhealthy = true;
    }
  }

  async function invokeJudge(judge: JudgeState, prompt: string): Promise<T2MemoryExtraction[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (judge.apiKey) headers.Authorization = `Bearer ${judge.apiKey}`;
    // Agentchat convention: options.baseUrl is the full OpenAI-compat base
    // path (typically ending in "/v1"). Append /chat/completions to that.
    // Tolerate baseUrls without /v1 by adding it when missing.
    const trimmed = judge.baseUrl.replace(/\/+$/, '');
    const url = trimmed.endsWith('/v1') ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
    const init: any = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: judge.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_tokens: maxTokens,
        temperature: 0,
      }),
    };
    if (judge.caPem) init.tls = { ca: judge.caPem };
    const res = await fetchImpl(url, init);
    if (!res.ok) {
      throw new Error(`judge ${judge.name} returned ${res.status}: ${await res.text()}`);
    }
    const json = await res.json() as any;
    const content = json.choices[0]?.message?.content;
    if (!content) return [];
    return opts.parseResponse(content);
  }

  return {
    async invoke(transcript: string): Promise<T2MemoryExtraction[]> {
      if (judges.length === 0) throw new Error('all judges unhealthy this tick');
      const prompt = opts.promptBuilder(transcript);
      let lastError: unknown;
      // Snapshot the starting index for this invoke so failures don't disrupt
      // round-robin traversal of the remaining judges. nextIndex is advanced
      // ONLY on the success path, immediately before returning.
      const startIdx = nextIndex;
      for (let attempts = 0; attempts < judges.length; attempts++) {
        const idx = (startIdx + attempts) % judges.length;
        const judge = judges[idx]!;
        if (judge.unhealthy) continue;
        try {
          const result = await invokeJudge(judge, prompt);
          nextIndex = (idx + 1) % judges.length;
          return result;
        } catch (err) {
          lastError = err;
          markFailure(judge);
          opts.log.warn({ judge: judge.name, err: err instanceof Error ? err.message : String(err) }, 't2 promotion: judge failed');
        }
      }
      if (judges.every((judge) => judge.unhealthy)) {
        throw new Error('all judges unhealthy this tick');
      }
      throw lastError instanceof Error ? lastError : new Error('judge invocation failed');
    },
    resetTickHealth(): void {
      for (const judge of judges) {
        judge.failCount = 0;
        judge.unhealthy = false;
      }
    },
    judgeCount(): number {
      return judges.length;
    },
  };
}
