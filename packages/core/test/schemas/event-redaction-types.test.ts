import { expect, test } from "bun:test";

import { EventTypeSchema } from "../../src/schemas/event.js";

const NEW_TYPES = [
  "agent-response-blocked",
  "agent-response-redaction-hit",
  "agent-response-redaction-bypassed",
  "agent-tool-use-blocked",
  "agent-tool-use-redaction-hit",
  "agent-tool-use-redaction-bypassed",
  "agent-tool-result-blocked",
  "agent-tool-result-redaction-hit",
  "agent-tool-result-redaction-bypassed",
] as const;

for (const t of NEW_TYPES) {
  test(`EventTypeSchema accepts ${t}`, () => {
    expect(() => EventTypeSchema.parse(t)).not.toThrow();
  });
}

test("EventTypeSchema still rejects an unknown type", () => {
  expect(() => EventTypeSchema.parse("not-a-real-event-type")).toThrow();
});
