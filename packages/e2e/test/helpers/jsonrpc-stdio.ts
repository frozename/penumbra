/**
 * Minimal newline-delimited JSON-RPC client for the MCP stdio transport.
 *
 * MCP stdio framing per spec: "Messages are encoded as JSON-RPC 2.0
 * messages, separated by newlines. Messages MUST NOT contain embedded
 * newlines." We do NOT use Content-Length / LSP-style framing.
 *
 * Bun subprocess I/O types at runtime:
 *   stdin  → FileSink  (.write(data), .end(), .flush())
 *   stdout → ReadableStream<Uint8Array>  (.getReader())
 */
import type { BunSubprocess } from "./spawn-bin.js";

/** Bun FileSink — the actual runtime type of proc.stdin when stdin:'pipe'. */
interface FileSink {
  write(data: string | ArrayBufferView | ArrayBuffer): number;
  flush(): void | Promise<void>;
  end(): void | Promise<void>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** Frame a JSON-RPC message for stdin. Adds the trailing newline. */
export function frame(message: object): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Parse a sequence of byte chunks (e.g. from a stream's reader) into
 * JSON-RPC messages. Yields one parsed object per newline-delimited
 * chunk. Trailing partial line is discarded.
 */
export function* parseChunks(chunks: Iterable<Uint8Array>): Generator {
  const dec = new TextDecoder();
  let buffer = "";
  for (const chunk of chunks) {
    buffer += dec.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        yield JSON.parse(line);
      }
      nl = buffer.indexOf("\n");
    }
  }
}

/**
 * JSON-RPC client wrapping a Bun child process's stdin/stdout streams.
 * Auto-increments request IDs. `request()` resolves with the response.
 */
export class JsonRpcStdioClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private readonly readerLoop: Promise<void>;
  private closed = false;
  private readerDead = false;

  constructor(private readonly proc: BunSubprocess) {
    this.readerLoop = this.readForever();
  }

  // Method indirection so the type system does not narrow the boolean
  // field across async pending.set calls (which it can't see mutate state).
  private isReaderDead(): boolean {
    return this.readerDead;
  }

  private dispatchMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
    if (!("id" in msg) || typeof msg.id !== "number") {
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      return;
    }
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(`JSON-RPC error: ${String(msg.error.code)} ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private flushBuffer(buffer: string): string {
    let remaining = buffer;
    let nl = remaining.indexOf("\n");
    while (nl !== -1) {
      const line = remaining.slice(0, nl);
      remaining = remaining.slice(nl + 1);
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
          this.dispatchMessage(msg);
        } catch {
          /* skip non-JSON noise */
        }
      }
      nl = remaining.indexOf("\n");
    }
    return remaining;
  }

  private async readForever(): Promise<void> {
    const stdout = this.proc.stdout as unknown as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += dec.decode(value, { stream: true });
        buffer = this.flushBuffer(buffer);
      }
    } catch (err) {
      this.readerDead = true;
      const error = err as Error;
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      throw new Error("client is closed");
    }
    if (this.isReaderDead()) {
      throw new Error("reader loop has died (subprocess likely crashed)");
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    // Re-check after registering to close the race window where readForever
    // crashes between our pre-check and the pending.set.
    if (this.isReaderDead()) {
      this.pending.delete(id);
      throw new Error("reader loop died while registering request");
    }
    const sink = this.proc.stdin as unknown as FileSink;
    sink.write(frame(req));
    await sink.flush();
    return await resultPromise;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) {
      throw new Error("client is closed");
    }
    const note: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    const sink = this.proc.stdin as unknown as FileSink;
    sink.write(frame(note));
    await sink.flush();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      const sink = this.proc.stdin as unknown as FileSink;
      await sink.end();
    } catch {
      /* already closed */
    }
    await this.readerLoop;
  }
}
