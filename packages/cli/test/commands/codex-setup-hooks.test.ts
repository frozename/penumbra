import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { observeCodexBuild } from "@src/commands/codex-hook-capabilities.js";
import { buildCodexHookPlan } from "@src/commands/codex-setup-hooks.js";

const COMMAND =
  "'/Applications/Bun Runtime/bin/bun' '/Volumes/Work SSD/penumbra.ts' hook codex --storage-root '/Volumes/Work SSD/storage'";
const BUILD = "0.153.4";

function hookInput(
  capability: "SessionStart" | "PreToolUse" | "Stop",
  scenario: "startup" | "mcp" | "stop",
): Record<string, unknown> {
  const common = {
    session_id: "session-probe",
    transcript_path: null,
    cwd: "/private/tmp/codex-probe/project",
    hook_event_name: capability,
    model: "gpt-5.6-sol",
    permission_mode: "default",
  };
  if (capability === "SessionStart") return { ...common, source: scenario };
  if (capability === "PreToolUse") {
    return {
      ...common,
      turn_id: "turn-mcp",
      tool_name: "mcp__fixture__read",
      tool_use_id: "tool-mcp",
      tool_input: { path: "/tmp/input" },
    };
  }
  return { ...common, turn_id: "turn-stop", stop_hook_active: false };
}

