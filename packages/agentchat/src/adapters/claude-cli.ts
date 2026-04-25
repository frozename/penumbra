import type { Adapter, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import { spawnCliAdapter } from './cli-spawn.js';

export interface ClaudeCliOptions {
  command: string;
  args?: string[];
  cwd?: string;
}

export class ClaudeCliAdapter implements Adapter {
  readonly kind = 'claude-cli';
  constructor(private readonly opts: ClaudeCliOptions) {}
  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const out = await spawnCliAdapter({
      command: this.opts.command,
      args: this.opts.args ?? ['code', '--no-tty'],
      prompt: input.prompt,
      signal: input.signal,
      cwd: this.opts.cwd,
    });
    return { text: out.text };
  }
}
