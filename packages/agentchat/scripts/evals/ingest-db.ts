import { resolveStorageDbPath } from "@penumbra/core";
import { canonicalJson } from "@penumbra/core/evals/canonical";
import { ingestRows, IngestRowsSchema } from "@penumbra/core/evals/ingest";
import { lineageUsage } from "@penumbra/core/evals/lineage";
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface IngestDbOptions {
  dbPath: string | undefined;
  storageRoot: string;
  retentionDays: number | undefined;
  t0RetentionDays: number | undefined;
  now: number;
}

export interface IngestDbResult {
  code: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

interface HandoffDbRow {
  handoff_id: string;
  ts: string;
  message: string;
  parent_handoff_id: string | null;
  triggered_by_event_id: string | null;
  branch_base: string | null;
  branch_name: string | null;
  workflow_run_id: string | null;
  dispatch_attempts: number;
}

interface EventDbRow {
  id: number;
  handoff_id: string;
  worker_id: string | null;
  source: string;
  kind: string;
  ts: string;
  meta_json: string | null;
}

interface LaneDbRow {
  lane_id: string;
  implementer_handoff: string;
  gate_status: string;
  ts_closed: string | null;
}

const HANDOFFS_SQL =
  "SELECT handoff_id, ts, message, parent_handoff_id, triggered_by_event_id, branch_base, branch_name, workflow_run_id, dispatch_attempts FROM handoffs ORDER BY ts, handoff_id";
const EVENTS_SQL =
  "SELECT id, handoff_id, worker_id, source, kind, ts, meta_json FROM dispatch_events ORDER BY id";
const LANES_SQL =
  "SELECT lane_id, implementer_handoff, gate_status, ts_closed FROM lane_ledger ORDER BY lane_id";
const TABLE_EXISTS_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?";

function fail(code: 1 | 2, stderr: string): IngestDbResult {
  return { code, stdout: "", stderr };
}

export function openIngestDatabase(dbPath: string): Database {
  return new Database(dbPath, { readonly: true });
}

function realPathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isLiveStorageDb(dbPath: string, storageRoot: string): boolean {
  const liveDbPath = resolveStorageDbPath(storageRoot, { env: {} });
  return realPathOrResolve(dbPath) === realPathOrResolve(liveDbPath);
}

function tableExists(db: Database, name: string): boolean {
  return db.prepare<{ name: string }, [string]>(TABLE_EXISTS_SQL).all(name).length > 0;
}

function selectAll<T>(db: Database, sql: string): T[] {
  return db.prepare<T, []>(sql).all();
}

function buildRows(db: Database): {
  handoffs: HandoffDbRow[];
  events: EventDbRow[];
  lanes: LaneDbRow[];
} {
  const handoffs = selectAll<HandoffDbRow>(db, HANDOFFS_SQL);
  const events = selectAll<EventDbRow>(db, EVENTS_SQL);
  const lanes = tableExists(db, "lane_ledger") ? selectAll<LaneDbRow>(db, LANES_SQL) : [];
  return { handoffs, events, lanes };
}

function parseRows(raw: unknown): ReturnType<typeof IngestRowsSchema.safeParse> {
  return IngestRowsSchema.safeParse(raw);
}

function lineageStartTs(handoffs: readonly HandoffDbRow[], rootHandoffId: string): string | null {
  const row = handoffs.find((handoff) => handoff.handoff_id === rootHandoffId);
  return row?.ts ?? null;
}

interface LineageUsageInfo {
  lineage_usage: unknown;
  usage_missing_reason: string | null;
}

function usageForLineage(
  db: Database,
  handoffIds: readonly string[],
  startTs: string | null,
  opts: { now: number; t0RetentionDays: number },
  t0Present: boolean,
): LineageUsageInfo {
  if (!t0Present) {
    return { lineage_usage: null, usage_missing_reason: "t0_events_absent" };
  }
  if (startTs === null) {
    return { lineage_usage: null, usage_missing_reason: "no_usage_rows" };
  }
  const usage = lineageUsage(db, { handoff_ids: [...handoffIds], start_ts: startTs }, opts);
  if (usage === null) {
    return { lineage_usage: null, usage_missing_reason: "no_usage_rows" };
  }
  return { lineage_usage: usage, usage_missing_reason: null };
}

function lineageLine(
  episode: {
    lineage: { root_handoff_id: string; handoff_ids: string[] };
    attempt_history: unknown;
    first_attempt: string;
  },
  usage: LineageUsageInfo,
): Record<string, unknown> {
  return {
    type: "lineage",
    root_handoff_id: episode.lineage.root_handoff_id,
    handoff_ids: episode.lineage.handoff_ids,
    attempt_history: episode.attempt_history,
    first_attempt: episode.first_attempt,
    lineage_usage: usage.lineage_usage,
    usage_missing_reason: usage.usage_missing_reason,
  };
}

export function ingestDb(opts: IngestDbOptions): IngestDbResult {
  if (opts.dbPath === undefined || opts.dbPath === "") {
    return fail(2, "db_missing --db <path> is required\n");
  }
  if (opts.retentionDays === undefined || opts.t0RetentionDays === undefined) {
    return fail(
      2,
      "retention_flags_required --retention-days and --t0-retention-days are required\n",
    );
  }
  if (isLiveStorageDb(opts.dbPath, opts.storageRoot)) {
    return fail(2, `db_is_live_storage ${opts.dbPath} is the live storage database\n`);
  }

  const db = openIngestDatabase(opts.dbPath);
  try {
    const { handoffs, events, lanes } = buildRows(db);
    const parsed = parseRows({
      schema_version: 1,
      handoffs,
      events,
      retry_events: [],
      lanes,
    });
    if (!parsed.success) {
      return fail(1, `ingest_rows_invalid ${parsed.error.issues[0]?.message ?? "schema"}\n`);
    }
    const result = ingestRows(parsed.data, {
      now: opts.now,
      retentionDays: opts.retentionDays,
    });
    const t0Present = tableExists(db, "t0_events");
    const lines: string[] = [];
    for (const episode of result.episodes) {
      const startTs = lineageStartTs(handoffs, episode.lineage.root_handoff_id);
      const usage = usageForLineage(
        db,
        episode.lineage.handoff_ids,
        startTs,
        { now: opts.now, t0RetentionDays: opts.t0RetentionDays },
        t0Present,
      );
      lines.push(canonicalJson(lineageLine(episode, usage)));
    }
    lines.push(
      canonicalJson({
        type: "ingest_summary",
        lineages: result.report.lineages,
        excluded: result.report.excluded,
        orphan_events_dropped: result.report.orphan_events_dropped,
      }),
    );
    return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(1, `ingest_failed ${message}\n`);
  } finally {
    db.close();
  }
}
