import { expect, test } from "bun:test";

import { createBearerAuth, getPrincipal } from "@src/auth.js";

interface WorkerTokenStoreLike {
  lookup(plaintextToken: string): { token_hash: string; worker_id: string } | null;
  touch?(token_hash: string, nowMs: number): void;
}

function makeFakeStore(seeds: Record<string, string>): WorkerTokenStoreLike {
  return {
    lookup(plaintext): { token_hash: string; worker_id: string } | null {
      const value = seeds[plaintext];
      if (value === undefined) return null;
      return { token_hash: "hash-of-" + plaintext, worker_id: value };
    },
  };
}

test("shared bearer → principal kind=shared", () => {
  const auth = createBearerAuth({ token: "shared-sec", workerTokenStore: makeFakeStore({}) });
  const req = new Request("http://x/", { headers: { authorization: "Bearer shared-sec" } });
  expect(auth(req)).toBeNull();
  const p = getPrincipal(req);
  expect(p).toEqual({ kind: "shared", via: "config" });
});

test("worker bearer → principal kind=worker with worker_id and token_hash", () => {
  const auth = createBearerAuth({
    token: "shared-sec",
    workerTokenStore: makeFakeStore({ "tok-A": "W-A" }),
  });
  const req = new Request("http://x/", { headers: { authorization: "Bearer tok-A" } });
  expect(auth(req)).toBeNull();
  expect(getPrincipal(req)).toEqual({
    kind: "worker",
    worker_id: "W-A",
    token_hash: "hash-of-tok-A",
  });
});

test("unknown bearer → 401, no principal attached", () => {
  const auth = createBearerAuth({ token: "shared-sec", workerTokenStore: makeFakeStore({}) });
  const req = new Request("http://x/", { headers: { authorization: "Bearer mystery" } });
  const res = auth(req);
  expect(res?.status).toBe(401);
  expect(getPrincipal(req)).toBeNull();
});

test("missing Authorization header → 401", () => {
  const auth = createBearerAuth({ token: "shared-sec", workerTokenStore: makeFakeStore({}) });
  const req = new Request("http://x/");
  expect(auth(req)?.status).toBe(401);
  expect(getPrincipal(req)).toBeNull();
});

test("auth layer does not parse the request body", async () => {
  const auth = createBearerAuth({
    token: "shared-sec",
    workerTokenStore: makeFakeStore({ "tok-A": "W-A" }),
  });
  const req = new Request("http://x/", {
    method: "POST",
    headers: { authorization: "Bearer tok-A", "content-type": "application/json" },
    body: "{{{ not json",
  });
  expect(auth(req)).toBeNull();
  expect(getPrincipal(req)?.kind).toBe("worker");
  const body = await req.text();
  expect(body).toBe("{{{ not json");
});

test("createBearerAuth without workerTokenStore preserves current behaviour: only shared bearer accepted", () => {
  const auth = createBearerAuth({ token: "shared-sec" });
  const ok = new Request("http://x/", { headers: { authorization: "Bearer shared-sec" } });
  const bad = new Request("http://x/", { headers: { authorization: "Bearer anything-else" } });
  expect(auth(ok)).toBeNull();
  expect(getPrincipal(ok)).toEqual({ kind: "shared", via: "config" });
  expect(auth(bad)?.status).toBe(401);
});
