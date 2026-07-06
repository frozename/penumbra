import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import { compressStaged, pruneOldRotations } from "./invocation-rotation.js";

const DEFAULT_MAX_BYTES_PER_DAY = 100 * 1024 * 1024;
const WRITE_BACKPRESSURE_THRESHOLD = 1 * 1024 * 1024;
const ROTATION_RETAIN_DAYS = 14;
const MAX_PENDING_DURING_ROTATION = 10_000;

export interface InvocationRow {
  ts: string;
  pid: number;
  tool: string;
  origin: string;
  args_bytes: number;
  result_bytes: number;
  duration_ms: number;
  ok: boolean;
  error_kind: string | null;
}

export interface InvocationSink {
  write(row: InvocationRow): void;
  close(): Promise<void>;
}

export interface InvocationSinkOptions {
  maxBytesPerDay?: number;
}

interface InvocationSinkTestHooks {
  testHooks?: {
    now?: () => Date;
    pid?: () => number;
    compressStaged?: (stagedPath: string) => Promise<string>;
    onSyncWrite?: () => void;
    pauseBeforeReopen?: () => Promise<void>;
    onRotationReopened?: () => void;
    onRotationIdle?: () => void;
    maxPendingDuringRotation?: number;
  };
}

export interface InvocationSinkTestOptions extends InvocationSinkOptions, InvocationSinkTestHooks {}

function isoDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function deriveRotationBasename(filePath: string): string {
  return basename(filePath).replace(/\.jsonl$/, "");
}

type ClosableWriteStream = Pick<WriteStream, "once" | "end">;

export function closeWriteStream(stream: ClosableWriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.once("finish", () => {
      resolve();
    });
    stream.end();
  });
}

function chmodNewlyCreatedSegments(firstCreated: string, finalDir: string): void {
  // mkdirSync(recursive: true) returns the shallowest newly-created path or undefined.
  // We chmod from that path down to finalDir, never touching pre-existing ancestors.
  chmodSync(firstCreated, 0o700);
  const rel = finalDir.slice(firstCreated.length);
  if (!rel) return;
  let current = firstCreated;
  for (const seg of rel.split(sep).filter(Boolean)) {
    current = join(current, seg);
    chmodSync(current, 0o700);
  }
}

function serializeRow(row: InvocationRow): string {
  // TS structural typing erases at runtime; pick exactly the 8 contract fields
  // so a caller passing a wider object cannot leak payloads into the log.
  return `${JSON.stringify({
    ts: row.ts,
    pid: row.pid,
    tool: row.tool,
    origin: row.origin,
    args_bytes: row.args_bytes,
    result_bytes: row.result_bytes,
    duration_ms: row.duration_ms,
    ok: row.ok,
    error_kind: row.error_kind,
  })}\n`;
}

function errnoCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return "";
}

class InvocationSinkImpl implements InvocationSink {
  private readonly maxBytesPerDay: number;
  private readonly parentDir: string;
  private readonly rotationBasename: string;
  private readonly now: () => Date;
  private readonly pid: () => number;
  private readonly compressStagedFn: (stagedPath: string) => Promise<string>;
  private readonly maxPendingDuringRotation: number;
  private readonly warned = new Set<string>();
  private readonly filePath: string;
  private readonly options: InvocationSinkTestOptions;

  private stream: WriteStream | null = null;
  private bytesToday = 0;
  private openDay: string;
  private rotating = false;
  private rotationPromise: Promise<void> | null = null;
  private readonly pendingDuringRotation: string[] = [];
  private droppedDuringRotation = 0;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private isClosing = false;
  private closePromise: Promise<void> | null = null;

  constructor(filePath: string, options: InvocationSinkTestOptions) {
    this.filePath = filePath;
    this.options = options;
    this.maxBytesPerDay = options.maxBytesPerDay ?? DEFAULT_MAX_BYTES_PER_DAY;
    this.parentDir = dirname(filePath);
    this.rotationBasename = deriveRotationBasename(filePath);
    this.now = options.testHooks?.now ?? ((): Date => new Date());
    this.pid = options.testHooks?.pid ?? ((): number => process.pid);
    this.compressStagedFn = options.testHooks?.compressStaged ?? compressStaged;
    this.maxPendingDuringRotation =
      options.testHooks?.maxPendingDuringRotation ?? MAX_PENDING_DURING_ROTATION;

    const firstCreated = mkdirSync(this.parentDir, { recursive: true, mode: 0o700 });
    if (firstCreated !== undefined) {
      chmodNewlyCreatedSegments(firstCreated, this.parentDir);
    }
    this.openDay = isoDateKey(this.now());
    this.openStream(true);
  }

  write(row: InvocationRow): void {
    if (this.isClosing) return;
    const line = serializeRow(row);
    if (this.rotating) {
      this.enqueuePending(line);
      return;
    }
    if (this.stream === null) return;
    const today = isoDateKey(this.now());
    if (today !== this.openDay) {
      this.enqueuePending(line);
      this.startRotation();
      return;
    }
    this.writeLine(line, true);
  }

  async close(): Promise<void> {
    if (this.closePromise !== null) {
      await this.closePromise;
      return;
    }
    this.isClosing = true;
    this.closePromise = this.runClose();
    await this.closePromise;
  }

  private async runClose(): Promise<void> {
    if (this.rotationPromise !== null) {
      await this.rotationPromise;
    }
    this.flushPending();
    await this.closeActiveStream().catch((error: unknown) => {
      this.warnOnce("close", "failed closing sink stream", error);
    });
    if (this.backgroundTasks.size > 0) {
      await Promise.allSettled(Array.from(this.backgroundTasks));
    }
  }

