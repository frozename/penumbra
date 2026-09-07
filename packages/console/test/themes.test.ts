import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const themesDir = resolve(here, "..", "src", "themes");

function readTheme(name: string): string {
  return readFileSync(resolve(themesDir, name), "utf8");
}

describe("@penumbra/console themes", () => {
  test("ported token files include the sirius brand token and app.css consumes it", () => {
    expect(readTheme("tokens.css")).toMatch(/--color-brand:\s+#6366f1/);
    expect(readTheme("colors_and_type.css")).toMatch(/--color-brand:\s+#6366f1/);
    expect(readTheme("app.css")).toContain("var(--color-brand)");
  });

  test("tokens.css and colors_and_type.css keep the sirius brand token", () => {
    expect(readTheme("tokens.css")).toContain("--color-brand");
    expect(readTheme("colors_and_type.css")).toContain("--color-brand");
  });

  test("app.css defines rules for .session-invalid-banner, .dialog-overlay and .toast-region", () => {
    const css = readTheme("app.css");
    expect(css).toMatch(/\.session-invalid-banner\s*\{/);
    expect(css).toMatch(/\.dialog-overlay\s*\{/);
    expect(css).toMatch(/\.toast-region\s*\{/);
  });
});
