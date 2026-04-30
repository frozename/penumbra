export interface CapturePortOpts {
  observe: (event: any) => Promise<{ event_id: string }>;
  chainId: string | null;
  handoffId: string;
  projectId: string | null;
  agentName: string;
  provider: string | null;
  model: string | null;
  lane: 'local' | 'cloud' | 'cli-subscription' | 'unknown';
  triggeredByEventId?: string | null;
}

interface RegularNotificationEvent {
  kind:
    | 'agent_message_chunk'
    | 'agent_thought_chunk'
    | 'tool_call'
    | 'tool_call_update'
    | 'usage_update';
  toolCallId?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';
  content?: string;
  input?: unknown;
  output?: unknown;
  used?: number;
  size?: number;
  cost?: { amount: number; currency: string };
}

export type NotificationEvent =
  | RegularNotificationEvent
  | {
      kind: 'capacity_error';
      provider: string;
      model: string | null;
      raw: string;
    };

interface ChunkBuffer {
  kind: 'agent_message_chunk' | 'agent_thought_chunk';
  text: string;
  startedAt: number;
}

interface HeldToolCall {
  startedAt: number;
  input: unknown;
}

const TRUNCATE_LIMIT = 8 * 1024;

function truncateIfNeeded(value: unknown): { value: unknown; truncated: boolean; bytesTotal: number } {
  if (value === undefined || value === null) return { value: value ?? null, truncated: false, bytesTotal: 0 };
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= TRUNCATE_LIMIT) return { value, truncated: false, bytesTotal: bytes };
  const prefix = json.slice(0, TRUNCATE_LIMIT);
  return { value: { __truncated_string: prefix }, truncated: true, bytesTotal: bytes };
}

export class CapturePort {
  private opts: CapturePortOpts;
  private chunkBuffer: ChunkBuffer | null = null;
  private toolCalls = new Map<string, HeldToolCall>();
  private inFlight = new Set<Promise<unknown>>();
  private stats = { sent: 0, failed: 0 };
  private closed = false;
  private usageWarnedMissing = false;

  constructor(opts: CapturePortOpts) {
    this.opts = opts;
  }

  emit(ev: NotificationEvent): void {
    if (this.closed) return;
    try {
      if (ev.kind === 'agent_message_chunk' || ev.kind === 'agent_thought_chunk') {
        this.handleChunk(ev);
      } else if (ev.kind === 'tool_call') {
        this.handleToolCall(ev);
      } else if (ev.kind === 'tool_call_update') {
        this.handleToolCallUpdate(ev);
      } else if (ev.kind === 'usage_update') {
        this.handleUsageUpdate(ev);
      } else if (ev.kind === 'capacity_error') {
        this.handleCapacityError(ev);
      }
    } catch {
      // emit never throws
    }
  }

