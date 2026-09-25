#!/usr/bin/env bun
/**
 * Tarball qualification: pack the library, install the packed artifact into two
 * temporary host consumers under tmp/sharedlib6/, and prove it runs there
 * without any penumbra workspace source on the resolution path.
 *
 * Layout (all inside tmp/sharedlib6/, wiped by the composite check):
 *   pack/penumbra-exec-primitives-0.1.0.tgz   — candidate tarball
 *   pack/repack/…tgz                          — second pack for byte determinism
 *   pack/extracted/, pack/repack-extracted/   — unpacked content trees
 *   node_modules/@penumbra/<name>/            — poison layer: any upward
 *     resolution of @penumbra/* from a consumer copy lands on a throwing stub
 *   home/<consumer>/                          — isolated HOME per consumer
 *   home/<consumer>-xdg/                      — isolated XDG_CONFIG_HOME
 *   bun/<consumer>-<role>/                    — bun caches + tmpdirs
 *   consumer-<name>/                          — copied consumer fixture
 *
 * Per consumer the runner:
 *   1. copies the tracked fixture (omitting tsconfig*.json, renaming
 *      test/*.parity.ts to *.test.ts so `bun test` picks them up) and writes a
 *      tsconfig.consumer.json scoped to src/** with types ["node"];
 *   2. installs the tarball with `bun add ../pack/penumbra-exec-primitives-0.1.0.tgz`
 *      under an isolated HOME + bun cache and asserts the manifest carries
 *      penumbra-exec-primitives as its only runtime dependency;
 *   3. typechecks the consumer src against the installed .d.ts with its own
 *      typescript + @types/node devDependencies (a registry fetch — the only
 *      step allowed to touch the network);
 *   4. runs the consumer's smoke + test suite — infra-host additionally under
 *      node (which type-strips .ts) — with a poisoned proxy env proving no
 *      network is required at runtime;
 *   5. verifies every installed dependency's real path stays inside the
 *      temporary consumer root, that @penumbra/* resolves to the guard stub,
 *      and that installed package content is byte-identical to the tarball;
 *   6. poisons the installed entry point and re-runs the suite: every test
 *      file must fail to load, proving each one really exercises the packed
 *      artifact; the file is restored and the digest re-verified.
 *
 * measurements.json records per-run stdout logs, exit codes, dependency trees,
 * package.json dependency declarations, test/parity counts, HOME entries,
 * guard/poison results and digests so the evidence writer can quote a
 * measured record rather than prose.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = dirname(import.meta.dir);
const REPO_ROOT = join(PACKAGE_DIR, "..", "..");
const RUN_DIR = join(REPO_ROOT, "tmp", "sharedlib6");
const PACK_DIR = join(RUN_DIR, "pack");
const EXTRACT_DIR = join(PACK_DIR, "extracted");
const REPACK_DIR = join(PACK_DIR, "repack");
const REPACK_EXTRACT_DIR = join(PACK_DIR, "repack-extracted");
const HOME_DIR = join(RUN_DIR, "home");
const BUN_DIR = join(RUN_DIR, "bun");
const LOG_DIR = join(RUN_DIR, "logs");
const CONSUMERS_DIR = join(PACKAGE_DIR, "qualification", "consumers");
const TARBALL_NAME = "penumbra-exec-primitives-0.1.0.tgz";
const TARBALL_SPEC = `../pack/${TARBALL_NAME}`;
const TARBALL_SPEC_RE = /^\.\.\/pack\/penumbra-exec-primitives-0\.1\.0\.tgz$/;
const PKG_NAME = "penumbra-exec-primitives";
const REGISTRY_PACKAGES = ["typescript", "@types/node"];

const PARITY_FILES: Record<string, string[]> = {
  "penumbra-host": [
    "acp-warm-pool.test.ts",
    "cli-spawn.test.ts",
    "cli-spawn-stream.test.ts",
    "exports.test.ts",
    "guard.test.ts",
    "stdio-acp-client.test.ts",
    "stdio-acp-client-onrequest.test.ts",
    "stdio-acp-permission.test.ts",
    "stdio-acp-server.test.ts",
  ],
  "infra-host": ["infra.test.ts"],
};

const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout.trim();
const nodeVersion = spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim();

interface CmdResult {
  cmd: string[];
  exit: number;
  pass: number;
  fail: number;
  failing: string[];
  log: string;
  stdout: string;
}

const problems: string[] = [];

function cmd(argv: string[], cwd: string, env: NodeJS.ProcessEnv, name: string): CmdResult {
  const [bin, ...args] = argv;
  if (bin === undefined) throw new Error(`cmd ${name}: empty argv`);
  const r = spawnSync(bin, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000,
  });
  const stdout = r.stdout;
  const output = `${stdout}${r.stderr}`;
  const logFile = join(LOG_DIR, `${name}.log`);
  writeFileSync(logFile, output);
  if (r.error !== undefined) {
    problems.push(`${name}: spawn failed: ${String(r.error)}`);
  }
  return {
    cmd: argv.map((a) => (a.startsWith(REPO_ROOT + sep) ? relative(REPO_ROOT, a) : a)),
    exit: r.status ?? 1,
    pass: parseCount(output, /^\s*(\d+) pass$/m),
    fail: parseCount(output, /^\s*(\d+) fail$/m),
    failing: [...output.matchAll(/^\(fail\) (.+)$/gm)]
      .map((m) => (m[1] ?? "").replace(/ \[[\d.]+m?s\]$/, ""))
      .filter((t) => t !== ""),
    log: relative(RUN_DIR, logFile),
    stdout,
  };
}

function parseCount(output: string, pattern: RegExp): number {
  const m = pattern.exec(output);
  return m === null ? 0 : Number(m[1]);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface TreeListing {
  entries: string[];
  files: number;
  bytes: number;
  content_sha256: string;
}

/** Sorted <relpath>\t<sha256> content digest over every file under root. */
function treeListing(root: string): TreeListing {
  const lines: string[] = [];
  let bytes = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = relative(root, full).split(sep).join("/");
        const buf = readFileSync(full);
        lines.push(`${rel}\t${createHash("sha256").update(buf).digest("hex")}`);
        bytes += buf.byteLength;
      }
    }
  };
  walk(root);
  lines.sort();
  const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
  return {
    entries: lines.map((l) => l.split("\t")[0] ?? ""),
    files: lines.length,
    bytes,
    content_sha256: digest,
  };
}

