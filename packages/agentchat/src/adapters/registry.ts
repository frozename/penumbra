import type { Adapter } from '../sdk/adapter.js';
import { OpenAiCompatHttpAdapter, type OpenAiCompatHttpOptions } from './openai-compat-http.js';
import { ClaudeCliAdapter } from './claude-cli.js';
import { GeminiCliAdapter } from './gemini-cli.js';
import { CodexCliAdapter } from './codex-cli.js';
import { OpencodeAcpAdapter, type OpencodeAcpOptions } from './opencode-acp.js';
import { OpencodeCliAdapter, type OpencodeCliOptions } from './opencode-cli.js';
import { StdioAcpAdapter, type StdioAcpOptions } from './stdio-acp.js';

export type AdapterFactory = (options: Record<string, unknown>) => Adapter;

const builtIns: Record<string, AdapterFactory> = {
  'stdio-acp': (o) => {
    const opts = o as Partial<StdioAcpOptions>;
    if (!opts.binary) throw new Error('stdio-acp: binary is required');
    return new StdioAcpAdapter({
      binary: opts.binary,
      args: opts.args,
      model: opts.model,
      cwd: opts.cwd,
      env: opts.env,
      unsetEnv: opts.unsetEnv,
      bootTimeoutMs: opts.bootTimeoutMs,
      requestTimeoutMs: opts.requestTimeoutMs,
      authMethodId: opts.authMethodId,
      framing: opts.framing,
      fsReadTextFile: opts.fsReadTextFile,
      mcpServers: opts.mcpServers,
    });
  },
  'openai-compat-http': (o) => {
    // Legacy alias: `api_key_env` (snake_case) is treated as `apiKeyEnv`.
    const opts = o as Partial<OpenAiCompatHttpOptions> & { api_key_env?: string };
    if (!opts.baseUrl) throw new Error('openai-compat-http: baseUrl is required');
    if (!opts.model) throw new Error('openai-compat-http: model is required');
    const apiKeyEnv = opts.apiKeyEnv ?? opts.api_key_env;
    const hasKeySource = Boolean(opts.apiKey) || Boolean(apiKeyEnv) || Boolean(opts.apiKeyKeychain) || Boolean(opts.apiKeyFile);
    if (!hasKeySource) {
      throw new Error('openai-compat-http: one of apiKey / apiKeyEnv / apiKeyKeychain / apiKeyFile is required');
    }
    return new OpenAiCompatHttpAdapter({
      baseUrl: opts.baseUrl,
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(opts.apiKeyKeychain ? { apiKeyKeychain: opts.apiKeyKeychain } : {}),
      ...(opts.apiKeyFile ? { apiKeyFile: opts.apiKeyFile } : {}),
      model: opts.model,
      maxTokens: opts.maxTokens,
      extraBody: opts.extraBody,
      caPath: opts.caPath,
      systemPrompt: opts.systemPrompt,
    });
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
  'opencode-cli': (o) => {
    const opts = o as Partial<OpencodeCliOptions>;
    if (!opts.model) throw new Error('opencode-cli: model is required');
    return new OpencodeCliAdapter({
      model: opts.model,
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      pass_via: opts.pass_via,
      env: opts.env,
      unset_env: opts.unset_env,
      strip_patterns: opts.strip_patterns,
      mcpServers: opts.mcpServers,
    });
  },
  'opencode-acp': (o) => {
    const opts = o as Partial<OpencodeAcpOptions>;
    if (!opts.model) throw new Error('opencode-acp: model is required');
    return new OpencodeAcpAdapter({
      model: opts.model,
      cwd: opts.cwd,
      opencodeBinary: opts.opencodeBinary,
      bootTimeoutMs: opts.bootTimeoutMs,
      requestTimeoutMs: opts.requestTimeoutMs,
      mcpServers: opts.mcpServers,
    });
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
    if (!['openai-compat-http', 'claude-cli', 'gemini-cli', 'codex-cli', 'opencode-cli', 'opencode-acp', 'stdio-acp'].includes(key)) {
      delete builtIns[key];
    }
  }
}
