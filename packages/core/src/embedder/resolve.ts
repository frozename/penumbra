import type { Embedder } from "./interface.js";
import { OpenAICompatEmbedder, type RemoteEmbedderOpts } from "./openai-compat.js";

export type EmbedderMode = "bundled" | "remote" | "auto";

export interface ResolveOpts {
  mode: EmbedderMode;
  remote?: RemoteEmbedderOpts;
  fallback: Embedder;
  healthTimeoutMs?: number;
}

export async function resolveEmbedder(opts: ResolveOpts): Promise<Embedder> {
  if (opts.mode === "bundled") return opts.fallback;

  if (opts.mode === "remote") {
    const remote = assertRemoteRequired(opts.remote);
    if (remote.healthPath !== "") {
      const timeout = opts.healthTimeoutMs ?? 500;
      const reachable = await openaiReachable(remote.baseUrl, remote.healthPath, timeout);
      if (!reachable) {
        throw new Error(`remote embedder endpoint is unreachable: ${remote.baseUrl}`);
      }
    }
    return new OpenAICompatEmbedder(remote);
  }

  if (!opts.remote?.baseUrl) return opts.fallback;
  const remote = assertRemoteRequired(opts.remote);
  if (remote.healthPath === "") return new OpenAICompatEmbedder(remote);

  const timeout = opts.healthTimeoutMs ?? 500;
  const reachable = await openaiReachable(remote.baseUrl, remote.healthPath, timeout);
  if (!reachable) return opts.fallback;
  return new OpenAICompatEmbedder(remote);
}

function assertRemoteRequired(remote: RemoteEmbedderOpts | undefined): RemoteEmbedderOpts {
  if (!remote?.baseUrl) {
    throw new Error("remote embedder requires PENUMBRA_EMBEDDINGS_BASE_URL");
  }
  if (!remote.model) {
    throw new Error("remote embedder requires PENUMBRA_EMBEDDINGS_MODEL");
  }
  return {
    ...remote,
    healthPath: remote.healthPath ?? "/healthz",
  };
}

async function openaiReachable(
  baseUrl: string,
  healthPath: string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const path = healthPath ?? "/healthz";
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${normalizedPath}`, {
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
