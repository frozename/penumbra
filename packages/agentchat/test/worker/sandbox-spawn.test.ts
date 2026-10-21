import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SandboxUnavailableError,
  spawnSandboxed,
  type SpawnSandboxedOpts,
  wrapSandboxExecArgv,
} from "@src/worker/sandbox-spawn.js";

let cwd: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "phase1d-sb-"));
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

// `delete process.env[key]` with a computed key trips no-dynamic-delete; use
// Reflect.deleteProperty for genuine deletion (assigning undefined coerces to
// the literal string "undefined" via ProcessEnv setters).
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

async function withEnv(
  key: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = process.env[key];
  setEnv(key, value);
  try {
    await fn();
  } finally {
    setEnv(key, prev);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await Bun.sleep(50);
  }
  throw new Error(`pid ${pid.toString()} is still alive`);
}

describe("spawnSandboxed", () => {
  test("argv form runs and captures output", async () => {
    const r = await spawnSandboxed({
      argv: ["echo", "hello"],
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
    });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe("hello");
    expect(r.truncated).toBe(false);
    expect(r.killReason).toBeUndefined();
  });

  test("cmd form runs via bash -c", async () => {
    const r = await spawnSandboxed({ cmd: "echo hi", cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe("hi");
  });

  test("argv is preferred when both are set", async () => {
    const r = await spawnSandboxed({
      argv: ["echo", "A"],
      cmd: "echo B",
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
    });
    expect(r.output.trim()).toBe("A");
  });

  test("bad command yields exit code 127", async () => {
    const r = await spawnSandboxed({
      argv: ["nonexistent-cmd-xyzzy"],
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
    });
    expect(r.exitCode).toBe(127);
  });

  test("false yields exit code 1", async () => {
    const r = await spawnSandboxed({ argv: ["false"], cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.exitCode).toBe(1);
  });

  test("PATH stripping keeps bun unavailable", async () => {
    const r = await spawnSandboxed({
      cmd: "bun --version",
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
    });
    expect(r.exitCode).not.toBe(0);
  });

  test("PATH override is visible inside the sandbox", async () => {
    const r = await spawnSandboxed({
      cmd: "echo $PATH",
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
      path: "/usr/bin:/bin:/extra",
    });
    expect(r.output.trim()).toContain("/extra");
  });

  test("HOME equals cwd", async () => {
    const r = await spawnSandboxed({
      cmd: "echo $HOME",
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
    });
    expect(r.output.trim()).toBe(cwd);
  });

  test("CI is set to true", async () => {
    const r = await spawnSandboxed({ cmd: "echo $CI", cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.output.trim()).toBe("true");
  });

  test("LANG passes through when set", async () => {
    await withEnv("LANG", "en_US.UTF-8", async () => {
      const r = await spawnSandboxed({
        cmd: "echo $LANG",
        cwd,
        timeoutMs: 5000,
        outputMaxBytes: 1024,
      });
      expect(r.output.trim()).toBe("en_US.UTF-8");
    });
  });

  test("unrelated env does not leak", async () => {
    await withEnv("SECRET_PHASE1D_TEST", "leak", async () => {
      const r = await spawnSandboxed({
        cmd: 'echo "[$SECRET_PHASE1D_TEST]"',
        cwd,
        timeoutMs: 5000,
        outputMaxBytes: 1024,
      });
      expect(r.output.trim()).toBe("[]");
    });
  });

  test("stdin is ignored so cat exits immediately", async () => {
    const r = await spawnSandboxed({ cmd: "cat", cwd, timeoutMs: 5000, outputMaxBytes: 1024 });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("");
  });

  test("timeout kills a sleeping process", async () => {
    const r = await spawnSandboxed({
      argv: ["sleep", "10"],
      cwd,
      timeoutMs: 200,
      outputMaxBytes: 1024,
    });
    expect(r.killReason).toBe("timeout");
    expect(r.durationMs).toBeLessThan(3000);
    expect(r.exitCode).not.toBe(0);
  });

  test.skipIf(process.platform === "win32")("timeout kills background descendants", async () => {
    const pidFile = join(cwd, "sandbox-grandchild.pid");
    const r = await spawnSandboxed({
      cmd: `sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; wait`,
      cwd,
      timeoutMs: 200,
      outputMaxBytes: 1024,
    });
    const pid = Number((await readFile(pidFile, "utf8")).trim());

    try {
      expect(r.killReason).toBe("timeout");
      await waitUntilDead(pid);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  test("timeout result exposes a termination signal when available", async () => {
    const r = await spawnSandboxed({
      argv: ["sleep", "10"],
      cwd,
      timeoutMs: 200,
      outputMaxBytes: 1024,
    });
    expect(r.killReason).toBe("timeout");
    expect(r.signal === null || r.signal === "SIGTERM" || r.signal === "SIGKILL").toBe(true);
  });

  test("a SIGKILL penumbra did not send is reported as a resource kill", async () => {
    const r = await spawnSandboxed({
      argv: ["sh", "-c", "kill -9 $$"],
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
    });
    expect(r.signal).toBe("SIGKILL");
    expect(r.killReason).toBe("resource");
  });

  test("output cap truncates and terminates a noisy process", async () => {
    const r = await spawnSandboxed({ cmd: "yes", cwd, timeoutMs: 5000, outputMaxBytes: 4096 });
    expect(r.truncated).toBe(true);
    expect(r.killReason).toBe("output_overflow");
    expect(r.output.length).toBeLessThanOrEqual(4096);
  });

  test("AbortController cancels the process", async () => {
    const controller = new AbortController();
    const promise = spawnSandboxed({
      argv: ["sleep", "5"],
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 100);
    const r = await promise;
    expect(r.killReason).toBe("cancelled");
    expect(r.durationMs).toBeLessThan(3000);
  });

  test("envOverride wins over defaults", async () => {
    const r = await spawnSandboxed({
      cmd: "echo $CI",
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
      envOverride: { CI: "no" },
    });
    expect(r.output.trim()).toBe("no");
  });

  test("empty argv arguments are allowed", async () => {
    const r = await spawnSandboxed({
      argv: ["echo", ""],
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
    });
    expect(r.output).toBe("\n");
  });

  test("duration is reasonable for a short sleep", async () => {
    const r = await spawnSandboxed({
      argv: ["sleep", "0.2"],
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 1024,
    });
    expect(r.durationMs).toBeGreaterThan(150);
    expect(r.durationMs).toBeLessThan(1500);
  });

  test("throws when neither argv nor cmd are provided", async () => {
    // Test fabricates the missing-argv/cmd case to exercise the runtime guard;
    // SpawnSandboxedOpts requires one of argv|cmd at the type level.
    const optsMissingArgvAndCmd = {
      cwd,
      timeoutMs: 1000,
      outputMaxBytes: 1024,
    } as unknown as SpawnSandboxedOpts;
    let caught: unknown;
    try {
      await spawnSandboxed(optsMissingArgvAndCmd);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof Error ? caught.message : String(caught)).toBe(
      "spawnSandboxed: argv or cmd required",
    );
  });
});

describe("wrapSandboxExecArgv", () => {
  const profile = "(version 1)\n(allow default)\n";

  test("prepends sandbox-exec -p <profile> on darwin", () => {
    const argv = wrapSandboxExecArgv(["bash", "-c", "echo hi"], profile, {
      platform: "darwin",
      exists: () => true,
    });
    expect(argv).toEqual(["/usr/bin/sandbox-exec", "-p", profile, "bash", "-c", "echo hi"]);
  });

  test("fails closed on non-darwin platforms", () => {
    let caught: unknown;
    try {
      wrapSandboxExecArgv(["echo", "hi"], profile, { platform: "linux", exists: () => true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxUnavailableError);
    expect((caught as SandboxUnavailableError).code).toBe("sandbox_unavailable");
  });

  test("fails closed when sandbox-exec is absent on darwin", () => {
    let caught: unknown;
    try {
      wrapSandboxExecArgv(["echo", "hi"], profile, { platform: "darwin", exists: () => false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxUnavailableError);
  });
});

describe.skipIf(process.platform !== "darwin")("spawnSandboxed sandboxProfile", () => {
  const denyWriteProfile = (root: string): string =>
    `(version 1)\n(allow default)\n(deny file-write* (subpath "${root}"))\n`;

  test("denies file-write under the protected root while allowing reads", async () => {
    const target = join(cwd, "denied-marker");
    // SBPL subpath rules match resolved paths — /var is a /private/var symlink
    // on macOS, so the protected root must be realpath'd or the deny misses.
    const realRoot = await realpath(cwd);
    const r = await spawnSandboxed({
      cmd: `touch "${target}"`,
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 4096,
      sandboxProfile: denyWriteProfile(realRoot),
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.argv.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"]);
    const exists = await readFile(target, "utf8").then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);

    const read = await spawnSandboxed({
      cmd: "echo still-works",
      cwd,
      timeoutMs: 5000,
      outputMaxBytes: 4096,
      sandboxProfile: denyWriteProfile(realRoot),
    });
    expect(read.exitCode).toBe(0);
    expect(read.output.trim()).toBe("still-works");
  });
});
