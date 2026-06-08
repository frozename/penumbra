// packages/agentchat/src/config/types.ts
import { z } from "zod";

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
  /** Keep ACP subprocess sessions warm between dispatches. Default: off. */
  warm_pool: z.boolean().optional(),
  warm_pool_idle_grace_ms: z.number().int().min(1000).max(3600000).optional(),
  warm_pool_max_age_ms: z.number().int().min(10000).max(86400000).optional(),
  warm_pool_max_entries: z.number().int().min(1).max(10).optional(),
  /** Eagerly pre-warm a connection for this agent at worker boot so warm reuse
   *  engages regardless of first-poll-wins worker spread. Requires warm_pool.
   *  Default: off. */
  warm_pool_prewarm: z.boolean().optional(),
  /** Per-agent cap on pre-warm targets this agent may contribute on one worker.
   *  Bounded further by the worker-level cap. */
  warm_pool_prewarm_max_targets: z.number().int().min(1).max(10).optional(),
  /** Deprecated and ignored; retained so older configs still parse. */
  warm_pool_health_ping: z.boolean().optional(),
});
export type AgentOptions = z.infer<typeof AgentOptionsSchema>;

/**
 * Per-agent recall-context enrichment. When `enabled: true`, the worker
 * dispatcher prepends a `<recent-relevant-context>` block to handoff.message
 * before invoking the adapter. The block is built from a recall query against
 * the dispatched message text.
 *
 * - `k`: max results to include (default 3)
 * - `scope`: `'project'` filters by project_id derived from the worktree cwd;
 *            `'global'` does not filter (recalls across all projects);
 *            `'corpus:<name>'` queries the named knowledge corpus instead of
 *            general recall (the corpus is built via `memory.corpus.build`).
 * - `max_chars_per_result`: per-result body cap to bound prompt growth
 *
 * Failure (recall throws / times out) is soft: dispatch proceeds without the
 * preamble. The adapter never sees the wrapping fail.
 */
export const RecallContextConfigSchema = z.object({
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

/**
 * Config for an MCP server that the daemon owns and spawns on behalf of a
 * long-lived agent. Consumed by the daemon's mcp-pool (Phase 2 of the
 * action-gate federation rollout — plan at
 * `docs/superpowers/plans/2026-05-11-action-gate-federation.md`).
 *
 * The shape mirrors `McpServerStdio` in
 * `packages/agentchat/src/adapters/acp-types.ts` so future migrations can
 * convert one to the other without semantic loss. The duplication is
 * intentional for V1: this schema is yaml-loaded with runtime validation;
 * `McpServerStdio` is a runtime ACP transport type with no zod equivalent.
 *
 * Lifecycle: the daemon mcp-pool spawns one subprocess per
 * (name, command, args, env) tuple, refcounts by agent_id, and tears down
 * after a grace period when no long-lived agent references it.
 */
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
    .refine((entries) => new Set(entries.map((e) => e.name)).size === entries.length, {
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
  .refine(
    (cfg) =>
      !cfg.require_snapshot || (cfg.snapshot_tool !== undefined && cfg.snapshot_tool.length > 0),
    { message: "require_snapshot=true requires snapshot_tool to be set", path: ["snapshot_tool"] },
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
    pricing_mode: z.enum(["api", "subscription"]).default("api"),
    subscription_provider: z.string().min(1).optional(),
    subscription_model: z.string().min(1).optional(),
    api_provider: z.string().min(1).optional(),
    /** Relative tier used by task eligibility (cheap < oc < premium). */
    tier: z.string().optional(),
    /** Estimated per-run cost in cents used by task eligibility filtering. */
    cost_cents_per_run: z.number().nonnegative().optional(),
    /** Marks whether the agent can be assigned maestro spawn tasks. */
    maestro_capable: z.boolean().optional(),
    /** Optional per-agent task types this agent supports for maestro routing. */
    task_types: z.array(z.string().min(1)).optional(),
    /** Legacy alias for task_types. */
    task_types_supported: z.array(z.string().min(1)).optional(),
    /** Per-agent recall-context enrichment. Off unless explicitly enabled. */
    recall_context: RecallContextConfigSchema.optional(),
    /** One-line summary of what this agent is and what it's good at. Free text. */
    description: z.string().optional(),
    /** Capability hints for routing decisions: e.g. ["local","gemma4","fast","extraction"]. */
    tags: z.array(z.string().min(1)).optional(),
    /** Empirical observations from past use — pitfalls, strengths, quant-specific notes. Each entry is one short bullet. */
    quirks: z.array(z.string().min(1)).optional(),
    long_lived: z.boolean().optional(),
    long_lived_config: LongLivedConfigSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.pricing_mode === "subscription" && !data.subscription_provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subscription_provider"],
        message: 'subscription_provider is required when pricing_mode is "subscription"',
      });
    }
    if (data.long_lived === true && data.long_lived_config === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["long_lived_config"],
        message: "long_lived: true requires long_lived_config",
      });
    }
  });
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

const PressureCapWindowSchema = z.union([
  z
    .number()
    .int()
    .min(1)
    .max(100)
    .transform((refuse) => ({ warn: null as number | null, refuse })),
  z
    .object({
      warn: z.number().int().min(1).max(100).nullable().optional(),
      refuse: z.number().int().min(1).max(100),
    })
    .superRefine((data, ctx) => {
      if (data.warn !== null && data.warn !== undefined && data.warn >= data.refuse) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["warn"],
          message: "warn must be < refuse",
        });
      }
    })
    .transform((value) => ({
      warn: value.warn ?? null,
      refuse: value.refuse,
    })),
]);

