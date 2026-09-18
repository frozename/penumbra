import { z } from "zod";

export type EnvEntry<T> = {
  schema: z.ZodType;
  default?: T;
  description: string;
  isSensitive?: boolean;
};

// KEY='' contract (see load.ts): an operator who exports KEY='' opts out of
// any inherited value. Per-type semantics:
//   Bool      empty -> undefined so the field's .default() (or .optional())
//                      applies instead of crashing the enum match.
//   NonNeg*   empty -> NaN so the coercion chain fails strictly, matching
//                      PosInt (which already rejects '' via min(1)) instead of
//                      silently coercing Number('') === 0 and masking misconfig.
const emptyToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;
const emptyToNaN = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? Number.NaN : v;

const Bool = z
  .enum(["true", "1", "yes", "false", "0", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");
const T2EmbedRecipe = z.enum(["body_v1", "title_only", "title_plus_concise"]);

const NonNegInt = z.preprocess(
  emptyToNaN,
  z.coerce
    .number()
    .int()
    .min(0)
    .refine((v) => !Number.isNaN(v), {
      message: "must be a valid number",
    }),
);
const PosInt = z.coerce
  .number()
  .int()
  .min(1)
  .refine((v) => !Number.isNaN(v), {
    message: "must be a valid number",
  });
const NonNegNum = z.preprocess(
  emptyToNaN,
  z.coerce
    .number()
    .min(0)
    .refine((v) => !Number.isNaN(v), {
      message: "must be a valid number",
    }),
);
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
const OptPosInt = PosInt.optional();
const DEFAULT_SAKANA_SYNTH_MAX_PLAUSIBLE_PCT = 300;
export const DEFAULT_ALIBABA_SYNTH_MAX_PLAUSIBLE_PCT = 300;
const SakanaSynthMaxPlausiblePct = z.preprocess((v: unknown): unknown => {
  if (v === undefined) return v;
  const parsed = typeof v === "string" && v.trim() === "" ? Number.NaN : Number(v);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SAKANA_SYNTH_MAX_PLAUSIBLE_PCT;
  return parsed;
}, z.number().positive());
const AlibabaSynthMaxPlausiblePct = z.preprocess((v: unknown): unknown => {
  if (v === undefined) return v;
  const parsed = typeof v === "string" && v.trim() === "" ? Number.NaN : Number(v);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ALIBABA_SYNTH_MAX_PLAUSIBLE_PCT;
  return parsed;
}, z.number().positive());

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
  PENUMBRA_REGISTRAR: {
    schema: OptStr,
    description:
      "Daemon registrar route toggle. The daemon disables registrar routes only when this is exactly 0.",
  },
  PENUMBRA_EVENT_LOOP_LAG_THRESHOLD_MS: {
    schema: NonNegInt,
    default: 500,
    description: "Event-loop lag warning threshold in milliseconds.",
  },
  PENUMBRA_EVENT_LOOP_LAG_INTERVAL_MS: {
    schema: NonNegInt,
    default: 2000,
    description: "Event-loop lag sampling interval in milliseconds.",
  },
  PENUMBRA_SLOW_QUERY_THRESHOLD_MS: {
    schema: NonNegInt,
    default: 250,
    description: "Slow sqlite query logging threshold in milliseconds.",
  },
  PENUMBRA_DAEMON_SERVICE_TESTS: {
    schema: Bool,
    default: false,
    description: "Enable daemon tests that require live service-style integration harnesses.",
  },
  PENUMBRA_UPDATE_SCHEMA_SNAPSHOT: {
    schema: Bool,
    default: false,
    description:
      "Rewrite the committed db schema snapshot fixture instead of asserting against it.",
  },
  PENUMBRA_AUTO_RECALL_ENABLED: {
    schema: Bool,
    default: true,
    description: "Enable automatic memory recall on chain_start dispatches.",
  },
  PENUMBRA_WORKFLOW_RUN_WAIT_DEADLINE_MS: {
    schema: OptStr,
    description:
      "Workflow execution wait deadline after recall composition, in milliseconds. Defaults to and is capped at 240000, so numeric overrides can only lower it; blank, non-finite, or values below 1 fall back to 240000.",
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
  PENUMBRA_CLAUDE_USER_DIR: {
    schema: OptStr,
    description:
      "Directory that receives the bundled workflow install; defaults to ~/.claude. Set by the e2e harness so a test run cannot write into the developer real home.",
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
  PENUMBRA_WORKER_CRASH_GUARD: {
    schema: z.enum(["survive"]).optional(),
    description: "Set to survive to keep the agentchat worker alive after unhandled rejections.",
  },
  PENUMBRA_WORKERS_CONFIG_PATH: {
    schema: OptStr,
    description: "Path to workers.yaml config file.",
  },
  PENUMBRA_INJECT_TIMEOUT_MS: {
    schema: OptPosInt,
    description:
      "Timeout in milliseconds for mid-session message injection into a worker ACP session (agentchat/worker/inject-route.ts). Unset uses the 30s built-in default.",
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
  PENUMBRA_AGENTCHAT_SERVICE_TESTS: {
    schema: Bool,
    default: false,
    description: "Enable agentchat tests that require live service-style integration harnesses.",
  },
  PENUMBRA_PROJECTS_YAML: {
    schema: OptStr,
    description: "Path to projects.yaml registry.",
  },
  PENUMBRA_LOCAL_NODE_HOSTS: {
    schema: OptStr,
    default: "",
    description:
      "Comma-separated hostnames treated as local model nodes for analyzer health checks.",
  },
  PENUMBRA_LLAMACTL_PROXY_BASE_URL: {
    schema: z.string(),
    default: "http://127.0.0.1:7944",
    description: "Base URL for llamactl proxy served-model discovery.",
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
  PENUMBRA_OPENCODE_GROUP_KILL: {
    schema: Bool,
    default: true,
    description: "Kill opencode ACP child process groups on POSIX platforms.",
  },
  PENUMBRA_REFINER_MODEL: {
    schema: OptStr,
    description: "Model for task refiner.",
  },
  PENUMBRA_REFINER_ROLE: {
    schema: OptStr,
    description: "Role used to resolve task-refiner LLM candidates.",
  },
  PENUMBRA_REFINER_TIMEOUT_MS: {
    schema: PosInt,
    default: 90_000,
    description:
      "Dispatch-prompt refiner HTTP timeout in ms. Larger than the judge default because the refiner may use a reasoning model that emits a long chain-of-thought before the answer.",
  },
  PENUMBRA_JUDGE_TIMEOUT_MS: {
    schema: PosInt,
    default: 30_000,
    description: "Judge-chat HTTP request timeout in milliseconds.",
  },
  PENUMBRA_WARM_PREWARM_CAP: {
    schema: PosInt,
    default: 4,
    description: "Worker-level absolute cap on warm-pool processes across all pre-warmed slots.",
  },
  PENUMBRA_CLAIM_AFFINITY_GRACE_MS: {
    schema: NonNegInt,
    default: 500,
    description:
      "Grace a non-home worker holds back before claiming a warm-pooled handoff so a home-repoRoot worker wins the first-poll claim (0 disables).",
  },
  PENUMBRA_RECURSION_DEPTH_CAP: {
    schema: PosInt,
    default: 8,
    description: "Max recursion depth for chain dispatches.",
  },
  PENUMBRA_DISPATCH_DRIFT_ENABLED: {
    schema: Bool,
    default: true,
    description: "Enable the dispatch-drift reminder workflow.",
  },
  PENUMBRA_SOLO_DRIFT_THRESHOLD: {
    schema: PosInt,
    default: 8,
    description: "Consecutive non-dispatch tool calls before dispatch-drift reminder fires.",
  },
  PENUMBRA_SOLO_DRIFT_RENAG: {
    schema: PosInt,
    default: 4,
    description: "Additional non-dispatch tool calls between dispatch-drift reminder repeats.",
  },
  PENUMBRA_MCP_BIN: {
    schema: OptStr,
    description: "Path to the penumbra MCP server binary.",
  },
  PENUMBRA_MCP_INJECTED_ENV_KEYS: {
    schema: OptStr,
    description: "Comma-separated env keys to inject into MCP sessions.",
  },
  PENUMBRA_MCP_ORIGIN: {
    schema: OptStr,
    description: "Fallback origin label for MCP tool calls when request metadata is unavailable.",
  },
  PENUMBRA_MCP_BUILD_ID: {
    schema: OptStr,
    description:
      "Override for the build-metadata suffix in MCP_SERVER_VERSION. Falls back to the short git SHA, then 'unknown', when unset.",
  },
  PENUMBRA_MCP_INVOCATION_LOG_ENABLED: {
    schema: Bool,
    default: false,
    description:
      "When true, every MCP tool invocation is appended as one JSONL row (ts, tool, origin, args_bytes, result_bytes, duration_ms, ok, error_kind) to $XDG_STATE_HOME/penumbra/mcp-invocations.jsonl. No payloads are captured. Opt-in; restart the penumbra-mcp stdio child to pick up changes.",
  },
  PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS: {
    schema: OptPosInt,
    description:
      "Central MCP response budget in estimated tokens. When set, an oversized tool result is truncated to this budget and the full payload is spilled to the in-process handle store (recover via read_handle). Unset disables budgeting. Invalid values fail fast at MCP server startup; use a positive integer. Opt-in; restart the penumbra-mcp stdio child to pick up changes.",
  },
  PENUMBRA_MCP_TOOL_ALLOWLIST: {
    schema: OptStr,
    description: "Comma- or newline-separated MCP tool allowlist.",
  },
  PENUMBRA_MCP_ORIGIN_FLEET_WORKER: {
    schema: OptStr,
    default: "fleet-worker",
    description: "Origin label injected into fleet-worker MCP sessions.",
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
    // Dreaming runs on local/free models by default; set a positive value to re-enable a USD cap.
    default: 0,
    description: "Max USD per dreaming cycle (0 disables cap).",
  },
  PENUMBRA_DREAMING_DAILY_USD: {
    schema: NonNegNum,
    // Dreaming runs on local/free models by default; set a positive value to re-enable a USD cap.
    default: 0,
    description: "Max daily USD for dreaming (0 disables cap).",
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
  PENUMBRA_DREAMING_PHASE_LLM_FRACTION: {
    schema: OptNonNegNum,
    description: "Optional LLM lane budget fraction (0..1) for per-cycle/daily dreaming caps.",
  },
  PENUMBRA_DREAMING_PHASE_EMBEDDING_FRACTION: {
    schema: OptNonNegNum,
    description:
      "Optional embedding lane budget fraction (0..1) for per-cycle/daily dreaming caps.",
  },
  PENUMBRA_DREAMING_PHASE_RESEARCH_FRACTION: {
    schema: OptNonNegNum,
    description: "Optional research lane budget fraction (0..1) for per-cycle/daily dreaming caps.",
  },
  PENUMBRA_DREAMING_COST_ESTIMATE_P3_LLM_USD: {
    schema: NonNegNum,
    default: 0.02,
    description: "Estimated LLM USD per P3 scoring call.",
  },
  PENUMBRA_DREAMING_COST_ESTIMATE_P4_REWRITER_LLM_USD: {
    schema: NonNegNum,
    default: 0.01,
    description: "Estimated LLM USD per P4 query rewrite call.",
  },
  PENUMBRA_DREAMING_COST_ESTIMATE_P5_RESEARCH_USD: {
    schema: NonNegNum,
    default: 0.05,
    description: "Estimated research USD per P5 queued query action.",
  },
  PENUMBRA_DREAMING_COST_ESTIMATE_P6_SYNTH_LLM_USD: {
    schema: NonNegNum,
    default: 0.04,
    description: "Estimated LLM USD per P6 brief synthesis call.",
  },
  PENUMBRA_DREAMING_COST_ESTIMATE_P7_EMBED_USD: {
    schema: NonNegNum,
    default: 0.005,
    description: "Estimated embedding USD per P7 re-embed call.",
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
    default: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf",
    description: "Model for the dreaming rewriter.",
  },
  PENUMBRA_DREAMING_REWRITER_ROLE: {
    schema: OptStr,
    description: "Role used to resolve dreaming query-rewriter LLM candidates.",
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
  PENUMBRA_USAGE_POLL_SINGLETON: {
    schema: Bool,
    default: true,
    description:
      "Machine-wide usage-poll singleton lock gate; set to 0 so every worker polls (legacy behavior).",
  },

  // ── embeddings ──────────────────────────────────────────────────────
  PENUMBRA_EMBEDDINGS_BASE_URL: {
    schema: OptStr,
    description: "Base URL for remote OpenAI-compatible embeddings endpoint.",
  },
  PENUMBRA_EMBEDDINGS_MODEL: {
    schema: OptStr,
    description: "Model name for remote embeddings requests.",
  },
  PENUMBRA_EMBEDDINGS_DIM: {
    schema: NonNegInt,
    default: 384,
    description: "Embedding dimension for remote embeddings endpoint.",
  },
  PENUMBRA_EMBEDDINGS_TOKEN: {
    schema: OptStr,
    description: "Auth token for remote embeddings endpoint.",
    isSensitive: true,
  },
  PENUMBRA_EMBEDDINGS_AUTH_HEADER: {
    schema: z.string(),
    default: "Authorization",
    description: "Header key used when sending embeddings auth token.",
  },
  PENUMBRA_EMBEDDINGS_AUTH_SCHEME: {
    schema: z.string(),
    default: "Bearer",
    description: "Auth scheme prefix used with embeddings token (empty for raw token).",
  },
  PENUMBRA_EMBEDDINGS_HEALTH_PATH: {
    schema: z.string(),
    default: "/healthz",
    description: "Health path for probe checks; empty string disables probing.",
  },
  PENUMBRA_EMBEDDINGS_MODE: {
    schema: z.enum(["bundled", "remote", "auto"]),
    default: "auto",
    description: "Embeddings mode selection: bundled, remote, or auto.",
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

  // ── typesafe (Jev judge) ──────────────────────────────────────────────
  PENUMBRA_TYPESAFE_API_KEY: {
    schema: OptStr,
    description: "TypeSafe API key. Wins over the keychain ref when non-empty.",
    isSensitive: true,
  },
  PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN: {
    schema: OptStr,
    description:
      "Keychain ref 'service/account' for the TypeSafe API key, e.g. llamactl/typesafe. Used only when PENUMBRA_TYPESAFE_API_KEY is empty.",
  },
  PENUMBRA_TYPESAFE_BASE_URL: {
    schema: z.string(),
    default: "https://api.typesafe.ai",
    description: "TypeSafe API base URL. Must be https.",
  },
  PENUMBRA_TYPESAFE_MODEL: {
    schema: z.string(),
    default: "jev-1.13.0",
    description:
      "Pinned, versioned Jev model id. Aliases (jev-latest, jev-preview) move on release and are refused.",
  },
  PENUMBRA_TYPESAFE_TIMEOUT_MS: {
    schema: PosInt,
    default: 10_000,
    description:
      "TOTAL deadline in ms for one TypeSafe evaluation, across every attempt and backoff. Not per attempt.",
  },
  PENUMBRA_TYPESAFE_JUDGE_PROMOTION: {
    schema: z.enum(["off", "shadow"]),
    default: "off",
    description:
      "Judge-promotion mode: off | shadow. Any other value (including on/true) fails the whole config parse at boot.",
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
  PENUMBRA_DEAD_PIN_FAILURE_WINDOW_MS: {
    schema: OptPosInt,
    description:
      "Recency window for workflow preferred-agent dead-pin worker failures in milliseconds. Missing or invalid values use the workflow default.",
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
  PENUMBRA_AA_SNAPSHOT_REFRESH_INTERVAL_MS: {
    schema: OptPosInt,
    description:
      "Interval for the Artificial Analysis snapshot refresh sweeper in milliseconds. Must be a positive integer (0 is rejected, not treated as 'use the default').",
  },
  PENUMBRA_AA_SNAPSHOT_REFRESH_DISABLED: {
    schema: Bool,
    default: false,
    description: "Disable the Artificial Analysis snapshot refresh sweeper.",
  },
  PENUMBRA_PROVIDER_DRIFT_SWEEP_INTERVAL_MS: {
    schema: OptPosInt,
    description:
      "Interval for the provider-drift dry-run discovery sweeper in milliseconds. Must be a positive integer.",
  },
  PENUMBRA_PROVIDER_DRIFT_SWEEP_DISABLED: {
    schema: Bool,
    default: false,
    description: "Disable the provider-drift dry-run discovery sweeper.",
  },
  PENUMBRA_PROVIDER_DRIFT_CLI_ENTRY: {
    schema: OptStr,
    description:
      "Override path to the penumbra CLI entry the provider-drift sweeper spawns for its dry-run.",
  },
  PENUMBRA_GATE_QUALITY_DIGEST_DIR: {
    schema: OptStr,
    description: "Directory for gate-quality digest output.",
  },
  PENUMBRA_GATE_QUALITY_T2_WRITES: {
    schema: Bool,
    default: false,
    description:
      "Enable gate-quality digest writes to t2 memory. Off by default; digest generation still runs.",
  },
  PENUMBRA_GATE_QUALITY_DIGEST_INTERVAL_MS: {
    schema: OptNonNegInt,
    description: "Interval for the gate-quality digest sweeper in milliseconds.",
  },
  PENUMBRA_GATE_QUALITY_PRESSURE_GUARD: {
    schema: Bool,
    default: false,
    description:
      "Defer the gate-quality digest sweep when subscription pressure is over threshold. Off by default.",
  },
  PENUMBRA_MEMORY_EFFICACY_PRESSURE_GUARD: {
    schema: Bool,
    default: false,
    description:
      "Defer memory-efficacy job runs when subscription pressure is over threshold. Off by default.",
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
  PENUMBRA_GOOGLE_SYNTH_MAX_PLAUSIBLE_PCT: {
    schema: NonNegNum,
    default: 40,
    description: "Maximum plausible percentage for synthesized Google usage estimates.",
  },
  PENUMBRA_SAKANA_SYNTH_MAX_PLAUSIBLE_PCT: {
    schema: SakanaSynthMaxPlausiblePct,
    default: DEFAULT_SAKANA_SYNTH_MAX_PLAUSIBLE_PCT,
    description: "Maximum plausible percentage for synthesized Sakana usage estimates.",
  },
  PENUMBRA_ALIBABA_SYNTH_MAX_PLAUSIBLE_PCT: {
    schema: AlibabaSynthMaxPlausiblePct,
    default: DEFAULT_ALIBABA_SYNTH_MAX_PLAUSIBLE_PCT,
    description: "Maximum plausible percentage for synthesized Alibaba usage estimates.",
  },
  PENUMBRA_PER_WORKER_USAGE_CURSOR: {
    schema: Bool,
    default: true,
    description: "Store usage-reader cursors per worker instead of one shared cursor.",
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
  PENUMBRA_RUN_EMBED_BENCH: {
    schema: Bool,
    default: false,
    description: "Run the opt-in embed recipe benchmark test.",
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
  PENUMBRA_DISPATCH_EVENTS_RETENTION_DAYS: {
    schema: PosInt,
    default: 14,
    description:
      "Days to retain dispatch_events telemetry rows before the retention worker prunes them.",
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
  PENUMBRA_T2_EMBED_RECIPE: {
    schema: T2EmbedRecipe,
    // Default to the validated title-led recipe so a fresh install gets the recall
    // fix without operator config; existing corpora migrate via the version-gated P7 reembed.
    default: "title_plus_concise",
    description: "T2 embedding representation recipe (body_v1, title_only, title_plus_concise).",
  },
  PENUMBRA_T2_OVERSAMPLE_FACTOR: {
    schema: PosInt,
    default: 1,
    description: "Oversampling multiplier for T2 candidate retrieval.",
  },
  PENUMBRA_RECALL_VERIFIED_BOOST: {
    schema: Bool,
    default: false,
    description: "Boost recently verified T2 memories during recall ranking.",
  },
  PENUMBRA_T2_REEMBED_ENABLED: {
    schema: Bool,
    default: false,
    description: "Enable P7 t2 re-embedding/backfill passes.",
  },
  PENUMBRA_PROMOTION_NEAR_DUP_THRESHOLD: {
    schema: NonNegNum,
    // packages/core getNearDupThreshold enforces the (0,1] clamp at read time.
    default: 0.95,
    description: "Similarity threshold for the T2 promotion near-duplicate gate.",
  },
  PENUMBRA_PROMOTION_NEAR_DUP_GATE: {
    schema: Bool,
    default: false,
    description: "Enable the T2 promotion near-duplicate approval gate.",
  },
  PENUMBRA_EXTRACTION_FILTER_GATE: {
    schema: Bool,
    default: false,
    description: "Enable the T2 promotion extraction filter gate.",
  },
  PENUMBRA_EMBED_RECIPE_TIMEOUT_MS: {
    schema: NonNegInt,
    default: 180_000,
    description: "Timeout for T2 embed recipe benchmark candidates.",
  },
  // ── dreaming phase tunables (consumed by dreaming/config.ts + curator) ─
  PENUMBRA_DREAMING_P1_BATCH_SIZE: {
    schema: OptNonNegInt,
    description: "P1 batch size (overrides PENUMBRA_DREAMING_P; default 10).",
  },
  PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS: {
    schema: NonNegInt,
    default: 5,
    description: "Minimum t1_rollups.n_events required for t2 promotion eligibility (default 5).",
  },
  PENUMBRA_SESSION_SWEEP_ENABLED: {
    schema: Bool,
    default: true,
    description: "Enable close-time session memory candidate extraction.",
  },
  PENUMBRA_SESSION_SWEEP_MAX_CANDIDATES: {
    schema: PosInt,
    default: 10,
    description: "Maximum session-memory-sweep candidates to request from extraction.",
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
  PENUMBRA_PC1_AUTORETIRE: {
    schema: Bool,
    default: false,
    description: "Auto-retire memories detected as PC1 ephemera.",
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
  PENUMBRA_STALE_SWEEP_LIVENESS_CHECK: {
    schema: Bool,
    default: false,
    description: "Require worker liveness checks before stale handoff force-resolution.",
  },
  PENUMBRA_STALE_SWEEP_MAX_ALIVE_GRACE_MS: {
    schema: NonNegInt,
    default: 1_800_000,
    description: "Maximum stale handoff grace period while the owning worker is alive.",
  },
  // ── isolated install ────────────────────────────────────────────────
  PENUMBRA_ISOLATED_INSTALL_AUTO: {
    schema: Bool,
    default: false,
    description: "Auto-enable isolated install for all dispatches.",
  },
  PENUMBRA_ISOLATED_INSTALL_AUTO_BOUNDARY: {
    schema: Bool,
    default: false,
    description:
      "Auto-enable isolated install for BOUNDARY-class dispatches (read via isEnvTruthy in daemon/routes/chains.ts).",
  },
  PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS: {
    schema: PosInt,
    default: 120_000,
    description:
      "Timeout in milliseconds for the isolated `bun install` run on a new worktree (core/worktree/manager.ts).",
  },

  // ── auto-recall ─────────────────────────────────────────────────────
  PENUMBRA_AUTO_RECALL_PROJECT_BRIEF: {
    schema: Bool,
    default: false,
    description:
      "Inject the latest project brief into the auto-recall block on chain_start (isEnvTruthy, daemon/routes/chains.ts).",
  },

  // ── t2 judge (chunking + pool) ──────────────────────────────────────
  PENUMBRA_T2_JUDGE_MAX_CHARS_PER_CHUNK: {
    schema: PosInt,
    default: 80_000,
    description:
      "Max characters per transcript chunk sent to the t2 extraction judge before splitting (workers/t2-promotion.ts).",
  },
  PENUMBRA_T2_JUDGE_TIMEOUT_MS: {
    schema: PosInt,
    default: 900_000,
    description:
      "HTTP request timeout in milliseconds for the t2 judge pool (workers/t2-judge-pool.ts).",
  },
  PENUMBRA_SESSION_EXTRACT_MAX_CHARS_PER_CHUNK: {
    schema: PosInt,
    default: 20_000,
    description:
      "Max characters per transcript chunk for POST /memory/session-extract judging (routes/memory-session-extract.ts). Sized for 8192-token judges at ~3 chars/token minus the 3332-char template and output headroom.",
  },
  PENUMBRA_SESSION_EXTRACT_MAX_CHUNKS: {
    schema: PosInt,
    default: 8,
    description:
      "Max chunks judged per POST /memory/session-extract call; applied as head 2 / tail (N-2) after packing (routes/memory-session-extract.ts).",
  },

  // ── notification sweeper ────────────────────────────────────────────
  PENUMBRA_PENDING_ACTION_TTL_MS: {
    schema: NonNegNum,
    default: 7 * 24 * 60 * 60 * 1000,
    description:
      "TTL in milliseconds for pending notification actions; the sweeper uses 2x this as the discovery cutoff (sweepers/notification-sweeper.ts).",
  },
  PENUMBRA_NOTIFICATION_SWEEP_INTERVAL_MS: {
    schema: NonNegNum,
    default: 5 * 60 * 1000,
    description:
      "Interval in milliseconds between notification sweeps (sweepers/notification-sweeper.ts).",
  },

  // ── dispatch lifecycle lock ─────────────────────────────────────────
  PENUMBRA_LIFECYCLE_LOCK_TIMEOUT_MS: {
    schema: PosInt,
    default: 300_000,
    description:
      "Hold timeout in milliseconds for the dispatch lifecycle lock before it is forcibly released (dispatch/lifecycle-lock.ts).",
  },

  // ── memory digest (cli) ─────────────────────────────────────────────
  PENUMBRA_MEMORY_DIGEST_MAX_LINES: {
    schema: PosInt,
    default: 200,
    description:
      "Max memory rows the `penumbra memory digest` command emits (cli/commands/memory.ts).",
  },
  PENUMBRA_MEMORY_DIGEST_MAX_BYTES: {
    schema: PosInt,
    default: 24_000,
    description:
      "Max bytes written to the auto-loaded memory digest MEMORY.md (plugin/workflows/memory-digest/workflow.ts).",
  },
  PENUMBRA_MEMORY_DIGEST_STATUS_ROWS: {
    schema: NonNegInt,
    default: 20,
    description: "Number of status rows in the memory digest (cli/commands/memory.ts).",
  },
  PENUMBRA_MEMORY_DIGEST_PATTERN_ROWS: {
    schema: NonNegInt,
    default: 180,
    description: "Number of pattern rows in the memory digest (cli/commands/memory.ts).",
  },

  // ── adversarial review ──────────────────────────────────────────────
  PENUMBRA_REVIEW_MEMORY_CONTEXT: {
    schema: Bool,
    default: false,
    description:
      "Inject prior review findings recalled from memory into the adversarial-review dispatch message.",
  },

  // ── agent routing cutovers ──────────────────────────────────────────
  PENUMBRA_GATE_OUTCOME_CUTOVER_ISO: {
    schema: OptStr,
    description:
      "ISO timestamp overriding the gate-outcome cutover used by the legacy NULL-verdict predicate (core/services/agent-routing.ts). Invalid values fall back to the built-in default.",
  },
  PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO: {
    schema: OptStr,
    description:
      "ISO timestamp overriding the classifier-decline exemption cutover (core/services/agent-routing.ts). Invalid values fall back to the built-in default.",
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

  // ── core test fixtures ────────────────────────────────────────────
  PENUMBRA_TEST_LLM_KEY: {
    schema: OptStr,
    description:
      "Fixture-only apiKeyEnv target used by core/test/services/role-llm-candidates.test.ts to verify late-bound env auth resolution. Not read outside tests.",
    isSensitive: true,
  },
  PENUMBRA_TEST_LLM_SNAKE_KEY: {
    schema: OptStr,
    description:
      "Fixture-only api_key_env target used by core/test/services/role-llm-candidates.test.ts to verify late-bound snake_case env auth resolution. Not read outside tests.",
    isSensitive: true,
  },
  PENUMBRA_ACP_DISCOVERY_KEEP: {
    schema: OptStr,
    description:
      "Fixture-only env key used by ACP discovery tests to verify non-scrubbed process env values reach the child process.",
  },
  PENUMBRA_ACP_DISCOVERY_UNSET: {
    schema: OptStr,
    description:
      "Fixture-only env key used by ACP discovery tests to verify requested unset_env entries are removed from the child process.",
  },
  PENUMBRA_CC_MEMORY_DIR: {
    schema: OptStr,
    description: "Directory override for Claude Code memory-digest test and workflow output.",
  },
} as const;

const shape: Record<string, z.ZodType> = {};
for (const [key, entry] of Object.entries(ENV_REGISTRY)) {
  const base =
    entry.default !== undefined ? entry.schema.default(entry.default) : entry.schema.optional();
  // Bool is an enum that does not include ""; without this wrapper, KEY=''
  // crashes the parse with a confusing "expected one of ..." error instead
  // of honoring the documented empty-string opt-out (load.ts).
  shape[key] = entry.schema === Bool ? z.preprocess(emptyToUndefined, base) : base;
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
  return EnvSchema.parse(subset);
}

export function isMcpInvocationLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnv(env).PENUMBRA_MCP_INVOCATION_LOG_ENABLED === true;
}

/**
 * Central MCP response budget in estimated tokens, or null when unset.
 * Invalid non-numeric, zero, or negative values fail fast through the env
 * registry instead of silently disabling or changing the budget.
 * Parse this ONCE (in buildServer) and pass it explicitly to instrumentHandler;
 * instrumentation must never read the env itself.
 */
export function getMcpResponseBudgetTokens(env: NodeJS.ProcessEnv = process.env): number | null {
  return (parseEnv(env).PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS as number | undefined) ?? null;
}

export function getSessionExtractMaxCharsPerChunk(env: NodeJS.ProcessEnv = process.env): number {
  return parseEnv(env).PENUMBRA_SESSION_EXTRACT_MAX_CHARS_PER_CHUNK as number;
}

export function getSessionExtractMaxChunks(env: NodeJS.ProcessEnv = process.env): number {
  return parseEnv(env).PENUMBRA_SESSION_EXTRACT_MAX_CHUNKS as number;
}
