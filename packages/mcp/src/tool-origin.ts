function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim().length > 0) return item;
    }
    return undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) return value;
  return undefined;
}

function readEnvOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // For callers that cannot thread per-request metadata (for example user-level
  // maestro sessions), set PENUMBRA_MCP_ORIGIN=maestro in the MCP child env.
  return readHeaderValue(env.PENUMBRA_MCP_ORIGIN);
}

export function resolveToolOrigin(extra: unknown): string | undefined {
  if (!extra || typeof extra !== "object") return undefined;

  const asRecord = extra as Record<string, unknown>;
  const requestInfo = asRecord.requestInfo as
    | { headers?: Record<string, string | string[] | undefined> }
    | undefined;
  const headers = requestInfo?.headers;

  if (headers && typeof headers === "object") {
    const headerOrigin =
      readHeaderValue(headers["x-penumbra-origin"]) ??
      readHeaderValue(headers["X-Penumbra-Origin"]);
    if (headerOrigin) return headerOrigin;
  }

  const meta = asRecord._meta;
  if (meta && typeof meta === "object") {
    const metaRecord = meta as Record<string, unknown>;
    const metaOrigin =
      readHeaderValue(metaRecord.origin as string | string[] | undefined) ??
      readHeaderValue(metaRecord.penumbra_origin as string | string[] | undefined) ??
      readHeaderValue(metaRecord["x-penumbra-origin"] as string | string[] | undefined);
    if (metaOrigin) return metaOrigin;
  }

  return readEnvOrigin();
}
