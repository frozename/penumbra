import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modelName = "fast-all-MiniLM-L6-v2";
const assetName = `${modelName}.tar.gz`;
const contents = { "config.json": "tiny config", "model.onnx": "tiny model" };
const hash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const manifest = Object.fromEntries(
  Object.entries(contents).map(([name, value]) => [name, hash(value)]),
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function implementation(): Promise<typeof import("./fetch-embedder-model.js")> {
  expect(
    await Bun.file(join(import.meta.dir, "fetch-embedder-model.ts")).exists(),
    "The verified release-asset fetcher must be implemented",
  ).toBe(true);
  return await import("./fetch-embedder-model.js");
}

async function fixture(): Promise<{ root: string; dest: string; model: string }> {
  const root = await mkdtemp(join(tmpdir(), "penumbra-model-test-"));
  roots.push(root);
  const dest = join(root, "cache");
  return { root, dest, model: join(dest, modelName) };
}

async function writeModel(model: string): Promise<void> {
  await mkdir(model, { recursive: true });
  await Promise.all(
    Object.entries(contents).map(([name, value]) => writeFile(join(model, name), value)),
  );
}

function noDownload(): Promise<void> {
  throw new Error("download must not be attempted");
}

test("matching existing model is verified without downloading", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { dest, model } = await fixture();
  await writeModel(model);
  const result = await fetchEmbedderModel({ dest, manifest, download: noDownload });
  expect(result.exitCode).toBe(0);
  expect(result.message).toContain("already present and verified");
});

test("altered existing file fails closed and stays untouched", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { dest, model } = await fixture();
  await writeModel(model);
  await writeFile(join(model, "model.onnx"), "altered");
  const result = await fetchEmbedderModel({ dest, manifest, download: noDownload });
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain("model.onnx");
  expect(result.message).toContain("sha256 mismatch");
  expect(result.message).toContain("remove it and re-run");
  expect(await readFile(join(model, "model.onnx"), "utf8")).toBe("altered");
});

test("missing existing file is named without writing or downloading", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { dest, model } = await fixture();
  await writeModel(model);
  await rm(join(model, "config.json"));
  const result = await fetchEmbedderModel({ dest, manifest, download: noDownload });
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain("config.json");
  expect(await Bun.file(join(model, "config.json")).exists()).toBe(false);
});

test("all bad existing files are reported together", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { dest, model } = await fixture();
  await writeModel(model);
  await rm(join(model, "config.json"));
  await writeFile(join(model, "model.onnx"), "altered");
  const result = await fetchEmbedderModel({ dest, manifest, download: noDownload });
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain("config.json");
  expect(result.message).toContain("model.onnx");
});

test("archive sha256 mismatch prevents extraction and cleans the temporary archive", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { dest } = await fixture();
  let archive = "";
  let extracted = false;
  const result = await fetchEmbedderModel({
    dest,
    manifest,
    archiveSha256: hash("expected archive"),
    download: async (directory) => {
      archive = join(directory, assetName);
      await writeFile(archive, "incorrect archive");
    },
    extract: () => {
      extracted = true;
      return Promise.resolve();
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain("archive sha256 mismatch");
  expect(extracted).toBe(false);
  expect(await Bun.file(archive).exists()).toBe(false);
  expect(await Bun.file(join(dest, modelName, "model.onnx")).exists()).toBe(false);
});

async function tinyArchive(root: string): Promise<string> {
  const source = join(root, "source");
  await writeModel(join(source, modelName));
  const archive = join(root, assetName);
  const child = Bun.spawn(["tar", "-czf", archive, "-C", source, modelName], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  return archive;
}

test("tiny tarball is extracted, verified, and removed from the temporary directory", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { root, dest, model } = await fixture();
  const source = await tinyArchive(root);
  let downloadedArchive = "";
  const result = await fetchEmbedderModel({
    dest,
    manifest,
    archiveSha256: hash(await readFile(source)),
    download: async (directory) => {
      downloadedArchive = join(directory, assetName);
      await copyFile(source, downloadedArchive);
    },
  });
  expect(result.exitCode).toBe(0);
  expect(result.message).toContain("downloaded and verified");
  for (const [name, value] of Object.entries(contents)) {
    expect(await readFile(join(model, name), "utf8")).toBe(value);
  }
  expect(await Bun.file(downloadedArchive).exists()).toBe(false);
});

test("extracted model manifest mismatch fails after extraction", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { root, dest } = await fixture();
  const source = await tinyArchive(root);
  const result = await fetchEmbedderModel({
    dest,
    manifest: { ...manifest, "model.onnx": hash("different bytes") },
    archiveSha256: hash(await readFile(source)),
    download: async (directory) => {
      await copyFile(source, join(directory, assetName));
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain("model.onnx");
  expect(result.message).toContain("sha256 mismatch");
});

test("download failure includes stderr and authentication guidance", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { dest } = await fixture();
  const result = await fetchEmbedderModel({
    dest,
    manifest,
    download: () => Promise.reject(new Error("gh: authentication failed")),
  });
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain("gh: authentication failed");
  expect(result.message).toContain("GH_TOKEN");
  expect(result.message).toContain("gh auth login");
});

test("CLI destination defaults to the repository and accepts --dest", async () => {
  const { parseArgs } = await implementation();
  expect(parseArgs([])).toBe(join(import.meta.dir, "..", "local_cache"));
  expect(parseArgs(["--dest", "/tmp/test-cache"])).toBe("/tmp/test-cache");
});

test("CLI rejects unknown arguments and a missing destination", async () => {
  const { parseArgs } = await implementation();
  expect(() => parseArgs(["--unknown"])).toThrow("Usage:");
  expect(() => parseArgs(["--dest"])).toThrow("Usage:");
  expect(() => parseArgs(["--dest", "--other"])).toThrow("Usage:");
});
