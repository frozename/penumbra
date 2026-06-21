import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const consoleDir = join(here, "..");
// The 'built dist/index.html' test runs vite build, which is slow.
// Set PENUMBRA_CSP_BUILD=1 to enable it (e.g., in a release-validation script).
const RUN_BUILD_TEST = process.env.PENUMBRA_CSP_BUILD === "1";
const built = RUN_BUILD_TEST ? test : test.skip;

const CSP_REQUIRED_DIRECTIVES = [
  /default-src\s+'self'/,
  /connect-src\s[^"]*'self'/,
  /connect-src\s[^"]*http:\/\/127\.0\.0\.1:\*/,
  /connect-src\s[^"]*http:\/\/localhost:\*/,
  /img-src\s[^"]*'self'[^"]*data:/,
  /object-src\s+'none'/,
  /base-uri\s+'none'/,
  /frame-ancestors\s+'none'/,
];

function readCsp(html: string): string {
  const match =
    /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(["'])([\s\S]*?)\1/i.exec(html);
  expect(match).not.toBeNull();
  return match![2]!;
}

function expectStrictCsp(html: string): void {
  const csp = readCsp(html);
  for (const re of CSP_REQUIRED_DIRECTIVES) {
    expect(csp).toMatch(re);
  }
}

describe("CSP enforcement", () => {
  test("source index.html contains strict CSP meta tag", () => {
    const html = readFileSync(join(consoleDir, "index.html"), "utf8");
    expectStrictCsp(html);
  });

  built("built dist/index.html preserves the CSP meta tag", () => {
    const distIndex = join(consoleDir, "dist", "index.html");
    if (!existsSync(distIndex)) {
      const result = spawnSync("bun", ["run", "build"], {
        cwd: consoleDir,
        stdio: "pipe",
        encoding: "utf8",
      });
      if (result.status !== 0) {
        throw new Error(`vite build failed: ${result.stderr}`);
      }
    }

    const html = readFileSync(distIndex, "utf8");
    expectStrictCsp(html);
  });
});
