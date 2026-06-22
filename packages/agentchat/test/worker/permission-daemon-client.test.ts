import type { Logger } from "@penumbra/core";

import { describe, expect, test } from "bun:test";

import type { CreatePermissionResult, PenumbraClient } from "../../src/penumbra-client.js";
import type { DiscordNotificationEvent } from "../../src/worker/discord-events.js";
import type {
  EventSourceLike,
  PermissionDaemonClientOpts,
  PermissionDaemonClient as PermissionDaemonClientType,
  PermissionDecisionResult,
} from "../../src/worker/permission-daemon-client.js";

import { PermissionDaemonClient } from "../../src/worker/permission-daemon-client.js";

type PenumbraClientStub = Pick<PenumbraClient, "createPermission" | "getPermission">;

interface FakeClient {
  createPermission: PenumbraClient["createPermission"];
  getPermission: PenumbraClient["getPermission"];
}

interface SseEvent {
  data: string;
  lastEventId?: string;
}

interface SseDecidedPayload {
  permission_id: string;
  parent_handoff_id?: string;
  conversation_id?: string;
  agent_name?: string;
  tool_name?: string;
  decision: "approve" | "reject";
  remember?: "this_call" | "this_dispatch" | null;
  reason?: string | null;
  decided_by?: string;
}

interface SseExpiredPayload {
  permission_id: string;
  parent_handoff_id?: string;
  conversation_id?: string;
  agent_name?: string;
  tool_name?: string;
  ttl_at?: string;
  expired_at?: string;
}

type SsePayload = SseDecidedPayload | SseExpiredPayload;

// pino's Logger has heavily-overloaded info/warn signatures the structural
// {info,warn} stub can't satisfy. Single laundering helper produces a typed
// Logger from a plain {info,warn} shape.
function asLogger(stub: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}): Logger {
  return stub as unknown as Logger;
}

// `PermissionDaemonClient.waiters` is a private field; introspecting it for
// "still pending" assertions requires one laundering helper. Reads only.
function waitersSize(client: PermissionDaemonClientType): number {
  return (client as unknown as { waiters: Map<string, unknown> }).waiters.size;
}

const noopLogger = (): Logger =>
  asLogger({
    info: () => undefined,
    warn: () => undefined,
  });

class FakeEventSource implements EventSourceLike {
  listeners = new Map<string, Set<(evt: SseEvent) => void>>();
  reconnectListeners = new Set<() => void>();
  closed = false;
  addEventListener(name: string, fn: (evt: SseEvent) => void): void {
    if (name === "onReconnect") {
      this.reconnectListeners.add(() => {
        fn({ data: "" });
      });
      return;
    }
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn);
    return (): void => {
      this.reconnectListeners.delete(fn);
    };
  }
  emit(name: string, payload: { permission_id: string; data: SsePayload }): void {
    const data = JSON.stringify(payload.data);
    for (const fn of this.listeners.get(name) ?? []) {
      fn({ data, lastEventId: "seq:1" });
    }
  }
  onReconnectFire(): void {
    for (const fn of this.reconnectListeners) fn();
  }
  close(): void {
    this.closed = true;
  }
}

function makeFakeClient(): FakeClient {
  return {
    createPermission: (body): Promise<CreatePermissionResult> =>
      Promise.resolve({
        permission_id: body.permission_id,
        status: "pending",
        ttl_at: "t",
      }),
    getPermission: (id) =>
      Promise.resolve({
        permission: {
          permission_id: id,
          parent_handoff_id: "h-1",
          conversation_id: "c",
          agent_name: "a",
          tool_name: "t",
          raw_input_json: "{}",
          status: "pending",
          remember_scope: null,
          decision_reason: null,
          decided_by: null,
          ttl_at: "t",
          created_at: "t",
          decided_at: null,
        },
      }),
  };
}

// Synthesize a typed PermissionDaemonClientOpts from a fake EventSource+client.
function makeOpts(
  fakeEs: FakeEventSource,
  fakeClient: FakeClient,
  opts?: { onPermissionEvent?: (event: DiscordNotificationEvent) => void },
): PermissionDaemonClientOpts {
  const penumbraClient: PenumbraClientStub = fakeClient;
  return {
    penumbraClient,
    makeEventSource: (): EventSourceLike => fakeEs,
    uuid: (): string => "perm-fixed",
    log: noopLogger(),
    onPermissionEvent: opts?.onPermissionEvent,
  };
}

