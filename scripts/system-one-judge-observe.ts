import type { Database } from "bun:sqlite";

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

import {
  createLocalPromotionShadowSeat,
  type LocalPromotionShadowDecision,
} from "../packages/daemon/src/dreaming/local-promotion-shadow.js";
import {
  createLocalDecisionClient,
  type TypesafeFetch,
} from "../packages/integrations/typesafe/src/index.js";
import { openReplayDb } from "./typesafe-shadow-eval.js";

const voteSchema = z.object({
  promote: z.boolean(),
  confidence: z.number().min(0).max(1),
  seat: z.string().optional(),
  abstained: z.boolean().optional(),
  error_class: z.string().optional(),
});
export interface ShadowInput {
  decisionId: string;
  subjectId: string;
  body: string;
  historicalAt: string;
  votes: z.infer<typeof voteSchema>[];
}
interface StoredInput {
  decision_id: string;
  subject_id: string;
  created_at: string;
  incumbent_json: string;
  jev_json: string;
  first_prompt_excerpt: string;
}

export function loadShadowInputs(
  db: Database,
  options: { since: string; limit: number },
): ShadowInput[] {
  if (
    !Number.isFinite(Date.parse(options.since)) ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 1000
  )
    throw new Error("valid since and limit 1..1000 required");
  const stored = db
    .query<StoredInput, [string, number]>(
      `SELECT d.decision_id, d.subject_id, d.created_at, d.incumbent_json, d.jev_json, r.first_prompt_excerpt
    FROM judge_decisions d JOIN t1_rollups r ON r.rollup_id=d.subject_id
    WHERE d.site='dream.p1.promotion' AND d.created_at>=? AND r.first_prompt_excerpt IS NOT NULL
    ORDER BY d.created_at DESC, d.decision_id LIMIT ?`,
    )
    .all(options.since, 10_000);
  const seen = new Set<string>();
  const inputs: ShadowInput[] = [];
  for (const row of stored) {
    const bodyHash = createHash("sha256").update(row.first_prompt_excerpt).digest("hex");
    if (seen.has(bodyHash)) continue;
    try {
      const prior = z
        .object({ inputSha256: z.literal(bodyHash) })
        .safeParse(JSON.parse(row.jev_json));
      const incumbent = z
        .object({ votes: z.array(voteSchema).min(1) })
        .safeParse(JSON.parse(row.incumbent_json));
      if (!prior.success || !incumbent.success) continue;
      seen.add(bodyHash);
      inputs.push({
        decisionId: row.decision_id,
        subjectId: row.subject_id,
        body: row.first_prompt_excerpt,
        historicalAt: row.created_at,
        votes: incumbent.data.votes,
      });
      if (inputs.length >= options.limit) break;
    } catch {
      /* Malformed historical rows cannot become labels or inference inputs. */
    }
  }
  return inputs;
}

interface ObserverOptions {
  live: boolean;
  config: { baseUrl: string; model: string; revision: string };
  fetch: TypesafeFetch;
  writeDecision: (
    row: LocalPromotionShadowDecision & { historicalAt: string; decisionId: string },
  ) => void;
  intervalMs: number;
  signal: AbortSignal;
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}

interface ObserverResult {
  status: "executed" | "not_run";
  mode: "shadow";
  applied: false;
  methodology: string;
  config: ObserverOptions["config"];
  startedAt: string;
  endedAt: string;
  selected: number;
  attempted: number;
  answered: number;
  interrupted: boolean;
}

export async function observeInputs(
  inputs: ShadowInput[],
  options: ObserverOptions,
): Promise<ObserverResult> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1)
    throw new Error("invalid intervalMs");
  const startedAt = new Date().toISOString();
  let attempted = 0;
  let answered = 0;
  if (options.live) {
    const client = createLocalDecisionClient({
      ...options.config,
      fetch: options.fetch,
      timeoutMs: 5000,
      maxConcurrency: 1,
      maxRetries: 0,
    });
    for (const input of inputs) {
      if (options.signal.aborted) break;
      const start = performance.now();
      const seat = createLocalPromotionShadowSeat({
        client: {
          evaluate: (req) =>
            client.evaluate({
              ...req,
              signal: req.signal ? AbortSignal.any([req.signal, options.signal]) : options.signal,
            }),
        },
        revision: options.config.revision,
        writeDecision: (row) => {
          if (row.failure === null) answered++;
          options.writeDecision({
            ...row,
            historicalAt: input.historicalAt,
            decisionId: input.decisionId,
          });
        },
      });
      attempted++;
      await seat.shadow(
        { kind: "promote_t1", body: input.body, subjectId: input.subjectId },
        Promise.resolve(input.votes),
      );
      if (attempted < inputs.length)
        await delay(Math.max(1, options.intervalMs - (performance.now() - start)), options.signal);
    }
  }
  return {
    status: options.live ? "executed" : "not_run",
    mode: "shadow",
    applied: false,
    methodology:
      "Paced read-only historical replay; incumbent ballots are exact-body-hash matched historical observations, not contemporaneous inference or ground truth. No labels or accuracy are inferred.",
    config: options.config,
    startedAt,
    endedAt: new Date().toISOString(),
    selected: inputs.length,
    attempted,
    answered,
    interrupted: options.signal.aborted,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      db: { type: "string" },
      config: { type: "string" },
      out: { type: "string" },
      since: { type: "string" },
      limit: { type: "string", default: "20" },
      "interval-ms": { type: "string", default: "30000" },
      live: { type: "boolean", default: false },
    },
  });
  if (!values.db || !values.config || !values.out || !values.since)
    throw new Error(
      "--db PATH --config FILE --out NEW_DIR --since ISO [--limit 20 --interval-ms 30000 --live]",
    );
  const config = z
    .object({ baseUrl: z.url(), model: z.string().min(1), revision: z.string().min(1) })
    .parse(JSON.parse(readFileSync(values.config, "utf8")));
  const intervalMs = Number(values["interval-ms"]);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 30_000 || intervalMs > 300_000)
    throw new Error("interval must be 30000..300000ms");
  const db = openReplayDb(values.db);
  let inputs: ShadowInput[];
  try {
    inputs = loadShadowInputs(db, { since: values.since, limit: Number(values.limit) });
  } finally {
    db.close();
  }
  mkdirSync(values.out, { mode: 0o700 });
  const destination = join(values.out, "observations.jsonl");
  writeFileSync(destination, "", { flag: "wx", mode: 0o600 });
  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
  });
  process.once("SIGTERM", () => {
    controller.abort();
  });
  const result = await observeInputs(inputs, {
    live: values.live,
    config,
    fetch,
    intervalMs,
    signal: controller.signal,
    writeDecision: (row) => {
      appendFileSync(destination, JSON.stringify(row) + "\n");
    },
  });
  writeFileSync(join(values.out, "run.json"), JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
