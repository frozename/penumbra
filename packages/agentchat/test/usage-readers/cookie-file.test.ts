import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandHome, readCookieFile } from "../../src/usage-readers/cookie-file.js";

function tempCookie(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cookie-file-test-"));
  const p = join(dir, "oc.cookie");
  writeFileSync(p, contents);
  return p;
}

describe("readCookieFile", () => {
  test("reads and trims cookie from file", async () => {
    expect(await readCookieFile(tempCookie("  session=abc123\n"))).toBe("session=abc123");
  });

  test("returns null for a missing file", async () => {
    expect(await readCookieFile(join(tmpdir(), "definitely-missing-oc-cookie-xyz"))).toBeNull();
  });

  test("returns null for a blank file", async () => {
    expect(await readCookieFile(tempCookie("   \n"))).toBeNull();
  });

  test("expands ~ in a path without throwing", async () => {
    expect(await readCookieFile("~/nonexistent-penumbra-cookie-xyz")).toBeNull();
  });
});

describe("expandHome", () => {
  test("expands a leading ~/", () => {
    const out = expandHome("~/foo");
    expect(out.startsWith("~")).toBe(false);
    expect(out.endsWith("/foo")).toBe(true);
  });

  test("leaves absolute paths unchanged", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path");
  });
});
