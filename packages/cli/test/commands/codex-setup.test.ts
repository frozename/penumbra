import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  type CodexSetupHost,
  type CodexSetupOptions,
  runCodexSetup,
} from "@src/commands/codex-setup.js";

const SKILL_NAMES = [
  "penumbra-dispatch-evidence",
  "penumbra-first-moves",
  "penumbra-handoff",
  "penumbra-memory",
  "penumbra-plan",
  "penumbra-registrar",
  "penumbra-review",
  "penumbra-workflow",
];

const SEEDED_CONFIG = [
  "# keep this user comment",
  "[mcp_servers.other]",
  'command = "other"',
  "",
  "[otel]",
  'environment = "user"',
  "",
  "[skills.config]",
  'mode = "manual"',
  "",
].join("\n");

interface Fixture {
  root: string;
  codexDir: string;
  skillsDir: string;
  packageDir: string;
  storageRoot: string;
  mcpEntrypoint: string;
  opts: CodexSetupOptions;
}

interface TestManifest {
  schemaVersion: number;
  mode: string;
  codexDir: string;
  plugin?: { identifier: string };
  skills: {
    name: string;
    destination: string;
    artifacts: { path: string; hash: string }[];
  }[];
}

interface ParsedConfig {
  mcp_servers: {
    other?: { command: string };
    penumbra: { command: string; args: string[]; env: { PENUMBRA_STORAGE_ROOT: string } };
  };
  otel?: { environment: string };
  skills?: { config: { mode: string } };
}

