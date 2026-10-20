import { expect, test } from "bun:test";
import { z } from "zod";

import { parseStructured, renderJsonContract } from "./structured.js";

const PlanSchema = z.object({
  tasks: z.array(z.object({ message: z.string().min(1), task_name: z.string().min(1) })).min(1),
});

test("parseStructured accepts the LAST fenced json block", () => {
  const text = [
    "Here is a draft:",
    "```json",
    '{"tasks":[]}',
    "```",
    "On reflection, the real answer:",
    "```json",
    '{"tasks":[{"task_name":"alpha","message":"do alpha"}]}',
    "```",
  ].join("\n");

  const out = parseStructured(text, PlanSchema);
  expect(out.ok).toBe(true);
  if (out.ok) expect(out.value.tasks[0]?.task_name).toBe("alpha");
});

test("parseStructured reports no_json_block for prose and for empty output", () => {
  expect(parseStructured("I could not do it", PlanSchema)).toEqual({
    error: "no_json_block",
    ok: false,
  });
  expect(parseStructured(null, PlanSchema)).toEqual({
    error: "no_json_block",
    ok: false,
  });
  expect(parseStructured("", PlanSchema)).toEqual({ error: "no_json_block", ok: false });
});

test("parseStructured reports invalid_json for a malformed block", () => {
  const out = parseStructured("```json\n{tasks:[}\n```", PlanSchema);
  expect(out).toEqual({ error: "invalid_json", ok: false });
});

test("parseStructured rejects an unterminated final json fence even after a valid draft", () => {
  const out = parseStructured(
    [
      "```json",
      '{"tasks":[{"task_name":"draft","message":"do draft"}]}',
      "```",
      "Second attempt starts here:",
      "```json",
      '{"tasks":[{"task_name":"alpha","message":"do alpha"}]',
    ].join("\n"),
    PlanSchema,
  );
  expect(out).toEqual({ error: "invalid_json", ok: false });
});

test("parseStructured rejects case-insensitive unterminated json fences", () => {
  const validDraft = [
    "```json",
    '{"tasks":[{"task_name":"draft","message":"do draft"}]}',
    "```",
  ].join("\n");

  for (const fence of ["```JSON", "```Json"]) {
    const incomplete = `${fence}\n{"tasks":[`;
    expect(parseStructured(`${validDraft}\n${incomplete}`, PlanSchema)).toEqual({
      error: "invalid_json",
      ok: false,
    });
    expect(parseStructured(incomplete, PlanSchema)).toEqual({ error: "invalid_json", ok: false });
  }
});

test("parseStructured fails closed on a well-formed block that violates the schema", () => {
  // The exact swarm failure mode: valid JSON, wrong shape, silently empty fan-out.
  const out = parseStructured('```json\n{"tasks":[]}\n```', PlanSchema);
  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.error).toBe("schema_violation");
    expect(out.issues?.length).toBeGreaterThan(0);
  }
});

test("parseStructured duck-types the schema rather than checking zod identity", () => {
  // A schema from a DIFFERENT zod copy has no shared prototype; only safeParse
  // is contractual across the loader's bundle boundary.
  const foreign = { safeParse: (v: unknown) => ({ data: v as { n: number }, success: true }) };
  const out = parseStructured('```json\n{"n":1}\n```', foreign);
  expect(out.ok).toBe(true);
  if (out.ok) expect(out.value.n).toBe(1);
});

test("parseStructured renders symbol issue paths safely", () => {
  const symbolIssuePathSchema = z.object({ task: z.string() }).superRefine((_, context) => {
    context.addIssue({
      code: "custom",
      message: "symbol path",
      path: [Symbol("bad_path")],
    });
  });

  const out = parseStructured('```json\n{"task":"alpha"}\n```', symbolIssuePathSchema);
  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.error).toBe("schema_violation");
    expect(out.issues?.[0]).toContain("Symbol(bad_path)");
    expect(out.issues?.[0]).toContain("symbol path");
  }
});

test("parseStructured wraps sync safeParse throw as schema_violation", () => {
  const throwingSchema = z.string().superRefine(() => {
    throw new Error("sync parser failure");
  });
  const out = parseStructured('```json\n"ok"\n```', throwingSchema);
  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.error).toBe("schema_violation");
    expect(out.issues?.[0]).toContain("sync parser failure");
  }
});

test("parseStructured wraps async safeParse throw as schema_violation", () => {
  const asyncSchema = z.string().superRefine(async () => {
    return;
  });
  const out = parseStructured('```json\n"ok"\n```', asyncSchema);
  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.error).toBe("schema_violation");
    expect(out.issues?.[0]).toContain("Encountered Promise during synchronous parse");
  }
});

test("parseStructured rejects malformed json before running safeParse", () => {
  const throwingSchema = z.string().superRefine(() => {
    throw new Error("never run");
  });
  const out = parseStructured("```json\n{oops:}\n```", throwingSchema);
  expect(out).toEqual({ error: "invalid_json", ok: false });
});

test("renderJsonContract emits an unambiguous last-block instruction", () => {
  const contract = renderJsonContract({
    example: '{"tasks":[{"task_name":"short-label","message":"the full dispatch prompt"}]}',
    name: "plan",
  });
  expect(contract).toContain("```json");
  expect(contract).toContain("very end");
  expect(contract).toContain('{"tasks":[{"task_name":"short-label"');
  expect(contract).toContain("plan");
});
