import type { DispatchEventInput } from '@penumbra/core';
import type { RuntimeThoughtsConfig } from './thought-config.js';

export interface RecordThoughtInput {
  handoffId: string;
  adapter: string;
  agentName: string;
  text: string;
  tokenCount?: number;
  ts?: string;
}

export interface ThoughtCaptureDeps {
  config: RuntimeThoughtsConfig;
  enqueue: (event: DispatchEventInput) => void;
  workerId?: string | null;
  now?: () => Date;
}

const REDACTION_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

function redactCredentials(text: string): string {
  let out = text;
  for (const pattern of REDACTION_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

export class ThoughtCapture {
  private readonly perDispatch = new Map<string, { sequence: number; bytesUsed: number; streamCapHit: boolean }>();

  constructor(private readonly deps: ThoughtCaptureDeps) {}

  isAdapterEnabled(adapter: string, agentName: string): boolean {
    if (!this.deps.config.enabled) return false;
    const override = this.deps.config.capture.perAgentOverrides[agentName];
    if (override === false) return false;
    if (override === true) return true;
    return this.deps.config.capture.adapters[adapter] === true;
  }

  recordThought(input: RecordThoughtInput): void {
    if (!this.isAdapterEnabled(input.adapter, input.agentName)) return;

    const state = this.perDispatch.get(input.handoffId) ?? { sequence: 0, bytesUsed: 0, streamCapHit: false };
    if (state.streamCapHit) return;

    const ts = (input.ts ?? (this.deps.now ?? (() => new Date()))().toISOString());
    const sequence = state.sequence;
    state.sequence = sequence + 1;

    const redacted = redactCredentials(input.text);
    const cap = this.deps.config.capture.maxTextBytes;
    const truncated = redacted.length > cap ? redacted.slice(0, cap) : redacted;
    const droppedFromRow = redacted.length - truncated.length;

    const remaining = this.deps.config.capture.maxStreamBytes - state.bytesUsed;
    if (truncated.length > remaining) {
      const totalDropped = (redacted.length) + 0;
      state.streamCapHit = true;
      this.perDispatch.set(input.handoffId, state);
      this.deps.enqueue({
        handoff_id: input.handoffId,
        worker_id: this.deps.workerId ?? null,
        source: 'worker',
        kind: 'agent.thought.overflow',
        ts,
        meta: { sequence_n: -1, bytes_dropped: totalDropped },
      });
      return;
    }

    state.bytesUsed += truncated.length;
    this.perDispatch.set(input.handoffId, state);

    const thoughtMeta: Record<string, unknown> = {
      sequence_n: sequence,
      adapter: input.adapter,
      agent_name: input.agentName,
      text: truncated,
    };
    if (input.tokenCount !== undefined) thoughtMeta.token_count = input.tokenCount;

    this.deps.enqueue({
      handoff_id: input.handoffId,
      worker_id: this.deps.workerId ?? null,
      source: 'worker',
      kind: 'agent.thought',
      ts,
      meta: thoughtMeta,
    });

    if (droppedFromRow > 0) {
      this.deps.enqueue({
        handoff_id: input.handoffId,
        worker_id: this.deps.workerId ?? null,
        source: 'worker',
        kind: 'agent.thought.overflow',
        ts,
        meta: { sequence_n: sequence, bytes_dropped: droppedFromRow },
      });
    }
  }

  resetDispatch(handoffId: string): void {
    this.perDispatch.delete(handoffId);
  }
}
