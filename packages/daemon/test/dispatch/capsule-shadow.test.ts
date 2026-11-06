import {
  buildServices,
  classifyGitHooks,
  createLogger,
  loadSqliteVec,
  type Logger,
  migrate,
  ProjectRegistry,
  type RecallRequest,
  RecallRequestSchema,
  type RecallResult,
  type Services,
  type Watchdog,
} from "@penumbra/core";
import {
  compileCapsule,
  type CompileInput,
  type CompileResult,
  type ProbePort,
  runPreflight,
} from "@penumbra/core/dispatch/capsule";
import { digestOf } from "@penumbra/core/evals/canonical";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { autoRecallForDispatch } from "@src/dispatch/auto-recall.js";
import { type CapsuleGitPort, createCapsuleGitPort } from "@src/dispatch/capsule-probe.js";
import {
  CAPSULE_SHADOW_EVENT_KIND,
  CAPSULE_SHADOW_MAX_IN_FLIGHT,
  CAPSULE_SHADOW_TIMEOUT_MS,
  type CapsuleProbePortRequest,
  type CapsuleShadowArgs,
  type CapsuleShadowDeps,
  type CapsuleShadowMode,
  drainCapsuleShadowForTest,
  readCapsuleShadowMode,
  resetCapsuleShadowStateForTest,
  runCapsuleShadow,
  scheduleCapsuleShadow,
  setCapsuleShadowDepsForTest,
} from "@src/dispatch/capsule-shadow.js";
import { lifecycleLock } from "@src/dispatch/lifecycle-lock.js";
import { chainsStartRoute } from "@src/routes/chains.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

const STABLE_TS = "2026-04-26T00:00:00Z";
const CAPSULE_MODE_KEY = "PENUMBRA_DISPATCH_CAPSULE_MODE";
const REQUIRED_PROJECT_KEY = "PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID";
const AUTO_RECALL_ENABLED_KEY = "PENUMBRA_AUTO_RECALL_ENABLED";
const AUTO_RECALL_BRIEF_KEY = "PENUMBRA_AUTO_RECALL_PROJECT_BRIEF";
const MANAGED_ENV_KEYS = [
  CAPSULE_MODE_KEY,
  REQUIRED_PROJECT_KEY,
  AUTO_RECALL_ENABLED_KEY,
  AUTO_RECALL_BRIEF_KEY,
] as const;

const PROJECT_ID = "penumbra";
const MESSAGE = "implement capsule shadow wiring ZX-42";
const FIXED_SHA = "0123456789abcdef0123456789abcdef01234567";
const ADVISORY_TEXT = "## Relevant prior context\n\n- memo-alpha-ZX - snippet alpha";
const STALE_BASE_REFUSAL: CompileResult = {
  ok: false,
  code: "stale_base",
  detail: "base moved",
};

const ALLOWED_META_KEYS = new Set([
  "recipe_hash",
  "input_hash",
  "output_hash",
  "token_report",
  "dropped_ids",
  "refusal_code",
  "preflight_codes",
]);

const ALLOWED_SHADOW_IMPORTS = new Set([
  "@penumbra/core",
  "@penumbra/core/dispatch/capsule",
  "@penumbra/core/evals/canonical",
  "@penumbra/config",
  "./capsule-probe.js",
  "./dispatch-event-log.js",
  "node:child_process",
  "node:os",
  "node:util",
]);

const tmpDirs: string[] = [];
let savedEnv: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    Reflect.deleteProperty(process.env, key);
  }
});

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  setCapsuleShadowDepsForTest(null);
  resetCapsuleShadowStateForTest();
  globalThis.fetch = originalFetch;
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const testWatchdog: Watchdog = {
  recordHeartbeat: () => undefined,
  hasActiveWorker: () => true,
  getStaleWorkers: () => [],
  getStaleHeartbeatAges: () => [],
  tick: () => Promise.resolve(),
};

function tempServices(withProjectRegistry = false): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/capsule-shadow-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date(STABLE_TS),
    uuid: (() => {
      let n = 0;
      return (): string => `id-${String(++n)}`;
    })(),
    ...(withProjectRegistry
      ? {
          projectRegistry: new ProjectRegistry(
            new Map([[PROJECT_ID, { project_id: PROJECT_ID, root_path: "/tmp/penumbra" }]]),
          ),
        }
      : {}),
  });
  services.watchdog = testWatchdog;
  return services;
}

function fakeRecallHit(id: string, title: string): RecallResult {
  return {
    id,
    tier: "t2",
    score: 1,
    fusedScore: 1,
    sources: ["t2"],
    title,
    body: "",
    project_id: null,
    source_session_ids: [],
    created_at: STABLE_TS,
    ts: STABLE_TS,
  };
}

const RECALL_TITLES = ["memo-alpha-ZX", "memo-beta-ZX"];

function stubRecallHits(services: Services): void {
  services.recallReader.recall = (_req: RecallRequest): Promise<RecallResult[]> =>
    Promise.resolve(RECALL_TITLES.map((title, i) => fakeRecallHit(`m${String(i + 1)}`, title)));
}

interface HandoffRow {
  message: string;
}

function getHandoff(services: Services, handoff_id: string): HandoffRow {
  const row = services.db
    .query<HandoffRow, [string]>(`SELECT message FROM handoffs WHERE handoff_id=?`)
    .get(handoff_id);
  if (!row) throw new Error(`handoff not found: ${handoff_id}`);
  return row;
}

interface ChainStartBody {
  handoff_id: string;
  lane_id?: string;
}

