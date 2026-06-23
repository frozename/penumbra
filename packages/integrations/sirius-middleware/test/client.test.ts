import type { T0EventInput } from "@penumbra/core";

import { expect, test } from "bun:test";

import type { IPenumbraDaemonClient } from "../src/client.js";

import { PenumbraDaemonNoopClient } from "../src/client.js";

const stubEvent: T0EventInput = {
  ts: "2026-01-01T00:00:00Z",
  source: "sirius-middleware",
  user_id: "u",
  machine_id: "m",
  event_type: "agent-prompt",
  lane: "unknown",
  payload_json: {},
};

test("noop client implements interface and does nothing", async () => {
  const client: IPenumbraDaemonClient = new PenumbraDaemonNoopClient();
  await client.observe(stubEvent);
  expect(true).toBe(true);
});