function writeSkill(packageDir: string, name: string, body = `# ${name}\n`): void {
  const skillDir = join(packageDir, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n${body}`,
  );
}

function makeFixture(prefix = "codex-setup-"): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const codexDir = join(root, "codex");
  const skillsDir = join(root, "skills");
  const packageDir = join(root, "package");
  const storageRoot = join(root, "storage");
  const mcpEntrypoint = join(root, "mcp entrypoint.ts");
  mkdirSync(join(packageDir, ".codex-plugin"), { recursive: true });
  writeFileSync(
    join(packageDir, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "penumbra", version: "0.1.0", skills: "./skills/" }),
  );
  for (const name of SKILL_NAMES) writeSkill(packageDir, name);
  writeFileSync(mcpEntrypoint, "// disposable MCP entrypoint\n");
  return {
    root,
    codexDir,
    skillsDir,
    packageDir,
    storageRoot,
    mcpEntrypoint,
    opts: {
      action: "install",
      mode: "standalone",
      codexDir,
      skillsDir,
      packageDir,
      storageRoot,
      mcpEntrypoint,
    },
  };
}

function seedUnrelated(fixture: Fixture): void {
  mkdirSync(fixture.codexDir, { recursive: true });
  writeFileSync(join(fixture.codexDir, "config.toml"), SEEDED_CONFIG);
  writeFileSync(join(fixture.codexDir, "hooks.json"), '{"user":true}\n');
  mkdirSync(join(fixture.skillsDir, "unrelated"), { recursive: true });
  writeFileSync(join(fixture.skillsDir, "unrelated", "SKILL.md"), "user skill\n");
}

function walkSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  if (!existsSync(root)) return snapshot;
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const name = relative(root, path) || ".";
    if (stat.isSymbolicLink()) {
      snapshot[name] = "symlink";
      return;
    }
    if (stat.isDirectory()) {
      snapshot[name] = "directory";
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    snapshot[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
  };
  visit(root);
  return snapshot;
}

function manifest(fixture: Fixture): TestManifest {
  return JSON.parse(
    readFileSync(join(fixture.codexDir, "penumbra", "installation.json"), "utf8"),
  ) as TestManifest;
}

function cleanup(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

test("status does not initialize an absent Codex profile", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-setup-status-")));
  const codexDir = join(root, "codex");
  try {
    const result = await runCodexSetup({
      action: "status",
      mode: "standalone",
      codexDir,
      skillsDir: join(root, "skills"),
      packageDir: join(root, "package"),
      storageRoot: join(root, "storage"),
      mcpEntrypoint: join(root, "mcp.ts"),
    });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.components.skills.state).toBe("absent");
    expect(existsSync(codexDir)).toBe(false);
    expect(existsSync(join(root, "storage"))).toBe(false);
    expect(existsSync(join(root, "skills"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("standalone install round-trips through Bun's TOML consumer and preserves unrelated state", async () => {
  const fixture = makeFixture();
  try {
    seedUnrelated(fixture);
    const beforeHooks = readFileSync(join(fixture.codexDir, "hooks.json"), "utf8");
    const beforeUnrelated = readFileSync(join(fixture.skillsDir, "unrelated", "SKILL.md"), "utf8");

    const result = await runCodexSetup(fixture.opts);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const config = readFileSync(join(fixture.codexDir, "config.toml"), "utf8");
    const parsed = Bun.TOML.parse(config) as unknown as ParsedConfig;
    expect(parsed.mcp_servers.other?.command).toBe("other");
    expect(parsed.otel?.environment).toBe("user");
    expect(parsed.skills?.config.mode).toBe("manual");
    expect(parsed.mcp_servers.penumbra.command).toBe(process.execPath);
    expect(parsed.mcp_servers.penumbra.args).toEqual([fixture.mcpEntrypoint]);
    expect(parsed.mcp_servers.penumbra.env.PENUMBRA_STORAGE_ROOT).toBe(fixture.storageRoot);
    expect(config.startsWith(SEEDED_CONFIG)).toBe(true);
    expect(readFileSync(join(fixture.codexDir, "hooks.json"), "utf8")).toBe(beforeHooks);
    expect(readFileSync(join(fixture.skillsDir, "unrelated", "SKILL.md"), "utf8")).toBe(
      beforeUnrelated,
    );
    expect(result.components.hooks.state).toBe("absent");
    expect(result.components.telemetry.state).toBe("absent");
    expect(config).not.toContain("/v1/logs");
    const owned = manifest(fixture);
    expect(owned.schemaVersion).toBe(1);
    expect(owned.mode).toBe("standalone");
    expect(owned.skills).toHaveLength(8);
    expect(owned.skills.every((skill) => skill.artifacts.length === 1)).toBe(true);
  } finally {
    cleanup(fixture);
  }
});

test("second install is idempotent and status performs zero writes", async () => {
  const fixture = makeFixture();
  try {
    await runCodexSetup(fixture.opts);
    const beforeSecond = walkSnapshot(fixture.root);
    const second = await runCodexSetup(fixture.opts);
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(walkSnapshot(fixture.root)).toEqual(beforeSecond);

    const beforeStatus = walkSnapshot(fixture.root);
    const status = await runCodexSetup({ ...fixture.opts, action: "status" });
    expect(status.ok).toBe(true);
    expect(status.changed).toBe(false);
    expect(status.components.mcp.state).toBe("installed");
    expect(status.components.skills.state).toBe("installed");
    expect(walkSnapshot(fixture.root)).toEqual(beforeStatus);
  } finally {
    cleanup(fixture);
  }
});

test("package update adds new skills, refreshes owned files, and removes retired unchanged skills", async () => {
  const fixture = makeFixture();
  try {
    await runCodexSetup(fixture.opts);
    writeSkill(fixture.packageDir, "penumbra-ninth", "# ninth\n");
    writeSkill(fixture.packageDir, "penumbra-memory", "# updated memory\n");
    mkdirSync(join(fixture.packageDir, "skills", "penumbra-memory", "references"));
    writeFileSync(
      join(fixture.packageDir, "skills", "penumbra-memory", "references", "guide.md"),
      "owned nested artifact\n",
    );
    rmSync(join(fixture.packageDir, "skills", "penumbra-review"), { recursive: true });

    const result = await runCodexSetup(fixture.opts);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(existsSync(join(fixture.skillsDir, "penumbra-ninth", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(fixture.skillsDir, "penumbra-memory", "SKILL.md"), "utf8")).toContain(
      "updated memory",
    );
    expect(existsSync(join(fixture.skillsDir, "penumbra-review"))).toBe(false);
    expect(
      readFileSync(join(fixture.skillsDir, "penumbra-memory", "references", "guide.md"), "utf8"),
    ).toBe("owned nested artifact\n");
    expect(
      manifest(fixture).skills.find((skill) => skill.name === "penumbra-memory")?.artifacts,
    ).toHaveLength(2);
    expect(
      manifest(fixture)
        .skills.map((skill) => skill.name)
        .sort(),
    ).toEqual(
      [...SKILL_NAMES.filter((name) => name !== "penumbra-review"), "penumbra-ninth"].sort(),
    );
  } finally {
    cleanup(fixture);
  }
});

test("a retired edited skill blocks upgrade and unrelated skills are never pruned", async () => {
  const fixture = makeFixture();
  try {
    seedUnrelated(fixture);
    await runCodexSetup(fixture.opts);
    const edited = join(fixture.skillsDir, "penumbra-review", "SKILL.md");
    writeFileSync(edited, "user edit\n");
    rmSync(join(fixture.packageDir, "skills", "penumbra-review"), { recursive: true });
    writeSkill(fixture.packageDir, "penumbra-ninth", "# ninth\n");
    const before = walkSnapshot(fixture.root);

    const result = await runCodexSetup(fixture.opts);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.components.skills.state).toBe("conflict");
    expect(readFileSync(edited, "utf8")).toBe("user edit\n");
    expect(existsSync(join(fixture.skillsDir, "unrelated", "SKILL.md"))).toBe(true);
    expect(existsSync(join(fixture.skillsDir, "penumbra-ninth"))).toBe(false);
    expect(walkSnapshot(fixture.root)).toEqual(before);
  } finally {
    cleanup(fixture);
  }
});

test("repair restores a missing owned file", async () => {
  const fixture = makeFixture();
  try {
    await runCodexSetup(fixture.opts);
    const missing = join(fixture.skillsDir, "penumbra-plan", "SKILL.md");
    rmSync(missing);
    const beforeStatus = walkSnapshot(fixture.root);

    const status = await runCodexSetup({ ...fixture.opts, action: "status" });
    expect(status.ok).toBe(true);
    expect(status.changed).toBe(false);
    expect(status.components.skills.state).toBe("absent");
    expect(walkSnapshot(fixture.root)).toEqual(beforeStatus);

    const result = await runCodexSetup({ ...fixture.opts, action: "repair" });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(existsSync(missing)).toBe(true);
  } finally {
    cleanup(fixture);
  }
});

test("install and repair preserve an edited owned skill and report conflict", async () => {
  const fixture = makeFixture();
  try {
    await runCodexSetup(fixture.opts);
    const edited = join(fixture.skillsDir, "penumbra-plan", "SKILL.md");
    writeFileSync(edited, "user edit\n");
    const before = walkSnapshot(fixture.root);

    for (const action of ["install", "repair"] as const) {
      const result = await runCodexSetup({ ...fixture.opts, action });
      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(result.components.skills.state).toBe("conflict");
      expect(readFileSync(edited, "utf8")).toBe("user edit\n");
      expect(walkSnapshot(fixture.root)).toEqual(before);
    }
  } finally {
    cleanup(fixture);
  }
});

test("uninstall removes only unchanged owned data and reports residual edits", async () => {
  const fixture = makeFixture();
  try {
    seedUnrelated(fixture);
    await runCodexSetup(fixture.opts);
    const edited = join(fixture.skillsDir, "penumbra-memory", "SKILL.md");
    writeFileSync(edited, "user edit\n");

    const result = await runCodexSetup({ ...fixture.opts, action: "uninstall" });

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.components.skills.state).toBe("conflict");
    expect(readFileSync(edited, "utf8")).toBe("user edit\n");
    expect(existsSync(join(fixture.skillsDir, "penumbra-plan"))).toBe(false);
    expect(existsSync(join(fixture.skillsDir, "unrelated", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(fixture.codexDir, "config.toml"), "utf8")).toBe(SEEDED_CONFIG);
    expect(existsSync(join(fixture.codexDir, "hooks.json"))).toBe(true);
    expect(existsSync(join(fixture.codexDir, "penumbra", "installation.json"))).toBe(true);
  } finally {
    cleanup(fixture);
  }
});

test("uninstall preserves extra user files inside an owned skill and retains conflict ownership", async () => {
  const fixture = makeFixture();
  try {
    await runCodexSetup(fixture.opts);
    const extra = join(fixture.skillsDir, "penumbra-memory", "notes.txt");
    writeFileSync(extra, "user data\n");

    const result = await runCodexSetup({ ...fixture.opts, action: "uninstall" });

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.components.skills.state).toBe("conflict");
    expect(readFileSync(extra, "utf8")).toBe("user data\n");
    expect(existsSync(join(fixture.codexDir, "penumbra", "installation.json"))).toBe(true);

    rmSync(extra);
    const completed = await runCodexSetup({ ...fixture.opts, action: "uninstall" });
    expect(completed.ok).toBe(true);
    expect(existsSync(join(fixture.codexDir, "penumbra", "installation.json"))).toBe(false);
  } finally {
    cleanup(fixture);
  }
});

test("edited managed MCP configuration is retained for install, repair, and uninstall", async () => {
  for (const action of ["install", "repair", "uninstall"] as const) {
    const fixture = makeFixture(`codex-setup-config-${action}-`);
    try {
      await runCodexSetup(fixture.opts);
      const configPath = join(fixture.codexDir, "config.toml");
      const edited = readFileSync(configPath, "utf8").replace(process.execPath, "/user/bun");
      writeFileSync(configPath, edited);
      const before = walkSnapshot(fixture.root);

      const result = await runCodexSetup({ ...fixture.opts, action });

      expect(result.ok).toBe(false);
      expect(result.changed).toBe(action === "uninstall");
      expect(result.components.mcp.state).toBe("conflict");
      expect(readFileSync(configPath, "utf8")).toBe(edited);
      if (action !== "uninstall") expect(walkSnapshot(fixture.root)).toEqual(before);
    } finally {
      cleanup(fixture);
    }
  }
});

test("unsupported plugin mode is unavailable without standalone fallback", async () => {
  const fixture = makeFixture();
  try {
    const status = await runCodexSetup({ ...fixture.opts, action: "status", mode: "plugin" });
    expect(status.ok).toBe(true);
    expect(status.changed).toBe(false);
    expect(status.components.skills.state).toBe("unknown");

    const result = await runCodexSetup({ ...fixture.opts, mode: "plugin" });
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.components.skills.state).toBe("unavailable");
    expect(existsSync(fixture.codexDir)).toBe(false);
    expect(existsSync(fixture.skillsDir)).toBe(false);
  } finally {
    cleanup(fixture);
  }
});

test("supported plugin adapter receives only its pinned argv arrays", async () => {
  const fixture = makeFixture();
  const calls: string[][] = [];
  const host: CodexSetupHost = {
    plugin: {
      state: "supported",
      identifier: "penumbra@verified",
      installArgv: ["codex", "plugin", "install", "penumbra@verified"],
      statusArgv: ["codex", "plugin", "get", "penumbra@verified"],
      uninstallArgv: ["codex", "plugin", "remove", "penumbra@verified"],
    },
    invoke: (argv) => {
      calls.push([...argv]);
      return Promise.resolve({ ok: true, installed: argv[2] !== "remove", detail: "fixture" });
    },
  };
  try {
    const installed = await runCodexSetup({ ...fixture.opts, mode: "plugin", host });
    expect(installed.ok).toBe(true);
    expect(calls).toEqual([["codex", "plugin", "install", "penumbra@verified"]]);
    expect(existsSync(fixture.skillsDir)).toBe(false);
    expect(manifest(fixture).plugin?.identifier).toBe("penumbra@verified");

    const status = await runCodexSetup({
      ...fixture.opts,
      action: "status",
      mode: "plugin",
      host,
    });
    expect(status.ok).toBe(true);
    expect(calls.at(-1)).toEqual(["codex", "plugin", "get", "penumbra@verified"]);
  } finally {
    cleanup(fixture);
  }
});

test("plugin install, external removal, repair, and status round-trip through the host adapter", async () => {
  const fixture = makeFixture();
  const calls: string[][] = [];
  let pluginInstalled = false;
  const host: CodexSetupHost = {
    plugin: {
      state: "supported",
      identifier: "penumbra@verified",
      installArgv: ["codex", "plugin", "install", "penumbra@verified"],
      statusArgv: ["codex", "plugin", "get", "penumbra@verified"],
      uninstallArgv: ["codex", "plugin", "remove", "penumbra@verified"],
    },
    invoke: (argv) => {
      calls.push([...argv]);
      if (argv[2] === "install") pluginInstalled = true;
      return Promise.resolve({ ok: true, installed: pluginInstalled, detail: "fixture" });
    },
  };
  try {
    const installed = await runCodexSetup({ ...fixture.opts, mode: "plugin", host });
    expect(installed.ok).toBe(true);
    expect(installed.changed).toBe(true);
    expect(calls).toEqual([["codex", "plugin", "install", "penumbra@verified"]]);

    pluginInstalled = false;
    const beforeExistingInstall = walkSnapshot(fixture.root);
    const existingInstall = await runCodexSetup({ ...fixture.opts, mode: "plugin", host });
    expect(existingInstall.ok).toBe(false);
    expect(existingInstall.changed).toBe(false);
    expect(calls.slice(-1)).toEqual([["codex", "plugin", "get", "penumbra@verified"]]);
    expect(walkSnapshot(fixture.root)).toEqual(beforeExistingInstall);

    const repaired = await runCodexSetup({
      ...fixture.opts,
      action: "repair",
      mode: "plugin",
      host,
    });
    expect(repaired.ok).toBe(true);
    expect(repaired.changed).toBe(true);
    expect(calls.slice(-2)).toEqual([
      ["codex", "plugin", "get", "penumbra@verified"],
      ["codex", "plugin", "install", "penumbra@verified"],
    ]);

    const status = await runCodexSetup({
      ...fixture.opts,
      action: "status",
      mode: "plugin",
      host,
    });
    expect(status.ok).toBe(true);
    expect(status.changed).toBe(false);
    expect(status.components.skills.state).toBe("installed");

    const beforeSecondRepair = walkSnapshot(fixture.root);
    const secondRepair = await runCodexSetup({
      ...fixture.opts,
      action: "repair",
      mode: "plugin",
      host,
    });
    expect(secondRepair.ok).toBe(true);
    expect(secondRepair.changed).toBe(false);
    expect(calls.at(-1)).toEqual(["codex", "plugin", "get", "penumbra@verified"]);
    expect(walkSnapshot(fixture.root)).toEqual(beforeSecondRepair);
  } finally {
    cleanup(fixture);
  }
});

test("plugin install requires an explicit installed confirmation before local ownership writes", async () => {
  for (const installed of [undefined, false]) {
    const fixture = makeFixture(`codex-setup-plugin-install-${String(installed)}-`);
    const calls: string[][] = [];
    const host: CodexSetupHost = {
      plugin: {
        state: "supported",
        identifier: "penumbra@verified",
        installArgv: ["codex", "plugin", "install", "penumbra@verified"],
        statusArgv: ["codex", "plugin", "get", "penumbra@verified"],
        uninstallArgv: ["codex", "plugin", "remove", "penumbra@verified"],
      },
      invoke: (argv) => {
        calls.push([...argv]);
        return Promise.resolve({ ok: true, installed });
      },
    };
    try {
      seedUnrelated(fixture);
      const before = walkSnapshot(fixture.root);
      const result = await runCodexSetup({ ...fixture.opts, mode: "plugin", host });

      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(result.components.skills.state).toBe("unavailable");
      expect(calls).toEqual([["codex", "plugin", "install", "penumbra@verified"]]);
      expect(walkSnapshot(fixture.root)).toEqual(before);
      expect(existsSync(join(fixture.codexDir, "penumbra", "installation.json"))).toBe(false);
    } finally {
      cleanup(fixture);
    }
  }
});

test("plugin repair preserves local bytes when status or install confirmation is ambiguous", async () => {
  for (const confirmation of [undefined, false]) {
    const fixture = makeFixture(`codex-setup-plugin-repair-${String(confirmation)}-`);
    const calls: string[][] = [];
    let phase: "install" | "status-unknown" | "status-failed" | "repair-install" = "install";
    const host: CodexSetupHost = {
      plugin: {
        state: "supported",
        identifier: "penumbra@verified",
        installArgv: ["codex", "plugin", "install", "penumbra@verified"],
        statusArgv: ["codex", "plugin", "get", "penumbra@verified"],
        uninstallArgv: ["codex", "plugin", "remove", "penumbra@verified"],
      },
      invoke: (argv) => {
        calls.push([...argv]);
        if (phase === "install") return Promise.resolve({ ok: true, installed: true });
        if (phase === "status-unknown") return Promise.resolve({ ok: true });
        if (phase === "status-failed") return Promise.resolve({ ok: false, installed: false });
        if (argv[2] === "get") return Promise.resolve({ ok: true, installed: false });
        return Promise.resolve({ ok: true, installed: confirmation });
      },
    };
    try {
      await runCodexSetup({ ...fixture.opts, mode: "plugin", host });
      const before = walkSnapshot(fixture.root);

      phase = "status-unknown";
      const unknown = await runCodexSetup({
        ...fixture.opts,
        action: "repair",
        mode: "plugin",
        host,
      });
      expect(unknown.ok).toBe(false);
      expect(calls.at(-1)).toEqual(["codex", "plugin", "get", "penumbra@verified"]);
      expect(walkSnapshot(fixture.root)).toEqual(before);

      phase = "status-failed";
      const failed = await runCodexSetup({
        ...fixture.opts,
        action: "repair",
        mode: "plugin",
        host,
      });
      expect(failed.ok).toBe(false);
      expect(calls.at(-1)).toEqual(["codex", "plugin", "get", "penumbra@verified"]);
      expect(walkSnapshot(fixture.root)).toEqual(before);

      phase = "repair-install";
      const unconfirmed = await runCodexSetup({
        ...fixture.opts,
        action: "repair",
        mode: "plugin",
        host,
      });
      expect(unconfirmed.ok).toBe(false);
      expect(unconfirmed.changed).toBe(false);
      expect(calls.slice(-2)).toEqual([
        ["codex", "plugin", "get", "penumbra@verified"],
        ["codex", "plugin", "install", "penumbra@verified"],
      ]);
      expect(walkSnapshot(fixture.root)).toEqual(before);
    } finally {
      cleanup(fixture);
    }
  }
});

test("mode switch conflicts until explicit uninstall", async () => {
  const fixture = makeFixture();
  try {
    await runCodexSetup(fixture.opts);
    const before = walkSnapshot(fixture.root);
    const switched = await runCodexSetup({ ...fixture.opts, mode: "plugin" });
    expect(switched.ok).toBe(false);
    expect(switched.components.skills.state).toBe("conflict");
    expect(walkSnapshot(fixture.root)).toEqual(before);

    const removed = await runCodexSetup({ ...fixture.opts, action: "uninstall" });
    expect(removed.ok).toBe(true);
    expect(removed.changed).toBe(true);
    const unavailable = await runCodexSetup({ ...fixture.opts, mode: "plugin" });
    expect(unavailable.components.skills.state).toBe("unavailable");
  } finally {
    cleanup(fixture);
  }
});

test("live and dangling destination leaf symlinks do not change outside canaries", async () => {
  for (const dangling of [false, true]) {
    const fixture = makeFixture(`codex-setup-leaf-${String(dangling)}-`);
    try {
      mkdirSync(join(fixture.skillsDir, "penumbra-memory"), { recursive: true });
      const canary = join(fixture.root, dangling ? "missing-canary" : "canary");
      if (!dangling) writeFileSync(canary, "safe\n");
      symlinkSync(canary, join(fixture.skillsDir, "penumbra-memory", "SKILL.md"));
      const before = walkSnapshot(fixture.root);

      const result = await runCodexSetup(fixture.opts);

      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(walkSnapshot(fixture.root)).toEqual(before);
      if (!dangling) expect(readFileSync(canary, "utf8")).toBe("safe\n");
      else expect(existsSync(canary)).toBe(false);
      expect(existsSync(join(fixture.codexDir, "penumbra", "installation.json"))).toBe(false);
    } finally {
      cleanup(fixture);
    }
  }
});

test("a symlinked destination ancestor aborts before writes and preserves its canary", async () => {
  const fixture = makeFixture();
  try {
    const outside = join(fixture.root, "outside");
    mkdirSync(outside);
    const canary = join(outside, "canary");
    writeFileSync(canary, "safe\n");
    symlinkSync(outside, fixture.skillsDir);
    const before = walkSnapshot(fixture.root);

    const result = await runCodexSetup(fixture.opts);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(walkSnapshot(fixture.root)).toEqual(before);
    expect(readFileSync(canary, "utf8")).toBe("safe\n");
    expect(existsSync(join(fixture.codexDir, "penumbra", "installation.json"))).toBe(false);
  } finally {
    cleanup(fixture);
  }
});

test("spaces and quote dollar backtick characters remain literal in an alternate Codex home", async () => {
  const fixture = makeFixture("codex setup '$` literal -");
  try {
    const result = await runCodexSetup(fixture.opts);
    expect(result.ok).toBe(true);
    const parsed = Bun.TOML.parse(
      readFileSync(join(fixture.codexDir, "config.toml"), "utf8"),
    ) as unknown as ParsedConfig;
    expect(parsed.mcp_servers.penumbra.args[0]).toBe(fixture.mcpEntrypoint);
    expect(parsed.mcp_servers.penumbra.env.PENUMBRA_STORAGE_ROOT).toBe(fixture.storageRoot);
    expect(manifest(fixture).codexDir).toBe(fixture.codexDir);
  } finally {
    cleanup(fixture);
  }
});

