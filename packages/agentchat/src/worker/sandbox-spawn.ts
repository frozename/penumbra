export interface SpawnSandboxedOpts {
  argv?: string[];
  cmd?: string;
  cwd: string;
  envOverride?: Record<string, string>;
  timeoutMs: number;
  outputMaxBytes: number;
  signal?: AbortSignal;
  /** Override the sandbox PATH; default '/usr/bin:/bin' */
  path?: string;
}

export interface SpawnSandboxedResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  output: string;
  truncated: boolean;
  durationMs: number;
  argv: string[];
  envKeys: string[];
  killReason?: "timeout" | "output_overflow" | "cancelled";
}

type Subprocess = ReturnType<typeof Bun.spawn>;

const PASS_THROUGH_ENV_KEYS = ["LANG", "LC_ALL"];

function isExecutableMissingError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  return /Executable not found/i.test(message);
}

function buildSandboxEnv(opts: SpawnSandboxedOpts): Record<string, string> {
  const env: Record<string, string> = {
    PATH: opts.path ?? "/usr/bin:/bin",
    HOME: opts.cwd,
    CI: "true",
    TERM: "dumb",
  };
  for (const key of PASS_THROUGH_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  for (const [k, v] of Object.entries(opts.envOverride ?? {})) env[k] = v;
  return env;
}

function killProc(proc: Subprocess): void {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* SIGTERM may race with natural exit */
  }
  setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* SIGKILL may race with natural exit */
    }
  }, 2000);
}

async function readStream(
  s: ReadableStream<Uint8Array> | null,
  ingest: (c: string) => void,
): Promise<void> {
  if (!s) return;
  const reader = s.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      ingest(dec.decode(value, { stream: true }));
    }
    const tail = dec.decode();
    if (tail) ingest(tail);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* releaseLock may throw if stream already finalized */
    }
  }
}

export async function spawnSandboxed(opts: SpawnSandboxedOpts): Promise<SpawnSandboxedResult> {
  if (!opts.argv && !opts.cmd) throw new Error("spawnSandboxed: argv or cmd required");

  const argv = opts.argv ?? ["bash", "-c", opts.cmd ?? ""];
  const env = buildSandboxEnv(opts);
  const envKeys = Object.keys(env);

  const start = performance.now();
  let proc: Subprocess;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    if (isExecutableMissingError(err)) {
      return {
        exitCode: 127,
        signal: null,
        output: "",
        truncated: false,
        durationMs: Math.round(performance.now() - start),
        argv,
        envKeys,
      };
    }
    throw err;
  }

  let buf = "";
  let truncated = false;
  let killReason: SpawnSandboxedResult["killReason"];

  const ingest = (chunk: string): void => {
    if (truncated) return;
    const currentBytes = Buffer.byteLength(buf, "utf8");
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (currentBytes + chunkBytes > opts.outputMaxBytes) {
      const remaining = opts.outputMaxBytes - currentBytes;
      buf += chunk.slice(0, Math.max(0, remaining));
      truncated = true;
      killReason = "output_overflow";
      killProc(proc);
      return;
    }
    buf += chunk;
  };

  const timeoutHandle = setTimeout(() => {
    if (proc.exitCode !== null) return;
    killReason ??= "timeout";
    killProc(proc);
  }, opts.timeoutMs);

  const onAbort = (): void => {
    if (proc.exitCode !== null) return;
    killReason ??= "cancelled";
    killProc(proc);
  };

  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await Promise.all([
      readStream(proc.stdout as ReadableStream<Uint8Array> | null, ingest),
      readStream(proc.stderr as ReadableStream<Uint8Array> | null, ingest),
    ]);
    await proc.exited;
  } finally {
    clearTimeout(timeoutHandle);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }

  const durationMs = Math.round(performance.now() - start);
  const exitCode = proc.exitCode ?? -1;
  const sig = proc.signalCode ?? null;

  return {
    exitCode,
    signal: sig,
    output: buf,
    truncated,
    durationMs,
    argv,
    envKeys,
    killReason,
  };
}
