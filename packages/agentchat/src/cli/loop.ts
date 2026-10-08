import type { AgentChatConfig, LongLivedConfigWithPrecomputedAllowlist } from "../config/types.js";
import type { Mention } from "../mention/parser.js";
import type { Resolution } from "../mention/resolver.js";
import type { Adapter, DispatchInput, DispatchOutput } from "../sdk/adapter.js";
import type { WriteToolsExecutor } from "../worker/write-tools-executor.js";

import { shutdownAllAcpWarmPools } from "../adapters/acp-warm-pool-registry.js";
import { buildAdapter } from "../adapters/registry.js";
import { classifierDeclineMetaFromUnknown } from "../classifier-decline.js";
import { parseMentions } from "../mention/parser.js";
import { resolveMention } from "../mention/resolver.js";
import { ensureDispatchStream } from "../sdk/stream-wrapper.js";
import { CapturePort } from "../worker/capture-port.js";
import {
  buildMaestroRedactorFromEnv,
  type MaestroOutputRedactor,
} from "../worker/maestro-output-redactor.js";
import { normalizeAdapterOptions } from "./adapter-options.js";

const MAESTRO_RESPONSE_BLOCKED_SENTINEL = "[maestro response withheld by output policy]";

export function installAcpWarmPoolShutdownHandlers(
  proc: Pick<NodeJS.Process, "on"> = process,
  shutdownAll: () => void = shutdownAllAcpWarmPools,
): void {
  proc.on("SIGTERM", () => {
    shutdownAll();
  });
  proc.on("SIGINT", () => {
    shutdownAll();
  });
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
  observe: (event: Record<string, unknown>) => Promise<{ event_id: string }>;
  /** optional: called for each text delta as the adapter streams. */
  onChunk?: (delta: string) => void;
  requestPermission?: DispatchInput["requestPermission"];
  /** Plumbed from the worker's chain_trust_mode so adapters can short-circuit
   *  permission gates under "all" without consulting requestPermission. */
  trust_mode?: DispatchInput["trust_mode"];
  /** Plumbed from the handoff row's permission_profile so natively enforcing
   *  adapters can apply their own policy mechanism. */
  permission_profile?: DispatchInput["permission_profile"];
  /** Worker-computed Layer B deny roots accompanying permission_profile. */
  sandbox_deny_roots?: DispatchInput["sandbox_deny_roots"];
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
  /** Post-adapter observe envelopes that could not be delivered (each carries a
   *  pre-generated event_id so a later outbox replay dedups at the daemon). Any
   *  observe failure after the adapter finished keeps the turn instead of
   *  re-running it. */
  pendingObservations?: Record<string, unknown>[];
}

type AgentCfg = AgentChatConfig["agents"][number];

type RedactionHit = { rule_id: string; count: number };

interface DispatchOutcome {
  outText: string;
  outMeta: DispatchOutput["meta"] | undefined;
  dispatchError: { message: string } | undefined;
  dispatchErrorMeta: DispatchOutput["meta"] | undefined;
}

interface RedactionOutcome {
  finalText: string;
  blockedHits: RedactionHit[] | null;
  bypassHits: RedactionHit[] | null;
  rewrittenHits: RedactionHit[] | null;
}

