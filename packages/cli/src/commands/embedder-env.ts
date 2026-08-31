import type { EmbedderMode, RemoteEmbedderOpts } from "@penumbra/core";

export interface EmbedderEnvConfig {
  mode: EmbedderMode;
  remote?: RemoteEmbedderOpts;
}

/** Read PENUMBRA_EMBEDDINGS_* env vars and assemble mode + remote opts. */
export function readEmbedderEnv(
  env: Record<string, string | undefined>,
): EmbedderEnvConfig | undefined {
  const hasCanonical =
    env.PENUMBRA_EMBEDDINGS_BASE_URL !== undefined ||
    env.PENUMBRA_EMBEDDINGS_MODEL !== undefined ||
    env.PENUMBRA_EMBEDDINGS_DIM !== undefined ||
    env.PENUMBRA_EMBEDDINGS_TOKEN !== undefined ||
    env.PENUMBRA_EMBEDDINGS_AUTH_HEADER !== undefined ||
    env.PENUMBRA_EMBEDDINGS_AUTH_SCHEME !== undefined ||
    env.PENUMBRA_EMBEDDINGS_HEALTH_PATH !== undefined ||
    env.PENUMBRA_EMBEDDINGS_MODE !== undefined;

  if (!hasCanonical) return undefined;

  const modeRaw = env.PENUMBRA_EMBEDDINGS_MODE ?? "auto";
  const mode = parseMode(modeRaw);

  if (mode === "bundled") {
    return { mode };
  }

  const baseUrl = env.PENUMBRA_EMBEDDINGS_BASE_URL;
  const model = env.PENUMBRA_EMBEDDINGS_MODEL;

  if (mode === "remote") {
    if (!baseUrl) {
      throw new Error(
        "PENUMBRA_EMBEDDINGS_BASE_URL is required when PENUMBRA_EMBEDDINGS_MODE=remote",
      );
    }
    if (!model) {
      throw new Error("PENUMBRA_EMBEDDINGS_MODEL is required when PENUMBRA_EMBEDDINGS_MODE=remote");
    }
  }

  if (!baseUrl) {
    return mode === "auto" ? { mode } : undefined;
  }

  if (!model) {
    throw new Error(
      "PENUMBRA_EMBEDDINGS_MODEL is required when PENUMBRA_EMBEDDINGS_BASE_URL is set",
    );
  }

  return {
    mode,
    remote: {
      baseUrl,
      model,
      dim: parseDim(env.PENUMBRA_EMBEDDINGS_DIM ?? "384", "PENUMBRA_EMBEDDINGS_DIM"),
      token: env.PENUMBRA_EMBEDDINGS_TOKEN,
      authHeader: env.PENUMBRA_EMBEDDINGS_AUTH_HEADER ?? "Authorization",
      authScheme: env.PENUMBRA_EMBEDDINGS_AUTH_SCHEME ?? "Bearer",
      healthPath: env.PENUMBRA_EMBEDDINGS_HEALTH_PATH ?? "/healthz",
    },
  };
}

function parseMode(value: string): EmbedderMode {
  if (value === "bundled" || value === "remote" || value === "auto") return value;
  throw new Error(`PENUMBRA_EMBEDDINGS_MODE must be one of bundled|remote|auto, got '${value}'`);
}

function parseDim(raw: string, key: string): number {
  const dim = Number(raw);
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new RangeError(`${key} must be a positive integer, got '${raw}'`);
  }
  return dim;
}
