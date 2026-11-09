export type ServedModelsFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; tls?: { ca: string } },
) => Promise<Response>;

export interface FetchServedModelsOpts {
  fetch?: ServedModelsFetch;
  timeoutMs?: number;
  bearerToken?: string;
  caPem?: string;
}

export interface ServedModelEntry {
  id: string;
  owned_by?: string;
  created?: number;
  experimental?: boolean;
}

export function servedModelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

function buildProbeInit(
  opts: FetchServedModelsOpts,
  signal: AbortSignal,
): { signal: AbortSignal; headers?: { authorization: string }; tls?: { ca: string } } {
  return {
    signal,
    ...(opts.bearerToken ? { headers: { authorization: `Bearer ${opts.bearerToken}` } } : {}),
    ...(opts.caPem ? { tls: { ca: opts.caPem } } : {}),
  };
}

// #256: carries the HTTP status so callers can tell an auth failure from other errors.
export class ServedModelsProbeError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`served models probe failed: ${String(status)}`);
    this.name = "ServedModelsProbeError";
    this.status = status;
  }
}

export async function fetchServedModelEntries(
  baseUrl: string,
  opts: FetchServedModelsOpts = {},
): Promise<ServedModelEntry[]> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const response = await fetchImpl(
    servedModelsUrl(baseUrl),
    buildProbeInit(opts, AbortSignal.timeout(timeoutMs)),
  );
  if (!response.ok) {
    throw new ServedModelsProbeError(response.status);
  }
  const body = (await response.json()) as { data?: ServedModelBodyItem[] };
  const entries: ServedModelEntry[] = [];
  for (const model of body.data ?? []) {
    const entry = toServedModelEntry(model);
    if (entry) entries.push(entry);
  }
  return entries;
}

type ServedModelBodyItem = {
  id?: unknown;
  owned_by?: unknown;
  created?: unknown;
  experimental?: unknown;
  qualification?: { stage?: unknown } | null;
};

function isExperimentalServedModel(model: ServedModelBodyItem): boolean {
  if (model.experimental === true) return true;
  const qualification = model.qualification;
  if (qualification === null || qualification === undefined) return false;
  return typeof qualification === "object" && qualification.stage === "experimental";
}

function toServedModelEntry(model: ServedModelBodyItem): ServedModelEntry | undefined {
  if (typeof model.id !== "string" || model.id.length === 0) return undefined;
  return {
    id: model.id,
    ...(typeof model.owned_by === "string" ? { owned_by: model.owned_by } : {}),
    ...(typeof model.created === "number" ? { created: model.created } : {}),
    ...(isExperimentalServedModel(model) ? { experimental: true } : {}),
  };
}

export async function fetchServedModels(
  baseUrl: string,
  opts: FetchServedModelsOpts = {},
): Promise<ReadonlySet<string>> {
  const entries = await fetchServedModelEntries(baseUrl, opts);
  const ids = new Set<string>();
  for (const model of entries) ids.add(model.id);
  return ids;
}
