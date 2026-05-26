import { z } from 'zod';

/**
 * Schema for the agent-focused config split file.
 * Covers agents plus agent-side worker concerns.
 * Mirrors legacy AgentChatConfig fields for these sections.
 */

export const AgentOptionsSchema = z.looseObject({
  allowed_tools: z.array(z.string()).optional(),
  permission_ttl_s: z.number().int().positive().optional(),
  fsReadTextFile: z.boolean().optional(),
  fsWriteTextFile: z.boolean().optional(),
  terminal: z.boolean().optional(),
  mcpWriteTools: z.boolean().optional(),
  requestTimeoutMs: z.number().int().min(1_000).max(900_000).optional(),
  terminal_path: z.string().optional(),
  terminal_timeout_s: z.number().int().min(1).max(300).optional(),
  terminal_output_max_bytes: z.number().int().min(1024).max(8_388_608).optional(),
  terminal_max_concurrent: z.number().int().min(1).max(8).optional(),
});
export type AgentOptions = z.infer<typeof AgentOptionsSchema>;

export const RecallContextConfigSchema = z.object({
  enabled: z.boolean().default(false),
  k: z.number().int().positive().max(20).default(3),
  scope: z
    .union([
      z.enum(['project', 'global']),
      z
        .string()
        .regex(
          /^corpus:[A-Za-z0-9_-]+$/,
          'corpus scope must be `corpus:<name>` with name matching [A-Za-z0-9_-]+',
        ),
    ])
    .default('project'),
  max_chars_per_result: z.number().int().positive().max(8000).default(800),
});
export type RecallContextConfig = z.infer<typeof RecallContextConfigSchema>;

export const LongLivedSubscriptionSchema = z.object({
  server: z.string().min(1),
  event: z.string().min(1),
});
export type LongLivedSubscription = z.infer<typeof LongLivedSubscriptionSchema>;

export const LongLivedBoundsSchema = z.object({
  wall_clock_ms: z.number().int().positive(),
  cost_cents: z.number().int().nonnegative(),
  max_sub_dispatches: z.number().int().nonnegative(),
});
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
    message: 'name must be non-empty after trimming whitespace',
  }),
  command: z.string().refine((s) => s.trim().length > 0, {
    message: 'command must be non-empty after trimming whitespace',
  }),
  args: z.array(z.string()).default([]),
  env: z
    .array(
      z.object({
        name: z.string().refine((s) => s.trim().length > 0, {
          message: 'env entry name must be non-empty after trimming',
        }),
        value: z.string(),
      }),
    )
    .default([])
    .refine((entries) => new Set(entries.map((entry) => entry.name)).size === entries.length, {
      message: 'env entries must have unique names',
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
  .refine(
    (cfg) => !cfg.require_snapshot || (cfg.snapshot_tool !== undefined && cfg.snapshot_tool.length > 0),
    {
      message: 'require_snapshot=true requires snapshot_tool to be set',
      path: ['snapshot_tool'],
    },
  );
export type LongLivedConfig = z.infer<typeof LongLivedConfigSchema>;
export type LongLivedConfigWithPrecomputedAllowlist = LongLivedConfig & {
  mcp_allowlist_sdk_patterns: string[];
};

export const AgentConfigSchema = z
  .object({
    name: z.string().min(1),
    adapter: z.string().min(1),
    options: AgentOptionsSchema.default({}),
    roles: z.array(z.string().min(1)).default([]),
    auto_approve_to: z.array(z.string().min(1)).default([]),
    pricing_mode: z.enum(['api', 'subscription']).default('api'),
    subscription_provider: z.string().min(1).optional(),
    subscription_model: z.string().min(1).optional(),
    api_provider: z.string().min(1).optional(),
    tier: z.string().optional(),
    cost_cents_per_run: z.number().nonnegative().optional(),
    maestro_capable: z.boolean().optional(),
    task_types: z.array(z.string().min(1)).optional(),
    task_types_supported: z.array(z.string().min(1)).optional(),
    recall_context: RecallContextConfigSchema.optional(),
    description: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
    quirks: z.array(z.string().min(1)).optional(),
    long_lived: z.boolean().optional(),
    long_lived_config: LongLivedConfigSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.pricing_mode === 'subscription' && !data.subscription_provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subscription_provider'],
        message: 'subscription_provider is required when pricing_mode is "subscription"',
      });
    }
    if (data.long_lived === true && data.long_lived_config === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['long_lived_config'],
        message: 'long_lived: true requires long_lived_config',
      });
    }
  });
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ThoughtSignalDefinitionSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
});
export type ThoughtSignalDefinition = z.infer<typeof ThoughtSignalDefinitionSchema>;

export const ThoughtCaptureConfigSchema = z
  .object({
    max_text_bytes: z.number().int().positive().default(16384),
    max_stream_bytes: z.number().int().positive().default(1048576),
    adapters: z.record(z.string(), z.boolean()).default({}),
    per_agent_overrides: z.record(z.string(), z.boolean()).default({}),
  })
  .optional();
export type ThoughtCaptureConfig = z.infer<typeof ThoughtCaptureConfigSchema>;

export const ThoughtDigestConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    agent: z.string().min(1).default('local-gemma26'),
    max_input_chars: z.number().int().positive().default(50000),
    timeout_ms: z.number().int().positive().default(60000),
  })
  .optional();
export type ThoughtDigestConfig = z.infer<typeof ThoughtDigestConfigSchema>;

export const ThoughtSignalsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    agent: z.string().min(1).default('local-gemma26'),
    timeout_ms: z.number().int().positive().default(60000),
    max_input_chars: z.number().int().positive().optional(),
    definitions: z.array(ThoughtSignalDefinitionSchema).default([]),
  })
  .optional();
export type ThoughtSignalsConfig = z.infer<typeof ThoughtSignalsConfigSchema>;

export const ThoughtAnalyzeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    only_when: z.array(z.string().min(1)).default(['pr_opened', 'test_failed', 'typecheck_failed']),
    digest: ThoughtDigestConfigSchema,
    signals: ThoughtSignalsConfigSchema,
  })
  .optional();
export type ThoughtAnalyzeConfig = z.infer<typeof ThoughtAnalyzeConfigSchema>;

export const ThoughtsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    capture: ThoughtCaptureConfigSchema,
    analyze: ThoughtAnalyzeConfigSchema,
  })
  .optional();
export type ThoughtsConfig = z.infer<typeof ThoughtsConfigSchema>;

export const ShellPerAgentOverrideSchema = z
  .object({
    dangerous_commands_extra: z.array(z.string()).optional(),
    redact_output: z.boolean().optional(),
  })
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
    dangerous_commands: z.array(z.string()).default([
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
    ]),
    per_agent_overrides: z.record(z.string(), ShellPerAgentOverrideSchema).default({}),
  })
  .optional();
export type ShellConfig = z.infer<typeof ShellConfigSchema>;

export const AgentsConfigSchema = z
  .object({
    agents: z.array(AgentConfigSchema).min(1),
    thoughts: ThoughtsConfigSchema,
    shell: ShellConfigSchema,
  })
  .strict();
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
