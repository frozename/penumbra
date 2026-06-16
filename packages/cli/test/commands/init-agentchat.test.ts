import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

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

import { runInit } from "../../src/commands/init.js";
import { AGENTCHAT_TEMPLATE } from "../../src/commands/init-agentchat-template.js";

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

  const parsed = YAML.parse(readFileSync(agentchatPath, "utf8"));
  expect(
    parsed.agents.some((agent: { maestro_capable?: boolean }) => agent.maestro_capable === true),
  ).toBe(true);
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
