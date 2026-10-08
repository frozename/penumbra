import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startStdioAcpServer } from "@src/adapters/stdio-acp-server.js";

const cleanupPids = new Set<number>();

afterEach(() => {
  for (const pid of cleanupPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  cleanupPids.clear();
});

describe("startStdioAcpServer", () => {
  test("rejects an already-aborted start before executing the child", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "stdio-acp-aborted-"));
    const sentinelPath = join(fixtureDir, "spawned");
    const controller = new AbortController();
    const cancelReason = new Error("cancelled before server start");
    controller.abort(cancelReason);
    let handle: Awaited<ReturnType<typeof startStdioAcpServer>> | null = null;
    let caught: unknown;

    try {
      try {
        handle = await startStdioAcpServer({
          binary: "sh",
          args: ["-c", 'printf spawned > "$1"', "sh", sentinelPath],
          signal: controller.signal,
        });
        if (handle.pid) cleanupPids.add(handle.pid);
        await handle.exited;
      } catch (err) {
        caught = err;
      }

      expect(existsSync(sentinelPath)).toBe(false);
      expect(handle).toBeNull();
      expect(caught).toBe(cancelReason);
    } finally {
      if (handle?.pid) cleanupPids.delete(handle.pid);
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("getStderrTail captures child stderr output", async () => {
    const handle = await startStdioAcpServer({
      binary: "sh",
      args: ["-c", 'printf "hello-stderr-1\nhello-stderr-2\n" 1>&2; sleep 0.05'],
    });
    if (handle.pid) cleanupPids.add(handle.pid);

    await handle.exited;
    const tail = handle.getStderrTail();
    expect(tail).toContain("hello-stderr-1");
    expect(tail).toContain("hello-stderr-2");
    if (handle.pid) cleanupPids.delete(handle.pid);
  });

  test("getStderrTail caps at stderrTailBytes (drops oldest bytes)", async () => {
    const handle = await startStdioAcpServer({
      binary: "sh",
      // Print 5 lines: first should be evicted; last should remain.
      args: [
        "-c",
        'for i in 1 2 3 4 5; do printf "line-%d-aaaaaaaaaa\n" "$i" 1>&2; done; sleep 0.05',
      ],
      stderrTailBytes: 64,
    });
    if (handle.pid) cleanupPids.add(handle.pid);

    await handle.exited;
    const tail = handle.getStderrTail();
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(64);
    expect(tail).toContain("line-5");
    expect(tail).not.toContain("line-1");
    if (handle.pid) cleanupPids.delete(handle.pid);
  });

  test("logs a spawn error and exposes it via getSpawnError when the binary is missing", async () => {
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
    try {
      const handle = await startStdioAcpServer({
        binary: "/nonexistent/acp-binary-under-test-xyz",
      });
      const code = await handle.exited;
      expect(code).toBeNull();
      const joined = errors.join("\n");
      expect(joined).toContain("stdio-acp-server");
      expect(joined).toContain("/nonexistent/acp-binary-under-test-xyz");
      expect(handle.getSpawnError).toBeDefined();
      const spawnError = handle.getSpawnError?.() ?? null;
      expect(spawnError).not.toBeNull();
      expect(spawnError?.message.length ?? 0).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("kill escalates when the ACP process ignores SIGTERM", async () => {
    const handle = await startStdioAcpServer({
      binary: "sh",
      args: ["-c", 'trap "" TERM; while :; do sleep 1; done'],
    });
    if (handle.pid) cleanupPids.add(handle.pid);

    handle.kill();

    const exited = await Promise.race([
      handle.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, 3_500);
      }),
    ]);

    expect(exited).toBe(true);
    if (handle.pid) cleanupPids.delete(handle.pid);
  });
});

describe.skipIf(process.platform !== "darwin")("startStdioAcpServer sandboxProfile", () => {
  test("wraps the child in sandbox-exec and denies writes under the profile root", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "stdio-acp-sb-"));
    const realRoot = realpathSync(fixtureDir);
    const sentinelPath = join(fixtureDir, "spawned");
    const profile = `(version 1)\n(allow default)\n(deny file-write* (subpath "${realRoot}"))\n`;
    let handle: Awaited<ReturnType<typeof startStdioAcpServer>> | null = null;

    try {
      handle = await startStdioAcpServer({
        binary: "sh",
        args: ["-c", 'printf x > "$1"', "sh", sentinelPath],
        sandboxProfile: profile,
      });
      if (handle.pid) cleanupPids.add(handle.pid);
      const code = await handle.exited;

      expect(code).not.toBe(0);
      expect(existsSync(sentinelPath)).toBe(false);
    } finally {
      if (handle?.pid) cleanupPids.delete(handle.pid);
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("runs unsandboxed children identically when sandboxProfile is omitted", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "stdio-acp-nosb-"));
    const sentinelPath = join(fixtureDir, "spawned");
    let handle: Awaited<ReturnType<typeof startStdioAcpServer>> | null = null;

    try {
      handle = await startStdioAcpServer({
        binary: "sh",
        args: ["-c", 'printf x > "$1"', "sh", sentinelPath],
      });
      if (handle.pid) cleanupPids.add(handle.pid);
      const code = await handle.exited;

      expect(code).toBe(0);
      expect(existsSync(sentinelPath)).toBe(true);
    } finally {
      if (handle?.pid) cleanupPids.delete(handle.pid);
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
