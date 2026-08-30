import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { DaemonHttpError } from "@src/daemon-client.js";
import { registrarListHandler } from "@src/tools/registrar-list.js";
import { registrarStatusHandler } from "@src/tools/registrar-status.js";

import { fakeDaemon, firstJson } from "../helpers.js";

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject but it resolved");
}

test("registrar_list round-trips entries through a fake DaemonClient", async () => {
  const payload = {
    entries: [
      {
        registrar_id: "registrar-1",
        slug: "registrar-rollout",
        title: "Registrar rollout",
        home_project: "penumbra",
        source_doc_path: null,
        status: "active" as const,
        created_at: 1_700_000_000,
        updated_at: 1_700_000_001,
      },
    ],
  };
  const registrarList = mock<DaemonClient["registrarList"]>(() => Promise.resolve(payload));
  const handler = registrarListHandler(fakeDaemon({ registrarList }));

  const result = await handler({});

  expect(firstJson(result)).toEqual(payload);
  expect(registrarList).toHaveBeenCalledTimes(1);
});

test("registrar_status round-trips detail through a fake DaemonClient", async () => {
  const payload = {
    entry: {
      registrar_id: "registrar-1",
      slug: "registrar-rollout",
      title: "Registrar rollout",
      home_project: "penumbra",
      source_doc_path: null,
      status: "active" as const,
      created_at: 1_700_000_000,
      updated_at: 1_700_000_001,
    },
    phases: [
      {
        registrar_id: "registrar-1",
        phase_no: 1,
        title: "MCP tools",
        status: "active" as const,
        updated_at: 1_700_000_001,
      },
    ],
    events: [],
    rollup: { open_blockers: 0, open_follow_ups: 0 },
  };
  const registrarStatus = mock<DaemonClient["registrarStatus"]>((req) => {
    expect(req).toEqual({ registrar_id: "registrar-1" });
    return Promise.resolve(payload);
  });
  const handler = registrarStatusHandler(fakeDaemon({ registrarStatus }));

  const result = await handler({ registrar_id: "registrar-1" });

  expect(firstJson(result)).toEqual(payload);
  expect(registrarStatus).toHaveBeenCalledTimes(1);
});

test("registrar_status maps daemon 404 to registrar entry not found", async () => {
  const registrarStatus = mock<DaemonClient["registrarStatus"]>(() =>
    Promise.reject(
      new DaemonHttpError("daemon /registrar/missing: HTTP 404", 404, {
        error: "registrar_not_found",
        registrar_id: "missing",
      }),
    ),
  );
  const handler = registrarStatusHandler(fakeDaemon({ registrarStatus }));

  const err = await captureRejection(handler({ registrar_id: "missing" }));

  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe("registrar entry not found");
});
