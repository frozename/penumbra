import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpencodeCliAdapter } from "@src/adapters/opencode-cli.js";
import { buildAdapter } from "@src/adapters/registry.js";

interface OpencodeMcpServerCfg {
  type: "local";
  command: string[];
  environment: Record<string, string>;
  enabled: boolean;
}

interface OpencodeConfigSnapshot {
  $schema?: string;
  mcp: Record<string, OpencodeMcpServerCfg>;
}

interface CaptureScript {
  markerPath: string;
  snapshotPath: string;
  scriptPath: string;
}

const tempDirs: string[] = [];

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-home-"));
  tempDirs.push(dir);
  const prevHome = process.env.HOME;
  const homedirSpy = spyOn(os, "homedir").mockReturnValue(dir);
  process.env.HOME = dir;
  try {
    return await fn();
  } finally {
    homedirSpy.mockRestore();
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  }
}

function createCaptureScript(): CaptureScript {
  const dir = mkdtempSync(join(tmpdir(), "opencode-cli-test-"));
  tempDirs.push(dir);
  const markerPath = join(dir, "xdg-home.txt");
  const snapshotPath = join(dir, "config-snapshot.json");
  const scriptPath = join(dir, "capture-xdg.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/sh
printf '%s' "$XDG_CONFIG_HOME" > "$1"
cp "$XDG_CONFIG_HOME/opencode/config.json" "$2"
cat
`,
    "utf8",
  );
  chmodSync(scriptPath, 0o755);
  return { markerPath, snapshotPath, scriptPath };
}

function readSnapshot(snapshotPath: string): OpencodeConfigSnapshot {
  return JSON.parse(readFileSync(snapshotPath, "utf8")) as OpencodeConfigSnapshot;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

test("opencode-cli sets a per-dispatch XDG_CONFIG_HOME when mcpServers are provided", async () => {
  const { markerPath, snapshotPath, scriptPath } = createCaptureScript();
  const adapter = new OpencodeCliAdapter({
    model: "gpt-5",
    command: scriptPath,
    args: [markerPath, snapshotPath],
    pass_via: "stdin",
    mcpServers: [
      {
        name: "penumbra",
        command: "bun",
        args: ["/tmp/penumbra-mcp.ts"],
        env: [{ name: "PENUMBRA_STORAGE_ROOT", value: "/tmp/penumbra-live" }],
      },
    ],
  });

  const out = await withTempHome(() =>
    adapter.dispatch({
      prompt: "hi opencode",
      conversation: { id: "c", project_id: null },
      config: {},
      signal: new AbortController().signal,
    }),
  );

  const xdgConfigHome = readFileSync(markerPath, "utf8");
  const snapshot = readSnapshot(snapshotPath);

  expect(out.text.trim()).toBe("hi opencode");
  expect(xdgConfigHome).toContain("penumbra-oc-mcp-");
  expect(snapshot).toEqual({
    $schema: "https://opencode.ai/config.json",
    mcp: {
      penumbra: {
        type: "local",
        command: ["bun", "/tmp/penumbra-mcp.ts"],
        environment: { PENUMBRA_STORAGE_ROOT: "/tmp/penumbra-live" },
        enabled: true,
      },
    },
  });
  expect(existsSync(join(xdgConfigHome, "opencode", "config.json"))).toBe(false);
});

test("registry forwards mcpServers to opencode-cli", async () => {
  const { markerPath, snapshotPath, scriptPath } = createCaptureScript();
  const adapter = buildAdapter("opencode-cli", {
    model: "gpt-5",
    command: scriptPath,
    args: [markerPath, snapshotPath],
    pass_via: "stdin",
    mcpServers: [
      {
        name: "penumbra",
        command: "bun",
        args: ["/tmp/penumbra-mcp.ts"],
        env: [{ name: "PENUMBRA_STORAGE_ROOT", value: "/tmp/penumbra-live" }],
      },
    ],
  });

  const out = await adapter.dispatch({
    prompt: "hi registry",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
  });

  const xdgConfigHome = readFileSync(markerPath, "utf8");
  const snapshot = readSnapshot(snapshotPath);

  expect(out.text.trim()).toBe("hi registry");
  expect(xdgConfigHome).toContain("penumbra-oc-mcp-");
  expect(snapshot.mcp.penumbra).toBeDefined();
  expect(existsSync(join(xdgConfigHome, "opencode", "config.json"))).toBe(false);
});
