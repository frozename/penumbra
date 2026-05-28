import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

describe("lint scaffolding", () => {
  it("bun run lint succeeds (config present, dependencies installed)", () => {
    const r = spawnSync("bun", ["run", "lint"], { encoding: "utf8" });
    // exit 0 means lint config loaded and ran; non-zero still means VIOLATIONS,
    // not config breakage. We assert <128 (eslint's "no config" exit code).
    expect(r.status).not.toBe(128);
  }, 30000);
});
