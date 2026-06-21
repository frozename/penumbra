import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ENV_REGISTRY, isMcpInvocationLogEnabled, parseEnv } from "../src/env.js";

describe("parseEnv", () => {
  test("applies default when var is unset", () => {
    const result = parseEnv({});
    expect(result.PENUMBRA_DREAMING_CRON_MINUTES).toBe(30);
  });

  test("boolean transform produces boolean type", () => {
    const result = parseEnv({ PENUMBRA_DREAMING_ENABLED: "true" });
    // boolean transform produces boolean, not string
    expect(typeof result.PENUMBRA_DREAMING_ENABLED).toBe("boolean");
    expect(result.PENUMBRA_DREAMING_ENABLED).toBe(true);
    expect(typeof result.PENUMBRA_DREAMING_ENABLED).toBe("boolean");
    expect(result.PENUMBRA_DREAMING_ENABLED).toBe(true);
  });

  test("strict boolean rejects unknown values with key name in error", () => {
    expect(() => parseEnv({ PENUMBRA_DREAMING_ENABLED: "neither" })).toThrow(
      /PENUMBRA_DREAMING_ENABLED/,
    );
  });

  test("boolean tolerates KEY='' opt-out and falls back to its default", () => {
    const result = parseEnv({ PENUMBRA_DREAMING_ENABLED: "" });
    expect(result.PENUMBRA_DREAMING_ENABLED).toBe(false);

    const whitespace = parseEnv({ PENUMBRA_DREAMING_ENABLED: "   " });
    expect(whitespace.PENUMBRA_DREAMING_ENABLED).toBe(false);

    const onTrueDefault = parseEnv({ PENUMBRA_AUTO_RECALL_ENABLED: "" });
    expect(onTrueDefault.PENUMBRA_AUTO_RECALL_ENABLED).toBe(true);
  });

  test("NonNegInt rejects KEY='' instead of silently coercing to 0", () => {
    expect(() => parseEnv({ PENUMBRA_EVENT_LOOP_LAG_THRESHOLD_MS: "" })).toThrow(
      /PENUMBRA_EVENT_LOOP_LAG_THRESHOLD_MS/,
    );
    expect(() => parseEnv({ PENUMBRA_EVENT_LOOP_LAG_THRESHOLD_MS: "   " })).toThrow(
      /PENUMBRA_EVENT_LOOP_LAG_THRESHOLD_MS/,
    );
  });

  test("NonNegNum rejects KEY='' instead of silently coercing to 0", () => {
    expect(() => parseEnv({ PENUMBRA_DREAMING_PER_CYCLE_USD: "" })).toThrow(
      /PENUMBRA_DREAMING_PER_CYCLE_USD/,
    );
  });

  test("t2 embed recipe defaults to title_plus_concise", () => {
    const result = parseEnv({});
    expect(result.PENUMBRA_T2_EMBED_RECIPE).toBe("title_plus_concise");
    expect(result.PENUMBRA_T2_OVERSAMPLE_FACTOR).toBe(1);
    expect(result.PENUMBRA_T2_REEMBED_ENABLED).toBe(false);
  });

  test("t2 embed recipe accepts only supported values", () => {
    expect(() => parseEnv({ PENUMBRA_T2_EMBED_RECIPE: "invalid" })).toThrow(
      /PENUMBRA_T2_EMBED_RECIPE/,
    );
    const ok = parseEnv({ PENUMBRA_T2_EMBED_RECIPE: "title_plus_concise" });
    expect(ok.PENUMBRA_T2_EMBED_RECIPE).toBe("title_plus_concise");
  });
});

describe("ENV_REGISTRY", () => {
  test("sensitive keys have isSensitive: true", () => {
    expect(ENV_REGISTRY.PENUMBRA_DAEMON_TOKEN?.isSensitive).toBe(true);
    expect(ENV_REGISTRY.PENUMBRA_SIRIUS_TOKEN?.isSensitive).toBe(true);
    expect(ENV_REGISTRY.PENUMBRA_EMBEDDINGS_TOKEN?.isSensitive).toBe(true);
    expect(ENV_REGISTRY.PENUMBRA_DISCORD_WEBHOOK_URL?.isSensitive).toBe(true);
    expect(ENV_REGISTRY.PENUMBRA_JUDGE_TOKEN?.isSensitive).toBe(true);
  });

  test("non-secret key does not have isSensitive", () => {
    expect(ENV_REGISTRY.PENUMBRA_DAEMON_HOST?.isSensitive).toBeFalsy();
  });

  test("agentchat single-file override env key is removed", () => {
    const removedLegacyKey = ["PENUMBRA", "AGENTCHAT", "CONFIG"].join("_");
    expect(ENV_REGISTRY).not.toHaveProperty(removedLegacyKey);
  });

  test("penumbra multi-file config dir override env key exists", () => {
    expect(ENV_REGISTRY.PENUMBRA_CONFIG_DIR).toBeDefined();
  });

  test("MCP response budget docs mention invalid values fail fast", () => {
    const description = ENV_REGISTRY.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS.description;
    expect(description).toContain("Invalid values");
    expect(description).toContain("fail fast");
    expect(description).toContain("positive integer");
  });
});

describe("isMcpInvocationLogEnabled", () => {
  let previousValue: string | undefined;

  beforeEach(() => {
    previousValue = process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
  });

  afterEach(() => {
    if (previousValue === undefined) {
      delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
      return;
    }
    process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED = previousValue;
  });

  test("returns false when PENUMBRA_MCP_INVOCATION_LOG_ENABLED is unset", () => {
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
    expect(isMcpInvocationLogEnabled()).toBe(false);
  });

  test.each([["1"], ["true"], ["yes"]])(
    'returns true when PENUMBRA_MCP_INVOCATION_LOG_ENABLED is "%s"',
    (value) => {
      process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED = value;
      expect(isMcpInvocationLogEnabled()).toBe(true);
    },
  );

  test.each([["0"], ["false"], ["no"]])(
    'returns false when PENUMBRA_MCP_INVOCATION_LOG_ENABLED is "%s"',
    (value) => {
      process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED = value;
      expect(isMcpInvocationLogEnabled()).toBe(false);
    },
  );

  test("reads from an injected env (does not snapshot process.env)", () => {
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
    expect(isMcpInvocationLogEnabled({ PENUMBRA_MCP_INVOCATION_LOG_ENABLED: "1" })).toBe(true);
    expect(isMcpInvocationLogEnabled({})).toBe(false);
  });
});
