export interface InvocationSummaryInputRow {
  ts: string;
  tool: string;
  origin: string;
  args_bytes: number;
  result_bytes: number;
  duration_ms: number;
  ok: boolean;
  error_kind: string | null;
}

export interface SummaryRow {
  calls: number;
  errors: number;
  total_bytes_in: number;
  total_bytes_out: number;
  p50_bytes_out: number;
  p95_bytes_out: number;
  first_error: string | null;
  origins: Set<string>;
}

function pickNearestRank(sortedAscending: number[], percentile: number): number {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(
    sortedAscending.length - 1,
    Math.floor((sortedAscending.length * percentile) / 100),
  );
  return sortedAscending[index] ?? 0;
}

export function summarize(rows: InvocationSummaryInputRow[]): Map<string, SummaryRow> {
  const out = new Map<string, SummaryRow>();
  const bytesByTool = new Map<string, number[]>();

  for (const row of rows) {
    const current = out.get(row.tool) ?? {
      calls: 0,
      errors: 0,
      total_bytes_in: 0,
      total_bytes_out: 0,
      p50_bytes_out: 0,
      p95_bytes_out: 0,
      first_error: null,
      origins: new Set<string>(),
    };
    current.calls += 1;
    current.total_bytes_in += row.args_bytes;
    current.total_bytes_out += row.result_bytes;
    current.origins.add(row.origin);
    if (!row.ok) {
      current.errors += 1;
      if (current.first_error === null) {
        current.first_error = row.error_kind;
      }
    }
    out.set(row.tool, current);

    const bytes = bytesByTool.get(row.tool) ?? [];
    bytes.push(row.result_bytes);
    bytesByTool.set(row.tool, bytes);
  }

  for (const [tool, summaryRow] of out.entries()) {
    const sorted = [...(bytesByTool.get(tool) ?? [])].sort((a, b) => a - b);
    summaryRow.p50_bytes_out = pickNearestRank(sorted, 50);
    summaryRow.p95_bytes_out = pickNearestRank(sorted, 95);
  }

  return out;
}

export function parseLines(lines: string[]): InvocationSummaryInputRow[] {
  const rows: InvocationSummaryInputRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as InvocationSummaryInputRow);
    } catch {
      // Intentionally skip malformed JSONL rows.
    }
  }
  return rows;
}
