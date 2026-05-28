import type { FilterContrib } from "./index.js";
export function conceptFilter(concept: string | undefined, col = "concepts"): FilterContrib | null {
  return concept ? { sql: `${col} LIKE '%' || ? || '%'`, params: [concept] } : null;
}
