import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { runCodexCapabilityProbe, runProcess } from "../../scripts/probe-codex-capabilities.js";
import { assertHookOutput, parseCapabilityFixture } from "./capability-contract.js";

const ownedRoots: string[] = [];

function createRoot(prefix = "codex probe "): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  ownedRoots.push(root);
  return root;
}

function hookInput(event: "PreToolUse" | "SessionEnd", cwd: string): Record<string, unknown> {
  const common = {
    session_id: "session-1",
    transcript_path: null,
    cwd,
    hook_event_name: event,
    model: "gpt-5.6",
  };
  return event === "PreToolUse"
    ? {
        ...common,
        permission_mode: "default",
        turn_id: "turn-1",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        tool_input: { command: "true" },
      }
    : { ...common, reason: "other" };
}

function invokeGeneratedHook(
  command: string,
  input: Record<string, unknown>,
  cwd: string,
  env: Record<string, string>,
): { exitCode: number | null; stdout: string; stderr: string } {
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd,
    env,
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 1_000,
  });
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function invokeGeneratedHookAsync(
  command: string,
  input: Record<string, unknown>,
  cwd: string,
  env: Record<string, string>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveHook, rejectHook) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectHook);
    child.once("close", (exitCode) =>
      resolveHook({
        exitCode,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      }),
    );
    child.stdin.end(JSON.stringify(input));
  });
}

async function waitForCaptureReservation(path: string): Promise<boolean> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (readdirSync(path).some((name) => name.startsWith("event-"))) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return false;
}

// The /proc reader is injectable so tests can force the reap race (#283) without timing.
interface ProcStatReader {
  platform: NodeJS.Platform;
  readStat: (path: string) => string;
}

const liveProcStat: ProcStatReader = {
  platform: process.platform,
  readStat: (path) => readFileSync(path, "utf8"),
};

function isProcessTerminated(pid: number, proc: ProcStatReader = liveProcStat): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  if (proc.platform !== "linux") return false;
  try {
    const stat = proc.readStat(`/proc/${pid.toString()}/stat`);
    const commandEnd = stat.lastIndexOf(") ");
    if (commandEnd === -1 || stat.length <= commandEnd + 2) {
      throw new Error(`invalid process stat for pid ${pid.toString()}`);
    }
    return stat[commandEnd + 2] === "Z";
  } catch (error) {
    // ENOENT: the /proc entry was already gone at open(). ESRCH: init reaped the
    // process between open() and read() (#283). Both mean it has terminated.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return true;
    throw error;
  }
}

async function waitForProcessTermination(pid: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!isProcessTerminated(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`pid ${pid.toString()} is still running`);
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(10, remaining)));
  }
}

