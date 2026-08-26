import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import { DaemonHttpError } from "../../src/daemon-client.js";
import { registrarAppendHandler } from "../../src/tools/registrar-append.js";
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

  expect(
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

  expect(promise).rejects.toThrow("phase already transitioned");
  expect(promise).rejects.not.toThrow("HTTP 409");
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
