import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../bin/penumbra.ts", import.meta.url));
const FAKE_PLUGIN_REGISTRATION =
  '# fake codex: plugin registration\n[plugins."penumbra@penumbra-local"]\nenabled = true\n';

interface Fixture {
  root: string;
  codexDir: string;
  executable: string;
  logPath: string;
  statePath: string;
}

interface CliResult {
  exit: number;
  stdout: string;
  stderr: string;
}

interface FakeState {
  marketplace: boolean;
  installed: boolean;
  root: string | null;
  unknown: boolean;
  tamperManagedMcpOnAdd?: boolean;
}

interface SetupReport {
  ok: boolean;
  changed: boolean;
  mode: string;
  components: { mcp: { state: string }; skills: { state: string } };
}

interface OwnershipManifest {
  plugin: {
    identifier: string;
    marketplaceName: string;
    marketplaceOwned: boolean;
    pluginOwned: boolean;
  };
}

function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex plugin cli '$` ")));
  const binDir = join(root, "bin");
  const executable = join(binDir, "codex");
  const logPath = join(root, "calls.jsonl");
  const statePath = join(root, "state.json");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    executable,
    `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const logPath = process.env.FAKE_CODEX_LOG;
const statePath = process.env.FAKE_CODEX_STATE;
if (!logPath || !statePath || !process.env.CODEX_HOME) process.exit(90);
appendFileSync(logPath, JSON.stringify({ args, codexHome: process.env.CODEX_HOME }) + "\\n");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { marketplace: false, installed: false, root: null, unknown: false };
const save = () => writeFileSync(statePath, JSON.stringify(state));
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const configPath = process.env.CODEX_HOME + "/config.toml";
const registration = ${JSON.stringify(FAKE_PLUGIN_REGISTRATION)};
const readConfig = () => existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
const writeConfig = (value) => { mkdirSync(process.env.CODEX_HOME, { recursive: true }); writeFileSync(configPath, value); };
const appendConfig = (block) => { const current = readConfig(); const separator = current === "" || current.endsWith("\\n\\n") ? "" : current.endsWith("\\n") ? "\\n" : "\\n\\n"; writeConfig(current + separator + block); };
const installedFromConfig = () => readConfig().includes(registration);
if (args[0] === "--version") { process.stdout.write("codex-cli 0.153.4\\n"); process.exit(0); }
if (args.join(" ") === "plugin --help") { process.stdout.write("add list remove marketplace\\n"); process.exit(0); }
if (args.join(" ") === "plugin marketplace --help") { process.stdout.write("add list remove\\n"); process.exit(0); }
if (args[1] === "marketplace" && args[2] === "list") {
  if (!existsSync(process.env.CODEX_HOME)) process.exit(6);
  emit({ marketplaces: state.marketplace ? [{ name: "penumbra-local", root: state.root, marketplaceSource: { sourceType: "local", source: state.root } }] : [] }); process.exit(0);
}
if (args[1] === "marketplace" && args[2] === "add") {
  if (state.marketplace) { emit({ marketplaceName: "penumbra-local", installedRoot: state.root, alreadyAdded: true }); process.exit(0); }
  state.marketplace = true; state.root = args[3]; save();
  emit({ marketplaceName: "penumbra-local", installedRoot: state.root, alreadyAdded: false }); process.exit(0);
}
if (args[1] === "list") {
  if (!state.marketplace) process.exit(4);
  if (state.unknown && installedFromConfig()) { process.stdout.write("{malformed\\n"); process.exit(0); }
  const installed = installedFromConfig() ? [{ pluginId: "penumbra@penumbra-local", name: "penumbra", marketplaceName: "penumbra-local", version: "0.1.0", installed: true, enabled: true, source: { source: "local", path: state.root + "/penumbra" }, marketplaceSource: { sourceType: "local", source: state.root }, installPolicy: "AVAILABLE", authPolicy: "ON_INSTALL" }] : [];
  emit({ installed, available: [] }); process.exit(0);
}
if (args[1] === "add") {
  if (!installedFromConfig()) appendConfig(registration);
  if (state.tamperManagedMcpOnAdd) writeConfig(readConfig().replace(/command = "[^"]*"/, 'command = "/host/changed"'));
  state.installed = true; save();
  emit({ pluginId: "penumbra@penumbra-local", name: "penumbra", marketplaceName: "penumbra-local", version: "0.1.0", installedPath: process.env.CODEX_HOME + "/plugins/cache/penumbra-local/penumbra/0.1.0", authPolicy: "ON_INSTALL" }); process.exit(0);
}
if (args[1] === "remove") {
  writeConfig(readConfig().replace(registration, ""));
  state.installed = false; save();
  emit({ pluginId: "penumbra@penumbra-local", name: "penumbra", marketplaceName: "penumbra-local" }); process.exit(0);
}
if (args[1] === "marketplace" && args[2] === "remove") {
  state.marketplace = false; save();
  appendConfig("[host_cleanup]\\npreserved = true\\n");
  emit({ marketplaceName: "penumbra-local", installedRoot: null }); process.exit(0);
}
process.exit(91);
`,
  );
  chmodSync(executable, 0o700);
  return {
    root,
    codexDir: join(root, "explicit codex home '$`"),
    executable,
    logPath,
    statePath,
  };
}

