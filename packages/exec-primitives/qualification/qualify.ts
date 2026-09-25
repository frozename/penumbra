import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

// C5 consumer qualification: packs the candidate into a local tarball (a channel
// stand-in only — not a release or registry artifact), installs it into two
// throwaway hosts, and runs each host's tests against the packed bits.
//
//   penumbra-host  — bun consumer; runs the ported contract suite plus the
//                    adapter-parity tests re-pointed at the old shim surface.
//   infra-host     — node consumer (`node --test`, .mjs only); proves the dist
//                    has no Bun coupling and the wire protocol works end-to-end.

const PACKAGE_DIR = dirname(import.meta.dir);
const QUALIFY_DIR = join(PACKAGE_DIR, "qualification");
const CONSUMERS = join(QUALIFY_DIR, "consumers");
const PEN_HOST = join(CONSUMERS, "penumbra-host");
const INFRA_HOST = join(CONSUMERS, "infra-host");
const EVIDENCE_DIR = join(QUALIFY_DIR, "evidence");
const WORK = mkdtempSync(join(tmpdir(), "exec-primitives-qualify-"));

interface CmdResult {
  exit: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string[], cwd: string): CmdResult {
  const result = spawnSync(cmd[0] ?? "", cmd.slice(1), {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
    timeout: 300_000,
  });
  return {
    exit: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function fail(msg: string): never {
  process.stderr.write(`qualify: FAIL — ${msg}\n`);
  rmSync(WORK, { recursive: true, force: true });
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
  const before = run(["bun", "pm", "pack", "--destination", destDir], PACKAGE_DIR);
  if (before.exit !== 0) {
    // Older bun lacks --destination; pack into cwd and move.
    const packed = run(["bun", "pm", "pack"], PACKAGE_DIR);
    if (packed.exit !== 0) fail(`bun pm pack failed: ${packed.stderr}`);
    const tgz = readdirSync(PACKAGE_DIR).find((f) => f.endsWith(".tgz"));
    if (tgz === undefined) fail("bun pm pack produced no tarball");
    cpSync(join(PACKAGE_DIR, tgz), join(destDir, tgz));
    rmSync(join(PACKAGE_DIR, tgz));
    return join(destDir, tgz);
  }
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

process.stdout.write("== build ==\n");
const build = run(["bun", "run", "build"], PACKAGE_DIR);
if (build.exit !== 0) fail(`build failed:\n${build.stdout}\n${build.stderr}`);

process.stdout.write("== pack (twice, reproducibility check) ==\n");
const packA = pack(join(WORK, "a"));
const packB = pack(join(WORK, "b"));
const extractedA = extract(packA, join(WORK, "a", "out"));
const extractedB = extract(packB, join(WORK, "b", "out"));
const digestA = contentDigest(extractedA);
const digestB = contentDigest(extractedB);
const tgzSha = sha256File(packA);
process.stdout.write(
  `tarball: ${join("a", "out")} files=${String(digestA.files)} bytes=${String(digestA.bytes)}\n` +
    `sha256(tgz)=${tgzSha} content_sha256=${digestA.digest} repack_identical=${String(digestA.digest === digestB.digest)}\n`,
);

process.stdout.write("== install: penumbra-host ==\n");
const penVendor = join(PEN_HOST, "vendor", "penumbra-exec-primitives");
rmSync(join(PEN_HOST, "vendor"), { recursive: true, force: true });
mkdirSync(join(PEN_HOST, "vendor"), { recursive: true });
cpSync(extractedA, penVendor, { recursive: true });
const install = run(["bun", "install"], PEN_HOST);
if (install.exit !== 0) fail(`penumbra-host install failed:\n${install.stderr}`);

process.stdout.write("== port contract suite ==\n");
const port = run(["bun", join(QUALIFY_DIR, "contract-port.ts")], PACKAGE_DIR);
if (port.exit !== 0) fail(`contract-port failed:\n${port.stderr}`);
process.stdout.write(port.stdout);

process.stdout.write("== test: penumbra-host (bun test) ==\n");
const penTest = run(["bun", "test"], PEN_HOST);
process.stdout.write(penTest.stdout);
process.stderr.write(penTest.stderr);

process.stdout.write("== install: infra-host ==\n");
const infraVendor = join(INFRA_HOST, "node_modules", "penumbra-exec-primitives");
rmSync(join(INFRA_HOST, "node_modules"), { recursive: true, force: true });
mkdirSync(join(INFRA_HOST, "node_modules"), { recursive: true });
symlinkSync(penVendor, infraVendor, "dir");

process.stdout.write("== test: infra-host (node --test) ==\n");
const nodeVersion = run(["node", "--version"], INFRA_HOST).stdout.trim();
const infraTest = run(["node", "--test", "smoke.test.mjs"], INFRA_HOST);
process.stdout.write(infraTest.stdout);
process.stderr.write(infraTest.stderr);

const penCombined = `${penTest.stdout}\n${penTest.stderr}`;
const infraCombined = `${infraTest.stdout}\n${infraTest.stderr}`;
const penPass = /(\d+) pass/.exec(penCombined)?.[1];
const penFail = /(\d+) fail/.exec(penCombined)?.[1];
const infraPass = /pass\s+(\d+)/.exec(infraCombined)?.[1];
const infraFail = /fail\s+(\d+)/.exec(infraCombined)?.[1];

const evidence = {
  generated_at: new Date().toISOString(),
  note: "local tarball is a channel stand-in for qualification only — not a release or distribution channel",
  tarball: {
    package: `${JSON.parse(readFileSync(join(penVendor, "package.json"), "utf8"))["name"] as string}@${JSON.parse(readFileSync(join(penVendor, "package.json"), "utf8"))["version"] as string}`,
    name: "penumbra-exec-primitives-0.1.0.tgz",
    sha256: tgzSha,
    content_sha256: digestA.digest,
    files: digestA.files,
    unpacked_bytes: digestA.bytes,
    repack_identical: digestA.digest === digestB.digest,
  },
  consumers: {
    "penumbra-host": {
      runtime: `bun ${run(["bun", "--version"], PEN_HOST).stdout.trim()}`,
      install: "file: vendor/ (unpacked tarball)",
      exit: penTest.exit,
      pass: penPass === undefined ? null : Number(penPass),
      fail: penFail === undefined ? null : Number(penFail),
      suites: [
        "test/contract/* (ported contract suite)",
        "test/parity/* (adapter parity)",
        "test/exports.test.ts",
      ],
    },
    "infra-host": {
      runtime: `node ${nodeVersion}`,
      install: "node_modules symlink -> vendored unpacked tarball",
      exit: infraTest.exit,
      pass: infraPass === undefined ? null : Number(infraPass),
      fail: infraFail === undefined ? null : Number(infraFail),
      suites: ["smoke.test.mjs (node --test)"],
    },
  },
};

mkdirSync(EVIDENCE_DIR, { recursive: true });
writeFileSync(join(EVIDENCE_DIR, "consumers.json"), `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(join(EVIDENCE_DIR, "penumbra-host-test.log"), penCombined);
writeFileSync(join(EVIDENCE_DIR, "infra-host-test.log"), infraCombined);
rmSync(WORK, { recursive: true, force: true });

const ok = penTest.exit === 0 && infraTest.exit === 0 && digestA.digest === digestB.digest;
process.stdout.write(
  `qualify: ${ok ? "PASS" : "FAIL"} penumbra-host exit=${String(penTest.exit)} pass=${penPass ?? "?"} fail=${penFail ?? "?"} | infra-host exit=${String(infraTest.exit)} pass=${infraPass ?? "?"} fail=${infraFail ?? "?"} | repack_identical=${String(digestA.digest === digestB.digest)}\n`,
);
process.exit(ok ? 0 : 1);
