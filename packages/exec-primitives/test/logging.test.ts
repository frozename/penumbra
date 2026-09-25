import { describe, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";

import * as lib from "../src/index.ts";
import { cleanupDir, hostEnv, makeTmpDir, sleep } from "./helpers.ts";

describe("[B1] sink boundary", () => {
  test("[B1] with no logger installed, a framing breach writes nothing to stderr or console", async () => {
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    const consoleErrSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new lib.StdioAcpClient({ stdin, stdout, framing: "content-length" });
      const pending = client.request("initialize", {}).catch((err: unknown) => err);
      stdout.write(`Content-Length: ${String(32 * 1024 * 1024)}\r\n\r\n`);
      const err = await pending;
      expect(err).toBeInstanceOf(Error);
      await sleep(10);
      for (const call of stderrSpy.mock.calls) {
        expect(String(call[0])).not.toContain("framing");
        expect(String(call[0])).not.toContain("acp");
      }
      expect(consoleErrSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      consoleErrSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    }
  });

  test("[B1] with a logger installed, a framing breach reaches the logger", async () => {
    const messages: string[] = [];
    const logger: lib.ExecLogger = {
      warn: (msg) => {
        messages.push(msg);
      },
      error: (msg) => {
        messages.push(msg);
      },
    };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const client = new lib.StdioAcpClient({ stdin, stdout, framing: "content-length", logger });
    const pending = client.request("initialize", {}).catch((err: unknown) => err);
    stdout.write(`Content-Length: ${String(32 * 1024 * 1024)}\r\n\r\n`);
    await pending;
    await sleep(10);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]).toMatch(/framing|content.length/i);
  });

  test("[B1] child stderr reaches onStderrChunk and is never teed to process.stderr", async () => {
    const dir = makeTmpDir("tee");
    const stderrSpy = spyOn(process.stderr, "write");
    try {
      const chunks: string[] = [];
      const handle = await lib.startStdioAcpServer({
        command: "sh",
        args: ["-c", "echo TEE_MARKER_SENTINEL 1>&2; sleep 1"],
        cwd: dir,
        env: hostEnv(dir),
        signal: new AbortController().signal,
        cancelGraceMs: 100,
        watchdogMs: 10_000,
        stderrTailBytes: 32,
        onStderrChunk: (chunk) => {
          chunks.push(chunk);
        },
      });
      await sleep(300);
      const tail = handle.getStderrTail();
      expect(chunks.join("")).toContain("TEE_MARKER_SENTINEL");
      expect(tail.length).toBeLessThanOrEqual(32);
      expect(tail).toContain("SENTINEL");
      for (const call of stderrSpy.mock.calls) {
        expect(String(call[0])).not.toContain("TEE_MARKER_SENTINEL");
      }
      handle.kill();
      await handle.exited;
    } finally {
      stderrSpy.mockRestore();
      cleanupDir(dir);
    }
  });
});
