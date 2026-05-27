import { chmodSync, createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_MAX_BYTES_PER_DAY = 100 * 1024 * 1024;

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

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function openInvocationSink(filePath: string, options: InvocationSinkOptions = {}): InvocationSink {
  const maxBytesPerDay = options.maxBytesPerDay ?? DEFAULT_MAX_BYTES_PER_DAY;
  const parentDir = dirname(filePath);

  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  chmodSync(parentDir, 0o700);

  let stream: WriteStream | null = createWriteStream(filePath, {
    mode: 0o600,
    flags: 'a',
    encoding: 'utf8',
  });
  let currentDay = dayStamp(new Date());
  let bytesToday = 0;

  return {
    write(row) {
      if (stream === null) {
        return;
      }

      const nowDay = dayStamp(new Date());
      if (nowDay !== currentDay) {
        currentDay = nowDay;
        bytesToday = 0;
      }

      const line = `${JSON.stringify(row)}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (bytesToday + lineBytes > maxBytesPerDay) {
        return;
      }

      stream.write(line);
      bytesToday += lineBytes;
    },
    close() {
      if (stream === null) {
        return Promise.resolve();
      }

      const open = stream;
      stream = null;
      return new Promise((resolve, reject) => {
        open.end((err: Error | null | undefined) => {
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
