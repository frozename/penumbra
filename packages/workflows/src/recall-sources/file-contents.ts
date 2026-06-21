import { realpathSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

const DEFAULT_MAX_BYTES = 65_536;

export type FileContentsInput = {
  cwd: string;
  storageRoot?: string;
  args: { path: string; max_bytes?: number; allowed_roots?: string[] };
};

type FileContentsSuccess = {
  path: string;
  body: string;
  truncated: boolean;
  byte_size: number;
};

type FileContentsNotFound = {
  path: string;
  body: null;
  error: "not_found";
};

type FileContentsOutsideAllowedRoots = {
  path: string;
  body: null;
  error: "path_outside_allowed_roots";
};

export type FileContentsResult =
  | FileContentsSuccess
  | FileContentsNotFound
  | FileContentsOutsideAllowedRoots;
export type FileContentsOutput = {
  result: FileContentsResult;
  warnings: string[];
};

function decodeUtf8Prefix(buffer: Buffer): string | null {
  if (buffer.includes(0x00)) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trim = 0; trim <= 3; trim++) {
    const end = buffer.length - trim;
    if (end < 0) break;
    try {
      return decoder.decode(buffer.subarray(0, end));
    } catch {
      // try trimming one more trailing byte (partial multi-byte sequence)
    }
  }
  return null;
}

function isPathAllowed(realAbsPath: string, candidateRoots: string[], cwd: string): boolean {
  for (const root of candidateRoots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(resolve(cwd, root));
    } catch {
      continue;
    }
    if (realAbsPath === realRoot || realAbsPath.startsWith(`${realRoot}${sep}`)) {
      return true;
    }
  }
  return false;
}

async function readBoundedBody(
  absPath: string,
  byteSize: number,
  limit: number,
): Promise<{ body: string; truncated: boolean }> {
  const bytesToRead = Math.min(byteSize, limit);
  const truncated = byteSize > limit;
  const handle = await open(absPath, "r");
  try {
    const raw = Buffer.alloc(bytesToRead);
    if (bytesToRead > 0) {
      await handle.read(raw, 0, bytesToRead, 0);
    }
    const decoded = decodeUtf8Prefix(raw);
    return { body: decoded ?? "<binary file omitted>", truncated };
  } finally {
    await handle.close();
  }
}

export async function runFileContents(input: FileContentsInput): Promise<FileContentsOutput> {
  const requested = input.args.path.trim();
  if (requested.length === 0) {
    return { result: { path: "", body: null, error: "not_found" }, warnings: [] };
  }
  const absPath = resolve(input.cwd, requested);
  const candidateRoots = [input.cwd, input.storageRoot, ...(input.args.allowed_roots ?? [])].filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );
  let realAbsPath: string | null = null;
  try {
    realAbsPath = realpathSync(absPath);
  } catch {
    realAbsPath = null;
  }
  if (realAbsPath !== null && !isPathAllowed(realAbsPath, candidateRoots, input.cwd)) {
    return {
      result: { path: absPath, body: null, error: "path_outside_allowed_roots" },
      warnings: [],
    };
  }
  const maxBytes = input.args.max_bytes ?? DEFAULT_MAX_BYTES;
  let byteSize: number;
  try {
    const info = await stat(absPath);
    if (!info.isFile()) {
      return { result: { path: absPath, body: null, error: "not_found" }, warnings: [] };
    }
    byteSize = info.size;
  } catch {
    return { result: { path: absPath, body: null, error: "not_found" }, warnings: [] };
  }

  const limit = Math.max(0, maxBytes);
  const warnings: string[] = [];
  if (byteSize > limit) {
    warnings.push(
      `file.contents: ${absPath} exceeds max_bytes=${String(limit)}; returning first ${String(Math.min(byteSize, limit))} bytes`,
    );
  }
  const { body, truncated } = await readBoundedBody(absPath, byteSize, limit);
  if (body === "<binary file omitted>") {
    return {
      result: { path: absPath, body, truncated: false, byte_size: byteSize },
      warnings,
    };
  }
  return {
    result: { path: absPath, body, truncated, byte_size: byteSize },
    warnings,
  };
}
