import {
  type MaestroOutputRedactor,
  type MaestroRedactionResult,
  type MaestroRedactionResultObject,
} from "./maestro-output-redactor.js";

export type ObservedDispatchEvent = Record<string, unknown>;

export interface CapturePortOpts {
  observe(event: ObservedDispatchEvent): Promise<{ event_id: string }>;
  chainId: string | null;
  handoffId: string;
  projectId: string | null;
  agentName: string;
  provider: string | null;
  model: string | null;
  lane: "local" | "cloud" | "cli-subscription" | "unknown";
  triggeredByEventId?: string | null;
  /**
   * If set, applies value-pattern redaction to outgoing agent-response
   * text before dispatch. Side-channel events carry the hits + decision for
   * audit. agent-thought is never redacted.
   */
  maestroRedactor?: MaestroOutputRedactor;
  closeTimeoutMs?: number;
}

interface RegularNotificationEvent {
  kind:
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "tool_call"
    | "tool_call_update"
    | "usage_update";
  toolCallId?: string;
  status?: "pending" | "in_progress" | "completed" | "failed" | "canceled";
  content?: string;
  input?: unknown;
  output?: unknown;
  used?: number;
  size?: number;
  tokens_input?: number;
  tokens_cache_read?: number;
  tokens_cache_write?: number;
  cost?: { amount: number; currency: string };
}

type UsageTokenPayload = Pick<
  RegularNotificationEvent,
  "tokens_cache_read" | "tokens_cache_write" | "tokens_input"
>;

export type NotificationEvent =
  | RegularNotificationEvent
  | {
      kind: "capacity_error";
      provider: string;
      model: string | null;
      raw: string;
    };

interface ChunkBuffer {
  kind: "agent_message_chunk" | "agent_thought_chunk";
  text: string;
  startedAt: number;
}

interface HeldToolCall {
  startedAt: number;
  input: unknown;
}

type RedactionHit = MaestroRedactionResult["hits"][number];

const TRUNCATE_LIMIT = 8 * 1024;
const MAESTRO_RESPONSE_BLOCKED_SENTINEL = "[maestro response withheld by output policy]";
const MAESTRO_TOOL_USE_BLOCKED_SENTINEL = "[maestro tool-use withheld by output policy]";
const MAESTRO_TOOL_RESULT_BLOCKED_SENTINEL = "[maestro tool-result withheld by output policy]";

function truncateIfNeeded(value: unknown): {
  value: unknown;
  truncated: boolean;
  bytesTotal: number;
} {
  if (value === undefined || value === null)
    return { value: null, truncated: false, bytesTotal: 0 };
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= TRUNCATE_LIMIT) return { value, truncated: false, bytesTotal: bytes };
  const prefix = json.slice(0, TRUNCATE_LIMIT);
  return { value: { __truncated_string: prefix }, truncated: true, bytesTotal: bytes };
}

function joinRuleIds(hits: RedactionHit[]): string {
  return hits.map((h) => h.rule_id).join(",");
}

function readErrorBody(err: unknown): unknown {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = (err as { body?: unknown }).body;
  return candidate;
}

function assignFiniteUsageToken(
  payload: UsageTokenPayload,
  key: keyof UsageTokenPayload,
  value: number | undefined,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    payload[key] = value;
  }
}

function usageTokenPayload(ev: RegularNotificationEvent): UsageTokenPayload {
  const payload: UsageTokenPayload = {};
  assignFiniteUsageToken(payload, "tokens_input", ev.tokens_input);
  assignFiniteUsageToken(payload, "tokens_cache_read", ev.tokens_cache_read);
  assignFiniteUsageToken(payload, "tokens_cache_write", ev.tokens_cache_write);
  return payload;
}

export class CapturePort {
  private readonly opts: CapturePortOpts;
  private chunkBuffer: ChunkBuffer | null = null;
  private readonly toolCalls = new Map<string, HeldToolCall>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private stats = { sent: 0, failed: 0 };
  private closed = false;
  private usageWarnedMissing = false;

  constructor(opts: CapturePortOpts) {
    this.opts = opts;
  }

  emit(ev: NotificationEvent): void {
    if (this.closed) return;
    try {
      switch (ev.kind) {
        case "agent_message_chunk":
        case "agent_thought_chunk":
          this.handleChunk(ev);
          break;
        case "tool_call":
          this.handleToolCall(ev);
          break;
        case "tool_call_update":
          this.handleToolCallUpdate(ev);
          break;
        case "usage_update":
          this.handleUsageUpdate(ev);
          break;
        case "capacity_error":
          this.handleCapacityError(ev);
          break;
      }
    } catch {
      // emit never throws
    }
  }

