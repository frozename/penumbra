import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CodexSetupHost,
  type CodexSetupOptions,
  runCodexSetup,
} from "@src/commands/codex-setup.js";

const BUILD = "0.153.4";
const CLI_PATH = fileURLToPath(new URL("../../bin/penumbra.ts", import.meta.url));
const MCP_ENTRYPOINT = fileURLToPath(new URL("../../../mcp/bin/penumbra-mcp.ts", import.meta.url));
const PACKAGED_DIR = fileURLToPath(new URL("../../../../plugin/codex/penumbra", import.meta.url));
const PACKAGED_GUARD = join(PACKAGED_DIR, "hooks", "penumbra-agent-gc-guard.sh");

type HookGroup = {
  matcher?: string;
  hooks: { type: string; command: string; timeout: number }[];
};

type Manifest = {
  safety?: { guardPath: string; guardHash: string; sentinelPath: string };
  hooks?: { commandPrefix: string; commandPrefixes?: string[] };
};

type CliResult = { exit: number; stdout: string; stderr: string };

type Fixture = {
  root: string;
  codexDir: string;
  storageRoot: string;
  opts: CodexSetupOptions;
};

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function hookInput(toolName: "Bash" | "exec_command" | "apply_patch"): Record<string, unknown> {
  return {
    session_id: "probe-root",
    transcript_path: null,
    cwd: "/private/tmp/probe project",
    hook_event_name: "PreToolUse",
    model: "gpt-5.6-sol",
    permission_mode: "default",
    turn_id: `turn-${toolName}`,
    tool_name: toolName,
    tool_use_id: `tool-${toolName}`,
    tool_input:
      toolName === "Bash"
        ? { command: "git status" }
        : toolName === "exec_command"
          ? { cmd: "git status" }
          : { patch: "*** Begin Patch" },
  };
}

function capabilityCase(
  toolName: "Bash" | "exec_command" | "apply_patch",
  scenario: "bash" | "exec_command" | "apply_patch",
  supported: boolean,
): Record<string, unknown> {
  const input = hookInput(toolName);
  return {
    fixture: {
      surface: "cli",
      build: BUILD,
      capability: "PreToolUse",
      state: supported ? "supported" : "unknown",
      evidence: {
        kind: supported ? "live" : "contract",
        surface: "cli",
        source: "isolated-codex-capability-probe",
        observedAt: "2026-09-12T12:00:00.000Z",
        probeId: supported ? `isolated-cli-PreToolUse-${scenario}` : null,
      },
      ...(supported
        ? {
            input,
            identity: {
              role: "root",
              sessionId: input.session_id,
              projectCwd: input.cwd,
              agentId: null,
            },
          }
        : {}),
    },
    reason: supported ? null : "unobserved",
    scenario,
  };
}

function qualifiedReport(): Record<string, unknown> {
  return {
    surface: "cli",
    build: BUILD,
    cases: [
      capabilityCase("Bash", "bash", true),
      capabilityCase("exec_command", "exec_command", true),
      capabilityCase("apply_patch", "apply_patch", false),
      {
        ...capabilityCase("exec_command", "exec_command", false),
        scenario: "code_mode",
      },
    ],
    cleanupComplete: true,
  };
}

function makeFixture(prefix = "codex safety setup ", packageDir = PACKAGED_DIR): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const codexDir = join(root, "Codex Profile");
  const storageRoot = join(root, "custom storage root");
  return {
    root,
    codexDir,
    storageRoot,
    opts: {
      action: "install",
      mode: "standalone",
      codexDir,
      skillsDir: join(root, "Agent Skills"),
      packageDir,
      storageRoot,
      mcpEntrypoint: MCP_ENTRYPOINT,
      hookCapabilities: qualifiedReport(),
      observedCodexBuild: BUILD,
    },
  };
}

function managedGuard(fixture: Fixture): string {
  return join(fixture.codexDir, "penumbra", "hooks", "penumbra-agent-gc-guard.sh");
}

function managedSentinel(fixture: Fixture): string {
  return join(fixture.codexDir, "penumbra", "allow-agent-gc");
}

function hooksPath(fixture: Fixture): string {
  return join(fixture.codexDir, "hooks.json");
}

function manifestPath(fixture: Fixture): string {
  return join(fixture.codexDir, "penumbra", "installation.json");
}

function readHooks(fixture: Fixture): Record<string, HookGroup[]> {
  const config = JSON.parse(readFileSync(hooksPath(fixture), "utf8")) as {
    hooks: Record<string, HookGroup[]>;
  };
  return config.hooks;
}