  private warnOnce(tag: string, message: string, error: unknown): void {
    if (this.warned.has(tag)) return;
    this.warned.add(tag);
    console.error(`[mcp:invocation-sink] ${message}; further ${tag} failures suppressed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private openStream(seedFromExisting: boolean): void {
    const preExisted = existsSync(this.filePath);
    if (seedFromExisting && preExisted) {
      const stats = statSync(this.filePath);
      const today = isoDateKey(this.now());
      const mtimeDay = isoDateKey(stats.mtime);
      this.openDay = mtimeDay > today ? today : mtimeDay;
      this.bytesToday = stats.size;
    } else {
      this.openDay = isoDateKey(this.now());
      this.bytesToday = 0;
    }

    this.stream = createWriteStream(this.filePath, {
      mode: 0o600,
      flags: "a",
      encoding: "utf8",
    });
    // createWriteStream's `mode` is honored when creating a NEW file, but ignored
    // when opening an existing file with 'a'. For pre-existing files, harden the
    // permissions explicitly so a loose-umask file from a prior run can't stay world-readable.
    if (preExisted) {
      chmodSync(this.filePath, 0o600);
    }
    this.stream.on("error", () => {
      // A disk-failure error event would otherwise crash the process. The sink is
      // best-effort observability; surface the failure by closing rather than throwing.
      this.stream = null;
    });
  }

  private closeActiveStream(): Promise<void> {
    if (this.stream === null) return Promise.resolve();
    const activeStream = this.stream;
    this.stream = null;
    return closeWriteStream(activeStream);
  }

  private writeLine(line: string, countAsSynchronous: boolean): void {
    if (this.stream === null) return;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this.bytesToday + lineBytes > this.maxBytesPerDay) return;
    if (this.stream.writableLength + lineBytes > WRITE_BACKPRESSURE_THRESHOLD) return;

    const accepted = this.stream.write(line);
    if (accepted || this.stream.writableLength > 0) {
      this.bytesToday += lineBytes;
      if (countAsSynchronous) {
        this.options.testHooks?.onSyncWrite?.();
      }
    }
  }

  private enqueuePending(line: string): void {
    if (this.pendingDuringRotation.length >= this.maxPendingDuringRotation) {
      this.droppedDuringRotation += 1;
      this.warnOnce(
        "pending-overflow",
        "pending-overflow: dropping invocation line during rotation",
        "full",
      );
      return;
    }
    this.pendingDuringRotation.push(line);
  }

  private flushPending(): void {
    if (this.stream === null || this.pendingDuringRotation.length === 0) return;
    const pending = this.pendingDuringRotation.splice(0);
    for (const line of pending) {
      this.writeLine(line, false);
    }
  }

  private startRotation(): void {
    if (this.rotating) return;
    this.rotating = true;
    const previousDay = this.openDay;
    this.rotationPromise = this.runRotation(previousDay)
      .catch((error: unknown) => {
        this.warnOnce("rotate", "write-path rotation failed", error);
      })
      .finally(() => {
        if (this.droppedDuringRotation > 0) {
          console.error(
            `[mcp:invocation-sink] rotation overflow: dropped ${String(this.droppedDuringRotation)} invocation lines during rotation`,
          );
          this.droppedDuringRotation = 0;
        }
        this.rotating = false;
        this.flushPending();
        this.options.testHooks?.onRotationIdle?.();
      });
  }

  private async runRotation(previousDay: string): Promise<void> {
    try {
      await this.closeActiveStream();
    } catch (error: unknown) {
      this.warnOnce("close-before-rotate", "failed closing sink before rotation", error);
    }

    const stagedPath = this.stagePreviousDay(previousDay);

    if (this.options.testHooks?.pauseBeforeReopen) {
      await this.options.testHooks.pauseBeforeReopen();
    }

    try {
      this.openStream(false);
      this.options.testHooks?.onRotationReopened?.();
    } catch (error: unknown) {
      this.warnOnce("open-after-rotate", "failed reopening sink after rotation", error);
      this.stream = null;
    }

    if (stagedPath !== null) {
      this.runBackgroundCompress(stagedPath);
    }
  }

  private stagePreviousDay(previousDay: string): string | null {
    // Include pid so concurrent penumbra-mcp processes rotating the shared log
    // never compute the same destination — otherwise renameSync clobbers the
    // first archive with the second process's fresh (empty) live file.
    const stagedPath = join(
      this.parentDir,
      `${this.rotationBasename}.${previousDay}.${String(this.pid())}.jsonl`,
    );
    try {
      renameSync(this.filePath, stagedPath);
      return stagedPath;
    } catch (error: unknown) {
      const code = errnoCode(error);
      if (code !== "ENOENT") {
        this.warnOnce("rename-before-rotate", "failed staging invocation log for rotation", error);
      }
      return null;
    }
  }

  private runBackgroundCompress(stagedPath: string): void {
    const task = (async (): Promise<void> => {
      await this.compressStagedFn(stagedPath);
      pruneOldRotations(this.parentDir, ROTATION_RETAIN_DAYS, this.rotationBasename);
    })();
    this.backgroundTasks.add(task);
    void task
      .catch((error: unknown) => {
        this.warnOnce(
          "rotate-background",
          "failed background invocation rotation maintenance",
          error,
        );
      })
      .finally(() => {
        this.backgroundTasks.delete(task);
      });
  }
}

export function openInvocationSink(
  filePath: string,
  options: InvocationSinkOptions = {},
): InvocationSink {
  return new InvocationSinkImpl(filePath, options);
}

export function openInvocationSinkForTest(
  filePath: string,
  options: InvocationSinkTestOptions = {},
): InvocationSink {
  return new InvocationSinkImpl(filePath, options);
}
