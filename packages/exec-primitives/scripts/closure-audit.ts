/**
 * closure-audit.ts — static boundary audit for the exec-primitives package.
 * The audit engine lives in closure-audit-core.ts (split under the
 * max-lines cap).
 *
 * Modes:
 *   --src              audit packages/exec-primitives/src/**
 *   --tarball <dir>    audit <dir>/package/dist/src/** (.js and .d.ts) + manifest
 *   --consumers        audit qualification/consumers dirs' {src,test,fixtures}
 *   --self-test        audit qualification/audit-fixtures/* (each must behave
 *                      as expected) then the real src/**; a missing fixture fails
 *
 * Exit 0 when clean; exit 1 with one "finding:" line per violation otherwise.
 * A run with no mode argument audits nothing and exits non-zero.
 * Counts are printed as JSON so evidence can copy them verbatim.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  auditAndPrint,
  auditCodeRoot,
  auditConsumerRoot,
  loadAllowlist,
} from "./closure-audit-core.js";

const SCRIPTS_DIR = import.meta.dir;
const PACKAGE_DIR = dirname(SCRIPTS_DIR);
const QUALIFICATION_DIR = join(PACKAGE_DIR, "qualification");
const FIXTURES_DIR = join(QUALIFICATION_DIR, "audit-fixtures");
const ALLOWLIST_PATH = join(QUALIFICATION_DIR, "audit-allowlist.json");
const DIST_ALLOWLIST_PATH = join(QUALIFICATION_DIR, "audit-allowlist-dist.json");

const FIXTURE_EXPECTATIONS: {
  name: string;
  mode: "code" | "consumer";
  rule: string;
  token: string;
}[] = [
  {
    name: "a-penumbra-core-type-import",
    mode: "code",
    rule: "forbidden-specifier",
    token: "@penumbra/core",
  },
  {
    name: "a-penumbra-core-dynamic-import",
    mode: "code",
    rule: "dynamic-import",
    token: "@penumbra/core",
  },
  {
    name: "a-src-alias",
    mode: "code",
    rule: "forbidden-specifier",
    token: "@src/adapters/helper.js",
  },
  {
    name: "a-relative-escape",
    mode: "code",
    rule: "relative-escape",
    token: "../../../agentchat/src/adapters/helper.js",
  },
  { name: "a-node-fs", mode: "code", rule: "node-builtin", token: "node:fs" },
  { name: "a-process-env", mode: "code", rule: "process-env", token: "process-env" },
  { name: "a-console", mode: "code", rule: "console", token: "console" },
  {
    name: "a-dependencies-key",
    mode: "code",
    rule: "dependencies-key",
    token: "dependencies",
  },
  { name: "b-top-level-let", mode: "code", rule: "mutable-binding", token: "let|var" },
  { name: "b-const-map", mode: "code", rule: "mutable-binding", token: "new Map" },
  { name: "b-const-annotated-array", mode: "code", rule: "mutable-binding", token: "[" },
  { name: "b-const-object-literal", mode: "code", rule: "mutable-binding", token: "{" },
  {
    name: "b-const-arrow-map",
    mode: "code",
    rule: "mutable-binding",
    token: "new Map",
  },
  { name: "b-const-arrow-record", mode: "code", rule: "mutable-binding", token: "{" },
  { name: "b-static-member", mode: "code", rule: "mutable-binding", token: "static new Map" },
  {
    name: "c-unlisted-fallback",
    mode: "code",
    rule: "policy-token",
    token: "fallbacktolocal",
  },
  {
    name: "c-stale-allowlist",
    mode: "code",
    rule: "stale-allowlist",
    token: "nomatchtokenhere",
  },
  {
    name: "d-consumer-dist-path",
    mode: "consumer",
    rule: "consumer-banned-path",
    token: "./dist/internal.js",
  },
  {
    name: "d-consumer-packages-path",
    mode: "consumer",
    rule: "consumer-banned-path",
    token: "../../packages/agentchat/src/adapters/helper.js",
  },
  {
    name: "d-consumer-child-process",
    mode: "consumer",
    rule: "consumer-node-builtin",
    token: "node:child_process",
  },
  {
    name: "d-consumer-shim-no-package-import",
    mode: "consumer",
    rule: "consumer-no-package-import",
    token: "penumbra-exec-primitives",
  },
  {
    name: "d-consumer-guard-dynamic-import",
    mode: "consumer",
    rule: "consumer-bare-specifier",
    token: "@penumbra/core",
  },
  { name: "clean", mode: "code", rule: "", token: "" },
];

function checkFixture(fixture: (typeof FIXTURE_EXPECTATIONS)[number]): string[] {
  const dir = join(FIXTURES_DIR, fixture.name);
  if (!existsSync(dir)) return [`missing fixture ${fixture.name}`];
  const result =
    fixture.mode === "consumer"
      ? auditConsumerRoot(dir)
      : auditCodeRoot(
          dir,
          [".ts", ".js", ".mjs", ".d.ts"],
          loadAllowlist(join(dir, "audit-allowlist.json")),
        );
  const hits = result.findings;
  if (fixture.rule === "") {
    return hits.length !== 0 || result.mutableBindings !== 0
      ? [`expected clean audit, got ${String(hits.length)} findings`]
      : [];
  }
  const matching = hits.filter((h) => h.rule === fixture.rule);
  if (hits.length !== 1 || matching.length !== 1) {
    return [
      `expected exactly one ${fixture.rule} hit, got ${JSON.stringify(
        hits.map((h) => `${h.rule}@${h.file}:${String(h.line)}`),
      )}`,
    ];
  }
  const hit = matching[0];
  if (hit?.token !== fixture.token) {
    return [`expected token ${JSON.stringify(fixture.token)}, got ${JSON.stringify(hit?.token)}`];
  }
  return [];
}

function runSelfTest(): number {
  let failures = 0;
  for (const fixture of FIXTURE_EXPECTATIONS) {
    for (const err of checkFixture(fixture)) {
      process.stdout.write(`self-test FAIL: ${fixture.name}: ${err}\n`);
      failures += 1;
    }
  }
  const src = auditAndPrint("src", join(PACKAGE_DIR, "src"), "code", [".ts"], ALLOWLIST_PATH);
  if (src.findings.length > 0 || src.mutableBindings > 0) {
    process.stdout.write("self-test FAIL: real src audit not clean\n");
    failures += 1;
  }
  if (failures === 0) {
    process.stdout.write(
      `self-test: PASS (${String(FIXTURE_EXPECTATIONS.length)} fixtures, src clean)\n`,
    );
    return 0;
  }
  process.stdout.write(`self-test: FAIL (${String(failures)} fixture failures)\n`);
  return 1;
}

function checkManifestDeps(manifestPath: string): number {
  if (!existsSync(manifestPath)) {
    process.stdout.write(`finding: package.json:0 [missing-dir] ${manifestPath}\n`);
    return 1;
  }
  if ("dependencies" in (JSON.parse(readFileSync(manifestPath, "utf8")) as object)) {
    process.stdout.write(`finding: package.json:0 [dependencies-key] dependencies\n`);
    return 1;
  }
  return 0;
}

function auditSrcMode(): number {
  const r = auditAndPrint("src", join(PACKAGE_DIR, "src"), "code", [".ts"], ALLOWLIST_PATH);
  // The src/ subtree has no manifest of its own — audit the package manifest
  // for a runtime `dependencies` key (the package must stay dependency-free).
  let failures = checkManifestDeps(join(PACKAGE_DIR, "package.json"));
  if (r.findings.length > 0 || r.mutableBindings > 0) failures += 1;
  return failures;
}

function auditTarballMode(dir: string): number {
  const r = auditAndPrint(
    "tarball",
    join(dir, "package", "dist", "src"),
    "code",
    [".js", ".d.ts"],
    DIST_ALLOWLIST_PATH,
  );
  let failures = checkManifestDeps(join(dir, "package", "package.json"));
  if (r.findings.length > 0 || r.mutableBindings > 0) failures += 1;
  return failures;
}

function auditConsumersMode(): number {
  const consumersDir = join(QUALIFICATION_DIR, "consumers");
  if (!existsSync(consumersDir)) {
    process.stdout.write(`finding: consumers:0 [missing-dir] ${consumersDir}\n`);
    return 1;
  }
  let failures = 0;
  for (const name of readdirSync(consumersDir).sort()) {
    const consumerDir = join(consumersDir, name);
    if (!statSync(consumerDir).isDirectory()) continue;
    const r = auditAndPrint(`consumer:${name}`, consumerDir, "consumer", [], "");
    if (r.findings.length > 0) failures += 1;
  }
  return failures;
}

function usage(): never {
  process.stdout.write(
    "usage: closure-audit.ts (--src | --tarball <dir> | --consumers | --self-test) ...\n",
  );
  process.exit(2);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    process.exit(runSelfTest());
  }
  const modeFlags = ["--src", "--tarball", "--consumers"];
  if (!modeFlags.some((f) => args.includes(f))) {
    usage();
  }
  let failures = 0;
  if (args.includes("--src")) failures += auditSrcMode();
  const tarballIdx = args.indexOf("--tarball");
  if (tarballIdx !== -1) {
    const dir = args[tarballIdx + 1];
    if (dir === undefined) {
      process.stdout.write("usage: --tarball <extracted-dir>\n");
      process.exit(2);
    }
    failures += auditTarballMode(dir);
  }
  if (args.includes("--consumers")) failures += auditConsumersMode();
  process.stdout.write(
    failures === 0 ? "closure-audit: PASS\n" : `closure-audit: FAIL (${String(failures)})\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
