import { buildAdapter } from "@penumbra/agentchat";
import { loadConfig } from "@penumbra/agentchat/config";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

import { AGENTCHAT_TEMPLATE } from "@src/commands/init-agentchat-template.js";
import { runInit } from "@src/commands/init.js";

// Use homebrew sqlite (supports dynamic extension loading for sqlite-vec) on macOS,
// matching the bootstrap every other CLI/runtime test uses. Without it runInit's
// loadSqliteVec throws on the default macOS sqlite build.
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let storageRoot = "";
let agentchatDir = "";
let agentchatPath = "";
let claudeUserDir = "";
let oldAgentchatConfig: string | undefined;

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "penumbra-cli-init-"));
  agentchatDir = mkdtempSync(join(tmpdir(), "penumbra-agentchat-"));
  agentchatPath = join(agentchatDir, "agentchat.yaml");
  // Temp claudeUserDir so runInit's unconditional CLAUDE.md install never touches the real ~/.claude.
  claudeUserDir = mkdtempSync(join(tmpdir(), "penumbra-cli-claude-user-"));
  oldAgentchatConfig = process.env.AGENTCHAT_CONFIG;
  process.env.AGENTCHAT_CONFIG = agentchatPath;
});

afterEach(() => {
  process.env.AGENTCHAT_CONFIG = oldAgentchatConfig;
  rmSync(storageRoot, { recursive: true, force: true });
  rmSync(agentchatDir, { recursive: true, force: true });
  rmSync(claudeUserDir, { recursive: true, force: true });
});

test("seeds agentchat config when missing", async () => {
  const exit = await runInit({ storageRoot, uuid: () => "tok-123", claudeUserDir });
  expect(exit).toBe(0);
  expect(existsSync(agentchatPath)).toBe(true);
  expect(readFileSync(agentchatPath, "utf8")).toBe(AGENTCHAT_TEMPLATE);

  const parsed = YAML.parse(readFileSync(agentchatPath, "utf8")) as {
    agents: { maestro_capable?: boolean }[];
  };
  expect(parsed.agents.some((agent) => agent.maestro_capable === true)).toBe(true);
});

test("preserves an existing agentchat config by default", async () => {
  writeFileSync(agentchatPath, "sentinel: keep-me\n");

  await runInit({ storageRoot, uuid: () => "tok-123", claudeUserDir });
  expect(readFileSync(agentchatPath, "utf8")).toBe("sentinel: keep-me\n");
});

test("force-overwrites an existing agentchat config", async () => {
  writeFileSync(agentchatPath, "sentinel: keep-me\n");

  await runInit({ storageRoot, uuid: () => "tok-123", forceAgentchat: true, claudeUserDir });
  expect(readFileSync(agentchatPath, "utf8")).toBe(AGENTCHAT_TEMPLATE);
});

test("seeded template includes devin-swe-1-7-acp and resolves to stdio-acp(binary=devin, hygiene-config args)", async () => {
  await runInit({ storageRoot, uuid: () => "tok-123", claudeUserDir });

  // Run through the REAL worker config loader (full schema + adapter-option refinement),
  // not just YAML.parse — this catches any future AgentOptionsSchema drift that would
  // reject the seeded devin entry.
  const config = loadConfig(agentchatPath);
  const devin = config.agents.find((a) => a.name === "devin-swe-1-7-acp");
  expect(devin).toBeDefined();
  if (!devin) throw new Error("devin-swe-1-7-acp entry missing from seeded template");
  expect(devin.adapter).toBe("stdio-acp");
  // Roles are earned per-install after a smoke gate, never seeded: a fresh
  // install must not auto-route work to this unsmoked seat.
  expect(devin.roles).toEqual([]);
  expect(devin.maestro_capable).toBeUndefined();

  // Build via the REAL registry factory (same path the worker uses) and verify
  // it resolves to a stdio-acp adapter that will spawn
  // `devin --config ... acp --model swe-1-7`.
  const adapter = buildAdapter(devin.adapter, devin.options);
  const opts = (adapter as unknown as { opts: { binary?: string; args?: string[] } }).opts;
  expect(opts.binary).toBe("devin");
  expect(opts.args).toEqual([
    "--config",
    "/absolute/path/to/devin-acp-hygiene.json",
    "--respect-workspace-trust",
    "false",
    "acp",
    "--model",
    "swe-1-7",
  ]);
});
