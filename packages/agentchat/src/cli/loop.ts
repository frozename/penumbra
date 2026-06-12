import { buildAdapter } from "../adapters/registry.js";
import { parseMentions, type Mention } from "../mention/parser.js";
import { resolveMention, type Resolution } from "../mention/resolver.js";
import type { AgentChatConfig } from "../config/types.js";
import type { DispatchInput, DispatchOutput } from "../sdk/adapter.js";
import { ensureDispatchStream } from "../sdk/stream-wrapper.js";
import type { WriteToolsExecutor } from "../worker/write-tools-executor.js";
import { CapturePort } from "../worker/capture-port.js";
import { buildMaestroRedactorFromEnv } from "../worker/maestro-output-redactor.js";
import { normalizeAdapterOptions } from "./adapter-options.js";
import { shutdownAllAcpWarmPools } from "../adapters/acp-warm-pool-registry.js";

export function installAcpWarmPoolShutdownHandlers(
  proc: Pick<NodeJS.Process, "on"> = process,
  shutdownAll: () => void = shutdownAllAcpWarmPools,
): void {
  proc.on("SIGTERM", () => shutdownAll());
  proc.on("SIGINT", () => shutdownAll());
}

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
  requestPermission?: DispatchInput["requestPermission"];
  eventContext?: DispatchInput["eventContext"];
  onEvent?: DispatchInput["onEvent"];
  signal?: AbortSignal;
  buildAdapterOverride?: (
    kind: string,
    opts: Record<string, unknown>,
  ) => ReturnType<typeof buildAdapter>;
  long_lived_identity?: {
    dispatch_kind?: string | null;
    long_lived_agent_id?: string | null;
    long_lived_tick_id?: string | null;
  };
}

export interface ChatTurnResult {
  text: string;
  prompt_event_id: string;
  response_event_id: string;
  next_mention: { target: string; resolution: Resolution } | null;
  /** raw mentions found in the response, in order */
  mentions: Mention[];
  meta?: DispatchOutput["meta"];
  /** Set when the adapter dispatch threw. The error response is still observed in t0; the bin should not queue a handoff and should surface the error inline. */
  error?: { message: string };
}

