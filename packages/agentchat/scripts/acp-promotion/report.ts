import type { AcpPromotionRunResult } from "./types.js";

export function renderPromotionJsonl(rows: AcpPromotionRunResult[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

export function renderPromotionMarkdown(
  rows: AcpPromotionRunResult[],
  opts: { generatedAt: string },
): string {
  const lines: string[] = [];
  lines.push("# ACP Promotion Report");
  lines.push("");
  lines.push(`Generated: ${opts.generatedAt}`);
  lines.push("");
  lines.push(
    "| Agent | Scenario | Status | Reliability | Trustworthy | Action | Handoff | Failure |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    lines.push(
      `| ${row.agent} | ${row.scenario} | ${row.status} | ${row.reliability_status ?? ""} | ${row.trustworthy === null ? "" : String(row.trustworthy)} | ${row.recommended_action ?? ""} | ${row.handoff_id ?? ""} | ${row.failure_reason ?? ""} |`,
    );
  }
  lines.push("");
  lines.push("## Promotion Summary");
  lines.push("");
  for (const agent of [...new Set(rows.map((row) => row.agent))].sort()) {
    const agentRows = rows.filter((row) => row.agent === agent);
    const ready =
      agentRows.length > 0 &&
      agentRows.every((row) => row.status === "passed" && row.trustworthy === true);
    lines.push(`- ${agent}: ${ready ? "promotion-ready" : "not promotion-ready"}`);
  }
  lines.push("");
  lines.push("No routing changes were applied by this report.");
  lines.push("");
  return lines.join("\n");
}
