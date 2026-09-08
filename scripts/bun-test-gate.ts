#!/usr/bin/env bun
/**
 * CI test gate that tolerates a known, version-independent Bun NAPI-teardown
 * panic without masking real failures.
 *
 * `bun test` exits 133 ("panic(main thread): A C++ exception occurred / Bun has
 * crashed") at PROCESS TEARDOWN — AFTER printing a clean summary — via
 * oven-sh/bun PR #32569: libc exit() from Bun's Global.exit runs
 * onnxruntime-node's global destructor, which throws into Bun's std::terminate
 * handler. This is not bun #30431, which was fixed by #30291 and covered a
 * different source of the same message; there is no Bun version floor.
 *
 * This wrapper runs `bun test`, streams its output, and gates on the REPORTED
 * failure/error counts instead of the raw exit code. It exits 0 only when the run
 * reached its summary with 0 failures AND 0 errors AND the non-zero exit is the
 * known teardown panic. A real test failure (fail > 0), a load error (error > 0),
 * or any crash BEFORE the summary (no "Ran N tests" line) still fails the gate.
 *
 * Keep the child process asynchronous and stream both output pipes. Node's
 * spawnSync default pipe buffer is 1 MiB per stream; large Bun shards can exceed
 * that before reaching the final summary, causing the gate itself to terminate
 * the child with ENOBUFS and then parse truncated output. Relay raw pipe chunks
 * unchanged, and decode only the accumulated parser text.
 */
import type { Readable, Writable } from "node:stream";

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import {
  isKnownBunTeardownPanicPass,
  parseBunTestReport,
} from "../packages/agentchat/src/worker/bun-test-output.js";

// Always exclude stale compiled test shadows in dist/ — the package tsconfigs are
// noEmit, so any packages/*/dist/test/*.test.js are leftover artifacts that bun
// would otherwise glob (failing on relative imports and inflating the count).
// bun accepts multiple --path-ignore-patterns flags, so caller-supplied patterns still apply.
const child = spawn(
  "bun",
  ["test", "--path-ignore-patterns=**/dist/**", ...process.argv.slice(2)],
  {
    stdio: ["inherit", "pipe", "pipe"],
  },
);

function writeChunk(stream: Writable, chunk: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function collectAndForward(stream: Readable, target: Writable): Promise<string> {
  const decoder = new StringDecoder("utf8");
  let output = "";

  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      output += chunk;
      await writeChunk(target, chunk);
    } else {
      const buffer = Buffer.from(chunk);
      output += decoder.write(buffer);
      await writeChunk(target, buffer);
    }
  }

  output += decoder.end();
  return output;
}

async function waitForChild(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

const [stdout, stderr, result] = await Promise.all([
  collectAndForward(child.stdout, process.stdout),
  collectAndForward(child.stderr, process.stderr),
  waitForChild(),
]);

const code = result.code ?? 1;
const report = parseBunTestReport(stdout + stderr);
const signalText = result.signal ? ` signal=${result.signal}` : "";
const failureLine = `bun-test-gate: failing (exit ${String(code)}${signalText}; fails=${String(report.fails)} errors=${String(report.errors)} reachedSummary=${String(report.reachedSummary)} knownPanic=${String(report.knownPanic)}).`;

if (result.code === 0) {
  if (report.reachedSummary) {
    process.exitCode = 0;
  } else {
    console.error(failureLine);
    process.exitCode = 1;
  }
} else if (isKnownBunTeardownPanicPass(report)) {
  console.error(
    `::warning:: bun test exited ${String(code)} via the known NAPI-teardown panic, but reported 0 failures / 0 errors across all suites — treating as pass. See scripts/bun-test-gate.ts.`,
  );
  process.exitCode = 0;
} else {
  console.error(failureLine);
  process.exitCode = code;
}
