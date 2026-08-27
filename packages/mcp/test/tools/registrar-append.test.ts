import { expect, mock, test } from "bun:test";
import { z } from "zod";

import type { DaemonClient } from "../../src/daemon-client.js";

import { DaemonHttpError } from "../../src/daemon-client.js";
import {
  RegistrarAppendInputSchema,
  RegistrarAppendInputShape,
  registrarAppendHandler,
} from "../../src/tools/registrar-append.js";
import { fakeDaemon } from "../helpers.js";

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject but it resolved");
}

test("an unknown kind throws at the zod boundary and daemon.registrarAppend is never invoked", async () => {
  const registrarAppend = mock<DaemonClient["registrarAppend"]>(() =>
    Promise.resolve({ event: {} as never }),
  );
  const handler = registrarAppendHandler(fakeDaemon({ registrarAppend }));

  await expect(
    handler({
      registrar_id: "registrar-1",
      kind: "unknown",
      actor: "maestro",
      body: "should not reach the daemon",
    }),
  ).rejects.toThrow();
  expect(registrarAppend).not.toHaveBeenCalled();
});

test("a daemon 409 is surfaced as 'phase already transitioned', not a raw HTTP dump", async () => {
  const registrarAppend = mock<DaemonClient["registrarAppend"]>(() =>
    Promise.reject(
      new DaemonHttpError("daemon /registrar/registrar-1/events: HTTP 409", 409, {
        error: "invalid_phase_transition",
        registrar_id: "registrar-1",
        phase_no: 1,
        from_status: "complete",
      }),
    ),
  );
  const handler = registrarAppendHandler(fakeDaemon({ registrarAppend }));

  const promise = handler({
    registrar_id: "registrar-1",
    kind: "phase_transition",
    phase_no: 1,
    actor: "maestro",
    body: "restart phase",
    from_status: "complete",
    state: "active",
  });

  await expect(promise).rejects.toThrow("phase already transitioned");
  await expect(promise).rejects.not.toThrow("HTTP 409");
});

test("an entry_transition input parses and passes through to the daemon client", async () => {
  const calls: Parameters<DaemonClient["registrarAppend"]>[] = [];
  const registrarAppend = mock<DaemonClient["registrarAppend"]>((req) => {
    calls.push([req]);
    return Promise.resolve({
      event: {
        event_id: 1,
        registrar_id: req.registrar_id,
        phase_no: null,
        kind: "entry_transition",
        state: "paused",
        ref_event_id: null,
        link_kind: null,
        link_value: null,
        actor: "maestro",
        body: "paused for review",
        created_at: 1_700_000_000,
      },
    });
  });
  const handler = registrarAppendHandler(fakeDaemon({ registrarAppend }));

  const result = await handler({
    registrar_id: "registrar-1",
    kind: "entry_transition",
    from_status: "active",
    state: "paused",
    actor: "maestro",
    body: "paused for review",
  });

  expect(registrarAppend).toHaveBeenCalledTimes(1);
  expect(calls[0]).toEqual([
    {
      registrar_id: "registrar-1",
      event: {
        actor: "maestro",
        body: "paused for review",
        kind: "entry_transition",
        from_status: "active",
        state: "paused",
      },
    },
  ]);
  expect(result).toBeTruthy();
});

test("a daemon 409 invalid_entry_transition is surfaced as 'entry status already transitioned'", async () => {
  const registrarAppend = mock<DaemonClient["registrarAppend"]>(() =>
    Promise.reject(
      new DaemonHttpError("daemon /registrar/registrar-1/events: HTTP 409", 409, {
        error: "invalid_entry_transition",
        registrar_id: "registrar-1",
        from_status: "paused",
        current_status: "active",
      }),
    ),
  );
  const handler = registrarAppendHandler(fakeDaemon({ registrarAppend }));

  const promise = handler({
    registrar_id: "registrar-1",
    kind: "entry_transition",
    from_status: "paused",
    state: "abandoned",
    actor: "maestro",
    body: "should conflict",
  });

  await expect(promise).rejects.toThrow("entry status already transitioned");
  await expect(promise).rejects.not.toThrow("HTTP 409");
});

