import * as fs from "node:fs/promises";
import { resolveInsideWorktree, FsPathError } from "@penumbra/core";

const MAX_READ_BYTES = 1024 * 1024;

export class ReadTextFileError extends Error {
  constructor(
    public readonly code: "outside_worktree" | "not_found" | "io",
    message: string,
  ) {
    super(message);
    this.name = "ReadTextFileError";
  }
}

export interface ReadTextFileArgs {
  path: string;
  line?: number | null;
  limit?: number | null;
}

export interface ReadTextFileResult {
  content: string;
}

function sliceLines(text: string, line?: number | null, limit?: number | null): string {
  const startLine = Number.isInteger(line) && (line ?? 0) > 0 ? (line as number) : null;
  const lineLimit = Number.isInteger(limit) && (limit ?? 0) > 0 ? (limit as number) : null;

  if (startLine === null && lineLimit === null) {
    return text;
  }

  const lines = text.split("\n");
  const start = startLine !== null ? startLine - 1 : 0;
  const end = lineLimit !== null ? start + lineLimit : lines.length;
  let sliced = lines.slice(start, end).join("\n");
  const reachedEnd = end >= lines.length;

  if (!reachedEnd && !sliced.endsWith("\n")) {
    sliced += "\n";
  }
  if (reachedEnd && text.endsWith("\n") && !sliced.endsWith("\n")) {
    sliced += "\n";
  }

  return sliced;
}

export async function executeReadTextFile(
  args: ReadTextFileArgs,
  worktree: string,
): Promise<ReadTextFileResult> {
  let real: string;
  try {
    real = await resolveInsideWorktree(args.path, worktree);
  } catch (err) {
    if (err instanceof FsPathError) {
      if (err.code === "outside_worktree") {
        throw new ReadTextFileError("outside_worktree", err.message);
      }
      if (err.code === "not_found") {
        throw new ReadTextFileError("not_found", err.message);
      }
      throw new ReadTextFileError("io", err.message);
    }
    throw err;
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(real);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new ReadTextFileError("not_found", `file not found: ${args.path}`);
    }
    throw new ReadTextFileError(
      "io",
      `failed to read ${args.path}: ${err?.message ?? String(err)}`,
    );
  }

  let content = sliceLines(buf.toString("utf8"), args.line, args.limit);
  if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES) {
    content = Buffer.from(content, "utf8").subarray(0, MAX_READ_BYTES).toString("utf8");
  }

  return { content };
}
