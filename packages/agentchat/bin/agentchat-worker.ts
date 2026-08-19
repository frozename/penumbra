#!/usr/bin/env bun
import type { AgentOptions, AgentPool } from "@penumbra/config";

import { defaultProjectRegistryPath, loadProjectRegistry, SettingsDefaults } from "@penumbra/core";
import { fetchServedModels } from "../../core/src/index.js";
import {
  createLogger,
  type DispatchEventInput,
  type HandoffRow,
  systemUuid,
  waitForDaemonStorageRoot,
} from "@penumbra/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "../src/adapters/acp-types.js";
import type { AgentChatConfig } from "../src/config/types.js";
import type { Adapter, DispatchEvent, DispatchInput, DispatchOutput } from "../src/sdk/adapter.js";
import type { UsageReader } from "../src/usage-readers/index.js";
import type { CapturePort } from "../src/worker/capture-port.js";

import { meaningfulOutput } from "../../core/src/services/agent-performance-capture.js";
import {
  acpWarmPoolLiveEntryCount,
  drainAgent,
  shutdownAllAcpWarmPools,
  totalAcpWarmPoolEntryCount,
} from "../src/adapters/acp-warm-pool-registry.js";
import { poolKeyFor } from "../src/adapters/acp-warm-pool.js";
import {
  type CapacityError,
  spawnCliAdapter,
  spawnCliAdapterStream,
  type SpawnOpts,
} from "../src/adapters/cli-spawn.js";
import { prepareOpencodeMcpConfigDir } from "../src/adapters/opencode-mcp-config.js";
import { buildAdapter, createStdioAcpAdapter, registerAdapter } from "../src/adapters/registry.js";
import { resolveAdapterApiKey } from "../src/adapters/secret.js";
import { normalizeAdapterOptions } from "../src/cli/adapter-options.js";
import { dispatchHandoff } from "../src/cli/dispatch-handoff.js";
import { loadConfigPathOrDir } from "../src/config/load.js";
import { invalidateChangedWarmPools } from "../src/worker/warm-pool-reload.js";
import { PenumbraClient } from "../src/penumbra-client.js";
import { ClaudeJsonlReader } from "../src/usage-readers/claude-jsonl-reader.js";
import { ClaudeStatusLineBridge } from "../src/usage-readers/claude-statusline-bridge.js";
import { CodexRolloutReader } from "../src/usage-readers/codex-rollout-reader.js";
import { GoogleOtlpSynth } from "../src/usage-readers/google-otlp-synth.js";
import { loadOpencodeConsoleConfig } from "../src/usage-readers/opencode-console-config.js";
import { OpenCodeConsoleReader } from "../src/usage-readers/opencode-console-reader.js";
import { OpenCodeDbReader } from "../src/usage-readers/opencode-db-reader.js";
import {
  acquireOrRefreshUsagePollLock,
  readUsagePollLock,
} from "../src/usage-readers/poll-lock.js";
import { resolveUsageCursorPath, startUsagePoller } from "../src/usage-readers/poller.js";
import { SakanaUsageSynth } from "../src/usage-readers/sakana-usage-synth.js";
import { runWorkerBoot } from "../src/worker-boot.js";
import { resolveWorkerId } from "../src/worker-id.js";
import { autocommitOnChainEnd } from "../src/worker/autocommit-on-chain-end.js";
import {
  computeClaimGraceMs,
  DEFAULT_CLAIM_AFFINITY_GRACE_MS,
} from "../src/worker/claim-affinity.js";
import { runWorkerControlListener } from "../src/worker/control-listener.js";
import { installGlobalCrashHandlers } from "../src/worker/crash-guard.js";
import { type DiscordNotificationEvent, renderDiscordEvent } from "../src/worker/discord-events.js";
import { postToDiscord } from "../src/worker/discord-notifier.js";
import { createDiscordRateLimiter } from "../src/worker/discord-rate-limit.js";
import { createWorkerDispatcher } from "../src/worker/dispatcher.js";
import { DispatchEventQueue } from "../src/worker/event-queue.js";
import { startEventSource } from "../src/worker/event-source.js";
import { registerExecutor, unregisterExecutor } from "../src/worker/executor-registry.js";
import { emitHeartbeat } from "../src/worker/heartbeat-emit.js";
import { startHeartbeatLoop } from "../src/worker/heartbeat-loop.js";
import { workerInjectRoute } from "../src/worker/inject-route.js";
import { createMergeReconciler, type MergeResult } from "../src/worker/merge-reconciler.js";
import { loadNotificationConfig } from "../src/worker/notification-config.js";
import { resolveNotificationRoute } from "../src/worker/notification-router.js";
import { createNotificationScheduler } from "../src/worker/notification-scheduler.js";
import {
  applyOrchestrateToolsToConfig,
  withOrchestrateTools,
} from "../src/worker/orchestrate-tools.js";
import { createPermissionCallback } from "../src/worker/permission-callback.js";
import { PermissionDaemonClient } from "../src/worker/permission-daemon-client.js";
import {
  createPermissionEventSource,
  type PermissionEventSource,
  type PermissionSseCreds,
} from "../src/worker/permission-event-source.js";
import { createPrewarmLoop, type PrewarmLoop } from "../src/worker/prewarm-loop.js";
import { computePrewarmTargets, type PrewarmTarget } from "../src/worker/prewarm-targets.js";
import { resolveDispatchCwd } from "../src/worker/project-cwd.js";
import { RecallEnricher } from "../src/worker/recall-enricher.js";
import { resolveSandboxConfig } from "../src/worker/sandbox-config.js";
import { createWorkerShutdown } from "../src/worker/shutdown.js";
import {
  buildRetryPayloadOrNull,
  resolveAgentProvider,
  type RoutingBiasLike,
  selectRetryAgent,
  shouldRetryHandoffForSilentFailure,
  SILENT_RETRY_PREFIX,
} from "../src/worker/silent-failure-retry.js";
import { runThoughtAnalyzer, type ThoughtAnalyzerDeps } from "../src/worker/thought-analyzer.js";
import { ThoughtCapture } from "../src/worker/thought-capture.js";
import { loadThoughtsConfig } from "../src/worker/thought-config.js";
import {
  applyWorktreeOverride,
  rewriteWorktreeHandoffMessage,
} from "../src/worker/worktree-integration.js";
import { createWorkerWorktreeManager } from "../src/worker/worktree-manager.js";
import { buildWorktreeReadyEvent } from "../src/worker/worktree-ready-event.js";
import { WriteToolsExecutor } from "../src/worker/write-tools-executor.js";

function flag(name: string, fallback?: string): string | undefined {
  const long = `--${name}`;
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === long) {
      return process.argv[i + 1] ?? fallback;
    }
    if (arg?.startsWith(`${long}=`)) {
      return arg.slice(long.length + 1);
    }
  }
  return fallback;
}

interface CliSpawnAdapterOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  pass_via?: "stdin" | "argv";
  env?: Record<string, string>;
  unset_env?: string[];
  strip_patterns?: string[];
  capturePort?: CapturePort;
  emit_stdout_thoughts?: boolean;
}

interface OpencodeCliAdapterOptions extends CliSpawnAdapterOptions {
  model?: string;
  mcpServers?: McpServer[];
}

function cleanGeminiCliOutput(text: string): string {
  return text
    .replaceAll("MCP issues detected. Run /mcp list for status.", "")
    .split("\n")
    .filter(
      (line) =>
        !/^Export retry time \d+ms exceeds remaining timeout \d+ms, not retrying further\.$/.test(
          line,
        ),
    )
    .join("\n");
}

function emitCapacityError(capturePort: CapturePort | undefined, err: CapacityError): void {
  capturePort?.emit({
    kind: "capacity_error",
    provider: err.provider,
    model: err.model,
    raw: err.raw,
  });
}

type CliKind = "claude-cli" | "gemini-cli" | "agy-cli" | "codex-cli";

function buildCliSpawnOpts(
  kind: CliKind,
  opts: CliSpawnAdapterOptions,
  defaultArgs: string[],
  command: string,
  thoughtCapture: ThoughtCapture | null,
  input: DispatchInput,
): SpawnOpts {
  void kind;
  return {
    command,
    args: opts.args ?? defaultArgs,
    prompt: input.prompt,
    signal: input.signal,
    cwd: opts.cwd,
    pass_via: opts.pass_via,
    env: opts.env,
    unset_env: opts.unset_env,
    strip_patterns: opts.strip_patterns,
    emit_stdout_thoughts: opts.emit_stdout_thoughts,
    thoughtCapture: thoughtCapture ?? undefined,
    onCapacityError: (err): void => {
      emitCapacityError(opts.capturePort, err);
    },
    eventContext: input.eventContext as SpawnOpts["eventContext"],
    onEvent: input.onEvent,
  };
}

