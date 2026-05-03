import type { AgentChatConfig } from '../config/types.js';

export interface RuntimeShellConfig {
  enabled: boolean;
  maxSessionsPerHandoff: number;
  maxConcurrentRunsPerSession: number;
  maxSessionIdleMs: number;
  maxCommandDurationMs: number;
  outputByteLimit: number;
  redactOutput: boolean;
  unsetEnv: string[];
  dangerousCommands: string[];
  dangerousCommandsForAgent: (agentName: string) => string[];
  redactOutputForAgent: (agentName: string) => boolean;
}

const DEFAULT_DANGEROUS_COMMANDS = [
  'sudo\\b',
  '\\brm\\s+-rf\\b',
  '\\brm\\s+-fr\\b',
  '\\bgit\\s+push\\b',
  '\\bgit\\s+(reset|checkout)\\s+--hard\\b',
  'curl[^|]*\\|\\s*(sh|bash)\\b',
  'wget[^|]*\\|\\s*(sh|bash)\\b',
  '>\\s*/dev/(sd|hd|nvme)',
  '\\bdd\\b.*\\bof=\\s*/dev/',
  '\\bmkfs\\.',
];

export function loadShellConfig(input: { agentchat: AgentChatConfig }): RuntimeShellConfig {
  const shell = input.agentchat.shell;
  const dangerousCommands = shell?.dangerous_commands ?? DEFAULT_DANGEROUS_COMMANDS;
  const perAgentOverrides = shell?.per_agent_overrides ?? {};

  return {
    enabled: shell?.enabled ?? false,
    maxSessionsPerHandoff: shell?.max_sessions_per_handoff ?? 4,
    maxConcurrentRunsPerSession: shell?.max_concurrent_runs_per_session ?? 1,
    maxSessionIdleMs: shell?.max_session_idle_ms ?? 600000,
    maxCommandDurationMs: shell?.max_command_duration_ms ?? 60000,
    outputByteLimit: shell?.output_byte_limit ?? 1048576,
    redactOutput: shell?.redact_output ?? true,
    unsetEnv: [...(shell?.unset_env ?? [])],
    dangerousCommands: [...dangerousCommands],
    dangerousCommandsForAgent(agentName: string): string[] {
      const override = perAgentOverrides[agentName];
      const extra = override?.dangerous_commands_extra ?? [];
      return [...dangerousCommands, ...extra];
    },
    redactOutputForAgent(agentName: string): boolean {
      const override = perAgentOverrides[agentName];
      return override?.redact_output ?? (shell?.redact_output ?? true);
    },
  };
}
