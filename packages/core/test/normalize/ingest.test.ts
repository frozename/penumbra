import { expect, test } from "bun:test";
import { normalize } from "../../src/normalize/ingest.js";
import { DEFAULT_REDACTION_RULES, RegexRedactor } from "../../src/redaction/regex.js";

const redactor = new RegexRedactor(DEFAULT_REDACTION_RULES);
const ctx = {
  userId: "u-1",
  machineId: "m-1",
  now: () => new Date("2026-04-23T12:00:00.000Z"),
  uuid: () => "fixed-uuid",
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
