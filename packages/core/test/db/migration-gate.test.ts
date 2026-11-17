import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as migrations from "@src/db/migrations.js";
import { SCHEMA_VERSION } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const OLDER_VERSION = String(SCHEMA_VERSION - 1);
const CURRENT_VERSION = String(SCHEMA_VERSION);
const CUTOVER_DOC = /docs\/operations\/schema-49-cutover\.md/;

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function mkTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function stampOlderStore(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrations.migrate(db, { embeddingDim: 384 });
  db.run("UPDATE db_meta SET value=? WHERE key='schema_version'", [OLDER_VERSION]);
  return db;
}

function readSchemaVersion(db: Database): string | undefined {
  return db
    .query<{ value: string }, [string]>("SELECT value FROM db_meta WHERE key=?")
    .get("schema_version")?.value;
}

function captureError(fn: () => void): Error | undefined {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  return undefined;
}

test("migrate refuses an older store when PENUMBRA_ALLOW_MIGRATE is not set", () => {
  const db = stampOlderStore();
  const err = captureError(() => {
    migrations.migrate(db, {
      embeddingDim: 384,
      migrationGate: { env: {}, resolveBuildCommit: () => SHA_A },
    });
  });
  expect(err).toBeInstanceOf(Error);
  const message = err!.message;
  expect(message).toMatch(/PENUMBRA_ALLOW_MIGRATE/);
  expect(message).toMatch(/not set/);
  expect(message).toMatch(CUTOVER_DOC);
  expect(message).toContain(OLDER_VERSION);
  expect(message).toContain(CURRENT_VERSION);
  expect(readSchemaVersion(db)).toBe(OLDER_VERSION);
});

test("migrate refuses an older store when PENUMBRA_ALLOW_MIGRATE does not match the build commit", () => {
  const db = stampOlderStore();
  const err = captureError(() => {
    migrations.migrate(db, {
      embeddingDim: 384,
      migrationGate: { env: { PENUMBRA_ALLOW_MIGRATE: SHA_B }, resolveBuildCommit: () => SHA_A },
    });
  });
  expect(err).toBeInstanceOf(Error);
  const message = err!.message;
  expect(message).toMatch(/does not match/);
  expect(message).toMatch(CUTOVER_DOC);
  expect(message).toContain(SHA_B);
  expect(message).toContain(SHA_A);
  expect(readSchemaVersion(db)).toBe(OLDER_VERSION);
});

test("migrate refuses an older store when PENUMBRA_ALLOW_MIGRATE is only a commit prefix", () => {
  const db = stampOlderStore();
  const err = captureError(() => {
    migrations.migrate(db, {
      embeddingDim: 384,
      migrationGate: {
        env: { PENUMBRA_ALLOW_MIGRATE: SHA_A.slice(0, 12) },
        resolveBuildCommit: () => SHA_A,
      },
    });
  });
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toMatch(/does not match/);
  expect(readSchemaVersion(db)).toBe(OLDER_VERSION);
});

test("migrate refuses an older store when the build commit cannot be determined", () => {
  const db = stampOlderStore();
  const err = captureError(() => {
    migrations.migrate(db, {
      embeddingDim: 384,
      migrationGate: { env: { PENUMBRA_ALLOW_MIGRATE: SHA_A }, resolveBuildCommit: () => null },
    });
  });
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toMatch(/could not be determined/);
  expect(readSchemaVersion(db)).toBe(OLDER_VERSION);
});

test("migrate does not resolve the build commit for fresh or current stores", () => {
  // resolveBuildCommit is a new export; the typeof assertion keeps this test
  // failing by assertion instead of a TypeError until the fix lands.
  expect(typeof migrations.resolveBuildCommit).toBe("function");

  let resolveCalls = 0;
  const resolveBuildCommit = (): string | null => {
    resolveCalls += 1;
    throw new Error("resolveBuildCommit must stay lazy");
  };

  const fresh = new Database(":memory:");
  loadSqliteVec(fresh);
  migrations.migrate(fresh, {
    embeddingDim: 384,
    migrationGate: { env: {}, resolveBuildCommit },
  });
  expect(resolveCalls).toBe(0);
  expect(readSchemaVersion(fresh)).toBe(CURRENT_VERSION);

  const current = new Database(":memory:");
  loadSqliteVec(current);
  migrations.migrate(current, { embeddingDim: 384 });
  migrations.migrate(current, {
    embeddingDim: 384,
    migrationGate: { env: { PENUMBRA_ALLOW_MIGRATE: SHA_B }, resolveBuildCommit },
  });
  expect(resolveCalls).toBe(0);
  expect(readSchemaVersion(current)).toBe(CURRENT_VERSION);
});

test("migrate allows an older store when PENUMBRA_ALLOW_MIGRATE matches the build commit", () => {
  const db = stampOlderStore();
  migrations.migrate(db, {
    embeddingDim: 384,
    migrationGate: {
      env: { PENUMBRA_ALLOW_MIGRATE: `  ${SHA_A.toUpperCase()}\n` },
      resolveBuildCommit: () => SHA_A,
    },
  });
  expect(readSchemaVersion(db)).toBe(CURRENT_VERSION);
});

test("migrate refuses a newer-stamped store before consulting the migration gate", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrations.migrate(db, { embeddingDim: 384 });
  const newer = String(SCHEMA_VERSION + 1);
  db.run("UPDATE db_meta SET value=? WHERE key='schema_version'", [newer]);

  const err = captureError(() => {
    migrations.migrate(db, {
      embeddingDim: 384,
      migrationGate: { env: { PENUMBRA_ALLOW_MIGRATE: SHA_A }, resolveBuildCommit: () => SHA_A },
    });
  });
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toMatch(/newer than this build supports/);
  expect(readSchemaVersion(db)).toBe(newer);
});

test("resolveBuildCommit returns the commit stamped in BUILD_COMMIT", () => {
  expect(typeof migrations.resolveBuildCommit).toBe("function");
  const dir = mkTmpDir("penumbra-build-commit-");
  writeFileSync(join(dir, "BUILD_COMMIT"), `${SHA_A}\n`);
  expect(migrations.resolveBuildCommit(dir)).toBe(SHA_A);
});

test("resolveBuildCommit falls back to git when BUILD_COMMIT holds the export-subst placeholder", () => {
  expect(typeof migrations.resolveBuildCommit).toBe("function");
  const dir = mkTmpDir("penumbra-build-commit-git-");
  writeFileSync(join(dir, "BUILD_COMMIT"), "$Format:%H$\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "x",
    ],
    { cwd: dir },
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  expect(migrations.resolveBuildCommit(dir)).toBe(head);
});

test("resolveBuildCommit returns null without a stamp or git repository", () => {
  expect(typeof migrations.resolveBuildCommit).toBe("function");
  const dir = mkTmpDir("penumbra-build-commit-none-");
  expect(migrations.resolveBuildCommit(dir)).toBeNull();
});

test("snapshot checkouts stamp BUILD_COMMIT through git export-subst", () => {
  const repoRoot = resolve(import.meta.dir, "../../../..");
  const gitattributesPath = join(repoRoot, ".gitattributes");
  expect(existsSync(gitattributesPath)).toBe(true);
  expect(readFileSync(gitattributesPath, "utf8").split("\n")).toContain(
    "BUILD_COMMIT export-subst",
  );
  const buildCommitPath = join(repoRoot, "BUILD_COMMIT");
  expect(existsSync(buildCommitPath)).toBe(true);
  expect(readFileSync(buildCommitPath, "utf8").trim()).toBe("$Format:%H$");
});