async function invokeGeneratedHookWithPendingInput(
  command: string,
  input: string,
  cwd: string,
  env: Record<string, string>,
  beforeInput: () => Promise<void>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn("/bin/sh", ["-c", command], { cwd, env });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const completed = new Promise<number | null>((resolveHook, rejectHook) => {
    child.once("error", rejectHook);
    child.once("close", resolveHook);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 1_500);
  try {
    await beforeInput();
    child.stdin.end(input);
    return {
      exitCode: await completed,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

function expectContained(root: string, path: string): void {
  const rel = relative(root, path);
  expect(path).not.toBe("");
  expect(isAbsolute(rel) || rel === ".." || rel.startsWith(`..${"/"}`)).toBe(false);
}

afterEach(() => {
  for (const root of ownedRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("the probe keeps command homes inside its owned profile", async () => {
  const root = createRoot();
  const homes: string[] = [];
  const result = await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "2026-09-10T00:00:00.000Z",
    run: async (invocation) => {
      homes.push(invocation.env.HOME ?? "");
      expect(invocation.env.CODEX_HOME).toBe(join(root, "codex"));
      expect(invocation.env.XDG_CONFIG_HOME).toBe(join(root, "config"));
      expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
      expect(invocation.env.PENUMBRA_HANDOFF_ID).toBeUndefined();
      expect(invocation.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(invocation.argv.some((arg) => arg.includes("bypass-hook-trust"))).toBe(false);
      expectContained(root, invocation.cwd);
      for (const arg of invocation.argv) {
        if (arg.startsWith(root)) expectContained(root, arg);
      }
      return invocation.argv.includes("--version")
        ? { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "authentication_required" };
    },
  });

  expect(homes.length).toBeGreaterThan(0);
  for (const home of homes) expectContained(root, home);
  expect(result.build).toBe("0.153.4");
  expect(result.cleanupComplete).toBe(true);
  for (const observation of result.cases) {
    expect(() => parseCapabilityFixture(observation.fixture)).not.toThrow();
  }
  expect(result.cases.find((case_) => case_.fixture.capability === "SessionStart")?.reason).toBe(
    "authentication_required",
  );
});

test("the probe isolates repeated calls and keeps a root with spaces as one argv value", async () => {
  const root = createRoot();
  const calls: string[][] = [];
  const run = async (invocation: { argv: string[]; cwd: string; env: Record<string, string> }) => {
    calls.push(invocation.argv);
    expectContained(root, invocation.cwd);
    expectContained(root, invocation.env.HOME ?? "");
    return invocation.argv.includes("--version")
      ? { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" }
      : invocation.argv.includes("mcp") && invocation.argv.includes("--help")
        ? { exitCode: 0, stdout: "add list get remove", stderr: "" }
        : invocation.argv.includes("list")
          ? { exitCode: 0, stdout: "capability-probe", stderr: "" }
          : invocation.argv.includes("get")
            ? {
                exitCode: 0,
                stdout: `capability-probe ${join(root, "capture", "probe-stdio")}`,
                stderr: "",
              }
            : invocation.argv.includes("remove")
              ? { exitCode: 0, stdout: "capability-probe removed", stderr: "" }
              : invocation.argv.includes("add")
                ? { exitCode: 0, stdout: "capability-probe added", stderr: "" }
                : { exitCode: 1, stdout: "", stderr: "authentication_required" };
  };

  await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "now",
    run,
  });
  await runCodexCapabilityProbe({
    root,
    surface: "desktop",
    binary: "/fixture/codex",
    now: () => "now",
    run,
  });

  expect(calls.some((argv) => argv.includes(join(root, "capture", "probe-stdio")))).toBe(true);
  expect(calls.flat().filter((arg) => arg === join(root, "capture", "probe-stdio"))).toHaveLength(
    2,
  );
});

test("the generated handler round-trips quoted paths through the hook consumer", async () => {
  const root = createRoot("probe-command-quote'- spaces; $literal-");
  const calls: string[][] = [];
  const outputs: Array<{ event: "PreToolUse" | "SessionEnd"; output: string }> = [];
  let handlerFailure: string | null = null;
  const result = await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "2026-09-10T00:00:00.000Z",
    run: async (invocation) => {
      calls.push(invocation.argv);
      if (invocation.argv.includes("exec")) {
        const hooks = JSON.parse(readFileSync(join(root, "codex", "hooks.json"), "utf8")) as {
          hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
        };
        for (const event of ["PreToolUse", "SessionEnd"] as const) {
          const command = hooks.hooks[event]?.[0]?.hooks[0]?.command;
          expect(command).toBeString();
          const output = invokeGeneratedHook(
            command ?? "",
            hookInput(event, join(root, "project")),
            join(root, "project"),
            invocation.env,
          );
          if (output.exitCode !== 0 || output.stderr) {
            handlerFailure = `${output.exitCode}: ${output.stderr}`;
            return { exitCode: 1, stdout: "", stderr: handlerFailure };
          }
          outputs.push({ event, output: output.stdout });
        }
        return { exitCode: 0, stdout: "PROBE_OK", stderr: "" };
      }
      return invocation.argv.includes("--version")
        ? { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "authentication_required" };
    },
  });

  expect(calls.some((argv) => argv.includes("exec"))).toBe(true);
  expect(handlerFailure).toBeNull();
  expect(outputs).toHaveLength(2);
  for (const { event, output } of outputs) {
    expect(output).toBe("");
    if (output) assertHookOutput(event, JSON.parse(output));
  }
  for (const event of ["PreToolUse", "SessionEnd"] as const) {
    const observation = result.cases.find(
      (case_) => case_.fixture.capability === event && case_.fixture.state === "supported",
    );
    expect(observation).toBeDefined();
    expect(() => parseCapabilityFixture(observation?.fixture)).not.toThrow();
  }
});

test("the generated handler reserves exactly 24 capture slots under concurrent delivery", async () => {
  const root = createRoot();
  let deliveries: Array<{ exitCode: number | null; stdout: string; stderr: string }> = [];
  const result = await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "2026-09-10T00:00:00.000Z",
    run: async (invocation) => {
      if (invocation.argv.includes("exec")) {
        const hooks = JSON.parse(readFileSync(join(root, "codex", "hooks.json"), "utf8")) as {
          hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
        };
        const command = hooks.hooks.PreToolUse[0]?.hooks[0]?.command;
        expect(command).toBeString();
        deliveries = await Promise.all(
          Array.from({ length: 25 }, (_, index) =>
            invokeGeneratedHookAsync(
              command ?? "",
              { ...hookInput("PreToolUse", join(root, "project")), turn_id: `turn-${index}` },
              join(root, "project"),
              invocation.env,
            ),
          ),
        );
        return { exitCode: 0, stdout: "PROBE_OK", stderr: "" };
      }
      return invocation.argv.includes("--version")
        ? { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "authentication_required" };
    },
  });

  expect(deliveries.filter((delivery) => delivery.exitCode === 0)).toHaveLength(24);
  expect(deliveries.filter((delivery) => delivery.exitCode === 2)).toHaveLength(1);
  expect(
    deliveries.filter((delivery) => delivery.exitCode === 0).every((delivery) => !delivery.stdout),
  ).toBe(true);
  expect(
    result.cases.some(
      (case_) => case_.fixture.capability === "PreToolUse" && case_.fixture.state === "supported",
    ),
  ).toBe(true);
});

test("the generated handler retains its capture ownership while stdin is pending", async () => {
  const outer = createRoot();
  const root = join(outer, "probe");
  const savedCapture = join(outer, "saved-capture");
  const otherCapture = join(outer, "other-capture");
  mkdirSync(root);
  mkdirSync(otherCapture);
  writeFileSync(join(otherCapture, "canary"), "unchanged");
  let reservedBeforeReplacement = false;
  const deliveries: Array<{ exitCode: number | null; stdout: string; stderr: string }> = [];

  const result = await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "2026-09-10T00:00:00.000Z",
    run: async (invocation) => {
      if (invocation.argv.includes("exec")) {
        const hooks = JSON.parse(readFileSync(join(root, "codex", "hooks.json"), "utf8")) as {
          hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
        };
        const command = hooks.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
        deliveries.push(
          await invokeGeneratedHookWithPendingInput(
            command,
            JSON.stringify(hookInput("PreToolUse", join(root, "project"))),
            join(root, "project"),
            invocation.env,
            async () => {
              reservedBeforeReplacement = await waitForCaptureReservation(join(root, "capture"));
              renameSync(join(root, "capture"), savedCapture);
              symlinkSync(otherCapture, join(root, "capture"));
            },
          ),
        );
        return { exitCode: 0, stdout: "PROBE_OK", stderr: "" };
      }
      return invocation.argv.includes("--version")
        ? { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "authentication_required" };
    },
  });

  expect(reservedBeforeReplacement).toBe(true);
  expect(deliveries).toEqual([{ exitCode: 0, stdout: "", stderr: "" }]);
  expect(readdirSync(otherCapture)).toEqual(["canary"]);
  expect(readdirSync(savedCapture).sort()).toEqual(["event-0.json", "probe-stdio"]);
  expect(result.cleanupComplete).toBe(false);
  expect(result.cases.every((case_) => case_.fixture.state === "unknown")).toBe(true);
  expect(result.cases.some((case_) => case_.reason === "probe_root_symlink")).toBe(true);
});

