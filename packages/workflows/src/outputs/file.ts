import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type FileOutputMode = 'overwrite' | 'append' | 'skip-if-exists';
export type FileOutputResult = { warnings: string[]; path?: string; skipped?: boolean };

export async function emitFileOutput(input: {
  path: string;
  body: string;
  mode?: FileOutputMode;
  repoRoot?: string;
}): Promise<FileOutputResult> {
  const mode = input.mode ?? 'overwrite';
  const path = isAbsolute(input.path)
    ? input.path
    : input.repoRoot !== undefined
      ? join(input.repoRoot, input.path)
      : resolve(process.cwd(), input.path);
  try {
    await mkdir(dirname(path), { recursive: true });
    if (mode === 'skip-if-exists' && existsSync(path)) {
      return { warnings: [], path, skipped: true };
    }
    if (mode === 'append') {
      await appendFile(path, input.body, 'utf8');
    } else {
      await writeFile(path, input.body, 'utf8');
    }
    return { warnings: [], path, skipped: false };
  } catch (err: any) {
    return { warnings: [`output file: ${err?.message ?? String(err)}`] };
  }
}
