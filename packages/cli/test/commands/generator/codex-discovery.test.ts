import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  discoverCodexModels,
  parseCodexDebugModelsOutput,
} from "../../../src/commands/generator/discovery-codex.js";

const fixturePath = join(import.meta.dir, "../fixtures/codex-debug-models.json");
const fixtureText = readFileSync(fixturePath, "utf8");

describe("codex model discovery", () => {
  test("parseCodexDebugModelsOutput extracts slug/display/reasoning-tier variants from a captured fixture", () => {
    const models = parseCodexDebugModelsOutput(fixtureText);

    expect(models).toHaveLength(43);
    expect(models).toContainEqual({
      sourceProviderId: "codex",
      modelId: "gpt-5.5",
      displayName: "GPT-5.5",
      reasoningTier: "high",
    });
    expect(
      models.filter((model) => model.modelId === "gpt-5.6-sol").map((model) => model.reasoningTier),
    ).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(
      models.filter((model) => model.modelId === "gpt-5.5").map((model) => model.reasoningTier),
    ).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("parseCodexDebugModelsOutput preserves unknown tiers and deduplicates them per model", () => {
    const models = parseCodexDebugModelsOutput(
      JSON.stringify({
        models: [
          {
            slug: "future-model",
            display_name: "Future Model",
            supported_reasoning_levels: [
              { effort: "medium" },
              { effort: "future-tier" },
              { effort: "medium" },
            ],
          },
        ],
      }),
    );

    expect(models.map((model) => model.reasoningTier)).toEqual(["medium", "future-tier"]);
  });

  test("discoverCodexModels uses the injected debug-model runner", async () => {
    let runCount = 0;
    const expected = parseCodexDebugModelsOutput(fixtureText);

    const models = await discoverCodexModels({
      runCodexDebugModels: async () => {
        runCount += 1;
        return fixtureText;
      },
    });

    expect(runCount).toBe(1);
    expect(models).toEqual(expected);
  });
});
