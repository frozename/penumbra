import { describe, expect, test } from "bun:test";

import { isReviewClean, isReviewComplete } from "../src/review-completeness.js";

describe("review-completeness", () => {
  test("isReviewComplete", () => {
    expect(isReviewComplete({ outcome: "success", failed_personas: [] })).toBe(true);
    expect(isReviewComplete({ outcome: "success_partial", failed_personas: ["security"] })).toBe(
      false,
    );
    expect(isReviewComplete({ outcome: "failed", failed_personas: [] })).toBe(false);
    expect(isReviewComplete({ outcome: "failed" })).toBe(false);
    expect(isReviewComplete(null)).toBe(false);
    expect(isReviewComplete(undefined)).toBe(false);
  });

  test("isReviewClean", () => {
    // clean
    expect(
      isReviewClean({
        green: true,
        highCount: 0,
        fixRejected: false,
        review: { completed_personas: ["a"], outcome: "success", failed_personas: [] },
      }),
    ).toBe(true);

    // NOT clean: outcome 'success_partial' with failed_personas non-empty
    expect(
      isReviewClean({
        green: true,
        highCount: 0,
        fixRejected: false,
        review: { completed_personas: ["a"], outcome: "success_partial", failed_personas: ["b"] },
      }),
    ).toBe(false);

    // NOT clean: outcome 'failed'
    expect(
      isReviewClean({
        green: true,
        highCount: 0,
        fixRejected: false,
        review: { completed_personas: ["a"], outcome: "failed", failed_personas: [] },
      }),
    ).toBe(false);

    // NOT clean: zero completed_personas
    expect(
      isReviewClean({
        green: true,
        highCount: 0,
        fixRejected: false,
        review: { completed_personas: [], outcome: "success", failed_personas: [] },
      }),
    ).toBe(false);

    // NOT clean: highCount > 0
    expect(
      isReviewClean({
        green: true,
        highCount: 1,
        fixRejected: false,
        review: { completed_personas: ["a"], outcome: "success", failed_personas: [] },
      }),
    ).toBe(false);

    // NOT clean: not green
    expect(
      isReviewClean({
        green: false,
        highCount: 0,
        fixRejected: false,
        review: { completed_personas: ["a"], outcome: "success", failed_personas: [] },
      }),
    ).toBe(false);

    // NOT clean: fixRejected
    expect(
      isReviewClean({
        green: true,
        highCount: 0,
        fixRejected: true,
        review: { completed_personas: ["a"], outcome: "success", failed_personas: [] },
      }),
    ).toBe(false);
  });
});
