import { z, type ZodTypeAny } from "zod";

export type EnvEntry<T> = {
  schema: ZodTypeAny;
  default?: T;
  description: string;
  isSensitive?: boolean;
};

const Bool = z
  .enum(["true", "1", "yes", "false", "0", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const NonNegInt = z.coerce
  .number()
  .int()
  .min(0)
  .refine((v) => !Number.isNaN(v), {
    message: "must be a valid number",
  });
const PosInt = z.coerce
  .number()
  .int()
  .min(1)
  .refine((v) => !Number.isNaN(v), {
    message: "must be a valid number",
  });
const NonNegNum = z.coerce
  .number()
  .min(0)
  .refine((v) => !Number.isNaN(v), {
    message: "must be a valid number",
  });
const Port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .refine((v) => !Number.isNaN(v), {
    message: "must be a valid port number",
  });
const OptStr = z.string().optional();
const ReqStr = z.string().min(1);
const OptNonNegInt = NonNegInt.optional();
const OptNonNegNum = NonNegNum.optional();

export const ENV_REGISTRY: Readonly<Record<string, EnvEntry<unknown>>> = {
  // ── daemon ──────────────────────────────────────────────────────────
  PENUMBRA_DAEMON_HOST: {
    schema: z.string(),
    default: "127.0.0.1",
    description: "Hostname the daemon listens on.",
  },
  PENUMBRA_DAEMON_URL: {
    schema: OptStr,
    description: "Full URL of the daemon (auto-discovered when unset).",
  },
  PENUMBRA_DAEMON_TOKEN: {
    schema: OptStr,
    description: "Bearer token for daemon HTTP API.",
    isSensitive: true,
  },
  PENUMBRA_DAEMON_CLIENT: {
    schema: OptStr,
    description: "Client identifier for daemon requests.",
  },
  PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID: {
    schema: Bool,
    default: false,
    description: "Require explicit project_id on chain_start.",
  },
  PENUMBRA_AUTO_RECALL_ENABLED: {
    schema: Bool,
    default: true,
    description: "Enable automatic memory recall on chain_start dispatches.",
  },
  PENUMBRA_STORAGE_ROOT: {
    schema: OptStr,
    description: "Root directory for penumbra storage.",
  },
  PENUMBRA_ALLOW_REMOTE: {
    schema: Bool,
    default: false,
    description: "Allow connections from non-localhost origins.",
  },
  PENUMBRA_DEBUG_ERRORS: {
    schema: Bool,
    default: false,
    description: "Include stack traces in error responses.",
  },
  PENUMBRA_TOKEN: {
    schema: OptStr,
    description: "Generic penumbra bearer token.",
    isSensitive: true,
  },
  PENUMBRA_BIN: {
    schema: OptStr,
    description: "Path to the penumbra CLI binary.",
  },
  PENUMBRA_CONFIG: {
    schema: OptStr,
    description: "Path to penumbra config file.",
  },
  PENUMBRA_CONFIG_DIR: {
    schema: OptStr,
    description: "Directory containing penumbra split config files.",
  },
  PENUMBRA_CONSOLE_DIST: {
    schema: OptStr,
    description: "Path to the console static dist directory.",
  },

  // ── worker ──────────────────────────────────────────────────────────
  PENUMBRA_WORKER_URL: {
    schema: OptStr,
    description: "URL for the agentchat worker.",
  },
  PENUMBRA_WORKER_ID: {
    schema: OptStr,
    description: "Unique worker identifier.",
  },
  PENUMBRA_WORKER_HEARTBEAT_STALE_MS: {
    schema: OptNonNegInt,
    description: "Milliseconds before a worker heartbeat is considered stale.",
  },
  PENUMBRA_WORKER_HEARTBEAT_TIMEOUT_MS: {
    schema: OptNonNegInt,
    description: "Milliseconds before a worker heartbeat times out.",
  },
  PENUMBRA_WORKER_ISOLATION: {
    schema: OptStr,
    default: "",
    description: "Worker isolation mode: sticky, hard, or shared.",
  },
  PENUMBRA_WORKER_PROJECT_ID: {
    schema: OptStr,
    default: "",
    description: "Project ID for worker isolation.",
  },
  PENUMBRA_WORKER_PROBE_ENABLED: {
    schema: Bool,
    default: true,
    description: "Enable worker health probes.",
  },
  PENUMBRA_WORKER_PROBE_INTERVAL_MS: {
    schema: NonNegInt,
    default: 15000,
    description: "Worker probe interval in milliseconds.",
  },
  PENUMBRA_WORKER_PROBE_MISS_THRESHOLD: {
    schema: NonNegInt,
    default: 3,
    description: "Number of missed probes before eviction.",
  },
  PENUMBRA_WORKER_TOKEN_STALE_MS: {
    schema: OptNonNegInt,
    description: "Milliseconds before a worker token is considered stale.",
  },
  PENUMBRA_WORKER_TOKEN_SWEEP_INTERVAL_MS: {
    schema: OptNonNegInt,
    description: "Interval for sweeping stale worker tokens.",
  },
  PENUMBRA_WORKERS_CONFIG_PATH: {
    schema: OptStr,
    description: "Path to workers.yaml config file.",
  },
  PENUMBRA_EXTRA_WORKERS_ENABLED: {
    schema: Bool,
    default: true,
    description: "Enable the extra-worker supervisor.",
  },
  PENUMBRA_BOOT_RECONCILE: {
    schema: Bool,
    default: true,
    description: "Run orphan reconciliation on boot.",
  },

  // ── agentchat ───────────────────────────────────────────────────────
  PENUMBRA_PERMISSION_TTL_S: {
    schema: NonNegInt,
    default: 300,
    description: "Permission request TTL in seconds.",
  },
  PENUMBRA_PROJECTS_YAML: {
    schema: OptStr,
    description: "Path to projects.yaml registry.",
  },
  PENUMBRA_HANDOFF_ID: {
    schema: OptStr,
    description: "Current handoff ID (set by dispatch).",
  },
  PENUMBRA_OPENCODE_MODEL: {
    schema: OptStr,
    default: "gpt-5",
    description: "Model for opencode adapter.",
  },
  PENUMBRA_REFINER_MODEL: {
    schema: OptStr,
    description: "Model for task refiner.",
  },
  PENUMBRA_RECURSION_DEPTH_CAP: {
    schema: PosInt,
    default: 8,
    description: "Max recursion depth for chain dispatches.",
  },
  PENUMBRA_MCP_BIN: {
    schema: OptStr,
    description: "Path to the penumbra MCP server binary.",
  },
  PENUMBRA_MCP_INJECTED_ENV_KEYS: {
    schema: OptStr,
    description: "Comma-separated env keys to inject into MCP sessions.",
  },
  PENUMBRA_MCP_INVOCATION_LOG_ENABLED: {
    schema: Bool,
    default: false,
    description:
      "When true, every MCP tool invocation is appended as one JSONL row (ts, tool, origin, args_bytes, result_bytes, duration_ms, ok, error_kind) to $XDG_STATE_HOME/penumbra/mcp-invocations.jsonl. No payloads are captured. Opt-in; restart the penumbra-mcp stdio child to pick up changes.",
  },
  PENUMBRA_MCP_TOOL_ALLOWLIST: {
    schema: OptStr,
    description: "Comma- or newline-separated MCP tool allowlist.",
  },
  PENUMBRA_CANCEL_GRACE_S: {
    schema: OptNonNegInt,
    description: "Grace period in seconds before cancelling a handoff.",
  },

  // ── dreaming ────────────────────────────────────────────────────────
  PENUMBRA_DREAMING_ENABLED: {
    schema: Bool,
    default: false,
    description: "Enable the dreaming cron loop.",
  },
  PENUMBRA_DREAMING_CRON_MINUTES: {
    schema: NonNegInt,
    default: 30,
    description: "Dreaming cycle interval in minutes.",
  },
  PENUMBRA_DREAMING_PER_CYCLE_USD: {
    schema: NonNegNum,
    default: 0.5,
    description: "Max USD per dreaming cycle.",
  },
  PENUMBRA_DREAMING_DAILY_USD: {
    schema: NonNegNum,
    default: 5.0,
    description: "Max daily USD for dreaming.",
  },
  PENUMBRA_DREAMING_PRESSURE_GUARD: {
    schema: Bool,
    default: true,
    description: "Enable dreaming pressure guard.",
  },
  PENUMBRA_DREAMING_PER_CYCLE_EMBEDDING_USD: {
    schema: NonNegNum,
    default: 0.1,
    description: "Max embedding USD per dreaming cycle.",
  },
  PENUMBRA_DREAMING_PER_CYCLE_RESEARCH_USD: {
    schema: NonNegNum,
    default: 0.25,
    description: "Max research USD per dreaming cycle.",
  },
  PENUMBRA_DREAMING_LINK_AUTO_THRESHOLD: {
    schema: NonNegNum,
    default: 0.75,
    description: "Auto-apply score threshold for links.",
  },
  PENUMBRA_DREAMING_P: {
    schema: OptNonNegInt,
    description: "Legacy dreaming p1 batch size.",
  },
  PENUMBRA_DREAMING_PC: {
    schema: OptNonNegInt,
    description: "Legacy dreaming pc batch size.",
  },
  PENUMBRA_DREAMING_RETIRE_AUTO_THRESHOLD: {
    schema: NonNegNum,
    default: 0.85,
    description: "Auto-retire score threshold.",
  },
  PENUMBRA_DREAMING_CONTENT_QUALITY_THRESHOLD: {
    schema: NonNegNum,
    default: 0.5,
    description: "Content quality threshold.",
  },
  PENUMBRA_DREAMING_AUTO_PROMOTE_MIN_JUDGES: {
    schema: NonNegInt,
    default: 2,
    description: "Minimum judges for auto-promote.",
  },
  PENUMBRA_DREAMING_REEMBED_BATCH_SIZE: {
    schema: NonNegInt,
    default: 100,
    description: "Re-embedding batch size.",
  },
  PENUMBRA_DREAMING_SKIP_PHASES: {
    schema: z.string(),
    default: "",
    description: "Comma-separated dreaming phases to skip.",
  },
  PENUMBRA_DREAMING_EVENT_TRIGGER_ENABLED: {
    schema: Bool,
    default: true,
    description: "Enable event-triggered dreaming.",
  },
  PENUMBRA_DREAMING_IDLE_MINUTES: {
    schema: NonNegInt,
    default: 15,
    description: "Idle minutes before dreaming triggers.",
  },
  PENUMBRA_DREAMING_TRIGGER_COOLDOWN_MINUTES: {
    schema: NonNegInt,
    default: 5,
    description: "Cooldown between dreaming triggers.",
  },
  PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS: {
    schema: NonNegInt,
    default: 24,
    description: "Hours between brief refreshes.",
  },
  PENUMBRA_DREAMING_BRIEF_SYNTH_MAX_MEMORIES: {
    schema: NonNegInt,
    default: 20,
    description: "Max memories for brief synthesis.",
  },
  PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ALLOW_PUBLIC: {
    schema: Bool,
    default: false,
    description: "Allow public synthesizer for briefs.",
  },
  PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ROLE: {
    schema: OptStr,
    description: "Role for brief synthesizer.",
  },
  PENUMBRA_DREAMING_JUDGE_ROLE: {
    schema: OptStr,
    description: "Role for dreaming judge.",
  },
  PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS: {
    schema: NonNegInt,
    default: 86_400_000,
    description: "Negative cache TTL in milliseconds.",
  },
  PENUMBRA_DREAMING_CURATOR_ENABLED: {
    schema: Bool,
    default: false,
    description: "Enable the dreaming curator.",
  },
  PENUMBRA_DREAMING_REWRITER_ENABLED: {
    schema: Bool,
    default: false,
    description: "Enable the dreaming rewriter.",
  },
  PENUMBRA_DREAMING_REWRITER_BASE_URL: {
    schema: z.string(),
    default: "http://127.0.0.1:7944",
    description: "Base URL for the dreaming rewriter.",
  },
  PENUMBRA_DREAMING_REWRITER_MODEL: {
    schema: z.string(),
    default: "Qwen3.6-35B-A3B-4bit",
    description: "Model for the dreaming rewriter.",
  },
  PENUMBRA_DREAMING_REWRITER_TIMEOUT_MS: {
    schema: NonNegInt,
    default: 5000,
    description: "Rewriter request timeout in milliseconds.",
  },
  PENUMBRA_DREAMING_REWRITER_CACHE_TTL_MS: {
    schema: NonNegInt,
    default: 30 * 86_400_000,
    description: "Rewriter cache TTL in milliseconds.",
  },
  PENUMBRA_DREAMING_REWRITER_CONCURRENCY: {
    schema: NonNegInt,
    default: 4,
    description: "Rewriter concurrency limit.",
  },
  PENUMBRA_DREAMING_QUERY_GATE_ENABLED: {
    schema: Bool,
    default: true,
    description: "Enable dreaming query gate.",
  },
  PENUMBRA_DREAMING_INTERNAL_TERMS: {
    schema: OptStr,
    description: "Comma-separated internal terms for query rewriting.",
  },
  PENUMBRA_DREAM_DIGEST_DIR: {
    schema: OptStr,
    description: "Directory for dream digest output.",
  },
  PENUMBRA_DREAM_MODE_STRATEGY: {
    schema: OptStr,
    description: "Dream mode strategy.",
  },

  // ── discord ─────────────────────────────────────────────────────────
  PENUMBRA_DISCORD_WEBHOOK_URL: {
    schema: OptStr,
    description: "Discord webhook URL for alerts.",
    isSensitive: true,
  },
  PENUMBRA_DISCORD_ALERTS_WEBHOOK_URL: {
    schema: OptStr,
    description: "Discord webhook URL for general alerts.",
    isSensitive: true,
  },
  PENUMBRA_DISCORD_PROJECT_WEBHOOK_URL: {
    schema: OptStr,
    description: "Discord webhook URL for project alerts.",
    isSensitive: true,
  },
  PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL: {
    schema: OptStr,
    description: "Discord webhook URL for penumbra project alerts.",
    isSensitive: true,
  },
  PENUMBRA_DISCORD_AVATAR_CODEX_URL: {
    schema: OptStr,
    description: "Discord avatar URL for codex bot.",
  },
  PENUMBRA_DISCORD_INCLUDE_PROMPT: {
    schema: Bool,
    default: false,
    description: "Include prompt in discord notifications.",
  },
  PENUMBRA_DISCORD_QUIET: {
    schema: Bool,
    default: false,
    description: "Suppress discord notifications.",
  },

  // ── console ─────────────────────────────────────────────────────────
  PENUMBRA_CSP_BUILD: {
    schema: Bool,
    default: false,
    description: "Enable CSP build mode for console.",
  },
  PENUMBRA_VISUAL_HARNESS: {
    schema: Bool,
    default: false,
    description: "Enable visual harness for console.",
  },
  PENUMBRA_DESIGN_DIR: {
    schema: OptStr,
    description: "Path to design directory.",
  },
  PENUMBRA_REVIEWS_DIR: {
    schema: OptStr,
    description: "Path to reviews directory.",
  },

  // ── claude subscription ─────────────────────────────────────────────
  PENUMBRA_CLAUDE_CODE_SUBSCRIPTION: {
    schema: OptStr,
    description: "Claude Code subscription tier (api, max, etc.).",
  },
  PENUMBRA_CLAUDE_RL_PATH: {
    schema: z.string(),
    default: "/tmp/penumbra-claude-rl.json",
    description: "Path to Claude rate-limit state file.",
  },

  // ── cost / usage ────────────────────────────────────────────────────
  PENUMBRA_USAGE_POLL_DISABLED: {
    schema: Bool,
    default: false,
    description: "Disable usage polling.",
  },
  PENUMBRA_USAGE_POLL_INTERVAL_MS: {
    schema: OptNonNegInt,
    description: "Usage poll interval in milliseconds.",
  },

  // ── sirius ──────────────────────────────────────────────────────────
  PENUMBRA_SIRIUS_BASE_URL: {
    schema: OptStr,
    description: "Base URL for sirius-gateway.",
  },
  PENUMBRA_SIRIUS_DIM: {
    schema: NonNegInt,
    default: 1536,
    description: "Embedding dimension for sirius.",
  },
  PENUMBRA_SIRIUS_MODEL: {
    schema: OptStr,
    description: "Model for sirius requests.",
  },
  PENUMBRA_SIRIUS_TOKEN: {
    schema: OptStr,
    description: "Bearer token for sirius-gateway.",
    isSensitive: true,
  },

  // ── judge ───────────────────────────────────────────────────────────
  PENUMBRA_JUDGE_BASE_URL: {
    schema: OptStr,
    description: "Base URL for the judge LLM.",
  },
  PENUMBRA_JUDGE_MODEL: {
    schema: OptStr,
    default: "gpt-4o",
    description: "Model for judge evaluations.",
  },
  PENUMBRA_JUDGE_ROLE: {
    schema: z.string(),
    default: "memory-refiner",
    description: "Role for the judge.",
  },
  PENUMBRA_JUDGE_TOKEN: {
    schema: OptStr,
    description: "Bearer token for the judge LLM.",
    isSensitive: true,
  },
  PENUMBRA_EMBEDDER_PREFER_SIRIUS: {
    schema: Bool,
    default: false,
    description: "Prefer sirius for embeddings.",
  },
  PENUMBRA_EMBEDDING_MODEL_VERSION: {
    schema: z.string(),
    default: "v1",
    description: "Embedding model version tag.",
  },

  // ── handoff / dispatch ──────────────────────────────────────────────
  PENUMBRA_HANDOFF_DISPATCHED_TTL_MS: {
    schema: OptNonNegInt,
    description: "TTL for dispatched handoffs in milliseconds.",
  },
  PENUMBRA_HANDOFF_PENDING_TTL_MS: {
    schema: OptNonNegInt,
    description: "TTL for pending handoffs in milliseconds.",
  },
  PENUMBRA_DISPATCH_TIMEOUT_S: {
    schema: OptNonNegInt,
    description: "Dispatch timeout in seconds.",
  },
  PENUMBRA_ORPHAN_HANDOFF_FAIL_FAST: {
    schema: Bool,
    default: false,
    description: "Fail fast on orphan handoffs.",
  },
  PENUMBRA_ORPHAN_HANDOFF_RECOVERY_BATCH: {
    schema: OptNonNegInt,
    description: "Batch size for orphan recovery.",
  },
  PENUMBRA_ORPHAN_HANDOFF_RECOVERY_INTERVAL_MS: {
    schema: OptNonNegInt,
    description: "Interval for orphan recovery sweeps.",
  },
  PENUMBRA_ORPHAN_HANDOFF_STRICT_MODE: {
    schema: Bool,
    default: false,
    description: "Strict mode for orphan handoff recovery.",
  },
  PENUMBRA_PR_ORPHAN_SWEEPER_DRY_RUN: {
    schema: Bool,
    default: false,
    description: "Dry-run mode for PR orphan sweeper.",
  },
  PENUMBRA_PR_ORPHAN_SWEEPER_INTERVAL_MS: {
    schema: OptNonNegInt,
    description: "Interval for PR orphan sweeper.",
  },
  PENUMBRA_RECONCILER_SWEEP_INTERVAL_MS: {
    schema: OptNonNegInt,
    description: "Interval for reconciler sweeps.",
  },
  PENUMBRA_RECONCILER_SWEEP_MAX_CLOSE: {
    schema: NonNegInt,
    default: 5,
    description: "Max PRs to close per reconciler sweep.",
  },
  PENUMBRA_RECONCILE_TEST_TIMEOUT_S: {
    schema: OptNonNegInt,
    description: "Timeout for reconcile tests in seconds.",
  },
  PENUMBRA_RECONCILE_TYPECHECK_TIMEOUT_S: {
    schema: OptNonNegInt,
    description: "Timeout for typecheck in reconcile.",
  },
  PENUMBRA_WORKTREE_GC_INTERVAL_MS: {
    schema: OptNonNegInt,
    description: "Interval for worktree GC in milliseconds.",
  },
  PENUMBRA_WORKTREE_GC_GRACE_MS: {
    schema: OptNonNegInt,
    description: "Grace period for worktree GC in milliseconds.",
  },
  PENUMBRA_WORKTREE_ROOT: {
    schema: OptStr,
    description: "Root directory for worktrees.",
  },

  // ── long-lived ──────────────────────────────────────────────────────
  PENUMBRA_LONG_LIVED_AGENT_ID: {
    schema: OptStr,
    description: "Current long-lived agent ID.",
  },
  PENUMBRA_LONG_LIVED_TICK_ID: {
    schema: OptStr,
    description: "Current long-lived tick ID.",
  },
  PENUMBRA_LONG_LIVED_THREAD_NOTES_MAX_CHARS: {
    schema: NonNegInt,
    default: 4096,
    description: "Max chars for thread notes before truncation.",
  },

  // ── notification ────────────────────────────────────────────────────
  PENUMBRA_NOTIFICATION_SCHEDULER_DISABLED: {
    schema: Bool,
    default: false,
    description: "Disable the notification scheduler.",
  },
  PENUMBRA_HOOK_EVENTS: {
    schema: OptStr,
    description: "Hook event types to trigger.",
  },
  PENUMBRA_HOOK_RE: {
    schema: OptStr,
    description: "Regex filter for hooks.",
  },

  // ── misc ────────────────────────────────────────────────────────────
  PENUMBRA_MAESTRO_REDACTION_BYPASS: {
    schema: Bool,
    default: false,
    description: "Bypass maestro output redaction.",
  },
  PENUMBRA_MARKER_PREFIX: {
    schema: OptStr,
    description: "Prefix for penumbra markers.",
  },
  PENUMBRA_RG_BINARY: {
    schema: z.string(),
    default: "rg",
    description: "Path to ripgrep binary.",
  },
  PENUMBRA_RUN_OPENCODE_INTEGRATION: {
    schema: Bool,
    default: false,
    description: "Enable opencode integration tests.",
  },
  PENUMBRA_SHELL_SESSION_ID: {
    schema: OptStr,
    description: "Current shell session ID.",
  },
  PENUMBRA_SKIP_ONNX: {
    schema: Bool,
    default: false,
    description: "Skip ONNX runtime initialization.",
  },
  PENUMBRA_TERMINAL_PROGRESS_CAP: {
    schema: NonNegInt,
    default: 5,
    description: "Max terminal progress lines to show.",
  },
  PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID: {
    schema: Bool,
    default: false,
    description: "Require explicit project_id on requests.",
  },
  PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH: {
    schema: Bool,
    default: false,
    description: "Require prompt to match project context.",
  },
  PENUMBRA_BACKUP_RETENTION_DAYS: {
    schema: OptNonNegInt,
    description: "Number of days to retain backups.",
  },
  // ── tier configuration (consumed by core/settings.ts) ─────────────
  PENUMBRA_T0_RETENTION_DAYS: {
    schema: PosInt,
    default: 30,
    description: "Days to retain t0 observations.",
  },
  PENUMBRA_T1_ROLLUP_INTERVAL_SEC: {
    schema: PosInt,
    default: 60,
    description: "Seconds between t1 rollup passes.",
  },
  PENUMBRA_T1_SESSION_IDLE_MINUTES: {
    schema: PosInt,
    default: 10,
    description: "Minutes of idle before a t1 session closes.",
  },
  PENUMBRA_T2_PROMOTION_DELAY_HOURS: {
    schema: NonNegInt,
    default: 24,
    description: "Hours to delay t2 promotion after t1 close.",
  },
  // ── dreaming phase tunables (consumed by dreaming/config.ts + curator) ─
  PENUMBRA_DREAMING_P1_BATCH_SIZE: {
    schema: OptNonNegInt,
    description: "P1 batch size (overrides PENUMBRA_DREAMING_P; default 10).",
  },
  PENUMBRA_DREAMING_P4_QUEUE_MAX: {
    schema: NonNegInt,
    default: 1000,
    description: "P4 research query queue cap.",
  },
  PENUMBRA_DREAMING_PC1_BATCH: {
    schema: OptNonNegInt,
    description: "DEPRECATED — use PENUMBRA_DREAMING_PC1_BATCH_SIZE.",
  },
  PENUMBRA_DREAMING_PC1_BATCH_SIZE: {
    schema: OptNonNegInt,
    description: "PC1 ephemera batch size (default 100).",
  },
  PENUMBRA_DREAMING_PC2_AUTO_APPLY: {
    schema: Bool,
    default: false,
    description: "Auto-apply PC2 cluster links when score >= PC2_AUTO_THRESHOLD.",
  },
  PENUMBRA_DREAMING_PC2_AUTO_THRESHOLD: {
    schema: NonNegNum,
    default: 0.97,
    description: "Auto-apply score threshold for PC2 intra-cluster links.",
  },
  PENUMBRA_DREAMING_PC2_CLUSTER_LINK_THRESHOLD: {
    schema: OptNonNegNum,
    description: "PC2 cluster link min-score (default 0.85).",
  },
  PENUMBRA_DREAMING_PC2_MIN_CLUSTER: {
    schema: OptNonNegInt,
    description: "DEPRECATED — use PENUMBRA_DREAMING_PC2_MIN_CLUSTER_SIZE.",
  },
  PENUMBRA_DREAMING_PC2_MIN_CLUSTER_SIZE: {
    schema: OptNonNegInt,
    description: "PC2 minimum cluster size (default 3).",
  },
  PENUMBRA_DREAMING_PC2_QUEUE_THRESHOLD: {
    schema: OptNonNegNum,
    description: "DEPRECATED — use PENUMBRA_DREAMING_PC2_CLUSTER_LINK_THRESHOLD.",
  },
  // ── e2e test gates ────────────────────────────────────────────────
  PENUMBRA_E2E: {
    schema: Bool,
    default: false,
    description: "Enable end-to-end test suites.",
  },
  PENUMBRA_E2E_LLAMACTL: {
    schema: Bool,
    default: false,
    description: "Enable llamactl end-to-end smoke tests.",
  },
  PENUMBRA_E2E_LLAMACTL_MANIFEST: {
    schema: OptStr,
    description: "Path to llamactl e2e manifest fixture.",
  },
} as const;

const shape: Record<string, ZodTypeAny> = {};
for (const [key, entry] of Object.entries(ENV_REGISTRY)) {
  shape[key] =
    entry.default !== undefined ? entry.schema.default(entry.default) : entry.schema.optional();
}

export const EnvSchema = z.object(shape);
export type EnvConfig = z.infer<typeof EnvSchema>;

export function parseEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const subset: Record<string, string | undefined> = {};
  for (const key of Object.keys(ENV_REGISTRY)) {
    if (key in env) {
      subset[key] = env[key];
    }
  }
  return EnvSchema.parse(subset) as EnvConfig;
}

export function isMcpInvocationLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnv(env).PENUMBRA_MCP_INVOCATION_LOG_ENABLED === true;
}
