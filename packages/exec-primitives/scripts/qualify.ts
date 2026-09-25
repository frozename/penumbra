/**
 * qualify.ts — consumer qualification for the exec-primitives candidate.
 *
 * Packs the package into a local tarball (a channel stand-in only — not a
 * release or registry artifact), vendors the unpacked tree into two throwaway
 * consumers, installs with an isolated HOME, and runs each consumer's suites
 * against the packed bits:
 *
 *   penumbra-host  — bun consumer; ported contract suite (generated into
 *                    test/contract/), the *.parity.ts adapter-parity suites,
 *                    and src/smoke.ts.
 *   infra-host     — plain-JS consumer; test/infra.parity.mjs plus
 *                    src/smoke.mjs under BOTH bun and node.
 *
 * The poison check asserts `penumbra-exec-primitives` resolves inside each
 * consumer's own node_modules — never the workspace-root link — so a missing
 * or broken vendor install cannot be masked by repo-level resolution.
 *
 * Outputs go under <repo>/tmp/sharedlib6-run/: tarball extract, per-suite
 * logs, and consumers.json evidence. Consumer vendor/, node_modules/,
 * bun.lock and test/contract/ are transient and removed at the start of each
 * run (left in place at the end so a rerun is incremental and inspectable —
 * they are gitignored).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SCRIPTS_DIR = import.meta.dir;
const PACKAGE_DIR = dirname(SCRIPTS_DIR);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const QUALIFY_DIR = join(PACKAGE_DIR, "qualification");
const CONSUMERS = join(QUALIFY_DIR, "consumers");
const PEN_HOST = join(CONSUMERS, "penumbra-host");
const INFRA_HOST = join(CONSUMERS, "infra-host");
const RUN_DIR = join(REPO_ROOT, "tmp", "sharedlib6-run");
const HOME_DIR = join(RUN_DIR, "home");
const BUN_CACHE = join(RUN_DIR, "bun-cache");

interface CmdResult {
  exit: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string[], cwd: string): CmdResult {
  const result = spawnSync(cmd[0] ?? "", cmd.slice(1), {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: HOME_DIR,
      BUN_INSTALL_CACHE_DIR: BUN_CACHE,
    },
    timeout: 300_000,
  });
  return {
    exit: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const lines: string[] = [];
function emit(line: string): void {
  lines.push(line);
  process.stdout.write(`${line}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`qualify: FAIL — ${msg}\n`);
  writeFileSync(join(RUN_DIR, "qualify.exit"), "1\n");
  process.exit(1);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function contentDigest(root: string): { digest: string; files: number; bytes: number } {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(root, full);
      const data = readFileSync(full);
      hash.update(rel);
      hash.update("\0");
      hash.update(data);
      hash.update("\0");
      files += 1;
      bytes += statSync(full).size;
    }
  };
  walk(root);
  return { digest: hash.digest("hex"), files, bytes };
}

function pack(destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const packed = run(["bun", "pm", "pack", "--destination", destDir], PACKAGE_DIR);
  if (packed.exit !== 0) fail(`bun pm pack failed: ${packed.stderr}`);
  const tgz = readdirSync(destDir).find((f) => f.endsWith(".tgz"));
  if (tgz === undefined) fail("bun pm pack produced no tarball");
  return join(destDir, tgz);
}

function extract(tgz: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const result = run(["tar", "-xzf", tgz, "-C", destDir], destDir);
  if (result.exit !== 0) fail(`tar extract failed: ${result.stderr}`);
  const pkg = join(destDir, "package");
  if (!existsSync(pkg)) fail("tarball missing package/ root");
  return pkg;
}

function cleanConsumer(dir: string): void {
  for (const name of ["vendor", "node_modules", "bun.lock", "test/contract"]) {
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

function vendorInto(dir: string, extracted: string): void {
  mkdirSync(join(dir, "vendor"), { recursive: true });
  cpSync(extracted, join(dir, "vendor", "penumbra-exec-primitives"), { recursive: true });
}

function resolveCheck(consumerDir: string): string {
  const r = run(
    ["bun", "-e", 'process.stdout.write(import.meta.resolve("penumbra-exec-primitives"))'],
    consumerDir,
  );
  if (r.exit !== 0) {
    fail(`resolve check failed in ${consumerDir}: ${r.stderr.trim()}`);
  }
  const resolved = r.stdout.trim().replace(/^file:\/\//, "");
  const local = resolve(consumerDir);
  const insideConsumer =
    resolved.startsWith(`${local}${sep}`) ||
    resolved.includes(`${sep}vendor${sep}penumbra-exec-primitives${sep}`);
  if (!insideConsumer) {
    fail(
      `poison: penumbra-exec-primitives resolves outside the consumer (${resolved}) — ` +
        `workspace-root resolution would mask a missing vendor install`,
    );
  }
  return resolved;
}

function parseBunCounts(output: string): { pass: number | null; fail: number | null } {
  const pass = /(\d+) pass/.exec(output)?.[1];
  const failCount = /(\d+) fail/.exec(output)?.[1];
  return {
    pass: pass === undefined ? null : Number(pass),
    fail: failCount === undefined ? null : Number(failCount),
  };
}

mkdirSync(RUN_DIR, { recursive: true });
mkdirSync(HOME_DIR, { recursive: true });

emit("== build ==");
const build = run(["bun", "run", "build"], PACKAGE_DIR);
if (build.exit !== 0) fail(`build failed:\n${build.stdout}\n${build.stderr}`);

emit("== pack (twice, reproducibility check) ==");
const packA = pack(join(RUN_DIR, "pack-a"));
const packB = pack(join(RUN_DIR, "pack-b"));
const extractedA = extract(packA, join(RUN_DIR, "extract-a"));
const extractedB = extract(packB, join(RUN_DIR, "extract-b"));
const digestA = contentDigest(extractedA);
const digestB = contentDigest(extractedB);
const tgzSha = sha256File(packA);
emit(
  `tarball: files=${String(digestA.files)} bytes=${String(digestA.bytes)}\n` +
    `sha256(tgz)=${tgzSha} content_sha256=${digestA.digest} repack_identical=${String(
      digestA.digest === digestB.digest,
    )}`,
);
if (digestA.digest !== digestB.digest) fail("repack produced a different content digest");

for (const host of [PEN_HOST, INFRA_HOST]) {
  cleanConsumer(host);
  vendorInto(host, extractedA);
}

emit("== install: penumbra-host ==");
const penInstall = run(["bun", "install"], PEN_HOST);
if (penInstall.exit !== 0) fail(`penumbra-host install failed:\n${penInstall.stderr}`);

emit("== install: infra-host ==");
const infraInstall = run(["bun", "install"], INFRA_HOST);
if (infraInstall.exit !== 0) fail(`infra-host install failed:\n${infraInstall.stderr}`);

emit("== poison: resolution must be consumer-local ==");
const penResolved = resolveCheck(PEN_HOST);
emit(`penumbra-host resolves ${relative(REPO_ROOT, penResolved)}`);
const infraResolved = resolveCheck(INFRA_HOST);
emit(`infra-host resolves ${relative(REPO_ROOT, infraResolved)}`);

emit("== port contract suite ==");
const port = run(["bun", join(QUALIFY_DIR, "contract-port.ts")], PACKAGE_DIR);
if (port.exit !== 0) fail(`contract-port failed:\n${port.stderr}`);
emit(port.stdout.trim());

emit("== smoke: penumbra-host (bun src/smoke.ts) ==");
const penSmoke = run(["bun", "src/smoke.ts"], PEN_HOST);
emit(penSmoke.stdout.trim());
if (penSmoke.exit !== 0) {
  writeFileSync(join(RUN_DIR, "penumbra-host-smoke.log"), `${penSmoke.stdout}\n${penSmoke.stderr}`);
  fail(`penumbra-host smoke exited ${String(penSmoke.exit)}:\n${penSmoke.stderr}`);
}

emit("== test: penumbra-host contract suite (bun test) ==");
const penContract = run(["bun", "test"], PEN_HOST);
writeFileSync(
  join(RUN_DIR, "penumbra-host-contract.log"),
  `${penContract.stdout}\n${penContract.stderr}`,
);
if (penContract.exit !== 0) {
  fail(
    `penumbra-host contract suite exited ${String(penContract.exit)} — see tmp/sharedlib6-run/penumbra-host-contract.log`,
  );
}

emit("== test: penumbra-host parity suites ==");
const parityFiles = readdirSync(join(PEN_HOST, "test"))
  .filter((f) => f.endsWith(".parity.ts"))
  .sort()
  .map((f) => `./test/${f}`);
const penParity = run(["bun", "test", ...parityFiles], PEN_HOST);
writeFileSync(
  join(RUN_DIR, "penumbra-host-parity.log"),
  `${penParity.stdout}\n${penParity.stderr}`,
);
if (penParity.exit !== 0) {
  fail(
    `penumbra-host parity suites exited ${String(penParity.exit)} — see tmp/sharedlib6-run/penumbra-host-parity.log`,
  );
}

emit("== smoke: infra-host under node (src/smoke.mjs) ==");
const infraNodeSmoke = run(["node", "src/smoke.mjs"], INFRA_HOST);
emit(infraNodeSmoke.stdout.trim());
if (infraNodeSmoke.exit !== 0) {
  writeFileSync(
    join(RUN_DIR, "infra-host-smoke-node.log"),
    `${infraNodeSmoke.stdout}\n${infraNodeSmoke.stderr}`,
  );
  fail(`infra-host node smoke exited ${String(infraNodeSmoke.exit)}:\n${infraNodeSmoke.stderr}`);
}

emit("== smoke: infra-host under bun (src/smoke.mjs) ==");
const infraBunSmoke = run(["bun", "src/smoke.mjs"], INFRA_HOST);
emit(infraBunSmoke.stdout.trim());
if (infraBunSmoke.exit !== 0) {
  writeFileSync(
    join(RUN_DIR, "infra-host-smoke-bun.log"),
    `${infraBunSmoke.stdout}\n${infraBunSmoke.stderr}`,
  );
  fail(`infra-host bun smoke exited ${String(infraBunSmoke.exit)}:\n${infraBunSmoke.stderr}`);
}

emit("== test: infra-host parity suite (bun test) ==");
const infraTest = run(["bun", "test", "./test/infra.parity.mjs"], INFRA_HOST);
writeFileSync(join(RUN_DIR, "infra-host-test.log"), `${infraTest.stdout}\n${infraTest.stderr}`);
if (infraTest.exit !== 0) {
  fail(
    `infra-host suite exited ${String(infraTest.exit)} — see tmp/sharedlib6-run/infra-host-test.log`,
  );
}

const penContractCombined = `${penContract.stdout}\n${penContract.stderr}`;
const penParityCombined = `${penParity.stdout}\n${penParity.stderr}`;
const infraCombined = `${infraTest.stdout}\n${infraTest.stderr}`;
const penContractCounts = parseBunCounts(penContractCombined);
const penParityCounts = parseBunCounts(penParityCombined);
const infraCounts = parseBunCounts(infraCombined);

const packedManifest = JSON.parse(readFileSync(join(extractedA, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const evidence = {
  generated_at: new Date().toISOString(),
  note: "local tarball is a channel stand-in for qualification only — not a release or distribution channel",
  toolchain: {
    bun: run(["bun", "--version"], PACKAGE_DIR).stdout.trim(),
    node: run(["node", "--version"], PACKAGE_DIR).stdout.trim(),
  },
  tarball: {
    package: `${packedManifest.name}@${packedManifest.version}`,
    name: `${packedManifest.name}-${packedManifest.version}.tgz`,
    sha256: tgzSha,
    content_sha256: digestA.digest,
    files: digestA.files,
    unpacked_bytes: digestA.bytes,
    repack_identical: digestA.digest === digestB.digest,
  },
  consumers: {
    "penumbra-host": {
      runtime: `bun ${run(["bun", "--version"], PEN_HOST).stdout.trim()}`,
      install: "file: dep on unpacked tarball (vendor/penumbra-exec-primitives)",
      resolved_to: relative(REPO_ROOT, penResolved),
      smoke_exit: penSmoke.exit,
      contract: { exit: penContract.exit, ...penContractCounts },
      parity: {
        exit: penParity.exit,
        ...penParityCounts,
        files: parityFiles,
      },
    },
    "infra-host": {
      runtime_bun: `bun ${run(["bun", "--version"], INFRA_HOST).stdout.trim()}`,
      runtime_node: run(["node", "--version"], INFRA_HOST).stdout.trim(),
      install: "file: dep on unpacked tarball (vendor/penumbra-exec-primitives)",
      resolved_to: relative(REPO_ROOT, infraResolved),
      smoke_node_exit: infraNodeSmoke.exit,
      smoke_bun_exit: infraBunSmoke.exit,
      parity: { exit: infraTest.exit, ...infraCounts },
    },
  },
};

writeFileSync(join(RUN_DIR, "consumers.json"), `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(join(RUN_DIR, "qualify.exit"), "0\n");

const ok =
  penContract.exit === 0 &&
  penParity.exit === 0 &&
  infraTest.exit === 0 &&
  penSmoke.exit === 0 &&
  infraNodeSmoke.exit === 0 &&
  infraBunSmoke.exit === 0;
emit(
  `qualify: ${ok ? "PASS" : "FAIL"} penumbra-host contract=${String(
    penContractCounts.pass ?? "?",
  )}p/${String(penContractCounts.fail ?? "?")}f parity=${String(
    penParityCounts.pass ?? "?",
  )}p/${String(penParityCounts.fail ?? "?")}f | infra-host=${String(
    infraCounts.pass ?? "?",
  )}p/${String(infraCounts.fail ?? "?")}f | repack_identical=${String(
    digestA.digest === digestB.digest,
  )}`,
);
process.exit(ok ? 0 : 1);
