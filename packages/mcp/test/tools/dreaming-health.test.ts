import type { Database } from "bun:sqlite";

import { describe, expect, it } from "bun:test";

import { getDreamingHealthAlerts } from "../../src/tools/dreaming-health.js";

interface PreparedStub {
  get: (...args: unknown[]) => { c: number };
}

function makeDb(prepareImpl: (sql: string) => PreparedStub): Database {
  // Test boundary: the production code only exercises .prepare().get() against
  // these queries, so a minimal structural double is safe across the cast.
  return { prepare: prepareImpl } as unknown as Database;
}

describe("dreaming-health", () => {
  it("reports current running cycle and no alerts", (): void => {
    const mockDb = makeDb(
      (): PreparedStub => ({
        get: (): { c: number } => ({ c: 1 }),
      }),
    );
    const res = getDreamingHealthAlerts(mockDb, { daemonUptimeMs: 1000 });
    expect(res.alerts).toEqual([]);
    expect(res.cycles_in_last_24h).toBe(1);
  });

  it("dream.health.no_cycles_24h alert when uptime > 24h, zero cycles", (): void => {
    const mockDb = makeDb(
      (sql): PreparedStub => ({
        get: (): { c: number } => {
          if (sql.includes('outcome = "crashed"')) return { c: 0 };
          return { c: 0 };
        },
      }),
    );
    const res = getDreamingHealthAlerts(mockDb, { daemonUptimeMs: 25 * 60 * 60 * 1000 });
    expect(res.alerts).toContain("dream.health.no_cycles_24h");
  });

  it("dream.health.crashed_high alert when crashed_24h >= 3", (): void => {
    const mockDb = makeDb(
      (sql): PreparedStub => ({
        get: (): { c: number } => {
          if (sql.includes('outcome = "crashed"')) return { c: 3 };
          return { c: 1 };
        },
      }),
    );
    const res = getDreamingHealthAlerts(mockDb, { daemonUptimeMs: 1000 });
    expect(res.alerts).toContain("dream.health.crashed_high");
  });

  it("dream.health.rewrite_failing alert when rewrites only fail", (): void => {
    const mockDb = makeDb(
      (): PreparedStub => ({
        get: (...args: unknown[]): { c: number } => {
          if (args.includes("dream_p4_query_rewrite_failed")) return { c: 3 };
          if (args.includes("dream_p4_query_rewritten")) return { c: 0 };
          return { c: 1 };
        },
      }),
    );
    const res = getDreamingHealthAlerts(mockDb, { daemonUptimeMs: 1000 });
    expect(res.alerts).toContain("dream.health.rewrite_failing");
  });
});
