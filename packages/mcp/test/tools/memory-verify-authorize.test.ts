import type { DaemonClient } from "@src/daemon-client.js";

import { memoryVerifyAuthorizeHandler } from "@src/tools/memory-verify-authorize.js";
import { expect, test } from "bun:test";

import { fakeDaemon } from "../helpers.js";

type MemoryVerifyAuthorizeFn = DaemonClient["memoryVerifyAuthorize"];

test("memory_verify_authorize handler forwards the parsed payload", async () => {
  const calls: unknown[] = [];
  const memoryVerifyAuthorize: MemoryVerifyAuthorizeFn = (req) => {
    calls.push(req);
    return Promise.resolve({ ok: true, authorized: true, events_written: 1 });
  };
  const handler = memoryVerifyAuthorizeHandler(fakeDaemon({ memoryVerifyAuthorize }));
  const out = await handler({
    handoff_id: "h1",
    verdict: "passed",
    basis: { kind: "manual_override", reason: "ok", authorized_by: "lead" },
  });
  expect(calls).toHaveLength(1);
  const block = out.content[0];
  if (block === undefined || typeof block.text !== "string") {
    throw new Error("expected content[0].text");
  }
  expect(block.text).toContain('"authorized": true');
});
