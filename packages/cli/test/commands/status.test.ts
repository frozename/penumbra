import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runStatus } from "@src/commands/status.js";

const TOKEN = "fixture-token-259";
const METRICS = { embedder: { name: "test-embedder", dim: 384 } };
const HANDOFFS_URL = "http://127.0.0.1:4242/handoffs?status=dispatched,approved";

type HandoffsReply = () => Promise<Response>;
type FakeFetch = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

interface FakeDaemon {
  fetchImpl: FakeFetch;
  calls: { url: string; auth: string }[];
}

function fakeDaemon(handoffs: HandoffsReply, metricsStatus = 200): FakeDaemon {
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
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { fetchImpl, calls };
}

function handoffRows(
  rows: { handoff_id: string; to_agent: string; status: string }[],
): HandoffsReply {
  return () => Promise.resolve(Response.json({ handoffs: rows }));
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