async function runRawCli(fixture: Fixture, args: string[]): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    env: {
      PATH: `${join(fixture.root, "bin")}:${process.env.PATH ?? ""}`,
      HOME: join(fixture.root, "controlled home"),
      CODEX_HOME: join(fixture.root, "wrong env codex home"),
      XDG_CONFIG_HOME: join(fixture.root, "controlled xdg"),
      AGENTCHAT_CONFIG: join(fixture.root, "agentchat.yaml"),
      PENUMBRA_STORAGE_ROOT: join(fixture.root, "storage"),
      PENUMBRA_CLAUDE_USER_DIR: join(fixture.root, "claude"),
      FAKE_CODEX_LOG: fixture.logPath,
      FAKE_CODEX_STATE: fixture.statePath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exit = await child.exited;
  const [stdout, stderr] = await output;
  return { exit, stdout, stderr };
}

async function runCli(fixture: Fixture, action: string): Promise<CliResult> {
  return await runRawCli(fixture, [
    "codex-setup",
    action,
    "--mode",
    "plugin",
    "--codex-dir",
    fixture.codexDir,
    "--skills-dir",
    join(fixture.root, "skills"),
    "--json",
  ]);
}

function calls(fixture: Fixture): { args: string[]; codexHome: string }[] {
  if (!existsSync(fixture.logPath)) return [];
  return readFileSync(fixture.logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; codexHome: string });
}

function removeFakePluginRegistration(content: string): string {
  return content.replace(FAKE_PLUGIN_REGISTRATION, "");
}

