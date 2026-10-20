import type { ChainMessageEvent } from "@penumbra/api-contract";

import { expect, test } from "bun:test";

import { chainsSlice, type ChainsSlice } from "@src/api/domains/chains.js";
import { DaemonTransport } from "@src/api/transport.js";

// eslint-disable-next-line no-restricted-imports -- e2e harness lives outside src/
import { type E2EHarness, startHarness } from "../../e2e/harness/index";

const conversationId = "conversation/%2F and space";
const invalidBody = {
  error: { code: "validation_error", message: "Invalid transcript tail options" },
};

function makeRows(count: number): ChainMessageEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    event_id: `e${String(index).padStart(4, "0")}`,
    ts: new Date(Date.UTC(2026, 8, 12, 0, 0, index)).toISOString(),
    event_type: index % 2 === 0 ? "user-prompt" : "agent-response",
    source: "agentchat",
    source_detail: null,
    user_id: "u1",
    payload: index === 0 ? null : { seq: index },
  }));
}

async function withHarness(
  run: (h: E2EHarness, chains: ChainsSlice) => Promise<void>,
): Promise<void> {
  const h = await startHarness();
  try {
    const chains = chainsSlice(
      new DaemonTransport({
        getConfig: (): { baseUrl: string; token: string } => ({
          baseUrl: h.baseUrl,
          token: h.token,
        }),
        fetch: Bun.fetch.bind(Bun),
      }),
    );
    await run(h, chains);
  } finally {
    await h.stop();
  }
}

function request(h: E2EHarness, query: URLSearchParams): Promise<Response> {
  return Bun.fetch(`${h.baseUrl}/chains/messages?${query.toString()}`, {
    headers: { Authorization: `Bearer ${h.token}` },
  });
}

async function rawEvents(h: E2EHarness, params: Record<string, string> = {}): Promise<unknown> {
  const response = await request(
    h,
    new URLSearchParams({ conversation_id: conversationId, ...params }),
  );
  expect(response.status).toBe(200);
  return await response.json();
}

test("harness real client reads newest 500 canonical messages and preserves uncapped legacy default", async () => {
  await withHarness(async (h, chains) => {
    const rows = makeRows(1201);
    const snapshot = structuredClone(rows);
    h.setChainMessages(conversationId, rows);
    h.setChainMessages("unrelated", [
      { ...rows[0]!, event_id: "other", ts: "2099-01-01T00:00:00.000Z" },
    ]);
    expect(await chains.messages(conversationId, { tail: true })).toEqual({
      events: rows.slice(701),
    });
    expect(await chains.messages(conversationId, { tail: true, limit: 500 })).toEqual({
      events: rows.slice(701),
    });
    expect(await chains.messages(conversationId, { tail: true, limit: 2 })).toEqual({
      events: rows.slice(-2),
    });
    expect(await chains.messages(conversationId)).toEqual({ events: rows });
    expect(await chains.messages(conversationId, { tail: false })).toEqual({ events: rows });
    expect(rows).toEqual(snapshot);
    expect(await chains.messages("unknown", { tail: true })).toEqual({ events: [] });
  });
});

test("GET /chains/messages tail=true applies types and before_ts before taking tail window", async () => {
  await withHarness(async (h, chains) => {
    const rows = makeRows(1201);
    const snapshot = structuredClone(rows);
    h.setChainMessages(conversationId, rows);
    expect(
      await rawEvents(h, {
        tail: "true",
        types: " , agent-response, , ",
        before_ts: rows[1001]!.ts,
        limit: "2",
      }),
    ).toEqual({ events: [rows[997], rows[999]] });
    expect(await rawEvents(h, { tail: "true", types: "agent-response", limit: "2" })).toEqual({
      events: [rows[1197], rows[1199]],
    });
    expect(await rawEvents(h, { tail: "true", before_ts: rows[1000]!.ts, limit: "2" })).toEqual({
      events: [rows[998], rows[999]],
    });
    expect(await rawEvents(h, { tail: "true", types: " , ", before_ts: "", limit: "2" })).toEqual({
      events: rows.slice(-2),
    });
    expect(
      await rawEvents(h, { tail: "true", before_ts: "opaque", limit: "2", offset: "0" }),
    ).toEqual({ events: rows.slice(-2) });
    expect(await rawEvents(h, { tail: "true", before_ts: "!", limit: "2" })).toEqual({
      events: [],
    });
    expect(await rawEvents(h, { tail: "true", types: "missing", limit: "2" })).toEqual({
      events: [],
    });
    expect(await chains.messages(conversationId)).toEqual({ events: snapshot });
    expect(rows).toEqual(snapshot);
  });
});

