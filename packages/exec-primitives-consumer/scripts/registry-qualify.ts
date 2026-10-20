#!/usr/bin/env bun
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyWorktree,
  computeDigest,
  computeTarballHashes,
  hasLockEntry,
  listRecursiveEntries,
  parseBunSummary,
  REGISTRY_QUALIFY_IDENTITY_EXIT,
  REGISTRY_QUALIFY_WORKTREE_EXIT,
  validatePublishedManifest,
} from "./registry-qualify-helpers.ts";
import { renderEvidenceJson, renderEvidenceMd } from "./registry-qualify-evidence.ts";
import {
  CONTENT_SHA256,
  INTEGRITY,
  LOCK_ENTRY,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SHA1,
  SHA256,
  TARBALL_URL,
} from "../src/pin.ts";

const TAG = "qualification/sharedlib6-2026-09-24";
const TAG_COMMIT = "001e12fc79c40d6c3c3a5fdf106d96d420f4c997";
const ANCESTRY_FLOOR_SHA = "f122106dc5e84849eba1ba415c0ae122a6e79338";
const RUN_JSON = "tmp/exec-primitives-registry/run.json";
const EVIDENCE_JSON = "docs/qualification/exec-primitives-0.1.0-registry-qualification.json";
const EVIDENCE_MD = "docs/qualification/exec-primitives-0.1.0-registry-qualification.md";
const SPAWN_TIMEOUT_MS = 600_000;

const SOURCE_BLOBS: Record<string, string> = {
  "acp-session": "d4a384d7ef5d42be1c6db33ceafa53ab370e0b4b",
  "acp-warm-pool": "93c4d650f802f20ffcec8dc63c6fa9ff43ab294d",
  host: "04ca1b1806d46a8bd4b5a9524956148d64a1dfde",
  index: "addb29f8a1f2ad26c56d3b045b947f726e25058a",
  "process-supervisor": "677bc723d4850efedde6d20ef2c8eec137211088",
  "stdio-acp-client": "6e9239130aa9bb2d1caddb3c59229062ae99fb24",
  "stdio-acp-permission": "44319d7a318ec72962e62eb6c5591b723841e6cf",
  "stdio-acp-server": "654b32188b8a6fbe070872cea6827b86dcf5d2fc",
};

const PARITY: Record<string, Record<string, number>> = {
  "penumbra-host": {
    "acp-warm-pool": 22,
    "cli-spawn": 24,
    "cli-spawn-stream": 10,
    exports: 1,
    guard: 1,
    "stdio-acp-client": 11,
    "stdio-acp-client-onrequest": 6,
    "stdio-acp-permission": 28,
    "stdio-acp-server": 5,
  },
  "infra-host": { infra: 21 },
};

const CONTRACT: Record<string, number> = {
  "acp-permission": 9,
  "acp-session": 7,
  "acp-transport": 11,
  "acp-warm-pool": 7,
  logging: 3,
  "process-supervisor": 33,
};

interface CmdResult {
  exit: number;
  stdout: string;
  stderr: string;
}

interface Adaptation {
  id: string;
  change: string;
}

interface ConsumerRun {
  parity: Record<string, number>;
  contract?: Record<string, number>;
  bun_test: { pass: number; fail: number; files: number };
  installed_content_sha256: string;
  install_specifier: string;
  copy_outside_repo: boolean;
  resolved_inside_copy: boolean;
  digest_equal: boolean;
  poison_run: { pass: number; exit: number };
  home_entries_after: string[];
  fixture_toolchain: { typescript: string; "@types/node": string };
  adaptations: Adaptation[];
  guard: { exit: number };
  smoke_node?: { exit: number };
}

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const writeEvidence = process.argv.includes("--write-evidence");

