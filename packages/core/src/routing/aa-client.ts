import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { type AaModel, AaModelSchema, type AaModelSnapshot } from "./schemas.js";

export const DEFAULT_AA_MODELS_ENDPOINT =
  "https://artificialanalysis.ai/api/v2/language/models/free";
export const DEFAULT_AA_API_KEY_PATH = "~/.config/penumbra/secrets/artificial-analysis.key";

// The free language-models endpoint paginates; a server that keeps answering
// has_more: true must end in a typed failure, never an endless loop.
const MAX_AA_PAGES = 10;

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
  | "oversized_response"
  | "gone"
  | "forbidden";

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

// Legacy /api/v2/data/* envelope (still supported for custom endpoint overrides).
const AaLegacyWrapperSchema = z
  .object({
    status: z.unknown().optional(),
    prompt_options: z
      .object({
        data_version: z.string().optional(),
        benchmark_version: z.string().optional(),
      })
      .loose()
      .optional(),
    data: z.array(z.unknown()),
  })
  .loose();

// Free-tier /api/v2/language/models/free envelope.
const AaFreeWrapperSchema = z
  .object({
    tier: z.unknown().optional(),
    intelligence_index_version: z.unknown().optional(),
    pagination: z
      .object({
        has_more: z.boolean().optional(),
      })
      .loose()
      .optional(),
    data: z.array(z.unknown()),
  })
  .loose();

const FREE_PERFORMANCE_KEYS = [
  ["median_output_tokens_per_second", "median_output_tokens_per_second"],
  ["median_time_to_first_token_seconds", "median_time_to_first_token_seconds"],
  ["median_time_to_first_answer_token", "median_time_to_first_answer_token_seconds"],
] as const;

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

type RequestContext = Pick<
  ResolvedFetchOptions,
  "endpoint" | "transport" | "timeoutMs" | "maxResponseBytes" | "now"
> & { apiKey: string; attempt: number };

type JsonBody =
  | { ok: true; body: unknown }
  | { ok: false; kind: "oversized_response" | "invalid_response" };

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface ResolvedFetchOptions {
  endpoint: string;
  transport: AaTransport;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  maxResponseBytes: number;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

function resolveOptions(opts: FetchAaModelsOptions): ResolvedFetchOptions {
  return {
    endpoint: opts.endpoint ?? DEFAULT_AA_MODELS_ENDPOINT,
    transport: opts.transport ?? { fetch: globalThis.fetch.bind(globalThis) },
    timeoutMs: opts.timeoutMs ?? 10_000,
    maxAttempts: normalizePositiveInt(opts.maxAttempts, 3),
    retryDelayMs: opts.retryDelayMs ?? 500,
    maxRetryDelayMs: opts.maxRetryDelayMs ?? 60_000,
    maxResponseBytes: opts.maxResponseBytes ?? 5_000_000,
    sleep: opts.sleep ?? defaultSleep,
    now: opts.now ?? ((): Date => new Date()),
  };
}

export async function fetchAaModels(opts: FetchAaModelsOptions): Promise<AaFetchResult> {
  const config = resolveOptions(opts);
  let lastRateLimitDelaySeconds: number | undefined;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const outcome = await runAttempt(opts.apiKey, config, attempt, lastRateLimitDelaySeconds);
    if (outcome.action === "return") {
      return outcome.result;
    }
    if (outcome.retryAfterSeconds !== undefined) {
      lastRateLimitDelaySeconds = outcome.retryAfterSeconds;
    }
    await config.sleep(outcome.delayMs);
  }

  return failure("network", config.maxAttempts);
}

type AttemptOutcome =
  | { action: "return"; result: AaFetchResult }
  | { action: "retry"; delayMs: number; retryAfterSeconds?: number };

async function runAttempt(
  apiKey: string,
  config: ResolvedFetchOptions,
  attempt: number,
  lastRateLimitDelaySeconds: number | undefined,
): Promise<AttemptOutcome> {
  let response: Response;
  try {
    response = await requestAa(config.endpoint, apiKey, config);
  } catch (error) {
    const aborted = isAbortError(error);
    if (!aborted && attempt < config.maxAttempts) {
      return { action: "retry", delayMs: config.retryDelayMs };
    }
    return { action: "return", result: failure(aborted ? "aborted" : "network", attempt) };
  }

  if (response.ok) {
    const ctx: RequestContext = { ...config, apiKey, attempt };
    return { action: "return", result: await processOkResponse(response, ctx) };
  }

  const outcome = classifyUnsuccessful(
    response,
    attempt,
    config.maxAttempts,
    config.retryDelayMs,
    config.maxRetryDelayMs,
    lastRateLimitDelaySeconds,
  );
  if (outcome.action === "fail") {
    return { action: "return", result: outcome.result };
  }
  if (outcome.action === "rate_limited") {
    return {
      action: "retry",
      delayMs: outcome.delayMs,
      retryAfterSeconds: outcome.retryAfterSeconds,
    };
  }
  return { action: "retry", delayMs: config.retryDelayMs };
}