async function startChain(
  services: Services,
  extraBody: Record<string, unknown> = {},
): Promise<{ res: Response; body: ChainStartBody }> {
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: MESSAGE,
        task_class: "STANDARD",
        project_id: PROJECT_ID,
        ...extraBody,
      }),
    }),
    services,
  );
  return { res, body: (await res.json()) as ChainStartBody };
}

interface ShadowEventRow {
  kind: string;
  meta_json: string | null;
  source: string;
  worker_id: string | null;
  ts: string;
}

function shadowEvents(services: Services, handoff_id: string): ShadowEventRow[] {
  return services.db
    .query<ShadowEventRow, [string, string]>(
      `SELECT kind, meta_json, source, worker_id, ts FROM dispatch_events
       WHERE handoff_id=? AND kind=? ORDER BY id`,
    )
    .all(handoff_id, CAPSULE_SHADOW_EVENT_KIND);
}

function eventMeta(row: ShadowEventRow): Record<string, unknown> {
  if (row.meta_json === null) return {};
  return JSON.parse(row.meta_json) as Record<string, unknown>;
}

interface RecallInjection {
  injectedText: string | null;
  message: string;
}

async function expectedRecallInjection(services: Services): Promise<RecallInjection> {
  const auto = await autoRecallForDispatch(
    { prompt: MESSAGE, task_class: "STANDARD", project_id: PROJECT_ID },
    {
      memoryRecall: async (args) => {
        const recallReq = RecallRequestSchema.parse({
          query: args.query,
          limit: args.top_k,
          project_id: args.project_id ?? null,
        });
        const results = await services.recallReader.recall(recallReq, {
          signal: args.signal,
        });
        return {
          hits: results.map((r) => ({
            id: r.id,
            title: r.title ?? "",
            snippet: r.body,
            tier: r.tier,
          })),
        };
      },
    },
  );
  const injectedText = auto.injected_text;
  return {
    injectedText,
    message: injectedText === null ? MESSAGE : `${injectedText}\n\n${MESSAGE}`,
  };
}

interface LogCall {
  level: string;
  obj: Record<string, unknown>;
  msg: string | undefined;
}

function fakeLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const record =
    (level: string): ((obj: unknown, msg?: string) => void) =>
    (obj: unknown, msg?: string): void => {
      calls.push({
        level,
        obj: typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : {},
        msg,
      });
    };
  const logger = {
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
  } as unknown as Logger;
  return { logger, calls };
}

const silentLog = createLogger({ component: "capsule-shadow-test", level: "silent" });

function fakeGitPort(): CapsuleGitPort {
  return {
    head: () => Promise.resolve(FIXED_SHA),
    resolveSha: () => Promise.resolve(FIXED_SHA),
    resolveRef: () => Promise.resolve(FIXED_SHA),
  };
}

function okProbePort(overrides: Partial<ProbePort> = {}): ProbePort {
  const port: ProbePort = {
    hasBase: () => Promise.resolve({ status: "ok" }),
    hasCode: () => Promise.resolve({ status: "ok" }),
    hasTests: () => Promise.resolve({ status: "ok" }),
    runtime: () => Promise.resolve({ status: "ok", version: "test" }),
    pathTool: () => Promise.resolve({ status: "ok" }),
    storagePath: () => Promise.resolve({ status: "ok", path: "/tmp" }),
    operatorCheckout: () => Promise.resolve({ status: "ok", path: "/tmp" }),
    artifactReadable: () => Promise.resolve({ status: "ok" }),
    hookStatus: () => Promise.resolve({ status: "ok", hooks: "not_configured" }),
  };
  return { ...port, ...overrides };
}

const REQUESTED_BASE = "fedcba9876543210fedcba9876543210fedcba98";
const OPERATOR_HEAD = FIXED_SHA;
const MISSING_BASE = "1111111111111111111111111111111111111111";

function splitGitPort(): CapsuleGitPort {
  return {
    head: () => Promise.resolve(OPERATOR_HEAD),
    resolveSha: (sha: string) =>
      Promise.resolve(sha === REQUESTED_BASE || sha === OPERATOR_HEAD ? sha : null),
    resolveRef: (ref: string) =>
      Promise.resolve(ref === "feature/base" || ref === REQUESTED_BASE ? REQUESTED_BASE : null),
  };
}

interface ProbeRecord {
  opts: CapsuleProbePortRequest[];
  worktreeCalls: number;
}

function recordingProbePort(
  record: ProbeRecord,
  mode: "ready" | "degraded" = "degraded",
): (request: CapsuleProbePortRequest) => ProbePort {
  return (request) => {
    record.opts.push(request);
    const worktreeCall = <T>(produce: () => Promise<T>): Promise<T> => {
      record.worktreeCalls += 1;
      return produce();
    };
    return okProbePort({
      hasBase: () =>
        Promise.resolve(
          request.baseSha === REQUESTED_BASE || request.baseSha === OPERATOR_HEAD
            ? { status: "ok" as const }
            : { status: "fail" as const, detail: "base commit not present" },
        ),
      hasCode: () =>
        worktreeCall(() =>
          Promise.resolve(
            mode === "ready"
              ? { status: "ok" as const }
              : { status: "fail" as const, detail: "no tracked files" },
          ),
        ),
      hasTests: () =>
        worktreeCall(() =>
          Promise.resolve(
            mode === "ready"
              ? { status: "ok" as const }
              : { status: "fail" as const, detail: "no tracked test files" },
          ),
        ),
      hookStatus: () =>
        worktreeCall(() =>
          Promise.resolve(
            mode === "ready"
              ? { status: "ok" as const, hooks: "not_configured" as const }
              : { status: "unknown" as const, detail: "hooks path unresolved" },
          ),
        ),
      storagePath: () => Promise.resolve({ status: "ok" as const, path: request.storageRoot }),
      operatorCheckout: () =>
        Promise.resolve({ status: "ok" as const, path: request.operatorCheckout }),
    });
  };
}

