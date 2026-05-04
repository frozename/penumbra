import type { Database } from 'bun:sqlite';

const EMOJI_TO_OBS_TYPE: Array<[string, string]> = [
  ['🔴', 'bugfix'],
  ['🟣', 'feature'],
  ['🔄', 'refactor'],
  ['✅', 'change'],
  ['🔵', 'discovery'],
  ['⚖️', 'decision'],
  ['🚨', 'security_alert'],
  ['🔐', 'security_note'],
  ['🎯', 'session'],
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
}

export function backfillRecallFields(db: Database): BackfillStats {
  const stats: BackfillStats = {
    t2_obs_type_set: 0,
    t2_concepts_set: 0,
    t2_severity_set: 0,
    t2_file_paths_set: 0,
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
      },
      []
    >(`SELECT memory_id, title, metadata_json, obs_type, concepts, severity, file_paths FROM t2_memories`)
    .all();

  const updateStmt = db.prepare(
    `UPDATE t2_memories SET obs_type=?, concepts=?, severity=?, file_paths=? WHERE memory_id=?`,
  );

  for (const row of rows) {
    let meta: { concepts?: string[]; severity?: string; file_paths?: string[] } = {};
    try {
      meta = JSON.parse(row.metadata_json || '{}');
    } catch {
      meta = {};
    }

    let obsType = row.obs_type;
    if (!obsType) {
      obsType = emojiToObsType(row.title);
      if (obsType) stats.t2_obs_type_set += 1;
    }

    let concepts = row.concepts;
    if (!concepts || concepts === '[]') {
      const fromMeta = Array.isArray(meta.concepts) ? meta.concepts : [];
      if (fromMeta.length > 0) {
        concepts = JSON.stringify(fromMeta);
        stats.t2_concepts_set += 1;
      } else if (concepts === null) {
        concepts = '[]';
      }
    }

    let severity = row.severity;
    if (!severity && typeof meta.severity === 'string') {
      severity = meta.severity;
      stats.t2_severity_set += 1;
    }

    let filePaths = row.file_paths;
    if (!filePaths || filePaths === '[]') {
      const fromMeta = Array.isArray(meta.file_paths) ? meta.file_paths : [];
      if (fromMeta.length > 0) {
        filePaths = JSON.stringify(fromMeta);
        stats.t2_file_paths_set += 1;
      } else if (filePaths === null) {
        filePaths = '[]';
      }
    }

    updateStmt.run(obsType ?? null, concepts ?? '[]', severity ?? null, filePaths ?? '[]', row.memory_id);
  }

  return stats;
}
