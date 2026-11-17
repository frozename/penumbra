import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DbMeta } from "./meta.js";
import { applySchema, SCHEMA_VERSION } from "./schema.js";

export const ALLOW_MIGRATE_ENV = "PENUMBRA_ALLOW_MIGRATE";
export const SCHEMA_CUTOVER_RUNBOOK = "docs/operations/schema-49-cutover.md";

const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export const DEFAULT_SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface MigrationGate {
  env: Record<string, string | undefined>;
  resolveBuildCommit?: () => string | null;
}

export interface MigrateOpts {
  embeddingDim: number;
  migrationGate?: MigrationGate;
}

function normalizeCommit(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveBuildCommit(sourceRoot: string = DEFAULT_SOURCE_ROOT): string | null {
  try {
    const stamped = normalizeCommit(readFileSync(resolve(sourceRoot, "BUILD_COMMIT"), "utf8"));
    if (COMMIT_PATTERN.test(stamped)) return stamped;
  } catch {
    // ENOENT or unreadable stamp: fall through to git.
  }
  try {
    const head = normalizeCommit(
      execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }),
    );
    if (COMMIT_PATTERN.test(head)) return head;
  } catch {
    return null;
  }
  return null;
}

function assertSchemaBumpAllowed(from: number, gate: MigrationGate): void {
  const resolveBuild = gate.resolveBuildCommit ?? ((): string | null => resolveBuildCommit());
  const commit = resolveBuild();
  const given = gate.env[ALLOW_MIGRATE_ENV]?.trim().toLowerCase() ?? "";
  const to = SCHEMA_VERSION;
  const prefix = `refusing schema_version ${String(from)} -> ${String(to)} migration: `;
  const suffix = (named: string): string =>
    ` Schema changes go through ${SCHEMA_CUTOVER_RUNBOOK}; set ${ALLOW_MIGRATE_ENV}=${named} only inside that window.`;
  if (given === "") {
    throw new Error(
      `${prefix}${ALLOW_MIGRATE_ENV} is not set.${suffix(commit ?? "<this build's full commit>")}`,
    );
  }
  if (commit === null) {
    throw new Error(
      `${prefix}this build's commit could not be determined (no BUILD_COMMIT stamp and git rev-parse HEAD failed).${suffix("<this build's full commit>")}`,
    );
  }
  if (given !== commit) {
    throw new Error(
      `${prefix}${ALLOW_MIGRATE_ENV}=${given} does not match this build (${commit}).${suffix("<this build's full commit>")}`,
    );
  }
}

export function assertEmbedderDim(db: Database, embedderDim: number, embedderName?: string): void {
  const meta = new DbMeta(db);
  const storedDim = meta.getNumber("embedding_dim");
  if (storedDim === undefined || storedDim === embedderDim) return;
  const name = embedderName ?? "unknown";
  throw new Error(
    `embedding dim mismatch: embedder '${name}' produces ${String(embedderDim)}-dim vectors but the store is ${String(storedDim)}-dim. Re-embed the corpus or fix PENUMBRA_EMBEDDINGS_DIM.`,
  );
}

function readStampedSchemaVersion(db: Database): number | undefined {
  const hasMeta = db
    .query<
      { name: string },
      []
    >("SELECT name FROM sqlite_master WHERE type='table' AND name='db_meta'")
    .get();
  if (!hasMeta) return undefined;
  return new DbMeta(db).getNumber("schema_version");
}

// applySchema is forward-only: it can add tables/columns but never removes the
// ones a newer build introduced, and a newer build may depend on constraints
// this one cannot express. Refusing beats silently re-stamping the store to an
// older version and corrupting a database an upgraded daemon still owns.
export function assertSchemaNotNewer(db: Database): void {
  const stamped = readStampedSchemaVersion(db);
  if (stamped === undefined || stamped <= SCHEMA_VERSION) return;
  throw new Error(
    `schema_version ${String(stamped)} is newer than this build supports (${String(SCHEMA_VERSION)}). ` +
      `Upgrade penumbra to a build that knows schema ${String(stamped)}; refusing to migrate.`,
  );
}

export function migrate(db: Database, opts: MigrateOpts): void {
  assertSchemaNotNewer(db);
  if (opts.migrationGate !== undefined) {
    const stamped = readStampedSchemaVersion(db);
    if (stamped !== undefined && stamped < SCHEMA_VERSION) {
      assertSchemaBumpAllowed(stamped, opts.migrationGate);
    }
  }
  applySchema(db, { embeddingDim: opts.embeddingDim });
  const meta = new DbMeta(db);
  const storedDim = meta.getNumber("embedding_dim");
  if (storedDim !== undefined && storedDim !== opts.embeddingDim) {
    throw new Error(
      `embedding_dim mismatch: stored=${String(storedDim)} requested=${String(opts.embeddingDim)}. ` +
        `Run 'penumbra reembed' to change.`,
    );
  }
  meta.set("schema_version", String(SCHEMA_VERSION));
  meta.set("embedding_dim", String(opts.embeddingDim));
}
