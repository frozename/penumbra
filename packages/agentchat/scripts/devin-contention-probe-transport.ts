import { type ChildProcessWithoutNullStreams } from "node:child_process";

const STDERR_TAIL_BYTES = 8_192;
const CLOSE_GRACE_MS = 1_000;

interface JsonRpcResponse {
  error?: { message?: string };
  id?: number | string;
  result?: unknown;
}

interface PendingRequest {
  reject: (err: Error) => void;
  resolve: (value: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function appendTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > STDERR_TAIL_BYTES ? next.slice(-STDERR_TAIL_BYTES) : next;
}

export class JsonRpcClient {
  private buffer = "";
  private readonly exitPromise: Promise<number | null>;
  private readonly pending = new Map<number, PendingRequest>();
  private requestId = 0;
  private stderr = "";

  constructor(private readonly proc: ChildProcessWithoutNullStreams) {
    this.exitPromise = new Promise((resolve) => {
      this.proc.once("exit", (code) => {
        resolve(code);
      });
    });
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.consumeStdout(chunk.toString("utf8"));
    });
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendTail(this.stderr, chunk);
    });
    this.proc.on("exit", () => {
      this.rejectAll(new Error("transport closed"));
    });
    // A child exiting mid-write can surface EPIPE on stdin; an unhandled
    // 'error' event there would crash the parent.
    this.proc.stdin.on("error", () => {
      // deliberately empty
    });
  }

  get pid(): number {
    return this.proc.pid ?? 0;
  }

  get stderrTail(): string {
    return this.stderr;
  }

  async close(): Promise<number | null> {
    if (this.proc.exitCode !== null) {
      return this.proc.exitCode;
    }
    this.proc.stdin.end();
    const graceful = await this.waitForExit(CLOSE_GRACE_MS);
    if (graceful !== undefined) {
      return graceful;
    }
    this.proc.kill("SIGTERM");
    const terminated = await this.waitForExit(CLOSE_GRACE_MS);
    if (terminated !== undefined) {
      return terminated;
    }
    this.proc.kill("SIGKILL");
    return await this.exitPromise;
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = ++this.requestId;
    const body = JSON.stringify({ id, jsonrpc: "2.0", method, params });
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timeout });
    });
    this.proc.stdin.write(`${body}\n`);
    return promise;
  }

  private waitForExit(timeoutMs: number): Promise<number | null | undefined> {
    return Promise.race([
      this.exitPromise,
      new Promise<undefined>((resolve) => {
        setTimeout(() => {
          resolve(undefined);
        }, timeoutMs).unref();
      }),
    ]);
  }

  private consumeStdout(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof parsed.id !== "number") {
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(parsed.id);
    clearTimeout(pending.timeout);
    if (parsed.error) {
      pending.reject(new Error(parsed.error.message ?? "json-rpc error"));
    } else {
      pending.resolve(parsed.result);
    }
  }

  private rejectAll(err: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const item of pending) {
      clearTimeout(item.timeout);
      item.reject(err);
    }
  }
}
