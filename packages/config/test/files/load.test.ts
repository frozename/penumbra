import { BILLED_HAND_SEAT_WHITELIST } from "@src/files/billing-gate.js";
import { loadAgentChatConfigFromDir, reloadAgentChatConfig } from "@src/files/load.js";
import { readUtf8 } from "@src/files/node-fs.js";
import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeRecursive, writeUtf8 } from "../_fs-helpers.js";

const fsCalls = { mkdtempSync: nodeFs.mkdtempSync };

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fsCalls.mkdtempSync(join(tmpdir(), "agentchat-config-"));
  tempDirs.push(dir);
  return dir;
}

function fixture(name: "agents" | "routing" | "quotas"): string {
  return readUtf8(join(import.meta.dir, "fixtures", `${name}.yaml`));
}

function writeConfigDir(
  dir: string,
  overrides?: Partial<Record<"agents" | "routing" | "quotas", string>>,
): void {
  writeUtf8(join(dir, "agents.yaml"), overrides?.agents ?? fixture("agents"));
  writeUtf8(join(dir, "routing.yaml"), overrides?.routing ?? fixture("routing"));
  writeUtf8(join(dir, "quotas.yaml"), overrides?.quotas ?? fixture("quotas"));
}

afterEach(() => {
  reloadAgentChatConfig();
  for (const dir of tempDirs.splice(0)) {
    removeRecursive(dir);
  }
});

describe("loadAgentChatConfigFromDir", () => {
  test("happy path loads and merges all three files", () => {
    const dir = makeTempDir();
    writeConfigDir(dir);

    const loaded = loadAgentChatConfigFromDir(dir);

    expect(loaded.agents.length).toBeGreaterThan(0);
    expect(loaded.default_roles.executor).toBe("claude-acp-sonnet");
    expect(loaded.providers.length).toBeGreaterThan(0);
    expect(loaded.thoughts?.enabled).toBe(true);
    expect(loaded.shell?.enabled).toBe(true);
  });

  test("returns the same object reference for repeated calls on the same dir", () => {
    const dir = makeTempDir();
    writeConfigDir(dir);

    const first = loadAgentChatConfigFromDir(dir);
    const second = loadAgentChatConfigFromDir(dir);

    expect(first).toBe(second);
  });

  test("reloadAgentChatConfig clears cache and returns a new object reference", () => {
    const dir = makeTempDir();
    writeConfigDir(dir);

    const first = loadAgentChatConfigFromDir(dir);
    reloadAgentChatConfig();
    const second = loadAgentChatConfigFromDir(dir);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  test("missing file throws with file path in message", () => {
    const dir = makeTempDir();
    writeUtf8(join(dir, "routing.yaml"), fixture("routing"));
    writeUtf8(join(dir, "quotas.yaml"), fixture("quotas"));

    expect(() => loadAgentChatConfigFromDir(dir)).toThrow(/agents\.yaml/);
  });

  test("schema failure includes file name and zod path", () => {
    const dir = makeTempDir();
    writeConfigDir(dir, {
      agents: `agents:\n  - adapter: stdio-acp\n`,
    });

    expect(() => loadAgentChatConfigFromDir(dir)).toThrow(/agents\.yaml/);
    expect(() => loadAgentChatConfigFromDir(dir)).toThrow(/agents\.0\.name/);
  });

  test("rejects mistyped pressure cap window labels", () => {
    const dir = makeTempDir();
    writeConfigDir(dir, {
      quotas: `
providers:
  - name: anthropic
    pressure_caps:
      five_huor:
        warn: 80
        refuse: 95
`,
    });

    expect(() => loadAgentChatConfigFromDir(dir)).toThrow(/quotas\.yaml/);
    expect(() => loadAgentChatConfigFromDir(dir)).toThrow(/providers\.0\.pressure_caps\.five_huor/);
  });

  test("different dirs do not share cached object references", () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    writeConfigDir(dirA);
    writeConfigDir(dirB);

    const first = loadAgentChatConfigFromDir(dirA);
    const second = loadAgentChatConfigFromDir(dirB);

    expect(first).not.toBe(second);
  });

  test("returns deeply frozen config", () => {
    const dir = makeTempDir();
    writeConfigDir(dir);

    const loaded = loadAgentChatConfigFromDir(dir);

    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.default_roles)).toBe(true);
    expect(Object.isFrozen(loaded.agents)).toBe(true);

    expect(Reflect.set(loaded.default_roles, "executor", "changed")).toBe(false);
    expect(loaded.default_roles.executor).toBe("claude-acp-sonnet");
  });

  test("fails loudly on an unwhitelisted billed hand seat", () => {
    const dir = join(import.meta.dir, "fixtures", "billed-hand-seat");

    expect(() => loadAgentChatConfigFromDir(dir)).toThrow(/agents\.yaml/);
    expect(() => loadAgentChatConfigFromDir(dir)).toThrow(/openai-gpt52-http/);
  });

  test("uses the shared billing gate prefix in errors", () => {
    const dir = join(import.meta.dir, "fixtures", "billed-hand-seat");

    expect(() => loadAgentChatConfigFromDir(dir)).toThrow(
      new RegExp(`^${dir.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}/agents\\.yaml:`),
    );
  });

  test("exports the hand-seat whitelist constant for other packages", () => {
    expect(BILLED_HAND_SEAT_WHITELIST).toContain("deepseek-v4-flash-http");
  });
});
