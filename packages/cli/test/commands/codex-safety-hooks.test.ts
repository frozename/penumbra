import { assertHookOutput } from "@harness-parity/capability-contract.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeCodexGuardInput, runCodexSafetyHook } from "@src/commands/codex-safety-hook.js";

interface CliResult {
  exit: number;
  stdout: string;
  stderr: string;
}

const CLI_PATH = fileURLToPath(new URL("../../bin/penumbra.ts", import.meta.url));
const CC_GUARD_PATH = fileURLToPath(
  new URL("../../../../docs/cc-setup/hooks/penumbra-agent-gc-guard.sh", import.meta.url),
);
const PACKAGED_GUARD_PATH = fileURLToPath(
  new URL("../../../../plugin/codex/penumbra/hooks/penumbra-agent-gc-guard.sh", import.meta.url),
);

function run(argv: string[], cwd?: string): string {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${argv.join(" ")} failed (${String(result.exitCode)}): ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

function rawPreToolUse(toolName: string, toolInput: Record<string, unknown>, cwd: string): string {
  return JSON.stringify({
    session_id: "codex-safety-test",
    transcript_path: null,
    cwd,
    hook_event_name: "PreToolUse",
    model: "gpt-5.6-codex",
    permission_mode: "default",
    turn_id: "turn-1",
    tool_name: toolName,
    tool_use_id: "tool-1",
    tool_input: toolInput,
  });
}

function makeRepo(): { root: string; branch: string; originalRef: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "codex safety repo "));
  const branch = "feat/unlanded-safety-test";
  run(["git", "init", "-q", "-b", "main", root]);
  run(["git", "config", "user.email", "test@example.invalid"], root);
  run(["git", "config", "user.name", "Test User"], root);
  writeFileSync(join(root, "base.txt"), "base\n");
  run(["git", "add", "base.txt"], root);
  run(["git", "commit", "-q", "-m", "base"], root);
  run(["git", "checkout", "-q", "-b", branch], root);
  writeFileSync(join(root, "unlanded.txt"), "unlanded\n");
  run(["git", "add", "unlanded.txt"], root);
  run(["git", "commit", "-q", "-m", "unlanded"], root);
  const originalRef = run(["git", "rev-parse", branch], root);
  run(["git", "checkout", "-q", "main"], root);

  const dbPath = join(root, "state", "db.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.run("CREATE TABLE handoffs (handoff_id TEXT, branch_name TEXT)");
  db.run("INSERT INTO handoffs VALUES (?, ?)", ["handoff-1", branch]);
  db.close();
  return { root, branch, originalRef, dbPath };
}

