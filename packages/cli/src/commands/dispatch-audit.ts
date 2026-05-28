import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DispatchReliabilityReport } from "@penumbra/core";

export interface DispatchAuditResponse {
  report: DispatchReliabilityReport;
}

export interface RunDispatchAuditOpts {
  handoffId: string;
  json: boolean;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}

function defaultPrint(line: string): void {
  process.stdout.write(`${line}\n`);
}

function resolveDaemon(storageRoot: string): { baseUrl: string; token: string } {
  const portPath = join(storageRoot, "port");
  const tokenPath = join(storageRoot, "token");
  if (!existsSync(portPath) || !existsSync(tokenPath)) {
    throw new Error(
      `penumbra dispatch audit: missing ${portPath} or ${tokenPath}. Run 'penumbra start' first.`,
    );
  }

  const port = Number(readFileSync(portPath, "utf8").trim());
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`penumbra dispatch audit: invalid daemon port in ${portPath}`);
  }
  if (!token) {
    throw new Error(`penumbra dispatch audit: empty daemon token in ${tokenPath}`);
  }

  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

export function formatDispatchAudit(report: DispatchReliabilityReport): string {
  return [
    `handoff: ${report.handoff_id}`,
    `status: ${report.status}`,
    `trustworthy: ${report.trustworthy ? "yes" : "no"}`,
    `summary: ${report.summary}`,
    `recommended_action: ${report.recommended_action}`,
    `missing_events: ${report.missing_events.length > 0 ? report.missing_events.join(", ") : "none"}`,
  ].join("\n");
}

export async function runDispatchAudit(opts: RunDispatchAuditOpts): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? defaultPrint;
  const daemon = resolveDaemon(opts.storageRoot);
  const params = new URLSearchParams({ handoff_id: opts.handoffId });
  const res = await fetcher(`${daemon.baseUrl}/dispatch/audit?${params.toString()}`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  if (!res.ok) {
    throw new Error(`penumbra dispatch audit: daemon /dispatch/audit returned HTTP ${res.status}`);
  }

  const body = (await res.json()) as DispatchAuditResponse;
  if (opts.json) {
    print(JSON.stringify(body.report, null, 2));
    return;
  }

  print(formatDispatchAudit(body.report));
}
