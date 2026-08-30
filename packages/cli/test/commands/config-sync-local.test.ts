import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

import type { LlamactlInventory } from "../../../core/src/index.js";

import { AgentsConfigSchema } from "../../../config/src/index.js";
import { runConfigSyncLocal } from "../../src/commands/config-sync-local.js";

let tempDirs: string[] = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "penumbra-config-sync-local-"));
  tempDirs.push(dir);
  return dir;
}

function writeAgents(dir: string, agents: unknown[]): void {
  writeFileSync(join(dir, "agents.yaml"), YAML.stringify({ agents }), "utf8");
}

function readAgents(dir: string): ReturnType<typeof AgentsConfigSchema.parse> {
  return AgentsConfigSchema.parse(YAML.parse(readFileSync(join(dir, "agents.yaml"), "utf8")));
}

describe("penumbra config sync-local", () => {
  test("dry run plans local seat upserts without writing", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [{ name: "manual", adapter: "stdio-acp" }]);
    const before = readFileSync(join(dir, "agents.yaml"), "utf8");

    const result = await runConfigSyncLocal({
      configDir: dir,
      dryRun: true,
      inventory: (): {
        status: "ok";
        messages: string[];
        models: never[];
      } => ({
        status: "ok",
        messages: [],
        nodes: [{ name: "mac-mini", endpoint: "https://mac-mini.local:7945", healthy: true }],
        models: [
          {
            id: "granite-4.1-3b-Q8_0.gguf",
            node: { name: "mac-mini", endpoint: "https://mac-mini.local:7945", healthy: true },
          },
        ],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("would upsert local-granite-4-1-3b-q8-0-http");
    expect(readFileSync(join(dir, "agents.yaml"), "utf8")).toBe(before);
  });

  test("uses slashless model name for seat slug and keeps full model id in options", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [{ name: "manual", adapter: "stdio-acp" }]);

    await runConfigSyncLocal({
      configDir: dir,
      apply: true,
      inventory: (): Promise<LlamactlInventory> =>
        Promise.resolve({
          status: "ok",
          messages: [],
          nodes: [{ name: "llm-node", endpoint: "https://llm-node.local:7945", healthy: true }],
          models: [
            {
              id: "LFM2.5-8B-A1B-MoQ/MoQ-4.25.gguf",
              node: { name: "llm-node", endpoint: "https://llm-node.local:7945", healthy: true },
            },
          ],
        }),
      reloadConfig: (): { ok: boolean } => ({ ok: true }),
    });

    const seat = readAgents(dir).agents.find(
      (agent) => agent.name === "local-lfm2-5-8b-a1b-moq-http",
    );
    expect(seat).toBeDefined();
    if (!seat) throw new Error("generated seat was missing");
    expect(seat.options.model).toBe("LFM2.5-8B-A1B-MoQ/MoQ-4.25.gguf");
  });

  test("apply upserts generated seats, preserves hand tuned fields, and uses keychain secrets", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [
      {
        name: "local-granite-4-1-3b-q8-0-http",
        adapter: "openai-compat-http",
        api_provider: "local",
        roles: ["reviewer"],
        tags: ["curated"],
        quirks: ["keep me"],
        options: {
          baseUrl: "http://old",
          model: "old-model",
          maxTokens: 4096,
          extraBody: { temperature: 0 },
        },
      },
    ]);
    const reloads: string[] = [];

    const result = await runConfigSyncLocal({
      configDir: dir,
      apply: true,
      inventory: (): LlamactlInventory => ({
        status: "ok",
        messages: [],
        nodes: [{ name: "mac-mini", endpoint: "https://mac-mini.local:7945", healthy: true }],
        models: [
          {
            id: "granite-4.1-3b-Q8_0.gguf",
            node: { name: "mac-mini", endpoint: "https://mac-mini.local:7945", healthy: true },
          },
        ],
      }),
      reloadConfig: () => {
        reloads.push("reload");
        return { ok: true };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(reloads).toEqual(["reload"]);
    const seat = readAgents(dir).agents[0]!;
    expect(seat.roles).toEqual(["reviewer"]);
    expect(seat.tags).toEqual(["curated"]);
    expect(seat.quirks).toEqual(["keep me"]);
    expect(seat.options).toMatchObject({
      baseUrl: "https://mac-mini.local:7945",
      model: "granite-4.1-3b-Q8_0.gguf",
      maxTokens: 4096,
      extraBody: { temperature: 0 },
      apiKeyKeychain: "llamactl/mac-mini",
    });
    expect(JSON.stringify(seat)).not.toContain("ll_agt_");
    expect(seat.provenance).toBeUndefined();
  });

  test("stamps a freshly generated seat's provenance.managed_fields with the original 3-field list", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [{ name: "manual", adapter: "stdio-acp" }]);

    await runConfigSyncLocal({
      configDir: dir,
      apply: true,
      inventory: (): LlamactlInventory => ({
        status: "ok",
        messages: [],
        nodes: [],
        models: [
          {
            id: "fresh-model.gguf",
            node: { name: "mac-mini", endpoint: "https://mac-mini.local:7945", healthy: true },
          },
        ],
      }),
      reloadConfig: (): { ok: boolean } => ({ ok: true }),
    });

    const seat = readAgents(dir).agents.find((agent) => agent.name === "local-fresh-model-http");
    expect(seat?.provenance).toEqual({
      source: "llamactl-sync-local",
      managed_fields: ["options.baseUrl", "options.model", "options.apiKeyKeychain"],
    });
  });

  test("aborts a prune without writing when routing.yaml still references the pruned seat", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [
      {
        name: "local-vanished-http",
        adapter: "openai-compat-http",
        api_provider: "local",
        options: { baseUrl: "http://old", model: "vanished" },
        provenance: { source: "llamactl-sync-local" },
      },
    ]);
    writeFileSync(
      join(dir, "routing.yaml"),
      YAML.stringify({
        default_roles: {},
        workloads: {
          review_adversarial: {
            eligible_roles: ["reviewer"],
            synthesizer: "local-vanished-http",
          },
        },
      }),
      "utf8",
    );
    const before = readFileSync(join(dir, "agents.yaml"), "utf8");

    const result = await runConfigSyncLocal({
      configDir: dir,
      apply: true,
      inventory: (): LlamactlInventory => ({
        status: "ok",
        messages: [],
        nodes: [],
        models: [
          {
            id: "new-model.gguf",
            node: { name: "mac-mini", endpoint: "https://mac-mini.local:7945", healthy: true },
          },
        ],
      }),
      reloadConfig: (): { ok: boolean } => ({ ok: true }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("local-vanished-http");
    expect(readFileSync(join(dir, "agents.yaml"), "utf8")).toBe(before);
  });

  test("prunes only vanished generator-owned seats and keeps hand-authored seats", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [
      {
        name: "local-vanished-http",
        adapter: "openai-compat-http",
        api_provider: "local",
        options: { baseUrl: "http://old", model: "vanished" },
        provenance: { source: "llamactl-sync-local" },
      },
      {
        name: "local-hand-authored-http",
        adapter: "openai-compat-http",
        api_provider: "local",
        options: { baseUrl: "http://old", model: "vanished" },
      },
    ]);

    await runConfigSyncLocal({
      configDir: dir,
      apply: true,
      inventory: (): LlamactlInventory => ({
        status: "ok",
        messages: [],
        nodes: [],
        models: [
          {
            id: "new-model.gguf",
            node: { name: "mac-mini", endpoint: "https://mac-mini.local:7945", healthy: true },
          },
        ],
      }),
      reloadConfig: (): { ok: boolean } => ({ ok: true }),
    });

    expect(
      readAgents(dir)
        .agents.map((agent) => agent.name)
        .sort(),
    ).toEqual(["local-hand-authored-http", "local-new-model-http"]);
  });

  test("skips models already covered by a hand-authored same-model seat and prunes generator-owned duplicates", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [
      {
        name: "local-lfm2-5-8b-a1b-moq-http",
        adapter: "openai-compat-http",
        api_provider: "local",
        roles: ["executor", "reviewer"],
        tags: ["curated"],
        description: "Hand-authored local seat",
        quirks: ["manual"],
        options: {
          baseUrl: "http://hand-authored.local",
          model: "LFM2.5-8B-A1B-MoQ/MoQ-4.25.gguf",
        },
      },
      {
        name: "local-lfm2-5-8b-a1b-moq-moq-4-25-http",
        adapter: "openai-compat-http",
        api_provider: "local",
        options: {
          baseUrl: "http://generated.local",
          model: "LFM2.5-8B-A1B-MoQ/MoQ-4.25.gguf",
        },
        provenance: { source: "llamactl-sync-local" },
      },
    ]);

    await runConfigSyncLocal({
      configDir: dir,
      apply: true,
      inventory: (): LlamactlInventory => ({
        status: "ok",
        messages: [],
        nodes: [{ name: "llm-node", endpoint: "https://llm-node.local:7945", healthy: true }],
        models: [
          {
            id: "LFM2.5-8B-A1B-MoQ/MoQ-4.25.gguf",
            node: { name: "llm-node", endpoint: "https://llm-node.local:7945", healthy: true },
          },
          {
            id: "new-model.gguf",
            node: { name: "llm-node", endpoint: "https://llm-node.local:7945", healthy: true },
          },
        ],
      }),
      reloadConfig: (): { ok: boolean } => ({ ok: true }),
    });

    const agents = readAgents(dir).agents;
    expect(agents.map((agent) => agent.name).sort()).toEqual([
      "local-lfm2-5-8b-a1b-moq-http",
      "local-new-model-http",
    ]);
    const handAuthored = agents.find((agent) => agent.name === "local-lfm2-5-8b-a1b-moq-http");
    expect(handAuthored?.roles).toEqual(["executor", "reviewer"]);
    expect(handAuthored?.tags).toEqual(["curated"]);
    expect(handAuthored?.description).toBe("Hand-authored local seat");
    expect(handAuthored?.quirks).toEqual(["manual"]);
    expect(handAuthored?.options.baseUrl).toBe("http://hand-authored.local");
    expect(handAuthored?.provenance).toBeUndefined();
  });

  test("apply is idempotent", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [{ name: "manual", adapter: "stdio-acp" }]);
    const opts = {
      configDir: dir,
      apply: true,
      inventory: (): LlamactlInventory => ({
        status: "ok" as const,
        messages: [],
        nodes: [],
        models: [
          {
            id: "new-model.gguf",
            node: { name: "mac-mini", endpoint: "https://mac-mini.local:7945", healthy: true },
          },
        ],
      }),
      reloadConfig: (): { ok: boolean } => ({ ok: true }),
    };

    await runConfigSyncLocal(opts);
    const once = readFileSync(join(dir, "agents.yaml"), "utf8");
    await runConfigSyncLocal(opts);

    expect(readFileSync(join(dir, "agents.yaml"), "utf8")).toBe(once);
  });

  test("empty inventory exits cleanly without modifying agents.yaml", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [{ name: "manual", adapter: "stdio-acp" }]);
    const before = readFileSync(join(dir, "agents.yaml"), "utf8");

    const result = await runConfigSyncLocal({
      configDir: dir,
      apply: true,
      inventory: () => ({
        status: "unavailable",
        messages: ["llamactl unavailable"],
        nodes: [],
        models: [],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("llamactl unavailable");
    expect(readFileSync(join(dir, "agents.yaml"), "utf8")).toBe(before);
  });

  test("flags a suspiciously empty inventory when nodes are configured but zero models were found", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [{ name: "manual", adapter: "stdio-acp" }]);
    const before = readFileSync(join(dir, "agents.yaml"), "utf8");

    const result = await runConfigSyncLocal({
      configDir: dir,
      apply: true,
      inventory: () => ({
        status: "unavailable",
        messages: [],
        nodes: [{ name: "mac-mini", endpoint: "https://mac-mini.local:7945", healthy: true }],
        models: [],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("configured node");
    expect(readFileSync(join(dir, "agents.yaml"), "utf8")).toBe(before);
  });

  test("partial inventory skips prunes but still applies upserts", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [
      {
        name: "local-vanished-http",
        adapter: "openai-compat-http",
        api_provider: "local",
        options: { baseUrl: "http://old", model: "vanished" },
        provenance: { source: "llamactl-sync-local" },
      },
    ]);

    const result = await runConfigSyncLocal({
      configDir: dir,
      apply: true,
      inventory: () => ({
        status: "partial",
        messages: ["served models unavailable: node-b timed out"],
        nodes: [{ name: "mac-mini", endpoint: "https://mac-mini.local:7945", healthy: true }],
        models: [
          {
            id: "new-model.gguf",
            node: { name: "mac-mini", endpoint: "https://mac-mini.local:7945", healthy: true },
          },
        ],
      }),
      reloadConfig: () => ({ ok: true }),
    });

    expect(result.exitCode).toBe(0);
    expect(
      readAgents(dir)
        .agents.map((agent) => agent.name)
        .sort(),
    ).toEqual(["local-new-model-http", "local-vanished-http"]);
    expect(result.stdout.join("\n")).toContain("skipping prune");
  });

  test("aborts without writing when schema validation fails", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [{ name: "manual", adapter: "stdio-acp" }]);
    const before = readFileSync(join(dir, "agents.yaml"), "utf8");

    const result = await runConfigSyncLocal({
      configDir: dir,
      apply: true,
      inventory: () => ({
        status: "ok",
        messages: [],
        nodes: [],
        models: [
          {
            id: "new-model.gguf",
            node: { name: "mac-mini", endpoint: "https://mac-mini.local:7945", healthy: true },
          },
        ],
      }),
      validateAgentsConfig: () => {
        throw new Error("schema fail");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("schema fail");
    expect(readFileSync(join(dir, "agents.yaml"), "utf8")).toBe(before);
  });

  test("does not pull llamactl into config-load path", () => {
    const loadSource = readFileSync("packages/config/src/files/load.ts", "utf8");
    expect(loadSource).not.toContain("llamactl");
    expect(loadSource).not.toContain("sync-local");
  });

  test("cli subcommand resolves deployed split dir from PENUMBRA_CONFIG_DIR", async () => {
    const dir = await makeTempDir();
    writeAgents(dir, [{ name: "manual", adapter: "stdio-acp" }]);

    const proc = Bun.spawn(["bun", "packages/cli/bin/penumbra.ts", "config", "sync-local"], {
      env: {
        ...process.env,
        PENUMBRA_CONFIG_DIR: dir,
        PENUMBRA_LLAMACTL_PROXY_BASE_URL: "http://127.0.0.1:9",
        DEV_STORAGE: join(dir, "missing-dev-storage"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("no local models discovered");
    expect(existsSync(join(dir, "agents.yaml"))).toBe(true);
  });
});
