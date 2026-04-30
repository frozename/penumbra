#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PermissionDaemonClient } from '../src/worker/permission-daemon-client.js';
import { loadConfig } from '../src/config/load.js';
import { PenumbraClient } from '../src/penumbra-client.js';
import { PenumbraHttpError, isTerminalHttpStatus } from '../src/penumbra-client.js';
import { dispatchHandoff } from '../src/cli/dispatch-handoff.js';
import { startEventSource } from '../src/worker/event-source.js';
import { createWorkerDispatcher } from '../src/worker/dispatcher.js';
import { createPermissionCallback } from '../src/worker/permission-callback.js';
import { runWorkerControlListener } from '../src/worker/control-listener.js';
import { registerExecutor, unregisterExecutor } from '../src/worker/executor-registry.js';
import { resolveSandboxConfig } from '../src/worker/sandbox-config.js';
import { WriteToolsExecutor } from '../src/worker/write-tools-executor.js';
import { applyWorktreeOverride } from '../src/worker/worktree-integration.js';
import { createMergeReconciler, type MergeResult } from '../src/worker/merge-reconciler.js';
import {
  formatHandoffEmbed,
  formatMergeResultEmbed,
  postToDiscord,
} from '../src/worker/discord-notifier.js';
import { startUsagePoller } from '../src/usage-readers/poller.js';
import { CodexRolloutReader } from '../src/usage-readers/codex-rollout-reader.js';
import { OpenCodeDbReader } from '../src/usage-readers/opencode-db-reader.js';
import { ClaudeJsonlReader } from '../src/usage-readers/claude-jsonl-reader.js';
import { ClaudeStatusLineBridge } from '../src/usage-readers/claude-statusline-bridge.js';
import { createLogger, type HandoffRow, waitForDaemonStorageRoot, systemUuid, WorktreeManager } from '@penumbra/core';

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return fallback;
}

const configPath = process.env.AGENTCHAT_CONFIG ?? join(homedir(), '.config/agentchat/agentchat.yaml');
const explicitRoot = flag('storage-root', process.env.PENUMBRA_STORAGE_ROOT);
const bootstrapLog = createLogger({ component: 'agentchat-worker' });
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
        'penumbra daemon not found yet; waiting (up to 60s) for it to come up',
      );
    },
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const concurrency = Number(flag('concurrency', '4'));
const pollIntervalMs = Number(flag('poll-interval', '1000'));
const defaultMaxHops = Number(flag('max-hops', '8'));
const defaultTrust = (flag('trust', 'all') as 'all' | 'config');
const transcriptBudget = Number(flag('transcript-budget', '8192'));
const workerId = flag('worker-id', `worker-${Math.random().toString(36).slice(2, 7)}`)!;
const discordWebhookUrl = process.env.PENUMBRA_DISCORD_WEBHOOK_URL;
const discordQuiet = process.env.PENUMBRA_DISCORD_QUIET === '1';
const discordIncludePrompt = process.env.PENUMBRA_DISCORD_INCLUDE_PROMPT === '1';

const log = createLogger({ component: 'agentchat-worker' });
const config = loadConfig(configPath);
const client = new PenumbraClient({ storageRoot });

function mapChainEndStatus(reason: string): 'completed' | 'failed' | 'rejected' | 'expired' {
  if (reason === 'completed') return 'completed';
  if (reason === 'cancelled') return 'rejected';
  if (reason === 'max_hops') return 'expired';
  return 'failed';
}

function latencySecondsFrom(ts: string): number {
  const started = Date.parse(ts);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 1000));
}

