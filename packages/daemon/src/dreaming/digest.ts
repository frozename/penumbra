import type { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DreamActionRow {
  action_id: string;
  cycle_id: string;
  phase: string;
  action_type: string;
  confidence: number;
  status: string;
  target_ids: string;
  untrusted_source: number;
  cycle_started_at: number | null;
}

export interface ListPendingDreamActionsOpts {
  limit?: number;
}

export interface ListPendingDreamActionsResult {
  actions: DreamActionRow[];
  total_count: number;
  oldest_pending_age_hours: number;
}

export function listPendingDreamActionsQuery(
  db: Database,
  opts: ListPendingDreamActionsOpts = {},
): ListPendingDreamActionsResult {
  const limit = Math.min(opts.limit ?? 100, 500);

  const actions = db
    .prepare(
      `
    SELECT
      da.action_id,
      da.cycle_id,
      da.phase,
      da.action_type,
      da.confidence,
      da.status,
      da.target_ids,
      da.untrusted_source,
      dc.started_at AS cycle_started_at
    FROM dream_actions da
    LEFT JOIN dream_cycles dc ON da.cycle_id = dc.cycle_id
    WHERE da.status IN ('queued', 'approved')
    ORDER BY dc.started_at ASC
    LIMIT ?
  `,
    )
    .all(limit) as DreamActionRow[];

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM dream_actions WHERE status IN ('queued', 'approved')`)
      .get() as { n: number }
  ).n;

  let oldest_pending_age_hours = 0;
  if (actions.length > 0) {
    const oldestMs = actions[0]!.cycle_started_at;
    if (oldestMs != null) {
      oldest_pending_age_hours = (Date.now() - oldestMs) / (1000 * 60 * 60);
    }
  }

  return { actions, total_count: total, oldest_pending_age_hours };
}

export async function writeDailyDigest(db: Database, outDir: string): Promise<string> {
  const todayStart = getTodayStartMs();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;

  const actions = db
    .prepare(
      `
    SELECT
      da.action_id,
      da.cycle_id,
      da.phase,
      da.action_type,
      da.confidence,
      da.status,
      da.target_ids,
      da.untrusted_source,
      dc.started_at AS cycle_started_at
    FROM dream_actions da
    LEFT JOIN dream_cycles dc ON da.cycle_id = dc.cycle_id
    WHERE da.status IN ('queued', 'approved')
      AND dc.started_at >= ? AND dc.started_at < ?
    ORDER BY dc.started_at ASC
  `,
    )
    .all(todayStart, todayEnd) as DreamActionRow[];

  const dateStr = formatDate(new Date());
  const filename = `dream-digest-${dateStr}.md`;
  const filepath = join(outDir, filename);

  const lines: string[] = [
    `# Dream Digest — ${dateStr}`,
    "",
    `**Pending actions today: ${actions.length}**`,
    "",
  ];

  if (actions.length > 0) {
    lines.push("| Phase | Type | Confidence | Status | Untrusted | Targets |");
    lines.push("|-------|------|-----------|--------|-----------|---------|");
    for (const a of actions) {
      const trustTag = a.untrusted_source ? " **[UNTRUSTED]**" : "";
      let targets: string[] = [];
      try {
        targets = JSON.parse(a.target_ids);
      } catch {
        // malformed target_ids
      }
      lines.push(
        `| ${a.phase} | ${a.action_type}${trustTag} | ${a.confidence.toFixed(2)} | ${a.status} | ${a.untrusted_source ? "yes" : "no"} | ${targets.join(", ")} |`,
      );
    }
    lines.push("");
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(filepath, lines.join("\n"), "utf8");

  return filepath;
}

export function startDailyDigestCron(deps: {
  db: Database;
  outDir: string;
  log?: { warn?: (obj: object, msg: string) => void };
}): () => void {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let stopped = false;

  const run = async () => {
    if (stopped) return;
    try {
      await writeDailyDigest(deps.db, deps.outDir);
    } catch (err) {
      deps.log?.warn?.({ err: String(err) }, "dreaming: daily digest failed");
    }
  };

  const timer = setInterval(run, DAY_MS);
  if (typeof (timer as any).unref === "function") (timer as any).unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function getTodayStartMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