/** Recursive relative-path listing of every entry (files and dirs). */
function listRecursive(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      out.push(relative(root, full).split(sep).join("/"));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort();
}

function consumerEnv(consumer: string, poisonNet: boolean): NodeJS.ProcessEnv {
  // HOME must stay empty for the whole run — home_entries_after is the proof.
  // Every tool-visible directory therefore lives outside HOME, under the run
  // root (home/ for identity dirs, bun/ for caches).
  const home = join(HOME_DIR, consumer);
  const xdgConfig = join(HOME_DIR, `${consumer}-xdg`);
  const xdgCache = join(BUN_DIR, `${consumer}-xdg-cache`);
  const bunInstall = join(BUN_DIR, `${consumer}-install`);
  const bunCache = join(BUN_DIR, `${consumer}-cache`);
  const tmpdir = join(BUN_DIR, `${consumer}-tmp`);
  const dirs = [home, xdgConfig, xdgCache, bunInstall, bunCache, tmpdir];
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin",
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    BUN_INSTALL: bunInstall,
    BUN_INSTALL_CACHE_DIR: bunCache,
    TMPDIR: tmpdir,
    TERM: "dumb",
  };
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
  if (poisonNet) {
    const dead = "http://127.0.0.1:9/";
    env["HTTP_PROXY"] = dead;
    env["HTTPS_PROXY"] = dead;
    env["http_proxy"] = dead;
    env["https_proxy"] = dead;
    env["ALL_PROXY"] = dead;
    env["all_proxy"] = dead;
    env["NO_PROXY"] = "";
    env["no_proxy"] = "";
    env["npm_config_registry"] = dead;
    const npmCache = join(BUN_DIR, `${consumer}-npm-cache`);
    env["npm_config_cache"] = npmCache;
    mkdirSync(npmCache, { recursive: true });
  }
  return env;
}

