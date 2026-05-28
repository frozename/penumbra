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

/** Frame a JSON-RPC message for stdin. Adds the trailing newline. */
export function frame(message: object): string {
  return JSON.stringify(message) + "\n";
}

/**
 * Parse a sequence of byte chunks (e.g. from a stream's reader) into
 * JSON-RPC messages. Yields one parsed object per newline-delimited
 * chunk. Trailing partial line is discarded.
 */
export function* parseChunks(chunks: Iterable<Uint8Array>): Generator<unknown> {
  const dec = new TextDecoder();
  let buffer = "";
  for (const chunk of chunks) {
    buffer += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      yield JSON.parse(line);
    }
  }
}

/**
 * JSON-RPC client wrapping a Bun child process's stdin/stdout streams.
 * Auto-increments request IDs. `request()` resolves with the response.
 */
export class JsonRpcStdioClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
    }
  >();
  private readonly readerLoop: Promise<void>;
  private closed = false;
  private readerDead = false;

  constructor(private readonly proc: BunSubprocess) {
    this.readerLoop = this.readForever();
  }

  private async readForever(): Promise<void> {
    const stdout = this.proc.stdout as unknown as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.length === 0) continue;
          let msg: JsonRpcResponse | JsonRpcNotification;
          try {
            msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
          } catch {
            continue;
          }
          if ("id" in msg && typeof msg.id === "number") {
            const pending = this.pending.get(msg.id);
            if (!pending) continue;
            this.pending.delete(msg.id);
            if (msg.error)
              pending.reject(new Error(`JSON-RPC error: ${msg.error.code} ${msg.error.message}`));
            else pending.resolve(msg.result);
          }
          // Notifications (no id) are ignored by this minimal client.
        }
      }
    } catch (err) {
      this.readerDead = true;
      for (const pending of this.pending.values()) pending.reject(err as Error);
      this.pending.clear();
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) throw new Error("client is closed");
    if (this.readerDead) throw new Error("reader loop has died (subprocess likely crashed)");
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    // Re-check after registering to close the race window where readForever
    // crashes between our pre-check and the pending.set.
    if (this.readerDead) {
      this.pending.delete(id);
      throw new Error("reader loop died while registering request");
    }
    const sink = this.proc.stdin as unknown as FileSink;
    sink.write(frame(req));
    await sink.flush();
    return resultPromise;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new Error("client is closed");
    const note: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    const sink = this.proc.stdin as unknown as FileSink;
    sink.write(frame(note));
    await sink.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
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
