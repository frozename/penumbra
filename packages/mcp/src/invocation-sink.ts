import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  type WriteStream,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { compressStaged, pruneOldRotations } from './invocation-rotation.js';

const DEFAULT_MAX_BYTES_PER_DAY = 100 * 1024 * 1024;
const WRITE_BACKPRESSURE_THRESHOLD = 1 * 1024 * 1024;
const ROTATION_RETAIN_DAYS = 14;
const MAX_PENDING_DURING_ROTATION = 10_000;

export interface InvocationRow {
  ts: string;
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
  return basename(filePath).replace(/\.jsonl$/, '');
}

type ClosableWriteStream = Pick<WriteStream, 'once' | 'end'>;

export function closeWriteStream(stream: ClosableWriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.once('finish', () => resolve());
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

function openInvocationSinkInternal(
  filePath: string,
  options: InvocationSinkTestOptions = {},
): InvocationSink {
  const maxBytesPerDay = options.maxBytesPerDay ?? DEFAULT_MAX_BYTES_PER_DAY;
  const parentDir = dirname(filePath);
  const rotationBasename = deriveRotationBasename(filePath);
  const now = options.testHooks?.now ?? (() => new Date());
  const compressStagedFn = options.testHooks?.compressStaged ?? compressStaged;
  const maxPendingDuringRotation =
    options.testHooks?.maxPendingDuringRotation ?? MAX_PENDING_DURING_ROTATION;
  const warned = new Set<string>();

  function warnOnce(tag: string, message: string, error: unknown): void {
    if (warned.has(tag)) return;
    warned.add(tag);
    console.error(`[mcp:invocation-sink] ${message}; further ${tag} failures suppressed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const firstCreated = mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  if (firstCreated !== undefined) {
    chmodNewlyCreatedSegments(firstCreated, parentDir);
  }

  let stream: WriteStream | null = null;
  let bytesToday = 0;
  let openDay = isoDateKey(now());
  let rotating = false;
  let rotationPromise: Promise<void> | null = null;
  const pendingDuringRotation: string[] = [];
  let droppedDuringRotation = 0;
  const backgroundTasks = new Set<Promise<void>>();
  let isClosing = false;
  let closePromise: Promise<void> | null = null;

  function openStream(seedFromExisting: boolean): void {
    const preExisted = existsSync(filePath);
    if (seedFromExisting && preExisted) {
      const stats = statSync(filePath);
      const today = isoDateKey(now());
      const mtimeDay = isoDateKey(stats.mtime);
      openDay = mtimeDay > today ? today : mtimeDay;
      bytesToday = stats.size;
    } else {
      openDay = isoDateKey(now());
      bytesToday = 0;
    }

    stream = createWriteStream(filePath, {
      mode: 0o600,
      flags: 'a',
      encoding: 'utf8',
    });
    // createWriteStream's `mode` is honored when creating a NEW file, but ignored
    // when opening an existing file with 'a'. For pre-existing files, harden the
    // permissions explicitly so a loose-umask file from a prior run can't stay world-readable.
    if (preExisted) {
      chmodSync(filePath, 0o600);
    }
    stream.on('error', () => {
      // A disk-failure error event would otherwise crash the process. The sink is
      // best-effort observability; surface the failure by closing rather than throwing.
      stream = null;
    });
  }

  function closeActiveStream(): Promise<void> {
    if (stream === null) return Promise.resolve();
    const activeStream = stream;
    stream = null;
    return closeWriteStream(activeStream);
  }

  function serializeRow(row: InvocationRow): string {
    // TS structural typing erases at runtime; pick exactly the 8 contract fields
    // so a caller passing a wider object cannot leak payloads into the log.
    return `${JSON.stringify({
      ts: row.ts,
      tool: row.tool,
      origin: row.origin,
      args_bytes: row.args_bytes,
      result_bytes: row.result_bytes,
      duration_ms: row.duration_ms,
      ok: row.ok,
      error_kind: row.error_kind,
    })}\n`;
  }

  function writeLine(line: string, countAsSynchronous: boolean): void {
    if (stream === null) {
      return;
    }
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (bytesToday + lineBytes > maxBytesPerDay) {
      return;
    }
    if (stream.writableLength + lineBytes > WRITE_BACKPRESSURE_THRESHOLD) {
      return;
    }

    const accepted = stream.write(line);
    if (accepted || stream.writableLength > 0) {
      bytesToday += lineBytes;
      if (countAsSynchronous) {
        options.testHooks?.onSyncWrite?.();
      }
    }
  }

  function enqueuePending(line: string): void {
    if (pendingDuringRotation.length >= maxPendingDuringRotation) {
      droppedDuringRotation += 1;
      warnOnce('pending-overflow', 'pending-overflow: dropping invocation line during rotation', 'full');
      return;
    }
    pendingDuringRotation.push(line);
  }

  function flushPending(): void {
    if (stream === null || pendingDuringRotation.length === 0) {
      return;
    }
    const pending = pendingDuringRotation.splice(0);
    for (const line of pending) {
      writeLine(line, false);
    }
  }

  function startRotation(today: string): void {
    if (rotating) return;
    rotating = true;
    const previousDay = openDay;
    rotationPromise = (async () => {
      try {
        await closeActiveStream();
      } catch (error) {
        warnOnce('close-before-rotate', 'failed closing sink before rotation', error);
      }

      let stagedPath: string | null = null;
      stagedPath = join(parentDir, `${rotationBasename}.${previousDay}.jsonl`);
      try {
        renameSync(filePath, stagedPath);
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code)
            : '';
        if (code === 'ENOENT') {
          stagedPath = null;
        } else {
          warnOnce('rename-before-rotate', 'failed staging invocation log for rotation', error);
          stagedPath = null;
        }
      }

      if (options.testHooks?.pauseBeforeReopen) {
        await options.testHooks.pauseBeforeReopen();
      }

      try {
        openStream(false);
        options.testHooks?.onRotationReopened?.();
      } catch (error) {
        warnOnce('open-after-rotate', 'failed reopening sink after rotation', error);
        stream = null;
      }

      if (stagedPath !== null) {
        const stagedPathValue = stagedPath;
        const task = (async () => {
          await compressStagedFn(stagedPathValue);
          pruneOldRotations(parentDir, ROTATION_RETAIN_DAYS, rotationBasename);
        })();
        backgroundTasks.add(task);
        void task
          .catch((error) => {
          warnOnce('rotate-background', 'failed background invocation rotation maintenance', error);
          })
          .finally(() => {
            backgroundTasks.delete(task);
          });
      }
    })()
      .catch((error) => {
        warnOnce('rotate', 'write-path rotation failed', error);
      })
      .finally(() => {
        if (droppedDuringRotation > 0) {
          console.error(
            `[mcp:invocation-sink] rotation overflow: dropped ${droppedDuringRotation} invocation lines during rotation`,
          );
          droppedDuringRotation = 0;
        }
        rotating = false;
        flushPending();
        options.testHooks?.onRotationIdle?.();
      });
  }

  openStream(true);

  return {
    write(row) {
      if (isClosing) {
        return;
      }
      const line = serializeRow(row);
      if (rotating) {
        enqueuePending(line);
        return;
      }
      if (stream === null) {
        return;
      }
      const today = isoDateKey(now());
      if (today !== openDay) {
        enqueuePending(line);
        startRotation(today);
        return;
      }
      writeLine(line, true);
    },
    async close() {
      if (closePromise !== null) {
        return closePromise;
      }
      isClosing = true;
      closePromise = (async () => {
        if (rotationPromise !== null) {
          await rotationPromise;
        }
        flushPending();
        await closeActiveStream().catch((error) => {
          warnOnce('close', 'failed closing sink stream', error);
        });
        if (backgroundTasks.size > 0) {
          await Promise.allSettled(Array.from(backgroundTasks));
        }
      })();
      await closePromise;
    },
  };
}

export function openInvocationSink(filePath: string, options: InvocationSinkOptions = {}): InvocationSink {
  return openInvocationSinkInternal(filePath, options);
}

export function openInvocationSinkForTest(
  filePath: string,
  options: InvocationSinkTestOptions = {},
): InvocationSink {
  return openInvocationSinkInternal(filePath, options);
}