function safetyGroups(fixture: Fixture): HookGroup[] {
  return (readHooks(fixture).PreToolUse ?? []).filter((group) =>
    group.hooks.some((handler) => handler.timeout === 12),
  );
}

function readManifest(fixture: Fixture): Manifest {
  return JSON.parse(readFileSync(manifestPath(fixture), "utf8")) as Manifest;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function rawEvent(toolName: "Bash" | "exec_command", command: string, cwd: string): string {
  return JSON.stringify({
    session_id: "installed-safety-root",
    transcript_path: null,
    cwd,
    hook_event_name: "PreToolUse",
    model: "gpt-5.6-sol",
    permission_mode: "default",
    turn_id: "turn-installed",
    tool_name: toolName,
    tool_use_id: "tool-installed",
    tool_input: toolName === "Bash" ? { command } : { cmd: command },
  });
}

async function runInstalledCommand(
  command: string,
  input: string,
  home: string,
  env: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const child = Bun.spawn(["/bin/sh", "-c", command], {
    env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await child.stdin.write(input);
  await child.stdin.end();
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

function createUnlandedRepo(fixture: Fixture): { branch: string; ref: string } {
  const repo = join(fixture.root, "repo");
  const run = (argv: string[]): string => {
    const result = Bun.spawnSync(argv, { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  mkdirSync(repo);
  run(["git", "init", "-q", "-b", "main"]);
  run(["git", "config", "user.email", "test@example.invalid"]);
  run(["git", "config", "user.name", "Test User"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  run(["git", "add", "base.txt"]);
  run(["git", "commit", "-q", "-m", "base"]);
  const branch = "feat/installed-safety";
  run(["git", "checkout", "-q", "-b", branch]);
  writeFileSync(join(repo, "work.txt"), "work\n");
  run(["git", "add", "work.txt"]);
  run(["git", "commit", "-q", "-m", "work"]);
  const ref = run(["git", "rev-parse", branch]);
  run(["git", "checkout", "-q", "main"]);
  mkdirSync(fixture.storageRoot, { recursive: true });
  const db = new Database(join(fixture.storageRoot, "db.sqlite"));
  db.run("CREATE TABLE handoffs (handoff_id TEXT, branch_name TEXT)");
  db.run("INSERT INTO handoffs VALUES (?, ?)", ["handoff-installed", branch]);
  db.close();
  return { branch, ref };
}

function gitRef(fixture: Fixture, branch: string): string {
  const result = Bun.spawnSync(["git", "rev-parse", branch], {
    cwd: join(fixture.root, "repo"),
    stdout: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

test("runCodexSetup installs an exact storage-bound safety command and real guard decisions", async () => {
  const fixture = makeFixture();
  try {
    const repo = createUnlandedRepo(fixture);
    const installed = await runCodexSetup(fixture.opts);
    expect(installed.ok).toBe(true);
    expect(installed.components.hooks.state).toBe("installed");

    const guardPath = managedGuard(fixture);
    const sentinelPath = managedSentinel(fixture);
    const expectedCommand = [
      `PENUMBRA_STORAGE_ROOT=${quote(fixture.storageRoot)}`,
      quote(realpathSync(process.execPath)),
      quote(realpathSync(CLI_PATH)),
      "hook codex-safety",
      `--guard-path ${quote(guardPath)}`,
      `--sentinel-path ${quote(sentinelPath)}`,
    ].join(" ");
    const groups = safetyGroups(fixture);
    const installedCommand = groups[0]?.hooks[0]?.command;
    if (!installedCommand) throw new Error("installed safety command missing");
    const installedHooks = readHooks(fixture);
    const advisory = (installedHooks.PreToolUse ?? []).filter((group) =>
      group.hooks.some((handler) => handler.timeout === 2),
    );
    expect(Object.keys(installedHooks)).toEqual(["PreToolUse"]);
    expect(advisory.map((group) => group.matcher)).toEqual(["^Bash$", "^exec_command$"]);
    expect(advisory.every((group) => group.hooks[0]?.command.includes(" hook codex "))).toBe(true);
    expect(groups.map((group) => group.matcher)).toEqual(["^Bash$", "^exec_command$"]);
    expect(groups.map((group) => group.hooks[0]?.command)).toEqual([
      expectedCommand,
      expectedCommand,
    ]);
    expect(groups.map((group) => group.hooks[0]?.timeout)).toEqual([12, 12]);
    expect(readFileSync(guardPath)).toEqual(readFileSync(PACKAGED_GUARD));
    expect(existsSync(sentinelPath)).toBe(false);
    expect(readManifest(fixture).safety).toEqual({
      guardPath,
      guardHash: sha256(readFileSync(PACKAGED_GUARD)),
      sentinelPath,
    });

    let fakeExecutions = 0;
    const denied = await runInstalledCommand(
      installedCommand,
      rawEvent("Bash", `git branch -D ${repo.branch}`, join(fixture.root, "repo")),
      join(fixture.root, "clean home"),
    );
    const denial = JSON.parse(denied.stdout) as Record<string, unknown>;
    if (denied.exit === 0 && denial.decision !== "block") fakeExecutions += 1;
    expect(denied.exit).toBe(2);
    expect(denial.decision).toBe("block");
    expect(fakeExecutions).toBe(0);
    expect(gitRef(fixture, repo.branch)).toBe(repo.ref);

    const allowed = await runInstalledCommand(
      installedCommand,
      rawEvent("exec_command", "git status --short", join(fixture.root, "repo")),
      join(fixture.root, "clean home"),
    );
    const allowance = JSON.parse(allowed.stdout) as Record<string, unknown>;
    if (allowed.exit === 0 && allowance.decision !== "block") fakeExecutions += 1;
    expect(allowed.exit).toBe(0);
    expect(allowance).toEqual({});
    expect(fakeExecutions).toBe(1);
    expect(gitRef(fixture, repo.branch)).toBe(repo.ref);

    const overrideDbPath = join(fixture.root, "explicit database", "db.sqlite");
    mkdirSync(dirname(overrideDbPath), { recursive: true });
    const overrideDb = new Database(overrideDbPath);
    overrideDb.run("CREATE TABLE handoffs (handoff_id TEXT, branch_name TEXT)");
    overrideDb.close();
    const dbCapturePath = join(fixture.root, "captured database path");
    writeFileSync(
      guardPath,
      [
        "#!/usr/bin/env bash",
        "cat >/dev/null",
        'printf "%s" "$PENUMBRA_DB" > "$PENUMBRA_TEST_DB_CAPTURE"',
        "exit 0",
        "",
      ].join("\n"),
    );
    const explicitOverride = await runInstalledCommand(
      installedCommand,
      rawEvent("Bash", "git status --short", join(fixture.root, "repo")),
      join(fixture.root, "clean home"),
      { PENUMBRA_DB: overrideDbPath, PENUMBRA_TEST_DB_CAPTURE: dbCapturePath },
    );
    expect(explicitOverride.exit).toBe(0);
    expect(JSON.parse(explicitOverride.stdout)).toEqual({});
    expect(readFileSync(dbCapturePath, "utf8")).toBe(overrideDbPath);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("status repair and uninstall preserve missing or modified managed safety artifacts", async () => {
  const fixture = makeFixture("codex safety lifecycle ");
  try {
    await runCodexSetup(fixture.opts);
    const guardPath = managedGuard(fixture);
    const original = readFileSync(guardPath);
    expect(
      (await runCodexSetup({ ...fixture.opts, action: "status" })).components.hooks.state,
    ).toBe("installed");

    rmSync(guardPath);
    expect(
      (await runCodexSetup({ ...fixture.opts, action: "status" })).components.hooks.state,
    ).toBe("absent");
    expect((await runCodexSetup({ ...fixture.opts, action: "repair" })).ok).toBe(true);
    expect(readFileSync(guardPath)).toEqual(original);

    writeFileSync(guardPath, "user-edited guard\n");
    for (const action of ["status", "repair", "uninstall"] as const) {
      const result = await runCodexSetup({ ...fixture.opts, action });
      expect(result.ok).toBe(false);
      expect(result.components.hooks.state).toBe("conflict");
      expect(readFileSync(guardPath, "utf8")).toBe("user-edited guard\n");
    }
    writeFileSync(guardPath, original);
    const uninstalled = await runCodexSetup({ ...fixture.opts, action: "uninstall" });
    expect(uninstalled.ok).toBe(true);
    expect(existsSync(guardPath)).toBe(false);
    expect(existsSync(manifestPath(fixture))).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("managed guard updates are byte-identical and modified safety commands conflict", async () => {
  const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), "codex safety package ")));
  const packageDir = join(packageRoot, "penumbra package");
  cpSync(PACKAGED_DIR, packageDir, { recursive: true });
  const fixture = makeFixture("codex safety update ", packageDir);
  try {
    await runCodexSetup(fixture.opts);
    const source = join(packageDir, "hooks", "penumbra-agent-gc-guard.sh");
    const updated = Buffer.concat([readFileSync(source), Buffer.from("\n")]);
    writeFileSync(source, updated);
    const update = await runCodexSetup(fixture.opts);
    expect(update.ok).toBe(true);
    expect(update.changed).toBe(true);
    expect(readFileSync(managedGuard(fixture))).toEqual(updated);

    const config = JSON.parse(readFileSync(hooksPath(fixture), "utf8")) as {
      hooks: Record<string, HookGroup[]>;
    };
    const safety = config.hooks.PreToolUse?.find((group) =>
      group.hooks.some((handler) => handler.command.includes(" hook codex-safety ")),
    );
    if (!safety?.hooks[0]) throw new Error("managed safety hook missing");
    const unrelated = structuredClone(safety);
    unrelated.hooks[0]!.command = unrelated.hooks[0]!.command.replace(
      "hook codex-safety ",
      "hook codex-safety-other ",
    );
    config.hooks.PreToolUse?.push(unrelated);
    writeFileSync(hooksPath(fixture), `${JSON.stringify(config, null, 2)}\n`);
    expect((await runCodexSetup({ ...fixture.opts, action: "status" })).ok).toBe(true);
    config.hooks.PreToolUse?.pop();
    safety.hooks[0].command += " --user-edited";
    writeFileSync(hooksPath(fixture), `${JSON.stringify(config, null, 2)}\n`);
    const before = readFileSync(hooksPath(fixture));
    for (const action of ["status", "repair", "uninstall"] as const) {
      const result = await runCodexSetup({ ...fixture.opts, action });
      expect(result.ok).toBe(false);
      expect(result.components.hooks.state).toBe("conflict");
      expect(readFileSync(hooksPath(fixture))).toEqual(before);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("unsafe destinations and stale safety ownership fail closed", async () => {
  const symlinkFixture = makeFixture("codex safety symlink ");
  try {
    const canary = join(symlinkFixture.root, "canary");
    writeFileSync(canary, "safe\n");
    mkdirSync(dirname(managedGuard(symlinkFixture)), { recursive: true });
    symlinkSync(canary, managedGuard(symlinkFixture));
    const result = await runCodexSetup(symlinkFixture.opts);
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(readFileSync(canary, "utf8")).toBe("safe\n");
    expect(existsSync(hooksPath(symlinkFixture))).toBe(false);
  } finally {
    rmSync(symlinkFixture.root, { recursive: true, force: true });
  }

  const unownedFixture = makeFixture("codex safety unowned guard ");
  try {
    mkdirSync(dirname(managedGuard(unownedFixture)), { recursive: true });
    writeFileSync(managedGuard(unownedFixture), "user guard\n");
    const status = await runCodexSetup({ ...unownedFixture.opts, action: "status" });
    expect(status.ok).toBe(false);
    expect(status.components.hooks.state).toBe("conflict");
    expect(readFileSync(managedGuard(unownedFixture), "utf8")).toBe("user guard\n");
  } finally {
    rmSync(unownedFixture.root, { recursive: true, force: true });
  }

  const staleFixture = makeFixture("codex safety stale ownership ");
  try {
    await runCodexSetup(staleFixture.opts);
    const manifest = JSON.parse(readFileSync(manifestPath(staleFixture), "utf8")) as Manifest;
    if (!manifest.safety) throw new Error("managed safety ownership missing");
    manifest.safety.guardPath = join(staleFixture.root, "outside-guard.sh");
    writeFileSync(manifestPath(staleFixture), `${JSON.stringify(manifest, null, 2)}\n`);
    const before = readFileSync(manifestPath(staleFixture));
    const result = await runCodexSetup({ ...staleFixture.opts, action: "status" });
    expect(result.ok).toBe(false);
    expect(result.components.hooks.state).toBe("conflict");
    expect(readFileSync(manifestPath(staleFixture))).toEqual(before);
  } finally {
    rmSync(staleFixture.root, { recursive: true, force: true });
  }

  const prefixFixture = makeFixture("codex safety stale hook ownership ");
  try {
    await runCodexSetup(prefixFixture.opts);
    const manifest = JSON.parse(readFileSync(manifestPath(prefixFixture), "utf8")) as Manifest;
    if (!manifest.hooks) throw new Error("managed hook ownership missing");
    manifest.hooks.commandPrefixes = [manifest.hooks.commandPrefix, "penumbra hook"];
    writeFileSync(manifestPath(prefixFixture), `${JSON.stringify(manifest, null, 2)}\n`);
    const result = await runCodexSetup({ ...prefixFixture.opts, action: "status" });
    expect(result.ok).toBe(false);
    expect(result.components.hooks.state).toBe("conflict");
  } finally {
    rmSync(prefixFixture.root, { recursive: true, force: true });
  }
});

test("a later manifest failure restores an originally absent safety hook and guard", async () => {
  const fixture = makeFixture("codex safety absent rollback ");
  mkdirSync(fixture.codexDir, { recursive: true });
  const priorHooks = `${JSON.stringify({ description: "user hooks", hooks: {} })}\n`;
  writeFileSync(hooksPath(fixture), priorHooks);
  const host: CodexSetupHost = {
    plugin: {
      state: "supported",
      identifier: "penumbra@verified",
      installArgv: ["codex", "plugin", "install", "penumbra@verified"],
      statusArgv: ["codex", "plugin", "status", "penumbra@verified"],
      uninstallArgv: ["codex", "plugin", "uninstall", "penumbra@verified"],
    },
    invoke: () => {
      mkdirSync(manifestPath(fixture), { recursive: true });
      return Promise.resolve({ ok: true, installed: true });
    },
  };
  try {
    const failed = await runCodexSetup({ ...fixture.opts, mode: "plugin", host });
    expect(failed.ok).toBe(false);
    expect(failed.changed).toBe(true);
    expect(existsSync(managedGuard(fixture))).toBe(false);
    expect(readFileSync(hooksPath(fixture), "utf8")).toBe(priorHooks);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a later manifest failure restores prior hook and guard bytes", async () => {
  const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), "codex safety rollback package ")));
  const packageDir = join(packageRoot, "package");
  cpSync(PACKAGED_DIR, packageDir, { recursive: true });
  const fixture = makeFixture("codex safety rollback ", packageDir);
  let hostCalls = 0;
  const host: CodexSetupHost = {
    plugin: {
      state: "supported",
      identifier: "penumbra@verified",
      installArgv: ["codex", "plugin", "install", "penumbra@verified"],
      statusArgv: ["codex", "plugin", "status", "penumbra@verified"],
      uninstallArgv: ["codex", "plugin", "uninstall", "penumbra@verified"],
    },
    invoke: () => {
      hostCalls += 1;
      if (hostCalls === 2) {
        rmSync(manifestPath(fixture));
        mkdirSync(manifestPath(fixture));
      }
      return Promise.resolve({ ok: true, installed: true });
    },
  };
  try {
    const installed = await runCodexSetup({ ...fixture.opts, mode: "plugin", host });
    expect(installed.ok).toBe(true);
    const oldGuard = readFileSync(managedGuard(fixture));
    const repairConfig = JSON.parse(readFileSync(hooksPath(fixture), "utf8")) as {
      hooks: Record<string, HookGroup[]>;
    };
    const advisoryIndex = repairConfig.hooks.PreToolUse?.findIndex(
      (group) => !group.hooks.some((handler) => handler.command.includes(" hook codex-safety ")),
    );
    if (advisoryIndex === undefined || advisoryIndex < 0) {
      throw new Error("managed advisory hook missing");
    }
    repairConfig.hooks.PreToolUse?.splice(advisoryIndex, 1);
    writeFileSync(hooksPath(fixture), `${JSON.stringify(repairConfig, null, 2)}\n`);
    const oldHooks = readFileSync(hooksPath(fixture));
    writeFileSync(
      join(packageDir, "hooks", "penumbra-agent-gc-guard.sh"),
      Buffer.concat([oldGuard, Buffer.from("\n")]),
    );

    const failed = await runCodexSetup({
      ...fixture.opts,
      action: "repair",
      mode: "plugin",
      host,
    });
    expect(failed.ok).toBe(false);
    expect(failed.changed).toBe(true);
    expect(readFileSync(managedGuard(fixture))).toEqual(oldGuard);
    expect(readFileSync(hooksPath(fixture))).toEqual(oldHooks);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("rollback preserves an external concurrent guard change", async () => {
  const fixture = makeFixture("codex safety concurrent rollback ");
  try {
    const {
      applyCodexSafetySetup,
      prepareCodexSafetySetup,
      readCodexSafetySource,
      restoreCodexSafetySetup,
    } = await import("@src/commands/codex-safety-setup.js");
    const source = readCodexSafetySource(fixture.opts);
    if (!source) throw new Error("packaged safety guard missing");
    const prepared = prepareCodexSafetySetup(fixture.opts, source, undefined, true);
    applyCodexSafetySetup(fixture.opts, prepared);
    writeFileSync(managedGuard(fixture), "external concurrent bytes\n");
    expect(() => {
      restoreCodexSafetySetup(fixture.opts, prepared);
    }).toThrow("managed safety guard changed during rollback");
    expect(readFileSync(managedGuard(fixture), "utf8")).toBe("external concurrent bytes\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
