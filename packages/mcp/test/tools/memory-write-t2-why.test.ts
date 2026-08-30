import type { DaemonClient } from "@src/daemon-client.js";

import { memoryWriteT2Handler } from "@src/tools/memory-write-t2.js";
import { expect, test } from "bun:test";

import { fakeDaemon } from "../helpers.js";

type MemoryWriteT2Fn = DaemonClient["memoryWriteT2"];

function firstText(content: { type: string; text?: string }[]): string {
  const block = content[0];
  if (block === undefined || typeof block.text !== "string") {
    throw new Error("expected content[0].text");
  }
  return block.text;
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
    why: "Operator requested durable memory",
    source_quote: "Body",
    obs_type: "operator_note",
    durability: "volatile",
    is_episodic: true,
  });
  expect(firstText(out.content)).toContain('"memory_id": "m1"');
});

test("memory_write_t2 still forwards writes when why/source_quote/obs_type are omitted", async () => {
  const calls: unknown[] = [];
  const memoryWriteT2: MemoryWriteT2Fn = (req) => {
    calls.push(req);
    return Promise.resolve({ memory_id: "m2", created: true });
  };
  const handler = memoryWriteT2Handler(fakeDaemon({ memoryWriteT2 }));

  const out = await handler({
    title: "Direct memory baseline",
    body: "Body",
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    title: "Direct memory baseline",
    body: "Body",
  });
  expect(firstText(out.content)).toContain('"memory_id": "m2"');
});
