import type { T2MemoryExtraction } from "@penumbra/core";

import { readFileSync } from "node:fs";

export interface JudgeEntry {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  caPath?: string;
  requestExtras?: Record<string, unknown>;
}

type JudgeLogFn = (...a: unknown[]) => void;

export interface JudgePoolLogger {
  info: JudgeLogFn;
  warn: JudgeLogFn;
  error?: JudgeLogFn;
}

export interface JudgePoolOpts {
  judges: JudgeEntry[];
  log: JudgePoolLogger;
  fetch?: typeof fetch;
  timeoutMs?: number;
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

interface JudgeChoice {
  message?: { content?: string };
}

interface JudgeResponse {
  choices?: JudgeChoice[];
}

interface JudgeFetchInit extends RequestInit {
  tls?: { ca: string };
}

export class JudgeError extends Error {
  override readonly name = "JudgeError";
  readonly isContextOverflow: boolean;
  readonly nPromptTokens?: number;
  readonly nCtx?: number;
  constructor(
    message: string,
    opts: { isContextOverflow: boolean; nPromptTokens?: number; nCtx?: number },
  ) {
    super(message);
    this.isContextOverflow = opts.isContextOverflow;
    this.nPromptTokens = opts.nPromptTokens;
    this.nCtx = opts.nCtx;
  }
}

function parseTokenNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function parseOverflowMetricsFromText(body: string): { nPromptTokens?: number; nCtx?: number } {
  const tokenMatch = /n_prompt_tokens["']?\s*[:=]\s*(\d+)/i.exec(body);
  const ctxMatch = /n_ctx["']?\s*[:=]\s*(\d+)/i.exec(body);
  if (tokenMatch && ctxMatch) {
    const nPromptTokens = parseInt(tokenMatch[1] ?? "", 10);
    const nCtx = parseInt(ctxMatch[1] ?? "", 10);
    if (Number.isFinite(nPromptTokens) && Number.isFinite(nCtx) && nCtx > 0) {
      return { nPromptTokens, nCtx };
    }
  }
  const tokensExceedsMatch = /\((\d+)\s*tokens?\)[^]*exceeds[^]*\((\d+)\s*tokens?\)/i.exec(body);
  if (tokensExceedsMatch) {
    const nPromptTokens = parseInt(tokensExceedsMatch[1] ?? "", 10);
    const nCtx = parseInt(tokensExceedsMatch[2] ?? "", 10);
    if (Number.isFinite(nPromptTokens) && Number.isFinite(nCtx) && nCtx > 0) {
      return { nPromptTokens, nCtx };
    }
  }
  return {};
}

export function classifyJudgeHttpError(
  status: number,
  bodyText: string,
): {
  isOverflow: boolean;
  nPromptTokens?: number;
  nCtx?: number;
} {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { type?: unknown; code?: unknown; n_prompt_tokens?: unknown; n_ctx?: unknown };
    };
    const err = parsed.error;
    if (!err || typeof err !== "object") return { isOverflow: false };
    const isOverflow =
      err.type === "exceed_context_size_error" || err.code === "exceed_context_size_error";
    if (!isOverflow) return { isOverflow: false };
    let nPromptTokens = parseTokenNumber(err.n_prompt_tokens);
    let nCtx = parseTokenNumber(err.n_ctx);
    if (
      nCtx !== undefined &&
      (nCtx < 1000 || (nPromptTokens !== undefined && nPromptTokens <= nCtx))
    ) {
      nPromptTokens = undefined;
      nCtx = undefined;
    }
    return { isOverflow: true, nPromptTokens, nCtx };
  } catch {
    if (status >= 400 && status < 500) {
      const phraseMatch = /exceed_context_size_error|exceeds the available context size/i.test(
        bodyText,
      );
      if (phraseMatch) {
        const metrics = parseOverflowMetricsFromText(bodyText);
        return { isOverflow: true, ...metrics };
      }
    }
    return { isOverflow: false };
  }
}

export function isContextOverflow(err: unknown): boolean {
  if (typeof err === "string") {
    return /exceed_context_size_error|exceeds the available context size/i.test(err);
  }
  if (err instanceof JudgeError) {
    return err.isContextOverflow;
  }
  if (err instanceof Error) {
    const typed = err as { isContextOverflow?: unknown };
    if (typeof typed.isContextOverflow === "boolean") return typed.isContextOverflow;
    return /exceed_context_size_error|exceeds the available context size/i.test(err.message);
  }
  return false;
}

export function getJudgeTimeoutMs(): number {
  let envTimeout = parseInt(process.env.PENUMBRA_T2_JUDGE_TIMEOUT_MS ?? "", 10);
  if (isNaN(envTimeout) || envTimeout <= 0) {
    envTimeout = 900_000;
  }
  return envTimeout;
}

function buildJudgeUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

function loadJudgeStates(opts: JudgePoolOpts): JudgeState[] {
  const judges: JudgeState[] = [];
  for (const judge of opts.judges) {
    try {
      judges.push({
        ...judge,
        failCount: 0,
        unhealthy: false,
        caPem: judge.caPath ? readFileSync(judge.caPath, "utf8") : undefined,
      });
    } catch (err) {
      opts.log.warn(
        {
          judge: judge.name,
          caPath: judge.caPath,
          err: err instanceof Error ? err.message : String(err),
        },
        "t2 promotion: judge init failed",
      );
    }
  }
  return judges;
}

export function createJudgePool(opts: JudgePoolOpts): JudgePool {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? getJudgeTimeoutMs();

  // Bumped from 4096 → 8192: granite-8b's reasoning_content + JSON output
  // sometimes overflows 4096, causing mid-array truncation ("Expected ']'").
  // 8192 leaves headroom for verbose multi-extraction responses while still
  // bounding cost on the slower judges.
  const maxTokens = opts.maxTokens ?? 16384;
  const unhealthyAfter = opts.unhealthyAfter ?? 2;
  const judges = loadJudgeStates(opts);
  if (judges.length === 0) {
    throw new Error("no_judges_available");
  }
  let nextIndex = 0;

  function markFailure(judge: JudgeState): void {
    judge.failCount++;
    if (judge.failCount >= unhealthyAfter) {
      judge.unhealthy = true;
    }
  }

  async function invokeJudge(judge: JudgeState, prompt: string): Promise<T2MemoryExtraction[]> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (judge.apiKey) headers.Authorization = `Bearer ${judge.apiKey}`;
    const url = buildJudgeUrl(judge.baseUrl);
    const init: JudgeFetchInit = {
      method: "POST",
      headers,
      body: JSON.stringify({
        response_format: { type: "json_object" },
        max_tokens: maxTokens,
        temperature: 0,
        ...(judge.requestExtras ?? {}),
        model: judge.model,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (judge.caPem) init.tls = { ca: judge.caPem };
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`judge ${judge.name} timed out after ${String(timeoutMs)}ms`);
      }
      throw err;
    }
    if (!res.ok) {
      const bodyText = await res.text();
      const classified = classifyJudgeHttpError(res.status, bodyText);
      const message = `judge ${judge.name} returned ${String(res.status)}: ${bodyText}`;
      throw new JudgeError(message, {
        isContextOverflow: classified.isOverflow,
        nPromptTokens: classified.nPromptTokens,
        nCtx: classified.nCtx,
      });
    }
    const json = (await res.json()) as JudgeResponse;
    const content = json.choices?.[0]?.message?.content;
    if (!content) return [];
    return opts.parseResponse(content);
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve the existing retry and health policy while changing only cursor advancement.
  async function tryEachJudge(prompt: string): Promise<T2MemoryExtraction[]> {
    let lastError: unknown;
    const attempted = new Set<number>();
    let result: T2MemoryExtraction[] | undefined;
    for (let attempts = 0; attempts < judges.length; attempts++) {
      let idx: number | undefined;
      if (attempts === 0) {
        // Advance the shared cursor exactly once per invocation; retries use attempted only.
        idx = nextIndex;
        nextIndex = (nextIndex + 1) % judges.length;
      } else {
        for (let i = 0; i < judges.length; i++) {
          if (!attempted.has(i)) {
            idx = i;
            break;
          }
        }
      }
      if (idx === undefined) break;
      attempted.add(idx);
      const judge = judges[idx];
      if (!judge || judge.unhealthy) continue;
      try {
        result = await invokeJudge(judge, prompt);
        break;
      } catch (err) {
        lastError = err;
        if (!isContextOverflow(err)) markFailure(judge);
        opts.log.warn(
          { judge: judge.name, err: err instanceof Error ? err.message : String(err) },
          "t2 promotion: judge failed",
        );
      }
    }
    if (result !== undefined) return result;
    if (judges.every((judge) => judge.unhealthy)) {
      throw new Error("all judges unhealthy this tick");
    }
    throw lastError instanceof Error ? lastError : new Error("judge invocation failed");
  }

  return {
    async invoke(transcript: string): Promise<T2MemoryExtraction[]> {
      if (judges.length === 0) throw new Error("all judges unhealthy this tick");
      const prompt = opts.promptBuilder(transcript);
      return await tryEachJudge(prompt);
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
