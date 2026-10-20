import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".claude/workflows";
const FORBIDDEN: Array<[string, RegExp]> = [
  ["Date.now()", /\bDate\.now\s*\(/],
  ["argless new Date()", /\bnew\s+Date\b(?!\s*\(\s*[^\s)])/],
  ["bare Date()", /(?<![.\w$]|new\s)Date\s*\(/],
  ["Math.random()", /\bMath\.random\s*\(/],
];

describe("CC workflow scripts are deterministic", () => {
  for (const name of readdirSync(DIR)
    .filter((n) => n.endsWith(".js"))
    .sort()) {
    test(`${name} has no clock or RNG reads`, () => {
      const source = readFileSync(join(DIR, name), "utf8");
      const hits = FORBIDDEN.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
      expect(hits, `${name} uses forbidden nondeterminism`).toEqual([]);
    });
  }
});
