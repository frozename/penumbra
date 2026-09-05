import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { AcpClient, type AcpClientOptions } from "@src/adapters/acp-client.js";
import type { AcpServerHandle, StartAcpServerOptions } from "@src/adapters/acp-server.js";
import type {
  AcpCreateSessionRequest,
  AcpEvent,
  AcpPermissionReply,
  AcpPermissionResponse,
  AcpTool,
} from "@src/adapters/acp-types.js";
import { OpencodeAcpAdapter } from "@src/adapters/opencode-acp.js";
import type { DispatchInput } from "@src/sdk/adapter.js";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const baseUrl = "http://127.0.0.1:1";

interface CapturedInit {
  url: string;
  [key: string]: unknown;
}

async function expectRejectionMatching(p: Promise<unknown>, expected: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof Error)) {
    throw new Error("expected promise to reject with an Error");
  }
  expect(caught.message).toMatch(expected);
}

describe("acp-client fetch budget", () => {
  test("message POST opts out of Bun's 300s default fetch idle timeout", async () => {
    const inits: CapturedInit[] = [];
    globalThis.fetch = mock((url: string | URL, init?: RequestInit): Promise<Response> => {
      inits.push({ url: String(url), ...(init as Record<string, unknown>) });
      const urlStr = String(url);
      if (urlStr.includes("/event")) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller): void {
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const client = new AcpClient({ baseUrl });
    try {
      for await (const _ of client.sendMessage("ses_x", "hi", { model: "p/m" })) {
        /* drain */
      }
    } catch {
      /* the SSE stream closing is fine */
    }

    const post = inits.find((i) => i.url.endsWith("/message"));
    expect(post).toBeDefined();
    // This assertion pins the spelling of an undocumented Bun fetch option,
    // not observable behavior. If Bun renames `timeout`, the POST silently
    // ignores the unknown key, the 300s cap returns, and this test still
    // passes. The @ts-expect-error in acp-client.ts is the guard that would
    // fail loudly on a rename — keep both.
    expect((post as Record<string, unknown> | undefined)?.timeout).toBe(false);
  });

  test("SSE GET opts out of Bun's 300s default fetch idle timeout", async () => {
    const inits: CapturedInit[] = [];
    globalThis.fetch = mock((url: string | URL, init?: RequestInit): Promise<Response> => {
      inits.push({ url: String(url), ...(init as Record<string, unknown>) });
      const urlStr = String(url);
      if (urlStr.includes("/event")) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller): void {
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const client = new AcpClient({ baseUrl });
    try {
      for await (const _ of client.sendMessage("ses_x", "hi", { model: "p/m" })) {
        /* drain */
      }
    } catch {
      /* the SSE stream closing is fine */
    }

    const get = inits.find((i) => i.url.includes("/event"));
    expect(get).toBeDefined();
    expect((get as Record<string, unknown> | undefined)?.timeout).toBe(false);
  });
});

type AcpClientLike = Pick<
  AcpClient,
  "openSession" | "sendMessage" | "replyPermission" | "respondPermission" | "replySessionPermission"
>;

interface SendMessageOpts {
  model?: string;
  tools?: AcpTool[];
  agent?: string;
  directory?: string;
  workspace?: string;
}

interface ClientMock extends AcpClientLike {
  openSession: ReturnType<
    typeof mock<
      (req?: AcpCreateSessionRequest) => Promise<{ sessionId: string; workspaceId?: string }>
    >
  >;
  sendMessage: ReturnType<
    typeof mock<
      (sessionId: string, content: string, opts?: SendMessageOpts) => AsyncIterable<AcpEvent>
    >
  >;
  replyPermission: ReturnType<
    typeof mock<(requestID: string, reply: AcpPermissionReply) => Promise<void>>
  >;
  respondPermission: ReturnType<
    typeof mock<
      (sessionId: string, permissionID: string, response: AcpPermissionResponse) => Promise<void>
    >
  >;
  replySessionPermission: ReturnType<
    typeof mock<(sessionId: string, requestID: string, reply: AcpPermissionReply) => Promise<void>>
  >;
}

function createServerHandle(): AcpServerHandle & {
  kill: ReturnType<typeof mock<() => Promise<void>>>;
} {
  const kill = mock((): Promise<void> => Promise.resolve());
  return {
    port: 4312,
    baseUrl: "http://127.0.0.1:4312",
    pid: 999,
    kill,
    exited: Promise.resolve({ code: 0, signal: null }),
  };
}

function createInput(prompt = "ping"): DispatchInput {
  return {
    prompt,
    conversation: { id: "conv-1", project_id: null },
    config: {},
    signal: new AbortController().signal,
  };
}

function createClient(): ClientMock {
  return {
    openSession: mock(
      (_req?: AcpCreateSessionRequest): Promise<{ sessionId: string; workspaceId?: string }> =>
        Promise.resolve({ sessionId: "sess-123", workspaceId: "." }),
    ),
    sendMessage: mock((): AsyncIterable<AcpEvent> => neverYieldEvents()),
    replyPermission: mock((): Promise<void> => Promise.resolve()),
    respondPermission: mock((): Promise<void> => Promise.resolve()),
    replySessionPermission: mock((): Promise<void> => Promise.resolve()),
  };
}

async function* neverYieldEvents(): AsyncGenerator<AcpEvent, void, undefined> {
  await new Promise<void>(() => {
    /* hang forever */
  });
  yield* [] as AcpEvent[];
}

async function* yieldOnceThenHang(event: unknown): AsyncGenerator<AcpEvent, void, undefined> {
  await Promise.resolve();
  yield event as AcpEvent;
  await new Promise<void>(() => {
    /* hang forever */
  });
}

async function* yieldSpacedThenHang(
  events: unknown[],
  gapMs: number,
): AsyncGenerator<AcpEvent, void, undefined> {
  for (const evt of events) {
    await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
    yield evt as AcpEvent;
  }
  await new Promise<void>(() => {
    /* hang forever */
  });
}

describe("opencode-acp rolling inactivity", () => {
  test("fires after the first event when no further wire activity arrives", async () => {
    const handle = createServerHandle();
    const startServer = mock(
      (_opts: StartAcpServerOptions): Promise<AcpServerHandle> => Promise.resolve(handle),
    );
    const client = createClient();
    client.sendMessage = mock(() =>
      yieldOnceThenHang({
        type: "message.part.updated",
        properties: { part: { id: "p-1", type: "text" } },
      }),
    );
    const createClientMock = mock((opts: AcpClientOptions): AcpClientLike => {
      expect(opts.baseUrl).toBe(handle.baseUrl);
      return client;
    });

    const adapter = new OpencodeAcpAdapter(
      {
        model: "deepseek-v4",
        cwd: "/tmp/opencode-acp",
        inactivityTimeoutMs: 50,
        firstEventTimeoutMs: 5_000,
      },
      { startServer, createClient: createClientMock },
    );

    await expectRejectionMatching(adapter.dispatch(createInput()), /no wire activity for 50ms/);
  });

  test("steady wire activity keeps the turn alive; silence then kills it (re-arm pinning)", async () => {
    const handle = createServerHandle();
    const startServer = mock(
      (_opts: StartAcpServerOptions): Promise<AcpServerHandle> => Promise.resolve(handle),
    );
    const client = createClient();
    const events: unknown[] = [
      { type: "message.part.updated", properties: { part: { id: "p-1", type: "text" } } },
      { type: "message.part.delta", properties: { field: "text", partID: "p-1", delta: "a" } },
      { type: "message.part.delta", properties: { field: "text", partID: "p-1", delta: "b" } },
      { type: "message.part.delta", properties: { field: "text", partID: "p-1", delta: "c" } },
      { type: "message.part.delta", properties: { field: "text", partID: "p-1", delta: "d" } },
    ];
    client.sendMessage = mock(() => yieldSpacedThenHang(events, 20));
    const createClientMock = mock((opts: AcpClientOptions): AcpClientLike => {
      expect(opts.baseUrl).toBe(handle.baseUrl);
      return client;
    });

    const adapter = new OpencodeAcpAdapter(
      {
        model: "deepseek-v4",
        cwd: "/tmp/opencode-acp",
        inactivityTimeoutMs: 50,
        requestTimeoutMs: 10_000,
        firstEventTimeoutMs: 5_000,
      },
      { startServer, createClient: createClientMock },
    );

    const deltas: string[] = [];
    let caught: unknown;
    try {
      for await (const event of adapter.dispatchStream(createInput())) {
        if (event.type === "delta") {
          deltas.push(event.text);
        }
      }
    } catch (e) {
      caught = e;
    }
    // 5 events at 20ms apart = 100ms total elapsed, well over the 50ms
    // inactivity budget. If the re-arm is removed, the watchdog fires at
    // t=50ms (initial arm only) and only 2 deltas arrive. This assertion
    // is the one that dies when the re-arm block is deleted.
    expect(deltas).toEqual(["a", "b", "c", "d"]);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/no wire activity for 50ms/);
  });

  test("watchdog fires before the outer total budget under default options (Defect 1 regression)", async () => {
    const handle = createServerHandle();
    const startServer = mock(
      (_opts: StartAcpServerOptions): Promise<AcpServerHandle> => Promise.resolve(handle),
    );
    const client = createClient();
    client.sendMessage = mock(() =>
      yieldOnceThenHang({
        type: "message.part.updated",
        properties: { part: { id: "p-1", type: "text" } },
      }),
    );
    const createClientMock = mock((opts: AcpClientOptions): AcpClientLike => {
      expect(opts.baseUrl).toBe(handle.baseUrl);
      return client;
    });

    // Default options: no explicit requestTimeoutMs or inactivityTimeoutMs.
    // DEFAULT_REQUEST_TIMEOUT_MS = 600_000, DEFAULT_INACTIVITY_TIMEOUT_MS = 300_000.
    // Scale all setTimeout durations by 1/10_000 so 300s → 30ms, 600s → 60ms,
    // 120s first-event → 12ms. The watchdog (30ms) fires before the outer
    // budget (60ms). If Defect 1 is present (watchdog uses requestTimeoutMs),
    // the watchdog arms at 600s → 60ms, same as the outer, and the error
    // message says "600000ms" instead of "300000ms".
    const realSetTimeout = globalThis.setTimeout;
    const SCALE = 1 / 10_000;
    globalThis.setTimeout = ((
      cb: Parameters<typeof setTimeout>[0],
      ms?: Parameters<typeof setTimeout>[1],
    ) => realSetTimeout(cb, (typeof ms === "number" ? ms : 0) * SCALE)) as typeof setTimeout;
    try {
      const adapter = new OpencodeAcpAdapter(
        { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
        { startServer, createClient: createClientMock },
      );
      await expectRejectionMatching(
        adapter.dispatch(createInput()),
        /no wire activity for 300000ms/,
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("inactivity expiry aborts the signal handed to the AcpClient (Defect A)", async () => {
    const handle = createServerHandle();
    const startServer = mock(
      (_opts: StartAcpServerOptions): Promise<AcpServerHandle> => Promise.resolve(handle),
    );
    const client = createClient();
    client.sendMessage = mock(() =>
      yieldOnceThenHang({
        type: "message.part.updated",
        properties: { part: { id: "p-1", type: "text" } },
      }),
    );
    const clientSignals: AbortSignal[] = [];
    const createClientMock = mock((opts: AcpClientOptions): AcpClientLike => {
      if (opts.signal) clientSignals.push(opts.signal);
      return client;
    });

    const adapter = new OpencodeAcpAdapter(
      {
        model: "deepseek-v4",
        cwd: "/tmp/opencode-acp",
        inactivityTimeoutMs: 50,
        firstEventTimeoutMs: 5_000,
      },
      { startServer, createClient: createClientMock },
    );

    await expectRejectionMatching(adapter.dispatch(createInput()), /no wire activity for 50ms/);

    // One client is created for the session open, one for the stream. The
    // stream client's signal must be ABORTED when the watchdog fires:
    // asserting only that the error was thrown is mutation-dead for this
    // defect (it passed before the fix too, while iterator.next(), the SSE
    // reader.read(), and the POST /message fetch all stayed pending).
    const streamSignal = clientSignals.at(-1);
    expect(streamSignal).toBeInstanceOf(AbortSignal);
    expect(streamSignal?.aborted).toBe(true);
    expect(streamSignal?.reason).toBeInstanceOf(Error);
    expect((streamSignal?.reason as Error).message).toMatch(/no wire activity for 50ms/);
  });

  test("close event/expiry races do not poison later events (Defect B)", async () => {
    const handle = createServerHandle();
    const startServer = mock(
      (_opts: StartAcpServerOptions): Promise<AcpServerHandle> => Promise.resolve(handle),
    );
    const client = createClient();
    const createClientMock = mock((_opts: AcpClientOptions): AcpClientLike => client);

    const adapter = new OpencodeAcpAdapter(
      {
        model: "deepseek-v4",
        cwd: "/tmp/opencode-acp",
        inactivityTimeoutMs: 60,
        requestTimeoutMs: 10_000,
        firstEventTimeoutMs: 5_000,
      },
      { startServer, createClient: createClientMock },
    );

    // Turn 1: one event then silence — the watchdog genuinely fires and the
    // turn dies with the inactivity error. Its expiry must not poison the
    // adapter's next turn: inactivity state is fresh per turn.
    client.sendMessage = mock(() =>
      yieldOnceThenHang({
        type: "message.part.updated",
        properties: { part: { id: "p-1", type: "text" } },
      }),
    );
    await expectRejectionMatching(adapter.dispatch(createInput()), /no wire activity for 60ms/);

    // Turn 2 on the same adapter instance: events land 10ms inside the 60ms
    // budget — close to expiry, repeatedly — then a clean session.idle. With
    // a one-shot rejectable promise, an expiry racing an event could leave a
    // stale rejection behind that kills the next healthy event instantly;
    // each close call must re-arm cleanly and every delta must arrive.
    client.sendMessage = mock(() =>
      yieldSpacedThenHang(
        [
          { type: "message.part.updated", properties: { part: { id: "p-1", type: "text" } } },
          { type: "message.part.delta", properties: { field: "text", partID: "p-1", delta: "a" } },
          { type: "message.part.delta", properties: { field: "text", partID: "p-1", delta: "b" } },
          { type: "message.part.delta", properties: { field: "text", partID: "p-1", delta: "c" } },
          { type: "session.idle" },
        ],
        50,
      ),
    );
    const out = await adapter.dispatch(createInput());
    expect(out).toEqual({ text: "abc" });
  });
});
