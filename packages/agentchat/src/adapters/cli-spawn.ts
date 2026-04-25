export interface SpawnOpts {
  command: string;
  args: string[];
  prompt: string;
  signal: AbortSignal;
  env?: Record<string, string>;
  cwd?: string;
}

export async function spawnCliAdapter(opts: SpawnOpts): Promise<{ text: string }> {
  const proc = Bun.spawn([opts.command, ...opts.args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd,
    signal: opts.signal,
  });
  proc.stdin.write(opts.prompt);
  await proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${opts.command}: exit code ${code}${err ? ` — ${err}` : ''}`);
  }
  return { text };
}
