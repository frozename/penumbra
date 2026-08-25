import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadModelAliasMapFromDir } from "@penumbra/config";

import type { DaemonServices } from "../src/serve.js";

import { makeTempDaemon, type TempDaemon } from "./helpers.js";

const originalConfigDir = process.env.PENUMBRA_CONFIG_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.PENUMBRA_CONFIG_DIR;
  } else {
    process.env.PENUMBRA_CONFIG_DIR = originalConfigDir;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-routing-config-"));
  tempDirs.push(dir);
  return dir;
}

function writeReloadableConfig(dir: string): void {
  writeFileSync(
    join(dir, "agents.yaml"),
    `agents:
  - name: test-agent
    adapter: mock
`,
  );
  writeFileSync(join(dir, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(dir, "quotas.yaml"), "providers: []\n");
}

function writeRouter(dir: string, mode: "off" | "shadow"): void {
  writeFileSync(join(dir, "router.yaml"), `mode: ${mode}\n`);
}

function writeAliases(dir: string, slug = "gpt-5.6"): void {
  writeFileSync(
    join(dir, "model-aliases.yaml"),
    `test-agent:
  aa_creator: openai
  aa_slug: ${slug}
`,
  );
}

function daemonServices(daemon: TempDaemon): DaemonServices {
  return daemon.services as DaemonServices;
}

function prepareReload(daemon: TempDaemon, configDir: string): void {
  const playbooksDir = join(configDir, "playbooks");
  const workflowsDir = join(configDir, "workflows");
  mkdirSync(playbooksDir);
  mkdirSync(workflowsDir);
  daemonServices(daemon).workflowDirs = { playbooksDir, workflowsDir };
}

async function reload(daemon: TempDaemon): Promise<Response> {
  return fetch(`${daemon.url}/agentchat/reload`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}` },
  });
}

test("daemon boot loads router.yaml and model-aliases.yaml, defaulting to mode:'off' when absent", async () => {
  const configuredDir = makeConfigDir();
  writeReloadableConfig(configuredDir);
  writeRouter(configuredDir, "shadow");
  writeAliases(configuredDir);
  process.env.PENUMBRA_CONFIG_DIR = configuredDir;

  const configured = makeTempDaemon();
  try {
    expect(daemonServices(configured).taskRouterConfig.mode).toBe("shadow");
    expect(daemonServices(configured).modelAliasMap).toEqual({
      "test-agent": { aa_creator: "openai", aa_slug: "gpt-5.6" },
    });
    await fetch(`${configured.url}/health`);
  } finally {
    configured.stop();
  }

  const defaultDir = makeConfigDir();
  writeReloadableConfig(defaultDir);
  process.env.PENUMBRA_CONFIG_DIR = defaultDir;
  const defaults = makeTempDaemon();
  try {
    expect(daemonServices(defaults).taskRouterConfig.mode).toBe("off");
    expect(daemonServices(defaults).modelAliasMap).toEqual({});
    await fetch(`${defaults.url}/health`);
  } finally {
    defaults.stop();
  }
});

test("a present-but-invalid router.yaml at boot does not prevent daemon start; router config falls back to mode 'off'", async () => {
  const configDir = makeConfigDir();
  writeReloadableConfig(configDir);
  writeFileSync(join(configDir, "router.yaml"), "mode: invalid\n");
  writeAliases(configDir);
  process.env.PENUMBRA_CONFIG_DIR = configDir;

  const daemon = makeTempDaemon();
  try {
    expect(daemonServices(daemon).taskRouterConfig.mode).toBe("off");
    expect(daemonServices(daemon).modelAliasMap).toEqual({
      "test-agent": { aa_creator: "openai", aa_slug: "gpt-5.6" },
    });
    await fetch(`${daemon.url}/health`);
  } finally {
    daemon.stop();
  }
});

test("a present-but-invalid model-aliases.yaml at boot falls back to an empty map while a valid router.yaml still loads", async () => {
  const configDir = makeConfigDir();
  writeReloadableConfig(configDir);
  writeRouter(configDir, "shadow");
  writeFileSync(
    join(configDir, "model-aliases.yaml"),
    `test-agent:
  aa_creator: openai
`,
  );
  process.env.PENUMBRA_CONFIG_DIR = configDir;

  const daemon = makeTempDaemon();
  try {
    expect(daemonServices(daemon).taskRouterConfig.mode).toBe("shadow");
    expect(daemonServices(daemon).modelAliasMap).toEqual({});
    await fetch(`${daemon.url}/health`);
  } finally {
    daemon.stop();
  }
});

test("reload picks up a mode change from off to shadow without a bounce", async () => {
  const configDir = makeConfigDir();
  writeReloadableConfig(configDir);
  writeRouter(configDir, "off");
  writeAliases(configDir);
  process.env.PENUMBRA_CONFIG_DIR = configDir;

  const daemon = makeTempDaemon();
  prepareReload(daemon, configDir);
  try {
    writeRouter(configDir, "shadow");

    const response = await reload(daemon);

    expect(response.status).toBe(200);
    expect(daemonServices(daemon).taskRouterConfig.mode).toBe("shadow");
  } finally {
    daemon.stop();
  }
});

test("an invalid router.yaml on reload keeps the previously committed snapshot", async () => {
  const configDir = makeConfigDir();
  writeReloadableConfig(configDir);
  writeRouter(configDir, "off");
  writeAliases(configDir);
  process.env.PENUMBRA_CONFIG_DIR = configDir;

  const daemon = makeTempDaemon();
  prepareReload(daemon, configDir);
  try {
    const previous = daemonServices(daemon).taskRouterConfig;
    writeFileSync(join(configDir, "router.yaml"), "mode: invalid\n");

    const response = await reload(daemon);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ config_path: configDir });
    expect(daemonServices(daemon).taskRouterConfig).toBe(previous);
  } finally {
    daemon.stop();
  }
});

test("an invalid model-aliases.yaml on reload keeps the previous snapshot AND does not partially apply a valid router.yaml from the same reload", async () => {
  const configDir = makeConfigDir();
  writeReloadableConfig(configDir);
  writeRouter(configDir, "off");
  writeAliases(configDir);
  process.env.PENUMBRA_CONFIG_DIR = configDir;

  const daemon = makeTempDaemon();
  prepareReload(daemon, configDir);
  try {
    const previousRouter = daemonServices(daemon).taskRouterConfig;
    const previousAliases = daemonServices(daemon).modelAliasMap;
    writeRouter(configDir, "shadow");
    writeFileSync(
      join(configDir, "model-aliases.yaml"),
      `test-agent:
  aa_creator: 123
  aa_slug: gpt-5.6
`,
    );
    expect(() => loadModelAliasMapFromDir(configDir)).toThrow();

    const response = await reload(daemon);

    expect(response.status).toBe(422);
    expect(daemonServices(daemon).taskRouterConfig).toBe(previousRouter);
    expect(daemonServices(daemon).modelAliasMap).toBe(previousAliases);
  } finally {
    daemon.stop();
  }
});
