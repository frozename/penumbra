export interface LockHolder {
  handoff_id: string;
  acquired_at: number;
}

class LifecycleLock {
  private holder: LockHolder | null = null;
  private waiters: Array<() => void> = [];
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
      return this._makeRelease();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.holder = { handoff_id: handoffId, acquired_at: Date.now() };
    return this._makeRelease();
  }

  private _makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holder = null;
      this._drain();
    };
  }

  private _drain(): void {
    const next = this.waiters.shift();
    if (next) next();
  }

  reset(): void {
    this.holder = null;
    const waiters = [...this.waiters];
    this.waiters.length = 0;
    for (const w of waiters) w();
  }
}

const rawTtl = parseInt(process.env.PENUMBRA_LIFECYCLE_LOCK_TIMEOUT_MS ?? "", 10);
export const lifecycleLock = new LifecycleLock(
  Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 300_000,
);

export function resetLifecycleLock(): void {
  lifecycleLock.reset();
}
