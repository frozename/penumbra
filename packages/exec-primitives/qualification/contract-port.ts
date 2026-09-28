import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

// Ports the package contract suite into a TEMPORARY penumbra-host consumer copy
// so the same tests run against the packed+installed tarball instead of
// ../src/index.ts. single-owner.test.ts is repo-side only (module-instance
// identity + the closure-audit script do not exist in an installed consumer);
// its namespace assertion is re-expressed as test/exports.parity.ts against the
// dist surface.
//
// Usage: bun qualification/contract-port.ts <consumer-copy-root>
// The target must live under tmp/sharedlib6/ so the qualification fence keeps
// the tracked qualification/ tree byte-identical during a run.

const PACKAGE_DIR = dirname(import.meta.dir);
const REPO_ROOT = join(PACKAGE_DIR, "..", "..");

const targetArg = process.argv[2];
if (targetArg === undefined || targetArg === "") {
  process.stderr.write("usage: bun qualification/contract-port.ts <consumer-copy-root>\n");
  process.exit(2);
}
const TARGET_ROOT = resolve(REPO_ROOT, targetArg);
const EXPECTED_PREFIX = join(REPO_ROOT, "tmp", "sharedlib6") + sep;
if (!TARGET_ROOT.startsWith(EXPECTED_PREFIX)) {
  process.stderr.write(
    `contract-port: refusing to write outside tmp/sharedlib6 (got ${TARGET_ROOT})\n`,
  );
  process.exit(2);
}
const OUT_DIR = join(TARGET_ROOT, "test", "contract");

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

process.stdout.write(
  `contract-port: wrote ${String(written)} files + fixture to ${OUT_DIR} (skipped: ${[...SKIP].join(", ")})\n`,
);