export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const MAESTRO_RESPONSE_BLOCKED_SENTINEL = "[maestro response withheld by output policy]";
  const cfg = input.config.agents.find((a) => a.name === input.initialAgent);
  if (!cfg) throw new Error(`agent not found in config: ${input.initialAgent}`);

  const promptText = input.prompt ?? input.userMessage;
  const promptEvent = await input.observe({
    ts: new Date().toISOString(),
    source: "agentchat",
    event_type: "agent-prompt",
    lane: "cli-subscription",
    session_id: input.conversation.id,
    project_id: input.conversation.project_id,
    user_id: "local-user",
    machine_id: "local",
    payload_json: { prompt: promptText },
    payload_summary: promptText.slice(0, 240),
  });

  const lane: "local" | "cloud" | "cli-subscription" | "unknown" = "cli-subscription";
  const hostedSpecs = cfg.long_lived_config?.hosted_mcp_servers ?? [];
  // TODO: hard-filter unavailable hosted MCP servers here once the CLI has a
  // daemon health client available in this process. The daemon owns the mcpPool
  // and this loop currently only receives config, so prompt-stamper warnings are
  // the only availability signal exposed without a new health plumbing path.
  const adapterOptions = normalizeAdapterOptions(
    cfg,
    hostedSpecs,
    cfg.long_lived_config?.mcp_allowlist_sdk_patterns ?? cfg.long_lived_config?.mcp_allowlist ?? [],
  );
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

  const adapter = (input.buildAdapterOverride ?? buildAdapter)(cfg.adapter, {
    ...adapterOptions,
    agentName: cfg.name,
    capturePort,
  });

  let outText = "";
  let outMeta: DispatchOutput["meta"];
  let dispatchError: { message: string } | undefined;
  try {
    try {
      const dispatchInput = {
        prompt: promptText,
        conversation: input.conversation,
        config: {},
        long_lived_session: {
          dispatch_kind: input.long_lived_identity?.dispatch_kind ?? null,
          agent_id: input.long_lived_identity?.long_lived_agent_id ?? null,
          tick_id: input.long_lived_identity?.long_lived_tick_id ?? null,
          mcp_tool_allowlist: cfg.long_lived_config?.mcp_allowlist ?? null,
        },
        signal: input.signal ?? new AbortController().signal,
        requestPermission: input.requestPermission,
        handoff_id: input.handoff_id,
        executor: input.executor,
        eventContext: input.eventContext,
        onEvent: input.onEvent,
      };
      for await (const ev of ensureDispatchStream(adapter, dispatchInput)) {
        if (ev.type === "delta") {
          outText += ev.text;
          input.onChunk?.(ev.text);
        } else if (ev.type === "done") {
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

  // Maestro output redaction on the final agent-response. The capture-port
  // redactor only sees streaming chunks; adapters that resolve via a single
  // final payload still need the assembled response checked here before the
  // authoritative event is observed.
  let finalText = outText;
  let blockedHits: { rule_id: string; count: number }[] | null = null;
  let bypassHits: { rule_id: string; count: number }[] | null = null;
  let rewrittenHits: { rule_id: string; count: number }[] | null = null;
  if (!dispatchError && maestroRedactor) {
    const result = maestroRedactor.checkContent(outText);
    if (result.decision === "blocked") {
      blockedHits = result.hits;
    } else if (result.bypassed) {
      bypassHits = result.hits;
    } else if (result.decision === "rewritten") {
      rewrittenHits = result.hits;
      finalText = result.content;
    }
  }

  const baseEnvelope = {
    ts: new Date().toISOString(),
    source: "agentchat" as const,
    lane: "cli-subscription" as const,
    session_id: input.conversation.id,
    project_id: input.conversation.project_id,
    user_id: cfg.name,
    machine_id: "local",
    triggered_by_event_id: promptEvent.event_id,
  };

  if (blockedHits) {
    await input.observe({
      ...baseEnvelope,
      event_type: "agent-response-blocked",
      payload_json: {
        handoff_id: input.handoff_id ?? null,
        hits: blockedHits,
        decision: "blocked",
        redacted_message: MAESTRO_RESPONSE_BLOCKED_SENTINEL,
      },
      payload_summary:
        `maestro response blocked by ${blockedHits.map((h) => h.rule_id).join(",")}`.slice(0, 240),
    });
    finalText = MAESTRO_RESPONSE_BLOCKED_SENTINEL;
  } else if (bypassHits) {
    await input.observe({
      ...baseEnvelope,
      event_type: "agent-response-redaction-bypassed",
      payload_json: { handoff_id: input.handoff_id ?? null, hits: bypassHits },
      payload_summary: `bypass on (would-block=${bypassHits.length})`.slice(0, 240),
    });
  } else if (rewrittenHits) {
    await input.observe({
      ...baseEnvelope,
      event_type: "agent-response-redaction-hit",
      payload_json: { handoff_id: input.handoff_id ?? null, hits: rewrittenHits },
      payload_summary: `redaction hits: ${rewrittenHits.map((h) => h.rule_id).join(",")}`.slice(
        0,
        240,
      ),
    });
  }

  const responsePayload = dispatchError
    ? { handoff_id: input.handoff_id ?? null, error: dispatchError.message }
    : { handoff_id: input.handoff_id ?? null, response: finalText };
  const responseSummary = dispatchError
    ? `error: ${dispatchError.message}`.slice(0, 240)
    : finalText.slice(0, 240);

  const responseEvent = await input.observe({
    ...baseEnvelope,
    event_type: "agent-response",
    payload_json: responsePayload,
    payload_summary: responseSummary,
  });

  // Don't parse mentions on an errored or blocked turn — the response text is
  // empty/garbage or intentionally withheld.
  const knownTargets = [
    ...input.config.agents.map((a) => a.name),
    ...Object.keys(input.config.default_roles),
  ];
  const mentions = dispatchError || blockedHits ? [] : parseMentions(outText, { knownTargets });
  const next = mentions[0]
    ? { target: mentions[0].target, resolution: resolveMention(mentions[0].target, input.config) }
    : null;

  return {
    text: finalText,
    prompt_event_id: promptEvent.event_id,
    response_event_id: responseEvent.event_id,
    next_mention: next,
    mentions,
    ...(outMeta ? { meta: outMeta } : {}),
    ...(dispatchError ? { error: dispatchError } : {}),
  };
}

export function resolveCaptureAttribution(
  cfg: Pick<
    AgentChatConfig["agents"][number],
    "options" | "subscription_model" | "subscription_provider"
  >,
) {
  const adapterOptions = (cfg.options ?? {}) as Record<string, unknown>;
  const provider =
    cfg.subscription_provider ??
    (typeof adapterOptions.provider === "string" ? adapterOptions.provider : null);
  const model =
    cfg.subscription_model ??
    (typeof adapterOptions.model === "string" ? adapterOptions.model : null);

  return { provider, model };
}
