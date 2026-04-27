import type { Adapter, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import { spawnCliAdapter } from './cli-spawn.js';
import { resolveAdapterApiKey } from './secret.js';

export interface OpencodeCliOptions {
  model: string;
  command?: string;
  args?: string[];
  cwd?: string;
  pass_via?: 'stdin' | 'argv';
  env?: Record<string, string>;
  unset_env?: string[];
  strip_patterns?: string[];
}

export class OpencodeCliAdapter implements Adapter {
  readonly kind = 'opencode-cli';
  constructor(private readonly opts: OpencodeCliOptions) {}

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const model = this.opts.model.includes('/') ? this.opts.model : `opencode/${this.opts.model}`;
    const command = this.opts.command ?? '~/.opencode/bin/opencode'.replace(/^~/, process.env.HOME ?? '');
    const baseArgs = this.opts.args ?? ['run', '--model', model];

    let apiKey = '';
    try {
      apiKey = resolveAdapterApiKey({ apiKeyKeychain: 'llamactl/opencode' });
    } catch {
      // Graceful degradation: let the CLI handle missing credentials
    }

    const out = await spawnCliAdapter({
      command,
      args: baseArgs,
      prompt: input.prompt,
      signal: input.signal,
      cwd: this.opts.cwd,
      pass_via: this.opts.pass_via ?? 'argv',
      env: { ...this.opts.env, OPENCODE_API_KEY: apiKey },
      unset_env: this.opts.unset_env,
      strip_patterns: this.opts.strip_patterns,
    });
    return { text: out.text };
  }
}
