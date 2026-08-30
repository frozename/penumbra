import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { DaemonHttpError } from "@src/daemon-client.js";
import {
  chainGetResponseHandler,
  ChainGetResponseInputShape,
} from "@src/tools/chain-get-response.js";

import { fakeDaemon } from "../helpers.js";

type GetChainResponsesFn = DaemonClient["getChainResponses"];

function textOf(res: { content: { text?: unknown }[] }): string {
  const text = res.content[0].text;
  if (typeof text !== "string") throw new Error("expected text content");
  return text;
}

test("ChainGetResponseInputShape requires conversation_id", () => {
  expect(() => ChainGetResponseInputShape.conversation_id.parse(undefined)).toThrow();
  expect(ChainGetResponseInputShape.which.parse(undefined)).toBe("final");
  expect(ChainGetResponseInputShape.which.parse("all")).toBe("all");
});

test("chainGetResponseHandler calls daemon.getChainResponses and formats output", async () => {
  const getChainResponses: GetChainResponsesFn = (conversation_id, which) => {
    expect(conversation_id).toBe("conv1");
    expect(which).toBe("all");
    return Promise.resolve({ responses: [{ agent: "a", text: "hi", ts: "t" }] });
  };
  const daemon = fakeDaemon({ getChainResponses });
  const handler = chainGetResponseHandler(daemon);
  const res = await handler({ conversation_id: "conv1", which: "all" });
  expect(res.content[0].type).toBe("text");
  const text = textOf(res);
  expect(text).toMatch(/^● chain_get_response {2}/);
  expect(text).toContain('"agent": "a"');
});

test("chainGetResponseHandler preserves multiline text and optional error fields", async () => {
  const getChainResponses = mock<GetChainResponsesFn>(() =>
    Promise.resolve({
      responses: [
        { agent: "planner", text: "line1\nline2", ts: "t1" },
        { agent: "planner", text: "", error: { message: "adapter crashed" }, ts: "t2" },
      ],
    }),
  );
  const daemon = fakeDaemon({ getChainResponses });
  const handler = chainGetResponseHandler(daemon);
  const res = await handler({ conversation_id: "conv1", which: "all" });
  const text = textOf(res);
  expect(text).toMatch(/^● chain_get_response {2}/);
  expect(text).toContain("line1\\nline2");
  expect(text).toContain("adapter crashed");
});

test("chainGetResponseHandler maps daemon 404s to a structured not_found payload", async () => {
  const err = new DaemonHttpError("daemon /chains/responses: HTTP 404", 404, {
    error: { code: "not_found", message: "no chain events found for conversation" },
  });
  const getChainResponses = mock<GetChainResponsesFn>(() => Promise.reject(err));
  const daemon = fakeDaemon({ getChainResponses });
  const handler = chainGetResponseHandler(daemon);
  const res = await handler({ conversation_id: "missing", which: "final" });
  const text = textOf(res);
  expect(text).toMatch(/^◑ chain_get_response {2}/);
  expect(text).toContain('"code": "not_found"');
});

test("chainGetResponseHandler rethrows non-404 daemon errors", async () => {
  const getChainResponses = mock<GetChainResponsesFn>(() =>
    Promise.reject(new Error("daemon /chains/responses: HTTP 500")),
  );
  const daemon = fakeDaemon({ getChainResponses });
  const handler = chainGetResponseHandler(daemon);
  let caught: unknown;
  try {
    await handler({ conversation_id: "conv1", which: "final" });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain("HTTP 500");
});

test("chainGetResponseHandler rethrows DaemonHttpError 500s instead of masking them as not_found", async () => {
  const err = new DaemonHttpError("test", 500, "oops");
  const getChainResponses = mock<GetChainResponsesFn>(() => Promise.reject(err));
  const daemon = fakeDaemon({ getChainResponses });
  const handler = chainGetResponseHandler(daemon);
  let caught: unknown;
  try {
    await handler({ conversation_id: "conv1", which: "final" });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBe(err);
});
