import { resolveDaemonStorageRoot } from "@penumbra/core";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_PATH = "/tmp/penumbra-statusline.cache";
const CACHE_TTL_MS = 2_000;
const DAEMON_TIMEOUT_MS = 1_500;

interface StatuslineCache {
  ts: number;
  line: string;
}

interface DaemonCounts {
  dispatched: number;
  awaiting: number;
  done: number;
}

export interface RunStatuslineOpts {
  fetch?: typeof globalThis.fetch;
  storageRoot?: string;
}

export async function runStatusline(opts: RunStatuslineOpts = {}): Promise<string> {
  try {
    const raw = await readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as StatuslineCache;
    if (
      Number.isFinite(parsed.ts) &&
      typeof parsed.line === "string" &&
      Date.now() - parsed.ts < CACHE_TTL_MS
    ) {
      return parsed.line;
    }
  } catch {
    // Cache miss or unreadable cache; continue to daemon fetch.
  }

  let counts: DaemonCounts;
  try {
    counts = await fetchCounts(opts.fetch ?? globalThis.fetch, opts.storageRoot);
  } catch {
    return "◑ penumbra  daemon offline";
  }

  const line = formatLine(counts);

  try {
    await writeFile(CACHE_PATH, JSON.stringify({ ts: Date.now(), line } satisfies StatuslineCache));
  } catch {
    // Best effort only.
  }

  return line;
}

async function fetchCounts(
  fetchFn: typeof globalThis.fetch,
  storageRootOverride?: string,
): Promise<DaemonCounts> {
  const storageRoot =
    storageRootOverride ?? process.env.PENUMBRA_STORAGE_ROOT ?? resolveDaemonStorageRoot();
  const portPath = join(storageRoot, "port");
  const tokenPath = join(storageRoot, "token");
  const [portRaw, tokenRaw] = await Promise.all([
    readFile(portPath, "utf8"),
    readFile(tokenPath, "utf8"),
  ]);
  const port = Number(portRaw.trim());
  const token = tokenRaw.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`penumbra statusline: invalid daemon port in ${portPath}`);
  }
  if (!token) {
    throw new Error(`penumbra statusline: empty daemon token in ${tokenPath}`);
  }

  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const headers = { authorization: `Bearer ${token}` };
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, DAEMON_TIMEOUT_MS);

  try {
    const dispatchedRes = await fetchFn(`${baseUrl}/handoffs?status=dispatched`, {
      headers,
      signal: controller.signal,
    });
    const awaitingRes = await fetchFn(`${baseUrl}/permissions?status=pending`, {
      headers,
      signal: controller.signal,
    });
    const doneSince = new Date(Date.now() - 3_600_000).toISOString();
    const doneRes = await fetchFn(
      `${baseUrl}/handoffs?status=completed&since=${encodeURIComponent(doneSince)}`,
      {
        headers,
        signal: controller.signal,
      },
    );

    if (!dispatchedRes.ok || !awaitingRes.ok || !doneRes.ok) {
      throw new Error("daemon returned non-2xx");
    }

    const dispatchedBody = (await dispatchedRes.json()) as { handoffs?: unknown[] };
    const awaitingBody = (await awaitingRes.json()) as { permissions?: unknown[] };
    const doneBody = (await doneRes.json()) as { done?: number };

    return {
      dispatched: Array.isArray(dispatchedBody.handoffs) ? dispatchedBody.handoffs.length : 0,
      awaiting: Array.isArray(awaitingBody.permissions) ? awaitingBody.permissions.length : 0,
      done: typeof doneBody.done === "number" ? doneBody.done : 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatLine(counts: DaemonCounts): string {
  if (counts.awaiting > 0) {
    return `◐ penumbra  ${String(counts.awaiting)} awaiting  ${String(counts.dispatched)} dispatched  ${String(counts.done)} done`;
  }
  if (counts.dispatched > 0) {
    return `◌ penumbra  ${String(counts.dispatched)} dispatched  ${String(counts.done)} done`;
  }
  if (counts.done > 0) {
    return `● penumbra  ${String(counts.done)} done`;
  }
  return "● penumbra  idle";
}
