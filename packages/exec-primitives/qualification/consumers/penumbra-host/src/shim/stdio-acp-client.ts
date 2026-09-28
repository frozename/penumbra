/**
 * Parity shim: re-creates the legacy `adapters/stdio-acp-client.ts` surface over
 * the extracted `penumbra-exec-primitives` StdioAcpClient.
 *
 * The extracted client deliberately changed two observable behaviors:
 *  - request-handler failures are reported on the wire with a generic message
 *    (the raw error is no longer echoed to the peer);
 *  - diagnostics go to a host logger instead of console.*.
 * The legacy tests assert the old wire contract, so this shim taps the inbound
 * stream, pulls JSON-RPC *request* frames out before the inner client sees
 * them, and dispatches them itself with the legacy response/error shape.
 */
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";

import {
  AcpTransportClosedError,
  StdioAcpClient as PackedStdioAcpClient,
} from "penumbra-exec-primitives";

export interface StdioAcpClientOptions {
  stdin: Writable;
  stdout: Readable;
  framing?: "newline" | "content-length";
}

type WireHandler = (params: unknown) => unknown;

interface WireMessage {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function isRequestMessage(msg: WireMessage): boolean {
  return typeof msg.method === "string" && msg.id !== undefined && msg.id !== null;
}

function extractErrorCode(err: unknown): number {
  if (typeof err !== "object" || err === null || !("code" in err)) return -32000;
  const code: unknown = (err as { code?: unknown }).code;
  return typeof code === "number" ? code : -32000;
}

export class StdioAcpClient {
  private readonly inner: PackedStdioAcpClient;
  private readonly tap: PassThrough;
  private readonly stdin: Writable;
  private readonly framing: "newline" | "content-length";
  private readonly requestHandlers = new Map<string, WireHandler>();
  private lineBuf = "";
  private frameBuf = Buffer.alloc(0);
  private frameLen: number | null = null;
  private passthrough = false;

  constructor(opts: StdioAcpClientOptions) {
    this.stdin = opts.stdin;
    this.framing = opts.framing ?? "newline";
    this.tap = new PassThrough();
    this.inner = new PackedStdioAcpClient({
      stdin: opts.stdin,
      stdout: this.tap,
      framing: this.framing,
      logger: {
        error: (message) => {
          console.error(message);
        },
        warn: (message) => {
          console.error(message);
        },
      },
    });

    const out = opts.stdout;
    if (this.framing === "newline") {
      out.on("data", (chunk: Buffer | string) => {
        this.demuxLines(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      });
    } else {
      out.on("data", (chunk: Buffer) => {
        this.demuxFrames(chunk);
      });
    }
    out.once("end", () => {
      this.flushTail();
      this.tap.end();
    });
    out.once("close", () => {
      this.flushTail();
      this.tap.destroy();
    });
    out.on("error", (err: Error) => {
      this.tap.destroy(err);
    });
    // The inner client destroys its stdout on a framing fault. Translate that
    // back into a real-transport close + the legacy console.error diagnostic.
    this.tap.once("close", () => {
      if (!out.destroyed && !out.readableEnded) {
        console.error("stdio-acp-client: transport closed by framing fault");
        try {
          out.destroy();
        } catch {
          /* best-effort */
        }
      }
    });
  }

  isTransportOpen(): boolean {
    return this.inner.isTransportOpen();
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    try {
      return await this.inner.request(method, params);
    } catch (err) {
      if (err instanceof AcpTransportClosedError) {
        throw new Error("stdio-acp-client: transport closed");
      }
      throw err;
    }
  }

  notify(method: string, params?: unknown): void {
    try {
      this.inner.notify(method, params);
    } catch (err) {
      if (err instanceof AcpTransportClosedError) {
        throw new Error("stdio-acp-client: transport closed");
      }
      throw err;
    }
  }

  on(method: string, handler: (params: unknown) => void): void {
    this.inner.on(method, handler);
  }

  onRequest(method: string, handler: WireHandler): void {
    this.requestHandlers.set(method, handler);
  }

  private demuxLines(chunk: string): void {
    this.lineBuf += chunk;
    let newlineIndex = this.lineBuf.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuf.slice(0, newlineIndex);
      this.lineBuf = this.lineBuf.slice(newlineIndex + 1);
      this.handleInboundLine(line);
      newlineIndex = this.lineBuf.indexOf("\n");
    }
  }

