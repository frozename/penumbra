import { ProjectRegistry } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonClient } from "../../src/daemon-client.js";
import type { ToolDef } from "../../src/tools/registry.js";

import { HandleStore } from "../../src/handle-store.js";
import { setLongLivedRuntimeContextFromEnv } from "../../src/long-lived-context.js";
import { fakeDaemon } from "../helpers.js";
import { insertLongLivedTick, seedLongLivedAgent } from "./long-lived-fixtures.js";

type RegistryModule = typeof import("../../src/tools/registry.js");
type ToolRegistry = RegistryModule["TOOL_REGISTRY"];
type RegistryEntry = ToolDef;
type CreateResolverFn = RegistryModule["createProjectIdResolverFromCwd"];
type ResolverOpts = NonNullable<Parameters<CreateResolverFn>[0]>;
type LoadRegistryFn = NonNullable<ResolverOpts["loadRegistry"]>;
type FindProjectIdFn = NonNullable<ResolverOpts["findProjectId"]>;

let TOOL_REGISTRY: ToolRegistry | null = null;
let createProjectIdResolverFromCwd: CreateResolverFn | null = null;
let resetProjectRegistryCache: (() => void) | null = null;
let importError: unknown = null;

beforeAll(async () => {
  try {
    const mod = await import("../../src/tools/registry.js");
    TOOL_REGISTRY = mod.TOOL_REGISTRY;
    createProjectIdResolverFromCwd = mod.createProjectIdResolverFromCwd;
    resetProjectRegistryCache = mod.__resetProjectRegistryCacheForTest;
  } catch (err) {
    importError = err;
  }
});

const TOOL_NAMES = [
  "agent_rank",
  "agent_recommend",
  "agent_route_for",
  "brainstorm",
  "chain_cancel",
  "chain_get_messages",
  "chain_get_response",
  "chain_history",
  "chain_list_agents",
  "chain_start",
  "chain_start_simple",
  "chain_start_refined",
  "chain_status",
  "chain_wait",
  "chain_send_message",
  "cost_quota_status",
  "subscription_pressure_status",
  "cost_recent",
  "daemon_reload_config",
  "dispatch_audit",
  "dispatch_land",
  "dispatch_timeline",
  "dreaming_health",
  "fs_glob",
  "fs_grep",
  "fs_read",
  "fs_write",
  "fs_edit",
  "fs_exec",
  "fleet_latency",
  "handoff_approve",
  "handoff_get",
  "handoff_list_pending",
  "long_lived_approve_action",
  "long_lived_audit",
  "long_lived_get",
  "long_lived_inject_goal",
  "long_lived_list",
  "long_lived_pause",
  "long_lived_pending_actions",
  "long_lived_self_pending_actions",
  "long_lived_self_state_get",
  "long_lived_self_state_set",
  "long_lived_reject_action",
  "long_lived_resume",
  "long_lived_retire",
  "long_lived_state_get",
  "long_lived_state_set",
  "long_lived_tick",
  "long_lived_ticks",
  "lane_close",
  "lane_ledger_recent",
  "lane_open",
  "maestro_session_get",
  "maestro_session_start",
  "maestro_session_start_adhoc",
  "maestro_capabilities",
  "memory_corpus_build",
  "memory_corpus_list",
  "memory_corpus_query",
  "memory_curator_patterns_add",
  "memory_curator_patterns_approve",
  "memory_curator_patterns_disable",
  "memory_curator_patterns_list",
  "memory_dream_action_revert",
  "memory_efficacy_rebuild",
  "memory_efficacy_recent",
  "memory_efficacy_job_status",
  "memory_efficacy_jobs",
  "memory_get_observations",
  "memory_list_pending_dream_actions",
  "memory_observe",
  "memory_recall",
  "memory_search",
  "memory_status",
  "memory_verify",
  "memory_verify_authorize",
  "memory_write_t2",
  "memory_timeline",
  "memory_verification_events",
  "task_draft_list_pending",
  "task_draft_list_pending_escalations",
  "permission_approve",
  "permission_get",
  "permission_list_pending",
  "plan_cancel",
  "plan_list",
  "plan_start",
  "plan_open",
  "plan_status",
  "quality_status",
  "registrar_append",
  "registrar_create",
  "registrar_list",
  "registrar_status",
  "reconciler_sweep_orphan_prs",
  "reconciler_verdicts",
  "routing_bias_list",
  "routing_bias_set",
  "routing_bias_clear",
  "session_end",
  "shell_close",
  "shell_list",
  "shell_run",
  "task_cancel",
  "task_comment_gh",
  "task_complete",
  "task_fail",
  "task_file",
  "task_get",
  "task_heartbeat",
  "task_link_gh",
  "task_list",
  "task_next",
  "task_sync_gh_now",
  "task_unlink_gh",
  "worktree_cleanup",
  "worktree_inspect",
  "worktree_list",
  "workflow_history",
  "workflow_list",
  "workflow_run",
  "workflow_status",
  "workflow_wait",
  "workflow_suggest",
] as const;

