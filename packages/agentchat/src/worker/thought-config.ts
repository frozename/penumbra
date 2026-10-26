import type { AgentPool } from "@penumbra/config";

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
  pool: AgentPool | null;
  maxInputChars: number;
  timeoutMs: number;
}

export interface RuntimeThoughtSignalsConfig {
  enabled: boolean;
  pool: AgentPool | null;
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
  const t: NonNullable<AgentChatConfig["thoughts"]> = input.agentchat.thoughts ?? {};
  const enabled = t.enabled === true;

  const capture: RuntimeThoughtCaptureConfig = {
    maxTextBytes: t.capture?.max_text_bytes ?? 16384,
    maxStreamBytes: t.capture?.max_stream_bytes ?? 1048576,
    adapters: { ...(t.capture?.adapters ?? {}) },
    perAgentOverrides: { ...(t.capture?.per_agent_overrides ?? {}) },
  };

  const analyzeRequested = enabled && t.analyze?.enabled === true;
  const digest: RuntimeThoughtDigestConfig = {
    enabled: analyzeRequested && t.analyze?.digest?.enabled === true,
    pool: t.analyze?.digest?.agent ?? null,
    // #295: ~4.1 chars/token, so 20000 chars plus the prompt fits an 8192-token local judge slot.
    maxInputChars: t.analyze?.digest?.max_input_chars ?? 20000,
    timeoutMs: t.analyze?.digest?.timeout_ms ?? 60000,
  };
  const signals: RuntimeThoughtSignalsConfig = {
    enabled: analyzeRequested && t.analyze?.signals?.enabled === true,
    pool: t.analyze?.signals?.agent ?? null,
    timeoutMs: t.analyze?.signals?.timeout_ms ?? 60000,
    maxInputChars: t.analyze?.signals?.max_input_chars ?? null,
    definitions: (t.analyze?.signals?.definitions ?? []).map((d) => ({
      name: d.name,
      prompt: d.prompt,
    })),
  };

  return {
    enabled,
    capture,
    analyze: {
      enabled: analyzeRequested,
      onlyWhen: t.analyze?.only_when ?? ["pr_opened", "test_failed", "typecheck_failed"],
      digest,
      signals,
    },
  };
}
