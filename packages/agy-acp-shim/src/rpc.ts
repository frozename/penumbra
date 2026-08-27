// Framing: newline-delimited JSON (stdio-acp-client.ts default, line 46:
//   `this.framing = options.framing ?? 'newline'`)
// content-length mode is available via the optional `framing` parameter.

import { createInterface } from "node:readline";

export type RpcRequest = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
};

export type RpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type RpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type RpcHandlers = Record<string, (params: unknown) => Promise<unknown>>;

export interface RpcServer {
  notify(method: string, params?: unknown): void;
  start(): void;
}

export interface RpcServerIo {
  input?: NodeJS.ReadableStream;
  output?: { write(chunk: string): unknown };
}

function rpcErrorCode(err: unknown): number {
  if (typeof err !== "object" || err === null || !("code" in err)) return -32000;
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" && Number.isFinite(code) ? code : -32000;
}

/** Encodes a JSON-RPC message as newline-delimited JSON (stdio-acp default). */
export function encodeMessage(msg: object): string {
  return JSON.stringify(msg) + "\n";
}

/** Encodes using LSP content-length framing (not used by stdio-acp by default). */
export function encodeMessageContentLength(msg: object): string {
  const json = JSON.stringify(msg);
  const byteLen = Buffer.byteLength(json, "utf8");
  return `Content-Length: ${String(byteLen)}\r\n\r\n${json}`;
}

/**
 * Decodes newline-delimited JSON messages from a string buffer.
 * Blank lines and lines not starting with `{` are silently skipped.
 */
export function decodeMessages(buf: string): object[] {
  const results: object[] = [];
  for (const line of buf.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      results.push(JSON.parse(trimmed) as object);
    } catch {
      // malformed JSON — skip
    }
  }
  return results;
}

/**
 * Creates a JSON-RPC server that reads newline-delimited requests from stdin
 * and writes responses + notifications to stdout.
 */
export function createRpcServer(handlers: RpcHandlers, io: RpcServerIo = {}): RpcServer {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const write = (msg: object): void => {
    output.write(encodeMessage(msg));
  };

  const notify = (method: string, params?: unknown): void => {
    const notification: RpcNotification = { jsonrpc: "2.0", method };
    if (params !== undefined) notification.params = params;
    write(notification);
  };

  const start = (): void => {
    const rl = createInterface({ input, terminal: false });

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;

      let req: RpcRequest;
      try {
        req = JSON.parse(trimmed) as RpcRequest;
      } catch {
        const errResp: RpcResponse = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        };
        write(errResp);
        return;
      }

      const handler = handlers[req.method];
      if (!handler) {
        const errResp: RpcResponse = {
          jsonrpc: "2.0",
          id: req.id ?? null,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
        write(errResp);
        return;
      }

      Promise.resolve()
        .then(() => handler(req.params ?? {}))
        .then(
          (result) => {
            const resp: RpcResponse = { jsonrpc: "2.0", id: req.id ?? null, result };
            write(resp);
          },
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            const resp: RpcResponse = {
              jsonrpc: "2.0",
              id: req.id ?? null,
              error: { code: rpcErrorCode(err), message },
            };
            write(resp);
          },
        );
    });
  };

  return { notify, start };
}