const READ_ONLY_TOOL_NAMES = [
  "agent_rank",
  "agent_recommend",
  "agent_route_for",
  "chain_get_messages",
  "chain_get_response",
  "chain_history",
  "chain_list_agents",
  "chain_status",
  "chain_wait",
  "cost_quota_status",
  "subscription_pressure_status",
  "cost_recent",
  "dispatch_audit",
  "dispatch_timeline",
  "fs_glob",
  "fs_grep",
  "fs_read",
  "fleet_latency",
  "handoff_get",
  "handoff_list_pending",
  "maestro_session_get",
  "maestro_capabilities",
  "memory_corpus_list",
  "memory_corpus_query",
  "memory_curator_patterns_list",
  "dreaming_health",
  "memory_efficacy_job_status",
  "memory_efficacy_jobs",
  "memory_efficacy_recent",
  "memory_get_observations",
  "memory_list_pending_dream_actions",
  "memory_recall",
  "memory_search",
  "memory_status",
  "lane_ledger_recent",
  "memory_timeline",
  "memory_verification_events",
  "task_draft_list_pending",
  "task_draft_list_pending_escalations",
  "permission_get",
  "permission_list_pending",
  "plan_list",
  "plan_status",
  "quality_status",
  "registrar_list",
  "registrar_status",
  "long_lived_get",
  "long_lived_list",
  "long_lived_pending_actions",
  "long_lived_self_pending_actions",
  "long_lived_self_state_get",
  "long_lived_audit",
  "long_lived_state_get",
  "long_lived_ticks",
  "shell_list",
  "task_get",
  "task_list",
  "task_next",
  "reconciler_verdicts",
  "routing_bias_list",
  "workflow_history",
  "workflow_list",
  "workflow_status",
  "workflow_wait",
  "workflow_suggest",
  "worktree_inspect",
  "worktree_list",
] as const;

const MUTATING_TOOL_NAMES = [
  "chain_cancel",
  "chain_start",
  "chain_start_simple",
  "chain_start_refined",
  "chain_send_message",
  "brainstorm",
  "daemon_reload_config",
  "dispatch_land",
  "handoff_approve",
  "long_lived_pause",
  "long_lived_resume",
  "long_lived_retire",
  "long_lived_state_set",
  "long_lived_self_state_set",
  "lane_close",
  "lane_open",
  "long_lived_approve_action",
  "long_lived_reject_action",
  "long_lived_inject_goal",
  "long_lived_tick",
  "memory_corpus_build",
  "memory_efficacy_rebuild",
  "memory_observe",
  "memory_verify",
  "memory_verify_authorize",
  "memory_write_t2",
  "memory_curator_patterns_add",
  "memory_curator_patterns_approve",
  "memory_curator_patterns_disable",
  "memory_dream_action_revert",
  "maestro_session_start",
  "maestro_session_start_adhoc",
  "permission_approve",
  "plan_cancel",
  "plan_start",
  "plan_open",
  "registrar_append",
  "registrar_create",
  "reconciler_sweep_orphan_prs",
  "routing_bias_set",
  "routing_bias_clear",
  "fs_write",
  "fs_edit",
  "fs_exec",
  "session_end",
  "shell_close",
  "shell_run",
  "task_cancel",
  "task_comment_gh",
  "task_complete",
  "task_fail",
  "task_file",
  "task_heartbeat",
  "task_link_gh",
  "task_sync_gh_now",
  "task_unlink_gh",
  "workflow_run",
  "worktree_cleanup",
] as const;

interface ActingOnEnvelope {
  acting_on: { kind: string; id: string };
  content: { text: string }[];
}

