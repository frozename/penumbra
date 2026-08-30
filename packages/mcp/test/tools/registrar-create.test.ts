import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { DaemonHttpError } from "@src/daemon-client.js";
import { registrarCreateHandler } from "@src/tools/registrar-create.js";

import { fakeDaemon, firstJson } from "../helpers.js";

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject but it resolved");
}

test("returns registrar_id and status='active' by default", async () => {
  const registrarCreate = mock<DaemonClient["registrarCreate"]>(() =>
    Promise.resolve({ registrar_id: "registrar-1" }),
  );
  const handler = registrarCreateHandler(fakeDaemon({ registrarCreate }));

  const result = await handler({
    title: "Registrar rollout",
    slug: "registrar-rollout",
    home_project: "penumbra",
    phases: ["MCP tools"],
  });

  expect(firstJson(result)).toEqual({ registrar_id: "registrar-1", status: "active" });
  expect(registrarCreate).toHaveBeenCalledWith({
    title: "Registrar rollout",
    slug: "registrar-rollout",
    home_project: "penumbra",
    phases: ["MCP tools"],
    status: "active",
  });
});

test("a validation_failed 400 renders as a readable message", async () => {
  const registrarCreate = mock<DaemonClient["registrarCreate"]>(() =>
    Promise.reject(
      new DaemonHttpError("daemon /registrar: HTTP 400", 400, {
        error: "validation_failed",
        details: [{ path: ["phases"], message: "at least one phase is required" }],
      }),
    ),
  );
  const handler = registrarCreateHandler(fakeDaemon({ registrarCreate }));

  const err = await captureRejection(
    handler({
      title: "Registrar rollout",
      slug: "registrar-rollout",
      home_project: "penumbra",
      phases: ["MCP tools"],
    }),
  );
  const message = err instanceof Error ? err.message : String(err);

  expect(message).toContain("validation_failed");
  expect(message).toContain("at least one phase is required");
  expect(message).not.toContain("HTTP 400");
});

test("a daemon 409 is surfaced as a readable slug-taken message", async () => {
  const registrarCreate = mock<DaemonClient["registrarCreate"]>(() =>
    Promise.reject(
      new DaemonHttpError("daemon /registrar: HTTP 409", 409, {
        error: "registrar_slug_taken",
        slug: "registrar-rollout",
      }),
    ),
  );
  const handler = registrarCreateHandler(fakeDaemon({ registrarCreate }));

  const err = await captureRejection(
    handler({
      title: "Registrar rollout",
      slug: "registrar-rollout",
      home_project: "penumbra",
      phases: ["MCP tools"],
    }),
  );

  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe("registrar slug already taken: registrar-rollout");
});
