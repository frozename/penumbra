import { resolveDaemonStorageRoot } from "@penumbra/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function parseDuration(input: string): number {
  const m = /^(\d+)([smhd])$/.exec(input);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2] as "s" | "m" | "h" | "d";
    const mult: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    const factor = mult[unit];
    if (factor === undefined) {
      throw new Error(`Invalid duration: ${input}`);
    }
    return n * factor;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(input)) {
    return Date.now() - new Date(input).getTime();
  }
  throw new Error(`Invalid duration: ${input}`);
}

export interface RunCostOpts {
  since?: string;
  json: boolean;
  fetch?: typeof fetch;
  print?: (s: string) => void;
  storageRoot?: string;
  project_id?: string | null;
}

function resolveDaemon(storageRoot?: string): { baseUrl: string; token: string } {
  const root = storageRoot ?? resolveDaemonStorageRoot();
  const port = readFileSync(join(root, "port"), "utf8").trim();
  const token = readFileSync(join(root, "token"), "utf8").trim();
  if (!port || Number.isNaN(Number(port))) {
    throw new Error(`penumbra cost: invalid daemon port in ${join(root, "port")}`);
  }
  if (!token) {
    throw new Error(`penumbra cost: empty daemon token in ${join(root, "token")}`);
  }
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

function resolveSinceParam(since?: string): string | undefined {
  if (!since) return undefined;
  if (/^\d+[smhd]$/.test(since)) {
    return new Date(Date.now() - parseDuration(since)).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(since)) {
    return new Date(since).toISOString();
  }
  throw new Error(`Invalid duration: ${since}`);
}

function defaultPrint(s: string): void {
  process.stdout.write(`${s}\n`);
}

function formatNumber(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined) return "—";
  return n.toFixed(digits);
}

function formatPercent(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toFixed(1);
}

export async function runCostRecent(opts: RunCostOpts): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? defaultPrint;
  const since = resolveSinceParam(opts.since);
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (opts.project_id !== null && opts.project_id !== undefined)
    params.set("project_id", opts.project_id);

  const url = opts.fetch
    ? `/usage/recent${params.toString() ? `?${params.toString()}` : ""}`
    : ((): string => {
        const daemon = resolveDaemon(opts.storageRoot);
        return `${daemon.baseUrl}/usage/recent${params.toString() ? `?${params.toString()}` : ""}`;
      })();
  const headers = opts.fetch
    ? undefined
    : { authorization: `Bearer ${resolveDaemon(opts.storageRoot).token}` };
  const res = await fetcher(url, headers ? { headers } : undefined);
  if (!res.ok) {
    print(`error: HTTP ${String(res.status)}`);
    return;
  }

  const body = (await res.json()) as {
    total_cost_usd: number | null;
    total_tokens_used: number;
    handoff_count: number;
    by_provider: {
      provider: string | null;
      cost_usd: number | null;
      tokens_used: number;
      handoff_count: number;
    }[];
    window: { from: string; to: string };
  };

  if (opts.json) {
    print(JSON.stringify(body, null, 2));
    return;
  }

  print(`Cost ledger -- window ${body.window.from} -> ${body.window.to}`);
  print("");
  print(
    `  Total: ${formatNumber(body.total_cost_usd)}  (${String(body.total_tokens_used)} tokens, ${String(body.handoff_count)} dispatches)`,
  );
  print("  By provider:");
  if (body.by_provider.length === 0) {
    print("    (none)");
    return;
  }
  for (const row of body.by_provider) {
    const provider = (row.provider ?? "(unknown)").padEnd(14);
    print(
      `    ${provider} ${formatNumber(row.cost_usd)}  (${String(row.tokens_used)} tokens, ${String(row.handoff_count)} dispatches)`,
    );
  }
}

function quotaUrlAndHeaders(
  opts: RunCostOpts,
  paramsString: string,
): { url: string; headers: { authorization: string } | undefined } {
  const suffix = paramsString ? `?${paramsString}` : "";
  if (opts.fetch) return { url: `/usage/quota_status${suffix}`, headers: undefined };
  const daemon = resolveDaemon(opts.storageRoot);
  return {
    url: `${daemon.baseUrl}/usage/quota_status${suffix}`,
    headers: { authorization: `Bearer ${daemon.token}` },
  };
}

export async function runCostQuota(opts: RunCostOpts): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? defaultPrint;
  const since = resolveSinceParam(opts.since);
  const params = new URLSearchParams();
  if (since) params.set("since", since);

  const { url, headers } = quotaUrlAndHeaders(opts, params.toString());
  const res = await fetcher(url, headers ? { headers } : undefined);
  if (!res.ok) {
    print(`error: HTTP ${String(res.status)}`);
    return;
  }

  const body = (await res.json()) as {
    window: { from: string; to: string };
    providers: {
      provider: string;
      model?: string;
      used_usd: number | null;
      quota_usd: number | null;
      remaining_usd: number | null;
      remaining_pct_usd: number | null;
      used_tokens: number;
      quota_tokens: number | null;
      remaining_tokens: number | null;
      remaining_pct_tokens: number | null;
    }[];
  };

  if (opts.json) {
    print(JSON.stringify(body, null, 2));
    return;
  }

  print(`Quota status -- window ${body.window.from} -> ${body.window.to}`);
  print("");
  if (body.providers.length === 0) {
    print("  (no configured provider quotas)");
    return;
  }

  const labels = body.providers.map((p) => (p.model ? `${p.provider}/${p.model}` : p.provider));
  const labelWidth = Math.max(14, ...labels.map((l) => l.length));

  for (const [i, row] of body.providers.entries()) {
    const labelText = labels[i] ?? "";
    const label = labelText.padEnd(labelWidth);
    if (row.quota_usd !== null) {
      printQuotaUsd(print, label, row);
      continue;
    }
    if (row.quota_tokens !== null) {
      printQuotaTokens(print, label, row);
    }
  }
}

function printQuotaUsd(
  print: (s: string) => void,
  label: string,
  row: { used_usd: number | null; quota_usd: number | null; remaining_pct_usd: number | null },
): void {
  const usedDollars = "$" + formatNumber(row.used_usd, 2);
  const quotaDollars = "$" + formatNumber(row.quota_usd, 2);
  print(
    `  ${label} ${usedDollars} / ${quotaDollars}   (${formatPercent(row.remaining_pct_usd)}% remaining)`,
  );
}

function printQuotaTokens(
  print: (s: string) => void,
  label: string,
  row: {
    used_tokens: number;
    quota_tokens: number | null;
    remaining_pct_tokens: number | null;
  },
): void {
  print(
    `  ${label} ${String(row.used_tokens)} / ${String(row.quota_tokens)} tokens   (${formatPercent(row.remaining_pct_tokens)}% remaining)`,
  );
}
