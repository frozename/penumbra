export interface SandboxConfigInput {
  terminal_path?: string;
  terminal_timeout_s?: number;
  terminal_output_max_bytes?: number;
  terminal_max_concurrent?: number;
}

export interface SandboxConfig {
  path: string;
  timeoutMs: number;
  outputMaxBytes: number;
  maxConcurrent: number;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  path: "/usr/bin:/bin",
  timeoutMs: 30_000,
  outputMaxBytes: 1_048_576,
  maxConcurrent: 3,
};

export function resolveSandboxConfig(opts: SandboxConfigInput): SandboxConfig {
  return {
    path: opts.terminal_path ?? DEFAULT_SANDBOX_CONFIG.path,
    timeoutMs: (opts.terminal_timeout_s ?? 30) * 1000,
    outputMaxBytes: opts.terminal_output_max_bytes ?? DEFAULT_SANDBOX_CONFIG.outputMaxBytes,
    maxConcurrent: opts.terminal_max_concurrent ?? DEFAULT_SANDBOX_CONFIG.maxConcurrent,
  };
}
