import { describe, it, expect } from "bun:test";
import { getDreamingHealthAlerts } from "../../src/tools/dreaming-health.js";

describe("dreaming-health", () => {
  it("reports current running cycle and no alerts", () => {
    const mockDb = {
      prepare: () => ({
        get: () => ({ c: 1 }),
      }),
    };
    const res = getDreamingHealthAlerts(mockDb, { daemonUptimeMs: 1000 });
    expect(res.alerts).toEqual([]);
    expect(res.cycles_in_last_24h).toBe(1);
  });

  it("dream.health.no_cycles_24h alert when uptime > 24h, zero cycles", () => {
    const mockDb = {
      prepare: (sql: string) => ({
        get: () => {
          if (sql.includes('outcome = "crashed"')) return { c: 0 };
          return { c: 0 };
        },
      }),
    };
    const res = getDreamingHealthAlerts(mockDb, { daemonUptimeMs: 25 * 60 * 60 * 1000 });
    expect(res.alerts).toContain("dream.health.no_cycles_24h");
  });

  it("dream.health.crashed_high alert when crashed_24h >= 3", () => {
    const mockDb = {
      prepare: (sql: string) => ({
        get: () => {
          if (sql.includes('outcome = "crashed"')) return { c: 3 };
          return { c: 1 };
        },
      }),
    };
    const res = getDreamingHealthAlerts(mockDb, { daemonUptimeMs: 1000 });
    expect(res.alerts).toContain("dream.health.crashed_high");
  });
});
