import type { FilterContrib } from "./index.js";
export function typeFilter(obsType: string | undefined, col = "obs_type"): FilterContrib | null {
  return obsType ? { sql: `${col} = ?`, params: [obsType] } : null;
}
