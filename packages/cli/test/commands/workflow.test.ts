import { runWorkflowList, runWorkflowRun } from "@src/commands/workflow.js";
import { expect, test } from "bun:test";

test("runWorkflowList prints names + descriptions", async () => {
  const calls: string[] = [];
  const out = (s: string): void => {
    calls.push(s);
  };
  const fakeFetch = (): Promise<{
    workflows: { name: string; description: string; triggers: unknown[] }[];
  }> => Promise.resolve({ workflows: [{ name: "demo", description: "d", triggers: [] }] });
  await runWorkflowList({ out, fetchList: fakeFetch });
  expect(calls.join("\n")).toContain("demo");
  expect(calls.join("\n")).toContain("d");
});

test('runWorkflowList prints "(no workflows registered)" on empty', async () => {
  const calls: string[] = [];
  await runWorkflowList({
    out: (s) => calls.push(s),
    fetchList: () => Promise.resolve({ workflows: [] }),
  });
  expect(calls.join("\n")).toContain("no workflows");
});

test("runWorkflowRun forwards --session-id in the request body", async () => {
  const captured: { path: string; body: unknown }[] = [];
  const post = (path: string, body: unknown): Promise<unknown> => {
    captured.push({ path, body });
    return Promise.resolve({ outcome: "success" });
  };
  await runWorkflowRun({
    out: () => {
      /* discard */
    },
    storageRoot: "/tmp",
    name: "session-handoff",
    sessionId: "sess-123",
    post,
  });
  expect(captured).toHaveLength(1);
  expect(captured[0]?.path).toBe("/workflows/run");
  expect(captured[0]?.body).toEqual({ name: "session-handoff", session_id: "sess-123" });
});

test("runWorkflowRun omits session_id when not provided", async () => {
  const captured: { body: unknown }[] = [];
  const post = (_path: string, body: unknown): Promise<unknown> => {
    captured.push({ body });
    return Promise.resolve({});
  };
  await runWorkflowRun({
    out: () => {
      /* discard */
    },
    storageRoot: "/tmp",
    name: "wf",
    post,
  });
  expect(captured[0]?.body).toEqual({ name: "wf" });
});
