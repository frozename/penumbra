import type { Embedder } from "./interface.js";
import { SiriusEmbedder, type SiriusEmbedderOpts } from "./sirius.js";

export interface ResolveOpts {
  preferSirius: boolean;
  sirius?: SiriusEmbedderOpts;
  fallback: Embedder;
  healthTimeoutMs?: number;
}

export async function resolveEmbedder(opts: ResolveOpts): Promise<Embedder> {
  if (!opts.preferSirius || !opts.sirius) return opts.fallback;

  const timeout = opts.healthTimeoutMs ?? 500;
  const reachable = await siriusReachable(opts.sirius.baseUrl, timeout);
  if (!reachable) return opts.fallback;
  return new SiriusEmbedder(opts.sirius);
}

async function siriusReachable(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/healthz`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