function run(
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; log?: string } = {},
): CmdResult {
  const proc = Bun.spawnSync({
    cmd: [cmd, ...args],
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: SPAWN_TIMEOUT_MS,
  });
  const result = {
    exit: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
  if (options.log) writeFileSync(options.log, result.stdout + result.stderr);
  return result;
}

function must(
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; log?: string } = {},
): CmdResult {
  const result = run(cmd, args, options);
  if (result.exit !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed with ${result.exit}${options.log ? `; see ${options.log}` : ""}`,
    );
  }
  return result;
}

function failClosed(message: string): never {
  console.error(message);
  process.exit(REGISTRY_QUALIFY_IDENTITY_EXIT);
}

function failWorktree(message: string): never {
  console.error(message);
  process.exit(REGISTRY_QUALIFY_WORKTREE_EXIT);
}

function failRun(message: string): never {
  console.error(message);
  process.exit(1);
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  function walk(current: string): void {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) files.push(relative(dir, full));
    }
  }
  walk(dir);
  return files.sort();
}

function requireBunSummary(
  output: string,
  label: string,
): { pass: number; fail: number; files: number } {
  const summary = parseBunSummary(output);
  if (!summary) throw new Error(`${label} missing complete bun summary`);
  return summary;
}

function rewriteFiles(dir: string, needle: string, replacement: string): Adaptation[] {
  const adaptations: Adaptation[] = [];
  for (const rel of listFiles(dir)) {
    const path = join(dir, rel);
    const text = readFileSync(path, "utf8");
    if (!text.includes(needle)) continue;
    writeFileSync(path, text.split(needle).join(replacement));
    adaptations.push({ id: rel, change: `rewrote ${needle} to ${replacement}` });
  }
  return adaptations;
}

function makeEnv(runDir: string, name: string, poison: boolean): Record<string, string> {
  const home = join(runDir, "home", name);
  const xdg = join(runDir, "home", `${name}-xdg`);
  const cache = join(runDir, "bun", `${name}-cache`);
  const install = join(runDir, "bun", `${name}-install`);
  const tmp = join(runDir, "bun", `${name}-tmp`);
  const xdgCache = join(runDir, "bun", `${name}-xdgc`);
  for (const d of [home, xdg, cache, install, tmp, xdgCache]) mkdirSync(d, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    XDG_CACHE_HOME: xdgCache,
    BUN_INSTALL: install,
    BUN_INSTALL_CACHE_DIR: cache,
    TMPDIR: tmp,
    TERM: "dumb",
    NO_COLOR: "1",
  };
  if (poison) {
    Object.assign(env, {
      HTTP_PROXY: "http://127.0.0.1:9/",
      HTTPS_PROXY: "http://127.0.0.1:9/",
      http_proxy: "http://127.0.0.1:9/",
      https_proxy: "http://127.0.0.1:9/",
      ALL_PROXY: "http://127.0.0.1:9/",
      all_proxy: "http://127.0.0.1:9/",
      npm_config_registry: "http://127.0.0.1:9/",
    });
  }
  return env;
}

function homeEntries(runDir: string, name: string): string[] {
  const roots = [join(runDir, "home", name), join(runDir, "home", `${name}-xdg`)];
  const entries: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const rel of listRecursiveEntries(root)) entries.push(relative(runDir, join(root, rel)));
  }
  return entries.sort();
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

async function artifact(runDir: string) {
  const tgzDir = join(runDir, "tgz");
  const extract = join(tgzDir, "x");
  mkdirSync(extract, { recursive: true });
  let response: Response;
  try {
    response = await fetch(TARBALL_URL);
  } catch (error) {
    failClosed(`tarball fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) failClosed(`tarball fetch failed: ${response.status}`);
  const buf = Buffer.from(await response.arrayBuffer());
  const hashes = computeTarballHashes(buf);
  if (hashes.sha256 !== SHA256 || hashes.sha1 !== SHA1 || hashes.integrity !== INTEGRITY) {
    failClosed("tarball identity does not match src/pin.ts");
  }
  const tgz = join(tgzDir, "package.tgz");
  writeFileSync(tgz, buf);
  must("tar", ["-xzf", tgz, "-C", extract]);
  const pkg = join(extract, "package");
  const manifestBad = validatePublishedManifest(readJson(join(pkg, "package.json")));
  if (manifestBad.length > 0)
    failClosed(`published manifest gate failed: ${manifestBad.join(",")}`);
  const entries = listFiles(pkg);
  const unpackedBytes = entries.reduce((n, rel) => n + readFileSync(join(pkg, rel)).byteLength, 0);
  const digest = computeDigest(pkg);
  if (entries.length !== 19 || unpackedBytes !== 83005 || digest !== CONTENT_SHA256) {
    failClosed("tarball content identity does not match src/pin.ts");
  }
  return {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    tarball_url: TARBALL_URL,
    sha256: hashes.sha256,
    sha1: hashes.sha1,
    integrity: hashes.integrity,
    files: entries.length,
    unpacked_bytes: unpackedBytes,
    content_sha256: digest,
    entries,
  };
}

