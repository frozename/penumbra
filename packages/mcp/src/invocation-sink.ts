import { chmodSync, createWriteStream, existsSync, mkdirSync, statSync, type WriteStream } from 'node:fs';
import { dirname, join, sep } from 'node:path';

const DEFAULT_MAX_BYTES_PER_DAY = 100 * 1024 * 1024;
const WRITE_BACKPRESSURE_THRESHOLD = 1 * 1024 * 1024;

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

function isoDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
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

export function openInvocationSink(filePath: string, options: InvocationSinkOptions = {}): InvocationSink {
  const maxBytesPerDay = options.maxBytesPerDay ?? DEFAULT_MAX_BYTES_PER_DAY;
  const parentDir = dirname(filePath);

  const firstCreated = mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  if (firstCreated !== undefined) {
    chmodNewlyCreatedSegments(firstCreated, parentDir);
  }

  const preExisted = existsSync(filePath);
  let stream: WriteStream | null = createWriteStream(filePath, {
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

  // Seed bytesToday from existing file size when the file's date matches today,
  // so a process restart can't reset the daily cap to zero.
  let bytesToday = 0;
  if (preExisted) {
    const stats = statSync(filePath);
    if (isoDateKey(stats.mtime) === isoDateKey(new Date())) {
      bytesToday = stats.size;
    }
  }
  let currentDay = isoDateKey(new Date());

  return {
    write(row) {
      if (stream === null) {
        return;
      }

      const today = isoDateKey(new Date());
      if (today !== currentDay) {
        currentDay = today;
        bytesToday = 0;
      }

      // TS structural typing erases at runtime; pick exactly the 8 contract fields
      // so a caller passing a wider object cannot leak payloads into the log.
      const line = `${JSON.stringify({
        ts: row.ts,
        tool: row.tool,
        origin: row.origin,
        args_bytes: row.args_bytes,
        result_bytes: row.result_bytes,
        duration_ms: row.duration_ms,
        ok: row.ok,
        error_kind: row.error_kind,
      })}\n`;
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
      }
    },
    close() {
      if (stream === null) {
        return Promise.resolve();
      }

      const activeStream = stream;
      stream = null;
      return new Promise((resolve, reject) => {
        activeStream.end((err: Error | null | undefined) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}
