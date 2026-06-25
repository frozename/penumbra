import type { Database } from "bun:sqlite";

import {
  buildT2EmbedText,
  resolveGateOutcomeCutoverIso,
  type Services,
  writeDirectT2Memory,
} from "@penumbra/core";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { checkDbPressure } from "../pressure.js";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECURRENCE_THRESHOLD = 3;
const ANALYSIS_WINDOW_MS = 24 * 60 * 60 * 1000;
const ANALYSIS_WINDOW_HOURS = 24;
const MAX_METADATA_DEPTH = 20;
const MAX_WINDOW_ROWS = 5_000;
const MAX_T2_LANE_IDS = 20;
const MAX_SLUG_SIGNATURE_CHARS = 96;

type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

type Log = {
  warn?: (obj: Record<string, unknown>, msg: string) => void;
  info?: (obj: Record<string, unknown>, msg: string) => void;
};

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

export interface GateQualityDigestSweepDeps {
  services: Services;
  outDir: string;
  now?: () => Date;
  getEnv?: (key: string) => string | undefined;
  recurrenceThreshold?: number;
  log?: Log;
  checkPressure?: () => boolean;
}

export interface GateQualityDigestSweepResult {
  lanesProcessed: number;
  malformedMetadata: number;
  t2Writes: number;
  digestPath: string;
}

interface LaneCloseRow {
  lane_id: string;
  ts_closed: string;
  gate_status: string;
  task_class: string;
  implementer_handoff: string;
  reviewer_handoff: string | null;
  metadata_json: string;
}

interface FailureSummary {
  signature: string;
  count: number;
  laneIds: string[];
}

export interface AgentGateRateTrend {
  agent_name: string;
  task_type: string;
  currentRate: number;
  previousRate: number | null;
  deltaPoints: number | null;
  samples: number;
}

// Per-seat split of the gate_outcome column over the analysis window. NULL is
// surfaced as its own bucket so the NULL-vs-review_debt composition is visible
// per agent (the scorer treats NULL specially; this is observability only and
// does not promote NULL to passed).
export interface AgentGateOutcomeSplit {
  agent_name: string;
  passed: number;
  failed: number;
  skipped: number;
  review_debt: number;
  null_outcome: number;
  total: number;
}

export async function runGateQualityDigestSweep(
  deps: GateQualityDigestSweepDeps,
): Promise<GateQualityDigestSweepResult> {
  const now = (deps.now ?? ((): Date => new Date()))();
  const date = formatDate(now);
  const digestPath = getGateQualityDigestPath(deps.outDir, date);
  if (existsSync(digestPath)) {
    return {
      lanesProcessed: 0,
      malformedMetadata: 0,
      t2Writes: 0,
      digestPath,
    };
  }

  const db = deps.services.db;
  const rows = readClosedLanesInWindow(db, now, deps.log);
  const analysis = analyzeFailures(rows);
  const t2WritesEnabled = resolveT2WritesEnabled(deps.getEnv);
  const threshold = Math.max(1, deps.recurrenceThreshold ?? DEFAULT_RECURRENCE_THRESHOLD);
  const t2Writes = t2WritesEnabled
    ? await writeRecurringFailureMemories({
        services: deps.services,
        date,
        failures: analysis.failures.filter((failure) => failure.count >= threshold),
      })
    : 0;

  const digestPathWritten = await writeGateQualityDigest({
    digestPath,
    outDir: deps.outDir,
    date,
    byStatus: aggregateGateStatusCounts(rows),
    failures: analysis.failures,
    malformedMetadata: analysis.malformedMetadata,
    trends: readAgentGateTrends(db, now),
    seatSplits: readAgentGateOutcomeSplits(db, now),
  });

  return {
    lanesProcessed: rows.length,
    malformedMetadata: analysis.malformedMetadata,
    t2Writes,
    digestPath: digestPathWritten,
  };
}