function shadowArgs(overrides: Partial<CapsuleShadowArgs> = {}): CapsuleShadowArgs {
  return {
    handoff_id: "h-capsule-shadow",
    objective: MESSAGE,
    project_root: "/tmp/capsule-shadow-project",
    advisory_memory: [{ source: "auto_recall", text: ADVISORY_TEXT }],
    recalled_memory_ids: ["m1"],
    ...overrides,
  };
}

function directShadowDeps(
  services: Services,
  overrides: Partial<CapsuleShadowDeps> = {},
): CapsuleShadowDeps {
  return {
    compile: compileCapsule,
    preflight: runPreflight,
    gitPort: () => fakeGitPort(),
    probePort: () => okProbePort(),
    effectiveHooksPath: () => Promise.resolve(null),
    pathExists: (path: string) => Promise.resolve(existsSync(path)),
    storageRoot: services.storageRoot,
    homeDir: join(tmpdir(), "capsule-shadow-home"),
    timeoutMs: CAPSULE_SHADOW_TIMEOUT_MS,
    log: silentLog,
    eventLog: services.dispatchEventLog,
    clock: services.clock,
    ...overrides,
  };
}

function routeShadowDeps(overrides: Partial<CapsuleShadowDeps> = {}): Partial<CapsuleShadowDeps> {
  return {
    compile: compileCapsule,
    preflight: runPreflight,
    gitPort: () => fakeGitPort(),
    probePort: () => okProbePort(),
    effectiveHooksPath: () => Promise.resolve(null),
    log: silentLog,
    ...overrides,
  };
}

function compileSpy(calls: CompileInput[], lockHeld?: boolean[]): typeof compileCapsule {
  return (input, options) => {
    calls.push(input);
    lockHeld?.push(lifecycleLock.isHeld());
    return compileCapsule(input, options);
  };
}

interface PendingCompile {
  compile: typeof compileCapsule;
  deferreds: { promise: Promise<CompileResult>; resolve: (v: CompileResult) => void }[];
}

function pendingCompile(): PendingCompile {
  const deferreds: PendingCompile["deferreds"] = [];
  const compile: typeof compileCapsule = (input) => {
    let resolveFn!: (v: CompileResult) => void;
    const promise = new Promise<CompileResult>((resolve) => {
      resolveFn = resolve;
    });
    deferreds.push({ promise, resolve: resolveFn });
    return promise;
  };
  return { compile, deferreds };
}

