import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RuleCounts = { errors: number; warnings: number };
type BaselineFile = {
  totals: RuleCounts;
  byRule: Record<string, RuleCounts>;
  byFile: Record<string, RuleCounts>;
};

describe("lint baseline capture", () => {
  it("writes a per-rule violation JSON to the configured path", () => {
    // Capture into a temp dir via LINT_BASELINE_OUT so the run asserts the
    // script's ACTUAL output (not an unrelated committed snapshot) and does not
    // litter the tracked docs/quality/ tree with a fresh dated file.
    const dir = mkdtempSync(join(tmpdir(), "lint-baseline-"));
    const out = join(dir, "baseline.json");
    try {
      const res = spawnSync("bun", ["run", "scripts/tooling/lint-baseline.ts"], {
        encoding: "utf8",
        env: { ...process.env, LINT_BASELINE_OUT: out },
      });
      // Assert the run itself succeeded so a spawn failure (bun off PATH) or a
      // script error (eslint produced no JSON) surfaces directly instead of as a
      // bare existsSync===false a step later.
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(0);
      expect(existsSync(out)).toBe(true);
      const data = JSON.parse(readFileSync(out, "utf8")) as BaselineFile;
      expect(typeof data.totals.errors).toBe("number");
      expect(typeof data.totals.warnings).toBe("number");
      expect(typeof data.byRule).toBe("object");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
