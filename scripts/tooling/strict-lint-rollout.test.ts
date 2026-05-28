import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

describe("strict-lint rollout — baseline invariants", () => {
  it("tsconfig.json keeps the project-references shape", () => {
    const cfg = JSON.parse(readFileSync("tsconfig.json", "utf8"));
    expect(cfg.files).toEqual([]);
    expect(Array.isArray(cfg.references)).toBe(true);
    expect(cfg.references.length).toBeGreaterThan(0);
  });

  it("root typecheck script still drives tsc --build", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts.typecheck).toContain("tsc --build");
  });

  it("tsc --build exits 0", () => {
    const r = spawnSync("bun", ["run", "typecheck"], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});