test("the generated handler rejects capture replacement before descriptor acquisition", async () => {
  const outer = createRoot();
  const root = join(outer, "probe");
  const savedCapture = join(outer, "saved-capture");
  const otherCapture = join(outer, "other-capture");
  mkdirSync(root);
  mkdirSync(otherCapture);
  writeFileSync(join(otherCapture, "canary"), "unchanged");
  const deliveries: Array<{ exitCode: number | null; stdout: string; stderr: string }> = [];

  const result = await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "now",
    run: async (invocation) => {
      if (invocation.argv.includes("exec")) {
        const hooks = JSON.parse(readFileSync(join(root, "codex", "hooks.json"), "utf8")) as {
          hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
        };
        const generatedHandler = join(root, "capture", "probe-stdio");
        const executableCopy = join(outer, "probe-stdio");
        copyFileSync(generatedHandler, executableCopy);
        renameSync(join(root, "capture"), savedCapture);
        symlinkSync(otherCapture, join(root, "capture"));
        deliveries.push(
          invokeGeneratedHook(
            (hooks.hooks.PreToolUse[0]?.hooks[0]?.command ?? "").replace(
              shellQuote(generatedHandler),
              shellQuote(executableCopy),
            ),
            hookInput("PreToolUse", join(root, "project")),
            join(root, "project"),
            invocation.env,
          ),
        );
        return { exitCode: 0, stdout: "PROBE_OK", stderr: "" };
      }
      return invocation.argv.includes("--version")
        ? { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "authentication_required" };
    },
  });

  expect(deliveries).toEqual([{ exitCode: 2, stdout: "", stderr: "" }]);
  expect(readdirSync(otherCapture)).toEqual(["canary"]);
  expect(result.cleanupComplete).toBe(false);
  expect(result.cases.some((case_) => case_.reason === "probe_root_symlink")).toBe(true);
});

