import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type FileOutputResult = { warnings: string[]; path?: string };

export async function emitFileOutput(input: { path: string; body: string }): Promise<FileOutputResult> {
  try {
    await mkdir(dirname(input.path), { recursive: true });
    await writeFile(input.path, input.body, 'utf8');
    return { warnings: [], path: input.path };
  } catch (err: any) {
    return { warnings: [`output file: ${err?.message ?? String(err)}`] };
  }
}
