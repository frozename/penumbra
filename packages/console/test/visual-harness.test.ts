import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadStoryIndex } from "../visual/story-index.js";

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, "..", "storybook-static");

// These tests need the storybook-static build artifact. They run in two modes:
//  - default: skipped when storybook-static/ is absent (keeps the suite fast for routine bun test)
//  - opt-in: PENUMBRA_VISUAL_HARNESS=1 forces the tests to run; they fail loudly if the build
//    is missing, surfacing the prerequisite. Set this in any CI lane that exercises the harness.
const STATIC_PRESENT = existsSync(resolve(staticDir, "index.json"));
const FORCE = process.env.PENUMBRA_VISUAL_HARNESS === "1";
const harnessTest = STATIC_PRESENT || FORCE ? test : test.skip;

describe("visual harness story index", () => {
  harnessTest("storybook static index exists after build-storybook", () => {
    expect(existsSync(resolve(staticDir, "index.json"))).toBe(true);
  });

  harnessTest("loads story entries with id, title, and name", () => {
    const stories = loadStoryIndex(staticDir);
    expect(stories.length).toBeGreaterThan(0);
    for (const story of stories) {
      expect(story.id.length).toBeGreaterThan(0);
      expect(story.title.length).toBeGreaterThan(0);
      expect(story.name.length).toBeGreaterThan(0);
    }
  });
});
