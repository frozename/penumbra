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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCodexPluginHost } from "@src/commands/codex-plugin-host.js";
import type { CodexSetupHost } from "@src/commands/codex-setup.js";

// #285: each scenario below spawns the fake codex (a bun script) about 11 times. That ran
// close to bun's 5 s per-test default under load, and the 1 s per-invoke bound that every
// install and rollback call shares could run out mid-rollback.
const SCENARIO_TEST_TIMEOUT_MS = 20_000;
// Per-invoke bound for the install-and-rollback scenarios (the host caps it at 15 s).
const ROLLBACK_INVOKE_TIMEOUT_MS = 10_000;
// Per-call delay in the slow-codex pin: 8 calls take at least 1.6 s, past the old 1 s bound.
const SLOW_CODEX_DELAY_MS = 200;

interface Fixture {
  root: string;
  codexDir: string;
  marketplaceRoot: string;
  pluginRoot: string;
  executable: string;
  logPath: string;
  statePath: string;
  env: NodeJS.ProcessEnv;
}

function makeFixture(prefix = "codex plugin host "): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const codexDir = join(root, "codex home '$`");
  const marketplaceRoot = join(root, "marketplace root '$`");
  const pluginRoot = join(marketplaceRoot, "penumbra");
  const binDir = join(root, "bin");
  const executable = join(binDir, "codex");
  const logPath = join(root, "argv.jsonl");
  const statePath = join(root, "state.json");
  mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
  mkdirSync(join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  mkdirSync(join(marketplaceRoot, "personal"));
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({ name: "penumbra", version: "0.1.0" })}\n`,
  );
  writeFileSync(
    join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    `${JSON.stringify({
      name: "penumbra-local",
      plugins: [
        {
          name: "penumbra",
          source: { source: "local", path: "./penumbra" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    })}\n`,
  );
  writeFileSync(
    executable,
    `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const scenario = process.env.FAKE_CODEX_SCENARIO ?? "normal";
const statePath = process.env.FAKE_CODEX_STATE;
const logPath = process.env.FAKE_CODEX_LOG;
const root = process.env.FAKE_MARKETPLACE_ROOT;
const codexHome = process.env.CODEX_HOME;
if (!statePath || !logPath || !root || !codexHome) process.exit(91);
appendFileSync(logPath, JSON.stringify({ args, codexHome }) + "\\n");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { marketplace: false, installed: false };
const save = () => writeFileSync(statePath, JSON.stringify(state));
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const missingProfileWarning = 'WARNING: proceeding, even though we could not create PATH aliases: CODEX_HOME points to "' + codexHome + '", but that path does not exist\\n';
const emitQualificationWarning = () => {
  if (scenario === "qualification-warning") process.stderr.write(missingProfileWarning);
  if (scenario === "qualification-warning-extra") process.stderr.write(missingProfileWarning + "unexpected stderr\\n");
  if (scenario === "qualification-warning-malformed") process.stderr.write("WARNING: proceeding because CODEX_HOME is absent: " + codexHome + "\\n");
  if (scenario === "qualification-warning-foreign") process.stderr.write(missingProfileWarning.replace(codexHome, codexHome + "-foreign"));
};
if (args[0] === "--version") {
  if (scenario === "qualification-profile-swap") symlinkSync(codexHome + " target", codexHome);
  if (scenario === "hang") await new Promise(() => {});
  if (scenario === "flood") process.stdout.write("x".repeat(4096));
  else {
    process.stdout.write(scenario === "unknown-version" ? "codex-cli 0.154.0\\n" : "codex-cli 0.153.4\\n");
    emitQualificationWarning();
    if (scenario === "version-extra-output") process.stdout.write("\\n");
  }
  process.exit(0);
}
if (args.join(" ") === "plugin --help") {
  process.stdout.write("Usage: codex plugin <add|list|remove|marketplace>\\n"); emitQualificationWarning(); process.exit(0);
}
if (args.join(" ") === "plugin marketplace --help") {
  process.stdout.write("Usage: codex plugin marketplace <add|list|remove>\\n"); emitQualificationWarning(); process.exit(0);
}
if (args[0] !== "plugin") process.exit(92);
const delayMs = Number(process.env.FAKE_CODEX_DELAY_MS ?? "0");
if (delayMs > 0) await Bun.sleep(delayMs);
if (args[1] === "marketplace" && args[2] === "list") {
  if (!existsSync(codexHome)) process.exit(6);
  if (scenario === "marketplace-list-hang") await new Promise(() => {});
  if (scenario === "marketplace-list-failed") process.exit(5);
  if (scenario === "marketplace-list-malformed") { process.stdout.write("{malformed\\n"); process.exit(0); }
  let marketplaces = [];
  if (scenario === "unrelated-marketplace") {
    const personalRoot = root + "/personal";
    marketplaces = [{ name: "personal", root: personalRoot, marketplaceSource: { sourceType: "local", source: personalRoot } }];
  }
  if (["preexisting-marketplace", "marketplace-list-foreign", "marketplace-list-duplicate"].includes(scenario)) {
    const listedRoot = scenario === "marketplace-list-foreign" ? root + "/foreign" : root;
    marketplaces = [{ name: "penumbra-local", root: listedRoot, marketplaceSource: { sourceType: "local", source: listedRoot } }];
    if (scenario === "marketplace-list-duplicate") marketplaces.push({ ...marketplaces[0] });
  }
  emit({ marketplaces }); process.exit(0);
}
if (args[1] === "marketplace" && args[2] === "add") {
  if (scenario === "preexisting-marketplace") { emit({ marketplaceName: "penumbra-local", installedRoot: root, alreadyAdded: true }); process.exit(0); }
  state.marketplace = true; if (scenario === "preexisting-plugin") state.installed = true; save();
  emit({ marketplaceName: "penumbra-local", installedRoot: root, alreadyAdded: false }); process.exit(0);
}
if (args[1] === "list") {
  if (!state.marketplace) process.exit(4);
  if (scenario === "post-add-list-hang" && state.installed) await new Promise(() => {});
  let installed = state.installed ? [{
    pluginId: "penumbra@penumbra-local", name: "penumbra", marketplaceName: "penumbra-local",
    version: "0.1.0", installed: true, enabled: true,
    source: { source: "local", path: root + "/penumbra" },
    marketplaceSource: { sourceType: "local", source: root },
    installPolicy: "AVAILABLE", authPolicy: "ON_INSTALL"
  }] : [];
  if (scenario === "disabled" && installed[0]) installed[0].enabled = false;
  if (scenario === "foreign-source" && installed[0]) installed[0].source.path = root + "/foreign";
  if (scenario === "wrong-id" && installed[0]) installed[0].pluginId = "other@penumbra-local";
  if (scenario === "missing-installed-field" && installed[0]) delete installed[0].installed;
  if (scenario === "duplicate" && installed[0]) installed.push({ ...installed[0] });
  if (scenario === "list-missing-after-add" && state.installed) installed = [];
  if (scenario === "malformed-list" || (scenario === "post-add-malformed-list" && state.installed)) { process.stdout.write("{malformed\\n"); process.exit(0); }
  emit({ installed, available: [] }); process.exit(0);
}
if (args[1] === "add") {
  state.installed = true; save();
  emit({ pluginId: scenario === "malformed-add" ? "wrong" : "penumbra@penumbra-local", name: "penumbra", marketplaceName: "penumbra-local", version: "0.1.0", installedPath: codexHome + "/plugins/cache/penumbra-local/penumbra/0.1.0", authPolicy: "ON_INSTALL" }); process.exit(0);
}
if (args[1] === "remove") {
  if (scenario !== "remove-unconfirmed") state.installed = false; save();
  emit({ pluginId: "penumbra@penumbra-local", name: "penumbra", marketplaceName: "penumbra-local" }); process.exit(0);
}
if (args[1] === "marketplace" && args[2] === "remove") {
  state.marketplace = false; save();
  emit({ marketplaceName: "penumbra-local", installedRoot: null }); process.exit(0);
}
process.exit(93);
`,
  );
  chmodSync(executable, 0o700);
  return {
    root,
    codexDir,
    marketplaceRoot,
    pluginRoot,
    executable,
    logPath,
    statePath,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: join(root, "controlled home"),
      XDG_CONFIG_HOME: join(root, "controlled xdg"),
      FAKE_CODEX_LOG: logPath,
      FAKE_CODEX_STATE: statePath,
      FAKE_MARKETPLACE_ROOT: marketplaceRoot,
    },
  };
}

function calls(fixture: Fixture): { args: string[]; codexHome: string }[] {
  if (!existsSync(fixture.logPath)) return [];
  return readFileSync(fixture.logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; codexHome: string });
}

async function host(
  fixture: Fixture,
  scenario = "normal",
  timeoutMs = 1_000,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CodexSetupHost> {
  return await createCodexPluginHost({
    codexDir: fixture.codexDir,
    marketplaceRoot: fixture.marketplaceRoot,
    pluginRoot: fixture.pluginRoot,
    executable: fixture.executable,
    env: { ...fixture.env, FAKE_CODEX_SCENARIO: scenario, ...extraEnv },
    timeoutMs,
    maxOutputBytes: 1_024,
  });
}

test("qualified 0.153.4 host installs, confirms, and removes the bundled local plugin", async () => {
  const fixture = makeFixture();
  try {
    const adapter = await host(fixture);
    expect(adapter.plugin.state, adapter.plugin.detail).toBe("supported");
    const installed = await adapter.invoke(adapter.plugin.installArgv ?? []);
    expect(installed.ok).toBe(true);
    expect(installed.installed).toBe(true);
    expect(installed.ownership).toEqual({
      identifier: "penumbra@penumbra-local",
      marketplaceName: "penumbra-local",
      marketplaceRoot: fixture.marketplaceRoot,
      pluginRoot: fixture.pluginRoot,
      marketplaceOwned: true,
      pluginOwned: true,
    });
    const status = await adapter.invoke(adapter.plugin.statusArgv ?? [], installed.ownership);
    expect(status).toMatchObject({ ok: true, installed: true });
    const removed = await adapter.invoke(adapter.plugin.uninstallArgv ?? [], installed.ownership);
    expect(removed).toMatchObject({ ok: true, installed: false });
    expect(JSON.parse(readFileSync(fixture.statePath, "utf8"))).toEqual({
      marketplace: false,
      installed: false,
    });
    expect(calls(fixture).map(({ args }) => args)).toEqual([
      ["--version"],
      ["plugin", "--help"],
      ["plugin", "marketplace", "--help"],
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "add", fixture.marketplaceRoot, "--json"],
      ["plugin", "list", "--marketplace", "penumbra-local", "--json"],
      ["plugin", "add", "penumbra@penumbra-local", "--json"],
      ["plugin", "list", "--marketplace", "penumbra-local", "--json"],
      ["plugin", "list", "--marketplace", "penumbra-local", "--json"],
      ["plugin", "list", "--marketplace", "penumbra-local", "--json"],
      ["plugin", "remove", "penumbra@penumbra-local", "--json"],
      ["plugin", "list", "--marketplace", "penumbra-local", "--json"],
      ["plugin", "marketplace", "remove", "penumbra-local", "--json"],
    ]);
    expect(new Set(calls(fixture).map(({ codexHome }) => codexHome))).toEqual(
      new Set([fixture.codexDir]),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("first install qualifies with the exact missing-profile warning on every help command", async () => {
  const fixture = makeFixture("codex-host-qualification-warning-");
  try {
    const adapter = await host(fixture, "qualification-warning");
    expect(adapter.plugin.state, adapter.plugin.detail).toBe("supported");
    expect(existsSync(fixture.codexDir)).toBe(false);
    const installed = await adapter.invoke(adapter.plugin.installArgv ?? []);
    expect(installed).toMatchObject({ ok: true, installed: true });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("qualification rejects malformed, extra, and foreign-profile warnings", async () => {
  for (const scenario of [
    "qualification-warning-malformed",
    "qualification-warning-extra",
    "qualification-warning-foreign",
  ]) {
    const fixture = makeFixture(`codex-host-${scenario}-`);
    try {
      const adapter = await host(fixture, scenario);
      expect(adapter.plugin.state, scenario).not.toBe("supported");
      expect(
        calls(fixture).map(({ args }) => args),
        scenario,
      ).toEqual([["--version"]]);
      expect(existsSync(fixture.codexDir), scenario).toBe(false);
      expect(existsSync(fixture.statePath), scenario).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("operational plugin-list failure on a missing profile remains unknown", async () => {
  const fixture = makeFixture("codex-host-missing-profile-status-");
  try {
    const adapter = await host(fixture, "qualification-warning");
    expect(adapter.plugin.state, adapter.plugin.detail).toBe("supported");
    const status = await adapter.invoke(adapter.plugin.statusArgv ?? []);
    expect(status).toEqual({
      ok: false,
      detail: "plugin list did not prove an installed or absent state",
    });
    expect(existsSync(fixture.codexDir)).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a symlinked Codex profile is rejected before any child process starts", async () => {
  const fixture = makeFixture("codex-host-symlink-profile-");
  try {
    const actual = join(fixture.root, "actual codex home");
    mkdirSync(actual);
    symlinkSync(actual, fixture.codexDir);
    const adapter = await host(fixture);
    expect(adapter.plugin.state).not.toBe("supported");
    expect(calls(fixture)).toEqual([]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a profile swapped to a symlink by version qualification blocks help subprocesses", async () => {
  const fixture = makeFixture("codex-host-qualification-profile-swap-");
  try {
    mkdirSync(`${fixture.codexDir} target`);
    const adapter = await host(fixture, "qualification-profile-swap");
    expect(calls(fixture).map(({ args }) => args)).toEqual([["--version"]]);
    expect(adapter.plugin.state).not.toBe("supported");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a profile swapped to a symlink after qualification blocks the next subprocess", async () => {
  const fixture = makeFixture("codex-host-profile-swap-");
  try {
    const adapter = await host(fixture);
    expect(adapter.plugin.state).toBe("supported");
    const actual = join(fixture.root, "actual codex home");
    mkdirSync(actual);
    symlinkSync(actual, fixture.codexDir);
    const result = await adapter.invoke(adapter.plugin.statusArgv ?? []);
    expect(result.ok).toBe(false);
    expect(calls(fixture)).toHaveLength(3);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("nonnormalized and non-directory Codex profile ancestors are rejected before spawn", async () => {
  for (const mutate of [
    (fixture: Fixture): void => {
      fixture.codexDir = `${fixture.root}/missing/../codex`;
    },
    (fixture: Fixture): void => {
      const blocked = join(fixture.root, "blocked ancestor");
      writeFileSync(blocked, "not a directory\n");
      fixture.codexDir = join(blocked, "codex");
    },
  ]) {
    const fixture = makeFixture("codex-host-invalid-profile-");
    try {
      mutate(fixture);
      const adapter = await host(fixture);
      expect(adapter.plugin.state).not.toBe("supported");
      expect(calls(fixture)).toEqual([]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("unknown builds, output floods, and hanging children stay bounded and never mutate", async () => {
  for (const [scenario, timeoutMs] of [
    ["unknown-version", 1_000],
    ["version-extra-output", 1_000],
    ["flood", 1_000],
    ["hang", 50],
  ] as const) {
    const fixture = makeFixture(`codex-host-${scenario}-`);
    try {
      const adapter = await host(fixture, scenario, timeoutMs);
      expect(adapter.plugin.state).not.toBe("supported");
      expect(existsSync(fixture.statePath)).toBe(false);
      expect(calls(fixture).every(({ codexHome }) => codexHome === fixture.codexDir)).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test.each([
  "disabled",
  "foreign-source",
  "wrong-id",
  "missing-installed-field",
  "duplicate",
  "list-missing-after-add",
  "malformed-list",
  "malformed-add",
])(
  "ambiguous installed entries never confirm usable state (%s)",
  async (scenario) => {
    const fixture = makeFixture(`codex-host-${scenario}-`);
    try {
      const adapter = await host(fixture, scenario, ROLLBACK_INVOKE_TIMEOUT_MS);
      const result = await adapter.invoke(adapter.plugin.installArgv ?? []);
      expect(result.ok).toBe(false);
      expect(result.installed).not.toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  SCENARIO_TEST_TIMEOUT_MS,
);

test.each([
  ["disabled", { marketplace: false, installed: false }],
  ["missing-installed-field", { marketplace: false, installed: false }],
  ["list-missing-after-add", { marketplace: false, installed: true }],
  ["malformed-add", { marketplace: false, installed: false }],
  ["foreign-source", { marketplace: true, installed: true }],
  ["wrong-id", { marketplace: true, installed: true }],
  ["duplicate", { marketplace: true, installed: true }],
  ["preexisting-plugin", { marketplace: true, installed: true }],
] as const)(
  "rollback removes only newly owned exact state and preserves ambiguous or preexisting state (%s)",
  async (scenario, expected) => {
    const fixture = makeFixture(`codex-host-rollback-${scenario}-`);
    try {
      const adapter = await host(fixture, scenario, ROLLBACK_INVOKE_TIMEOUT_MS);
      const result = await adapter.invoke(adapter.plugin.installArgv ?? []);
      expect(result.ok).toBe(false);
      expect(JSON.parse(readFileSync(fixture.statePath, "utf8")), scenario).toEqual(expected);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  SCENARIO_TEST_TIMEOUT_MS,
);

test(
  "rollback under a slow codex still finishes inside the per-invoke bound",
  async () => {
    const fixture = makeFixture("codex-host-rollback-slow-");
    try {
      const adapter = await host(fixture, "disabled", ROLLBACK_INVOKE_TIMEOUT_MS, {
        FAKE_CODEX_DELAY_MS: String(SLOW_CODEX_DELAY_MS),
      });
      expect(adapter.plugin.state, adapter.plugin.detail).toBe("supported");
      const result = await adapter.invoke(adapter.plugin.installArgv ?? []);
      expect(result.ok).toBe(false);
      const state: unknown = existsSync(fixture.statePath)
        ? JSON.parse(readFileSync(fixture.statePath, "utf8"))
        : null;
      expect(state).toEqual({ marketplace: false, installed: false });
      expect(result.ownership).toBeUndefined();
      expect(
        calls(fixture)
          .map(({ args }) => args)
          .slice(3),
      ).toEqual([
        ["plugin", "marketplace", "list", "--json"],
        ["plugin", "marketplace", "add", fixture.marketplaceRoot, "--json"],
        ["plugin", "list", "--marketplace", "penumbra-local", "--json"],
        ["plugin", "add", "penumbra@penumbra-local", "--json"],
        ["plugin", "list", "--marketplace", "penumbra-local", "--json"],
        ["plugin", "remove", "penumbra@penumbra-local", "--json"],
        ["plugin", "list", "--marketplace", "penumbra-local", "--json"],
        ["plugin", "marketplace", "remove", "penumbra-local", "--json"],
      ]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  SCENARIO_TEST_TIMEOUT_MS,
);

test("uninstall keeps the owned marketplace when plugin absence is not confirmed", async () => {
  const fixture = makeFixture("codex-host-remove-unconfirmed-");
  try {
    const adapter = await host(fixture, "normal");
    const installed = await adapter.invoke(adapter.plugin.installArgv ?? []);
    const unconfirmed = await host(fixture, "remove-unconfirmed");
    const result = await unconfirmed.invoke(
      unconfirmed.plugin.uninstallArgv ?? [],
      installed.ownership,
    );
    expect(result.ok).toBe(false);
    expect(JSON.parse(readFileSync(fixture.statePath, "utf8"))).toEqual({
      marketplace: true,
      installed: true,
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("uninstall refuses to mutate without exact persisted marketplace ownership", async () => {
  const fixture = makeFixture("codex-host-missing-ownership-");
  try {
    const adapter = await host(fixture);
    const installed = await adapter.invoke(adapter.plugin.installArgv ?? []);
    expect(installed.installed).toBe(true);
    const result = await adapter.invoke(adapter.plugin.uninstallArgv ?? []);
    expect(result.ok).toBe(false);
    expect(JSON.parse(readFileSync(fixture.statePath, "utf8"))).toEqual({
      marketplace: true,
      installed: true,
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("invalid or symlinked bundle identity is unavailable before invoking Codex", async () => {
  for (const mutate of [
    (fixture: Fixture): void => {
      writeFileSync(
        join(fixture.marketplaceRoot, ".agents", "plugins", "marketplace.json"),
        JSON.stringify({ name: "foreign", plugins: [] }),
      );
    },
    (fixture: Fixture): void => {
      writeFileSync(
        join(fixture.pluginRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "other", version: "0.1.0" }),
      );
    },
    (fixture: Fixture): void => {
      const manifest = join(fixture.marketplaceRoot, ".agents", "plugins", "marketplace.json");
      const target = join(fixture.root, "outside-marketplace.json");
      writeFileSync(target, readFileSync(manifest));
      unlinkSync(manifest);
      symlinkSync(target, manifest);
    },
  ]) {
    const fixture = makeFixture("codex-host-invalid-bundle-");
    try {
      mutate(fixture);
      const adapter = await host(fixture);
      expect(adapter.plugin.state).toBe("unavailable");
      expect(calls(fixture)).toEqual([]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("an already registered marketplace is a conflict and is never claimed or removed", async () => {
  const fixture = makeFixture("codex-host-preexisting-");
  try {
    const adapter = await host(fixture, "preexisting-marketplace");
    const result = await adapter.invoke(adapter.plugin.installArgv ?? []);
    expect(result).toMatchObject({ ok: false });
    expect(result.installed).not.toBe(true);
    expect(
      calls(fixture)
        .map(({ args }) => args)
        .slice(3),
    ).toEqual([["plugin", "marketplace", "list", "--json"]]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a complete unrelated local marketplace inventory does not block installation", async () => {
  const fixture = makeFixture("codex-host-unrelated-marketplace-");
  try {
    const adapter = await host(fixture, "unrelated-marketplace");
    const result = await adapter.invoke(adapter.plugin.installArgv ?? []);
    expect(result).toMatchObject({ ok: true, installed: true });
    expect(
      calls(fixture)
        .map(({ args }) => args)
        .slice(3, 5),
    ).toEqual([
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "add", fixture.marketplaceRoot, "--json"],
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("unknown, malformed, duplicate, and foreign marketplace inventory never mutates", async () => {
  for (const scenario of [
    "marketplace-list-failed",
    "marketplace-list-hang",
    "marketplace-list-malformed",
    "marketplace-list-duplicate",
    "marketplace-list-foreign",
  ]) {
    const fixture = makeFixture(`codex-host-inventory-${scenario}-`);
    try {
      const adapter = await host(
        fixture,
        scenario,
        scenario === "marketplace-list-hang" ? 300 : 1_000,
      );
      const result = await adapter.invoke(adapter.plugin.installArgv ?? []);
      expect(result.ok, scenario).toBe(false);
      expect(
        calls(fixture)
          .map(({ args }) => args)
          .slice(3),
        scenario,
      ).toEqual([["plugin", "marketplace", "list", "--json"]]);
      expect(existsSync(fixture.statePath), scenario).toBe(false);
      expect(existsSync(fixture.codexDir), scenario).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("ambiguous post-add status never grants full plugin ownership", async () => {
  for (const scenario of [
    "post-add-list-hang",
    "post-add-malformed-list",
    "disabled",
    "foreign-source",
  ]) {
    const fixture = makeFixture(`codex-host-post-add-${scenario}-`);
    try {
      const adapter = await host(
        fixture,
        scenario,
        scenario === "post-add-list-hang" ? 300 : 1_000,
      );
      const result = await adapter.invoke(adapter.plugin.installArgv ?? []);
      expect(result.ok, scenario).toBe(false);
      expect(result.installed, scenario).not.toBe(true);
      expect(result.ownership?.pluginOwned, scenario).not.toBe(true);
      if (["post-add-list-hang", "post-add-malformed-list", "foreign-source"].includes(scenario)) {
        expect(
          calls(fixture).map(({ args }) => args),
          scenario,
        ).not.toContainEqual(["plugin", "remove", "penumbra@penumbra-local", "--json"]);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});
