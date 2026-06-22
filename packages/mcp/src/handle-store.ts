import { randomUUID } from "node:crypto";

interface HandleEntry {
  content: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class HandleStore {
  private entries = new Map<string, HandleEntry>();
  private readonly ttlMs: number;

  constructor({ ttlMs = 10 * 60 * 1000 }: { ttlMs?: number } = {}) {
    this.ttlMs = ttlMs;
  }

  put(content: string): string {
    const id = randomUUID();
    const timer = setTimeout(() => this.entries.delete(id), this.ttlMs);
    if (typeof timer.unref === "function") timer.unref();
    this.entries.set(id, { content, expiresAt: Date.now() + this.ttlMs, timer });
    return id;
  }

  get(id: string): string | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      clearTimeout(entry.timer);
      this.entries.delete(id);
      return undefined;
    }
    return entry.content;
  }

  keys(): string[] {
    const now = Date.now();
    return Array.from(this.entries.entries())
      .filter(([, e]) => now <= e.expiresAt)
      .map(([k]) => k);
  }

  close(): void {
    for (const { timer } of this.entries.values()) clearTimeout(timer);
    this.entries.clear();
  }
}
