#!/usr/bin/env bun
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";

import { resolveDefaultInvocationLogPath } from "../src/invocation-sink-registry.js";
import {
  type InvocationSummaryInputRow,
  parseLines,
  summarize,
  type SummaryRow,
} from "../src/invocation-summary.js";

function parseSinceDuration(value: string): number {
  const match = /^(\d+)([dh])$/i.exec(value);
  if (!match) {
    throw new Error(`invalid --since value '${value}'. Expected Nd or Nh (examples: 7d, 12h).`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  if (!Number.isFinite(amount)) {
    throw new Error(`invalid --since value '${value}'.`);
  }
  return unit === "d" ? amount * 86_400_000 : amount * 3_600_000;
}

function resolveInputFiles(logPath: string): string[] {
  const dir = dirname(logPath);
  if (!existsSync(dir)) return [];

  const liveBase = basename(logPath).replace(/\.jsonl$/, "");
  const rotationNameRe = new RegExp(
    `^${liveBase.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d{4}-\\d{2}-\\d{2}\\.jsonl\\.gz$`,
  );

  const rotated = readdirSync(dir)
    .filter((name) => rotationNameRe.test(name))
    .sort()
    .map((name) => join(dir, name));

  if (existsSync(logPath)) rotated.push(logPath);
  return rotated;
}

function isInvocationRow(value: unknown): value is InvocationSummaryInputRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.ts === "string" &&
    typeof row.tool === "string" &&
    typeof row.origin === "string" &&
    typeof row.args_bytes === "number" &&
    typeof row.result_bytes === "number" &&
    typeof row.duration_ms === "number" &&
    typeof row.ok === "boolean" &&
    (typeof row.error_kind === "string" || row.error_kind === null)
  );
}

function formatMarkdownTable(summary: Map<string, SummaryRow>): string {
  const rows = [...summary.entries()].sort(
    (a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]),
  );
  const lines = [
    "| tool | calls | errors | total_bytes_in | total_bytes_out | p50_bytes_out | p95_bytes_out | first_error | origins |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  for (const [tool, row] of rows) {
    lines.push(
      `| ${tool} | ${String(row.calls)} | ${String(row.errors)} | ${String(row.total_bytes_in)} | ${String(row.total_bytes_out)} | ${String(row.p50_bytes_out)} | ${String(row.p95_bytes_out)} | ${row.first_error ?? ""} | ${[...row.origins].sort().join(",")} |`,
    );
  }
  return lines.join("\n");
}

function tryParseInvocationRow(
  line: string,
  cutoffMs: number,
): InvocationSummaryInputRow | undefined {
  const parsed = parseLines([line]);
  if (parsed.length !== 1) return undefined;
  const row = parsed[0];
  if (!isInvocationRow(row)) return undefined;
  const rowTs = Date.parse(row.ts);
  if (!Number.isFinite(rowTs) || rowTs < cutoffMs) return undefined;
  return row;
}

async function collectRows(
  files: string[],
  cutoffMs: number,
): Promise<InvocationSummaryInputRow[]> {
  const rows: InvocationSummaryInputRow[] = [];
  for (const filePath of files) {
    const input = filePath.endsWith(".gz")
      ? createReadStream(filePath).pipe(createGunzip())
      : createReadStream(filePath);
    const reader = createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      const row = tryParseInvocationRow(line, cutoffMs);
      if (row) rows.push(row);
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      since: { type: "string" },
      path: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const logPath = values.path ?? resolveDefaultInvocationLogPath();
  const sinceRaw = values.since;
  const cutoffMs =
    Date.now() - (sinceRaw ? parseSinceDuration(sinceRaw) : Number.POSITIVE_INFINITY);
  const cutoffLabel = sinceRaw
    ? new Date(cutoffMs).toISOString()
    : "the beginning of recorded history";

  const files = resolveInputFiles(logPath);
  if (files.length === 0) {
    process.stdout.write(`no invocations recorded since ${cutoffLabel}\n`);
    return;
  }

  const rows = await collectRows(files, cutoffMs);
  if (rows.length === 0) {
    process.stdout.write(`no invocations recorded since ${cutoffLabel}\n`);
    return;
  }

  const summary = summarize(rows);
  process.stdout.write(`${formatMarkdownTable(summary)}\n`);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