test("the generated handler bounds malformed and oversized input after reserving a descriptor", async () => {
  const root = createRoot();
  const deliveries: Array<{ exitCode: number | null; stdout: string; stderr: string }> = [];
  const result = await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "now",
    run: async (invocation) => {
      if (invocation.argv.includes("exec")) {
        const hooks = JSON.parse(readFileSync(join(root, "codex", "hooks.json"), "utf8")) as {
          hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
        };
        const command = hooks.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
        for (const input of ["{", `{"value":"${"x".repeat(33 * 1024)}"}`]) {
          deliveries.push(
            await invokeGeneratedHookWithPendingInput(
              command,
              input,
              join(root, "project"),
              invocation.env,
              async () => {
                expect(await waitForCaptureReservation(join(root, "capture"))).toBe(true);
              },
            ),
          );
        }
        expect(
          readdirSync(join(root, "capture")).filter((name) => name.startsWith("event-")),
        ).toHaveLength(2);
        return { exitCode: 0, stdout: "PROBE_OK", stderr: "" };
      }
      return invocation.argv.includes("--version")
        ? { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "authentication_required" };
    },
  });

  expect(deliveries).toEqual([
    { exitCode: 2, stdout: "", stderr: "" },
    { exitCode: 2, stdout: "", stderr: "" },
  ]);
  expect(result.cleanupComplete).toBe(true);
  expect(result.cases.every((case_) => case_.fixture.state === "unknown")).toBe(true);
});

test("prompt and deferred completion remain unknown for explicit contract reasons", async () => {
  const root = createRoot();
  const result = await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "now",
    run: async (invocation) => {
      if (invocation.argv.includes("exec")) {
        writeFileSync(
          join(root, "capture", "event-prompt.json"),
          JSON.stringify({
            session_id: "session-1",
            transcript_path: null,
            cwd: join(root, "project"),
            hook_event_name: "UserPromptSubmit",
            model: "gpt-5.6",
            prompt: "hello",
          }),
        );
        writeFileSync(
          join(root, "capture", "event-post.json"),
          JSON.stringify({
            session_id: "session-1",
            transcript_path: null,
            cwd: join(root, "project"),
            hook_event_name: "PostToolUse",
            model: "gpt-5.6",
            permission_mode: "default",
            turn_id: "turn-1",
            tool_name: "Bash",
            tool_use_id: "tool-1",
            tool_input: { command: "sleep 1" },
            tool_response: { output: "", exitCode: 0 },
          }),
        );
        return { exitCode: 0, stdout: "PROBE_OK", stderr: "" };
      }
      return invocation.argv.includes("--version")
        ? { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "authentication_required" };
    },
  });

  const prompt = result.cases.find((case_) => case_.scenario === "prompt");
  const deferred = result.cases.find((case_) => case_.scenario === "deferred_bash_completion");
  expect(prompt?.fixture.state).toBe("unknown");
  expect(prompt?.reason).toBe("user_prompt_input_contract_not_validated");
  expect(deferred?.fixture.state).toBe("unknown");
  expect(deferred?.reason).toBe("deferred_completion_correlation_not_validated");
});

