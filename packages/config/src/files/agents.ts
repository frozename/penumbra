import { z } from "zod";

import { CANONICAL_PROVIDER_VALUE_RE } from "../provider-format.js";
import { AgentPoolSchema } from "./agent-pool.js";

const CANONICAL_PROVIDER_MESSAGE =
  'provider must be canonical lowercase-hyphen (e.g. "openai", "nvidia-nim") so routing-bias matching resolves it';

/**
 * Schema for the agent-focused config split file.
 * Covers agents plus agent-side worker concerns.
 * Mirrors legacy AgentChatConfig fields for these sections.
 */

// This strict key union is the universal option gate for every adapter.
// Unknown adapters skip adapter-specific refinement, but still cannot introduce
// option keys that are absent from this schema.
export const AgentOptionsSchema = z.strictObject({
  agent: z.string().optional(),
  agentName: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  apiKeyFile: z.string().optional(),
  apiKeyKeychain: z.string().optional(),
  api_key_env: z.string().optional(),
  args: z.array(z.string()).optional(),
  authMethodId: z.string().optional(),
  autoApprovePermissions: z.array(z.string()).optional(),
  baseUrl: z.string().optional(),
  binary: z.string().optional(),
  bootTimeoutMs: z.number().int().optional(),
  caPath: z.string().optional(),
  capturePort: z.unknown().optional(),
  claudeCodeAllowedTools: z.array(z.string()).optional(),
  claudeCodeDisallowedTools: z.array(z.string()).optional(),
  claudeCodeSettingSources: z.array(z.string()).optional(),
  claudeCodeStrictMcpConfig: z.boolean().optional(),
  claudeCodeTools: z.array(z.string()).optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  emit_stdout_thoughts: z.boolean().optional(),
  env: z.record(z.string(), z.unknown()).optional(),
  extraBody: z.unknown().optional(),
  firstEventTimeoutMs: z.number().int().positive().optional(),
  framing: z.string().optional(),
  permission_ttl_s: z.number().int().positive().optional(),
  fsReadTextFile: z.boolean().optional(),
  fsWriteTextFile: z.boolean().optional(),
  terminal: z.boolean().optional(),
  mcpWriteTools: z.boolean().optional(),
  hostEnvPolicy: z.unknown().optional(),
  inactivityTimeoutMs: z.number().int().positive().optional(),
  maxTokens: z.number().int().optional(),
  mcpServers: z.unknown().optional(),
  model: z.string().optional(),
  modelWarmupPrompt: z.string().optional(),
  model_warmup_prompt: z.string().optional(),
  openSessionTimeoutMs: z.number().int().positive().optional(),
  opencodeBinary: z.string().optional(),
  pass_via: z.enum(["stdin", "argv"]).optional(),
  provider: z.string().optional(),
  repoRoot: z.string().optional(),
  requestExtras: z.unknown().optional(),
  requestTimeoutMs: z.number().int().min(1_000).max(900_000).optional(),
  sanitizeClaudeHostEnv: z.boolean().optional(),
  strip_patterns: z.array(z.string().min(1).max(512)).min(1).optional(),
  systemPrompt: z.string().optional(),
  terminal_path: z.string().optional(),
  terminal_timeout_s: z.number().int().min(1).max(300).optional(),
  terminal_output_max_bytes: z.number().int().min(1024).max(8_388_608).optional(),
  terminal_max_concurrent: z.number().int().min(1).max(8).optional(),
  unsetEnv: z.array(z.string()).optional(),
  unset_env: z.array(z.string()).optional(),
  warmPool: z.boolean().optional(),
  warmPoolIdleGraceMs: z.number().int().optional(),
  warmPoolMaxAgeMs: z.number().int().optional(),
  warmPoolMaxEntries: z.number().int().optional(),
  warmPoolSize: z.number().int().optional(),
  warm_pool: z.boolean().optional(),
  warm_pool_health_ping: z.boolean().optional(),
  warm_pool_idle_grace_ms: z.number().int().min(1000).max(3600000).optional(),
  warm_pool_max_age_ms: z.number().int().min(10000).max(86400000).optional(),
  warm_pool_max_entries: z.number().int().min(1).max(10).optional(),
  warm_pool_prewarm: z.boolean().optional(),
  warm_pool_prewarm_max_targets: z.number().int().min(1).max(10).optional(),
  warm_pool_size: z.number().int().min(1).max(10).optional(),
});
export type AgentOptions = z.infer<typeof AgentOptionsSchema>;

export const UNIVERSAL_OPTION_KEYS = [
  "allowed_tools",
  "cwd",
  "env",
  "fsReadTextFile",
  "fsWriteTextFile",
  "mcpServers",
  "mcpWriteTools",
  "model",
  "permission_ttl_s",
  "provider",
  "requestTimeoutMs",
  "terminal",
  "terminal_max_concurrent",
  "terminal_output_max_bytes",
  "terminal_path",
  "terminal_timeout_s",
  "unsetEnv",
  "unset_env",
] as const;

