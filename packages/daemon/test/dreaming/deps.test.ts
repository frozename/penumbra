import { reloadAgentChatConfig } from "@penumbra/config";
import { applySchema, loadSqliteVec, type Logger } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DreamConfig, TypesafeEnvSlice } from "@src/dreaming/config.js";
import { buildDreamCycleDeps, createDreamingRewriterCandidates } from "@src/dreaming/deps.js";
import { StubJudgePool } from "@src/dreaming/judge-pool.js";
import {
  createLazyShadowSeat,
  createLazyTypesafeJudgeLoader,
  isShadowComposedPool,
  TYPESAFE_SHADOW_SUBSYSTEM,
  type TypesafeModuleLike,
  type TypesafeShadowSeat,
} from "@src/dreaming/typesafe-judge-seat.js";
import { readSubsystemHealth } from "@src/services/subsystem-health.js";

// Compile-time pin: drift between the seat's structural type and the real
// @penumbra/typesafe surface fails the daemon test program (tsconfig.test.json).
const compat: typeof import("@penumbra/typesafe") extends TypesafeModuleLike ? true : never = true;

const configDir = join(tmpdir(), `penumbra-rewriter-role-${crypto.randomUUID()}`);

const TEST_ENV: TypesafeEnvSlice = {
  PENUMBRA_TYPESAFE_BASE_URL: "https://api.typesafe.ai",
  PENUMBRA_TYPESAFE_MODEL: "jev-1.13.0",
  PENUMBRA_TYPESAFE_TIMEOUT_MS: 10_000,
  PENUMBRA_TYPESAFE_JUDGE_PROMOTION: "shadow",
};

const TWO_JUDGE_SEATS =
  "agents:\n" +
  "  - name: judge-a\n    adapter: openai-compat-http\n    api_provider: local\n    roles: [dreaming-judge]\n    options:\n      baseUrl: http://localhost:1111/v1\n" +
  "  - name: judge-b\n    adapter: openai-compat-http\n    api_provider: local\n    roles: [dreaming-judge]\n    options:\n      baseUrl: http://localhost:2222/v1\n";

const NO_JUDGE_SEATS =
  "agents:\n  - name: unrelated\n    adapter: openai-compat-http\n    roles: [other]\n    options:\n      baseUrl: http://localhost:8080/v1\n";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

afterEach(() => {
  delete process.env.PENUMBRA_CONFIG_DIR;
  delete process.env.PENUMBRA_DREAMING_REWRITER_ROLE;
  rmSync(configDir, { recursive: true, force: true });
});

function writeAgentsYaml(agentsYaml: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "agents.yaml"), agentsYaml);
  writeFileSync(join(configDir, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(configDir, "quotas.yaml"), "providers: []\n");
  process.env.PENUMBRA_CONFIG_DIR = configDir;
  reloadAgentChatConfig();
}

function openSchemaDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
  return db;
}

function makeWarnLog(): { log: Logger; warnCalls: [unknown, unknown][] } {
  const warnCalls: [unknown, unknown][] = [];
  const log = {
    warn: (...args: unknown[]): void => {
      warnCalls.push([args[0], args[1]]);
    },
  } as unknown as Logger;
  return { log, warnCalls };
}

function enabledTypesafeModule(): TypesafeModuleLike {
  return {
    resolveTypesafeSettings: () => ({
      enabled: true,
      apiKey: "test-key",
      keySource: "env",
      baseUrl: "https://api.typesafe.ai",
      model: "jev-1.13.0",
      timeoutMs: 10_000,
      judgePromotion: "shadow",
    }),
    createTypesafeClient: () => ({
      evaluate: () => Promise.reject(new Error("unreachable in test")),
    }),
    judgePromotion: () => Promise.resolve({ ok: false, reason: "transport", status: null }),
  };
}

test("falls back to the legacy dreaming rewriter environment candidate plus local secondary when no seat has its role", () => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "agents.yaml"),
    "agents:\n  - name: unrelated\n    adapter: openai-compat-http\n    roles: [other]\n    options:\n      baseUrl: http://localhost:8080/v1\n",
  );
  writeFileSync(join(configDir, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(configDir, "quotas.yaml"), "providers: []\n");
  process.env.PENUMBRA_CONFIG_DIR = configDir;
  reloadAgentChatConfig();

  const candidates = createDreamingRewriterCandidates({
    rewriterBaseUrl: "http://127.0.0.1:7944/v1",
    rewriterModel: "legacy-rewriter",
  } as DreamConfig);

  expect(candidates).toEqual([
    {
      name: "legacy-rewriter",
      baseUrl: "http://127.0.0.1:7944/v1",
      model: "legacy-rewriter",
      provider: "local",
      auth: { source: "none" },
    },
    {
      name: "lfm2-generator",
      baseUrl: "http://127.0.0.1:7944/v1",
      model: "lfm2-generator",
      provider: "local",
      auth: { source: "none" },
    },
  ]);
});

