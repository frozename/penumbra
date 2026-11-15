import { getConfig } from "@penumbra/config";
import { readJudgeDecisions } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { buildDreamingConfig } from "@src/dreaming/config.js";
import { makeFakeJudgePool } from "@src/dreaming/judge-pool.js";
import { wireLocalPromotionShadow } from "@src/dreaming/local-promotion-shadow-runtime.js";
import { drainShadowJudgements } from "@src/dreaming/typesafe-judge-seat.js";

function database(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE judge_decisions (
    decision_id TEXT PRIMARY KEY, site TEXT, subject_id TEXT, mode TEXT,
    model TEXT, incumbent_json TEXT, jev_json TEXT, applied INTEGER,
    usage_input_tokens INTEGER, created_at TEXT)`);
  db.run(`CREATE TABLE subsystem_health (
    subsystem TEXT PRIMARY KEY, tier TEXT, seat TEXT, model TEXT, host TEXT,
    consecutive_failures INTEGER DEFAULT 0, last_success_ts TEXT, last_failure_ts TEXT,
    last_failure_reason TEXT, last_failure_status INTEGER, first_non_primary_ts TEXT,
    last_skip_ts TEXT, updated_at TEXT)`);
  return db;
}

const config = { baseUrl: "http://127.0.0.1:18944", model: "nano", revision: "sha256:pin" };
const args = { body: "private memory", kind: "promote_t1" as const, subjectId: "rollup" };

test("local shadow config defaults off and requires explicit pins when enabled", () => {
  expect(buildDreamingConfig(getConfig({})).localPromotionShadow).toBeUndefined();
  expect(() => buildDreamingConfig(getConfig({ PENUMBRA_LOCAL_JUDGE_SHADOW: "1" }))).toThrow();
  expect(() => getConfig({ PENUMBRA_LOCAL_JUDGE_SHADOW: "veto" })).toThrow();
  const parsed = buildDreamingConfig(
    getConfig({
      PENUMBRA_LOCAL_JUDGE_SHADOW: "1",
      PENUMBRA_LOCAL_JUDGE_MODEL: "nano",
      PENUMBRA_LOCAL_JUDGE_REVISION: "sha256:pin",
    }),
  );
  expect(parsed.localPromotionShadow).toEqual(config);
  const bundle = getConfig({});
  expect(
    buildDreamingConfig({ ...bundle, env: { ...bundle.env, PENUMBRA_LOCAL_JUDGE_SHADOW: "veto" } })
      .localPromotionShadow,
  ).toBeUndefined();
});

test("disabled local shadow preserves object identity and makes no requests", async () => {
  const db = database();
  try {
    const pool = makeFakeJudgePool([{ promote: true, confidence: 1 }]);
    const wired = wireLocalPromotionShadow(pool, undefined, db, {});
    expect(wired).toBe(pool);
    expect(await wired.judgeAll?.(args)).toEqual([{ promote: true, confidence: 1 }]);
    expect(readJudgeDecisions(db)).toHaveLength(0);
  } finally {
    db.close();
  }
});

test("local stream stores failures and probabilities without rationale or authority", async () => {
  const db = database();
  const votes = [{ promote: true, confidence: 0.8, rationale: "private reasoning" }];
  try {
    const pool = makeFakeJudgePool(votes);
    const wired = wireLocalPromotionShadow(pool, config, db, {
      localJudgeFetch: () =>
        Promise.resolve(
          Response.json({
            model: "nano",
            answers: { promote: { type: "noul", noul: 0.1 } },
            usage: { input_tokens: 23, output_tokens: 0 },
          }),
        ),
    });
    expect(await wired.judgeAll?.(args)).toBe(votes);
    await drainShadowJudgements(2000);
    const rows = readJudgeDecisions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      site: "dream.p1.local-promotion-shadow",
      model: "nano",
      mode: "shadow",
      applied: false,
      usageInputTokens: 23,
    });
    expect(rows[0]?.jev).toMatchObject({
      provider: "local-system-one",
      revision: config.revision,
      probability: 0.1,
      candidatePromote: false,
      failure: null,
    });
    expect(JSON.stringify(rows)).not.toContain("private memory");
    expect(JSON.stringify(rows)).not.toContain("private reasoning");
    expect(db.query("SELECT consecutive_failures FROM subsystem_health").get()).toEqual({
      consecutive_failures: 0,
    });
  } finally {
    db.close();
  }
});

test("rebuilds share admission, backpressure and process request cap", async () => {
  const db = database();
  let now = 0;
  let calls = 0;
  const services = {
    localJudgeNow: (): number => now,
    localJudgeFetch: (): Promise<Response> => {
      calls++;
      return Promise.resolve(
        Response.json({
          model: "wrong-model",
          answers: { promote: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
      );
    },
  };
  try {
    const pool = makeFakeJudgePool([{ promote: false, confidence: 1 }]);
    for (let i = 0; i < 51; i++) {
      const wired = wireLocalPromotionShadow(pool, config, db, services);
      await Promise.all([wired.judgeAll?.(args), wired.judgeAll?.(args)]);
      await drainShadowJudgements(2000);
      if (i === 0) {
        await wired.judgeAll?.(args);
        await drainShadowJudgements(2000);
        expect(calls).toBe(1);
      }
      now += 30_000;
    }
    expect(calls).toBe(50);
    expect(readJudgeDecisions(db)).toHaveLength(50);
    expect(readJudgeDecisions(db)[0]?.jev).toMatchObject({
      failure: "invalid_response",
      model: "nano",
    });
  } finally {
    db.close();
  }
});

test("remote configuration fails closed without fetching or changing incumbent", async () => {
  const db = database();
  let calls = 0;
  const pool = makeFakeJudgePool([{ promote: false, confidence: 1 }]);
  try {
    const wired = wireLocalPromotionShadow(
      pool,
      { ...config, baseUrl: "https://hosted.example" },
      db,
      {
        localJudgeFetch: () => {
          calls++;
          throw new Error("must not fetch");
        },
      },
    );
    expect(await wired.judgeAll?.(args)).toEqual([{ promote: false, confidence: 1 }]);
    await drainShadowJudgements(2000);
    expect(calls).toBe(0);
    expect(readJudgeDecisions(db)).toHaveLength(0);
  } finally {
    db.close();
  }
});