function makeCliSpawnAdapter(
  kind: CliKind,
  opts: CliSpawnAdapterOptions,
  defaultArgs: string[],
  transformText: (text: string) => string,
  thoughtCapture: ThoughtCapture | null,
): Adapter {
  const command = opts.command;
  if (!command) {
    throw new Error(`${kind}: command is required`);
  }
  const spawnOptsFor = (input: DispatchInput): SpawnOpts =>
    buildCliSpawnOpts(kind, opts, defaultArgs, command, thoughtCapture, input);
  return {
    kind,
    async dispatch(input: DispatchInput): Promise<DispatchOutput> {
      const { text } = await spawnCliAdapter(spawnOptsFor(input));
      return { text: transformText(text) };
    },
    async *dispatchStream(input: DispatchInput): AsyncGenerator<DispatchEvent> {
      for await (const event of spawnCliAdapterStream(spawnOptsFor(input))) {
        if (event.type === "done") {
          yield {
            ...event,
            result: {
              ...event.result,
              text: transformText(event.result.text),
            },
          };
          continue;
        }
        yield event;
      }
    },
  };
}

async function buildOpencodeCliSpawnOpts(
  opts: OpencodeCliAdapterOptions,
  command: string,
  baseArgs: string[],
  thoughtCapture: ThoughtCapture | null,
  input: DispatchInput,
): Promise<SpawnOpts & { cleanup?: () => Promise<void> }> {
  let apiKey = "";
  try {
    apiKey = resolveAdapterApiKey({ apiKeyKeychain: "llamactl/opencode" });
  } catch {
    // Graceful degradation: let the CLI handle missing credentials.
  }

  const env: Record<string, string> = { ...opts.env, OPENCODE_API_KEY: apiKey };
  let cleanup: (() => Promise<void>) | undefined;
  if (opts.mcpServers && opts.mcpServers.length > 0) {
    const prepared = await prepareOpencodeMcpConfigDir(opts.mcpServers);
    env.XDG_CONFIG_HOME = prepared.xdgConfigHome;
    cleanup = prepared.cleanup;
  }

  return {
    command,
    args: baseArgs,
    prompt: input.prompt,
    signal: input.signal,
    cwd: opts.cwd,
    pass_via: opts.pass_via ?? "argv",
    env,
    unset_env: opts.unset_env,
    strip_patterns: opts.strip_patterns,
    emit_stdout_thoughts: opts.emit_stdout_thoughts,
    thoughtCapture: thoughtCapture ?? undefined,
    onCapacityError: (err): void => {
      emitCapacityError(opts.capturePort, err);
    },
    eventContext: input.eventContext as SpawnOpts["eventContext"],
    onEvent: input.onEvent,
    cleanup,
  };
}

function makeOpencodeCliAdapter(
  rawOptions: unknown,
  thoughtCapture: ThoughtCapture | null,
): Adapter {
  const opts = rawOptions as OpencodeCliAdapterOptions;
  if (!opts.model) {
    throw new Error("opencode-cli: model is required");
  }

  const model = opts.model.includes("/") ? opts.model : `opencode/${opts.model}`;
  const command = opts.command ?? "~/.opencode/bin/opencode".replace(/^~/, process.env.HOME ?? "");
  const baseArgs = opts.args ?? ["run", "--model", model];

  const spawnOptsFor = (
    input: DispatchInput,
  ): Promise<SpawnOpts & { cleanup?: () => Promise<void> }> =>
    buildOpencodeCliSpawnOpts(opts, command, baseArgs, thoughtCapture, input);

  return {
    kind: "opencode-cli",
    async dispatch(input: DispatchInput): Promise<DispatchOutput> {
      const spawnOpts = await spawnOptsFor(input);
      try {
        const { text, stderr } = await spawnCliAdapter(spawnOpts);
        if (!text.trim()) {
          const markers = [
            "ProviderModelNotFoundError",
            "Error: Model not found",
            "AuthenticationError",
            "Error: API key",
          ];
          const matched = markers.find((marker) => stderr.includes(marker));
          if (matched || stderr.trim()) {
            const msg = stderr.trim().slice(0, 500);
            throw new Error(`opencode-cli error: ${msg || "empty output"}`);
          }
        }
        return { text };
      } finally {
        await spawnOpts.cleanup?.();
      }
    },
    async *dispatchStream(input: DispatchInput): AsyncGenerator<DispatchEvent> {
      const spawnOpts = await spawnOptsFor(input);
      try {
        yield* spawnCliAdapterStream(spawnOpts);
      } finally {
        await spawnOpts.cleanup?.();
      }
    },
  };
}

function registerThoughtAwareAdapters(thoughtCapture: ThoughtCapture | null): void {
  const registerCli = (
    kind: CliKind,
    defaultArgs: string[],
    transformText: (text: string) => string = (text) => text,
  ): void => {
    registerAdapter(
      kind,
      (rawOptions): Adapter =>
        makeCliSpawnAdapter(kind, rawOptions, defaultArgs, transformText, thoughtCapture),
    );
  };

  registerCli("claude-cli", ["code", "--no-tty"]);
  registerCli("gemini-cli", [], cleanGeminiCliOutput);
  registerCli("agy-cli", [], (text) => text);
  registerCli("codex-cli", []);

  registerAdapter(
    "opencode-cli",
    (rawOptions): Adapter => makeOpencodeCliAdapter(rawOptions, thoughtCapture),
  );

  // HIGH-1: route the worker's thought-aware stdio-acp registration through the
  // SAME factory as the registry builtin. The previous hand-rolled construction
  // here omitted the warm-pool opts + pool injection, so `warm_pool: true` was a
  // silent no-op in the real worker. The factory wires warm pool AND
  // thoughtCapture together; do not reintroduce a parallel opts map.
  registerAdapter("stdio-acp", (rawOptions) =>
    createStdioAcpAdapter(rawOptions, { thoughtCapture: thoughtCapture ?? undefined }),
  );
}

