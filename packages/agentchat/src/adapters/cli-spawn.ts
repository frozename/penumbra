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
}

const DEFAULT_CANCEL_GRACE_S = 10;

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

export async function spawnCliAdapter(opts: SpawnOpts): Promise<{ text: string; stderr: string }> {
  const isArgv = opts.pass_via === 'argv';
  const finalArgs = isArgv ? [...opts.args, opts.prompt] : opts.args;

  const mergedEnv: Record<string, string> = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
  for (const key of opts.unset_env ?? []) delete mergedEnv[key];

  const cancelGraceMs = readCancelGraceMs(opts.env?.PENUMBRA_CANCEL_GRACE_S ?? process.env.PENUMBRA_CANCEL_GRACE_S);
  const proc = Bun.spawn([opts.command, ...finalArgs], {
    stdin: 'pipe',
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

  if (!isArgv) {
    proc.stdin.write(opts.prompt);
  }
  await proc.stdin.end();
  try {
    const rawText = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`${opts.command}: exit code ${code}${stderr ? ` — ${stderr}` : ''}`);
    }
    return {
      text: applyStripPatterns(rawText, opts.strip_patterns),
      stderr,
    };
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
    opts.signal.removeEventListener('abort', onAbort);
  }
}
