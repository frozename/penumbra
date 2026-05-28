import type { FilterContrib } from "./index.js";
export function dateFilter(
  start: string | undefined,
  end: string | undefined,
  col = "created_at",
): FilterContrib | null {
  if (!start && !end) return null;
  if (start && !end) return { sql: `${col} >= ?`, params: [start] };
  if (!start && end) return { sql: `${col} <= ?`, params: [end] };
  return { sql: `${col} BETWEEN ? AND ?`, params: [start!, end!] };
}
