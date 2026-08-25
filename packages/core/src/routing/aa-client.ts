import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { AaModelSchema, type AaModel, type AaModelSnapshot } from "./schemas.js";

export const DEFAULT_AA_MODELS_ENDPOINT = "https://artificialanalysis.ai/api/v2/data/llms/models";
export const DEFAULT_AA_API_KEY_PATH = "~/.config/penumbra/secrets/artificial-analysis.key";

export type AaApiKeyResult = { state: "configured"; apiKey: string } | { state: "unconfigured" };

export interface AaTransport {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface FetchAaModelsOptions {
  apiKey: string;
  endpoint?: string;
  transport?: AaTransport;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxResponseBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export type AaFetchFailureKind =
  | "auth"
  | "rate_limited"
  | "http"
  | "network"
  | "aborted"
  | "invalid_response"
  | "oversized_response";

export interface AaFetchFailure {
  kind: AaFetchFailureKind;
  message: string;
  attempts: number;
  status?: number;
  retryAfterSeconds?: number;
}

export type AaFetchResult =
  | { ok: true; snapshot: AaFetchSnapshot }
  | { ok: false; error: AaFetchFailure };

export interface AaFetchSnapshot extends AaModelSnapshot {
  skippedModelCount?: number;
  skippedModelSamples?: string[];
}

const AaResponseWrapperSchema = z
  .object({
    status: z.unknown().optional(),
    prompt_options: z
      .object({
        data_version: z.string().optional(),
        benchmark_version: z.string().optional(),
      })
      .passthrough()
      .optional(),
    data: z.array(z.unknown()),
  })
  .passthrough();

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export async function readAaApiKey(
  path: string = DEFAULT_AA_API_KEY_PATH,
): Promise<AaApiKeyResult> {
  try {
    const raw = await readFile(expandHome(path), "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0
      ? { state: "configured", apiKey: trimmed }
      : { state: "unconfigured" };
  } catch {
    return { state: "unconfigured" };
  }
}

export async function fetchAaModels(opts: FetchAaModelsOptions): Promise<AaFetchResult> {
  const endpoint = opts.endpoint ?? DEFAULT_AA_MODELS_ENDPOINT;
  const transport = opts.transport ?? { fetch: globalThis.fetch.bind(globalThis) };
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxAttempts = normalizePositiveInt(opts.maxAttempts, 3);
  const retryDelayMs = opts.retryDelayMs ?? 500;
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? 60_000;
  const maxResponseBytes = opts.maxResponseBytes ?? 5_000_000;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => new Date());
  let lastRateLimitDelaySeconds: number | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await transport.fetch(endpoint, {
        headers: {
          "x-api-key": opts.apiKey,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const aborted =
        error instanceof DOMException
          ? error.name === "AbortError" || error.name === "TimeoutError"
          : error instanceof Error &&
            (error.name === "AbortError" || error.name === "TimeoutError");
      const kind: AaFetchFailureKind = aborted ? "aborted" : "network";
      if (attempt < maxAttempts && !aborted) {
        await sleep(retryDelayMs);
        continue;
      }
      return failure(kind, attempt, undefined);
    }

    if (response.ok) {
      return parseAaResponse(response, now, attempt, maxResponseBytes);
    }

    if (response.status === 401) {
      return failure("auth", attempt, response.status);
    }

    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
      lastRateLimitDelaySeconds = retryAfterSeconds;
      if (attempt < maxAttempts) {
        const retryAfterMs = (retryAfterSeconds ?? retryDelayMs / 1000) * 1000;
        await sleep(Math.min(retryAfterMs, maxRetryDelayMs));
        continue;
      }
      return failure("rate_limited", attempt, response.status, retryAfterSeconds);
    }

    if (response.status >= 500 && response.status <= 599 && attempt < maxAttempts) {
      await sleep(retryDelayMs);
      continue;
    }

    return failure("http", attempt, response.status, lastRateLimitDelaySeconds);
  }

  return failure("network", maxAttempts, undefined);
}

async function parseAaResponse(
  response: Response,
  now: () => Date,
  attempt: number,
  maxResponseBytes: number,
): Promise<AaFetchResult> {
  let raw: string;
  try {
    const read = await readResponseText(response, maxResponseBytes);
    if (!read.ok) {
      return failure("oversized_response", attempt, response.status);
    }
    raw = read.text;
  } catch {
    return failure("invalid_response", attempt, response.status);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return failure("invalid_response", attempt, response.status);
  }

  const wrapper = AaResponseWrapperSchema.safeParse(body);
  if (!wrapper.success) {
    return failure("invalid_response", attempt, response.status);
  }

  const models: AaModel[] = [];
  const skippedModelSamples: string[] = [];
  let skippedModelCount = 0;
  for (const [index, candidate] of wrapper.data.data.entries()) {
    const parsed = AaModelSchema.safeParse(candidate);
    if (!parsed.success) {
      // One upstream row-level schema addition must not freeze the whole cache.
      skippedModelCount += 1;
      if (skippedModelSamples.length < 3) {
        skippedModelSamples.push(skippedModelSample(candidate, index));
      }
      continue;
    }
    models.push(parsed.data);
  }

  return {
    ok: true,
    snapshot: {
      collectedAt: now().toISOString(),
      ...(wrapper.data.prompt_options?.data_version
        ? { dataVersion: wrapper.data.prompt_options.data_version }
        : {}),
      ...(wrapper.data.prompt_options?.benchmark_version
        ? { benchmarkVersion: wrapper.data.prompt_options.benchmark_version }
        : {}),
      ...(skippedModelCount > 0 ? { skippedModelCount, skippedModelSamples } : {}),
      models,
    },
  };
}

async function readResponseText(
  response: Response,
  maxResponseBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!response.body) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength > maxResponseBytes
      ? { ok: false }
      : { ok: true, text };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        return { ok: false };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } finally {
    reader.releaseLock();
  }
}

function skippedModelSample(candidate: unknown, index: number): string {
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "slug" in candidate &&
    typeof candidate.slug === "string" &&
    candidate.slug.length > 0
  ) {
    return candidate.slug;
  }
  return `index:${index}`;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  const normalized = Math.floor(value ?? fallback);
  return Number.isFinite(normalized) && normalized >= 1 ? normalized : fallback;
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function failure(
  kind: AaFetchFailureKind,
  attempts: number,
  status?: number,
  retryAfterSeconds?: number,
): AaFetchResult {
  return {
    ok: false,
    error: {
      kind,
      message: failureMessage(kind),
      attempts,
      ...(status === undefined ? {} : { status }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  };
}

function failureMessage(kind: AaFetchFailureKind): string {
  switch (kind) {
    case "auth":
      return "Artificial Analysis API authentication failed";
    case "rate_limited":
      return "Artificial Analysis API rate limit exceeded";
    case "http":
      return "Artificial Analysis API request failed";
    case "network":
      return "Artificial Analysis API network request failed";
    case "aborted":
      return "Artificial Analysis API request timed out";
    case "invalid_response":
      return "Artificial Analysis API response failed validation";
    case "oversized_response":
      return "Artificial Analysis API response exceeded size limit";
  }
}
