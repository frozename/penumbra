import { beforeAll, expect, test } from "bun:test";

import { fallbackTokenEstimate } from "@src/dispatch/capsule/budget.js";
import { AdvisoryItemSchema } from "@src/dispatch/capsule/schema.js";
import { type Lesson, type LessonEligibilityCtx, LessonSchema } from "@src/evals/lesson.js";

// Input and output shapes are declared locally: lesson-retrieval.ts does not
// exist at the base, so no value or type may be imported from it.
type RetrievalArm = "memory_on" | "memory_off";
type RetrievalUsage = "pending" | "not_retrieved" | "applied" | "ignored";
type RetrievalDecision = "admitted" | "withheld" | "memory_off";
type RetrievalRecord = {
  lesson_id: string;
  eligible: boolean;
  reasons: string[];
  token_cost: number;
  decision: RetrievalDecision;
  usage: RetrievalUsage;
};
type LessonRetrievalTelemetry = {
  arm: RetrievalArm;
  estimator: "tokenizer" | "fallback_estimate";
  records: RetrievalRecord[];
  admitted_tokens: number;
};
type AdvisoryItem = {
  id: string;
  authority: "advisory";
  text: string;
  provenance: { source: string; ref: string };
};
type RetrieveResult = { advisory: AdvisoryItem[]; telemetry: LessonRetrievalTelemetry };
type RetrieveRequest = {
  lessons: readonly unknown[];
  ctx: LessonEligibilityCtx;
  arm: RetrievalArm;
  counter?: (text: string) => number;
};
type RetrieveFn = (request: RetrieveRequest) => RetrieveResult;
type MarkLessonUsageResult =
  | { ok: true; telemetry: LessonRetrievalTelemetry }
  | { ok: false; reason: "unknown_lesson" | "not_admitted" | "already_recorded" };
type MarkLessonUsageFn = (
  telemetry: LessonRetrievalTelemetry,
  lesson_id: string,
  usage: "applied" | "ignored",
) => MarkLessonUsageResult;

interface SchemaLike {
  safeParse: (value: unknown) => { success: boolean };
}

const MOD_URL = new URL("../../src/evals/lesson-retrieval.ts", import.meta.url).href;

