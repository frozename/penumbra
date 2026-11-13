import { expect, test } from "bun:test";

import {
  fixtureSchema,
  questionsFor,
  runJudgeBench,
  summarizeBench,
} from "./system-one-judge-bench.js";
import { comparePromotion } from "./system-one-judge-compare.js";

const fixture = fixtureSchema.parse({
  id: "x",
  family: "x",
  workload: "promotion",
  split: "test",
  state: { body: "a finding", kind: "promote_t1" },
  labels: { promote: true },
  labelRationale: "learned",
  labeler: "author",
  labelStatus: "provisional-single-annotator",
  source: { kind: "synthetic" },
  tags: [],
});
const config = {
  protocol: "systemone" as const,
  model: "local",
  revision: "sha",
  baseUrl: "http://127.0.0.1:18944",
  hardware: "test",
  runtime: "test",
  quantization: "test",
  contextTokens: 4096,
  timeoutMs: 50,
};

test("dry run performs no inference and does not claim measured quality", async () => {
  let calls = 0;
  const result = await runJudgeBench(config, [fixture], {
    live: false,
    fetch: () => {
      calls++;
      return Promise.reject(new Error("network"));
    },
  });
  expect(calls).toBe(0);
  expect(result.rows).toHaveLength(0);
  expect(result.status).toBe("not_run");
});

test("independent AI labels require distinct reviewers and explicit provenance", () => {
  const ai = { ...fixture, labelStatus: "independently-ai-reviewed" };
  expect(fixtureSchema.safeParse(ai).success).toBe(false);
  const provenance = {
    method: "blind-source-checks",
    reviewers: ["reviewer-a", "reviewer-b"],
    commonBaseModel: true,
    factualSupport: "verified",
    evidence: ["packages/core/src/db/schema.ts:122"],
  };
  expect(fixtureSchema.safeParse({ ...ai, reviewProvenance: provenance }).success).toBe(true);
  expect(
    fixtureSchema.safeParse({
      ...ai,
      reviewProvenance: { ...provenance, reviewers: ["reviewer-a", "reviewer-a"] },
    }).success,
  ).toBe(false);
});

test("paired comparisons exclude uncertain unlabeled cases rather than counting them as negatives", async () => {
  const pending = {
    ...fixture,
    id: "pending",
    family: "pending",
    state: { body: "incomplete claim", kind: "promote_t1" },
    labels: {},
  };
  const fixtures = [fixture, pending];
  const run = await runJudgeBench(config, fixtures, {
    live: true,
    fetch: () =>
      Promise.resolve(
        Response.json({
          model: "local",
          answers: Object.fromEntries(
            Object.keys(questionsFor(fixture)).map((id) => [id, { type: "noul", noul: 0.9 }]),
          ),
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
      ),
  });
  const paired = comparePromotion(run, run, fixtures);
  expect(paired.selected).toBe(1);
  expect(paired.commonAnswered).toBe(1);
  expect(paired.candidate).toMatchObject({ tp: 1, fp: 0, fn: 0 });
});

test("responses, failures and repeated requests remain non-authoritative and coverage is honest", async () => {
  let calls = 0;
  const output = await runJudgeBench(config, [fixture], {
    live: true,
    repeats: 2,
    fetch: (_url, init) => {
      calls++;
      const req = JSON.parse(init.body) as { questions: Record<string, unknown> };
      expect(init.body).not.toContain("labelRationale");
      expect(init.body).not.toContain("provisional-single-annotator");
      return Promise.resolve(
        Response.json({
          model: "local",
          answers: Object.fromEntries(
            Object.keys(req.questions).map((id) => [
              id,
              { type: "noul", noul: id === "promote" ? 0.9 : 0.1 },
            ]),
          ),
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
      );
    },
  });
  expect(calls).toBe(2);
  expect(output.rows.map((row) => ({ mode: row.mode, applied: row.applied }))).toEqual([
    { mode: "shadow", applied: false },
    { mode: "shadow", applied: false },
  ]);
  const report = summarizeBench(output, [fixture]);
  expect(report.quality.test?.promote).toMatchObject({ selected: 1, answered: 1, tp: 1 });
});

test("timeout abstains and cannot become a correct rejection", async () => {
  const output = await runJudgeBench(config, [fixture], {
    live: true,
    fetch: () => Promise.reject(new Error("unavailable")),
  });
  expect(summarizeBench(output, [fixture]).quality.test?.promote).toMatchObject({
    answered: 0,
    abstained: 1,
  });
});

test("shared question set preserves existing TypeSafe promotion questions and untrusted-data notice", () => {
  expect(Object.keys(questionsFor(fixture))).toHaveLength(5);
  expect(questionsFor(fixture).promote?.instructions).toContain("untrusted");
});

test("constrained Granite control receives the same direct policy with separate untrusted state", async () => {
  const output = await runJudgeBench({ ...config, protocol: "constrained-promotion" }, [fixture], {
    live: true,
    fetch: (_url, init) => {
      const body = JSON.parse(init.body) as { messages: { content: string }[] };
      expect(body.messages[0]?.content).toContain("untrusted");
      expect(body.messages[1]?.content).toContain("a finding");
      return Promise.resolve(
        Response.json({
          choices: [
            { message: { content: '{"promote":true,"confidence":0.9}' }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 8 },
        }),
      );
    },
  });
  expect(output.rows[0]?.answers.promote).toEqual({ type: "noul", noul: 0.9 });
});
