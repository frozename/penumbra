import { normalize } from "@src/normalize/ingest.js";
import { DEFAULT_REDACTION_RULES, RegexRedactor } from "@src/redaction/regex.js";
import { expect, test } from "bun:test";

const redactor = new RegexRedactor(DEFAULT_REDACTION_RULES);
const ctx = {
  userId: "u-1",
  machineId: "m-1",
  now: (): Date => new Date("2026-04-23T12:00:00.000Z"),
  uuid: (): string => "fixed-uuid",
  redactor,
};

test("fills in event_id, ingest_ts, and default nullables", () => {
  const e = normalize(
    {
      ts: "2026-04-23T11:59:59.000Z",
      source: "mcp",
      user_id: "overridden-by-ctx?",
      machine_id: "overridden-by-ctx?",
      event_type: "agent-tool-use",
      lane: "local",
      payload_json: { tool: "Read", api_key: "sk-secret" },
    },
    ctx,
  );
  expect(e.event_id).toBe("fixed-uuid");
  expect(e.ingest_ts).toBe("2026-04-23T12:00:00.000Z");
  expect(e.user_id).toBe("u-1");
  expect(e.machine_id).toBe("m-1");
  expect(e.payload_json).toEqual({ tool: "Read", api_key: "[REDACTED]" });
  expect(e.source_detail).toBeNull();
  expect(e.project_id).toBeNull();
});

test("preserves explicit event_id and ingest_ts when provided", () => {
  const e = normalize(
    {
      event_id: "explicit",
      ingest_ts: "2026-04-23T12:05:00.000Z",
      ts: "2026-04-23T11:59:59.000Z",
      source: "mcp",
      user_id: "x",
      machine_id: "x",
      event_type: "agent-prompt",
      lane: "local",
      payload_json: {},
    },
    ctx,
  );
  expect(e.event_id).toBe("explicit");
  expect(e.ingest_ts).toBe("2026-04-23T12:05:00.000Z");
});

test("strips privacy-tagged text from payload_summary", () => {
  const e = normalize(
    {
      ts: "2026-04-23T11:59:59.000Z",
      source: "mcp",
      user_id: "x",
      machine_id: "x",
      event_type: "agent-prompt",
      lane: "local",
      payload_json: { prompt: "keep <private>secret</private> done" },
      payload_summary: "keep <private>secret</private> done",
    },
    ctx,
  );
  expect(e.payload_summary).toBe("keep  done");
});

test("strips privacy-tagged text from payload_json string leaves (top-level)", () => {
  const e = normalize(
    {
      ts: "2026-04-23T11:59:59.000Z",
      source: "mcp",
      user_id: "x",
      machine_id: "x",
      event_type: "agent-prompt",
      lane: "local",
      payload_json: {
        prompt: "keep <private>sk-super-secret-token-DO-NOT-INDEX</private> done",
        text: "before <private>SSN 123-45-6789</private> after",
      },
    },
    ctx,
  );
  const payload = e.payload_json as Record<string, string>;
  expect(payload.prompt).toBe("keep  done");
  expect(payload.text).toBe("before  after");
  const serialized = JSON.stringify(e.payload_json);
  expect(serialized).not.toContain("<private>");
  expect(serialized).not.toContain("sk-super-secret-token-DO-NOT-INDEX");
  expect(serialized).not.toContain("SSN 123-45-6789");
});

test("strips privacy-tagged text from nested payload_json (objects + arrays)", () => {
  const e = normalize(
    {
      ts: "2026-04-23T11:59:59.000Z",
      source: "mcp",
      user_id: "x",
      machine_id: "x",
      event_type: "agent-prompt",
      lane: "local",
      payload_json: {
        messages: [
          { role: "user", content: "hello <private>NESTED_SECRET_A</private> world" },
          { role: "assistant", content: "ok" },
        ],
        meta: {
          note: "outer <private>NESTED_SECRET_B</private> tail",
          tags: ["a", "<private>NESTED_SECRET_C</private>", "b"],
        },
      },
    },
    ctx,
  );
  const serialized = JSON.stringify(e.payload_json);
  expect(serialized).not.toContain("<private>");
  expect(serialized).not.toContain("NESTED_SECRET_A");
  expect(serialized).not.toContain("NESTED_SECRET_B");
  expect(serialized).not.toContain("NESTED_SECRET_C");
  const payload = e.payload_json as {
    messages: { role: string; content: string }[];
    meta: { note: string; tags: string[] };
  };
  expect(payload.messages[0].content).toBe("hello  world");
  expect(payload.meta.note).toBe("outer  tail");
  expect(payload.meta.tags).toEqual(["a", "", "b"]);
});

test("privacy-tag stripping composes with key-name redaction", () => {
  const e = normalize(
    {
      ts: "2026-04-23T11:59:59.000Z",
      source: "mcp",
      user_id: "x",
      machine_id: "x",
      event_type: "agent-prompt",
      lane: "local",
      payload_json: {
        api_key: "sk-should-be-key-redacted",
        prompt: "keep <private>content-should-be-tag-stripped</private> done",
      },
    },
    ctx,
  );
  const payload = e.payload_json as Record<string, string>;
  expect(payload.api_key).toBe("[REDACTED]");
  expect(payload.prompt).toBe("keep  done");
});
