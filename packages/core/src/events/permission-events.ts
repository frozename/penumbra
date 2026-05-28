export type PermissionEventKind =
  | "permission.created"
  | "permission.decided"
  | "permission.expired";

export interface PermissionEvent {
  kind: PermissionEventKind;
  permission_id: string;
  ts: string;
  /** Event-specific payload — same shape the SSE wire serialises. */
  payload: Record<string, unknown>;
}

export interface EmittedPermissionEvent extends PermissionEvent {
  seq: number;
}

export type PermissionEventListener = (evt: EmittedPermissionEvent) => void;

export class PermissionEventBus {
  private listeners = new Set<PermissionEventListener>();
  private ring: EmittedPermissionEvent[] = [];
  private nextSeq = 1;
  private readonly ringSize: number;

  constructor(opts: { ringSize?: number } = {}) {
    this.ringSize = opts.ringSize ?? 256;
  }

  subscribe(fn: PermissionEventListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(evt: PermissionEvent): EmittedPermissionEvent {
    const stamped: EmittedPermissionEvent = { ...evt, seq: this.nextSeq++ };
    this.ring.push(stamped);
    if (this.ring.length > this.ringSize) {
      this.ring.splice(0, this.ring.length - this.ringSize);
    }
    for (const fn of this.listeners) {
      try {
        fn(stamped);
      } catch {
        /* one bad subscriber must not block others */
      }
    }
    return stamped;
  }

  /**
   * Returns events with seq > sinceSeq, or null if the requested seq has
   * already fallen out of the ring buffer (caller must re-fetch state).
   */
  replaySince(sinceSeq: number): EmittedPermissionEvent[] | null {
    if (this.ring.length === 0) return [];
    const earliest = this.ring[0]!.seq;
    if (sinceSeq < earliest - 1) return null;
    return this.ring.filter((e) => e.seq > sinceSeq);
  }
}
