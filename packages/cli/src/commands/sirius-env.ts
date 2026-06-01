import type { EmbedderMode, RemoteEmbedderOpts } from "@penumbra/core";

export interface EmbedderEnvConfig {
  mode: EmbedderMode;
  remote?: RemoteEmbedderOpts;
}

const LEGACY_KEYS = [
  "PENUMBRA_SIRIUS_BASE_URL",
  "PENUMBRA_SIRIUS_TOKEN",
  "PENUMBRA_SIRIUS_MODEL",
  "PENUMBRA_SIRIUS_DIM",
  "PENUMBRA_EMBEDDER_PREFER_SIRIUS",
] as const;

let legacyWarningEmitted = false;

/**
 * Read PENUMBRA_EMBEDDINGS_* env vars and assemble mode + remote opts.
 * Falls back to deprecated PENUMBRA_SIRIUS_* aliases when canonical vars are unset.
 */
export function readEmbedderEnv(
  env: Record<string, string | undefined>,
): EmbedderEnvConfig | undefined {
  const canonical = readCanonical(env);
  if (canonical) return canonical;

  const legacy = readLegacy(env);
  if (legacy) return legacy;
  return undefined;
}

function readCanonical(env: Record<string, string | undefined>): EmbedderEnvConfig | undefined {
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

function readLegacy(env: Record<string, string | undefined>): EmbedderEnvConfig | undefined {
  const hasLegacy = LEGACY_KEYS.some((k) => env[k] !== undefined);
  if (!hasLegacy) return undefined;

  maybeWarnLegacy();

  const preferLegacy = isTruthy(env.PENUMBRA_EMBEDDER_PREFER_SIRIUS);
  if (!preferLegacy) {
    return { mode: "bundled" };
  }

  const baseUrl = env.PENUMBRA_SIRIUS_BASE_URL;
  if (!baseUrl) {
    return { mode: "auto" };
  }

  const model = env.PENUMBRA_SIRIUS_MODEL;
  if (!model) {
    throw new Error("PENUMBRA_SIRIUS_MODEL is required when PENUMBRA_SIRIUS_BASE_URL is set");
  }

  const dim = parseDim(env.PENUMBRA_SIRIUS_DIM ?? "1536", "PENUMBRA_SIRIUS_DIM");

  return {
    mode: "auto",
    remote: {
      baseUrl,
      model,
      dim,
      token: env.PENUMBRA_SIRIUS_TOKEN,
      authHeader: "Authorization",
      authScheme: "Bearer",
      healthPath: "/healthz",
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

function maybeWarnLegacy(): void {
  if (legacyWarningEmitted) return;
  legacyWarningEmitted = true;
  console.warn(
    "penumbra: PENUMBRA_SIRIUS_* and PENUMBRA_EMBEDDER_PREFER_SIRIUS are deprecated; use PENUMBRA_EMBEDDINGS_BASE_URL, PENUMBRA_EMBEDDINGS_MODEL, PENUMBRA_EMBEDDINGS_DIM, PENUMBRA_EMBEDDINGS_TOKEN, PENUMBRA_EMBEDDINGS_AUTH_HEADER, PENUMBRA_EMBEDDINGS_AUTH_SCHEME, PENUMBRA_EMBEDDINGS_HEALTH_PATH, and PENUMBRA_EMBEDDINGS_MODE",
  );
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["true", "1", "yes", "on"].includes(value.toLowerCase());
}
