import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  discoverOpencodeModels,
  parseOpencodeModelsOutput,
} from "../../../src/commands/generator/discovery-opencode.js";

const fixturePath = join(import.meta.dir, "../fixtures/opencode-models.txt");
const fixtureText = readFileSync(fixturePath, "utf8");

describe("opencode model discovery", () => {
  test("parseOpencodeModelsOutput extracts every model from the live-captured fixture", () => {
    const models = parseOpencodeModelsOutput(fixtureText);

    expect(models).toHaveLength(131);
    expect(models).toContainEqual({
      sourceProviderId: "opencode",
      modelId: "opencode/big-pickle",
      displayName: "Big Pickle",
    });
  });

  test("parseOpencodeModelsOutput skips a malformed object and continues with later models", () => {
    const models = parseOpencodeModelsOutput(`broken/model
{
  "id": "broken",
  this is not json
}
valid/model
{
  "id": "valid",
  "providerID": "valid",
  "name": "Valid Model"
}
`);

    expect(models).toEqual([
      {
        sourceProviderId: "opencode",
        modelId: "valid/model",
        displayName: "Valid Model",
      },
    ]);
  });

  test("discoverOpencodeModels uses the injected model runner", async () => {
    let runCount = 0;

    const models = await discoverOpencodeModels({
      runOpencodeModels: () => {
        runCount += 1;
        return fixtureText;
      },
    });

    expect(runCount).toBe(1);
    expect(models).toEqual(parseOpencodeModelsOutput(fixtureText));
  });
});
