import type { AgentChatConfig } from '../config/types.js';
import { runChatTurn as realRunChatTurn, type ChatTurnInput, type ChatTurnResult } from './loop.js';
import { dispatchHandoff } from './dispatch-handoff.js';
import type { HandoffRow } from '@penumbra/core';

export interface AutoChainOpts {
  config: AgentChatConfig;
  initialAgent: string;
  userMessage: string;
  conversation: { id: string; project_id: string | null };
  maxHops: number;
  transcriptBudget: number;
  observe: (event: any) => Promise<{ event_id: string }>;
  createHandoff: (body: any) => Promise<{ handoff_id: string; status: string }>;
  approve: (id: string, body: any) => Promise<{ handoff_id: string; status: string }>;
  runChatTurn?: (input: ChatTurnInput) => Promise<ChatTurnResult>;
  trustMode?: 'all' | 'config';
  projectContext?: string;
  onChunk?: (delta: string) => void;
}

export async function runAutoChain(opts: AutoChainOpts): Promise<{
  hops: number;
  terminatedReason: 'no_mention' | 'max_hops' | 'untrusted' | 'error';
  cappedHandoffId?: string;
}> {
  const trustMode = opts.trustMode ?? 'all';
  const transcript: { agent: string; text: string }[] = [{ agent: 'user', text: opts.userMessage }];

  // Synthesize an initial chain-start handoff for the loop. We never persist this row;
  // dispatchHandoff treats from_agent === 'user' specially (no transcript wrap).
  let currentHandoff: { from_agent: string; to_agent: string; message: string } = {
    from_agent: 'user',
    to_agent: opts.initialAgent,
    message: opts.userMessage,
  };

  let hops = 0;
  while (true) {
    hops++;
    process.stdout.write(`\n[${currentHandoff.to_agent}]\n`);
    const res = await dispatchHandoff({
      handoff: currentHandoff,
      config: opts.config,
      conversation: opts.conversation,
      transcript,
      transcriptBudget: opts.transcriptBudget,
      hopsSoFar: hops - 1,
      maxHops: opts.maxHops,
      trustMode,
      projectContext: opts.projectContext,
      observe: opts.observe,
      createHandoff: opts.createHandoff,
      approve: opts.approve,
      runChatTurn: opts.runChatTurn ?? realRunChatTurn,
      onChunk: opts.onChunk,
    });
    process.stdout.write('\n\n');

    const terminate = async (reason: 'completed' | 'max_hops' | 'untrusted' | 'error', cappedHandoffId?: string) => {
      await opts.observe({
        ts: new Date().toISOString(),
        source: 'agentchat',
        event_type: 'chain-terminated',
        lane: 'cli-subscription',
        session_id: opts.conversation.id,
        project_id: opts.conversation.project_id,
        user_id: 'local-user',
        machine_id: 'local',
        payload_json: {
          reason,
          hop_count: hops,
          conversation_id: opts.conversation.id,
          terminal_handoff_id: cappedHandoffId,
        },
      });
    };

    if (res.terminatedReason === 'error') {
      await terminate('error');
      return { hops, terminatedReason: 'error' };
    }
    if (res.terminatedReason === 'no_mention') {
      await terminate('completed');
      return { hops, terminatedReason: 'no_mention' };
    }
    if (res.terminatedReason === 'max_hops') {
      await terminate('max_hops', res.cappedHandoffId);
      return { hops, terminatedReason: 'max_hops', cappedHandoffId: res.cappedHandoffId! };
    }
    if (res.terminatedReason === 'untrusted') {
      console.log(`[untrusted edge ${currentHandoff.to_agent}→${res.next ? res.next.to : '?'}, handoff ${res.cappedHandoffId!.slice(0, 8)} queued]`);
      await terminate('untrusted', res.cappedHandoffId);
      return { hops, terminatedReason: 'untrusted', cappedHandoffId: res.cappedHandoffId! };
    }

    // Continue: shape the next synthetic handoff.
    transcript.push({ agent: currentHandoff.to_agent, text: res.text });
    console.log(`[auto-approved → ${res.next!.to}]`);
    currentHandoff = {
      from_agent: res.next!.from,
      to_agent: res.next!.to,
      message: res.next!.message,
    };
  }
}