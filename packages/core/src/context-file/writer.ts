import { Database } from "bun:sqlite";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertSafeProjectId } from "../schemas/project-id.js";

export interface ContextFileWriterOpts {
  db: Database;
  storageRoot: string;
  topK: number;
}

interface RollupRow {
  rollup_id: string;
  started_at: string;
  ended_at: string | null;
  first_prompt_excerpt: string | null;
  last_response_excerpt: string | null;
  tool_calls_summary: string | null;
}

interface MemoryRow {
  memory_id: string;
  title: string;
  body: string;
  created_at: string;
}

function buildMemoriesSection(memories: MemoryRow[]): string[] {
  if (memories.length === 0) return [];
  const out: string[] = ["## Cross-session memories"];
  for (const m of memories) out.push(`### ${m.title}\n\n${m.body}\n`);
  return out;
}

function buildRollupsSection(rollups: RollupRow[]): string[] {
  if (rollups.length === 0) return [];
  const out: string[] = ["## Recent sessions"];
  for (const r of rollups) {
    out.push(`### ${r.started_at} → ${r.ended_at ?? "ongoing"}`);
    if (r.first_prompt_excerpt) out.push(`- **First prompt:** ${r.first_prompt_excerpt}`);
    if (r.last_response_excerpt) out.push(`- **Last response:** ${r.last_response_excerpt}`);
    if (r.tool_calls_summary) out.push(`- **Tools:** ${r.tool_calls_summary}`);
    out.push("");
  }
  return out;
}

export class ContextFileWriter {
  constructor(private readonly opts: ContextFileWriterOpts) {}

  rewrite(projectId: string): void {
    assertSafeProjectId(projectId);
    if (this.opts.topK < 1) {
      throw new RangeError(`ContextFileWriter.topK must be >= 1, got ${String(this.opts.topK)}`);
    }
    const rollups = this.opts.db
      .query<RollupRow, [string, number]>(
        `SELECT rollup_id, started_at, ended_at, first_prompt_excerpt,
                last_response_excerpt, tool_calls_summary
           FROM t1_rollups
          WHERE project_id = ?
          ORDER BY COALESCE(ended_at, started_at) DESC
          LIMIT ?`,
      )
      .all(projectId, this.opts.topK);

    const memories = this.opts.db
      .query<MemoryRow, [string, number]>(
        `SELECT memory_id, title, body, created_at
           FROM t2_memories
          WHERE project_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(projectId, this.opts.topK);

    const parts: string[] = [
      "---",
      `generated_at: ${JSON.stringify(new Date().toISOString())}`,
      `project_id: ${JSON.stringify(projectId)}`,
      `t1_count: ${String(rollups.length)}`,
      `t2_count: ${String(memories.length)}`,
      "---",
      "",
    ];

    if (rollups.length === 0 && memories.length === 0) {
      parts.push(
        "## no memories yet",
        "",
        "Observations have not been rolled up for this project. Use the tool for a few sessions and memories will populate here.",
      );
    } else {
      parts.push(...buildMemoriesSection(memories), ...buildRollupsSection(rollups));
    }

    const dir = join(this.opts.storageRoot, "context", projectId);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `latest.md.${String(process.pid)}.tmp`);
    const final = join(dir, "latest.md");
    writeFileSync(tmp, parts.join("\n") + "\n", { mode: 0o644 });
    renameSync(tmp, final);
  }
}
