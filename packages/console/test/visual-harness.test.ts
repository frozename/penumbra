import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStoryIndex } from "../visual/story-index";

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, "..", "storybook-static");

describe("visual harness story index", () => {
  test("storybook static index exists after build-storybook", () => {
    expect(existsSync(resolve(staticDir, "index.json"))).toBe(true);
  });

  test("loads story entries with id, title, and name", () => {
    const stories = loadStoryIndex(staticDir);
    expect(stories.length).toBeGreaterThan(0);
    for (const story of stories) {
      expect(story.id.length).toBeGreaterThan(0);
      expect(story.title.length).toBeGreaterThan(0);
      expect(story.name.length).toBeGreaterThan(0);
    }
  });
});
