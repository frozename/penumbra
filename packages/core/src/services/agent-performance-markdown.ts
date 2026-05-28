import { createHash } from "node:crypto";
import {
  AgentPerformanceMarkdownParseInputSchema,
  AgentPerformanceRowSchema,
  AgentTaskTypeSchema,
  type AgentPerformanceMarkdownParseInput,
  type AgentPerformanceRow,
} from "../schemas/agent-performance.js";

const CANONICAL_HEADER = [
  "ts",
  "agent",
  "task_type",
  "outcome",
  "rounds",
  "smoke_pass",
  "maestro_score",
  "reviewer_findings",
  "cost_usd",
  "latency_min",
  "notes",
] as const;

function normalizeHeaderCell(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function splitPipeRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const body = trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
  return body.split("|").map((cell) => cell.trim());
}

function isDividerRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseIntegerCell(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "n/a") return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseCostCell(value: string, metadata: Record<string, string>): number | null {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed === "" || lower === "n/a") return null;
  if (lower === "<1") {
    metadata.cost_marker = "<1";
    return null;
  }
  const hasApprox = trimmed.startsWith("~");
  const normalized = hasApprox ? trimmed.slice(1).trim() : trimmed;
  const parsed = Number.parseFloat(normalized);
  if (Number.isNaN(parsed)) return null;
  if (hasApprox) metadata.cost_marker = "~";
  return parsed;
}

function parseLatencyCell(value: string, metadata: Record<string, string>): number | null {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed === "" || lower === "n/a") return null;
  if (lower === "<1") {
    metadata.latency_marker = "<1";
    return null;
  }
  const parsed = Number.parseFloat(trimmed);
  if (Number.isNaN(parsed)) return null;
  return Math.round(parsed * 60_000);
}

function parseSmokeCell(
  value: string,
  metadata: Record<string, string>,
): AgentPerformanceRow["smoke_pass"] {
  const trimmed = value.trim();
  if (trimmed.endsWith("*")) {
    metadata.smoke_marker = "*";
  }
  const normalized = trimmed.replace(/\*$/, "").trim().toLowerCase();
  if (normalized === "" || normalized === "n/a") return "n/a";
  return normalized as AgentPerformanceRow["smoke_pass"];
}

function parseOutcomeCell(
  value: string,
  metadata: Record<string, string>,
): AgentPerformanceRow["outcome"] {
  const trimmed = value.trim();
  if (trimmed.endsWith("*")) {
    metadata.legacy_marker = "*";
  }
  return trimmed.replace(/\*$/, "").trim() as AgentPerformanceRow["outcome"];
}