async function maybePostDiscordChainEnd(handoff: HandoffRow, reason: string): Promise<void> {
  if (discordQuiet || !discordWebhookUrl) return;

  let resolvedHandoff = handoff;
  try {
    const res = await client.getHandoff(handoff.handoff_id);
    resolvedHandoff = (res.handoff as HandoffRow) ?? handoff;
  } catch {
    resolvedHandoff = handoff;
  }

  const ok = await postToDiscord(discordWebhookUrl, {
    embeds: [
      formatHandoffEmbed({
        handoff_id: resolvedHandoff.handoff_id,
        agent: resolvedHandoff.to_agent,
        status: mapChainEndStatus(reason),
        latency_seconds: latencySecondsFrom(resolvedHandoff.ts),
        conversation_id: resolvedHandoff.conversation_id,
        error_summary: reason === 'error' ? resolvedHandoff.error_message ?? 'dispatch error' : undefined,
        prompt: resolvedHandoff.message,
      }, { includePrompt: discordIncludePrompt }),
    ],
  });
  if (!ok) {
    log.warn({ handoff_id: resolvedHandoff.handoff_id, reason }, 'discord chain-end notification failed');
  }
}

async function maybePostDiscordMergeResult(handoffId: string, result: MergeResult): Promise<void> {
  if (discordQuiet || !discordWebhookUrl) return;
  if (result.status === 'no_changes') return;

  let handoff: HandoffRow | null = null;
  try {
    ({ handoff } = await client.getHandoff(handoffId));
  } catch {
    handoff = null;
  }

  const ok = await postToDiscord(discordWebhookUrl, {
    embeds: [
      formatMergeResultEmbed({
        handoff_id: handoffId,
        conversation_id: handoff?.conversation_id ?? '<unknown>',
        agent: handoff?.to_agent ?? '<unknown>',
        status: result.status === 'pr_opened'
          ? 'pr_opened'
          : result.status === 'pr_creation_failed'
            ? 'pr_creation_failed'
            : result.status === 'typecheck_failed'
              ? 'typecheck_failed'
              : 'test_failed',
        regression_summary: result.regression_summary,
        prompt: handoff?.message,
        pr_url: result.pr_url,
      }, { includePrompt: discordIncludePrompt }),
    ],
  });
  if (!ok) {
    log.warn({ handoff_id: handoffId, status: result.status }, 'discord merge-result notification failed');
  }
}

