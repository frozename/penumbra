import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_MAX_BYTES = 65_536;

export type FileContentsInput = {
  cwd: string;
  args: { path: string; max_bytes?: number };
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
  error: 'not_found';
};

export type FileContentsResult = FileContentsSuccess | FileContentsNotFound;
export type FileContentsOutput = {
  result: FileContentsResult;
  warnings: string[];
};

function decodeUtf8Prefix(buffer: Buffer): string | null {
  if (buffer.includes(0x00)) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let trim = 0; trim <= 3; trim++) {
    const end = buffer.length - trim;
    if (end < 0) break;
    try {
      return decoder.decode(buffer.subarray(0, end));
    } catch {}
  }
  return null;
}

export async function runFileContents(input: FileContentsInput): Promise<FileContentsOutput> {
  const requested = input.args.path?.trim() ?? '';
  if (requested.length === 0) {
    return { result: { path: '', body: null, error: 'not_found' }, warnings: [] };
  }
  const absPath = resolve(input.cwd, requested);
  const maxBytes = input.args.max_bytes ?? DEFAULT_MAX_BYTES;
  let byteSize: number;
  try {
    const info = await stat(absPath);
    if (!info.isFile()) {
      return { result: { path: absPath, body: null, error: 'not_found' }, warnings: [] };
    }
    byteSize = info.size;
  } catch {
    return {
      result: { path: absPath, body: null, error: 'not_found' },
      warnings: [],
    };
  }

  const limit = Math.max(0, maxBytes);
  const bytesToRead = Math.min(byteSize, limit);
  const truncated = byteSize > limit;
  const warnings: string[] = [];
  if (truncated) {
    warnings.push(`file.contents: ${absPath} exceeds max_bytes=${limit}; returning first ${bytesToRead} bytes`);
  }

  const handle = await open(absPath, 'r');
  try {
    const raw = Buffer.alloc(bytesToRead);
    if (bytesToRead > 0) {
      await handle.read(raw, 0, bytesToRead, 0);
    }
    const body = decodeUtf8Prefix(raw);
    if (body === null) {
      return {
        result: {
          path: absPath,
          body: '<binary file omitted>',
          truncated: false,
          byte_size: byteSize,
        },
        warnings,
      };
    }
    return {
      result: {
        path: absPath,
        body,
        truncated,
        byte_size: byteSize,
      },
      warnings,
    };
  } finally {
    await handle.close();
  }
}
