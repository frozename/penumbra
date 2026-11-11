import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { openReplayDb } from "./typesafe-shadow-eval.js";

export interface ReviewSource {
  rollup_id: string;
  session_id: string;
  project_id: string | null;
  started_at: string;
  first_prompt_excerpt: string;
  t2_promoted_at: string | null;
}
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

interface RankedSource {
  row: ReviewSource;
  bodyHash: string;
  rank: string;
}
interface ReviewCase {
  caseId: string;
  body: string;
  promote: null;
  rationale: string;
  factualSupport: string;
  evidence: string[];
  reviewer: string;
}
interface ReviewPacket {
  manifest: {
    schemaVersion: number;
    labelStatus: string;
    policy: string;
    sampling: string;
    seed: string;
    inputRows: number;
    eligibleUniqueRows: number;
    selected: number;
    excludedPilotHashes: number;
    packetSha256: string;
    strata: { stratum: string; eligible: number; selected: number }[];
  };
  cases: ReviewCase[];
  key: (ReviewSource & { caseId: string | undefined; bodyHash: string; stratum: string })[];
}

function groupSources(
  rows: ReviewSource[],
  seed: string,
  excluded: Set<string>,
): Map<string, RankedSource[]> {
  const families = new Set<string>();
  const bodies = new Set<string>();
  const buckets = new Map<string, RankedSource[]>();
  const ordered = rows
    .map((row) => ({
      row,
      bodyHash: hash(row.first_prompt_excerpt),
      rank: hash(`${seed}:${row.rollup_id}`),
    }))
    .sort((a, b) => a.rank.localeCompare(b.rank));
  for (const item of ordered) {
    const { row, bodyHash } = item;
    if (
      !row.first_prompt_excerpt.trim() ||
      excluded.has(bodyHash) ||
      bodies.has(bodyHash) ||
      families.has(row.session_id)
    )
      continue;
    families.add(row.session_id);
    bodies.add(bodyHash);
    const length = row.first_prompt_excerpt.length;
    const stratum = `${row.started_at.slice(0, 7)}:${length < 1000 ? "short" : length < 8000 ? "medium" : "long"}:${row.t2_promoted_at ? "retained" : "unretained"}`;
    const bucket = buckets.get(stratum) ?? [];
    bucket.push(item);
    buckets.set(stratum, bucket);
  }
  return buckets;
}

function sampleBuckets(
  buckets: [string, RankedSource[]][],
  limit: number,
): (RankedSource & { stratum: string })[] {
  const selected: (RankedSource & { stratum: string })[] = [];
  for (let i = 0; selected.length < limit; i++) {
    let added = false;
    for (const [stratum, bucket] of buckets) {
      const item = bucket[i];
      if (!item || selected.length >= limit) continue;
      selected.push({ ...item, stratum });
      added = true;
    }
    if (!added) break;
  }
  return selected.sort((a, b) => a.rank.localeCompare(b.rank));
}

export function buildReviewPacket(
  rows: ReviewSource[],
  options: {
    seed: string;
    limit: number;
    excludedHashes: string[];
  },
): ReviewPacket {
  if (
    !options.seed ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 1000
  )
    throw new Error("seed and limit 1..1000 required");
  const excluded = new Set(options.excludedHashes);
  const buckets = groupSources(rows, options.seed, excluded);
  const sortedBuckets = [...buckets].sort(([a], [b]) => a.localeCompare(b));
  const selected = sampleBuckets(sortedBuckets, options.limit);
  const cases: ReviewCase[] = selected.map(({ row, bodyHash }) => ({
    caseId: hash(`${options.seed}:${bodyHash}`).slice(0, 24),
    body: row.first_prompt_excerpt,
    promote: null,
    rationale: "",
    factualSupport: "unreviewed",
    evidence: [] as string[],
    reviewer: "",
  }));
  return {
    manifest: {
      schemaVersion: 1,
      labelStatus: "awaiting-independent-review",
      policy:
        "Content durability under the incumbent promotion rubric; factual support is separate. Retention and model decisions are not ground truth.",
      sampling:
        "Seeded round-robin by month, character-length band and existing retention; one unique body/session; not a population-weighted estimate.",
      seed: options.seed,
      inputRows: rows.length,
      eligibleUniqueRows: [...buckets.values()].reduce((sum, bucket) => sum + bucket.length, 0),
      selected: cases.length,
      excludedPilotHashes: excluded.size,
      packetSha256: hash(cases.map((row) => JSON.stringify(row)).join("\n") + "\n"),
      strata: sortedBuckets.map(([stratum, bucket]) => ({
        stratum,
        eligible: bucket.length,
        selected: selected.filter((item) => item.stratum === stratum).length,
      })),
    },
    cases,
    key: selected.map(({ row, bodyHash, stratum }, i) => ({
      caseId: cases[i]?.caseId,
      ...row,
      bodyHash,
      stratum,
    })),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      db: { type: "string" },
      out: { type: "string" },
      seed: { type: "string" },
      limit: { type: "string", default: "200" },
      exclude: { type: "string" },
      since: { type: "string" },
    },
  });
  if (!values.db || !values.out || !values.seed || !values.exclude)
    throw new Error(
      "--db PATH --out NEW_PRIVATE_DIR --seed STRING --exclude PILOT_FIXTURES [--since ISO] [--limit N]",
    );
  const excludedHashes = readFileSync(values.exclude, "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => {
      const row = JSON.parse(line) as { state?: { body?: string } };
      return typeof row.state?.body === "string" ? [hash(row.state.body)] : [];
    });
  const db = openReplayDb(values.db);
  try {
    const rows = db
      .query<ReviewSource, [string]>(
        `SELECT rollup_id, session_id, project_id, started_at, first_prompt_excerpt, t2_promoted_at
      FROM t1_rollups WHERE first_prompt_excerpt IS NOT NULL AND length(trim(first_prompt_excerpt)) >= 40 AND started_at >= ?`,
      )
      .all(values.since ?? "");
    const packet = buildReviewPacket(rows, {
      seed: values.seed,
      limit: Number(values.limit),
      excludedHashes,
    });
    mkdirSync(values.out, { mode: 0o700 });
    for (const [name, data] of [
      ["reviewer-a.jsonl", packet.cases],
      ["reviewer-b.jsonl", packet.cases],
      ["private-source-key.jsonl", packet.key],
    ] as const)
      writeFileSync(
        join(values.out, name),
        data.map((row) => JSON.stringify(row)).join("\n") + "\n",
        { flag: "wx", mode: 0o600 },
      );
    writeFileSync(
      join(values.out, "manifest.json"),
      JSON.stringify(packet.manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(JSON.stringify(packet.manifest, null, 2) + "\n");
  } finally {
    db.close();
  }
}