test("the capture reader does not follow a symlink to a canary", async () => {
  const outer = createRoot();
  const root = join(outer, "probe");
  const canary = join(outer, "canary.json");
  mkdirSync(root);
  writeFileSync(canary, '{"not":"a hook"}');
  const result = await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "now",
    run: async (invocation) => {
      if (invocation.argv.includes("exec")) {
        symlinkSync(canary, join(root, "capture", "event-symlink.json"));
        return { exitCode: 0, stdout: "PROBE_OK", stderr: "" };
      }
      return invocation.argv.includes("--version")
        ? { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "authentication_required" };
    },
  });

  expect(readFileSync(canary, "utf8")).toBe('{"not":"a hook"}');
  expect(
    result.cases.some(
      (case_) => case_.fixture.capability === "PreToolUse" && case_.fixture.state === "supported",
    ),
  ).toBe(false);
});

test("the capture reader skips a FIFO within an owned subprocess timeout", () => {
  const root = createRoot();
  const script = [
    'import { execFileSync } from "node:child_process";',
    'import { join } from "node:path";',
    `import { runCodexCapabilityProbe } from ${JSON.stringify(join(import.meta.dir, "../../scripts/probe-codex-capabilities.ts"))};`,
    `const root = ${JSON.stringify(root)};`,
    "await runCodexCapabilityProbe({",
    '  root, surface: "cli", binary: "/fixture/codex", now: () => "now",',
    "  run: async (invocation) => {",
    '    if (invocation.argv.includes("--version")) {',
    '      execFileSync("/usr/bin/mkfifo", [join(root, "capture", "event-fifo.json")]);',
    '      return { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" };',
    "    }",
    '    return { exitCode: 1, stdout: "", stderr: "authentication_required" };',
    "  },",
    "});",
  ].join("\n");
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
    timeout: 1_000,
  });

  expect(child.status).toBe(0);
  expect(child.error).toBeUndefined();
});

test("a symlinked root is rejected before invoking Codex", async () => {
  const outer = createRoot();
  const source = join(outer, "source");
  const link = join(outer, "probe-link");
  writeFileSync(source, "canary");
  symlinkSync(source, link);
  let calls = 0;

  await expect(
    runCodexCapabilityProbe({
      root: link,
      surface: "cli",
      binary: "/fixture/codex",
      now: () => "now",
      run: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }),
  ).rejects.toThrow("probe_root_symlink");

  expect(calls).toBe(0);
  expect(readFileSync(source, "utf8")).toBe("canary");
});

test("a nonempty probe root is rejected before invoking Codex", async () => {
  const root = createRoot();
  writeFileSync(join(root, "caller-file"), "caller-owned");
  let calls = 0;

  await expect(
    runCodexCapabilityProbe({
      root,
      surface: "cli",
      binary: "/fixture/codex",
      now: () => "now",
      run: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }),
  ).rejects.toThrow("probe_root_not_empty");

  expect(calls).toBe(0);
  expect(readFileSync(join(root, "caller-file"), "utf8")).toBe("caller-owned");
});

test("a root below a symlinked ancestor is rejected before invoking Codex", async () => {
  const outer = createRoot();
  const realAncestor = join(outer, "real-ancestor");
  const linkedAncestor = join(outer, "linked-ancestor");
  mkdirSync(realAncestor);
  symlinkSync(realAncestor, linkedAncestor);
  const root = join(linkedAncestor, "probe");
  mkdirSync(join(realAncestor, "probe"));

  await expect(
    runCodexCapabilityProbe({
      root,
      surface: "cli",
      binary: "/fixture/codex",
      now: () => "now",
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }),
  ).rejects.toThrow("probe_root_symlink");
});

