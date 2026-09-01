import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { DaemonHttpError } from "@src/daemon-client.js";
import {
  chainGetResponseHandler,
  ChainGetResponseInputShape,
} from "@src/tools/chain-get-response.js";

import { fakeDaemon, installFetchMock, requestUrl } from "../helpers.js";

type GetChainResponsesFn = DaemonClient["getChainResponses"];

function textOf(res: { content: { text?: unknown }[] }): string {
  const text = res.content[0].text;
  if (typeof text !== "string") throw new Error("expected text content");
  return text;
}

test("ChainGetResponseInputShape requires conversation_id", () => {
  const shape = ChainGetResponseInputShape as Record<
    string,
    { parse: (input: unknown) => unknown }
  >;
  expect(() => ChainGetResponseInputShape.conversation_id.parse(undefined)).toThrow();
  expect(ChainGetResponseInputShape.which.parse(undefined)).toBe("final");
  expect(ChainGetResponseInputShape.which.parse("all")).toBe("all");
  expect(shape.handoff_id.parse("h-1")).toBe("h-1");
  expect(() => shape.handoff_id.parse("")).toThrow();
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

test("chainGetResponseHandler forwards handoff_id to daemon.getChainResponses", async () => {
  const getChainResponses: GetChainResponsesFn = (conversation_id, which, handoff_id) => {
    expect(conversation_id).toBe("conv1");
    expect(which).toBe("all");
    expect(handoff_id).toBe("h-first");
    return Promise.resolve({
      responses: [{ agent: "a", text: "hi", ts: "t", handoff_id: "h-first" }],
    } as Awaited<ReturnType<GetChainResponsesFn>>);
  };
  const daemon = fakeDaemon({ getChainResponses });
  const handler = chainGetResponseHandler(daemon);
  const res = await handler({
    conversation_id: "conv1",
    which: "all",
    handoff_id: "h-first",
  });
  expect(textOf(res)).toContain('"handoff_id": "h-first"');
});

test("DaemonClient.getChainResponses appends handoff_id only when provided", async () => {
  const seen: string[] = [];
  const { daemon, restore } = installFetchMock((input) => {
    seen.push(new URL(requestUrl(input)).pathname + new URL(requestUrl(input)).search);
    return Promise.resolve(Response.json({ responses: [] }));
  });
  try {
    await daemon.getChainResponses("conv 1", "final", "h/first");
    await daemon.getChainResponses("conv 1", "all");
  } finally {
    restore();
  }

  expect(seen).toEqual([
    "/chains/responses?conversation_id=conv%201&which=final&handoff_id=h%2Ffirst",
    "/chains/responses?conversation_id=conv%201&which=all",
  ]);
});

test("DaemonClient.getChainResponses forwards an explicitly empty handoff_id", async () => {
  const seen: string[] = [];
  const { daemon, restore } = installFetchMock((input) => {
    seen.push(new URL(requestUrl(input)).pathname + new URL(requestUrl(input)).search);
    return Promise.resolve(Response.json({ responses: [] }));
  });
  try {
    await daemon.getChainResponses("conv 1", "final", "");
  } finally {
    restore();
  }

  expect(seen).toEqual(["/chains/responses?conversation_id=conv%201&which=final&handoff_id="]);
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
