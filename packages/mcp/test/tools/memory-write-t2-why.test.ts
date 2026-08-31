import { expect, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { memoryWriteT2Handler } from "@src/tools/memory-write-t2.js";

import { fakeDaemon } from "../helpers.js";

type MemoryWriteT2Fn = DaemonClient["memoryWriteT2"];

function firstText(content: { type: string; text?: string }[]): string {
  const block = content[0];
  if (block === undefined || typeof block.text !== "string") {
    throw new Error("expected content[0].text");
  }
  return block.text;
}

async function expectRejects(operation: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
}

test("memory_write_t2 forwards why/source_quote/obs_type when provided", async () => {
  const calls: unknown[] = [];
  const memoryWriteT2: MemoryWriteT2Fn = (req) => {
    calls.push(req);
    return Promise.resolve({ memory_id: "m1", created: true });
  };
  const handler = memoryWriteT2Handler(fakeDaemon({ memoryWriteT2 }));

  const out = await handler({
    title: "Direct memory",
    body: "Body",
    slug: "direct-memory",
    hook: "When direct memory has provenance fields",
    why: "Operator requested durable memory",
    source_quote: "Body",
    obs_type: "operator_note",
    durability: "volatile",
    is_episodic: true,
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    title: "Direct memory",
    body: "Body",
    slug: "direct-memory",
    hook: "When direct memory has provenance fields",
    why: "Operator requested durable memory",
    source_quote: "Body",
    obs_type: "operator_note",
    durability: "volatile",
    is_episodic: true,
  });
  expect(firstText(out.content)).toContain('"memory_id": "m1"');
});

test("memory_write_t2 still forwards writes when optional provenance fields are omitted", async () => {
  const calls: unknown[] = [];
  const memoryWriteT2: MemoryWriteT2Fn = (req) => {
    calls.push(req);
    return Promise.resolve({ memory_id: "m2", created: true });
  };
  const handler = memoryWriteT2Handler(fakeDaemon({ memoryWriteT2 }));

  const out = await handler({
    title: "Direct memory baseline",
    body: "Body",
    slug: "direct-memory-baseline",
    hook: "When direct memory only has required fields",
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    title: "Direct memory baseline",
    body: "Body",
    slug: "direct-memory-baseline",
    hook: "When direct memory only has required fields",
  });
  expect(firstText(out.content)).toContain('"memory_id": "m2"');
});

test("memory_write_t2 rejects missing slug or hook before forwarding to daemon", async () => {
  const calls: unknown[] = [];
  const handler = memoryWriteT2Handler(
    fakeDaemon({
      memoryWriteT2: (req) => {
        calls.push(req);
        return Promise.resolve({ memory_id: "m3", created: true });
      },
    }),
  );

  await expectRejects(() =>
    handler({
      title: "Missing slug",
      body: "Body",
      hook: "When direct memory has no slug",
    }),
  );
  await expectRejects(() =>
    handler({
      title: "Missing hook",
      body: "Body",
      slug: "missing-hook",
    }),
  );
  expect(calls).toHaveLength(0);
});

test("memory_write_t2 rejects visually empty slug or hook before forwarding to daemon", async () => {
  const calls: unknown[] = [];
  const handler = memoryWriteT2Handler(
    fakeDaemon({
      memoryWriteT2: (req) => {
        calls.push(req);
        return Promise.resolve({ memory_id: "m4", created: true });
      },
    }),
  );

  await expectRejects(() =>
    handler({
      title: "Invisible slug",
      body: "Body",
      slug: "\u200B\u200D",
      hook: "When direct memory has no visible slug",
    }),
  );
  await expectRejects(() =>
    handler({
      title: "Invisible hook",
      body: "Body",
      slug: "invisible-hook",
      hook: "\u200B\u200D",
    }),
  );
  expect(calls).toHaveLength(0);
});