async function load(): Promise<Record<string, unknown> | null> {
  try {
    return (await import(MOD_URL)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let mod: Record<string, unknown> | null = null;

beforeAll(async () => {
  mod = await load();
});

const retrieveLessonsForCapsule = (): RetrieveFn =>
  mod?.["retrieveLessonsForCapsule"] as RetrieveFn;
const markLessonUsage = (): MarkLessonUsageFn => mod?.["markLessonUsage"] as MarkLessonUsageFn;
const LessonRetrievalTelemetrySchema = (): SchemaLike =>
  mod?.["LessonRetrievalTelemetrySchema"] as SchemaLike;

const PROJECT = "proj";
const FINAL_SHA = "a".repeat(40);
const HARNESS_SHA = "b".repeat(40);
const ENGINE = "llama.cpp-b4000";
const ENGINE_NEXT = "llama.cpp-b5000";
const LOCK_SHA = "d".repeat(64);
const RECEIPT_DIGEST = "e".repeat(64);

const L1 = "1".repeat(64);
const L2 = "2".repeat(64);
const L3 = "3".repeat(64);
const L4 = "4".repeat(64);
const L5 = "5".repeat(64);
const L6 = "6".repeat(64);
const L7 = "7".repeat(64);
const L9 = "9".repeat(64);

const CREATED_AT = "2026-11-01T00:00:00.000Z";
const EXPIRES_AT = "2027-02-01T00:00:00.000Z";
const EXPIRES_EARLY = "2026-11-15T00:00:00.000Z";
const NOW = "2026-12-01T00:00:00.000Z";

const BASE_SCOPE: Lesson["scope"] = {
  project_id: PROJECT,
  harness_build_sha: HARNESS_SHA,
  engine: ENGINE,
  dependency_lock_sha256: LOCK_SHA,
};

const BASE_CURRENT: LessonEligibilityCtx["current"] = {
  harness_build_sha: HARNESS_SHA,
  engine: ENGINE,
  dependency_lock_sha256: LOCK_SHA,
};

function baseCtx(): LessonEligibilityCtx {
  return {
    now: NOW,
    project_id: PROJECT,
    revoked: [],
    current: { ...BASE_CURRENT },
  };
}

function mk(id: string, overrides: Partial<Lesson> = {}): Lesson {
  return {
    lesson_id: id,
    review: "approved",
    approved_by: "reviewer",
    authority: "advisory",
    polarity: "positive",
    source: {
      episode_id: "ep-1",
      family_id: "fam-1",
      final_sha: FINAL_SHA,
      receipt_digests: [RECEIPT_DIGEST],
    },
    scope: { ...BASE_SCOPE },
    failure_signature: "sig-X",
    root_cause: "cause-Y",
    procedure: ["step one", "step two"],
    applicability: ["when X"],
    exclusions: ["not Y"],
    counterexample: null,
    created_at: CREATED_AT,
    expires_at: EXPIRES_AT,
    contributions: [],
    provenance_gaps: [],
    ...overrides,
  };
}

function withheldLessons(): Lesson[] {
  return [
    mk(L4, { review: "proposed", approved_by: null }),
    mk(L5, { scope: { ...BASE_SCOPE, project_id: "other" } }),
    mk(L6, { polarity: "negative" }),
    mk(L7, { expires_at: EXPIRES_EARLY }),
  ];
}

function recordFor(telemetry: LessonRetrievalTelemetry, lesson_id: string): RetrievalRecord {
  const record = telemetry.records.find((r) => r.lesson_id === lesson_id);
  if (!record) {
    throw new Error(`missing retrieval record for ${lesson_id}`);
  }
  return record;
}

test("fixture sanity", () => {
  const variants: Lesson[] = [
    mk(L1),
    mk(L4, { review: "proposed", approved_by: null }),
    mk(L5, { scope: { ...BASE_SCOPE, project_id: "other" } }),
    mk(L6, { polarity: "negative" }),
    mk(L7, { expires_at: EXPIRES_EARLY }),
    mk(L1, { review: "proposed", approved_by: null }),
  ];
  for (const lesson of variants) {
    expect(LessonSchema.parse(lesson).lesson_id).toBe(lesson.lesson_id);
  }
});

test("retrieve memory_on admits an eligible lesson with telemetry", () => {
  expect(typeof mod?.["retrieveLessonsForCapsule"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = retrieveLessonsForCapsule()({
    lessons: [mk(L1)],
    ctx: baseCtx(),
    arm: "memory_on",
  });
  expect(res.advisory).toHaveLength(1);
  const [item] = res.advisory;
  expect(item).toBeDefined();
  if (!item) {
    return;
  }
  expect(item.id).toBe(`lesson:${L1}`);
  expect(item.authority).toBe("advisory");
  expect(item.provenance).toEqual({ source: "lesson", ref: L1 });
  expect(AdvisoryItemSchema.safeParse(item).success).toBe(true);
  expect(item.text).toContain("sig-X");
  expect(item.text).toContain("cause-Y");
  expect(item.text).toContain("step one");
  expect(item.text).toContain("step two");
  expect(res.telemetry.arm).toBe("memory_on");
  expect(res.telemetry.estimator).toBe("fallback_estimate");
  const tokenCost = fallbackTokenEstimate(item.text);
  expect(res.telemetry.records).toEqual([
    {
      lesson_id: L1,
      eligible: true,
      reasons: [],
      token_cost: tokenCost,
      decision: "admitted",
      usage: "pending",
    },
  ]);
  expect(res.telemetry.admitted_tokens).toBe(tokenCost);
});

test("retrieve memory_on withholds ineligible lessons with reasons", () => {
  expect(typeof mod?.["retrieveLessonsForCapsule"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = retrieveLessonsForCapsule()({
    lessons: withheldLessons(),
    ctx: baseCtx(),
    arm: "memory_on",
  });
  expect(res.advisory).toEqual([]);
  expect(res.telemetry.admitted_tokens).toBe(0);
  expect(res.telemetry.records).toHaveLength(4);
  const expectedReasons: Record<string, string[]> = {
    [L4]: ["not_approved"],
    [L5]: ["cross_project"],
    [L6]: ["negative_example"],
    [L7]: ["expired"],
  };
  for (const [lesson_id, reasons] of Object.entries(expectedReasons)) {
    expect(recordFor(res.telemetry, lesson_id)).toMatchObject({
      lesson_id,
      eligible: false,
      reasons,
      decision: "withheld",
      usage: "not_retrieved",
    });
  }
});

test("retrieve withholds revoked sources and changed engine versions", () => {
  expect(typeof mod?.["retrieveLessonsForCapsule"]).toBe("function");
  if (!mod) {
    return;
  }
  const retrieve = retrieveLessonsForCapsule();
  const revoked = retrieve({
    lessons: [mk(L1)],
    ctx: { ...baseCtx(), revoked: [FINAL_SHA] },
    arm: "memory_on",
  });
  expect(revoked.advisory).toEqual([]);
  expect(revoked.telemetry.records).toHaveLength(1);
  expect(recordFor(revoked.telemetry, L1)).toMatchObject({
    lesson_id: L1,
    eligible: false,
    reasons: ["source_revoked"],
    decision: "withheld",
    usage: "not_retrieved",
  });

  const changed = retrieve({
    lessons: [mk(L1)],
    ctx: { ...baseCtx(), current: { ...BASE_CURRENT, engine: ENGINE_NEXT } },
    arm: "memory_on",
  });
  expect(changed.advisory).toEqual([]);
  expect(changed.telemetry.records).toHaveLength(1);
  expect(recordFor(changed.telemetry, L1)).toMatchObject({
    lesson_id: L1,
    eligible: false,
    reasons: ["source_version_changed"],
    decision: "withheld",
    usage: "not_retrieved",
  });
});

test("retrieve memory_off scores eligibility without admitting", () => {
  expect(typeof mod?.["retrieveLessonsForCapsule"]).toBe("function");
  if (!mod) {
    return;
  }
  const retrieve = retrieveLessonsForCapsule();
  const res = retrieve({ lessons: [mk(L1)], ctx: baseCtx(), arm: "memory_off" });
  expect(res.advisory).toEqual([]);
  expect(res.telemetry.admitted_tokens).toBe(0);
  expect(res.telemetry.arm).toBe("memory_off");
  expect(res.telemetry.records).toHaveLength(1);
  const record = recordFor(res.telemetry, L1);
  expect(record).toMatchObject({
    lesson_id: L1,
    eligible: true,
    reasons: [],
    decision: "memory_off",
    usage: "not_retrieved",
  });
  const on = retrieve({ lessons: [mk(L1)], ctx: baseCtx(), arm: "memory_on" });
  expect(record.token_cost).toBe(recordFor(on.telemetry, L1).token_cost);
});

test("retrieve uses the injected counter when it succeeds", () => {
  expect(typeof mod?.["retrieveLessonsForCapsule"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = retrieveLessonsForCapsule()({
    lessons: [mk(L1)],
    ctx: baseCtx(),
    arm: "memory_on",
    counter: (): number => 7,
  });
  const record = recordFor(res.telemetry, L1);
  expect(record.token_cost).toBe(7);
  expect(res.telemetry.estimator).toBe("tokenizer");
  expect(res.telemetry.admitted_tokens).toBe(7);
});

test("retrieve falls back per item when the counter throws", () => {
  expect(typeof mod?.["retrieveLessonsForCapsule"]).toBe("function");
  if (!mod) {
    return;
  }
  const counter = (text: string): number => {
    if (text.includes(L1)) {
      return 7;
    }
    throw new Error("x");
  };
  const res = retrieveLessonsForCapsule()({
    lessons: [mk(L1), mk(L2)],
    ctx: baseCtx(),
    arm: "memory_on",
    counter,
  });
  expect(res.advisory).toHaveLength(2);
  expect(recordFor(res.telemetry, L1).token_cost).toBe(7);
  const item2 = res.advisory.find((item) => item.id === `lesson:${L2}`);
  expect(item2).toBeDefined();
  if (!item2) {
    return;
  }
  expect(recordFor(res.telemetry, L2).token_cost).toBe(fallbackTokenEstimate(item2.text));
  expect(res.telemetry.estimator).toBe("fallback_estimate");
});

test("retrieve withholds duplicate lesson ids under both arms", () => {
  expect(typeof mod?.["retrieveLessonsForCapsule"]).toBe("function");
  if (!mod) {
    return;
  }
  const retrieve = retrieveLessonsForCapsule();
  const expectedDuplicate: RetrievalRecord = {
    lesson_id: L1,
    eligible: false,
    reasons: ["duplicate_lesson_id"],
    token_cost: 0,
    decision: "withheld",
    usage: "not_retrieved",
  };
  for (const arm of ["memory_on", "memory_off"] as const) {
    const res = retrieve({ lessons: [mk(L1), mk(L1)], ctx: baseCtx(), arm });
    expect(res.telemetry.records).toEqual([expectedDuplicate]);
    expect(res.advisory).toEqual([]);
  }

  const mixed = retrieve({
    lessons: [mk(L1), mk(L1, { review: "proposed", approved_by: null })],
    ctx: baseCtx(),
    arm: "memory_on",
  });
  const dupRecords = mixed.telemetry.records.filter((r) => r.lesson_id === L1);
  expect(dupRecords).toHaveLength(1);
  expect(dupRecords[0]).toMatchObject({
    lesson_id: L1,
    eligible: false,
    reasons: ["duplicate_lesson_id", "not_approved"],
    decision: "withheld",
    usage: "not_retrieved",
  });
  expect(mixed.advisory).toEqual([]);
});

test("retrieve withholds schema-invalid lessons as invalid:<index>", () => {
  expect(typeof mod?.["retrieveLessonsForCapsule"]).toBe("function");
  if (!mod) {
    return;
  }
  const retrieve = retrieveLessonsForCapsule();
  const invalidRecord: RetrievalRecord = {
    lesson_id: "invalid:0",
    eligible: false,
    reasons: ["invalid_lesson_schema"],
    token_cost: 0,
    decision: "withheld",
    usage: "not_retrieved",
  };
  const mixed = retrieve({
    lessons: [{ ...mk(L1), authority: "binding" }, mk(L2)],
    ctx: baseCtx(),
    arm: "memory_on",
  });
  const invalidRec = mixed.telemetry.records.find((r) => r.lesson_id === "invalid:0");
  expect(invalidRec).toEqual(invalidRecord);
  expect(mixed.advisory).toHaveLength(1);
  expect(mixed.advisory[0]?.id).toBe(`lesson:${L2}`);
  expect(recordFor(mixed.telemetry, L2)).toMatchObject({
    lesson_id: L2,
    eligible: true,
    decision: "admitted",
    usage: "pending",
  });

  const extraKey = retrieve({
    lessons: [{ ...mk(L1), grants_tools: ["Bash"] }],
    ctx: baseCtx(),
    arm: "memory_on",
  });
  expect(extraKey.telemetry.records).toEqual([invalidRecord]);
  expect(extraKey.advisory).toEqual([]);
});

test("retrieve orders records and advisory deterministically", () => {
  expect(typeof mod?.["retrieveLessonsForCapsule"]).toBe("function");
  if (!mod) {
    return;
  }
  const input: RetrieveRequest = {
    lessons: [mk(L3), mk(L1), mk(L2)],
    ctx: baseCtx(),
    arm: "memory_on",
  };
  const retrieve = retrieveLessonsForCapsule();
  const first = retrieve(input);
  const second = retrieve(input);
  expect(first.telemetry.records.map((r) => r.lesson_id)).toEqual([L1, L2, L3]);
  expect(first.advisory.map((item) => item.id)).toEqual([
    `lesson:${L1}`,
    `lesson:${L2}`,
    `lesson:${L3}`,
  ]);
  expect(second).toEqual(first);
});

test("LessonRetrievalTelemetrySchema enforces a strict telemetry shape", () => {
  expect(typeof mod?.["retrieveLessonsForCapsule"]).toBe("function");
  expect(mod?.["LessonRetrievalTelemetrySchema"]).toBeDefined();
  if (!mod) {
    return;
  }
  const retrieve = retrieveLessonsForCapsule();
  const schema = LessonRetrievalTelemetrySchema();
  const admitted = retrieve({ lessons: [mk(L1)], ctx: baseCtx(), arm: "memory_on" }).telemetry;
  const withheld = retrieve({
    lessons: withheldLessons(),
    ctx: baseCtx(),
    arm: "memory_on",
  }).telemetry;
  const control = retrieve({ lessons: [mk(L1)], ctx: baseCtx(), arm: "memory_off" }).telemetry;
  for (const telemetry of [admitted, withheld, control]) {
    expect(schema.safeParse(telemetry).success).toBe(true);
  }
  expect(schema.safeParse({ ...admitted, extra: 1 }).success).toBe(false);
  const firstRecord = admitted.records[0];
  expect(firstRecord).toBeDefined();
  if (!firstRecord) {
    return;
  }
  expect(
    schema.safeParse({
      ...admitted,
      records: [{ ...firstRecord, extra: 1 }, ...admitted.records.slice(1)],
    }).success,
  ).toBe(false);
});

test("markLessonUsage records applied and ignored usage immutably", () => {
  expect(typeof mod?.["retrieveLessonsForCapsule"]).toBe("function");
  expect(typeof mod?.["markLessonUsage"]).toBe("function");
  if (!mod) {
    return;
  }
  const retrieve = retrieveLessonsForCapsule();
  const mark = markLessonUsage();
  const { telemetry } = retrieve({ lessons: [mk(L1)], ctx: baseCtx(), arm: "memory_on" });
  const before = structuredClone(telemetry);

  const applied = mark(telemetry, L1, "applied");
  expect(applied.ok).toBe(true);
  if (applied.ok) {
    expect(recordFor(applied.telemetry, L1)).toEqual({
      ...recordFor(telemetry, L1),
      usage: "applied",
    });
  }
  expect(telemetry).toEqual(before);

  const ignored = mark(telemetry, L1, "ignored");
  expect(ignored.ok).toBe(true);
  if (ignored.ok) {
    expect(recordFor(ignored.telemetry, L1)).toEqual({
      ...recordFor(telemetry, L1),
      usage: "ignored",
    });
  }
  expect(telemetry).toEqual(before);

  expect(mark(telemetry, L9, "applied")).toEqual({ ok: false, reason: "unknown_lesson" });

  const withheldTelemetry = retrieve({
    lessons: withheldLessons(),
    ctx: baseCtx(),
    arm: "memory_on",
  }).telemetry;
  expect(mark(withheldTelemetry, L4, "applied")).toEqual({
    ok: false,
    reason: "not_admitted",
  });

  const controlTelemetry = retrieve({
    lessons: [mk(L1)],
    ctx: baseCtx(),
    arm: "memory_off",
  }).telemetry;
  expect(mark(controlTelemetry, L1, "applied")).toEqual({
    ok: false,
    reason: "not_admitted",
  });

  const once = mark(telemetry, L1, "applied");
  expect(once.ok).toBe(true);
  if (once.ok) {
    expect(mark(once.telemetry, L1, "ignored")).toEqual({
      ok: false,
      reason: "already_recorded",
    });
  }
});
