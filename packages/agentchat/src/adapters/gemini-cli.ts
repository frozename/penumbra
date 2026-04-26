import type { Adapter, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import { spawnCliAdapter } from './cli-spawn.js';

export interface GeminiCliOptions {
  command: string;
  args?: string[];
  cwd?: string;
  pass_via?: 'stdin' | 'argv';
  env?: Record<string, string>;
  unset_env?: string[];
  strip_patterns?: string[];
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
      pass_via: this.opts.pass_via,
      env: this.opts.env,
      unset_env: this.opts.unset_env,
      strip_patterns: this.opts.strip_patterns,
    });
    return { text: out.text };
  }
}

