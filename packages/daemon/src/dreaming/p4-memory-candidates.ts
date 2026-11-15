export function p4MemoryCandidatesSql(hasProjectId: boolean): string {
  const now = hasProjectId ? "?2" : "?1";
  const cutoff = hasProjectId ? "?3" : "?2";
  return `WITH recent_research AS (
    SELECT json_extract(payload_json, '$.source_memory_id') AS source_memory_id,
           MAX(COALESCE(decided_at, ${now})) AS last_researched_at
      FROM dream_actions
     WHERE phase='P4' AND action_type='research_query'
       AND COALESCE(decided_at, ${now}) > ${cutoff}
     GROUP BY json_extract(payload_json, '$.source_memory_id')
  )
  SELECT m.memory_id, m.title, SUBSTR(m.body, 1, 200) AS body, m.updated_at,
         r.last_researched_at
    FROM t2_memories m
    LEFT JOIN recent_research r ON r.source_memory_id = m.memory_id
   WHERE ${hasProjectId ? "m.project_id = ?1 AND " : ""}m.kind NOT IN ('brief')
     AND m.retired_at IS NULL AND m.title IS NOT NULL AND m.title != ''
   ORDER BY r.last_researched_at IS NOT NULL ASC, r.last_researched_at ASC, m.created_at DESC
   LIMIT 2`;
}
