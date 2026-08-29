import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("returns an empty bundle when the config directory is absent", () => {
    const configDir = join(
      mkdtempSync(join(tmpdir(), "penumbra-start-absent-parent-")),
      "missing-config",
    );
    const previousConfigDir = process.env.PENUMBRA_CONFIG_DIR;
    process.env.PENUMBRA_CONFIG_DIR = configDir;
    try {
      expect(loadAgentchatBundle()).toEqual({
        agentRegistry: null,
        agentRouting: null,
        providerQuotas: [],
        agentchatConfig: null,
      });
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.PENUMBRA_CONFIG_DIR;
      } else {
        process.env.PENUMBRA_CONFIG_DIR = previousConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("rethrows ordinary parse failures when the config directory exists", () => {
    const configDir = mkdtempSync(join(tmpdir(), "penumbra-start-invalid-"));
    const previousConfigDir = process.env.PENUMBRA_CONFIG_DIR;
    const write = process.stderr.write;
    const stderr: string[] = [];
    process.env.PENUMBRA_CONFIG_DIR = configDir;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "agents.yaml"), "agents: [\n");
      writeFileSync(join(configDir, "routing.yaml"), "default_roles: {}\n");
      writeFileSync(join(configDir, "quotas.yaml"), "providers: []\n");

      expect(() => loadAgentchatBundle()).toThrow(/Flow sequence/);
      expect(stderr.join("")).toContain(
        `penumbra: failed to load agentchat config from ${configDir}`,
      );
    } finally {
      process.stderr.write = write;
      if (previousConfigDir === undefined) {
        delete process.env.PENUMBRA_CONFIG_DIR;
      } else {
        process.env.PENUMBRA_CONFIG_DIR = previousConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
