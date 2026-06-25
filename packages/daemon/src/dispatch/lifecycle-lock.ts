export interface LockHolder {
  handoff_id: string;
  acquired_at: number;
}

export class LifecycleLock {
  private holder: LockHolder | null = null;
  private waiters: { handoffId: string; resolve: (holder: LockHolder | null) => void }[] = [];
  readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  private reclaimIfExpired(): void {
    if (this.holder !== null && Date.now() - this.holder.acquired_at >= this.ttlMs) {
      this.holder = null;
      this._drain();
    }
  }

  getHolder(): LockHolder | null {
    this.reclaimIfExpired();
    return this.holder;
  }

  isHeld(): boolean {
    this.reclaimIfExpired();
    return this.holder !== null;
  }

  async acquire(handoffId: string): Promise<() => void> {
    this.reclaimIfExpired();
    if (this.holder === null) {
      this.holder = { handoff_id: handoffId, acquired_at: Date.now() };
      return this._makeRelease(this.holder);
    }
    const granted = await new Promise<LockHolder | null>((resolve) => {
      this.waiters.push({ handoffId, resolve });
    });
    if (granted !== null && this.holder === granted) {
      return this._makeRelease(granted);
    }
    this.holder = { handoff_id: handoffId, acquired_at: Date.now() };
    return this._makeRelease(this.holder);
  }

  private _makeRelease(grantedHolder: LockHolder | null): () => void {
    let released = false;
    return () => {
      if (released) return;
      // A release from a holder that was since TTL-evicted (and replaced by a new
      // holder) must be a no-op: clearing this.holder here would wipe the current
      // holder's lease and open a concurrent-land window.
      if (this.holder !== grantedHolder) return;
      released = true;
      this.holder = null;
      this._drain();
    };
  }

  private _drain(): void {
    const next = this.waiters.shift();
    if (!next) return;
    const holder = { handoff_id: next.handoffId, acquired_at: Date.now() };
    this.holder = holder;
    next.resolve(holder);
  }

  reset(): void {
    this.holder = null;
    const waiters = [...this.waiters];
    this.waiters.length = 0;
    for (const w of waiters) w.resolve(null);
  }
}

const rawTtl = parseInt(process.env.PENUMBRA_LIFECYCLE_LOCK_TIMEOUT_MS ?? "", 10);
export const lifecycleLock = new LifecycleLock(
  Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 300_000,
);

export function resetLifecycleLock(): void {
  lifecycleLock.reset();
}
