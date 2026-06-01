import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Branding, MAX_BODY_CHARS, resolveStorageDbPath, validateT2Body } from "@penumbra/core";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

type Candidate = {
  memory_id: string;
  title: string;
  reason: "length" | "xml";
  body_chars: number;
};

interface ParsedArgs {
  dbPath: string;
  apply: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let apply = false;
  let explicitDbPath: string | null = null;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      apply = false;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (explicitDbPath !== null) {
      throw new Error(`Unexpected extra positional arg: ${arg}`);
    }
    explicitDbPath = arg;
  }
  const storageRoot = process.env.PENUMBRA_STORAGE_ROOT ?? Branding.storageRoot;
  const dbPath = explicitDbPath ? resolve(explicitDbPath) : resolveStorageDbPath(storageRoot);
  return { dbPath, apply };
}

function loadCandidates(db: Database): Candidate[] {
  const rows = db
    .query<{ memory_id: string; title: string | null; body: string }, []>(
      `SELECT memory_id, title, body
         FROM t2_memories
        WHERE retired_at IS NULL`,
    )
    .all();

  const candidates: Candidate[] = [];
  for (const row of rows) {
    const validation = validateT2Body(row.body);
    if (validation.ok) continue;
    candidates.push({
      memory_id: row.memory_id,
      title: row.title ?? "(untitled)",
      reason: validation.reason,
      body_chars: row.body.length,
    });
  }
  return candidates;
}

function ensureCycle(db: Database, nowIso: string): string {
  const cycleId = "t2-retire-junk-sweep-2026-06-01";
  db.run(
    `INSERT OR IGNORE INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
     VALUES(?, ?, 'manual_t2_retire_junk', 0, 'completed', '[]')`,
    [cycleId, nowIso],
  );
  return cycleId;
}

function enqueueRetireActions(db: Database, candidates: Candidate[]): {
  queued: number;
  alreadyQueued: number;
} {
  const nowIso = new Date().toISOString();
  const cycleId = ensureCycle(db, nowIso);
  let queued = 0;
  let alreadyQueued = 0;

  db.transaction(() => {
    for (const candidate of candidates) {
      const targetIds = JSON.stringify([candidate.memory_id]);
      const existing = db
        .query<{ action_id: string }, [string]>(
          `SELECT action_id
             FROM dream_actions
            WHERE action_type = 'retire'
              AND status IN ('queued', 'approved', 'auto_applied')
              AND reverted_by IS NULL
              AND target_ids = ?
            LIMIT 1`,
        )
        .get(targetIds);
      if (existing) {
        alreadyQueued += 1;
        continue;
      }

      db.run(
        `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
         VALUES(?, ?, 'P3', 'retire', ?, 'queued', ?, ?)`,
        [
          randomUUID(),
          cycleId,
          candidate.reason === "xml" ? 0.99 : 0.98,
          targetIds,
          JSON.stringify({
            source: "t2_junk_retire_sweep",
            reason: candidate.reason,
            max_body_chars: MAX_BODY_CHARS,
            body_chars: candidate.body_chars,
          }),
        ],
      );
      queued += 1;
    }
  })();

  return { queued, alreadyQueued };
}

function printCandidates(candidates: Candidate[]): void {
  console.log(`Candidates: ${candidates.length}`);
  if (candidates.length === 0) return;
  for (const candidate of candidates) {
    console.log(
      `- ${candidate.memory_id} reason=${candidate.reason} body_chars=${candidate.body_chars} title=${candidate.title}`,
    );
  }
}

async function main(): Promise<void> {
  const { dbPath, apply } = parseArgs(process.argv.slice(2));
  const db = new Database(dbPath);
  try {
    const candidates = loadCandidates(db);
    printCandidates(candidates);
    if (!apply) {
      console.log("Mode: dry-run (no writes)");
      return;
    }
    const result = enqueueRetireActions(db, candidates);
    console.log(
      `Mode: apply (queued=${result.queued}, already_queued=${result.alreadyQueued}, total=${candidates.length})`,
    );
  } finally {
    db.close();
  }
}

await main();