function copyConsumer(name: string): string {
  const src = join(CONSUMERS_DIR, name);
  const dest = join(RUN_DIR, `consumer-${name}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const copyDir = (from: string, to: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "bun.lock") continue;
      if (from === src && /^tsconfig.*\.json$/.test(entry.name)) continue;
      const s = join(from, entry.name);
      const d = join(to, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(d, { recursive: true });
        copyDir(s, d);
      } else if (entry.isFile()) {
        cpSync(s, d);
      }
    }
  };
  copyDir(src, dest);
  const testDir = join(dest, "test");
  if (existsSync(testDir)) {
    for (const file of readdirSync(testDir)) {
      if (!file.endsWith(".parity.ts")) continue;
      cpSync(join(testDir, file), join(testDir, file.replace(/\.parity\.ts$/, ".test.ts")));
      rmSync(join(testDir, file));
    }
  }
  writeFileSync(
    join(dest, "tsconfig.consumer.json"),
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
  );
  return dest;
}

function writePoisonLayer(): string[] {
  const penumbraRoot = join(REPO_ROOT, "node_modules", "@penumbra");
  const names = existsSync(penumbraRoot)
    ? readdirSync(penumbraRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name)
    : [];
  if (!names.includes("core")) names.push("core");
  const poisonRoot = join(RUN_DIR, "node_modules", "@penumbra");
  for (const name of names) {
    const dir = join(poisonRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: `@penumbra/${name}`, version: "0.0.0", type: "module", main: "./index.js" })}\n`,
    );
    writeFileSync(
      join(dir, "index.js"),
      `throw new Error("@penumbra/${name} resolved inside a packed-artifact consumer (resolution-guard)")\n`,
    );
  }
  return names;
}

interface ConsumerRecord {
  runtime: string;
  copy_root: string;
  install_specifier: string;
  manifest_dependencies: Record<string, string>;
  manifest_dev_dependencies: Record<string, string>;
  installed_dependencies: string[];
  resolved_to: string;
  digest_equal: boolean;
  installed_content_sha256: string;
  home_entries_after: string[];
  network_required: boolean;
  registry_packages: string[];
  poison_run: { exit: number; pass: number };
  guard: { exit: number };
  steps: StepRecord[];
}

interface StepRecord {
  name: string;
  exit: number;
  pass: number;
  fail: number;
  failing: string[];
  log: string;
  cmd: string[];
}

function stepRecord(result: CmdResult, label: string): StepRecord {
  return {
    name: label,
    exit: result.exit,
    pass: result.pass,
    fail: result.fail,
    failing: result.failing,
    log: result.log,
    cmd: result.cmd,
  };
}

function checkManifest(copyRoot: string): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  specifier: string;
} {
  const manifest = readJson(join(copyRoot, "package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = manifest.dependencies ?? {};
  const devDependencies = manifest.devDependencies ?? {};
  const depNames = Object.keys(dependencies);
  if (depNames.length !== 1 || depNames[0] !== PKG_NAME) {
    problems.push(
      `${copyRoot}: dependencies must be exactly {${PKG_NAME}}, got [${depNames.join(",")}]`,
    );
  }
  const specifier = dependencies[PKG_NAME] ?? "";
  if (!TARBALL_SPEC_RE.test(specifier)) {
    problems.push(`${copyRoot}: unexpected ${PKG_NAME} specifier ${specifier}`);
  }
  const devNames = Object.keys(devDependencies).sort();
  if (devNames.join(",") !== "@types/node,typescript") {
    problems.push(
      `${copyRoot}: devDependencies must be exactly @types/node+typescript, got [${devNames.join(",")}]`,
    );
  }
  return { dependencies, devDependencies, specifier };
}

function checkInstalledDepsInside(copyRoot: string): string[] {
  const copyReal = realpathSync(copyRoot);
  const nm = join(copyRoot, "node_modules");
  const installed: string[] = [];
  if (!existsSync(nm)) {
    problems.push(`${copyRoot}: node_modules missing after bun add`);
    return installed;
  }
  const checkEntry = (dir: string, name: string, display: string): void => {
    const real = realpathSync(join(dir, name));
    if (real !== copyReal && !real.startsWith(copyReal + sep)) {
      problems.push(`${display}: realpath escapes consumer root -> ${real}`);
    }
    installed.push(display);
  };
  for (const entry of readdirSync(nm, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      const scopeDir = join(nm, entry.name);
      for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
        checkEntry(scopeDir, scoped.name, `${entry.name}/${scoped.name}`);
      }
      continue;
    }
    checkEntry(nm, entry.name, entry.name);
  }
  return installed.sort();
}

function resolveInsideCopy(copyRoot: string, runEnv: NodeJS.ProcessEnv, logName: string): string {
  const probe = cmd(
    ["bun", "-e", `console.log(await import.meta.resolve("${PKG_NAME}"));`],
    copyRoot,
    runEnv,
    logName,
  );
  const url = probe.stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("file:"));
  if (url === undefined) {
    problems.push(`resolve probe produced no file: URL (exit ${String(probe.exit)})`);
    return "";
  }
  const copyReal = realpathSync(copyRoot);
  let resolvedReal: string;
  try {
    resolvedReal = realpathSync(fileURLToPath(url));
  } catch (e) {
    problems.push(`resolve probe target unreadable: ${url} (${String(e)})`);
    return "";
  }
  if (resolvedReal !== copyReal && !resolvedReal.startsWith(copyReal + sep)) {
    problems.push(`${PKG_NAME} resolved outside consumer copy -> ${resolvedReal}`);
  }
  return relative(REPO_ROOT, resolvedReal);
}