test("buildDreamCycleDeps constructs with partial dream config", () => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "agents.yaml"),
    "agents:\n  - name: unrelated\n    adapter: openai-compat-http\n    roles: [other]\n    options:\n      baseUrl: http://localhost:8080/v1\n",
  );
  writeFileSync(join(configDir, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(configDir, "quotas.yaml"), "providers: []\n");
  process.env.PENUMBRA_CONFIG_DIR = configDir;
  reloadAgentChatConfig();
  const db = new Database(":memory:");

  try {
    const deps = buildDreamCycleDeps({}, db, {} as DreamConfig);

    expect(deps.rewriterCandidates).toEqual([]);
    expect(deps.contentQualityJudge).toBeUndefined();
  } finally {
    db.close();
  }
});

test("flag off leaves the incumbent pool untouched and never loads @penumbra/typesafe", () => {
  writeAgentsYaml(TWO_JUDGE_SEATS);
  let loadCalls = 0;
  const services = {
    loadTypesafeModule: (): Promise<TypesafeModuleLike> => {
      loadCalls += 1;
      return Promise.resolve(enabledTypesafeModule());
    },
  };
  const db = openSchemaDb();
  try {
    const deps = buildDreamCycleDeps(services, db, {} as DreamConfig);
    expect(deps.judgePool).toBeDefined();
    expect(isShadowComposedPool(deps.judgePool!)).toBe(false);
    expect(loadCalls).toBe(0);

    writeAgentsYaml(NO_JUDGE_SEATS);
    const noSeatDeps = buildDreamCycleDeps(services, db, {} as DreamConfig);
    expect(noSeatDeps.judgePool).toBeInstanceOf(StubJudgePool);
    expect("judgeAll" in noSeatDeps.judgePool!).toBe(false);
  } finally {
    db.close();
  }
});

test("shadow flag composes the pool and resolves the module once per services object", async () => {
  writeAgentsYaml(TWO_JUDGE_SEATS);
  let loadCalls = 0;
  const { log } = makeWarnLog();
  const services = {
    log,
    loadTypesafeModule: (): Promise<TypesafeModuleLike> => {
      loadCalls += 1;
      return Promise.resolve(enabledTypesafeModule());
    },
  };
  const dreamConfig = {
    typesafeJudgePromotion: "shadow",
    typesafeEnv: TEST_ENV,
  } as DreamConfig;
  const db = openSchemaDb();
  try {
    const deps = buildDreamCycleDeps(services, db, dreamConfig);
    expect(isShadowComposedPool(deps.judgePool!)).toBe(true);
    await Bun.sleep(0);
    expect(loadCalls).toBe(1);

    const rebuilt = buildDreamCycleDeps(services, db, dreamConfig);
    expect(isShadowComposedPool(rebuilt.judgePool!)).toBe(true);
    await Bun.sleep(0);
    expect(loadCalls).toBe(1);
  } finally {
    db.close();
  }
});

test("lazy loader memoizes a disabled resolution and the lazy seat stays unbuilt", async () => {
  const db = openSchemaDb();
  try {
    let resolveCalls = 0;
    let clientCalls = 0;
    const { log, warnCalls } = makeWarnLog();
    const mod: TypesafeModuleLike = {
      resolveTypesafeSettings: () => {
        resolveCalls += 1;
        return { enabled: false, reason: "no_key", judgePromotion: "shadow" };
      },
      createTypesafeClient: () => {
        clientCalls += 1;
        return { evaluate: () => Promise.reject(new Error("unreachable in test")) };
      },
      judgePromotion: () => Promise.resolve({ ok: false, reason: "transport", status: null }),
    };
    const loader = createLazyTypesafeJudgeLoader(() => Promise.resolve(mod), {
      env: TEST_ENV,
      log,
    });
    expect(await loader()).toEqual({ disabled: "no_key" });
    expect(await loader()).toEqual({ disabled: "no_key" });
    expect(resolveCalls).toBe(1);
    expect(clientCalls).toBe(0);
    expect(warnCalls).toEqual([[{ reason: "no_key" }, "typesafe shadow judge disabled"]]);

    let seatBuilds = 0;
    const seat = createLazyShadowSeat(loader, (): TypesafeShadowSeat => {
      seatBuilds += 1;
      return { shadow: () => Promise.resolve() };
    });
    await seat.shadow(
      {
        body: "durable finding that must never reach a constructed seat",
        kind: "promote_t1",
        subjectId: "r1",
      },
      Promise.resolve(null),
    );
    expect(seatBuilds).toBe(0);
    expect(readSubsystemHealth(db, TYPESAFE_SHADOW_SUBSYSTEM)).toBeNull();

    const rejectingLoader = createLazyTypesafeJudgeLoader(
      () => Promise.reject(new Error("module missing")),
      { env: TEST_ENV },
    );
    expect(await rejectingLoader()).toEqual({ disabled: "import_failed" });
  } finally {
    db.close();
  }
});

