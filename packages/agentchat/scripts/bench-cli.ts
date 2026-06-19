/**
 * bench-cli.ts
 *
 * Bench a CLI-spawn agent (agy, opencode, claude, ...) against the BENCH_TASKS.
 * The HTTP bench (bench.ts / bench-fleet.ts) only covers openai-compat-http
 * agents; this runner exercises a cli-spawn binary the same way the worker does
 * (single --print invocation per task) and emits the same JSONL shape that
 * bench-grade.ts consumes.
 *
 * usage:
 *   bun bench-cli.ts --command <bin> --model "<model>" [--label L]
 *                    [--pre-args a,b,c] [--extra-args a,b,c] [--timeout-ms N] [--limit K]
 *
 * --pre-args are inserted BEFORE --model (for CLIs that take a leading
 * subcommand, e.g. opencode's `run`); --extra-args go AFTER --model.
 *
 * examples:
 *   # agy / claude shape: bin --model X --print <prompt>
 *   bun bench-cli.ts --command /Users/acordeiro/.local/bin/agy \
 *     --model "Gemini 3.1 Pro (High)" --label google-gemini-cli > results.jsonl
 *   # opencode shape: opencode run --model X <prompt>
 *   bun bench-cli.ts --command /Users/acordeiro/.opencode/bin/opencode \
 *     --model "opencode-go/glm-5.2" --pre-args run --extra-args "" \
 *     --label opencode-glm-52 > results.jsonl
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { BENCH_TASKS, BENCH_SYSTEM_PROMPT } from "./bench-prompts.js";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const command = arg("command");
const model = arg("model");
const label = arg("label") ?? model ?? "cli";
const extraArgs = (arg("extra-args") ?? "--dangerously-skip-permissions,--print")
  .split(",")
  .filter(Boolean);
// Args inserted BEFORE --model, e.g. a leading subcommand like opencode's `run`.
const preArgs = (arg("pre-args") ?? "").split(",").filter(Boolean);
const timeoutMs = Number(arg("timeout-ms") ?? "180000");
const limit = arg("limit") ? Number(arg("limit")) : BENCH_TASKS.length;

if (!command || !model) {
  console.error(
    "usage: bun bench-cli.ts --command <bin> --model <model> [--label L] [--pre-args a,b] [--extra-args a,b] [--timeout-ms N] [--limit K]",
  );
  process.exit(1);
}

function runOnce(prompt: string): Promise<{ out: string; err?: string }> {
  return new Promise((res) => {
    const child = spawn(command!, [...preArgs, "--model", model!, ...extraArgs, prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      res({ out: out.trim(), err: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(t);
      res({ out: out.trim(), err: code === 0 ? undefined : err.trim() || `exit ${code}` });
    });
    child.on("error", (e) => {
      clearTimeout(t);
      res({ out: "", err: String(e) });
    });
  });
}

for (const task of BENCH_TASKS.slice(0, limit)) {
  const fixturePath = resolve(scriptsDir, task.fixturePath);
  const fixtureBody = existsSync(fixturePath) ? readFileSync(fixturePath, "utf8") : "";
  const userContent = `--- File: ${task.fixtureLabel} ---\n${fixtureBody}\n\n---\n\n${task.question}`;
  const prompt = `${BENCH_SYSTEM_PROMPT}\n\n${userContent}`;
  const start = Date.now();
  const { out, err } = await runOnce(prompt);
  console.log(
    JSON.stringify({
      label,
      model,
      task: task.id,
      description: task.description,
      answer: out,
      groundTruth: task.groundTruth,
      latencyMs: Date.now() - start,
      ...(err ? { error: err } : {}),
    }),
  );
}
