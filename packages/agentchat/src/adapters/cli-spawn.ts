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

function applyStripPatterns(text: string, patterns: string[] | undefined): string {
  if (!patterns || patterns.length === 0) return text;
  const compiled = patterns.map((p) => new RegExp(p));
  const lines = text.split('\n');
  const kept = lines.filter((line) => !compiled.some((re) => re.test(line)));
  return kept.join('\n');
}

export async function spawnCliAdapter(opts: SpawnOpts): Promise<{ text: string; stderr: string }> {
  const isArgv = opts.pass_via === 'argv';
  const finalArgs = isArgv ? [...opts.args, opts.prompt] : opts.args;

  const mergedEnv: Record<string, string> = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
  for (const key of opts.unset_env ?? []) delete mergedEnv[key];

  const proc = Bun.spawn([opts.command, ...finalArgs], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: mergedEnv,
    cwd: opts.cwd,
    signal: opts.signal,
  });
  if (!isArgv) {
    proc.stdin.write(opts.prompt);
  }
  await proc.stdin.end();
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
}