test("a daemon 404 is surfaced as registrar entry not found", async () => {
  const registrarAppend = mock<DaemonClient["registrarAppend"]>(() =>
    Promise.reject(
      new DaemonHttpError("daemon /registrar/missing/events: HTTP 404", 404, {
        error: "registrar_not_found",
        registrar_id: "missing",
      }),
    ),
  );
  const handler = registrarAppendHandler(fakeDaemon({ registrarAppend }));

  const err = await captureRejection(
    handler({
      registrar_id: "missing",
      kind: "progress",
      actor: "maestro",
      body: "record progress",
    }),
  );

  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe("registrar entry not found");
});

test("a daemon phase_not_found 404 names the missing phase", async () => {
  const registrarAppend = mock<DaemonClient["registrarAppend"]>(() =>
    Promise.reject(
      new DaemonHttpError("daemon /registrar/registrar-1/events: HTTP 404", 404, {
        error: "phase_not_found",
        registrar_id: "registrar-1",
        phase_no: 7,
      }),
    ),
  );
  const handler = registrarAppendHandler(fakeDaemon({ registrarAppend }));

  await expect(
    handler({
      registrar_id: "registrar-1",
      kind: "progress",
      actor: "maestro",
      body: "record progress",
    }),
  ).rejects.toThrow("registrar phase 7 not found");
});

test("an unrecognized or bodyless daemon 404 notes that the registrar feature may be disabled", async () => {
  for (const body of [undefined, { error: "route_not_found" }]) {
    const registrarAppend = mock<DaemonClient["registrarAppend"]>(() =>
      Promise.reject(
        new DaemonHttpError("daemon /registrar/registrar-1/events: HTTP 404", 404, body),
      ),
    );
    const handler = registrarAppendHandler(fakeDaemon({ registrarAppend }));

    await expect(
      handler({
        registrar_id: "registrar-1",
        kind: "progress",
        actor: "maestro",
        body: "record progress",
      }),
    ).rejects.toThrow("registrar feature may be disabled");
  }
});

test("RegistrarAppendInputShape rejects a multibyte body over 4096 bytes", () => {
  expect(() =>
    z.object(RegistrarAppendInputShape).parse({
      registrar_id: "registrar-1",
      kind: "progress",
      actor: "maestro",
      body: "€".repeat(2000),
    }),
  ).toThrow("body must be at most 4096 bytes");
});

test("RegistrarAppendInputSchema rejects from_status for event kinds that do not transition state", () => {
  expect(() =>
    RegistrarAppendInputSchema.parse({
      registrar_id: "registrar-1",
      kind: "progress",
      from_status: "active",
      actor: "maestro",
      body: "record progress",
    }),
  ).toThrow("from_status is only valid for phase_transition and entry_transition");
});

test("a daemon 400 surfaces its validation message", async () => {
  const registrarAppend = mock<DaemonClient["registrarAppend"]>(() =>
    Promise.reject(
      new DaemonHttpError("daemon /registrar/registrar-1/events: HTTP 400", 400, {
        error: "validation_failed",
        details: [{ path: ["ref_event_id"], message: "reference event does not exist" }],
      }),
    ),
  );
  const handler = registrarAppendHandler(fakeDaemon({ registrarAppend }));

  const err = await captureRejection(
    handler({
      registrar_id: "registrar-1",
      kind: "progress",
      actor: "maestro",
      body: "record progress",
    }),
  );
  const message = err instanceof Error ? err.message : String(err);

  expect(message).toContain("validation_failed");
  expect(message).toContain("reference event does not exist");
  expect(message).not.toContain("HTTP 400");
});