export function startGateQualityDigestSweeper(
  deps: GateQualityDigestSweepDeps,
  intervalMs?: number,
): () => void {
  const effectiveIntervalMs =
    intervalMs ??
    parseOptionalNonNegativeInt(
      deps.getEnv?.("PENUMBRA_GATE_QUALITY_DIGEST_INTERVAL_MS") ??
        process.env.PENUMBRA_GATE_QUALITY_DIGEST_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
    );
  let gateQualityDigestInFlight = false;

  const tick = async (): Promise<void> => {
    if (gateQualityDigestInFlight) return;
    if (resolvePressureGuardEnabled(deps.getEnv)) {
      const check = deps.checkPressure ?? ((): boolean => checkDbPressure(deps.services.db));
      if (check()) {
        deps.log?.info?.({}, "gate-quality-digest: deferred due to subscription pressure");
        return;
      }
    }
    gateQualityDigestInFlight = true;
    try {
      await runGateQualityDigestSweep(deps);
    } catch (err) {
      deps.log?.warn?.({ err: String(err) }, "gate-quality-digest: sweep failed");
    } finally {
      gateQualityDigestInFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, effectiveIntervalMs);
  void tick();
  maybeUnref(timer);

  return () => {
    clearInterval(timer);
  };
}

function readClosedLanesInWindow(db: Database, now: Date, log?: Log): LaneCloseRow[] {
  const start = new Date(now.getTime() - ANALYSIS_WINDOW_MS);
  const rows = db
    .query<LaneCloseRow, [string, string, number]>(
      `SELECT lane_id, ts_closed, gate_status, task_class, implementer_handoff, reviewer_handoff, metadata_json
       FROM lane_ledger
       WHERE ts_closed IS NOT NULL
         AND ts_closed > ?
         AND ts_closed <= ?
       ORDER BY ts_closed ASC, lane_id ASC
       LIMIT ?`,
    )
    .all(start.toISOString(), now.toISOString(), MAX_WINDOW_ROWS + 1);

  if (rows.length > MAX_WINDOW_ROWS) {
    log?.warn?.(
      { limit: MAX_WINDOW_ROWS, windowHours: ANALYSIS_WINDOW_HOURS },
      "gate-quality-digest: closed-lane window truncated at row limit",
    );
    return rows.slice(0, MAX_WINDOW_ROWS);
  }

  return rows;
}

function analyzeFailures(rows: LaneCloseRow[]): {
  failures: FailureSummary[];
  malformedMetadata: number;
} {
  const bySignature = new Map<string, Set<string>>();
  let malformedMetadata = 0;

  for (const row of rows) {
    const parsed = parseMetadata(row.metadata_json);
    if (!parsed.ok) {
      malformedMetadata++;
      continue;
    }
    for (const signature of extractFailureSignatures(parsed.value)) {
      let laneIds = bySignature.get(signature);
      if (!laneIds) {
        laneIds = new Set();
        bySignature.set(signature, laneIds);
      }
      laneIds.add(row.lane_id);
    }
  }

  return {
    failures: [...bySignature.entries()]
      .map(([signature, laneIds]) => ({
        signature,
        count: laneIds.size,
        laneIds: [...laneIds].sort(),
      }))
      .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature)),
    malformedMetadata,
  };
}

function parseMetadata(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw || "{}") };
  } catch {
    return { ok: false };
  }
}

