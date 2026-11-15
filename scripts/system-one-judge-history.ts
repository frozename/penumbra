import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { fixtureSchema } from "./system-one-judge-bench.js";
import { binaryMetrics } from "./system-one-judge-metrics.js";
import { openReplayDb } from "./typesafe-shadow-eval.js";

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { db: { type: "string" }, fixtures: { type: "string" }, out: { type: "string" } },
    strict: true,
  });
  if (!values.db || !values.fixtures || !values.out)
    throw new Error("--db PATH --fixtures FILE --out FILE; read-only, no inference");
  const fixtures = readFileSync(values.fixtures, "utf8")
    .trim()
    .split("\n")
    .map((line) => fixtureSchema.parse(JSON.parse(line)))
    .filter((f) => f.source.table === "t1_rollups");
  const db = openReplayDb(values.db);
  const rows: {
    caseId: string;
    model: string;
    expected: boolean;
    probability: number;
    createdAt: string;
    storedLatencyMs: number | null;
  }[] = [];
  try {
    const query = db.query<{ model: string; jev_json: string; created_at: string }, [string]>(
      "SELECT model, jev_json, created_at FROM judge_decisions WHERE subject_id=? AND site='dream.p1.promotion' ORDER BY created_at DESC",
    );
    for (const fixture of fixtures) {
      const bodyHash = createHash("sha256").update(String(fixture.state.body)).digest("hex");
      const latest = query.all(fixture.source.id ?? "").find((row) => {
        const data = JSON.parse(row.jev_json) as Record<string, unknown>;
        return data.inputSha256 === bodyHash;
      });
      if (!latest) continue;
      const data = JSON.parse(latest.jev_json) as { pPromote: number; latencyMs?: number };
      if (!Number.isFinite(data.pPromote) || data.pPromote < 0 || data.pPromote > 1) continue;
      rows.push({
        caseId: fixture.id,
        model: latest.model,
        expected: fixture.labels.filtered_promote === true,
        probability: data.pPromote,
        createdAt: latest.created_at,
        storedLatencyMs: data.latencyMs ?? null,
      });
    }
  } finally {
    db.close();
  }
  writeFileSync(
    values.out,
    JSON.stringify(
      {
        provenance:
          "Existing Jev decisions; model and body hash matched, no new hosted calls. Stored latency includes waiting for incumbent votes and is not isolated Jev inference latency. Question-version identity was not stored.",
        metrics: binaryMetrics(rows),
        rows,
      },
      null,
      2,
    ) + "\n",
  );
}