  async flush(): Promise<void> {
    this.flushChunkBuffer();
    this.emitOrphans();
    await Promise.allSettled([...this.inFlight]);
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  getStats(): { sent: number; failed: number } {
    return { ...this.stats };
  }

  private handleChunk(ev: RegularNotificationEvent): void {
    const kind = ev.kind as 'agent_message_chunk' | 'agent_thought_chunk';
    if (this.chunkBuffer && this.chunkBuffer.kind !== kind) {
      this.flushChunkBuffer();
    }
    if (!this.chunkBuffer) {
      this.chunkBuffer = { kind, text: '', startedAt: Date.now() };
    }
    this.chunkBuffer.text += ev.content ?? '';
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
    const terminal = ev.status === 'completed' || ev.status === 'failed' || ev.status === 'canceled';
    if (!terminal) return;
    const held = this.toolCalls.get(ev.toolCallId);
    if (!held) return;
    this.toolCalls.delete(ev.toolCallId);
    if (this.chunkBuffer) {
      this.flushChunkBuffer();
    }
    this.emitToolRow(ev.toolCallId, held, ev.status as string, ev.output ?? null, false);
  }

  private handleUsageUpdate(ev: RegularNotificationEvent): void {
    if (typeof ev.used !== 'number' || !Number.isFinite(ev.used)) {
      if (!this.usageWarnedMissing) {
        console.error('capture-port: usage_update missing/invalid `used`, dropping');
        this.usageWarnedMissing = true;
      }
      return;
    }
    const event = this.buildBaseEvent('usage-update', Date.now());
    let cost_usd: number | null = null;
    if (ev.cost) {
      if (ev.cost.currency === 'USD') {
        cost_usd = ev.cost.amount;
      } else {
        console.error(`capture-port: usage_update cost ${ev.cost.currency} not converted (skipped)`);
      }
    }
    event.cost_usd = cost_usd;
    event.payload_json = {
      handoff_id: this.opts.handoffId,
      used: ev.used,
      size: ev.size,
      currency: ev.cost?.currency ?? null,
      raw_cost: ev.cost ?? null,
      source_kind: 'acp-wire',
    };
    event.payload_summary = ev.cost
      ? `${ev.used}/${ev.size} tokens, ${ev.cost.amount} ${ev.cost.currency}`.slice(0, 240)
      : `${ev.used}/${ev.size} tokens`.slice(0, 240);
    this.dispatch(event);
  }

  private handleCapacityError(ev: Extract<NotificationEvent, { kind: 'capacity_error' }>): void {
    const event = this.buildBaseEvent('provider-capacity-error', Date.now());
    event.provider = ev.provider || this.opts.provider;
    event.model = ev.model ?? this.opts.model;
    event.payload_json = {
      handoff_id: this.opts.handoffId,
      provider: ev.provider,
      model: ev.model,
      raw: ev.raw,
      source_kind: 'cli-spawn-stderr',
    };
    event.payload_summary = `${ev.provider}/${ev.model ?? 'unknown'} capacity error`.slice(0, 240);
    this.dispatch(event);
  }

  private flushChunkBuffer(): void {
    const buf = this.chunkBuffer;
    if (!buf) return;
    this.chunkBuffer = null;
    const eventType = buf.kind === 'agent_message_chunk' ? 'agent-response' : 'agent-thought';
    const event = this.buildBaseEvent(eventType, buf.startedAt);
    event.payload_json = { handoff_id: this.opts.handoffId, text: buf.text };
    event.payload_summary = buf.text.slice(0, 240);
    this.dispatch(event);
  }

  private emitOrphans(): void {
    for (const [toolCallId, held] of this.toolCalls) {
      this.emitToolRow(toolCallId, held, 'canceled', null, true);
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
    const inputResult = truncateIfNeeded(held.input);
    const outputResult = truncateIfNeeded(output);
    const event = this.buildBaseEvent('agent-tool-use', held.startedAt);
    const payload: any = {
      handoff_id: this.opts.handoffId,
      tool_call_id: toolCallId,
      input: inputResult.value,
      output: outputResult.value,
      status,
    };
    if (orphaned) payload.lifecycle = 'orphaned';
    const anyTruncated = inputResult.truncated || outputResult.truncated;
    if (anyTruncated) {
      payload.truncated = true;
      payload.bytes_total = (inputResult.truncated ? inputResult.bytesTotal : 0) +
        (outputResult.truncated ? outputResult.bytesTotal : 0);
    }
    event.payload_json = payload;
    event.payload_summary = `${toolCallId} ${status}`.slice(0, 240);
    this.dispatch(event);
  }

  private buildBaseEvent(eventType: string, startedAt: number): any {
    const event: any = {
      ts: new Date(startedAt).toISOString(),
      source: 'agentchat',
      source_detail: this.opts.agentName,
      project_id: this.opts.projectId,
      user_id: 'local-user',
      machine_id: 'local',
      session_id: this.opts.chainId ?? this.opts.handoffId,
      event_type: eventType,
      lane: this.opts.lane,
      provider: this.opts.provider,
      model: this.opts.model,
      latency_ms: Date.now() - startedAt,
      payload_json: {},
      payload_summary: '',
    };
    if (this.opts.triggeredByEventId) {
      event.triggered_by_event_id = this.opts.triggeredByEventId;
    }
    return event;
  }

  private dispatch(event: any): void {
    const p = this.opts.observe(event)
      .then(() => { this.stats.sent++; })
      .catch((err: unknown) => {
        this.stats.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        const body = (err as any)?.body;
        const bodySuffix = body ? ` body=${JSON.stringify(body)}` : '';
        console.error(`capture-port: observe failed: ${msg}${bodySuffix}`);
      })
      .finally(() => { this.inFlight.delete(p); });
    this.inFlight.add(p);
  }
}
