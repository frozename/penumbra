import { Database } from "bun:sqlite";
import type { Clock } from "../utils/clock.js";
import type { ProjectResolution } from "./project-id.js";

export class ProjectCache {
  private readonly db: Database;
  private readonly clock: Clock;

  constructor(opts: { db: Database; clock: Clock }) {
    this.db = opts.db;
    this.clock = opts.clock;
  }

  upsertFromResolution(resolution: ProjectResolution, path: string): void {
    if (resolution.kind === "quarantine") return;
    const existing = this.db
      .query<
        { first_seen_paths: string },
        [string]
      >("SELECT first_seen_paths FROM projects WHERE project_id=?")
      .get(resolution.project_id);

    if (existing) {
      const paths: string[] = JSON.parse(existing.first_seen_paths);
      if (!paths.includes(path)) {
        paths.push(path);
        this.db.run("UPDATE projects SET first_seen_paths=? WHERE project_id=?", [
          JSON.stringify(paths),
          resolution.project_id,
        ]);
      }
      return;
    }

    const now = this.clock().toISOString();
    this.db.run(
      `INSERT INTO projects(project_id, kind, git_remote, git_relpath_root, marker_uuid, display_name, first_seen_paths, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resolution.project_id,
        resolution.kind,
        resolution.kind === "git" ? resolution.git_remote : null,
        resolution.kind === "git" ? resolution.git_relpath_root : null,
        resolution.kind === "marker" ? resolution.marker_uuid : null,
        null,
        JSON.stringify([path]),
        now,
      ],
    );
  }
}
