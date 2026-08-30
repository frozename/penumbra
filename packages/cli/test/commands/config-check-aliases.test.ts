import type { AaModelSnapshot } from "@penumbra/core";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

import { runConfigCheckAliases } from "@src/commands/config-check-aliases.js";

let tempDirs: string[] = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "penumbra-config-check-aliases-"));
  tempDirs.push(dir);
  return dir;
}

function writeAgents(dir: string, agents: unknown[]): void {
  writeFileSync(join(dir, "agents.yaml"), YAML.stringify({ agents }), "utf8");
}

function writeAliases(dir: string, aliases: Record<string, unknown>): void {
  writeFileSync(join(dir, "model-aliases.yaml"), YAML.stringify(aliases), "utf8");
}

describe("penumbra config check-aliases", () => {
  test("reports matched/dark/missing counts and names for a fixture roster", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [
      { name: "seat-matched", adapter: "stdio-acp" },
      { name: "seat-dark", adapter: "stdio-acp" },
      { name: "seat-missing", adapter: "stdio-acp" },
    ]);
    writeAliases(dir, {
      "seat-matched": { aa_creator: "anthropic", aa_slug: "claude-opus-5" },
      "seat-dark": { aa_creator: "anthropic", aa_slug: "claude-ghost-9" },
    });
    const snapshot: AaModelSnapshot = {
      collectedAt: "2026-08-26T00:00:00.000Z",
      models: [
        {
          id: "anthropic/claude-opus-5",
          name: "Claude Opus 5",
          slug: "claude-opus-5",
          model_creator: { id: "anthropic", name: "Anthropic", slug: "anthropic" },
          evaluations: {},
          pricing: {},
        },
      ],
    };

    const result = runConfigCheckAliases({ configDir: dir, loadSnapshot: () => snapshot });

    expect(result.report.matched).toEqual(["seat-matched"]);
    expect(result.report.dark).toEqual(["seat-dark"]);
    expect(result.report.missing).toEqual(["seat-missing"]);
    expect(result.stdout.join("\n")).toContain("Matched (1)");
    expect(result.stdout.join("\n")).toContain("seat-matched -> anthropic/claude-opus-5");
    expect(result.stdout.join("\n")).toContain("Dark (1)");
    expect(result.stdout.join("\n")).toContain("seat-dark");
    expect(result.stdout.join("\n")).toContain("Missing (1)");
    expect(result.stdout.join("\n")).toContain("seat-missing");
  });

  test("lists AA models sharing a creator with an already-aliased seat that no seat is aliased to", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [{ name: "seat-openai", adapter: "stdio-acp" }]);
    writeAliases(dir, {
      "seat-openai": { aa_creator: "openai", aa_slug: "gpt-5.5-high" },
    });
    const snapshot: AaModelSnapshot = {
      collectedAt: "2026-08-26T00:00:00.000Z",
      models: [
        {
          id: "openai/gpt-5.5-high",
          name: "GPT-5.5 High",
          slug: "gpt-5.5-high",
          model_creator: { id: "openai", name: "OpenAI", slug: "openai" },
          evaluations: {},
          pricing: {},
        },
        {
          id: "openai/gpt-5.6-max",
          name: "GPT-5.6 Max",
          slug: "gpt-5.6-max",
          model_creator: { id: "openai", name: "OpenAI", slug: "openai" },
          evaluations: {},
          pricing: {},
        },
        {
          id: "anthropic/claude-opus-5",
          name: "Claude Opus 5",
          slug: "claude-opus-5",
          model_creator: { id: "anthropic", name: "Anthropic", slug: "anthropic" },
          evaluations: {},
          pricing: {},
        },
      ],
    };

    const result = runConfigCheckAliases({ configDir: dir, loadSnapshot: () => snapshot });

    expect(result.report.sameCreatorUnseated).toEqual([
      {
        aaCreator: "openai",
        aaSlug: "gpt-5.6-max",
        aaId: "openai/gpt-5.6-max",
        aaName: "GPT-5.6 Max",
      },
    ]);
    expect(result.stdout.join("\n")).toContain("openai/gpt-5.6-max");
  });

  test("exits 0 always — this is a report, not a gate", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [{ name: "seat-a", adapter: "stdio-acp" }]);
    writeAliases(dir, {});

    const ok = runConfigCheckAliases({
      configDir: dir,
      loadSnapshot: () => ({ collectedAt: "", models: [] }),
    });
    expect(ok.exitCode).toBe(0);

    const missingConfigDir = join(dir, "does-not-exist");
    const failed = runConfigCheckAliases({
      configDir: missingConfigDir,
      loadSnapshot: () => {
        throw new Error("should not be reached");
      },
    });
    expect(failed.exitCode).toBe(0);
    expect(failed.stderr.join("\n")).not.toBe("");
  });
});
