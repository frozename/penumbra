import { AgentsConfigSchema } from "@src/files/agents.js";
import { loadProviderSourcesFromDir } from "@src/files/providers.js";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

import {
  type ProviderDiscoveryAdapter,
  runConfigSyncProviders,
} from "../../../cli/src/commands/config-sync-providers.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "penumbra-config-sync-providers-"));
  tempDirs.push(dir);
  return dir;
}

function writeFixture(dir: string, providersYaml: string): void {
  writeFileSync(join(dir, "providers.yaml"), providersYaml, "utf8");
  writeFileSync(
    join(dir, "agents.yaml"),
    YAML.stringify({
      agents: [
        {
          name: "role-holders",
          adapter: "stdio-acp",
          roles: ["dreaming-rewriter", "brief-synthesizer", "memory-refiner", "refiner"],
        },
        {
          name: "judge-a",
          adapter: "stdio-acp",
          roles: ["dreaming-judge"],
        },
        {
          name: "judge-b",
          adapter: "stdio-acp",
          roles: ["dreaming-judge"],
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(join(dir, "model-aliases.yaml"), YAML.stringify({}), "utf8");
  writeFileSync(join(dir, "routing.yaml"), YAML.stringify({}), "utf8");
}

describe("penumbra config sync-providers", () => {
  test("threads pass_via and strip_patterns from providers.yaml into generated agy-cli seat options and managed_fields", async () => {
    const dir = await makeTempDir();
    writeFixture(
      dir,
      `
anthropic:
  discovery:
    kind: fake
    locator: fake-models
  auth: {}
  bindings:
    anthropic-cli:
      kind: agy-cli
      pricing_mode: subscription
      api_provider: anthropic
      subscription_provider: anthropic
      model_carrier: options.args.model
      seat_name_template: anthropic-{model}-cli
      carriers:
        binary: agy
        args_template: ["--model", "{displayName}"]
        pass_via: argv
        strip_patterns: ["secret", "token", "apikey", "bearer", "credential"]
`,
    );

    const discoveryAdapters: Record<string, ProviderDiscoveryAdapter> = {
      fake: () => [
        {
          sourceProviderId: "anthropic",
          modelId: "sonnet-4",
          displayName: "Sonnet 4",
          reasoningTier: "high",
        },
      ],
    };

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters,
      fetchModelsDevPayload: () => ({}),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);

    const loaded = AgentsConfigSchema.parse(
      YAML.parse(readFileSync(join(dir, "agents.yaml"), "utf8")),
    );
    const generatedSeat = loaded.agents.find(
      (agent) => agent.name === "anthropic-sonnet-4-cli-high",
    );

    expect(generatedSeat).toBeDefined();
    expect(generatedSeat?.adapter).toBe("agy-cli");
    expect(generatedSeat?.options).toMatchObject({
      command: "agy",
      args: ["--model", "Sonnet 4"],
      pass_via: "argv",
      strip_patterns: ["secret", "token", "apikey", "bearer", "credential"],
    });
    expect(generatedSeat?.provenance?.managed_fields).toEqual(
      expect.arrayContaining(["options.pass_via", "options.strip_patterns"]) as unknown,
    );

    expect(loadProviderSourcesFromDir(dir).anthropic?.bindings["anthropic-cli"]?.carriers).toEqual(
      expect.objectContaining({
        pass_via: "argv",
        strip_patterns: ["secret", "token", "apikey", "bearer", "credential"],
      }) as unknown,
    );
  });
});
