import { describe, expect, it } from "bun:test";

import {
  assertNoRoleTagCollision,
  assertUniqueSeatNames,
  seatNameFor,
} from "@src/generator/naming.js";

describe("seatNameFor", () => {
  it("is a pure function of (source, model slug, effort) — same input twice yields byte-identical names", () => {
    const first = seatNameFor("codex", "gpt-5.5", "high");
    const second = seatNameFor("codex", "gpt-5.5", "high");
    expect(first).toBe(second);
    expect(first).toBe("codex-gpt-5-5-high");
  });

  it("normalizes dots and slashes into hyphens so the name is valid seat-name-safe characters", () => {
    expect(seatNameFor("opencode", "anthropic/claude-sonnet-5.0")).toBe(
      "opencode-anthropic-claude-sonnet-5-0",
    );
  });

  it("omits the effort segment entirely when effort is not given", () => {
    expect(seatNameFor("sakana", "fugu-base")).toBe("sakana-fugu-base");
  });

  it("lowercases mixed-case source/model input for canonical seat names", () => {
    expect(seatNameFor("Codex", "GPT-5.5", "High")).toBe("codex-gpt-5-5-high");
  });

  it("throws instead of returning an empty name when every character is outside [a-z0-9]", () => {
    expect(() => seatNameFor("!!!", "###")).toThrow(/empty seat name/);
  });
});

describe("assertNoRoleTagCollision", () => {
  it("rejects a generated seat name identical to a live role tag", () => {
    expect(() => {
      assertNoRoleTagCollision(["codex-gpt-5-5-high", "reviewer"], ["executor", "reviewer"]);
    }).toThrow(/reviewer/);
  });

  it("does not throw when no generated name collides with a role tag", () => {
    expect(() => {
      assertNoRoleTagCollision(
        ["codex-gpt-5-5-high", "sakana-fugu-base"],
        ["executor", "reviewer"],
      );
    }).not.toThrow();
  });

  it("aggregates every colliding name into a single thrown error", () => {
    expect(() => {
      assertNoRoleTagCollision(
        ["executor", "reviewer", "codex-gpt-5-5-high"],
        ["executor", "reviewer"],
      );
    }).toThrow(/executor.*reviewer|reviewer.*executor/s);
  });
});

describe("assertUniqueSeatNames", () => {
  it("throws when two different raw inputs normalize to the same seat name (gpt-5.5 vs gpt-5-5)", () => {
    expect(() => {
      assertUniqueSeatNames([
        { source: "codex", modelSlug: "gpt-5.5" },
        { source: "codex", modelSlug: "gpt-5-5" },
      ]);
    }).toThrow(/codex-gpt-5-5/);
  });

  it("does not throw when every generated seat name is unique", () => {
    expect(() => {
      assertUniqueSeatNames([
        { source: "codex", modelSlug: "gpt-5.5" },
        { source: "sakana", modelSlug: "fugu-base" },
        { source: "codex", modelSlug: "gpt-5.5", effort: "high" },
      ]);
    }).not.toThrow();
  });

  it("aggregates multiple distinct collision groups into a single thrown error", () => {
    expect(() => {
      assertUniqueSeatNames([
        { source: "codex", modelSlug: "gpt-5.5" },
        { source: "codex", modelSlug: "gpt-5-5" },
        { source: "vendor", modelSlug: "anthropic/claude" },
        { source: "vendor", modelSlug: "anthropic-claude" },
      ]);
    }).toThrow(/codex-gpt-5-5.*vendor-anthropic-claude|vendor-anthropic-claude.*codex-gpt-5-5/s);
  });
});

it("assertUniqueSeatNames treats identical duplicate inputs as one logical seat, not a collision", () => {
  expect(() => {
    assertUniqueSeatNames([
      { source: "codex", modelSlug: "gpt-5.5" },
      { source: "codex", modelSlug: "gpt-5.5" },
    ]);
  }).not.toThrow();
});
