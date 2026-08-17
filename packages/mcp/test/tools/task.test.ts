import { type TextContentEnvelope } from "@nova/mcp-shared";
import {
  CancelTaskInputSchema,
  CompleteTaskInputSchema,
  FailTaskInputSchema,
  FileTaskInputSchema,
  HeartbeatTaskInputSchema,
  TaskKindSchema,
  TaskRecordSchema,
  TaskStatusSchema,
} from "@penumbra/core";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { taskCancelHandler } from "../../src/tools/task-cancel.js";
import { taskCommentGhHandler } from "../../src/tools/task-comment-gh.js";
import { taskCompleteHandler } from "../../src/tools/task-complete.js";
import { taskFailHandler } from "../../src/tools/task-fail.js";
import { taskFileHandler } from "../../src/tools/task-file.js";
import { taskGetHandler } from "../../src/tools/task-get.js";
import { taskHeartbeatHandler } from "../../src/tools/task-heartbeat.js";
import { taskLinkGhHandler } from "../../src/tools/task-link-gh.js";
import { taskListHandler } from "../../src/tools/task-list.js";
import { taskNextHandler } from "../../src/tools/task-next.js";
import { taskSyncGhNowHandler } from "../../src/tools/task-sync-gh-now.js";
import { taskUnlinkGhHandler } from "../../src/tools/task-unlink-gh.js";

function parseToolResult(out: TextContentEnvelope): unknown {
  return JSON.parse(out.content[0]!.text);
}

function sampleTask(taskId: string): z.infer<typeof TaskRecordSchema> {
  return {
    id: taskId,
    created_at: 1_746_000_000_000,
    updated_at: 1_746_000_000_123,
    created_by_kind: "human",
    created_by_id: "cli",
    project_id: "proj_1",
    parent_task_id: null,
    kind: "work",
    priority: "normal",
    prompt: "implement task board MCP wiring",
    acceptance_criteria: "green tests",
    expected_artifacts: [{ type: "commit", ref: "abc123" }],
    eligibility: {
      required_tags: ["typescript"],
      min_tier: "standard",
      max_cost_cents: 50,
      deny_agents: [],
      allow_agents: ["codex"],
      heartbeat_ttl_ms: 90_000,
      preference_window_ms: 30_000,
      max_attempts: 1,
    },
    review_eligibility: null,
    requires_review: false,
    status: "pending",
    result_summary: null,
    result_artifacts: null,
    failure_reason: null,
    chain_id: null,
    origin: "mcp-test",
  };
}

