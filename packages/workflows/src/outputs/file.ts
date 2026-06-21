import { realpathSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
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

async function writeUniqueSuffix(targetPath: string, body: string): Promise<FileOutputResult> {
  const ext = extname(targetPath);
  const base = ext.length > 0 ? targetPath.slice(0, -ext.length) : targetPath;
  const MAX_ATTEMPTS = 1000;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const candidate = n === 1 ? targetPath : `${base}-${String(n)}${ext}`;
    try {
      await writeFile(candidate, body, { flag: "wx", encoding: "utf8" });
      return { warnings: [], path: candidate, skipped: false };
    } catch (err: unknown) {
      if (errorCode(err) === "EEXIST") continue;
      throw err;
    }
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
    await appendFile(targetPath, body, "utf8");
    return { warnings: [], path: targetPath, skipped: false };
  }
  if (mode === "skip-if-exists") {
    try {
      await writeFile(targetPath, body, { flag: "wx", encoding: "utf8" });
    } catch (err: unknown) {
      if (errorCode(err) === "EEXIST") {
        return { warnings: [], path: targetPath, skipped: true };
      }
      throw err;
    }
    return { warnings: [], path: targetPath, skipped: false };
  }
  await writeFile(targetPath, body, "utf8");
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
