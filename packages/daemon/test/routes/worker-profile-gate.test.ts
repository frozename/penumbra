import { buildServices, loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";

import {
  countFreshProfileEnforcingWorkers,
  countFreshScratchCapableWorkers,
  profiledLiveWorkerGateResponse,
  scratchLiveWorkerGateResponse,
  workerCanClaimProject,
  type WorkerGateServices,
  workerTokenMetadataDeclaresProfile,
  workerTokenMetadataDeclaresScratch,
} from "@src/routes/worker-profile-gate.js";

type Authz = Parameters<typeof workerCanClaimProject>[0];
type AuthzEntry = NonNullable<Authz>;

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const STALE_ENV = "PENUMBRA_WORKER_HEARTBEAT_STALE_MS";
const PROFILE = "review_readonly";
const PROFILE_META = { enforces_permission_profiles: [PROFILE] };
const SCRATCH_META = { supports_scratch_worktrees: true };
const HARD_A: AuthzEntry = { project_id: "proj-a", isolation: "hard" };

function tempServices(): WorkerGateServices {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/worker-profile-gate-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date(NOW),
    uuid: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `e-${String(n)}`;
      };
    })(),
  });
}

interface SeedRow {
  row: string;
  worker: string;
  lastSeenAt: number;
  metadata: Record<string, unknown> | null;
  revokedAt?: number;
}

