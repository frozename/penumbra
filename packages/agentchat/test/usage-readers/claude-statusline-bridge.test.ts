import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeStatusLineBridge } from "@src/usage-readers/claude-statusline-bridge.js";

function tmpCache(): string {
  return join(mkdtempSync(join(tmpdir(), "claude-rl-")), "rl.json");
}

describe("ClaudeStatusLineBridge", () => {
  it("emits one rate-limit-snapshot per window with provider=anthropic", async () => {
    const path = tmpCache();
    writeFileSync(
      path,
      JSON.stringify({
        five_hour: { used_percentage: 30, resets_at: 1777364441 },
        seven_day: { used_percentage: 50, resets_at: 1777545224 },
      }),
    );
    const reader = new ClaudeStatusLineBridge({ cachePath: path });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(2);
    expect(r.rate_limit_snapshots.every((s) => s.provider === "anthropic")).toBe(true);
    expect(r.rate_limit_snapshots.find((s) => s.window_label === "five_hour")?.used_pct).toBe(30);
    expect(r.rate_limit_snapshots.find((s) => s.window_label === "seven_day")?.used_pct).toBe(50);
  });

  it("accepts utilization as alternate field name", async () => {
    const path = tmpCache();
    writeFileSync(
      path,
      JSON.stringify({
        five_hour: { utilization: 25, resets_at: 1777364441 },
      }),
    );
    const reader = new ClaudeStatusLineBridge({ cachePath: path });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(1);
    expect(r.rate_limit_snapshots.at(0)?.used_pct).toBe(25);
  });

  it("does not re-emit when file mtime is unchanged", async () => {
    const path = tmpCache();
    writeFileSync(path, JSON.stringify({ five_hour: { used_percentage: 10, resets_at: 1 } }));
    const reader = new ClaudeStatusLineBridge({ cachePath: path });
    const r1 = await reader.read(null);
    expect(r1.rate_limit_snapshots).toHaveLength(1);
    const r2 = await reader.read(r1.cursor);
    expect(r2.rate_limit_snapshots).toHaveLength(0);
  });
});
