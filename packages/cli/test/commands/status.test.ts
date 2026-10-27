import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runStatus } from "@src/commands/status.js";

const TOKEN = "fixture-token-259";
const METRICS = { embedder: { name: "test-embedder", dim: 384 } };
const HANDOFFS_URL = "http://127.0.0.1:4242/handoffs?status=dispatched,approved";
const QUOTAS_URL = "http://127.0.0.1:4242/usage/provider_quotas";
const LOCAL_QUOTA = { provider: "local", max_in_flight: 2, in_flight: 1 };

type HandoffsReply = () => Promise<Response>;
type FakeFetch = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

interface FakeDaemon {
  fetchImpl: FakeFetch;
  calls: { url: string; auth: string }[];
}

function fakeDaemon(
  handoffs: HandoffsReply,
  metricsStatus = 200,
  quotas?: HandoffsReply,
): FakeDaemon {
  const calls: { url: string; auth: string }[] = [];
  const fetchImpl: FakeFetch = (url, init) => {
    calls.push({ url, auth: init.headers.authorization ?? "" });
    const path = new URL(url).pathname;
    if (path === "/metrics") {
      return Promise.resolve(Response.json(METRICS, { status: metricsStatus }));
    }
    if (path === "/dispatch/events") {
      return Promise.resolve(Response.json({ events: [] }));
    }
    if (path === "/handoffs") {
      return handoffs();
    }
    if (path === "/usage/provider_quotas" && quotas !== undefined) {
      return quotas();
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { fetchImpl, calls };
}

function handoffRows(
  rows: { handoff_id: string; to_agent: string; status: string }[],
): HandoffsReply {
  return () => Promise.resolve(Response.json({ handoffs: rows }));
}

function quotaRows(rows: unknown[]): HandoffsReply {
  return () => Promise.resolve(Response.json({ provider_quotas: rows }));
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-status-activity-"));
  writeFileSync(join(dir, "pid"), `${String(process.pid)}\n`);
  writeFileSync(join(dir, "port"), "4242\n");
  writeFileSync(join(dir, "token"), `${TOKEN}\n`);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("penumbra status activity (#259)", () => {
  test("a running daemon reports dispatched handoffs per agent and the approved queue", async () => {
    const daemon = fakeDaemon(
      handoffRows([
        { handoff_id: "h1", to_agent: "a", status: "dispatched" },
        { handoff_id: "h2", to_agent: "a", status: "dispatched" },
        { handoff_id: "h3", to_agent: "b", status: "dispatched" },
        { handoff_id: "h4", to_agent: "c", status: "approved" },
      ]),
    );
    const r = await runStatus({ storageRoot: dir, fetchImpl: daemon.fetchImpl });
    expect(r.status).toBe("running");
    expect(r.embedder).toEqual(METRICS.embedder);
    expect(r.activity).toEqual({
      ok: true,
      dispatched_by_agent: { a: 2, b: 1 },
      approved_queued: 1,
    });
    const handoffCall = daemon.calls.find((c) => c.url === HANDOFFS_URL);
    expect(handoffCall?.auth).toBe(`Bearer ${TOKEN}`);
  });

  test("an idle daemon reports an empty activity block", async () => {
    const daemon = fakeDaemon(handoffRows([]));
    const r = await runStatus({ storageRoot: dir, fetchImpl: daemon.fetchImpl });
    expect(r.status).toBe("running");
    expect(r.activity).toEqual({ ok: true, dispatched_by_agent: {}, approved_queued: 0 });
  });

  test("an HTTP 500 from /handoffs keeps status running and reports activity.ok false", async () => {
    const daemon = fakeDaemon(() => Promise.resolve(new Response("boom", { status: 500 })));
    const r = await runStatus({ storageRoot: dir, fetchImpl: daemon.fetchImpl });
    expect(r.status).toBe("running");
    expect(r.embedder).toEqual(METRICS.embedder);
    expect(r.activity).toEqual({ ok: false, error: "GET /handoffs returned HTTP 500" });
  });

  test("a malformed /handoffs body keeps status running and reports activity.ok false", async () => {
    const notJson = fakeDaemon(() => Promise.resolve(new Response("not json", { status: 200 })));
    const r1 = await runStatus({ storageRoot: dir, fetchImpl: notJson.fetchImpl });
    expect(r1.status).toBe("running");
    expect(r1.activity).toEqual({ ok: false, error: "daemon returned invalid JSON for /handoffs" });

    const noArray = fakeDaemon(() => Promise.resolve(Response.json({ rows: [] })));
    const r2 = await runStatus({ storageRoot: dir, fetchImpl: noArray.fetchImpl });
    expect(r2.status).toBe("running");
    expect(r2.activity).toEqual({
      ok: false,
      error: "daemon /handoffs response has no handoffs array",
    });
  });

  test("a rejected /handoffs request keeps status running and does not leak the token", async () => {
    const daemon = fakeDaemon(() => Promise.reject(new Error("ECONNREFUSED")));
    const r = await runStatus({ storageRoot: dir, fetchImpl: daemon.fetchImpl });
    expect(r.status).toBe("running");
    expect(r.activity).toEqual({ ok: false, error: "GET /handoffs failed: ECONNREFUSED" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test("a stale daemon gets no activity block and /handoffs is never requested", async () => {
    const daemon = fakeDaemon(handoffRows([]), 503);
    const r = await runStatus({ storageRoot: dir, fetchImpl: daemon.fetchImpl });
    expect(r.status).toBe("stale");
    expect(r.activity).toBeUndefined();
    expect(daemon.calls.map((c) => new URL(c.url).pathname)).toEqual(["/metrics"]);
  });
});

describe("penumbra status provider quotas (#259)", () => {
  test("a running daemon reports the effective provider quotas", async () => {
    const daemon = fakeDaemon(handoffRows([]), 200, quotaRows([LOCAL_QUOTA]));
    const r = await runStatus({ storageRoot: dir, fetchImpl: daemon.fetchImpl });
    expect(r.status).toBe("running");
    expect(r.provider_quotas).toEqual({ ok: true, quotas: [LOCAL_QUOTA] });
    expect(r.activity).toEqual({ ok: true, dispatched_by_agent: {}, approved_queued: 0 });
    const quotasCall = daemon.calls.find((c) => c.url === QUOTAS_URL);
    expect(quotasCall?.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test("extra keys on a quota row are dropped", async () => {
    const daemon = fakeDaemon(
      handoffRows([]),
      200,
      quotaRows([{ ...LOCAL_QUOTA, seats: ["local-a"] }]),
    );
    const r = await runStatus({ storageRoot: dir, fetchImpl: daemon.fetchImpl });
    expect(r.provider_quotas).toEqual({ ok: true, quotas: [LOCAL_QUOTA] });
  });

  test("a daemon without the route (HTTP 404) keeps status running and reports provider_quotas.ok false", async () => {
    const daemon = fakeDaemon(handoffRows([]));
    const r = await runStatus({ storageRoot: dir, fetchImpl: daemon.fetchImpl });
    expect(r.status).toBe("running");
    expect(r.embedder).toEqual(METRICS.embedder);
    expect(r.provider_quotas).toEqual({
      ok: false,
      error: "GET /usage/provider_quotas returned HTTP 404",
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test("a malformed /usage/provider_quotas body keeps status running and reports provider_quotas.ok false", async () => {
    const notJson = fakeDaemon(handoffRows([]), 200, () =>
      Promise.resolve(new Response("not json", { status: 200 })),
    );
    const r1 = await runStatus({ storageRoot: dir, fetchImpl: notJson.fetchImpl });
    expect(r1.status).toBe("running");
    expect(r1.provider_quotas).toEqual({
      ok: false,
      error: "daemon returned invalid JSON for /usage/provider_quotas",
    });

    const noArray = fakeDaemon(handoffRows([]), 200, () =>
      Promise.resolve(Response.json({ quotas: [] })),
    );
    const r2 = await runStatus({ storageRoot: dir, fetchImpl: noArray.fetchImpl });
    expect(r2.status).toBe("running");
    expect(r2.provider_quotas).toEqual({
      ok: false,
      error: "daemon /usage/provider_quotas response has no provider_quotas array",
    });

    const badRow = fakeDaemon(
      handoffRows([]),
      200,
      quotaRows([{ provider: "local", max_in_flight: 2 }]),
    );
    const r3 = await runStatus({ storageRoot: dir, fetchImpl: badRow.fetchImpl });
    expect(r3.status).toBe("running");
    expect(r3.provider_quotas).toEqual({
      ok: false,
      error: "daemon /usage/provider_quotas response has a malformed row",
    });
  });

  test("a rejected /usage/provider_quotas request keeps status running and does not leak the token", async () => {
    const daemon = fakeDaemon(handoffRows([]), 200, () => Promise.reject(new Error("ECONNRESET")));
    const r = await runStatus({ storageRoot: dir, fetchImpl: daemon.fetchImpl });
    expect(r.status).toBe("running");
    expect(r.provider_quotas).toEqual({
      ok: false,
      error: "GET /usage/provider_quotas failed: ECONNRESET",
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test("a stale daemon gets no provider_quotas and the route is never requested", async () => {
    const daemon = fakeDaemon(handoffRows([]), 503, quotaRows([LOCAL_QUOTA]));
    const r = await runStatus({ storageRoot: dir, fetchImpl: daemon.fetchImpl });
    expect(r.status).toBe("stale");
    expect(r.provider_quotas).toBeUndefined();
    expect(daemon.calls.map((c) => new URL(c.url).pathname)).toEqual(["/metrics"]);
  });
});
