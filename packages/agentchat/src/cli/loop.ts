import { buildAdapter } from '../adapters/registry.js';
import { parseMentions, type Mention } from '../mention/parser.js';
import { resolveMention, type Resolution } from '../mention/resolver.js';
import type { AgentChatConfig } from '../config/types.js';
import type { DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import { ensureDispatchStream } from '../sdk/stream-wrapper.js';
import type { WriteToolsExecutor } from '../worker/write-tools-executor.js';
import { CapturePort } from '../worker/capture-port.js';
import { buildMaestroRedactorFromEnv } from '../worker/maestro-output-redactor.js';

export interface ChatTurnInput {
  config: AgentChatConfig;
  initialAgent: string;
  userMessage: string;
  conversation: { id: string; project_id: string | null };
  /** optional: override prompt assembly. If absent, the userMessage is sent verbatim. */
  prompt?: string;
  handoff_id?: string;
  executor?: WriteToolsExecutor;
  observe: (event: any) => Promise<{ event_id: string }>;
  /** optional: called for each text delta as the adapter streams. */
  onChunk?: (delta: string) => void;
  requestPermission?: DispatchInput['requestPermission'];
  eventContext?: DispatchInput['eventContext'];
  onEvent?: DispatchInput['onEvent'];
  signal?: AbortSignal;
}

export interface ChatTurnResult {
  text: string;
  prompt_event_id: string;
  response_event_id: string;
  next_mention: { target: string; resolution: Resolution } | null;
  /** raw mentions found in the response, in order */
  mentions: Mention[];
  /** Set when the adapter dispatch threw. The error response is still observed in t0; the bin should not queue a handoff and should surface the error inline. */
  error?: { message: string };
}

export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const cfg = input.config.agents.find((a) => a.name === input.initialAgent);
  if (!cfg) throw new Error(`agent not found in config: ${input.initialAgent}`);

  const promptText = input.prompt ?? input.userMessage;
  const promptEvent = await input.observe({
    ts: new Date().toISOString(),
    source: 'agentchat',
    event_type: 'agent-prompt',
    lane: 'cli-subscription',
    session_id: input.conversation.id,
    project_id: input.conversation.project_id,
    user_id: 'local-user',
    machine_id: 'local',
    payload_json: { prompt: promptText },
    payload_summary: promptText.slice(0, 240),
  });

  const lane: 'local' | 'cloud' | 'cli-subscription' | 'unknown' = 'cli-subscription';
  const adapterOptions = (cfg.options ?? {}) as Record<string, unknown>;
  const { provider, model } = resolveCaptureAttribution(cfg);
  const knownAgents = new Set(input.config.agents.map((a) => a.name));
  const maestroRedactor = buildMaestroRedactorFromEnv({
    env: process.env as Record<string, string | undefined>,
    knownAgents,
  });
  const capturePort = new CapturePort({
    observe: input.observe,
    chainId: input.conversation.id,
    handoffId: input.handoff_id!,
    projectId: input.conversation.project_id,
    agentName: cfg.name,
    provider,
    model,
    lane,
    triggeredByEventId: promptEvent.event_id,
    maestroRedactor,
  });

  const adapter = buildAdapter(cfg.adapter, { ...adapterOptions, capturePort });

  let outText = '';
  let outMeta: DispatchOutput['meta'];
  let dispatchError: { message: string } | undefined;
  try {
    try {
      const dispatchInput = {
        prompt: promptText,
        conversation: input.conversation,
        config: {},
        signal: input.signal ?? new AbortController().signal,
        requestPermission: input.requestPermission,
        handoff_id: input.handoff_id,
        executor: input.executor,
        eventContext: input.eventContext,
        onEvent: input.onEvent,
      };
      for await (const ev of ensureDispatchStream(adapter, dispatchInput)) {
        if (ev.type === 'delta') {
          outText += ev.text;
          input.onChunk?.(ev.text);
        } else if (ev.type === 'done') {
          // 'done' carries the authoritative final text + meta. Trust it over the
          // accumulated deltas in case the adapter sent a final-shaped result
          // (e.g. one-shot adapters yield delta+done where delta == result.text).
          outText = ev.result.text;
          outMeta = ev.result.meta;
        }
        // tool_call / tool_result / tool_error are reserved; v1 adapters do not emit them.
      }
    } catch (err) {
      dispatchError = { message: err instanceof Error ? err.message : String(err) };
    }
  } finally {
    await capturePort.close();
    const stats = capturePort.getStats();
    console.error(`capture-port stats: sent=${stats.sent} failed=${stats.failed}`);
  }
  void outMeta; // observed via raw_response in v1; reserved for future direct surfacing

  const responsePayload = dispatchError
    ? { error: dispatchError.message }
    : { response: outText };
  const responseSummary = dispatchError
    ? `error: ${dispatchError.message}`.slice(0, 240)
    : outText.slice(0, 240);

  const responseEvent = await input.observe({
    ts: new Date().toISOString(),
    source: 'agentchat',
    event_type: 'agent-response',
    lane: 'cli-subscription',
    session_id: input.conversation.id,
    project_id: input.conversation.project_id,
    user_id: cfg.name,
    machine_id: 'local',
    payload_json: responsePayload,
    payload_summary: responseSummary,
    triggered_by_event_id: promptEvent.event_id,
  });

  // Don't parse mentions on an errored turn — the response text is empty/garbage.
  const knownTargets = [...input.config.agents.map((a) => a.name), ...Object.keys(input.config.default_roles)];
  const mentions = dispatchError ? [] : parseMentions(outText, { knownTargets });
  const next = mentions[0]
    ? { target: mentions[0].target, resolution: resolveMention(mentions[0].target, input.config) }
    : null;

  return {
    text: outText,
    prompt_event_id: promptEvent.event_id,
    response_event_id: responseEvent.event_id,
    next_mention: next,
    mentions,
    ...(dispatchError ? { error: dispatchError } : {}),
  };
}

export function resolveCaptureAttribution(
  cfg: Pick<AgentChatConfig['agents'][number], 'options' | 'subscription_model' | 'subscription_provider'>,
) {
  const adapterOptions = (cfg.options ?? {}) as Record<string, unknown>;
  const provider =
    cfg.subscription_provider ??
    (typeof adapterOptions.provider === 'string' ? adapterOptions.provider : null);
  const model =
    cfg.subscription_model ??
    (typeof adapterOptions.model === 'string' ? adapterOptions.model : null);

  return { provider, model };
}
