import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const themesDir = resolve(here, "..", "src", "themes");

function readTheme(name: string) {
  return readFileSync(resolve(themesDir, name), "utf8");
}

describe("@penumbra/console themes", () => {
  test("ported token files include the sirius brand token and app.css consumes it", () => {
    expect(readTheme("tokens.css")).toMatch(/--color-brand:\s+#6366f1/);
    expect(readTheme("colors_and_type.css")).toMatch(/--color-brand:\s+#6366f1/);
    expect(readTheme("app.css")).toContain("var(--color-brand)");
  });

  test("tokens.css keeps the non-sirius theme marker comments", () => {
    const body = readTheme("tokens.css");
    expect(body).toContain("TODO restore when a user asks for this theme");
  });

  test("colors_and_type.css keeps the non-sirius theme marker comments", () => {
    const body = readTheme("colors_and_type.css");
    expect(body).toContain("TODO restore when a user asks for this theme");
  });
});