test("GET /chains/messages tail=true rejects invalid limit/offset/raw syntax", async () => {
  await withHarness(async (h) => {
    const invalid: [string, string][] = [
      ...["", "TRUE", "True", "FALSE", "False", " true", "true ", "1", "0", "null", "enabled"].map(
        (value): [string, string] => ["tail", value],
      ),
      ...[
        "",
        "0",
        "00",
        "01",
        "+1",
        "-1",
        " 1",
        "1 ",
        "1.5",
        "1e2",
        "0x10",
        "2junk",
        "NaN",
        "Infinity",
        "-Infinity",
        "501",
        "9".repeat(400),
      ].map((value): [string, string] => ["limit", value]),
      ...[
        "",
        "00",
        "01",
        "1",
        "-1",
        "-0",
        "+0",
        " 0",
        "0 ",
        "0.0",
        "0e0",
        "0x0",
        "0junk",
        "NaN",
        "Infinity",
      ].map((value): [string, string] => ["offset", value]),
    ];
    for (const [key, value] of invalid) {
      const query = new URLSearchParams({ conversation_id: conversationId, tail: "true" });
      query.set(key, value);
      const response = await request(h, query);
      const body: unknown = await response.json();
      expect({ key, value, status: response.status, body }).toEqual({
        key,
        value,
        status: 400,
        body: invalidBody,
      });
    }
  });
});

test("GET /chains/messages uses first raw tail, limit, and offset values", async () => {
  await withHarness(async (h) => {
    const rows = makeRows(4);
    h.setChainMessages(conversationId, rows);
    const query = new URLSearchParams({ conversation_id: conversationId });
    for (const [key, value] of [
      ["tail", "true"],
      ["tail", "bad"],
      ["limit", "2"],
      ["limit", "0"],
      ["offset", "0"],
      ["offset", "bad"],
    ]) {
      query.append(key!, value!);
    }
    const response = await request(h, query);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: rows.slice(-2) });
    const invalid = new URLSearchParams({ conversation_id: conversationId });
    invalid.append("tail", "bad");
    invalid.append("tail", "true");
    const rejected = await request(h, invalid);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual(invalidBody);
  });
});

test("GET /chains/messages legacy omitted and false keep permissive limit parse semantics", async () => {
  await withHarness(async (h, chains) => {
    const rows = makeRows(1201);
    h.setChainMessages(conversationId, rows);
    for (const tail of [undefined, "false"]) {
      const params: Record<string, string> = tail === undefined ? {} : { tail };
      for (const limit of ["2junk", "2.9"]) {
        expect(
          await rawEvents(h, { ...params, limit, types: "absent", before_ts: "!", offset: "999" }),
        ).toEqual({ events: rows.slice(0, 2) });
      }
      for (const limit of ["", "invalid", "0", "-1"]) {
        expect(await rawEvents(h, { ...params, limit })).toEqual({ events: rows });
      }
      expect(await rawEvents(h, params)).toEqual({ events: rows });
    }
    expect(await chains.messages(conversationId, { tail: false, limit: 2.9 })).toEqual({
      events: rows.slice(0, 2),
    });
    expect(await chains.messages(conversationId)).toEqual({ events: rows });
  });
});

test("GET /chains/messages keeps old missing conversation error and priority over tail validation", async () => {
  await withHarness(async (h) => {
    for (const conversation of [undefined, ""]) {
      for (const tail of [undefined, "true", "false", "invalid"]) {
        const query = new URLSearchParams({ limit: "invalid", offset: "00" });
        if (conversation !== undefined) query.set("conversation_id", conversation);
        if (tail !== undefined) query.set("tail", tail);
        const response = await request(h, query);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: { code: "missing_param", message: "conversation_id is required" },
        });
      }
    }
  });
});

test("harness tail preserves supplied canonical equal-timestamp order and seeds across reset/replacement", async () => {
  await withHarness(async (h, chains) => {
    const rows = makeRows(4).map((row, index) => ({
      ...row,
      event_id: ["z", "a", "m", "b"][index]!,
      ts: "2026-09-12T00:00:00.000Z",
    }));
    const snapshot = structuredClone(rows);
    h.setChainMessages(conversationId, rows);
    expect(await chains.messages(conversationId, { tail: true, limit: 3 })).toEqual({
      events: rows.slice(1),
    });
    expect(await chains.messages(conversationId)).toEqual({ events: snapshot });
    expect(rows).toEqual(snapshot);
    const replacement = [{ ...rows[0]!, event_id: "replacement" }];
    h.setChainMessages(conversationId, replacement);
    expect(await chains.messages(conversationId, { tail: true })).toEqual({ events: replacement });
    h.reset();
    expect(await chains.messages(conversationId, { tail: true })).toEqual({ events: [] });
    expect(await chains.messages(conversationId)).toEqual({ events: [] });
    h.setChainMessages(conversationId, rows);
    expect(await chains.messages(conversationId, { tail: true })).toEqual({ events: snapshot });
    expect(rows).toEqual(snapshot);
    expect(replacement).toEqual([{ ...snapshot[0]!, event_id: "replacement" }]);
  });
});
