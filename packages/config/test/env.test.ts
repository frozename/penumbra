import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ENV_REGISTRY, getUpdateEnv, isMcpInvocationLogEnabled, parseEnv } from "../src/env.js";

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

  test("AA snapshot refresh interval rejects 0 (sweeper treats missing and 0 differently otherwise)", () => {
    expect(() => parseEnv({ PENUMBRA_AA_SNAPSHOT_REFRESH_INTERVAL_MS: "0" })).toThrow(
      /PENUMBRA_AA_SNAPSHOT_REFRESH_INTERVAL_MS/,
    );
    const unset = parseEnv({});
    expect(unset.PENUMBRA_AA_SNAPSHOT_REFRESH_INTERVAL_MS).toBeUndefined();
    const positive = parseEnv({ PENUMBRA_AA_SNAPSHOT_REFRESH_INTERVAL_MS: "60000" });
    expect(positive.PENUMBRA_AA_SNAPSHOT_REFRESH_INTERVAL_MS).toBe(60000);
  });

  test("p1 jev shadow cost estimate registers with the P7 sibling's NonNegNum contract", () => {
    const unset = parseEnv({});
    expect(unset.PENUMBRA_DREAMING_COST_ESTIMATE_P1_JEV_SHADOW_USD).toBe(0.003);

    const override = parseEnv({ PENUMBRA_DREAMING_COST_ESTIMATE_P1_JEV_SHADOW_USD: "0.01" });
    expect(override.PENUMBRA_DREAMING_COST_ESTIMATE_P1_JEV_SHADOW_USD).toBe(0.01);

    const zero = parseEnv({ PENUMBRA_DREAMING_COST_ESTIMATE_P1_JEV_SHADOW_USD: "0" });
    expect(zero.PENUMBRA_DREAMING_COST_ESTIMATE_P1_JEV_SHADOW_USD).toBe(0);

    expect(() => parseEnv({ PENUMBRA_DREAMING_COST_ESTIMATE_P1_JEV_SHADOW_USD: "-0.5" })).toThrow(
      /PENUMBRA_DREAMING_COST_ESTIMATE_P1_JEV_SHADOW_USD/,
    );
    expect(() => parseEnv({ PENUMBRA_DREAMING_COST_ESTIMATE_P1_JEV_SHADOW_USD: "" })).toThrow(
      /PENUMBRA_DREAMING_COST_ESTIMATE_P1_JEV_SHADOW_USD/,
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

  test("sakana plausible percentage falls back for blank or invalid values", () => {
    const unset = parseEnv({});
    expect(unset.PENUMBRA_SAKANA_SYNTH_MAX_PLAUSIBLE_PCT).toBe(300);

    const blank = parseEnv({ PENUMBRA_SAKANA_SYNTH_MAX_PLAUSIBLE_PCT: "" });
    expect(blank.PENUMBRA_SAKANA_SYNTH_MAX_PLAUSIBLE_PCT).toBe(300);

    const invalid = parseEnv({ PENUMBRA_SAKANA_SYNTH_MAX_PLAUSIBLE_PCT: "not-a-number" });
    expect(invalid.PENUMBRA_SAKANA_SYNTH_MAX_PLAUSIBLE_PCT).toBe(300);

    const override = parseEnv({ PENUMBRA_SAKANA_SYNTH_MAX_PLAUSIBLE_PCT: "450" });
    expect(override.PENUMBRA_SAKANA_SYNTH_MAX_PLAUSIBLE_PCT).toBe(450);
  });
});

describe("ENV_REGISTRY", () => {
  test("sensitive keys have isSensitive: true", () => {
    expect(ENV_REGISTRY.PENUMBRA_DAEMON_TOKEN?.isSensitive).toBe(true);
    expect(ENV_REGISTRY.PENUMBRA_EMBEDDINGS_TOKEN?.isSensitive).toBe(true);
    expect(ENV_REGISTRY.PENUMBRA_DISCORD_WEBHOOK_URL?.isSensitive).toBe(true);
    expect(ENV_REGISTRY.PENUMBRA_JUDGE_TOKEN?.isSensitive).toBe(true);
    expect(ENV_REGISTRY.PENUMBRA_TYPESAFE_API_KEY?.isSensitive).toBe(true);
  });

  test("typesafe defaults pin a versioned model, a total deadline and promotion off", () => {
    const env = parseEnv({});
    expect(env.PENUMBRA_TYPESAFE_BASE_URL).toBe("https://api.typesafe.ai");
    expect(env.PENUMBRA_TYPESAFE_MODEL).toBe("jev-1.13.0");
    expect(env.PENUMBRA_TYPESAFE_TIMEOUT_MS).toBe(10000);
    expect(env.PENUMBRA_TYPESAFE_JUDGE_PROMOTION).toBe("off");
    expect(env.PENUMBRA_TYPESAFE_API_KEY).toBeUndefined();
    expect(ENV_REGISTRY.PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN?.isSensitive).toBeFalsy();
  });

  test("typesafe judge promotion is a closed off|shadow|veto enum, not a boolean", () => {
    expect(
      parseEnv({ PENUMBRA_TYPESAFE_JUDGE_PROMOTION: "shadow" }).PENUMBRA_TYPESAFE_JUDGE_PROMOTION,
    ).toBe("shadow");
    const veto = ((): unknown => {
      try {
        return parseEnv({ PENUMBRA_TYPESAFE_JUDGE_PROMOTION: "veto" })
          .PENUMBRA_TYPESAFE_JUDGE_PROMOTION;
      } catch {
        return "threw";
      }
    })();
    expect(veto).toBe("veto");
    expect(() => parseEnv({ PENUMBRA_TYPESAFE_JUDGE_PROMOTION: "on" })).toThrow();
    expect(() => parseEnv({ PENUMBRA_TYPESAFE_JUDGE_PROMOTION: "true" })).toThrow();
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

describe("orphan lane grace registry", () => {
  for (const [key, fallback] of [
    ["PENUMBRA_LANE_ORPHAN_SWEEPER_GRACE_MINUTES", 120],
    ["PENUMBRA_LANE_ORPHAN_SWEEPER_NON_TRIVIAL_GRACE_MINUTES", 1440],
  ] as const) {
    test(`${key} registers a class default and integer override`, () => {
      expect(parseEnv({})[key]).toBe(fallback);
      expect(parseEnv({ [key]: "360" })[key]).toBe(360);
    });
    test(`${key} preserves settings fallback for invalid values`, () => {
      for (const raw of ["0", "-1", "1.5", "banana", ""]) {
        expect(parseEnv({ [key]: raw })[key]).toBe(fallback);
      }
    });
  }
});

describe("getUpdateEnv", () => {
  test("defaults to systemd/launchd names documented in AGENTS.md", () => {
    expect(getUpdateEnv({})).toEqual({
      serviceManager: "auto",
      daemonUnit: "penumbra-daemon.service",
      workerUnit: "penumbra-worker.service",
      daemonLabel: "dev.penumbra.daemon",
      workerLabel: "dev.penumbra.worker",
    });
  });

  test("honours overrides and ignores unrelated malformed keys", () => {
    const env = getUpdateEnv({
      PENUMBRA_UPDATE_SERVICE_MANAGER: "launchd",
      PENUMBRA_UPDATE_WORKER_UNIT: "pw@2.service",
      PENUMBRA_UPDATE_WORKER_LABEL: "com.example.worker",
      PENUMBRA_JOB_MEMORY_MAX: "not-a-size",
    });
    expect(env.serviceManager).toBe("launchd");
    expect(env.workerUnit).toBe("pw@2.service");
    expect(env.workerLabel).toBe("com.example.worker");
  });

  test("rejects unit names that are not services and labels with spaces", () => {
    expect(() => getUpdateEnv({ PENUMBRA_UPDATE_DAEMON_UNIT: "penumbra-daemon" })).toThrow();
    expect(() => getUpdateEnv({ PENUMBRA_UPDATE_DAEMON_LABEL: "dev penumbra" })).toThrow();
    expect(() => getUpdateEnv({ PENUMBRA_UPDATE_SERVICE_MANAGER: "upstart" })).toThrow();
  });
});
