import type { Adapter, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import { spawnCliAdapter } from './cli-spawn.js';

export interface GeminiCliOptions {
  command: string;
  args?: string[];
  cwd?: string;
}

export class GeminiCliAdapter implements Adapter {
  readonly kind = 'gemini-cli';
  constructor(private readonly opts: GeminiCliOptions) {}
  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const out = await spawnCliAdapter({
      command: this.opts.command,
      args: this.opts.args ?? [],
      prompt: input.prompt,
      signal: input.signal,
      cwd: this.opts.cwd,
    });
    return { text: out.text };
  }
}
