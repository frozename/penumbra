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
    throw new Error(`served models probe failed: ${String(response.status)}`);
  }
  const body = (await response.json()) as {
    data?: { id?: unknown; owned_by?: unknown; created?: unknown }[];
  };
  const entries: ServedModelEntry[] = [];
  for (const model of body.data ?? []) {
    if (typeof model.id === "string" && model.id.length > 0) {
      entries.push({
        id: model.id,
        ...(typeof model.owned_by === "string" ? { owned_by: model.owned_by } : {}),
        ...(typeof model.created === "number" ? { created: model.created } : {}),
      });
    }
  }
  return entries;
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
