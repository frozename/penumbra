import { realpathSync } from "node:fs";
import { appendFile, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

export type FileOutputMode = "overwrite" | "append" | "skip-if-exists" | "unique-suffix";
export type FileOutputResult = { warnings: string[]; path?: string; skipped?: boolean };

function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = err.code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isContained(root: string, path: string): boolean {
  const rootRelativePath = relative(root, path);
  return (
    rootRelativePath === "" || (!rootRelativePath.startsWith("..") && !isAbsolute(rootRelativePath))
  );
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function resolveForCheck(resolvedRoot: string, resolvedTarget: string, realRoot: string): string {
  if (!isContained(resolvedRoot, resolvedTarget)) return resolvedTarget;
  let check = resolvedTarget;
  for (;;) {
    try {
      return realpathSync(check);
    } catch {
      if (check === resolvedRoot) return realRoot;
      const parent = dirname(check);
      if (parent === check) return resolve(check);
      check = parent;
    }
  }
}

function containmentWarning(input: {
  path: string;
  repoRoot?: string;
  targetPath: string;
}): FileOutputResult | null {
  if (input.repoRoot === undefined) return null;
  const resolvedRoot = resolve(input.repoRoot);
  const resolvedTarget = resolve(input.targetPath);
  const realRoot = safeRealpath(input.repoRoot);
  const checked = resolveForCheck(resolvedRoot, resolvedTarget, realRoot);
  if (!isContained(realRoot, checked)) {
    return {
      warnings: [
        `output file: path is outside the allowed root (${input.repoRoot}): ${input.path}`,
      ],
    };
  }
  return null;
}

let tempPathSequence = 0;

function tempPathFor(targetPath: string): string {
  tempPathSequence = (tempPathSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${targetPath}.${String(process.pid)}.${String(Date.now())}.${String(tempPathSequence)}.tmp`;
}

async function writeTempFile(targetPath: string, body: string): Promise<string> {
  const tmpPath = tempPathFor(targetPath);
  try {
    await writeFile(tmpPath, body, { flag: "wx", encoding: "utf8" });
  } catch (err: unknown) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  return tmpPath;
}

async function writeAtomic(targetPath: string, body: string): Promise<void> {
  const tmpPath = await writeTempFile(targetPath, body);
  try {
    await rename(tmpPath, targetPath);
  } catch (err: unknown) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

async function writeAtomicIfAbsent(targetPath: string, body: string): Promise<boolean> {
  const tmpPath = await writeTempFile(targetPath, body);
  try {
    // Local notes live on APFS/ext4-like filesystems where hardlink create-if-absent is supported.
    await link(tmpPath, targetPath);
    return true;
  } catch (err: unknown) {
    if (errorCode(err) === "EEXIST") return false;
    throw err;
  } finally {
    await rm(tmpPath, { force: true });
  }
}

async function writeUniqueSuffix(targetPath: string, body: string): Promise<FileOutputResult> {
  const ext = extname(targetPath);
  const base = ext.length > 0 ? targetPath.slice(0, -ext.length) : targetPath;
  const MAX_ATTEMPTS = 1000;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const candidate = n === 1 ? targetPath : `${base}-${String(n)}${ext}`;
    const written = await writeAtomicIfAbsent(candidate, body);
    if (written) return { warnings: [], path: candidate, skipped: false };
  }
  throw new Error(
    `Exceeded maximum unique-suffix attempts (${String(MAX_ATTEMPTS)}) for ${targetPath}`,
  );
}

async function writeByMode(
  targetPath: string,
  body: string,
  mode: FileOutputMode,
): Promise<FileOutputResult> {
  if (mode === "unique-suffix") {
    return await writeUniqueSuffix(targetPath, body);
  }
  if (mode === "append") {
    // Atomic tmp+rename is for whole-file writes; read-modify-rename loses concurrent appends.
    await appendFile(targetPath, body, { encoding: "utf8" });
    return { warnings: [], path: targetPath, skipped: false };
  }
  if (mode === "skip-if-exists") {
    try {
      await readFile(targetPath, "utf8");
      return { warnings: [], path: targetPath, skipped: true };
    } catch (err: unknown) {
      if (errorCode(err) !== "ENOENT") {
        throw err;
      }
    }
    const written = await writeAtomicIfAbsent(targetPath, body);
    return { warnings: [], path: targetPath, skipped: !written };
  }
  await writeAtomic(targetPath, body);
  return { warnings: [], path: targetPath, skipped: false };
}

export async function emitFileOutput(input: {
  path: string;
  body: string;
  mode?: FileOutputMode;
  repoRoot?: string;
}): Promise<FileOutputResult> {
  const mode = input.mode ?? "overwrite";
  const targetPath = isAbsolute(input.path)
    ? input.path
    : input.repoRoot !== undefined
      ? join(input.repoRoot, input.path)
      : resolve(process.cwd(), input.path);

  const warning = containmentWarning({
    path: input.path,
    repoRoot: input.repoRoot,
    targetPath,
  });
  if (warning) return warning;

  try {
    await mkdir(dirname(targetPath), { recursive: true });
    return await writeByMode(targetPath, input.body, mode);
  } catch (err: unknown) {
    return { warnings: [`output file: ${errorMessage(err)}`] };
  }
}
