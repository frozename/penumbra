#!/usr/bin/env bun
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';
import {
  parseLines,
  summarize,
  type InvocationSummaryInputRow,
  type SummaryRow,
} from '../src/invocation-summary.js';
import { resolveDefaultPath } from '../src/invocation-sink-registry.js';

function parseSinceDuration(value: string): number {
  const match = /^(\d+)([dh])$/i.exec(value);
  if (!match) {
    throw new Error(`invalid --since value '${value}'. Expected Nd or Nh (examples: 7d, 12h).`);
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (!Number.isFinite(amount)) {
    throw new Error(`invalid --since value '${value}'.`);
  }
  return unit === 'd' ? amount * 86_400_000 : amount * 3_600_000;
}

function resolveInputFiles(logPath: string): string[] {
  const dir = dirname(logPath);
  if (!existsSync(dir)) return [];

  const liveBase = basename(logPath).replace(/\.jsonl$/, '');
  const rotationNameRe = new RegExp(`^${liveBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d{4}-\\d{2}-\\d{2}\\.jsonl\\.gz$`);

  const rotated = readdirSync(dir)
    .filter((name) => rotationNameRe.test(name))
    .sort()
    .map((name) => join(dir, name));

  if (existsSync(logPath)) rotated.push(logPath);
  return rotated;
}

function isInvocationRow(value: unknown): value is InvocationSummaryInputRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.ts === 'string' &&
    typeof row.tool === 'string' &&
    typeof row.origin === 'string' &&
    typeof row.args_bytes === 'number' &&
    typeof row.result_bytes === 'number' &&
    typeof row.duration_ms === 'number' &&
    typeof row.ok === 'boolean' &&
    (typeof row.error_kind === 'string' || row.error_kind === null)
  );
}

function formatMarkdownTable(summary: Map<string, SummaryRow>): string {
  const rows = [...summary.entries()].sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]));
  const lines = [
    '| tool | calls | errors | total_bytes_in | total_bytes_out | p50_bytes_out | p95_bytes_out | first_error | origins |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  for (const [tool, row] of rows) {
    lines.push(
      `| ${tool} | ${row.calls} | ${row.errors} | ${row.total_bytes_in} | ${row.total_bytes_out} | ${row.p50_bytes_out} | ${row.p95_bytes_out} | ${row.first_error ?? ''} | ${[...row.origins].sort().join(',')} |`,
    );
  }
  return lines.join('\n');
}

async function collectRows(files: string[], cutoffMs: number): Promise<InvocationSummaryInputRow[]> {
  const rows: InvocationSummaryInputRow[] = [];
  for (const filePath of files) {
    const input = filePath.endsWith('.gz')
      ? createReadStream(filePath).pipe(createGunzip())
      : createReadStream(filePath);
    const reader = createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      const parsed = parseLines([line]);
      if (parsed.length !== 1) continue;
      const row = parsed[0];
      if (!isInvocationRow(row)) continue;
      const rowTs = Date.parse(row.ts);
      if (!Number.isFinite(rowTs) || rowTs < cutoffMs) continue;
      rows.push(row);
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      since: { type: 'string' },
      path: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });
  if (positionals.length > 0) {
    throw new Error(`unexpected positional argument(s): ${positionals.join(' ')}`);
  }

  const logPath = values.path ?? resolveDefaultPath();
  const sinceRaw = values.since;
  const cutoffMs = Date.now() - (sinceRaw ? parseSinceDuration(sinceRaw) : Number.POSITIVE_INFINITY);
  const cutoffLabel = sinceRaw
    ? new Date(cutoffMs).toISOString()
    : 'the beginning of recorded history';

  const files = resolveInputFiles(logPath);
  if (files.length === 0) {
    console.log(`no invocations recorded since ${cutoffLabel}`);
    return;
  }

  const rows = await collectRows(files, cutoffMs);
  if (rows.length === 0) {
    console.log(`no invocations recorded since ${cutoffLabel}`);
    return;
  }

  const summary = summarize(rows);
  console.log(formatMarkdownTable(summary));
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
