import { describe, expect, test } from "bun:test";

import { TaskProfileSchema } from "@src/routing/schemas.js";
import { profileTaskDeterministic } from "@src/routing/task-profile.js";

const fixtures: { name: string; message: string; role: string }[] = [
  {
    name: "repo-wide implementation",
    message:
      "Implement a repo-wide routing migration across every package, update the schemas, and add integration tests.",
    role: "executor",
  },
  {
    name: "one-line formatting fix",
    message: "Make a one-line formatting fix in the README.",
    role: "executor",
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