// The subset of universal options a providers.yaml binding may carry onto a
// generated seat. `satisfies` fails compilation if a key ever leaves
// UNIVERSAL_OPTION_KEYS, instead of generating adapter-rejected seats.
export const CARRIER_TOOL_OPTION_KEYS = [
  "fsReadTextFile",
  "fsWriteTextFile",
  "terminal",
  "terminal_max_concurrent",
  "terminal_output_max_bytes",
  "terminal_path",
  "terminal_timeout_s",
] as const satisfies readonly (typeof UNIVERSAL_OPTION_KEYS)[number][];
const _carrierKeysExistInSchema: readonly (keyof typeof AgentOptionsSchema.shape)[] =
  CARRIER_TOOL_OPTION_KEYS;
void _carrierKeysExistInSchema;

const CLI_OPTION_KEYS = [
  "args",
  "capturePort",
  "command",
  "emit_stdout_thoughts",
  "pass_via",
  "strip_patterns",
] as const;

export const CARRIER_CLI_OPTION_KEYS = ["pass_via", "strip_patterns"] as const;

const STDIO_ACP_WARM_OPTION_KEYS = [
  "modelWarmupPrompt",
  "model_warmup_prompt",
  "warmPool",
  "warmPoolIdleGraceMs",
  "warmPoolMaxAgeMs",
  "warmPoolMaxEntries",
  "warmPoolSize",
  "warm_pool",
  "warm_pool_health_ping",
  "warm_pool_idle_grace_ms",
  "warm_pool_max_age_ms",
  "warm_pool_max_entries",
  "warm_pool_prewarm",
  "warm_pool_prewarm_max_targets",
  "warm_pool_size",
] as const;

export const ADAPTER_SPECIFIC_OPTION_KEYS = {
  "agy-cli": CLI_OPTION_KEYS,
  "claude-cli": CLI_OPTION_KEYS,
  "codex-cli": CLI_OPTION_KEYS,
  "gemini-cli": CLI_OPTION_KEYS,
  "openai-compat-http": [
    "apiKey",
    "apiKeyEnv",
    "apiKeyFile",
    "apiKeyKeychain",
    "api_key_env",
    "baseUrl",
    "caPath",
    "extraBody",
    "maxTokens",
    "requestExtras",
    "systemPrompt",
  ],
  "opencode-acp": [
    "agent",
    "autoApprovePermissions",
    "bootTimeoutMs",
    "firstEventTimeoutMs",
    "inactivityTimeoutMs",
    "openSessionTimeoutMs",
    "opencodeBinary",
  ],
  "opencode-cli": CLI_OPTION_KEYS,
  "stdio-acp": [
    "agentName",
    "args",
    "authMethodId",
    "binary",
    "bootTimeoutMs",
    "capturePort",
    "claudeCodeAllowedTools",
    "claudeCodeDisallowedTools",
    "claudeCodeSettingSources",
    "claudeCodeStrictMcpConfig",
    "claudeCodeTools",
    "framing",
    "hostEnvPolicy",
    "repoRoot",
    "sanitizeClaudeHostEnv",
    ...STDIO_ACP_WARM_OPTION_KEYS,
  ],
} as const satisfies Record<string, readonly string[]>;

export function allowedKeysFor(adapter: string): ReadonlySet<string> | null {
  if (!Object.hasOwn(ADAPTER_SPECIFIC_OPTION_KEYS, adapter)) return null;
  const adapterKeys =
    ADAPTER_SPECIFIC_OPTION_KEYS[adapter as keyof typeof ADAPTER_SPECIFIC_OPTION_KEYS];
  return new Set([...UNIVERSAL_OPTION_KEYS, ...adapterKeys]);
}

export function refineAgentConfigAdapterOptions(
  data: { adapter: string; options?: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  // Known adapters get a second pass that rejects schema-valid keys they do not consume.
  const allowedKeys = allowedKeysFor(data.adapter);
  if (!allowedKeys) return;
  for (const key of Object.keys(data.options ?? {})) {
    if (allowedKeys.has(key)) continue;
    ctx.addIssue({
      code: "custom",
      path: ["options", key],
      message: `option '${key}' is not used by adapter '${data.adapter}'`,
    });
  }
}

export const RecallContextConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    k: z.number().int().positive().max(20).default(3),
    scope: z
      .union([
        z.enum(["project", "global"]),
        z
          .string()
          .regex(
            /^corpus:[A-Za-z0-9_-]+$/,
            "corpus scope must be `corpus:<name>` with name matching [A-Za-z0-9_-]+",
          ),
      ])
      .default("project"),
    max_chars_per_result: z.number().int().positive().max(8000).default(800),
  })
  .strict();