// bun:test's `.rejects.toThrow(...)` and `.resolves.toEqual(...)` are typed
// as returning void even though at runtime they await the underlying promise.
// Centralize the await-and-match dance behind helpers so each test stays
// readable and lint-clean.
async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  const message = caught instanceof Error ? caught.message : String(caught);
  expect(message).toMatch(pattern);
}

async function expectResolves<T>(promise: Promise<T>, expected: Awaited<T>): Promise<void> {
  const actual = await promise;
  expect(actual).toEqual(expected);
}

// Construct an Error with a numeric `status` property without leaking `any`
// into the test surface.
function makeHttpError(message: string, status: number): Error {
  const err = new Error(message);
  (err as Error & { status?: number }).status = status;
  return err;
}

describe("PermissionDaemonClient", () => {
  test("requestPermission registers waiter BEFORE POST and resolves on SSE decided event", async () => {
    const fakeEs = new FakeEventSource();
    const seen: DiscordNotificationEvent[] = [];
    const client = new PermissionDaemonClient(
      makeOpts(fakeEs, makeFakeClient(), {
        onPermissionEvent: (event) => seen.push(event),
      }),
    );
    await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 60,
    });
    await Promise.resolve();
    // Simulate operator approving via SSE.
    fakeEs.emit("permission.decided", {
      permission_id: "perm-fixed",
      data: {
        permission_id: "perm-fixed",
        decision: "approve",
        remember: "this_dispatch",
        reason: null,
      },
    });
    const result = await promise;
    expect(result.decision).toBe("approve");
    expect(result.remember).toBe("this_dispatch");
    expect(seen).toEqual([
      {
        kind: "permission_requested",
        permission_id: "perm-fixed",
        handoff_id: "h-1",
        conversation_id: "c",
        agent: "a",
        tool_name: "t",
        ttl_at: "t",
      },
      {
        kind: "permission_decided",
        permission_id: "perm-fixed",
        handoff_id: undefined,
        conversation_id: undefined,
        agent: undefined,
        tool_name: undefined,
        decision: "approve",
        decided_by: undefined,
      },
    ]);
  });

  test("requestPermission rejects on permission.expired", async () => {
    const fakeEs = new FakeEventSource();
    const seen: DiscordNotificationEvent[] = [];
    const client = new PermissionDaemonClient(
      makeOpts(fakeEs, makeFakeClient(), {
        onPermissionEvent: (event) => seen.push(event),
      }),
    );
    await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 60,
    });
    await Promise.resolve();
    fakeEs.emit("permission.expired", {
      permission_id: "perm-fixed",
      data: {
        permission_id: "perm-fixed",
        parent_handoff_id: "h-1",
        conversation_id: "c",
        agent_name: "a",
        tool_name: "t",
        ttl_at: "t",
        expired_at: "t",
      },
    });
    await expectRejection(promise, /expired/);
    expect(seen).toEqual([
      {
        kind: "permission_requested",
        permission_id: "perm-fixed",
        handoff_id: "h-1",
        conversation_id: "c",
        agent: "a",
        tool_name: "t",
        ttl_at: "t",
      },
      {
        kind: "permission_expired",
        permission_id: "perm-fixed",
        handoff_id: "h-1",
        conversation_id: "c",
        agent: "a",
        tool_name: "t",
        ttl_at: "t",
      },
    ]);
  });

  test("requestPermission with createPermission HTTP failure rejects", async () => {
    const fakeEs = new FakeEventSource();
    const fakeClient = makeFakeClient();
    fakeClient.createPermission = (): Promise<CreatePermissionResult> =>
      Promise.reject(new Error("http 500"));
    const client = new PermissionDaemonClient(makeOpts(fakeEs, fakeClient));
    await client.start();

    await expectRejection(
      client.requestPermission({
        parent_handoff_id: "h-1",
        conversation_id: "c",
        agent_name: "a",
        tool_name: "t",
        raw_input: {},
        ttl_seconds: 60,
      }),
      /http 500/,
    );
  });

  test("decided event for an unknown id is silently ignored", async () => {
    const fakeEs = new FakeEventSource();
    const seen: DiscordNotificationEvent[] = [];
    const client = new PermissionDaemonClient(
      makeOpts(fakeEs, makeFakeClient(), {
        onPermissionEvent: (event) => seen.push(event),
      }),
    );
    await client.start();
    // No throw — just observes that emitting an unknown id doesn't crash.
    fakeEs.emit("permission.decided", {
      permission_id: "unknown",
      data: {
        permission_id: "unknown",
        parent_handoff_id: "h-unknown",
        conversation_id: "c-unknown",
        agent_name: "agent-unknown",
        tool_name: "tool.unknown",
        decision: "approve",
        decided_by: "operator",
      },
    });
    expect(fakeEs.closed).toBe(false);
    expect(seen).toEqual([
      {
        kind: "permission_decided",
        permission_id: "unknown",
        handoff_id: "h-unknown",
        conversation_id: "c-unknown",
        agent: "agent-unknown",
        tool_name: "tool.unknown",
        decision: "approve",
        decided_by: "operator",
      },
    ]);
  });

  test("reconnect -> terminal pending row converges via GET", async () => {
    const fakeEs = new FakeEventSource();
    const fakeClient = makeFakeClient();
    fakeClient.getPermission = (id): ReturnType<PenumbraClient["getPermission"]> =>
      Promise.resolve({
        permission: {
          permission_id: id,
          parent_handoff_id: "h-1",
          conversation_id: "c",
          agent_name: "a",
          tool_name: "t",
          raw_input_json: "{}",
          status: "approved",
          remember_scope: "this_dispatch",
          decision_reason: "ok",
          decided_by: "operator",
          ttl_at: "t",
          created_at: "t",
          decided_at: "t",
        },
      });
    const client = new PermissionDaemonClient(makeOpts(fakeEs, fakeClient));
    await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 60,
    });

    fakeEs.onReconnectFire();
    const expected: PermissionDecisionResult = {
      decision: "approve",
      remember: "this_dispatch",
      reason: "ok",
    };
    await expectResolves(promise, expected);
  });

  test("reconnect -> still-pending row keeps waiting", async () => {
    const fakeEs = new FakeEventSource();
    const fakeClient = makeFakeClient();
    fakeClient.getPermission = (id): ReturnType<PenumbraClient["getPermission"]> =>
      Promise.resolve({
        permission: {
          permission_id: id,
          parent_handoff_id: "h-1",
          conversation_id: "c",
          agent_name: "a",
          tool_name: "t",
          raw_input_json: "{}",
          status: "pending",
          remember_scope: null,
          decision_reason: null,
          decided_by: null,
          ttl_at: "t",
          created_at: "t",
          decided_at: null,
        },
      });
    const client = new PermissionDaemonClient(makeOpts(fakeEs, fakeClient));
    await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 60,
    });

    fakeEs.onReconnectFire();
    await Promise.resolve();
    expect(waitersSize(client)).toBe(1);
    expect(promise).toBeInstanceOf(Promise);
  });

  test("reconnect -> 404 from GET rejects waiter", async () => {
    const fakeEs = new FakeEventSource();
    const fakeClient = makeFakeClient();
    fakeClient.getPermission = (): ReturnType<PenumbraClient["getPermission"]> =>
      Promise.reject(makeHttpError("missing", 404));
    const client = new PermissionDaemonClient(makeOpts(fakeEs, fakeClient));
    await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 60,
    });

    fakeEs.onReconnectFire();
    await expectRejection(promise, /not found|404/i);
  });

  test("reconnect -> non-404 GET error rejects waiter", async () => {
    const fakeEs = new FakeEventSource();
    const fakeClient = makeFakeClient();
    fakeClient.getPermission = (): ReturnType<PenumbraClient["getPermission"]> =>
      Promise.reject(makeHttpError("daemon unavailable", 503));
    const client = new PermissionDaemonClient(makeOpts(fakeEs, fakeClient));
    await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: "h-1",
      conversation_id: "c",
      agent_name: "a",
      tool_name: "t",
      raw_input: {},
      ttl_seconds: 60,
    });

    fakeEs.onReconnectFire();
    await expectRejection(promise, /daemon unavailable/);
    expect(waitersSize(client)).toBe(0);
  });
});
