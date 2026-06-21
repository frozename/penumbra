import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

type TsConfig = {
  files: unknown[];
  references: unknown[];
};

type PackageJson = {
  scripts: Record<string, string>;
};

describe("strict-lint rollout — baseline invariants", () => {
  it("tsconfig.json keeps the project-references shape", () => {
    const cfg = JSON.parse(readFileSync("tsconfig.json", "utf8")) as TsConfig;
    expect(cfg.files).toEqual([]);
    expect(Array.isArray(cfg.references)).toBe(true);
    expect(cfg.references.length).toBeGreaterThan(0);
  });

  it("root typecheck script still drives tsc --build", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
    expect(pkg.scripts.typecheck).toContain("tsc --build");
  });

  // The "tsc --build exits 0" invariant is gated by the dedicated CI `typecheck`
  // step (`bun run typecheck`), which runs in isolation before the test step.
  // Re-running the whole-monorepo typecheck inside the test runner duplicated
  // that, was slow, and depended on dist freshness at test time — it passed alone
  // but flaked amid other tests. Keep the cheap, deterministic scaffolding
  // invariants above; leave the build gate to the CI step.
});
