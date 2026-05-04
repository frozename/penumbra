import { Glob } from 'bun';

export type FsGlobInput = { cwd: string; args: { pattern: string } };
export type FsGlobOutput = { matches: string[]; warnings: string[] };

export async function runFsGlob(input: FsGlobInput): Promise<FsGlobOutput> {
  try {
    const glob = new Glob(input.args.pattern);
    const matches: string[] = [];
    for await (const path of glob.scan({ cwd: input.cwd, onlyFiles: true })) {
      matches.push(path);
    }
    return { matches, warnings: [] };
  } catch (err: any) {
    return { matches: [], warnings: [`fs.glob: ${err?.message ?? String(err)}`] };
  }
}
