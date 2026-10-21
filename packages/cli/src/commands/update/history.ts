import type { Clock, FsPort } from "./types.js";

const MOVE_RE = /\bfrom=([0-9a-f]{40}) to=([0-9a-f]{40})\b/;
const OK_RE = /\sok ([0-9a-f]{7,40})\b/;

/**
 * The commit before the most recent move that completed: a `from=<sha> to=<sha>`
 * line followed by `ok <to>` (this command, and the bash `penumbra-update` with a
 * short sha). Moves that were refused, aborted or rolled back never count, so the
 * default rollback target is a real move, not a no-op.
 */
export function lastCompletedFrom(text: string): string | null {
  let pending: { from: string; to: string } | null = null;
  let completed: string | null = null;
  for (const line of text.split("\n")) {
    const move = MOVE_RE.exec(line);
    if (move?.[1] && move[2]) {
      pending = { from: move[1], to: move[2] };
      continue;
    }
    const ok = OK_RE.exec(line)?.[1];
    if (pending && ok && pending.to.startsWith(ok)) completed = pending.from;
    if (line.trim() !== "") pending = null;
  }
  return completed;
}

export async function appendHistory(
  fs: FsPort,
  clock: Clock,
  path: string,
  entry: string,
): Promise<void> {
  await fs.appendText(path, `${new Date(clock.now()).toISOString()} ${entry}\n`);
}
