import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runLongLivedApprove,
  runLongLivedAudit,
  runLongLivedGet,
  runLongLivedInject,
  runLongLivedList,
  runLongLivedPause,
  runLongLivedPending,
  runLongLivedReject,
  runLongLivedResume,
  runLongLivedRetire,
  runLongLivedStateGet,
  runLongLivedStateSet,
  runLongLivedTicks,
} from "../src/commands/long-lived.js";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function setupRoot(): string {
  root = mkdtempSync(join(tmpdir(), "penumbra-long-lived-cli-"));
  writeFileSync(join(root, "port"), "59999");
  writeFileSync(join(root, "token"), "tok");
  return root;
}

function mockFetch(expectedPath: string, fixture: unknown): typeof fetch {
  return (path: string | URL | Request) => {
    const asStr =
      typeof path === "string" ? path : path instanceof URL ? path.toString() : path.url;
    expect(asStr).toBe(expectedPath);
    return Promise.resolve(Response.json(fixture));
  };
}

function parseJson(s: string): unknown {
  return JSON.parse(s);
}

test("long-lived list prints JSON", async () => {
  const out: string[] = [];
  await runLongLivedList({
    json: true,
    storageRoot: setupRoot(),
    fetch: mockFetch("/long-lived", { items: [{ id: "ll-1" }] }),
    print: (line) => out.push(line),
  });
  expect((parseJson(out.join("\n")) as { items: { id: string }[] }).items[0]!.id).toBe("ll-1");
});

test("long-lived get prints JSON", async () => {
  const out: string[] = [];
  await runLongLivedGet({
    json: true,
    storageRoot: setupRoot(),
    id: "ll-1",
    fetch: mockFetch("/long-lived/ll-1", { id: "ll-1" }),
    print: (line) => out.push(line),
  });
  expect((parseJson(out.join("\n")) as { id: string }).id).toBe("ll-1");
});

test("long-lived pause prints JSON", async () => {
  const out: string[] = [];
  await runLongLivedPause({
    json: true,
    storageRoot: setupRoot(),
    id: "ll-1",
    fetch: mockFetch("/long-lived/ll-1/pause", { paused: true }),
    print: (line) => out.push(line),
  });
  expect((parseJson(out.join("\n")) as { paused: boolean }).paused).toBe(true);
});

test("long-lived resume prints JSON", async () => {
  const out: string[] = [];
  await runLongLivedResume({
    json: true,
    storageRoot: setupRoot(),
    id: "ll-1",
    fetch: mockFetch("/long-lived/ll-1/resume", { resumed: true }),
    print: (line) => out.push(line),
  });
  expect((parseJson(out.join("\n")) as { resumed: boolean }).resumed).toBe(true);
});

test("long-lived retire prints JSON", async () => {
  const out: string[] = [];
  await runLongLivedRetire({
    json: true,
    storageRoot: setupRoot(),
    id: "ll-1",
    fetch: mockFetch("/long-lived/ll-1/retire", { retired: true }),
    print: (line) => out.push(line),
  });
  expect((parseJson(out.join("\n")) as { retired: boolean }).retired).toBe(true);
});

test("long-lived state get prints JSON", async () => {
  const out: string[] = [];
  await runLongLivedStateGet({
    json: true,
    storageRoot: setupRoot(),
    id: "ll-1",
    fetch: mockFetch("/long-lived/ll-1/state", { intent_summary: "x" }),
    print: (line) => out.push(line),
  });
  expect((parseJson(out.join("\n")) as { intent_summary: string }).intent_summary).toBe("x");
});

test("long-lived state set prints JSON", async () => {
  const out: string[] = [];
  await runLongLivedStateSet({
    json: true,
    storageRoot: setupRoot(),
    id: "ll-1",
    intent_summary: "x",
    working_memory: { a: 1 },
    fetch: mockFetch("/long-lived/ll-1/state", { updated: true }),
    print: (line) => out.push(line),
  });
  expect((parseJson(out.join("\n")) as { updated: boolean }).updated).toBe(true);
});

test("long-lived pending prints JSON", async () => {
  const out: string[] = [];
  await runLongLivedPending({
    json: true,
    storageRoot: setupRoot(),
    id: "ll-1",
    fetch: mockFetch("/long-lived/ll-1/pending-actions?status=pending", { actions: [] }),
    print: (line) => out.push(line),
  });
  expect((parseJson(out.join("\n")) as { actions: unknown[] }).actions).toHaveLength(0);
});

test("long-lived approve prints JSON", async () => {
  const out: string[] = [];
  await runLongLivedApprove({
    json: true,
    storageRoot: setupRoot(),
    action_id: "act-1",
    fetch: mockFetch("/long-lived/pending-actions/act-1/approve", { approved: true }),
    print: (line) => out.push(line),
  });
  expect((parseJson(out.join("\n")) as { approved: boolean }).approved).toBe(true);
});

test("long-lived reject prints JSON", async () => {
  const out: string[] = [];
  await runLongLivedReject({
    json: true,
    storageRoot: setupRoot(),
    action_id: "act-1",
    reason: "nope",
    fetch: mockFetch("/long-lived/pending-actions/act-1/reject", { rejected: true }),
    print: (line) => out.push(line),
  });
  expect((parseJson(out.join("\n")) as { rejected: boolean }).rejected).toBe(true);
});

test("long-lived inject prints JSON", async () => {
  const out: string[] = [];
  await runLongLivedInject({
    json: true,
    storageRoot: setupRoot(),
    id: "ll-1",
    goal: "g",
    fetch: mockFetch("/long-lived/ll-1/inject-goal", { injected: true }),
    print: (line) => out.push(line),
  });
  expect((parseJson(out.join("\n")) as { injected: boolean }).injected).toBe(true);
});

test("long-lived audit prints JSON", async () => {
  const out: string[] = [];
  await runLongLivedAudit({
    json: true,
    storageRoot: setupRoot(),
    id: "ll-1",
    since: "1",
    limit: "2",
    fetch: mockFetch("/long-lived/ll-1/audit?since=1&limit=2", { audit: [] }),
    print: (line) => out.push(line),
  });
  expect((parseJson(out.join("\n")) as { audit: unknown[] }).audit).toHaveLength(0);
});

test("long-lived ticks prints JSON", async () => {
  const out: string[] = [];
  await runLongLivedTicks({
    json: true,
    storageRoot: setupRoot(),
    id: "ll-1",
    since: "1",
    limit: "2",
    fetch: mockFetch("/long-lived/ll-1/ticks?since=1&limit=2", { ticks: [] }),
    print: (line) => out.push(line),
  });
  expect((parseJson(out.join("\n")) as { ticks: unknown[] }).ticks).toHaveLength(0);
});
