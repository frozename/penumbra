import { DaemonClient } from "@penumbra/mcp";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { connectInMemory } from "../../mcp/test/helpers.js";
import { makeSandbox } from "./helpers/sandbox.js";
import {
  type BunSubprocess,
  captureOutput,
  drainOutput,
  killGracefully,
  spawnPenumbra,
  waitForPortFile,
} from "./helpers/spawn-bin.js";

interface ToolResult {
  content: { type: string; text: string }[];
}

interface TaskEvent {
  task_id: string;
  at: number;
  kind: string;
  actor: string | null;
  payload: unknown;
}

interface TaskListItem {
  id: string;
  parent_task_id: string | null;
  kind: string;
  eligibility: {
    deny_agents?: string[];
  };
}

interface TaskGetResponse {
  id: string;
  status: string;
  events?: { kind: string }[];
}

interface TaskNextResponse {
  task_id: string;
  prompt: string;
  lease_id: string;
  expires_at: number;
}

type McpClient = Awaited<ReturnType<typeof connectInMemory>>;

function parseToolResult(out: unknown): unknown {
  return JSON.parse((out as ToolResult).content[0]!.text);
}

async function callToolJson<T>(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const out = await client.callTool({ name, arguments: args });
  return parseToolResult(out) as T;
}

