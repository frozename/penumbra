import type { AgentChatConfig } from '../config/types.js';
import { runChatTurn as realRunChatTurn, type ChatTurnInput, type ChatTurnResult } from './loop.js';
import { buildNextPrompt } from './transcript.js';

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
}

export async function runAutoChain(opts: AutoChainOpts): Promise<{
  hops: number;
  terminatedReason: 'no_mention' | 'max_hops' | 'error';
  cappedHandoffId?: string;
}> {
  let hops = 0;
  let currentAgent = opts.initialAgent;
  let currentPrompt = opts.userMessage;
  const transcript: { agent: string; text: string }[] = [{ agent: 'user', text: opts.userMessage }];
  const turnRunner = opts.runChatTurn ?? realRunChatTurn;

  while (true) {
    hops++;
    const turn = await turnRunner({
      config: opts.config,
      initialAgent: currentAgent,
      userMessage: opts.userMessage,
      conversation: opts.conversation,
      prompt: hops > 1 ? currentPrompt : undefined,
      observe: opts.observe,
    });
    
    console.log(`\n[${currentAgent}]\n${turn.text}\n`);
    
    if (turn.error) {
      console.log(`[${currentAgent}] error: ${turn.error}`);
      return { hops, terminatedReason: 'error' };
    }

    if (!turn.next_mention) {
      return { hops, terminatedReason: 'no_mention' };
    }

    const toAgent = turn.next_mention.resolution.kind === 'unknown' 
      ? turn.next_mention.target 
      : (turn.next_mention.resolution as any).agent_name;
    const toRole = turn.next_mention.resolution.kind === 'role' 
      ? (turn.next_mention.resolution as any).role 
      : null;

    const handoff = await opts.createHandoff({
      from: currentAgent,
      to: toAgent,
      to_role: toRole,
      message: turn.text,
      conversation_id: opts.conversation.id,
      project_id: opts.conversation.project_id,
      triggered_by_event_id: turn.response_event_id,
    });

    if (hops >= opts.maxHops) {
      return { hops, terminatedReason: 'max_hops', cappedHandoffId: handoff.handoff_id };
    }

    console.log(`[auto-approved → ${turn.next_mention.target}]`);
    await opts.approve(handoff.handoff_id, { resolved_by: 'auto' });

    transcript.push({ agent: currentAgent, text: turn.text });
    currentPrompt = buildNextPrompt(transcript, currentAgent, turn.text, { maxTokens: opts.transcriptBudget });
    currentAgent = toAgent;
  }
}
