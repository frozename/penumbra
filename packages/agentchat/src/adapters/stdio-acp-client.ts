import type { Readable, Writable } from "node:stream";

import { createInterface } from "node:readline";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id: string | number;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: JsonRpcError;
  id: string | number | null;
}

export interface StdioAcpClientOptions {
  stdin: Writable;
  stdout: Readable;
  framing?: "newline" | "content-length";
}

interface PendingRequest {
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
}

type WireHandler = (params: unknown) => unknown;

const MAX_HEADER_BYTES = 8 * 1024;
const MAX_CONTENT_LENGTH = 16 * 1024 * 1024;

interface JsonRpcInbound {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asJsonRpcInbound(v: unknown): JsonRpcInbound | null {
  return isObjectLike(v) ? v : null;
}

function extractErrorCode(err: unknown): number {
  if (typeof err !== "object" || err === null || !("code" in err)) return -32000;
  const code: unknown = err.code;
  return typeof code === "number" ? code : -32000;
}

export class StdioAcpClient {
  private nextId = 1;
  private readonly pendingRequests = new Map<string | number, PendingRequest>();
  private readonly handlers = new Map<string, WireHandler>();
  private readonly requestHandlers = new Map<string, WireHandler>();
  private readonly framing: "newline" | "content-length";
  private transportOpen = true;

  // For content-length framing
  private buffer: Buffer = Buffer.alloc(0);
  private contentLength: number | null = null;
  private framingBroken = false;

  constructor(private readonly options: StdioAcpClientOptions) {
    this.framing = options.framing ?? "newline";

    if (this.framing === "newline") {
      this.attachNewlineReader();
    } else {
      this.options.stdout.on("data", (chunk: Buffer) => {
        if (this.framingBroken) return;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processBuffer();
      });
    }

    this.options.stdout.once("close", () => {
      this.closeTransport();
    });
    this.options.stdout.once("end", () => {
      this.closeTransport();
    });
    this.options.stdout.once("error", (err) => {
      this.closeTransport(err);
    });
    this.options.stdin.once("close", () => {
      this.closeTransport();
    });
    this.options.stdin.once("error", (err) => {
      this.closeTransport(err);
    });
  }

  isTransportOpen(): boolean {
    const stdout = this.options.stdout as Readable & { closed?: boolean; readableEnded?: boolean };
    return (
      this.transportOpen &&
      this.options.stdin.writable &&
      !this.options.stdin.destroyed &&
      stdout.readable &&
      !stdout.destroyed &&
      !stdout.closed &&
      !stdout.readableEnded
    );
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params,
      id,
    };

    return await new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.writeMessage(request);
    });
  }

  notify(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.writeMessage(notification);
  }

  on(method: string, handler: (params: unknown) => void): void {
    this.handlers.set(method, handler);
  }

  onRequest(method: string, handler: (params: unknown) => unknown): void {
    this.requestHandlers.set(method, handler);
  }

  private attachNewlineReader(): void {
    const rl = createInterface({
      input: this.options.stdout,
      terminal: false,
    });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
      try {
        const message = JSON.parse(trimmed) as unknown;
        this.handleMessage(message);
      } catch (err) {
        console.error("stdio-acp-client: failed to parse JSON-RPC message:", err);
      }
    });
  }

  private processBuffer(): void {
    while (this.tryReadOneFramedMessage()) {
      // loop until no more complete messages are available in the buffer
    }
  }

  private tryReadOneFramedMessage(): boolean {
    if (this.framingBroken) return false;
    if (this.contentLength === null) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          this.breakFraming(`header exceeds ${String(MAX_HEADER_BYTES)} bytes without terminator`);
        }
        return false;
      }
      this.consumeHeader(headerEnd);
      if (this.isFramingBroken()) return false;
    }

    if (this.contentLength === null) return false;
    if (this.buffer.length < this.contentLength) return false;

    const bodyBuffer = this.buffer.subarray(0, this.contentLength);
    this.buffer = this.buffer.subarray(this.contentLength);
    this.contentLength = null;

    const bodyStr = bodyBuffer.toString("utf8");
    if (!bodyStr.trim()) return true;

    try {
      const message = JSON.parse(bodyStr) as unknown;
      this.handleMessage(message);
    } catch (err) {
      console.error("stdio-acp-client: failed to parse framed JSON-RPC message:", err);
    }
    return true;
  }

  private consumeHeader(headerEnd: number): void {
    if (headerEnd > MAX_HEADER_BYTES) {
      this.breakFraming(`header (${String(headerEnd)} bytes) exceeds cap`);
      return;
    }
    const headerStr = this.buffer.toString("utf8", 0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
    if (match) {
      const contentLengthText = match[1];
      if (contentLengthText !== undefined) {
        const parsed = parseInt(contentLengthText, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          this.breakFraming(`invalid Content-Length: ${contentLengthText}`);
          return;
        }
        if (parsed > MAX_CONTENT_LENGTH) {
          this.breakFraming(
            `Content-Length ${String(parsed)} exceeds cap ${String(MAX_CONTENT_LENGTH)}`,
          );
          return;
        }
        this.contentLength = parsed;
      } else {
        console.error("stdio-acp-client: invalid Content-Length header");
      }
    } else {
      console.error("stdio-acp-client: missing Content-Length in header");
      // Try to recover by dropping header
    }
    this.buffer = this.buffer.subarray(headerEnd + 4);
  }

  private breakFraming(reason: string): void {
    if (this.framingBroken) return;
    this.framingBroken = true;
    console.error(`stdio-acp-client: framing breach — ${reason}; closing transport`);
    this.buffer = Buffer.alloc(0);
    this.contentLength = null;
    try {
      this.options.stdout.destroy();
    } catch {
      // best-effort
    }
  }

  private isFramingBroken(): boolean {
    return this.framingBroken;
  }

  private writeMessage(message: object): void {
    const jsonStr = JSON.stringify(message);
    if (this.framing === "content-length") {
      const byteLen = Buffer.byteLength(jsonStr, "utf8");
      this.options.stdin.write(`Content-Length: ${String(byteLen)}\r\n\r\n${jsonStr}`);
    } else {
      this.options.stdin.write(jsonStr + "\n");
    }
  }

  private closeTransport(cause?: Error): void {
    if (!this.transportOpen) return;
    this.transportOpen = false;
    const err = cause ?? new Error("stdio-acp-client: transport closed");
    for (const req of this.pendingRequests.values()) {
      req.reject(err);
    }
    this.pendingRequests.clear();
  }

  private handleMessage(rawMessage: unknown): void {
    const message = asJsonRpcInbound(rawMessage);
    if (!message) return;

    if (message.method !== undefined && message.id !== undefined && message.id !== null) {
      void this.handleRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      this.resolvePending(message.id, message);
      return;
    }
    if (message.method !== undefined) {
      const handler = this.handlers.get(message.method);
      if (handler) handler(message.params);
    }
  }

  private resolvePending(id: string | number, message: JsonRpcInbound): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    if (message.error) {
      pending.reject(
        new Error(
          `stdio-acp-client: ${message.error.message} (code: ${String(message.error.code)})`,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleRequest(message: {
    id: string | number;
    method: string;
    params?: unknown;
  }): Promise<void> {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `method not found: ${message.method}` },
      });
      return;
    }

    try {
      const result = await handler(message.params);
      this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const code = extractErrorCode(err);
      console.warn("stdio-acp-client: wrote JSON-RPC error frame", {
        method: message.method,
        code,
        messageLength: err.message.length,
      });
      this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code,
          message: err.message,
        },
      });
    }
  }
}
