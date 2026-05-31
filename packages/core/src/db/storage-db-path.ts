import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ResolveStorageDbPathOpts {
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

export function resolveStorageDbPath(
  storageRoot: string,
  opts: ResolveStorageDbPathOpts = {},
): string {
  const dbPath = join(storageRoot, "db.sqlite");
  assertTestDbPathIsolation(dbPath, opts);
  return dbPath;
}

export function assertTestDbPathIsolation(
  dbPath: string,
  opts: ResolveStorageDbPathOpts = {},
): void {
  const env = opts.env ?? process.env;
  if (env.NODE_ENV !== "test") return;

  const home = opts.homeDir ?? env.HOME ?? homedir();
  const prodDbPath = resolve(home, ".penumbra", "db.sqlite");
  if (resolve(dbPath) === prodDbPath) {
    throw new Error(
      `penumbra test isolation: refusing to open production database path ${prodDbPath} under NODE_ENV=test`,
    );
  }
}
