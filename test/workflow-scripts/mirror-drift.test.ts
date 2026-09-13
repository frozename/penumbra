import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";

// .claude/workflows/*.js are mirrored into ~/.claude/workflows/ for global
// execution; several are plain copies, not symlinks, so a repo edit does not
// reach the executing copy until re-mirrored. This test pins byte-equality for
// every mirrored file that is not a symlink and reports repo files that have no
// mirror copy. CI has no such directory, so the drift describe is skipped.
const REPO_DIR = resolve(".claude/workflows");
const MIRROR_DIR = join(homedir(), ".claude", "workflows");

// The filter below is the guard's breadth. It is deliberately kept separate
// from the census assertions underneath, which re-derive the full listing with
// a different predicate and name known non-`penumbra-` scripts explicitly, so
// narrowing this filter cannot shrink the guarded set silently.
const guardedJs = readdirSync(REPO_DIR)
  .filter((file) => file.endsWith(".js"))
  .sort();
const guardedSet = new Set(guardedJs);

// Scripts that do not match a `penumbra-` prefix; each must remain guarded.
const KNOWN_NON_PREFIX_SCRIPTS = [
  "adversarial-plan-integration.js",
  "adversarial-plan-topic.js",
  "adversarial-review.js",
  "integration-audit.js",
  "land-and-close.js",
  "session-first-moves.js",
  "session-memory-sweep.js",
  "penumbra.js",
];

describe("workflow mirror guard breadth", () => {
  test("the guard iterates every .js workflow in .claude/workflows", () => {
    const allRepoJs = readdirSync(REPO_DIR)
      .filter((file) => extname(file) === ".js")
      .sort();
    const unguarded = allRepoJs.filter((name) => !guardedSet.has(name));
    expect(unguarded, "repo .js workflows not covered by the mirror guard").toEqual([]);
  });

  test("known non-`penumbra-` scripts are each covered by the guard", () => {
    for (const name of KNOWN_NON_PREFIX_SCRIPTS) {
      expect(guardedSet.has(name), `${name} must be covered by the mirror drift guard`).toBe(true);
    }
  });
});

if (!existsSync(MIRROR_DIR)) {
  describe.skip("global workflow mirror drift (no mirror directory)", () => {});
} else {
  describe("global workflow mirror drift", () => {
    for (const name of guardedJs) {
      const mirrorPath = join(MIRROR_DIR, name);

      if (existsSync(mirrorPath) && lstatSync(mirrorPath).isSymbolicLink()) {
        // Symlinks cannot drift; do not byte-compare.
        continue;
      }

      if (existsSync(mirrorPath)) {
        test(`${name} matches the ~/.claude/workflows mirror`, () => {
          expect(readFileSync(mirrorPath, "utf8")).toBe(readFileSync(join(REPO_DIR, name), "utf8"));
        });
      } else {
        test(`${name} is mirrored in ~/.claude/workflows`, () => {
          expect(existsSync(mirrorPath), `${name} is missing from the mirror`).toBe(true);
        });
      }
    }
  });
}
