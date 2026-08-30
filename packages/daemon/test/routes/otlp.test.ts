import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { otlpLogsRoute, otlpMetricsRoute, otlpTracesRoute } from "@src/routes/otlp.js";

import { ProtoWriter } from "../../../core/test/otlp/encoder.js";

const FIXTURE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "core",
  "test",
  "otlp",
  "fixtures",
  "gemini-logs.json",
);

let dbs: Database[] = [];

function makeServices(): Services {
  const db = new Database(":memory:");
  dbs.push(db);
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/otlp-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-29T12:00:00Z"),
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
}

afterEach(() => {
  for (const d of dbs) d.close();
  dbs = [];
});

describe("otlpLogsRoute", () => {
  it("parses, normalizes, and ingests usage-update events from a gemini envelope", async () => {
    const services = makeServices();
    const body = readFileSync(FIXTURE_PATH, "utf8");
    const req = new Request("http://localhost/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const res = await otlpLogsRoute(req, services);
    expect(res.status).toBe(200);
    const rows = services.db
      .prepare(`SELECT provider, model, event_type FROM t0_events WHERE event_type='usage-update'`)
      .all() as { event_type: string; model: string; provider: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.provider).toBe("google");
    expect(rows[0]!.model).toBe("gemini-3-flash-preview");
  });

  it("returns 415 on truly unsupported content-type", async () => {
    const services = makeServices();
    const req = new Request("http://localhost/v1/logs", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "plain",
    });
    const res = await otlpLogsRoute(req, services);
    expect(res.status).toBe(415);
  });

  it("returns 400 on malformed JSON", async () => {
    const services = makeServices();
    const req = new Request("http://localhost/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await otlpLogsRoute(req, services);
    expect(res.status).toBe(400);
  });
});

describe("otlpMetricsRoute", () => {
  it("returns 200 and discards (no rows ingested)", async () => {
    const services = makeServices();
    const req = new Request("http://localhost/v1/metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"resourceMetrics":[]}',
    });
    const res = await otlpMetricsRoute(req, services);
    expect(res.status).toBe(200);
    const n = services.db.prepare(`SELECT COUNT(*) AS n FROM t0_events`).get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("otlpTracesRoute", () => {
  it("returns 200 and discards", async () => {
    const services = makeServices();
    const req = new Request("http://localhost/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"resourceSpans":[]}',
    });
    const res = await otlpTracesRoute(req, services);
    expect(res.status).toBe(200);
  });
});

function kv(key: string, valueEncoder: (w: ProtoWriter) => void): Uint8Array {
  const i = new ProtoWriter();
  i.writeString(1, key);
  const v = new ProtoWriter();
  valueEncoder(v);
  i.writeNested(2, v.bytes());
  return i.bytes();
}

describe("otlpLogsRoute protobuf", () => {
  it("accepts application/x-protobuf and ingests usage events", async () => {
    const services = makeServices();

    const resourceAttr = kv("service.name", (w) => {
      w.writeString(1, "gemini-cli");
    });
    const eventNameAttr = kv("event.name", (w) => {
      w.writeString(1, "gen_ai.client.inference.operation.details");
    });
    const providerAttr = kv("gen_ai.provider.name", (w) => {
      w.writeString(1, "gcp.vertex_ai");
    });
    const modelAttr = kv("gen_ai.request.model", (w) => {
      w.writeString(1, "gemini-3-flash-preview");
    });
    const inAttr = kv("gen_ai.usage.input_tokens", (w) => {
      w.writeVarintField(3, 100);
    });
    const outAttr = kv("gen_ai.usage.output_tokens", (w) => {
      w.writeVarintField(3, 5);
    });

    const resource = new ProtoWriter();
    resource.writeNested(1, resourceAttr);

    const scope = new ProtoWriter();
    scope.writeString(1, "gemini-cli");

    const logRecord = new ProtoWriter();
    logRecord.writeFixed64(1, 1777466989089000000n);
    logRecord.writeNested(6, eventNameAttr);
    logRecord.writeNested(6, providerAttr);
    logRecord.writeNested(6, modelAttr);
    logRecord.writeNested(6, inAttr);
    logRecord.writeNested(6, outAttr);

    const scopeLogs = new ProtoWriter();
    scopeLogs.writeNested(1, scope.bytes());
    scopeLogs.writeNested(2, logRecord.bytes());

    const resourceLogs = new ProtoWriter();
    resourceLogs.writeNested(1, resource.bytes());
    resourceLogs.writeNested(2, scopeLogs.bytes());

    const envelope = new ProtoWriter();
    envelope.writeNested(1, resourceLogs.bytes());

    const req = new Request("http://localhost/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: envelope.bytes(),
    });
    const res = await otlpLogsRoute(req, services);
    expect(res.status).toBe(200);
    const rows = services.db
      .prepare(`SELECT provider, model FROM t0_events WHERE event_type='usage-update'`)
      .all() as { model: string; provider: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.provider).toBe("google");
    expect(rows[0]!.model).toBe("gemini-3-flash-preview");
  });
});
