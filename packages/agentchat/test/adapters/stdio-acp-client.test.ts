import { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";
import { describe, expect, it, mock } from "bun:test";
import { PassThrough } from "node:stream";

function readUtf8(stream: PassThrough): string {
  const chunk: unknown = stream.read();
  if (chunk === null || chunk === undefined) return "";
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  throw new Error(`readUtf8: unexpected chunk type ${typeof chunk}`);
}

describe("StdioAcpClient", () => {
  describe("framing: newline (default)", () => {
    it("writes line-delimited JSON", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout });

      const reqPromise = client.request("test/method", { foo: "bar" });

      const written = readUtf8(stdin);
      expect(written).toMatch(
        /{"jsonrpc":"2\.0","method":"test\/method","params":{"foo":"bar"},"id":1}\n/,
      );

      stdout.write('{"jsonrpc":"2.0","id":1,"result":"ok"}\n');
      const result: unknown = await reqPromise;
      expect(result).toBe("ok");
    });

    it("reads line-delimited JSON and handles notifications", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout });

      const handler = mock();
      client.on("test/notification", handler);

      stdout.write('{"jsonrpc":"2.0","method":"test/notification","params":{"event":"fired"}}\n');

      // Yield event loop
      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledWith({ event: "fired" });
    });

    it("warns with bounded metadata when writing a JSON-RPC error frame", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout });
      client.onRequest("terminal/wait_for_exit", () => {
        const err = new Error("terminal not found: term-404") as Error & { code: number };
        err.code = -32005;
        throw err;
      });

      const consoleWarnSpy = mock();
      const originalWarn = console.warn;
      console.warn = consoleWarnSpy;

      try {
        stdout.write(
          '{"jsonrpc":"2.0","id":99,"method":"terminal/wait_for_exit","params":{"terminal_id":"term-404"}}\n',
        );

        await new Promise((r) => setTimeout(r, 10));

        expect(readUtf8(stdin)).toBe(
          '{"jsonrpc":"2.0","id":99,"error":{"code":-32005,"message":"terminal not found: term-404"}}\n',
        );
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          "stdio-acp-client: wrote JSON-RPC error frame",
          {
            method: "terminal/wait_for_exit",
            code: -32005,
            messageLength: 28,
          },
        );
      } finally {
        console.warn = originalWarn;
      }
    });

    it("does not persist non-terminal handler messages in the console warning", async () => {
      const secret = "sk-FAKE-SECRET-DO-NOT-LOG-12345";
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout });
      client.onRequest("fs/read_text_file", () => {
        throw new Error(`fs failed with ${secret}`);
      });

      const warnings: unknown[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]): void => {
        warnings.push(args);
      };

      try {
        stdout.write(
          '{"jsonrpc":"2.0","id":100,"method":"fs/read_text_file","params":{"path":"secret.txt"}}\n',
        );

        await new Promise((r) => setTimeout(r, 10));

        expect(readUtf8(stdin)).toBe(
          `{"jsonrpc":"2.0","id":100,"error":{"code":-32000,"message":"fs failed with ${secret}"}}\n`,
        );
        expect(JSON.stringify(warnings)).not.toContain(secret);
        expect(warnings).toEqual([
          [
            "stdio-acp-client: wrote JSON-RPC error frame",
            {
              method: "fs/read_text_file",
              code: -32000,
              messageLength: 46,
            },
          ],
        ]);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe("framing: newline — non-JSON lines", () => {
    it("silently skips non-JSON status lines without logging or breaking subsequent messages", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout });

      const handler = mock();
      client.on("test/notification", handler);

      const consoleErrorSpy = mock();
      const originalError = console.error;
      console.error = consoleErrorSpy;

      try {
        stdout.write("Created\n");
        stdout.write("Expanding\n");
        stdout.write("Hook\n");
        stdout.write('{"jsonrpc":"2.0","method":"test/notification","params":{"after":"junk"}}\n');

        await new Promise((r) => setTimeout(r, 10));

        expect(handler).toHaveBeenCalledWith({ after: "junk" });
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      } finally {
        console.error = originalError;
      }
    });

    it("logs once for malformed JSON and continues processing subsequent messages", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout });

      const handler = mock();
      client.on("test/notification", handler);

      const consoleErrorSpy = mock();
      const originalError = console.error;
      console.error = consoleErrorSpy;

      try {
        stdout.write("{not-real-json\n");
        stdout.write(
          '{"jsonrpc":"2.0","method":"test/notification","params":{"recovered":true}}\n',
        );

        await new Promise((r) => setTimeout(r, 10));

        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({ recovered: true });
      } finally {
        console.error = originalError;
      }
    });
  });

  describe("framing: content-length", () => {
    it("writes Content-Length framed JSON", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout, framing: "content-length" });

      const reqPromise = client.request("test/method", { foo: "bar" });

      const written = readUtf8(stdin);
      const expectedJson = '{"jsonrpc":"2.0","method":"test/method","params":{"foo":"bar"},"id":1}';
      const expectedHeader = `Content-Length: ${String(Buffer.byteLength(expectedJson, "utf8"))}\r\n\r\n`;
      expect(written).toBe(expectedHeader + expectedJson);

      const respJson = '{"jsonrpc":"2.0","id":1,"result":"framed-ok"}';
      stdout.write(
        `Content-Length: ${String(Buffer.byteLength(respJson, "utf8"))}\r\n\r\n${respJson}`,
      );

      const result: unknown = await reqPromise;
      expect(result).toBe("framed-ok");
    });

    it("reads Content-Length framed JSON in split chunks", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout, framing: "content-length" });

      const reqPromise = client.request("test/split", {});

      // Simulate a read that arrives in multiple chunks
      const respJson = '{"jsonrpc":"2.0","id":1,"result":"split-ok"}';
      const fullMessage = `Content-Length: ${String(Buffer.byteLength(respJson, "utf8"))}\r\n\r\n${respJson}`;

      const chunk1 = fullMessage.substring(0, 20);
      const chunk2 = fullMessage.substring(20, 30);
      const chunk3 = fullMessage.substring(30);

      stdout.write(chunk1);
      await new Promise((r) => setTimeout(r, 5));
      stdout.write(chunk2);
      await new Promise((r) => setTimeout(r, 5));
      stdout.write(chunk3);

      const result: unknown = await reqPromise;
      expect(result).toBe("split-ok");
    });

    it("rejects oversized Content-Length and closes the transport", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout, framing: "content-length" });

      const destroySpy = mock(stdout.destroy.bind(stdout));
      stdout.destroy = destroySpy;

      const reqPromise = client.request("test/oversize", {});
      const settled: { rejected: boolean; error?: unknown } = { rejected: false };
      reqPromise.catch((err: unknown) => {
        settled.rejected = true;
        settled.error = err;
      });

      const consoleErrorSpy = mock();
      const originalError = console.error;
      console.error = consoleErrorSpy;

      try {
        // 1 GiB content-length — way above the cap. No body needed; the cap
        // must trip the moment Content-Length is parsed.
        const oversized = 1024 * 1024 * 1024;
        stdout.write(`Content-Length: ${String(oversized)}\r\n\r\n`);

        await new Promise((r) => setTimeout(r, 20));

        expect(destroySpy).toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalled();
        expect(settled.rejected).toBe(true);
        expect(String(settled.error)).toMatch(/transport closed/);
      } finally {
        console.error = originalError;
      }
    });

    it("rejects oversized header (no header terminator) and closes the transport", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout, framing: "content-length" });

      const destroySpy = mock(stdout.destroy.bind(stdout));
      stdout.destroy = destroySpy;

      const reqPromise = client.request("test/oversize-header", {});
      const settled: { rejected: boolean; error?: unknown } = { rejected: false };
      reqPromise.catch((err: unknown) => {
        settled.rejected = true;
        settled.error = err;
      });

      const consoleErrorSpy = mock();
      const originalError = console.error;
      console.error = consoleErrorSpy;

      try {
        // Garbage header with no \r\n\r\n terminator, larger than the header cap.
        const junk = "X".repeat(64 * 1024); // 64KB > 8KB cap
        stdout.write(junk);

        await new Promise((r) => setTimeout(r, 20));

        expect(destroySpy).toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalled();
        expect(settled.rejected).toBe(true);
        expect(String(settled.error)).toMatch(/transport closed/);
      } finally {
        console.error = originalError;
      }
    });

    it("handles malformed JSON cleanly and recovers", async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout, framing: "content-length" });

      const reqPromise = client.request("test/recover", {});

      // Send a malformed message
      const badJson = '{"jsonrpc":"2.0","id":999, BAD}';
      stdout.write(
        `Content-Length: ${String(Buffer.byteLength(badJson, "utf8"))}\r\n\r\n${badJson}`,
      );

      // Send the good message
      const goodJson = '{"jsonrpc":"2.0","id":1,"result":"recovered"}';
      stdout.write(
        `Content-Length: ${String(Buffer.byteLength(goodJson, "utf8"))}\r\n\r\n${goodJson}`,
      );

      const result: unknown = await reqPromise;
      expect(result).toBe("recovered");
    });
  });
});
