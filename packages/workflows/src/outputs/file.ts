import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type FileOutputMode = 'overwrite' | 'append' | 'skip-if-exists';
export type FileOutputResult = { warnings: string[]; path?: string; skipped?: boolean };

export async function emitFileOutput(input: {
  path: string;
  body: string;
  mode?: FileOutputMode;
}): Promise<FileOutputResult> {
  const mode = input.mode ?? 'overwrite';
  try {
    await mkdir(dirname(input.path), { recursive: true });
    if (mode === 'skip-if-exists' && existsSync(input.path)) {
      return { warnings: [], path: input.path, skipped: true };
    }
    if (mode === 'append') {
      await appendFile(input.path, input.body, 'utf8');
    } else {
      await writeFile(input.path, input.body, 'utf8');
    }
    return { warnings: [], path: input.path, skipped: false };
  } catch (err: any) {
    return { warnings: [`output file: ${err?.message ?? String(err)}`] };
  }
}
