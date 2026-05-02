// packages/agentchat/src/config/types.ts
import { z } from 'zod';

export const AgentOptionsSchema = z.looseObject({
  /** Tool name allowlist for chain_trust_mode='config'. Strings without glob chars are exact-matched; strings containing *?[ are matched as picomatch globs. Default: undefined ⇒ treated as []. */
  allowed_tools: z.array(z.string()).optional(),
  /** Override of PENUMBRA_PERMISSION_TTL_S for this agent. Seconds. */
  permission_ttl_s: z.number().int().positive().optional(),
  /** Phase 1b.1: advertise fs.readTextFile capability. */
  fsReadTextFile: z.boolean().optional(),
  /** Phase 1d: advertise fs.writeTextFile capability (ACP wire). */
  fsWriteTextFile: z.boolean().optional(),
  /** Phase 1d: advertise terminal/* capability (ACP wire). */
  terminal: z.boolean().optional(),
  /** Phase 1d: expose write tools via penumbra-mcp. */
  mcpWriteTools: z.boolean().optional(),
  /** ACP session/prompt watchdog in milliseconds. Default is adapter-specific. */
  requestTimeoutMs: z.number().int().min(1_000).max(900_000).optional(),
  /** Sandbox PATH for terminal commands. Default: '/usr/bin:/bin'. */
  terminal_path: z.string().optional(),
  /** Per-command timeout in seconds. Default: 30. */
  terminal_timeout_s: z.number().int().min(1).max(300).optional(),
  /** Terminal output cap in bytes. Default: 1 MiB. */
  terminal_output_max_bytes: z.number().int().min(1024).max(8388608).optional(),
  /** Max concurrent terminals per dispatch. Default: 3. */
  terminal_max_concurrent: z.number().int().min(1).max(8).optional(),
});
export type AgentOptions = z.infer<typeof AgentOptionsSchema>;

export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  adapter: z.string().min(1),
  options: AgentOptionsSchema.default({}),
  roles: z.array(z.string().min(1)).default([]),
  auto_approve_to: z.array(z.string().min(1)).default([]),
  /** One-line summary of what this agent is and what it's good at. Free text. */
  description: z.string().optional(),
  /** Capability hints for routing decisions: e.g. ["local","gemma4","fast","extraction"]. */
  tags: z.array(z.string().min(1)).optional(),
  /** Empirical observations from past use — pitfalls, strengths, quant-specific notes. Each entry is one short bullet. */
  quirks: z.array(z.string().min(1)).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ProviderQuotaConfigSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1).optional(),
  quota_usd_per_24h: z.number().positive().optional(),
  quota_tokens_per_24h: z.number().int().positive().optional(),
  quota_tokens_per_5h: z.number().int().positive().optional(),
});
export type ProviderQuotaConfig = z.infer<typeof ProviderQuotaConfigSchema>;

export const NotificationEventConfigSchema = z
  .object({
    dispatch_start: z.boolean().optional(),
    dispatch_end: z.boolean().optional(),
    dispatch_failure: z.boolean().optional(),
    watchdog_failure: z.boolean().optional(),
    claim_retry: z.boolean().optional(),
    adapter_retry_exhausted: z.boolean().optional(),
    permission_requested: z.boolean().optional(),
    permission_decided: z.boolean().optional(),
    permission_expired: z.boolean().optional(),
    merge_result: z.boolean().optional(),
    cost_quota_summary: z.boolean().optional(),
  })
  .default({});
export type NotificationEventConfig = z.infer<typeof NotificationEventConfigSchema>;

export const NotificationChannelSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('discord_webhook'),
    default_webhook_url_env: z
      .string()
      .min(1)
      .default('PENUMBRA_DISCORD_WEBHOOK_URL'),
  }),
]);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationProjectRouteSchema = z.object({
  channel: z.string().min(1).default('discord'),
  webhook_url_env: z.string().min(1).optional(),
  include_prompt: z.boolean().optional(),
  prompt_policy: z.enum(['never', 'summary', 'always']).optional(),
});
export type NotificationProjectRoute = z.infer<
  typeof NotificationProjectRouteSchema
>;

