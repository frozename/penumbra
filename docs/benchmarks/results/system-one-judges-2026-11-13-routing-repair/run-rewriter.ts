import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const privateRoot = "/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-routing-repair";
const baseline = join(privateRoot, "baseline-source");
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
if (!args.includes("--live") || !args.includes("--out") || !out || existsSync(out))
  throw new Error("Explicit live flag and fresh output directory required");
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const freeze = JSON.parse(readFileSync(new URL("./candidate-freeze-v4.json", import.meta.url), "utf8"));
if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() !== freeze.candidateSourceCommit)
  throw new Error("Candidate source commit changed");
if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: baseline, encoding: "utf8" }).trim() !== freeze.baselineSourceCommit)
  throw new Error("Baseline source commit changed");
for (const [path, digest] of Object.entries(freeze.codeSha256))
  if (sha(readFileSync(join(root, path))) !== digest) throw new Error("Frozen candidate changed: " + path);
for (const [path, digest] of Object.entries(freeze.baselineCodeSha256))
  if (sha(readFileSync(join(baseline, path))) !== digest) throw new Error("Frozen baseline changed: " + path);
const manifest = JSON.parse(readFileSync(new URL("./test-manifest.json", import.meta.url), "utf8"));
const text = readFileSync(join(privateRoot, "fixtures.jsonl"), "utf8");
if (sha(text) !== manifest.fixtureSha256 || sha(readFileSync(join(privateRoot, "labels-adjudicated.jsonl"))) !== manifest.labelSha256)
  throw new Error("Independent frozen fixture/label mismatch");
mkdirSync(out, { mode: 0o700 });
for (const [id, modulePath] of [
  ["r1", join(baseline, "scripts/rewriter-bench.ts")],
  ["r2", join(root, "scripts/rewriter-bench.ts")],
] as const) {
  const bench = await import(modulePath);
  const cases = bench.parseBenchCases(text);
  if (cases.length !== 96) throw new Error("Incomplete fixture set");
  mkdirSync(join(out, id), { mode: 0o700 });
  const model = { id, model: "granite-q8-rewriter-eval", baseUrl: "http://127.0.0.1:18945/v1", maxTokens: 512, timeoutMs: 5000 };
  await bench.runBenchmark(bench.parseBenchConfig({ models: [model], repetitions: 2, concurrency: 1 }), cases, join(out, id, "serial"), sha(text));
  console.log(JSON.stringify({ phase: id + "-resident-idle-start", milliseconds: 10000 }));
  await Bun.sleep(10000);
  const burst = cases.toSorted((a: { inputSha256: string }, b: { inputSha256: string }) => a.inputSha256.localeCompare(b.inputSha256)).slice(0, 16);
  await bench.runBenchmark(bench.parseBenchConfig({ models: [model], repetitions: 1, concurrency: 2 }), burst, join(out, id, "burst"), sha(burst.map((c: unknown) => JSON.stringify(c)).join("\n") + "\n"));
}
