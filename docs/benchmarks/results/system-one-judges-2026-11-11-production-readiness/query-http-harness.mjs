import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { p4MemoryCandidatesSql } from "../../../../packages/daemon/src/dreaming/p4-memory-candidates.ts";

const { values } = parseArgs({ args: process.argv.slice(2), options: { db: { type: "string" }, legacy: { type: "string" }, variant: { type: "string" } }, strict: true });
if (!values.db || !values.legacy || !["legacy", "grouped"].includes(values.variant)) throw new Error("explicit snapshot, SQL and variant required");
const db = new Database(values.db, { readonly: true });
const sql = values.variant === "legacy" ? JSON.parse(readFileSync(values.legacy, "utf8")).project : p4MemoryCandidatesSql(true);
const statement = db.prepare(sql);
const projects = db.query("SELECT project_id FROM t2_memories WHERE project_id IS NOT NULL GROUP BY project_id ORDER BY COUNT(*) DESC LIMIT 3").all();
const now = Date.now();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/health") return Response.json({ status: "ok" });
  if (path !== "/work") return new Response("not found", { status: 404 });
  const started = performance.now();
  let selected = 0;
  for (const project of projects) selected += statement.all(project.project_id, now, now - 86400000).length;
  return Response.json({ elapsedMs: performance.now() - started, selected });
} });
process.stdout.write(JSON.stringify({ port: server.port, variant: values.variant }) + "\n");