/**
 * Overwrite the installed entry point with a throwing stub and re-run the
 * suite: every test file must fail to load (pass === 0), proving each one
 * really exercises the packed artifact. Restores the file afterwards and
 * re-verifies the installed digest.
 */
function poisonRun(
  copyRoot: string,
  runEnv: NodeJS.ProcessEnv,
  name: string,
  installedDigest: string,
): { exit: number; pass: number } {
  const entry = join(copyRoot, "node_modules", PKG_NAME, "dist", "src", "index.js");
  if (!existsSync(entry)) {
    problems.push(`${name}: installed entry missing for poison run: ${entry}`);
    return { exit: 1, pass: -1 };
  }
  const original = readFileSync(entry);
  try {
    writeFileSync(entry, `throw new Error("poisoned installed entry (qualification)")\n`);
    const run = cmd(["bun", "test"], copyRoot, runEnv, `${name}-poison-run`);
    if (run.pass !== 0) {
      problems.push(`${name}: ${String(run.pass)} test(s) passed against a poisoned artifact`);
    }
    return { exit: run.exit, pass: run.pass };
  } finally {
    writeFileSync(entry, original);
    const nm = join(copyRoot, "node_modules", PKG_NAME);
    if (treeListing(nm).content_sha256 !== installedDigest) {
      problems.push(`${name}: installed content digest drifted across the poison run`);
    }
  }
}

