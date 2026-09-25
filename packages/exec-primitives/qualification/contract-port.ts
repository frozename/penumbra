import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Ports the package contract suite into the penumbra-host consumer so the same
// tests run against the packed+installed tarball instead of ../src/index.ts.
// single-owner.test.ts is repo-side only (module-instance identity + the
// closure-audit script do not exist in an installed consumer); its namespace
// assertion is re-expressed as test/exports.test.ts against the dist surface.

const PACKAGE_DIR = dirname(import.meta.dir);
const HOST_DIR = join(PACKAGE_DIR, "qualification", "consumers", "penumbra-host");
const OUT_DIR = join(HOST_DIR, "test", "contract");

const SKIP = new Set(["single-owner.test.ts"]);

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(join(OUT_DIR, "fixtures"), { recursive: true });

const entries = readdirSync(join(PACKAGE_DIR, "test")).filter(
  (f) => f.endsWith(".test.ts") && !SKIP.has(f),
);
let written = 0;
for (const file of [...entries, "helpers.ts"]) {
  const src = readFileSync(join(PACKAGE_DIR, "test", file), "utf8");
  const rewritten = src.replaceAll('"../src/index.ts"', '"penumbra-exec-primitives"');
  writeFileSync(join(OUT_DIR, file), rewritten);
  written += 1;
}
cpSync(
  join(PACKAGE_DIR, "test", "fixtures", "fake-acp.ts"),
  join(OUT_DIR, "fixtures", "fake-acp.ts"),
);

// The rewritten bare specifier sorts differently than "../src/index.ts" did;
// let eslint normalize import grouping so the generated copies stay lint-clean.
spawnSync("bunx", ["eslint", "--fix", "--no-warn-ignored", OUT_DIR], {
  cwd: join(PACKAGE_DIR, "..", ".."),
  stdio: "inherit",
});

process.stdout.write(
  `contract-port: wrote ${String(written)} files + fixture to ${OUT_DIR} (skipped: ${[...SKIP].join(", ")})\n`,
);
