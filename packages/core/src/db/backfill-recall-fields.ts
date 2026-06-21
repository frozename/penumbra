import type { Database } from "bun:sqlite";

const EMOJI_TO_OBS_TYPE: [string, string][] = [
  ["🔴", "bugfix"],
  ["🟣", "feature"],
  ["🔄", "refactor"],
  ["✅", "change"],
  ["🔵", "discovery"],
  ["⚖️", "decision"],
  ["🚨", "security_alert"],
  ["🔐", "security_note"],
  ["🎯", "session"],
];

function emojiToObsType(title: string): string | null {
  const stripped = title.trim();
  for (const [emoji, kind] of EMOJI_TO_OBS_TYPE) {
    if (stripped.startsWith(emoji)) return kind;
  }
  return null;
}

export interface BackfillStats {
  t2_obs_type_set: number;
  t2_concepts_set: number;
  t2_severity_set: number;
  t2_file_paths_set: number;
  t2_learned_at_set: number;
}

interface MetaShape {
  concepts?: string[];
  severity?: string;
  file_paths?: string[];
}

interface T2Row {
  memory_id: string;
  title: string;
  metadata_json: string;
  obs_type: string | null;
  concepts: string | null;
  severity: string | null;
  file_paths: string | null;
  created_at: string;
  learned_at: string | null;
}

interface ResolvedRow {
  obs_type: string | null;
  concepts: string;
  severity: string | null;
  file_paths: string;
  learned_at: string;
}

function parseMeta(raw: string): MetaShape {
  const source = raw || "{}";
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

function resolveObsType(row: T2Row, stats: BackfillStats): string | null {
  if (row.obs_type) return row.obs_type;
  const fromEmoji = emojiToObsType(row.title);
  if (fromEmoji) {
    stats.t2_obs_type_set += 1;
    return fromEmoji;
  }
  return null;
}

function resolveConcepts(row: T2Row, meta: MetaShape, stats: BackfillStats): string {
  if (row.concepts && row.concepts !== "[]") return row.concepts;
  const fromMeta = Array.isArray(meta.concepts) ? meta.concepts : [];
  if (fromMeta.length > 0) {
    stats.t2_concepts_set += 1;
    return JSON.stringify(fromMeta);
  }
  return row.concepts ?? "[]";
}

function resolveSeverity(row: T2Row, meta: MetaShape, stats: BackfillStats): string | null {
  if (row.severity) return row.severity;
  if (typeof meta.severity === "string") {
    stats.t2_severity_set += 1;
    return meta.severity;
  }
  return null;
}

function resolveFilePaths(row: T2Row, meta: MetaShape, stats: BackfillStats): string {
  if (row.file_paths && row.file_paths !== "[]") return row.file_paths;
  const fromMeta = Array.isArray(meta.file_paths) ? meta.file_paths : [];
  if (fromMeta.length > 0) {
    stats.t2_file_paths_set += 1;
    return JSON.stringify(fromMeta);
  }
  return row.file_paths ?? "[]";
}

function resolveLearnedAt(row: T2Row, stats: BackfillStats): string {
  if (row.learned_at) return row.learned_at;
  stats.t2_learned_at_set += 1;
  return row.created_at;
}

function resolveRow(row: T2Row, stats: BackfillStats): ResolvedRow {
  const meta = parseMeta(row.metadata_json);
  return {
    obs_type: resolveObsType(row, stats),
    concepts: resolveConcepts(row, meta, stats),
    severity: resolveSeverity(row, meta, stats),
    file_paths: resolveFilePaths(row, meta, stats),
    learned_at: resolveLearnedAt(row, stats),
  };
}

function rowIsUnchanged(row: T2Row, resolved: ResolvedRow): boolean {
  return (
    resolved.obs_type === row.obs_type &&
    resolved.concepts === row.concepts &&
    resolved.severity === row.severity &&
    resolved.file_paths === row.file_paths &&
    resolved.learned_at === row.learned_at
  );
}

export function backfillRecallFields(db: Database): BackfillStats {
  const stats: BackfillStats = {
    t2_obs_type_set: 0,
    t2_concepts_set: 0,
    t2_severity_set: 0,
    t2_file_paths_set: 0,
    t2_learned_at_set: 0,
  };

  const rows = db
    .query<
      T2Row,
      []
    >(`SELECT memory_id, title, metadata_json, obs_type, concepts, severity, file_paths, created_at, learned_at FROM t2_memories`)
    .all();

  const updateStmt = db.prepare(
    `UPDATE t2_memories SET obs_type=?, concepts=?, severity=?, file_paths=?, learned_at=? WHERE memory_id=?`,
  );

  const backfillTx = db.transaction(() => {
    for (const row of rows) {
      const resolved = resolveRow(row, stats);
      if (rowIsUnchanged(row, resolved)) continue;
      updateStmt.run(
        resolved.obs_type,
        resolved.concepts,
        resolved.severity,
        resolved.file_paths,
        resolved.learned_at,
        row.memory_id,
      );
    }
  });

  backfillTx();

  return stats;
}
