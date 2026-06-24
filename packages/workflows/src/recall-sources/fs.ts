import { Glob } from "bun";

const DEFAULT_MAX_MATCHES = 200;

export type FsGlobInput = {
  cwd: string;
  args: { pattern: string; max_matches?: number };
  scan?: (pattern: string, cwd: string) => AsyncIterable<string>;
};
export type FsGlobOutput = { matches: string[]; warnings: string[] };

function resolveMaxMatches(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return DEFAULT_MAX_MATCHES;
}

function scanGlob(pattern: string, cwd: string): AsyncIterable<string> {
  const glob = new Glob(pattern);
  return glob.scan({ cwd, onlyFiles: true });
}

export async function runFsGlob(input: FsGlobInput): Promise<FsGlobOutput> {
  try {
    const maxMatches = resolveMaxMatches(input.args.max_matches);
    const scan = input.scan ?? scanGlob;
    const matches: string[] = [];
    const warnings: string[] = [];
    for await (const path of scan(input.args.pattern, input.cwd)) {
      matches.push(path);
      if (matches.length >= maxMatches) {
        warnings.push(
          `fs.glob: reached max_matches cap of ${String(maxMatches)}; results may be truncated`,
        );
        break;
      }
    }
    return { matches, warnings };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { matches: [], warnings: [`fs.glob: ${msg}`] };
  }
}