describe("capsule shadow dispatch boundary (#392)", () => {
  test("off mode: chain_start message, compile calls and shadow events are untouched", async () => {
    const services = tempServices(true);
    stubRecallHits(services);
    const compileCalls: CompileInput[] = [];
    setCapsuleShadowDepsForTest(routeShadowDeps({ compile: compileSpy(compileCalls) }));

    const { res, body } = await startChain(services);
    await drainCapsuleShadowForTest();

    expect(res.status).toBe(200);
    const expected = await expectedRecallInjection(services);
    expect(expected.injectedText).not.toBeNull();
    expect(getHandoff(services, body.handoff_id).message).toBe(expected.message);
    expect(compileCalls).toHaveLength(0);
    expect(shadowEvents(services, body.handoff_id)).toHaveLength(0);
  });

  test("shadow mode: one capsule_shadow event, unchanged message, hash-only meta", async () => {
    const servicesOff = tempServices(true);
    stubRecallHits(servicesOff);
    const offStart = await startChain(servicesOff);
    expect(offStart.res.status).toBe(200);
    const offHandoff = getHandoff(servicesOff, offStart.body.handoff_id);

    process.env[CAPSULE_MODE_KEY] = "shadow";
    const services = tempServices(true);
    stubRecallHits(services);
    const compileCalls: CompileInput[] = [];
    const { logger } = fakeLogger();
    setCapsuleShadowDepsForTest(
      routeShadowDeps({ compile: compileSpy(compileCalls), log: logger }),
    );

    const { res, body } = await startChain(services);
    await drainCapsuleShadowForTest();

    expect(res.status).toBe(200);
    const handoff = getHandoff(services, body.handoff_id);
    expect(handoff.message).toBe(offHandoff.message);
    const events = shadowEvents(services, body.handoff_id);
    expect(events).toHaveLength(1);
    const meta = eventMeta(events[0]!);
    for (const key of Object.keys(meta)) {
      expect(ALLOWED_META_KEYS.has(key)).toBe(true);
    }
    const tokenReport = meta["token_report"];
    expect(typeof tokenReport).toBe("object");
    expect(Object.keys(tokenReport as Record<string, unknown>).sort()).toEqual([
      "estimator",
      "limit",
      "used",
    ]);
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain(MESSAGE);
    expect(serialized).not.toContain("memo-alpha-ZX");
    expect(serialized).not.toContain("AUTHORITATIVE");
  });

  test("runCapsuleShadow dedupes identical handoff+input but not a changed input", async () => {
    const services = tempServices(true);
    const compileCalls: CompileInput[] = [];
    const deps = directShadowDeps(services, { compile: compileSpy(compileCalls) });
    const args = shadowArgs({ handoff_id: "h-dedupe" });

    await runCapsuleShadow(args, deps);
    await runCapsuleShadow(args, deps);
    await runCapsuleShadow(
      shadowArgs({ handoff_id: "h-dedupe", objective: `${MESSAGE} revised` }),
      deps,
    );

    expect(compileCalls.length).toBeGreaterThan(0);
    const events = shadowEvents(services, "h-dedupe");
    expect(events).toHaveLength(2);
  });

  test("compile throw is fail-open for direct run and route", async () => {
    const services = tempServices(true);
    const { logger, calls } = fakeLogger();
    const deps = directShadowDeps(services, {
      compile: () => {
        throw new Error("compile exploded");
      },
      log: logger,
    });

    const outcome = await runCapsuleShadow(shadowArgs(), deps).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    expect(outcome).toBe("resolved");

    const shadowErrors = calls.filter(
      (c) => c.level === "warn" && c.obj["event"] === "capsule_shadow_error",
    );
    expect(shadowErrors).toHaveLength(1);
    expect(shadowEvents(services, "h-capsule-shadow")).toHaveLength(0);

    process.env[CAPSULE_MODE_KEY] = "shadow";
    const routeServices = tempServices(true);
    stubRecallHits(routeServices);
    const { logger: routeLog } = fakeLogger();
    setCapsuleShadowDepsForTest(
      routeShadowDeps({
        compile: () => {
          throw new Error("compile exploded");
        },
        log: routeLog,
      }),
    );
    const { res, body } = await startChain(routeServices);
    await drainCapsuleShadowForTest();
    expect(res.status).toBe(200);
    const expected = await expectedRecallInjection(routeServices);
    expect(getHandoff(routeServices, body.handoff_id).message).toBe(expected.message);
  });

  test("preflight throw is fail-open for direct run and route", async () => {
    const services = tempServices(true);
    const { logger, calls } = fakeLogger();
    const deps = directShadowDeps(services, {
      preflight: () => {
        throw new Error("preflight exploded");
      },
      log: logger,
    });

    const outcome = await runCapsuleShadow(shadowArgs(), deps).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    expect(outcome).toBe("resolved");

    const shadowErrors = calls.filter(
      (c) => c.level === "warn" && c.obj["event"] === "capsule_shadow_error",
    );
    expect(shadowErrors).toHaveLength(1);
    expect(shadowEvents(services, "h-capsule-shadow")).toHaveLength(0);

    process.env[CAPSULE_MODE_KEY] = "shadow";
    const routeServices = tempServices(true);
    stubRecallHits(routeServices);
    setCapsuleShadowDepsForTest(
      routeShadowDeps({
        preflight: () => {
          throw new Error("preflight exploded");
        },
      }),
    );
    const { res, body } = await startChain(routeServices);
    await drainCapsuleShadowForTest();
    expect(res.status).toBe(200);
    const expected = await expectedRecallInjection(routeServices);
    expect(getHandoff(routeServices, body.handoff_id).message).toBe(expected.message);
  });

  test("compile refusal records refusal_code event without capsule text", async () => {
    const services = tempServices(true);
    const { logger, calls } = fakeLogger();
    const compileCalls: CompileInput[] = [];
    const deps = directShadowDeps(services, {
      compile: (input) => {
        compileCalls.push(input);
        return Promise.resolve(STALE_BASE_REFUSAL);
      },
      log: logger,
    });

    const outcome = await runCapsuleShadow(shadowArgs(), deps).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    expect(outcome).toBe("resolved");

    const events = shadowEvents(services, "h-capsule-shadow");
    expect(events).toHaveLength(1);
    const meta = eventMeta(events[0]!);
    expect(meta["refusal_code"]).toBe("stale_base");
    expect(compileCalls).toHaveLength(1);
    expect(meta["input_hash"]).toBe(digestOf(compileCalls[0]!));
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain(MESSAGE);
    expect(serialized).not.toContain("memo-alpha-ZX");
    const shadowErrors = calls.filter(
      (c) => c.level === "warn" && c.obj["event"] === "capsule_shadow_error",
    );
    expect(shadowErrors.length).toBeGreaterThan(0);

    process.env[CAPSULE_MODE_KEY] = "shadow";
    const routeServices = tempServices(true);
    stubRecallHits(routeServices);
    setCapsuleShadowDepsForTest(
      routeShadowDeps({
        compile: () => Promise.resolve(STALE_BASE_REFUSAL),
      }),
    );
    const { res, body } = await startChain(routeServices);
    await drainCapsuleShadowForTest();
    expect(res.status).toBe(200);
    const expected = await expectedRecallInjection(routeServices);
    expect(getHandoff(routeServices, body.handoff_id).message).toBe(expected.message);
  });

  test("readCapsuleShadowMode fails open to off on an invalid runtime value", () => {
    const { logger, calls } = fakeLogger();
    let mode: CapsuleShadowMode | undefined;
    expect(() => {
      mode = readCapsuleShadowMode(logger, { [CAPSULE_MODE_KEY]: "bogus" });
    }).not.toThrow();
    expect(mode).toBe("off");

    const shadowErrors = calls.filter(
      (c) => c.level === "warn" && c.obj["event"] === "capsule_shadow_error",
    );
    expect(shadowErrors).toHaveLength(1);
    expect(String(shadowErrors[0]!.obj["err"])).toContain(CAPSULE_MODE_KEY);
  });

  test("invalid runtime capsule mode fails open through chain_start without reaching the compiler", async () => {
    process.env[CAPSULE_MODE_KEY] = "bogus";
    const services = tempServices(true);
    stubRecallHits(services);
    const { logger, calls } = fakeLogger();
    services.log = logger;
    const compileCalls: CompileInput[] = [];
    setCapsuleShadowDepsForTest(routeShadowDeps({ compile: compileSpy(compileCalls) }));

    const { res, body } = await startChain(services);
    await drainCapsuleShadowForTest();

    expect(res.status).toBe(200);
    const expected = await expectedRecallInjection(services);
    expect(getHandoff(services, body.handoff_id).message).toBe(expected.message);
    expect(compileCalls).toHaveLength(0);
    expect(shadowEvents(services, body.handoff_id)).toHaveLength(0);

    const shadowErrors = calls.filter(
      (c) => c.level === "warn" && c.obj["event"] === "capsule_shadow_error",
    );
    expect(shadowErrors).toHaveLength(1);
    expect(String(shadowErrors[0]!.obj["err"])).toContain(CAPSULE_MODE_KEY);
  });

  test("scheduleCapsuleShadow never throws and logs capsule_shadow_error on buildArgs failure", async () => {
    process.env[CAPSULE_MODE_KEY] = "shadow";
    const services = tempServices(true);
    const { logger, calls } = fakeLogger();
    setCapsuleShadowDepsForTest(routeShadowDeps({ log: logger }));

    expect(() =>
      scheduleCapsuleShadow(services, () => {
        throw new Error("boom");
      }),
    ).not.toThrow();
    await drainCapsuleShadowForTest();

    const shadowErrors = calls.filter(
      (c) => c.level === "warn" && c.obj["event"] === "capsule_shadow_error",
    );
    expect(shadowErrors).toHaveLength(1);
    expect(shadowEvents(services, "h-capsule-shadow")).toHaveLength(0);
  });

  test("compile runs outside the lifecycle lock and honors the shadow timeout", async () => {
    const services = tempServices(true);
    const { logger, calls } = fakeLogger();
    const lockHeld: boolean[] = [];
    const pending = pendingCompile();
    const deps = directShadowDeps(services, {
      compile: (input, options) => {
        lockHeld.push(lifecycleLock.isHeld());
        return pending.compile(input, options);
      },
      timeoutMs: 20,
      log: logger,
    });

    const started = Date.now();
    await runCapsuleShadow(shadowArgs(), deps);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(lockHeld).toEqual([false]);
    const timeouts = calls.filter(
      (c) => c.obj["event"] === "capsule_shadow_error" && c.obj["reason"] === "timeout",
    );
    expect(timeouts).toHaveLength(1);
    pending.deferreds[0]!.resolve(STALE_BASE_REFUSAL);
  });

  test("route returns and persists the handoff while shadow compile is pending", async () => {
    process.env[CAPSULE_MODE_KEY] = "shadow";
    const services = tempServices(true);
    stubRecallHits(services);
    const pending = pendingCompile();
    const compileCalls: CompileInput[] = [];
    setCapsuleShadowDepsForTest(
      routeShadowDeps({
        compile: (input, options) => {
          compileCalls.push(input);
          return pending.compile(input, options);
        },
        timeoutMs: 20,
      }),
    );

    const { res, body } = await startChain(services);
    expect(res.status).toBe(200);
    expect(getHandoff(services, body.handoff_id).message).toBeTruthy();

    await drainCapsuleShadowForTest();
    expect(compileCalls).toHaveLength(1);
    pending.deferreds[0]!.resolve(STALE_BASE_REFUSAL);
    await drainCapsuleShadowForTest();
  });

  test("capsule shadow performs no fetch and stays inside the import allowlist", async () => {
    let fetchCalls = 0;
    globalThis.fetch = ((): Promise<Response> => {
      fetchCalls += 1;
      return Promise.reject(new Error("network forbidden"));
    }) as unknown as typeof fetch;

    const services = tempServices(true);
    await runCapsuleShadow(shadowArgs(), directShadowDeps(services));
    await drainCapsuleShadowForTest();
    expect(fetchCalls).toBe(0);

    const src = readFileSync(join(import.meta.dir, "../../src/dispatch/capsule-shadow.ts"), "utf8");
    const specifiers = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g)].map(
      (m) => m[1]!,
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(ALLOWED_SHADOW_IMPORTS.has(specifier)).toBe(true);
    }
    expect(specifiers.some((s) => /agentchat|mcp|judge|dreaming|t2-judge|provider/i.test(s))).toBe(
      false,
    );
    expect(src).not.toMatch(/PENUMBRA_[A-Z0-9_]+/);
  });

  test("compile input keeps auto-recall text advisory-only", async () => {
    process.env[CAPSULE_MODE_KEY] = "shadow";
    const services = tempServices(true);
    stubRecallHits(services);
    const compileCalls: CompileInput[] = [];
    setCapsuleShadowDepsForTest(
      routeShadowDeps({ compile: compileSpy(compileCalls), log: fakeLogger().logger }),
    );

    const { res } = await startChain(services);
    await drainCapsuleShadowForTest();
    expect(res.status).toBe(200);
    expect(compileCalls).toHaveLength(1);

    const input = compileCalls[0]!;
    const { injectedText } = await expectedRecallInjection(services);
    const injected = injectedText ?? "";
    expect(injected).not.toBe("");

    const memoryCarrier = input.advisory.memory.find((item) => item.text.includes(injected));
    expect(memoryCarrier?.authority).toBe("advisory");
    expect(memoryCarrier?.provenance.source).toBe("auto_recall");

    expect(input.objective).toBe(MESSAGE);
    expect(input.objective).not.toContain(injected);
    expect(input.acceptance_state).not.toContain(injected);
    for (const constraint of input.essential_constraints) {
      expect(constraint.text).not.toContain(injected);
    }
    expect(input.advisory.repo_map?.text ?? "").not.toContain(injected);
    for (const item of input.advisory.log_excerpts) {
      expect(item.text).not.toContain(injected);
    }
  });

  test("hook view disagreement surfaces in preflight_codes and leaves the message unchanged", async () => {
    const hooksDir = makeTmpDir("capsule-hooks-");
    writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(hooksDir, "pre-commit"), 0o755);
    expect(classifyGitHooks("/tmp", hooksDir).status).toBe("installed");

    process.env[CAPSULE_MODE_KEY] = "shadow";
    const services = tempServices(true);
    stubRecallHits(services);
    setCapsuleShadowDepsForTest(
      routeShadowDeps({
        probePort: () =>
          okProbePort({
            hookStatus: () => Promise.resolve({ status: "ok", hooks: "not_configured" }),
          }),
        effectiveHooksPath: () => Promise.resolve(hooksDir),
      }),
    );

    const { res, body } = await startChain(services);
    await drainCapsuleShadowForTest();

    expect(res.status).toBe(200);
    const expected = await expectedRecallInjection(services);
    expect(getHandoff(services, body.handoff_id).message).toBe(expected.message);

    const events = shadowEvents(services, body.handoff_id);
    expect(events).toHaveLength(1);
    const meta = eventMeta(events[0]!);
    const preflightCodes = meta["preflight_codes"];
    expect(Array.isArray(preflightCodes)).toBe(true);
    expect(preflightCodes).toContain("hook_view_disagreement");
  });

  test("chains.ts has exactly one shadow-guarded scheduleCapsuleShadow call site", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/routes/chains.ts"), "utf8");
    const callPattern = /scheduleCapsuleShadow\(/g;
    const matches = src.match(callPattern) ?? [];
    expect(matches).toHaveLength(1);
    const callIndex = src.search(callPattern);
    const before = src.slice(0, callIndex);
    const guardIndex = before.lastIndexOf('=== "shadow"');
    expect(guardIndex).toBeGreaterThan(-1);
    const ifIndexes = [...before.matchAll(/\bif\s*\(/g)].map((m) => m.index);
    const lastIfIndex = Math.max(...ifIndexes);
    expect(lastIfIndex).toBeGreaterThan(-1);
    expect(lastIfIndex).toBeLessThan(guardIndex);
    expect(before.slice(lastIfIndex, callIndex)).toContain('=== "shadow"');
  });

  test("in-flight cap admits CAPSULE_SHADOW_MAX_IN_FLIGHT runs and skips the rest until work settles", async () => {
    process.env[CAPSULE_MODE_KEY] = "shadow";
    const services = tempServices(true);
    const { logger, calls } = fakeLogger();
    const pending = pendingCompile();
    const compileCalls: CompileInput[] = [];
    setCapsuleShadowDepsForTest(
      routeShadowDeps({
        compile: (input, options) => {
          compileCalls.push(input);
          return pending.compile(input, options);
        },
        timeoutMs: 20,
        log: logger,
      }),
    );

    for (let i = 0; i < CAPSULE_SHADOW_MAX_IN_FLIGHT + 1; i += 1) {
      void scheduleCapsuleShadow(services, () => shadowArgs({ handoff_id: `h-cap-${String(i)}` }));
    }
    await drainCapsuleShadowForTest();

    expect(compileCalls).toHaveLength(CAPSULE_SHADOW_MAX_IN_FLIGHT);
    expect(shadowEvents(services, `h-cap-${String(CAPSULE_SHADOW_MAX_IN_FLIGHT)}`)).toHaveLength(0);

    void scheduleCapsuleShadow(services, () => shadowArgs({ handoff_id: "h-cap-extra" }));
    await drainCapsuleShadowForTest();
    expect(compileCalls).toHaveLength(CAPSULE_SHADOW_MAX_IN_FLIGHT);
    expect(shadowEvents(services, "h-cap-extra")).toHaveLength(0);

    const skips = calls.filter(
      (c) =>
        (c.level === "debug" || c.level === "info") &&
        c.obj["event"] === "capsule_shadow_skipped" &&
        c.obj["reason"] === "in_flight_cap",
    );
    expect(skips.length).toBeGreaterThanOrEqual(2);

    for (const d of pending.deferreds) {
      d.resolve(STALE_BASE_REFUSAL);
    }
    await drainCapsuleShadowForTest();

    void scheduleCapsuleShadow(services, () => shadowArgs({ handoff_id: "h-cap-after" }));
    await drainCapsuleShadowForTest();
    expect(compileCalls.length).toBeGreaterThan(CAPSULE_SHADOW_MAX_IN_FLIGHT);
  });

  test("daemon storage root under the operator home does not produce storage_not_isolated", async () => {
    const fakeHome = makeTmpDir("capsule-home-");
    const services = tempServices(true);
    const servicesHome: Services = { ...services, storageRoot: join(fakeHome, ".penumbra") };
    const worktreeRoot = makeTmpDir("capsule-wt-");
    const operatorRoot = makeTmpDir("capsule-op-");
    const record: ProbeRecord = { opts: [], worktreeCalls: 0 };
    setCapsuleShadowDepsForTest({
      compile: compileCapsule,
      preflight: runPreflight,
      gitPort: () => fakeGitPort(),
      probePort: recordingProbePort(record, "ready"),
      effectiveHooksPath: () => Promise.resolve(null),
      homeDir: fakeHome,
      pathExists: () => Promise.resolve(true),
      log: silentLog,
    });

    await scheduleCapsuleShadow(servicesHome, () =>
      shadowArgs({
        handoff_id: "h-home-storage",
        project_root: operatorRoot,
        dispatch_worktree_root: worktreeRoot,
      }),
    );
    await drainCapsuleShadowForTest();

    const events = shadowEvents(services, "h-home-storage");
    expect(events).toHaveLength(1);
    const meta = eventMeta(events[0]!);
    const preflightCodes = meta["preflight_codes"];
    expect(Array.isArray(preflightCodes)).toBe(true);
    expect(preflightCodes).not.toContain("storage_not_isolated");
    expect(record.opts[0]?.storageRoot).toBe(join(worktreeRoot, ".test-storage"));
  });

  test("dispatch worktree storage under the operator home still yields storage_not_isolated", async () => {
    const fakeHome = makeTmpDir("capsule-home-");
    const services = tempServices(true);
    const servicesHome: Services = { ...services, storageRoot: join(fakeHome, ".penumbra") };
    const worktreeRoot = join(fakeHome, "dispatch-wt");
    const operatorRoot = makeTmpDir("capsule-op-");
    const record: ProbeRecord = { opts: [], worktreeCalls: 0 };
    setCapsuleShadowDepsForTest({
      compile: compileCapsule,
      preflight: runPreflight,
      gitPort: () => fakeGitPort(),
      probePort: recordingProbePort(record, "ready"),
      effectiveHooksPath: () => Promise.resolve(null),
      homeDir: fakeHome,
      pathExists: () => Promise.resolve(true),
      log: silentLog,
    });

    await scheduleCapsuleShadow(servicesHome, () =>
      shadowArgs({
        handoff_id: "h-home-wt-storage",
        project_root: operatorRoot,
        dispatch_worktree_root: worktreeRoot,
      }),
    );
    await drainCapsuleShadowForTest();

    const events = shadowEvents(services, "h-home-wt-storage");
    expect(events).toHaveLength(1);
    const meta = eventMeta(events[0]!);
    const preflightCodes = meta["preflight_codes"];
    expect(Array.isArray(preflightCodes)).toBe(true);
    expect(preflightCodes).toContain("storage_not_isolated");
  });

  test("requested branch_base drives base_sha and probe baseSha, not operator HEAD", async () => {
    const services = tempServices(true);
    const compileCalls: CompileInput[] = [];
    const record: ProbeRecord = { opts: [], worktreeCalls: 0 };
    const worktreeRoot = join(makeTmpDir("capsule-wt-base-"), "not-yet-created");

    await runCapsuleShadow(
      shadowArgs({
        handoff_id: "h-base-req",
        branch_base: "feature/base",
        dispatch_worktree_root: worktreeRoot,
      }),
      directShadowDeps(services, {
        gitPort: () => splitGitPort(),
        probePort: recordingProbePort(record),
        compile: compileSpy(compileCalls),
        pathExists: () => Promise.resolve(false),
      }),
    );

    expect(compileCalls[0]?.base_sha).toBe(REQUESTED_BASE);
    const events = shadowEvents(services, "h-base-req");
    expect(events).toHaveLength(1);
    const meta = eventMeta(events[0]!);
    expect(meta["refusal_code"]).toBeUndefined();
    expect(record.opts[0]?.baseSha).toBe(REQUESTED_BASE);
  });

  test("unresolvable branch_base records base_missing and stale_base", async () => {
    const services = tempServices(true);
    const record: ProbeRecord = { opts: [], worktreeCalls: 0 };
    const worktreeRoot = join(makeTmpDir("capsule-wt-base-"), "not-yet-created");

    await runCapsuleShadow(
      shadowArgs({
        handoff_id: "h-base-missing",
        branch_base: MISSING_BASE,
        dispatch_worktree_root: worktreeRoot,
      }),
      directShadowDeps(services, {
        gitPort: () => splitGitPort(),
        probePort: recordingProbePort(record),
        pathExists: () => Promise.resolve(false),
      }),
    );

    const events = shadowEvents(services, "h-base-missing");
    expect(events).toHaveLength(1);
    const meta = eventMeta(events[0]!);
    const preflightCodes = meta["preflight_codes"];
    expect(Array.isArray(preflightCodes)).toBe(true);
    expect(preflightCodes).toContain("base_missing");
    expect(meta["refusal_code"]).toBe("stale_base");
  });

  test("absent branch_base keeps the operator HEAD base", async () => {
    const services = tempServices(true);
    const compileCalls: CompileInput[] = [];
    const worktreeRoot = join(makeTmpDir("capsule-wt-base-"), "not-yet-created");

    await runCapsuleShadow(
      shadowArgs({
        handoff_id: "h-base-head",
        dispatch_worktree_root: worktreeRoot,
      }),
      directShadowDeps(services, {
        gitPort: () => splitGitPort(),
        probePort: recordingProbePort({ opts: [], worktreeCalls: 0 }),
        compile: compileSpy(compileCalls),
        pathExists: () => Promise.resolve(false),
      }),
    );

    expect(compileCalls[0]?.base_sha).toBe(OPERATOR_HEAD);
  });

  test("missing dispatch worktree records worktree_deferred without worktree probe failures", async () => {
    const services = tempServices(true);
    const record: ProbeRecord = { opts: [], worktreeCalls: 0 };
    const worktreeRoot = join(makeTmpDir("capsule-wt-parent-"), "not-yet-created");

    await runCapsuleShadow(
      shadowArgs({
        handoff_id: "h-wt-deferred",
        dispatch_worktree_root: worktreeRoot,
      }),
      directShadowDeps(services, {
        probePort: recordingProbePort(record),
        effectiveHooksPath: () => Promise.resolve("/nonexistent-hooks"),
      }),
    );

    const events = shadowEvents(services, "h-wt-deferred");
    expect(events).toHaveLength(1);
    const meta = eventMeta(events[0]!);
    const preflightCodes = meta["preflight_codes"];
    expect(Array.isArray(preflightCodes)).toBe(true);
    expect(preflightCodes).toContain("worktree_deferred");
    for (const code of [
      "code_missing",
      "tests_missing",
      "hook_unknown",
      "hook_missing",
      "storage_not_isolated",
      "artifact_unreadable",
      "hook_view_disagreement",
    ]) {
      expect(preflightCodes).not.toContain(code);
    }
    expect(record.worktreeCalls).toBe(0);
  });

  test("route passes branch_base through to shadow base resolution", async () => {
    process.env[CAPSULE_MODE_KEY] = "shadow";
    const services = tempServices(true);
    stubRecallHits(services);
    const compileCalls: CompileInput[] = [];
    setCapsuleShadowDepsForTest(
      routeShadowDeps({
        compile: compileSpy(compileCalls),
        gitPort: () => splitGitPort(),
        pathExists: () => Promise.resolve(false),
      }),
    );

    const { res } = await startChain(services, { branch_base: "feature/base" });
    await drainCapsuleShadowForTest();

    expect(res.status).toBe(200);
    expect(compileCalls).toHaveLength(1);
    expect(compileCalls[0]?.base_sha).toBe(REQUESTED_BASE);
  });

  test("route sets dispatch_worktree_root to worktreeBaseFor/handoff_id for worktree dispatches", async () => {
    process.env[CAPSULE_MODE_KEY] = "shadow";
    for (const use_worktree of [undefined, true]) {
      const services = tempServices(true);
      stubRecallHits(services);
      const roots: string[] = [];
      setCapsuleShadowDepsForTest(
        routeShadowDeps({
          pathExists: (path: string): Promise<boolean> => {
            roots.push(path);
            return Promise.resolve(false);
          },
        }),
      );

      const { res, body } = await startChain(
        services,
        use_worktree === undefined ? {} : { use_worktree },
      );
      await drainCapsuleShadowForTest();

      expect(res.status).toBe(200);
      expect(roots).toEqual([
        join(services.worktreeManager.worktreeBaseFor(PROJECT_ID), body.handoff_id),
      ]);
    }
  });

  test("route omits dispatch_worktree_root when use_worktree is false", async () => {
    process.env[CAPSULE_MODE_KEY] = "shadow";
    const services = tempServices(true);
    stubRecallHits(services);
    const roots: string[] = [];
    const record: ProbeRecord = { opts: [], worktreeCalls: 0 };
    setCapsuleShadowDepsForTest(
      routeShadowDeps({
        pathExists: (path: string): Promise<boolean> => {
          roots.push(path);
          return Promise.resolve(false);
        },
        probePort: recordingProbePort(record),
      }),
    );

    const { res } = await startChain(services, { use_worktree: false });
    await drainCapsuleShadowForTest();

    expect(res.status).toBe(200);
    expect(roots).toEqual([]);
    expect(record.opts).toHaveLength(1);
    expect(record.opts[0]?.storageRoot).toBe("");
  });

  test("ready worktree head comes from gitPort(worktreeRoot), not the requested base", async () => {
    const repo = makeTmpDir("capsule-head-repo-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
    writeFileSync(join(repo, "base.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
    const requestedBase = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    const worktreeRoot = makeTmpDir("capsule-head-wt-");
    execFileSync("git", ["init", "-b", "work"], { cwd: worktreeRoot });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: worktreeRoot });
    execFileSync("git", ["config", "user.name", "test"], { cwd: worktreeRoot });
    writeFileSync(join(worktreeRoot, "work.txt"), "work\n");
    execFileSync("git", ["add", "."], { cwd: worktreeRoot });
    execFileSync("git", ["commit", "-m", "work"], { cwd: worktreeRoot });
    const worktreeHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreeRoot,
      encoding: "utf8",
    }).trim();
    expect(worktreeHead).not.toBe(requestedBase);

    const services = tempServices(true);
    const gitRoots: string[] = [];
    const compileCalls: CompileInput[] = [];
    const heads: (string | null)[] = [];

    await runCapsuleShadow(
      shadowArgs({
        handoff_id: "h-wt-head",
        project_root: repo,
        branch_base: requestedBase,
        dispatch_worktree_root: worktreeRoot,
      }),
      directShadowDeps(services, {
        gitPort: (root: string): CapsuleGitPort => {
          gitRoots.push(root);
          return createCapsuleGitPort({ worktreeRoot: root });
        },
        compile: (input, options) => {
          compileCalls.push(input);
          return options.git.headSha().then((head) => {
            heads.push(head);
            return compileCapsule(input, options);
          });
        },
      }),
    );

    expect(gitRoots).toContain(worktreeRoot);
    expect(heads).toEqual([worktreeHead]);
    expect(compileCalls[0]?.base_sha).toBe(requestedBase);
    const events = shadowEvents(services, "h-wt-head");
    expect(events).toHaveLength(1);
    expect(eventMeta(events[0]!)["refusal_code"]).toBe("stale_base");
  });
});