  private flushTail(): void {
    if (this.framing === "newline" && this.lineBuf.length > 0) {
      const tail = this.lineBuf;
      this.lineBuf = "";
      this.handleInboundLine(tail);
    }
    if (this.frameBuf.length > 0) {
      this.tap.write(this.frameBuf);
      this.frameBuf = Buffer.alloc(0);
    }
  }

  private handleInboundLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    let consumed = false;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && isRequestMessage(parsed as WireMessage)) {
        consumed = true;
        this.dispatchRequest(parsed as WireMessage);
      }
    }
    if (!consumed) {
      // Forward the raw line so the inner client still sees (and logs on)
      // malformed JSON lines and plain status chatter.
      this.tap.write(rawLine + "\n");
    }
  }

  private demuxFrames(chunk: Buffer): void {
    if (this.passthrough) {
      this.tap.write(chunk);
      return;
    }
    this.frameBuf = Buffer.concat([this.frameBuf, chunk]);
    for (;;) {
      if (this.frameLen === null) {
        const headerEnd = this.frameBuf.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          if (this.frameBuf.length > 8 * 1024) {
            this.passthrough = true;
            this.tap.write(this.frameBuf);
            this.frameBuf = Buffer.alloc(0);
          }
          return;
        }
        const headerStr = this.frameBuf.toString("utf8", 0, headerEnd);
        const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
        const parsed = match?.[1] !== undefined ? parseInt(match[1], 10) : NaN;
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 16 * 1024 * 1024) {
          // Malformed/oversized header — hand the bytes to the inner client so
          // it performs the bounded framing-fault teardown itself.
          this.passthrough = true;
          this.tap.write(this.frameBuf);
          this.frameBuf = Buffer.alloc(0);
          return;
        }
        this.frameLen = parsed + headerEnd + 4;
      }
      if (this.frameBuf.length < this.frameLen) return;
      const rawFrame = this.frameBuf.subarray(0, this.frameLen);
      this.frameBuf = this.frameBuf.subarray(this.frameLen);
      const headerEnd = rawFrame.indexOf("\r\n\r\n");
      const body = rawFrame.subarray(headerEnd + 4);
      this.frameLen = null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && isRequestMessage(parsed as WireMessage)) {
        this.dispatchRequest(parsed as WireMessage);
      } else {
        this.tap.write(rawFrame);
      }
    }
  }

  private dispatchRequest(message: WireMessage): void {
    const id = message.id ?? null;
    const method = message.method ?? "";
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.writeFrame({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
      return;
    }
    Promise.resolve()
      .then(() => handler(message.params))
      .then(
        (result) => {
          this.writeFrame({ jsonrpc: "2.0", id, result });
        },
        (error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          const code = extractErrorCode(err);
          console.warn("stdio-acp-client: wrote JSON-RPC error frame", {
            method,
            code,
            messageLength: err.message.length,
          });
          try {
            this.writeFrame({
              jsonrpc: "2.0",
              id,
              error: { code, message: err.message },
            });
          } catch {
            /* transport already gone — the peer cannot be answered */
          }
        },
      );
  }

  private writeFrame(message: object): void {
    const jsonStr = JSON.stringify(message);
    if (this.framing === "content-length") {
      const byteLen = Buffer.byteLength(jsonStr, "utf8");
      this.stdin.write(`Content-Length: ${String(byteLen)}\r\n\r\n${jsonStr}`);
    } else {
      this.stdin.write(jsonStr + "\n");
    }
  }
}
