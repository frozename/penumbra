import { expect } from "bun:test";
import { serviceTest } from "./helpers/service-gates.js";
import { makeTempDaemon } from "./helpers.js";

serviceTest("GET /health returns 200", async () => {
  const d = makeTempDaemon();
  try {
    d.services.db.exec(`
      INSERT INTO lane_ledger (
        lane_id, ts_opened, ts_closed, task_class, implementer_handoff,
        reviewer_handoff, gate_status, recalled_memory_ids, recalled_query, override_reason, metadata_json
      ) VALUES (
        'lane-open-1', '2026-04-23T10:00:00.000Z', NULL, 'BOUNDARY', 'handoff-1',
        NULL, 'open', '[]', NULL, NULL, '{}'
      ),
      (
        'lane-closed-1', '2026-04-23T09:00:00.000Z', '2026-04-23T09:30:00.000Z', 'BOUNDARY', 'handoff-2',
        NULL, 'passed', '[]', NULL, NULL, '{}'
      ),
      (
        'lane-open-2', '2026-04-23T08:00:00.000Z', NULL, 'STANDARD', 'handoff-3',
        NULL, 'open', '[]', NULL, NULL, '{}'
      );
    `);
    const res = await fetch(`${d.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.version).toBeDefined();
    expect(body.reviewBacklog).toEqual({
      open_lanes_count: 2,
      open_boundary_lanes_count: 1,
      oldest_open_lane_age_ms: 4 * 60 * 60 * 1000,
    });
  } finally {
    d.stop();
  }
});

serviceTest("GET /health needs no auth", async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/health`);
    expect(res.status).toBe(200);
  } finally {
    d.stop();
  }
});

serviceTest("GET /other returns 401 without token", async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/observations`, { method: "POST" });
    expect(res.status).toBe(401);
  } finally {
    d.stop();
  }
});
