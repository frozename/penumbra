import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  discoverDevinModels,
  parseDevinModelsOutput,
  parseDevinModelsOutputReport,
} from "@src/commands/generator/discovery-devin.js";

const fixturePath = join(import.meta.dir, "../fixtures/devin-models.json");
const fixtureText = readFileSync(fixturePath, "utf8");

async function withFakeDevinCli<T>(run: () => Promise<T>): Promise<T> {
  const binDir = mkdtempSync(join(tmpdir(), "penumbra-devin-discovery-"));
  const previousPath = process.env.PATH;
  try {
    const devinPath = join(binDir, "devin");
    writeFileSync(
      devinPath,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${fixtureText.replaceAll("'", "'\\''")}'\n`,
    );
    chmodSync(devinPath, 0o755);

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

describe("devin model discovery", () => {
  test("parseDevinModelsOutput maps families[].variants[] to DiscoveredModel with metadata", () => {
    const models = parseDevinModelsOutput(fixtureText);

    const swe17 = models.find((model) => model.modelId === "swe-1-7");
    expect(swe17).toEqual({
      sourceProviderId: "devin",
      modelId: "swe-1-7",
      displayName: "SWE 1.7",
      metadata: {
        family: "swe-1.7",
        familyLabel: "SWE 1.7",
        costTier: "Free",
        context: 256000,
        isBeta: false,
      },
    });
  });

  test("parseDevinModelsOutput does NOT emit reasoningTier — the tier is baked into the uid", () => {
    const report = parseDevinModelsOutputReport(fixtureText);

    for (const model of report.models) {
      expect(model.reasoningTier).toBeUndefined();
    }

    const swe17Medium = report.models.find((model) => model.modelId === "swe-1-7-medium");
    expect(swe17Medium).toBeDefined();
    expect(swe17Medium?.reasoningTier).toBeUndefined();
  });

  test("a malformed variant produces a diagnostics row rather than throwing or being silently dropped", () => {
    const report = parseDevinModelsOutputReport(fixtureText);

    const malformedDiagnostic = report.diagnostics?.find((d) => d.reason === "empty model_uid");
    expect(malformedDiagnostic).toBeDefined();
    expect(malformedDiagnostic?.row).toContain("Broken Variant");
  });

  test("REFUSES any uid whose cost_tier is not Free — the promo-end tripwire", () => {
    const report = parseDevinModelsOutputReport(fixtureText);

    expect(report.models.some((model) => model.modelId === "swe-1-7-lightning")).toBe(false);

    const lightningDiagnostic = report.diagnostics?.find((d) => d.row === "swe-1-7-lightning");
    expect(lightningDiagnostic).toBeDefined();
    expect(lightningDiagnostic?.reason).toContain("cost_tier");
    expect(lightningDiagnostic?.reason).toContain("Free");
  });

  test("REFUSES any claude-*/gpt-*/gemini-* family under provider devin — the routing-bias bypass guard", () => {
    const report = parseDevinModelsOutputReport(fixtureText);

    expect(report.models.some((model) => model.modelId === "claude-opus-5")).toBe(false);
    expect(report.models.some((model) => model.modelId === "gpt-5-5")).toBe(false);

    const claudeDiagnostic = report.diagnostics?.find((d) => d.row === "claude-opus-5");
    expect(claudeDiagnostic).toBeDefined();
    expect(claudeDiagnostic?.reason).toContain("forbidden");

    const gptDiagnostic = report.diagnostics?.find((d) => d.row === "gpt-5-5");
    expect(gptDiagnostic).toBeDefined();
    expect(gptDiagnostic?.reason).toContain("forbidden");
  });

  test("accepted models are exactly the Free, non-forbidden-family variants", () => {
    const models = parseDevinModelsOutput(fixtureText);

    expect(models.map((model) => model.modelId).sort()).toEqual(
      ["glm-5-2", "swe-1-7", "swe-1-7-medium"].sort(),
    );
  });

  test("discoverDevinModels uses the injected model runner", async () => {
    let runCount = 0;

    const result = (await discoverDevinModels({
      runDevinModels: () => {
        runCount += 1;
        return fixtureText;
      },
    })) as { models: ReturnType<typeof parseDevinModelsOutput> };

    expect(runCount).toBe(1);
    expect(result.models).toEqual(parseDevinModelsOutput(fixtureText));
  });

  test("discoverDevinModels closes stdin for the real devin CLI runner", async () => {
    const startedAt = Date.now();

    const result = (await withFakeDevinCli(async () => await discoverDevinModels())) as {
      models: ReturnType<typeof parseDevinModelsOutput>;
    };

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(result.models.map((model) => model.modelId).sort()).toEqual(
      ["glm-5-2", "swe-1-7", "swe-1-7-medium"].sort(),
    );
  }, 5_000);
});