describe("task.* handlers", () => {
  test("task.file forwards FileTaskInput and origin, returns {task_id}", async () => {
    const calls: { input: unknown; opts: { origin?: string } }[] = [];
    const handler = taskFileHandler({
      taskFile: (input, opts) => {
        calls.push({ input, opts });
        return Promise.resolve({ task_id: "task_1" });
      },
    });

    const input = {
      prompt: "wire mcp tool",
      acceptance_criteria: "tool is callable",
      expected_artifacts: [{ type: "commit" as const, ref: "deadbeef" }],
      gh_create: {
        repo: "frozename/penumbra",
        title: "Task issue title",
        body: "Task issue body",
        labels: ["tasks"],
        assignees: ["frozename"],
      },
      eligibility: { required_tags: ["typescript"] },
      review_eligibility: { min_tier: "premium" },
      priority: "high" as const,
      kind: "work" as const,
      requires_review: true,
      parent_task_id: "task_parent",
      origin: "tool-body-origin",
      created_by_kind: "agent" as const,
      created_by_id: "codex",
    };

    const out = await handler(input, { _meta: { origin: "mcp-origin" } });

    expect(FileTaskInputSchema.parse(calls[0]?.input)).toEqual(input);
    expect(calls[0]?.opts).toEqual({ origin: "mcp-origin" });
    const parsed = z.object({ task_id: z.string().min(1) }).parse(parseToolResult(out));
    expect(parsed.task_id).toBe("task_1");
  });

  test("task.list forwards filters and returns {tasks: TaskRecord[]}", async () => {
    const calls: { filters: unknown }[] = [];
    const handler = taskListHandler({
      taskList: (filters) => {
        calls.push({ filters });
        return Promise.resolve({ tasks: [sampleTask("task_2")] });
      },
    });

    const input = {
      status: "pending" as z.infer<typeof TaskStatusSchema>,
      kind: "work" as z.infer<typeof TaskKindSchema>,
      eligible_for: "codex",
      parent_task_id: "task_parent",
      origin: "dispatch",
      limit: 5,
      offset: 2,
    };

    const out = await handler(input);

    expect(calls[0]?.filters).toEqual(input);
    const parsed = z.object({ tasks: z.array(TaskRecordSchema) }).parse(parseToolResult(out));
    expect(parsed.tasks).toHaveLength(1);
  });

  test("task.get forwards task_id/include and returns task payload", async () => {
    const calls: {
      taskId: string;
      opts: { include?: ("lease" | "events" | "descendants")[] };
    }[] = [];
    const handler = taskGetHandler({
      taskGet: (taskId, opts) => {
        calls.push({ taskId, opts });
        return Promise.resolve({
          ...sampleTask(taskId),
          lease: {
            id: "lease_3",
            task_id: taskId,
            agent_id: "codex",
            claimed_at: 1_746_000_000_111,
            expires_at: 1_746_000_090_111,
            released_at: null,
            release_reason: null,
            auction_score: 0.9,
          },
          events: [
            {
              id: 1,
              task_id: taskId,
              at: 1_746_000_000_100,
              kind: "filed",
              actor: "cli",
              payload: null,
            },
          ],
          descendants: {
            count: 0,
            depth: 0,
            ids: [],
          },
        });
      },
    });

    const out = await handler({ task_id: "task_3", include: ["lease", "events", "descendants"] });

    expect(calls[0]).toEqual({
      taskId: "task_3",
      opts: { include: ["lease", "events", "descendants"] },
    });
    const parsed = z
      .object({
        ...TaskRecordSchema.shape,
        lease: z
          .object({
            id: z.string(),
            task_id: z.string(),
            agent_id: z.string(),
            claimed_at: z.number().int(),
            expires_at: z.number().int(),
            released_at: z.number().int().nullable(),
            release_reason: z.string().nullable(),
            auction_score: z.number().nullable(),
          })
          .nullable()
          .optional(),
        events: z
          .array(
            z.object({
              id: z.number().int(),
              task_id: z.string(),
              at: z.number().int(),
              kind: z.enum([
                "filed",
                "auctioned",
                "leased",
                "heartbeat",
                "completed",
                "cancelled",
                "released",
                "review_filed",
                "review_passed",
                "review_failed",
              ]),
              actor: z.string().nullable(),
              payload: z.unknown().nullable(),
            }),
          )
          .optional(),
        descendants: z
          .object({
            count: z.number().int(),
            depth: z.number().int(),
            ids: z.array(z.string()),
          })
          .optional(),
      })
      .strict()
      .parse(parseToolResult(out));
    expect(parsed.id).toBe("task_3");
  });

  test("task.next forwards lease request and maps no-task to null", async () => {
    const calls: { input: unknown }[] = [];
    const handler = taskNextHandler({
      taskNext: (input) => {
        calls.push({ input });
        return Promise.resolve(null);
      },
    });

    const input = {
      agent_id: "codex",
      tags: ["typescript"],
      max_cost_cents: 42,
    };

    const out = await handler(input);

    expect(calls[0]?.input).toEqual(input);
    expect(parseToolResult(out)).toBeNull();
  });

  test("task.heartbeat forwards body and returns {expires_at}", async () => {
    const calls: { taskId: string; body: { lease_id: string } }[] = [];
    const handler = taskHeartbeatHandler({
      taskHeartbeat: (taskId, body) => {
        calls.push({ taskId, body });
        return Promise.resolve({ expires_at: 1_746_000_090_000 });
      },
    });

    const input = { task_id: "task_5", lease_id: "lease_5" };
    const out = await handler(input);

    expect(calls[0]).toEqual({ taskId: "task_5", body: { lease_id: "lease_5" } });
    expect(HeartbeatTaskInputSchema.parse({ task_id: "task_5", ...calls[0]?.body })).toEqual(input);
    const parsed = z.object({ expires_at: z.number().int() }).parse(parseToolResult(out));
    expect(parsed.expires_at).toBe(1_746_000_090_000);
  });

  test("task.complete forwards CompleteTaskInput and returns {status}", async () => {
    const calls: {
      taskId: string;
      body: {
        lease_id?: string;
        result_summary: string;
        result_artifacts?: unknown[];
        chain_id?: string;
        review_verdict?: unknown;
      };
    }[] = [];
    const handler = taskCompleteHandler({
      taskComplete: (taskId, body) => {
        calls.push({ taskId, body });
        return Promise.resolve({ status: "done" });
      },
    });

    const input = {
      task_id: "task_6",
      lease_id: "lease_6",
      result_summary: "done",
      result_artifacts: [{ type: "commit" as const, ref: "cafebabe" }],
      chain_id: "conv_6",
      review_verdict: { passed: true, notes: "checked" },
    };
    const out = await handler(input);

    expect(calls[0]).toEqual({
      taskId: "task_6",
      body: {
        lease_id: "lease_6",
        result_summary: "done",
        result_artifacts: [{ type: "commit", ref: "cafebabe" }],
        chain_id: "conv_6",
        review_verdict: { passed: true, notes: "checked" },
      },
    });
    expect(CompleteTaskInputSchema.parse({ task_id: "task_6", ...calls[0]?.body })).toEqual(input);
    const parsed = z.object({ status: z.string().min(1) }).parse(parseToolResult(out));
    expect(parsed.status).toBe("done");
  });

  test("task.complete forwards an omitted lease_id as a lease-less completion", async () => {
    const calls: {
      taskId: string;
      body: {
        lease_id?: string;
        result_summary: string;
        result_artifacts?: unknown[];
      };
    }[] = [];
    const handler = taskCompleteHandler({
      taskComplete: (taskId, body) => {
        calls.push({ taskId, body });
        return Promise.resolve({ status: "done" });
      },
    });

    const input = {
      task_id: "task_6b",
      result_summary: "landed cleanly",
      result_artifacts: [{ type: "commit" as const, ref: "cafebabe" }],
    };

    // lease_id is optional at the tool layer: the daemon's principal-aware
    // gate decides whether a lease-less completion is allowed, not the schema.
    await handler(input);
    expect(calls.length).toBe(1);
    expect(calls[0]?.taskId).toBe("task_6b");
    expect(calls[0]?.body.lease_id).toBeUndefined();
    expect(calls[0]?.body.result_summary).toBe("landed cleanly");
  });

  test("task.fail forwards FailTaskInput and returns {status}", async () => {
    const calls: { taskId: string; body: { lease_id: string; reason: string } }[] = [];
    const handler = taskFailHandler({
      taskFail: (taskId, body) => {
        calls.push({ taskId, body });
        return Promise.resolve({ status: "failed" });
      },
    });

    const input = { task_id: "task_7", lease_id: "lease_7", reason: "tool crashed" };
    const out = await handler(input);

    expect(calls[0]).toEqual({
      taskId: "task_7",
      body: { lease_id: "lease_7", reason: "tool crashed" },
    });
    expect(FailTaskInputSchema.parse({ task_id: "task_7", ...calls[0]?.body })).toEqual(input);
    const parsed = z.object({ status: z.string().min(1) }).parse(parseToolResult(out));
    expect(parsed.status).toBe("failed");
  });

  test("task.cancel forwards CancelTaskInput and returns {status}", async () => {
    const calls: { taskId: string; body: { reason?: string } }[] = [];
    const handler = taskCancelHandler({
      taskCancel: (taskId, body) => {
        calls.push({ taskId, body });
        return Promise.resolve({ status: "cancelled" });
      },
    });

    const input = { task_id: "task_8", reason: "obsolete" };
    const out = await handler(input);

    expect(calls[0]).toEqual({ taskId: "task_8", body: { reason: "obsolete" } });
    expect(CancelTaskInputSchema.parse({ task_id: "task_8", ...calls[0]?.body })).toEqual(input);
    const parsed = z.object({ status: z.string().min(1) }).parse(parseToolResult(out));
    expect(parsed.status).toBe("cancelled");
  });

  test("task.link_gh forwards link input and returns sync payload", async () => {
    const calls: { taskId: string; body: { repo: string; issue_number: number } }[] = [];
    const handler = taskLinkGhHandler({
      taskLinkGh: (taskId, body) => {
        calls.push({ taskId, body });
        return Promise.resolve({
          task_id: taskId,
          gh_issue_url: "https://github.com/frozename/penumbra/issues/1",
          gh_state: "queued",
          last_sync_ts: null,
          gh_sync_status: "queued",
        });
      },
    });

    const out = await handler({ task_id: "task_9", repo: "frozename/penumbra", issue_number: 1 });

    expect(calls[0]).toEqual({
      taskId: "task_9",
      body: { repo: "frozename/penumbra", issue_number: 1 },
    });
    const parsed = z
      .object({
        task_id: z.string(),
        gh_issue_url: z.string(),
        gh_state: z.string(),
        last_sync_ts: z.string().nullable(),
        gh_sync_status: z.string().optional(),
      })
      .parse(parseToolResult(out));
    expect(parsed.task_id).toBe("task_9");
  });

  test("task.comment_gh forwards manual comment input and returns comment_url", async () => {
    const calls: { taskId: string; body: { body: string } }[] = [];
    const handler = taskCommentGhHandler({
      taskCommentGh: (taskId, body) => {
        calls.push({ taskId, body });
        return Promise.resolve({
          comment_url: "https://github.com/frozename/penumbra/issues/1#issuecomment-222",
        });
      },
    });

    const out = await handler({ task_id: "task_9", body: "please investigate this edge case" });

    expect(calls[0]).toEqual({
      taskId: "task_9",
      body: { body: "please investigate this edge case" },
    });
    const parsed = z
      .object({
        comment_url: z.url(),
      })
      .parse(parseToolResult(out));
    expect(parsed.comment_url).toContain("issuecomment");
  });

  test("task.unlink_gh forwards task_id and returns {ok}", async () => {
    const calls: { taskId: string }[] = [];
    const handler = taskUnlinkGhHandler({
      taskUnlinkGh: (taskId) => {
        calls.push({ taskId });
        return Promise.resolve({ ok: true });
      },
    });

    const out = await handler({ task_id: "task_10" });

    expect(calls[0]?.taskId).toBe("task_10");
    const parsed = z.object({ ok: z.boolean() }).parse(parseToolResult(out));
    expect(parsed.ok).toBe(true);
  });

  test("task.sync_gh_now forwards optional task_id and returns summary", async () => {
    const calls: { input: { task_id?: string } }[] = [];
    const handler = taskSyncGhNowHandler({
      taskSyncGhNow: (input) => {
        calls.push({ input });
        return Promise.resolve({
          linked: 1,
          pushed: 0,
          pulled: 1,
          errored: 0,
          skipped: false,
          results: [{ task_id: "task_11" }],
        });
      },
    });

    const out = await handler({ task_id: "task_11" });
    expect(calls[0]?.input).toEqual({ task_id: "task_11" });

    const parsed = z
      .object({
        linked: z.number().int(),
        pushed: z.number().int(),
        pulled: z.number().int(),
        errored: z.number().int(),
        skipped: z.boolean(),
        results: z.array(z.unknown()),
      })
      .parse(parseToolResult(out));
    expect(parsed.pulled).toBe(1);
  });
});
