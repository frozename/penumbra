import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const ROTATION_NAME_RE = /^mcp-invocations\.(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/;
const ONE_DAY_MS = 86_400_000;

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function utcDayStartMs(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

/** Rotates `mcp-invocations.jsonl` into a dated gzip and returns the gzip path, or null when no live file exists. */
export async function rotateIfNeeded(
  livePath: string,
  forDate: Date = new Date(),
): Promise<string | null> {
  if (!existsSync(livePath)) return null;

  const day = dateKey(forDate);
  const dir = dirname(livePath);
  const stagedPath = join(dir, `mcp-invocations.${day}.jsonl`);
  const gzPath = `${stagedPath}.gz`;

  try {
    renameSync(livePath, stagedPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EXDEV') throw error;
    copyFileSync(livePath, stagedPath);
    unlinkSync(livePath);
  }

  await pipeline(
    createReadStream(stagedPath),
    createGzip(),
    createWriteStream(gzPath, { mode: 0o600 }),
  );
  unlinkSync(stagedPath);
  return gzPath;
}

/** Deletes only dated invocation gzip files older than `retainDays`, while leaving non-matching files untouched. */
export async function pruneOldRotations(dir: string, retainDays: number): Promise<void> {
  const cutoffUtcDayMs = utcDayStartMs(new Date()) - retainDays * ONE_DAY_MS;
  for (const name of readdirSync(dir)) {
    const match = ROTATION_NAME_RE.exec(name);
    if (!match) continue;

    const rotatedDayMs = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(rotatedDayMs)) continue;
    if (rotatedDayMs < cutoffUtcDayMs) {
      unlinkSync(join(dir, name));
    }
  }
}
