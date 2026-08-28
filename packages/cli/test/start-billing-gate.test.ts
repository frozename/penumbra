import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BilledHandSeatViolation, isBilledHandSeatViolation } from "@penumbra/config";
import { handleAgentchatConfigLoadError, loadAgentchatBundle } from "../src/commands/start.js";

describe("handleAgentchatConfigLoadError", () => {
  test("rethrows billed hand-seat violations", () => {
    const error = new BilledHandSeatViolation("agents.yaml: boom");
    expect(() => handleAgentchatConfigLoadError(error)).toThrow(BilledHandSeatViolation);
    expect(isBilledHandSeatViolation(error)).toBe(true);
  });

  test("preserves generic config errors as non-fatal", () => {
    const error = new Error("agents.yaml: ordinary config issue");
    expect(handleAgentchatConfigLoadError(error)).toBe(false);
  });
});

describe("loadAgentchatBundle", () => {
  test("boot path preserves seven-day provider quota ceilings", () => {
    const configDir = mkdtempSync(join(tmpdir(), "penumbra-start-quota-"));
    const previousConfigDir = process.env.PENUMBRA_CONFIG_DIR;
    process.env.PENUMBRA_CONFIG_DIR = configDir;
    try {
      writeFileSync(
        join(configDir, "agents.yaml"),
        ["agents:", "  - name: test-agent-1", "    adapter: mock", "    roles: [executor]"].join(
          "\n",
        ),
      );
      writeFileSync(join(configDir, "routing.yaml"), "default_roles: {}\n");
      writeFileSync(
        join(configDir, "quotas.yaml"),
        [
          "providers:",
          "  - name: alibaba",
          "    quota_tokens_per_7d: 7000000",
          "    pressure_caps:",
          "      seven_day:",
          "        warn: 80",
          "        refuse: 95",
        ].join("\n"),
      );

      expect(loadAgentchatBundle().providerQuotas).toEqual([
        {
          provider: "alibaba",
          model: undefined,
          quota_usd_per_24h: undefined,
          quota_tokens_per_24h: undefined,
          quota_tokens_per_5h: undefined,
          quota_tokens_per_7d: 7_000_000,
          pressure_caps: { seven_day: { warn: 80, refuse: 95 } },
        },
      ]);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.PENUMBRA_CONFIG_DIR;
      } else {
        process.env.PENUMBRA_CONFIG_DIR = previousConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