function loadProjectContext(project_id: string | null): string | undefined {
  if (!project_id) return undefined;
  const path = join(storageRoot, 'context', project_id, 'latest.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function createPermissionEventSource(url: string, token: string) {
  // Native EventSource (browser API) doesn't support custom headers — bun's
  // global EventSource (when available) inherits that limitation, so we
  // can't use it here: the daemon's bearer auth would never be sent. The
  // fallback below is the authoritative path until we adopt a polyfill that
  // supports authenticated reconnect.
  const listeners = new Map<string, Set<(evt: { data: string; lastEventId?: string }) => void>>();
  const reconnectListeners = new Set<() => void>();
  const controller = new AbortController();
  let closed = false;
  let backoffMs = 200;

  const fireReconnectListeners = () => {
    for (const fn of reconnectListeners) fn();
  };

  const emit = (name: string, data: string, lastEventId?: string) => {
    for (const fn of listeners.get(name) ?? []) {
      fn({ data, lastEventId });
    }
  };

  const parseFrame = (frame: string) => {
    let eventName = '';
    let lastEventId: string | undefined;
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('id:')) lastEventId = line.slice(3).trim();
    }
    if (eventName && dataLines.length) emit(eventName, dataLines.join('\n'), lastEventId);
  };

  const pump = async () => {
    while (!closed && !controller.signal.aborted) {
      try {
        const res = await fetch(url, {
          headers: {
            accept: 'text/event-stream',
            authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`permissions SSE HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        fireReconnectListeners();
        try {
          while (!closed && !controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            backoffMs = 200;
            buf += decoder.decode(value, { stream: true });
            const frames = buf.split('\n\n');
            buf = frames.pop() ?? '';
            for (const frame of frames) parseFrame(frame);
          }
        } finally {
          reader.releaseLock();
          try { await res.body.cancel(); } catch { /* noop */ }
        }
      } catch {
        if (closed || controller.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30000);
      }
    }
  };
  void pump();

  return {
    addEventListener(name: string, fn: (evt: { data: string; lastEventId?: string }) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
    },
    onReconnect(fn: () => void) {
      reconnectListeners.add(fn);
      return () => {
        reconnectListeners.delete(fn);
      };
    },
    close() {
      closed = true;
      controller.abort();
      reconnectListeners.clear();
      listeners.clear();
    },
  };
}

async function loadConversationTranscript(conversation_id: string): Promise<{ handoff_id: string; agent: string; text: string }[]> {
  // Phase 1: rebuild a transcript by listing handoffs in the conversation. Each handoff row
  // carries the sender (from_agent) and message (the sender's reply text). We retain handoff_id
  // alongside each entry so the dispatcher can drop the current row by id rather than by content
  // — matching by {agent, text} would mis-fire when the same sender emits identical text twice.
  const { handoffs } = await client.listHandoffs({
    statuses: ['completed', 'dispatched', 'approved', 'redirected'],
    conversation_id,
  });
  const sorted = [...handoffs].sort((a, b) => a.ts.localeCompare(b.ts));
  return sorted.map((h) => ({
    handoff_id: h.handoff_id as string,
    agent: h.from_agent === 'user' ? 'user' : (h.from_agent as string),
    text: h.message as string,
  }));
}

// Forward declaration: the dispatcher's onClaimRetryable needs to call
// eventSource.forget(), but eventSource is created after dispatcher (circular).
// Use a mutable pointer that gets filled in below.
let eventSourceRef: { forget(id: string): void } | null = null;

const worktreeManager = new WorktreeManager();

// Read port + token at boot to construct authenticated SSE connections to the
// daemon. PenumbraClient re-reads on every call (survives daemon restarts) but
// the SSE pump captures these once; daemon-restart resilience is a documented
// Phase 1c v2 limitation. Wrap in try/catch so a missing daemon yields a clean
// error instead of an opaque ENOENT trace.
let baseDaemonUrl: string;
let daemonToken: string;
try {
  const portStr = readFileSync(join(storageRoot, 'port'), 'utf8').trim();
  daemonToken = readFileSync(join(storageRoot, 'token'), 'utf8').trim();
  baseDaemonUrl = `http://127.0.0.1:${Number(portStr)}`;
} catch (err) {
  console.error(`penumbra not running at ${storageRoot} (missing port/token); start the daemon first`);
  process.exit(1);
}

const permissionDaemonClient = new PermissionDaemonClient({
  penumbraClient: client,
  makeEventSource: () => createPermissionEventSource(`${baseDaemonUrl}/permissions/events`, daemonToken),
  uuid: systemUuid,
  log,
});
await permissionDaemonClient.start();

const reconcileWorktree = createMergeReconciler({
  worktreeManager,
  postProgress: (id, payload) => client.postProgress(id, payload),
  notifyResult: (id, result) => maybePostDiscordMergeResult(id, result),
  log,
  mainRepoDir: process.cwd(),
  getHandoff: async (id) => {
    try {
      const { handoff } = await client.getHandoff(id);
      return handoff;
    } catch {
      return null;
    }
  },
});

const dispatcher = createWorkerDispatcher({
  log,
  concurrency,
  claim: (id) => client.claimHandoff(id, workerId),
  postProgress: (id, payload) => client.postProgress(id, payload),
  complete: async (id) => { await client.completeHandoff(id); },
  onChainEnd: (handoff, reason) => {
    void maybePostDiscordChainEnd(handoff as HandoffRow, reason);
    if (reason === 'completed') {
      // Trigger the merge reconciler asynchronously without blocking completion
      void reconcileWorktree((handoff as HandoffRow).handoff_id).catch((err) => {
        log.error({ handoff_id: (handoff as HandoffRow).handoff_id, err: String(err) }, 'worktree reconciliation failed');
      });
    }
  },
  onClaimRetryable: (id) => eventSourceRef?.forget(id),
  dispatch: async (handoff, onChunk, signal) => {
    // The handoff is already in 'dispatched' state at this point (the dispatcher
    // claimed it before calling). Whatever happens inside this function — clean
    // termination OR an unhandled throw from anything in the chain — we MUST
    // ensure the row leaves 'dispatched' (completed on success, or failed on
    // exhausted adapter retries) so it doesn't get stuck until manual recovery.
    const transcript = await loadConversationTranscript(handoff.conversation_id);
    // Drop the current handoff's row by handoff_id — dispatchHandoff re-adds it via the wrapper.
    const transcriptForBuild = transcript
      .filter((t) => t.handoff_id !== handoff.handoff_id)
      .map((t) => ({ agent: t.agent, text: t.text }));
    // Count prior hops: non-user entries in the full transcript (each represents one completed
    // hop's output; the current handoff's row counts because it carries the previous hop's reply).
    const hopsSoFar = transcript.filter((t) => t.agent !== 'user').length;
    
    // Enrich handoff for dispatcher progress reporting
    handoff.hop_idx = hopsSoFar;

    const projectContext = loadProjectContext(handoff.project_id);
    const trustMode = (handoff.chain_trust_mode ?? defaultTrust) as 'all' | 'config';
    const maxHops = handoff.chain_max_hops ?? defaultMaxHops;
    const agentCfg = config.agents.find((a) => a.name === handoff.to_agent);
    const allowedTools = (agentCfg?.options as any)?.allowed_tools ?? [];
    const ttlSeconds = (agentCfg?.options as any)?.permission_ttl_s ?? Number(process.env.PENUMBRA_PERMISSION_TTL_S ?? 300);
    const perDispatchAllowlist = new Set<string>();
    const requestPermission = createPermissionCallback({
      trustMode,
      allowedTools,
      handoffId: handoff.handoff_id as string,
      conversationId: handoff.conversation_id,
      agentName: handoff.to_agent,
      ttlSeconds,
      daemonClient: permissionDaemonClient,
      perDispatchAllowlist,
      log,
    });

    let overrideConfig = config;
    let executor: WriteToolsExecutor | null = null;
    try {
      const result = await applyWorktreeOverride(handoff, config, storageRoot, worktreeManager);
      overrideConfig = result.overrideConfig;
      const sandboxConfig = resolveSandboxConfig((agentCfg?.options as any) ?? {});
      executor = new WriteToolsExecutor({
        worktreeRoot: result.handle?.path ?? process.cwd(),
        permissionCallback: requestPermission,
        auditEmitter: {
          emit: async (eventType, payload) => {
            const payloadSummary = (() => {
              const typed = payload as Record<string, unknown> | null;
              if (!typed || typeof typed !== 'object') return eventType;
              const path = typeof typed.path === 'string' ? typed.path : null;
              const terminalId = typeof typed.terminal_id === 'string' ? typed.terminal_id : null;
              const reason = typeof typed.reason === 'string' ? typed.reason : null;
              const detail = path ?? terminalId ?? reason;
              return detail ? `${eventType}: ${detail}` : eventType;
            })();
            await client.observe({
              ts: new Date().toISOString(),
              source: 'agentchat',
              event_type: eventType,
              lane: 'cli-subscription',
              project_id: handoff.project_id ?? null,
              user_id: handoff.to_agent,
              machine_id: 'local',
              session_id: handoff.conversation_id,
              payload_json: payload as Record<string, unknown>,
              payload_summary: payloadSummary.slice(0, 240),
            });
          },
        },
        sandboxConfig,
        logger: log,
        handoffId: handoff.handoff_id as string,
        dispatchId: handoff.handoff_id as string,
      });
      registerExecutor(handoff.handoff_id as string, executor);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await client.markFailed(handoff.handoff_id as string, reason);
      throw err;
    }

    try {
      return await dispatchHandoff({
        handoff,
        config: overrideConfig,
        conversation: { id: handoff.conversation_id, project_id: handoff.project_id ?? null },
        transcript: transcriptForBuild,
        transcriptBudget,
        hopsSoFar,
        maxHops,
        trustMode,
        requestPermission,
        projectContext,
        executor: executor ?? undefined,
        observe: (e) => client.observe(e),
        createHandoff: (body) => client.createHandoff(body),
        approve: (id, body) => client.approve(id, body),
        markFailed: (id, reason) => client.markFailed(id, reason),
        onChunk,
        signal,
      });
    } finally {
      if (executor) {
        await executor.dispose().catch((err) => {
          log.warn({ handoff_id: handoff.handoff_id, err: String(err) }, 'executor dispose failed');
        });
        unregisterExecutor(handoff.handoff_id as string);
      }
    }
  },
});

const eventSource = startEventSource({
  client: {
    listHandoffs: (o) => client.listHandoffs(o),
    subscribeHandoffEvents: (o) => client.subscribeHandoffEvents(o),
  },
  statuses: ['approved', 'redirected'],
  pollIntervalMs,
  onEvent: (row) => { 
    if (!row) return;
    void dispatcher.handle(row); 
  },
  log,
});
eventSourceRef = eventSource;

log.info({ storageRoot, concurrency, pollIntervalMs, defaultMaxHops, defaultTrust, workerId }, 'agentchat worker started');

// Usage poller: only worker-primary runs the singleton, to avoid 4 readers racing
// on the same cursor file. Disabled via PENUMBRA_USAGE_POLL_DISABLED=1 for tests.
let usagePoller: { stop: () => void } | null = null;
if (workerId === 'worker-primary' && process.env.PENUMBRA_USAGE_POLL_DISABLED !== '1') {
  usagePoller = startUsagePoller({
    readers: [
      new CodexRolloutReader(),
      new OpenCodeDbReader(),
      new ClaudeJsonlReader(),
      new ClaudeStatusLineBridge(),
    ],
    intervalMs: Number(process.env.PENUMBRA_USAGE_POLL_INTERVAL_MS) || 60_000,
    cursorPath: join(storageRoot, 'local-state-cursors.json'),
    emit: (e) => client.observe(e),
    log,
  });
  log.info({ readers: 4 }, 'usage-poller started (worker-primary)');
}

// Heartbeat loop (15s nominal, with backoff on failure)
let heartbeatTimer: Timer | null = null;
const sendHeartbeat = (delayMs = 15_000, attempt = 0) => {
  heartbeatTimer = setTimeout(async () => {
    try {
      await client.postHeartbeat(workerId);
      sendHeartbeat(15_000, 0);
    } catch (err: any) {
      const status = err instanceof PenumbraHttpError ? err.status : null;
      const isTerminal = status !== null && isTerminalHttpStatus(status);
      if (isTerminal) {
        log.error({ status, err: String(err) }, 'heartbeat failed permanently; worker may be unauthorized');
        // We don't exit here to allow in-flight tasks to finish, but we stop heartbeating
        return;
      }
      
      const nextAttempt = attempt + 1;
      const backoff = Math.min(1000 * Math.pow(2, attempt), 30_000);
      log.debug({ err: String(err), backoff, nextAttempt }, 'heartbeat failed; retrying with backoff');
      sendHeartbeat(backoff, nextAttempt);
    }
  }, delayMs);
};
sendHeartbeat(0);

// Control listener (SSE)
const controlAbort = new AbortController();
void runWorkerControlListener({
  client,
  dispatcher,
  signal: controlAbort.signal,
  log,
});

const shutdown = async (sig: string) => {
  log.info({ sig }, 'shutting down');
  controlAbort.abort();
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  usagePoller?.stop();
  await eventSource.stop();
  permissionDaemonClient.stop();
  dispatcher.stop();
  await dispatcher.idle();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