  async flush(): Promise<void> {
    this.flushChunkBuffer();
    this.emitOrphans();
    const closeTimeoutMs = this.opts.closeTimeoutMs ?? 2_000;
    const pendingCount = this.inFlight.size;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise<void>((resolve) => setTimeout(resolve, closeTimeoutMs)),
    ]);
    if (this.inFlight.size > 0 && pendingCount > 0) {
      console.error(
        `capture-port: close timed out after ${String(closeTimeoutMs)}ms; pending=${String(this.inFlight.size)}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
  }

  getStats(): { sent: number; failed: number } {
    return { ...this.stats };
  }

  private handleChunk(ev: RegularNotificationEvent): void {
    const kind = ev.kind as "agent_message_chunk" | "agent_thought_chunk";
    if (this.chunkBuffer && this.chunkBuffer.kind !== kind) {
      this.flushChunkBuffer();
    }
    this.chunkBuffer ??= { kind, text: "", startedAt: Date.now() };
    this.chunkBuffer.text += ev.content ?? "";
  }

  private handleToolCall(ev: RegularNotificationEvent): void {
    if (!ev.toolCallId) return;
    if (this.chunkBuffer) {
      this.flushChunkBuffer();
    }
    this.toolCalls.set(ev.toolCallId, {
      startedAt: Date.now(),
      input: ev.input ?? null,
    });
  }

  private handleToolCallUpdate(ev: RegularNotificationEvent): void {
    if (!ev.toolCallId) return;
    const terminal =
      ev.status === "completed" || ev.status === "failed" || ev.status === "canceled";
    if (!terminal) return;
    const held = this.toolCalls.get(ev.toolCallId);
    if (!held) return;
    this.toolCalls.delete(ev.toolCallId);
    if (this.chunkBuffer) {
      this.flushChunkBuffer();
    }
    const status = ev.status ?? "completed";
    this.emitToolRow(ev.toolCallId, held, status, ev.output ?? null, false);
  }

  private handleUsageUpdate(ev: RegularNotificationEvent): void {
    if (typeof ev.used !== "number" || !Number.isFinite(ev.used)) {
      if (!this.usageWarnedMissing) {
        console.error("capture-port: usage_update missing/invalid `used`, dropping");
        this.usageWarnedMissing = true;
      }
      return;
    }
    const event = this.buildBaseEvent("usage-update", Date.now());
    let cost_usd: number | null = null;
    if (ev.cost) {
      if (ev.cost.currency === "USD") {
        cost_usd = ev.cost.amount;
      } else {
        console.error(
          `capture-port: usage_update cost ${ev.cost.currency} not converted (skipped)`,
        );
      }
    }
    event.cost_usd = cost_usd;
    event.payload_json = {
      handoff_id: this.opts.handoffId,
      used: ev.used,
      size: ev.size,
      ...usageTokenPayload(ev),
      currency: ev.cost?.currency ?? null,
      raw_cost: ev.cost ?? null,
      source_kind: "acp-wire",
    };
    const usedStr = String(ev.used);
    const sizeStr = ev.size === undefined ? "unknown" : String(ev.size);
    event.payload_summary = ev.cost
      ? `${usedStr}/${sizeStr} tokens, ${String(ev.cost.amount)} ${ev.cost.currency}`.slice(0, 240)
      : `${usedStr}/${sizeStr} tokens`.slice(0, 240);
    this.dispatch(event);
  }

  private handleCapacityError(ev: Extract<NotificationEvent, { kind: "capacity_error" }>): void {
    const event = this.buildBaseEvent("provider-capacity-error", Date.now());
    event.provider = ev.provider || this.opts.provider;
    event.model = ev.model ?? this.opts.model;
    event.payload_json = {
      handoff_id: this.opts.handoffId,
      provider: ev.provider,
      model: ev.model,
      raw: ev.raw,
      source_kind: "cli-spawn-stderr",
    };
    event.payload_summary = `${ev.provider}/${ev.model ?? "unknown"} capacity error`.slice(0, 240);
    this.dispatch(event);
  }

  private flushChunkBuffer(): void {
    const buf = this.chunkBuffer;
    if (!buf) return;
    this.chunkBuffer = null;
    const baseEventType = buf.kind === "agent_message_chunk" ? "agent-response" : "agent-thought";

    if (baseEventType === "agent-response" && this.opts.maestroRedactor) {
      this.flushRedactedResponse(buf, this.opts.maestroRedactor);
      return;
    }

    const event = this.buildBaseEvent(baseEventType, buf.startedAt);
    event.payload_json = { handoff_id: this.opts.handoffId, text: buf.text };
    event.payload_summary = buf.text.slice(0, 240);
    this.dispatch(event);
  }

  private flushRedactedResponse(buf: ChunkBuffer, redactor: MaestroOutputRedactor): void {
    const result: MaestroRedactionResult = redactor.checkContent(buf.text);
    if (result.decision === "blocked") {
      this.dispatchResponseBlocked(buf.startedAt, result.hits);
      return;
    }
    if (result.bypassed) {
      this.dispatchResponseRedactionNote(buf.startedAt, result.hits, "bypassed");
    } else if (result.decision === "rewritten") {
      this.dispatchResponseRedactionNote(buf.startedAt, result.hits, "hit");
    }
    const event = this.buildBaseEvent("agent-response", buf.startedAt);
    event.payload_json = { handoff_id: this.opts.handoffId, text: result.content };
    event.payload_summary = result.content.slice(0, 240);
    this.dispatch(event);
  }

  private dispatchResponseBlocked(startedAt: number, hits: RedactionHit[]): void {
    const blocked = this.buildBaseEvent("agent-response-blocked", startedAt);
    blocked.payload_json = {
      handoff_id: this.opts.handoffId,
      hits,
      decision: "blocked",
      redacted_message: MAESTRO_RESPONSE_BLOCKED_SENTINEL,
    };
    blocked.payload_summary = `maestro response blocked by ${joinRuleIds(hits)}`.slice(0, 240);
    this.dispatch(blocked);
  }

  private dispatchResponseRedactionNote(
    startedAt: number,
    hits: RedactionHit[],
    kind: "bypassed" | "hit",
  ): void {
    const eventType =
      kind === "bypassed" ? "agent-response-redaction-bypassed" : "agent-response-redaction-hit";
    const note = this.buildBaseEvent(eventType, startedAt);
    note.payload_json = { handoff_id: this.opts.handoffId, hits };
    note.payload_summary =
      kind === "bypassed"
        ? `bypass on (would-block=${String(hits.length)})`.slice(0, 240)
        : `redaction hits: ${joinRuleIds(hits)}`.slice(0, 240);
    this.dispatch(note);
  }

  private emitOrphans(): void {
    for (const [toolCallId, held] of this.toolCalls) {
      this.emitToolRow(toolCallId, held, "canceled", null, true);
    }
    this.toolCalls.clear();
  }

  private emitToolRow(
    toolCallId: string,
    held: HeldToolCall,
    status: string,
    output: unknown,
    orphaned: boolean,
  ): void {
    const redactor = this.opts.maestroRedactor;
    const redaction = redactor
      ? this.applyToolRedaction(toolCallId, held, output, redactor)
      : { redactedInput: held.input, redactedOutput: output, blocked: false };
    if (redaction.blocked) return;

    const inputResult = truncateIfNeeded(redaction.redactedInput);
    const outputResult = truncateIfNeeded(redaction.redactedOutput);
    const event = this.buildBaseEvent("agent-tool-use", held.startedAt);
    const payload: Record<string, unknown> = {
      handoff_id: this.opts.handoffId,
      tool_call_id: toolCallId,
      input: inputResult.value,
      output: outputResult.value,
      status,
    };
    if (orphaned) payload.lifecycle = "orphaned";
    const anyTruncated = inputResult.truncated || outputResult.truncated;
    if (anyTruncated) {
      payload.truncated = true;
      payload.bytes_total =
        (inputResult.truncated ? inputResult.bytesTotal : 0) +
        (outputResult.truncated ? outputResult.bytesTotal : 0);
    }
    event.payload_json = payload;
    event.payload_summary = `${toolCallId} ${status}`.slice(0, 240);
    this.dispatch(event);
  }

  private applyToolRedaction(
    toolCallId: string,
    held: HeldToolCall,
    output: unknown,
    redactor: MaestroOutputRedactor,
  ): { redactedInput: unknown; redactedOutput: unknown; blocked: boolean } {
    const inputCheck: MaestroRedactionResultObject = redactor.checkValue(held.input);
    if (inputCheck.decision === "blocked") {
      this.dispatchToolUseBlocked(toolCallId, held.startedAt, inputCheck.hits);
      return { redactedInput: held.input, redactedOutput: output, blocked: true };
    }
    this.dispatchToolUseRedactionNote(toolCallId, held.startedAt, inputCheck);
    const redactedInput = inputCheck.value;

    const outputCheck: MaestroRedactionResultObject = redactor.checkAnyValue(output);
    if (outputCheck.decision === "blocked") {
      this.dispatchToolResultBlocked(toolCallId, held.startedAt, outputCheck.hits);
      const sentinel: Record<string, unknown> = {
        redacted_message: MAESTRO_TOOL_RESULT_BLOCKED_SENTINEL,
        rule_id: outputCheck.hits[0]?.rule_id ?? "maestro_output_policy",
      };
      return { redactedInput, redactedOutput: sentinel, blocked: false };
    }
    this.dispatchToolResultRedactionNote(toolCallId, held.startedAt, outputCheck);
    return { redactedInput, redactedOutput: outputCheck.value, blocked: false };
  }

  private dispatchToolUseBlocked(
    toolCallId: string,
    startedAt: number,
    hits: RedactionHit[],
  ): void {
    const blocked = this.buildBaseEvent("agent-tool-use-blocked", startedAt);
    blocked.payload_json = {
      handoff_id: this.opts.handoffId,
      tool_call_id: toolCallId,
      hits,
      decision: "blocked",
      redacted_message: MAESTRO_TOOL_USE_BLOCKED_SENTINEL,
    };
    blocked.payload_summary = `tool call blocked by ${joinRuleIds(hits)}`.slice(0, 240);
    this.dispatch(blocked);
  }

  private dispatchToolUseRedactionNote(
    toolCallId: string,
    startedAt: number,
    check: MaestroRedactionResultObject,
  ): void {
    if (check.bypassed) {
      const note = this.buildBaseEvent("agent-tool-use-redaction-bypassed", startedAt);
      note.payload_json = {
        handoff_id: this.opts.handoffId,
        tool_call_id: toolCallId,
        hits: check.hits,
      };
      note.payload_summary = `bypass on (would-block=${String(check.hits.length)})`.slice(0, 240);
      this.dispatch(note);
    } else if (check.decision === "rewritten") {
      const note = this.buildBaseEvent("agent-tool-use-redaction-hit", startedAt);
      note.payload_json = {
        handoff_id: this.opts.handoffId,
        tool_call_id: toolCallId,
        hits: check.hits,
      };
      note.payload_summary = `tool redaction hits: ${joinRuleIds(check.hits)}`.slice(0, 240);
      this.dispatch(note);
    }
  }

  private dispatchToolResultBlocked(
    toolCallId: string,
    startedAt: number,
    hits: RedactionHit[],
  ): void {
    const blocked = this.buildBaseEvent("agent-tool-result-blocked", startedAt);
    blocked.payload_json = {
      handoff_id: this.opts.handoffId,
      tool_call_id: toolCallId,
      hits,
      decision: "blocked",
      redacted_message: MAESTRO_TOOL_RESULT_BLOCKED_SENTINEL,
    };
    blocked.payload_summary = `tool result blocked by ${joinRuleIds(hits)}`.slice(0, 240);
    this.dispatch(blocked);
  }

  private dispatchToolResultRedactionNote(
    toolCallId: string,
    startedAt: number,
    check: MaestroRedactionResultObject,
  ): void {
    if (check.bypassed) {
      const note = this.buildBaseEvent("agent-tool-result-redaction-bypassed", startedAt);
      note.payload_json = {
        handoff_id: this.opts.handoffId,
        tool_call_id: toolCallId,
        hits: check.hits,
      };
      note.payload_summary = `bypass on (would-block=${String(check.hits.length)})`.slice(0, 240);
      this.dispatch(note);
    } else if (check.decision === "rewritten") {
      const note = this.buildBaseEvent("agent-tool-result-redaction-hit", startedAt);
      note.payload_json = {
        handoff_id: this.opts.handoffId,
        tool_call_id: toolCallId,
        hits: check.hits,
      };
      note.payload_summary = `tool result redaction hits: ${joinRuleIds(check.hits)}`.slice(0, 240);
      this.dispatch(note);
    }
  }

  private buildBaseEvent(eventType: string, startedAt: number): ObservedDispatchEvent {
    const event: ObservedDispatchEvent = {
      ts: new Date(startedAt).toISOString(),
      source: "agentchat",
      source_detail: this.opts.agentName,
      project_id: this.opts.projectId,
      user_id: "local-user",
      machine_id: "local",
      session_id: this.opts.chainId ?? this.opts.handoffId,
      event_type: eventType,
      lane: this.opts.lane,
      provider: this.opts.provider,
      model: this.opts.model,
      latency_ms: Date.now() - startedAt,
      payload_json: {},
      payload_summary: "",
    };
    if (this.opts.triggeredByEventId) {
      event.triggered_by_event_id = this.opts.triggeredByEventId;
    }
    return event;
  }

  private dispatch(event: ObservedDispatchEvent): void {
    const p = this.opts
      .observe(event)
      .then(() => {
        this.stats.sent++;
      })
      .catch((err: unknown) => {
        this.stats.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        const body = readErrorBody(err);
        const bodySuffix = body === undefined ? "" : ` body=${JSON.stringify(body)}`;
        console.error(`capture-port: observe failed: ${msg}${bodySuffix}`);
      })
      .finally(() => {
        this.inFlight.delete(p);
      });
    this.inFlight.add(p);
  }
}
