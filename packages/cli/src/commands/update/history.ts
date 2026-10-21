import type { Clock, FsPort } from "./types.js";

/** Last `from=<sha>` in update-history.log: the commit before the most recent move. */
export function lastHistoryFrom(text: string): string | null {
  let last: string | null = null;
  for (const match of text.matchAll(/\bfrom=([0-9a-f]{40})\b/g)) {
    last = match[1] ?? last;
  }
  return last;
}

export async function appendHistory(
  fs: FsPort,
  clock: Clock,
  path: string,
  entry: string,
): Promise<void> {
  await fs.appendText(path, `${new Date(clock.now()).toISOString()} ${entry}\n`);
}
