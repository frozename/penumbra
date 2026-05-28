import { expect, test } from "bun:test";
import { PenumbraDaemonNoopClient } from "../src/client.js";
import type { IPenumbraDaemonClient } from "../src/client.js";

test("noop client implements interface and does nothing", async () => {
  const client: IPenumbraDaemonClient = new PenumbraDaemonNoopClient();
  await client.observe({} as any); // Should resolve without throwing
  expect(true).toBe(true);
});