test("malformed or conflicting MCP config aborts before any write", async () => {
  for (const config of [
    "[broken\nvalue = 1\n",
    '[mcp_servers.penumbra]\ncommand = "user"\n',
    '[mcp_servers.penumbra]\ncommand = "one"\n\n[mcp_servers.penumbra]\ncommand = "two"\n',
    "# penumbra: managed [mcp_servers.penumbra] block - do not edit between markers\n",
  ]) {
    const fixture = makeFixture("codex-setup-invalid-");
    try {
      mkdirSync(fixture.codexDir);
      writeFileSync(join(fixture.codexDir, "config.toml"), config);
      const before = walkSnapshot(fixture.root);
      const result = await runCodexSetup(fixture.opts);
      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(result.components.mcp.state).toBe("conflict");
      expect(walkSnapshot(fixture.root)).toEqual(before);
      expect(existsSync(join(fixture.codexDir, "penumbra", "installation.json"))).toBe(false);
    } finally {
      cleanup(fixture);
    }
  }
});

test("tampered ownership destinations abort before uninstalling any artifact", async () => {
  const fixture = makeFixture();
  try {
    await runCodexSetup(fixture.opts);
    const ownershipPath = join(fixture.codexDir, "penumbra", "installation.json");
    const owned = manifest(fixture);
    const canary = join(fixture.root, "outside-canary");
    writeFileSync(canary, "safe\n");
    const firstSkill = owned.skills[0];
    const firstArtifact = firstSkill?.artifacts[0];
    if (!firstSkill || !firstArtifact) throw new Error("fixture ownership is incomplete");
    firstSkill.destination = fixture.root;
    firstArtifact.path = "outside-canary";
    writeFileSync(ownershipPath, `${JSON.stringify(owned, null, 2)}\n`);
    const before = walkSnapshot(fixture.root);

    const result = await runCodexSetup({ ...fixture.opts, action: "uninstall" });

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(readFileSync(canary, "utf8")).toBe("safe\n");
    expect(walkSnapshot(fixture.root)).toEqual(before);
  } finally {
    cleanup(fixture);
  }
});

