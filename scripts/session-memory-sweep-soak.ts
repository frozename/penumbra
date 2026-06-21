import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

type SessionExtractCandidate = {
  action?: string;
  backlinks?: unknown;
};

type SessionExtractResponse = {
  candidates?: SessionExtractCandidate[];
  near_dup_filtered?: boolean;
  near_dup_filtered_count?: number;
};

export type SessionMemorySweepSoakResult = {
  session_id: string;
  candidate_count: number;
  has_updates: boolean;
  near_dup_filtered: boolean;
  fts_backlinks_found: boolean;
};

export function formatSessionMemorySweepSoakResult(result: SessionMemorySweepSoakResult): string {
  return JSON.stringify(result);
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({ error: message });
}

function resolveStorageRoot(): string {
  const env = process.env.PENUMBRA_STORAGE_ROOT;
  if (env && existsSync(join(env, "port")) && existsSync(join(env, "token"))) {
    return env;
  }
  const candidates = [join(homedir(), ".penumbra"), "/tmp/penumbra-live"];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "port")) && existsSync(join(candidate, "token"))) {
      return candidate;
    }
  }
  throw new Error("penumbra storage root with port/token was not found");
}

function readDaemon(storageRoot: string): { baseUrl: string; token: string } {
  const port = readFileSync(join(storageRoot, "port"), "utf8").trim();
  const token = readFileSync(join(storageRoot, "token"), "utf8").trim();
  if (!port || Number.isNaN(Number(port))) {
    throw new Error(`invalid daemon port in ${join(storageRoot, "port")}`);
  }
  if (!token) throw new Error(`empty daemon token in ${join(storageRoot, "token")}`);
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

function readLatestSessionId(storageRoot: string): string {
  const dbPath = join(storageRoot, "db.sqlite");
  if (!existsSync(dbPath)) throw new Error(`db.sqlite was not found in ${storageRoot}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query<{ session_id: string }, []>(
        `SELECT session_id
           FROM t1_rollups
          WHERE session_id IS NOT NULL
          ORDER BY COALESCE(ended_at, started_at) DESC, rowid DESC
          LIMIT 1`,
      )
      .get();
    if (!row?.session_id) throw new Error("no t1_rollups session_id found");
    return row.session_id;
  } finally {
    db.close();
  }
}

async function extractSession(
  daemon: { baseUrl: string; token: string },
  sessionId: string,
): Promise<SessionExtractResponse> {
  const res = await fetch(`${daemon.baseUrl}/memory/session-extract`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`/memory/session-extract -> ${String(res.status)}${body ? ` ${body}` : ""}`);
  }
  return (await res.json()) as SessionExtractResponse;
}

function summarize(
  sessionId: string,
  response: SessionExtractResponse,
): SessionMemorySweepSoakResult {
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  return {
    session_id: sessionId,
    candidate_count: candidates.length,
    has_updates: candidates.some((candidate) => candidate.action === "update"),
    near_dup_filtered:
      response.near_dup_filtered === true || (response.near_dup_filtered_count ?? 0) > 0,
    fts_backlinks_found: candidates.some(
      (candidate) => Array.isArray(candidate.backlinks) && candidate.backlinks.length > 0,
    ),
  };
}

async function main(): Promise<number> {
  try {
    const storageRoot = resolveStorageRoot();
    const sessionId = readLatestSessionId(storageRoot);
    const response = await extractSession(readDaemon(storageRoot), sessionId);
    process.stdout.write(formatSessionMemorySweepSoakResult(summarize(sessionId, response)) + "\n");
    return 0;
  } catch (error) {
    process.stdout.write(formatError(error) + "\n");
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
