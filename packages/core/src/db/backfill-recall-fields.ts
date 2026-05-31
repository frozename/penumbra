import type { Database } from "bun:sqlite";

const EMOJI_TO_OBS_TYPE: Array<[string, string]> = [
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
      {
        memory_id: string;
        title: string;
        metadata_json: string;
        obs_type: string | null;
        concepts: string | null;
        severity: string | null;
        file_paths: string | null;
        created_at: string;
        learned_at: string | null;
      },
      []
    >(
      `SELECT memory_id, title, metadata_json, obs_type, concepts, severity, file_paths, created_at, learned_at FROM t2_memories`,
    )
    .all();

  const updateStmt = db.prepare(
    `UPDATE t2_memories SET obs_type=?, concepts=?, severity=?, file_paths=?, learned_at=? WHERE memory_id=?`,
  );

  const backfillTx = db.transaction(() => {
    for (const row of rows) {
      let meta: { concepts?: string[]; severity?: string; file_paths?: string[] } = {};
      try {
        meta = JSON.parse(row.metadata_json || "{}");
      } catch {
        meta = {};
      }

      let obsType = row.obs_type;
      if (!obsType) {
        obsType = emojiToObsType(row.title);
        if (obsType) stats.t2_obs_type_set += 1;
      }

      let concepts = row.concepts;
      if (!concepts || concepts === "[]") {
        const fromMeta = Array.isArray(meta.concepts) ? meta.concepts : [];
        if (fromMeta.length > 0) {
          concepts = JSON.stringify(fromMeta);
          stats.t2_concepts_set += 1;
        } else if (concepts === null) {
          concepts = "[]";
        }
      }

      let severity = row.severity;
      if (!severity && typeof meta.severity === "string") {
        severity = meta.severity;
        stats.t2_severity_set += 1;
      }

      let filePaths = row.file_paths;
      if (!filePaths || filePaths === "[]") {
        const fromMeta = Array.isArray(meta.file_paths) ? meta.file_paths : [];
        if (fromMeta.length > 0) {
          filePaths = JSON.stringify(fromMeta);
          stats.t2_file_paths_set += 1;
        } else if (filePaths === null) {
          filePaths = "[]";
        }
      }

      let learnedAt = row.learned_at;
      if (!learnedAt) {
        learnedAt = row.created_at;
        stats.t2_learned_at_set += 1;
      }

      const nextObsType = obsType ?? null;
      const nextConcepts = concepts ?? "[]";
      const nextSeverity = severity ?? null;
      const nextFilePaths = filePaths ?? "[]";
      const nextLearnedAt = learnedAt ?? null;

      if (
        nextObsType === row.obs_type &&
        nextConcepts === row.concepts &&
        nextSeverity === row.severity &&
        nextFilePaths === row.file_paths &&
        nextLearnedAt === row.learned_at
      ) {
        continue;
      }

      updateStmt.run(
        nextObsType,
        nextConcepts,
        nextSeverity,
        nextFilePaths,
        nextLearnedAt,
        row.memory_id,
      );
    }
  });

  backfillTx();

  return stats;
}
