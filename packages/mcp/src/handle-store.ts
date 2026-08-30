import { randomUUID } from "node:crypto";

interface HandleEntry {
  content: string;
  bytes: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export const DEFAULT_HANDLE_STORE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export class HandleStore {
  private entries = new Map<string, HandleEntry>();
  private readonly ttlMs: number;
  private readonly maxTotalBytes: number;
  private totalBytes = 0;

  constructor({
    ttlMs = 10 * 60 * 1000,
    maxTotalBytes = DEFAULT_HANDLE_STORE_MAX_TOTAL_BYTES,
  }: { ttlMs?: number; maxTotalBytes?: number } = {}) {
    this.ttlMs = ttlMs;
    this.maxTotalBytes = maxTotalBytes;
  }

  put(content: string): string {
    const id = randomUUID();
    const bytes = Buffer.byteLength(content, "utf8");
    while (this.entries.size > 0 && this.totalBytes + bytes > this.maxTotalBytes) {
      const oldestId = this.entries.keys().next().value;
      if (oldestId === undefined) break;
      this.deleteEntry(oldestId);
    }
    const timer = setTimeout(() => {
      this.deleteEntry(id);
    }, this.ttlMs);
    if (typeof timer.unref === "function") timer.unref();
    this.entries.set(id, { content, bytes, expiresAt: Date.now() + this.ttlMs, timer });
    this.totalBytes += bytes;
    return id;
  }

  get(id: string): string | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.deleteEntry(id);
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
    this.totalBytes = 0;
  }

  private deleteEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    this.totalBytes -= entry.bytes;
  }
}
