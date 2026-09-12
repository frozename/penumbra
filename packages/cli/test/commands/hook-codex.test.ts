import { buildServices, loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "@penumbra/daemon";
import { buildRegistry } from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodexHook } from "@src/commands/hook-codex.js";

const CLI_PATH = fileURLToPath(new URL("../../bin/penumbra.ts", import.meta.url));
const TOKEN = "codex-hook-token";

function event(
  hookEventName: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    hook_event_name: hookEventName,
    session_id: "opaque-root-session",
    cwd: "/fixture/project",
    transcript_path: null,
    model: "gpt-5.6-sol",
    ...(hookEventName === "PreCompact" || hookEventName === "SessionEnd"
      ? {}
      : { permission_mode: "default" }),
    ...fields,
  };
}

function eventFields(hookEventName: string): Record<string, unknown> {
  switch (hookEventName) {
    case "SessionStart":
      return { source: "startup" };
    case "Stop":
      return { turn_id: "turn-stop", stop_hook_active: false };
    case "PreToolUse":
      return {
        turn_id: "turn-tool",
        tool_name: "apply_patch",
        tool_use_id: "tool-1",
        tool_input: { patch: "*** Begin Patch" },
      };
    case "PostToolUse":
      return {
        turn_id: "turn-tool",
        tool_name: "apply_patch",
        tool_use_id: "tool-1",
        tool_input: { patch: "*** Begin Patch" },
        tool_response: { ok: true },
      };
    case "SubagentStart":
      return { turn_id: "turn-child", agent_id: "child-1", agent_type: "worker" };
    case "SubagentStop":
      return {
        turn_id: "turn-child",
        agent_id: "child-1",
        agent_type: "worker",
        stop_hook_active: false,
      };
    default:
      return {};
  }
}

function daemonFiles(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "codex-hook-daemon-"));
  writeFileSync(join(root, "port"), "43123\n");
  writeFileSync(join(root, "token"), `${TOKEN}\n`);
  return {
    root,
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type CapturedRequest = { path: string; body: Record<string, unknown>; signal: AbortSignal | null };

function requestBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "string") throw new Error("expected a JSON string body");
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a JSON object body");
  }
  return parsed as Record<string, unknown>;
}

function recorder(
  requests: CapturedRequest[],
  onRequest?: (request: CapturedRequest) => void,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const request = {
      path: new URL(url).pathname,
      body: requestBody(init?.body),
      signal: init?.signal ?? null,
    };
    requests.push(request);
    onRequest?.(request);
    return await Promise.resolve(
      Response.json(
        request.path === "/workflows/trigger"
          ? { matched: ["fixture"], additionalContext: "prime context" }
          : { ok: true, event_id: "event-1" },
      ),
    );
  }) as typeof fetch;
}

test("a schema-valid verified root triggers while a captured worker context stays suppressed", async () => {
  const daemon = daemonFiles();
  try {
    const rootRequests: CapturedRequest[] = [];
    const rootOutput: string[] = [];
    const rootCode = await runCodexHook({
      storageRoot: daemon.root,
      rawEvent: JSON.stringify(event("SessionStart", eventFields("SessionStart"))),
      sessionId: "opaque-root-session",
      env: { PENUMBRA_MCP_ORIGIN: "maestro" },
      fetchFn: recorder(rootRequests),
      write: (value) => rootOutput.push(value),
    });
    expect(rootCode).toBe(0);
    expect(rootRequests.some((request) => request.path === "/workflows/trigger")).toBe(true);
    expect(rootOutput).toEqual([
      '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"prime context"}}\n',
    ]);

    const mutableEnv: NodeJS.ProcessEnv = {
      PENUMBRA_MCP_ORIGIN: "maestro",
      PENUMBRA_WORKER_ID: "worker-7",
    };
    const workerRequests: CapturedRequest[] = [];
    await runCodexHook({
      storageRoot: daemon.root,
      rawEvent: JSON.stringify(event("PreToolUse", eventFields("PreToolUse"))),
      sessionId: "opaque-root-session",
      env: mutableEnv,
      fetchFn: recorder(workerRequests, () => {
        delete mutableEnv.PENUMBRA_WORKER_ID;
      }),
      write: (): void => undefined,
    });
    expect(workerRequests.map((request) => request.path)).toEqual(["/observations"]);
    const observation = workerRequests[0]?.body;
    expect(observation?.origin).toBe("unknown");
    expect((observation?.payload_json as Record<string, unknown>).lineage).toBe("root");
  } finally {
    daemon.cleanup();
  }
});

