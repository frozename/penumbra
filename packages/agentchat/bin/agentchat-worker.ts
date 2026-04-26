#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config/load.js';
import { PenumbraClient } from '../src/penumbra-client.js';
import { dispatchHandoff } from '../src/cli/dispatch-handoff.js';
import { startEventSource } from '../src/worker/event-source.js';
import { createWorkerDispatcher } from '../src/worker/dispatcher.js';
import { createLogger } from '@penumbra/core';

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return fallback;
}

const configPath = process.env.AGENTCHAT_CONFIG ?? join(homedir(), '.config/agentchat/agentchat.yaml');
const storageRoot = flag('storage-root', process.env.PENUMBRA_STORAGE_ROOT ?? join(homedir(), '.penumbra'))!;
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

async function loadConversationTranscript(conversation_id: string): Promise<{ agent: string; text: string }[]> {
  // Phase 1: rebuild a simple transcript by listing prior completed handoffs in the conversation.
  // Each completed handoff carries the sender (from_agent) and message (the sender's reply text).
  // The user-prompt that started the chain is reconstructed from the very first handoff's message.
  const { handoffs } = await client.listHandoffs({
    statuses: ['completed', 'dispatched', 'approved', 'redirected'],
    conversation_id,
  });
  // Drop the chain-start synthetic handoff — its message IS the user prompt and should be the first transcript line.
  const sorted = [...handoffs].sort((a, b) => a.ts.localeCompare(b.ts));
  const transcript: { agent: string; text: string }[] = [];
  for (const h of sorted) {
    if (h.from_agent === 'user') {
      transcript.push({ agent: 'user', text: h.message });
    } else {
      transcript.push({ agent: h.from_agent, text: h.message });
    }
  }
  return transcript;
}

const dispatcher = createWorkerDispatcher({
  log,
  concurrency,
  claim: (id) => client.claimHandoff(id),
  dispatch: async (handoff) => {
    const transcript = await loadConversationTranscript(handoff.conversation_id);
    // Drop the current handoff's own message from the transcript — dispatchHandoff re-adds it via the wrapper.
    const transcriptForBuild = transcript.filter((t) => !(t.agent === handoff.from_agent && t.text === handoff.message));
    // Count prior hops: number of agent-response transcript entries (i.e., non-user).
    const hopsSoFar = transcript.filter((t) => t.agent !== 'user').length;

    const projectContext = loadProjectContext(handoff.project_id);
    const trustMode = (handoff.chain_trust_mode ?? defaultTrust) as 'all' | 'config';
    const maxHops = handoff.chain_max_hops ?? defaultMaxHops;

    const result = await dispatchHandoff({
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

    // Always mark the dispatched handoff completed once the hop finishes (success or terminal).
    try { await client.completeHandoff(handoff.handoff_id); }
    catch (err) { log.warn({ handoff_id: handoff.handoff_id, err: String(err) }, 'completeHandoff failed'); }

    return result;
  },
});

const stop = startEventSource({
  client: {
    listHandoffs: (o) => client.listHandoffs(o),
    subscribeHandoffEvents: (o) => client.subscribeHandoffEvents(o),
  },
  statuses: ['approved', 'redirected'],
  pollIntervalMs,
  onEvent: (row) => { void dispatcher.handle(row); },
});

log.info({ storageRoot, concurrency, pollIntervalMs, defaultMaxHops, defaultTrust }, 'agentchat worker started');

const shutdown = async (sig: string) => {
  log.info({ sig }, 'shutting down');
  await stop();
  await dispatcher.idle();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
