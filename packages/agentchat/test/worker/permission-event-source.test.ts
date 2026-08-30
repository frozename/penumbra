import { describe, expect, spyOn, test } from "bun:test";

import {
  createPermissionEventSource,
  type PermissionSseCreds,
} from "@src/worker/permission-event-source.js";

interface CapturedRequest {
  url: string;
  authorization: string | null;
}

interface FetchScenarioStep {
  status?: number;
  /** SSE body chunks (each pushed as a separate reader.read() result). */
  chunks?: string[];
  /** If set, throw this error instead of returning a Response. */
  throwError?: Error;
  /** If true, hold the stream open forever after emitting chunks. */
  hold?: boolean;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
}

// Scripted fetch: consumes one FetchScenarioStep per invocation and records
// the request's authorization header so tests can assert on token freshness.
// Respects init.signal for `hold: true` streams so es.close() unblocks them.
function scriptedFetch(steps: FetchScenarioStep[], captured: CapturedRequest[]): typeof fetch {
  let call = 0;
  const impl = async (input: unknown, init?: RequestInit): Promise<FakeResponse> => {
    await Promise.resolve(undefined);
    const url = typeof input === "string" ? input : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.push({ url, authorization: headers.authorization ?? null });
    const step = steps[call] ?? steps[steps.length - 1];
    call++;
    if (!step) throw new Error("scripted fetch exhausted");
    if (step.throwError) throw step.throwError;
    const chunks = step.chunks ?? [];
    const hold = step.hold ?? false;
    const encoder = new TextEncoder();
    const signal = init?.signal;
    const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        if (!hold) {
          controller.close();
          return;
        }
        const finish = (): void => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        if (signal) {
          if (signal.aborted) finish();
          else signal.addEventListener("abort", finish, { once: true });
        }
      },
    });
    return {
      ok: (step.status ?? 200) < 400,
      status: step.status ?? 200,
      body,
    };
  };
  return impl as unknown as typeof fetch;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("createPermissionEventSource", () => {
  test("resolveCreds is invoked fresh on each (re)connect and picks up a rotated token", async () => {
    // First connect uses token v1, closes cleanly after one frame. Second
    // connect (after the resolver has flipped to v2) uses token v2 and holds
    // the stream open. Asserts both connects went out with the token that
    // was current at the *time of connect*, not the boot-captured value.
    const credsSequence: PermissionSseCreds[] = [
      { baseUrl: "http://127.0.0.1:1111", token: "token-v1" },
      { baseUrl: "http://127.0.0.1:2222", token: "token-v2" },
    ];
    let credsCall = 0;
    const resolveCreds = (): PermissionSseCreds => {
      const creds = credsSequence[Math.min(credsCall, credsSequence.length - 1)];
      credsCall++;
      if (!creds) throw new Error("no creds");
      return creds;
    };
    const captured: CapturedRequest[] = [];
    const steps: FetchScenarioStep[] = [
      // First connect: emit one frame then close so the pump reconnects.
      { chunks: ["event: permission.decided\ndata: {}\n\n"] },
      // Second connect: hold open so the loop stops here.
      { hold: true },
    ];
    const es = createPermissionEventSource("/permissions/events", resolveCreds, {
      fetchImpl: scriptedFetch(steps, captured),
      backoffStartMs: 1,
      backoffCapMs: 5,
    });
    try {
      // Wait long enough for two connect attempts (first closes → backoff 1ms
      // → second connect holds).
      for (let i = 0; i < 50 && captured.length < 2; i++) {
        await sleep(10);
      }
      expect(captured.length).toBeGreaterThanOrEqual(2);
      const c0 = captured[0];
      const c1 = captured[1];
      if (!c0 || !c1) throw new Error("missing captured requests");
      expect(c0.url).toBe("http://127.0.0.1:1111/permissions/events");
      expect(c0.authorization).toBe("Bearer token-v1");
      expect(c1.url).toBe("http://127.0.0.1:2222/permissions/events");
      expect(c1.authorization).toBe("Bearer token-v2");
    } finally {
      es.close();
    }
  });

  test("401 on the first connect triggers re-read + retry with the rotated token", async () => {
    // Simulates the exact stranded-token scenario from the bug report:
    // daemon rotated the token between boot and the first SSE attempt, so
    // the first fetch returns 401. The pump must back off, call resolveCreds
    // AGAIN (picking up the rotated token), and reconnect — not permanently
    // give up.
    const rotatingToken = { current: "stale-boot-token" };
    let credsCall = 0;
    const resolveCreds = (): PermissionSseCreds => {
      credsCall++;
      // After the first read, "rotate" so the next resolve returns the new token.
      if (credsCall === 1) {
        // Simulate an async rotation happening between the first connect
        // (which returns 401) and the retry.
        queueMicrotask(() => {
          rotatingToken.current = "rotated-token";
        });
      }
      return { baseUrl: "http://127.0.0.1:1234", token: rotatingToken.current };
    };
    const captured: CapturedRequest[] = [];
    const steps: FetchScenarioStep[] = [{ status: 401, chunks: [] }, { hold: true }];
    const es = createPermissionEventSource("/permissions/events", resolveCreds, {
      fetchImpl: scriptedFetch(steps, captured),
      backoffStartMs: 1,
      backoffCapMs: 5,
    });
    try {
      for (let i = 0; i < 50 && captured.length < 2; i++) {
        await sleep(10);
      }
      expect(captured.length).toBeGreaterThanOrEqual(2);
      const first = captured[0];
      const second = captured[1];
      if (!first || !second) throw new Error("missing captured requests");
      expect(first.authorization).toBe("Bearer stale-boot-token");
      // Crucial: after the 401, we did NOT give up — we retried with the
      // freshly-resolved token.
      expect(second.authorization).toBe("Bearer rotated-token");
    } finally {
      es.close();
    }
  });

  test("resolveCreds throwing (e.g. transient missing token file) is treated as retryable", async () => {
    // If resolveCreds throws (daemon mid-rotation, token file briefly
    // absent), the pump must swallow the error, back off, and retry — the
    // same way the control listener continues on transient errors.
    let attempts = 0;
    const resolveCreds = (): PermissionSseCreds => {
      attempts++;
      if (attempts === 1) throw new Error("ENOENT: token missing mid-rotation");
      return { baseUrl: "http://127.0.0.1:9999", token: "recovered" };
    };
    const captured: CapturedRequest[] = [];
    const steps: FetchScenarioStep[] = [{ hold: true }];
    const es = createPermissionEventSource("/permissions/events", resolveCreds, {
      fetchImpl: scriptedFetch(steps, captured),
      backoffStartMs: 1,
      backoffCapMs: 5,
    });
    try {
      for (let i = 0; i < 50 && captured.length < 1; i++) {
        await sleep(10);
      }
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(captured.length).toBeGreaterThanOrEqual(1);
      const req = captured[0];
      if (!req) throw new Error("missing captured request");
      expect(req.authorization).toBe("Bearer recovered");
    } finally {
      es.close();
    }
  });

  test("pump errors are logged via console.error including the backoff delay", async () => {
    // Silent-retry regression: prior to the fix the pump caught with a bare
    // `catch {}` and spun forever with zero operator signal. Confirm the
    // retryable path now emits a log per failed connect attempt including
    // the backoff we're about to sleep for.
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let attempts = 0;
      const resolveCreds = (): PermissionSseCreds => {
        attempts++;
        throw new Error("simulated boot failure");
      };
      const es = createPermissionEventSource("/permissions/events", resolveCreds, {
        fetchImpl: (() => {
          throw new Error("unreachable");
        }) as unknown as typeof fetch,
        backoffStartMs: 3,
        backoffCapMs: 20,
      });
      try {
        for (let i = 0; i < 50 && consoleError.mock.calls.length < 1; i++) {
          await sleep(5);
        }
        expect(attempts).toBeGreaterThanOrEqual(1);
        expect(consoleError).toHaveBeenCalled();
        const logged = consoleError.mock.calls.some((call) => {
          const meta = call[1] as unknown;
          return (
            typeof meta === "object" &&
            meta !== null &&
            "backoff_ms" in (meta as Record<string, unknown>) &&
            "err" in (meta as Record<string, unknown>)
          );
        });
        expect(logged).toBe(true);
      } finally {
        es.close();
      }
    } finally {
      consoleError.mockRestore();
    }
  });

  test("close() during the backoff sleep interrupts it promptly (well under backoff)", async () => {
    // Uncancellable-sleep regression: previously the pump slept up to
    // backoffCapMs before noticing close(); now close() must interrupt the
    // sleep so the coroutine exits quickly and releases its closures.
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let attempts = 0;
      const resolveCreds = (): PermissionSseCreds => {
        attempts++;
        throw new Error("simulated boot failure");
      };
      const backoffMs = 2000;
      const es = createPermissionEventSource("/permissions/events", resolveCreds, {
        fetchImpl: (() => {
          throw new Error("unreachable");
        }) as unknown as typeof fetch,
        backoffStartMs: backoffMs,
        backoffCapMs: backoffMs,
      });
      try {
        for (let i = 0; i < 50 && attempts < 1; i++) {
          await sleep(5);
        }
        expect(attempts).toBeGreaterThanOrEqual(1);
        const t0 = Date.now();
        es.close();
        await es._done();
        const dt = Date.now() - t0;
        expect(dt).toBeLessThan(backoffMs / 2);
      } finally {
        es.close();
      }
    } finally {
      consoleError.mockRestore();
    }
  });

  test("addEventListener dispatches parsed SSE frames to registered listeners", async () => {
    // Confirms the parseSseFrame path still works end-to-end after
    // extraction: an event frame emitted by fetch reaches the listener.
    const resolveCreds = (): PermissionSseCreds => ({
      baseUrl: "http://127.0.0.1:1234",
      token: "t",
    });
    const captured: CapturedRequest[] = [];
    const frame =
      'event: permission.decided\nid: perm-1:1\ndata: {"permission_id":"p1","decision":"approve"}\n\n';
    const steps: FetchScenarioStep[] = [{ chunks: [frame], hold: true }];
    const es = createPermissionEventSource("/permissions/events", resolveCreds, {
      fetchImpl: scriptedFetch(steps, captured),
    });
    const seen: { data: string; lastEventId?: string }[] = [];
    es.addEventListener("permission.decided", (evt) => seen.push(evt));
    try {
      for (let i = 0; i < 50 && seen.length === 0; i++) {
        await sleep(10);
      }
      expect(seen.length).toBe(1);
      const first = seen[0];
      if (!first) throw new Error("no event delivered");
      expect(first.data).toBe('{"permission_id":"p1","decision":"approve"}');
      expect(first.lastEventId).toBe("perm-1:1");
    } finally {
      es.close();
    }
  });
});