function readSseFrames(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: TaskEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  return (async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buf += decoder.decode(value, { stream: true });

        let splitAt = buf.indexOf("\n\n");
        while (splitAt >= 0) {
          const frame = buf.slice(0, splitAt);
          buf = buf.slice(splitAt + 2);
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine) {
            onEvent(JSON.parse(dataLine.slice(6)) as TaskEvent);
          }
          splitAt = buf.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
}

async function waitForEvent(
  events: TaskEvent[],
  predicate: (event: TaskEvent) => boolean,
  timeoutMs: number,
): Promise<TaskEvent> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for task event after ${String(timeoutMs)}ms`);
}

async function waitForLedgerRows(
  dbPath: string,
): Promise<{ agent_name: string; task_type: string; outcome: string }[]> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query<{ agent_name: string; task_type: string; outcome: string }, [string, string]>(
        `SELECT agent_name, task_type, outcome
       FROM agent_performance
       WHERE agent_name IN (?, ?)
       ORDER BY ts ASC, performance_id ASC`,
      )
      .all("e2e-doer", "e2e-reviewer");
    db.close();

    const hasDoer = rows.some((row) => row.agent_name === "e2e-doer");
    const hasReviewer = rows.some((row) => row.agent_name === "e2e-reviewer");
    if (hasDoer && hasReviewer) return rows;
    await Bun.sleep(20);
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .query<{ agent_name: string; task_type: string; outcome: string }, [string, string]>(
      `SELECT agent_name, task_type, outcome
     FROM agent_performance
     WHERE agent_name IN (?, ?)
     ORDER BY ts ASC, performance_id ASC`,
    )
    .all("e2e-doer", "e2e-reviewer");
  db.close();
  return rows;
}

test("task board full-stack smoke: CLI + SSE + MCP + ledger", async () => {
  const sb = makeSandbox();
  let daemon: BunSubprocess | null = null;
  const abort = new AbortController();
  let streamDone: Promise<void> | null = null;
  let mcp: McpClient | null = null;

  const agentchatConfigPath = join(sb.dir, "agentchat.yaml");
  const penumbraConfigDir = join(sb.dir, "penumbra-config");
  writeFileSync(
    agentchatConfigPath,
    [
      "agents:",
      "  - name: e2e-doer",
      "    adapter: noop",
      "    options: {}",
      "    tier: oc",
      "    tags: [implementation]",
      "    cost_cents_per_run: 10",
      "  - name: e2e-reviewer",
      "    adapter: noop",
      "    options: {}",
      "    tier: premium",
      "    tags: [review]",
      "    cost_cents_per_run: 15",
      "default_roles: {}",
    ].join("\n"),
  );
  mkdirSync(penumbraConfigDir, { recursive: true });
  writeFileSync(
    join(penumbraConfigDir, "agents.yaml"),
    [
      "agents:",
      "  - name: e2e-doer",
      "    adapter: noop",
      "    options: {}",
      "    tier: oc",
      "    tags: [implementation]",
      "    cost_cents_per_run: 10",
      "  - name: e2e-reviewer",
      "    adapter: noop",
      "    options: {}",
      "    tier: premium",
      "    tags: [review]",
      "    cost_cents_per_run: 15",
    ].join("\n"),
  );
  writeFileSync(join(penumbraConfigDir, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(penumbraConfigDir, "quotas.yaml"), "providers: []\n");

  const env = {
    AGENTCHAT_CONFIG: agentchatConfigPath,
    PENUMBRA_CONFIG_DIR: penumbraConfigDir,
    PENUMBRA_WORKTREE_ROOT: join(sb.dir, "worktrees"),
  };
  mkdirSync(env.PENUMBRA_WORKTREE_ROOT, { recursive: true });

  try {
    const init = await captureOutput(spawnPenumbra(["init"], sb.dir, env));
    expect(init.exitCode).toBe(0);

    daemon = spawnPenumbra(["start"], sb.dir, env);
    drainOutput(daemon);

    const port = await waitForPortFile(sb.dir, 30_000);
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const token = readFileSync(join(sb.dir, "token"), "utf8").trim();
    expect(token.length).toBeGreaterThan(0);

    const create = await captureOutput(
      spawnPenumbra(
        [
          "task",
          "new",
          "--prompt",
          "smoke test",
          "--priority",
          "normal",
          "--acceptance",
          "criterion 1",
          "--require-review",
        ],
        sb.dir,
        env,
      ),
    );
    expect(create.exitCode).toBe(0);

    const taskId = create.stdout.trim();
    expect(taskId).toMatch(/^task_/);

    const sseRes = await fetch(`${baseUrl}/tasks/events?since=0`, {
      headers: { authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
    expect(sseRes.body).toBeTruthy();

    const streamEvents: TaskEvent[] = [];
    streamDone = readSseFrames(sseRes.body!, (event) => {
      streamEvents.push(event);
    });

    await waitForEvent(
      streamEvents,
      (event) => event.kind === "filed" && event.task_id === taskId,
      1000,
    );

    const daemonClient = new DaemonClient({ baseUrl, token });
    mcp = await connectInMemory(daemonClient);

    const doerLease = await callToolJson<TaskNextResponse | null>(mcp, "task.next", {
      agent_id: "e2e-doer",
    });
    expect(doerLease).not.toBeNull();
    expect(doerLease?.task_id).toBe(taskId);
    expect(doerLease?.prompt).toBe("smoke test");

    const heartbeat = await callToolJson<{ expires_at: number }>(mcp, "task.heartbeat", {
      task_id: taskId,
      lease_id: doerLease!.lease_id,
    });
    expect(heartbeat.expires_at).toBeGreaterThan(0);

    const completed = await callToolJson<{ status: string }>(mcp, "task.complete", {
      task_id: taskId,
      lease_id: doerLease!.lease_id,
      result_summary: "smoke task completed",
      result_artifacts: [{ type: "commit", ref: "abc123" }],
      chain_id: "chain-test-001",
    });
    expect(completed.status).toBe("done_pending_review");

    const reviewList = await callToolJson<{ tasks: TaskListItem[] }>(mcp, "task.list", {
      kind: "review",
      parent_task_id: taskId,
    });
    expect(reviewList.tasks).toHaveLength(1);

    const reviewTask = reviewList.tasks[0]!;
    expect(reviewTask.parent_task_id).toBe(taskId);
    expect(reviewTask.kind).toBe("review");
    expect(reviewTask.eligibility.deny_agents).toContain("e2e-doer");

    const reviewerLease = await callToolJson<TaskNextResponse | null>(mcp, "task.next", {
      agent_id: "e2e-reviewer",
    });
    expect(reviewerLease).not.toBeNull();
    expect(reviewerLease?.task_id).toBe(reviewTask.id);

    const reviewComplete = await callToolJson<{ status: string }>(mcp, "task.complete", {
      task_id: reviewTask.id,
      lease_id: reviewerLease!.lease_id,
      result_summary: "review done",
      review_verdict: {
        passed: true,
        notes: "criterion 1 met",
      },
    });
    expect(reviewComplete.status).toBe("done");

    const parent = await callToolJson<TaskGetResponse>(mcp, "task.get", {
      task_id: taskId,
      include: ["events"],
    });
    expect(parent.status).toBe("done");
    expect(parent.events?.some((event) => event.kind === "review_passed")).toBe(true);

    await waitForEvent(
      streamEvents,
      (event) => event.kind === "review_passed" && event.task_id === taskId,
      1000,
    );

    const rows = await waitForLedgerRows(join(sb.dir, "db.sqlite"));
    expect(
      rows.some(
        (row) =>
          row.agent_name === "e2e-doer" &&
          row.task_type.startsWith("implement_") &&
          row.outcome === "merged",
      ),
    ).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.agent_name === "e2e-reviewer" &&
          row.task_type === "review_adversarial" &&
          row.outcome === "merged",
      ),
    ).toBe(true);

    const parentKinds: string[] = streamEvents
      .filter((event) => event.task_id === taskId)
      .map((event) => event.kind);
    for (const expected of [
      "filed",
      "leased",
      "heartbeat",
      "completed",
      "review_filed",
      "review_passed",
    ]) {
      expect(parentKinds).toContain(expected);
    }

    const reviewKinds: string[] = streamEvents
      .filter((event) => event.task_id === reviewTask.id)
      .map((event) => event.kind);
    for (const expected of ["filed", "leased", "completed"]) {
      expect(reviewKinds).toContain(expected);
    }

    const kindSet = new Set(streamEvents.map((event) => event.kind));
    expect(kindSet.has("filed")).toBe(true);
    expect(kindSet.has("leased")).toBe(true);
    expect(kindSet.has("heartbeat")).toBe(true);
    expect(kindSet.has("completed")).toBe(true);
    expect(kindSet.has("review_filed")).toBe(true);
    expect(kindSet.has("review_passed")).toBe(true);
  } finally {
    if (mcp) await mcp.close();
    abort.abort();
    if (streamDone) {
      await streamDone.catch((): void => undefined);
    }
    if (daemon) {
      await captureOutput(spawnPenumbra(["stop"], sb.dir, env));
      await killGracefully(daemon);
    }
    sb.cleanup();
  }
}, 90_000);