test("a replaced root never cleans the attacker target", async () => {
  const outer = createRoot();
  const root = join(outer, "probe");
  const saved = join(outer, "saved-probe");
  const target = join(outer, "attacker-target");
  const canary = join(target, "home", "canary");
  mkdirSync(root);
  mkdirSync(join(target, "home"), { recursive: true });
  writeFileSync(canary, "do-not-delete");

  const result = await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "now",
    run: async (invocation) => {
      if (invocation.argv.includes("--version")) {
        renameSync(root, saved);
        symlinkSync(target, root);
        return { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "authentication_required" };
    },
  });

  expect(result.cleanupComplete).toBe(false);
  expect(readFileSync(canary, "utf8")).toBe("do-not-delete");
});

test("a replaced created child never reports complete cleanup", async () => {
  const outer = createRoot();
  const root = join(outer, "probe");
  const target = join(outer, "attacker-target");
  const canary = join(target, "canary");
  mkdirSync(root);
  mkdirSync(target);
  writeFileSync(canary, "do-not-delete");

  const result = await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "now",
    run: async (invocation) => {
      if (invocation.argv.includes("--version")) {
        rmSync(join(root, "home"), { recursive: true, force: true });
        symlinkSync(target, join(root, "home"));
        return { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "authentication_required" };
    },
  });

  expect(result.cleanupComplete).toBe(false);
  expect(readFileSync(canary, "utf8")).toBe("do-not-delete");
});

test("a captured startup event qualifies only that CLI scenario", async () => {
  const root = createRoot();
  const result = await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "2026-09-10T00:00:00.000Z",
    run: async (invocation) => {
      if (invocation.argv.includes("--version")) {
        writeFileSync(
          join(root, "capture", "event-startup.json"),
          JSON.stringify({
            session_id: "session-1",
            transcript_path: null,
            cwd: join(root, "project"),
            hook_event_name: "SessionStart",
            model: "gpt-5.6",
            permission_mode: "default",
            source: "startup",
          }),
        );
        return { exitCode: 0, stdout: "codex-cli 0.153.4", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "trust review required" };
    },
  });

  const startup = result.cases.find(
    (case_) => case_.fixture.capability === "SessionStart" && case_.scenario === "startup",
  );
  const resume = result.cases.find(
    (case_) => case_.fixture.capability === "SessionStart" && case_.scenario === "resume",
  );
  expect(startup?.fixture.state).toBe("supported");
  expect(() => parseCapabilityFixture(startup?.fixture)).not.toThrow();
  expect(resume?.fixture.state).toBe("unknown");
});

test("a never-settling adapter is bounded and reported as an unknown observation", async () => {
  const root = createRoot();
  const result = await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "now",
    run: async () => await new Promise<never>(() => undefined),
  });

  expect(result.cleanupComplete).toBe(true);
  expect(result.cases.every((case_) => case_.fixture.state === "unknown")).toBe(true);
  expect(result.cases.some((case_) => case_.reason === "probe_timeout")).toBe(true);
});

test("a throwing adapter removes every directory created for its profile", async () => {
  const root = createRoot();
  const result = await runCodexCapabilityProbe({
    root,
    surface: "cli",
    binary: "/fixture/codex",
    now: () => "now",
    run: async () => {
      throw new Error("adapter failed");
    },
  });

  expect(result.cleanupComplete).toBe(true);
  expect(result.cases.some((case_) => case_.reason === "probe_error")).toBe(true);
  expect(readdirSync(root)).toEqual([]);
});

test("the process termination wait rejects a live process and accepts its exit", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 20)"], {
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("test child has no pid");

  try {
    await expect(waitForProcessTermination(pid, 50)).rejects.toThrow(
      `pid ${pid.toString()} is still running`,
    );
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  await expect(waitForProcessTermination(pid, 50)).resolves.toBeUndefined();
});