function runConsumer(
  name: string,
  nodeSmoke: boolean,
  expectedContentDigest: string,
): ConsumerRecord {
  const copyRoot = copyConsumer(name);
  const installEnv = consumerEnv(name, false);
  const runEnv = consumerEnv(name, true);
  const steps: StepRecord[] = [];

  if (name === "penumbra-host") {
    const port = cmd(
      ["bun", join(PACKAGE_DIR, "qualification", "contract-port.ts"), copyRoot],
      PACKAGE_DIR,
      runEnv,
      `${name}-contract-port`,
    );
    steps.push(stepRecord(port, "contract-port"));
  }

  const add = cmd(["bun", "add", TARBALL_SPEC], copyRoot, installEnv, `${name}-bun-add`);
  steps.push(stepRecord(add, "bun-add"));
  const manifest = checkManifest(copyRoot);
  const installed = checkInstalledDepsInside(copyRoot);

  const typecheck = cmd(
    [join(copyRoot, "node_modules", ".bin", "tsc"), "--noEmit", "-p", "tsconfig.consumer.json"],
    copyRoot,
    runEnv,
    `${name}-typecheck`,
  );
  steps.push(stepRecord(typecheck, "typecheck"));

  const bunSmoke = cmd(["bun", "src/smoke.ts"], copyRoot, runEnv, `${name}-smoke-bun`);
  steps.push(stepRecord(bunSmoke, "smoke-bun"));

  if (nodeSmoke) {
    const nodeSmokeRun = cmd(["node", "src/smoke.ts"], copyRoot, runEnv, `${name}-smoke-node`);
    steps.push(stepRecord(nodeSmokeRun, "smoke-node"));
  }

  for (const file of PARITY_FILES[name] ?? []) {
    const parity = cmd(
      ["bun", "test", join("test", file)],
      copyRoot,
      runEnv,
      `${name}-parity-${file}`,
    );
    steps.push(stepRecord(parity, `parity:${file}`));
  }

  const suite = cmd(["bun", "test"], copyRoot, runEnv, `${name}-bun-test`);
  steps.push(stepRecord(suite, "bun-test"));

  const resolvedTo = resolveInsideCopy(copyRoot, runEnv, `${name}-resolve`);

  const guard = cmd(
    [
      "bun",
      "-e",
      `import("@penumbra/core").then(() => process.exit(1), (e) => { process.exit(/resolution-guard/.test(String(e)) ? 0 : 2); });`,
    ],
    copyRoot,
    runEnv,
    `${name}-guard`,
  );
  steps.push(stepRecord(guard, "guard"));
  if (guard.exit !== 0) {
    problems.push(`${name}: @penumbra/core did not resolve to the guard stub`);
  }

  const installedPkgDir = join(copyRoot, "node_modules", PKG_NAME);
  const installedDigest = existsSync(installedPkgDir)
    ? treeListing(installedPkgDir).content_sha256
    : "";
  const digestEqual =
    installedDigest !== "" &&
    expectedContentDigest !== "" &&
    installedDigest === expectedContentDigest;
  if (!digestEqual) {
    problems.push(`${name}: installed content digest does not match tarball`);
  }

  const poison = poisonRun(copyRoot, runEnv, name, installedDigest);

  const homeEntries = [
    ...listRecursive(join(HOME_DIR, name)).map((e) => `home/${e}`),
    ...listRecursive(join(HOME_DIR, `${name}-xdg`)).map((e) => `xdg/${e}`),
  ].sort();
  if (homeEntries.length > 0) {
    problems.push(`${name}: isolated HOME/XDG_CONFIG_HOME not empty: ${homeEntries.join(",")}`);
  }

  for (const s of steps) {
    if (s.exit !== 0 || s.fail !== 0) {
      problems.push(`${name}: step ${s.name} exit=${String(s.exit)} fail=${String(s.fail)}`);
    }
  }

  return {
    runtime: nodeSmoke ? `bun ${bunVersion} + node ${nodeVersion}` : `bun ${bunVersion}`,
    copy_root: relative(REPO_ROOT, copyRoot),
    install_specifier: manifest.specifier,
    manifest_dependencies: manifest.dependencies,
    manifest_dev_dependencies: manifest.devDependencies,
    installed_dependencies: installed,
    resolved_to: resolvedTo,
    digest_equal: digestEqual,
    installed_content_sha256: installedDigest,
    home_entries_after: homeEntries,
    network_required: true,
    registry_packages: REGISTRY_PACKAGES,
    poison_run: { exit: poison.exit, pass: poison.pass },
    guard: { exit: guard.exit },
    steps,
  };
}

