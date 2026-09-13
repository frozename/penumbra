import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { fileURLToPath } from "node:url";

interface CliFixture {
  root: string;
  home: string;
  codexDir: string;
  skillsDir: string;
  storageRoot: string;
  claudeDir: string;
  agentchatConfig: string;
}

interface CliResult {
  exit: number;
  stdout: string;
  stderr: string;
}

interface SetupJson {
  ok: boolean;
  changed: boolean;
  components: {
    mcp: { state: string };
    skills: { state: string };
    hooks: { state: string };
  };
}

const CLI_PATH = fileURLToPath(new URL("../../bin/penumbra.ts", import.meta.url));

function makeFixture(prefix = "codex-setup-cli-"): CliFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return {
    root,
    home: join(root, "home"),
    codexDir: join(root, "codex"),
    skillsDir: join(root, "skills"),
    storageRoot: join(root, "storage"),
    claudeDir: join(root, "claude"),
    agentchatConfig: join(root, "agentchat.yaml"),
  };
}

async function runCli(fixture: CliFixture, args: string[]): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    env: {
      PATH: `${join(fixture.root, "bin")}:${process.env.PATH ?? ""}`,
      HOME: fixture.home,
      CODEX_HOME: fixture.codexDir,
      AGENTCHAT_CONFIG: fixture.agentchatConfig,
      PENUMBRA_STORAGE_ROOT: fixture.storageRoot,
      PENUMBRA_CLAUDE_USER_DIR: fixture.claudeDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const streams = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exit = await child.exited;
  const [stdout, stderr] = await streams;
  return { exit, stdout, stderr };
}

function writeCapabilityInputs(
  fixture: CliFixture,
  observedAt = "2026-09-12T12:00:00.000Z",
): string {
  const binDir = join(fixture.root, "bin");
  mkdirSync(binDir, { recursive: true });
  const codex = join(binDir, "codex");
  writeFileSync(
    codex,
    '#!/bin/sh\n[ "$1" = "--version" ] || exit 2\nprintf "codex-cli 0.153.4\\n"\n',
  );
  chmodSync(codex, 0o700);
  const reportPath = join(fixture.root, "capability report.json");
  const input = {
    session_id: "probe-root",
    transcript_path: null,
    cwd: join(fixture.root, "probe project"),
    hook_event_name: "SessionStart",
    model: "gpt-5.6-sol",
    permission_mode: "default",
    source: "startup",
  };
  writeFileSync(
    reportPath,
    `${JSON.stringify({
      surface: "cli",
      build: "0.153.4",
      cases: [
        {
          fixture: {
            surface: "cli",
            build: "0.153.4",
            capability: "SessionStart",
            state: "supported",
            evidence: {
              kind: "live",
              surface: "cli",
              source: "isolated-codex-capability-probe",
              observedAt,
              probeId: "isolated-cli-SessionStart-startup",
            },
            input,
            identity: {
              role: "root",
              sessionId: input.session_id,
              projectCwd: input.cwd,
              agentId: null,
            },
          },
          reason: null,
          scenario: "startup",
        },
      ],
      cleanupComplete: true,
    })}\n`,
  );
  return reportPath;
}

function capabilityArgs(reportPath: string): string[] {
  return ["--capability-report", reportPath];
}

function setupArgs(
  fixture: CliFixture,
  action: "install" | "status" | "repair" | "uninstall",
  mode = "standalone",
): string[] {
  return [
    "codex-setup",
    action,
    "--codex-dir",
    fixture.codexDir,
    "--skills-dir",
    fixture.skillsDir,
    "--mode",
    mode,
    "--json",
  ];
}

function parseSetupJson(result: CliResult): SetupJson {
  return JSON.parse(result.stdout) as SetupJson;
}

function expectNoSharedState(fixture: CliFixture): void {
  expect(existsSync(fixture.storageRoot)).toBe(false);
  expect(existsSync(fixture.agentchatConfig)).toBe(false);
  expect(existsSync(fixture.claudeDir)).toBe(false);
}

