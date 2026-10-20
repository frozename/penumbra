import { describe, expect, test } from "bun:test";

import { TaskProfileSchema } from "@src/routing/schemas.js";
import { profileTaskDeterministic } from "@src/routing/task-profile.js";

const fixtures: { name: string; message: string; role?: string }[] = [
  {
    name: "repo-wide implementation",
    message:
      "Implement a repo-wide routing migration across every package, update the schemas, and add integration tests.",
    role: "executor",
  },
  {
    name: "one-line formatting fix",
    message: "Make a one-line formatting fix in the README.",
  },
  {
    name: "ambiguous request",
    message: "update the thing",
  },
  {
    name: "review request",
    message: "Review-only task: audit the authentication change for regressions.",
    role: "reviewer",
  },
] as const;

describe("profileTaskDeterministic", () => {
  test("a repo-wide implementation message scores high codingDemand and complexity", () => {
    const profile = profileTaskDeterministic(fixtures[0].message, fixtures[0].role);

    expect(profile.taskTypes).toContain("coding");
    expect(profile.codingDemand).toBeGreaterThanOrEqual(0.8);
    expect(profile.complexity).toBeGreaterThanOrEqual(0.8);
  });

  test("a one-line formatting fix scores low complexity, high cost/latency sensitivity", () => {
    const profile = profileTaskDeterministic(fixtures[1].message, fixtures[1].role);

    expect(profile.complexity).toBeLessThanOrEqual(0.3);
    expect(profile.latencySensitivity).toBeGreaterThanOrEqual(0.75);
    expect(profile.costSensitivity).toBeGreaterThanOrEqual(0.75);
  });

  test("repo-wide scope dominates a conflicting one-line signal", () => {
    const profile = profileTaskDeterministic(
      "Implement a one-line repo-wide API migration across every package.",
      "executor",
    );

    expect(profile.complexity).toBeGreaterThanOrEqual(0.8);
    expect(profile.contextDemand).toBeGreaterThanOrEqual(0.8);
    expect(profile.rationale.join(" ")).not.toContain("favors low latency and cost");
  });

  test("mentioning a repository does not turn a non-coding summary into coding", () => {
    const profile = profileTaskDeterministic(
      "Research the repository history and summarize the evidence.",
    );

    expect(profile.taskTypes).not.toContain("coding");
    expect(profile.codingDemand).toBeLessThanOrEqual(0.3);
  });

  test("mentioning a package does not turn non-coding research into coding", () => {
    const profile = profileTaskDeterministic(
      "Research the npm package license and summarize the evidence.",
    );

    expect(profile.taskTypes).not.toContain("coding");
    expect(profile.codingDemand).toBeLessThanOrEqual(0.3);
  });

  test("confidence is lower for a message with no recognizable signal than for one with several, and never reaches 1.0", () => {
    const ambiguous = profileTaskDeterministic(fixtures[2].message);
    const recognized = profileTaskDeterministic(fixtures[0].message, fixtures[0].role);

    expect(ambiguous.confidence).toBeLessThan(recognized.confidence);
    expect(ambiguous.confidence).toBeLessThan(0.6);
    expect(recognized.confidence).toBeLessThan(1);
  });

  test("output validates against TaskProfileSchema for every fixture", () => {
    for (const fixture of fixtures) {
      const profile = profileTaskDeterministic(fixture.message, fixture.role);
      expect(TaskProfileSchema.safeParse(profile).success).toBe(true);
    }
  });

  test("confidence formula is pinned: a role fallback alone scores 0.53 and no signal scores 0.25", () => {
    expect(profileTaskDeterministic("hello there", "executor").confidence).toBe(0.53);
    expect(profileTaskDeterministic("hello there").confidence).toBe(0.25);
  });

  test("identical input twice produces byte-identical output", () => {
    const hints = {
      expectedInputTokens: 900,
      requiredCapabilities: ["typescript"],
    };

    const first = profileTaskDeterministic(fixtures[0].message, "executor", hints);
    const second = profileTaskDeterministic(fixtures[0].message, "executor", hints);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

const NEUTRAL_FILLER =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ";

function padToLength(tail: string, length: number): string {
  const filler = NEUTRAL_FILLER.repeat(Math.ceil(length / NEUTRAL_FILLER.length));
  return `${filler.slice(0, Math.max(0, length - tail.length - 1))} ${tail}`;
}

describe("small-signal axis gating", () => {
  test("an implement_substantial hint is not overridden by an incidental formatting mention", () => {
    const profile = profileTaskDeterministic(
      padToLength("keep formatting unchanged", 5000),
      undefined,
      { taskType: "implement_substantial" },
    );

    expect(profile.complexity).toBe(0.72);
    expect(profile.latencySensitivity).toBe(0.25);
    expect(profile.costSensitivity).toBe(0.3);
  });

  test("a review_adversarial hint is not overridden by an incidental one-line mention", () => {
    const profile = profileTaskDeterministic(
      padToLength("assess the one-line fix", 5000),
      undefined,
      { taskType: "review_adversarial" },
    );

    expect(profile.complexity).toBe(0.58);
    expect(profile.latencySensitivity).toBe(0.5);
    expect(profile.costSensitivity).toBe(0.55);
  });

  test("an implement_small hint still takes the small-task axes", () => {
    const profile = profileTaskDeterministic(
      padToLength("apply the one-line schema change", 2000),
      undefined,
      { taskType: "implement_small" },
    );

    expect(profile.complexity).toBe(0.18);
    expect(profile.latencySensitivity).toBe(0.9);
    expect(profile.costSensitivity).toBe(0.9);
  });

  test("an unknown-type message over the small-signal length cap ignores the small axes", () => {
    const profile = profileTaskDeterministic(padToLength("this is a trivial chore", 2000));

    expect(profile.taskTypes).toEqual(["other"]);
    expect(profile.complexity).toBe(0.3);
    expect(profile.latencySensitivity).toBe(0.5);
    expect(profile.costSensitivity).toBe(0.55);
  });

  test("an unknown-type message under the cap still takes the small-task axes", () => {
    const profile = profileTaskDeterministic(padToLength("this is a trivial chore", 200));

    expect(profile.complexity).toBe(0.18);
    expect(profile.latencySensitivity).toBe(0.9);
    expect(profile.costSensitivity).toBe(0.9);
  });

  test("the small signal still counts toward confidence when its axes are gated", () => {
    const gated = profileTaskDeterministic(
      padToLength("this is a trivial chore", 5000),
      undefined,
      { taskType: "implement_substantial" },
    );
    const control = profileTaskDeterministic(
      padToLength("this is a mundane chore", 5000),
      undefined,
      { taskType: "implement_substantial" },
    );

    expect(gated.confidence).toBe(0.6);
    expect(control.confidence).toBe(0.53);
  });
});