export type RecallContextConfig = z.infer<typeof RecallContextConfigSchema>;

export const LongLivedSubscriptionSchema = z.object({
  server: z.string().min(1),
  event: z.string().min(1),
});
export type LongLivedSubscription = z.infer<typeof LongLivedSubscriptionSchema>;

export const LongLivedBoundsSchema = z
  .object({
    wall_clock_ms: z.number().int().positive(),
    cost_cents: z.number().int().nonnegative(),
    max_sub_dispatches: z.number().int().nonnegative(),
  })
  .strict();
export type LongLivedBounds = z.infer<typeof LongLivedBoundsSchema>;

export const LongLivedActionTiersSchema = z
  .object({
    approval_required_globs: z.array(z.string()).default([]),
    cooldown_overrides: z.record(z.string(), z.number().int().nonnegative()).default({}),
  })
  .default({ approval_required_globs: [], cooldown_overrides: {} });
export type LongLivedActionTiers = z.infer<typeof LongLivedActionTiersSchema>;

const longLivedCronRegex = /^[\d*\-,/]+(\s+[\d*\-,/]+){4}$/;

export const HostedMcpServerSchema = z.object({
  name: z.string().refine((s) => s.trim().length > 0, {
    message: "name must be non-empty after trimming whitespace",
  }),
  command: z.string().refine((s) => s.trim().length > 0, {
    message: "command must be non-empty after trimming whitespace",
  }),
  args: z.array(z.string()).default([]),
  env: z
    .array(
      z.object({
        name: z.string().refine((s) => s.trim().length > 0, {
          message: "env entry name must be non-empty after trimming",
        }),
        value: z.string(),
      }),
    )
    .default([])
    .refine((entries) => new Set(entries.map((entry) => entry.name)).size === entries.length, {
      message: "env entries must have unique names",
    }),
});
export type HostedMcpServer = z.infer<typeof HostedMcpServerSchema>;

export const LongLivedConfigSchema = z
  .object({
    schedule_cron: z.string().regex(longLivedCronRegex).optional(),
    project_id: z.string().optional(),
    subscriptions: z.array(LongLivedSubscriptionSchema).default([]),
    hosted_mcp_servers: z.array(HostedMcpServerSchema).default([]),
    mcp_allowlist: z.array(z.string()).default([]),
    snapshot_tool: z
      .string()
      .regex(/^[^:\s]+:[^:\s]+$/, { message: 'snapshot_tool must be canonical "server:tool" form' })
      .optional(),
    require_snapshot: z.boolean().default(false),
    bounds: LongLivedBoundsSchema,
    circuit_breaker_threshold: z.number().int().positive().default(3),
    action_tiers: LongLivedActionTiersSchema.optional(),
    standing_brief: z.string().min(1),
  })
  .strict()
  .refine(
    (cfg) =>
      !cfg.require_snapshot || (cfg.snapshot_tool !== undefined && cfg.snapshot_tool.length > 0),
    {
      message: "require_snapshot=true requires snapshot_tool to be set",
      path: ["snapshot_tool"],
    },
  );
export type LongLivedConfig = z.infer<typeof LongLivedConfigSchema>;
export type LongLivedConfigWithPrecomputedAllowlist = LongLivedConfig & {
  mcp_allowlist_sdk_patterns: string[];
};

export const AgentProvenanceSchema = z
  .object({
    source: z.string().min(1),
    managed_fields: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type AgentProvenance = z.infer<typeof AgentProvenanceSchema>;

export const AgentConfigSchema = z
  .object({
    name: z.string().min(1),
    adapter: z.string().min(1),
    options: AgentOptionsSchema.default({}),
    roles: z.array(z.string().min(1)).default([]),
    auto_approve_to: z.array(z.string().min(1)).default([]),
    pricing_mode: z.enum(["api", "subscription"]).default("api"),
    subscription_provider: z
      .string()
      .min(1)
      .regex(CANONICAL_PROVIDER_VALUE_RE, { message: CANONICAL_PROVIDER_MESSAGE })
      .optional(),
    subscription_model: z.string().min(1).optional(),
    api_provider: z
      .string()
      .min(1)
      .regex(CANONICAL_PROVIDER_VALUE_RE, { message: CANONICAL_PROVIDER_MESSAGE })
      .optional(),
    tier: z.string().optional(),
    cost_cents_per_run: z.number().nonnegative().optional(),
    maestro_capable: z.boolean().optional(),
    task_types: z.array(z.string().min(1)).optional(),
    task_types_supported: z.array(z.string().min(1)).optional(),
    recall_context: RecallContextConfigSchema.optional(),
    description: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
    quirks: z.array(z.string().min(1)).optional(),
    provenance: AgentProvenanceSchema.optional(),
    long_lived: z.boolean().optional(),
    long_lived_config: LongLivedConfigSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    refineAgentConfigAdapterOptions(data, ctx);
    if (data.pricing_mode === "subscription" && !data.subscription_provider) {
      ctx.addIssue({
        code: "custom",
        path: ["subscription_provider"],
        message: 'subscription_provider is required when pricing_mode is "subscription"',
      });
    }
    if (data.long_lived === true && data.long_lived_config === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["long_lived_config"],
        message: "long_lived: true requires long_lived_config",
      });
    }
  });
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ThoughtSignalDefinitionSchema = z
  .object({
    name: z.string().min(1),
    prompt: z.string().min(1),
  })
  .strict();
