import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";

import { AgentConfigSchema, AgentOptionsSchema } from "../src/files/agents.js";
import { listDir, lstatInfo, readUtf8 } from "../src/files/node-fs.js";

const fullAgentOptions = {
  agentName: "codex-acp-fast",
  allowed_tools: ["mcp__penumbra__memory_recall"],
  apiKey: "test-key",
  apiKeyEnv: "TEST_API_KEY",
  apiKeyFile: "/tmp/test-api-key",
  apiKeyKeychain: "service/account",
  api_key_env: "TEST_API_KEY",
  args: ["exec"],
  authMethodId: "auth-method",
  baseUrl: "http://127.0.0.1:8080/v1",
  binary: "codex",
  bootTimeoutMs: 1000,
  caPath: "/tmp/test-ca.pem",
  capturePort: {},
  claudeCodeAllowedTools: ["mcp__penumbra__memory_recall"],
  claudeCodeDisallowedTools: ["Bash"],
  claudeCodeSettingSources: ["user"],
  claudeCodeStrictMcpConfig: true,
  claudeCodeTools: ["Read"],
  command: "codex",
  cwd: "/tmp/worktree",
  emit_stdout_thoughts: true,
  env: { TEST_ENV: "1" },
  extraBody: { temperature: 0 },
  framing: "newline",
  fsReadTextFile: true,
  fsWriteTextFile: true,
  hostEnvPolicy: { claude: true },
  maxTokens: 1024,
  mcpServers: [{ name: "penumbra", command: "bun", args: ["penumbra-mcp.ts"] }],
  mcpWriteTools: true,
  model: "test-model",
  modelWarmupPrompt: "Reply READY.",
  model_warmup_prompt: "Reply READY.",
  opencodeBinary: "opencode",
  pass_via: "argv",
  permission_ttl_s: 60,
  provider: "openai-compat",
  repoRoot: "/tmp/repo",
  requestTimeoutMs: 60000,
  sanitizeClaudeHostEnv: true,
  strip_patterns: ["secret"],
  systemPrompt: "You are concise.",
  terminal: true,
  terminal_max_concurrent: 3,
  terminal_output_max_bytes: 1048576,
  terminal_path: "/usr/bin:/bin",
  terminal_timeout_s: 30,
  unsetEnv: ["SECRET"],
  unset_env: ["SECRET"],
  warmPool: true,
  warmPoolIdleGraceMs: 1000,
  warmPoolMaxAgeMs: 20000,
  warmPoolMaxEntries: 2,
  warmPoolSize: 2,
  warm_pool: true,
  warm_pool_health_ping: false,
  warm_pool_idle_grace_ms: 1000,
  warm_pool_max_age_ms: 20000,
  warm_pool_max_entries: 2,
  warm_pool_prewarm: true,
  warm_pool_prewarm_max_targets: 2,
  warm_pool_size: 2,
} as const;

const fullAgentOptionKeys = Object.keys(fullAgentOptions).sort();

function collectYamlFixtures(dir: string): string[] {
  const out: string[] = [];
  for (const entry of listDir(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const abs = join(dir, entry);
    const info = lstatInfo(abs);
    if (info.isSymbolicLink) continue;
    if (info.isDirectory) {
      out.push(...collectYamlFixtures(abs));
      continue;
    }
    if (/\.ya?ml$/.test(entry) && relative(process.cwd(), abs).includes("/test/")) {
      out.push(abs);
    }
  }
  return out;
}

function agentOptionsBlocksFromYamlFixture(path: string): unknown[] {
  const parsed: unknown = parseYaml(readUtf8(path));
  if (!parsed || typeof parsed !== "object") return [];
  const agents = (parsed as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return [];
  return agents
    .map((agent) =>
      agent && typeof agent === "object" ? (agent as { options?: unknown }).options : undefined,
    )
    .filter((options) => options !== undefined);
}

describe("AgentOptionsSchema strict key coverage", () => {
  test("accepts the complete declared option-key union", () => {
    const parsed = AgentOptionsSchema.parse(fullAgentOptions);
    expect(Object.keys(parsed).sort()).toEqual(fullAgentOptionKeys);
  });

  test("full-options fixture covers the exact declared schema keys", () => {
    const schemaKeys = Object.keys(AgentOptionsSchema.shape).sort();
    expect(fullAgentOptionKeys).toEqual(schemaKeys);
  });

  test("rejects typoed option keys", () => {
    expect(() => AgentOptionsSchema.parse({ warm_pool_siez: true })).toThrow(/warm_pool_siez/);
  });

  test("accepts every repo config fixture agent options block", () => {
    const fixtureOptions = collectYamlFixtures(join(process.cwd(), "packages")).flatMap(
      agentOptionsBlocksFromYamlFixture,
    );
    expect(fixtureOptions.length).toBeGreaterThan(0);
    for (const options of fixtureOptions) {
      expect(() => AgentOptionsSchema.parse(options)).not.toThrow();
    }
  });
});

describe("AgentConfigSchema adapter-aware options", () => {
  test("rejects warm_pool on opencode-acp because that adapter does not consume it", () => {
    expect(() =>
      AgentConfigSchema.parse({
        name: "opencode",
        adapter: "opencode-acp",
        options: { model: "gpt-5", warm_pool: true },
      }),
    ).toThrow(/warm_pool.*opencode-acp/);
  });

  test("accepts warm_pool on stdio-acp", () => {
    expect(() =>
      AgentConfigSchema.parse({
        name: "stdio",
        adapter: "stdio-acp",
        options: { binary: "codex", warm_pool: true },
      }),
    ).not.toThrow();
  });

  test("leaves unknown adapters forward-compatible", () => {
    expect(() =>
      AgentConfigSchema.parse({
        name: "future",
        adapter: "future-acp",
        options: { model: "future", warm_pool: true },
      }),
    ).not.toThrow();
  });
});
