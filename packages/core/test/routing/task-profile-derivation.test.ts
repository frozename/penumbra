import { describe, expect, test } from "bun:test";

import { profileTaskDeterministic } from "@src/routing/task-profile.js";

describe("ambiguity", () => {
  test("vague wording pins ambiguity to 0.82 even with a specific hint and a long message", () => {
    const profile = profileTaskDeterministic(
      "Refactor the thing in the parser module to use a helper function.",
      undefined,
      { taskType: "implement_small" },
    );

    expect(profile.ambiguity).toBe(0.82);
  });

  test("a specific hint with a short message pins ambiguity to 0.55", () => {
    const message = "Fix the README typo";
    expect(message.length).toBe(19);

    const profile = profileTaskDeterministic(message, undefined, {
      taskType: "implement_small",
    });

    expect(profile.ambiguity).toBe(0.55);
  });

  test("a specific hint with a long non-vague message pins ambiguity to 0.25", () => {
    const message = "Update the helper function in the parser module to handle null values.";
    expect(message.length).toBe(70);

    const profile = profileTaskDeterministic(message, undefined, {
      taskType: "implement_small",
    });

    expect(profile.ambiguity).toBe(0.25);
  });
});

describe("token estimates and hint pass-through", () => {
  test("token estimates fall back to ceil(length / 4) input and round(180 + complexity * 820) output", () => {
    const message = "abcdefghij";
    expect(message.length).toBe(10);

    const profile = profileTaskDeterministic(message);

    expect(profile.complexity).toBe(0.3);
    expect(profile.expectedInputTokens).toBe(3);
    expect(profile.expectedOutputTokens).toBe(426);
  });

  test("token and capability hints pass through verbatim", () => {
    const profile = profileTaskDeterministic("Summarize the report", undefined, {
      expectedInputTokens: 1234,
      expectedOutputTokens: 56,
      requiredCapabilities: ["typescript"],
      preferredCapabilities: ["fast"],
      disallowedCapabilities: ["gpu"],
    });

    expect(profile.expectedInputTokens).toBe(1234);
    expect(profile.expectedOutputTokens).toBe(56);
    expect(profile.requiredCapabilities).toEqual(["typescript"]);
    expect(profile.preferredCapabilities).toEqual(["fast"]);
    expect(profile.disallowedCapabilities).toEqual(["gpu"]);
  });

  test("negative and non-integer token hints fall back to the derived estimates", () => {
    const profile = profileTaskDeterministic("abcdefghij", undefined, {
      expectedInputTokens: -5,
      expectedOutputTokens: 2.5,
    });

    expect(profile.expectedInputTokens).toBe(3);
    expect(profile.expectedOutputTokens).toBe(426);
  });

  test("capability hints keep only string entries and default to empty lists", () => {
    const dirtyHints = {
      requiredCapabilities: ["typescript", 7, null],
      disallowedCapabilities: ["gpu", {}],
    } as unknown as Parameters<typeof profileTaskDeterministic>[2];

    const profile = profileTaskDeterministic("hello there", undefined, dirtyHints);

    expect(profile.requiredCapabilities).toEqual(["typescript"]);
    expect(profile.preferredCapabilities).toEqual([]);
    expect(profile.disallowedCapabilities).toEqual(["gpu"]);
  });
});

describe("risk and agentic axes", () => {
  test("risk-sensitive terms pin risk to 0.82 and reliabilityDemand to 0.9", () => {
    const profile = profileTaskDeterministic(
      "Update the production deployment schema.",
      undefined,
      { taskType: "implement_small" },
    );

    expect(profile.risk).toBe(0.82);
    expect(profile.reliabilityDemand).toBe(0.9);
  });

  test("agent/workflow signals pin agenticDemand to 0.85 and reliabilityDemand to 0.78", () => {
    const profile = profileTaskDeterministic(
      "Dispatch the agent workflow to finish the milestone.",
    );

    expect(profile.agenticDemand).toBe(0.85);
    expect(profile.reliabilityDemand).toBe(0.78);
  });

  test("small-task axes keep an elevated risk instead of dropping it to 0.1", () => {
    const profile = profileTaskDeterministic("fix the tiny auth typo");

    expect(profile.complexity).toBe(0.18);
    expect(profile.risk).toBe(0.82);
  });
});

describe("task type mapping and order", () => {
  test("legacy hint types merge with signal types in canonical enum order", () => {
    const profile = profileTaskDeterministic(
      "debug the failing code and run the tests",
      undefined,
      {
        taskType: "debug_diagnose",
      },
    );

    expect(profile.taskTypes).toEqual(["coding", "debugging", "analysis", "tool_use"]);
  });

  test("a smoke_test hint merges with a summarization signal in canonical order", () => {
    const profile = profileTaskDeterministic("Summarize the check output.", undefined, {
      taskType: "smoke_test",
    });

    expect(profile.taskTypes).toEqual(["summarization", "tool_use"]);
  });

  test("a docs_mechanical hint maps to writing with no other types", () => {
    const profile = profileTaskDeterministic("Update the README copy.", undefined, {
      taskType: "docs_mechanical",
    });

    expect(profile.taskTypes).toEqual(["writing"]);
  });
});

describe("rationale", () => {
  test("a zero-signal message yields exactly the conservative fallback sentence", () => {
    const profile = profileTaskDeterministic("hello there");

    expect(profile.rationale).toEqual([
      "No recognized task signal; using a conservative low-confidence profile.",
    ]);
  });

  test("a legacy hint plus a risk signal yields exactly the legacy and risk sentences", () => {
    const profile = profileTaskDeterministic(
      "Update the production deployment schema.",
      undefined,
      { taskType: "implement_small" },
    );

    expect(profile.rationale).toEqual([
      "Legacy task and role signals map to implement_small.",
      "Risk-sensitive terms raise reliability demand.",
    ]);
  });
});
