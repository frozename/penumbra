import { REFINER_INPUT_MAX_BYTES } from "@penumbra/core";
import { expect, mock, test } from "bun:test";

import { makeDispatchRefineRoute } from "../../src/routes/dispatch-refine.js";

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/dispatch/refine", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("returns 400 invalid_json on malformed body", async () => {
  const handler = makeDispatchRefineRoute({
    chat: mock(() => Promise.resolve("x")),
    model: "gpt-4o",
  });
  const req = new Request("http://localhost/dispatch/refine", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  const res = await handler(req);
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_json" });
});

test("returns 400 missing_message when message field is absent", async () => {
  const chat = mock(() => Promise.resolve("x"));
  const handler = makeDispatchRefineRoute({ chat, model: "gpt-4o" });
  const res = await handler(jsonReq({ not_message: "hi" }));
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "missing_message" });
  expect(chat).not.toHaveBeenCalled();
});

test("returns 413 input_too_large when message exceeds limit", async () => {
  const chat = mock(() => Promise.resolve("x"));
  const handler = makeDispatchRefineRoute({ chat, model: "gpt-4o" });
  const big = "a".repeat(REFINER_INPUT_MAX_BYTES + 1);
  const res = await handler(jsonReq({ message: big }));
  expect(res.status).toBe(413);
  expect(await res.json()).toMatchObject({ error: "input_too_large" });
  expect(chat).not.toHaveBeenCalled();
});

test("returns 400 input_blank for whitespace-only message", async () => {
  const chat = mock(() => Promise.resolve("x"));
  const handler = makeDispatchRefineRoute({ chat, model: "gpt-4o" });
  const res = await handler(jsonReq({ message: "   \n\t  " }));
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "input_blank" });
  expect(chat).not.toHaveBeenCalled();
});

test("returns 502 refiner_upstream_failed when chat throws", async () => {
  const chat = mock(() => Promise.reject(new Error("boom")));
  const handler = makeDispatchRefineRoute({ chat, model: "gpt-4o" });
  const res = await handler(jsonReq({ message: "real" }));
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ error: "refiner_upstream_failed" });
  // Error body must NOT leak raw upstream message
  const body = await handler(jsonReq({ message: "real" })).then((r) => r.text());
  expect(body).not.toContain("boom");
});

test("returns 502 refiner_returned_empty when chat returns blank", async () => {
  const chat = mock(() => Promise.resolve("   "));
  const handler = makeDispatchRefineRoute({ chat, model: "gpt-4o" });
  const res = await handler(jsonReq({ message: "real" }));
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ error: "refiner_returned_empty" });
});

test("returns 200 + {refined} on happy path", async () => {
  const chat = mock((opts: { model: string; messages: { role: string; content: string }[] }) => {
    expect(opts.model).toBe("haiku-test");
    expect(opts.messages.length).toBe(2);
    expect(opts.messages[1]?.content).toBe("Original spike prompt");
    return Promise.resolve("  Reshaped.  ");
  });
  const handler = makeDispatchRefineRoute({ chat, model: "haiku-test" });
  const res = await handler(jsonReq({ message: "Original spike prompt" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ refined: "Reshaped." });
});
