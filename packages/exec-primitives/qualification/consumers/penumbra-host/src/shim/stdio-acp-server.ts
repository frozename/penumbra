/**
 * Parity shim: re-creates the legacy `adapters/stdio-acp-server.ts` surface over
 * the extracted `startStdioAcpServer`. The legacy API took `binary` plus
 * optional env/cwd (host-owned defaults: inherit process env, host cwd);
 * the package requires explicit values, supplied here.
 */
import {
  startStdioAcpServer as startPackedStdioAcpServer,
  type StdioAcpHandle as PackedStdioAcpHandle,
} from "penumbra-exec-primitives";

export interface StartStdioAcpServerOptions {
  binary: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  stderrTailBytes?: number;
}

/** Legacy handle shape — getSpawnError is optional here so fixture mocks compile. */
export interface StdioAcpHandle extends Omit<PackedStdioAcpHandle, "getSpawnError"> {
  getSpawnError?: () => Error | null;
}

const NEVER_ABORTED = new AbortController().signal;

const STDIO_ACP_CANCEL_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES_DEFAULT = 8 * 1024;

function shimLogger(): { error: (message: string, fields?: Record<string, unknown>) => void } {
  return {
    error: (message, fields) => {
      if (fields && Object.keys(fields).length > 0) {
        console.error(message, fields);
      } else {
        console.error(message);
      }
    },
  };
}

function materializeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function startStdioAcpServer(
  opts: StartStdioAcpServerOptions,
): Promise<StdioAcpHandle> {
  if (opts.signal?.aborted === true) {
    const reason: unknown = opts.signal.reason;
    return await Promise.reject(
      reason instanceof Error ? reason : new Error("stdio-acp-server: start aborted"),
    );
  }
  const handle = await startPackedStdioAcpServer({
    command: opts.binary,
    args: opts.args ?? [],
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? materializeEnv(),
    signal: opts.signal ?? NEVER_ABORTED,
    cancelGraceMs: STDIO_ACP_CANCEL_GRACE_MS,
    stderrTailBytes: opts.stderrTailBytes ?? STDERR_TAIL_BYTES_DEFAULT,
    logger: shimLogger(),
    onStderrChunk: (chunk) => {
      try {
        process.stderr.write(chunk);
      } catch {
        /* stderr tee is best-effort */
      }
    },
  });
  return handle;
}