type ToolResultEnvelope = { content?: unknown };
type ZodLike = {
  _def?: Record<string, unknown>;
  def?: Record<string, unknown>;
  shape?: Record<string, unknown>;
  options?: unknown[];
  isOptional?: () => boolean;
};

const TEST_ID = "registry-envelope-test";

function makeRegistryDaemon(): DaemonClient {
  const daemon = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "resolve") {
          return () => ({ baseUrl: "http://daemon.test", token: "test-token" });
        }
        if (prop === "maestroCapabilities") {
          return async () => ({
            agents: [
              { name: "codex-acp-fast", maestro_capable: true, task_types: ["plan_refine"] },
            ],
            task_types: ["debug_diagnose"],
            workflows: ["brainstorm"],
          });
        }
        if (prop === "listChainAgents") {
          return async () => ({ agents: [{ name: "codex-acp-fast" }] });
        }
        if (prop === "maestroSessionStartAdhoc") {
          return async () => ({
            status: "dispatched",
            agent_name: "codex-acp-fast",
            chain_handoff_id: TEST_ID,
            conversation_id: "conversation-1",
            session: registryDaemonPayload().session,
          });
        }
        return async () => registryDaemonPayload();
      },
    },
  );
  return daemon as DaemonClient;
}

function registryDaemonPayload(): Record<string, unknown> {
  return {
    ok: true,
    id: TEST_ID,
    status: "dispatched",
    result: {},
    results: [],
    agents: [],
    agent_id: "codex-acp-fast",
    agent_name: "codex-acp-fast",
    by_provider: [],
    chain_handoff_id: TEST_ID,
    conversation_id: "conversation-1",
    cost_budget_cents: 1,
    cost_consumed_cents: 0,
    decision: "approve",
    events: [],
    gate_status: "passed",
    handoff_id: TEST_ID,
    handoff: {
      handoff_id: TEST_ID,
      status: "pending",
      conversation_id: "conversation-1",
      from_agent: "user",
      to_agent: "codex-acp-fast",
    },
    handoff_count: 0,
    handoffs: [],
    history: [],
    implementer_handoff: "handoff-implementer",
    messages: [],
    permissions: [],
    permission_id: TEST_ID,
    plans: [],
    reliability: {
      status: "complete",
      trustworthy: true,
      recommended_action: "accept",
      summary: "ok",
    },
    responses: [{ agent: "codex-acp-fast", text: "ok", ts: "2026-01-01T00:00:00.000Z" }],
    session: {
      task_id: TEST_ID,
      chain_handoff_id: TEST_ID,
      agent_id: "codex-acp-fast",
      started_at: 1,
      wall_clock_budget_ms: 1000,
      cost_budget_cents: 1,
      sub_dispatch_budget: 1,
      cost_consumed_cents: 0,
      sub_dispatches_consumed: 0,
      soft_warned_at: null,
      terminated_at: null,
      termination_reason: null,
    },
    soft_warned_at: null,
    started_at: 1,
    sub_dispatch_budget: 1,
    sub_dispatches_consumed: 0,
    task_id: TEST_ID,
    tasks: [],
    terminated_at: null,
    termination_reason: null,
    wall_clock_budget_ms: 1000,
    window: {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-02T00:00:00.000Z",
    },
    worktrees: [],
  };
}

function seedRuntimeDb(storageRoot: string): void {
  const db = new Database(join(storageRoot, "db.sqlite"));
  try {
    seedLongLivedAgent(db, { name: "registry-agent" });
    insertLongLivedTick(db, { tick_id: "registry-tick", agent_id: "registry-agent" });
  } finally {
    db.close();
  }
}

function sampleArgsForInputSchema(inputSchema: unknown): unknown {
  if (isZodObject(inputSchema)) {
    return sampleObjectFromShape(getZodObjectShape(inputSchema));
  }
  if (isPlainObject(inputSchema)) {
    return sampleObjectFromShape(inputSchema);
  }
  return {};
}

function sampleArgsForTool(name: string, inputSchema: unknown): unknown {
  if (name === "agent_recommend") return { workload: "debug_diagnose" };
  if (name === "chain_start" || name === "chain_start_refined" || name === "chain_start_simple") {
    return {
      initial_agent: "codex-acp-fast",
      message: "test",
      conversation_id: "conversation-1",
      project_id: "penumbra",
      task_class: "STANDARD",
      workload: "debug_diagnose",
    };
  }
  if (name === "chain_wait") return { conversation_id: "conversation-1", timeout_ms: 1 };
  if (name === "long_lived_self_state_set") return { intent_summary: "test" };
  if (name === "routing_bias_set") {
    return { scope: "agent", value: "codex-acp-fast", mode: "boost", ttl_seconds: 60 };
  }
  if (name === "routing_bias_clear") return { all: true, confirm: true };
  if (name === "workflow_wait") return { workflow_run_id: TEST_ID, timeout_ms: 1 };
  return sampleArgsForInputSchema(inputSchema);
}