function seed(services: WorkerGateServices, r: SeedRow): void {
  services.db.run(
    `INSERT INTO worker_tokens (token_hash, worker_id, issued_at, last_seen_at, revoked_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      `th-${r.row}`,
      r.worker,
      r.lastSeenAt - 60_000,
      r.lastSeenAt,
      r.revokedAt ?? null,
      r.metadata === null ? null : JSON.stringify(r.metadata),
    ],
  );
}

describe("workerCanClaimProject", () => {
  const rows: (readonly [string, Authz, string | null, boolean])[] = [
    ["no authz entry, a project", undefined, "proj-a", true],
    ["no authz entry, null project", undefined, null, true],
    ["hard, same project", HARD_A, "proj-a", true],
    ["hard, other project", HARD_A, "proj-b", false],
    ["hard, null project", HARD_A, null, false],
    ["hard without project_id, a project", { isolation: "hard" }, "proj-b", true],
    ["sticky, other project", { project_id: "proj-a", isolation: "sticky" }, "proj-b", true],
    ["shared, other project", { project_id: "proj-a", isolation: "shared" }, "proj-b", true],
  ];
  for (const [name, authz, projectId, expected] of rows) {
    test(name, () => {
      expect(workerCanClaimProject(authz, projectId)).toBe(expected);
    });
  }
});

describe("workerTokenMetadataDeclaresProfile", () => {
  const rows: (readonly [string, string | null, boolean])[] = [
    ["null metadata", null, false],
    ["empty string", "", false],
    ["malformed JSON", "{not json", false],
    ["JSON null", "null", false],
    ["empty object", "{}", false],
    ["a string instead of an array", '{"enforces_permission_profiles":"review_readonly"}', false],
    ["other profiles only", '{"enforces_permission_profiles":["other"]}', false],
    ["declares the profile", '{"enforces_permission_profiles":["review_readonly"]}', true],
    [
      "declares it among others",
      '{"enforces_permission_profiles":["other","review_readonly"]}',
      true,
    ],
  ];
  for (const [name, metadataJson, expected] of rows) {
    test(name, () => {
      expect(workerTokenMetadataDeclaresProfile(metadataJson, PROFILE)).toBe(expected);
    });
  }
});

describe("workerTokenMetadataDeclaresScratch", () => {
  const rows: (readonly [string, string | null, boolean])[] = [
    ["null metadata", null, false],
    ["empty string", "", false],
    ["malformed JSON", "{not json", false],
    ["JSON null", "null", false],
    ["empty object", "{}", false],
    ["the string 'true'", '{"supports_scratch_worktrees":"true"}', false],
    ["the number 1", '{"supports_scratch_worktrees":1}', false],
    ["false", '{"supports_scratch_worktrees":false}', false],
    ["true", '{"supports_scratch_worktrees":true}', true],
  ];
  for (const [name, metadataJson, expected] of rows) {
    test(name, () => {
      expect(workerTokenMetadataDeclaresScratch(metadataJson)).toBe(expected);
    });
  }
});

describe("fresh worker counts and live-worker gates", () => {
  let services: WorkerGateServices;
  const previousStale = process.env[STALE_ENV];

  beforeEach(() => {
    setSystemTime(new Date(NOW));
    Reflect.deleteProperty(process.env, STALE_ENV);
    services = tempServices();
  });

  afterEach(() => {
    setSystemTime();
    if (previousStale === undefined) Reflect.deleteProperty(process.env, STALE_ENV);
    else process.env[STALE_ENV] = previousStale;
  });

  test("profile count excludes revoked, stale and undeclared rows", () => {
    seed(services, { row: "ok", worker: "w-ok", lastSeenAt: NOW, metadata: PROFILE_META });
    seed(services, {
      row: "revoked",
      worker: "w-revoked",
      lastSeenAt: NOW,
      metadata: PROFILE_META,
      revokedAt: NOW,
    });
    seed(services, {
      row: "stale",
      worker: "w-stale",
      lastSeenAt: NOW - 600_000,
      metadata: PROFILE_META,
    });
    seed(services, { row: "null", worker: "w-null", lastSeenAt: NOW, metadata: null });
    seed(services, {
      row: "other",
      worker: "w-other",
      lastSeenAt: NOW,
      metadata: { enforces_permission_profiles: ["other"] },
    });
    expect(countFreshProfileEnforcingWorkers(services, PROFILE, null)).toBe(1);
  });

  test("the default 90 s window keeps a row seen exactly at the cutoff", () => {
    seed(services, {
      row: "edge",
      worker: "w-edge",
      lastSeenAt: NOW - 90_000,
      metadata: PROFILE_META,
    });
    seed(services, {
      row: "past",
      worker: "w-past",
      lastSeenAt: NOW - 90_001,
      metadata: PROFILE_META,
    });
    expect(countFreshProfileEnforcingWorkers(services, PROFILE, null)).toBe(1);
  });

  test("a positive PENUMBRA_WORKER_HEARTBEAT_STALE_MS narrows the window", () => {
    process.env[STALE_ENV] = "1000";
    seed(services, {
      row: "near",
      worker: "w-near",
      lastSeenAt: NOW - 500,
      metadata: SCRATCH_META,
    });
    seed(services, {
      row: "far",
      worker: "w-far",
      lastSeenAt: NOW - 5_000,
      metadata: SCRATCH_META,
    });
    expect(countFreshScratchCapableWorkers(services, null)).toBe(1);
  });

  test("two fresh tokens of one worker count once", () => {
    const both = { ...PROFILE_META, ...SCRATCH_META };
    seed(services, { row: "a", worker: "w-dup", lastSeenAt: NOW - 1_000, metadata: both });
    seed(services, { row: "b", worker: "w-dup", lastSeenAt: NOW, metadata: both });
    expect(countFreshProfileEnforcingWorkers(services, PROFILE, null)).toBe(1);
    expect(countFreshScratchCapableWorkers(services, null)).toBe(1);
  });

  test("scratch count reads only the worker's newest fresh token", () => {
    seed(services, {
      row: "old",
      worker: "w-flip",
      lastSeenAt: NOW - 60_000,
      metadata: SCRATCH_META,
    });
    seed(services, {
      row: "new",
      worker: "w-flip",
      lastSeenAt: NOW - 1_000,
      metadata: { other: true },
    });
    expect(countFreshScratchCapableWorkers(services, null)).toBe(0);
  });

  test("scratch count excludes revoked, stale and non-true rows", () => {
    seed(services, { row: "ok", worker: "w-ok", lastSeenAt: NOW, metadata: SCRATCH_META });
    seed(services, {
      row: "revoked",
      worker: "w-revoked",
      lastSeenAt: NOW,
      metadata: SCRATCH_META,
      revokedAt: NOW,
    });
    seed(services, {
      row: "stale",
      worker: "w-stale",
      lastSeenAt: NOW - 600_000,
      metadata: SCRATCH_META,
    });
    seed(services, {
      row: "string",
      worker: "w-string",
      lastSeenAt: NOW,
      metadata: { supports_scratch_worktrees: "true" },
    });
    expect(countFreshScratchCapableWorkers(services, null)).toBe(1);
  });

  test("a hard-isolated worker counts only for its own project", () => {
    const both = { ...PROFILE_META, ...SCRATCH_META };
    services.workerAuthz = new Map([["w-hard", HARD_A]]);
    seed(services, { row: "hard", worker: "w-hard", lastSeenAt: NOW, metadata: both });
    expect(countFreshProfileEnforcingWorkers(services, PROFILE, "proj-a")).toBe(1);
    expect(countFreshProfileEnforcingWorkers(services, PROFILE, "proj-b")).toBe(0);
    expect(countFreshProfileEnforcingWorkers(services, PROFILE, null)).toBe(0);
    expect(countFreshScratchCapableWorkers(services, "proj-a")).toBe(1);
    expect(countFreshScratchCapableWorkers(services, "proj-b")).toBe(0);
    expect(countFreshScratchCapableWorkers(services, null)).toBe(0);
  });

  test("profile gate returns 503 permission_profile_unenforceable with no eligible worker", async () => {
    seed(services, {
      row: "scratch",
      worker: "w-scratch",
      lastSeenAt: NOW,
      metadata: SCRATCH_META,
    });
    const res = profiledLiveWorkerGateResponse(services, PROFILE, null);
    expect(res?.status).toBe(503);
    expect(await res?.json()).toEqual({
      error: {
        code: "permission_profile_unenforceable",
        message: "no live worker declares enforcement of permission_profile 'review_readonly'",
        permission_profile: PROFILE,
      },
    });
  });

  test("profile gate returns null with one eligible worker", () => {
    seed(services, { row: "ok", worker: "w-ok", lastSeenAt: NOW, metadata: PROFILE_META });
    expect(profiledLiveWorkerGateResponse(services, PROFILE, null)).toBeNull();
  });

  test("scratch gate returns 503 scratch_capable_worker_unavailable with no eligible worker", async () => {
    seed(services, {
      row: "profile",
      worker: "w-profile",
      lastSeenAt: NOW,
      metadata: PROFILE_META,
    });
    const res = scratchLiveWorkerGateResponse(services, null);
    expect(res?.status).toBe(503);
    expect(await res?.json()).toEqual({
      error: {
        code: "scratch_capable_worker_unavailable",
        message: "no live worker declares scratch-worktree support",
      },
    });
  });

  test("scratch gate returns null with one eligible worker", () => {
    seed(services, { row: "ok", worker: "w-ok", lastSeenAt: NOW, metadata: SCRATCH_META });
    expect(scratchLiveWorkerGateResponse(services, null)).toBeNull();
  });
});
