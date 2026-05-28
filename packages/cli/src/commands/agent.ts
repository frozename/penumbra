import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AgentPerformanceRow,
  type AgentSmokePass,
  type AgentTaskType,
  type ImportMarkdownResult,
  RecordOperatorAgentPerformanceInputSchema,
  resolveDaemonStorageRoot,
} from "@penumbra/core";

export interface RunAgentRankOpts {
  task_type: string;
  since?: string;
  min_samples?: number;
  include_neutral?: boolean;
  include_cost?: boolean;
  json: boolean;
  fetch?: typeof fetch;
  print?: (s: string) => void;
  storageRoot?: string;
}

export interface RunAgentLedgerAddOpts {
  handoff_id: string;
  task_type: AgentTaskType;
  outcome: AgentPerformanceRow["outcome"];
  rounds?: number;
  smoke_pass?: AgentSmokePass;
  reviewer_findings?: number;
  maestro_score?: number;
  cost_usd?: number;
  notes?: string;
  json: boolean;
  fetch?: typeof fetch;
  print?: (s: string) => void;
  storageRoot?: string;
}

export interface RunAgentLedgerImportOpts {
  from: string;
  fetch?: typeof fetch;
  print?: (s: string) => void;
  storageRoot?: string;
}

export interface RunAgentLedgerRenderOpts {
  out?: string;
  fetch?: typeof fetch;
  print?: (s: string) => void;
  storageRoot?: string;
  stdoutWrite?: (chunk: string) => unknown;
  stderrWrite?: (chunk: string) => unknown;
}

function defaultPrint(s: string): void {
  process.stdout.write(`${s}\n`);
}

function resolveDaemon(storageRoot?: string): { baseUrl: string; token: string } {
  const root = storageRoot ?? resolveDaemonStorageRoot();
  const port = readFileSync(join(root, "port"), "utf8").trim();
  const token = readFileSync(join(root, "token"), "utf8").trim();
  if (!port || Number.isNaN(Number(port))) {
    throw new Error(`penumbra agent: invalid daemon port in ${join(root, "port")}`);
  }
  if (!token) {
    throw new Error(`penumbra agent: empty daemon token in ${join(root, "token")}`);
  }
  return { baseUrl: `http://127.0.0.1:${Number(port)}`, token };
}

function buildDaemonRequest(
  pathname: string,
  storageRoot: string | undefined,
  hasCustomFetch: boolean,
): {
  url: string;
  headers: Record<string, string>;
} {
  if (hasCustomFetch) return { url: pathname, headers: {} };
  const daemon = resolveDaemon(storageRoot);
  return {
    url: `${daemon.baseUrl}${pathname}`,
    headers: { authorization: `Bearer ${daemon.token}` },
  };
}

function daemonError(prefix: string, pathname: string, status: number): Error {
  return new Error(`${prefix}: daemon ${pathname} returned HTTP ${status}`);
}

export async function runAgentRank(opts: RunAgentRankOpts): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? defaultPrint;
  const params = new URLSearchParams();
  params.set("task_type", opts.task_type);
  if (opts.since) params.set("since", opts.since);
  if (opts.min_samples != null) params.set("min_samples", String(opts.min_samples));
  if (opts.include_neutral != null) params.set("include_neutral", String(opts.include_neutral));
  if (opts.include_cost != null) params.set("include_cost", String(opts.include_cost));

  const daemon = opts.fetch ? null : resolveDaemon(opts.storageRoot);
  const url = opts.fetch
    ? `/agents/rank?${params.toString()}`
    : `${daemon!.baseUrl}/agents/rank?${params.toString()}`;
  const headers = daemon ? { authorization: `Bearer ${daemon.token}` } : undefined;
  const res = await fetcher(url, headers ? { headers } : undefined);
  if (!res.ok) {
    print(`error: HTTP ${res.status}`);
    return;
  }

  const body = (await res.json()) as {
    task_type: string;
    window: { from: string | null; to: string };
    candidates: Array<{
      agent_name: string;
      score: number;
      samples: number;
      success_rate: number;
      avg_rounds: number | null;
      avg_latency_ms: number | null;
      cost_per_success_usd: number | null;
    }>;
  };

  if (opts.json) {
    print(JSON.stringify(body, null, 2));
    return;
  }

  print(
    `Agent rank -- task_type=${body.task_type} window ${body.window.from ?? "all-time"} -> ${body.window.to}`,
  );
  print("");
  print("  agent               score  samples  success  avg_rounds  cost/success  latency");
  if (body.candidates.length === 0) {
    print("  (none)");
    return;
  }
  for (const row of body.candidates) {
    const agent = row.agent_name.padEnd(19);
    const score = `${(row.score * 100).toFixed(1)}%`.padEnd(6);
    const samples = String(row.samples).padEnd(7);
    const success = `${(row.success_rate * 100).toFixed(1)}%`.padEnd(8);
    const rounds = (row.avg_rounds == null ? "-" : row.avg_rounds.toFixed(1)).padEnd(10);
    const cost = (
      row.cost_per_success_usd == null ? "-" : `$${row.cost_per_success_usd.toFixed(4)}`
    ).padEnd(13);
    const latency = row.avg_latency_ms == null ? "-" : `${Math.round(row.avg_latency_ms / 1000)}s`;
    print(`  ${agent} ${score} ${samples} ${success} ${rounds} ${cost} ${latency}`);
  }
}

