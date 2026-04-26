export interface SpawnOpts {
  command: string;
  args: string[];
  prompt: string;
  signal: AbortSignal;
  env?: Record<string, string>;
  cwd?: string;
  pass_via?: 'stdin' | 'argv';
}

export async function spawnCliAdapter(opts: SpawnOpts): Promise<{ text: string }> {
  const isArgv = opts.pass_via === 'argv';
  const finalArgs = isArgv ? [...opts.args, opts.prompt] : opts.args;
  
  const proc = Bun.spawn([opts.command, ...finalArgs], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd,
    signal: opts.signal,
  });
  if (!isArgv) {
    proc.stdin.write(opts.prompt);
  }
  await proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${opts.command}: exit code ${code}${err ? ` — ${err}` : ''}`);
  }
  return { text };
}
