import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { EventTypeSchema } from "../../src/schemas/event.js";

const EVENT_TYPE_LITERAL_RE = /\bevent_type\s*:\s*['"]([^'"]+)['"]/g;

function findEventTypeDrift(): string[] {
  const repoRoot = resolve(import.meta.dir, "../../../../");
  const failures: string[] = [];

  const glob = new Bun.Glob("packages/*/src/**/*.ts");
  for (const relPath of glob.scanSync({ cwd: repoRoot })) {
    const absPath = join(repoRoot, relPath);
    const contents = readFileSync(absPath, "utf8");
    for (const match of contents.matchAll(EVENT_TYPE_LITERAL_RE)) {
      const eventType = match[1];
      if (!eventType) continue;
      if (!EventTypeSchema.safeParse(eventType).success) {
        failures.push(`${relPath}:${eventType}`);
      }
    }
  }

  return failures;
}

test("all event_type literals in packages/*/src parse through EventTypeSchema", () => {
  const drift = findEventTypeDrift();
  expect(drift).toEqual([]);
});