export async function runAgentLedgerAdd(opts: RunAgentLedgerAddOpts): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? defaultPrint;
  const parsed = RecordOperatorAgentPerformanceInputSchema.safeParse({
    handoff_id: opts.handoff_id,
    task_type: opts.task_type,
    outcome: opts.outcome,
    rounds: opts.rounds,
    smoke_pass: opts.smoke_pass,
    reviewer_findings: opts.reviewer_findings,
    maestro_score: opts.maestro_score,
    cost_usd: opts.cost_usd,
    notes: opts.notes,
  });
  if (!parsed.success) {
    throw new Error(
      `penumbra agent ledger add: invalid input (${parsed.error.issues.map((issue) => issue.message).join(", ")})`,
    );
  }

  const request = buildDaemonRequest(
    "/agents/performance/operator",
    opts.storageRoot,
    Boolean(opts.fetch),
  );
  const res = await fetcher(request.url, {
    method: "POST",
    headers: {
      ...request.headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(parsed.data),
  });
  if (!res.ok)
    throw daemonError("penumbra agent ledger add", "/agents/performance/operator", res.status);

  const body = (await res.json()) as { performance: AgentPerformanceRow };
  if (opts.json) {
    print(JSON.stringify(body.performance, null, 2));
    return;
  }

  print(
    `recorded ${body.performance.agent_name} ${body.performance.task_type} ${body.performance.outcome} for ${body.performance.handoff_id}`,
  );
}

export async function runAgentLedgerImport(opts: RunAgentLedgerImportOpts): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? defaultPrint;
  const sourcePath = resolve(opts.from);
  const markdown = await Bun.file(sourcePath).text();
  const request = buildDaemonRequest(
    "/agents/performance/import-markdown",
    opts.storageRoot,
    Boolean(opts.fetch),
  );
  const res = await fetcher(request.url, {
    method: "POST",
    headers: {
      ...request.headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({ markdown, sourcePath, projectId: null }),
  });
  if (!res.ok)
    throw daemonError(
      "penumbra agent ledger import",
      "/agents/performance/import-markdown",
      res.status,
    );

  const body = (await res.json()) as ImportMarkdownResult;
  print(`imported: ${body.imported}, skipped: ${body.skipped}`);
}

export async function runAgentLedgerRender(opts: RunAgentLedgerRenderOpts): Promise<void> {
  const request = buildDaemonRequest(
    "/agents/performance/markdown",
    opts.storageRoot,
    Boolean(opts.fetch),
  );
  const res = await (opts.fetch ?? fetch)(request.url, {
    headers: request.headers,
  });
  if (!res.ok)
    throw daemonError("penumbra agent ledger render", "/agents/performance/markdown", res.status);

  const markdown = await res.text();
  if (opts.out) {
    const outPath = resolve(opts.out);
    await Bun.write(outPath, markdown);
    (opts.print ?? defaultPrint)(`wrote ledger to ${outPath}`);
    return;
  }

  (opts.stdoutWrite ?? process.stdout.write.bind(process.stdout))(markdown);
  const confirmation = `wrote ${Buffer.byteLength(markdown, "utf8")} bytes to stdout`;
  if (opts.print) {
    opts.print(confirmation);
    return;
  }
  (opts.stderrWrite ?? process.stderr.write.bind(process.stderr))(`${confirmation}\n`);
}
