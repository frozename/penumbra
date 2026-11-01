import { expect, test } from "bun:test";
import { ESLint } from "eslint";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const cases = [
  { pattern: "**/public.js", file: "public.js", matches: true },
  { pattern: "**/public.js", file: "private.js", matches: false },
  { pattern: "**/{public,shared}.js", file: "shared.js", matches: true },
  { pattern: "**/{public,shared}.js", file: "private.js", matches: false },
  { pattern: "!**/private.js", file: "public.js", matches: true },
  { pattern: "!**/private.js", file: "private.js", matches: false },
  { pattern: "**/*.js", file: ".hidden.js", matches: false },
  { pattern: "**/.hidden.js", file: ".hidden.js", matches: true },
  { pattern: "**/@(public|shared).js", file: "shared.js", matches: true },
  { pattern: "**/@(public|shared).js", file: "private.js", matches: false },
  { pattern: "**/PUBLIC.js", file: "PUBLIC.js", matches: true },
  { pattern: "**/PUBLIC.js", file: "public.js", matches: false },
];

for (const entrypoint of ["import", "require"] as const) {
  for (const mode of ["allow", "forbid"] as const) {
    for (const { pattern, file, matches } of cases) {
      test(`import-x ${entrypoint} ${mode} preserves ${pattern} matching ${file}`, async () => {
        const imported =
          entrypoint === "import"
            ? import("eslint-plugin-import-x")
            : Promise.resolve().then(
                () => require("eslint-plugin-import-x") as typeof import("eslint-plugin-import-x"),
              );
        const loadError = await imported.then(
          () => null,
          (error: unknown) => error,
        );
        expect(loadError).toBeNull();
        const { default: importX } = await imported;
        const root = mkdtempSync(join(tmpdir(), "lint-glob-compatibility-"));
        try {
          mkdirSync(join(root, "lib"));
          writeFileSync(join(root, "lib", file), "export default 1;\n");
          const eslint = new ESLint({
            cwd: root,
            overrideConfigFile: true,
            overrideConfig: {
              plugins: { "import-x": importX },
              rules: { "import-x/no-internal-modules": ["error", { [mode]: [pattern] }] },
            },
          });
          const lint = eslint.lintText(`import value from "./lib/${file}";`, {
            filePath: join(root, "entry.js"),
          });
          const lintError = await lint.then(
            () => null,
            (error: unknown) => error,
          );
          expect(lintError).toBeNull();
          const [result] = await lint;
          const violation = mode === "forbid" ? matches : !matches;
          expect(result?.errorCount).toBe(violation ? 1 : 0);
          expect(result?.fatalErrorCount).toBe(0);
          if (violation) expect(result?.messages[0]?.ruleId).toBe("import-x/no-internal-modules");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}
