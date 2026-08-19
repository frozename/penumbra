import type { Adapter } from "../sdk/adapter.js";
import type { CapturePort } from "../worker/capture-port.js";

import { getOrCreateAcpWarmPool } from "./acp-warm-pool-registry.js";
import { AgyCliAdapter } from "./agy-cli.js";
import { ClaudeCliAdapter } from "./claude-cli.js";
import { CodexCliAdapter } from "./codex-cli.js";
import { GeminiCliAdapter } from "./gemini-cli.js";
import { OpenAiCompatHttpAdapter, type OpenAiCompatHttpOptions } from "./openai-compat-http.js";
import { OpencodeAcpAdapter, type OpencodeAcpOptions } from "./opencode-acp.js";
import { OpencodeCliAdapter, type OpencodeCliOptions } from "./opencode-cli.js";
import { StdioAcpClient } from "./stdio-acp-client.js";
import { startStdioAcpServer } from "./stdio-acp-server.js";
import { StdioAcpAdapter, type StdioAcpOptions, type StdioAcpThoughtCapture } from "./stdio-acp.js";

export type AdapterFactory = (options: Record<string, unknown>) => Adapter;

export const BUILT_IN_ADAPTER_KINDS = [
  "openai-compat-http",
  "claude-cli",
  "gemini-cli",
  "agy-cli",
  "codex-cli",
  "opencode-cli",
  "opencode-acp",
  "stdio-acp",
] as const;

const builtIns = new Map<string, AdapterFactory>();

const BUILT_IN_FACTORIES: Record<string, AdapterFactory> = {
  "stdio-acp": (o) => createStdioAcpAdapter(o),
  "openai-compat-http": (o) => {
    // Legacy alias: `api_key_env` (snake_case) is treated as `apiKeyEnv`.
    const opts = o as Partial<OpenAiCompatHttpOptions> & { api_key_env?: string };
    if (!opts.baseUrl) throw new Error("openai-compat-http: baseUrl is required");
    if (!opts.model) throw new Error("openai-compat-http: model is required");
    const apiKeyEnv = opts.apiKeyEnv ?? opts.api_key_env;
    const hasKeySource =
      Boolean(opts.apiKey) ||
      Boolean(apiKeyEnv) ||
      Boolean(opts.apiKeyKeychain) ||
      Boolean(opts.apiKeyFile);
    if (!hasKeySource) {
      throw new Error(
        "openai-compat-http: one of apiKey / apiKeyEnv / apiKeyKeychain / apiKeyFile is required",
      );
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
      requestTimeoutMs: opts.requestTimeoutMs,
      capturePort: opts.capturePort,
    });
  },
  "claude-cli": (o) => {
    const opts = o as {
      command?: string;
      args?: string[];
      cwd?: string;
      pass_via?: "stdin" | "argv";
      env?: Record<string, string>;
      unset_env?: string[];
      strip_patterns?: string[];
      capturePort?: CapturePort;
    };
    if (!opts.command) throw new Error("claude-cli: command is required");
    return new ClaudeCliAdapter({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      pass_via: opts.pass_via,
      env: opts.env,
      unset_env: opts.unset_env,
      strip_patterns: opts.strip_patterns,
      capturePort: opts.capturePort,
    });
  },
  "gemini-cli": (o) => {
    const opts = o as {
      command?: string;
      args?: string[];
      cwd?: string;
      pass_via?: "stdin" | "argv";
      env?: Record<string, string>;
      unset_env?: string[];
      strip_patterns?: string[];
      capturePort?: CapturePort;
    };
    if (!opts.command) throw new Error("gemini-cli: command is required");
    return new GeminiCliAdapter({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      pass_via: opts.pass_via,
      env: opts.env,
      unset_env: opts.unset_env,
      strip_patterns: opts.strip_patterns,
      capturePort: opts.capturePort,
    });
  },
  "agy-cli": (o) => {
    const opts = o as {
      command?: string;
      args?: string[];
      cwd?: string;
      pass_via?: "stdin" | "argv";
      env?: Record<string, string>;
      unset_env?: string[];
      strip_patterns?: string[];
      capturePort?: CapturePort;
    };
    if (!opts.command) throw new Error("agy-cli: command is required");
    return new AgyCliAdapter({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      pass_via: opts.pass_via,
      env: opts.env,
      unset_env: opts.unset_env,
      strip_patterns: opts.strip_patterns,
      capturePort: opts.capturePort,
    });
  },
  "codex-cli": (o) => {
    const opts = o as {
      command?: string;
      args?: string[];
      cwd?: string;
      pass_via?: "stdin" | "argv";
      env?: Record<string, string>;
      unset_env?: string[];
      strip_patterns?: string[];
      capturePort?: CapturePort;
    };
    if (!opts.command) throw new Error("codex-cli: command is required");
    return new CodexCliAdapter({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      pass_via: opts.pass_via,
      env: opts.env,
      unset_env: opts.unset_env,
      strip_patterns: opts.strip_patterns,
      capturePort: opts.capturePort,
    });
  },
  "opencode-cli": (o) => {
    const opts = o as Partial<OpencodeCliOptions>;
    if (!opts.model) throw new Error("opencode-cli: model is required");
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
      capturePort: opts.capturePort,
    });
  },
  "opencode-acp": (o) => {
    const opts = o as Partial<OpencodeAcpOptions>;
    if (!opts.model) throw new Error("opencode-acp: model is required");
    return new OpencodeAcpAdapter({
      model: opts.model,
      cwd: opts.cwd,
      opencodeBinary: opts.opencodeBinary,
      bootTimeoutMs: opts.bootTimeoutMs,
      requestTimeoutMs: opts.requestTimeoutMs,
      openSessionTimeoutMs: opts.openSessionTimeoutMs,
      firstEventTimeoutMs: opts.firstEventTimeoutMs,
      mcpServers: opts.mcpServers,
    });
  },
};