function sampleObjectFromShape(shape: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    if (isOptionalSchema(schema)) continue;
    out[key] = sampleValue(schema, key);
  }
  return out;
}

function sampleValue(schema: unknown, key: string): unknown {
  const zod = schema as ZodLike;
  const def = zod._def ?? zod.def;
  if (!def) return fallbackValueForKey(key);

  switch (def.type) {
    case "optional":
    case "default":
    case "catch":
      return sampleValue(def.innerType, key);
    case "nullable":
      return sampleValue(def.innerType, key);
    case "string":
      return fallbackValueForKey(key);
    case "number":
      return 1;
    case "boolean":
      return true;
    case "literal": {
      const values = def.values;
      if (Array.isArray(values) && values.length > 0) return values[0];
      return def.value ?? true;
    }
    case "enum":
      return (
        Object.values((def.entries ?? {}) as Record<string, unknown>)[0] ?? fallbackValueForKey(key)
      );
    case "array":
      return [sampleValue(def.element, key)];
    case "object":
      return sampleObjectFromShape(getZodObjectShape(schema));
    case "record":
      return {};
    case "union": {
      const options = (def.options as unknown[] | undefined) ?? zod.options;
      return sampleValue(options?.[0], key);
    }
    case "pipe":
      return sampleValue(def.in, key);
    default:
      return fallbackValueForKey(key);
  }
}

function fallbackValueForKey(key: string): string {
  if (key.endsWith("_at") || key === "since" || key === "now") {
    return "2026-01-01T00:00:00.000Z";
  }
  if (key === "task_type" || key === "workload") return "debug_diagnose";
  if (key === "task_class") return "STANDARD";
  if (key === "trust_mode") return "config";
  if (key === "dispatch_kind") return "chain";
  if (key === "gate_status" || key === "verdict") return "passed";
  if (key === "decision") return "approve";
  if (key === "mode") return "boost";
  if (key === "scope") return "agent";
  if (key === "source") return "mcp";
  if (key === "event_type") return "message";
  if (key === "lane") return "local";
  if (key === "command") return "true";
  if (key === "path" || key === "file_path") return "/tmp/penumbra-registry-envelope-test";
  if (key === "pattern") return "**/*.ts";
  if (key === "query" || key === "message" || key === "goal" || key === "body") return "test";
  return TEST_ID;
}

function isOptionalSchema(schema: unknown): boolean {
  const zod = schema as ZodLike;
  if (typeof zod.isOptional === "function" && zod.isOptional()) return true;
  const type = zod._def?.type ?? zod.def?.type;
  return type === "optional" || type === "default" || type === "catch";
}

function isZodObject(value: unknown): boolean {
  const zod = value as ZodLike;
  return (zod._def?.type ?? zod.def?.type) === "object";
}

function getZodObjectShape(schema: unknown): Record<string, unknown> {
  const zod = schema as ZodLike;
  const shape = zod.shape ?? zod._def?.shape ?? zod.def?.shape;
  if (typeof shape === "function") return shape() as Record<string, unknown>;
  if (isPlainObject(shape)) return shape;
  return {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
  );
}