test("real CLI plugin mode installs, repairs, reports, and uninstalls through the executable host", async () => {
  const fixture = makeFixture();
  try {
    const configPath = join(fixture.codexDir, "config.toml");
    const userConfig = 'model = "user-choice"\n\n[unrelated]\nkeep = true\n';
    mkdirSync(fixture.codexDir, { recursive: true });
    writeFileSync(configPath, userConfig);
    const installed = await runCli(fixture, "install");
    expect(installed.exit).toBe(0);
    expect(JSON.parse(installed.stdout) as SetupReport).toMatchObject({
      ok: true,
      changed: true,
      mode: "plugin",
      components: { skills: { state: "installed" } },
    });
    const ownershipPath = join(fixture.codexDir, "penumbra", "installation.json");
    const ownership = JSON.parse(readFileSync(ownershipPath, "utf8")) as OwnershipManifest;
    expect(ownership.plugin).toMatchObject({
      identifier: "penumbra@penumbra-local",
      marketplaceName: "penumbra-local",
      marketplaceOwned: true,
      pluginOwned: true,
    });
    expect(calls(fixture).every(({ codexHome }) => codexHome === fixture.codexDir)).toBe(true);
    expect(readFileSync(configPath, "utf8")).toContain("# fake codex: plugin registration");

    const status = await runCli(fixture, "status");
    expect(status.exit).toBe(0);
    expect((JSON.parse(status.stdout) as SetupReport).components.skills.state).toBe("installed");

    const beforeRepair = readFileSync(configPath, "utf8");
    const repaired = await runCli(fixture, "repair");
    expect(repaired.exit).toBe(0);
    expect((JSON.parse(repaired.stdout) as SetupReport).changed).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(beforeRepair);

    writeFileSync(configPath, removeFakePluginRegistration(beforeRepair));
    const absent = await runCli(fixture, "status");
    expect((JSON.parse(absent.stdout) as SetupReport).components.skills.state).toBe("absent");
    const restored = await runCli(fixture, "repair");
    expect(restored.exit).toBe(0);
    expect((JSON.parse(restored.stdout) as SetupReport).changed).toBe(true);
    expect(readFileSync(configPath, "utf8")).toContain(FAKE_PLUGIN_REGISTRATION);

    const removed = await runCli(fixture, "uninstall");
    expect(removed.exit).toBe(0);
    expect((JSON.parse(removed.stdout) as SetupReport).components.skills.state).toBe("absent");
    expect(existsSync(ownershipPath)).toBe(false);
    expect(JSON.parse(readFileSync(fixture.statePath, "utf8")) as FakeState).toMatchObject({
      marketplace: false,
      installed: false,
    });
    const finalConfig = readFileSync(configPath, "utf8");
    expect(finalConfig.startsWith(userConfig)).toBe(true);
    expect(finalConfig).not.toContain("# fake codex: plugin registration");
    expect(finalConfig).not.toContain("[mcp_servers.penumbra]");
    expect(finalConfig).toContain("[host_cleanup]\npreserved = true\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("unknown plugin status never triggers repair mutation", async () => {
  const fixture = makeFixture();
  try {
    expect((await runCli(fixture, "install")).exit).toBe(0);
    const state = JSON.parse(readFileSync(fixture.statePath, "utf8")) as FakeState;
    state.unknown = true;
    writeFileSync(fixture.statePath, JSON.stringify(state));
    const beforeAdds = calls(fixture).filter(({ args }) => args[1] === "add").length;

    const repaired = await runCli(fixture, "repair");

    expect(repaired.exit).not.toBe(0);
    expect(calls(fixture).filter(({ args }) => args[1] === "add")).toHaveLength(beforeAdds);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a fresh post-registration ambiguity records only marketplace ownership", async () => {
  const fixture = makeFixture();
  try {
    writeFileSync(
      fixture.statePath,
      JSON.stringify({ marketplace: false, installed: false, root: null, unknown: true }),
    );
    const failed = await runCli(fixture, "install");
    expect(failed.exit).not.toBe(0);
    expect(JSON.parse(failed.stdout) as SetupReport).toMatchObject({ ok: false, changed: true });
    const ownershipPath = join(fixture.codexDir, "penumbra", "installation.json");
    expect(JSON.parse(readFileSync(ownershipPath, "utf8")) as OwnershipManifest).toMatchObject({
      plugin: {
        identifier: "penumbra@penumbra-local",
        marketplaceOwned: true,
        pluginOwned: false,
      },
    });
    const configPath = join(fixture.codexDir, "config.toml");
    expect(readFileSync(configPath, "utf8")).toContain("# fake codex: plugin registration");

    const state = JSON.parse(readFileSync(fixture.statePath, "utf8")) as FakeState;
    state.unknown = false;
    state.installed = false;
    writeFileSync(fixture.statePath, JSON.stringify(state));
    writeFileSync(configPath, removeFakePluginRegistration(readFileSync(configPath, "utf8")));
    expect((await runCli(fixture, "uninstall")).exit).toBe(0);
    expect(existsSync(ownershipPath)).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("plugin repair rejects a managed MCP change written by the host and reports residual mutation", async () => {
  const fixture = makeFixture();
  try {
    expect((await runCli(fixture, "install")).exit).toBe(0);
    const configPath = join(fixture.codexDir, "config.toml");
    const installedConfig = readFileSync(configPath, "utf8");

    writeFileSync(configPath, installedConfig.replace(process.execPath, "/user/changed"));
    const addsBeforePreflight = calls(fixture).filter(({ args }) => args[1] === "add").length;
    const preflightConflict = await runCli(fixture, "repair");
    expect(preflightConflict.exit).not.toBe(0);
    expect(calls(fixture).filter(({ args }) => args[1] === "add")).toHaveLength(
      addsBeforePreflight,
    );

    writeFileSync(configPath, removeFakePluginRegistration(installedConfig));
    const state = JSON.parse(readFileSync(fixture.statePath, "utf8")) as FakeState;
    state.tamperManagedMcpOnAdd = true;
    writeFileSync(fixture.statePath, JSON.stringify(state));

    const postHostConflict = await runCli(fixture, "repair");

    expect(postHostConflict.exit).not.toBe(0);
    expect(JSON.parse(postHostConflict.stdout) as SetupReport).toMatchObject({
      ok: false,
      changed: true,
      components: { mcp: { state: "conflict" } },
    });
    expect(readFileSync(configPath, "utf8")).toContain('command = "/host/changed"');
    expect(readFileSync(configPath, "utf8")).toContain(FAKE_PLUGIN_REGISTRATION);
    expect(existsSync(join(fixture.codexDir, "penumbra", "installation.json"))).toBe(true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("plugin status on an absent profile is read-only and does not create a Codex home", async () => {
  const fixture = makeFixture();
  try {
    const status = await runCli(fixture, "status");
    expect(status.exit).toBe(0);
    const report = JSON.parse(status.stdout) as SetupReport;
    expect(report.changed).toBe(false);
    expect(report.components.skills.state).toBe("unknown");
    expect(existsSync(fixture.codexDir)).toBe(false);
    expect(existsSync(join(fixture.root, "wrong env codex home"))).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a symlinked explicit Codex profile is rejected before the executable is spawned", async () => {
  const fixture = makeFixture();
  try {
    const actual = join(fixture.root, "actual codex home");
    mkdirSync(actual);
    symlinkSync(actual, fixture.codexDir);
    const result = await runCli(fixture, "install");
    expect(result.exit).not.toBe(0);
    expect(calls(fixture)).toEqual([]);
    expect(existsSync(join(actual, "config.toml"))).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("explicit Codex init wires the same plugin host after validating its arguments", async () => {
  const fixture = makeFixture();
  try {
    const initialized = await runRawCli(fixture, [
      "init",
      "--harness",
      "codex",
      "--codex-mode",
      "plugin",
      "--codex-dir",
      fixture.codexDir,
      "--skills-dir",
      join(fixture.root, "skills"),
    ]);
    expect(initialized.exit).toBe(0);
    expect(existsSync(join(fixture.codexDir, "penumbra", "installation.json"))).toBe(true);
    expect(existsSync(join(fixture.root, "storage", "token"))).toBe(true);

    rmSync(fixture.logPath);
    const invalid = await runRawCli(fixture, [
      "init",
      "--harness",
      "codex",
      "--codex-mode",
      "invalid",
      "--codex-dir",
      join(fixture.root, "unused"),
    ]);
    expect(invalid.exit).not.toBe(0);
    expect(existsSync(fixture.logPath)).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