async function fetchDistTagsLatest(): Promise<{ http: number; latest: string }> {
  let response: Response;
  try {
    response = await fetch("https://registry.npmjs.org/@novaproto%2fexec-primitives", {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
    });
  } catch (error) {
    failClosed(`packument fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) failClosed(`packument fetch failed: ${response.status}`);
  const body = (await response.json()) as { "dist-tags"?: Record<string, string> };
  const latest = body["dist-tags"]?.["latest"] ?? "";
  if (latest !== PACKAGE_VERSION) failClosed(`packument latest mismatch: ${latest}`);
  return { http: response.status, latest };
}

function preflight(): void {
  rmSync(join(repoRoot, RUN_JSON), { force: true });
  if (run("git", ["merge-base", "--is-ancestor", ANCESTRY_FLOOR_SHA, "HEAD"]).exit !== 0) {
    failClosed(`ancestry floor is not an ancestor of HEAD: ${ANCESTRY_FLOOR_SHA}`);
  }
  const tag = run("git", ["rev-parse", "-q", "--verify", `${TAG}^{commit}`]).stdout.trim();
  if (tag !== TAG_COMMIT) failClosed("qualification tag is missing or moved");
  for (const [name, blob] of Object.entries(SOURCE_BLOBS)) {
    const actual = run("git", [
      "rev-parse",
      `${TAG_COMMIT}:packages/exec-primitives/src/${name}.ts`,
    ]).stdout.trim();
    if (actual !== blob) failClosed(`source blob mismatch: ${name}`);
  }
  const srcCount = run("git", [
    "ls-tree",
    "--name-only",
    TAG_COMMIT,
    "packages/exec-primitives/src/",
  ])
    .stdout.trim()
    .split("\n")
    .filter(Boolean).length;
  if (srcCount !== 8) failClosed("source blob count mismatch");
}

function assertCleanWorktree(): string {
  const status = run("git", ["status", "--porcelain"]);
  const classification = classifyWorktree({ exit: status.exit, stdout: status.stdout });
  if (classification === "dirty")
    failWorktree("worktree is dirty; refusing to write measured evidence");
  if (classification === "unreadable") {
    failWorktree("worktree status unreadable; refusing to write measured evidence");
  }
  const head = run("git", ["rev-parse", "HEAD"]);
  if (head.exit !== 0 || head.stdout.trim() === "") {
    failWorktree("worktree HEAD unreadable; refusing to write measured evidence");
  }
  return head.stdout.trim();
}

function assertHeadStableAndClean(expectedHead: string): void {
  const head = assertCleanWorktree();
  if (head !== expectedHead) {
    failWorktree("HEAD changed while measuring evidence; refusing to write measured evidence");
  }
}

function assertRunDirOutsideRepo(runDir: string): void {
  const repo = realpathSync(repoRoot);
  const run = realpathSync(runDir);
  if (run === repo || run.startsWith(`${repo}/`)) {
    failClosed("run directory resolved inside repository");
  }
}

function measureBaseSha(): string {
  return must("git", ["merge-base", "HEAD", "origin/main"]).stdout.trim();
}

function measurePin(): {
  manifest: string;
  section: string;
  specifier: string;
  lock_entry: string;
} {
  const manifestPath = "packages/exec-primitives-consumer/package.json";
  const manifest = readJson(join(repoRoot, manifestPath));
  const specifier =
    (manifest["devDependencies"] as Record<string, string> | undefined)?.[PACKAGE_NAME] ?? "";
  if (specifier !== PACKAGE_VERSION) failClosed(`manifest pin mismatch: ${specifier}`);
  const lockLine = readFileSync(join(repoRoot, "bun.lock"), "utf8")
    .split("\n")
    .find((line) => line.trim().startsWith(`"${PACKAGE_NAME}": [`))
    ?.trim()
    .replace(/,$/, "");
  if (lockLine !== LOCK_ENTRY) failClosed("root bun.lock entry mismatch");
  return {
    manifest: manifestPath,
    section: "devDependencies",
    specifier,
    lock_entry: lockLine,
  };
}

function measureRuntimeImportFence(): boolean {
  const out = run("git", [
    "grep",
    "-l",
    "-E",
    `(from|import\\()[[:space:]]*['"]${PACKAGE_NAME}`,
    "HEAD",
    "--",
    "packages",
    "plugin",
    "scripts",
    "test",
    ":!packages/exec-primitives-consumer",
  ]);
  if (out.exit === 1 && out.stdout.trim() === "") return false;
  if (out.exit !== 0) throw new Error(`git grep failed with ${out.exit}: ${out.stderr}`);
  failClosed(`runtime import outside consumer: ${out.stdout.trim()}`);
}

function exportFixtures(runDir: string): string {
  const exportDir = join(runDir, "export");
  mkdirSync(exportDir, { recursive: true });
  must("bash", [
    "-c",
    `git archive ${TAG_COMMIT} packages/exec-primitives/qualification/consumers packages/exec-primitives/test | tar -x -C "$1"`,
    "export-fixtures",
    exportDir,
  ]);
  return join(exportDir, "packages", "exec-primitives");
}

function writeConsumerTsconfig(dir: string): void {
  writeFileSync(
    join(dir, "tsconfig.consumer.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "esnext",
        module: "esnext",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        noEmit: true,
        types: ["node"],
        skipLibCheck: true,
      },
      include: ["src/**/*"],
    }),
    "utf8",
  );
  writeFileSync(
    join(dir, "tsconfig.consumer.json"),
    `${readFileSync(join(dir, "tsconfig.consumer.json"), "utf8")}\n`,
  );
}

function prepareConsumer(name: string, fixtureRoot: string, dest: string): Adaptation[] {
  cpSync(join(fixtureRoot, "qualification", "consumers", name), dest, { recursive: true });
  for (const f of readdirSync(dest)) {
    if (f.startsWith("tsconfig") && f.endsWith(".json")) rmSync(join(dest, f), { force: true });
  }
  const testDir = join(dest, "test");
  for (const f of readdirSync(testDir)) {
    if (f.endsWith(".parity.ts")) {
      const from = join(testDir, f);
      const to = join(testDir, `${f.slice(0, -".parity.ts".length)}.test.ts`);
      cpSync(from, to);
      rmSync(from);
    }
  }
  const adaptations = rewriteFiles(dest, "penumbra-exec-primitives", PACKAGE_NAME);
  if (name === "penumbra-host") {
    const contractDir = join(dest, "test", "contract");
    mkdirSync(join(contractDir, "fixtures"), { recursive: true });
    for (const f of readdirSync(join(fixtureRoot, "test"))) {
      if (f === "single-owner.test.ts") continue;
      const src = join(fixtureRoot, "test", f);
      const st = statSync(src);
      if (!st.isFile()) continue;
      const out = join(contractDir, f);
      writeFileSync(
        out,
        readFileSync(src, "utf8").split('"../src/index.ts"').join(`"${PACKAGE_NAME}"`),
      );
      adaptations.push({
        id: `test/contract/${f}`,
        change: `ported contract suite to ${PACKAGE_NAME}`,
      });
    }
    cpSync(
      join(fixtureRoot, "test", "fixtures", "fake-acp.ts"),
      join(contractDir, "fixtures", "fake-acp.ts"),
    );
    adaptations.push({
      id: "test/contract/fixtures/fake-acp.ts",
      change: "ported contract fixture",
    });
  }
  if (
    listFiles(dest).some((rel) =>
      readFileSync(join(dest, rel), "utf8").includes("penumbra-exec-primitives"),
    )
  ) {
    throw new Error(`${name} still contains the local package specifier`);
  }
  writeConsumerTsconfig(dest);
  return adaptations;
}

function countFile(log: string, want: number, label: string): number {
  const summary = requireBunSummary(readFileSync(log, "utf8"), label);
  if (summary.pass !== want || summary.fail !== 0) {
    throw new Error(`${label} expected ${want}/0, got ${summary.pass}/${summary.fail}`);
  }
  return summary.pass;
}

function readPackageVersion(dir: string): string {
  const manifest = readJson(join(dir, "package.json"));
  const version = manifest["version"];
  if (typeof version !== "string") throw new Error(`${dir} missing package version`);
  return version;
}

function runConsumer(name: string, fixtureRoot: string, runDir: string): ConsumerRun {
  const dir = join(runDir, `consumer-${name}`);
  const logs = join(runDir, "logs");
  mkdirSync(logs, { recursive: true });
  const adaptations = prepareConsumer(name, fixtureRoot, dir);
  const installEnv = makeEnv(runDir, name, false);
  must("bun", ["add", "--exact", `${PACKAGE_NAME}@${PACKAGE_VERSION}`], {
    cwd: dir,
    env: installEnv,
    log: join(logs, `${name}-add.log`),
  });
  const manifest = readJson(join(dir, "package.json"));
  const specifier =
    (manifest["dependencies"] as Record<string, string> | undefined)?.[PACKAGE_NAME] ?? "";
  if (specifier !== PACKAGE_VERSION) throw new Error(`${name} install specifier mismatch`);
  if (!hasLockEntry(readFileSync(join(dir, "bun.lock"), "utf8")))
    throw new Error(`${name} lock entry mismatch`);
  const fixtureToolchain = {
    typescript: readPackageVersion(join(dir, "node_modules", "typescript")),
    "@types/node": readPackageVersion(join(dir, "node_modules", "@types", "node")),
  };

  const env = makeEnv(runDir, name, true);
  must("./node_modules/.bin/tsc", ["--noEmit", "-p", "tsconfig.consumer.json"], {
    cwd: dir,
    env,
    log: join(logs, `${name}-typecheck.log`),
  });
  must("bun", ["src/smoke.ts"], { cwd: dir, env, log: join(logs, `${name}-smoke-bun.log`) });
  const smokeNode =
    name === "infra-host"
      ? run("node", ["src/smoke.ts"], { cwd: dir, env, log: join(logs, `${name}-smoke-node.log`) })
      : undefined;
  if (smokeNode && smokeNode.exit !== 0) throw new Error(`${name} node smoke failed`);

  const parity: Record<string, number> = {};
  for (const [stem, want] of Object.entries(PARITY[name]!)) {
    const log = join(logs, `${name}-parity-${stem}.log`);
    const result = run("bun", ["test", `./test/${stem}.test.ts`], { cwd: dir, env, log });
    if (result.exit !== 0) throw new Error(`${name} parity ${stem} failed`);
    parity[`${stem}.test.ts`] = countFile(log, want, `${name} ${stem}`);
  }

  const contract: Record<string, number> = {};
  if (name === "penumbra-host") {
    for (const [stem, want] of Object.entries(CONTRACT)) {
      const log = join(logs, `${name}-contract-${stem}.log`);
      const result = run("bun", ["test", `./test/contract/${stem}.test.ts`], {
        cwd: dir,
        env,
        log,
      });
      if (result.exit !== 0) throw new Error(`${name} contract ${stem} failed`);
      contract[`contract/${stem}.test.ts`] = countFile(log, want, `${name} contract ${stem}`);
    }
  }

  const fullLog = join(logs, `${name}-bun-test.log`);
  const full = run("bun", ["test"], { cwd: dir, env, log: fullLog });
  const fullSummary = requireBunSummary(readFileSync(fullLog, "utf8"), `${name} full bun test`);
  const expectedFull = name === "penumbra-host" ? { pass: 178, files: 15 } : { pass: 21, files: 1 };
  if (
    full.exit !== 0 ||
    fullSummary.pass !== expectedFull.pass ||
    fullSummary.fail !== 0 ||
    fullSummary.files !== expectedFull.files
  ) {
    throw new Error(`${name} full bun test mismatch`);
  }

  const resolved =
    run(
      "bun",
      [
        "-e",
        `import { realpathSync } from "node:fs"; console.log(realpathSync(Bun.fileURLToPath(import.meta.resolve("${PACKAGE_NAME}"))))`,
      ],
      { cwd: dir, env },
    )
      .stdout.trim()
      .split("\n")
      .at(-1) ?? "";
  const realDir = realpathSync(dir);
  const resolvedInsideCopy = resolved.startsWith(`${realDir}/`);
  if (!resolvedInsideCopy) throw new Error(`${name} resolved outside copy`);
  const guard = run(
    "bun",
    [
      "-e",
      'import("@penumbra/core").then(()=>process.exit(1),(e)=>process.exit(/resolution-guard/.test(String(e))?0:2))',
    ],
    { cwd: dir, env },
  );
  if (guard.exit !== 0) throw new Error(`${name} guard failed`);

  const pkgDir = realpathSync(join(dir, "node_modules", PACKAGE_NAME));
  const installedDigest = computeDigest(pkgDir);
  const digestEqual = installedDigest === CONTENT_SHA256;
  if (!digestEqual) throw new Error(`${name} installed digest mismatch`);
  const entry = join(pkgDir, "dist", "src", "index.js");
  const backup = join(runDir, `${name}-entry.bak`);
  cpSync(entry, backup);
  rmSync(entry);
  writeFileSync(entry, 'throw new Error("poisoned installed entry")\n');
  const poisonLog = join(logs, `${name}-poison.log`);
  let poison: CmdResult;
  let poisonSummary: { pass: number; fail: number; files: number };
  try {
    poison = run("bun", ["test"], { cwd: dir, env, log: poisonLog });
    poisonSummary = requireBunSummary(readFileSync(poisonLog, "utf8"), `${name} poison run`);
  } finally {
    rmSync(entry, { force: true });
    cpSync(backup, entry);
  }
  const digestAfterPoison = computeDigest(pkgDir);
  if (
    poison.exit === 0 ||
    poisonSummary.pass !== 0 ||
    poisonSummary.fail !== expectedFull.files ||
    poisonSummary.files !== expectedFull.files ||
    digestAfterPoison !== CONTENT_SHA256
  ) {
    throw new Error(`${name} poison run did not fail closed or restore cleanly`);
  }

  const homes = homeEntries(runDir, name);
  if (homes.length > 0) throw new Error(`${name} home entries not empty: ${homes.join(",")}`);
  return {
    parity,
    ...(name === "penumbra-host" ? { contract } : {}),
    bun_test: fullSummary,
    installed_content_sha256: installedDigest,
    install_specifier: specifier,
    copy_outside_repo: !realDir.startsWith(`${realpathSync(repoRoot)}/`),
    resolved_inside_copy: resolvedInsideCopy,
    digest_equal: digestEqual,
    poison_run: { pass: poisonSummary.pass, exit: poison.exit },
    home_entries_after: homes,
    fixture_toolchain: fixtureToolchain,
    adaptations,
    guard: { exit: guard.exit },
    ...(smokeNode ? { smoke_node: { exit: smokeNode.exit } } : {}),
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  if (writeEvidence) {
    const runJsonPath = join(repoRoot, RUN_JSON);
    if (!existsSync(runJsonPath))
      failRun(`${RUN_JSON} is missing; run without --write-evidence first`);
    const runJson = JSON.parse(readFileSync(runJsonPath, "utf8")) as Parameters<
      typeof renderEvidenceJson
    >[0];
    writeFileSync(join(repoRoot, EVIDENCE_JSON), `${renderEvidenceJson(runJson)}\n`);
    writeFileSync(join(repoRoot, EVIDENCE_MD), renderEvidenceMd(runJson));
    console.log(EVIDENCE_JSON);
    console.log(EVIDENCE_MD);
    return;
  }

  preflight();
  const runDir = mkdtempSync(join(tmpdir(), "exec-primitives-registry-"));
  assertRunDirOutsideRepo(runDir);
  mkdirSync(join(repoRoot, dirname(RUN_JSON)), { recursive: true });
  mkdirSync(join(runDir, "node_modules", "@penumbra", "core"), { recursive: true });
  writeFileSync(
    join(runDir, "node_modules", "@penumbra", "core", "package.json"),
    '{"name":"@penumbra/core","version":"0.0.0","type":"module","main":"./index.js"}\n',
  );
  writeFileSync(
    join(runDir, "node_modules", "@penumbra", "core", "index.js"),
    'throw new Error("@penumbra/core resolved inside a registry-artifact consumer (resolution-guard)")\n',
  );
  const artifactInfo = await artifact(runDir);
  const release = await fetchDistTagsLatest();
  const cleanHead = assertCleanWorktree();
  const pin = measurePin();
  const penumbraRuntimeImport = measureRuntimeImportFence();
  const fixtureRoot = exportFixtures(runDir);
  const measuredRows: string[] = [];
  const consumers = {
    "penumbra-host": runConsumer("penumbra-host", fixtureRoot, runDir),
    "infra-host": runConsumer("infra-host", fixtureRoot, runDir),
  };
  for (const [consumer, result] of Object.entries(consumers)) {
    for (const [file, pass] of Object.entries(result.parity))
      measuredRows.push(`${consumer}\t${file}\t${pass}\t0`);
    for (const [file, pass] of Object.entries(result.contract ?? {}))
      measuredRows.push(`${consumer}\t${file}\t${pass}\t0`);
    measuredRows.push(
      `${consumer}\tALL\t${result.bun_test.pass}\t${result.bun_test.fail}\t${result.bun_test.files}`,
    );
  }
  writeFileSync(join(runDir, "measured.tsv"), `${measuredRows.join("\n")}\n`);
  assertHeadStableAndClean(cleanHead);
  const runJson = {
    schema: "exec-primitives-registry-run/1",
    started_at: startedAt,
    run_dir: runDir,
    consumers,
    artifact: artifactInfo,
    pin,
    release,
    honesty: { penumbra_runtime_import: penumbraRuntimeImport },
    toolchain: {
      bun: run("bun", ["--version"]).stdout.trim(),
      node: must("node", ["--version"], { env: { PATH: process.env["PATH"] ?? "" } }).stdout.trim(),
      bun_node_compat: process.version,
    },
    base_sha: measureBaseSha(),
    ancestry_floor_sha: ANCESTRY_FLOOR_SHA,
    head_sha: cleanHead,
  };
  writeFileSync(join(repoRoot, RUN_JSON), `${JSON.stringify(runJson, null, 2)}\n`);
  console.log(RUN_JSON);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
