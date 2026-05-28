import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { runInit } from "../../src/commands/init.js";
import { AGENTCHAT_TEMPLATE } from "../../src/commands/init-agentchat-template.js";

let storageRoot = "";
let agentchatDir = "";
let agentchatPath = "";
let oldAgentchatConfig: string | undefined;

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "penumbra-cli-init-"));
  agentchatDir = mkdtempSync(join(tmpdir(), "penumbra-agentchat-"));
  agentchatPath = join(agentchatDir, "agentchat.yaml");
  oldAgentchatConfig = process.env.AGENTCHAT_CONFIG;
  process.env.AGENTCHAT_CONFIG = agentchatPath;
});

afterEach(() => {
  process.env.AGENTCHAT_CONFIG = oldAgentchatConfig;
  rmSync(storageRoot, { recursive: true, force: true });
  rmSync(agentchatDir, { recursive: true, force: true });
});

test("seeds agentchat config when missing", async () => {
  const exit = await runInit({ storageRoot, uuid: () => "tok-123" });
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

  await runInit({ storageRoot, uuid: () => "tok-123" });
  expect(readFileSync(agentchatPath, "utf8")).toBe("sentinel: keep-me\n");
});

test("force-overwrites an existing agentchat config", async () => {
  writeFileSync(agentchatPath, "sentinel: keep-me\n");

  await runInit({ storageRoot, uuid: () => "tok-123", forceAgentchat: true });
  expect(readFileSync(agentchatPath, "utf8")).toBe(AGENTCHAT_TEMPLATE);
});
