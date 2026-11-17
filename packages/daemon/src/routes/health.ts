import type { Database } from "bun:sqlite";

import { SCHEMA_VERSION } from "@penumbra/core/db/schema";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { LagSampler } from "../lag-sampler.js";
import type { LlmRoleFloorEvaluation } from "../services/subsystem-health.js";
import type { T2PromotionStatus } from "../workers/t2-promotion.js";

const execFile = promisify(execFileCb);

export type ManifestBuildInfo = {
  source: "manifest";
  commit: string;
  schemaVersion: number;
  bunVersion: string;
  lockfileSha: string;
  builtAt: string;
};

export type BuildInfo =
  | ManifestBuildInfo
  | {
      source: "git";
      commit: string;
      schemaVersion: number;
    }
  | {
      source: "unknown";
      commit: null;
      schemaVersion: null;
    };

/** What /health reports: the resolved build info, or "pending" while the startup probe runs. */
export type BuildInfoSnapshot =
  | BuildInfo
  | {
      source: "pending";
      commit: null;
      schemaVersion: null;
    };

export type ResolveBuildInfoOpts = {
  root: string;
  gitHead?: () => Promise<string | null>;
};

const DEPLOY_MANIFEST_NAME = "DEPLOY_MANIFEST.json";
const UNKNOWN_BUILD: BuildInfo = { source: "unknown", commit: null, schemaVersion: null };
const PENDING_BUILD: BuildInfoSnapshot = { source: "pending", commit: null, schemaVersion: null };

function readDeployManifest(root: string): unknown {
  const manifestPath = join(root, DEPLOY_MANIFEST_NAME);
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function parseManifest(raw: unknown): ManifestBuildInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const { commit, schemaVersion, bunVersion, lockfileSha, builtAt } = m;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) return null;
  if (typeof schemaVersion !== "number") return null;
  if (typeof bunVersion !== "string") return null;
  if (typeof lockfileSha !== "string") return null;
  if (typeof builtAt !== "string" || Number.isNaN(Date.parse(builtAt))) return null;
  return { source: "manifest", commit, schemaVersion, bunVersion, lockfileSha, builtAt };
}

export async function resolveBuildInfo(opts: ResolveBuildInfoOpts): Promise<BuildInfo> {
  const { root, gitHead } = opts;
  const manifest = parseManifest(readDeployManifest(root));
  if (manifest !== null) return manifest;
  const commit = await (gitHead ?? ((): Promise<string | null> => resolveGitHead(root)))();
  if (commit !== null) {
    return { source: "git", commit, schemaVersion: SCHEMA_VERSION };
  }
  return UNKNOWN_BUILD;
}

/**
 * Starts resolving build info once and returns a synchronous reader. The reader reports
 * "pending" until the probe settles, so /health never waits on the manifest read or git.
 */
export function startBuildInfoProbe(probe: Promise<BuildInfo>): () => BuildInfoSnapshot {
  let current: BuildInfoSnapshot = PENDING_BUILD;
  probe.then(
    (info) => {
      current = info;
    },
    () => {
      current = UNKNOWN_BUILD;
    },
  );
  return () => current;
}

async function resolveGitHead(root: string): Promise<string | null> {
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  try {
    const toplevelResult = await execFile("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: gitEnv,
      timeout: 15_000,
    });
    const toplevel = toplevelResult.stdout.trim();
    if (toplevel !== realpathSync(root)) return null;
    const headResult = await execFile("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      env: gitEnv,
      timeout: 15_000,
    });
    const commit = headResult.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) return null;
    return commit;
  } catch {
    return null;
  }
}

// Mirrors T2_EMPTY_EXTRACTION_SUBSYSTEM in packages/core/src/writers/t2.ts; the
// core index sits at the max-lines cap, so the constant cannot be re-exported.
const T2_EMPTY_EXTRACTION_SUBSYSTEM = "t2.promotion.empty_extraction";
const T2_EMPTY_EXTRACTION_UNHEALTHY_THRESHOLD = 50;

type HealthRouteOpts = {
  sampler?: LagSampler;
  db?: Database;
  now?: () => Date;
  llmRoleFloors?: LlmRoleFloorEvaluation;
  t2Promotion?: T2PromotionStatus;
  build?: BuildInfoSnapshot;
};

export function healthRoute(opts: HealthRouteOpts = {}): Response {
  const payload: Record<string, unknown> = { status: "ok", version: "0.0.0" };
  if (opts.db) {
    const openLanes = opts.db
      .query(
        `SELECT COUNT(*) AS n, MIN(ts_opened) AS oldest
         FROM lane_ledger
         WHERE gate_status = 'open'`,
      )
      .get() as { n: number; oldest: string | null };
    payload.reviewBacklog = {
      open_lanes_count: openLanes.n,
      open_boundary_lanes_count: (
        opts.db
          .query(
            `SELECT COUNT(*) AS n
           FROM lane_ledger
           WHERE gate_status = 'open' AND task_class = 'BOUNDARY'`,
          )
          .get() as { n: number }
      ).n,
      oldest_open_lane_age_ms: openLanes.oldest
        ? Math.max(0, (opts.now?.() ?? new Date()).getTime() - new Date(openLanes.oldest).getTime())
        : 0,
    };
  }
  if (opts.sampler) {
    payload.lagMs = opts.sampler.maxLagMs;
  }
  if (opts.llmRoleFloors) {
    payload.llmRoleFloors = opts.llmRoleFloors;
  }
  if (opts.t2Promotion) {
    payload.t2Promotion =
      opts.t2Promotion.enabled && opts.db
        ? withT2EmptyExtractionStreak(opts.t2Promotion, opts.db)
        : opts.t2Promotion;
  }
  if (opts.build) {
    payload.build = opts.build;
  }
  return Response.json(payload);
}

function withT2EmptyExtractionStreak(status: T2PromotionStatus, db: Database): T2PromotionStatus {
  const streak =
    db
      .query<
        { consecutive_failures: number },
        [string]
      >("SELECT consecutive_failures FROM subsystem_health WHERE subsystem = ?")
      .get(T2_EMPTY_EXTRACTION_SUBSYSTEM)?.consecutive_failures ?? 0;
  return {
    ...status,
    empty_extraction_streak: streak,
    healthy: streak < T2_EMPTY_EXTRACTION_UNHEALTHY_THRESHOLD,
  };
}
