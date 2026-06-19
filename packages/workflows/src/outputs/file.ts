import { realpathSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

export type FileOutputMode = "overwrite" | "append" | "skip-if-exists" | "unique-suffix";
export type FileOutputResult = { warnings: string[]; path?: string; skipped?: boolean };

export async function emitFileOutput(input: {
  path: string;
  body: string;
  mode?: FileOutputMode;
  repoRoot?: string;
}): Promise<FileOutputResult> {
  const mode = input.mode ?? "overwrite";
  let targetPath = isAbsolute(input.path)
    ? input.path
    : input.repoRoot !== undefined
      ? join(input.repoRoot, input.path)
      : resolve(process.cwd(), input.path);

  if (input.repoRoot !== undefined) {
    const resolvedRoot = resolve(input.repoRoot);
    const resolvedTarget = resolve(targetPath);
    const realRoot = (() => {
      try {
        return realpathSync(input.repoRoot);
      } catch {
        return resolvedRoot;
      }
    })();
    const isContained = (root: string, path: string): boolean => {
      const rootRelativePath = relative(root, path);
      return (
        rootRelativePath === "" ||
        (!rootRelativePath.startsWith("..") && !isAbsolute(rootRelativePath))
      );
    };
    const resolvedForCheck = (() => {
      if (!isContained(resolvedRoot, resolvedTarget)) {
        return resolvedTarget;
      }
      let check = resolvedTarget;
      while (true) {
        try {
          return realpathSync(check);
        } catch {
          if (check === resolvedRoot) {
            return realRoot;
          }
          const parent = dirname(check);
          if (parent === check) {
            return resolve(check);
          }
          check = parent;
        }
      }
    })();
    if (!isContained(realRoot, resolvedForCheck)) {
      return {
        warnings: [
          `output file: path is outside the allowed root (${input.repoRoot}): ${input.path}`,
        ],
      };
    }
  }

  try {
    await mkdir(dirname(targetPath), { recursive: true });
    if (mode === "unique-suffix") {
      const ext = extname(targetPath);
      const base = ext.length > 0 ? targetPath.slice(0, -ext.length) : targetPath;
      let n = 1;
      const MAX_ATTEMPTS = 1000;
      let written = false;
      while (n <= MAX_ATTEMPTS) {
        const candidate = n === 1 ? targetPath : `${base}-${n}${ext}`;
        try {
          await writeFile(candidate, input.body, { flag: "wx", encoding: "utf8" });
          targetPath = candidate;
          written = true;
          break;
        } catch (err: any) {
          if (err.code === "EEXIST") {
            n++;
            continue;
          }
          throw err;
        }
      }
      if (!written) {
        throw new Error(
          `Exceeded maximum unique-suffix attempts (${MAX_ATTEMPTS}) for ${targetPath}`,
        );
      }
      return { warnings: [], path: targetPath, skipped: false };
    }
    if (mode === "append") {
      await appendFile(targetPath, input.body, "utf8");
    } else if (mode === "skip-if-exists") {
      try {
        await writeFile(targetPath, input.body, { flag: "wx", encoding: "utf8" });
      } catch (err: any) {
        if (err?.code === "EEXIST") {
          return { warnings: [], path: targetPath, skipped: true };
        }
        throw err;
      }
    } else {
      await writeFile(targetPath, input.body, "utf8");
    }
    return { warnings: [], path: targetPath, skipped: false };
  } catch (err: any) {
    return { warnings: [`output file: ${err?.message ?? String(err)}`] };
  }
}
