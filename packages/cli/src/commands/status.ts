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

export interface StatusResult {
  status: "running" | "stopped" | "stale";
  port?: number;
  pid?: number;
  embedder?: { name: string; dim: number };
  reason?: string;
  activity?: StatusActivity;
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
    return { status: "running", pid, port, embedder: body.embedder, activity };
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
