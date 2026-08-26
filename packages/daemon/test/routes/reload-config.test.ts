import type { Logger } from "pino";

import { loadAgentChatConfigFromDir } from "@penumbra/config";
import {
  type AaSnapshotStorePayload,
  buildServices,
  loadSqliteVec,
  migrate,
  type Services,
  type WorkerControlBus,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { buildRegistry as buildWorkflowRegistry } from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { load as parseYaml, dump as stringifyYaml } from "js-yaml";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonServices } from "../../src/serve.js";
import type { ExtraWorkerSupervisor } from "../../src/workers/supervisor.js";

import { formatAgentChatConfigError } from "../../src/agentchat-config.js";
import { reloadConfigRoute } from "../../src/routes/reload-config.js";

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch (err) {
  void err;
}

// ─── typed test helpers ────────────────────────────────────────────────────

/** Daemon route handlers expect the augmented `DaemonServices` shape.
 *  `Services` from core lacks optional daemon-only extras (extraWorkerSupervisor, etc.);
 *  this narrows safely since the extras are all optional fields on the intersection. */
function asDaemonServices(services: Services): DaemonServices {
  return services as DaemonServices;
}

type LogFnKey = "info" | "warn" | "error" | "debug" | "trace" | "fatal";

/** Logger.info/warn/error are pino overloads; mockImplementation requires the union signature.
 *  Centralized cast satisfies the overload set without leaking `any` to callers. */
function noopLogFn(key: LogFnKey): Logger[LogFnKey] {
  void key;
  return (..._args: unknown[]): undefined => undefined;
}

/** ExtraWorkerSupervisor is a class with many private fields; tests only need `reconcile`. */
function asExtraWorkerSupervisor(
  mock: Pick<ExtraWorkerSupervisor, "reconcile">,
): ExtraWorkerSupervisor {
  return mock as unknown as ExtraWorkerSupervisor;
}

/** WorkerControlBus is a class with a private listener set; tests only need `subscribe`/`emit`. */
function asWorkerControlBus(mock: Pick<WorkerControlBus, "subscribe" | "emit">): WorkerControlBus {
  return mock as unknown as WorkerControlBus;
}

interface NamedWorkflowSpec {
  name: string;
  description: string;
}
interface NamedWorkflowRegistry {
  list(): NamedWorkflowSpec[];
  get(name: string): NamedWorkflowSpec | undefined;
}
/** WorkflowRegistry from core is generic over Spec=unknown; tests want the markdown-spec shape. */
function asNamedWorkflowRegistry(reg: unknown): NamedWorkflowRegistry {
  return reg as NamedWorkflowRegistry;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ─── body type shapes returned by reloadConfigRoute ────────────────────────

interface ReloadBody {
  ok?: boolean;
  agent_count?: number;
  workflow_count?: number;
  reloaded_at?: string;
  reactor_status?: string;
  reactor_error?: string;
  worker_extras?: {
    started?: string[];
    restarted?: string[];
    stopped?: string[];
    skipped?: string[];
    errors?: { worker_id: string; message: string }[];
    error?: string;
  };
  error?: string;
}

afterEach(() => {
  delete process.env.PENUMBRA_CONFIG_DIR;
  delete process.env.PENUMBRA_WORKERS_CONFIG_PATH;
});

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempServices(opts?: {
  agentRegistry?: string[] | null;
  workflowDirs?: { playbooksDir: string; workflowsDir: string };
}): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const worktreeRootDir = mkdtempSync(join(tmpdir(), "reload-config-worktrees-"));
  tempDirs.push(worktreeRootDir);
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/reload-config-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-26T00:00:00Z"),
    uuid: () => `id-${String(++n)}`,
    agentRegistry: opts?.agentRegistry ?? ["planner", "executor"],
    worktreeRootDir,
  });
  // Default to an empty tmp dir so workflow_count is deterministic and the
  // route doesn't pick up the live repo's playbooks during tests.
  const dirs =
    opts?.workflowDirs ??
    ((): { playbooksDir: string; workflowsDir: string } => {
      const root = mkdtempSync(join(tmpdir(), "reload-cfg-empty-"));
      tempDirs.push(root);
      return { playbooksDir: join(root, "playbooks"), workflowsDir: join(root, "workflows") };
    })();
  asDaemonServices(services).workflowDirs = dirs;
  return services;
}