export const ProviderQuotaConfigSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1).optional(),
  quota_usd_per_24h: z.number().positive().optional(),
  quota_tokens_per_24h: z.number().int().positive().optional(),
  quota_tokens_per_5h: z.number().int().positive().optional(),
  cost_budget_usd_per_5h: z.number().positive().optional(),
  cost_budget_usd_per_week: z.number().positive().optional(),
  cost_budget_usd_per_month: z.number().positive().optional(),
  pressure_caps: z.record(z.string().min(1), PressureCapWindowSchema).optional(),
  synthetic_cap: z
    .object({
      max_dispatches: z.number().int().positive(),
      window_seconds: z.number().int().positive(),
    })
    .optional(),
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

export const NotificationChannelSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("discord_webhook"),
    default_webhook_url_env: z.string().min(1).default("PENUMBRA_DISCORD_WEBHOOK_URL"),
  }),
]);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationProjectRouteSchema = z.object({
  channel: z.string().min(1).default("discord"),
  webhook_url_env: z.string().min(1).optional(),
  include_prompt: z.boolean().optional(),
  prompt_policy: z.enum(["never", "summary", "always"]).optional(),
});
export type NotificationProjectRoute = z.infer<typeof NotificationProjectRouteSchema>;

export const NotificationIdentitySchema = z.object({
  display_name: z.string().min(1).optional(),
  avatar_url: z.string().url().optional(),
  avatar_url_env: z.string().min(1).optional(),
});
export type NotificationIdentity = z.infer<typeof NotificationIdentitySchema>;

export const NotificationSummaryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    interval: z.enum(["hourly", "daily"]).default("daily"),
    channel: z.string().min(1).default("discord"),
  })
  .default({ enabled: true, interval: "daily", channel: "discord" });
export type NotificationSummaryConfig = z.infer<typeof NotificationSummaryConfigSchema>;

export const NotificationConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    include_prompt: z.boolean().optional(),
    prompt_policy: z.enum(["never", "summary", "always"]).default("never"),
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
        cost_quota: { enabled: true, interval: "daily", channel: "discord" },
      }),
  })
  .optional();
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;

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
    agent: z.string().min(1).default("local-gemma26"),
    max_input_chars: z.number().int().positive().default(50000),
    timeout_ms: z.number().int().positive().default(60000),
  })
  .optional();
export type ThoughtDigestConfig = z.infer<typeof ThoughtDigestConfigSchema>;

export const ThoughtSignalsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    agent: z.string().min(1).default("local-gemma26"),
    timeout_ms: z.number().int().positive().default(60000),
    max_input_chars: z.number().int().positive().optional(),
    definitions: z.array(ThoughtSignalDefinitionSchema).default([]),
  })
  .optional();
export type ThoughtSignalsConfig = z.infer<typeof ThoughtSignalsConfigSchema>;

export const ThoughtAnalyzeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    only_when: z.array(z.string().min(1)).default(["pr_opened", "test_failed", "typecheck_failed"]),
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
  .optional();
export type ShellConfig = z.infer<typeof ShellConfigSchema>;

export const RoleRoutingConfigSchema = z
  .object({
    exploration_policy: z.enum(["unsampled-first", "ranked-first"]).default("unsampled-first"),
    headroom_weighting: z.boolean().default(false),
    latency_weighting: z.boolean().default(false),
  })
  .default({
    exploration_policy: "unsampled-first",
    headroom_weighting: false,
    latency_weighting: false,
  });
export type RoleRoutingConfig = z.infer<typeof RoleRoutingConfigSchema>;

const AgentPinSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const ReviewPersonaSchema = z.object({
  name: z.string().min(1),
  bias: z.string().min(1),
  system_prompt: z.string().min(1),
  preferred_agent: AgentPinSchema,
  category_hints: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export type ReviewPersona = z.infer<typeof ReviewPersonaSchema>;

export const ReviewSynthesizerSchema = z.object({
  preferred_agent: AgentPinSchema,
  system_prompt: z.string().min(1),
});
export type ReviewSynthesizer = z.infer<typeof ReviewSynthesizerSchema>;

export const PlannerPersonaSchema = z.object({
  name: z.string().min(1),
  bias: z.string().min(1),
  system_prompt: z.string().min(1),
  preferred_agent: AgentPinSchema,
  description: z.string().optional(),
});
export type PlannerPersona = z.infer<typeof PlannerPersonaSchema>;

export const PlanSynthesizerSchema = z.object({
  preferred_agent: AgentPinSchema,
  system_prompt: z.string().min(1),
});
export type PlanSynthesizer = z.infer<typeof PlanSynthesizerSchema>;

export const AgentChatConfigSchema = z.object({
  agents: z.array(AgentConfigSchema).min(1),
  default_roles: z.record(z.string(), z.string()).default({}),
  reconcilerAutoRebase: z.boolean().default(true),
  role_routing: RoleRoutingConfigSchema.optional(),
  review_personas: z.record(z.string(), ReviewPersonaSchema).optional(),
  review_synthesizer: ReviewSynthesizerSchema.optional(),
  planner_personas: z.record(z.string(), PlannerPersonaSchema).optional(),
  plan_synthesizer: PlanSynthesizerSchema.optional(),
  providers: z.array(ProviderQuotaConfigSchema).default([]),
  notifications: NotificationConfigSchema,
  thoughts: ThoughtsConfigSchema,
  shell: ShellConfigSchema,
});
export type AgentChatConfig = z.infer<typeof AgentChatConfigSchema>;