export type ThoughtSignalDefinition = z.infer<typeof ThoughtSignalDefinitionSchema>;

export const ThoughtCaptureConfigSchema = z
  .object({
    max_text_bytes: z.number().int().positive().default(16384),
    max_stream_bytes: z.number().int().positive().default(1048576),
    adapters: z.record(z.string(), z.boolean()).default({}),
    per_agent_overrides: z.record(z.string(), z.boolean()).default({}),
  })
  .strict()
  .optional();
export type ThoughtCaptureConfig = z.infer<typeof ThoughtCaptureConfigSchema>;

export const ThoughtDigestConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    agent: AgentPoolSchema.optional(),
    max_input_chars: z.number().int().positive().default(50000),
    timeout_ms: z.number().int().positive().default(60000),
  })
  .strict()
  .optional();
export type ThoughtDigestConfig = z.infer<typeof ThoughtDigestConfigSchema>;

export const ThoughtSignalsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    agent: AgentPoolSchema.optional(),
    timeout_ms: z.number().int().positive().default(60000),
    max_input_chars: z.number().int().positive().optional(),
    definitions: z.array(ThoughtSignalDefinitionSchema).default([]),
  })
  .strict()
  .optional();
export type ThoughtSignalsConfig = z.infer<typeof ThoughtSignalsConfigSchema>;

export const ThoughtAnalyzeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    only_when: z.array(z.string().min(1)).default(["pr_opened", "test_failed", "typecheck_failed"]),
    digest: ThoughtDigestConfigSchema,
    signals: ThoughtSignalsConfigSchema,
  })
  .strict()
  .optional();
export type ThoughtAnalyzeConfig = z.infer<typeof ThoughtAnalyzeConfigSchema>;

export const ThoughtsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    capture: ThoughtCaptureConfigSchema,
    analyze: ThoughtAnalyzeConfigSchema,
  })
  .strict()
  .optional();
export type ThoughtsConfig = z.infer<typeof ThoughtsConfigSchema>;

export const ShellPerAgentOverrideSchema = z
  .object({
    dangerous_commands_extra: z.array(z.string()).optional(),
    redact_output: z.boolean().optional(),
  })
  .strict()
  .optional();
export type ShellPerAgentOverride = z.infer<typeof ShellPerAgentOverrideSchema>;

export const ShellConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    max_sessions_per_handoff: z.number().int().positive().default(4),
    max_concurrent_runs_per_session: z.number().int().positive().default(1),
    max_session_idle_ms: z.number().int().positive().default(600000),
    max_command_duration_ms: z.number().int().positive().default(60000),
    output_byte_limit: z.number().int().positive().default(1048576),
    redact_output: z.boolean().default(true),
    unset_env: z.array(z.string()).default([]),
    dangerous_commands: z
      .array(z.string())
      .default([
        "sudo\\b",
        "\\brm\\s+-rf\\b",
        "\\brm\\s+-fr\\b",
        "\\bgit\\s+push\\b",
        "\\bgit\\s+(reset|checkout)\\s+--hard\\b",
        "curl[^|]*\\|\\s*(sh|bash)\\b",
        "wget[^|]*\\|\\s*(sh|bash)\\b",
        ">\\s*/dev/(sd|hd|nvme)",
        "\\bdd\\b.*\\bof=\\s*/dev/",
        "\\bmkfs\\.",
      ]),
    per_agent_overrides: z.record(z.string(), ShellPerAgentOverrideSchema).default({}),
  })
  .strict()
  .optional();
export type ShellConfig = z.infer<typeof ShellConfigSchema>;

export const AgentsConfigSchema = z
  .object({
    agents: z.array(AgentConfigSchema).min(1),
    thoughts: ThoughtsConfigSchema,
    shell: ShellConfigSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    const seen = new Map<string, number>();
    for (const [i, agent] of data.agents.entries()) {
      const name = agent.name;
      const first = seen.get(name);
      if (first !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", i, "name"],
          message: `duplicate agent name '${name}' (also at agents[${String(first)}]); the routing scorer would silently collapse to the first entry, making this agent unreachable`,
        });
      } else {
        seen.set(name, i);
      }
    }
  });
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