test("lazy loader resolves disabled and never builds the client when settings resolution throws", async () => {
  let clientCalls = 0;
  const { log, warnCalls } = makeWarnLog();
  const baseMod = enabledTypesafeModule();
  const mod: TypesafeModuleLike = {
    ...baseMod,
    resolveTypesafeSettings: () => {
      throw new Error("boom");
    },
    createTypesafeClient: (options) => {
      clientCalls += 1;
      return baseMod.createTypesafeClient(options);
    },
  };
  const loader = createLazyTypesafeJudgeLoader(() => Promise.resolve(mod), {
    env: TEST_ENV,
    log,
  });
  const first = await loader().catch((err: unknown) => ({ rejected: err }));
  const second = await loader().catch((err: unknown) => ({ rejected: err }));
  expect(first).toEqual({ disabled: "load_failed" });
  expect(second).toEqual({ disabled: "load_failed" });
  expect(warnCalls).toEqual([[{ reason: "load_failed" }, "typesafe shadow judge disabled"]]);
  expect(JSON.stringify(warnCalls)).not.toContain("boom");
  expect(clientCalls).toBe(0);
});

test("lazy loader resolves disabled when client construction throws", async () => {
  const { log, warnCalls } = makeWarnLog();
  const mod: TypesafeModuleLike = {
    ...enabledTypesafeModule(),
    createTypesafeClient: () => {
      throw new Error("boom");
    },
  };
  const loader = createLazyTypesafeJudgeLoader(() => Promise.resolve(mod), {
    env: TEST_ENV,
    log,
  });
  const first = await loader().catch((err: unknown) => ({ rejected: err }));
  const second = await loader().catch((err: unknown) => ({ rejected: err }));
  expect(first).toEqual({ disabled: "load_failed" });
  expect(second).toEqual({ disabled: "load_failed" });
  expect(warnCalls).toEqual([[{ reason: "load_failed" }, "typesafe shadow judge disabled"]]);
  expect(JSON.stringify(warnCalls)).not.toContain("boom");
});

test("boot with a throwing settings resolution leaves no unhandled rejection and incumbent votes still flow", async () => {
  writeAgentsYaml(TWO_JUDGE_SEATS);
  const { log, warnCalls } = makeWarnLog();
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const db = openSchemaDb();
  try {
    const services = {
      log,
      loadTypesafeModule: (): Promise<TypesafeModuleLike> =>
        Promise.resolve({
          ...enabledTypesafeModule(),
          resolveTypesafeSettings: () => {
            throw new Error("boom");
          },
        }),
    };
    const deps = buildDreamCycleDeps(services, db, {
      typesafeJudgePromotion: "shadow",
      typesafeEnv: TEST_ENV,
    } as DreamConfig);
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(unhandled).toEqual([]);
    expect(warnCalls).toContainEqual([{ reason: "load_failed" }, "typesafe shadow judge disabled"]);
    const votes = await deps.judgePool!.judgeAll!({
      body: "a durable finding worth keeping",
      kind: "promote_t1",
      subjectId: "r1",
    });
    expect(votes.map((vote) => vote.seat)).toEqual(["judge-a", "judge-b"]);
    await Bun.sleep(0);
    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    db.close();
  }
});

test("a malformed agents.yaml surfaces the judge-pool warn on services.log", () => {
  writeAgentsYaml("agents: [unclosed\n");
  const { log, warnCalls } = makeWarnLog();
  const db = openSchemaDb();
  try {
    buildDreamCycleDeps({ log }, db, {} as DreamConfig);
    expect(
      warnCalls.some(([, msg]) =>
        String(msg).includes("failed to load agentchat config for judge pool"),
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});

const TYPESAFE_VALUE_IMPORT =
  /^\s*(?:import\s*["']|(?:import|export)\s(?!type\b)[^;]*?from\s*["'])@penumbra\/typesafe/m;

function staticallyValueImportsTypesafe(source: string): boolean {
  return TYPESAFE_VALUE_IMPORT.test(source);
}

test("the value-import tripwire flags side-effect imports of @penumbra/typesafe", () => {
  expect(staticallyValueImportsTypesafe('import "@penumbra/typesafe";')).toBe(true);
  expect(staticallyValueImportsTypesafe("import '@penumbra/typesafe'")).toBe(true);
  expect(staticallyValueImportsTypesafe('import { x } from "@penumbra/typesafe";')).toBe(true);
  expect(staticallyValueImportsTypesafe('export * from "@penumbra/typesafe";')).toBe(true);
  expect(staticallyValueImportsTypesafe('import type { X } from "@penumbra/typesafe";')).toBe(
    false,
  );
  expect(staticallyValueImportsTypesafe('const m = () => import("@penumbra/typesafe");')).toBe(
    false,
  );
});

test("no file under packages/daemon/src statically value-imports @penumbra/typesafe", () => {
  const srcRoot = join(import.meta.dir, "..", "..", "src");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        staticallyValueImportsTypesafe(readFileSync(full, "utf8"))
      ) {
        offenders.push(full);
      }
    }
  };
  walk(srcRoot);
  expect(offenders).toEqual([]);
  expect(compat).toBe(true);
});
