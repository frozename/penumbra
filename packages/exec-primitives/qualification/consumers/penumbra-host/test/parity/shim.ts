import {
  type ExecLogger,
  startStdioAcpServer as libStartStdioAcpServer,
  StdioAcpClient as LibStdioAcpClient,
  type StdioAcpClientOptions,
  type StdioAcpHandle,
} from "penumbra-exec-primitives";

const consoleLogger: ExecLogger = {
  warn: (msg, fields) => {
    console.warn(msg, fields);
  },
  error: (msg, fields) => {
    console.error(msg, JSON.stringify(fields));
  },
};

type LibClientOptions = StdioAcpClientOptions;

export const StdioAcpClient = class extends LibStdioAcpClient {
  constructor(opts: LibClientOptions) {
    super({ ...opts, logger: opts.logger ?? consoleLogger });
  }
};

export interface StartStdioAcpServerOpts {
  binary: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  stderrTailBytes?: number;
}

export async function startStdioAcpServer(opts: StartStdioAcpServerOpts): Promise<StdioAcpHandle> {
  if (opts.signal?.aborted === true) {
    const reason: unknown = opts.signal.reason;
    return await Promise.reject(reason instanceof Error ? reason : new Error(String(reason)));
  }
  return await libStartStdioAcpServer({
    command: opts.binary,
    args: opts.args ?? [],
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? { ...process.env },
    signal: opts.signal ?? new AbortController().signal,
    cancelGraceMs: 2_000,
    stderrTailBytes: opts.stderrTailBytes,
    onStderrChunk: (chunk) => {
      process.stderr.write(chunk);
    },
    logger: consoleLogger,
  });
}
