import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Tripwire for a cross-file coupling: the probe's EFFECTIVE_HOLD_CAP_MS is only
// safe while FAKE_CHILD_RETRY_DEADLINE_MS sits at or below the per-write retry
// deadline the fixture's runWithRetry actually uses. Both sides are plain
// numeric literals, so this test re-extracts each from source and fails loudly
// — naming the file and the extracted value — when they drift or when the
// anchor it searches for can no longer be found.
const PROBE_REL = "packages/agentchat/scripts/devin-contention-probe.ts";
const FIXTURE_REL = "packages/agentchat/scripts/fixtures/devin-contention-fake.ts";

function numericLiteralsIn(expression: string): number[] {
  const matches = expression.match(/(?<![\w$])\d[\d_]*(?![\w$])/g) ?? [];
  return matches.map((literal) => Number.parseInt(literal.replaceAll("_", ""), 10));
}

// Returns the sole numeric literal on the right-hand side of `name = …;` inside
// `body`. Anything else — no assignment, several assignments, or a right-hand
// side that hides the value behind indirection — is an explicit extraction
// failure, never a silent pass.
function soleAssignedNumber(body: string, name: string, where: string): number {
  const pattern = new RegExp(`\\b${name}\\s*=(?![=>])\\s*([^;]*);`, "g");
  const assignments = [...body.matchAll(pattern)];
  if (assignments.length !== 1) {
    throw new Error(
      `${where}: expected exactly one \`${name} = …;\` assignment, found ${String(
        assignments.length,
      )}; the retry-deadline tripwire lost its anchor — update the extractor`,
    );
  }
  const rhs = assignments[0]?.[1] ?? "";
  const literals = numericLiteralsIn(rhs);
  if (literals.length !== 1) {
    throw new Error(
      `${where}: \`${name}\` assignment right-hand side \`${rhs.trim()}\` must contain ` +
        `exactly one numeric literal, found ${String(
          literals.length,
        )}; the retry-deadline tripwire cannot see through indirection — update the extractor`,
    );
  }
  return literals[0]!;
}

// Slices a top-level function body out of `source` by brace matching, so the
// caller can scope a search to one function (the fixture declares a second,
// unrelated `deadline` in ensureSchema).
function functionBody(source: string, name: string, where: string): string {
  const declaration = new RegExp(`\\b(?:async\\s+)?function\\s+${name}\\b`).exec(source);
  if (declaration === null) {
    throw new Error(
      `${where}: \`function ${name}\` not found; the retry-deadline tripwire lost its ` +
        "anchor — update the extractor",
    );
  }
  const openBrace = source.indexOf("{", declaration.index + declaration[0].length);
  if (openBrace < 0) {
    throw new Error(`${where}: no body found for \`function ${name}\``);
  }
  const body = source.slice(openBrace);
  let depth = 0;
  for (const brace of body.matchAll(/[{}]/g)) {
    depth += brace[0] === "{" ? 1 : -1;
    if (depth === 0) {
      return body.slice(0, brace.index + 1);
    }
  }
  throw new Error(`${where}: unbalanced braces inside \`function ${name}\``);
}

function probeRetryDeadlineMs(): number {
  return soleAssignedNumber(
    readFileSync(join(import.meta.dirname, "devin-contention-probe.ts"), "utf8"),
    "FAKE_CHILD_RETRY_DEADLINE_MS",
    PROBE_REL,
  );
}

function fixtureRetryDeadlineMs(): number {
  const source = readFileSync(
    join(import.meta.dirname, "fixtures", "devin-contention-fake.ts"),
    "utf8",
  );
  return soleAssignedNumber(
    functionBody(source, "runWithRetry", FIXTURE_REL),
    "deadline",
    FIXTURE_REL,
  );
}

describe("probe/fixture retry-deadline coupling", () => {
  test("FAKE_CHILD_RETRY_DEADLINE_MS matches the fixture's per-write retry deadline", () => {
    const probeDeadline = probeRetryDeadlineMs();
    const fixtureDeadline = fixtureRetryDeadlineMs();

    expect(
      fixtureDeadline,
      `retry-deadline drift: ${PROBE_REL} sets FAKE_CHILD_RETRY_DEADLINE_MS = ${String(
        probeDeadline,
      )} but ${FIXTURE_REL} runWithRetry retries writes for ${String(
        fixtureDeadline,
      )}ms. EFFECTIVE_HOLD_CAP_MS in the probe derives from the smaller of the request ` +
        "timeout and this fixture deadline; update both sides together.",
    ).toBe(probeDeadline);
  });
});

describe("retry-deadline extractor", () => {
  test("tolerates underscore-free literals, reordered addition, and line wraps", () => {
    expect(soleAssignedNumber("const deadline = nowMs() + 6000;", "deadline", "inline")).toBe(6000);
    expect(soleAssignedNumber("const deadline = 6_000 + nowMs();", "deadline", "inline")).toBe(
      6000,
    );
    expect(soleAssignedNumber("const deadline =\n  clock() + 6_000;", "deadline", "inline")).toBe(
      6000,
    );
  });

  test("fails by name when the anchor is missing or ambiguous", () => {
    expect(() => soleAssignedNumber("const other = 1;", "deadline", "fake.ts")).toThrow(
      /fake\.ts.*deadline/,
    );
    expect(() => soleAssignedNumber("const deadline = budget();", "deadline", "fake.ts")).toThrow(
      /exactly one numeric literal/,
    );
  });
});
