import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import {
  discoverCodexModels,
  parseCodexDebugModelsOutput,
} from "../../../src/commands/generator/discovery-codex.js";

const fixturePath = join(import.meta.dir, "../fixtures/codex-debug-models.json");
const fixtureText = readFileSync(fixturePath, "utf8");

async function withFakeDiscoveryCli<T>(run: () => Promise<T>): Promise<T> {
  const binDir = mkdtempSync(join(tmpdir(), "penumbra-codex-discovery-"));
  const previousPath = process.env.PATH;
  try {
    const agyPath = join(binDir, "agy");
    writeFileSync(agyPath, "#!/bin/sh\ncat > /dev/null\nprintf 'm1\\tModel One\\n'\n");
    chmodSync(agyPath, 0o755);

    const codexPath = join(binDir, "codex");
    writeFileSync(
      codexPath,
      '#!/bin/sh\ncat > /dev/null\nprintf \'{"models":[{"slug":"m1","display_name":"Model One"}]}\\n\'\n',
    );
    chmodSync(codexPath, 0o755);

    process.env.PATH = previousPath ? `${binDir}${delimiter}${previousPath}` : binDir;
    return await run();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    rmSync(binDir, { recursive: true, force: true });
  }
}

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

  test("discoverCodexModels closes stdin for the real codex CLI runner", async () => {
    const startedAt = Date.now();

    const models = await withFakeDiscoveryCli(async () => await discoverCodexModels());

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(models).toEqual([
      {
        sourceProviderId: "codex",
        modelId: "m1",
        displayName: "Model One",
      },
    ]);
  }, 5_000);
});