test("ordinary opaque identity needs explicit session correlation and unknown stays unknown", async () => {
  const daemon = daemonFiles();
  try {
    const correlated: CapturedRequest[] = [];
    await runCodexHook({
      storageRoot: daemon.root,
      rawEvent: JSON.stringify(event("PostToolUse", eventFields("PostToolUse"))),
      sessionId: "opaque-root-session",
      env: { PENUMBRA_MCP_ORIGIN: "maestro" },
      fetchFn: recorder(correlated),
      write: (): void => undefined,
    });
    const trigger = correlated.find((request) => request.path === "/workflows/trigger");
    expect(trigger?.body.ingress).toMatchObject({
      role: "maestro",
      lineage: "root",
      provenance: "verified-session-correlation",
    });

    const unknown: CapturedRequest[] = [];
    await runCodexHook({
      storageRoot: daemon.root,
      rawEvent: JSON.stringify(event("PostToolUse", eventFields("PostToolUse"))),
      env: { PENUMBRA_MCP_ORIGIN: "maestro" },
      fetchFn: recorder(unknown),
      write: (): void => undefined,
    });
    expect(unknown.some((request) => request.path === "/workflows/trigger")).toBe(false);
  } finally {
    daemon.cleanup();
  }
});

test("ambient maestro marker alone does not verify a root launch", async () => {
  const daemon = daemonFiles();
  try {
    const requests: CapturedRequest[] = [];
    const output: string[] = [];
    const code = await runCodexHook({
      storageRoot: daemon.root,
      rawEvent: JSON.stringify(event("SessionStart", eventFields("SessionStart"))),
      env: { PENUMBRA_MCP_ORIGIN: "maestro" },
      fetchFn: recorder(requests),
      write: (value) => output.push(value),
    });
    expect(code).toBe(0);
    expect(requests.some((request) => request.path === "/workflows/trigger")).toBe(false);
    expect(requests.some((request) => request.path === "/observations")).toBe(false);
    expect(output).toEqual(["{}\n"]);
  } finally {
    daemon.cleanup();
  }
});

test("an arbitrary explicit session id does not correlate with a different raw session", async () => {
  const daemon = daemonFiles();
  try {
    const requests: CapturedRequest[] = [];
    await runCodexHook({
      storageRoot: daemon.root,
      rawEvent: JSON.stringify(event("PreToolUse", eventFields("PreToolUse"))),
      sessionId: "arbitrary-session",
      env: { PENUMBRA_MCP_ORIGIN: "maestro" },
      fetchFn: recorder(requests),
      write: (): void => undefined,
    });
    expect(requests.some((request) => request.path === "/workflows/trigger")).toBe(false);
    const observation = requests.find((request) => request.path === "/observations");
    expect(observation?.body).toMatchObject({ origin: "unknown" });
    const payload = observation?.body.payload_json as Record<string, unknown>;
    expect(payload).toMatchObject({ role: "unknown", lineage: "unknown", provenance: "unknown" });
  } finally {
    daemon.cleanup();
  }
});

test("a nonblank PENUMBRA_HANDOFF_ID suppresses root lifecycle and origin regardless of maestro or explicit project", async () => {
  const daemon = daemonFiles();
  try {
    const requests: CapturedRequest[] = [];
    await runCodexHook({
      storageRoot: daemon.root,
      rawEvent: JSON.stringify(event("PreToolUse", eventFields("PreToolUse"))),
      sessionId: "opaque-root-session",
      project: "caller-project",
      env: { PENUMBRA_MCP_ORIGIN: "maestro", PENUMBRA_HANDOFF_ID: "H-123" },
      fetchFn: recorder(requests),
      write: (): void => undefined,
    });
    expect(requests.some((request) => request.path === "/workflows/trigger")).toBe(false);
    const observation = requests.find((request) => request.path === "/observations");
    expect(observation?.body).toMatchObject({
      project_id: "caller-project",
      origin: "unknown",
    });
    const payload = observation?.body.payload_json as Record<string, unknown>;
    expect(payload).toMatchObject({
      role: "dispatch",
      lineage: "root",
      provenance: "verified-session-correlation",
    });
  } finally {
    daemon.cleanup();
  }
});

