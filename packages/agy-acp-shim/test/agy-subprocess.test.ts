import { describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { spawnAgy } from "../src/agy-subprocess.js";

const noop = (): void => undefined;
const readlineEvents = ["data", "readable", "end", "error", "close"] as const;

const readlineListenerCount = (stream: PassThrough): number =>
  readlineEvents.reduce((count, eventName) => count + stream.listenerCount(eventName), 0);

const makeMockChild = (): {
  child: ReturnType<typeof childProcess.spawn>;
  stderr: PassThrough;
  stdin: PassThrough;
  stdout: PassThrough;
} => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    kill: () => true,
    pid: 123_456,
    stderr,
    stdin,
    stdout,
  }) as unknown as ReturnType<typeof childProcess.spawn>;

  return { child, stderr, stdin, stdout };
};

describe("spawnAgy", () => {
  it("yields lines from a mock echo process", async () => {
    const lines: string[] = [];
    const proc = spawnAgy({
      binary: "echo",
      args: ["hello world"],
      onLine: (l) => lines.push(l),
    });
    await proc.exited;
    expect(lines.join(" ").trim()).toContain("hello world");
  });

  it("kill() terminates the subprocess before natural exit", async () => {
    const proc = spawnAgy({ binary: "sleep", args: ["60"], onLine: noop });
    proc.kill();
    const code = await proc.exited;
    // SIGTERM exits non-zero on macOS
    expect(code).not.toBe(0);
  });

  it("resolves exited after process finishes", async () => {
    const proc = spawnAgy({ binary: "true", args: [], onLine: noop });
    const code = await proc.exited;
    expect(code).toBe(0);
  });

  it("closes readline listeners when the child exits", async () => {
    const { child, stderr, stdin, stdout } = makeMockChild();
    const spawnSpy = spyOn(childProcess, "spawn").mockReturnValue(child);
    try {
      const proc = spawnAgy({ binary: "mock", args: [], onLine: noop });
      const beforeExit = readlineListenerCount(stdout);

      child.emit("exit", 0);
      const code = await proc.exited;

      expect(code).toBe(0);
      expect(beforeExit).toBeGreaterThan(0);
      expect(readlineListenerCount(stdout)).toBeLessThan(beforeExit);
    } finally {
      spawnSpy.mockRestore();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    }
  });

  it("closes readline listeners when the child errors", async () => {
    const { child, stderr, stdin, stdout } = makeMockChild();
    const spawnSpy = spyOn(childProcess, "spawn").mockReturnValue(child);
    try {
      const proc = spawnAgy({ binary: "mock", args: [], onLine: noop });
      const beforeError = readlineListenerCount(stdout);

      child.emit("error", new Error("spawn failed"));
      const code = await proc.exited;

      expect(code).toBeNull();
      expect(beforeError).toBeGreaterThan(0);
      expect(readlineListenerCount(stdout)).toBeLessThan(beforeError);
    } finally {
      spawnSpy.mockRestore();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    }
  });

  it("closes readline listeners when kill is requested", async () => {
    const { child, stderr, stdin, stdout } = makeMockChild();
    const spawnSpy = spyOn(childProcess, "spawn").mockReturnValue(child);
    const killSpy = spyOn(process, "kill").mockImplementation(() => true);
    try {
      const proc = spawnAgy({ binary: "mock", args: [], onLine: noop });
      const beforeKill = readlineListenerCount(stdout);

      proc.kill();
      const afterFirstKill = readlineListenerCount(stdout);
      proc.kill();

      child.emit("exit", null);
      await proc.exited;

      expect(beforeKill).toBeGreaterThan(0);
      expect(afterFirstKill).toBeLessThan(beforeKill);
      expect(readlineListenerCount(stdout)).toBe(afterFirstKill);
    } finally {
      killSpy.mockRestore();
      spawnSpy.mockRestore();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    }
  });

  it("does not send SIGKILL when the child exits before the escalation window", async () => {
    const killSpy = spyOn(process, "kill").mockImplementation(() => true);
    try {
      const proc = spawnAgy({ binary: "true", args: [], onLine: noop });
      proc.kill();
      await proc.exited;
      // Yield to flush the exited.then(clearTimeout) microtask.
      await new Promise((r) => setImmediate(r));
      // Wait past the 2s SIGKILL escalation window to prove the timer was cleared.
      await new Promise((r) => setTimeout(r, 2100));
      const sigkillCalls = killSpy.mock.calls.filter((c) => c[1] === "SIGKILL");
      expect(sigkillCalls.length).toBe(0);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("preserves leading indentation on forwarded lines", async () => {
    const lines: string[] = [];
    const indented = "    indented line";
    const proc = spawnAgy({
      binary: "printf",
      args: ["%s\\n", indented],
      onLine: (l) => lines.push(l),
    });
    await proc.exited;
    expect(lines).toContain(indented);
  });
});
