import { createReadStream, createWriteStream, existsSync, readdirSync, unlinkSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const ONE_DAY_MS = 86_400_000;
const WARNED_TAGS = new Set<string>();

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function utcDayStartMs(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function deriveBasename(livePath: string): string {
  return basename(livePath).replace(/\.jsonl$/, "");
}

export function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rotationNameRe(basenameValue: string): RegExp {
  // Optional trailing segment covers pid- (and pid+timestamp-) suffixed archives
  // produced when multiple penumbra-mcp processes rotate the shared log.
  return new RegExp(
    `^${escapeRegExp(basenameValue)}\\.(\\d{4}-\\d{2}-\\d{2})(?:\\.[\\w-]+)?\\.jsonl(?:\\.gz)?$`,
  );
}

function errnoCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return "";
}

async function pipeToGz(stagedPath: string, gzPath: string): Promise<void> {
  await pipeline(
    createReadStream(stagedPath),
    createGzip(),
    createWriteStream(gzPath, { mode: 0o600, flags: "wx" }),
  );
}

function warnOnce(tag: string, message: string, error: unknown): void {
  if (WARNED_TAGS.has(tag)) return;
  WARNED_TAGS.add(tag);
  console.error(`[mcp:invocation-rotation] ${message}; further ${tag} failures suppressed`, {
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function compressStaged(stagedPath: string): Promise<string> {
  const primaryGz = `${stagedPath}.gz`;
  let gzPath = primaryGz;
  try {
    await pipeToGz(stagedPath, primaryGz);
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
    // Another rotator already produced the archive at the same path; fall
    // back to a uniquely-suffixed name so we never clobber a prior archive.
    const stagedNoExt = stagedPath.replace(/\.jsonl$/, "");
    const fallback = `${stagedNoExt}-${String(Date.now())}.jsonl.gz`;
    await pipeToGz(stagedPath, fallback);
    gzPath = fallback;
  }
  await unlink(stagedPath);
  return gzPath;
}

/** Rotates `<basename>.jsonl` into a dated gzip and returns the gzip path, or null when no live file exists. */
export async function rotateIfNeeded(
  livePath: string,
  forDate: Date = new Date(),
): Promise<string | null> {
  if (!existsSync(livePath)) return null;

  const day = dateKey(forDate);
  const dir = dirname(livePath);
  const base = deriveBasename(livePath);
  const stagedPath = join(dir, `${base}.${day}.jsonl`);

  await rename(livePath, stagedPath);
  try {
    return await compressStaged(stagedPath);
  } catch (error) {
    try {
      await unlink(stagedPath);
    } catch (unlinkError) {
      warnOnce(
        "rotation-cleanup",
        `failed to remove staged plaintext at ${stagedPath}`,
        unlinkError,
      );
    }
    throw error;
  }
}

/** Deletes only dated invocation rotation files older than `retainDays`, while leaving non-matching files untouched. */
export function pruneOldRotations(dir: string, retainDays: number, basenameValue: string): void {
  const nameRe = rotationNameRe(basenameValue);
  const cutoffUtcDayMs = utcDayStartMs(new Date()) - retainDays * ONE_DAY_MS;
  for (const name of readdirSync(dir)) {
    const match = nameRe.exec(name);
    if (!match) continue;

    const rotatedDayMs = Date.parse(`${match[1] ?? ""}T00:00:00.000Z`);
    if (!Number.isFinite(rotatedDayMs)) continue;
    if (rotatedDayMs < cutoffUtcDayMs) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // best-effort prune
      }
    }
  }
}

// Backward-compatible helper for tests that need a full rotate+compress path.
export async function rotateAndPrune(
  livePath: string,
  retainDays: number,
  forDate: Date = new Date(),
): Promise<string | null> {
  const gzPath = await rotateIfNeeded(livePath, forDate);
  pruneOldRotations(dirname(livePath), retainDays, deriveBasename(livePath));
  return gzPath;
}
