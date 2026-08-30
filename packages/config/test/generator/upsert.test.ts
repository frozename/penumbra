import type { AgentConfig } from "@src/files/agents.js";

import { isGeneratorOwned, pruneOwnedOnly, upsertManagedFields } from "@src/generator/upsert.js";
import { describe, expect, test } from "bun:test";
import { isDeepStrictEqual } from "node:util";

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "seat",
    adapter: "openai-compat-http",
    options: {},
    roles: ["executor"],
    auto_approve_to: [],
    pricing_mode: "api",
    ...overrides,
  };
}

describe("upsertManagedFields", () => {
  test("preserves hand-edited roles/tags/quirks/description and rewrites only the given managed_fields", () => {
    const existing = baseAgent({
      roles: ["reviewer"],
      tags: ["curated"],
      quirks: ["operational forensics"],
      description: "hand tuned seat",
      options: { model: "old-model", baseUrl: "http://old" },
    });
    const generated = baseAgent({
      roles: ["executor"],
      tags: ["generated"],
      quirks: ["generated quirk"],
      description: "generated seat",
      options: { model: "new-model", baseUrl: "http://old" },
    });

    const merged = upsertManagedFields(existing, generated, ["options.model"]);

    expect(merged.quirks).toEqual(["operational forensics"]);
    expect(merged.roles).toEqual(["reviewer"]);
    expect(merged.tags).toEqual(["curated"]);
    expect(merged.description).toBe("hand tuned seat");
    expect(merged.options.model).toBe("new-model");
    expect(merged.options.baseUrl).toBe("http://old");
  });

  test("returns the generated payload unchanged when there is no existing agent", () => {
    const generated = baseAgent({ options: { model: "fresh" } });
    expect(upsertManagedFields(undefined, generated, ["options.model"])).toEqual(generated);
  });

  test("rewrites a top-level managed field", () => {
    const existing = baseAgent({ adapter: "stdio-acp" });
    const generated = baseAgent({ adapter: "openai-compat-http" });
    const merged = upsertManagedFields(existing, generated, ["adapter"]);
    expect(merged.adapter).toBe("openai-compat-http");
  });

  test("preserves strict equality when an optional managed field is absent from both seats", () => {
    const existing = baseAgent();
    const generated = baseAgent();

    const merged = upsertManagedFields(existing, generated, ["subscription_provider"]);

    expect(Object.hasOwn(merged, "subscription_provider")).toBe(false);
    expect(isDeepStrictEqual(existing, merged)).toBe(true);
  });

  test("removes a stale optional managed field when it is absent from the generated seat", () => {
    const existing = baseAgent({ subscription_provider: "openai" });
    const generated = baseAgent();

    const merged = upsertManagedFields(existing, generated, ["subscription_provider"]);

    expect(Object.hasOwn(merged, "subscription_provider")).toBe(false);
  });

  test("overwrites an optional managed field when it is present on the generated seat", () => {
    const existing = baseAgent({ subscription_provider: "openai" });
    const generated = baseAgent({ subscription_provider: "sakana" });

    const merged = upsertManagedFields(existing, generated, ["subscription_provider"]);

    expect(merged.subscription_provider).toBe("sakana");
  });

  test("does not create an undefined own-property for an absent nested managed field", () => {
    const existing = baseAgent();
    const generated = baseAgent();

    const merged = upsertManagedFields(existing, generated, ["options.model"]);

    expect(Object.hasOwn(merged.options, "model")).toBe(false);
    expect(isDeepStrictEqual(existing, merged)).toBe(true);
  });

  test("removes a stale nested managed field while preserving its siblings", () => {
    const existing = baseAgent({ options: { model: "stale", maxTokens: 10 } });
    const generated = baseAgent();

    const merged = upsertManagedFields(existing, generated, ["options.model"]);

    expect(Object.hasOwn(merged.options, "model")).toBe(false);
    expect(merged.options.maxTokens).toBe(10);
  });

  test("does not create missing parent objects when deleting a nested managed field", () => {
    const existing = baseAgent();
    const generated = baseAgent();

    const merged = upsertManagedFields(existing, generated, ["options.env.MODEL_ID"]);

    expect(Object.hasOwn(merged.options, "env")).toBe(false);
    expect(isDeepStrictEqual(existing, merged)).toBe(true);
  });

  test("does not mutate the existing agent's options object", () => {
    const existing = baseAgent({ options: { model: "old", maxTokens: 10 } });
    const generated = baseAgent({ options: { model: "new" } });
    upsertManagedFields(existing, generated, ["options.model"]);
    expect(existing.options.model).toBe("old");
  });
});

describe("isGeneratorOwned", () => {
  test("true only when provenance.source matches the given source", () => {
    const owned = baseAgent({ provenance: { source: "my-generator" } });
    const other = baseAgent({ provenance: { source: "other-generator" } });
    const none = baseAgent();

    expect(isGeneratorOwned(owned, "my-generator")).toBe(true);
    expect(isGeneratorOwned(other, "my-generator")).toBe(false);
    expect(isGeneratorOwned(none, "my-generator")).toBe(false);
  });
});

describe("upsertManagedFields path safety", () => {
  test("rejects a managed field path that targets __proto__", () => {
    const existing = baseAgent();
    const generated = baseAgent();
    expect(() => {
      upsertManagedFields(existing, generated, ["__proto__.polluted"]);
    }).toThrow(/__proto__/);
  });

  test("rejects a managed field path that targets constructor.prototype", () => {
    const existing = baseAgent();
    const generated = baseAgent();
    expect(() => {
      upsertManagedFields(existing, generated, ["constructor.prototype.polluted"]);
    }).toThrow(/constructor/);
  });

  test("rejects a managed field path that targets prototype directly", () => {
    const existing = baseAgent();
    const generated = baseAgent();
    expect(() => {
      upsertManagedFields(existing, generated, ["prototype.polluted"]);
    }).toThrow(/prototype/);
  });
});

describe("pruneOwnedOnly", () => {
  test("prunes generator-owned agents absent from generatedNames, keeps everything else", () => {
    const vanished = baseAgent({ name: "vanished", provenance: { source: "gen" } });
    const surviving = baseAgent({ name: "surviving", provenance: { source: "gen" } });
    const handAuthored = baseAgent({ name: "hand-authored" });

    const result = pruneOwnedOnly(
      [vanished, surviving, handAuthored],
      new Set(["surviving"]),
      "gen",
    );

    expect(result.agents.map((agent) => agent.name).sort()).toEqual(["hand-authored", "surviving"]);
    expect(result.prunes).toEqual(["vanished"]);
  });
});
