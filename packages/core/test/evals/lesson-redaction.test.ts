import { beforeAll, expect, test } from "bun:test";

// Input and output shapes are declared locally: lesson-redaction.ts does not
// exist at the base, so no value or type may be imported from it.
type LessonDraft = {
  project_id: string;
  polarity: "positive" | "negative";
  failure_signature: string;
  root_cause: string;
  procedure: string[];
  applicability: string[];
  exclusions: string[];
  counterexample: string | null;
  created_at: string;
  expires_at: string;
};
type RedactionEntry = { rule_id: string; count: number };
type RedactResult = { draft: LessonDraft; redactions: RedactionEntry[] };
type RedactOpts = { production_identifiers?: string[] };
type RedactFn = (draft: LessonDraft, opts?: RedactOpts) => RedactResult;

const MOD_URL = new URL("../../src/evals/lesson-redaction.ts", import.meta.url).href;

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

const redactLessonDraft = (): RedactFn => mod?.["redactLessonDraft"] as RedactFn;

const CREATED_AT = "2026-11-01T00:00:00.000Z";
const EXPIRES_AT = "2027-02-01T00:00:00.000Z";

function draft(overrides: Partial<LessonDraft> = {}): LessonDraft {
  return {
    project_id: "penumbra",
    polarity: "positive",
    failure_signature: "bun test hangs on unclosed sqlite handle",
    root_cause: "db handle left open",
    procedure: ["close db in afterAll"],
    applicability: ["packages/core tests"],
    exclusions: ["daemon integration"],
    counterexample: null,
    created_at: CREATED_AT,
    expires_at: EXPIRES_AT,
    ...overrides,
  };
}

test("redact: production identifiers are replaced in every text field", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const id = "db-prod-7.acme.example";
  const input = draft({
    failure_signature: `pool checkout failed on ${id}`,
    root_cause: `connection refused by ${id}`,
    procedure: [`fail over away from ${id}`],
    applicability: [`only while ${id} is primary`],
    exclusions: [`never pin ${id} in config`],
    counterexample: `green while ${id} was healthy`,
  });
  const res = redactLessonDraft()(input, { production_identifiers: [id] });
  expect(res.draft.failure_signature).toBe(
    "pool checkout failed on [REDACTED:production_identifier]",
  );
  expect(res.draft.root_cause).toBe("connection refused by [REDACTED:production_identifier]");
  expect(res.draft.procedure[0]).toBe("fail over away from [REDACTED:production_identifier]");
  expect(res.draft.applicability[0]).toBe("only while [REDACTED:production_identifier] is primary");
  expect(res.draft.exclusions[0]).toBe("never pin [REDACTED:production_identifier] in config");
  expect(res.draft.counterexample).toBe("green while [REDACTED:production_identifier] was healthy");
  expect(res.redactions).toEqual([{ rule_id: "production_identifier", count: 6 }]);
});

test("redact: identifier matching ignores case", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({ root_cause: "pool exhausted on DB-PROD-7.ACME.EXAMPLE" }),
    { production_identifiers: ["db-prod-7.acme.example"] },
  );
  expect(res.draft.root_cause).toBe("pool exhausted on [REDACTED:production_identifier]");
  expect(res.redactions).toEqual([{ rule_id: "production_identifier", count: 1 }]);
});

test("redact: the longest production identifier wins", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "acme-prod-cluster down" }), {
    production_identifiers: ["acme", "acme-prod-cluster"],
  });
  expect(res.draft.root_cause).toBe("[REDACTED:production_identifier] down");
  expect(res.redactions).toEqual([{ rule_id: "production_identifier", count: 1 }]);
});

test("redact: identifier matching is literal, not regex", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(draft({ root_cause: "svcXprod restart loop" }), {
    production_identifiers: ["svc.prod"],
  });
  expect(res.draft.root_cause).toBe("svcXprod restart loop");
  expect(res.redactions).toEqual([]);
});

test("redact: empty and whitespace identifiers are ignored", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const input = draft({ root_cause: "db handle left open" });
  const res = redactLessonDraft()(input, { production_identifiers: ["", "  "] });
  expect(res.draft).toEqual(input);
  expect(res.redactions).toEqual([]);
});

test("redact: home paths collapse to ~", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({
      root_cause: "lock held under /Users/alex/work/x",
      procedure: ["cd /home/bob/repo && bun test"],
    }),
  );
  expect(res.draft.root_cause).toBe("lock held under ~/work/x");
  expect(res.draft.procedure[0]).toBe("cd ~/repo && bun test");
  expect(res.redactions).toEqual([{ rule_id: "home_path", count: 2 }]);
});

test("redact: email and ipv4 built-ins fire while partial addresses stay", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({
      failure_signature: "dial 10.20.30.40 timed out",
      root_cause: "ops@acme.example bounced the alert",
      procedure: ["ping 1.2.3 for reachability"],
      applicability: ["hosts like 999.1.1.1 are out of scope"],
    }),
  );
  expect(res.draft.failure_signature).toBe("dial [REDACTED:ipv4] timed out");
  expect(res.draft.root_cause).toBe("[REDACTED:email] bounced the alert");
  expect(res.draft.procedure[0]).toBe("ping 1.2.3 for reachability");
  expect(res.draft.applicability[0]).toBe("hosts like 999.1.1.1 are out of scope");
  expect(res.redactions).toEqual([
    { rule_id: "email", count: 1 },
    { rule_id: "ipv4", count: 1 },
  ]);
});

test("redact: scope fields are untouched and the input is not mutated", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const id = "db-prod-7.acme.example";
  const input = draft({ project_id: id, counterexample: null });
  const before = structuredClone(input);
  const res = redactLessonDraft()(input, { production_identifiers: [id] });
  expect(res.draft.project_id).toBe(id);
  expect(res.draft.polarity).toBe("positive");
  expect(res.draft.created_at).toBe(CREATED_AT);
  expect(res.draft.expires_at).toBe(EXPIRES_AT);
  expect(res.draft.counterexample).toBeNull();
  expect(res.draft).toEqual(before);
  expect(input).toEqual(before);
  expect(res.redactions).toEqual([]);
});

test("redact: redactions are sorted, omit zero-hit rules, and sum across fields", () => {
  expect(typeof mod?.["redactLessonDraft"]).toBe("function");
  if (!mod) {
    return;
  }
  const res = redactLessonDraft()(
    draft({
      failure_signature: "flaky on db-prod-7.acme.example",
      root_cause: "page ops@acme.example",
      procedure: ["cc admin@acme.example"],
    }),
    { production_identifiers: ["db-prod-7.acme.example"] },
  );
  expect(res.draft.root_cause).toBe("page [REDACTED:email]");
  expect(res.draft.procedure[0]).toBe("cc [REDACTED:email]");
  expect(res.redactions).toEqual([
    { rule_id: "email", count: 2 },
    { rule_id: "production_identifier", count: 1 },
  ]);
});