for (const dir of [
  PACK_DIR,
  REPACK_DIR,
  EXTRACT_DIR,
  REPACK_EXTRACT_DIR,
  HOME_DIR,
  BUN_DIR,
  LOG_DIR,
]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

const runSteps: StepRecord[] = [];

rmSync(join(PACKAGE_DIR, "dist"), { recursive: true, force: true });
const build = cmd(
  ["bunx", "tsc", "--build", "packages/exec-primitives"],
  REPO_ROOT,
  { ...process.env },
  "package-build",
);
runSteps.push(stepRecord(build, "package-build"));
if (build.exit !== 0) {
  problems.push(`package build failed (exit ${String(build.exit)})`);
}

function packTarball(dest: string, logName: string): void {
  const packed = cmd(
    ["bun", "pm", "pack", "--destination", dest, "--ignore-scripts"],
    PACKAGE_DIR,
    { ...process.env },
    logName,
  );
  runSteps.push(stepRecord(packed, logName));
  if (packed.exit !== 0 || !existsSync(join(dest, TARBALL_NAME))) {
    problems.push(`bun pm pack failed for ${dest}`);
  }
}

packTarball(PACK_DIR, "pack-1");
packTarball(REPACK_DIR, "pack-2");

const tarballPath = join(PACK_DIR, TARBALL_NAME);
const repackPath = join(REPACK_DIR, TARBALL_NAME);
const untarJobs = [
  [tarballPath, EXTRACT_DIR],
  [repackPath, REPACK_EXTRACT_DIR],
] as const;
for (const [i, pair] of untarJobs.entries()) {
  const untar = cmd(
    ["tar", "-xzf", pair[0], "-C", pair[1]],
    RUN_DIR,
    { ...process.env },
    `untar-${String(i + 1)}`,
  );
  runSteps.push(stepRecord(untar, `untar-${String(i + 1)}`));
  if (untar.exit !== 0) problems.push(`tar extract failed for ${pair[0]}`);
}

const cmp = cmd(["cmp", "-s", tarballPath, repackPath], RUN_DIR, { ...process.env }, "pack-cmp");
runSteps.push(stepRecord(cmp, "pack-cmp"));
const byteReproducible = existsSync(tarballPath) && existsSync(repackPath) && cmp.exit === 0;
if (!byteReproducible) {
  problems.push("repacked tarball is not byte-identical to the first pack");
}

const pkgContentRoot = join(EXTRACT_DIR, "package");
const tarballListing = existsSync(pkgContentRoot)
  ? treeListing(pkgContentRoot)
  : { entries: [], files: 0, bytes: 0, content_sha256: "" };
if (!existsSync(join(pkgContentRoot, "dist", "src", "index.js"))) {
  problems.push("tarball missing dist/src/index.js");
}

// --- 6.2 manifest + content gate ---
{
  const manifestPath = join(pkgContentRoot, "package.json");
  if (!existsSync(manifestPath)) {
    problems.push("tarball missing package/package.json");
  } else {
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    for (const token of ["0.0.0", "@penumbra/", "workspace:", "file:", "link:"]) {
      if (raw.includes(token)) problems.push(`tarball package.json contains ${token}`);
    }
    if (manifest["license"] !== "MIT") {
      problems.push(`tarball license must be MIT, got ${JSON.stringify(manifest["license"])}`);
    }
  }
  const allowed = new Set(["package.json", "LICENSE", "README.md"]);
  for (const entry of tarballListing.entries) {
    if (!allowed.has(entry) && !entry.startsWith("dist/src/")) {
      problems.push(`tarball entry outside the allowed set: ${entry}`);
    }
  }
  const licensePath = join(pkgContentRoot, "LICENSE");
  if (existsSync(licensePath)) {
    const rootLicense = readFileSync(join(PACKAGE_DIR, "LICENSE"));
    if (!readFileSync(licensePath).equals(rootLicense)) {
      problems.push("tarball LICENSE is not byte-equal to the package LICENSE");
    }
  } else {
    problems.push("tarball missing LICENSE");
  }
  for (const entry of tarballListing.entries.filter((e) => e.endsWith(".d.ts"))) {
    const text = readFileSync(join(pkgContentRoot, entry), "utf8");
    if (text.includes("bun-types") || text.includes("@penumbra/")) {
      problems.push(`.d.ts leaks a workspace type: ${entry}`);
    }
  }
}

const packedBytes = existsSync(tarballPath) ? statSync(tarballPath).size : 0;

const poisoned = writePoisonLayer();

const consumers: Record<string, ConsumerRecord> = {};
for (const name of ["penumbra-host", "infra-host"]) {
  consumers[name] = runConsumer(name, name === "infra-host", tarballListing.content_sha256);
}

const measurements = {
  generated_at: new Date().toISOString(),
  note: "penumbra-exec-primitives tarball qualification (local channel stand-in only; not a release or publication)",
  toolchain: { bun: bunVersion, node: nodeVersion },
  steps: runSteps,
  tarball: {
    name: TARBALL_NAME,
    channel: "stand-in",
    sha256: existsSync(tarballPath) ? sha256File(tarballPath) : "",
    packed_bytes: packedBytes,
    unpacked_bytes: tarballListing.bytes,
    files: tarballListing.files,
    entries: tarballListing.entries,
    content_sha256: tarballListing.content_sha256,
    byte_reproducible: byteReproducible,
  },
  poison_layer: poisoned.map((n) => `@penumbra/${n}`),
  consumers,
  problems,
};

writeFileSync(join(RUN_DIR, "measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);

if (problems.length > 0) {
  process.stdout.write(`qualify: FAIL (${String(problems.length)} problems)\n`);
  for (const p of problems) process.stdout.write(`  ${p}\n`);
  process.exit(1);
}
process.stdout.write("qualify: PASS (evidence written to tmp/sharedlib6/measurements.json)\n");
process.exit(0);
