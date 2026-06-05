import { expect } from "bun:test";
import { makeTempDaemon } from "../helpers.js";
import { registerWorkerForTest } from "../../test-utils.js";
import { serviceTest } from "../helpers/service-gates.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

serviceTest("Scenario 1: cold boot, register W-A returns a token", async () => {
  const d = makeTempDaemon();
  try {
    const { worker_token, worker_id } = await registerWorkerForTest({
      baseUrl: d.url,
      sharedBearer: d.token,
      worker_id: "W-A",
    });
    expect(typeof worker_token).toBe("string");
    expect(worker_token.length).toBeGreaterThan(0);
    expect(worker_id).toBe("W-A");

    const row = d.services.db
      .query(`SELECT revoked_at FROM worker_tokens WHERE worker_id = 'W-A'`)
      .get() as any;
    expect(row).toBeDefined();
    expect(row.revoked_at).toBeNull();
  } finally {
    d.stop();
  }
});

serviceTest(
  "Scenario 2: heartbeat with bound token + matching body is 200; last_seen_at updates",
  async () => {
    const d = makeTempDaemon();
    try {
      const { worker_token } = await registerWorkerForTest({
        baseUrl: d.url,
        sharedBearer: d.token,
        worker_id: "W-A",
      });

      const getSeen = () =>
        (
          d.services.db
            .query(`SELECT last_seen_at FROM worker_tokens WHERE worker_id = 'W-A'`)
            .get() as any
        ).last_seen_at;
      const tIssue = getSeen();

      await sleep(10); // ensure time bumps

      const res = await fetch(d.url + "/worker/heartbeat", {
        method: "POST",
        headers: {
          authorization: `Bearer ${worker_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ worker_id: "W-A" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });

      const tBumped = getSeen();
      expect(tBumped).toBeGreaterThan(tIssue);
    } finally {
      d.stop();
    }
  },
);

serviceTest(
  "Scenario 3: heartbeat with bound token + mismatched body returns 403 worker_id_mismatch",
  async () => {
    const d = makeTempDaemon();
    try {
      const { worker_token } = await registerWorkerForTest({
        baseUrl: d.url,
        sharedBearer: d.token,
        worker_id: "W-A",
      });

      const res = await fetch(d.url + "/worker/heartbeat", {
        method: "POST",
        headers: {
          authorization: `Bearer ${worker_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ worker_id: "W-B" }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.error?.code).toBe("worker_id_mismatch");
    } finally {
      d.stop();
    }
  },
);

serviceTest(
  "Scenario 4: heartbeat with shared bearer returns 403 worker_token_required",
  async () => {
    const d = makeTempDaemon();
    try {
      const res = await fetch(d.url + "/worker/heartbeat", {
        method: "POST",
        headers: {
          authorization: `Bearer ${d.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ worker_id: "W-A" }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.error?.code).toBe("worker_token_required");
    } finally {
      d.stop();
    }
  },
);

serviceTest(
  "Scenario 5: claim collision �h W-A claims, W-B cannot steal under its own token",
  async () => {
    const d = makeTempDaemon();
    try {
      // seed handoff
      d.services.db.run(
        `\
      INSERT INTO handoffs (handoff_id, status, ts, conversation_id, from_agent, to_agent, message)\
      VALUES ('h-1', 'approved', ?, 'c1', 'A', 'B', 'm')\
    `,
        [d.services.clock().toISOString()],
      );

      const wa = await registerWorkerForTest({
        baseUrl: d.url,
        sharedBearer: d.token,
        worker_id: "W-A",
      });
      const wb = await registerWorkerForTest({
        baseUrl: d.url,
        sharedBearer: d.token,
        worker_id: "W-B",
      });

      // W-A claims
      const resA = await fetch(d.url + "/handoffs/h-1/claim", {
        method: "POST",
        headers: {
          authorization: `Bearer ${wa.worker_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ worker_id: "W-A" }),
      });
      expect(resA.status).toBe(200);

      // W-B attempts to claim
      const resB = await fetch(d.url + "/handoffs/h-1/claim", {
        method: "POST",
        headers: {
          authorization: `Bearer ${wb.worker_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ worker_id: "W-B" }),
      });
      expect(resB.status).toBe(409);

      const workerId = (
        d.services.db.query(`SELECT worker_id FROM handoffs WHERE handoff_id = 'h-1'`).get() as any
      ).worker_id;
      expect(workerId).toBe("W-A");
    } finally {
      d.stop();
    }
  },
);

serviceTest(
  "Scenario 6: terminal CAS — W-A completes without body worker_id; expected derived from principal",
  async () => {
    const d = makeTempDaemon();
    try {
      const wa = await registerWorkerForTest({
        baseUrl: d.url,
        sharedBearer: d.token,
        worker_id: "W-A",
      });

      d.services.db.run(
        `\
      INSERT INTO handoffs (handoff_id, status, worker_id, ts, conversation_id, from_agent, to_agent, message)\
      VALUES ('h-2', 'dispatched', 'W-A', ?, 'c1', 'A', 'B', 'm')\
    `,
        [d.services.clock().toISOString()],
      );

      const resA = await fetch(d.url + "/handoffs/h-2/complete", {
        method: "POST",
        headers: {
          authorization: `Bearer ${wa.worker_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(resA.status).toBe(200);
      const statusA = (
        d.services.db.query(`SELECT status FROM handoffs WHERE handoff_id = 'h-2'`).get() as any
      ).status;
      expect(statusA).toBe("completed");

      // Negative case
      d.services.db.run(
        `\
      INSERT INTO handoffs (handoff_id, status, worker_id, ts, conversation_id, from_agent, to_agent, message)\
      VALUES ('h-3', 'dispatched', 'W-B', ?, 'c1', 'A', 'B', 'm')\
    `,
        [d.services.clock().toISOString()],
      );

      const resB = await fetch(d.url + "/handoffs/h-3/complete", {
        method: "POST",
        headers: {
          authorization: `Bearer ${wa.worker_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(resB.status).toBe(409);
      const statusB = (
        d.services.db.query(`SELECT status FROM handoffs WHERE handoff_id = 'h-3'`).get() as any
      ).status;
      expect(statusB).toBe("dispatched");
    } finally {
      d.stop();
    }
  },
);

serviceTest("Scenario 7: revocation — admin revoke makes subsequent W-A calls 401", async () => {
  const d = makeTempDaemon();
  try {
    const wa = await registerWorkerForTest({
      baseUrl: d.url,
      sharedBearer: d.token,
      worker_id: "W-A",
    });

    const res1 = await fetch(d.url + "/worker/heartbeat", {
      method: "POST",
      headers: {
        authorization: `Bearer ${wa.worker_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ worker_id: "W-A" }),
    });
    expect(res1.status).toBe(200);

    d.services.db.run(`UPDATE worker_tokens SET revoked_at = ? WHERE worker_id = 'W-A'`, [
      Date.now(),
    ]);

    const res2 = await fetch(d.url + "/worker/heartbeat", {
      method: "POST",
      headers: {
        authorization: `Bearer ${wa.worker_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ worker_id: "W-A" }),
    });
    expect(res2.status).toBe(401);
  } finally {
    d.stop();
  }
});

serviceTest(
  "SIGKILL respawn flow: respawned worker recovers its own prior leases via /worker/reconcile-orphans under worker token",
  async () => {
    // The /worker/reconcile-orphans HTTP route scopes recovery to the caller's
    // own worker_id (handoff-recovery.runOnce(workerId)). It is the worker's
    // self-restart recovery path: a worker that died holding leases recovers
    // those leases when its replacement process boots, presents its bound
    // worker token, and calls this route.
    //
    // Other workers' orphans are recovered by the daemon's internal watchdog
    // sweep, not this HTTP route. This test locks in that the route works
    // through the new token-binding enforcement for the self-recovery case.
    const d = makeTempDaemon();
    try {
      // Register W-NEW first so subsequent calls use the bound token.
      const wNew = await registerWorkerForTest({
        baseUrl: d.url,
        sharedBearer: d.token,
        worker_id: "W-NEW",
      });

      // Seed an orphaned dispatch owned by W-NEW (simulating a prior incarnation
      // that died mid-flight before the new process took over the same identity).
      const oldTs = new Date("2025-01-01T00:00:00Z").toISOString();
      d.services.db.run(
        `
      INSERT INTO handoffs (handoff_id, status, worker_id, ts, conversation_id, from_agent, to_agent, message)
      VALUES ('h-X', 'dispatched', 'W-NEW', ?, 'c1', 'A', 'B', 'm')
    `,
        [oldTs],
      );

      const res = await fetch(d.url + "/worker/reconcile-orphans", {
        method: "POST",
        headers: {
          authorization: `Bearer ${wNew.worker_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ worker_id: "W-NEW" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      // Token binding does not break the GH #122 orphan-recovery envelope:
      // response shape is intact and the seeded orphan was actioned.
      expect(typeof body.requeued).toBe("number");
      expect(typeof body.exhausted).toBe("number");
      expect(Array.isArray(body.requeuedRowIds)).toBe(true);
      expect(Array.isArray(body.exhaustedRowIds)).toBe(true);
      expect(body.requeued + body.exhausted).toBeGreaterThan(0);

      const status = (
        d.services.db.query(`SELECT status FROM handoffs WHERE handoff_id = 'h-X'`).get() as any
      ).status;
      expect(status).not.toBe("dispatched");
    } finally {
      d.stop();
    }
  },
);
