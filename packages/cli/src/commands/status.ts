import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface StatusResult {
  status: "running" | "stopped" | "stale";
  port?: number;
  pid?: number;
  embedder?: { name: string; dim: number };
  reason?: string;
}

export async function runStatus(opts: { storageRoot: string }): Promise<StatusResult> {
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
    const res = await fetch(`http://127.0.0.1:${String(port)}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { status: "stale", pid, port };
    const body = (await res.json()) as { embedder: { name: string; dim: number } };
    const dispatchEventsRes = await fetch(
      `http://127.0.0.1:${String(port)}/dispatch/events?handoff_id=__penumbra_status_probe__`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (!dispatchEventsRes.ok) {
      return { status: "stale", pid, port, reason: "missing_dispatch_events_route" };
    }
    return { status: "running", pid, port, embedder: body.embedder };
  } catch {
    return { status: "stale", pid, port };
  }
}
