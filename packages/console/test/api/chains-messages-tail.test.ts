import { expect, expectTypeOf, test } from "bun:test";

import { chainsSlice, type ChainsSlice } from "@src/api/domains/chains.js";
import { DaemonContractError, DaemonHttpError } from "@src/api/errors.js";
import { DaemonTransport } from "@src/api/transport.js";
import { chainMessages, chainMessagesTail } from "@src/lib/query-keys.js";

const envelope = {
  events: [
    {
      event_id: "e1",
      ts: "2026-09-12T00:00:00.000Z",
      event_type: "agent-response",
      source: "agentchat",
      source_detail: null,
      user_id: "u1",
      payload: { content: "hello" },
    },
  ],
};

type Options = NonNullable<Parameters<ChainsSlice["messages"]>[1]>;

function makeClient(
  body: unknown = envelope,
  status = 200,
): { chains: ChainsSlice; calls: { url: URL; init?: RequestInit }[] } {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const injectedFetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(input instanceof Request ? input.url : input), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  const chains = chainsSlice(
    new DaemonTransport({
      getConfig: (): { baseUrl: string; token: string } => ({
        baseUrl: "http://127.0.0.1:51257",
        token: "tail-token",
      }),
      fetch: injectedFetch,
    }),
  );
  return { chains, calls };
}

test("chains.messages(true) sends tail:true and defaults to limit 500", async () => {
  const { chains, calls } = makeClient();
  const conversationId = "conversation/%2F and space";
  expect(await chains.messages(conversationId, { tail: true })).toEqual(envelope);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url.pathname).toBe("/chains/messages");
  expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
    conversation_id: conversationId,
    tail: "true",
    limit: "500",
  });
  expect(calls[0]!.init?.method).toBe("GET");
  expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer tail-token");
});

test("chains.messages(true) preserves explicit tail limit in query", async () => {
  const { chains, calls } = makeClient();
  expect(await chains.messages("c1", { tail: true, limit: 12 })).toEqual(envelope);
  expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
    conversation_id: "c1",
    tail: "true",
    limit: "12",
  });
});

for (const [label, opts, query] of [
  ["no options", undefined, {}],
  ["omitted tail", { limit: 3.9 }, { limit: "3.9" }],
  ["explicit undefined", { tail: undefined, limit: 3.9 }, { limit: "3.9" }],
  ["false", { tail: false, limit: 3.9 }, { tail: "false", limit: "3.9" }],
  ["legacy zero", { limit: 0 }, { limit: "0" }],
  ["legacy above cap", { tail: false, limit: 501 }, { tail: "false", limit: "501" }],
] as const) {
  test(`chains.messages preserves legacy query: ${label}`, async () => {
    const { chains, calls } = makeClient();
    expect(await chains.messages("c1", opts)).toEqual(envelope);
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      conversation_id: "c1",
      ...query,
    });
  });
}

const invalidOptions: [string, unknown][] = [
  ...["true", "false", "", null, 0, 1, {}, []].map((tail): [string, unknown] => [
    `flag ${JSON.stringify(tail)}`,
    { tail },
  ]),
  ...[null, "2", "", Number.NaN, Infinity, -Infinity, 0, -1, 1.5, 501].map(
    (limit): [string, unknown] => [`limit ${String(limit)}`, { tail: true, limit }],
  ),
];

for (const [label, opts] of invalidOptions) {
  test(`chains.messages rejects invalid tail options as a Promise before fetch: ${label}`, async () => {
    const { chains, calls } = makeClient();
    let result: ReturnType<ChainsSlice["messages"]> | undefined;
    let synchronousError: unknown;
    try {
      result = chains.messages("c1", opts as Options);
    } catch (error) {
      synchronousError = error;
    }
    expect(calls).toHaveLength(0);
    expect(synchronousError).toBeUndefined();
    expect(result).toBeInstanceOf(Promise);
    const error = await result!.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(DaemonContractError);
    expect(calls).toHaveLength(0);
  });
}

test("chains.messages tail=true preserves HTTP failures", async () => {
  const body = { error: { code: "tail_unavailable", message: "unavailable" } };
  const { chains } = makeClient(body, 503);
  const error = await chains.messages("c1", { tail: true }).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(DaemonHttpError);
  expect((error as DaemonHttpError).status).toBe(503);
  expect((error as DaemonHttpError).code).toBe("tail_unavailable");
  expect((error as DaemonHttpError).bodyText).toBe(JSON.stringify(body));
});

for (const body of [{ wrong: "shape" }, { events: [{}] }, { events: "invalid" }]) {
  test(`chains.messages rejects malformed tail body: ${JSON.stringify(body)}`, async () => {
    const { chains } = makeClient(body);
    const error = await chains.messages("c1", { tail: true }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DaemonContractError);
    expect((error as DaemonContractError).rawBody).toEqual(body);
    expect((error as DaemonContractError).issues.length).toBeGreaterThan(0);
  });
}

test("chainMessagesTail cache key includes tail flag and limit and remains id-prefixed", () => {
  expectTypeOf(chainMessagesTail("c1")).toEqualTypeOf<
    readonly ["chains", "messages", string, { readonly tail: true; readonly limit: number }]
  >();
  expect(chainMessages("c1")).toEqual(["chains", "messages", "c1"]);
  expect(chainMessagesTail("c1")).toEqual(["chains", "messages", "c1", { tail: true, limit: 500 }]);
  expect(chainMessagesTail("c1", 200)).toEqual([
    "chains",
    "messages",
    "c1",
    { tail: true, limit: 200 },
  ]);
  expect(chainMessagesTail("c2", 200)).toEqual([
    "chains",
    "messages",
    "c2",
    { tail: true, limit: 200 },
  ]);
  expect(chainMessagesTail("c1", 200)).not.toEqual(chainMessagesTail("c1"));
  expect(chainMessagesTail("c1", 200)).not.toEqual(chainMessagesTail("c2", 200));
  expect(chainMessagesTail("c1", 200).slice(0, 3)).toEqual([...chainMessages("c1")]);
});
