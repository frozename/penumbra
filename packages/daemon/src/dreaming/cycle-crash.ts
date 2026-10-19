import type { Database } from "bun:sqlite";

// Without this the row stays 'running' until the next daemon boot's zombie
// sweep, and dreaming_health keeps reporting the dead cycle as in flight.
export function finalizeCycleAsCrashed(db: Database, cycleId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  db.prepare(
    `UPDATE dream_cycles SET outcome='crashed', bail_reason=?, ended_at=? WHERE cycle_id=? AND outcome='running'`,
  ).run(`phase_error: ${message}`, Date.now(), cycleId);
}
