import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";

import { p4MemoryCandidatesSql } from "../packages/daemon/src/dreaming/p4-memory-candidates.js";
import { percentile } from "./system-one-judge-metrics.js";

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      db: { type: "string" },
      legacy: { type: "string" },
      out: { type: "string" },
      repeats: { type: "string", default: "2" },
    },
  });
  if (!values.db || !values.legacy || !values.out)
    throw new Error("--db SNAPSHOT --legacy OLD_SQL_JSON --out FILE [--repeats 2]");
  const repeats = Number(values.repeats);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5)
    throw new Error("repeats must be 1..5");
  const old = z
    .object({ project: z.string(), projectless: z.string() })
    .parse(JSON.parse(readFileSync(values.legacy, "utf8")));
  const db = new Database(values.db, { readonly: true });
  const startedAt = new Date().toISOString();
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  const runs: {
    projectHash: string;
    iteration: number;
    order: string[];
    legacyMs: number;
    groupedMs: number;
    identical: boolean;
    outputSha256: string;
    rows: number;
  }[] = [];
  try {
    const projects = db
      .query<
        { project_id: string; n: number },
        []
      >("SELECT project_id, COUNT(*) AS n FROM t2_memories WHERE project_id IS NOT NULL GROUP BY project_id ORDER BY n DESC LIMIT 3")
      .all();
    const legacy = db.query<Record<string, unknown>, [string, number, number]>(old.project);
    const groupedSql = p4MemoryCandidatesSql(true);
    const grouped = db.query<Record<string, unknown>, [string, number, number]>(groupedSql);
    for (let iteration = 0; iteration < repeats; iteration++) {
      for (const project of projects) {
        const order = iteration % 2 ? ["grouped", "legacy"] : ["legacy", "grouped"];
        const results = new Map<string, { elapsedMs: number; rows: Record<string, unknown>[] }>();
        for (const name of order) {
          const started = performance.now();
          const rows = (name === "legacy" ? legacy : grouped).all(project.project_id, now, cutoff);
          results.set(name, { elapsedMs: performance.now() - started, rows });
        }
        const before = results.get("legacy");
        const after = results.get("grouped");
        if (!before || !after) throw new Error("missing paired query result");
        runs.push({
          projectHash: hash(project.project_id),
          iteration,
          order,
          legacyMs: before.elapsedMs,
          groupedMs: after.elapsedMs,
          identical: hash(before.rows) === hash(after.rows),
          outputSha256: hash(after.rows),
          rows: after.rows.length,
        });
      }
    }
    const plan = db
      .query<{ detail: string }, [string, number, number]>(`EXPLAIN QUERY PLAN ${groupedSql}`)
      .all(projects[0]?.project_id ?? "", now, cutoff);
    const report = {
      startedAt,
      completedAt: new Date().toISOString(),
      dbMode: "read-only snapshot",
      nowMs: now,
      cutoffMs: cutoff,
      methodology:
        "Three largest project scopes; alternating query order by repetition; local warm filesystem caches; no production DB/index/service mutation; hashes compare ordered full query outputs without publishing memory text. This is query latency, not model latency or a production-daemon activation test.",
      sqliteVersion: db.query("SELECT sqlite_version() AS version").get(),
      counts: {
        memories: db.query("SELECT COUNT(*) AS n FROM t2_memories").get(),
        actions: db.query("SELECT COUNT(*) AS n FROM dream_actions").get(),
      },
      legacyP50Ms: percentile(
        runs.map((row) => row.legacyMs),
        0.5,
      ),
      groupedP50Ms: percentile(
        runs.map((row) => row.groupedMs),
        0.5,
      ),
      allOutputsIdentical: runs.every((row) => row.identical),
      groupedPlan: plan.map((row) => row.detail),
      runs,
    };
    writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.allOutputsIdentical) process.exitCode = 1;
  } finally {
    db.close();
  }
}