/**
 * Single construction path for the stdio-acp adapter, shared by the registry
 * builtin and the worker's thought-aware re-registration
 * (agentchat-worker.ts). Keeping both behind one factory is the HIGH-1 fix: the
 * worker override used to hand-roll its own opts/deps mapping that silently
 * omitted the warm-pool wiring, so `warm_pool: true` was a no-op in the real
 * worker. Anything that affects how the adapter is built (warm-pool deps,
 * option pass-through) must live here so the two sites cannot drift.
 */
export function createStdioAcpAdapter(
  o: Record<string, unknown>,
  extra?: { thoughtCapture?: StdioAcpThoughtCapture },
): Adapter {
  const opts = o as Partial<StdioAcpOptions>;
  if (!opts.binary) throw new Error("stdio-acp: binary is required");
  return new StdioAcpAdapter(
    {
      binary: opts.binary,
      args: opts.args,
      model: opts.model,
      cwd: opts.cwd,
      // Warm-pool scope. Set per-dispatch by the worktree override
      // (worktree-integration.ts) to the stable project root so an ACP process
      // is pooled across this agent's per-handoff worktrees. Without forwarding
      // it here, the adapter falls back to poolScope=cwd (the unique worktree
      // path) and warm reuse never engages under the default use_worktree:true.
      repoRoot: opts.repoRoot,
      env: opts.env,
      unsetEnv: opts.unsetEnv,
      bootTimeoutMs: opts.bootTimeoutMs,
      requestTimeoutMs: opts.requestTimeoutMs,
      authMethodId: opts.authMethodId,
      framing: opts.framing,
      fsReadTextFile: opts.fsReadTextFile,
      fsWriteTextFile: opts.fsWriteTextFile,
      terminal: opts.terminal,
      capturePort: opts.capturePort,
      mcpServers: opts.mcpServers,
      claudeCodeSettingSources: opts.claudeCodeSettingSources,
      claudeCodeStrictMcpConfig: opts.claudeCodeStrictMcpConfig,
      claudeCodeAllowedTools: opts.claudeCodeAllowedTools,
      claudeCodeTools: opts.claudeCodeTools,
      claudeCodeDisallowedTools: opts.claudeCodeDisallowedTools,
      hostEnvPolicy: opts.hostEnvPolicy,
      sanitizeClaudeHostEnv: opts.sanitizeClaudeHostEnv,
      agentName: opts.agentName,
      warmPool: opts.warmPool,
      warmPoolIdleGraceMs: opts.warmPoolIdleGraceMs,
      warmPoolMaxAgeMs: opts.warmPoolMaxAgeMs,
      warmPoolMaxEntries: opts.warmPoolMaxEntries,
      warmPoolSize: opts.warmPoolSize,
      modelWarmupPrompt: opts.modelWarmupPrompt,
    },
    {
      startServer: startStdioAcpServer,
      createClient: (h) =>
        new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout, framing: opts.framing }),
      ...(opts.warmPool === true
        ? {
            pool: getOrCreateAcpWarmPool(opts.agentName ?? opts.model ?? opts.binary, {
              warmPoolIdleGraceMs: opts.warmPoolIdleGraceMs,
              warmPoolMaxAgeMs: opts.warmPoolMaxAgeMs,
              warmPoolMaxEntries: opts.warmPoolMaxEntries,
              warmPoolSize: opts.warmPoolSize,
            }),
          }
        : {}),
      ...(extra?.thoughtCapture ? { thoughtCapture: extra.thoughtCapture } : {}),
    },
  );
}

for (const [kind, factory] of Object.entries(BUILT_IN_FACTORIES)) {
  builtIns.set(kind, factory);
}

const BUILT_IN_KIND_SET = new Set<string>(BUILT_IN_ADAPTER_KINDS);

export function buildAdapter(kind: string, options: Record<string, unknown>): Adapter {
  const factory = builtIns.get(kind);
  if (!factory) throw new Error(`unknown adapter kind: ${kind}`);
  return factory(options);
}

export function registerAdapter(kind: string, factory: AdapterFactory): void {
  builtIns.set(kind, factory);
}

export function clearCustomAdapters(): void {
  for (const key of [...builtIns.keys()]) {
    if (!BUILT_IN_KIND_SET.has(key)) {
      builtIns.delete(key);
    }
  }
}