function requestAa(
  url: string,
  apiKey: string,
  config: Pick<ResolvedFetchOptions, "transport" | "timeoutMs">,
): Promise<Response> {
  return config.transport.fetch(url, {
    headers: {
      "x-api-key": apiKey,
    },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
}

async function processOkResponse(response: Response, ctx: RequestContext): Promise<AaFetchResult> {
  const parsed = await readJsonBody(response, ctx.maxResponseBytes);
  if (!parsed.ok) {
    return failure(parsed.kind, ctx.attempt, response.status);
  }
  return isFreeEnvelope(parsed.body)
    ? await collectFreeSnapshot(parsed.body, ctx)
    : buildLegacySnapshot(parsed.body, ctx.attempt, ctx.now);
}

type UnsuccessfulOutcome =
  | { action: "fail"; result: AaFetchResult }
  | { action: "retry" }
  | { action: "rate_limited"; delayMs: number; retryAfterSeconds: number | undefined };

function classifyUnsuccessful(
  response: Response,
  attempt: number,
  maxAttempts: number,
  retryDelayMs: number,
  maxRetryDelayMs: number,
  lastRateLimitDelaySeconds: number | undefined,
): UnsuccessfulOutcome {
  const status = response.status;
  if (status === 401) {
    return { action: "fail", result: failure("auth", attempt, status) };
  }
  if (status === 410) {
    return { action: "fail", result: failure("gone", attempt, status) };
  }
  if (status === 403) {
    return { action: "fail", result: failure("forbidden", attempt, status) };
  }

  if (status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
    if (attempt < maxAttempts) {
      const retryAfterMs = (retryAfterSeconds ?? retryDelayMs / 1000) * 1000;
      return {
        action: "rate_limited",
        delayMs: Math.min(retryAfterMs, maxRetryDelayMs),
        retryAfterSeconds,
      };
    }
    return { action: "fail", result: failure("rate_limited", attempt, status, retryAfterSeconds) };
  }

  if (status >= 500 && status <= 599 && attempt < maxAttempts) {
    return { action: "retry" };
  }

  return { action: "fail", result: failure("http", attempt, status, lastRateLimitDelaySeconds) };
}

function isFreeEnvelope(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as Record<string, unknown>).data) &&
    ("pagination" in body || "tier" in body)
  );
}

async function fetchFreePage(url: string, ctx: RequestContext): Promise<JsonBody> {
  let response: Response;
  try {
    response = await requestAa(url, ctx.apiKey, ctx);
  } catch {
    return { ok: false, kind: "invalid_response" };
  }
  if (!response.ok) {
    return { ok: false, kind: "invalid_response" };
  }

  const parsed = await readJsonBody(response, ctx.maxResponseBytes);
  if (!parsed.ok) {
    return parsed;
  }
  return isFreeEnvelope(parsed.body) ? parsed : { ok: false, kind: "invalid_response" };
}

type FreeEnvelope = z.infer<typeof AaFreeWrapperSchema>;

async function collectFreeSnapshot(
  firstBody: unknown,
  ctx: RequestContext,
): Promise<AaFetchResult> {
  const pages = await readFreeEnvelopes(firstBody, ctx);
  if ("envelopes" in pages) {
    return buildFreeSnapshot(pages.envelopes, ctx.attempt, ctx.now);
  }
  return pages;
}

async function readFreeEnvelopes(
  firstBody: unknown,
  ctx: RequestContext,
): Promise<{ envelopes: FreeEnvelope[] } | AaFetchResult> {
  const envelopes: FreeEnvelope[] = [];
  let body: unknown = firstBody;

  for (let page = 1; ; page += 1) {
    const envelope = AaFreeWrapperSchema.safeParse(body);
    if (!envelope.success) {
      return failure("invalid_response", ctx.attempt);
    }
    envelopes.push(envelope.data);

    if (!(envelope.data.pagination?.has_more ?? false)) {
      break;
    }
    if (page >= MAX_AA_PAGES) {
      return failure(
        "invalid_response",
        ctx.attempt,
        undefined,
        undefined,
        `response exceeded ${String(MAX_AA_PAGES)} pages`,
      );
    }
    const next = await fetchFreePage(withPageParam(ctx.endpoint, page + 1), ctx);
    if (!next.ok) {
      return failure(next.kind, ctx.attempt);
    }
    body = next.body;
  }

  return { envelopes };
}

function buildFreeSnapshot(
  envelopes: FreeEnvelope[],
  attempt: number,
  now: () => Date,
): AaFetchResult {
  const merged: CollectedRows = {
    models: [],
    skippedModelCount: 0,
    skippedModelSamples: [],
    totalRows: 0,
  };
  let indexVersion: unknown;

  for (const envelope of envelopes) {
    indexVersion ??= envelope.intelligence_index_version;
    const rows = collectRows(envelope.data, normalizeFreeRow);
    merged.models.push(...rows.models);
    merged.skippedModelCount += rows.skippedModelCount;
    merged.skippedModelSamples.push(...rows.skippedModelSamples);
    merged.totalRows += rows.totalRows;
  }

  const version =
    typeof indexVersion === "number" || typeof indexVersion === "string"
      ? String(indexVersion)
      : undefined;
  return snapshotFromRows(
    merged,
    version === undefined ? {} : { dataVersion: version, benchmarkVersion: version },
    attempt,
    now,
  );
}

