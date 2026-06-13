import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PenumbraClient, PenumbraHttpError } from "../../src/penumbra-client.js";
import { runWorkerBoot } from "../../src/worker-boot.js";

function makeClient(fetchImpl: typeof fetch): { client: PenumbraClient; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pen-boot-reg-"));
  writeFileSync(join(root, "port"), "1\n");
  writeFileSync(join(root, "token"), "shared-tok\n");
  const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });
  return { client, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected item at index ${index}`);
  return item;
}

test("PenumbraClient.registerWorker calls /worker/register with shared bearer and captures worker_token", async () => {
  const captured: { url: string; auth: string | null; body: any }[] = [];
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url).pathname;
    const body = await req.json().catch(() => null);
    captured.push({ url, auth: req.headers.get("authorization"), body });
    return Response.json({ worker_token: "wt-alpha", worker_id: "W-A" });
  }) as any;

  const { client, cleanup } = makeClient(fetchImpl);
  try {
    const result = await client.registerWorker({
      worker_id: "W-A",
      metadata: { host: "mac-mini" },
    });

    expect(result.worker_token).toBe("wt-alpha");
    expect(result.worker_id).toBe("W-A");
    expect(captured).toHaveLength(1);
    const request = at(captured, 0);
    expect(request.url).toBe("/worker/register");
    expect(request.auth).toBe("Bearer shared-tok");
    expect(request.body.worker_id).toBe("W-A");
    expect(request.body.metadata).toEqual({ host: "mac-mini" });
    expect(client.getWorkerToken()).toBe("wt-alpha");
  } finally {
    cleanup();
  }
});

test("PenumbraClient.postHeartbeat requires worker_token before posting", async () => {
  const captured: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url).pathname;
    captured.push({ url, auth: req.headers.get("authorization") });
    if (url === "/worker/register")
      return Response.json({ worker_token: "wt-hb", worker_id: "W-A" });
    return Response.json({});
  }) as any;

  const { client, cleanup } = makeClient(fetchImpl);
  try {
    await expect(client.postHeartbeat("W-A")).rejects.toThrow(/worker token/i);
    expect(captured).toHaveLength(0);

    await client.registerWorker({ worker_id: "W-A" });

    await client.postHeartbeat("W-A");
    expect(at(captured, 1)).toMatchObject({ url: "/worker/heartbeat", auth: "Bearer wt-hb" });
  } finally {
    cleanup();
  }
});

test("PenumbraClient.reregisterWorker deduplicates concurrent re-registration attempts", async () => {
  let resolveRegister!: () => void;
  let registerCalls = 0;
  const captured: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url).pathname;
    captured.push({ url, auth: req.headers.get("authorization") });
    if (url === "/worker/register") {
      registerCalls++;
      if (registerCalls === 1) {
        return Response.json({ worker_token: "wt-1", worker_id: "W-A" });
      }
      await new Promise<void>((resolve) => {
        resolveRegister = resolve;
      });
      return Response.json({ worker_token: `wt-${registerCalls}`, worker_id: "W-A" });
    }
    return Response.json({});
  }) as any;

  const { client, cleanup } = makeClient(fetchImpl);
  try {
    await client.registerWorker({ worker_id: "W-A" });
    const p1 = client.reregisterWorker();
    const p2 = client.reregisterWorker();
    await Promise.resolve();
    resolveRegister();
    await Promise.all([p1, p2]);

    expect(registerCalls).toBe(2);
    expect(captured.filter((entry) => entry.url === "/worker/register")).toHaveLength(2);
    expect(client.getWorkerToken()).toBe("wt-2");
  } finally {
    cleanup();
  }
});

test("PenumbraClient.reconcileDispatchOrphans requires worker_token before posting", async () => {
  const captured: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url).pathname;
    captured.push({ url, auth: req.headers.get("authorization") });
    if (url === "/worker/register")
      return Response.json({ worker_token: "wt-rec", worker_id: "W-A" });
    return Response.json({ requeued: 0, exhausted: 0 });
  }) as any;

  const { client, cleanup } = makeClient(fetchImpl);
  try {
    await expect(client.reconcileDispatchOrphans("W-A")).rejects.toThrow(/worker token/i);
    expect(captured).toHaveLength(0);

    await client.registerWorker({ worker_id: "W-A" });
    await client.reconcileDispatchOrphans("W-A");
    expect(at(captured, 1)).toMatchObject({
      url: "/worker/reconcile-orphans",
      auth: "Bearer wt-rec",
    });
  } finally {
    cleanup();
  }
});

test("PenumbraClient.claimHandoff + completeHandoff + markFailed use worker_token after registerWorker", async () => {
  const captured: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url).pathname;
    captured.push({ url, auth: req.headers.get("authorization") });
    if (url === "/worker/register")
      return Response.json({ worker_token: "wt-handoff", worker_id: "W-A" });
    if (url.endsWith("/claim")) return Response.json({ handoff_id: "h-1", status: "dispatched" });
    if (url.endsWith("/complete")) return Response.json({ handoff_id: "h-1", status: "completed" });
    if (url.endsWith("/fail")) return Response.json({ handoff_id: "h-1", status: "failed" });
    return Response.json({});
  }) as any;

  const { client, cleanup } = makeClient(fetchImpl);
  try {
    await client.registerWorker({ worker_id: "W-A" });
    await client.claimHandoff("h-1", "W-A");
    await client.completeHandoff("h-1", "W-A");
    await client.markFailed("h-1", "boom", "W-A");

    const workerCalls = captured.filter((c) => c.url !== "/worker/register");
    expect(workerCalls).toHaveLength(3);
    for (const call of workerCalls) {
      expect(call.auth).toBe("Bearer wt-handoff");
    }
  } finally {
    cleanup();
  }
});

test("Non-worker paths continue to use the shared bearer after registerWorker", async () => {
  const captured: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url).pathname;
    captured.push({ url, auth: req.headers.get("authorization") });
    if (url === "/worker/register")
      return Response.json({ worker_token: "wt-nonworker", worker_id: "W-A" });
    if (url === "/observations") return Response.json({ event_id: "e-1" });
    return Response.json({});
  }) as any;

  const { client, cleanup } = makeClient(fetchImpl);
  try {
    await client.registerWorker({ worker_id: "W-A" });
    await client.observe({
      ts: "2026-05-21T00:00:00Z",
      source: "test",
      event_type: "test",
      lane: "test",
      payload_json: {},
    });

    const observeCall = captured.find((c) => c.url === "/observations");
    expect(observeCall?.auth).toBe("Bearer shared-tok");
  } finally {
    cleanup();
  }
});

describe("runWorkerBoot", () => {
  test("calls registerWorker BEFORE reconcileOrphansAtWorkerBoot steps", async () => {
    const previous = process.env.PENUMBRA_BOOT_RECONCILE;
    delete process.env.PENUMBRA_BOOT_RECONCILE;
    try {
      const calls: string[] = [];
      const log = { info: () => {}, warn: () => {}, error: () => {} };
      const client = {
        registerWorker: async () => {
          calls.push("register");
          return { worker_token: "wt-x", worker_id: "W-A" };
        },
        postHeartbeat: async () => {
          calls.push("heartbeat");
        },
        reconcileLongLivedOrphans: async () => {
          calls.push("long-lived");
          return { reconciled: 0 };
        },
        reconcileDispatchOrphans: async () => {
          calls.push("dispatch");
          return { requeued: 0, exhausted: 0 };
        },
      };

      await runWorkerBoot({ client: client as any, log, workerId: "W-A" });

      expect(calls[0]).toBe("register");
      const rest = calls.slice(1);
      expect(rest).toContain("heartbeat");
      expect(rest).toContain("long-lived");
      expect(rest).toContain("dispatch");
    } finally {
      if (previous === undefined) {
        delete process.env.PENUMBRA_BOOT_RECONCILE;
      } else {
        process.env.PENUMBRA_BOOT_RECONCILE = previous;
      }
    }
  });

  test("throws and does NOT call reconcile steps when registerWorker fails", async () => {
    const previous = process.env.PENUMBRA_BOOT_RECONCILE;
    delete process.env.PENUMBRA_BOOT_RECONCILE;
    try {
      const calls: string[] = [];
      const log = { info: () => {}, warn: () => {}, error: () => {} };
      const client = {
        registerWorker: async () => {
          calls.push("register-fail");
          throw new Error("HTTP 503");
        },
        postHeartbeat: async () => {
          calls.push("heartbeat");
        },
        reconcileLongLivedOrphans: async () => {
          calls.push("long-lived");
          return { reconciled: 0 };
        },
        reconcileDispatchOrphans: async () => {
          calls.push("dispatch");
          return { requeued: 0, exhausted: 0 };
        },
      };

      await expect(runWorkerBoot({ client: client as any, log, workerId: "W-A" })).rejects.toThrow(
        "HTTP 503",
      );
      expect(calls).toEqual(["register-fail"]);
    } finally {
      if (previous === undefined) {
        delete process.env.PENUMBRA_BOOT_RECONCILE;
      } else {
        process.env.PENUMBRA_BOOT_RECONCILE = previous;
      }
    }
  });

  test("skips reconcile steps when PENUMBRA_BOOT_RECONCILE=0", async () => {
    const previous = process.env.PENUMBRA_BOOT_RECONCILE;
    process.env.PENUMBRA_BOOT_RECONCILE = "0";
    try {
      const calls: string[] = [];
      const logs: Array<{ meta: Record<string, unknown>; msg: string }> = [];
      const log = {
        info: (meta: Record<string, unknown>, msg: string) => {
          logs.push({ meta, msg });
        },
        warn: () => {},
        error: () => {},
      };
      const client = {
        registerWorker: async () => {
          calls.push("register");
          return { worker_token: "wt-x", worker_id: "W-A" };
        },
        postHeartbeat: async () => {
          calls.push("heartbeat");
        },
        reconcileLongLivedOrphans: async () => {
          calls.push("long-lived");
          return { reconciled: 0 };
        },
        reconcileDispatchOrphans: async () => {
          calls.push("dispatch");
          return { requeued: 0, exhausted: 0 };
        },
      };

      await runWorkerBoot({ client: client as any, log, workerId: "W-A" });

      expect(calls).toEqual(["register"]);
      expect(logs).toContainEqual({
        meta: { event: "boot_reconcile_skipped", reason: "supervisor_managed" },
        msg: "boot orphan reconcile skipped",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.PENUMBRA_BOOT_RECONCILE;
      } else {
        process.env.PENUMBRA_BOOT_RECONCILE = previous;
      }
    }
  });
});

describe("401 auto-re-register + retry", () => {
  function err401(): Response {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  test("401 on workerHeartbeat triggers re-register + retry; second call succeeds", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    let heartbeatCount = 0;
    let registerCount = 0;

    const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url).pathname;
      calls.push({ url, auth: req.headers.get("authorization") });
      if (url === "/worker/register") {
        registerCount++;
        return Response.json({
          worker_token: registerCount === 1 ? "wt-initial" : "wt-refreshed",
          worker_id: "W-A",
        });
      }
      if (url === "/worker/heartbeat") {
        heartbeatCount++;
        return heartbeatCount === 1 ? err401() : Response.json({});
      }
      return Response.json({});
    }) as any;

    const { client, cleanup } = makeClient(fetchImpl);
    try {
      await client.registerWorker({ worker_id: "W-A", metadata: { host: "mac-mini" } });
      expect(client.getWorkerToken()).toBe("wt-initial");

      await client.postHeartbeat("W-A");

      expect(client.getWorkerToken()).toBe("wt-refreshed");

      const hbCalls = calls.filter((c) => c.url === "/worker/heartbeat");
      expect(hbCalls).toHaveLength(2);
      expect(at(hbCalls, 1).auth).toBe("Bearer wt-refreshed");

      const regCalls = calls.filter((c) => c.url === "/worker/register");
      expect(regCalls).toHaveLength(2);
      expect(at(regCalls, 1).auth).toBe("Bearer shared-tok");
    } finally {
      cleanup();
    }
  });

  test("401 auto-re-register emits info log on success", async () => {
    let heartbeatCount = 0;
    let registerCount = 0;
    const fetchImpl: typeof fetch = (async (input: any) => {
      const req = input instanceof Request ? input : new Request(String(input));
      const url = new URL(req.url).pathname;
      if (url === "/worker/register") {
        registerCount++;
        return Response.json({
          worker_token: registerCount === 1 ? "wt-initial" : "wt-refreshed",
          worker_id: "W-A",
        });
      }
      if (url === "/worker/heartbeat") {
        heartbeatCount++;
        return heartbeatCount === 1 ? err401() : Response.json({});
      }
      return Response.json({});
    }) as any;

    const root = mkdtempSync(join(tmpdir(), "pen-boot-reg-"));
    writeFileSync(join(root, "port"), "1\n");
    writeFileSync(join(root, "token"), "shared-tok\n");
    const logs: Array<{ meta: Record<string, unknown>; msg: string }> = [];
    const logger = {
      info: (meta: Record<string, unknown>, msg: string) => {
        logs.push({ meta, msg });
      },
    };
    const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl, logger });
    try {
      await client.registerWorker({ worker_id: "W-A" });
      await client.postHeartbeat("W-A");
      const reregisterLogs = logs.filter((l) => l.msg === "worker auto-reregistered");
      expect(reregisterLogs).toHaveLength(1);
      expect(at(reregisterLogs, 0).meta).toMatchObject({
        worker_id: "W-A",
        reason: "401_retry",
        status: 401,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("401 auto-re-register suppresses info log when re-register fails", async () => {
    let registerCount = 0;
    const fetchImpl: typeof fetch = (async (input: any) => {
      const req = input instanceof Request ? input : new Request(String(input));
      const url = new URL(req.url).pathname;
      if (url === "/worker/register") {
        registerCount++;
        if (registerCount === 1)
          return Response.json({ worker_token: "wt-initial", worker_id: "W-A" });
        return new Response(JSON.stringify({ error: "boom" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/worker/heartbeat") return err401();
      return Response.json({});
    }) as any;

    const root = mkdtempSync(join(tmpdir(), "pen-boot-reg-"));
    writeFileSync(join(root, "port"), "1\n");
    writeFileSync(join(root, "token"), "shared-tok\n");
    const logs: Array<{ msg: string }> = [];
    const logger = {
      info: (_meta: Record<string, unknown>, msg: string) => {
        logs.push({ msg });
      },
    };
    const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl, logger });
    try {
      await client.registerWorker({ worker_id: "W-A" });
      await expect(client.postHeartbeat("W-A")).rejects.toThrow();
      expect(logs.filter((l) => l.msg === "worker auto-reregistered")).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("401 followed by another 401 propagates the error; no infinite loop", async () => {
    const calls: { url: string }[] = [];
    let heartbeatCount = 0;

    const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url).pathname;
      calls.push({ url });
      if (url === "/worker/register")
        return Response.json({ worker_token: "wt-new", worker_id: "W-A" });
      if (url === "/worker/heartbeat") {
        heartbeatCount++;
        return err401();
      }
      return Response.json({});
    }) as any;

    const { client, cleanup } = makeClient(fetchImpl);
    try {
      await client.registerWorker({ worker_id: "W-A" });

      let caughtError: any;
      try {
        await client.postHeartbeat("W-A");
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeInstanceOf(PenumbraHttpError);
      expect(caughtError.status).toBe(401);
      // heartbeat → register → heartbeat-retry (3 calls total after initial register)
      const postRegisterCalls = calls.slice(1);
      expect(postRegisterCalls.filter((c) => c.url === "/worker/heartbeat")).toHaveLength(2);
      expect(postRegisterCalls.filter((c) => c.url === "/worker/register")).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("403 does NOT trigger re-register; propagates immediately", async () => {
    const calls: { url: string }[] = [];

    const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url).pathname;
      calls.push({ url });
      if (url === "/worker/register")
        return Response.json({ worker_token: "wt-x", worker_id: "W-A" });
      return new Response(JSON.stringify({ error: { code: "worker_id_mismatch" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const { client, cleanup } = makeClient(fetchImpl);
    try {
      await client.registerWorker({ worker_id: "W-A" });
      const postRegisterCallCount = calls.length;

      let caughtError: any;
      try {
        await client.postHeartbeat("W-A");
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeInstanceOf(PenumbraHttpError);
      expect(caughtError.status).toBe(403);
      // Only 1 additional call: the heartbeat that 403'd. No /worker/register retry.
      expect(calls.length).toBe(postRegisterCallCount + 1);
      expect(calls.at(-1)!.url).toBe("/worker/heartbeat");
    } finally {
      cleanup();
    }
  });

  test("Auto-retry covers all worker-scoped methods: reconcileDispatchOrphans, claimHandoff, completeHandoff, markFailed", async () => {
    type Case = { method: (c: PenumbraClient) => Promise<any>; expectedUrl: string | RegExp };
    const cases: Case[] = [
      {
        method: (c) => c.reconcileDispatchOrphans("W-A"),
        expectedUrl: "/worker/reconcile-orphans",
      },
      { method: (c) => c.claimHandoff("h-1", "W-A"), expectedUrl: /\/handoffs\/h-1\/claim/ },
      { method: (c) => c.completeHandoff("h-1", "W-A"), expectedUrl: /\/handoffs\/h-1\/complete/ },
      { method: (c) => c.markFailed("h-1", "boom", "W-A"), expectedUrl: /\/handoffs\/h-1\/fail/ },
    ];

    for (const { method, expectedUrl } of cases) {
      const calls: { url: string; auth: string | null }[] = [];
      let targetCount = 0;
      let registerCount = 0;

      const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        const url = new URL(req.url).pathname;
        calls.push({ url, auth: req.headers.get("authorization") });

        if (url === "/worker/register") {
          registerCount++;
          return Response.json({
            worker_token: registerCount === 1 ? "wt-init" : "wt-fresh",
            worker_id: "W-A",
          });
        }

        const matchesTarget =
          typeof expectedUrl === "string" ? url === expectedUrl : expectedUrl.test(url);
        if (matchesTarget) {
          targetCount++;
          if (targetCount === 1) return err401();
          return Response.json({ requeued: 0, exhausted: 0, handoff_id: "h-1", status: "ok" });
        }
        return Response.json({});
      }) as any;

      const { client, cleanup } = makeClient(fetchImpl);
      try {
        await client.registerWorker({ worker_id: "W-A" });
        await method(client);

        expect(client.getWorkerToken()).toBe("wt-fresh");
        expect(registerCount).toBe(2);
        expect(targetCount).toBe(2);
      } finally {
        cleanup();
      }
    }
  });

  test("5 concurrent 401s trigger exactly ONE re-registration", async () => {
    let heartbeatCount = 0;
    let registerCount = 0;

    const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url).pathname;

      if (url === "/worker/register") {
        registerCount++;
        return Response.json({ worker_token: "wt-fresh", worker_id: "W-A" });
      }
      if (url === "/worker/heartbeat") {
        heartbeatCount++;
        // First 5 calls (initial attempts) return 401; retries (6-10) return 200.
        return heartbeatCount <= 5 ? err401() : Response.json({});
      }
      return Response.json({});
    }) as any;

    const { client, cleanup } = makeClient(fetchImpl);
    try {
      await client.registerWorker({ worker_id: "W-A", metadata: { host: "test" } });
      registerCount = 0; // Reset — only count re-registrations from here.

      await Promise.all([
        client.postHeartbeat("W-A"),
        client.postHeartbeat("W-A"),
        client.postHeartbeat("W-A"),
        client.postHeartbeat("W-A"),
        client.postHeartbeat("W-A"),
      ]);

      expect(registerCount).toBe(1);
      expect(client.getWorkerToken()).toBe("wt-fresh");
    } finally {
      cleanup();
    }
  });

  test("Sequential 401s across separate retry cycles each trigger a fresh re-registration", async () => {
    let heartbeatCount = 0;
    let registerCount = 0;

    const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url).pathname;

      if (url === "/worker/register") {
        registerCount++;
        return Response.json({ worker_token: `wt-${registerCount}`, worker_id: "W-A" });
      }
      if (url === "/worker/heartbeat") {
        heartbeatCount++;
        // Odd calls (1st attempt per cycle) → 401; even calls (retries) → 200.
        return heartbeatCount % 2 === 1 ? err401() : Response.json({});
      }
      return Response.json({});
    }) as any;

    const { client, cleanup } = makeClient(fetchImpl);
    try {
      await client.registerWorker({ worker_id: "W-A" });
      registerCount = 0; // Reset.

      // First cycle: heartbeat #1 (401) → re-register #1 → heartbeat #2 (200).
      await client.postHeartbeat("W-A");
      expect(registerCount).toBe(1);

      // Second cycle: heartbeat #3 (401) → re-register #2 → heartbeat #4 (200).
      await client.postHeartbeat("W-A");
      expect(registerCount).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("Re-registration failure propagates 401 with registration error as .cause", async () => {
    let registerCount = 0;

    const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url).pathname;

      if (url === "/worker/register") {
        registerCount++;
        if (registerCount === 1) {
          return Response.json({ worker_token: "wt-initial", worker_id: "W-A" });
        }
        // Re-registration fails with 500.
        return new Response(JSON.stringify({ error: "internal_error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/worker/heartbeat") {
        return err401();
      }
      return Response.json({});
    }) as any;

    const { client, cleanup } = makeClient(fetchImpl);
    try {
      await client.registerWorker({ worker_id: "W-A" });

      let caughtError: any;
      try {
        await client.postHeartbeat("W-A");
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeInstanceOf(PenumbraHttpError);
      expect(caughtError.status).toBe(401);
      expect(caughtError.cause).toBeInstanceOf(PenumbraHttpError);
      expect((caughtError.cause as PenumbraHttpError).status).toBe(500);
    } finally {
      cleanup();
    }
  });

  test("Without a prior registerWorker call, worker-scoped posts fail locally", async () => {
    const calls: { url: string }[] = [];

    const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      calls.push({ url: new URL(req.url).pathname });
      return err401();
    }) as any;

    const { client, cleanup } = makeClient(fetchImpl);
    try {
      let caughtError: any;
      try {
        await client.postHeartbeat("W-A");
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError.message).toMatch(/worker token/i);
      expect(calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
