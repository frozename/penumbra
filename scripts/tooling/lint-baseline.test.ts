import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

describe("lint baseline capture", () => {
  it(
    "writes a per-rule violation JSON to docs/quality/",
    () => {
      spawnSync("bun", ["run", "scripts/tooling/lint-baseline.ts"], {
        encoding: "utf8",
      });
      const out = "docs/quality/lint-baseline-2026-05-28.json";
      expect(existsSync(out)).toBe(true);
      const data = JSON.parse(readFileSync(out, "utf8"));
      expect(typeof data.totals.errors).toBe("number");
      expect(typeof data.totals.warnings).toBe("number");
      expect(typeof data.byRule).toBe("object");
    },
    120_000,
  );
});
