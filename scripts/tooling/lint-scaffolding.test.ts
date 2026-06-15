import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

describe("lint scaffolding", () => {
  it("eslint config resolves (scaffolding present, dependencies installed)", () => {
    // Resolve the flat config for a single file instead of linting the whole
    // repo. This verifies the eslint config + deps are present in ~1s. A full
    // `bun run lint` runs type-aware linting over every file and exceeds a sane
    // test timeout even locally (~25s+), so checking the toolchain is wired is
    // this test's job; actually running lint is the advisory CI `lint` step's.
    const r = spawnSync(
      "bunx",
      ["eslint", "--print-config", "scripts/tooling/lint-scaffolding.test.ts"],
      { encoding: "utf8" },
    );
    // exit 0 = config resolved; 128 is eslint's "no config found" (scaffolding broken).
    expect(r.status).not.toBe(128);
    expect(r.status).toBe(0);
  }, 30000);
});
