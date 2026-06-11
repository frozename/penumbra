import { expect, test } from "bun:test";
import { memoryWriteT2Handler } from "../../src/tools/memory-write-t2.js";

test("memory_write_t2 forwards why/source_quote/obs_type when provided", async () => {
  const calls: unknown[] = [];
  const handler = memoryWriteT2Handler({
    memoryWriteT2: async (req: unknown) => {
      calls.push(req);
      return { memory_id: "m1", created: true };
    },
  } as any);

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
  expect(out.content[0].text).toContain('"memory_id": "m1"');
});

test("memory_write_t2 still forwards writes when why/source_quote/obs_type are omitted", async () => {
  const calls: unknown[] = [];
  const handler = memoryWriteT2Handler({
    memoryWriteT2: async (req: unknown) => {
      calls.push(req);
      return { memory_id: "m2", created: true };
    },
  } as any);

  const out = await handler({
    title: "Direct memory baseline",
    body: "Body",
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    title: "Direct memory baseline",
    body: "Body",
  });
  expect(out.content[0].text).toContain('"memory_id": "m2"');
});