function stableManualId(input: {
  projectId: string | null | undefined;
  ts: string;
  agentName: string;
  taskType: string;
  outcome: string;
  notes: string | null;
}): string {
  const hash = createHash("sha256")
    .update(
      [
        input.projectId ?? "",
        input.ts,
        input.agentName,
        input.taskType,
        input.outcome,
        input.notes ?? "",
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 16);
  return `manual:${hash}`;
}

function formatTsCell(ts: string): string {
  return /^\d{4}-\d{2}-\d{2}T/.test(ts) ? ts.slice(0, 10) : ts;
}

function formatCostCell(row: AgentPerformanceRow, metadata: Record<string, unknown>): string {
  if (metadata.cost_marker === "<1") return "<1";
  if (row.cost_usd == null) return "n/a";
  const prefix = metadata.cost_marker === "~" ? "~" : "";
  return `${prefix}${row.cost_usd.toFixed(2)}`;
}

function formatLatencyCell(row: AgentPerformanceRow, metadata: Record<string, unknown>): string {
  if (metadata.latency_marker === "<1") return "<1";
  if (row.latency_ms == null) return "n/a";
  return String(Number((row.latency_ms / 60_000).toFixed(6)));
}

function parseMetadata(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseAgentPerformanceMarkdownRows(
  inputRaw: AgentPerformanceMarkdownParseInput,
): AgentPerformanceRow[] {
  const inputResult = AgentPerformanceMarkdownParseInputSchema.safeParse(inputRaw);
  if (!inputResult.success) {
    throw new Error(
      `invalid agent performance markdown input: ${inputResult.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }
  const input = inputResult.data;
  const lines = input.markdown.split(/\r?\n/);
  const rows: AgentPerformanceRow[] = [];

  for (let index = 0; index < lines.length; index++) {
    const headerCells = splitPipeRow(lines[index] ?? "");
    if (!headerCells || headerCells.length !== CANONICAL_HEADER.length) continue;
    const normalizedHeader = headerCells.map(normalizeHeaderCell);
    if (!normalizedHeader.every((cell, idx) => cell === CANONICAL_HEADER[idx])) continue;

    const dividerCells = splitPipeRow(lines[index + 1] ?? "");
    if (
      !dividerCells ||
      dividerCells.length !== CANONICAL_HEADER.length ||
      !isDividerRow(dividerCells)
    )
      continue;

    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex++) {
      const rowCells = splitPipeRow(lines[rowIndex] ?? "");
      if (!rowCells) {
        index = rowIndex;
        break;
      }
      if (rowCells.length !== CANONICAL_HEADER.length) {
        continue;
      }

      const metadata: Record<string, string> = { source_path: input.sourcePath };
      const ts = rowCells[0]!.trim();
      const agentName = rowCells[1]!.trim();
      const rawTaskType = rowCells[2]!.trim();
      const taskType = AgentTaskTypeSchema.safeParse(rawTaskType).success ? rawTaskType : "unknown";
      if (taskType !== rawTaskType) {
        // Preserve legacy task types only for forensic lookup in metadata.
        metadata.task_type_original = rawTaskType;
      }
      const outcome = parseOutcomeCell(rowCells[3]!, metadata);
      const notes = rowCells[10]!.trim() === "" ? null : rowCells[10]!.trim();
      const handoffId = stableManualId({
        projectId: input.projectId,
        ts,
        agentName,
        taskType,
        outcome,
        notes,
      });

      const parsedRow = AgentPerformanceRowSchema.safeParse({
        performance_id: handoffId,
        ts,
        handoff_id: handoffId,
        conversation_id: null,
        project_id: input.projectId ?? null,
        agent_name: agentName,
        task_type: taskType,
        outcome,
        rounds: parseIntegerCell(rowCells[4]!),
        smoke_pass: parseSmokeCell(rowCells[5]!, metadata),
        reviewer_findings: parseIntegerCell(rowCells[7]!),
        maestro_score: parseIntegerCell(rowCells[6]!),
        cost_usd: parseCostCell(rowCells[8]!, metadata),
        tokens_used: null,
        latency_ms: parseLatencyCell(rowCells[9]!, metadata),
        source: "manual_seed",
        notes,
        metadata_json: JSON.stringify(metadata),
      });
      if (!parsedRow.success) {
        throw new Error(
          `invalid agent performance markdown row at line ${rowIndex + 1}: ${parsedRow.error.issues.map((issue) => issue.message).join(", ")}`,
        );
      }
      rows.push(parsedRow.data);
      index = rowIndex;
    }
  }

  return rows;
}

export function renderAgentPerformanceMarkdown(
  rows: AgentPerformanceRow[],
  opts: { generatedAt?: string | Date } = {},
): string {
  const generatedAt =
    opts.generatedAt instanceof Date
      ? opts.generatedAt.toISOString()
      : (opts.generatedAt ?? new Date().toISOString());
  const sortedRows = [...rows].sort(
    (a, b) =>
      a.ts.localeCompare(b.ts) ||
      a.agent_name.localeCompare(b.agent_name) ||
      a.performance_id.localeCompare(b.performance_id),
  );

  const header =
    "| ts | agent | task_type | outcome | rounds | smoke_pass | maestro_score | reviewer_findings | cost_usd | latency_min | notes |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = sortedRows
    .map((row) => {
      const metadata = parseMetadata(row.metadata_json);
      const legacyMarker = metadata.legacy_marker === "*" ? "*" : "";
      const smokeMarker = metadata.smoke_marker === "*" ? "*" : "";
      const smoke = row.smoke_pass == null ? "n/a" : `${row.smoke_pass}${smokeMarker}`;
      return [
        formatTsCell(row.ts),
        row.agent_name,
        row.task_type,
        `${row.outcome}${legacyMarker}`,
        row.rounds == null ? "" : String(row.rounds),
        smoke,
        row.maestro_score == null ? "" : String(row.maestro_score),
        row.reviewer_findings == null ? "" : String(row.reviewer_findings),
        formatCostCell(row, metadata),
        formatLatencyCell(row, metadata),
        row.notes ?? "",
      ];
    })
    .map((cells) => `| ${cells.join(" | ")} |`);

  return [
    "# Agent performance ledger",
    "",
    `Generated from agent_performance at ${generatedAt}.`,
    "",
    header,
    divider,
    ...body,
    "",
  ].join("\n");
}
