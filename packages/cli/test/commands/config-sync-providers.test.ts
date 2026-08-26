import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

import {
  AgentsConfigSchema,
  ModelAliasMapSchema,
  type ProviderSourcesConfig,
} from "../../../config/src/index.js";
import {
  runConfigSyncProviders,
  type ProviderDiscoveryAdapter,
} from "../../src/commands/config-sync-providers.js";
import { parseOpencodeModelsOutput } from "../../src/commands/generator/discovery-opencode.js";

let tempDirs: string[] = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "penumbra-config-sync-providers-"));
  tempDirs.push(dir);
  return dir;
}

const FLOOR_AGENTS = [
  {
    name: "role-holders",
    adapter: "stdio-acp",
    roles: ["dreaming-rewriter", "brief-synthesizer", "memory-refiner", "refiner"],
  },
  { name: "judge-a", adapter: "stdio-acp", roles: ["dreaming-judge"] },
  { name: "judge-b", adapter: "stdio-acp", roles: ["dreaming-judge"] },
];

const FLOOR_ALIASES = {
  "judge-a": { aa_creator: "anthropic", aa_slug: "claude-a" },
  "judge-b": { aa_creator: "openai", aa_slug: "gpt-b" },
};

function writeFixture(
  dir: string,
  providers: ProviderSourcesConfig,
  agents: unknown[] = FLOOR_AGENTS,
): void {
  writeFileSync(join(dir, "providers.yaml"), YAML.stringify(providers), "utf8");
  writeFileSync(join(dir, "agents.yaml"), YAML.stringify({ agents }), "utf8");
  writeFileSync(join(dir, "model-aliases.yaml"), YAML.stringify(FLOOR_ALIASES), "utf8");
  writeFileSync(join(dir, "routing.yaml"), YAML.stringify({}), "utf8");
}

function readAgents(dir: string): ReturnType<typeof AgentsConfigSchema.parse> {
  return AgentsConfigSchema.parse(YAML.parse(readFileSync(join(dir, "agents.yaml"), "utf8")));
}

function readAliases(dir: string): ReturnType<typeof ModelAliasMapSchema.parse> {
  return ModelAliasMapSchema.parse(
    YAML.parse(readFileSync(join(dir, "model-aliases.yaml"), "utf8")),
  );
}

function fakeAdapter(
  models: Array<{
    sourceProviderId: string;
    modelId: string;
    displayName: string;
    reasoningTier?: string;
  }>,
): ProviderDiscoveryAdapter {
  return async () => models;
}

function providerFixture(
  overrides: Partial<ProviderSourcesConfig[string]> = {},
): ProviderSourcesConfig {
  return {
    openai: {
      discovery: { kind: "fake", locator: "https://api.openai.com/v1/models" },
      auth: { keychain: "penumbra/openai" },
      bindings: {
        "openai-http": {
          kind: "openai-compat-http",
          pricing_mode: "subscription",
          api_provider: "openai",
          subscription_provider: "openai",
          model_carrier: "model",
          seat_name_template: "openai-{model}-http",
        },
      },
      ...overrides,
    },
  };
}

function opencodeProviderFixture(
  overrides: Partial<ProviderSourcesConfig[string]> = {},
): ProviderSourcesConfig {
  return {
    opencode: {
      discovery: { kind: "fake", locator: "opencode models --verbose" },
      auth: {},
      bindings: {
        "opencode-go-acp": {
          kind: "opencode-acp",
          pricing_mode: "subscription",
          api_provider: "opencode-go",
          subscription_provider: "opencode-go",
          model_carrier: "model",
          seat_name_template: "{model}-acp",
        },
      },
      ...overrides,
    },
  };
}

function alibabaCarrierProviderFixture(): ProviderSourcesConfig {
  return {
    alibaba: {
      discovery: { kind: "fake", locator: "codex models list" },
      auth: {},
      bindings: {
        "codex-alibaba-acp": {
          kind: "stdio-acp",
          pricing_mode: "subscription",
          api_provider: "alibaba",
          subscription_provider: "alibaba",
          model_carrier: "options.args.model",
          seat_name_template: "codex-alibaba-{model}-acp",
          carriers: {
            binary: "/opt/penumbra/bin/codex-acp",
            args_template: ["-c", "model={model}", "-c", "model_provider=alibaba"],
            unset_env: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"],
          },
        },
      },
    },
  };
}

function agyProviderFixture(): ProviderSourcesConfig {
  return {
    google: {
      discovery: { kind: "fake", locator: "agy models" },
      auth: {},
      bindings: {
        "google-gemini-cli": {
          kind: "agy-cli",
          pricing_mode: "subscription",
          api_provider: "google",
          subscription_provider: "google",
          model_carrier: "options.args.model",
          seat_name_template: "google-{model}-cli",
          carriers: {
            binary: "/Users/acordeiro/.local/bin/agy",
            args_template: [
              "--model",
              "{displayName}",
              "--dangerously-skip-permissions",
              "--print",
            ],
          },
        },
      },
    },
  };
}

const noModelsDev = async (): Promise<unknown> => ({});