test("child and recursive Stop events cannot touch a parent session or emit a root trigger", async () => {
  const daemon = daemonFiles();
  try {
    for (const raw of [
      event("SubagentStop", eventFields("SubagentStop")),
      event("Stop", { ...eventFields("Stop"), stop_hook_active: true }),
    ]) {
      const requests: CapturedRequest[] = [];
      await runCodexHook({
        storageRoot: daemon.root,
        rawEvent: JSON.stringify(raw),
        sessionId: "opaque-root-session",
        env: { PENUMBRA_MCP_ORIGIN: "maestro" },
        fetchFn: recorder(requests),
        write: () => undefined,
      });
      expect(requests.some((request) => request.path === "/sessions/touch")).toBe(false);
      expect(requests.some((request) => request.path === "/workflows/trigger")).toBe(false);
    }
  } finally {
    daemon.cleanup();
  }
});

test("apply_patch observation is accepted before the post-tool drift trigger without usage rows", async () => {
  const daemon = daemonFiles();
  try {
    const requests: CapturedRequest[] = [];
    const common = {
      storageRoot: daemon.root,
      sessionId: "opaque-root-session",
      env: { PENUMBRA_MCP_ORIGIN: "maestro" },
      fetchFn: recorder(requests),
      write: (): void => undefined,
    };
    await runCodexHook({
      ...common,
      rawEvent: JSON.stringify(event("PreToolUse", eventFields("PreToolUse"))),
    });
    await runCodexHook({
      ...common,
      rawEvent: JSON.stringify(event("PostToolUse", eventFields("PostToolUse"))),
    });

    const observationIndex = requests.findIndex((request) => request.path === "/observations");
    const postToolTriggerIndex = requests.findIndex(
      (request) =>
        request.path === "/workflows/trigger" &&
        (request.body.event as Record<string, unknown>).event === "post-tool-use",
    );
    expect(observationIndex).toBeGreaterThanOrEqual(0);
    expect(postToolTriggerIndex).toBeGreaterThan(observationIndex);
    expect(requests[observationIndex]?.body).toMatchObject({
      source: "codex",
      source_detail: "tool:apply_patch",
      session_id: "opaque-root-session",
      event_type: "agent-tool-use",
      origin: "maestro",
    });
    expect(requests.filter((request) => request.body.event_type === "usage-update")).toHaveLength(
      0,
    );
    expect(requests.every((request) => request.signal instanceof AbortSignal)).toBe(true);
  } finally {
    daemon.cleanup();
  }
});

test("producer bodies cross the current daemon route with capped control ids and trusted fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-hook-route-"));
  mkdirSync(join(root, "playbooks"));
  mkdirSync(join(root, "workflows"));
  writeFileSync(join(root, ".penumbra-project"), "codex-hook-route\n");
  writeFileSync(join(root, "port"), "43123\n");
  writeFileSync(join(root, "token"), `${TOKEN}\n`);
  const db = new Database(":memory:");
  try {
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const registry = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    const services = buildServices({
      env: {},
      input: {},
      storageRoot: root,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      workflowRegistry: registry,
    });
    const handler = createDaemonFetchHandler({ services, token: TOKEN });
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const source = input instanceof Request ? input.url : String(input);
      const body = requestBody(init?.body);
      bodies.push(body);
      return await handler(
        new Request(`http://localhost${new URL(source).pathname}`, {
          method: "POST",
          headers: init?.headers,
          body: init?.body,
          signal: init?.signal,
        }),
      );
    }) as typeof fetch;

    const longControl = "x".repeat(129);
    const code = await runCodexHook({
      storageRoot: root,
      rawEvent: JSON.stringify(
        event("PostToolUse", {
          ...eventFields("PostToolUse"),
          cwd: root,
          turn_id: longControl,
          tool_input: {
            role: "dispatch",
            lineage: "child",
            provenance: "unknown",
            parent_session_id: "forged-parent",
          },
        }),
      ),
      sessionId: "opaque-root-session",
      project: "caller-project",
      env: { PENUMBRA_MCP_ORIGIN: "maestro" },
      fetchFn,
      write: () => undefined,
    });
    expect(code).toBe(0);
    const trigger = bodies.find((body) => "ingress" in body);
    expect(trigger).toMatchObject({
      cwd: root,
      session_id: "opaque-root-session",
      ingress: {
        harness: "codex",
        role: "maestro",
        lineage: "root",
        provenance: "verified-session-correlation",
        turn_id: null,
        tool_use_id: "tool-1",
      },
    });
    expect(trigger?.args).toBeUndefined();
    services.supervisor.stopAll();
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an overlong correlated session downgrades to truthful unknown instead of forging root", async () => {
  const daemon = daemonFiles();
  try {
    const requests: CapturedRequest[] = [];
    const longSession = "s".repeat(129);
    await runCodexHook({
      storageRoot: daemon.root,
      rawEvent: JSON.stringify(
        event("PreToolUse", { ...eventFields("PreToolUse"), session_id: longSession }),
      ),
      sessionId: longSession,
      env: { PENUMBRA_MCP_ORIGIN: "maestro" },
      fetchFn: recorder(requests),
      write: () => undefined,
    });
    expect(requests[0]?.body).toMatchObject({ session_id: null, origin: "unknown" });
    expect(requests.some((request) => request.path === "/workflows/trigger")).toBe(false);
    const payload = requests[0]?.body.payload_json as Record<string, unknown>;
    expect(payload).toMatchObject({ role: "unknown", lineage: "unknown", provenance: "unknown" });
  } finally {
    daemon.cleanup();
  }
});

