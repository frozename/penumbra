import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseInFlight } from "./update/daemon.js";

/** The slice of fetch that runStatus uses; tests inject it. */
export type StatusFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<Response>;

/** #259: in-flight work on a running daemon, from GET /handoffs?status=dispatched,approved. */
export type StatusActivity =
  | { ok: true; dispatched_by_agent: Record<string, number>; approved_queued: number }
  | { ok: false; error: string };

/** #259: one provider-wide in-flight cap in effect on the daemon, with its live count. */
export interface StatusProviderQuota {
  provider: string;
  max_in_flight: number;
  in_flight: number;
}

/** #259: from GET /usage/provider_quotas. A daemon without the route answers 404 (ok: false). */
export type StatusProviderQuotas =
  | { ok: true; quotas: StatusProviderQuota[] }
  | { ok: false; error: string };

export interface StatusResult {
  status: "running" | "stopped" | "stale";
  port?: number;
  pid?: number;
  embedder?: { name: string; dim: number };
  reason?: string;
  activity?: StatusActivity;
  provider_quotas?: StatusProviderQuotas;
}

export async function runStatus(opts: {
  storageRoot: string;
  fetchImpl?: StatusFetch;
}): Promise<StatusResult> {
  const fetchImpl: StatusFetch = opts.fetchImpl ?? fetch;
  const pidPath = join(opts.storageRoot, "pid");
  const portPath = join(opts.storageRoot, "port");
  const tokenPath = join(opts.storageRoot, "token");
  if (!existsSync(pidPath) || !existsSync(portPath)) return { status: "stopped" };
  const pid = Number(readFileSync(pidPath, "utf8"));
  const port = Number(readFileSync(portPath, "utf8"));
  try {
    process.kill(pid, 0);
  } catch {
    return { status: "stale", pid, port };
  }
  try {
    const token = readFileSync(tokenPath, "utf8").trim();
    const res = await fetchImpl(`http://127.0.0.1:${String(port)}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { status: "stale", pid, port };
    const body = (await res.json()) as { embedder: { name: string; dim: number } };
    const dispatchEventsRes = await fetchImpl(
      `http://127.0.0.1:${String(port)}/dispatch/events?handoff_id=__penumbra_status_probe__`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (!dispatchEventsRes.ok) {
      return { status: "stale", pid, port, reason: "missing_dispatch_events_route" };
    }
    const activity = await readActivity(fetchImpl, port, token);
    const providerQuotas = await readProviderQuotas(fetchImpl, port, token);
    return {
      status: "running",
      pid,
      port,
      embedder: body.embedder,
      activity,
      provider_quotas: providerQuotas,
    };
  } catch {
    return { status: "stale", pid, port };
  }
}

// #259: a failure here is reported in `activity` and never changes `status`.
async function readActivity(
  fetchImpl: StatusFetch,
  port: number,
  token: string,
): Promise<StatusActivity> {
  try {
    const res = await fetchImpl(
      `http://127.0.0.1:${String(port)}/handoffs?status=dispatched,approved`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      return { ok: false, error: `GET /handoffs returned HTTP ${String(res.status)}` };
    }
    const inFlight = parseInFlight(await res.text());
    if (!inFlight.ok) {
      return inFlight;
    }
    const dispatchedByAgent: Record<string, number> = {};
    for (const handoff of inFlight.dispatched) {
      dispatchedByAgent[handoff.agent] = (dispatchedByAgent[handoff.agent] ?? 0) + 1;
    }
    return {
      ok: true,
      dispatched_by_agent: dispatchedByAgent,
      approved_queued: inFlight.approved,
    };
  } catch (err) {
    return {
      ok: false,
      error: `GET /handoffs failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

interface ProviderQuotasBody {
  provider_quotas?: { provider?: unknown; max_in_flight?: unknown; in_flight?: unknown }[];
}

// Rows are copied field by field, so extra daemon keys never reach the status output.
function parseProviderQuotas(text: string): StatusProviderQuotas {
  let body: ProviderQuotasBody;
  try {
    body = JSON.parse(text) as ProviderQuotasBody;
  } catch {
    return { ok: false, error: "daemon returned invalid JSON for /usage/provider_quotas" };
  }
  if (!Array.isArray(body.provider_quotas)) {
    return {
      ok: false,
      error: "daemon /usage/provider_quotas response has no provider_quotas array",
    };
  }
  const quotas: StatusProviderQuota[] = [];
  for (const row of body.provider_quotas) {
    if (
      typeof row.provider !== "string" ||
      typeof row.max_in_flight !== "number" ||
      typeof row.in_flight !== "number"
    ) {
      return { ok: false, error: "daemon /usage/provider_quotas response has a malformed row" };
    }
    quotas.push({
      provider: row.provider,
      max_in_flight: row.max_in_flight,
      in_flight: row.in_flight,
    });
  }
  return { ok: true, quotas };
}

// #259: a failure here, including HTTP 404 from a daemon that predates the route, is
// reported in `provider_quotas` and never changes `status`.
async function readProviderQuotas(
  fetchImpl: StatusFetch,
  port: number,
  token: string,
): Promise<StatusProviderQuotas> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${String(port)}/usage/provider_quotas`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `GET /usage/provider_quotas returned HTTP ${String(res.status)}`,
      };
    }
    return parseProviderQuotas(await res.text());
  } catch (err) {
    return {
      ok: false,
      error: `GET /usage/provider_quotas failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