function errnoError(code: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated, ${syscall}`), { code, syscall });
}

test("the process termination probe treats ESRCH from the /proc stat read as terminated", () => {
  const reads: string[] = [];
  const reapedDuringRead = errnoError("ESRCH", "read");
  let outcome: unknown;
  try {
    outcome = isProcessTerminated(process.pid, {
      platform: "linux",
      readStat: (path) => {
        reads.push(path);
        throw reapedDuringRead;
      },
    });
  } catch (error) {
    outcome = error;
  }
  expect(outcome).toBe(true);
  expect(reads).toEqual([`/proc/${process.pid.toString()}/stat`]);
});

test("the process termination probe still reads zombie state and rethrows other /proc errors", () => {
  const linuxStat = (stat: string): ProcStatReader => ({ platform: "linux", readStat: () => stat });
  const linuxThrow = (error: Error): ProcStatReader => ({
    platform: "linux",
    readStat: () => {
      throw error;
    },
  });
  expect(isProcessTerminated(process.pid, linuxStat("4242 (holder) Z 1 4242 4242"))).toBe(true);
  expect(isProcessTerminated(process.pid, linuxStat("4242 (holder) S 1 4242 4242"))).toBe(false);
  expect(isProcessTerminated(process.pid, linuxThrow(errnoError("ENOENT", "open")))).toBe(true);
  expect(() => isProcessTerminated(process.pid, linuxThrow(errnoError("EACCES", "open")))).toThrow(
    "EACCES",
  );
  const darwinReads: string[] = [];
  expect(
    isProcessTerminated(process.pid, {
      platform: "darwin",
      readStat: (path) => {
        darwinReads.push(path);
        return "";
      },
    }),
  ).toBe(false);
  expect(darwinReads).toEqual([]);
});

test("the real adapter drains heavy output and bounds owned process shutdown", async () => {
  const root = createRoot();
  const binary = join(root, "fake-codex");
  const childPid = join(root, "child.pid");
  writeFileSync(
    binary,
    [
      "#!/usr/bin/env bun",
      'import { writeFileSync } from "node:fs";',
      "const mode = Bun.argv[2];",
      "if (mode === 'heavy') process.stdout.write('x'.repeat(256 * 1024));",
      "if (mode === 'ignore-term') { process.on('SIGTERM', () => undefined); setInterval(() => undefined, 20); }",
      "if (mode === 'descendant') { Bun.spawn([process.execPath, import.meta.path, 'holder', Bun.argv[3]], { stdout: 'inherit', stderr: 'inherit' }); process.exit(0); }",
      "if (mode === 'holder') { writeFileSync(Bun.argv[3], String(process.pid)); setInterval(() => undefined, 20); }",
      "",
    ].join("\n"),
  );
  chmodSync(binary, 0o700);
  const invoke = (mode: string, timeoutMs = 1_000) =>
    runProcess({
      argv: [binary, mode, childPid],
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs,
    });

  const heavyStarted = Date.now();
  await expect(invoke("heavy")).rejects.toThrow("probe_output_limit");
  expect(Date.now() - heavyStarted).toBeLessThan(1_000);
  await expect(invoke("ignore-term")).rejects.toThrow("probe_timeout");
  await expect(invoke("descendant")).rejects.toThrow("probe_timeout");
  const pid = Number(readFileSync(childPid, "utf8"));
  expect(Number.isInteger(pid)).toBe(true);
  let terminated = false;
  try {
    await waitForProcessTermination(pid);
    terminated = true;
  } finally {
    if (!terminated) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
});

test("the committed host report contains only parser-valid sanitized fixtures", () => {
  const observed = JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "../../packages/cli/test/fixtures/codex-hooks/observed-capabilities.json",
      ),
      "utf8",
    ),
  ) as { report: { cases: Array<{ fixture: unknown; reason: string | null; scenario?: string }> } };

  for (const observation of observed.report.cases) {
    expect(() => parseCapabilityFixture(observation.fixture)).not.toThrow();
  }
  expect(observed.report.cases.find((case_) => case_.scenario === "prompt")?.reason).toBe(
    "user_prompt_input_contract_not_validated",
  );
  expect(
    observed.report.cases.find((case_) => case_.scenario === "deferred_bash_completion")?.reason,
  ).toBe("deferred_completion_correlation_not_validated");
});
