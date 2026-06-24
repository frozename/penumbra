export type LlamactlFetch = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface FetchLlamactlServedModelsOpts {
  fetch?: LlamactlFetch;
  timeoutMs?: number;
}

export function llamactlModelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

export async function fetchLlamactlServedModels(
  baseUrl: string,
  opts: FetchLlamactlServedModelsOpts = {},
): Promise<ReadonlySet<string>> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const response = await fetchImpl(llamactlModelsUrl(baseUrl), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`llamactl models probe failed: ${String(response.status)}`);
  }
  const body = (await response.json()) as { data?: { id?: unknown }[] };
  const ids = new Set<string>();
  for (const model of body.data ?? []) {
    if (typeof model.id === "string" && model.id.length > 0) {
      ids.add(model.id);
    }
  }
  return ids;
}