test("readonly destination fails closed without an ownership record", async () => {
  const fixture = makeFixture();
  try {
    mkdirSync(fixture.codexDir);
    chmodSync(fixture.codexDir, 0o500);
    const result = await runCodexSetup(fixture.opts);
    chmodSync(fixture.codexDir, 0o700);
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.reason).toContain("EACCES");
    expect(existsSync(join(fixture.codexDir, "penumbra", "installation.json"))).toBe(false);
  } finally {
    try {
      chmodSync(fixture.codexDir, 0o700);
    } catch {
      // The negative fixture may already have been removed.
    }
    cleanup(fixture);
  }
});

test("source package symlinks and invalid or duplicate skill names abort before writes", async () => {
  for (const mutate of [
    (fixture: Fixture): void => {
      symlinkSync(
        join(fixture.root, "mcp entrypoint.ts"),
        join(fixture.packageDir, "skills", "penumbra-memory", "credential"),
      );
    },
    (fixture: Fixture): void => {
      writeSkill(fixture.packageDir, "not-penumbra", "# invalid\n");
    },
    (fixture: Fixture): void => {
      const path = join(fixture.packageDir, "skills", "penumbra-plan", "SKILL.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("penumbra-plan", "penumbra-memory"));
    },
  ]) {
    const fixture = makeFixture("codex-setup-source-");
    try {
      mutate(fixture);
      const before = walkSnapshot(fixture.root);
      const result = await runCodexSetup(fixture.opts);
      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(walkSnapshot(fixture.root)).toEqual(before);
      expect(existsSync(fixture.skillsDir)).toBe(false);
      expect(existsSync(join(fixture.codexDir, "penumbra", "installation.json"))).toBe(false);
    } finally {
      cleanup(fixture);
    }
  }
});
