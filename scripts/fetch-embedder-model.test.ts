import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

async function expectModelNotices(model: string): Promise<void> {
  for (const name of ["LICENSE", "NOTICE"]) {
    expect(await Bun.file(join(model, name)).exists(), `${name} must accompany the model`).toBe(
      true,
    );
    expect(await readFile(join(model, name), "utf8")).toBe(
      await readFile(new URL(`../licenses/all-MiniLM-L6-v2.${name}.txt`, import.meta.url), "utf8"),
    );
  }
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
  await expectModelNotices(model);
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
  expect(await Bun.file(join(model, "LICENSE")).exists()).toBe(false);
});

test("installing notices replaces a notice symlink without writing its target", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { root, dest, model } = await fixture();
  await writeModel(model);
  const outside = join(root, "outside.txt");
  await writeFile(outside, "leave untouched");
  await symlink(outside, join(model, "LICENSE"));
  const result = await fetchEmbedderModel({ dest, manifest, download: noDownload });
  expect(result.exitCode).toBe(0);
  expect(await readFile(outside, "utf8")).toBe("leave untouched");
  await expectModelNotices(model);
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
  await expectModelNotices(model);
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

test("--from copies a verified local model without downloading", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { root, dest, model } = await fixture();
  const source = join(root, "source-cache");
  await writeModel(join(source, modelName));
  const result = await fetchEmbedderModel({
    dest,
    manifest,
    from: source,
    download: noDownload,
  });
  expect(result.exitCode).toBe(0);
  expect(result.message).toContain("copied");
  for (const [name, value] of Object.entries(contents)) {
    expect(await readFile(join(model, name), "utf8")).toBe(value);
  }
  await expectModelNotices(model);
});

test("--from refuses a source file that fails the manifest and leaves the destination empty", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { root, dest, model } = await fixture();
  const source = join(root, "source-cache");
  await writeModel(join(source, modelName));
  await writeFile(join(source, modelName, "model.onnx"), "tampered");
  const result = await fetchEmbedderModel({
    dest,
    manifest,
    from: source,
    download: noDownload,
  });
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain("model.onnx");
  expect(result.message).toContain("sha256 mismatch");
  expect(result.message).not.toContain("download must not be attempted");
  expect(await Bun.file(join(model, "model.onnx")).exists()).toBe(false);
});

test("--from rejects a missing source model directory", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { root, dest, model } = await fixture();
  const source = join(root, "empty-cache");
  await mkdir(source, { recursive: true });
  const result = await fetchEmbedderModel({
    dest,
    manifest,
    from: source,
    download: noDownload,
  });
  expect(result.exitCode).toBe(1);
  expect(result.message).not.toContain("download must not be attempted");
  expect(result.message).toContain(modelName);
  expect(await Bun.file(model).exists()).toBe(false);
});

test("--from is a no-op when the destination already verifies", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { dest, model } = await fixture();
  await writeModel(model);
  const result = await fetchEmbedderModel({
    dest,
    manifest,
    from: join(dest, "no-such-source"),
    download: noDownload,
  });
  expect(result.exitCode).toBe(0);
  expect(result.message).toContain("already present and verified");
});

test("--from never overwrites a failing existing model directory", async () => {
  const { fetchEmbedderModel } = await implementation();
  const { root, dest, model } = await fixture();
  await writeModel(model);
  await writeFile(join(model, "model.onnx"), "altered");
  const source = join(root, "source-cache");
  await writeModel(join(source, modelName));
  const result = await fetchEmbedderModel({
    dest,
    manifest,
    from: source,
    download: noDownload,
  });
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain("remove it and re-run");
  expect(await readFile(join(model, "model.onnx"), "utf8")).toBe("altered");
});

test("CLI destination defaults to the repository and accepts --dest", async () => {
  const { parseArgs } = await implementation();
  expect(parseArgs([]).dest).toBe(join(import.meta.dir, "..", "local_cache"));
  expect(parseArgs(["--dest", "/tmp/test-cache"]).dest).toBe("/tmp/test-cache");
});

test("CLI accepts --from alone and combined with --dest", async () => {
  const { parseArgs } = await implementation();
  let fromOnly: ReturnType<typeof parseArgs> | null = null;
  try {
    fromOnly = parseArgs(["--from", "/tmp/source"]);
  } catch {
    fromOnly = null;
  }
  expect(fromOnly).toEqual({
    dest: join(import.meta.dir, "..", "local_cache"),
    from: "/tmp/source",
  });
  expect(parseArgs(["--dest", "/tmp/dst", "--from", "/tmp/src"])).toEqual({
    dest: "/tmp/dst",
    from: "/tmp/src",
  });
});

test("CLI rejects unknown arguments and a missing destination", async () => {
  const { parseArgs } = await implementation();
  expect(() => parseArgs(["--unknown"])).toThrow("Usage:");
  expect(() => parseArgs(["--dest"])).toThrow("Usage:");
  expect(() => parseArgs(["--dest", "--other"])).toThrow("Usage:");
  expect(() => parseArgs(["--from"])).toThrow("Usage:");
  expect(() => parseArgs(["--from", "--dest"])).toThrow("Usage:");
});