async function runCliArgs(
  args: string[],
  rawEvent: string,
  env?: NodeJS.ProcessEnv,
): Promise<CliResult> {
  const profileRoot = mkdtempSync(join(tmpdir(), "codex safety cli profile "));
  try {
    const childEnv = Object.fromEntries(
      Object.entries({
        ...process.env,
        HOME: profileRoot,
        XDG_CONFIG_HOME: join(profileRoot, "config"),
        PENUMBRA_CONFIG_DIR: join(profileRoot, "config", "penumbra"),
        PENUMBRA_DB: undefined,
        PENUMBRA_STORAGE_ROOT: join(profileRoot, "storage"),
        ...env,
      }).filter((entry) => entry[1] !== undefined),
    ) as NodeJS.ProcessEnv;
    const child = Bun.spawn([process.execPath, CLI_PATH, ...args], {
      env: childEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.stdin.write(rawEvent);
    await child.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  } finally {
    rmSync(profileRoot, { recursive: true, force: true });
  }
}

async function runCli(opts: {
  rawEvent: string;
  guardPath: string;
  sentinelPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CliResult> {
  return await runCliArgs(
    ["hook", "codex-safety", "--guard-path", opts.guardPath, "--sentinel-path", opts.sentinelPath],
    opts.rawEvent,
    opts.env,
  );
}

function parsedOutput(result: CliResult): Record<string, unknown> {
  const lines = result.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  const output = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  assertHookOutput("PreToolUse", output);
  return output;
}

function writeCaptureGuard(root: string): {
  guardPath: string;
  capturePath: string;
  sentinelCapturePath: string;
} {
  const guardPath = join(root, "managed hook", "guard script.sh");
  const capturePath = join(root, "captured input.json");
  const sentinelCapturePath = join(root, "captured sentinel.txt");
  mkdirSync(dirname(guardPath), { recursive: true });
  writeFileSync(
    guardPath,
    [
      "#!/usr/bin/env bash",
      "set -u",
      'input="$(cat)"',
      'printf "%s" "$input" > "$PENUMBRA_TEST_CAPTURE_PATH"',
      'printf "%s" "$PENUMBRA_ALLOW_AGENT_GC_SENTINEL" > "$PENUMBRA_TEST_SENTINEL_CAPTURE_PATH"',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(guardPath, 0o700);
  return { guardPath, capturePath, sentinelCapturePath };
}

function writeProcessGuard(root: string, name: string, lines: string[]): string {
  const guardPath = join(root, name);
  writeFileSync(guardPath, ["#!/usr/bin/env bash", ...lines, ""].join("\n"));
  chmodSync(guardPath, 0o700);
  return guardPath;
}

function writeDbCaptureGuard(root: string): { guardPath: string; capturePath: string } {
  const capturePath = join(root, "captured-db-path.txt");
  const guardPath = writeProcessGuard(root, "db-capture-guard.sh", [
    'printf "%s" "${PENUMBRA_DB:-}" > "$PENUMBRA_TEST_DB_CAPTURE_PATH"',
    'exec bash "$PENUMBRA_TEST_DELEGATE_GUARD"',
  ]);
  return { guardPath, capturePath };
}

function fixturePids(path: string): number[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function processIsRunning(pid: number): boolean {
  if (!processExists(pid)) return false;
  const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return processExists(pid);
  return !result.stdout.toString().trim().startsWith("Z");
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (processIsRunning(pid) && performance.now() < deadline) await Bun.sleep(20);
  return !processIsRunning(pid);
}

async function cleanupFixtureProcesses(pidPath: string): Promise<void> {
  const pids = fixturePids(pidPath);
  for (const pid of pids) {
    if (!processExists(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  await Promise.all(pids.map(async (pid) => await waitForProcessExit(pid)));
}

test("the packaged guard is byte-identical and semantic input maps to the existing guard contract", () => {
  expect(readFileSync(PACKAGED_GUARD_PATH)).toEqual(readFileSync(CC_GUARD_PATH));
  expect(
    normalizeCodexGuardInput({
      event: "PreToolUse",
      command: "git status",
      cwd: "/tmp/repo with spaces",
    }),
  ).toEqual({ tool_input: { command: "git status" }, cwd: "/tmp/repo with spaces" });
});

test("the real CLI maps only documented Bash and exec_command fields through argv and stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex safety mapping "));
  try {
    const capture = writeCaptureGuard(root);
    const sentinelPath = join(root, "sentinel dir", "allow file");
    for (const [toolName, toolInput, expected] of [
      ["Bash", { command: "git status" }, "git status"],
      ["exec_command", { cmd: "git branch --show-current" }, "git branch --show-current"],
    ] as const) {
      rmSync(capture.capturePath, { force: true });
      const result = await runCli({
        rawEvent: rawPreToolUse(toolName, toolInput, root),
        guardPath: capture.guardPath,
        sentinelPath,
        env: {
          PENUMBRA_TEST_CAPTURE_PATH: capture.capturePath,
          PENUMBRA_TEST_SENTINEL_CAPTURE_PATH: capture.sentinelCapturePath,
        },
      });
      expect(result.exit).toBe(0);
      expect(parsedOutput(result)).toEqual({});
      expect(JSON.parse(readFileSync(capture.capturePath, "utf8"))).toEqual({
        tool_input: { command: expected },
        cwd: root,
      });
      expect(readFileSync(capture.sentinelCapturePath, "utf8")).toBe(sentinelPath);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed and uninspectable tool inputs are explicit and never invoke the guard", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex safety unsupported "));
  try {
    const capture = writeCaptureGuard(root);
    const cases = [
      "{not-json",
      "x".repeat(256 * 1024 + 1),
      rawPreToolUse("apply_patch", { patch: "git branch -D feat/unlanded" }, root),
      rawPreToolUse("functions.exec", { code: "git branch -D feat/unlanded" }, root),
      rawPreToolUse("Bash", { cmd: "git branch -D feat/unlanded" }, root),
      rawPreToolUse("exec_command", { command: "git branch -D feat/unlanded" }, root),
    ];
    for (const rawEvent of cases) {
      rmSync(capture.capturePath, { force: true });
      const result = await runCli({
        rawEvent,
        guardPath: capture.guardPath,
        sentinelPath: join(root, "sentinel"),
        env: {
          PENUMBRA_TEST_CAPTURE_PATH: capture.capturePath,
          PENUMBRA_TEST_SENTINEL_CAPTURE_PATH: capture.sentinelCapturePath,
        },
      });
      expect(result.exit).toBe(0);
      const output = parsedOutput(result);
      expect(output.systemMessage).toContain("not inspected");
      expect(result.stderr).toContain("not inspected");
      expect(existsSync(capture.capturePath)).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner rejects relative managed paths without invoking a guard", async () => {
  const code = await runCodexSafetyHook({
    rawEvent: rawPreToolUse("Bash", { command: "git status" }, "/tmp"),
    guardPath: "relative-guard.sh",
    sentinelPath: "relative-sentinel",
  });
  expect(code).toBe(1);
});

test("the real CLI rejects relative or incomplete managed path flags", async () => {
  for (const args of [
    [
      "hook",
      "codex-safety",
      "--guard-path",
      "relative-guard.sh",
      "--sentinel-path",
      "/tmp/codex-safety-sentinel",
    ],
    ["hook", "codex-safety", "--guard-path", "/tmp/codex-safety-guard.sh"],
  ]) {
    const result = await runCliArgs(args, rawPreToolUse("Bash", { command: "git status" }, "/tmp"));
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "usage: penumbra hook codex-safety --guard-path ABS --sentinel-path ABS",
    );
  }
});

test("the real CLI preserves exact deny and allow exits without executing the raw command", async () => {
  const fixture = makeRepo();
  try {
    const sentinelPath = join(fixture.root, "managed sentinel", "allow-agent-gc");
    const deletion = `git branch -D ${fixture.branch}`;
    let fakeToolExecutions = 0;
    const denied = await runCli({
      rawEvent: rawPreToolUse("Bash", { command: deletion }, fixture.root),
      guardPath: PACKAGED_GUARD_PATH,
      sentinelPath,
      env: { PENUMBRA_DB: fixture.dbPath },
    });
    const deniedOutput = parsedOutput(denied);
    if (denied.exit === 0 && deniedOutput.decision !== "block") fakeToolExecutions += 1;
    expect(denied.exit).toBe(2);
    expect(deniedOutput.decision).toBe("block");
    expect(denied.stderr).toContain("BLOCKED: refusing to destroy UNLANDED agent work");
    expect(fakeToolExecutions).toBe(0);
    expect(run(["git", "rev-parse", fixture.branch], fixture.root)).toBe(fixture.originalRef);

    const allowed = await runCli({
      rawEvent: rawPreToolUse("exec_command", { cmd: "git status --short" }, fixture.root),
      guardPath: PACKAGED_GUARD_PATH,
      sentinelPath,
      env: { PENUMBRA_DB: fixture.dbPath },
    });
    const allowedOutput = parsedOutput(allowed);
    if (allowed.exit === 0 && allowedOutput.decision !== "block") fakeToolExecutions += 1;
    expect(allowed.exit).toBe(0);
    expect(allowedOutput).toEqual({});
    expect(fakeToolExecutions).toBe(1);
    expect(run(["git", "rev-parse", fixture.branch], fixture.root)).toBe(fixture.originalRef);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the real CLI uses its custom storage root when PENUMBRA_DB is absent", async () => {
  const fixture = makeRepo();
  try {
    const sentinelPath = join(fixture.root, "managed sentinel", "allow-agent-gc");
    const deletion = `git branch -D ${fixture.branch}`;
    const capture = writeDbCaptureGuard(fixture.root);
    const env = {
      PENUMBRA_DB: undefined,
      PENUMBRA_STORAGE_ROOT: dirname(fixture.dbPath),
      PENUMBRA_TEST_DB_CAPTURE_PATH: capture.capturePath,
      PENUMBRA_TEST_DELEGATE_GUARD: PACKAGED_GUARD_PATH,
    };
    let fakeToolExecutions = 0;

    const denied = await runCli({
      rawEvent: rawPreToolUse("Bash", { command: deletion }, fixture.root),
      guardPath: capture.guardPath,
      sentinelPath,
      env,
    });
    const deniedOutput = parsedOutput(denied);
    if (denied.exit === 0 && deniedOutput.decision !== "block") fakeToolExecutions += 1;
    expect(denied.exit).toBe(2);
    expect(deniedOutput.decision).toBe("block");
    expect(readFileSync(capture.capturePath, "utf8")).toBe(fixture.dbPath);
    expect(fakeToolExecutions).toBe(0);
    expect(run(["git", "rev-parse", fixture.branch], fixture.root)).toBe(fixture.originalRef);

    const allowed = await runCli({
      rawEvent: rawPreToolUse("exec_command", { cmd: "git status --short" }, fixture.root),
      guardPath: capture.guardPath,
      sentinelPath,
      env,
    });
    const allowedOutput = parsedOutput(allowed);
    if (allowed.exit === 0 && allowedOutput.decision !== "block") fakeToolExecutions += 1;
    expect(allowed.exit).toBe(0);
    expect(allowedOutput).toEqual({});
    expect(fakeToolExecutions).toBe(1);
    expect(run(["git", "rev-parse", fixture.branch], fixture.root)).toBe(fixture.originalRef);

    const explicitDbPath = join(fixture.root, "explicit", "db.sqlite");
    const explicit = await runCli({
      rawEvent: rawPreToolUse("exec_command", { cmd: "git status --short" }, fixture.root),
      guardPath: capture.guardPath,
      sentinelPath,
      env: { ...env, PENUMBRA_DB: explicitDbPath },
    });
    expect(explicit.exit).toBe(0);
    expect(parsedOutput(explicit)).toEqual({});
    expect(readFileSync(capture.capturePath, "utf8")).toBe(explicitDbPath);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the real CLI uses and cleans an owned temporary database by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex safety default database "));
  try {
    const capture = writeDbCaptureGuard(root);
    const delegateGuard = writeProcessGuard(root, "allow-guard.sh", ["cat >/dev/null", "exit 0"]);
    const result = await runCli({
      rawEvent: rawPreToolUse("Bash", { command: "git status" }, root),
      guardPath: capture.guardPath,
      sentinelPath: join(root, "sentinel"),
      env: {
        PENUMBRA_TEST_DB_CAPTURE_PATH: capture.capturePath,
        PENUMBRA_TEST_DELEGATE_GUARD: delegateGuard,
      },
    });

    expect(result.exit).toBe(0);
    expect(parsedOutput(result)).toEqual({});
    const capturedDbPath = readFileSync(capture.capturePath, "utf8");
    expect(capturedDbPath.startsWith(tmpdir())).toBe(true);
    expect(existsSync(dirname(capturedDbPath))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the explicit fresh sentinel reaches the packaged guard without deleting the branch", async () => {
  const fixture = makeRepo();
  try {
    const sentinelPath = join(fixture.root, "managed sentinel", "allow-agent-gc");
    mkdirSync(dirname(sentinelPath), { recursive: true });
    writeFileSync(sentinelPath, "approved\n");
    const result = await runCli({
      rawEvent: rawPreToolUse("Bash", { command: `git branch -D ${fixture.branch}` }, fixture.root),
      guardPath: PACKAGED_GUARD_PATH,
      sentinelPath,
      env: { PENUMBRA_DB: fixture.dbPath },
    });
    expect(result.exit).toBe(0);
    expect(parsedOutput(result)).toEqual({});
    expect(run(["git", "rev-parse", fixture.branch], fixture.root)).toBe(fixture.originalRef);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a guard path containing spaces is passed as one argv entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex safety copied guard "));
  try {
    const guardPath = join(root, "managed hook", "penumbra guard.sh");
    mkdirSync(dirname(guardPath), { recursive: true });
    copyFileSync(CC_GUARD_PATH, guardPath);
    chmodSync(guardPath, 0o700);
    const result = await runCli({
      rawEvent: rawPreToolUse("Bash", { command: "git status" }, root),
      guardPath,
      sentinelPath: join(root, "managed sentinel", "allow file"),
    });
    expect(result.exit).toBe(0);
    expect(parsedOutput(result)).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unexpected guard exits are normalized to runner failure with the original exit diagnosed", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex safety guard exits "));
  try {
    for (const exitCode of [3, 127]) {
      const guardPath = writeProcessGuard(root, `exit-${String(exitCode)}.sh`, [
        "cat >/dev/null",
        `exit ${String(exitCode)}`,
      ]);
      const result = await runCli({
        rawEvent: rawPreToolUse("Bash", { command: "git status" }, root),
        guardPath,
        sentinelPath: join(root, "sentinel"),
      });
      expect(result.exit).toBe(1);
      expect(parsedOutput(result).systemMessage).toBe(
        `penumbra codex-safety: managed guard failed with exit ${String(exitCode)}`,
      );
    }

    const missing = await runCli({
      rawEvent: rawPreToolUse("Bash", { command: "git status" }, root),
      guardPath: join(root, "missing-guard.sh"),
      sentinelPath: join(root, "sentinel"),
    });
    expect(missing.exit).toBe(1);
    expect(parsedOutput(missing).systemMessage).toBe(
      "penumbra codex-safety: managed guard failed with exit 127",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner deadline is not extended by a descendant holding guard pipes", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex safety held pipes "));
  const pidPath = join(root, "fixture-pids");
  try {
    const guardPath = writeProcessGuard(root, "held-pipes.sh", [
      "cat >/dev/null",
      "sleep 30 &",
      'printf "%s %s\\n" "$$" "$!" > "$PENUMBRA_TEST_PID_PATH"',
      "wait",
    ]);
    const started = performance.now();
    const result = await runCli({
      rawEvent: rawPreToolUse("Bash", { command: "git status" }, root),
      guardPath,
      sentinelPath: join(root, "sentinel"),
      env: { PENUMBRA_TEST_PID_PATH: pidPath },
    });
    const elapsedMs = performance.now() - started;

    expect(result.exit).toBe(1);
    expect(parsedOutput(result).systemMessage).toBe(
      "penumbra codex-safety: managed guard timed out",
    );
    expect(elapsedMs).toBeGreaterThanOrEqual(9_000);
    expect(elapsedMs).toBeLessThan(11_500);
    const [guardPid, descendantPid] = fixturePids(pidPath);
    expect(guardPid).toBeDefined();
    expect(descendantPid).toBeDefined();
    expect(await waitForProcessExit(guardPid ?? 0)).toBe(true);
    expect(await waitForProcessExit(descendantPid ?? 0)).toBe(true);
  } finally {
    await cleanupFixtureProcesses(pidPath);
    rmSync(root, { recursive: true, force: true });
  }
}, 18_000);

test("a TERM-resistant owned guard child is killed and reaped at the deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex safety term resistant "));
  const pidPath = join(root, "fixture-pids");
  try {
    const guardPath = writeProcessGuard(root, "term-resistant.sh", [
      "trap '' TERM",
      "sleep 30 &",
      'printf "%s %s\\n" "$$" "$!" > "$PENUMBRA_TEST_PID_PATH"',
      "wait",
    ]);
    const started = performance.now();
    const result = await runCli({
      rawEvent: rawPreToolUse("exec_command", { cmd: "x".repeat(128 * 1024) }, root),
      guardPath,
      sentinelPath: join(root, "sentinel"),
      env: { PENUMBRA_TEST_PID_PATH: pidPath },
    });
    const elapsedMs = performance.now() - started;

    expect(result.exit).toBe(1);
    expect(parsedOutput(result).systemMessage).toBe(
      "penumbra codex-safety: managed guard timed out",
    );
    expect(elapsedMs).toBeLessThan(11_500);
    const [guardPid, descendantPid] = fixturePids(pidPath);
    expect(guardPid).toBeDefined();
    expect(descendantPid).toBeDefined();
    expect(await waitForProcessExit(guardPid ?? 0)).toBe(true);
    expect(await waitForProcessExit(descendantPid ?? 0)).toBe(true);
  } finally {
    await cleanupFixtureProcesses(pidPath);
    rmSync(root, { recursive: true, force: true });
  }
}, 18_000);

test("oversized guard output fails promptly after killing and reaping the owned child", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex safety output overflow "));
  const pidPath = join(root, "fixture-pids");
  try {
    const guardPath = writeProcessGuard(root, "output-overflow.sh", [
      "cat >/dev/null",
      "sleep 30 &",
      'printf "%s %s\\n" "$$" "$!" > "$PENUMBRA_TEST_PID_PATH"',
      "head -c 65537 /dev/zero",
      "wait",
    ]);
    const started = performance.now();
    const result = await runCli({
      rawEvent: rawPreToolUse("Bash", { command: "git status" }, root),
      guardPath,
      sentinelPath: join(root, "sentinel"),
      env: { PENUMBRA_TEST_PID_PATH: pidPath },
    });
    const elapsedMs = performance.now() - started;

    expect(result.exit).toBe(1);
    expect(parsedOutput(result).systemMessage).toBe(
      "penumbra codex-safety: managed guard failed: guard output exceeded the bounded limit",
    );
    expect(elapsedMs).toBeLessThan(3_000);
    const [guardPid, descendantPid] = fixturePids(pidPath);
    expect(guardPid).toBeDefined();
    expect(descendantPid).toBeDefined();
    expect(await waitForProcessExit(guardPid ?? 0)).toBe(true);
    expect(await waitForProcessExit(descendantPid ?? 0)).toBe(true);
  } finally {
    await cleanupFixtureProcesses(pidPath);
    rmSync(root, { recursive: true, force: true });
  }
}, 18_000);