function extractFailureSignatures(value: unknown): string[] {
  const signatures = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (depth >= MAX_METADATA_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    for (const key of ["failure_signature", "failure_class", "signature"]) {
      const candidate = record[key];
      if (typeof candidate === "string") {
        const normalized = normalizeSignature(candidate);
        if (normalized) signatures.add(normalized);
      }
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(value, 0);
  return [...signatures];
}

function normalizeSignature(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

async function writeRecurringFailureMemories(opts: {
  services: Services;
  date: string;
  failures: FailureSummary[];
}): Promise<number> {
  let writes = 0;
  for (const failure of opts.failures) {
    const slug = `gate-quality-digest-${opts.date}-${truncateSlugPart(failure.signature)}`;
    const existing = opts.services.db
      .query<
        { memory_id: string },
        [string]
      >(`SELECT memory_id FROM t2_memories WHERE hook = 'gate-quality-digest' AND slug = ?`)
      .get(slug);
    if (existing) continue;

    const laneIds = failure.laneIds.slice(0, MAX_T2_LANE_IDS);
    const omitted = failure.laneIds.length - laneIds.length;
    const title = `Recurring gate failure: ${failure.signature}`;
    const body = [
      `Observed ${String(failure.count)} lanes with this failure signature on ${opts.date}.`,
      "",
      `Lane IDs: ${laneIds.join(", ")}${omitted > 0 ? ` (${String(omitted)} more omitted)` : ""}`,
      "",
      "Use this as routing and review context for future gate-outcome analysis.",
    ].join("\n");
    const embedding = (await opts.services.embedder.embed([buildT2EmbedText(title, body)]))[0];
    if (!embedding) continue;

    const wrote = writeDirectT2Memory(opts.services.db, {
      title,
      body,
      slug,
      hook: "gate-quality-digest",
      obs_type: "discovery",
      durability: "medium",
      is_episodic: false,
      embedding,
    });
    if (wrote.created) writes++;
  }
  return writes;
}

interface GateStatusCounts {
  passed: number;
  failed: number;
  skipped: number;
  review_debt: number;
  open: number;
}

// Aggregate gate-status counts from the same ts_closed-bounded rows used for
// failure analysis, so the digest reports one consistent window. (Closed lanes
// carry a real gate status; 'open' stays 0 by construction.)
function aggregateGateStatusCounts(rows: LaneCloseRow[]): GateStatusCounts {
  const counts: GateStatusCounts = { passed: 0, failed: 0, skipped: 0, review_debt: 0, open: 0 };
  for (const row of rows) {
    if (row.gate_status in counts) {
      counts[row.gate_status as keyof GateStatusCounts]++;
    }
  }
  return counts;
}

async function writeGateQualityDigest(opts: {
  outDir: string;
  date: string;
  digestPath: string;
  byStatus: GateStatusCounts;
  failures: FailureSummary[];
  malformedMetadata: number;
  trends: AgentGateRateTrend[];
  seatSplits: AgentGateOutcomeSplit[];
}): Promise<string> {
  const filepath = opts.digestPath;
  const date = opts.date;
  const byStatus = opts.byStatus;

  const lines: string[] = [
    `# Gate Quality Digest - ${date}`,
    "",
    "## Lane Gate Status",
    "",
    "| status | count |",
    "|---|---:|",
    `| passed | ${String(byStatus.passed)} |`,
    `| failed | ${String(byStatus.failed)} |`,
    `| skipped | ${String(byStatus.skipped)} |`,
    `| review_debt | ${String(byStatus.review_debt)} |`,
    `| open | ${String(byStatus.open)} |`,
    "",
    "## Top Failure Signatures",
    "",
    "| signature | lanes |",
    "|---|---:|",
  ];

  if (opts.failures.length === 0) {
    lines.push("| none | 0 |");
  } else {
    for (const failure of opts.failures.slice(0, 10)) {
      lines.push(`| ${escapeMarkdownTableCell(failure.signature)} | ${String(failure.count)} |`);
    }
  }

  lines.push("", `Malformed lane metadata skipped: ${String(opts.malformedMetadata)}`, "");
  lines.push(
    "## Agent Gate Pass Rate Trends",
    "",
    "| agent | task_type | current | delta |",
    "|---|---|---:|---:|",
  );
  if (opts.trends.length === 0) {
    lines.push("| none | - | 0.0% | 0.0 pp |");
  } else {
    for (const trend of opts.trends) {
      lines.push(
        `| ${escapeMarkdownTableCell(trend.agent_name)} | ${escapeMarkdownTableCell(trend.task_type)} | ${formatPct(trend.currentRate)} | ${formatDelta(trend.deltaPoints)} |`,
      );
    }
  }
  lines.push("");

  lines.push(
    "## Per-Seat Gate Outcome Split",
    "",
    "| agent | passed | failed | skipped | review_debt | null | total |",
    "|---|---:|---:|---:|---:|---:|---:|",
  );
  if (opts.seatSplits.length === 0) {
    lines.push("| none | 0 | 0 | 0 | 0 | 0 | 0 |");
  } else {
    for (const split of opts.seatSplits) {
      lines.push(
        `| ${escapeMarkdownTableCell(split.agent_name)} | ${String(split.passed)} | ${String(split.failed)} | ${String(split.skipped)} | ${String(split.review_debt)} | ${String(split.null_outcome)} | ${String(split.total)} |`,
      );
    }
  }
  lines.push("");

  await mkdir(opts.outDir, { recursive: true });
  if (existsSync(filepath)) return filepath;
  await writeFile(filepath, lines.join("\n"), "utf8");
  return filepath;
}

function getGateQualityDigestPath(outDir: string, date: string): string {
  return join(outDir, `gate-quality-digest-${date}.md`);
}

function readAgentGateTrends(db: Database, now: Date): AgentGateRateTrend[] {
  const currentEnd = now;
  const currentStart = new Date(currentEnd.getTime() - ANALYSIS_WINDOW_MS);
  const previousEnd = currentStart;
  const previousStart = new Date(previousEnd.getTime() - ANALYSIS_WINDOW_MS);
  const current = readAgentGateRates(db, currentStart, currentEnd);
  const previous = readAgentGateRates(db, previousStart, previousEnd);
  const previousByKey = new Map(
    previous.map((row) => [`${row.agent_name}\0${row.task_type}`, row]),
  );
  return current
    .map((row) => {
      const prev = previousByKey.get(`${row.agent_name}\0${row.task_type}`);
      return {
        ...row,
        previousRate: prev?.currentRate ?? null,
        deltaPoints: prev ? (row.currentRate - prev.currentRate) * 100 : null,
      };
    })
    .sort(
      (a, b) => a.agent_name.localeCompare(b.agent_name) || a.task_type.localeCompare(b.task_type),
    );
}

export function readAgentGateOutcomeSplits(db: Database, now: Date): AgentGateOutcomeSplit[] {
  const end = now;
  const start = new Date(end.getTime() - ANALYSIS_WINDOW_MS);
  const rows = db
    .query<
      {
        agent_name: string;
        passed: number;
        failed: number;
        skipped: number;
        review_debt: number;
        null_outcome: number;
      },
      [string, string]
    >(
      `SELECT agent_name,
              SUM(CASE WHEN gate_outcome = 'passed' THEN 1 ELSE 0 END) AS passed,
              SUM(CASE WHEN gate_outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN gate_outcome = 'skipped' THEN 1 ELSE 0 END) AS skipped,
              SUM(CASE WHEN gate_outcome = 'review_debt' THEN 1 ELSE 0 END) AS review_debt,
              SUM(CASE WHEN gate_outcome IS NULL THEN 1 ELSE 0 END) AS null_outcome
       FROM agent_performance
       WHERE ts >= ? AND ts < ?
       GROUP BY agent_name
       ORDER BY agent_name ASC`,
    )
    .all(start.toISOString(), end.toISOString());
  return rows.map((row) => ({
    agent_name: row.agent_name,
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
    review_debt: row.review_debt,
    null_outcome: row.null_outcome,
    total: row.passed + row.failed + row.skipped + row.review_debt + row.null_outcome,
  }));
}

function readAgentGateRates(db: Database, start: Date, end: Date): AgentGateRateTrend[] {
  const cutover = resolveGateOutcomeCutoverIso();
  // Legacy-NULL rows (pre-cutover with no gate_outcome) are excluded from
  // both samples and gate_passes. They predate verdict stamping, so crediting
  // them as automatic passes inflated the apparent pass rate. Post-cutover
  // NULL stays in the denominator as a real "no-verdict" signal.
  const rows = db
    .query<
      { agent_name: string; task_type: string; samples: number; gate_passes: number },
      [string, string, string]
    >(
      `SELECT agent_name,
              task_type,
              COUNT(*) AS samples,
              SUM(CASE
                    WHEN gate_outcome IN ('passed', 'skipped') THEN 1
                    ELSE 0
                  END) AS gate_passes
       FROM agent_performance
       WHERE ts >= ? AND ts < ?
         AND (gate_outcome IS NOT NULL OR ts >= ?)
       GROUP BY agent_name, task_type
       ORDER BY agent_name ASC, task_type ASC`,
    )
    .all(start.toISOString(), end.toISOString(), cutover);
  return rows.map((row) => ({
    agent_name: row.agent_name,
    task_type: row.task_type,
    currentRate: row.samples > 0 ? row.gate_passes / row.samples : 0,
    previousRate: null,
    deltaPoints: null,
    samples: row.samples,
  }));
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${String(y)}-${m}-${day}`;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDelta(value: number | null): string {
  if (value === null) return "0.0 pp";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)} pp`;
}

function truncateSlugPart(value: string): string {
  return value.slice(0, MAX_SLUG_SIGNATURE_CHARS).replaceAll(/-+$/g, "");
}

function escapeMarkdownTableCell(value: string): string {
  return value
    .replaceAll(/[\r\n\t]/g, " ")
    .replaceAll(/[\\`*_{}<>()#+.!]/g, "")
    .replaceAll("[", "")
    .replaceAll("]", "")
    .replaceAll("|", "\\|")
    .trim();
}

function resolveT2WritesEnabled(getEnv?: (key: string) => string | undefined): boolean {
  const key = "PENUMBRA_GATE_QUALITY_T2_WRITES";
  const raw = getEnv?.(key) ?? process.env[key];
  return raw === "1" || raw === "true";
}

function resolvePressureGuardEnabled(getEnv?: (key: string) => string | undefined): boolean {
  const key = "PENUMBRA_GATE_QUALITY_PRESSURE_GUARD";
  const raw = getEnv?.(key) ?? process.env[key];
  return raw === "1" || raw === "true";
}

function parseOptionalNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
