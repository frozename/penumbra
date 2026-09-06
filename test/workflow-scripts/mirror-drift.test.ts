import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// penumbra-*.js workflow scripts are mirrored into ~/.claude/workflows/ for
// global execution; several are plain copies, not symlinks, so a repo edit does
// not reach the executing copy until re-mirrored. This test pins byte-equality
// per mirrored file that exists and is not a symlink.
//
// Blind spot: this guards the developer machine only; CI has no such directory
// and can never see mirror drift.
const REPO_DIR = resolve(".claude/workflows");
const MIRROR_DIR = join(homedir(), ".claude", "workflows");

describe("global workflow mirror drift", () => {
  const names = readdirSync(REPO_DIR).filter(
    (file) => file.startsWith("penumbra-") && file.endsWith(".js"),
  );

  for (const name of names) {
    const mirrorPath = join(MIRROR_DIR, name);
    test.skipIf(!existsSync(mirrorPath) || lstatSync(mirrorPath).isSymbolicLink())(
      `${name} matches the ~/.claude/workflows mirror`,
      () => {
        expect(readFileSync(mirrorPath, "utf8")).toBe(readFileSync(join(REPO_DIR, name), "utf8"));
      },
    );
  }
});
