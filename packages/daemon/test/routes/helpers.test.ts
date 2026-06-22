import { expect, test } from "bun:test";

import { bodyJson, json } from "../../src/routes/_helpers.js";

test("json helper returns JSON response with status and content type", async () => {
  const res = json({ ok: true }, 201);
  expect(res.status).toBe(201);
  expect(res.headers.get("content-type")).toBe("application/json");
  const body = await res.json();
  expect(body).toEqual({ ok: true });
});

test("bodyJson helper returns parsed payload on valid JSON", async () => {
  const req = new Request("http://x/test", {
    method: "POST",
    body: JSON.stringify({ a: 1 }),
    headers: { "content-type": "application/json" },
  });
  const body = await bodyJson(req);
  expect(body).toEqual({ a: 1 });
});

test("bodyJson helper returns null on invalid JSON", async () => {
  const req = new Request("http://x/test", {
    method: "POST",
    body: "{not-json",
    headers: { "content-type": "application/json" },
  });
  const body = await bodyJson(req);
  expect(body).toBeNull();
});