// Single source of truth: default to the split config DIR the daemon already
// reads (~/.config/penumbra/{agents,routing,quotas}.yaml). AGENTCHAT_CONFIG may
// still point at a single legacy agentchat.yaml file (loadConfigPathOrDir
// dispatches on file-vs-dir), so overrides/tests keep working.
const configPath = process.env.AGENTCHAT_CONFIG ?? join(homedir(), ".config/penumbra");
const explicitRoot = flag("storage-root", process.env.PENUMBRA_STORAGE_ROOT);
const bootstrapLog = createLogger({ component: "agentchat-worker" });
let storageRoot: string;
try {
  // Poll for the daemon up to 60s instead of failing fast. The launchd setup
  // starts daemon and worker in parallel at login; without this wait the
  // worker would race the daemon's port-file write, exit 1, and only recover
  // after launchd's ThrottleInterval. This keeps the worker up cleanly.
  storageRoot = await waitForDaemonStorageRoot({
    explicit: explicitRoot,
    onWaiting: (candidates) => {
      bootstrapLog.info(
        { candidates },
        "penumbra daemon not found yet; waiting (up to 60s) for it to come up",
      );
    },
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const concurrency = Number(flag("concurrency", "8"));
const pollIntervalMs = Number(flag("poll-interval", "1000"));
const defaultMaxHops = Number(flag("max-hops", "8"));
const defaultTrust = flag("trust", "all") as "all" | "config";
const transcriptBudget = Number(flag("transcript-budget", "8192"));

const log = createLogger({ component: "agentchat-worker" });
installGlobalCrashHandlers({
  log,
  flush: () => {
    log.flush();
  },
});
const workerId = resolveWorkerId({
  flag: flag("worker-id"),
  envValue: process.env.PENUMBRA_WORKER_ID,
  log,
});
const workerToken = process.env.PENUMBRA_TOKEN ?? "";
const workerProjectId = (process.env.PENUMBRA_WORKER_PROJECT_ID ?? "").trim() || undefined;
const workerIsolation = ((): "hard" | "sticky" | "shared" => {
  const raw = (process.env.PENUMBRA_WORKER_ISOLATION ?? "").trim().toLowerCase();
  if (raw === "hard" || raw === "sticky" || raw === "shared") {
    return raw;
  }
  if (raw !== "") {
    log.warn(
      { worker_id: workerId, isolation: raw },
      "unknown PENUMBRA_WORKER_ISOLATION, defaulting to shared",
    );
  }
  return "shared";
})();

const client = new PenumbraClient({ storageRoot, logger: log });
await runWorkerBoot({ client, log, workerId });
const recallEnricher = new RecallEnricher({ client, log });
const eventQueue = new DispatchEventQueue({
  send: (events, signal): Promise<void> => client.postDispatchEvents(events, signal),
});
let config = loadConfigPathOrDir(configPath);
const settings = SettingsDefaults.build({ env: process.env, input: {} });
const projectRegistry = loadProjectRegistry(
  process.env.PENUMBRA_PROJECTS_YAML ?? defaultProjectRegistryPath(),
);
const notificationConfig = loadNotificationConfig({ agentchat: config, env: process.env });
const thoughtsConfig = loadThoughtsConfig({ agentchat: config });
const thoughtCapture = thoughtsConfig.enabled
  ? new ThoughtCapture({
      config: thoughtsConfig,
      enqueue: (event): void => {
        eventQueue.enqueue(event);
      },
      workerId,
    })
  : null;
registerThoughtAwareAdapters(thoughtCapture);
const discordRateLimiter = createDiscordRateLimiter({
  now: () => Date.now(),
  windowMs: 30_000,
});
const onEvent = (event: DispatchEventInput): void => {
  if (event.kind === "dispatch.start") {
    return;
  }
  eventQueue.enqueue(event);
};

function mapChainEndStatus(reason: string): "completed" | "failed" | "rejected" | "expired" {
  if (reason === "completed") return "completed";
  if (reason === "cancelled") return "rejected";
  if (reason === "max_hops") return "expired";
  return "failed";
}

function latencySecondsFrom(ts: string): number {
  const started = Date.parse(ts);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 1000));
}

function resolveAgentEventMetadata(agentName: string | undefined): {
  provider?: string;
  model?: string;
} {
  if (!agentName) return {};

  const agentCfg = config.agents.find((agent) => agent.name === agentName);
  const options = (agentCfg?.options ?? {}) as Record<string, unknown>;

  return {
    ...(typeof options.provider === "string" ? { provider: options.provider } : {}),
    ...(typeof options.model === "string" ? { model: options.model } : {}),
  };
}

function applyAgentCwdOverride(
  config: AgentChatConfig,
  agentName: string,
  cwd: string,
): AgentChatConfig {
  return {
    ...config,
    agents: config.agents.map((agent) => {
      if (agent.name !== agentName) return agent;
      return {
        ...agent,
        options: {
          ...(agent.options ?? {}),
          cwd,
        },
      };
    }),
  };
}

function coalesceKeyForDiscordEvent(event: DiscordNotificationEvent): string | undefined {
  if (event.kind === "claim_retry") {
    return `claim_retry:${event.handoff_id ?? ""}`;
  }
  if (event.kind === "permission_decided") {
    return `permission_decided:${event.permission_id}`;
  }
  if (event.kind === "cost_quota_summary") {
    return `cost_quota_summary:${event.period ?? "default"}`;
  }
  return undefined;
}

type DiscordRoute = ReturnType<typeof resolveNotificationRoute>;

function isRateLimitSuppressed(
  event: DiscordNotificationEvent,
  route: NonNullable<DiscordRoute>,
): boolean {
  const coalesceKey = coalesceKeyForDiscordEvent(event);
  return (
    !!coalesceKey && !discordRateLimiter.shouldSend({ webhookKey: route.routeKey, coalesceKey })
  );
}

function discordEventLogContext(
  event: DiscordNotificationEvent,
  route: NonNullable<DiscordRoute>,
): Record<string, unknown> {
  return {
    kind: event.kind,
    handoff_id: event.handoff_id,
    conversation_id: event.conversation_id,
    project_id: event.project_id,
    agent: event.agent,
    route_key: route.routeKey,
    channel: route.channelName,
  };
}

async function postDiscordEvent(event: DiscordNotificationEvent): Promise<boolean> {
  if (!notificationConfig.enabled || !notificationConfig.events[event.kind]) {
    return true;
  }

  const route = resolveNotificationRoute({
    config: notificationConfig,
    env: process.env,
    projectId: event.project_id,
    agentKey: event.agent,
  });
  if (!route) {
    return true;
  }

  try {
    if (isRateLimitSuppressed(event, route)) {
      log.debug(
        discordEventLogContext(event, route),
        "discord notification suppressed by rate limiter",
      );
      return true;
    }
    const payload = renderDiscordEvent(event, { promptPolicy: route.promptPolicy });
    const ok = await postToDiscord(route.webhookUrl, payload, fetch, undefined, route.identity);
    if (!ok) {
      log.warn(discordEventLogContext(event, route), "discord notification delivery failed");
    }
    return ok;
  } catch (err) {
    log.warn(
      {
        kind: event.kind,
        handoff_id: event.handoff_id,
        conversation_id: event.conversation_id,
        project_id: event.project_id,
        agent: event.agent,
        err: err instanceof Error ? err.message : String(err),
      },
      "discord notification delivery failed",
    );
    return false;
  }
}

async function maybePostDiscordChainEnd(handoff: HandoffRow, reason: string): Promise<void> {
  if (!notificationConfig.enabled || !notificationConfig.events.dispatch_end) return;

  let resolvedHandoff = handoff;
  try {
    const res = await client.getHandoff(handoff.handoff_id);
    const fetched = res.handoff as HandoffRow | null;
    resolvedHandoff = fetched ?? handoff;
  } catch {
    resolvedHandoff = handoff;
  }

  const ok = await postDiscordEvent({
    kind: "dispatch_end",
    handoff_id: resolvedHandoff.handoff_id,
    conversation_id: resolvedHandoff.conversation_id,
    project_id: resolvedHandoff.project_id ?? undefined,
    agent: resolvedHandoff.to_agent,
    worker_id: resolvedHandoff.worker_id ?? workerId,
    status: mapChainEndStatus(reason),
    latency_seconds: latencySecondsFrom(resolvedHandoff.ts),
    error_summary:
      reason === "error" ? (resolvedHandoff.error_message ?? "dispatch error") : undefined,
    prompt: resolvedHandoff.message,
    ...resolveAgentEventMetadata(resolvedHandoff.to_agent),
  });
  if (!ok) {
    log.warn(
      { handoff_id: resolvedHandoff.handoff_id, reason },
      "discord chain-end notification failed",
    );
  }
}

const MERGE_STATUS_MAP = {
  verified: "verified",
  pr_opened: "pr_opened",
  pr_creation_failed: "pr_creation_failed",
  typecheck_failed: "typecheck_failed",
} as const;

function mergeResultDiscordStatus(
  status: MergeResult["status"],
): "verified" | "pr_opened" | "pr_creation_failed" | "typecheck_failed" | "test_failed" {
  return (
    (
      MERGE_STATUS_MAP as Record<
        string,
        "verified" | "pr_opened" | "pr_creation_failed" | "typecheck_failed"
      >
    )[status] ?? "test_failed"
  );
}

async function maybePostDiscordMergeResult(handoffId: string, result: MergeResult): Promise<void> {
  if (!notificationConfig.enabled || !notificationConfig.events.merge_result) {
    return;
  }
  if (result.status === "no_changes") {
    return;
  }

  let handoff: HandoffRow | null = null;
  try {
    const res = await client.getHandoff(handoffId);
    handoff = res.handoff;
  } catch {
    handoff = null;
  }

  const ok = await postDiscordEvent({
    kind: "merge_result",
    handoff_id: handoffId,
    conversation_id: handoff?.conversation_id ?? "<unknown>",
    project_id: handoff?.project_id ?? undefined,
    agent: handoff?.to_agent ?? "<unknown>",
    worker_id: handoff?.worker_id ?? workerId,
    status: mergeResultDiscordStatus(result.status),
    regression_summary: result.regression_summary,
    prompt: handoff?.message,
    pr_url: result.pr_url,
    ...resolveAgentEventMetadata(handoff?.to_agent),
  });
  if (!ok) {
    log.warn(
      { handoff_id: handoffId, status: result.status },
      "discord merge-result notification failed",
    );
  }
}

async function maybePostDiscordPermissionEvent(event: DiscordNotificationEvent): Promise<void> {
  if (!notificationConfig.enabled) return;
  if (!notificationConfig.events[event.kind]) return;

  let handoff: HandoffRow | null = null;
  if (event.handoff_id) {
    try {
      const res = await client.getHandoff(event.handoff_id);
      handoff = res.handoff;
    } catch {
      handoff = null;
    }
  }

  await postDiscordEvent({
    ...event,
    handoff_id: event.handoff_id ?? handoff?.handoff_id,
    conversation_id: event.conversation_id ?? handoff?.conversation_id,
    project_id: handoff?.project_id ?? event.project_id,
    agent: event.agent ?? handoff?.to_agent,
  });
}

async function maybeCaptureDispatchOutcome(
  handoff: HandoffRow,
  reason: string,
  worktreeChanged: boolean | null,
  wallMs: number | null,
  frameworkOverheadMs: number | null,
  finalResponseText: string | null,
): Promise<void> {
  const captureReason =
    reason === "completed" || reason === "max_hops" || reason === "cancelled" || reason === "error"
      ? reason
      : "error";
  let perf: {
    outcome: string;
    notes: string | null;
    metadata_json: string;
    task_type: string;
    reliability_status?: string | null;
  } | null = null;
  try {
    const finalResponseSummary = meaningfulOutput(finalResponseText);
    const response = await client.captureAgentPerformanceFromDispatch({
      handoff_id: handoff.handoff_id,
      task_type: handoff.chain_task_type ?? undefined,
      reason: captureReason,
      // Pass the worktree snapshot directly so the daemon-side capture
      // doesn't have to read dispatch_events (which races the events POST
      // and can return stale "no row yet" misses).
      worktree_changed: worktreeChanged,
      wall_ms: wallMs,
      framework_overhead_ms: frameworkOverheadMs,
      final_response_chars: finalResponseSummary.chars,
      has_meaningful_output: finalResponseSummary.meaningful,
    });
    perf = response.performance;
  } catch (err) {
    log.warn(
      { handoff_id: handoff.handoff_id, err: String(err) },
      "agent performance dispatch capture failed",
    );
    return;
  }

  // Auto-retry triggers on three reliability classes:
  //   1. outcome=failed + notes contain `silent_failure` (use_worktree task
  //      reported success but produced no worktree changes — original case).
  //   2. reliability_status=`no_worktree_activity` (classifier flagged the
  //      same empty-worktree pattern even when outcome wasn't downgraded).
  //   3. reliability_status=`non_terminal_stale` with `recommended_action=cancel`
  //      in notes (haiku/gemini stall pattern: handoff goes 5m+ without
  //      dispatch.end terminal event).
  // Bounded to a single retry per chain via SILENT_RETRY_PREFIX in the
  // recovery handoff message; further captures on retry handoffs are skipped.
  if (shouldRetryHandoffForSilentFailure(handoff, perf)) {
    if (handoff.message.startsWith(SILENT_RETRY_PREFIX)) {
      log.warn(
        {
          handoff_id: handoff.handoff_id,
          agent: handoff.to_agent,
          reliability_status: perf.reliability_status ?? null,
        },
        "silent-failure retry produced another silent failure — not retrying again",
      );
      return;
    }
    await tryAutoRetrySilentFailure(handoff, perf.task_type);
  }
}

async function tryAutoRetrySilentFailure(
  failedHandoff: HandoffRow,
  taskType: string,
): Promise<void> {
  let nextAgent: string | null = null;
  try {
    const ranked = await client.agentRank({
      task_type: taskType,
      min_samples: 1,
      include_neutral: false,
    });
    // Constrain the alternate to a real, dispatchable, non-steered agent:
    //  - validAgents drops display-label rows (e.g. "maestro (...)") that 400 at
    //    chain start;
    //  - activeBiases honors operator usage-steering excludes so the retry does
    //    not bypass a steer the first-pass route obeyed.
    // Both degrade open: an empty registry/bias set just relaxes the guard.
    const validAgents = new Set(config.agents.map((a) => a.name));
    const agentProviders = new Map(
      config.agents.map((a) => [a.name, resolveAgentProvider(a)] as const),
    );
    let activeBiases: RoutingBiasLike[] = [];
    try {
      activeBiases = await client.listRoutingBiases();
    } catch (err) {
      log.warn(
        { handoff_id: failedHandoff.handoff_id, err: String(err) },
        "silent-failure retry: routing-bias fetch failed; selecting unbiased",
      );
    }
    nextAgent = selectRetryAgent({
      candidates: ranked.candidates,
      failedAgent: failedHandoff.to_agent,
      validAgents,
      agentProviders,
      activeBiases,
    });
  } catch (err) {
    log.warn(
      { handoff_id: failedHandoff.handoff_id, err: String(err) },
      "silent-failure retry: agent_rank lookup failed; not retrying",
    );
    return;
  }
  if (!nextAgent) {
    log.warn(
      { handoff_id: failedHandoff.handoff_id, failed_agent: failedHandoff.to_agent },
      "silent-failure retry: no eligible alternate agent found in agent_rank",
    );
    return;
  }

  try {
    const retryPayload = buildRetryPayloadOrNull({
      failed_handoff_id: failedHandoff.handoff_id,
      failed_to_agent: failedHandoff.to_agent,
      conversation_id: failedHandoff.conversation_id,
      project_id: failedHandoff.project_id,
      task_type: failedHandoff.chain_task_type ?? undefined,
      message: failedHandoff.message,
      next_agent: nextAgent,
    });
    if (retryPayload === null) {
      console.error(
        `silent-failure-retry: original handoff ${failedHandoff.handoff_id} has no project_id, ` +
          "refusing to retry (would land in daemon cwd)",
      );
      return;
    }
    const result = await client.startChain(retryPayload);
    log.info(
      {
        original_handoff_id: failedHandoff.handoff_id,
        original_agent: failedHandoff.to_agent,
        retry_handoff_id: result.handoff_id,
        retry_agent: nextAgent,
      },
      "silent-failure detected; auto-retried on alternate agent",
    );
  } catch (err) {
    log.warn(
      {
        handoff_id: failedHandoff.handoff_id,
        next_agent: nextAgent,
        err: String(err),
      },
      "silent-failure retry: startChain failed",
    );
  }
}

function loadProjectContext(project_id: string | null): string | undefined {
  if (!project_id) return undefined;
  const path = join(storageRoot, "context", project_id, "latest.md");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

async function loadConversationTranscript(
  conversation_id: string,
): Promise<{ handoff_id: string; agent: string; text: string }[]> {
  // Phase 1: rebuild a transcript by listing handoffs in the conversation. Each handoff row
  // carries the sender (from_agent) and message (the sender's reply text). We retain handoff_id
  // alongside each entry so the dispatcher can drop the current row by id rather than by content
  // — matching by {agent, text} would mis-fire when the same sender emits identical text twice.
  const { handoffs } = await client.listHandoffs({
    statuses: ["completed", "dispatched", "approved", "redirected"],
    conversation_id,
  });
  const sorted = [...handoffs].sort((a, b) => a.ts.localeCompare(b.ts));
  return sorted.map((h) => ({
    handoff_id: h.handoff_id,
    agent: h.from_agent === "user" ? "user" : h.from_agent,
    text: h.message,
  }));
}

// Forward declaration: the dispatcher's onClaimRetryable needs to call
// eventSource.forget(), but eventSource is created after dispatcher (circular).
// Use a mutable pointer that gets filled in below.
let eventSourceRef: { forget(id: string): void } | null = null;

const handoffBranchNameCache = new Map<string, string>();

function rememberHandoffBranchName(handoff: Pick<HandoffRow, "handoff_id" | "branch_name">): void {
  if (typeof handoff.branch_name === "string" && handoff.branch_name.length > 0) {
    handoffBranchNameCache.set(handoff.handoff_id, handoff.branch_name);
  }
}

const worktreeManager = createWorkerWorktreeManager({
  resolveBranchName: (handoffId) => handoffBranchNameCache.get(handoffId),
});

// ---------------------------------------------------------------------------
// Warm-pool pre-warm loop (warm_pool_multiworker integration, Phase 3+4).
// Eagerly pre-warms each opted-in (agent, repoRoot) at boot so warm reuse
// engages regardless of the daemon's first-poll-wins worker spread. Gated on
// the per-agent `warm_pool_prewarm` sub-flag (default off): when no agent opts
// in, no loop is created and boot behaviour is byte-identical to before.
// ---------------------------------------------------------------------------
const PREWARM_GLOBAL_CAP = Number(process.env.PENUMBRA_WARM_PREWARM_CAP ?? 4);
// Cross-project claim affinity: a worker not home for a warm-pooled handoff's
// project holds back this long so a home-repoRoot worker wins the first-poll
// claim and reuses its warm connection (0 disables; see worker/claim-affinity.ts).
const CLAIM_AFFINITY_GRACE_MS = Number(
  process.env.PENUMBRA_CLAIM_AFFINITY_GRACE_MS ?? DEFAULT_CLAIM_AFFINITY_GRACE_MS,
);
const PREWARM_DISPATCH_TIMEOUT_MS = 60_000;
const DEFAULT_WARM_POOL_MAX_AGE_MS = 30 * 60_000;

const prewarmResolveProjectRoot = (projectId?: string): string | undefined =>
  (
    worktreeManager as { projectRootFor?: (projectId?: string) => string | undefined }
  ).projectRootFor?.(projectId);

// `config` is reassigned on hot-reload; read it lazily so each pass + each
// prewarm sees the current config without recreating these closures.
const computePrewarmTargetsNow = (): PrewarmTarget[] =>
  computePrewarmTargets({
    agents: config.agents.map((a) => ({
      name: a.name,
      options: a.options as {
        warm_pool?: boolean;
        warm_pool_prewarm?: boolean;
        warm_pool_size?: number;
      } | null,
    })),
    isolation: workerIsolation,
    workerProjectId,
    resolveProjectRoot: prewarmResolveProjectRoot,
    mainRepoPath: process.cwd(),
    cap: PREWARM_GLOBAL_CAP,
  });

// Aborted on shutdown to kill any in-flight pre-warm spawn before the pools are
// torn down (prevents orphaned codex-acp children).
const prewarmAbort = new AbortController();

const prewarmOne = async (target: PrewarmTarget): Promise<void> => {
  const cfg = config.agents.find((a) => a.name === target.agent);
  if (!cfg) throw new Error(`prewarm: agent not in config: ${target.agent}`);
  // Handshake-only: hosted MCP servers + tool allowlist are applied at
  // session/new (per dispatch), never on the warm connection, so pass none.
  // repoRoot == cwd == target.repoRoot makes the deposited poolKey byte-equal
  // the poolScope a real worktree dispatch computes (repoRoot ?? cwd).
  const adapterOptions = normalizeAdapterOptions(cfg, [], []);
  const adapter = buildAdapter(cfg.adapter, {
    ...adapterOptions,
    agentName: cfg.name,
    cwd: target.repoRoot,
    repoRoot: target.repoRoot,
  }) as Adapter & {
    prewarm?: (signal?: AbortSignal) => Promise<{ deposited: boolean; poolKey: string }>;
  };
  if (typeof adapter.prewarm !== "function") return; // non-ACP adapter: nothing to pre-warm

  // Combine a per-call timeout with the worker-shutdown signal: aborting kills
  // the spawned child (startServer wires signal→kill), so a hung handshake can
  // never (a) wedge the loop's single-flight or (b) orphan a process at exit.
  const ac = new AbortController();
  const onShutdown = (): void => {
    ac.abort(new Error("prewarm aborted: worker shutdown"));
  };
  if (prewarmAbort.signal.aborted) {
    onShutdown();
  } else {
    prewarmAbort.signal.addEventListener("abort", onShutdown, { once: true });
  }
  const timer = setTimeout(() => {
    ac.abort(new Error(`prewarm timeout ${String(PREWARM_DISPATCH_TIMEOUT_MS)}ms`));
  }, PREWARM_DISPATCH_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  try {
    const result = await adapter.prewarm(ac.signal);
    if (!result.deposited) {
      log.warn({ agent: target.agent, repo_root: target.repoRoot }, "prewarm-not-deposited");
    }
  } finally {
    clearTimeout(timer);
    prewarmAbort.signal.removeEventListener("abort", onShutdown);
  }
};

let prewarmLoop: PrewarmLoop | null = null;
const refreshPrewarmLoop = (): void => {
  const eligible = computePrewarmTargetsNow();
  if (eligible.length === 0) {
    if (prewarmLoop) {
      prewarmLoop.stop();
      prewarmLoop = null;
      log.info({ worker_id: workerId }, "prewarm-loop-stopped");
    }
    return;
  }
  if (prewarmLoop) {
    void prewarmLoop.reload();
    return;
  }
  const eligibleMaxAges = config.agents
    .filter((a) => {
      const o = a.options as Record<string, unknown> | undefined;
      return o?.warm_pool === true && o.warm_pool_prewarm === true;
    })
    .map((a) =>
      Number(
        (a.options as Record<string, unknown> | undefined)?.warm_pool_max_age_ms ??
          DEFAULT_WARM_POOL_MAX_AGE_MS,
      ),
    );
  const refreshIntervalMs = eligibleMaxAges.length
    ? Math.max(60_000, Math.floor(Math.min(...eligibleMaxAges) / 2))
    : Math.floor(DEFAULT_WARM_POOL_MAX_AGE_MS / 2);
  prewarmLoop = createPrewarmLoop({
    computeTargets: computePrewarmTargetsNow,
    prewarmOne,
    countEntries: totalAcpWarmPoolEntryCount,
    // Pool registry key = agentName (cfg.name); entry key = (agentName, repoRoot).
    hasLiveEntry: (target) =>
      acpWarmPoolLiveEntryCount(
        target.agent,
        poolKeyFor({ agent: target.agent, cwd: target.repoRoot }),
      ) > target.slot,
    clock: {
      now: () => Date.now(),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => {
        clearInterval(h as ReturnType<typeof setInterval>);
      },
    },
    cap: PREWARM_GLOBAL_CAP,
    refreshIntervalMs,
    // Wake at most once a minute so a crashed pre-warm self-heals promptly,
    // while the expensive proactive replace only runs at refreshIntervalMs.
    tickIntervalMs: Math.min(60_000, refreshIntervalMs),
    log: (level, obj, msg) => {
      log[level](obj, msg);
    },
  });
  log.info(
    {
      worker_id: workerId,
      targets: eligible.length,
      refresh_interval_ms: refreshIntervalMs,
      cap: PREWARM_GLOBAL_CAP,
    },
    "prewarm-loop-started",
  );
  void prewarmLoop.start();
};
refreshPrewarmLoop();

// Probe port + token at boot so a missing daemon yields a clean error
// instead of an opaque ENOENT trace from the first SSE connect attempt.
try {
  readFileSync(join(storageRoot, "port"), "utf8");
  readFileSync(join(storageRoot, "token"), "utf8");
} catch {
  console.error(
    `penumbra not running at ${storageRoot} (missing port/token); start the daemon first`,
  );
  process.exit(1);
}

// Resolve daemon port + token FRESH on every (re)connect so a daemon
// token-rotation is picked up without restarting the worker. Mirrors
// PenumbraClient.subscribeSse's resolve()-per-connect pattern.
const resolvePermissionSseCreds = (): PermissionSseCreds => {
  const portStr = readFileSync(join(storageRoot, "port"), "utf8").trim();
  const token = readFileSync(join(storageRoot, "token"), "utf8").trim();
  return {
    baseUrl: `http://127.0.0.1:${String(Number(portStr))}`,
    token,
  };
};

const permissionDaemonClient = new PermissionDaemonClient({
  penumbraClient: client,
  makeEventSource: (): PermissionEventSource =>
    createPermissionEventSource("/permissions/events", resolvePermissionSseCreds),
  uuid: systemUuid,
  log,
  onPermissionEvent: (event): void => {
    void maybePostDiscordPermissionEvent(event);
  },
});
await permissionDaemonClient.start();

function agentNamesForPool(pool: AgentPool | null): string[] {
  if (pool === null) {
    return [];
  }
  if (typeof pool === "string") return [pool];
  if (Array.isArray(pool)) return pool;
  return pool.members.map((member) => member.agent);
}

function localHostnamesFromEnv(): Set<string> {
  return new Set(
    (process.env.PENUMBRA_LOCAL_NODE_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

const configuredLocalHostnames = localHostnamesFromEnv();

function isLocalModelHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (configuredLocalHostnames.has(host)) return true;
  if (host === "localhost" || host === "::1") return true;
  if (host === "127.0.0.1" || host.startsWith("127.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (host.endsWith(".local")) return true;
  return false;
}

function openAiCompatSeat(
  agentName: string,
): { baseUrl: string; model: string; options: Record<string, unknown> } | null {
  const seat = config.agents.find((agent) => agent.name === agentName);
  if (seat?.adapter !== "openai-compat-http") {
    return null;
  }
  const options = seat.options as Record<string, unknown>;
  const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : null;
  const model = typeof options.model === "string" ? options.model : null;
  if (!baseUrl || !model) return null;
  return { baseUrl, model, options };
}

function isLocalAnalyzerAgent(agentName: string): boolean {
  const seat = openAiCompatSeat(agentName);
  if (!seat) return false;
  try {
    return isLocalModelHost(new URL(seat.baseUrl).hostname);
  } catch {
    return false;
  }
}

const analyzerHealthCache = new Map<string, { checkedAtMs: number; healthy: boolean }>();
const ANALYZER_HEALTH_TTL_MS = 20_000;

async function probeLocalAnalyzerSeat(agentName: string): Promise<boolean> {
  const seat = openAiCompatSeat(agentName);
  if (!seat) return false;

  try {
    const servedModels = await fetchServedModels(seat.baseUrl, { timeoutMs: 5_000 });
    return servedModels.has(seat.model);
  } catch {
    return false;
  }
}

async function prepareThoughtAnalyzerHealth(pool: AgentPool | null): Promise<void> {
  const nowMs = Date.now();
  const localAgents = agentNamesForPool(pool).filter((agentName) =>
    isLocalAnalyzerAgent(agentName),
  );
  await Promise.all(
    localAgents.map(async (agentName) => {
      const cached = analyzerHealthCache.get(agentName);
      if (cached && nowMs - cached.checkedAtMs < ANALYZER_HEALTH_TTL_MS) return;
      analyzerHealthCache.set(agentName, {
        checkedAtMs: nowMs,
        healthy: await probeLocalAnalyzerSeat(agentName),
      });
    }),
  );
}

const thoughtAnalyzerDeps: ThoughtAnalyzerDeps = {
  chainStart: (input) => client.chainStart(input),
  chainWait: (input) => client.chainWait(input),
  chainResponse: (input) => client.chainResponse(input),
  recordEvent: (event) => {
    eventQueue.enqueue(event);
    return Promise.resolve();
  },
  log,
  workerId,
  getHandoff: async (id) => {
    try {
      const res = await client.getHandoff(id);
      return res.handoff;
    } catch {
      return null;
    }
  },
  agentPool: {
    get registry() {
      return config.agents.map((agent) => agent.name);
    },
    isLocal: (agentName) => isLocalAnalyzerAgent(agentName),
    isHealthy: (agentName) => {
      if (!isLocalAnalyzerAgent(agentName)) return true;
      const cached = analyzerHealthCache.get(agentName);
      return cached?.healthy === true && Date.now() - cached.checkedAtMs < ANALYZER_HEALTH_TTL_MS;
    },
    prepare: (pool) => prepareThoughtAnalyzerHealth(pool),
  },
};

const reconcileWorktree = createMergeReconciler({
  worktreeManager,
  postProgress: (id: string, payload: Record<string, unknown>): Promise<void> =>
    client.postProgress(id, payload),
  captureResult: (id, result) =>
    client.captureAgentPerformanceFromReconciler({ handoff_id: id, result: { ...result } }),
  reconcilerAutoRebase: config.reconcilerAutoRebase,
  settings,
  emitVerdict: (verdict) =>
    client
      .observe({
        ts: new Date().toISOString(),
        source: "agentchat",
        source_detail: "merge-reconciler",
        project_id: null,
        user_id: "local-user",
        machine_id: systemUuid(),
        session_id: verdict.conversation_id,
        event_type: "reconciler.verdict",
        lane: "local",
        provider: null,
        model: null,
        tokens_in: null,
        tokens_out: null,
        cost_usd: null,
        latency_ms: null,
        request_id: null,
        payload_json: verdict,
        payload_summary: verdict.summary,
      })
      .then(() => undefined),
  notifyResult: (id, result) => maybePostDiscordMergeResult(id, result),
  log,
  mainRepoDir: process.cwd(),
  thoughtsConfig,
  thoughtAnalyzerDeps,
  runThoughtAnalyzer,
  listThoughtEvents: async (handoffId) => {
    const { events } = await client.getDispatchEvents({ handoff_id: handoffId });
    return events
      .filter((event) => event.kind === "agent.thought")
      .map((event) => {
        const meta = event.meta ?? {};
        return {
          sequence_n: typeof meta.sequence_n === "number" ? meta.sequence_n : 0,
          adapter: typeof meta.adapter === "string" ? meta.adapter : "",
          agent_name: typeof meta.agent_name === "string" ? meta.agent_name : "",
          text: typeof meta.text === "string" ? meta.text : "",
          token_count: typeof meta.token_count === "number" ? meta.token_count : undefined,
        };
      })
      .sort((a, b) => a.sequence_n - b.sequence_n);
  },
  getParentHandoffId: async (handoffId) => {
    const res = await client.getHandoff(handoffId);
    return res.handoff.parent_handoff_id ?? null;
  },
  getHandoff: async (id) => {
    try {
      const res = await client.getHandoff(id);
      return res.handoff;
    } catch {
      return null;
    }
  },
});

function summarizeAuditPayload(eventType: string, payload: unknown): string {
  const typed = payload as Record<string, unknown> | null;
  if (!typed || typeof typed !== "object") {
    return eventType;
  }
  const path = typeof typed.path === "string" ? typed.path : null;
  const terminalId = typeof typed.terminal_id === "string" ? typed.terminal_id : null;
  const reason = typeof typed.reason === "string" ? typed.reason : null;
  const detail = path ?? terminalId ?? reason;
  return detail ? `${eventType}: ${detail}` : eventType;
}

function buildDispatchExecutor(
  handoff: HandoffRow,
  agentOptions: AgentOptions,
  worktreeRoot: string,
  requestPermission: ReturnType<typeof createPermissionCallback>,
): WriteToolsExecutor {
  const sandboxConfig = resolveSandboxConfig(agentOptions);
  return new WriteToolsExecutor({
    worktreeRoot,
    permissionCallback: requestPermission,
    auditEmitter: {
      emit: async (eventType, payload): Promise<void> => {
        await client.observe({
          ts: new Date().toISOString(),
          source: "agentchat",
          event_type: eventType,
          lane: "cli-subscription",
          project_id: handoff.project_id ?? null,
          user_id: handoff.to_agent,
          machine_id: "local",
          session_id: handoff.conversation_id,
          payload_json: payload,
          payload_summary: summarizeAuditPayload(eventType, payload).slice(0, 240),
        });
      },
    },
    sandboxConfig,
    logger: log,
    handoffId: handoff.handoff_id,
    dispatchId: handoff.handoff_id,
  });
}

async function maybeApplyRecallEnrichment(
  agentCfg: AgentChatConfig["agents"][number] | undefined,
  handoff: HandoffRow,
  dispatchedHandoff: HandoffRow,
): Promise<HandoffRow> {
  if (!agentCfg?.recall_context?.enabled) {
    return dispatchedHandoff;
  }
  const recallConfig = agentCfg.recall_context as Parameters<
    typeof recallEnricher.enrich
  >[0]["config"];
  const enrichedMessage = await recallEnricher.enrich({
    message: dispatchedHandoff.message,
    config: recallConfig,
    projectId: handoff.project_id ?? null,
  });
  if (enrichedMessage === dispatchedHandoff.message) {
    return dispatchedHandoff;
  }
  return { ...dispatchedHandoff, message: enrichedMessage };
}

async function setUpDispatchWorktree(
  handoff: HandoffRow,
  scopedConfig: AgentChatConfig,
  agentOptions: AgentOptions,
  requestPermission: ReturnType<typeof createPermissionCallback>,
  signal: AbortSignal,
): Promise<{
  overrideConfig: AgentChatConfig;
  dispatchedHandoff: HandoffRow;
  executor: WriteToolsExecutor;
}> {
  const worktreeSetupStart = Date.now();
  rememberHandoffBranchName(handoff);
  const result = await applyWorktreeOverride(
    handoff,
    scopedConfig,
    storageRoot,
    worktreeManager,
    process.cwd(),
    { signal },
    {
      recordBranchName: async (handoffId, branchName) => {
        await client.recordHandoffBranchName(handoffId, branchName, workerId);
      },
    },
  );
  if (result.handle) {
    onEvent(
      buildWorktreeReadyEvent({
        handoffId: handoff.handoff_id,
        workerId,
        worktreeMode: result.handle.worktreeMode,
        durationMs: Date.now() - worktreeSetupStart,
      }),
    );
  }
  const overrideConfig = applyOrchestrateToolsToConfig(
    result.overrideConfig,
    handoff.to_agent,
    handoff.dispatch_kind ?? null,
  );
  const dispatchedHandoff: HandoffRow = result.worktreePromptRewrite
    ? {
        ...handoff,
        message: rewriteWorktreeHandoffMessage(handoff.message, result.worktreePromptRewrite),
      }
    : handoff;
  const executor = buildDispatchExecutor(
    handoff,
    agentOptions,
    result.handle?.path ?? process.cwd(),
    requestPermission,
  );
  registerExecutor(handoff.handoff_id, executor);
  return { overrideConfig, dispatchedHandoff, executor };
}

async function runDispatch(
  handoff: HandoffRow & { hop_idx?: number },
  onChunk: (delta: string) => void,
  signal: AbortSignal,
): Promise<import("../src/cli/dispatch-handoff.js").DispatchHandoffResult> {
  // The handoff is already in 'dispatched' state at this point (the dispatcher
  // claimed it before calling). Whatever happens inside this function — clean
  // termination OR an unhandled throw from anything in the chain — we MUST
  // ensure the row leaves 'dispatched' (completed on success, or failed on
  // exhausted adapter retries) so it doesn't get stuck until manual recovery.
  const dispatchCwd = resolveDispatchCwd({
    project_id: handoff.project_id ?? undefined,
    defaultCwd: process.cwd(),
    projectRegistry,
  });
  const scopedConfig = applyAgentCwdOverride(config, handoff.to_agent, dispatchCwd);
  const transcript = await loadConversationTranscript(handoff.conversation_id);
  // Drop the current handoff's row by handoff_id — dispatchHandoff re-adds it via the wrapper.
  const transcriptForBuild = transcript
    .filter((t) => t.handoff_id !== handoff.handoff_id)
    .map((t) => ({ agent: t.agent, text: t.text }));
  // Count prior hops: non-user entries in the full transcript (each represents one completed
  // hop's output; the current handoff's row counts because it carries the previous hop's reply).
  const hopsSoFar = transcript.filter((t) => t.agent !== "user").length;
  // Enrich handoff for dispatcher progress reporting
  handoff.hop_idx = hopsSoFar;

  const projectContext = loadProjectContext(handoff.project_id);
  const trustMode = handoff.chain_trust_mode ?? defaultTrust;
  const maxHops = handoff.chain_max_hops ?? defaultMaxHops;
  const agentCfg = config.agents.find((a) => a.name === handoff.to_agent);
  const agentOptions = agentCfg?.options ?? {};
  // Orchestrate-maestro dispatches get the task-board resolution tools
  // (task.get/complete/fail) injected so the worker can self-complete its
  // task; no-op for every other dispatch kind. Mirrored into overrideConfig
  // below so the adapter tool SURFACE (not just permission auto-approve) is
  // augmented too.
  const allowedTools = withOrchestrateTools(
    agentOptions.allowed_tools ?? [],
    handoff.dispatch_kind ?? null,
  );
  const ttlSeconds =
    agentOptions.permission_ttl_s ?? Number(process.env.PENUMBRA_PERMISSION_TTL_S ?? 300);
  const perDispatchAllowlist = new Set<string>();
  const requestPermission = createPermissionCallback({
    trustMode,
    allowedTools,
    handoffId: handoff.handoff_id,
    conversationId: handoff.conversation_id,
    agentName: handoff.to_agent,
    ttlSeconds,
    daemonClient: permissionDaemonClient,
    perDispatchAllowlist,
    log,
  });

  let setup: {
    overrideConfig: AgentChatConfig;
    dispatchedHandoff: HandoffRow;
    executor: WriteToolsExecutor;
  };
  try {
    setup = await setUpDispatchWorktree(
      handoff,
      scopedConfig,
      agentOptions,
      requestPermission,
      signal,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await client.markFailed(handoff.handoff_id, reason, workerId);
    throw err;
  }

  const dispatchedHandoff = await maybeApplyRecallEnrichment(
    agentCfg,
    handoff,
    setup.dispatchedHandoff,
  );

  try {
    return await dispatchHandoff({
      handoff: dispatchedHandoff,
      config: setup.overrideConfig,
      conversation: { id: handoff.conversation_id, project_id: handoff.project_id ?? null },
      transcript: transcriptForBuild,
      transcriptBudget,
      hopsSoFar,
      maxHops,
      trustMode,
      requestPermission,
      projectContext,
      executor: setup.executor,
      observe: (e: Record<string, unknown>) => client.observe(e),
      createHandoff: (body: Parameters<typeof client.createHandoff>[0]) =>
        client.createHandoff(body),
      approve: (id: string, body: Parameters<typeof client.approve>[1]) => client.approve(id, body),
      markFailed: (id: string, reason: string) => client.markFailed(id, reason, workerId),
      onChunk,
      eventContext: {
        handoffId: handoff.handoff_id,
        workerId,
        agentName: handoff.to_agent,
      } as SpawnOpts["eventContext"],
      onEvent,
      signal,
    });
  } finally {
    await setup.executor.dispose().catch((err: unknown) => {
      log.warn({ handoff_id: handoff.handoff_id, err: String(err) }, "executor dispose failed");
    });
    unregisterExecutor(handoff.handoff_id);
  }
}

const dispatcher = createWorkerDispatcher({
  log,
  concurrency,
  workerId,
  onEvent,
  dispatchStartBarrier: (event) => client.postDispatchEventsStrict([event]),
  onDispatchEvent: (event) => {
    void postDiscordEvent(event);
  },
  // Captured at dispatch.end so the reliability classifier has a stable
  // signal even after a maestro FF-merges and main moves past HEAD. Uses
  // git status (filtered to skip node_modules/.test-storage) plus a HEAD
  // != worktree-base check via reflog presence — reflog has >1 entry only
  // if commits actually happened on the agent branch.
  getWorktreeSnapshot: async (handoffId) => {
    const wt = worktreeManager.getWorktree(handoffId);
    if (!wt) return { worktreeChanged: null, dirty: null, committed: null };
    const { promisify } = await import("node:util");
    const { exec: execCb } = await import("node:child_process");
    const exec = promisify(execCb);
    try {
      const [statusRes, reflogRes] = await Promise.all([
        exec(
          `git -C "${wt.path}" status --short --untracked-files=all -- '.' ':(exclude)node_modules' ':(exclude)packages/*/node_modules' ':(exclude).test-storage'`,
        ).catch(() => ({ stdout: "" })),
        exec(
          `git -C "${wt.path}" reflog show --no-decorate ${wt.branchName} 2>/dev/null | wc -l`,
        ).catch(() => ({ stdout: "0" })),
      ]);
      const dirty = statusRes.stdout.trim().length > 0;
      // Reflog of a freshly-created branch has 1 entry (the branch creation).
      // >1 means commits / amends happened.
      const reflogEntries = parseInt(reflogRes.stdout.trim(), 10) || 0;
      const committed = reflogEntries > 1;
      return { worktreeChanged: dirty || committed, dirty, committed };
    } catch {
      return { worktreeChanged: null, dirty: null, committed: null };
    }
  },
  claim: (id) => client.claimHandoff(id, workerId),
  // Cross-project claim affinity. `config` is read lazily (each handoff) so the
  // warm_pool flag survives hot-reload, mirroring computePrewarmTargetsNow.
  claimGraceMs: (rawHandoff): number => {
    const handoff = rawHandoff as HandoffRow;
    return computeClaimGraceMs({
      toAgent: handoff.to_agent,
      handoffProjectId: handoff.project_id ?? null,
      agents: config.agents.map((a) => ({
        name: a.name,
        options: a.options as { warm_pool?: boolean } | null,
      })),
      workerProjectId,
      resolveProjectRoot: prewarmResolveProjectRoot,
      mainRepoPath: process.cwd(),
      graceMs: CLAIM_AFFINITY_GRACE_MS,
    });
  },
  postProgress: (id: string, payload: Record<string, unknown>): Promise<void> =>
    client.postProgress(id, payload),
  complete: async (id): Promise<void> => {
    await client.completeHandoff(id, workerId);
  },
  markFailed: async (id, reason): Promise<void> => {
    await client.markFailed(id, reason, workerId);
  },
  autocommitOnChainEnd: async (rawHandoff): Promise<void> => {
    const handoff = rawHandoff as HandoffRow;
    const wt = worktreeManager.getWorktree(handoff.handoff_id);
    if (!wt) {
      return;
    }
    await autocommitOnChainEnd(handoff, wt, { log });
  },
  onChainEnd: (
    handoff,
    reason,
    worktreeChanged,
    _dirty,
    _committed,
    wallMs,
    frameworkOverheadMs,
    finalResponseText,
  ) => {
    const typedHandoff = handoff as HandoffRow;
    void maybePostDiscordChainEnd(typedHandoff, reason);
    void maybeCaptureDispatchOutcome(
      typedHandoff,
      reason,
      worktreeChanged,
      wallMs,
      frameworkOverheadMs,
      finalResponseText,
    );
    if (reason === "completed") {
      // Trigger the merge reconciler asynchronously without blocking completion
      void reconcileWorktree(typedHandoff.handoff_id).catch((err: unknown) => {
        log.error(
          { handoff_id: typedHandoff.handoff_id, err: String(err) },
          "worktree reconciliation failed",
        );
      });
    }
  },
  onClaimRetryable: (id) => eventSourceRef?.forget(id),
  dispatch: async (rawHandoff, onChunk, signal) => {
    const handoff = rawHandoff as HandoffRow & { hop_idx?: number };
    return await runDispatch(handoff, onChunk, signal);
  },
});

mkdirSync(join(homedir(), ".penumbra"), { recursive: true });
const workerServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    const match = /^\/sessions\/([^/]+)\/inject$/.exec(url.pathname);
    const sessionId = match?.[1];
    if (req.method === "POST" && sessionId) {
      return await workerInjectRoute(req, decodeURIComponent(sessionId), { token: workerToken });
    }
    return new Response("not found", { status: 404 });
  },
});
writeFileSync(join(homedir(), ".penumbra", "worker-port"), `${String(workerServer.port)}\n`);
writeFileSync(
  join(homedir(), ".penumbra", "worker-bind"),
  `127.0.0.1:${String(workerServer.port)}\n`,
);

const eventSource = startEventSource({
  client: {
    listHandoffs: (o) => client.listHandoffs(o),
    subscribeHandoffEvents: (o) => client.subscribeHandoffEvents(o),
  },
  statuses: ["approved", "redirected"],
  pollIntervalMs,
  project_id: workerProjectId,
  isolation: workerIsolation,
  onEvent: (row) => {
    void dispatcher.handle(row as HandoffRow);
  },
  log,
});
eventSourceRef = eventSource;

log.info(
  { storageRoot, concurrency, pollIntervalMs, defaultMaxHops, defaultTrust, workerId },
  "agentchat worker started",
);

// Usage poller. The fleet runs MANY workers per host, but the usage readers all
// source machine-global origins (codex rollout dir, opencode db/console, claude
// jsonl/statusline, the daemon's global quota). A machine lock makes exactly one
// worker run those readers (self-organizing, with failover) so the others don't
// redundantly read the same sources and emit duplicate event_ids. Disabled via
// PENUMBRA_USAGE_POLL_DISABLED=1 (tests); the lock gate can be turned off (every
// worker polls, legacy behavior) via PENUMBRA_USAGE_POLL_SINGLETON=0.
let usagePoller: { stop: () => void } | null = null;
if (process.env.PENUMBRA_USAGE_POLL_DISABLED !== "1") {
  const usageReaders: UsageReader[] = [
    new CodexRolloutReader(),
    new OpenCodeDbReader(),
    new ClaudeJsonlReader(),
    new ClaudeStatusLineBridge(),
    new GoogleOtlpSynth({ client, min_emit_pct: 1 }),
    new SakanaUsageSynth({ client, min_emit_pct: 1 }),
  ];
  const ocConsoleConfig = loadOpencodeConsoleConfig();
  if (ocConsoleConfig) {
    usageReaders.push(new OpenCodeConsoleReader(ocConsoleConfig));
  }
  const usagePollIntervalMs = Number(process.env.PENUMBRA_USAGE_POLL_INTERVAL_MS) || 60_000;
  const singletonGate = process.env.PENUMBRA_USAGE_POLL_SINGLETON !== "0";
  const usagePollLockPath = join(storageRoot, "usage-poller.lock");
  // With single-holder polling, use a SHARED cursor so a worker that takes over on
  // failover resumes where the previous holder left off (per-worker cursors would
  // make the new holder re-read the source from its own stale snapshot).
  const usageCursorPath = singletonGate
    ? resolveUsageCursorPath({
        storageRoot,
        workerId,
        env: { ...process.env, PENUMBRA_PER_WORKER_USAGE_CURSOR: "0" },
      })
    : resolveUsageCursorPath({ storageRoot, workerId, env: process.env });
  usagePoller = startUsagePoller({
    readers: usageReaders,
    intervalMs: usagePollIntervalMs,
    cursorPath: usageCursorPath,
    emit: (e: Record<string, unknown>) => client.observe(e),
    log,
    ...(singletonGate
      ? {
          acquireMachineLock: (): boolean =>
            acquireOrRefreshUsagePollLock({
              lockPath: usagePollLockPath,
              workerId,
              now: Date.now(),
              // A holder that misses ~2.5 ticks (stops refreshing) is treated as gone →
              // another worker takes over. Detection is timestamp-only (no pid probe).
              staleMs: Math.round(usagePollIntervalMs * 2.5),
            }),
          describeLockHolder: (): string | null =>
            readUsagePollLock(usagePollLockPath)?.workerId ?? null,
        }
      : {}),
  });
  log.info({ readers: usageReaders.length, workerId, singletonGate }, "usage-poller started");
}

let notificationScheduler: ReturnType<typeof createNotificationScheduler> | null = null;
if (process.env.PENUMBRA_NOTIFICATION_SCHEDULER_DISABLED !== "1") {
  notificationScheduler = createNotificationScheduler({
    now: () => Date.now(),
    intervalMs: 60_000,
    config: notificationConfig,
    getQuotaSummary: async () => {
      try {
        const response = await client.fetchQuotaStatus();
        return {
          providers: response.providers.map((provider) => ({
            provider: provider.provider,
            ...(provider.model ? { model: provider.model } : {}),
            used_tokens: provider.used_tokens,
            quota_tokens: provider.quota_tokens,
            remaining_pct_tokens: provider.remaining_pct_tokens,
          })),
        };
      } catch (err) {
        log.warn(
          {
            kind: "cost_quota_summary",
            err: err instanceof Error ? err.message : String(err),
          },
          "cost quota summary fetch failed",
        );
        throw err;
      }
    },
    postEvent: async (event) => {
      const ok = await postDiscordEvent(event);
      if (!ok) {
        throw new Error("cost quota summary delivery failed");
      }
    },
  });
  notificationScheduler.start();
  log.info({ interval_ms: 60_000, workerId }, "notification scheduler started");
}

const heartbeatLoop = startHeartbeatLoop({
  emitHeartbeat: (signal) => emitHeartbeat({ client, workerId, signal, onEvent }),
  reregisterWorker: () => client.reregisterWorker(),
  exit: (code) => process.exit(code),
  schedule: (run, delayMs): { cancel: () => void } => {
    const timer = setTimeout(() => {
      void run();
    }, delayMs);
    return {
      cancel: (): void => {
        clearTimeout(timer);
      },
    };
  },
  log,
  workerId,
});

// Control listener (SSE)
const controlAbort = new AbortController();
void runWorkerControlListener({
  client,
  dispatcher,
  signal: controlAbort.signal,
  log,
  workerId,
  onEvent,
  onConfigReload: () => {
    const previousConfig = config;
    config = loadConfigPathOrDir(configPath);
    invalidateChangedWarmPools(previousConfig.agents, config.agents, drainAgent);
    // Recompute pre-warm targets against the new config: start the loop if an
    // agent just opted in, stop it if the last one opted out, otherwise refresh.
    refreshPrewarmLoop();
    log.info({ agent_count: config.agents.length }, "agentchat-config-reloaded-from-control-bus");
  },
});

const shutdown = createWorkerShutdown({
  log,
  controlAbort,
  heartbeatLoop,
  prewarmAbort,
  prewarmLoop,
  getPrewarmLoop: () => prewarmLoop,
  usagePoller,
  notificationScheduler,
  shutdownAllAcpWarmPools,
  eventSource,
  permissionDaemonClient,
  dispatcher,
  eventQueue,
  exit: (code) => process.exit(code),
});
process.on("SIGINT", () => {
  void shutdown("SIGINT").catch((err: unknown) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "worker shutdown failed");
    process.exit(1);
  });
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM").catch((err: unknown) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "worker shutdown failed");
    process.exit(1);
  });
});
