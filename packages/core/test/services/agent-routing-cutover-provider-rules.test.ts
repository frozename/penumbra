import type { Mock } from "bun:test";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  DEFAULT_CLASSIFIER_DECLINE_CUTOVER_ISO,
  DEFAULT_GATE_OUTCOME_CUTOVER_ISO,
  isTextOnlyAdapter,
  resolveClassifierDeclineCutoverIso,
  resolveGateOutcomeCutoverIso,
  resolveProvider,
} from "@src/services/agent-routing.js";

let savedGateOutcomeCutoverEnv: string | undefined;
let savedClassifierDeclineCutoverEnv: string | undefined;
let warn: Mock<typeof console.warn>;

beforeEach(() => {
  savedGateOutcomeCutoverEnv = process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO;
  savedClassifierDeclineCutoverEnv = process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO;
  warn = spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  if (savedGateOutcomeCutoverEnv === undefined) {
    delete process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO;
  } else {
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = savedGateOutcomeCutoverEnv;
  }
  if (savedClassifierDeclineCutoverEnv === undefined) {
    delete process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO;
  } else {
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = savedClassifierDeclineCutoverEnv;
  }
  warn.mockRestore();
});

describe("resolveGateOutcomeCutoverIso", () => {
  test("returns the default cutoff for an unparseable env value", () => {
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = "not-a-date";
    expect(resolveGateOutcomeCutoverIso()).toBe(DEFAULT_GATE_OUTCOME_CUTOVER_ISO);
  });

  test("normalizes a non-canonical env value to UTC ISO", () => {
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = "2026-07-01T02:00:00+02:00";
    expect(resolveGateOutcomeCutoverIso()).toBe("2026-07-01T00:00:00.000Z");
  });

  test("warns once when the env value is earlier than the default", () => {
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = "2025-03-04T05:06:07.000Z";
    resolveGateOutcomeCutoverIso();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[agent-routing] PENUMBRA_GATE_OUTCOME_CUTOVER_ISO=2025-03-04T05:06:07.000Z is earlier than default 2026-06-12T00:00:00.000Z; this relaxes legacy NULL-verdict reporting.",
    );
  });

  test("does not warn when the env value is later than the default", () => {
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = "2026-09-09T09:09:09.000Z";
    resolveGateOutcomeCutoverIso();
    expect(warn).toHaveBeenCalledTimes(0);
  });

  test("does not warn when the env value equals the default", () => {
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = "2026-10-10T10:10:10.000Z";
    resolveGateOutcomeCutoverIso();
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = "2026-06-12T00:00:00Z";
    expect(resolveGateOutcomeCutoverIso()).toBe(DEFAULT_GATE_OUTCOME_CUTOVER_ISO);
    expect(warn).toHaveBeenCalledTimes(0);
  });

  test("warns once for the same instant written in different formats", () => {
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = "2025-04-05T06:07:08Z";
    resolveGateOutcomeCutoverIso();
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = "2025-04-05T06:07:08.000Z";
    resolveGateOutcomeCutoverIso();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("warns again for a different earlier value", () => {
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = "2025-05-06T07:08:09.000Z";
    resolveGateOutcomeCutoverIso();
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = "2025-06-07T08:09:10.000Z";
    resolveGateOutcomeCutoverIso();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toContain("2025-06-07T08:09:10.000Z");
  });
});

describe("resolveClassifierDeclineCutoverIso", () => {
  test("returns the default cutoff for an unparseable env value", () => {
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = "not-a-date";
    expect(resolveClassifierDeclineCutoverIso()).toBe(DEFAULT_CLASSIFIER_DECLINE_CUTOVER_ISO);
  });

  test("normalizes a non-canonical env value to UTC ISO", () => {
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = "2026-07-02T02:00:00+02:00";
    expect(resolveClassifierDeclineCutoverIso()).toBe("2026-07-02T00:00:00.000Z");
  });

  test("warns once when the env value is earlier than the default", () => {
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = "2025-07-08T09:10:11.000Z";
    resolveClassifierDeclineCutoverIso();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[agent-routing] PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO=2025-07-08T09:10:11.000Z is earlier than default 2026-06-13T00:00:00.000Z; this relaxes the legacy classifier-decline exemption predicate.",
    );
  });

  test("does not warn when the env value is later than the default", () => {
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = "2026-09-10T09:09:09.000Z";
    resolveClassifierDeclineCutoverIso();
    expect(warn).toHaveBeenCalledTimes(0);
  });

  test("does not warn when the env value equals the default", () => {
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = "2026-10-11T10:10:10.000Z";
    resolveClassifierDeclineCutoverIso();
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = "2026-06-13T00:00:00Z";
    expect(resolveClassifierDeclineCutoverIso()).toBe(DEFAULT_CLASSIFIER_DECLINE_CUTOVER_ISO);
    expect(warn).toHaveBeenCalledTimes(0);
  });

  test("warns once for the same instant written in different formats", () => {
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = "2025-08-08T10:11:12Z";
    resolveClassifierDeclineCutoverIso();
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = "2025-08-08T10:11:12.000Z";
    resolveClassifierDeclineCutoverIso();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("warns again for a different earlier value", () => {
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = "2025-08-09T11:12:13.000Z";
    resolveClassifierDeclineCutoverIso();
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = "2025-08-10T12:13:14.000Z";
    resolveClassifierDeclineCutoverIso();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toContain("2025-08-10T12:13:14.000Z");
  });

  test("does not read the gate outcome env var", () => {
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = "2026-07-03T00:00:00.000Z";
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = "not-a-date";
    expect(resolveClassifierDeclineCutoverIso()).toBe(DEFAULT_CLASSIFIER_DECLINE_CUTOVER_ISO);
  });
});

describe("resolveProvider", () => {
  test("returns subscription_provider when pricing_mode is subscription", () => {
    expect(
      resolveProvider({
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
        api_provider: "openrouter",
      }),
    ).toBe("anthropic");
  });

  test("returns null when subscription mode has no subscription_provider", () => {
    expect(
      resolveProvider({
        pricing_mode: "subscription",
        subscription_provider: null,
        api_provider: "openrouter",
      }),
    ).toBeNull();
  });

  test("returns api_provider when pricing_mode is api", () => {
    expect(
      resolveProvider({
        pricing_mode: "api",
        subscription_provider: "anthropic",
        api_provider: "openrouter",
      }),
    ).toBe("openrouter");
  });

  test("falls back to subscription_provider when api_provider is null", () => {
    expect(
      resolveProvider({
        pricing_mode: "api",
        subscription_provider: "anthropic",
        api_provider: null,
      }),
    ).toBe("anthropic");
  });

  test("returns api_provider when pricing_mode is omitted", () => {
    expect(
      resolveProvider({
        subscription_provider: "anthropic",
        api_provider: "openrouter",
      }),
    ).toBe("openrouter");
  });

  test("matches pricing_mode case-sensitively", () => {
    expect(
      resolveProvider({
        pricing_mode: "Subscription",
        subscription_provider: "anthropic",
        api_provider: "openrouter",
      }),
    ).toBe("openrouter");
  });

  test("returns null when no provider is set", () => {
    expect(resolveProvider({ pricing_mode: "api" })).toBeNull();
  });
});

describe("isTextOnlyAdapter", () => {
  test("returns true for openai-compat-http", () => {
    expect(isTextOnlyAdapter("openai-compat-http")).toBe(true);
  });

  test.each([
    ["openai-compat", "openai-compat"],
    ["openai-compat-https", "openai-compat-https"],
    ["x-openai-compat-http", "x-openai-compat-http"],
    ["OPENAI-COMPAT-HTTP", "OPENAI-COMPAT-HTTP"],
    ["opencode-acp", "opencode-acp"],
    ["empty string", ""],
    ["undefined", undefined],
    ["null", null],
  ])("returns false for %s", (_label, adapter) => {
    expect(isTextOnlyAdapter(adapter)).toBe(false);
  });
});
