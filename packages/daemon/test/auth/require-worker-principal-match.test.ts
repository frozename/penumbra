import { expect, test } from "bun:test";

import { requireWorkerPrincipalMatch, setPrincipalForTest } from "@src/auth.js";

test("no principal attached → 403 worker_token_required", async () => {
  const req = new Request("http://x/");
  const res = requireWorkerPrincipalMatch(req, "W-A");
  expect(res?.status).toBe(403);
  expect(await res?.json()).toEqual({
    error: {
      code: "worker_token_required",
      message: "this route requires a per-worker bearer token",
    },
  });
});

test("shared principal → 403 worker_token_required", async () => {
  const req = new Request("http://x/");
  setPrincipalForTest(req, { kind: "shared", via: "config" });
  const res = requireWorkerPrincipalMatch(req, "W-A");
  expect(res?.status).toBe(403);
  const body = (await res?.json()) as { error: { code: string } };
  expect(body.error.code).toBe("worker_token_required");
});

test("worker principal with mismatched body worker_id → 403 worker_id_mismatch", async () => {
  const req = new Request("http://x/");
  setPrincipalForTest(req, { kind: "worker", worker_id: "W-A", token_hash: "h" });
  const res = requireWorkerPrincipalMatch(req, "W-B");
  expect(res?.status).toBe(403);
  expect(await res?.json()).toEqual({
    error: { code: "worker_id_mismatch", message: "body worker_id does not match credential" },
  });
});

test("worker principal with matching body worker_id → null", () => {
  const req = new Request("http://x/");
  setPrincipalForTest(req, { kind: "worker", worker_id: "W-A", token_hash: "h" });
  expect(requireWorkerPrincipalMatch(req, "W-A")).toBeNull();
});

test("principal set on one Request does not leak to another Request", async () => {
  const req = new Request("http://x/");
  setPrincipalForTest(req, { kind: "worker", worker_id: "W-A", token_hash: "h" });
  expect(requireWorkerPrincipalMatch(req, "W-A")).toBeNull();

  const req2 = new Request("http://x/");
  const res = requireWorkerPrincipalMatch(req2, "W-A");
  expect(res?.status).toBe(403);
  const body = (await res?.json()) as { error: { code: string } };
  expect(body.error.code).toBe("worker_token_required");
});