describe("penumbra config sync-providers", () => {
  test("excludes exact model ids before reporting and generation, and reports stale exclusions", async () => {
    const dir = await makeTempDir();
    const providers = providerFixture({ exclude_models: ["fugu-ultra", "retired-fugu"] });
    providers.openai!.bindings["openai-cli"] = {
      kind: "cli",
      pricing_mode: "subscription",
      api_provider: "openai",
      subscription_provider: "openai",
      model_carrier: "model",
      seat_name_template: "openai-{model}-cli",
    };
    writeFixture(dir, providers, [
      ...FLOOR_AGENTS,
      {
        name: "openai-fugu-ultra-http",
        adapter: "stdio-acp",
        api_provider: "openai",
        options: { binary: "operator-seat", model: "operator-fugu" },
      },
    ]);

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "openai", modelId: "fugu-ultra", displayName: "Fugu Ultra" },
          {
            sourceProviderId: "openai",
            modelId: "fugu-ultra-20260615",
            displayName: "Fugu Ultra 2026-06-15",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toContain("model excluded by config: openai/fugu-ultra");
    expect(result.stdout).toContain("exclusion unmatched (stale): openai/retired-fugu");
    expect(result.stdout).toContain("would upsert openai-fugu-ultra-20260615-http");
    expect(result.stdout).toContain("would alias openai-fugu-ultra-20260615-http");
    expect(
      result.stdout.some((line) =>
        line.startsWith("edge lit (no seat): openai/fugu-ultra-20260615 via openai-cli"),
      ),
    ).toBe(true);
    expect(
      result.stdout.some((line) =>
        line.startsWith("edge lit (no seat): openai/fugu-ultra via openai-cli"),
      ),
    ).toBe(false);
    expect(result.stdout).not.toContain("would upsert openai-fugu-ultra-http");
    expect(result.stdout).not.toContain("hand-covered openai/fugu-ultra");
  });

  test("skips a model already covered by a hand-authored seat, matched on source+model identity, not name", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, providerFixture(), [
      ...FLOOR_AGENTS,
      {
        name: "codex-sakana-fugu-acp",
        adapter: "stdio-acp",
        api_provider: "sakana",
        options: { binary: "codex", model: "fugu" },
      },
      {
        name: "totally-unrelated-seat-name",
        adapter: "stdio-acp",
        api_provider: "openai",
        options: { binary: "codex", model: "gpt-5.5" },
      },
      {
        name: "irrelevant-env-value",
        adapter: "stdio-acp",
        api_provider: "openai",
        options: { binary: "codex", env: { OTHER: "gpt-5.4" } },
      },
    ]);

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "codex", modelId: "fugu", displayName: "Fugu" },
          { sourceProviderId: "codex", modelId: "gpt-5.5", displayName: "GPT-5.5" },
          { sourceProviderId: "codex", modelId: "gpt-5.4", displayName: "GPT-5.4" },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("hand-covered openai/gpt-5.5");
    expect(result.stdout.join("\n")).not.toContain("hand-covered openai/fugu");
    expect(result.stdout.join("\n")).not.toContain("hand-covered openai/gpt-5.4");
    expect(result.stdout.join("\n")).toContain("would upsert openai-fugu-http");
    expect(result.stdout.join("\n")).toContain("would upsert openai-gpt-5-4-http");
  });

  test("agentCarriesModel detects a -c key=value token in an argv array", async () => {
    const dir = await makeTempDir();
    writeFixture(
      dir,
      {
        alibaba: {
          discovery: { kind: "fake", locator: "codex models list" },
          auth: {},
          bindings: {
            "alibaba-acp": {
              kind: "stdio-acp",
              pricing_mode: "subscription",
              api_provider: "alibaba",
              subscription_provider: "alibaba",
              model_carrier: "options.args.model",
              seat_name_template: "alibaba-{model}-acp",
            },
          },
        },
      },
      [
        ...FLOOR_AGENTS,
        {
          name: "codex-alibaba-acp",
          adapter: "stdio-acp",
          api_provider: "alibaba",
          options: {
            binary: "codex",
            args: ["-c", "model=qwen3.8-max", "-c", "model_provider=alibaba"],
          },
        },
      ],
    );

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "alibaba",
            modelId: "qwen3.8-max",
            displayName: "Qwen 3.8 Max",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hand-covered alibaba/qwen3.8-max");
    expect(
      result.stdout.some((line) => line.includes("edge lit (no seat): alibaba/qwen3.8-max")),
    ).toBe(false);
  });

  test("agentCarriesModel detects a --flag value pair in an argv array, matching on displayName", async () => {
    const dir = await makeTempDir();
    writeFixture(
      dir,
      {
        google: {
          discovery: { kind: "fake", locator: "gemini models list" },
          auth: {},
          bindings: {
            "google-gemini-cli": {
              kind: "cli",
              pricing_mode: "subscription",
              api_provider: "google",
              subscription_provider: "google",
              model_carrier: "options.args.model",
              seat_name_template: "google-{model}-cli",
            },
          },
        },
      },
      [
        ...FLOOR_AGENTS,
        {
          name: "google-gemini-cli",
          adapter: "gemini-cli",
          api_provider: "google",
          options: {
            args: ["--model", "Gemini 3.1 Pro (High)", "--approval-mode", "yolo"],
          },
        },
      ],
    );

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "google",
            modelId: "gemini-3.1-pro-high",
            displayName: "Gemini 3.1 Pro (High)",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hand-covered google/gemini-3.1-pro-high");
    expect(
      result.stdout.some((line) => line.includes("edge lit (no seat): google/gemini-3.1-pro-high")),
    ).toBe(false);
  });

  test("upserts generated seats with provenance matching the managed-field allowlist", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, {
      sakana: {
        discovery: { kind: "fake", locator: "https://api.sakana.ai/v1/models" },
        auth: { keychain: "llamactl/sakana" },
        bindings: {
          "sakana-http": {
            kind: "openai-compat-http",
            pricing_mode: "api",
            api_provider: "sakana",
            model_carrier: "model",
            seat_name_template: "sakana-{model}-http",
          },
        },
      },
    });

    const opts = {
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "sakana", modelId: "fugu-ultra", displayName: "Fugu Ultra" },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    };
    const result = await runConfigSyncProviders({ ...opts, apply: true });

    expect(result.exitCode).toBe(0);
    const seat = readAgents(dir).agents.find((agent) => agent.name === "sakana-fugu-ultra-http");
    expect(seat).toMatchObject({
      adapter: "openai-compat-http",
      api_provider: "sakana",
      pricing_mode: "api",
      roles: [],
      provenance: {
        source: "providers-sync",
        managed_fields: [
          "name",
          "adapter",
          "api_provider",
          "pricing_mode",
          "subscription_provider",
          "options.model",
          "options.baseUrl",
          "options.apiKeyKeychain",
        ],
      },
      options: {
        model: "fugu-ultra",
        baseUrl: "https://api.sakana.ai/v1",
        apiKeyKeychain: "llamactl/sakana",
      },
    });

    const synchronized = await runConfigSyncProviders(opts);
    expect(synchronized.stdout.join("\n")).not.toContain("would upsert");
  });

  test("co-generates a model-aliases.yaml entry for every generated seat", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, providerFixture());

    await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "codex",
            modelId: "gpt-5.5",
            displayName: "GPT-5.5",
            reasoningTier: "high",
          },
          { sourceProviderId: "codex", modelId: "gpt-5.4", displayName: "GPT-5.4" },
        ]),
      },
      fetchModelsDevPayload: async () => ({
        openai: { models: { "gpt-5.5": {}, "gpt-5.4": {} } },
      }),
      reloadConfig: async () => ({ ok: true }),
    });

    const generatedNames = readAgents(dir)
      .agents.filter((agent) => agent.provenance?.source === "providers-sync")
      .map((agent) => agent.name);
    const aliases = readAliases(dir);
    expect(generatedNames).toHaveLength(2);
    expect(Object.keys(aliases).filter((name) => generatedNames.includes(name))).toHaveLength(2);
    expect(aliases["openai-gpt-5-5-http-high"]).toEqual({
      aa_creator: "openai",
      aa_slug: "gpt-5-5-high",
      reasoning_level: "high",
    });
    expect(aliases["openai-gpt-5-4-http"]).toEqual({
      aa_creator: "openai",
      aa_slug: "gpt-5-4",
    });

    const collisionDir = await makeTempDir();
    const collidingProvider = providerFixture();
    collidingProvider.openai!.bindings["second-http"] = {
      ...collidingProvider.openai!.bindings["openai-http"]!,
    };
    writeFixture(collisionDir, collidingProvider);
    const collision = await runConfigSyncProviders({
      configDir: collisionDir,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "codex", modelId: "gpt-5.5", displayName: "GPT-5.5" },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });
    expect(collision.exitCode).toBe(1);
    expect(collision.stderr.join("\n")).toContain("collides across distinct");
  });

  test("keeps tier placeholders lenient only for deterministic seat names", async () => {
    const dir = await makeTempDir();
    const providers = providerFixture();
    providers.openai!.bindings["openai-http"]!.seat_name_template = "openai-{model}-{tier}-http";
    writeFixture(dir, providers);

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "openai", modelId: "gpt-5.4", displayName: "GPT-5.4" },
          {
            sourceProviderId: "openai",
            modelId: "gpt-5.5",
            displayName: "GPT-5.5",
            reasoningTier: "high",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    const generatedNames = readAgents(dir)
      .agents.filter((agent) => agent.provenance?.source === "providers-sync")
      .map((agent) => agent.name)
      .sort();
    expect(generatedNames).toEqual(["openai-gpt-5-4-http", "openai-gpt-5-5-high-http"]);
  });

  test("aborts with no filesystem write when runGeneratorSafetyGate reports any violation", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, providerFixture());
    const agentsBefore = readFileSync(join(dir, "agents.yaml"), "utf8");
    const aliasesBefore = readFileSync(join(dir, "model-aliases.yaml"), "utf8");
    let reloads = 0;

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "codex", modelId: "gpt-5.5", displayName: "GPT-5.5" },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      safetyGate: () => ({
        ok: false,
        violations: ["unsafe one", "unsafe two"],
        warnings: ["pre-existing role-tag collision"],
      }),
      reloadConfig: async () => {
        reloads += 1;
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("unsafe one");
    expect(result.stderr.join("\n")).toContain("unsafe two");
    expect(result.stdout).toContain("warning: pre-existing role-tag collision");
    expect(readFileSync(join(dir, "agents.yaml"), "utf8")).toBe(agentsBefore);
    expect(readFileSync(join(dir, "model-aliases.yaml"), "utf8")).toBe(aliasesBefore);
    expect(reloads).toBe(0);
  });

  test("prints safety gate warnings when the gate passes", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, providerFixture());

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "codex", modelId: "gpt-5.5", displayName: "GPT-5.5" },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      safetyGate: () => ({
        ok: true,
        violations: [],
        warnings: ["pre-existing role-tag collision"],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("warning: pre-existing role-tag collision");
  });

  test("dry-run (default) makes no filesystem change; --apply writes and requests a daemon reload", async () => {
    const dir = await makeTempDir();
    writeFixture(
      dir,
      {
        openai: providerFixture().openai!,
        empty: {
          discovery: { kind: "empty", locator: "empty models" },
          auth: {},
          bindings: {},
        },
        future: {
          discovery: { kind: "future-adapter", locator: "future models" },
          auth: {},
          bindings: {},
        },
      },
      [
        ...FLOOR_AGENTS,
        {
          name: "providers-sync-existing",
          adapter: "stdio-acp",
          options: { binary: "existing", model: "existing-model" },
          pricing_mode: "subscription",
          subscription_provider: "openai",
          provenance: { source: "providers-sync", managed_fields: ["options.model"] },
        },
      ],
    );
    const agentsBefore = readFileSync(join(dir, "agents.yaml"), "utf8");
    const aliasesBefore = readFileSync(join(dir, "model-aliases.yaml"), "utf8");
    let reloads = 0;
    const opts = {
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "codex", modelId: "gpt-5.5", displayName: "GPT-5.5" },
        ]),
        empty: fakeAdapter([]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => {
        reloads += 1;
        return { ok: true };
      },
    };

    const dryRun = await runConfigSyncProviders(opts);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout.join("\n")).toContain(
      'provider future skipped: no discovery adapter registered for kind "future-adapter"',
    );
    expect(dryRun.stdout.join("\n")).toContain(
      "provider empty skipped: discovery returned zero results",
    );
    expect(dryRun.stdout.join("\n")).toContain("dry run; pass --apply");
    expect(readFileSync(join(dir, "agents.yaml"), "utf8")).toBe(agentsBefore);
    expect(readFileSync(join(dir, "model-aliases.yaml"), "utf8")).toBe(aliasesBefore);
    expect(reloads).toBe(0);

    const applied = await runConfigSyncProviders({ ...opts, apply: true });
    expect(applied.exitCode).toBe(0);
    expect(readFileSync(join(dir, "agents.yaml"), "utf8")).not.toBe(agentsBefore);
    expect(readFileSync(join(dir, "model-aliases.yaml"), "utf8")).not.toBe(aliasesBefore);
    expect(readAgents(dir).agents.some((agent) => agent.name === "providers-sync-existing")).toBe(
      true,
    );
    expect(reloads).toBe(1);
    expect(applied.stdout.join("\n")).toContain("daemon reload requested");

    const synchronized = await runConfigSyncProviders(opts);
    expect(synchronized.stdout.join("\n")).not.toContain("would upsert");
    expect(synchronized.stdout.join("\n")).not.toContain("would alias");
  });

  test("preserves operator-promoted roles when re-syncing a generated seat", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, providerFixture());
    const opts = {
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "openai", modelId: "gpt-5.5", displayName: "GPT-5.5" },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: (): Promise<{ ok: boolean }> => Promise.resolve({ ok: true }),
    };

    await runConfigSyncProviders(opts);
    const promoted = readAgents(dir);
    const promotedSeat = promoted.agents.find((agent) => agent.name === "openai-gpt-5-5-http")!;
    promotedSeat.roles = ["reviewer"];
    promotedSeat.provenance!.managed_fields = [
      "options.model",
      "options.baseUrl",
      "options.apiKeyKeychain",
    ];
    writeFileSync(join(dir, "agents.yaml"), YAML.stringify(promoted), "utf8");

    const result = await runConfigSyncProviders(opts);

    expect(result.exitCode).toBe(0);
    expect(
      readAgents(dir).agents.find((agent) => agent.name === "openai-gpt-5-5-http")?.roles,
    ).toEqual(["reviewer"]);
    expect(
      readAgents(dir).agents.find((agent) => agent.name === "openai-gpt-5-5-http")?.provenance
        ?.managed_fields,
    ).toEqual([
      "name",
      "adapter",
      "api_provider",
      "pricing_mode",
      "subscription_provider",
      "options.model",
      "options.baseUrl",
      "options.apiKeyKeychain",
    ]);
  });

  test("materializes an opencode-acp seat from model_carrier alone, no carriers block required", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, opencodeProviderFixture());

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "opencode",
            modelId: "opencode-go/deepseek-v4-pro",
            displayName: "DeepSeek V4 Pro",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    expect(
      result.stdout.some((line) =>
        line.startsWith("edge lit (no seat): opencode-go/opencode-go/deepseek-v4-pro"),
      ),
    ).toBe(false);
    const seat = readAgents(dir).agents.find(
      (agent) => agent.name === "opencode-go-deepseek-v4-pro-acp",
    );
    expect(seat).toMatchObject({
      adapter: "opencode-acp",
      api_provider: "opencode-go",
      pricing_mode: "subscription",
      subscription_provider: "opencode-go",
      options: { model: "opencode-go/deepseek-v4-pro" },
      provenance: {
        source: "providers-sync",
        managed_fields: [
          "name",
          "adapter",
          "api_provider",
          "pricing_mode",
          "subscription_provider",
          "options.model",
        ],
      },
    });
    expect(seat?.options).not.toHaveProperty("opencodeBinary");
  });

  test("carriers.binary threads into options.opencodeBinary for opencode-acp", async () => {
    const dir = await makeTempDir();
    const providers = opencodeProviderFixture();
    providers.opencode!.bindings["opencode-go-acp"]!.carriers = {
      binary: "/opt/opencode-go/bin/opencode",
    };
    writeFixture(dir, providers);

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "opencode",
            modelId: "opencode-go/qwen3.7-max",
            displayName: "Qwen 3.7 Max",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    const seat = readAgents(dir).agents.find(
      (agent) => agent.name === "opencode-go-qwen3-7-max-acp",
    );
    expect(seat?.options).toMatchObject({
      model: "opencode-go/qwen3.7-max",
      opencodeBinary: "/opt/opencode-go/bin/opencode",
    });
    expect(seat?.provenance?.managed_fields).toContain("options.opencodeBinary");
  });

  test("reproduces the live codex-alibaba-acp args shape from an args_template", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, alibabaCarrierProviderFixture());

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "alibaba",
            modelId: "qwen3.8-max",
            displayName: "Qwen 3.8 Max",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    const seat = readAgents(dir).agents.find(
      (agent) => agent.name === "codex-alibaba-qwen3-8-max-acp",
    );
    expect(seat?.options).toMatchObject({
      binary: "/opt/penumbra/bin/codex-acp",
      args: ["-c", "model=qwen3.8-max", "-c", "model_provider=alibaba"],
      unsetEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"],
    });
    expect(seat?.options).not.toHaveProperty("command");
  });

  test("re-syncing a generated stdio-acp carrier seat reports no pending changes", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, alibabaCarrierProviderFixture());
    const opts = {
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "alibaba",
            modelId: "qwen3.8-max",
            displayName: "Qwen 3.8 Max",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    };

    const first = await runConfigSyncProviders(opts);
    const second = await runConfigSyncProviders(opts);

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("upserted codex-alibaba-qwen3-8-max-acp");
    expect(first.stdout).toContain("aliased codex-alibaba-qwen3-8-max-acp");
    expect(second.exitCode).toBe(0);
    expect(second.stdout).not.toContain("upserted codex-alibaba-qwen3-8-max-acp");
    expect(second.stdout).not.toContain("aliased codex-alibaba-qwen3-8-max-acp");
  });

  test("an env template renders literally, including a TOML-shaped CODEX_CONFIG value", async () => {
    const dir = await makeTempDir();
    const providers = alibabaCarrierProviderFixture();
    providers.alibaba!.bindings["codex-alibaba-acp"]!.carriers!.env = {
      CODEX_CONFIG: 'model = "{model}"\nmodel_provider = "alibaba"',
    };
    writeFixture(dir, providers);

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "alibaba",
            modelId: "qwen3.8-max",
            displayName: "Qwen 3.8 Max",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    const seat = readAgents(dir).agents.find(
      (agent) => agent.name === "codex-alibaba-qwen3-8-max-acp",
    );
    expect(seat?.options.env?.CODEX_CONFIG).toBe(
      'model = "qwen3.8-max"\nmodel_provider = "alibaba"',
    );
  });

  test("managed_fields covers exactly the carrier-set paths", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, alibabaCarrierProviderFixture());

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "alibaba",
            modelId: "qwen3.8-max",
            displayName: "Qwen 3.8 Max",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    expect(
      readAgents(dir).agents.find((agent) => agent.name === "codex-alibaba-qwen3-8-max-acp")
        ?.provenance?.managed_fields,
    ).toEqual([
      "name",
      "adapter",
      "api_provider",
      "pricing_mode",
      "subscription_provider",
      "options.binary",
      "options.args",
      "options.unsetEnv",
    ]);
  });

  test("materializes an agy-cli seat with options.command (not options.binary)", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, agyProviderFixture());

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "google",
            modelId: "gemini-3.1-pro-high",
            displayName: "Gemini 3.1 Pro (High)",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    const seat = readAgents(dir).agents.find(
      (agent) => agent.name === "google-gemini-3-1-pro-high-cli",
    );
    expect(seat).toMatchObject({
      adapter: "agy-cli",
      api_provider: "google",
      pricing_mode: "subscription",
      subscription_provider: "google",
      options: {
        command: "/Users/acordeiro/.local/bin/agy",
        args: ["--model", "Gemini 3.1 Pro (High)", "--dangerously-skip-permissions", "--print"],
      },
      provenance: {
        source: "providers-sync",
        managed_fields: [
          "name",
          "adapter",
          "api_provider",
          "pricing_mode",
          "subscription_provider",
          "options.command",
          "options.args",
        ],
      },
    });
    expect(seat?.options).not.toHaveProperty("binary");
  });

  test("args_template substitutes {displayName}, not {model}", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, agyProviderFixture());

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "google",
            modelId: "gemini-3.5-flash-medium",
            displayName: "Gemini 3.5 Flash (Medium)",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).not.toContain("carriers.args_template must include {model}");
    expect(
      readAgents(dir).agents.find((agent) => agent.name === "google-gemini-3-5-flash-medium-cli")
        ?.options.args,
    ).toEqual([
      "--model",
      "Gemini 3.5 Flash (Medium)",
      "--dangerously-skip-permissions",
      "--print",
    ]);
  });

  test("subscription_model_source:'displayName' stamps top-level subscription_model and lists it in managed_fields", async () => {
    const dir = await makeTempDir();
    const providers = agyProviderFixture();
    providers.google!.bindings["google-gemini-cli"]!.carriers!.subscription_model_source =
      "displayName";
    writeFixture(dir, providers);

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "google",
            modelId: "gemini-3.1-pro-high",
            displayName: "Gemini 3.1 Pro (High)",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    const seat = readAgents(dir).agents.find(
      (agent) => agent.name === "google-gemini-3-1-pro-high-cli",
    );
    expect(seat?.subscription_model).toBe("Gemini 3.1 Pro (High)");
    expect(seat?.provenance?.managed_fields).toContain("subscription_model");
  });

  test("with the real google-gemini-cli hand seat shape present, the agy source reports hand-covered", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, agyProviderFixture(), [
      ...FLOOR_AGENTS,
      {
        name: "google-gemini-cli",
        adapter: "agy-cli",
        api_provider: "google",
        pricing_mode: "subscription",
        subscription_provider: "google",
        options: {
          command: "/Users/acordeiro/.local/bin/agy",
          args: ["--model", "Gemini 3.1 Pro (High)", "--dangerously-skip-permissions", "--print"],
          pass_via: "argv",
        },
      },
    ]);

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "google",
            modelId: "gemini-3.1-pro-high",
            displayName: "Gemini 3.1 Pro (High)",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hand-covered google/gemini-3.1-pro-high");
    expect(result.stdout.join("\n")).not.toContain("would upsert google-gemini-3-1-pro-high-cli");
  });

  test("a stdio-acp binding with no carriers.binary stays refused with the existing 'requires the P5 binding contract' message, suffixed with the missing carrier name", async () => {
    const dir = await makeTempDir();
    const providers = alibabaCarrierProviderFixture();
    delete providers.alibaba!.bindings["codex-alibaba-acp"]!.carriers!.binary;
    writeFixture(dir, providers);

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "alibaba",
            modelId: "qwen3.8-max",
            displayName: "Qwen 3.8 Max",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "edge lit (no seat): alibaba/qwen3.8-max via codex-alibaba-acp — seat generation for kind stdio-acp requires the P5 binding contract (binary/tier/env carriers): missing carriers.binary",
    );
    expect(
      readAgents(dir).agents.filter((agent) => agent.provenance?.source === "providers-sync"),
    ).toHaveLength(0);
  });

  test("an args_template with no {model} placeholder is reported once at binding construction", async () => {
    const dir = await makeTempDir();
    const providers = alibabaCarrierProviderFixture();
    providers.alibaba!.bindings["codex-alibaba-acp"]!.carriers!.args_template = [
      "-c",
      "model=qwen3.8-max",
      "-c",
      "model_provider=alibaba",
    ];
    writeFixture(dir, providers);

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "alibaba",
            modelId: "qwen3.8-max",
            displayName: "Qwen 3.8 Max",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    expect(
      result.stdout.filter(
        (line) =>
          line ===
          "binding unusable: alibaba/codex-alibaba-acp — carriers.args_template must include {model}",
      ),
    ).toHaveLength(1);
    expect(
      readAgents(dir).agents.filter((agent) => agent.provenance?.source === "providers-sync"),
    ).toHaveLength(0);
  });

  test("a stdio-acp args_template with only {displayName} remains unusable", async () => {
    const dir = await makeTempDir();
    const providers = alibabaCarrierProviderFixture();
    providers.alibaba!.bindings["codex-alibaba-acp"]!.carriers!.args_template = [
      "-c",
      "model={displayName}",
      "-c",
      "model_provider=alibaba",
    ];
    writeFixture(dir, providers);

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "alibaba",
            modelId: "qwen3.8-max",
            displayName: "Qwen 3.8 Max",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "binding unusable: alibaba/codex-alibaba-acp — carriers.args_template must include {model}",
    );
    expect(
      readAgents(dir).agents.filter((agent) => agent.provenance?.source === "providers-sync"),
    ).toHaveLength(0);
  });

  test("prints per-row discovery diagnostics before continuing sync", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, agyProviderFixture());

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: async () => ({
          outcome: "discovered",
          models: [
            {
              sourceProviderId: "google",
              modelId: "gemini-3.1-pro-high",
              displayName: "Gemini 3.1 Pro (High)",
            },
          ],
          diagnostics: [
            {
              row: "missing-tab-row",
              reason: "missing tab separator",
            },
            {
              row: "empty-name\t   ",
              reason: "empty display name",
            },
          ],
        }),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'provider google malformed row skipped: "missing-tab-row" — missing tab separator',
    );
    expect(result.stdout).toContain(
      'provider google malformed row skipped: "empty-name\\t   " — empty display name',
    );
    expect(result.stdout).toContain("would upsert google-gemini-3-1-pro-high-cli");
  });

  test("reports an unusable args_template once when every discovered edge is hand-covered", async () => {
    const dir = await makeTempDir();
    const providers = alibabaCarrierProviderFixture();
    providers.alibaba!.bindings["codex-alibaba-acp"]!.carriers!.args_template = [
      "-c",
      "model=qwen3.8-max",
      "-c",
      "model_provider=alibaba",
    ];
    writeFixture(dir, providers, [
      ...FLOOR_AGENTS,
      {
        name: "hand-authored-codex-alibaba-acp",
        adapter: "stdio-acp",
        api_provider: "alibaba",
        options: {
          binary: "codex",
          args: ["-c", "model=qwen3.8-max", "-c", "model_provider=alibaba"],
        },
      },
    ]);

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "alibaba",
            modelId: "qwen3.8-max",
            displayName: "Qwen 3.8 Max",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hand-covered alibaba/qwen3.8-max");
    expect(
      result.stdout.filter(
        (line) =>
          line ===
          "binding unusable: alibaba/codex-alibaba-acp — carriers.args_template must include {model}",
      ),
    ).toHaveLength(1);
    expect(result.stdout.join("\n")).not.toContain("would upsert");
  });

  test("a model with no reasoningTier under a {tier}-referencing template refuses THAT edge only — the sibling alibaba edges still generate", async () => {
    const dir = await makeTempDir();
    const providers = alibabaCarrierProviderFixture();
    providers.alibaba!.bindings["codex-alibaba-acp"]!.carriers!.args_template = [
      "-c",
      "model={model}",
      "-c",
      "model_provider=alibaba",
      "-c",
      "model_reasoning_effort={tier}",
    ];
    writeFixture(dir, providers);

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "alibaba",
            modelId: "qwen3.8-max",
            displayName: "Qwen 3.8 Max",
          },
          {
            sourceProviderId: "alibaba",
            modelId: "qwen3.8-plus",
            displayName: "Qwen 3.8 Plus",
            reasoningTier: "high",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "edge lit (no seat): alibaba/qwen3.8-max via codex-alibaba-acp — reasoningTier is required for carrier template token {tier}",
    );
    const generated = readAgents(dir).agents.filter(
      (agent) => agent.provenance?.source === "providers-sync",
    );
    expect(generated.map((agent) => agent.name)).toEqual(["codex-alibaba-qwen3-8-plus-acp-high"]);
    expect(generated[0]?.options.args).toContain("model_reasoning_effort=high");
  });

  test("generates the whole opencode-go catalog fixture without unique-name or billed-seat failures", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, opencodeProviderFixture());
    const catalogModels = parseOpencodeModelsOutput(
      readFileSync(join(import.meta.dir, "fixtures", "opencode-models.txt"), "utf8"),
    )
      .slice(0, 31)
      .map((model) => ({
        ...model,
        modelId: model.modelId.replace(/^opencode\//, "opencode-go/"),
      }));

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter(catalogModels),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(catalogModels.length).toBeGreaterThan(30);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout.join("\n")).not.toContain("safety gate failed");
    expect(result.stdout.join("\n")).not.toContain("collide");
    expect(
      readAgents(dir).agents.filter((agent) => agent.provenance?.source === "providers-sync"),
    ).toHaveLength(catalogModels.length);
  });

  test("a freshly generated opencode-acp seat has no consumed roles", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, opencodeProviderFixture());

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "opencode",
            modelId: "opencode-go/glm-5.2",
            displayName: "GLM 5.2",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: async () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    expect(
      readAgents(dir).agents.find((agent) => agent.name === "opencode-go-glm-5-2-acp")?.roles,
    ).toEqual([]);
  });

  test("a hand-authored opencode-acp seat pinning the same model is still hand-covered", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, opencodeProviderFixture(), [
      ...FLOOR_AGENTS,
      {
        name: "hand-opencode-go-deepseek",
        adapter: "opencode-acp",
        api_provider: "opencode-go",
        pricing_mode: "subscription",
        subscription_provider: "opencode-go",
        options: { model: "opencode-go/deepseek-v4-pro" },
      },
    ]);

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          {
            sourceProviderId: "opencode",
            modelId: "opencode-go/deepseek-v4-pro",
            displayName: "DeepSeek V4 Pro",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hand-covered opencode-go/opencode-go/deepseek-v4-pro");
    expect(result.stdout.join("\n")).not.toContain("edge lit (no seat):");
    expect(result.stdout.join("\n")).not.toContain("would upsert");
  });

  test("a bare cli binding still produces the byte-identical P5 binding-contract refusal", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, {
      openai: {
        discovery: { kind: "fake", locator: "codex models list" },
        auth: {},
        bindings: {
          "codex-cli": {
            kind: "cli",
            pricing_mode: "subscription",
            api_provider: "openai",
            subscription_provider: "openai",
            model_carrier: "model",
            seat_name_template: "openai-{model}-cli",
          },
        },
      },
    });

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "openai", modelId: "gpt-5.4", displayName: "GPT-5.4" },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "edge lit (no seat): openai/gpt-5.4 via codex-cli — seat generation for kind cli requires the P5 binding contract (binary/tier/env carriers)",
    );
  });

  test("reports non-HTTP binding edges without generating seats or aliases", async () => {
    const dir = await makeTempDir();
    writeFixture(
      dir,
      {
        openai: {
          discovery: { kind: "fake", locator: "codex models list" },
          auth: {},
          bindings: {
            "codex-cli": {
              kind: "cli",
              pricing_mode: "subscription",
              api_provider: "openai",
              subscription_provider: "openai",
              model_carrier: "model",
              seat_name_template: "openai-{model}-cli",
            },
            "codex-acp": {
              kind: "stdio-acp",
              pricing_mode: "subscription",
              api_provider: "openai",
              subscription_provider: "openai",
              model_carrier: "env.CODEX_CONFIG",
              seat_name_template: "openai-{model}-acp",
            },
          },
        },
      },
      [
        ...FLOOR_AGENTS,
        {
          name: "hand-codex",
          adapter: "stdio-acp",
          api_provider: "openai",
          options: { binary: "/opt/codex", model: "gpt-5.5" },
        },
      ],
    );

    const result = await runConfigSyncProviders({
      configDir: dir,
      apply: true,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "openai", modelId: "gpt-5.5", displayName: "GPT-5.5" },
          { sourceProviderId: "openai", modelId: "gpt-5.4", displayName: "GPT-5.4" },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
      reloadConfig: (): Promise<{ ok: boolean }> => Promise.resolve({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hand-covered openai/gpt-5.5");
    expect(result.stdout).toContain(
      "edge lit (no seat): openai/gpt-5.4 via codex-cli — seat generation for kind cli requires the P5 binding contract (binary/tier/env carriers)",
    );
    expect(result.stdout).toContain(
      "edge lit (no seat): openai/gpt-5.4 via codex-acp — seat generation for kind stdio-acp requires the P5 binding contract (binary/tier/env carriers): missing carriers.binary",
    );
    expect(
      readAgents(dir).agents.filter((agent) => agent.provenance?.source === "providers-sync"),
    ).toHaveLength(0);
    expect(Object.keys(readAliases(dir))).toEqual(Object.keys(FLOOR_ALIASES));
  });

  test("reports one non-HTTP edge with discovered reasoning tiers in order", async () => {
    const dir = await makeTempDir();
    writeFixture(
      dir,
      {
        openai: {
          discovery: { kind: "fake", locator: "codex models list" },
          auth: {},
          bindings: {
            "codex-acp": {
              kind: "stdio-acp",
              pricing_mode: "subscription",
              api_provider: "openai",
              subscription_provider: "openai",
              model_carrier: "model",
              seat_name_template: "openai-{model}-acp",
            },
          },
        },
      },
      [
        ...FLOOR_AGENTS,
        {
          name: "hand-codex",
          adapter: "stdio-acp",
          api_provider: "openai",
          options: { binary: "/opt/codex", model: "gpt-5.5" },
        },
      ],
    );

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "openai", modelId: "gpt-5.5", displayName: "GPT-5.5" },
          {
            sourceProviderId: "openai",
            modelId: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            reasoningTier: "low",
          },
          {
            sourceProviderId: "openai",
            modelId: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            reasoningTier: "high",
          },
          {
            sourceProviderId: "openai",
            modelId: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            reasoningTier: "ultra",
          },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.filter((line) => line.startsWith("edge lit (no seat):"))).toEqual([
      "edge lit (no seat): openai/gpt-5.6-sol [low,high,ultra] via codex-acp — seat generation for kind stdio-acp requires the P5 binding contract (binary/tier/env carriers): missing carriers.binary",
    ]);
    expect(result.stdout.filter((line) => line.startsWith("hand-covered "))).toEqual([
      "hand-covered openai/gpt-5.5",
    ]);
  });

  test("does not fall back from a defined carrier path to options.model", async () => {
    const dir = await makeTempDir();
    const providers = providerFixture();
    providers.openai!.bindings["openai-http"]!.model_carrier = "env.MODEL_ID";
    writeFixture(dir, providers, [
      ...FLOOR_AGENTS,
      {
        name: "hand-codex",
        adapter: "stdio-acp",
        api_provider: "openai",
        options: { binary: "/opt/codex", model: "gpt-5.5", env: { MODEL_ID: "gpt-5.4" } },
      },
    ]);

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "openai", modelId: "gpt-5.5", displayName: "GPT-5.5" },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("hand-covered openai/gpt-5.5");
    expect(result.stdout).toContain("would upsert openai-gpt-5-5-http");
  });

  test("scans embedded CODEX_CONFIG identities only for CODEX_CONFIG carriers", async () => {
    const dir = await makeTempDir();
    writeFixture(
      dir,
      {
        sakana: {
          discovery: { kind: "fake", locator: "https://api.sakana.ai/v1/models" },
          auth: { keychain: "llamactl/sakana" },
          bindings: {
            "sakana-other-http": {
              kind: "openai-compat-http",
              pricing_mode: "api",
              api_provider: "sakana",
              model_carrier: "env.OTHER_CONFIG",
              seat_name_template: "sakana-other-{model}-http",
            },
          },
        },
        deepseek: {
          discovery: { kind: "fake", locator: "https://api.deepseek.com/v1/models" },
          auth: { keychain: "llamactl/deepseek" },
          bindings: {
            "deepseek-codex-http": {
              kind: "openai-compat-http",
              pricing_mode: "api",
              api_provider: "deepseek",
              model_carrier: "env.CODEX_CONFIG",
              seat_name_template: "deepseek-codex-{model}-http",
            },
          },
        },
      },
      [
        ...FLOOR_AGENTS,
        {
          name: "hand-sakana",
          adapter: "stdio-acp",
          api_provider: "sakana",
          options: { binary: "/opt/codex", env: { CODEX_CONFIG: '{"model":"gpt-5.5"}' } },
        },
        {
          name: "hand-deepseek",
          adapter: "stdio-acp",
          api_provider: "deepseek",
          options: { binary: "/opt/codex", env: { CODEX_CONFIG: '{"model":"gpt-5.5"}' } },
        },
      ],
    );

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "ignored", modelId: "gpt-5.5", displayName: "GPT-5.5" },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("hand-covered sakana/gpt-5.5");
    expect(result.stdout).toContain("would upsert sakana-other-gpt-5-5-http");
    expect(result.stdout).toContain("hand-covered deepseek/gpt-5.5");
    expect(result.stdout).not.toContain("would upsert deepseek-codex-gpt-5-5-http");
  });

  test("refuses unsafe model-carrier segments before binding generation", async () => {
    const dir = await makeTempDir();
    const providers = providerFixture();
    providers.openai!.bindings["openai-http"]!.model_carrier = "options.__proto__.polluted";
    writeFixture(dir, providers, [
      ...FLOOR_AGENTS,
      {
        name: "same-provider-manual-seat",
        adapter: "stdio-acp",
        api_provider: "openai",
        options: { binary: "/opt/codex" },
      },
    ]);

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "openai", modelId: "gpt-5.5", displayName: "GPT-5.5" },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'penumbra config sync-providers: refusing unsafe model carrier "options.__proto__.polluted"',
    );
  });

  test("warns before overwriting a model alias not owned by a prior providers sync", async () => {
    const dir = await makeTempDir();
    writeFixture(dir, providerFixture());
    writeFileSync(
      join(dir, "model-aliases.yaml"),
      YAML.stringify({
        ...FLOOR_ALIASES,
        "openai-gpt-5-5-http": { aa_creator: "anthropic", aa_slug: "operator-alias" },
      }),
      "utf8",
    );

    const result = await runConfigSyncProviders({
      configDir: dir,
      discoveryAdapters: {
        fake: fakeAdapter([
          { sourceProviderId: "openai", modelId: "gpt-5.5", displayName: "GPT-5.5" },
        ]),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "penumbra config sync-providers: warning: overwriting non-generated model alias openai-gpt-5-5-http",
    );
  });

  test("rejects prototype discovery adapters and validates skipped reasons", async () => {
    const prototypeDir = await makeTempDir();
    writeFixture(prototypeDir, providerFixture({ discovery: { kind: "toString", locator: "x" } }));

    const prototypeResult = await runConfigSyncProviders({
      configDir: prototypeDir,
      discoveryAdapters: {},
      fetchModelsDevPayload: noModelsDev,
    });

    expect(prototypeResult.exitCode).toBe(0);
    expect(prototypeResult.stdout).toContain(
      'provider openai skipped: no discovery adapter registered for kind "toString"',
    );

    const invalidReasonDir = await makeTempDir();
    writeFixture(invalidReasonDir, providerFixture());
    const invalidReasonResult = await runConfigSyncProviders({
      configDir: invalidReasonDir,
      discoveryAdapters: {
        fake: () => Promise.resolve({ outcome: "skipped", reason: 42 } as never),
      },
      fetchModelsDevPayload: noModelsDev,
    });

    expect(invalidReasonResult.exitCode).toBe(0);
    expect(invalidReasonResult.stdout).toContain(
      "provider openai skipped: discovery adapter returned an invalid skipped reason",
    );
  });
});
