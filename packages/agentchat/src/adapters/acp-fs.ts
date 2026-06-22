import { FsPathError, resolveInsideWorktree } from "@penumbra/core";
import * as fs from "node:fs/promises";

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

function normaliseLineNumber(value: number | null | undefined): number | null {
  return Number.isInteger(value) && (value ?? 0) > 0 ? (value ?? null) : null;
}

function sliceLines(text: string, line?: number | null, limit?: number | null): string {
  const startLine = normaliseLineNumber(line);
  const lineLimit = normaliseLineNumber(limit);

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

function classifyFsPathError(err: FsPathError): ReadTextFileError {
  if (err.code === "outside_worktree") {
    return new ReadTextFileError("outside_worktree", err.message);
  }
  if (err.code === "not_found") {
    return new ReadTextFileError("not_found", err.message);
  }
  return new ReadTextFileError("io", err.message);
}

function readErrorToReadTextFileError(err: unknown, requested: string): ReadTextFileError {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT") {
      return new ReadTextFileError("not_found", `file not found: ${requested}`);
    }
    const message = (err as { message?: unknown }).message;
    const detail = typeof message === "string" ? message : "unknown error";
    return new ReadTextFileError("io", `failed to read ${requested}: ${detail}`);
  }
  const detail = typeof err === "string" ? err : "unknown error";
  return new ReadTextFileError("io", `failed to read ${requested}: ${detail}`);
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
      throw classifyFsPathError(err);
    }
    throw err;
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(real);
  } catch (err) {
    throw readErrorToReadTextFileError(err, args.path);
  }

  let content = sliceLines(buf.toString("utf8"), args.line, args.limit);
  if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES) {
    content = Buffer.from(content, "utf8").subarray(0, MAX_READ_BYTES).toString("utf8");
  }

  return { content };
}
