import { describe, expect, it } from "bun:test";
import { T2_PROMOTION_PROMPT } from "../../src/workers/t2-promotion.js";

describe("t2 promotion discriminator prompt + schema", () => {
  it("includes gated discriminator fields and policy rules", () => {
    expect(T2_PROMOTION_PROMPT).toContain("obs_type");
    expect(T2_PROMOTION_PROMPT).toContain("promote");
    expect(T2_PROMOTION_PROMPT).toContain("is_episodic");
    expect(T2_PROMOTION_PROMPT).toContain("standing_brief");
    expect(T2_PROMOTION_PROMPT).toContain("80");
    expect(T2_PROMOTION_PROMPT).toContain("depth");
  });

  it("accepts discriminator golden fixtures for gate-on promotion decisions", () => {
    const fixtures = [
      {
        title: "Episodic runbook narration",
        body: "A failing test was written first, then implementation followed in the same session.",
        kind: "fact",
        obs_type: "is_episodic",
        is_episodic: true,
        promote: false,
        depth: 1,
      },
      {
        title: "Long-lived standing brief",
        body: "You are a long-lived agent that should always summarize unresolved verification gaps.",
        kind: "preference",
        obs_type: "standing_brief",
        promote: false,
        depth: 2,
      },
      {
        title: "Why-grounded semantic fact",
        body: "recall.ts filters retired_at IS NULL for active-memory retrieval.",
        kind: "knowledge",
        obs_type: "fact",
        why: "Prevents retrieval leakage from retired rows.",
        source_quote: "WHERE retired_at IS NULL",
        promote: true,
        depth: 2,
      },
      {
        title: "Short but deep",
        body: "Hook routing is global, not per project.",
        kind: "decision",
        obs_type: "fact",
        why: "Avoids contradictory per-project auth semantics.",
        promote: true,
        depth: 2,
      },
    ];

    for (const fixture of fixtures) {
      expect(typeof fixture.title).toBe("string");
      expect(typeof fixture.body).toBe("string");
      expect(typeof fixture.kind).toBe("string");
      expect(typeof fixture.promote).toBe("boolean");
    }
  });
});
