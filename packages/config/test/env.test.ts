import { beforeEach, afterEach, describe, test, expect } from "bun:test";
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

  test("t2 embed recipe defaults to body_v1", () => {
    const result = parseEnv({});
    expect(result.PENUMBRA_T2_EMBED_RECIPE).toBe("body_v1");
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
