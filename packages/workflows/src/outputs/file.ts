import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, extname } from "node:path";

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
  try {
    await mkdir(dirname(targetPath), { recursive: true });
    if (mode === "skip-if-exists" && existsSync(targetPath)) {
      return { warnings: [], path: targetPath, skipped: true };
    }
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
    } else {
      await writeFile(targetPath, input.body, "utf8");
    }
    return { warnings: [], path: targetPath, skipped: false };
  } catch (err: any) {
    return { warnings: [`output file: ${err?.message ?? String(err)}`] };
  }
}
