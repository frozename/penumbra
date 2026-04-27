#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config/load.js';
import { PenumbraClient } from '../src/penumbra-client.js';
import { dispatchHandoff } from '../src/cli/dispatch-handoff.js';
import { startEventSource } from '../src/worker/event-source.js';
import { createWorkerDispatcher } from '../src/worker/dispatcher.js';
import { createLogger, resolveDaemonStorageRoot } from '@penumbra/core';

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return fallback;
}

const configPath = process.env.AGENTCHAT_CONFIG ?? join(homedir(), '.config/agentchat/agentchat.yaml');
const explicitRoot = flag('storage-root', process.env.PENUMBRA_STORAGE_ROOT);
let storageRoot: string;
try {
  storageRoot = resolveDaemonStorageRoot({ explicit: explicitRoot });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const concurrency = Number(flag('concurrency', '4'));
const pollIntervalMs = Number(flag('poll-interval', '1000'));
const defaultMaxHops = Number(flag('max-hops', '8'));
const defaultTrust = (flag('trust', 'all') as 'all' | 'config');
const transcriptBudget = Number(flag('transcript-budget', '8192'));

const log = createLogger({ component: 'agentchat-worker' });
const config = loadConfig(configPath);
const client = new PenumbraClient({ storageRoot });

function loadProjectContext(project_id: string | null): string | undefined {
  if (!project_id) return undefined;
  const path = join(storageRoot, 'context', project_id, 'latest.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
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

const dispatcher = createWorkerDispatcher({
  log,
  concurrency,
  claim: (id) => client.claimHandoff(id),
  onClaimRetryable: (id) => eventSourceRef?.forget(id),
  dispatch: async (handoff) => {
    // The handoff is already in 'dispatched' state at this point (the dispatcher
    // claimed it before calling). Whatever happens inside this function — clean
    // termination, adapter error captured by runChatTurn, OR an unhandled throw
    // from anything in the chain — we MUST mark the row 'completed' before
    // returning, otherwise it gets stuck at 'dispatched' until manual recovery.
    try {
      const transcript = await loadConversationTranscript(handoff.conversation_id);
      // Drop the current handoff's row by handoff_id — dispatchHandoff re-adds it via the wrapper.
      const transcriptForBuild = transcript
        .filter((t) => t.handoff_id !== handoff.handoff_id)
        .map((t) => ({ agent: t.agent, text: t.text }));
      // Count prior hops: non-user entries in the full transcript (each represents one completed
      // hop's output; the current handoff's row counts because it carries the previous hop's reply).
      const hopsSoFar = transcript.filter((t) => t.agent !== 'user').length;

      const projectContext = loadProjectContext(handoff.project_id);
      const trustMode = (handoff.chain_trust_mode ?? defaultTrust) as 'all' | 'config';
      const maxHops = handoff.chain_max_hops ?? defaultMaxHops;

      return await dispatchHandoff({
        handoff,
        config,
        conversation: { id: handoff.conversation_id, project_id: handoff.project_id ?? null },
        transcript: transcriptForBuild,
        transcriptBudget,
        hopsSoFar,
        maxHops,
        trustMode,
        projectContext,
        observe: (e) => client.observe(e),
        createHandoff: (body) => client.createHandoff(body),
        approve: (id, body) => client.approve(id, body),
      });
    } finally {
      try { await client.completeHandoff(handoff.handoff_id); }
      catch (err) { log.warn({ handoff_id: handoff.handoff_id, err: String(err) }, 'completeHandoff failed'); }
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
  onEvent: (row) => { void dispatcher.handle(row); },
  log,
});
eventSourceRef = eventSource;

log.info({ storageRoot, concurrency, pollIntervalMs, defaultMaxHops, defaultTrust }, 'agentchat worker started');

const shutdown = async (sig: string) => {
  log.info({ sig }, 'shutting down');
  await eventSource.stop();
  await dispatcher.idle();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
