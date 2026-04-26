import type { Adapter } from '../sdk/adapter.js';
import { OpenAiCompatHttpAdapter, type OpenAiCompatHttpOptions } from './openai-compat-http.js';
import { ClaudeCliAdapter } from './claude-cli.js';
import { GeminiCliAdapter } from './gemini-cli.js';
import { CodexCliAdapter } from './codex-cli.js';

export type AdapterFactory = (options: Record<string, unknown>) => Adapter;

const builtIns: Record<string, AdapterFactory> = {
  'openai-compat-http': (o) => {
    const opts = o as Partial<OpenAiCompatHttpOptions> & { api_key_env?: string };
    const apiKey = opts.apiKey ?? (opts.api_key_env ? process.env[opts.api_key_env] : undefined);
    if (!opts.baseUrl) throw new Error('openai-compat-http: baseUrl is required');
    if (!apiKey) throw new Error('openai-compat-http: apiKey or api_key_env is required');
    if (!opts.model) throw new Error('openai-compat-http: model is required');
    return new OpenAiCompatHttpAdapter({ baseUrl: opts.baseUrl, apiKey, model: opts.model, maxTokens: opts.maxTokens, extraBody: opts.extraBody });
  },
  'claude-cli': (o) => {
    const opts = o as { command?: string; args?: string[]; cwd?: string; pass_via?: 'stdin' | 'argv'; env?: Record<string, string>; unset_env?: string[]; strip_patterns?: string[] };
    if (!opts.command) throw new Error('claude-cli: command is required');
    return new ClaudeCliAdapter({ command: opts.command, args: opts.args, cwd: opts.cwd, pass_via: opts.pass_via, env: opts.env, unset_env: opts.unset_env, strip_patterns: opts.strip_patterns });
  },
  'gemini-cli': (o) => {
    const opts = o as { command?: string; args?: string[]; cwd?: string; pass_via?: 'stdin' | 'argv'; env?: Record<string, string>; unset_env?: string[]; strip_patterns?: string[] };
    if (!opts.command) throw new Error('gemini-cli: command is required');
    return new GeminiCliAdapter({ command: opts.command, args: opts.args, cwd: opts.cwd, pass_via: opts.pass_via, env: opts.env, unset_env: opts.unset_env, strip_patterns: opts.strip_patterns });
  },
  'codex-cli': (o) => {
    const opts = o as { command?: string; args?: string[]; cwd?: string; pass_via?: 'stdin' | 'argv'; env?: Record<string, string>; unset_env?: string[]; strip_patterns?: string[] };
    if (!opts.command) throw new Error('codex-cli: command is required');
    return new CodexCliAdapter({ command: opts.command, args: opts.args, cwd: opts.cwd, pass_via: opts.pass_via, env: opts.env, unset_env: opts.unset_env, strip_patterns: opts.strip_patterns });
  },
};

export function buildAdapter(kind: string, options: Record<string, unknown>): Adapter {
  const factory = builtIns[kind];
  if (!factory) throw new Error(`unknown adapter kind: ${kind}`);
  return factory(options);
}

export function registerAdapter(kind: string, factory: AdapterFactory): void {
  builtIns[kind] = factory;
}

export function clearCustomAdapters(): void {
  for (const key of Object.keys(builtIns)) {
    if (!['openai-compat-http', 'claude-cli', 'gemini-cli', 'codex-cli'].includes(key)) {
      delete builtIns[key];
    }
  }
}
