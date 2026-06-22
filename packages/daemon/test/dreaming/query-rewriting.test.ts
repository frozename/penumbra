import { describe, expect, it } from "bun:test";

import { INTERNAL_TERMS_SEED, isWebSearchable } from "../../src/dreaming/query-rewriting.js";

describe("dreaming/query-rewriting", () => {
  const resetInternalTerms = (): string | undefined => {
    const previous = process.env.PENUMBRA_DREAMING_INTERNAL_TERMS;
    delete process.env.PENUMBRA_DREAMING_INTERNAL_TERMS;
    return previous;
  };

  const restoreInternalTerms = (value: string | undefined): void => {
    if (value === undefined) {
      delete process.env.PENUMBRA_DREAMING_INTERNAL_TERMS;
    } else {
      process.env.PENUMBRA_DREAMING_INTERNAL_TERMS = value;
    }
  };

  it("accepts web-shaped query about TypeScript strict null checks", () => {
    const result = isWebSearchable("TypeScript strict null checks");
    expect(result).toEqual({ ok: true });
  });

  it("accepts web-shaped query about SQLite WAL mode performance", () => {
    const result = isWebSearchable("SQLite WAL mode performance");
    expect(result).toEqual({ ok: true });
  });

  it("accepts web-shaped query about git worktree absolute path resolution", () => {
    const result = isWebSearchable("git worktree absolute path resolution");
    expect(result).toEqual({ ok: true });
  });

  it("accepts web-shaped query about Bun spawn process environment inheritance", () => {
    const result = isWebSearchable("Bun spawn process environment inheritance");
    expect(result).toEqual({ ok: true });
  });

  it("rejects commit-prefixed titles", () => {
    expect(isWebSearchable("feat(dreaming): something something")).toEqual({
      ok: false,
      reason: "commit_prefix",
    });
    expect(isWebSearchable("fix(worker): something else")).toEqual({
      ok: false,
      reason: "commit_prefix",
    });
    expect(isWebSearchable("fix: missing colon-space prefix")).toEqual({
      ok: false,
      reason: "commit_prefix",
    });
  });

  it("rejects code identifiers", () => {
    expect(
      isWebSearchable("Cross-repo dispatch_land fix: resolve repoDir from handoff.project_id"),
    ).toEqual({
      ok: false,
      reason: "code_identifier",
    });
    expect(isWebSearchable("Use handoffWriter::create to mint rows")).toEqual({
      ok: false,
      reason: "code_identifier",
    });
    expect(isWebSearchable("Refactor extraWorkerSupervisor methods")).toEqual({
      ok: false,
      reason: "code_identifier",
    });
  });

  it("rejects internal jargon terms from the seed", () => {
    expect(isWebSearchable("Test-driven development workflow for engine registry")).toEqual({
      ok: true,
    });
    expect(isWebSearchable("P4 backoff for cycle_id throttling")).toEqual({
      ok: false,
      reason: "internal_jargon",
    });
    expect(isWebSearchable("Handoff routing logic for maestro")).toEqual({
      ok: false,
      reason: "internal_jargon",
    });
  });

  it("rejects too_short titles", () => {
    expect(isWebSearchable("Split behavior change")).toEqual({ ok: false, reason: "too_short" });
    expect(isWebSearchable("Fix this")).toEqual({ ok: false, reason: "too_short" });
    expect(isWebSearchable("")).toEqual({ ok: false, reason: "too_short" });
  });

  it("rejects too_long titles", () => {
    expect(
      isWebSearchable(
        "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen",
      ),
    ).toEqual({ ok: false, reason: "too_long" });
  });

  it("supports PENUMBRA_DREAMING_INTERNAL_TERMS env override", () => {
    const priorTerms = resetInternalTerms();
    process.env.PENUMBRA_DREAMING_INTERNAL_TERMS = "foo,bar";
    try {
      expect(isWebSearchable("Hello foo world testing things")).toEqual({
        ok: false,
        reason: "internal_jargon",
      });
      expect(isWebSearchable("Hello world world testing things")).toEqual({ ok: true });
    } finally {
      restoreInternalTerms(priorTerms);
    }
  });

  it("applies rejection reasons in deterministic order", () => {
    expect(isWebSearchable("feat(t2): handoff_id dispatch_land")).toEqual({
      ok: false,
      reason: "commit_prefix",
    });
  });

  it("exports a non-empty internal term seed", () => {
    expect(INTERNAL_TERMS_SEED.length).toBeGreaterThan(0);
    for (const term of INTERNAL_TERMS_SEED) {
      expect(typeof term).toBe("string");
      expect(term.trim().length).toBeGreaterThan(0);
    }
  });
});
