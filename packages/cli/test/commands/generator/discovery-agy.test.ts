import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  discoverAgyModels,
  parseAgyModelsOutput,
} from "../../../src/commands/generator/discovery-agy.js";

const fixturePath = join(import.meta.dir, "../fixtures/agy-models.txt");
const fixtureText = readFileSync(fixturePath, "utf8");

async function withFakeDiscoveryCli<T>(run: () => Promise<T>): Promise<T> {
  const binDir = mkdtempSync(join(tmpdir(), "penumbra-agy-discovery-"));
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

describe("agy model discovery", () => {
  test("parseAgyModelsOutput parses tab-separated slug/display-name lines and skips the status line", () => {
    const models = parseAgyModelsOutput(fixtureText);

    expect(models).toHaveLength(14);
    expect(models[0]).toEqual({
      sourceProviderId: "agy",
      modelId: "gemini-3.7-flash-high",
      displayName: "Gemini 3.7 Flash (High)",
    });
    expect(models.some((model) => model.modelId === "Fetching available models...")).toBe(false);
  });

  test("parseAgyModelsOutput trims surrounding whitespace from model ids and display names", () => {
    expect(parseAgyModelsOutput(" gemini-3.7-flash-high \t Gemini 3.7 Flash (High) \n")).toEqual([
      {
        sourceProviderId: "agy",
        modelId: "gemini-3.7-flash-high",
        displayName: "Gemini 3.7 Flash (High)",
      },
    ]);
  });

  test("discoverAgyModels reports malformed rows while preserving valid rows", async () => {
    const result = (await discoverAgyModels({
      runAgyModels: () =>
        [
          "no-tab-row",
          "first-tab\tName\twith tab",
          "empty-name\t   ",
          " clean-id \t Clean Name ",
        ].join("\n"),
    })) as unknown as {
      models: ReturnType<typeof parseAgyModelsOutput>;
      diagnostics: { row: string; reason: string }[];
    };

    expect(result.models).toEqual([
      {
        sourceProviderId: "agy",
        modelId: "first-tab",
        displayName: "Name\twith tab",
      },
      {
        sourceProviderId: "agy",
        modelId: "clean-id",
        displayName: "Clean Name",
      },
    ]);
    expect(result.diagnostics).toEqual([
      { row: "no-tab-row", reason: "missing tab separator" },
      { row: "empty-name\t   ", reason: "empty display name" },
    ]);
  });

  test("discoverAgyModels uses the injected model runner", async () => {
    let runCount = 0;

    const result = (await discoverAgyModels({
      runAgyModels: () => {
        runCount += 1;
        return fixtureText;
      },
    })) as unknown as { models: ReturnType<typeof parseAgyModelsOutput> };

    expect(runCount).toBe(1);
    expect(result.models).toEqual(parseAgyModelsOutput(fixtureText));
  });

  test("discoverAgyModels closes stdin for the real agy CLI runner", async () => {
    const startedAt = Date.now();

    const result = (await withFakeDiscoveryCli(async () => await discoverAgyModels())) as {
      models: ReturnType<typeof parseAgyModelsOutput>;
    };

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(result.models).toEqual([
      {
        sourceProviderId: "agy",
        modelId: "m1",
        displayName: "Model One",
      },
    ]);
  }, 5_000);
});