async function withTempHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "reload-config-home-"));
  tempDirs.push(home);
  const previousHome = process.env.HOME;
  const previousWorkersConfigPath = process.env.PENUMBRA_WORKERS_CONFIG_PATH;
  process.env.HOME = home;
  process.env.PENUMBRA_WORKERS_CONFIG_PATH = join(home, ".config", "penumbra", "workers.yaml");
  try {
    return await fn(home);
  } finally {
    process.env.HOME = previousHome;
    if (previousWorkersConfigPath === undefined) {
      delete process.env.PENUMBRA_WORKERS_CONFIG_PATH;
    } else {
      process.env.PENUMBRA_WORKERS_CONFIG_PATH = previousWorkersConfigPath;
    }
  }
}

function writeWorkersYaml(home: string, content: string): string {
  const workersPath = join(home, ".config", "penumbra", "workers.yaml");
  mkdirSync(join(home, ".config", "penumbra"), { recursive: true });
  writeFileSync(workersPath, content);
  return workersPath;
}

function writeSplitAgentchatConfig(configDir: string, content: string): void {
  const parsed = (parseYaml(content) ?? {}) as Record<string, unknown>;
  const agentsDoc: Record<string, unknown> = { ...parsed };
  delete agentsDoc.default_roles;
  delete agentsDoc.role_routing;
  delete agentsDoc.providers;

  const routingDoc: Record<string, unknown> = {
    default_roles: parsed.default_roles ?? {},
  };
  if (parsed.role_routing !== undefined) {
    routingDoc.role_routing = parsed.role_routing;
  }

  const quotasDoc: Record<string, unknown> = {
    providers: Array.isArray(parsed.providers) ? parsed.providers : [],
  };

  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "agents.yaml"), stringifyYaml(agentsDoc));
  writeFileSync(join(configDir, "routing.yaml"), stringifyYaml(routingDoc));
  writeFileSync(join(configDir, "quotas.yaml"), stringifyYaml(quotasDoc));
}