describe("TOOL_REGISTRY", () => {
  it("module loads", () => {
    expect(importError).toBeNull();
    expect(TOOL_REGISTRY).not.toBeNull();
  });

  it("has the expected tool names", () => {
    if (importError || !TOOL_REGISTRY) return;

    expect(Object.keys(TOOL_REGISTRY).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("no registrar_* tool key collides with any existing plan_* tool key", () => {
    if (importError || !TOOL_REGISTRY) return;

    const keys = Object.keys(TOOL_REGISTRY);
    const planKeys = new Set(keys.filter((key) => key.startsWith("plan_")));
    const registrarOnly = keys
      .filter((key) => key.startsWith("registrar_") && !planKeys.has(key))
      .sort();

    expect(registrarOnly).toEqual([
      "registrar_append",
      "registrar_create",
      "registrar_list",
      "registrar_status",
    ]);
  });

  it("matches the registry shape and readOnly snapshot", () => {
    if (importError || !TOOL_REGISTRY) return;

    const allNames = [...READ_ONLY_TOOL_NAMES, ...MUTATING_TOOL_NAMES];
    expect(new Set(READ_ONLY_TOOL_NAMES).size).toBe(READ_ONLY_TOOL_NAMES.length);
    expect(new Set(MUTATING_TOOL_NAMES).size).toBe(MUTATING_TOOL_NAMES.length);
    expect(new Set(allNames).size).toBe(TOOL_NAMES.length);
    expect([...allNames].sort()).toEqual([...TOOL_NAMES].sort());

    for (const name of TOOL_NAMES) {
      const entry: RegistryEntry | undefined = TOOL_REGISTRY[name];
      expect(entry).toBeDefined();
      expect(typeof entry?.descriptor.description).toBe("string");
      expect(entry?.descriptor.description.length ?? 0).toBeGreaterThan(0);
      expect(typeof entry?.makeHandler).toBe("function");
      expect(typeof entry?.readOnly).toBe("boolean");
      const readOnlyExpected: boolean = (READ_ONLY_TOOL_NAMES as readonly string[]).includes(name);
      expect(entry?.readOnly).toBe(readOnlyExpected);
    }

    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(TOOL_REGISTRY[name]?.readOnly).toBe(true);
    }

    for (const name of MUTATING_TOOL_NAMES) {
      expect(TOOL_REGISTRY[name]?.readOnly).toBe(false);
    }
  });

  it("all registered handlers return MCP content envelopes", async () => {
    if (importError || !TOOL_REGISTRY) return;

    const daemon = makeRegistryDaemon();
    const handleStore = new HandleStore();
    const missingContent: string[] = [];
    const previousRequireProjectId = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    const previousStorageRoot = process.env.PENUMBRA_STORAGE_ROOT;
    const previousLongLivedAgent = process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
    const previousLongLivedTick = process.env.PENUMBRA_LONG_LIVED_TICK_ID;
    const originalFetch = globalThis.fetch;
    const storageRoot = mkdtempSync(join(tmpdir(), "penumbra-registry-envelope-storage-"));
    try {
      delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
      process.env.PENUMBRA_STORAGE_ROOT = storageRoot;
      process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "registry-agent";
      process.env.PENUMBRA_LONG_LIVED_TICK_ID = "registry-tick";
      setLongLivedRuntimeContextFromEnv(process.env);
      seedRuntimeDb(storageRoot);
      globalThis.fetch = async () =>
        new Response(JSON.stringify(registryDaemonPayload()), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      for (const [name, entry] of Object.entries(TOOL_REGISTRY)) {
        const handler = entry.makeHandler(daemon, { handleStore });
        let result: ToolResultEnvelope | undefined;
        try {
          result = (await handler(sampleArgsForTool(name, entry.descriptor.inputSchema))) as
            | ToolResultEnvelope
            | undefined;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`${name} handler threw during envelope guard: ${message}`);
        }
        if (!Array.isArray(result?.content)) {
          missingContent.push(name);
        }
      }
    } finally {
      if (previousRequireProjectId === undefined) {
        delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
      } else {
        process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = previousRequireProjectId;
      }
      if (previousStorageRoot === undefined) {
        delete process.env.PENUMBRA_STORAGE_ROOT;
      } else {
        process.env.PENUMBRA_STORAGE_ROOT = previousStorageRoot;
      }
      if (previousLongLivedAgent === undefined) {
        delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
      } else {
        process.env.PENUMBRA_LONG_LIVED_AGENT_ID = previousLongLivedAgent;
      }
      if (previousLongLivedTick === undefined) {
        delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
      } else {
        process.env.PENUMBRA_LONG_LIVED_TICK_ID = previousLongLivedTick;
      }
      setLongLivedRuntimeContextFromEnv(process.env);
      globalThis.fetch = originalFetch;
      handleStore.close();
      rmSync(storageRoot, { recursive: true, force: true });
    }

    expect(missingContent).toEqual([]);
  });

  it("wraps handoff_get results with acting_on for handoff_id inputs", async () => {
    if (importError || !TOOL_REGISTRY) return;

    const daemon: DaemonClient = fakeDaemon({
      getHandoff: (handoffId: string) =>
        Promise.resolve({
          handoff: {
            handoff_id: handoffId,
            status: "pending",
            conversation_id: "c-1",
            from_agent: "user",
            to_agent: "codex",
          },
        }),
    });
    const entry = TOOL_REGISTRY["handoff_get"];
    expect(entry).toBeDefined();
    const handler = entry!.makeHandler(daemon);
    const result = (await handler({ handoff_id: "abc" })) as ActingOnEnvelope;

    expect(result.acting_on).toEqual({ kind: "handoff", id: "abc" });
    expect(Object.keys(result)[0]).toBe("acting_on");
    expect(result.content[0]?.text).toContain('"handoff_id": "abc"');
  });

  it("wraps task_get results with acting_on for task_id inputs", async () => {
    if (importError || !TOOL_REGISTRY) return;

    const daemon: DaemonClient = fakeDaemon({
      taskGet: (taskId: string) =>
        Promise.resolve({
          task_id: taskId,
          status: "open",
        }),
    });
    const entry = TOOL_REGISTRY["task_get"];
    expect(entry).toBeDefined();
    const handler = entry!.makeHandler(daemon);
    const result = (await handler({ task_id: "xyz" })) as ActingOnEnvelope;

    expect(result.acting_on).toEqual({ kind: "task", id: "xyz" });
    expect(Object.keys(result)[0]).toBe("acting_on");
    expect(result.content[0]?.text).toMatch(/"task_id"\s*:\s*"xyz"/);
  });

  it("chain_start makeHandler injects cwd-resolved project_id when omitted", async () => {
    if (importError || !TOOL_REGISTRY || !resetProjectRegistryCache) return;

    const root = mkdtempSync(join(tmpdir(), "penumbra-mcp-chain-start-"));
    const registryPath = join(root, "projects.yaml");
    writeFileSync(
      registryPath,
      `projects:\n  - project_id: penumbra\n    root_path: "${process.cwd()}"\n`,
      "utf8",
    );

    type StartChainFn = DaemonClient["startChain"];
    const startChainMock = mock<StartChainFn>(() =>
      Promise.resolve({ conversation_id: "conv-1", handoff_id: "h-1" }),
    );
    const daemon: DaemonClient = fakeDaemon({ startChain: startChainMock });
    const previous = process.env.PENUMBRA_PROJECTS_YAML;

    try {
      process.env.PENUMBRA_PROJECTS_YAML = registryPath;
      delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
      resetProjectRegistryCache();
      const entry = TOOL_REGISTRY["chain_start"];
      expect(entry).toBeDefined();
      const handler = entry!.makeHandler(daemon);

      await handler({ initial_agent: "planner", message: "hi" });

      expect(startChainMock).toHaveBeenCalledWith(
        expect.objectContaining({
          initial_agent: "planner",
          message: "hi",
          project_id: "penumbra",
        }),
      );
    } finally {
      if (previous === undefined) delete process.env.PENUMBRA_PROJECTS_YAML;
      else process.env.PENUMBRA_PROJECTS_YAML = previous;
      rmSync(root, { recursive: true, force: true });
      resetProjectRegistryCache();
    }
  });

  it("caches project registry by mtime and reloads when mtime changes", () => {
    if (importError || !createProjectIdResolverFromCwd || !resetProjectRegistryCache) return;

    const root = mkdtempSync(join(tmpdir(), "penumbra-mcp-registry-"));
    const registryPath = join(root, "projects.yaml");
    writeFileSync(
      registryPath,
      "projects:\n  - project_id: penumbra\n    root_path: /tmp/penumbra\n",
      "utf8",
    );

    const fakeRegistry = new ProjectRegistry(new Map());
    const loadRegistry = mock<LoadRegistryFn>(() => fakeRegistry);
    const findProjectId = mock<FindProjectIdFn>(() => "penumbra");

    try {
      resetProjectRegistryCache();
      const resolver = createProjectIdResolverFromCwd({
        cwd: "/tmp/penumbra",
        registryPath,
        loadRegistry,
        findProjectId,
      });

      expect(resolver()).toBe("penumbra");
      expect(resolver()).toBe("penumbra");
      expect(loadRegistry).toHaveBeenCalledTimes(1);

      const now = Date.now() / 1000;
      utimesSync(registryPath, now, now + 1);

      expect(resolver()).toBe("penumbra");
      expect(loadRegistry).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