test("invalid harness is rejected before storage or user setup", async () => {
  const fixture = makeFixture("codex-init-cli-");
  try {
    const result = await runCli(fixture, ["init", "--harness", "invalid-harness"]);
    expect(result.exit).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("harness");
    expectNoSharedState(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("default init preserves token idempotency and Claude integration", async () => {
  const fixture = makeFixture("codex-init-default-");
  try {
    const first = await runCli(fixture, ["init"]);
    expect(first.exit).toBe(0);
    const token = readFileSync(join(fixture.storageRoot, "token"), "utf8");
    expect(existsSync(join(fixture.storageRoot, "db.sqlite"))).toBe(true);
    expect(existsSync(fixture.agentchatConfig)).toBe(true);
    expect(readFileSync(join(fixture.claudeDir, "CLAUDE.md"), "utf8")).toContain(
      "managed [dispatch-discipline] block",
    );

    const second = await runCli(fixture, ["init"]);
    expect(second.exit).toBe(0);
    expect(readFileSync(join(fixture.storageRoot, "token"), "utf8")).toBe(token);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("explicit Codex standalone init keeps shared bootstrap and skips Claude integration", async () => {
  const fixture = makeFixture("codex-init-standalone-");
  try {
    const result = await runCli(fixture, [
      "init",
      "--harness",
      "codex",
      "--codex-dir",
      fixture.codexDir,
      "--skills-dir",
      fixture.skillsDir,
      "--codex-mode",
      "standalone",
    ]);
    expect(result.exit).toBe(0);
    expect(existsSync(join(fixture.storageRoot, "token"))).toBe(true);
    expect(existsSync(join(fixture.storageRoot, "db.sqlite"))).toBe(true);
    expect(existsSync(fixture.agentchatConfig)).toBe(true);
    expect(existsSync(join(fixture.codexDir, "config.toml"))).toBe(true);
    expect(existsSync(join(fixture.codexDir, "penumbra", "installation.json"))).toBe(true);
    expect(existsSync(join(fixture.skillsDir, "penumbra-memory", "SKILL.md"))).toBe(true);
    expect(existsSync(join(fixture.claudeDir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(fixture.claudeDir, "workflows"))).toBe(false);
    expect(existsSync(join(fixture.claudeDir, "settings.json"))).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("codex-setup consumes the bare producer report and binds it to the observed CLI build", async () => {
  const fixture = makeFixture("codex setup report spaces ");
  try {
    const reportPath = writeCapabilityInputs(fixture);
    const result = await runCli(fixture, [
      ...setupArgs(fixture, "install"),
      ...capabilityArgs(reportPath),
    ]);

    expect(result.exit).toBe(0);
    expect(parseSetupJson(result).components.hooks.state).toBe("installed");
    const hooks = JSON.parse(readFileSync(join(fixture.codexDir, "hooks.json"), "utf8")) as {
      hooks: { SessionStart: { matcher: string }[] };
    };
    expect(hooks.hooks.SessionStart.map(({ matcher }) => matcher)).toEqual(["^startup$"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Codex init consumes the bare producer report through the same bounded build observation", async () => {
  const fixture = makeFixture("codex init report spaces ");
  try {
    const reportPath = writeCapabilityInputs(fixture);
    const result = await runCli(fixture, [
      "init",
      "--harness",
      "codex",
      "--codex-dir",
      fixture.codexDir,
      "--skills-dir",
      fixture.skillsDir,
      "--codex-mode",
      "standalone",
      ...capabilityArgs(reportPath),
    ]);

    expect(result.exit).toBe(0);
    const setup = JSON.parse(
      result.stdout.split("\n").find((line) => line.startsWith("{")) ?? "",
    ) as SetupJson | undefined;
    expect(setup?.components.hooks.state).toBe("installed");
    expect(existsSync(join(fixture.codexDir, "hooks.json"))).toBe(true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("malformed capability evidence is rejected before Codex init bootstrap writes", async () => {
  const fixture = makeFixture("codex-init-malformed-report-");
  try {
    const reportPath = writeCapabilityInputs(fixture, "not-a-date");
    const result = await runCli(fixture, [
      "init",
      "--harness",
      "codex",
      "--codex-dir",
      fixture.codexDir,
      "--skills-dir",
      fixture.skillsDir,
      "--codex-mode",
      "standalone",
      ...capabilityArgs(reportPath),
    ]);

    expect(result.exit).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("observedAt");
    expectNoSharedState(fixture);
    expect(existsSync(fixture.codexDir)).toBe(false);
    expect(existsSync(fixture.skillsDir)).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("status on an absent profile has no bootstrap or setup side effects", async () => {
  const fixture = makeFixture("codex-status-cli-");
  try {
    const result = await runCli(fixture, setupArgs(fixture, "status"));
    expect(result.exit).toBe(0);
    const report = parseSetupJson(result);
    expect(report.ok).toBe(true);
    expect(report.changed).toBe(false);
    expect(report.components.mcp.state).toBe("absent");
    expect(report.components.skills.state).toBe("absent");
    expectNoSharedState(fixture);
    expect(existsSync(fixture.codexDir)).toBe(false);
    expect(existsSync(fixture.skillsDir)).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a second standalone install is idempotent", async () => {
  const fixture = makeFixture();
  try {
    const first = await runCli(fixture, setupArgs(fixture, "install"));
    const second = await runCli(fixture, setupArgs(fixture, "install"));
    expect(first.exit).toBe(0);
    expect(parseSetupJson(first).changed).toBe(true);
    expect(second.exit).toBe(0);
    expect(parseSetupJson(second).changed).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("repair and uninstall delegate actions and preserve unrelated files", async () => {
  const fixture = makeFixture("codex-lifecycle-cli-");
  try {
    expect((await runCli(fixture, setupArgs(fixture, "install"))).exit).toBe(0);
    const ownedSkill = join(fixture.skillsDir, "penumbra-memory", "SKILL.md");
    unlinkSync(ownedSkill);
    const unrelated = join(fixture.skillsDir, "unrelated", "keep.txt");
    mkdirSync(join(fixture.skillsDir, "unrelated"), { recursive: true });
    writeFileSync(unrelated, "keep\n");

    const repaired = await runCli(fixture, setupArgs(fixture, "repair"));
    expect(repaired.exit).toBe(0);
    expect(parseSetupJson(repaired).changed).toBe(true);
    expect(existsSync(ownedSkill)).toBe(true);

    const uninstalled = await runCli(fixture, setupArgs(fixture, "uninstall"));
    expect(uninstalled.exit).toBe(0);
    expect(parseSetupJson(uninstalled).changed).toBe(true);
    expect(existsSync(ownedSkill)).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("keep\n");
    expect(readFileSync(join(fixture.codexDir, "config.toml"), "utf8")).not.toContain(
      "mcp_servers.penumbra",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("unqualified plugin command help is unknown without standalone writes", async () => {
  const fixture = makeFixture("codex-plugin-cli-");
  try {
    const binDir = join(fixture.root, "bin");
    const codex = join(binDir, "codex");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      codex,
      `#!/bin/sh
case "$*" in
  "--version") printf "codex-cli 0.153.4\\n" ;;
  "plugin --help") printf "Usage: codex plugin <add|list|remove|marketplace>\\n"; printf "unexpected help stderr\\n" >&2 ;;
  "plugin marketplace --help") printf "Usage: codex plugin marketplace <add|list|remove>\\n" ;;
  *) exit 2 ;;
esac
`,
    );
    chmodSync(codex, 0o700);
    const result = await runCli(fixture, setupArgs(fixture, "install", "plugin"));
    expect(result.exit).not.toBe(0);
    const report = parseSetupJson(result);
    expect(report.ok).toBe(false);
    expect(report.components.skills.state).toBe("unknown");
    expect(existsSync(join(fixture.codexDir, "config.toml"))).toBe(false);
    expect(existsSync(join(fixture.codexDir, "penumbra", "installation.json"))).toBe(false);
    expect(existsSync(fixture.skillsDir)).toBe(false);
    expectNoSharedState(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("invalid modes are rejected before bootstrap or setup", async () => {
  const initFixture = makeFixture("codex-invalid-init-mode-");
  const setupFixture = makeFixture("codex-invalid-setup-mode-");
  try {
    const init = await runCli(initFixture, [
      "init",
      "--harness",
      "codex",
      "--codex-mode",
      "invalid-mode",
    ]);
    expect(init.exit).not.toBe(0);
    expect(init.stdout + init.stderr).toContain("mode");
    expectNoSharedState(initFixture);

    const setup = await runCli(setupFixture, setupArgs(setupFixture, "install", "invalid-mode"));
    expect(setup.exit).not.toBe(0);
    expect(setup.stdout + setup.stderr).toContain("mode");
    expectNoSharedState(setupFixture);
    expect(existsSync(setupFixture.codexDir)).toBe(false);
    expect(existsSync(setupFixture.skillsDir)).toBe(false);
  } finally {
    rmSync(initFixture.root, { recursive: true, force: true });
    rmSync(setupFixture.root, { recursive: true, force: true });
  }
});

test("missing mode requires explicit standalone selection", async () => {
  const fixture = makeFixture("codex-missing-mode-");
  try {
    const result = await runCli(fixture, [
      "codex-setup",
      "install",
      "--codex-dir",
      fixture.codexDir,
      "--skills-dir",
      fixture.skillsDir,
      "--json",
    ]);
    expect(result.exit).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("--mode standalone");
    expectNoSharedState(fixture);
    expect(existsSync(fixture.codexDir)).toBe(false);
    expect(existsSync(fixture.skillsDir)).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("missing option values and relative paths fail before any writes", async () => {
  const missingFixture = makeFixture("codex-missing-value-");
  const relativeFixture = makeFixture("codex-relative-path-");
  try {
    const missing = await runCli(missingFixture, [
      "codex-setup",
      "install",
      "--mode",
      "standalone",
      "--codex-dir",
      "--skills-dir",
      missingFixture.skillsDir,
      "--json",
    ]);
    expect(missing.exit).not.toBe(0);
    expect(missing.stdout + missing.stderr).toContain("--codex-dir");
    expectNoSharedState(missingFixture);
    expect(existsSync(missingFixture.codexDir)).toBe(false);
    expect(existsSync(missingFixture.skillsDir)).toBe(false);

    const relative = await runCli(relativeFixture, [
      "init",
      "--harness",
      "codex",
      "--codex-mode",
      "standalone",
      "--codex-dir",
      "relative-codex",
      "--skills-dir",
      relativeFixture.skillsDir,
    ]);
    expect(relative.exit).not.toBe(0);
    expect(relative.stdout + relative.stderr).toContain("absolute");
    expectNoSharedState(relativeFixture);
    expect(existsSync(relativeFixture.codexDir)).toBe(false);
    expect(existsSync(relativeFixture.skillsDir)).toBe(false);
  } finally {
    rmSync(missingFixture.root, { recursive: true, force: true });
    rmSync(relativeFixture.root, { recursive: true, force: true });
  }
});

test("paths containing spaces remain literal", async () => {
  const fixture = makeFixture("codex setup cli spaces ");
  try {
    const result = await runCli(fixture, setupArgs(fixture, "install"));
    expect(result.exit).toBe(0);
    const config = readFileSync(join(fixture.codexDir, "config.toml"), "utf8");
    const manifest = readFileSync(join(fixture.codexDir, "penumbra", "installation.json"), "utf8");
    expect(config).toContain(JSON.stringify(fixture.storageRoot));
    expect(manifest).toContain(fixture.codexDir);
    expect(manifest).toContain(fixture.skillsDir);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a changed owned skill conflicts without overwrite", async () => {
  const fixture = makeFixture("codex-conflict-cli-");
  try {
    expect((await runCli(fixture, setupArgs(fixture, "install"))).exit).toBe(0);
    const skillPath = join(fixture.skillsDir, "penumbra-memory", "SKILL.md");
    writeFileSync(skillPath, "user edit\n");
    const result = await runCli(fixture, setupArgs(fixture, "install"));
    expect(result.exit).not.toBe(0);
    const report = parseSetupJson(result);
    expect(report.components.skills.state).toBe("conflict");
    expect(readFileSync(skillPath, "utf8")).toBe("user edit\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const target of ["codex", "skills"] as const) {
  test(`an uncanonicalized symlink ${target} path fails closed`, async () => {
    const fixture = makeFixture(`codex-symlink-${target}-`);
    const actual = join(fixture.root, `actual-${target}`);
    const linked = join(fixture.root, `linked-${target}`);
    mkdirSync(actual);
    symlinkSync(actual, linked);
    if (target === "codex") fixture.codexDir = linked;
    else fixture.skillsDir = linked;
    try {
      const result = await runCli(fixture, setupArgs(fixture, "install"));
      expect(result.exit).not.toBe(0);
      expect(parseSetupJson(result).ok).toBe(false);
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(existsSync(join(actual, "config.toml"))).toBe(false);
      expect(existsSync(join(actual, "penumbra-memory"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}