async function expectDeadline(fetchFn: typeof fetch): Promise<void> {
  const daemon = daemonFiles();
  try {
    const output: string[] = [];
    const started = performance.now();
    const code = await runCodexHook({
      storageRoot: daemon.root,
      rawEvent: JSON.stringify(event("SessionStart", eventFields("SessionStart"))),
      sessionId: "opaque-root-session",
      env: { PENUMBRA_MCP_ORIGIN: "maestro" },
      fetchFn,
      write: (value) => output.push(value),
      now: () => performance.now(),
    });
    const elapsed = performance.now() - started;
    expect(code).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(1_350);
    expect(elapsed).toBeLessThan(2_200);
    expect(output).toHaveLength(1);
    const parsedOutput: unknown = JSON.parse(output[0] ?? "");
    expect(parsedOutput).toBeDefined();
  } finally {
    daemon.cleanup();
  }
}

test("a hanging fetch shares the total 1500ms budget and emits one advisory", async () => {
  await expectDeadline(
    ((_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }
      })) as typeof fetch,
  );
});

test("a hanging response body is inside the same total budget and emits one advisory", async () => {
  await expectDeadline(((_: string | URL | Request, init?: RequestInit) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => new Promise<never>(() => undefined),
    } as unknown as Response);
  }) as typeof fetch);
});

async function runCli(
  rawEvent: string,
  storageRoot: string,
): Promise<{
  exit: number;
  stdout: string;
  stderr: string;
  elapsed: number;
}> {
  const started = performance.now();
  const child = Bun.spawn(
    [process.execPath, CLI_PATH, "hook", "codex", "--storage-root", storageRoot],
    {
      env: { PATH: process.env.PATH ?? "", PENUMBRA_MCP_ORIGIN: "maestro" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await child.stdin.write(rawEvent);
  await child.stdin.end();
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr, elapsed: performance.now() - started };
}

test("the real CLI emits one event-valid JSON advisory for malformed, oversized, and unavailable daemon input", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-hook-cli-"));
  try {
    const malformed = await runCli("{not-json", root);
    expect(malformed.exit).toBe(0);
    expect(malformed.stderr).toBe("");
    const malformedLines = malformed.stdout.trim().split("\n");
    expect(malformedLines).toHaveLength(1);
    expect(JSON.parse(malformedLines[0] ?? "")).toEqual({});

    const oversized = await runCli("x".repeat(256 * 1024 + 1), root);
    expect(oversized.exit).toBe(0);
    expect(oversized.elapsed).toBeLessThan(2_000);
    expect(oversized.stderr).toBe("");
    const oversizedLines = oversized.stdout.trim().split("\n");
    expect(oversizedLines).toHaveLength(1);
    expect(JSON.parse(oversizedLines[0] ?? "")).toEqual({});

    const unavailable = await runCli(JSON.stringify(event("Stop", eventFields("Stop"))), root);
    expect(unavailable.exit).toBe(0);
    expect(unavailable.stderr).toBe("");
    const unavailableLines = unavailable.stdout.trim().split("\n");
    expect(unavailableLines).toHaveLength(1);
    expect(JSON.parse(unavailableLines[0] ?? "")).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
