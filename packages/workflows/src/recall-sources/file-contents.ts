import { realpathSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

const DEFAULT_MAX_BYTES = 65_536;
export const BINARY_BODY_PLACEHOLDER = "<binary file omitted>";
const MAX_NUL_RATIO = 0.01;
const UTF16_PROBE_BYTES = 8192;

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

function escapeNulBytes(buffer: Buffer): { bytes: Buffer; escaped: number } {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0x00) count += 1;
  }
  if (count === 0) return { bytes: buffer, escaped: 0 };
  const out = Buffer.alloc(buffer.length + count);
  let offset = 0;
  for (const byte of buffer) {
    if (byte === 0x00) {
      out[offset] = 0x5c;
      out[offset + 1] = 0x30;
      offset += 2;
    } else {
      out[offset] = byte;
      offset += 1;
    }
  }
  return { bytes: out, escaped: count };
}

function hasUtf16Bom(buffer: Buffer): boolean {
  return (
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))
  );
}

function hasAlternatingNulPattern(probe: Buffer): boolean {
  let evenNul = 0;
  let oddNul = 0;
  for (const [index, byte] of probe.entries()) {
    if (byte !== 0) continue;
    if (index % 2 === 0) evenNul += 1;
    else oddNul += 1;
  }
  const evenTotal = Math.ceil(probe.length / 2);
  const oddTotal = Math.floor(probe.length / 2);
  return evenNul / evenTotal > 0.5 || (oddTotal > 0 && oddNul / oddTotal > 0.5);
}

// NUL escaping is for text that happens to carry a stray NUL. Dense NULs, a
// UTF-16 BOM, or a BOM-less UTF-16 alternating pattern mean the buffer is
// binary: escaping would emit a wall of \0 garbage that downstream gates then
// mistake for reviewable content.
function looksLikeBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  if (hasUtf16Bom(buffer)) return true;
  let nulCount = 0;
  for (const byte of buffer) {
    if (byte === 0) nulCount += 1;
  }
  // Density needs a real sample: measured against the raw length, a 30-byte
  // file with two stray NULs already exceeds 1%. The probe size is the floor.
  if (nulCount / Math.max(buffer.length, UTF16_PROBE_BYTES) > MAX_NUL_RATIO) return true;
  return hasAlternatingNulPattern(buffer.subarray(0, UTF16_PROBE_BYTES));
}

function decodeUtf8Prefix(buffer: Buffer): string | null {
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

function resolveUserPath(cwd: string, path: string, storageRoot?: string): string {
  if (path === "penumbra-storage:" || path.startsWith("penumbra-storage:")) {
    const relPath = path.slice("penumbra-storage:".length);
    return storageRoot ? resolve(storageRoot, relPath) : resolve(cwd, path);
  }
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(cwd, path);
}

function isPathAllowed(realAbsPath: string, candidateRoots: string[], cwd: string): boolean {
  for (const root of candidateRoots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(resolveUserPath(cwd, root));
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
): Promise<{ body: string | null; truncated: boolean; nulEscaped: number }> {
  const bytesToRead = Math.min(byteSize, limit);
  const truncated = byteSize > limit;
  const handle = await open(absPath, "r");
  try {
    const raw = Buffer.alloc(bytesToRead);
    if (bytesToRead > 0) {
      await handle.read(raw, 0, bytesToRead, 0);
    }
    if (looksLikeBinaryBuffer(raw)) {
      return { body: null, truncated, nulEscaped: 0 };
    }
    const { bytes, escaped } = escapeNulBytes(raw);
    return { body: decodeUtf8Prefix(bytes), truncated, nulEscaped: escaped };
  } finally {
    await handle.close();
  }
}

export async function runFileContents(input: FileContentsInput): Promise<FileContentsOutput> {
  const requested = input.args.path.trim();
  if (requested.length === 0) {
    return { result: { path: "", body: null, error: "not_found" }, warnings: [] };
  }
  const absPath = resolveUserPath(input.cwd, requested, input.storageRoot);
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
    const info = await stat(realAbsPath ?? absPath);
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
  const { body, truncated, nulEscaped } = await readBoundedBody(
    realAbsPath ?? absPath,
    byteSize,
    limit,
  );
  if (body === null) {
    warnings.push(`file.contents: ${absPath} binary content omitted`);
    return {
      result: {
        path: absPath,
        body: BINARY_BODY_PLACEHOLDER,
        truncated: false,
        byte_size: byteSize,
      },
      warnings,
    };
  }
  if (nulEscaped > 0) {
    warnings.push(`file.contents: ${absPath} ${String(nulEscaped)} NUL bytes escaped`);
  }
  return {
    result: { path: absPath, body, truncated, byte_size: byteSize },
    warnings,
  };
}