async function observePrompt(
  input: ChatTurnInput,
  promptText: string,
): Promise<{ event_id: string }> {
  return await input.observe({
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
}

function buildDispatchInput(
  input: ChatTurnInput,
  cfg: AgentCfg,
  promptText: string,
): DispatchInput {
  return {
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
    trust_mode: input.trust_mode,
    permission_profile: input.permission_profile,
    sandbox_deny_roots: input.sandbox_deny_roots,
    handoff_id: input.handoff_id,
    executor: input.executor,
    eventContext: input.eventContext,
    onEvent: input.onEvent,
  };
}

async function runAdapterDispatch(
  adapter: Adapter,
  dispatchInput: DispatchInput,
  onChunk: ((delta: string) => void) | undefined,
  capturePort: CapturePort,
): Promise<DispatchOutcome> {
  let outText = "";
  let outMeta: DispatchOutput["meta"] | undefined;
  let dispatchError: { message: string } | undefined;
  let dispatchErrorMeta: DispatchOutput["meta"] | undefined;
  try {
    try {
      for await (const ev of ensureDispatchStream(adapter, dispatchInput)) {
        if (ev.type === "delta") {
          outText += ev.text;
          onChunk?.(ev.text);
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
      const classifierDecline = classifierDeclineMetaFromUnknown(err);
      if (classifierDecline) dispatchErrorMeta = classifierDecline;
    }
  } finally {
    await capturePort.close();
    const stats = capturePort.getStats();
    console.error(`capture-port stats: sent=${String(stats.sent)} failed=${String(stats.failed)}`);
  }
  return { outText, outMeta, dispatchError, dispatchErrorMeta };
}

function applyMaestroRedaction(
  redactor: MaestroOutputRedactor,
  outText: string,
  dispatchError: { message: string } | undefined,
): RedactionOutcome {
  const base: RedactionOutcome = {
    finalText: outText,
    blockedHits: null,
    bypassHits: null,
    rewrittenHits: null,
  };
  if (dispatchError) return base;
  const result = redactor.checkContent(outText);
  if (result.decision === "blocked") return { ...base, blockedHits: result.hits };
  if (result.bypassed) return { ...base, bypassHits: result.hits };
  if (result.decision === "rewritten") {
    return { ...base, rewrittenHits: result.hits, finalText: result.content };
  }
  return base;
}

function buildRedactionEnvelopes(
  input: ChatTurnInput,
  baseEnvelope: Record<string, unknown>,
  redaction: RedactionOutcome,
): Record<string, unknown>[] {
  if (redaction.blockedHits) {
    const hits = redaction.blockedHits;
    return [
      {
        ...baseEnvelope,
        event_id: crypto.randomUUID(),
        event_type: "agent-response-blocked",
        payload_json: {
          handoff_id: input.handoff_id ?? null,
          hits,
          decision: "blocked",
          redacted_message: MAESTRO_RESPONSE_BLOCKED_SENTINEL,
        },
        payload_summary:
          `maestro response blocked by ${hits.map((h) => h.rule_id).join(",")}`.slice(0, 240),
      },
    ];
  }
  if (redaction.bypassHits) {
    const hits = redaction.bypassHits;
    return [
      {
        ...baseEnvelope,
        event_id: crypto.randomUUID(),
        event_type: "agent-response-redaction-bypassed",
        payload_json: { handoff_id: input.handoff_id ?? null, hits },
        payload_summary: `bypass on (would-block=${String(hits.length)})`.slice(0, 240),
      },
    ];
  }
  if (redaction.rewrittenHits) {
    const hits = redaction.rewrittenHits;
    return [
      {
        ...baseEnvelope,
        event_id: crypto.randomUUID(),
        event_type: "agent-response-redaction-hit",
        payload_json: { handoff_id: input.handoff_id ?? null, hits },
        payload_summary: `redaction hits: ${hits.map((h) => h.rule_id).join(",")}`.slice(0, 240),
      },
    ];
  }
  return [];
}

// Sends the ordered post-adapter envelopes (redaction first, agent-response
// last). The first failure stops the sequence and returns every unsent
// envelope — including the failed one — so an outbox can replay them in order.
async function sendPostTurnEnvelopes(
  input: ChatTurnInput,
  envelopes: Record<string, unknown>[],
): Promise<{ pendingObservations: Record<string, unknown>[]; responseEventId: string }> {
  const responseEnvelope = envelopes.at(-1);
  const pendingObservations: Record<string, unknown>[] = [];
  let responseEventId =
    typeof responseEnvelope?.event_id === "string" ? responseEnvelope.event_id : "";
  for (const envelope of envelopes) {
    if (pendingObservations.length > 0) {
      pendingObservations.push(envelope);
      continue;
    }
    try {
      const res = await input.observe(envelope);
      if (envelope === responseEnvelope) responseEventId = res.event_id;
    } catch {
      pendingObservations.push(envelope);
    }
  }
  return { pendingObservations, responseEventId };
}

function resolveNextMention(
  config: AgentChatConfig,
  outText: string,
  dispatchError: { message: string } | undefined,
  blockedHits: RedactionHit[] | null,
): { mentions: Mention[]; next: ChatTurnResult["next_mention"] } {
  const knownTargets = [
    ...config.agents.map((a) => a.name),
    ...Object.keys(config.default_roles ?? {}),
  ];
  const mentions = dispatchError || blockedHits ? [] : parseMentions(outText, { knownTargets });
  const first = mentions[0];
  const next = first
    ? { target: first.target, resolution: resolveMention(first.target, config) }
    : null;
  return { mentions, next };
}

export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const cfg = input.config.agents.find((a) => a.name === input.initialAgent);
  if (!cfg) throw new Error(`agent not found in config: ${input.initialAgent}`);

  const promptText = input.prompt ?? input.userMessage;
  const promptEvent = await observePrompt(input, promptText);

  // Config loaders stamp `mcp_allowlist_sdk_patterns` onto long_lived_config at
  // runtime (see ../config/load.ts), but the zod schema for long_lived_config
  // does not encode the field. Widen via the precomputed variant so the read is
  // type-checked without an inline cast bypass.
  const longLivedConfig = cfg.long_lived_config as
    | LongLivedConfigWithPrecomputedAllowlist
    | undefined;
  const hostedSpecs = longLivedConfig?.hosted_mcp_servers ?? [];
  const allowlistPatterns =
    longLivedConfig?.mcp_allowlist_sdk_patterns ?? longLivedConfig?.mcp_allowlist ?? [];
  const adapterOptions = normalizeAdapterOptions(
    { ...cfg, options: cfg.options },
    hostedSpecs,
    allowlistPatterns,
  );
  const { provider, model } = resolveCaptureAttribution(cfg);
  const knownAgents = new Set(input.config.agents.map((a) => a.name));
  const maestroRedactor = buildMaestroRedactorFromEnv({
    env: process.env,
    knownAgents,
  });
  const capturePort = new CapturePort({
    observe: input.observe,
    chainId: input.conversation.id,
    handoffId: input.handoff_id ?? "",
    projectId: input.conversation.project_id,
    agentName: cfg.name,
    provider,
    model,
    lane: "cli-subscription",
    triggeredByEventId: promptEvent.event_id,
    maestroRedactor,
  });

  const adapter = (input.buildAdapterOverride ?? buildAdapter)(cfg.adapter, {
    ...adapterOptions,
    agentName: cfg.name,
    capturePort,
  });

  const dispatchInput = buildDispatchInput(input, cfg, promptText);
  const outcome = await runAdapterDispatch(adapter, dispatchInput, input.onChunk, capturePort);
  void outcome.outMeta; // observed via raw_response in v1; reserved for future direct surfacing

  // Maestro output redaction on the final agent-response. The capture-port
  // redactor only sees streaming chunks; adapters that resolve via a single
  // final payload still need the assembled response checked here before the
  // authoritative event is observed.
  const redaction = applyMaestroRedaction(maestroRedactor, outcome.outText, outcome.dispatchError);

  const baseEnvelope = {
    ts: new Date().toISOString(),
    source: "agentchat" as const,
    lane: "cli-subscription" as const,
    session_id: input.conversation.id,
    project_id: input.conversation.project_id,
    source_detail: cfg.name,
    user_id: cfg.name,
    machine_id: "local",
    triggered_by_event_id: promptEvent.event_id,
  };

  const finalText = redaction.blockedHits ? MAESTRO_RESPONSE_BLOCKED_SENTINEL : redaction.finalText;

  const dispatchError = outcome.dispatchError;
  const responsePayload = dispatchError
    ? { handoff_id: input.handoff_id ?? null, agent: cfg.name, error: dispatchError.message }
    : { handoff_id: input.handoff_id ?? null, agent: cfg.name, response: finalText };
  const responseSummary = dispatchError
    ? `error: ${dispatchError.message}`.slice(0, 240)
    : finalText.slice(0, 240);

  const { pendingObservations, responseEventId } = await sendPostTurnEnvelopes(input, [
    ...buildRedactionEnvelopes(input, baseEnvelope, redaction),
    {
      ...baseEnvelope,
      event_id: crypto.randomUUID(),
      event_type: "agent-response",
      payload_json: responsePayload,
      payload_summary: responseSummary,
    },
  ]);

  // Don't parse mentions on an errored or blocked turn — the response text is
  // empty/garbage or intentionally withheld.
  const { mentions, next } = resolveNextMention(
    input.config,
    outcome.outText,
    dispatchError,
    redaction.blockedHits,
  );

  const meta = outcome.outMeta ?? outcome.dispatchErrorMeta;
  return {
    text: finalText,
    prompt_event_id: promptEvent.event_id,
    response_event_id: responseEventId,
    next_mention: next,
    mentions,
    ...(meta ? { meta } : {}),
    ...(dispatchError ? { error: dispatchError } : {}),
    ...(pendingObservations.length > 0 ? { pendingObservations } : {}),
  };
}

export function resolveCaptureAttribution(
  cfg: Pick<AgentCfg, "api_provider" | "options" | "subscription_model" | "subscription_provider">,
): { provider: string | null; model: string | null } {
  const adapterOptions: Record<string, unknown> = cfg.options ?? {};
  const providerOpt = adapterOptions.provider;
  const modelOpt = adapterOptions.model;
  const apiProvider = cfg.api_provider === "deepseek" ? cfg.api_provider : null;
  const provider =
    cfg.subscription_provider ??
    apiProvider ??
    (typeof providerOpt === "string" ? providerOpt : null);
  const model = cfg.subscription_model ?? (typeof modelOpt === "string" ? modelOpt : null);
  return { provider, model };
}
