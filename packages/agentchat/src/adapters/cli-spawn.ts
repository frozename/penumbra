export interface SpawnOpts {
  command: string;
  args: string[];
  prompt: string;
  signal: AbortSignal;
  env?: Record<string, string>;
  /** Names of inherited env vars to drop before spawning (e.g. when an inherited OPENAI_BASE_URL would override the CLI's own auth). */
  unset_env?: string[];
  cwd?: string;
  pass_via?: 'stdin' | 'argv';
  /** Regex patterns whose matching output lines are removed before returning. Useful for CLIs whose own hook/wrapper code prints chatty noise around the model reply. */
  strip_patterns?: string[];
  /** Optional callback fired when a vendor capacity-error pattern is detected in stderr. */
  onCapacityError?: (err: CapacityError) => void;
}

const CAPACITY_PATTERNS: Array<{ provider: string; re: RegExp }> = [
  { provider: 'google', re: /No capacity available for model ([\w.\-]+)/ },
];

export interface CapacityError {
  provider: string;
  model: string | null;
  raw: string;
}

export function detectCapacityError(stderr: string): CapacityError | null {
  if (!stderr) return null;
  for (const p of CAPACITY_PATTERNS) {
    const m = stderr.match(p.re);
    if (m) {
      return { provider: p.provider, model: m[1] ?? null, raw: m[0] };
    }
  }
  return null;
}

const DEFAULT_CANCEL_GRACE_S = 10;
const DEFAULT_DISPATCH_TIMEOUT_S = 900;

function applyStripPatterns(text: string, patterns: string[] | undefined): string {
  if (!patterns || patterns.length === 0) return text;
  const compiled = patterns.map((p) => new RegExp(p));
  const lines = text.split('\n');
  const kept = lines.filter((line) => !compiled.some((re) => re.test(line)));
  return kept.join('\n');
}

function readCancelGraceMs(raw?: string): number {
  if (raw == null || raw.trim() === '') return DEFAULT_CANCEL_GRACE_S * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CANCEL_GRACE_S * 1000;
  return parsed * 1000;
}

function readDispatchTimeoutMs(raw?: string): number {
  if (raw == null || raw.trim() === '') return DEFAULT_DISPATCH_TIMEOUT_S * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DISPATCH_TIMEOUT_S * 1000;
  return parsed * 1000;
}

export async function spawnCliAdapter(opts: SpawnOpts): Promise<{ text: string; stderr: string }> {
  const isArgv = opts.pass_via === 'argv';
  const finalArgs = isArgv ? [...opts.args, opts.prompt] : opts.args;

  const mergedEnv: Record<string, string> = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
  for (const key of opts.unset_env ?? []) delete mergedEnv[key];

  const cancelGraceMs = readCancelGraceMs(opts.env?.PENUMBRA_CANCEL_GRACE_S ?? process.env.PENUMBRA_CANCEL_GRACE_S);
  const dispatchTimeoutMs = readDispatchTimeoutMs(opts.env?.PENUMBRA_DISPATCH_TIMEOUT_S ?? process.env.PENUMBRA_DISPATCH_TIMEOUT_S);
  // When the prompt is passed via argv, the child has no reason to read stdin.
  // Wiring an empty pipe and then end()-ing it has been observed to leave
  // stdin-reading CLIs (notably `codex exec`) blocked indefinitely on EOF
  // when spawned from long-running worker processes — close the read side
  // up front instead so the child sees an immediate EOF on stdin.
  const proc = Bun.spawn([opts.command, ...finalArgs], {
    stdin: isArgv ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: mergedEnv,
    cwd: opts.cwd,
  });

  let cancelTimer: ReturnType<typeof setTimeout> | null = null;
  const kill = (kind: 'SIGTERM' | 'SIGKILL') => {
    try {
      proc.kill(kind);
    } catch {
      // Process may already be gone.
    }
  };
  const onAbort = () => {
    kill('SIGTERM');
    cancelTimer = setTimeout(() => kill('SIGKILL'), cancelGraceMs);
  };

  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener('abort', onAbort, { once: true });

  if (!isArgv && proc.stdin) {
    proc.stdin.write(opts.prompt);
    await proc.stdin.end();
  }

  // Watchdog: bound the total dispatch in case the child writes nothing
  // and proc.exited never resolves (observed under Bun 1.3.13 when a child
  // tree dies in some races). On timeout, SIGKILL the proc and reject so
  // the worker frees up instead of waiting forever.
  let dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  const watchdog = new Promise<never>((_, reject) => {
    dispatchTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`${opts.command}: dispatch exceeded ${dispatchTimeoutMs}ms (watchdog)`));
    }, dispatchTimeoutMs);
  });

  try {
    const result = await Promise.race([
      (async () => {
        const rawText = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const capErr = detectCapacityError(stderr);
        if (capErr && opts.onCapacityError) {
          try {
            opts.onCapacityError(capErr);
          } catch {
            // Callback failures must not break the spawn return path.
          }
        }
        const code = await proc.exited;
        return { rawText, stderr, code };
      })(),
      watchdog,
    ]);
    if (result.code !== 0) {
      throw new Error(`${opts.command}: exit code ${result.code}${result.stderr ? ` — ${result.stderr}` : ''}`);
    }
    return {
      text: applyStripPatterns(result.rawText, opts.strip_patterns),
      stderr: result.stderr,
    };
  } finally {
    if (dispatchTimer) clearTimeout(dispatchTimer);
    if (cancelTimer) clearTimeout(cancelTimer);
    opts.signal.removeEventListener('abort', onAbort);
  }
}
