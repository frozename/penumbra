import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Expand a leading `~` or `~/` to the user's home directory. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Read a session cookie from a file. Returns the trimmed contents, or null when
 * the file is missing, unreadable, or blank. Never throws — callers degrade to
 * no-signal so an absent/rotated cookie can't break the usage poller.
 */
export async function readCookieFile(path: string): Promise<string | null> {
  try {
    const raw = await readFile(expandHome(path), "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
