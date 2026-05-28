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

const PASS_THROUGH_ENV_KEYS = ["LANG", "LC_ALL"];

export async function spawnSandboxed(opts: SpawnSandboxedOpts): Promise<SpawnSandboxedResult> {
  if (!opts.argv && !opts.cmd) throw new Error("spawnSandboxed: argv or cmd required");

  const argv = opts.argv ?? ["bash", "-c", opts.cmd ?? ""];

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

  const start = performance.now();
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err: any) {
    if (err?.code === "ENOENT" || /Executable not found/i.test(String(err?.message ?? err))) {
      return {
        exitCode: 127,
        signal: null,
        output: "",
        truncated: false,
        durationMs: Math.round(performance.now() - start),
        argv,
        envKeys: Object.keys(env),
      };
    }
    throw err;
  }

  let buf = "";
  let truncated = false;
  let killReason: SpawnSandboxedResult["killReason"];

  const ingest = (chunk: string) => {
    if (truncated) return;
    const currentBytes = Buffer.byteLength(buf, "utf8");
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (currentBytes + chunkBytes > opts.outputMaxBytes) {
      const remaining = opts.outputMaxBytes - currentBytes;
      buf += chunk.slice(0, Math.max(0, remaining));
      truncated = true;
      killReason = "output_overflow";
      if (proc) {
        try {
          proc.kill("SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }, 2000);
      }
      return;
    }
    buf += chunk;
  };

  const readStream = async (s: ReadableStream<Uint8Array> | null) => {
    if (!s) return;
    const reader = s.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        ingest(dec.decode(value, { stream: true }));
      }
      const tail = dec.decode();
      if (tail) ingest(tail);
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  };

  const timeoutHandle = setTimeout(() => {
    if (proc?.exitCode !== null) return;
    killReason ??= "timeout";
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 2000);
    }
  }, opts.timeoutMs);

  const onAbort = () => {
    if (proc?.exitCode !== null) return;
    killReason ??= "cancelled";
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 2000);
    }
  };

  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await Promise.all([
      readStream(proc.stdout as ReadableStream<Uint8Array> | null),
      readStream(proc.stderr as ReadableStream<Uint8Array> | null),
    ]);
    await proc.exited;
  } finally {
    clearTimeout(timeoutHandle);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }

  const durationMs = Math.round(performance.now() - start);
  const exitCode = proc.exitCode ?? -1;
  const sig = (proc.signalCode as NodeJS.Signals | null) ?? null;

  return {
    exitCode,
    signal: sig,
    output: buf,
    truncated,
    durationMs,
    argv,
    envKeys: Object.keys(env),
    killReason,
  };
}