export const NotificationIdentitySchema = z.object({
  display_name: z.string().min(1).optional(),
  avatar_url: z.string().url().optional(),
  avatar_url_env: z.string().min(1).optional(),
});
export type NotificationIdentity = z.infer<typeof NotificationIdentitySchema>;

export const NotificationSummaryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    interval: z.enum(['hourly', 'daily']).default('daily'),
    channel: z.string().min(1).default('discord'),
  })
  .default({ enabled: true, interval: 'daily', channel: 'discord' });
export type NotificationSummaryConfig = z.infer<
  typeof NotificationSummaryConfigSchema
>;

export const NotificationConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    include_prompt: z.boolean().optional(),
    prompt_policy: z.enum(['never', 'summary', 'always']).default('never'),
    events: NotificationEventConfigSchema,
    channels: z.record(z.string(), NotificationChannelSchema).default({}),
    routes: z
      .object({
        projects: z.record(z.string(), NotificationProjectRouteSchema).default({}),
      })
      .default({ projects: {} }),
    identities: z
      .object({
        agents: z.record(z.string(), NotificationIdentitySchema).default({}),
      })
      .default({ agents: {} }),
    summaries: z
      .object({
        cost_quota: NotificationSummaryConfigSchema,
      })
      .default({
        cost_quota: { enabled: true, interval: 'daily', channel: 'discord' },
      }),
  })
  .optional();
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;

export const ThoughtSignalDefinitionSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
});
export type ThoughtSignalDefinition = z.infer<
  typeof ThoughtSignalDefinitionSchema
>;

export const ThoughtCaptureConfigSchema = z.object({
  max_text_bytes: z.number().int().positive().default(16384),
  max_stream_bytes: z.number().int().positive().default(1048576),
  adapters: z.record(z.string(), z.boolean()).default({}),
  per_agent_overrides: z.record(z.string(), z.boolean()).default({}),
}).optional();
export type ThoughtCaptureConfig = z.infer<typeof ThoughtCaptureConfigSchema>;

export const ThoughtDigestConfigSchema = z.object({
  enabled: z.boolean().default(false),
  agent: z.string().min(1).default('local-gemma26'),
  max_input_chars: z.number().int().positive().default(50000),
  timeout_ms: z.number().int().positive().default(60000),
}).optional();
export type ThoughtDigestConfig = z.infer<typeof ThoughtDigestConfigSchema>;

export const ThoughtSignalsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  agent: z.string().min(1).default('local-gemma26'),
  timeout_ms: z.number().int().positive().default(60000),
  max_input_chars: z.number().int().positive().optional(),
  definitions: z.array(ThoughtSignalDefinitionSchema).default([]),
}).optional();
export type ThoughtSignalsConfig = z.infer<typeof ThoughtSignalsConfigSchema>;

export const ThoughtAnalyzeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  only_when: z.array(z.string().min(1)).default(['pr_opened', 'test_failed', 'typecheck_failed']),
  digest: ThoughtDigestConfigSchema,
  signals: ThoughtSignalsConfigSchema,
}).optional();
export type ThoughtAnalyzeConfig = z.infer<typeof ThoughtAnalyzeConfigSchema>;

export const ThoughtsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  capture: ThoughtCaptureConfigSchema,
  analyze: ThoughtAnalyzeConfigSchema,
}).optional();
export type ThoughtsConfig = z.infer<typeof ThoughtsConfigSchema>;

export const RoleRoutingConfigSchema = z
  .object({
    exploration_policy: z.enum(['unsampled-first', 'ranked-first']).default('unsampled-first'),
  })
  .default({ exploration_policy: 'unsampled-first' });
export type RoleRoutingConfig = z.infer<typeof RoleRoutingConfigSchema>;

export const AgentChatConfigSchema = z.object({
  agents: z.array(AgentConfigSchema).min(1),
  default_roles: z.record(z.string(), z.string()).default({}),
  role_routing: RoleRoutingConfigSchema.optional(),
  providers: z.array(ProviderQuotaConfigSchema).default([]),
  notifications: NotificationConfigSchema,
  thoughts: ThoughtsConfigSchema,
});
export type AgentChatConfig = z.infer<typeof AgentChatConfigSchema>;
