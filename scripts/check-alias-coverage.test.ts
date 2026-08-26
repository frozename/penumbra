import { describe, expect, test } from "bun:test";

import type { ModelAliasMap } from "../packages/config/src/files/model-aliases.js";
import type { AaModelSnapshot } from "../packages/core/src/routing/schemas.js";

import { buildAliasCoverageReport } from "./check-alias-coverage.ts";

describe("check-alias-coverage", () => {
  test("buckets seat names into matched / dark (aliased, no snapshot match) / missing (no alias) using reconcileAliases", () => {
    const aliases: ModelAliasMap = {
      a: { aa_creator: "anthropic", aa_slug: "claude-opus-5" },
      b: { aa_creator: "anthropic", aa_slug: "claude-ghost-9" },
    };
    const snapshot: AaModelSnapshot = {
      collectedAt: "2026-08-26T00:00:00.000Z",
      models: [
        {
          id: "anthropic/claude-opus-5",
          name: "Claude Opus 5",
          slug: "claude-opus-5",
          model_creator: { id: "anthropic", name: "Anthropic", slug: "anthropic" },
          evaluations: {},
          pricing: {},
        },
      ],
    };

    const report = buildAliasCoverageReport(aliases, snapshot, ["a", "b", "c"]);

    expect(report.matched).toEqual(["a"]);
    expect(report.dark).toEqual(["b"]);
    expect(report.missing).toEqual(["c"]);
  });
});