function supportedCase(
  capability: "SessionStart" | "PreToolUse" | "Stop",
  scenario: "startup" | "mcp" | "stop",
): Record<string, unknown> {
  const input = hookInput(capability, scenario);
  return {
    fixture: {
      surface: "cli",
      build: BUILD,
      capability,
      state: "supported",
      evidence: {
        kind: "live",
        surface: "cli",
        source: "isolated-codex-capability-probe",
        observedAt: "2026-09-12T12:00:00.000Z",
        probeId: `isolated-cli-${capability}-${scenario}`,
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
    scenario,
  };
}

function bareReport(cases: Record<string, unknown>[]): Record<string, unknown> {
  return { surface: "cli", build: BUILD, cases, cleanupComplete: true };
}

function plan(report: unknown, observedBuild = BUILD): ReturnType<typeof buildCodexHookPlan> {
  return buildCodexHookPlan({
    manifest: report,
    command: COMMAND,
    observedBuild,
  });
}

async function observeBuildError(argv: readonly string[]): Promise<Error> {
  let caught: unknown;
  try {
    await observeCodexBuild(argv);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

test("the bare producer report installs each qualified scenario without broad siblings", () => {
  const result = plan(
    bareReport([
      supportedCase("SessionStart", "startup"),
      supportedCase("PreToolUse", "mcp"),
      supportedCase("Stop", "stop"),
    ]),
  );

  expect(result.state).toBe("installed");
  expect(result.detail).toContain("3");
  expect(result.hooks.SessionStart?.map((group) => group.matcher)).toEqual(["^startup$"]);
  expect(result.hooks.PreToolUse?.map((group) => group.matcher)).toEqual(["^mcp__fixture__read$"]);
  expect(result.hooks.Stop?.[0]?.matcher).toBeUndefined();
  expect(result.hooks.PostToolUse).toBeUndefined();
  const handlers = Object.values(result.hooks).flatMap((groups) =>
    groups.flatMap((group) => group.hooks),
  );
  expect(handlers).toHaveLength(3);
  expect(new Set(handlers.map((handler) => handler.command))).toEqual(new Set([COMMAND]));
});

test("stale target builds and rows without validated observed input install none", () => {
  const supported = supportedCase("SessionStart", "startup");
  const withoutInput = structuredClone(supported);
  const fixture = withoutInput.fixture as Record<string, unknown>;
  delete fixture.input;

  const stale = plan(bareReport([supported]), "0.153.5");
  const missing = plan(bareReport([withoutInput]));

  expect(stale.state).toBe("unavailable");
  expect(stale.detail).toContain("does not match observed Codex CLI build");
  expect(stale.hooks).toEqual({});
  expect(missing.state).toBe("unavailable");
  expect(missing.detail).toContain("validated event input");
  expect(missing.hooks).toEqual({});
});

test("malformed dates and mismatched scenario, session, project, child, tool, or source fail closed", () => {
  const mutations: [string, (row: Record<string, unknown>) => void][] = [
    [
      "observedAt",
      (row): void => {
        const fixture = row.fixture as Record<string, unknown>;
        (fixture.evidence as Record<string, unknown>).observedAt = "09/12/2026";
      },
    ],
    [
      "scenario",
      (row): void => {
        row.scenario = "resume";
      },
    ],
    [
      "session identity",
      (row): void => {
        const fixture = row.fixture as Record<string, unknown>;
        (fixture.identity as Record<string, unknown>).sessionId = "different-session";
      },
    ],
    [
      "project identity",
      (row): void => {
        const fixture = row.fixture as Record<string, unknown>;
        (fixture.identity as Record<string, unknown>).projectCwd = "/different-project";
      },
    ],
    [
      "probe identity",
      (row): void => {
        const fixture = row.fixture as Record<string, unknown>;
        (fixture.evidence as Record<string, unknown>).probeId = "isolated-cli-Stop-stop";
      },
    ],
  ];
  for (const [reason, mutate] of mutations) {
    const row = supportedCase("SessionStart", "startup");
    mutate(row);
    expect(plan(bareReport([row])).hooks, reason).toEqual({});
  }

  const tool = supportedCase("PreToolUse", "mcp");
  ((tool.fixture as Record<string, unknown>).input as Record<string, unknown>).tool_name =
    "write_stdin";
  expect(plan(bareReport([tool])).hooks).toEqual({});

  const source = supportedCase("SessionStart", "startup");
  ((source.fixture as Record<string, unknown>).input as Record<string, unknown>).source = "resume";
  expect(plan(bareReport([source])).hooks).toEqual({});

  const child = supportedCase("Stop", "stop");
  const childFixture = child.fixture as Record<string, unknown>;
  childFixture.capability = "SubagentStart";
  child.scenario = "child_start";
  childFixture.identity = {
    role: "child",
    sessionId: "session-probe",
    projectCwd: "/private/tmp/codex-probe/project",
    agentId: "agent-child",
  };
  const childInput = childFixture.input as Record<string, unknown>;
  childInput.hook_event_name = "SubagentStart";
  childInput.agent_id = "different-child";
  childInput.agent_type = "worker";
  expect(plan(bareReport([child])).hooks).toEqual({});
});

test("contract-only, unknown, desktop, incomplete cleanup, and deferred completion install none", () => {
  const variants = [
    ((): Record<string, unknown> => {
      const row = supportedCase("Stop", "stop");
      const fixture = row.fixture as Record<string, unknown>;
      fixture.state = "unknown";
      (fixture.evidence as Record<string, unknown>).kind = "contract";
      (fixture.evidence as Record<string, unknown>).probeId = null;
      row.reason = "probe_timeout";
      return bareReport([row]);
    })(),
    { ...bareReport([supportedCase("Stop", "stop")]), surface: "desktop" },
    { ...bareReport([supportedCase("Stop", "stop")]), cleanupComplete: false },
    ((): Record<string, unknown> => {
      const row = supportedCase("PreToolUse", "mcp");
      const fixture = row.fixture as Record<string, unknown>;
      fixture.capability = "PostToolUse";
      row.scenario = "deferred_bash_completion";
      const input = fixture.input as Record<string, unknown>;
      input.hook_event_name = "PostToolUse";
      input.tool_name = "Bash";
      input.tool_response = { exit_code: 0 };
      return bareReport([row]);
    })(),
  ];

  for (const report of variants) expect(plan(report).hooks).toEqual({});
});

test("the shipped hook definition remains inactive without a qualified report", () => {
  const source = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../plugin/codex/penumbra/hooks/hooks.json"),
      "utf8",
    ),
  ) as { description: string; hooks: Record<string, unknown> };
  const result = buildCodexHookPlan({ manifest: undefined, command: COMMAND });

  expect(source.description).toContain("probe-qualified");
  expect(source.hooks).toEqual({});
  expect(result.state).toBe("unavailable");
  expect(result.hooks).toEqual({});
});

test("the production build observer enforces its deadline when the child ignores SIGTERM", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "penumbra-codex-version-timeout-"));
  const childPath = join(fixtureDir, "ignore-term.ts");
  writeFileSync(
    childPath,
    ['process.on("SIGTERM", () => {});', "setTimeout(() => process.exit(0), 3_500);"].join("\n"),
  );

  try {
    const startedAt = performance.now();
    const error = await observeBuildError([process.execPath, childPath]);
    const elapsedMs = performance.now() - startedAt;
    expect(error.message).toBe("Codex version observation timed out");
    expect(elapsedMs).toBeGreaterThanOrEqual(1_750);
    expect(elapsedMs).toBeLessThan(3_000);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("the production build observer does not wait for pipes inherited by a descendant", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "penumbra-codex-version-pipes-"));
  const descendantPath = join(fixtureDir, "pipe-holder.ts");
  const parentPath = join(fixtureDir, "exited-parent.ts");
  const descendantPidPath = join(fixtureDir, "descendant.pid");
  writeFileSync(descendantPath, "setTimeout(() => process.exit(0), 3_500);\n");
  writeFileSync(
    parentPath,
    [
      'import { writeFileSync } from "node:fs";',
      "const descendant = Bun.spawn([process.execPath, Bun.argv[2]], {",
      '  stdin: "ignore",',
      '  stdout: "inherit",',
      '  stderr: "inherit",',
      "});",
      "writeFileSync(Bun.argv[3], String(descendant.pid));",
      "process.exit(0);",
    ].join("\n"),
  );

  let descendantPid: number | null = null;
  try {
    const startedAt = performance.now();
    const error = await observeBuildError([
      process.execPath,
      parentPath,
      descendantPath,
      descendantPidPath,
    ]);
    const elapsedMs = performance.now() - startedAt;
    expect(error.message).toBe("Codex version observation timed out");
    expect(elapsedMs).toBeGreaterThanOrEqual(1_750);
    expect(elapsedMs).toBeLessThan(3_000);
    descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
  } finally {
    if (descendantPid) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Cleanup may race with the descendant's self-exit safeguard.
      }
    }
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("the production build observer reaps a child after bounded output overflows", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "penumbra-codex-version-overflow-"));
  const childPath = join(fixtureDir, "overflow.ts");
  const childPidPath = join(fixtureDir, "child.pid");
  writeFileSync(
    childPath,
    [
      'import { writeFileSync } from "node:fs";',
      "writeFileSync(Bun.argv[2], String(process.pid));",
      'process.on("SIGTERM", () => {});',
      'process.stdout.write("x".repeat(65 * 1_024));',
      "setTimeout(() => process.exit(0), 3_500);",
    ].join("\n"),
  );

  let childPid: number | null = null;
  try {
    const error = await observeBuildError([process.execPath, childPath, childPidPath]);
    expect(error.message).toBe("Codex version output exceeded the bounded limit");
    childPid = Number(readFileSync(childPidPath, "utf8"));
    expect(() => process.kill(childPid!, 0)).toThrow();
  } finally {
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Cleanup may race with observer reaping.
      }
    }
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
