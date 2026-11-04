import { expect, test } from "bun:test";

import { createBearerAuth, getPrincipal, type WorkerTokenStoreLike } from "@src/auth.js";

function makeRecordingStore(seeds: Record<string, string>): WorkerTokenStoreLike & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    lookup(plaintext: string): { token_hash: string; worker_id: string } | null {
      calls.push(plaintext);
      const workerId = seeds[plaintext];
      if (workerId === undefined) return null;
      return { token_hash: `hash-of-${plaintext}`, worker_id: workerId };
    },
  };
}

test("lowercase scheme `bearer tok-A` → 401 even when store knows the token, lookup never called", () => {
  const store = makeRecordingStore({ "tok-A": "W-A" });
  const auth = createBearerAuth({ token: "shared-sec", workerTokenStore: store });
  const req = new Request("http://x/", { headers: { authorization: "bearer tok-A" } });
  const res = auth(req);
  expect(res?.status).toBe(401);
  expect(store.calls).toEqual([]);
});

test("`Bearer tok-A` strips the scheme prefix before store lookup", () => {
  const store = makeRecordingStore({ "tok-A": "W-A" });
  const auth = createBearerAuth({ token: "shared-sec", workerTokenStore: store });
  const req = new Request("http://x/", { headers: { authorization: "Bearer tok-A" } });
  expect(auth(req)).toBeNull();
  expect(store.calls).toEqual(["tok-A"]);
});

test("shared-bearer precedence: `Bearer shared-sec` authenticates as shared even when the store maps it", () => {
  const store = makeRecordingStore({ "shared-sec": "W-IMP" });
  const auth = createBearerAuth({ token: "shared-sec", workerTokenStore: store });
  const req = new Request("http://x/", { headers: { authorization: "Bearer shared-sec" } });
  expect(auth(req)).toBeNull();
  expect(getPrincipal(req)).toEqual({ kind: "shared", via: "config" });
  expect(store.calls).toEqual([]);
});

test("header extending the shared token (`Bearer shared-secX`) → 401 without throwing, no principal", () => {
  const store = makeRecordingStore({});
  const auth = createBearerAuth({ token: "shared-sec", workerTokenStore: store });
  const req = new Request("http://x/", { headers: { authorization: "Bearer shared-secX" } });
  let res = null as Response | null;
  expect(() => {
    res = auth(req);
  }).not.toThrow();
  expect(res?.status).toBe(401);
  expect(getPrincipal(req)).toBeNull();
});

test("bare token with no scheme (`shared-sec`) → 401", () => {
  const store = makeRecordingStore({});
  const auth = createBearerAuth({ token: "shared-sec", workerTokenStore: store });
  const req = new Request("http://x/", { headers: { authorization: "shared-sec" } });
  expect(auth(req)?.status).toBe(401);
});

test("401 body equals the unauthorized error envelope", async () => {
  const store = makeRecordingStore({});
  const auth = createBearerAuth({ token: "shared-sec", workerTokenStore: store });
  const req = new Request("http://x/", { headers: { authorization: "Bearer nope" } });
  const res = auth(req);
  expect(res?.status).toBe(401);
  expect(await res?.json()).toEqual({
    error: { code: "unauthorized", message: "missing or invalid bearer token" },
  });
});