test("POST /agentchat/reload replaces agentRegistry and returns info", async () => {
  const services = tempServices();
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat.yaml");

  writeAgentchat(
    yamlPath,
    `
  agents:
  - name: test-agent-1
    adapter: mock
  - name: test-agent-2
    adapter: mock
  `,
  );
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  const infoSpy = spyOn(services.log, "info").mockImplementation(noopLogFn("info"));
  try {
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<ReloadBody>(res);
    expect(body.ok).toBe(true);
    expect(body.agent_count).toBe(2);
    expect(body.reloaded_at).toBe("2026-04-26T00:00:00.000Z");
    expect(services.agentRegistry).toEqual(["test-agent-1", "test-agent-2"]);
    expect(services.agentRouting?.role_exploration_policy).toBe("unsampled-first");
    expect(body.project_registry_count).toBe(services.projectRegistry?.list().length ?? 0);
    expect(infoSpy).toHaveBeenCalledWith(
      {
        agent_count: 2,
        prev_count: 2,
        workflow_count: 0,
        project_registry_count: services.projectRegistry?.list().length ?? 0,
        reactor_status: "absent",
      },
      "agentchat-config-reloaded",
    );
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test("POST /agentchat/reload swaps role exploration policy from agentchat config", async () => {
  const services = tempServices();
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat-routing.yaml");

  writeAgentchat(
    yamlPath,
    `
agents:
  - name: test-agent-1
    adapter: mock
    roles: [executor]
default_roles:
  executor: test-agent-1
role_routing:
  exploration_policy: ranked-first
`,
  );
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    expect(services.agentRouting?.role_exploration_policy).toBe("ranked-first");
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test("POST /agentchat/reload reloads the long-lived reactor when present", async () => {
  const services = tempServices();
  let reloadCalls = 0;
  asDaemonServices(services).longLivedReactor = {
    manualTick: (): { outcome: string } => ({ outcome: "noop" }),
    reload: (): Promise<void> => {
      reloadCalls += 1;
      return Promise.resolve();
    },
    shutdown: (): Promise<void> => Promise.resolve(),
  };
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLogFn("warn"));
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat-reactor.yaml");

  writeAgentchat(
    yamlPath,
    `
agents:
  - name: test-agent-1
    adapter: mock
`,
  );
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<ReloadBody>(res);
    expect(body.reactor_status).toBe("reloaded");
    expect(body.reactor_error).toBeUndefined();
    expect(reloadCalls).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test("POST /agentchat/reload soft-fails long-lived reactor reload errors", async () => {
  const services = tempServices();
  asDaemonServices(services).longLivedReactor = {
    manualTick: (): { outcome: string } => ({ outcome: "noop" }),
    reload: (): Promise<void> => Promise.reject(new Error("reactor exploded")),
    shutdown: (): Promise<void> => Promise.resolve(),
  };
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLogFn("warn"));
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat-reactor-fail.yaml");

  writeAgentchat(yamlPath);
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<ReloadBody>(res);
    expect(body.ok).toBe(true);
    expect(body.agent_count).toBe(1);
    expect(body.reactor_status).toBe("failed");
    expect(body.reactor_error).toBe("reactor exploded");
    expect(warnSpy).toHaveBeenCalledWith(
      { error: "reactor exploded" },
      "long-lived-reactor-reload-failed",
    );
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test("POST /agentchat/reload refreshes providerQuotas from agentchat config", async () => {
  const services = tempServices();
  services.providerQuotas = [{ provider: "placeholder", quota_usd_per_24h: 1 }];
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat-providers.yaml");

  writeAgentchat(
    yamlPath,
    `
agents:
  - name: test-agent-1
    adapter: mock
providers:
  - name: anthropic
    model: claude-sonnet-4
    pressure_caps:
      five_hour:
        warn: 80
        refuse: 95
  - name: gemini
    model: gemini-2.5-pro
    pressure_caps:
      five_hour: 90
`,
  );
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    expect(services.providerQuotas).toEqual([
      {
        provider: "anthropic",
        model: "claude-sonnet-4",
        quota_usd_per_24h: undefined,
        quota_tokens_per_24h: undefined,
        quota_tokens_per_5h: undefined,
        pressure_caps: {
          five_hour: {
            warn: 80,
            refuse: 95,
          },
        },
      },
      {
        provider: "gemini",
        model: "gemini-2.5-pro",
        quota_usd_per_24h: undefined,
        quota_tokens_per_24h: undefined,
        quota_tokens_per_5h: undefined,
        pressure_caps: {
          five_hour: {
            warn: null,
            refuse: 90,
          },
        },
      },
    ]);
    expect(services.providerQuotas.some((entry) => entry.provider === "placeholder")).toBe(false);
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test("POST /agentchat/reload warns when routing references missing agents", async () => {
  const services = tempServices();
  const warnSpy = spyOn(services.log, "warn").mockImplementation(noopLogFn("warn"));
  const configDir = mkdtempSync(join(tmpdir(), "reload-config-missing-agent-"));
  writeFileSync(
    join(configDir, "agents.yaml"),
    `
agents:
  - name: known-agent
    adapter: mock
`,
  );
  writeFileSync(
    join(configDir, "routing.yaml"),
    `
default_roles:
  executor: known-agent
personas:
  risk:
    preferred_agent: missing-reviewer
    bias: risk
    system_prompt: Check risk.
workloads:
  review_adversarial:
    eligible_roles: [reviewer]
    synthesizer: known-agent
`,
  );
  writeFileSync(join(configDir, "quotas.yaml"), "providers: []\n");

  process.env.PENUMBRA_CONFIG_DIR = configDir;
  try {
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(
      {
        missing_agents: [
          {
            path: "personas.risk.preferred_agent",
            agent: "missing-reviewer",
          },
        ],
      },
      "agentchat-routing-references-missing-agents",
    );
  } finally {
    warnSpy.mockRestore();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("POST /agentchat/reload returns 422 if file missing", async () => {
  const services = tempServices();
  process.env.PENUMBRA_CONFIG_DIR = "/tmp/does-not-exist.yaml";
  const res = await reloadConfigRoute(
    new Request("http://x/agentchat/reload", { method: "POST" }),
    services,
  );
  expect(res.status).toBe(422);
  const body = await readJson<ReloadBody>(res);
  expect(body.error).toContain("not found");
  expect(services.agentRegistry).toEqual(["planner", "executor"]); // untouched
});

test("POST /agentchat/reload returns 422 and does not swap if yaml invalid", async () => {
  const services = tempServices();
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat-invalid.yaml");

  writeAgentchat(
    yamlPath,
    `
agents:
  - no_name: true
`,
  );

  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(422);
    const body = await readJson<ReloadBody>(res);
    expect(body.error).toContain("agents.0.name");
    expect(services.agentRegistry).toEqual(["planner", "executor"]); // untouched
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test("POST /agentchat/reload honors PENUMBRA_CONFIG_DIR", async () => {
  const services = tempServices();
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat-alt.yaml");

  writeAgentchat(
    yamlPath,
    `
agents:
  - name: override-agent
    adapter: mock
`,
  );

  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    expect(services.agentRegistry).toEqual(["override-agent"]);
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test("POST /agentchat/reload refreshes agentchatConfig and shellConfig", async () => {
  const services = tempServices();
  const runtime = asDaemonServices(services);
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat-shell.yaml");

  writeAgentchat(
    yamlPath,
    `
agents:
  - name: shell-agent
    adapter: mock
shell:
  enabled: true
  dangerous_commands:
    - '^danger\\b'
`,
  );
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  try {
    let res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    expect(runtime.agentchatConfig?.agents?.[0]?.name).toBe("shell-agent");
    expect(runtime.agentchatConfig?.agents?.[0]?.auto_approve_to ?? []).toEqual([]);
    expect(runtime.shellConfig?.enabled).toBe(true);
    expect(runtime.shellConfig?.dangerousCommandsForAgent("shell-agent")).toEqual(["^danger\\b"]);

    writeAgentchat(
      yamlPath,
      `
agents:
  - name: shell-agent
    adapter: mock
    auto_approve_to: [shell_run]
shell:
  enabled: true
  dangerous_commands:
    - '^rm\\b'
`,
    );
    res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    expect(runtime.agentchatConfig?.agents?.[0]?.auto_approve_to).toEqual(["shell_run"]);
    expect(runtime.shellConfig?.dangerousCommandsForAgent("shell-agent")).toEqual(["^rm\\b"]);
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

const PLAYBOOK_V1 = `---
name: alpha
description: v1
triggers:
  - kind: manual
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
template v1
`;

const PLAYBOOK_V2 = `---
name: alpha
description: v2
triggers:
  - kind: manual
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
template v2
`;

const PLAYBOOK_BETA = `---
name: beta
description: b
triggers:
  - kind: manual
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
template b
`;

function writeAgentchat(path: string, content?: string): void {
  writeSplitAgentchatConfig(
    path,
    content ??
      `
agents:
  - name: test-agent
    adapter: mock
`,
  );
}

function reloadAaSnapshotPayload(id: string): AaSnapshotStorePayload {
  return {
    provenance: { collectedAt: "2026-04-26T00:00:00Z" },
    models: [
      {
        id: `aa:${id}`,
        name: `Model ${id}`,
        slug: `model-${id}`,
        model_creator: { id: `creator:${id}`, name: `Creator ${id}`, slug: `creator-${id}` },
        evaluations: {},
        pricing: {},
      },
    ],
  };
}

test("POST /agentchat/reload replaces the AA snapshot store with the active router TTL", async () => {
  await withTempHome(async (home) => {
    const services = tempServices();
    // Bun's os.homedir() ignores a process.env.HOME override, so the
    // reload route's default `~/.penumbra/aa-snapshot.json` store would
    // otherwise write through to the operator's real snapshot file.
    asDaemonServices(services).aaSnapshotPath = join(home, ".penumbra", "aa-snapshot.json");
    const configDir = mkdtempSync(join(tmpdir(), "reload-router-aa-"));
    tempDirs.push(configDir);
    writeAgentchat(configDir);
    writeFileSync(join(configDir, "router.yaml"), "mode: shadow\nsnapshot_ttl_seconds: 1\n");
    process.env.PENUMBRA_CONFIG_DIR = configDir;

    const bootStore = services.aaSnapshotStore;
    const firstRes = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(firstRes.status).toBe(200);
    expect(services.aaSnapshotStore).not.toBe(bootStore);
    await services.aaSnapshotStore.write(reloadAaSnapshotPayload("one"));
    const firstRead = services.aaSnapshotStore.readSync();
    expect(firstRead.state).toBe("available");
    if (firstRead.state !== "available")
      throw new Error("expected AA snapshot store to be readable");
    expect(firstRead.snapshot.ttlSeconds).toBe(1);

    const firstReloadStore = services.aaSnapshotStore;
    writeFileSync(join(configDir, "router.yaml"), "mode: shadow\nsnapshot_ttl_seconds: 7200\n");
    const secondRes = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(secondRes.status).toBe(200);
    expect(services.aaSnapshotStore).not.toBe(firstReloadStore);
    await services.aaSnapshotStore.write(reloadAaSnapshotPayload("two"));
    const secondRead = services.aaSnapshotStore.readSync();
    expect(secondRead.state).toBe("available");
    if (secondRead.state !== "available")
      throw new Error("expected reloaded AA snapshot store to be readable");
    expect(secondRead.snapshot.ttlSeconds).toBe(7200);
  });
});

test("POST /agentchat/reload rebuilds workflow registry from disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "reload-cfg-wf-"));
  const playbooksDir = join(root, "playbooks");
  const workflowsDir = join(root, "workflows");
  mkdirSync(join(playbooksDir, "alpha"), { recursive: true });
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(playbooksDir, "alpha", "playbook.md"), PLAYBOOK_V1);

  const services = tempServices({ workflowDirs: { playbooksDir, workflowsDir } });
  // Pre-populate registry as the daemon would at boot, then mutate disk.
  services.workflowRegistry = await buildWorkflowRegistry({ playbooksDir, workflowsDir });
  expect(services.workflowRegistry.get("alpha")?.description).toBe("v1");

  // Add a second playbook + edit the first.
  mkdirSync(join(playbooksDir, "beta"), { recursive: true });
  writeFileSync(join(playbooksDir, "beta", "playbook.md"), PLAYBOOK_BETA);
  writeFileSync(join(playbooksDir, "alpha", "playbook.md"), PLAYBOOK_V2);

  const yamlPath = join(root, "agentchat.yaml");
  writeAgentchat(yamlPath);
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;

  try {
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<ReloadBody>(res);
    expect(body.ok).toBe(true);
    expect(body.workflow_count).toBe(2);
    const reg = asNamedWorkflowRegistry(services.workflowRegistry);
    expect(
      reg
        .list()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
    expect(reg.get("alpha")?.description).toBe("v2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /agentchat/reload returns 500 and keeps old workflow registry on rebuild failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "reload-cfg-wf-bad-"));
  const goodPlaybooks = join(root, "playbooks");
  const workflowsDir = join(root, "workflows");
  mkdirSync(join(goodPlaybooks, "alpha"), { recursive: true });
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(goodPlaybooks, "alpha", "playbook.md"), PLAYBOOK_V1);

  // Build the initial (good) registry.
  const services = tempServices({ workflowDirs: { playbooksDir: goodPlaybooks, workflowsDir } });
  const runtime = asDaemonServices(services);
  services.workflowRegistry = await buildWorkflowRegistry({
    playbooksDir: goodPlaybooks,
    workflowsDir,
  });
  const originalRegistry = services.workflowRegistry;
  expect(originalRegistry.get("alpha")?.description).toBe("v1");
  const yamlPath = join(root, "agentchat.yaml");
  writeAgentchat(
    yamlPath,
    `
agents:
  - name: old-agent
    adapter: mock
`,
  );
  expect(loadAgentChatConfigFromDir(yamlPath).agents[0]?.name).toBe("old-agent");
  services.agentRegistry = ["old-agent"];
  runtime.agentchatConfig = {
    agents: [{ name: "old-agent", adapter: "mock" }],
  };
  const originalAgentchatConfig = runtime.agentchatConfig;
  const emitSpy = vi.fn();
  services.workerControl = asWorkerControlBus({
    subscribe: () => (): undefined => undefined,
    emit: emitSpy,
  });

  // Now point the route at a path that's a regular file, not a directory —
  // existsSync passes but readdirSync throws ENOTDIR, which buildRegistry
  // surfaces as a thrown error rather than collecting in errors[].
  const badPath = join(root, "not-a-dir");
  writeFileSync(badPath, "definitely not a directory");
  runtime.workflowDirs = {
    playbooksDir: badPath,
    workflowsDir,
  };

  writeAgentchat(
    yamlPath,
    `
agents:
  - name: new-agent
    adapter: mock
`,
  );
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;
  const errSpy = spyOn(services.log, "error").mockImplementation(noopLogFn("error"));
  try {
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(500);
    const body = await readJson<ReloadBody>(res);
    expect(body.error).toContain("workflow registry rebuild failed");
    expect(services.workflowRegistry).toBe(originalRegistry);
    expect(services.workflowRegistry.get("alpha")?.description).toBe("v1");
    expect(services.agentRegistry).toEqual(["old-agent"]);
    expect(runtime.agentchatConfig).toBe(originalAgentchatConfig);
    expect(loadAgentChatConfigFromDir(yamlPath).agents[0]?.name).toBe("old-agent");
    expect(emitSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatAgentChatConfigError redacts apiKey/token/secret fields", () => {
  const formatted = formatAgentChatConfigError(
    new Error(
      'agentchat config invalid: agents.0.options.apiKey: got "sk-live-123"; agents.1.options.token: received abc123; agents.2.options.secret: bad value',
    ),
  );
  expect(formatted).toContain("agents.0.options.apiKey: <redacted>");
  expect(formatted).toContain("agents.1.options.token: <redacted>");
  expect(formatted).toContain("agents.2.options.secret: <redacted>");
  expect(formatted).not.toContain("sk-live-123");
  expect(formatted).not.toContain("abc123");
});

test("POST /agentchat/reload returns empty worker_extras when workers.yaml is absent", async () => {
  const services = tempServices();
  const reconcile = vi.fn(() =>
    Promise.resolve({
      started: [],
      restarted: [],
      stopped: [],
      skipped: [],
      errors: [],
    }),
  );
  asDaemonServices(services).extraWorkerSupervisor = asExtraWorkerSupervisor({ reconcile });
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat.yaml");
  writeAgentchat(yamlPath);

  await withTempHome(async () => {
    process.env.PENUMBRA_CONFIG_DIR = yamlPath;
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<ReloadBody>(res);
    expect(body.worker_extras).toEqual({
      started: [],
      restarted: [],
      stopped: [],
      skipped: [],
      errors: [],
    });
    expect(reconcile).toHaveBeenCalledWith([]);
  });
});

test("POST /agentchat/reload surfaces invalid workers.yaml errors without extra worker supervisor", async () => {
  const services = tempServices();
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat.yaml");
  writeAgentchat(yamlPath);

  await withTempHome(async (home) => {
    const workersPath = writeWorkersYaml(home, "extras: [");
    process.env.PENUMBRA_CONFIG_DIR = yamlPath;
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<ReloadBody>(res);
    expect(body.worker_extras?.error).toContain("workers.yaml");
    expect(body.worker_extras?.error).toContain(workersPath);
  });
});

test("POST /agentchat/reload restarts and tracks added workers from workers.yaml", async () => {
  const services = tempServices();
  const state: string[] = ["worker-a"];
  const reconcile = vi.fn((extras: { id: string }[]) => {
    const next = extras.map((item) => item.id);
    const nextSet = new Set(next);
    const started = next.filter((id) => !state.includes(id));
    const stopped = state.filter((id) => !nextSet.has(id));
    for (const id of stopped) {
      state.splice(state.indexOf(id), 1);
    }
    for (const id of started) state.push(id);
    return Promise.resolve({
      started,
      restarted: [],
      stopped,
      skipped: [],
      errors: [],
    });
  });
  asDaemonServices(services).extraWorkerSupervisor = asExtraWorkerSupervisor({ reconcile });
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat.yaml");
  writeAgentchat(yamlPath);

  await withTempHome(async (home) => {
    writeWorkersYaml(
      home,
      `
extras:
  - id: worker-a
    isolation: shared
`,
    );
    process.env.PENUMBRA_CONFIG_DIR = yamlPath;
    let res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);

    writeWorkersYaml(
      home,
      `
extras:
  - id: worker-a
    isolation: shared
  - id: worker-b
    isolation: shared
`,
    );
    res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    const body = await readJson<ReloadBody>(res);
    expect(body.worker_extras).toEqual({
      started: ["worker-b"],
      restarted: [],
      stopped: [],
      skipped: [],
      errors: [],
    });
  });
});

test("POST /agentchat/reload restarts and tracks removed workers from workers.yaml", async () => {
  const services = tempServices();
  const state: string[] = ["worker-a", "worker-b"];
  const reconcile = vi.fn((extras: { id: string }[]) => {
    const next = extras.map((item) => item.id);
    const nextSet = new Set(next);
    const stopped = state.filter((id) => !nextSet.has(id));
    const started = next.filter((id) => !state.includes(id));
    state.splice(0);
    state.push(...next);
    return Promise.resolve({
      started,
      restarted: [],
      stopped,
      skipped: [],
      errors: [],
    });
  });
  asDaemonServices(services).extraWorkerSupervisor = asExtraWorkerSupervisor({ reconcile });
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat.yaml");
  writeAgentchat(yamlPath);

  await withTempHome(async (home) => {
    writeWorkersYaml(
      home,
      `
extras:
  - id: worker-a
    isolation: shared
  - id: worker-b
    isolation: shared
`,
    );
    process.env.PENUMBRA_CONFIG_DIR = yamlPath;
    await reloadConfigRoute(new Request("http://x/agentchat/reload", { method: "POST" }), services);

    writeWorkersYaml(
      home,
      `
extras:
  - id: worker-a
    isolation: shared
`,
    );
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    const body = await readJson<ReloadBody>(res);
    expect(body.worker_extras).toEqual({
      started: [],
      restarted: [],
      stopped: ["worker-b"],
      skipped: [],
      errors: [],
    });
  });
});

test("POST /agentchat/reload reports worker_reconcile_errors for invalid workers.yaml", async () => {
  const services = tempServices();
  const reconcile = vi.fn(() =>
    Promise.resolve({
      started: [],
      restarted: [],
      stopped: [],
      skipped: [],
      errors: [],
    }),
  );
  asDaemonServices(services).extraWorkerSupervisor = asExtraWorkerSupervisor({ reconcile });
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat.yaml");
  writeAgentchat(yamlPath);

  await withTempHome(async (home) => {
    const workersPath = writeWorkersYaml(home, "extras: [");
    process.env.PENUMBRA_CONFIG_DIR = yamlPath;
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<ReloadBody>(res);
    expect(body.worker_extras?.error).toContain(workersPath);
    expect(reconcile).not.toHaveBeenCalled();
  });
});

test("POST /agentchat/reload surfaces worker reconcile spawn errors", async () => {
  const services = tempServices();
  const reconcile = vi.fn(() =>
    Promise.resolve({
      started: [],
      restarted: [],
      stopped: [],
      skipped: ["worker-a"],
      errors: [{ worker_id: "worker-a", message: "spawn failed" }],
    }),
  );
  asDaemonServices(services).extraWorkerSupervisor = asExtraWorkerSupervisor({ reconcile });
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat.yaml");
  writeAgentchat(yamlPath);

  await withTempHome(async (home) => {
    writeWorkersYaml(
      home,
      `
extras:
  - id: worker-a
    isolation: shared
`,
    );
    process.env.PENUMBRA_CONFIG_DIR = yamlPath;
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    const body = await readJson<ReloadBody>(res);
    expect(body.worker_extras).toEqual({
      started: [],
      restarted: [],
      stopped: [],
      skipped: ["worker-a"],
      errors: [{ worker_id: "worker-a", message: "spawn failed" }],
    });
  });
});

test("POST /agentchat/reload emits agentchat_reload to workerControl on success", async () => {
  const services = tempServices();
  const testDir = join("/tmp", "penumbra-reload-test");
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const yamlPath = join(testDir, "agentchat.yaml");

  writeAgentchat(
    yamlPath,
    `
  agents:
  - name: test-agent-1
    adapter: mock
  `,
  );
  process.env.PENUMBRA_CONFIG_DIR = yamlPath;

  const emitSpy = vi.fn();
  services.workerControl = asWorkerControlBus({
    subscribe: () => (): undefined => undefined,
    emit: emitSpy,
  });

  try {
    const res = await reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    expect(res.status).toBe(200);
    expect(emitSpy).toHaveBeenCalledWith({ type: "agentchat_reload" });
  } finally {
    rmSync(yamlPath, { recursive: true, force: true });
  }
});

test("POST /agentchat/reload serializes overlapping calls so invocation order wins", async () => {
  const services = tempServices();
  const testDir = mkdtempSync(join(tmpdir(), "reload-race-"));
  tempDirs.push(testDir);
  const configDirA = join(testDir, "cfg-a");
  const configDirB = join(testDir, "cfg-b");

  writeAgentchat(
    configDirA,
    `
agents:
  - name: agent-a1
    adapter: mock
  - name: agent-a2
    adapter: mock
  - name: agent-a3
    adapter: mock
`,
  );
  writeAgentchat(
    configDirB,
    `
agents:
  - name: agent-b1
    adapter: mock
  - name: agent-b2
    adapter: mock
`,
  );

  // Gate the FIRST route call inside the long-lived reactor reload — which
  // runs AFTER the route commits its snapshot. This lets us observe the
  // committed state of a still-in-flight call A while call B is enqueued.
  let releaseReactorA: (() => void) | undefined;
  const reactorAGate = new Promise<void>((resolve) => {
    releaseReactorA = resolve;
  });
  let reactorCallCount = 0;
  asDaemonServices(services).longLivedReactor = {
    manualTick: (): { outcome: string } => ({ outcome: "noop" }),
    reload: (): Promise<void> => {
      reactorCallCount += 1;
      if (reactorCallCount === 1) return reactorAGate;
      return Promise.resolve();
    },
    shutdown: (): Promise<void> => Promise.resolve(),
  };

  spyOn(services.log, "info").mockImplementation(noopLogFn("info"));

  try {
    process.env.PENUMBRA_CONFIG_DIR = configDirA;
    const promiseA = reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    // Give call A time to progress through the sync read + workflow rebuild
    // and reach the reactor.reload() await where it blocks on reactorAGate.
    await new Promise((r) => setTimeout(r, 50));

    // Now switch env to the fresher, smaller config and fire the second call.
    process.env.PENUMBRA_CONFIG_DIR = configDirB;
    const promiseB = reloadConfigRoute(
      new Request("http://x/agentchat/reload", { method: "POST" }),
      services,
    );
    // Give ample time for call B to run in the RED (unserialized) path.
    await new Promise((r) => setTimeout(r, 50));

    // With serialization: A has committed 3 agents and is blocked on the
    // reactor gate; B is queued and hasn't touched services yet.
    // Without serialization: B has already run concurrently, its 2-agent
    // snapshot has clobbered A's 3-agent snapshot.
    expect(services.agentRegistry).toEqual(["agent-a1", "agent-a2", "agent-a3"]);

    releaseReactorA?.();
    const [resA, resB] = await Promise.all([promiseA, promiseB]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Invocation order wins: B was invoked second, so its config is the
    // final committed state regardless of which rebuild resolved first.
    expect(services.agentRegistry).toEqual(["agent-b1", "agent-b2"]);
    expect(reactorCallCount).toBe(2);
  } finally {
    releaseReactorA?.();
  }
});
