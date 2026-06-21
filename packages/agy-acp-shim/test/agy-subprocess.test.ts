import { describe, expect, it, spyOn } from "bun:test";

import { spawnAgy } from "../src/agy-subprocess.js";

const noop = (): void => undefined;

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

  it("writes the prompt to stdin when provided", async () => {
    const lines: string[] = [];
    const proc = spawnAgy({
      binary: "cat",
      args: [],
      prompt: "first line\nsecond line",
      onLine: (l) => lines.push(l),
    });
    await proc.exited;
    expect(lines.join("\n")).toContain("first line");
    expect(lines.join("\n")).toContain("second line");
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
