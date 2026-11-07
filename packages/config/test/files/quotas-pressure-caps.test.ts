import type { z } from "zod";

import { describe, expect, test } from "bun:test";

import { QuotasConfigSchema } from "@src/files/quotas.js";

type BranchIssue = { path: PropertyKey[]; code: string; message: string };

function parseCaps(pressureCaps: unknown): ReturnType<typeof QuotasConfigSchema.safeParse> {
  return QuotasConfigSchema.safeParse({
    providers: [{ name: "google", pressure_caps: pressureCaps }],
  });
}

function branchIssues(pressureCaps: unknown): BranchIssue[] {
  const issues = parseCaps(pressureCaps).error?.issues ?? [];
  return issues
    .flatMap((issue) => (issue.code === "invalid_union" ? issue.errors.flat() : [issue]))
    .map((issue) => ({
      path: [...issue.path],
      code: issue.code,
      message: issue.message,
    }));
}

// expect.objectContaining returns any; narrowing to the element type keeps
// toContainEqual's typed parameter from tripping no-unsafe-argument.
function issueMatcher<T>(shape: Partial<T>): T {
  return expect.objectContaining(shape) as T;
}

describe("pressure_caps", () => {
  test("object form with warn omitted normalizes warn to null", () => {
    const result = parseCaps({ five_hour: { refuse: 90 } });
    expect(result.success).toBe(true);
    const caps = result.data?.providers[0]?.pressure_caps;
    expect(caps?.five_hour).toEqual({ warn: null, refuse: 90 });
    expect(caps?.five_hour?.warn).toBeNull();
  });

  test("object form accepts an explicit warn: null", () => {
    const result = parseCaps({ five_hour: { warn: null, refuse: 90 } });
    expect(result.success).toBe(true);
    expect(result.data?.providers[0]?.pressure_caps?.five_hour?.warn).toBeNull();
  });

  test("rejects warn equal to refuse with a warn-path custom issue", () => {
    expect(branchIssues({ five_hour: { warn: 90, refuse: 90 } })).toContainEqual({
      path: ["warn"],
      code: "custom",
      message: "warn must be < refuse",
    });
  });

  test("rejects warn above refuse with the same custom issue", () => {
    expect(branchIssues({ five_hour: { warn: 95, refuse: 90 } })).toContainEqual({
      path: ["warn"],
      code: "custom",
      message: "warn must be < refuse",
    });
  });

  test("the rejection surfaces as one invalid_union issue at the window path", () => {
    expect(
      parseCaps({ five_hour: { warn: 90, refuse: 90 } }).error?.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
      })),
    ).toEqual([{ code: "invalid_union", path: ["providers", 0, "pressure_caps", "five_hour"] }]);
  });

  test("object form rejects warn below 1 via the min bound", () => {
    const issues = branchIssues({ five_hour: { warn: 0, refuse: 90 } });
    expect(issues).toContainEqual(issueMatcher<BranchIssue>({ path: ["warn"], code: "too_small" }));
    expect(issues.some((issue) => issue.message === "warn must be < refuse")).toBe(false);
  });

  test("object form rejects refuse above 100", () => {
    expect(branchIssues({ five_hour: { warn: 50, refuse: 101 } })).toContainEqual(
      issueMatcher<BranchIssue>({ path: ["refuse"], code: "too_big" }),
    );
  });

  test("shorthand accepts the 100 upper bound", () => {
    const result = parseCaps({ five_hour: 100 });
    expect(result.success).toBe(true);
    expect(result.data?.providers[0]?.pressure_caps?.five_hour).toEqual({
      warn: null,
      refuse: 100,
    });
  });

  test("shorthand rejects 101 via the max bound", () => {
    expect(branchIssues({ five_hour: 101 })).toContainEqual(
      issueMatcher<BranchIssue>({ path: [], code: "too_big" }),
    );
  });

  test("shorthand rejects 0 via the min bound", () => {
    expect(branchIssues({ five_hour: 0 })).toContainEqual(
      issueMatcher<BranchIssue>({ path: [], code: "too_small" }),
    );
  });

  test("shorthand rejects a non-integer", () => {
    const issues = branchIssues({ five_hour: 50.5 });
    expect(issues).toContainEqual({
      path: [],
      code: "invalid_type",
      message: "Invalid input: expected int, received number",
    });
    const intIssue = issues.find(
      (issue) =>
        issue.path.length === 0 && issue.code === "invalid_type" && issue.message.includes("int"),
    );
    expect(intIssue).toBeDefined();
    expect(intIssue?.message).not.toContain("object");
  });

  const OTHER_WINDOW_LABELS = [
    "daily",
    "seven_day",
    "thirty_day",
    "rolling-5h",
    "primary",
    "secondary",
  ] as const;

  test.each([...OTHER_WINDOW_LABELS])("accepts the %s window label", (label) => {
    const result = parseCaps({ [label]: 40 });
    expect(result.success).toBe(true);
    expect(result.data?.providers[0]?.pressure_caps?.[label]).toEqual({
      warn: null,
      refuse: 40,
    });
  });
});

describe("opencode_console", () => {
  test("defaults base_url to https://opencode.ai when omitted", () => {
    const result = QuotasConfigSchema.safeParse({
      providers: [
        { name: "opencode-go", opencode_console: { workspace_id: "ws", cookie_file: "c" } },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data?.providers[0]?.opencode_console?.base_url).toBe("https://opencode.ai");
  });

  test("rejects an empty workspace_id", () => {
    const result = QuotasConfigSchema.safeParse({
      providers: [
        { name: "opencode-go", opencode_console: { workspace_id: "", cookie_file: "c" } },
      ],
    });
    expect(result.error?.issues).toContainEqual(
      issueMatcher<z.core.$ZodIssue>({
        path: ["providers", 0, "opencode_console", "workspace_id"],
        code: "too_small",
      }),
    );
  });

  test("requires cookie_file", () => {
    const result = QuotasConfigSchema.safeParse({
      providers: [{ name: "opencode-go", opencode_console: { workspace_id: "ws" } }],
    });
    expect(result.error?.issues).toContainEqual(
      issueMatcher<z.core.$ZodIssue>({
        path: ["providers", 0, "opencode_console", "cookie_file"],
        code: "invalid_type",
      }),
    );
  });
});
