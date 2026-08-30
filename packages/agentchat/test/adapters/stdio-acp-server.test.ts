import { startStdioAcpServer } from "@src/adapters/stdio-acp-server.js";
import { afterEach, describe, expect, spyOn, test } from "bun:test";

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
