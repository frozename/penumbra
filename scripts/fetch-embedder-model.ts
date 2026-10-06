#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const MODEL_NAME = "fast-all-MiniLM-L6-v2";
export const MODEL_REPO = "frozename/penumbra";
export const MODEL_TAG = "embedder-model-minilm-l6-v2-v1";
export const MODEL_ASSET = `${MODEL_NAME}.tar.gz`;
export const ARCHIVE_SHA256 = "d74a0baa6a0f5ac9bb2892cfa9aa49520d97a16dd64cdae2fce4df4868b80db1";
export const MODEL_MANIFEST: Readonly<Record<string, string>> = {
  "config.json": "1b4d8e2a3988377ed8b519a31d8d31025a25f1c5f8606998e8014111438efcd7",
  "model.onnx": "bbd7b466f6d58e646fdc2bd5fd67b2f5e93c0b687011bd4548c420f7bd46f0c5",
  "special_tokens_map.json": "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a",
  "tokenizer.json": "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  "tokenizer_config.json": "bd2e06a5b20fd1b13ca988bedc8763d332d242381b4fbc98f8fead4524158f79",
  "vocab.txt": "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
};

type FetchResult = { exitCode: 0 | 1; message: string };
type FetchOptions = {
  dest: string;
  manifest?: Readonly<Record<string, string>>;
  archiveSha256?: string;
  download?: (directory: string) => Promise<void>;
  extract?: (archive: string, destination: string) => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

export async function verifyModel(
  directory: string,
  manifest: Readonly<Record<string, string>>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const [name, expected] of Object.entries(manifest)) {
    try {
      if ((await sha256(join(directory, name))) !== expected) {
        failures.push(`${name}: sha256 mismatch`);
      }
    } catch (error) {
      failures.push(`${name}: missing or unreadable (${errorMessage(error)})`);
    }
  }
  return failures;
}

async function runCommand(args: string[]): Promise<void> {
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0)
    throw new Error(`${args[0] ?? "command"} exited ${String(code)}: ${stderr.trim()}`);
}

export async function downloadModel(directory: string): Promise<void> {
  await runCommand([
    "gh",
    "release",
    "download",
    MODEL_TAG,
    "--repo",
    MODEL_REPO,
    "--pattern",
    MODEL_ASSET,
    "--dir",
    directory,
  ]);
}

async function extractModel(archive: string, destination: string): Promise<void> {
  await runCommand(["tar", "--no-same-owner", "-xzf", archive, "-C", destination]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function fetchModel(options: FetchOptions): Promise<FetchResult> {
  const { dest, manifest = MODEL_MANIFEST, archiveSha256 = ARCHIVE_SHA256 } = options;
  const directory = join(dest, MODEL_NAME);
  if (await exists(directory)) {
    const failures = await verifyModel(directory, manifest);
    return failures.length > 0
      ? {
          exitCode: 1,
          message: `Existing model verification failed: ${failures.join("; ")}; remove it and re-run: rm -rf ${directory}`,
        }
      : { exitCode: 0, message: `${MODEL_NAME}: already present and verified` };
  }

  const temporary = await mkdtemp(join(tmpdir(), "penumbra-embedder-model-"));
  try {
    try {
      await (options.download ?? downloadModel)(temporary);
    } catch (error) {
      return {
        exitCode: 1,
        message: `${errorMessage(error)}\nRelease download requires GH_TOKEN or gh auth login.`,
      };
    }
    const archive = join(temporary, MODEL_ASSET);
    if ((await sha256(archive)) !== archiveSha256) {
      return { exitCode: 1, message: `${MODEL_ASSET}: archive sha256 mismatch; nothing extracted` };
    }
    await mkdir(dest, { recursive: true });
    // Reserve the model directory exclusively so a concurrent fetch cannot overwrite it.
    await mkdir(directory);
    await (options.extract ?? extractModel)(archive, dest);
    const failures = await verifyModel(directory, manifest);
    return failures.length > 0
      ? {
          exitCode: 1,
          message: `Extracted model verification failed: ${failures.join("; ")}; remove it and re-run: rm -rf ${directory}`,
        }
      : { exitCode: 0, message: `${MODEL_NAME}: downloaded and verified` };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function fetchEmbedderModel(options: FetchOptions): Promise<FetchResult> {
  try {
    return await fetchModel(options);
  } catch (error) {
    return { exitCode: 1, message: errorMessage(error) };
  }
}

export function parseArgs(args: string[]): string {
  if (args.length === 0) return resolve(import.meta.dir, "..", "local_cache");
  if (args.length === 2 && args[0] === "--dest" && args[1] && !args[1].startsWith("--")) {
    return resolve(args[1]);
  }
  throw new Error("Usage: bun scripts/fetch-embedder-model.ts [--dest <cacheDir>]");
}

if (import.meta.main) {
  try {
    const result = await fetchEmbedderModel({ dest: parseArgs(process.argv.slice(2)) });
    if (result.exitCode === 0) process.stdout.write(`${result.message}\n`);
    else console.error(result.message);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
