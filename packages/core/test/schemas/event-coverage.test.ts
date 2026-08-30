import { EventTypeSchema } from "@src/schemas/event.js";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const EVENT_TYPE_LITERAL_RE = /\bevent_type\s*:\s*['"]([^'"]+)['"]/g;

function listSourceTsFiles(repoRoot: string): string[] {
  const packagesDir = join(repoRoot, "packages");
  const files: string[] = [];

  const walk = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const absPath = join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(relative(repoRoot, absPath));
      }
    }
  };

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcDir = join(packagesDir, entry.name, "src");
    try {
      walk(srcDir);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === "ENOENT") continue;
      throw err;
    }
  }

  return files.sort();
}

function findEventTypeDrift(): string[] {
  const repoRoot = resolve(import.meta.dir, "../../../../");
  const failures: string[] = [];

  for (const relPath of listSourceTsFiles(repoRoot)) {
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