function withPageParam(endpoint: string, page: number): string {
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}page=${String(page)}`;
}

function buildLegacySnapshot(body: unknown, attempt: number, now: () => Date): AaFetchResult {
  const wrapper = AaLegacyWrapperSchema.safeParse(body);
  if (!wrapper.success) {
    return failure("invalid_response", attempt);
  }

  const options = wrapper.data.prompt_options;
  return snapshotFromRows(
    collectRows(wrapper.data.data, (row) => row),
    {
      ...(options?.data_version ? { dataVersion: options.data_version } : {}),
      ...(options?.benchmark_version ? { benchmarkVersion: options.benchmark_version } : {}),
    },
    attempt,
    now,
  );
}

function snapshotFromRows(
  rows: CollectedRows,
  versions: Pick<AaFetchSnapshot, "dataVersion" | "benchmarkVersion">,
  attempt: number,
  now: () => Date,
): AaFetchResult {
  // Rows that all fail validation are a broken upstream, not an empty
  // catalog; failing here keeps the last-known-good snapshot alive.
  if (rows.totalRows > 0 && rows.models.length === 0) {
    return failure("invalid_response", attempt);
  }

  return {
    ok: true,
    snapshot: {
      collectedAt: now().toISOString(),
      ...versions,
      ...(rows.skippedModelCount > 0
        ? {
            skippedModelCount: rows.skippedModelCount,
            skippedModelSamples: rows.skippedModelSamples.slice(0, 3),
          }
        : {}),
      models: rows.models,
    },
  };
}

interface CollectedRows {
  models: AaModel[];
  skippedModelCount: number;
  skippedModelSamples: string[];
  totalRows: number;
}

function collectRows(rows: unknown[], normalize: (row: unknown) => unknown): CollectedRows {
  const models: AaModel[] = [];
  const skippedModelSamples: string[] = [];
  let skippedModelCount = 0;
  for (const [index, candidate] of rows.entries()) {
    const parsed = AaModelSchema.safeParse(normalize(candidate));
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
  return { models, skippedModelCount, skippedModelSamples, totalRows: rows.length };
}

// Reshapes a /language/models/free row into the AaModelSchema shape: the
// free API has no creator slug (derive it from the name), nests performance,
// and does not publish a blended price (compute it). Identity fields are
// passed through untouched so schema validation still rejects junk rows.
function normalizeFreeRow(candidate: unknown): unknown {
  const row = asRecord(candidate);
  if (!row) {
    return candidate;
  }

  const creator = asRecord(row.model_creator);
  const creatorName = nonEmptyString(creator?.name) ?? "unknown";

  const pricing = asRecord(row.pricing);
  const input = pricing?.price_1m_input_tokens;
  const output = pricing?.price_1m_output_tokens;

  const normalized: Record<string, unknown> = {
    ...row,
    model_creator: {
      id: nonEmptyString(creator?.id) ?? "unknown",
      name: creatorName,
      slug: slugify(creatorName) || "unknown",
    },
    evaluations: asRecord(row.evaluations) ?? {},
    pricing: {
      ...pricing,
      price_1m_blended_3_to_1:
        typeof input === "number" && typeof output === "number" ? (3 * input + output) / 4 : null,
    },
  };

  const performance = asRecord(row.performance);
  if (performance) {
    for (const [targetKey, sourceKey] of FREE_PERFORMANCE_KEYS) {
      if (sourceKey in performance) {
        normalized[targetKey] = numOrNull(performance[sourceKey]);
      }
    }
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

async function readJsonBody(response: Response, maxResponseBytes: number): Promise<JsonBody> {
  let raw: string;
  try {
    const read = await readResponseText(response, maxResponseBytes);
    if (!read.ok) {
      return { ok: false, kind: "oversized_response" };
    }
    raw = read.text;
  } catch {
    return { ok: false, kind: "invalid_response" };
  }

  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, kind: "invalid_response" };
  }
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

  const reader = response.body.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      const { done, value } = chunk;
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
  return `index:${String(index)}`;
}

function isAbortError(error: unknown): boolean {
  const name =
    error instanceof DOMException || error instanceof Error
      ? error.name
      : typeof error === "object" && error !== null && "name" in error
        ? String((error as Record<string, unknown>).name)
        : "";
  return name === "AbortError" || name === "TimeoutError";
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
  detail?: string,
): AaFetchResult {
  return {
    ok: false,
    error: {
      kind,
      message: detail ? `${failureMessage(kind)}: ${detail}` : failureMessage(kind),
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
    case "gone":
      return "Artificial Analysis API endpoint has been retired";
    case "forbidden":
      return "Artificial Analysis API key tier lacks access";
  }
}
