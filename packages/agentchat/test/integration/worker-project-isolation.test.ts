import { expect, test } from "bun:test";

import { startEventSource } from "../../src/worker/event-source.js";

const pollWaitMs = 60;

interface ListHandoffsOpts {
  statuses: string[];
  conversation_id?: string;
  project_id?: string | null;
}

interface HandoffStub {
  handoff_id: string;
  status: string;
  project_id: string;
}

interface StubClient {
  listHandoffs: (opts: ListHandoffsOpts) => Promise<{ handoffs: HandoffStub[] }>;
  subscribeHandoffEvents: () => AsyncIterable<HandoffStub>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stubClient(overrides: {
  listHandoffs: (opts: ListHandoffsOpts) => Promise<{ handoffs: HandoffStub[] }>;
}): StubClient {
  return {
    listHandoffs: overrides.listHandoffs,
    subscribeHandoffEvents: (): AsyncIterable<HandoffStub> => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("sse-disabled")),
      }),
    }),
  };
}

function isHandoffStub(row: unknown): row is HandoffStub {
  if (typeof row !== "object" || row === null) return false;
  const candidate = row as Record<string, unknown>;
  return typeof candidate.handoff_id === "string" && typeof candidate.project_id === "string";
}

test("hard-isolated worker only keeps project-scoped claims", async () => {
  const calls: ListHandoffsOpts[] = [];
  const claimed: string[] = [];
  const rejected: string[] = [];
  const handoffs: HandoffStub[] = [
    { handoff_id: "alpha-1", status: "approved", project_id: "project-a" },
    { handoff_id: "beta-1", status: "approved", project_id: "project-b" },
  ];

  const client = stubClient({
    listHandoffs: (opts: ListHandoffsOpts) => {
      calls.push(opts);
      return Promise.resolve({ handoffs });
    },
  });

  const handle = startEventSource({
    client,
    statuses: ["approved"],
    project_id: "project-a",
    isolation: "hard",
    pollIntervalMs: 5,
    onEvent: (row) => {
      if (!isHandoffStub(row)) return;
      if (row.project_id === "project-a") {
        claimed.push(row.handoff_id);
      } else {
        rejected.push(row.handoff_id);
      }
    },
  });

  await sleep(pollWaitMs);
  await handle.stop();

  expect(calls.length).toBeGreaterThan(0);
  expect(calls.at(0)?.project_id).toBe("project-a");
  expect(claimed).toContain("alpha-1");
  expect(rejected).toContain("beta-1");
});

test("sticky worker falls back to shared queue when project queue is empty", async () => {
  const calls: ListHandoffsOpts[] = [];
  const claimed: string[] = [];
  const projectRows: HandoffStub[] = [];
  const sharedRows: HandoffStub[] = [
    { handoff_id: "shared-1", status: "approved", project_id: "project-shared" },
  ];

  const client = stubClient({
    listHandoffs: (opts: ListHandoffsOpts) => {
      calls.push(opts);
      if (opts.project_id) return Promise.resolve({ handoffs: projectRows });
      return Promise.resolve({ handoffs: sharedRows });
    },
  });

  const handle = startEventSource({
    client,
    statuses: ["approved"],
    project_id: "project-a",
    isolation: "sticky",
    pollIntervalMs: 5,
    onEvent: (row) => {
      if (!isHandoffStub(row)) return;
      claimed.push(row.handoff_id);
    },
  });

  await sleep(pollWaitMs);
  await handle.stop();

  expect(calls.some((call) => call.project_id === "project-a")).toBe(true);
  expect(calls.some((call) => call.project_id === undefined)).toBe(true);
  expect(claimed).toEqual(["shared-1"]);
});

test("shared worker polls without project filter and can claim any project", async () => {
  const calls: ListHandoffsOpts[] = [];
  const claimed: string[] = [];
  const handoffs: HandoffStub[] = [
    { handoff_id: "any-1", status: "approved", project_id: "project-a" },
    { handoff_id: "any-2", status: "approved", project_id: "project-b" },
  ];

  const client = stubClient({
    listHandoffs: (opts: ListHandoffsOpts) => {
      calls.push(opts);
      return Promise.resolve({ handoffs });
    },
  });

  const handle = startEventSource({
    client,
    statuses: ["approved"],
    project_id: "project-a",
    isolation: "shared",
    pollIntervalMs: 5,
    onEvent: (row) => {
      if (!isHandoffStub(row)) return;
      claimed.push(row.handoff_id);
    },
  });

  await sleep(pollWaitMs);
  await handle.stop();

  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((call) => call.project_id === undefined)).toBe(true);
  expect(claimed.sort()).toEqual(["any-1", "any-2"]);
});
