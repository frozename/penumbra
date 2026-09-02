import { Database } from "bun:sqlite";
import { createInterface } from "node:readline";

type Mode = "busy" | "missing-row" | "normal" | "serialized";

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
  if (mode !== "normal" && mode !== "busy" && mode !== "missing-row" && mode !== "serialized") {
    throw new Error(`unsupported mode: ${mode}`);
  }
  return { dbPath, mode };
}

function nowMs(): number {
  return performance.now();
}

function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run("PRAGMA busy_timeout=5000");
  return db;
}

function ensureSchema(db: Database): void {
  db.run("PRAGMA journal_mode=WAL");
  db.run("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at_ms REAL NOT NULL)");
  db.run(
    "CREATE TABLE IF NOT EXISTS probe_events (kind TEXT NOT NULL, pid INTEGER NOT NULL, round INTEGER NOT NULL, session_id TEXT, at_ms REAL NOT NULL)",
  );
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
): void {
  db.query(
    "INSERT INTO probe_events (kind, pid, round, session_id, at_ms) VALUES (?, ?, ?, ?, ?)",
  ).run(kind, process.pid, round, sessionId, nowMs());
}

function createSession(db: Database, shouldInsert: boolean, round: number): string {
  ensureSchema(db);
  const sessionId = `fake-session-${String(process.pid)}-${crypto.randomUUID()}`;
  recordEvent(db, "session_new_received", round, sessionId);
  if (shouldInsert) {
    db.query("INSERT INTO sessions (id, created_at_ms) VALUES (?, ?)").run(sessionId, nowMs());
  }
  recordEvent(db, "session_new_responding", round, sessionId);
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

  if (options.mode === "serialized") {
    await new Promise((resolve) => setTimeout(resolve, processIndex() * 75));
  }

  const sessionId = createSession(db, options.mode !== "missing-row", requestRound(req));
  writeResponse(req.id, { sessionId });
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const db = openDb(options.dbPath);
  const rl = createInterface({ input: process.stdin });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const parsed = JSON.parse(trimmed) as JsonRpcRequest;
      await handleRequest(parsed, options, db);
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
