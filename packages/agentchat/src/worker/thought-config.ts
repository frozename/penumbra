import type { AgentChatConfig } from "../config/types.js";

export interface RuntimeThoughtCaptureConfig {
  maxTextBytes: number;
  maxStreamBytes: number;
  adapters: Record<string, boolean>;
  perAgentOverrides: Record<string, boolean>;
}

export interface RuntimeThoughtSignalDefinition {
  name: string;
  prompt: string;
}

export interface RuntimeThoughtDigestConfig {
  enabled: boolean;
  agent: string;
  maxInputChars: number;
  timeoutMs: number;
}

export interface RuntimeThoughtSignalsConfig {
  enabled: boolean;
  agent: string;
  timeoutMs: number;
  maxInputChars: number | null;
  definitions: RuntimeThoughtSignalDefinition[];
}

export interface RuntimeThoughtAnalyzeConfig {
  enabled: boolean;
  onlyWhen: string[];
  digest: RuntimeThoughtDigestConfig;
  signals: RuntimeThoughtSignalsConfig;
}

export interface RuntimeThoughtsConfig {
  enabled: boolean;
  capture: RuntimeThoughtCaptureConfig;
  analyze: RuntimeThoughtAnalyzeConfig;
}

export function loadThoughtsConfig(input: { agentchat: AgentChatConfig }): RuntimeThoughtsConfig {
  const t = input.agentchat.thoughts;
  const enabled = t?.enabled === true;

  const capture: RuntimeThoughtCaptureConfig = {
    maxTextBytes: t?.capture?.max_text_bytes ?? 16384,
    maxStreamBytes: t?.capture?.max_stream_bytes ?? 1048576,
    adapters: { ...(t?.capture?.adapters ?? {}) },
    perAgentOverrides: { ...(t?.capture?.per_agent_overrides ?? {}) },
  };

  const analyzeRequested = enabled && t?.analyze?.enabled === true;
  const digest: RuntimeThoughtDigestConfig = {
    enabled: analyzeRequested && t?.analyze?.digest?.enabled === true,
    agent: t?.analyze?.digest?.agent ?? "local-gemma26",
    maxInputChars: t?.analyze?.digest?.max_input_chars ?? 50000,
    timeoutMs: t?.analyze?.digest?.timeout_ms ?? 60000,
  };
  const signals: RuntimeThoughtSignalsConfig = {
    enabled: analyzeRequested && t?.analyze?.signals?.enabled === true,
    agent: t?.analyze?.signals?.agent ?? "local-gemma26",
    timeoutMs: t?.analyze?.signals?.timeout_ms ?? 60000,
    maxInputChars: t?.analyze?.signals?.max_input_chars ?? null,
    definitions: (t?.analyze?.signals?.definitions ?? []).map((d) => ({
      name: d.name,
      prompt: d.prompt,
    })),
  };

  return {
    enabled,
    capture,
    analyze: {
      enabled: analyzeRequested,
      onlyWhen: t?.analyze?.only_when ?? ["pr_opened", "test_failed", "typecheck_failed"],
      digest,
      signals,
    },
  };
}
