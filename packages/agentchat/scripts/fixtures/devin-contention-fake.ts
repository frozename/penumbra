import { Database } from "bun:sqlite";
import { createInterface } from "node:readline";

type Mode =
  | "busy"
  | "missing-row"
  | "no-db"
  | "no-events"
  | "normal"
  | "serialized"
  | "serialized-late"
  | "slow-normal"
  | "slow-respond"
  | "timeout";

interface JsonRpcRequest {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

interface CliOptions {
  dbPath: string;
  mode: Mode;
}

function readFlag(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseCli(argv: string[]): CliOptions {
  const dbPath = readFlag(argv, "db");
  const mode = readFlag(argv, "mode") ?? "normal";
  if (dbPath === null) {
    throw new Error("missing --db");
  }
  if (
    mode !== "normal" &&
    mode !== "busy" &&
    mode !== "missing-row" &&
    mode !== "no-db" &&
    mode !== "no-events" &&
    mode !== "serialized" &&
    mode !== "serialized-late" &&
    mode !== "slow-normal" &&
    mode !== "slow-respond" &&
    mode !== "timeout"
  ) {
    throw new Error(`unsupported mode: ${mode}`);
  }
  return { dbPath, mode };
}

function nowMs(): number {
  // Wall clock, not performance.now(): these timestamps are compared across
  // child processes, whose performance epochs each start at their own spawn.
  return Date.now();
}

function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run("PRAGMA busy_timeout=5000");
  return db;
}

function isSqliteBusy(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|database is locked/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureSchema(db: Database): Promise<void> {
  const deadline = nowMs() + 5_000;
  for (;;) {
    try {
      db.run(
        "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at_ms REAL NOT NULL)",
      );
      db.run(
        "CREATE TABLE IF NOT EXISTS probe_events (kind TEXT NOT NULL, pid INTEGER NOT NULL, round INTEGER NOT NULL, session_id TEXT, at_ms REAL NOT NULL)",
      );
      return;
    } catch (err) {
      if (!isSqliteBusy(err) || nowMs() >= deadline) {
        throw err;
      }
      await sleep(25);
    }
  }
}

function writeResponse(id: number | string | undefined, result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ id, jsonrpc: "2.0", result })}\n`);
}

function writeError(id: number | string | undefined, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ error: { code: -32000, message }, id, jsonrpc: "2.0" })}\n`,
  );
}

function recordEvent(
  db: Database,
  kind: string,
  round: number,
  sessionId: string | null = null,
  atMs: number = nowMs(),
): Promise<void> {
  return runWithRetry(db, () => {
    db.query(
      "INSERT INTO probe_events (kind, pid, round, session_id, at_ms) VALUES (?, ?, ?, ?, ?)",
    ).run(kind, process.pid, round, sessionId, atMs);
  });
}

// Fine-grained retry instead of SQLite's doubling busy handler: while the
// probe parent holds the lock, writers must resume within a few ms of the
// release or the lock-round responding skew reflects the retry schedule
// instead of the target's own behavior.
async function runWithRetry(db: Database, run: () => void): Promise<void> {
  const deadline = nowMs() + 6_000;
  for (;;) {
    try {
      run();
      return;
    } catch (err) {
      if (!isSqliteBusy(err) || nowMs() >= deadline) {
        throw err;
      }
      await sleep(5);
    }
  }
}

function insertSessionRow(db: Database, sessionId: string): Promise<void> {
  return runWithRetry(db, () => {
    db.query("INSERT INTO sessions (id, created_at_ms) VALUES (?, ?)").run(sessionId, nowMs());
  });
}

async function createSession(
  db: Database,
  shouldInsert: boolean,
  round: number,
  receivedAtMs: number,
): Promise<string> {
  const sessionId = `fake-session-${String(process.pid)}-${crypto.randomUUID()}`;
  await recordEvent(db, "session_new_received", round, sessionId, receivedAtMs);
  if (shouldInsert) {
    await insertSessionRow(db, sessionId);
  }
  await recordEvent(db, "session_new_responding", round, sessionId);
  return sessionId;
}

function createSessionWithoutEvents(db: Database): string {
  const sessionId = `fake-session-${String(process.pid)}-${crypto.randomUUID()}`;
  db.query("INSERT INTO sessions (id, created_at_ms) VALUES (?, ?)").run(sessionId, nowMs());
  return sessionId;
}

function requestRound(req: JsonRpcRequest): number {
  const round = req.params?.round;
  return typeof round === "number" && Number.isInteger(round) ? round : 0;
}

function processIndex(): number {
  const raw = process.env.DEVIN_CONTENTION_PROBE_INDEX;
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : 0;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function handleRequest(
  req: JsonRpcRequest,
  options: CliOptions,
  db: Database,
  receivedAtMs: number | null,
): Promise<void> {
  if (req.method === "initialize") {
    writeResponse(req.id, {
      protocolVersion: "0.3.0",
      serverInfo: { name: "devin-contention-fake", version: "0.0.0" },
    });
    return;
  }

  if (req.method !== "session/new") {
    writeError(req.id, `unsupported method: ${req.method ?? "<missing>"}`);
    return;
  }

  if (options.mode === "busy") {
    writeError(req.id, "SQLITE_BUSY: database is locked");
    return;
  }

  if (options.mode === "no-db") {
    writeResponse(req.id, {
      sessionId: `fake-session-${String(process.pid)}-${crypto.randomUUID()}`,
    });
    return;
  }

  if (options.mode === "no-events") {
    writeResponse(req.id, { sessionId: createSessionWithoutEvents(db) });
    return;
  }

  if (options.mode === "slow-normal") {
    await sleep(350);
    const sessionId = await createSession(db, true, requestRound(req), receivedAtMs ?? nowMs());
    writeResponse(req.id, {
      sessionId,
    });
    return;
  }

  if (options.mode === "slow-respond") {
    const sessionId = `fake-session-${String(process.pid)}-${crypto.randomUUID()}`;
    await recordEvent(
      db,
      "session_new_received",
      requestRound(req),
      sessionId,
      receivedAtMs ?? nowMs(),
    );
    await insertSessionRow(db, sessionId);
    await sleep(300);
    await recordEvent(db, "session_new_responding", requestRound(req), sessionId);
    writeResponse(req.id, { sessionId });
    return;
  }

  if (options.mode === "timeout") {
    return;
  }

  if (options.mode === "serialized") {
    await new Promise((resolve) => setTimeout(resolve, processIndex() * 75));
  } else if (options.mode === "serialized-late") {
    await sleep(60 + processIndex() * 75);
  }

  const sessionId = await createSession(
    db,
    options.mode !== "missing-row",
    requestRound(req),
    receivedAtMs ?? nowMs(),
  );
  writeResponse(req.id, { sessionId });
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const db = openDb(options.dbPath);
  if (
    options.mode === "serialized" ||
    options.mode === "serialized-late" ||
    options.mode === "slow-respond"
  ) {
    db.run("PRAGMA busy_timeout=0");
  }
  await ensureSchema(db);
  const rl = createInterface({ input: process.stdin });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const parsed = JSON.parse(trimmed) as JsonRpcRequest;
      const receivedAtMs = parsed.method === "session/new" ? nowMs() : null;
      await handleRequest(parsed, options, db, receivedAtMs);
    }
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
