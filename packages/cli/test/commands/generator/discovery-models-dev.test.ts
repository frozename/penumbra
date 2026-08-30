import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  fetchModelsDevPayload,
  joinModelsDevMetadata,
} from "@src/commands/generator/discovery-models-dev.js";

const fixturePath = join(import.meta.dir, "../fixtures/models-dev-api.json");
// The snapshot intentionally keeps three real models from each of two providers.
const fixturePayload = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;

describe("models.dev discovery metadata", () => {
  test("joinModelsDevMetadata enriches a bare model id with cost/context/capabilities from a fixture snapshot", () => {
    const models = joinModelsDevMetadata(
      [
        {
          sourceProviderId: "opencode",
          modelId: "claude-opus-4-7",
          displayName: "Claude Opus 4.7",
        },
      ],
      fixturePayload,
    );

    expect(models).toEqual([
      {
        sourceProviderId: "opencode",
        modelId: "claude-opus-4-7",
        displayName: "Claude Opus 4.7",
        metadata: {
          modelsDevProvider: "anthropic",
          cost: {
            input: 5,
            output: 25,
            cache_read: 0.5,
            cache_write: 6.25,
          },
          context: 1_000_000,
          capabilities: {
            attachment: true,
            reasoning: true,
            tool_call: true,
            structured_output: true,
            temperature: false,
            modalities: {
              input: ["text", "image", "pdf"],
              output: ["text"],
            },
          },
        },
      },
    ]);
  });

  test("an opencode route-prefixed id falls back to its unique models.dev creator", () => {
    const models = joinModelsDevMetadata(
      [
        {
          sourceProviderId: "opencode",
          modelId: "opencode/claude-opus-4-7",
          displayName: "Claude Opus 4.7",
        },
      ],
      fixturePayload,
    );

    expect(models[0]?.metadata).toMatchObject({
      modelsDevProvider: "anthropic",
      cost: {
        input: 5,
        output: 25,
        cache_read: 0.5,
        cache_write: 6.25,
      },
      context: 1_000_000,
    });
  });

  test("a model id found under multiple models.dev providers stays unenriched", () => {
    const model = {
      sourceProviderId: "opencode",
      modelId: "shared-model",
      displayName: "Shared Model",
    };
    const ambiguousPayload = {
      first: { models: { "shared-model": { cost: { input: 1 } } } },
      second: { models: { "shared-model": { cost: { input: 2 } } } },
    };

    expect(joinModelsDevMetadata([model], ambiguousPayload)).toEqual([model]);
  });

  test("an id with no models.dev match keeps its identity and proceeds with no metadata, rather than failing the run", () => {
    const model = {
      sourceProviderId: "opencode",
      modelId: "private-provider/unlisted-model",
      displayName: "Unlisted Model",
      reasoningTier: "high",
    };

    expect(joinModelsDevMetadata([model], fixturePayload)).toEqual([model]);
  });

  test("fetchModelsDevPayload uses the injected fetch once and returns its parsed payload", async () => {
    const urls: string[] = [];

    const payload = await fetchModelsDevPayload({
      fetch: (input) => {
        urls.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return Response.json(fixturePayload);
      },
    });

    expect(urls).toEqual(["https://models.dev/api.json"]);
    expect(payload).toEqual(fixturePayload);
  });
});
