import type { SQLQueryBindings } from "bun:sqlite";

export interface FilterContrib {
  sql: string; // a single SQL fragment without leading AND
  params: SQLQueryBindings[];
}

export function combineFilters(contribs: FilterContrib[]): {
  whereSql: string;
  params: SQLQueryBindings[];
} {
  if (contribs.length === 0) return { whereSql: "1=1", params: [] };
  return {
    whereSql: contribs.map((c) => `(${c.sql})`).join(" AND "),
    params: contribs.flatMap((c) => c.params),
  };
}

export { conceptFilter } from "./concept.js";
export { dateFilter } from "./date.js";
export { fileFilter } from "./file.js";
export { projectFilter } from "./project.js";
export { typeFilter } from "./type.js";
